// 导入 Minecraft 服务器相关模块
import { system, world } from '@minecraft/server';

// 导入子弹击中实体的处理函数
import { bulletEntityImpact } from './dm_entities/common/bullet_manager';

// 导入灯光组件模块
import './element/light';

// 导入近战组件处理函数
import { meleeImpactHandler } from './dm_entities/common/melee_manager';

// 导入女仆相关组件函数
import './dm_entities/dm34/maid_manager';

// 导入目标管理引擎 + ActiveMovers
import {
    DmTargetEngine,
    ActiveMovers
} from './dm_entities/common/attackable_target_manager';

// 导入友军防误伤模块
import './dm_entities/common/player_attack_blocker';

// 导入幻域球模块
import { initFictoriaBall } from "./dm_entities/common/fictoria_ball.js";

// 导入战术指挥 UI
import "./dm_entities/common/fictoria_ui.js";

// 导入窒息挣脱底层模块
import "./dm_entities/common/suffocation_escape.js";

// 导入玩家剑近战相关逻辑
import "./dm_entities/player/dm_player_sword_attack.js";

// 导入 buff计算器
import "./dm_entities/common/damage_buff_calculator.js";

// 导入地雷js
import "./element/demon_landmine.js";

// 导入统一事件总线
import {
    initEventBus,
    registerEntityRemoveHandler,
    REMOVE_PRIORITY
} from "./dm_entities/common/event_bus.js";

// 导入走位指令内存总线
import {
    peekMoveCmd,
    consumeJumpCmd,
    dropMoveCmd
} from "./dm_entities/common/move_command_store.js";

// 导入分级异常兜底
import { safeRun, warnOnce } from "./dm_entities/common/safe_exec.js";

// 导入性能探针
import { PerfProbe, initPerfProbe } from "./dm_entities/common/perf_probe.js";

// ============================================================
// 性能探针总开关
//
// false = 完全关闭。不注册命令通道、不挂 interval，
//         所有埋点的 now() 返回 0、lap() 立即 return，
//         代价是每次埋点两次函数调用（约 10ns）。
//
// true  = 打开。初始化时自动开始采样，并注册三条自定义命令：
//           /perf:on     先标定单次调用成本，再开始采样
//           /perf:off    停止并输出完整报告
//           /perf:bench  只标定，不打断正在进行的采样
//         另有一套 scriptevent 入口，功能更全：
//           /scriptevent perf:hud     顶栏实时显示
//           /scriptevent perf:report  立刻打印明细
//           /scriptevent perf:reset   清空账本
//
// 自定义命令基于 @minecraft/server 2.1.0 的 customCommandRegistry，
// 属稳定 API，不需要 Beta APIs 实验开关。
//
// 输出走聊天栏（sendMessage），不写 console 日志。
// 想看日志需要在 perf_probe.js 里自行加 console.warn 双写。
//
// ⚠ 改完必须退出世界重进，/reload 不重载脚本模块。
// ============================================================
const PERF_PROBE_ENABLED = false;

// 初始化幻域球
initFictoriaBall();

// 初始化目标管理引擎
DmTargetEngine.init();

// 挂载性能探针（总开关关闭时这里什么都不做）
initPerfProbe(PERF_PROBE_ENABLED);

// ============================================================
// 说明：原 2 tick 枪械逻辑动力环已移除。
//
// 原先它调用的 gunLoop() 定义在 bullet_main.js 里，
// 函数体只是一个空的 world.getAllPlayers().forEach，
// 不产生任何行为，却在每 2 tick 占用一次定时器。
//
// bullet_main.js 已整体删除，此处的定时器一并移除。
// 枪械/子弹的实际结算仍在 bullet_manager.js 的
// world.afterEvents.projectileHitEntity 中完成。
// ============================================================

// ============================================================
// 优化方案：
// 原 main.js 每 tick 会遍历 34 个 TARGET_TYPES。
// 在旧版本中，同一个实体可能被重复查询、重复读取属性、重复 applyImpulse。
// 这会导致：
//
// 1. 查询开销爆炸
// 2. DynamicProperty 读取开销爆炸
// 3. applyImpulse 次数爆炸
// 4. 实体物理运动开销爆炸
//
// 现在改为：
//
// 1. main.js 不再查询任何 DM 实体
// 2. main.js 只遍历 ActiveMovers
// 3. 每个单位每 tick 只驱动一次
// 4. 使用 LEGACY_IMPULSE_MULTIPLIER 补偿旧版重复驱动产生的等效冲量
// ============================================================

// ============================================================
// 校准倍率
//
// 原来的 TARGET_TYPES 大约有 34 个。
// 诊断日志中曾经出现：
//
// ticks=40
// active=1360
//
// 也就是：
//
// 1360 / 40 = 34 次有效驱动 / tick
//
// 这说明旧版本里同一个单位很可能每 tick 被驱动约 34 次。
//
// 因此这里默认使用 34 作为等效补偿。
//
// 如果实机测试发现速度过快：
// 可以改成 24 / 16 / 12 / 8。
//
// 如果实机测试发现速度过慢：
// 可以改成 40 / 48。
//
// 长期目标是逐步降低这个值，并重新调整配置表里的速度参数。
// ============================================================
const LEGACY_IMPULSE_MULTIPLIER = 34;
// ============================================================
// 平滑驱动缓存
//
// 不读取实体真实速度，不做高开销闭环。
// 只缓存“当前实际驱动速度”，让它向走位引擎给出的目标速度平滑靠近。
//
// 优点：
// 1. 不增加 getEntities
// 2. 不增加 getBlock
// 3. 不增加 getVelocity
// 4. 只处理 ActiveMovers
// 5. 纯数值计算，开销极低
// ============================================================
const DriveVelCache = new Map();

// 每 tick 最大指令速度变化量
// 越小越平滑，越大越灵敏
// 建议从 0.045 开始
const MAX_CMD_ACCEL = 0.045;

// 实际驱动速度低于这个值时视为停止
const STOP_CMD_SPEED_SQ = 0.0004;

function approachCmd(current, target, maxDelta) {
    const diff = target - current;

    if (diff > maxDelta) {
        return current + maxDelta;
    }

    if (diff < -maxDelta) {
        return current - maxDelta;
    }

    return target;
}

// 实体移除时清理缓存，防止泄漏
registerEntityRemoveHandler("main_drive_cache", (event) => {
    try {
        const id = event.removedEntity?.id;
        if (!id) return;

        DriveVelCache.delete(id);
        dropMoveCmd(id);
    } catch (_) { }
}, REMOVE_PRIORITY.DRIVE_CACHE);
// 原始 CORE_SCALE 是 0.028。
// 现在乘以旧版重复驱动倍率，形成单次等效冲量。
const CORE_SCALE = 0.028 * LEGACY_IMPULSE_MULTIPLIER;

// 原始 MAX_DYNAMIC_IMPULSE 是 0.32。
// 旧版如果重复施加 34 次，等效上限约 0.32 * 34 = 10.88。
// 这里保持等效上限，避免钳制导致手感不一致。
const MAX_DYNAMIC_IMPULSE = 0.32 * LEGACY_IMPULSE_MULTIPLIER;

// ============================================================
// ActiveMovers 过期时间
//
// manager 每 5 tick 更新一次走位。
// 这里给 12 tick 缓冲。
//
// 如果一个单位超过 12 tick 没有被 manager 刷新，
// 说明它已经不再参与走位，或者已经失效。
// ============================================================
const MOVER_EXPIRE_TICKS = 12;

// ============================================================
// 调试开关
// ============================================================
const DEBUG_MAIN_DRIVE = false;

function mainDriveLog(...args) {
    if (DEBUG_MAIN_DRIVE) {
        console.warn(...args);
    }
}

// ============================================================
// 唯一驱动入口：
// 只处理 ActiveMovers
// ============================================================
const driveMaidMuscles = () => {
    try {
        if (!ActiveMovers || ActiveMovers.size === 0) {
            return;
        }

        const nowTick = system.currentTick;

        for (const [id, mover] of ActiveMovers) {
            const unit = mover?.unit;

            // 实体失效清理
            if (!unit || !unit.isValid) {
                DriveVelCache.delete(id);
                ActiveMovers.delete(id);
                continue;
            }

            if (nowTick - mover.tick > MOVER_EXPIRE_TICKS) {
                DriveVelCache.delete(id);
                ActiveMovers.delete(id);
                continue;
            }

            if (unit.hasTag("maid:ride_player")) {
                DriveVelCache.delete(id);
                ActiveMovers.delete(id);
                continue;
            }

            // 读取走位引擎解算出的速度指令
            //
            // 改造前是 3 次 getDynamicProperty（持久化通道）。
            // 这三个键在 entities/ 与资源包中 0 引用，
            // 只是模块间传参，改为内存表查询。
            const cmd = peekMoveCmd(id);
            const velX = cmd.x;
            const velZ = cmd.z;
            const velY = cmd.y;

            // ============================================================
            // 平滑驱动：
            // cmd_vel_x/z 只是目标速度。
            // drive.x / drive.z 才是 main.js 每帧实际输出的驱动速度。
            // ============================================================
            let drive = DriveVelCache.get(id);

            if (!drive) {
                drive = { x: 0, z: 0 };
                DriveVelCache.set(id, drive);
            }

            const cmdIdle = velX === 0 && velZ === 0 && velY <= 0.02;
            const driveSpeedSq = drive.x * drive.x + drive.z * drive.z;

            // 如果指令已经停止，但实际驱动速度还没降下来，
            // 不要立刻删除，继续刹车。
            if (cmdIdle) {
                if (driveSpeedSq < STOP_CMD_SPEED_SQ) {
                    DriveVelCache.delete(id);
                    ActiveMovers.delete(id);
                    continue;
                }

                // 保持 mover 活跃，防止刹车期间过期
                mover.tick = nowTick;
            }

            // 实际驱动速度向目标速度靠近，但限制每 tick 最大变化量
            drive.x = approachCmd(drive.x, velX, MAX_CMD_ACCEL);
            drive.z = approachCmd(drive.z, velZ, MAX_CMD_ACCEL);

            // 避免极小值无限抖动
            if (cmdIdle && drive.x * drive.x + drive.z * drive.z < STOP_CMD_SPEED_SQ) {
                drive.x = 0;
                drive.z = 0;
            }

            const controller =
                unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;

            // ============================================================
            // 注意：
            // 这里不再直接使用 velX / velZ，
            // 而是使用平滑后的 drive.x / drive.z。
            // ============================================================
            let impulseX = drive.x * CORE_SCALE;
            let impulseZ = drive.z * CORE_SCALE;

            if (Math.abs(impulseX) > MAX_DYNAMIC_IMPULSE) {
                impulseX = Math.sign(impulseX) * MAX_DYNAMIC_IMPULSE;
            }

            if (Math.abs(impulseZ) > MAX_DYNAMIC_IMPULSE) {
                impulseZ = Math.sign(impulseZ) * MAX_DYNAMIC_IMPULSE;
            }

            // 纵向冲量保持原逻辑，不参与 34 倍补偿。
            //
            // 原因是旧版 main 在第一次施加跳跃冲量后会执行：
            //
            // unit.setDynamicProperty("dm:cmd_vel_y", 0.02);
            //
            // 所以后续重复驱动不会反复施加纵向冲量。
            const impulseY = (velY > 0.02)
                ? Math.max(-0.4, Math.min(0.4, velY))
                : 0;

            controller.applyImpulse({
                x: impulseX,
                y: impulseY,
                z: impulseZ
            });

            // 跳跃冲量消费
            if (velY > 0.02) {
                consumeJumpCmd(unit);
            }

            mainDriveLog(
                `[MainDrive] ${unit.typeId} | ` +
                `velX=${velX.toFixed(3)} velZ=${velZ.toFixed(3)} velY=${velY.toFixed(3)} | ` +
                `impX=${impulseX.toFixed(3)} impZ=${impulseZ.toFixed(3)}`
            );
        }
    } catch (error) {
        // 高频底层动力线：保持静默，但不能完全无痕
        // 按 tag 去重，同一类异常只报一次，不会刷屏
        warnOnce("main.drive", `${error?.name ?? "Error"}: ${error?.message ?? error}`);
    }
};

// 每帧要执行的函数
//
// 探针关闭时 now() 返回 0、lap() 立刻 return，
// 埋点只付两次函数调用（约 10ns）。
const tick = () => {
    const t0 = PerfProbe.now();

    driveMaidMuscles();

    PerfProbe.lap("main.drive", t0);
};

// 注册游戏事件监听器
const events = () => {
    world.afterEvents.projectileHitEntity.subscribe(bulletEntityImpact);
    meleeImpactHandler();
};

// ============================================================
// 初始化函数
// ============================================================
const init = () => {
    // 启动统一事件总线（必须在所有模块注册完成之后）
    initEventBus();

    // 启动 1 Tick 全速丝滑动力环
    //
    // safeRun 兜住整轮异常：出问题时按 tag 只报一次，
    // 而不是像改造前那样被空 catch 完全吞掉。
    system.runInterval(() => {
        safeRun("main.tick", tick);
    }, 1);

    // 注册事件监听器
    events();
};

// 调用初始化函数，开始整个流程
init();