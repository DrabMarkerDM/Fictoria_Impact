// 导入 Minecraft 服务器相关模块
import { system, world } from '@minecraft/server';

// 导入子弹击中实体的处理函数
import { bulletEntityImpact } from './dm_entities/common/bullet_manager';

// 导入灯光组件模块
import './element/light';

// 导入近战组件处理函数
import { meleeImpactHandler, maidSpearImpact } from './dm_entities/common/melee_manager';

// 跟随超距召回 / 骑乘载具跟随（与 D 包同步）
import { initFollowRecall } from './dm_entities/common/follow_recall.js';
import { initVehicleFollow } from './dm_entities/common/vehicle_follow.js';

// 导入女仆相关组件函数
import './dm_entities/dm34/maid_manager';

// 导入女仆 dm34 交互层（JS 路由 + 烹饪计时器 + 背包；取代实体 JSON 里的 585 条 minecraft:interact）
import './dm_entities/dm34/index.js';

// 导入目标管理引擎 + ActiveMovers
import {
    DmTargetEngine,
    ActiveMovers
} from './dm_entities/common/attackable_target_manager';

// 骑乘熔断：玩家骑着她时不施力，方向盘归玩家
import { isPlayerMounted } from './dm_entities/player/ride_guard.js';

// 骑乘跟随：她骑马时引擎不驱动坐骑，补一条朝主人的推进指令
import { initMountFollow } from './dm_entities/player/mount_follow.js';

// 导入友军防误伤模块
import './dm_entities/common/player_attack_blocker';

// 导入幻域球模块
import { initFictoriaBall } from "./dm_entities/common/fictoria_ball.js";

// 导入战术指挥 UI
import "./dm_entities/common/fictoria_ui.js";

// 女仆指南：手持指南右键打开表单（章节式文本 UI）
import { initFieldManual } from "./dm_entities/common/field_manual.js";

// 新手套装：玩家第一次进世界时发一颗装好女仆的绿球 + 一本指南。
// 必须排在幻域球之后 —— 它要用 createMaidBall()。
import { initStarterKit } from "./dm_entities/common/starter_kit.js";

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
    dropMoveCmd,
    JUMP_IDLE
} from "./dm_entities/common/move_command_store.js";

// 导入分级异常兜底
import { safeRun, warnOnce } from "./dm_entities/common/safe_exec.js";

// 导入水体通行（溺水检测注册）
import { initDrowningDetector } from "./dm_entities/common/water_traversal.js";

// 导入性能探针
import { PerfProbe, initPerfProbe } from "./dm_entities/common/perf_probe.js";

// 性能探针总开关。false = 不注册命令、不挂 interval，埋点几乎零成本。
// true = 自动采样 + 注册 /perf:on|off|bench 与 /scriptevent perf:hud|report|reset，
// 输出走聊天栏。改完必须退出世界重进（/reload 不重载脚本模块）。
const PERF_PROBE_ENABLED = false;

// 初始化幻域球
initFictoriaBall();

// 初始化目标管理引擎
DmTargetEngine.init();

// 挂载性能探针（总开关关闭时这里什么都不做）
initPerfProbe(PERF_PROBE_ENABLED);

// 原来 2 tick 的枪械动力环（gunLoop）是空函数，随 bullet_main.js 一起删除；
// 子弹结算仍在 bullet_manager.js 的 projectileHitEntity 里。

// 走位优化：main.js 不再查询 DM 实体（原来每 tick 遍历 34 个类型，重复驱动、重复读属性），
// 只遍历 ActiveMovers，每个单位每 tick 驱动一次，
// LEGACY_IMPULSE_MULTIPLIER 用来补偿旧版重复驱动产生的等效冲量。
const LEGACY_IMPULSE_MULTIPLIER = 34;
// 平滑驱动缓存：不读真实速度、不做闭环，只让实际驱动速度向目标速度靠近。
// 纯数值计算，不增加 getEntities / getBlock / getVelocity。
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

// ActiveMovers 过期时间。manager 每 5 tick 刷新一次，这里给 12 tick 缓冲。
const MOVER_EXPIRE_TICKS = 12;

// 调试开关
const DEBUG_MAIN_DRIVE = false;

function mainDriveLog(...args) {
    if (DEBUG_MAIN_DRIVE) {
        console.warn(...args);
    }
}

// 唯一驱动入口：只处理 ActiveMovers
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

                        // 玩家骑着她 → 直接摘掉，一帧冲量都不给。
                        // 走位引擎那边已经熔断，这里再拦一道：mover 可能是上马前挂上的，
                        // 残留的 drive 速度会继续推好几帧，足够让玩家感到"她在跟我抢"。
            if (isPlayerMounted(unit)) {
                DriveVelCache.delete(id);
                ActiveMovers.delete(id);
                continue;
            }

                        // 走位引擎解出的速度指令（原来是 3 个动态属性，改为内存表）
            const cmd = peekMoveCmd(id);
            const velX = cmd.x;
            const velZ = cmd.z;
            const velY = cmd.y;

                        // drive.x / drive.z 是平滑后的实际驱动速度，cmd_vel 只是目标值
            let drive = DriveVelCache.get(id);

            if (!drive) {
                drive = { x: 0, z: 0 };
                DriveVelCache.set(id, drive);
            }

            // 纵向判据必须用绝对值：
            // 下潜/下沉是负值（-0.08 ~ -0.20），旧写法 velY <= 0.02
            // 会把「正在下潜」误判成 idle，整条 mover 被摘掉。
            const cmdIdle = velX === 0 && velZ === 0 && Math.abs(velY) <= JUMP_IDLE;
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

            // 冲量只给她本人。
            // 骑乘（群骑纷争后的引擎 bug）走另一条独立通道：mount_follow.js
            // 直接对载具 applyImpulse，只用于「跟随模式」；近战/远程/冲刺的
            // 冲量留给她自己，不再打到载具上（那会跟马的物理打架）。
            const controller = unit;

                        // 用平滑后的 drive，不用 velX/velZ
            let impulseX = drive.x * CORE_SCALE;
            let impulseZ = drive.z * CORE_SCALE;

            if (Math.abs(impulseX) > MAX_DYNAMIC_IMPULSE) {
                impulseX = Math.sign(impulseX) * MAX_DYNAMIC_IMPULSE;
            }

            if (Math.abs(impulseZ) > MAX_DYNAMIC_IMPULSE) {
                impulseZ = Math.sign(impulseZ) * MAX_DYNAMIC_IMPULSE;
            }

                        // 纵向冲量不参与 34 倍补偿。
                        // 判据必须用 Math.abs：跳跃为正、下潜为负，velY > 0.02 会把下潜归零。
            const impulseY = (Math.abs(velY) > JUMP_IDLE)
                ? Math.max(-0.4, Math.min(0.4, velY))
                : 0;

            controller.applyImpulse({
                x: impulseX,
                y: impulseY,
                z: impulseZ
            });

                        // 跳跃只消费正值（一次性动作，不复位会每 tick 累加）；
                        // 负值（下潜）刻意不消费 —— 下沉需要持续施压。
            if (velY > JUMP_IDLE) {
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

// 每帧执行的函数。探针关闭时埋点只付两次函数调用。
const tick = () => {
    const t0 = PerfProbe.now();

    driveMaidMuscles();

    PerfProbe.lap("main.drive", t0);
};

// 注册游戏事件监听器
const events = () => {
    world.afterEvents.projectileHitEntity.subscribe(bulletEntityImpact);
    meleeImpactHandler();
    maidSpearImpact();
};

// 初始化函数
const init = () => {
    // 溺水检测：必须在 initEventBus 之前登记处理器
    initDrowningDetector();

    // 指南与新手套装都只是订阅自己的事件，顺序不敏感
    initFieldManual();
    initStarterKit();

    // 骑乘跟随：自带 runInterval，和动力环一起跑
    initMountFollow();

    // 骑乘载具跟随 / 跟随超距召回（与 D 包同步）
    initVehicleFollow();
    initFollowRecall();

    // 启动统一事件总线（必须在所有模块注册完成之后）
    initEventBus();

        // 1 tick 动力环。safeRun 兜住整轮异常，按 tag 只报一次。
    system.runInterval(() => {
        safeRun("main.tick", tick);
    }, 1);

    // 注册事件监听器
    events();
};

// 调用初始化函数，开始整个流程
init();