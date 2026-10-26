// 导入 Minecraft 服务器相关模块
import { system, world } from '@minecraft/server';

// 导入枪支主循环函数
import { gunLoop } from './dm_entities/common/bullet_main';

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

// 导入buff计算器
import "./dm_entities/common/damage_buff_calculator.js";

// 导入地雷js
import "./element/demon_landmine.js";

// 初始化幻域球
initFictoriaBall();

// 初始化目标管理引擎
DmTargetEngine.init();

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
try {
    world.beforeEvents.entityRemove.subscribe((event) => {
        try {
            const id = event.removedEntity?.id;
            if (id) {
                DriveVelCache.delete(id);
            }
        } catch (_) { }
    });
} catch (_) { }
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

            // 读取走位引擎解算出的速度属性
            const velX = unit.getDynamicProperty("dm:cmd_vel_x") ?? 0;
            const velZ = unit.getDynamicProperty("dm:cmd_vel_z") ?? 0;
            const velY = unit.getDynamicProperty("dm:cmd_vel_y") ?? 0.02;

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
                unit.setDynamicProperty("dm:cmd_vel_y", 0.02);
            }

            mainDriveLog(
                `[MainDrive] ${unit.typeId} | ` +
                `velX=${velX.toFixed(3)} velZ=${velZ.toFixed(3)} velY=${velY.toFixed(3)} | ` +
                `impX=${impulseX.toFixed(3)} impZ=${impulseZ.toFixed(3)}`
            );
        }
    } catch (error) {
        // 高频底层动力线，允许静默兜底
    }
};

// 每帧要执行的函数
const tick = () => {
    driveMaidMuscles();
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
    // 启动 1 Tick 全速丝滑动力环
    system.runInterval(() => {
        try {
            tick();
        } catch (error) {
            // 高频底层动力线，允许静默兜底
        }
    }, 1);

    // 启动 2 Tick 枪械逻辑动力环
    system.runInterval(() => {
        try {
            gunLoop();
        } catch (error) {
            // 枪械逻辑异常静默兜底
        }
    }, 2);

    // 注册事件监听器
    events();
};

// 调用初始化函数，开始整个流程
init();