// move_command_store.js — 走位指令内存总线。

// 原来用 3 个 dynamic property（dm:cmd_vel_x/z/y）传速度：60 个干员同屏时每 tick 360 次
// 跨边界访问、每秒 7200 次，还让实体带上存档脏标记。现在改为模块级 Map，零存档写入。

// 必须保持的语义：
//   1. 缺省 x=0, z=0, y=0.02
//   2. main.js 施加跳跃后把 y 复位为 0.02（否则每 tick 重复施加）
//   3. 纵向意图按绝对值判断：|y| <= 0.02 无意图，>0.02 跳跃，<-0.02 下潜
//      （写成 y <= 0.02 会把负值归零，水中下潜整条失效）
//   4. 速度为 0 不立即删条目，main.js 还要靠 ActiveMovers 判断刹停

import { system } from "@minecraft/server";

// 常量

// 无跳跃意图时的 y 缺省值（与改造前一致）
export const JUMP_IDLE = 0.02;

// 条目闲置多久后回收（tick）。兜底清理没等到 entityRemove 的泄漏。
const CMD_TTL_TICKS = 60;

// 存储：key = entity.id（同 typeId 可能有多个实例，用 typeId 会互相覆盖指令）。
// value = { x, y, z, tick }
const Commands = new Map();

// 只读共享空值对象，避免查询时反复分配
const IDLE_COMMAND = Object.freeze({
    x: 0,
    y: JUMP_IDLE,
    z: 0,
    tick: 0
});

// 读取（热路径）。不存在时返回共享只读对象，调用方只读。
export function peekMoveCmd(entityId) {
    return Commands.get(entityId) ?? IDLE_COMMAND;
}

// 读取（可写）。拿到条目本身可就地改，避免读-改-写三次查表。
export function acquireMoveCmd(unit) {
    if (!unit) return IDLE_COMMAND;

    const id = unit.id;
    let cmd = Commands.get(id);

    if (!cmd) {
        cmd = {
            x: 0,
            y: JUMP_IDLE,
            z: 0,
            tick: 0
        };

        Commands.set(id, cmd);
    }

    return cmd;
}

// 写入完整指令。y 传 undefined 回落 JUMP_IDLE。
export function writeMoveCmd(unit, x, z, y) {
    if (!unit) return IDLE_COMMAND;

    const id = unit.id;
    let cmd = Commands.get(id);

    if (!cmd) {
        cmd = {
            x: 0,
            y: JUMP_IDLE,
            z: 0,
            tick: 0
        };

        Commands.set(id, cmd);
    }

    cmd.x = x;
    cmd.z = z;
    cmd.y = (y === undefined || y === null) ? JUMP_IDLE : y;
    cmd.tick = system.currentTick;

    return cmd;
}

// 清速：三分量归零，y 归零（不是 JUMP_IDLE）。
// dm:melee_charging 是另一个通道，不归本模块管。
export function clearMoveCmd(unit) {
    if (!unit) return;

    const cmd = Commands.get(unit.id);

    if (!cmd) return;

    cmd.x = 0;
    cmd.y = 0;
    cmd.z = 0;
    cmd.tick = system.currentTick;
}

// 消费跳跃冲量：施加完把 y 复位 0.02，防止下一 tick 重复施加。
export function consumeJumpCmd(unit) {
    if (!unit) return;

    const cmd = Commands.get(unit.id);

    if (cmd) {
        cmd.y = JUMP_IDLE;
    }
}

// 注销（实体移除时由事件总线调用）。
export function dropMoveCmd(entityId) {
    if (entityId === undefined || entityId === null) return;
    Commands.delete(entityId);
}

// 兜底回收（5 tick 一次，表里只有几十项）。
export function gcMoveCmd(nowTick) {
    if (Commands.size === 0) return;

    const deadline = nowTick - CMD_TTL_TICKS;

    for (const [id, cmd] of Commands) {
        if (cmd.tick <= deadline) {
            Commands.delete(id);
        }
    }
}

// 诊断
export function getMoveCmdCount() {
    return Commands.size;
}
