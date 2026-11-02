// ============================================================
// 走位指令内存总线（MoveCommandStore）
//
// ── 背景 ──────────────────────────────────────────────────
// 走位引擎解算出的速度，原先通过 3 个 dynamic property
// 传给 main.js 的驱动环：
//
//     dm:cmd_vel_x / dm:cmd_vel_z / dm:cmd_vel_y
//
// 这三个键在 entities/ 与资源包里 0 引用，纯粹是 JS 模块间传参，
// 却用了成本最高、且会让实体带上存档脏标记的持久化通道。
//
// 60 个干员同屏时：
//     每 tick 3 读 + 3 写 × 60 = 360 次跨边界属性访问
//     → 每秒 7,200 次
//
// 而它们承载的只是「这一 tick 想往哪走」这种瞬时状态。
//
// ── 现状 ──────────────────────────────────────────────────
// 改为模块级 Map，纯内存读写，零存档写入。
// 实体卸载丢了下一次解算会重算，无持久化需求。
//
// ── 必须保持的语义（与改造前逐条对齐）────────────────────
// 1. 缺省值：x=0, z=0, y=0.02
//    原代码：unit.getDynamicProperty("dm:cmd_vel_y") ?? 0.02
//
// 2. main.js 会「消费」跳跃冲量：施加后把 y 复位为 0.02，
//    否则同一次跳跃会被每 tick 重复施加。
//
// 3. y <= 0.02 表示「没有跳跃意图」，此时不施加纵向冲量。
//
// 4. 速度为 0 时不立即删除条目：
//    main.js 还要靠 ActiveMovers 判断实际驱动速度是否刹停。
// ============================================================

import { system } from "@minecraft/server";

// ============================================================
// 常量
// ============================================================

// 无跳跃意图时的 y 缺省值（与改造前一致）
export const JUMP_IDLE = 0.02;

// 条目闲置多久后回收（tick）
//
// main.js 每 tick 都会消费跳跃冲量，
// 60 tick 足够覆盖任何正常的解算间隔。
// 作用是兜底清理「实体离开模拟距离但没有触发 entityRemove」的泄漏。
const CMD_TTL_TICKS = 60;

// ============================================================
// 存储
//
// key   = entity.id（运行时唯一数值 ID）
// value = { x, y, z, tick }
//
// 之所以用 entity.id 而不是 typeId：
// 同一个 typeId（如 player:dm8）同屏可能有多个实例，
// 用 typeId 做 key 会让它们互相覆盖指令速度。
// ============================================================
const Commands = new Map();

// 只读共享空值对象，避免查询时反复分配
const IDLE_COMMAND = Object.freeze({
    x: 0,
    y: JUMP_IDLE,
    z: 0,
    tick: 0
});

// ============================================================
// 读取（热路径：main.js 每 tick、每个 mover 一次）
//
// 不存在时返回共享的只读对象，不产生分配。
// 调用方只读，不要写返回值的字段。
// ============================================================
export function peekMoveCmd(entityId) {
    return Commands.get(entityId) ?? IDLE_COMMAND;
}

// ============================================================
// 读取（可写）
//
// 拿到条目本身，允许就地修改字段。
// 走位引擎用这个避免「读-改-写」三次查表。
// ============================================================
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

// ============================================================
// 写入完整指令
//
// y 传 undefined 时回落到 JUMP_IDLE，保持 ?? 0.02 的旧语义。
// ============================================================
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

// ============================================================
// 清速
//
// 与原 clearMovementCommands / clearRangedCmdVel / _clearVel 等价：
// 三个分量都归零，且 y 归零（不是 JUMP_IDLE）。
//
// 注意：原来这些函数还会写 dm:melee_charging = 0，
// 那是另一个通道（JSON 层可见），不归本模块管，
// 由调用方各自保留。
// ============================================================
export function clearMoveCmd(unit) {
    if (!unit) return;

    const cmd = Commands.get(unit.id);

    if (!cmd) return;

    cmd.x = 0;
    cmd.y = 0;
    cmd.z = 0;
    cmd.tick = system.currentTick;
}

// ============================================================
// 消费跳跃冲量
//
// main.js 施加完纵向冲量后调用，把 y 复位为 0.02，
// 防止同一跳被下一 tick 重复施加。
// ============================================================
export function consumeJumpCmd(unit) {
    if (!unit) return;

    const cmd = Commands.get(unit.id);

    if (cmd) {
        cmd.y = JUMP_IDLE;
    }
}

// ============================================================
// 注销
//
// 实体移除时由事件总线调用。
// ============================================================
export function dropMoveCmd(entityId) {
    if (entityId === undefined || entityId === null) return;
    Commands.delete(entityId);
}

// ============================================================
// 兜底回收
//
// 由 5 tick 的目标引擎调用，成本 = 一次 Map 遍历。
// 正常情况下表里只有几十项，开销可忽略。
// ============================================================
export function gcMoveCmd(nowTick) {
    if (Commands.size === 0) return;

    const deadline = nowTick - CMD_TTL_TICKS;

    for (const [id, cmd] of Commands) {
        if (cmd.tick <= deadline) {
            Commands.delete(id);
        }
    }
}

// ============================================================
// 诊断
// ============================================================
export function getMoveCmdCount() {
    return Commands.size;
}
