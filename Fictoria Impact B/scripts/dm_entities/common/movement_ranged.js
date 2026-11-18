import { system, world } from "@minecraft/server";
import {
    writeMoveCmd,
    acquireMoveCmd,
    peekMoveCmd,
    clearMoveCmd
} from "./move_command_store.js";
import {
    factionOf,
    isInCombat
} from "./camp_faction.js";
import {
    detectLiquid,
    applyLiquidSpeed,
    resolveFloatImpulse,
    isDrowningRecovering
} from "./water_traversal.js";
import { isPlayerMounted } from "../player/ride_guard.js";

// 平方距离解析辅助
function getDistSq(pos1, pos2) {
    if (!pos1 || !pos2) return 99999;

    return (pos1.x - pos2.x) ** 2 +
        (pos1.y - pos2.y) ** 2 +
        (pos1.z - pos2.z) ** 2;
}

// 统一清速辅助
function clearRangedCmdVel(unit) {
    try {
        clearMoveCmd(unit);
    } catch (_) {}
}

// 清理静止短后撤状态
function clearStationaryBackState(unit) {
    try {
        rgSet(unit, "dm:stationary_back_until", 0);
        rgSet(unit, "dm:stationary_back_speed", 0);
        rgSet(unit, "dm:stationary_back_exit_buffer", 0);
    } catch (_) {}
}

// 清理受击后撤状态

//   不清理 dm:hurt_back_consumed_tick，
//   避免同一次受击被重复消费。
function clearHurtBackState(unit) {
    try {
        rgSet(unit, "dm:hurt_back_until", 0);
        rgSet(unit, "dm:hurt_back_speed", 0);
        rgSet(unit, "dm:hurt_back_source_id", "");
    } catch (_) {}
}

// 安全读取 tick
function readTick(value) {
    return typeof value === "number" && value > 0
        ? value
        : -999999;
}

// 安全获取实体
function getEntitySafe(entityId) {
    try {
        if (typeof entityId !== "string" || entityId === "") return null;
        if (typeof world.getEntity !== "function") return null;

        const entity = world.getEntity(entityId);

        if (entity && entity.isValid) {
            return entity;
        }

        return null;
    } catch (_) {
        return null;
    }
}

// 动态速度：常态 = 敌人实时速度 × SPEED_MULTIPLIER，上限 strafeSpeed；
// 后撤 / 贴脸的 ×1.5 加速保留，强制后撤时屏蔽。
// EMA 平滑（ALPHA 0.7）滤掉单 tick 速度毛刺。
const SPEED_MULTIPLIER = 1.3;
const EMA_ALPHA = 0.7;
const EMA_DP_KEY = "dm:ema_target_speed";

// 战斗瞬态：每轮必读必写的走位/后撤状态。放动态属性等于每次解算都做实体 NBT IO，
// 而且里面多个是绝对 tick —— currentTick 每次进世界从 0 重计，旧值会让判断永远成立。
// `dm:threat_target_id/_tick` 不在此列：它跟 melee、attackable_target_manager 共用，
// 单方面搬走就是两本账。
const RangedSnap = new Map();

function rgGet(unit, key, dflt) {
    try {
        const s = RangedSnap.get(unit.id);
        if (s && s[key] !== undefined) return s[key];
    } catch (_) { }
    return dflt;
}

function rgSet(unit, key, val) {
    try {
        let s = RangedSnap.get(unit.id);
        if (s === undefined) { s = {}; RangedSnap.set(unit.id, s); }
        if (val === undefined) delete s[key];
        else s[key] = val;
    } catch (_) { }
}

try {
    world.afterEvents.entityRemove.subscribe((ev) => {
        try { RangedSnap.delete(ev.removedEntityId); } catch (_) { }
    });
} catch (_) { }

try {
    world.afterEvents.entityLoad.subscribe((ev) => {
        try { RangedSnap.delete(ev.entity.id); } catch (_) { }
    });
} catch (_) { }

// 静止目标距离维持：安全距离不写速度（交给 JSON 寻路）；过近触发短后撤；
// 拉到退出缓冲后提前停。受击后撤优先级更高。
const STATIONARY_KEEP_RATIO = 0.25;
const STATIONARY_BACK_SPEED = 0.18;
const STATIONARY_BACK_DURATION = 6;
const STATIONARY_BACK_EXIT_BUFFER = 1.35;

// 通用受击直线后撤。触发来源：dm_last_hurt_tick / VictimDamageHistoryMap / threat_target。
// 只有真实攻击者距离 <= strafeRange × HURT_BACK_RANGE_RATIO 才触发，
// 否则远程攻击会让单位一直后退。manager 是 5 tick 一轮，窗口不能太短。
const HURT_BACK_CHECK_WINDOW = 20;
const HURT_BACK_DURATION = 10;
const HURT_BACK_SPEED = 0.35;
const HURT_BACK_RANGE_RATIO = 0.5;
const HURT_BACK_SOURCE_TICK_TOLERANCE = 2;

export class MovementRanged {
    /**
     * 通用战术走位动力学引擎
     * 依靠 dm_has_target 与 dm_skill_on 双重状态机实现战术接管
     */
    static execute(unit, config, closestThreat, closestDistSq, strafeRange, lastDamageTickMap, faction = null) {
        try {
            if (!unit || !unit.isValid) return;

            if (unit.hasTag("maid:ride_player")) {
                clearRangedCmdVel(unit);
                return;
            }

                        // 玩家骑着她 → 熔断走位。远程态尤其明显：引擎要"拉开距离"，
                        // 玩家要"冲上去"，两者每 tick 对冲，坐骑就原地抽搐。
            if (isPlayerMounted(unit)) {
                clearRangedCmdVel(unit);
                return;
            }

            // 阵营：目标引擎已算过，直接传；缺省才现场查一次
            const unitFaction = faction ?? factionOf(unit);

            const controller = unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;
            const nowTick = system.currentTick;
            const uLoc = unit.location;
            const dim = unit.dimension;
            const floorY = Math.floor(uLoc.y);

            // 溺水换气

            // 清空走位指令后 main.js 会把该单位从 ActiveMovers 摘除，
            // 不再施加水平 / 纵向冲量，实体由 behavior.float 自行上浮。
            // 到期后本函数恢复执行，自动重新接管追敌与下潜。
            // 溺水求气：传实体而不是 id —— 解除条件要看「是否出水 / 是否露头」，
            // 只给 id 的话只剩兜底超时可用。
            if (isDrowningRecovering(unit, nowTick)) {
                clearMoveCmd(unit);
                return;
            }

                        // 液体探测（统一走 water_traversal）。waterProbe 是本帧本单位的回执，
                        // 必须每帧新建 —— 跨 tick 复用会读到旧方块。
            const waterProbe = {};
            const isInLiquid = detectLiquid(dim, uLoc, waterProbe);
            const isFloatingInWater = isInLiquid && !controller.isOnGround;

            // 空气阻尼衰减
            if (!controller.isOnGround && !isInLiquid) {
                // 就地衰减，省掉「读-改-写」三轮查表
                const airCmd = acquireMoveCmd(unit);

                airCmd.x *= 0.65;
                airCmd.z *= 0.65;
                airCmd.y = 0;

                return;
            }

            // 地面战术走位 或 水中战术走位核心决策
            if (controller.isOnGround || isInLiquid) {
                const isCombat = isInCombat(unit, unitFaction);

                if (!isCombat) {
                    clearRangedCmdVel(unit);
                    return;
                }

                                // 通用受击直线后撤（最高优先级）：最近被真实攻击者近距离攻击就强制后撤，
                                // 距离限制 strafeRange × 0.5；不看目标是否静止、是否在环绕。
                let hurtBackMode = false;
                let hurtBackSpeed = HURT_BACK_SPEED;
                let hurtBackUntil = rgGet(unit, "dm:hurt_back_until", 0);
                let hurtBackSourceId = rgGet(unit, "dm:hurt_back_source_id", "");

                const managerHurtTick = readTick(unit.getDynamicProperty("dm_last_hurt_tick"));

                const victimLog = lastDamageTickMap
                    ? lastDamageTickMap.get(unit.id)
                    : undefined;

                const victimLogTick = readTick(victimLog ? victimLog.tick : undefined);
                const threatTick = readTick(unit.getDynamicProperty("dm:threat_target_tick"));

                const latestHurtTick = Math.max(
                    managerHurtTick,
                    victimLogTick,
                    threatTick
                );

                const lastConsumedHurtTick = rgGet(unit, "dm:hurt_back_consumed_tick", -1);

                                // `dm_last_hurt_tick` / `dm:threat_target_tick` 落盘，存的是**绝对 tick**。
                                // 进世界后 currentTick 从 0 重计，旧存档里的 tick 一定大于当前 tick →
                                // `nowTick - 旧tick` 变成大负数，`<= 20` 恒真，重进世界第一帧就白送一次后撤。
                                // 判据：tick 比当前还大 = 上一局的，一律当过期。
                const hurtTickInSession = latestHurtTick > 0 && latestHurtTick <= nowTick;

                if (hurtTickInSession && latestHurtTick > lastConsumedHurtTick) {
                    let triggered = false;

                    if (nowTick - latestHurtTick <= HURT_BACK_CHECK_WINDOW) {
                        const threatIdRaw = unit.getDynamicProperty("dm:threat_target_id");
                        const threatId = typeof threatIdRaw === "string"
                            ? threatIdRaw
                            : "";

                        const threatTickClose =
                            threatTick > 0 &&
                            latestHurtTick - threatTick <= HURT_BACK_SOURCE_TICK_TOLERANCE;

                        // 实时获取真实攻击者当前距离。
                        const lastHurtDist = rgGet(unit, "dm:last_hurt_dist");
                        const lastHurtDistTick = readTick(rgGet(unit, "dm:last_hurt_dist_tick"));

                        const hasRecordedDist =
                            lastHurtDistTick === latestHurtTick &&
                            typeof lastHurtDist === "number" &&
                            lastHurtDist >= 0;

                        let sourceDistSq = 99999;
                        let hasSourceDistance = false;

                        if (hasRecordedDist) {
                            sourceDistSq = lastHurtDist * lastHurtDist;
                            hasSourceDistance = true;
                        } else if (threatId !== "" && threatTickClose) {
                            const sourceEntity = getEntitySafe(threatId);

                            if (sourceEntity) {
                                sourceDistSq = getDistSq(uLoc, sourceEntity.location);
                                hasSourceDistance = true;
                            }
                        }

                        if (hasSourceDistance) {
                            const hurtBackRange = strafeRange * HURT_BACK_RANGE_RATIO;
                            const hurtBackRangeSq = hurtBackRange * hurtBackRange;

                            if (sourceDistSq <= hurtBackRangeSq) {
                                triggered = true;

                                hurtBackUntil = nowTick + HURT_BACK_DURATION;
                                hurtBackSpeed = HURT_BACK_SPEED;
                                hurtBackSourceId = threatId;

                                rgSet(unit, "dm:hurt_back_until", hurtBackUntil);
                                rgSet(unit, "dm:hurt_back_speed", hurtBackSpeed);
                                rgSet(unit, "dm:hurt_back_source_id", hurtBackSourceId);
                            }
                        }
                    }

                    // ------------------------------------------------------------
                    // 无论是否触发，都消费掉这次受击。

                    // 这样远距离攻击不会留在记录里，
                    // 避免单位之后靠近时突然误触发。
                    // ------------------------------------------------------------
                    rgSet(unit, "dm:hurt_back_consumed_tick", latestHurtTick);
                }

                if (nowTick < hurtBackUntil) {
                    hurtBackMode = true;
                    hurtBackSpeed = rgGet(unit, "dm:hurt_back_speed", HURT_BACK_SPEED);
                    hurtBackSourceId = rgGet(unit, "dm:hurt_back_source_id", "");
                } else if (hurtBackUntil !== 0) {
                    clearHurtBackState(unit);
                    hurtBackSourceId = "";
                }

                // 获取当前走位参照物

                // 受击后撤允许：
                //   1. 目标超出 strafeRange
                //   2. 暂时没有有效目标时使用视角后撤兜底
                let activeTarget = closestThreat;
                let activeDistSq = closestDistSq;
                const strafeRangeSq = strafeRange * strafeRange;

                if (
                    (!activeTarget || !activeTarget.isValid || activeDistSq > strafeRangeSq) &&
                    unit.target &&
                    unit.target.isValid
                ) {
                    activeTarget = unit.target;
                    activeDistSq = getDistSq(uLoc, unit.target.location);
                }

                let useBackFallback = false;

                if (!activeTarget || !activeTarget.isValid) {
                    if (hurtBackMode) {
                        useBackFallback = true;
                        activeDistSq = 0;
                    } else {
                        clearRangedCmdVel(unit);
                        return;
                    }
                }

                if (
                    !useBackFallback &&
                    activeDistSq > strafeRangeSq &&
                    !hurtBackMode
                ) {
                    clearRangedCmdVel(unit);
                    return;
                }

                // 目标速度只读取一次
                let targetVelocity = null;

                if (!useBackFallback && activeTarget && activeTarget.isValid) {
                    try {
                        targetVelocity = activeTarget.getVelocity();
                    } catch (_) {}
                }

                const isTargetStationary =
                    !useBackFallback &&
                    targetVelocity &&
                    (targetVelocity.x * targetVelocity.x + targetVelocity.z * targetVelocity.z) < 0.00001;

                // 静止目标距离维持状态

                // 受击后撤优先级更高。
                // 如果处于受击后撤，则跳过静止短后撤逻辑。
                let stationaryBackMode = false;
                let stationaryBackSpeed = 0;

                if (hurtBackMode) {
                    const oldStationaryUntil = rgGet(unit, "dm:stationary_back_until");
                    if (oldStationaryUntil !== undefined && oldStationaryUntil !== 0) {
                        clearStationaryBackState(unit);
                    }
                } else if (isTargetStationary) {
                    const stationaryKeepRange = strafeRange * STATIONARY_KEEP_RATIO;
                    const stationaryKeepRangeSq = stationaryKeepRange * stationaryKeepRange;

                    let stationaryBackUntil = rgGet(unit, "dm:stationary_back_until", 0);
                    let stationaryExitBuffer = rgGet(unit, "dm:stationary_back_exit_buffer", STATIONARY_BACK_EXIT_BUFFER);

                    // ------------------------------------------------------------
                    // 短后撤窗口尚未结束

                    // 如果距离已经拉到退出缓冲距离，则提前停止，
                    // 避免一次性撤得太远。
                    // ------------------------------------------------------------
                    if (nowTick < stationaryBackUntil) {
                        stationaryBackSpeed = rgGet(unit, "dm:stationary_back_speed", STATIONARY_BACK_SPEED);
                        stationaryExitBuffer = rgGet(unit, "dm:stationary_back_exit_buffer", STATIONARY_BACK_EXIT_BUFFER);

                        const stationaryExitRange = stationaryKeepRange * stationaryExitBuffer;
                        const stationaryExitRangeSq = stationaryExitRange * stationaryExitRange;

                        if (activeDistSq > stationaryExitRangeSq) {
                            clearStationaryBackState(unit);
                            rgSet(unit, EMA_DP_KEY, 0);
                            clearRangedCmdVel(unit);
                            return;
                        }

                        stationaryBackMode = true;
                    }
                    // ------------------------------------------------------------
                    // 距离过近 → 触发短后撤
                    // ------------------------------------------------------------
                    else if (activeDistSq <= stationaryKeepRangeSq) {
                        stationaryBackMode = true;
                        stationaryBackSpeed = STATIONARY_BACK_SPEED;
                        stationaryBackUntil = nowTick + STATIONARY_BACK_DURATION;
                        stationaryExitBuffer = STATIONARY_BACK_EXIT_BUFFER;

                        rgSet(unit, "dm:stationary_back_until", stationaryBackUntil);
                        rgSet(unit, "dm:stationary_back_speed", stationaryBackSpeed);
                        rgSet(unit, "dm:stationary_back_exit_buffer", stationaryExitBuffer);
                    }
                    // ------------------------------------------------------------
                    // 静止 + 距离安全 + 未受击 → 完全交给 JSON 寻路
                    // ------------------------------------------------------------
                    else {
                        clearStationaryBackState(unit);
                        rgSet(unit, EMA_DP_KEY, 0);
                        clearRangedCmdVel(unit);
                        return;
                    }
                } else {
                    const oldStationaryUntil = rgGet(unit, "dm:stationary_back_until");
                    if (oldStationaryUntil !== undefined && oldStationaryUntil !== 0) {
                        clearStationaryBackState(unit);
                    }
                }

                // 强制后撤统一入口

                // 受击后撤优先级高于静止短后撤。
                const forcedBackMode = hurtBackMode || stationaryBackMode;
                const forcedBackSpeed = hurtBackMode
                    ? hurtBackSpeed
                    : stationaryBackSpeed;

                // 多模态战术环绕切换判定
                let strafeDirection = rgGet(unit, "dm:strafe_line");
                let lastModeTick = rgGet(unit, "dm:strafe_mode_tick", 0);

                const halfStrafeRange = strafeRange * 0.5;
                const halfStrafeRangeSq = halfStrafeRange * halfStrafeRange;

                // ------------------------------------------------------------
                // 强制后撤模式下不参与随机环绕，直接向后
                // ------------------------------------------------------------
                if (forcedBackMode) {
                    strafeDirection = 0;
                } else if (
                    strafeDirection === undefined ||
                    (nowTick - lastModeTick >= (rgGet(unit, "dm:strafe_cooldown", 40)))
                ) {
                    const rand = Math.random();
                    const isCloseRange = activeDistSq < halfStrafeRangeSq;

                    if (isCloseRange) {
                        if (rand < 0.70) {
                            strafeDirection = 0;
                        } else {
                            strafeDirection = Math.random() < 0.5 ? 1 : -1;
                        }
                    } else {
                        if (rand < 0.40) {
                            strafeDirection = 1;
                        } else if (rand < 0.80) {
                            strafeDirection = -1;
                        } else {
                            strafeDirection = 0;
                        }
                    }

                    rgSet(unit, "dm:strafe_line", strafeDirection);
                    rgSet(unit, "dm:strafe_mode_tick", nowTick);
                    rgSet(unit, "dm:strafe_cooldown", Math.floor(Math.random() * 20) + 30);
                }

                                // 切向 / 法向向量：正常以当前目标为参照；受击后撤优先用真实攻击者方向，
                                // 没有有效参照物时用自身视角（最终向视角反方向直线后撤）。
                let dx = 0;
                let dy = 0;
                let dz = 0;
                let dirX = 0;
                let dirZ = 0;

                if (!useBackFallback && activeTarget && activeTarget.isValid) {
                    const tLoc = activeTarget.location;

                    dx = tLoc.x - uLoc.x;
                    dy = tLoc.y - uLoc.y;
                    dz = tLoc.z - uLoc.z;

                    const len = Math.sqrt(dx * dx + dz * dz) || 0.001;

                    dirX = dx / len;
                    dirZ = dz / len;
                } else {
                    try {
                        const viewDir = unit.getViewDirection();
                        const vLen = Math.sqrt(viewDir.x * viewDir.x + viewDir.z * viewDir.z) || 0.001;

                        dirX = viewDir.x / vLen;
                        dirZ = viewDir.z / vLen;
                    } catch (_) {
                        dirX = 1;
                        dirZ = 0;
                    }
                }

                // ------------------------------------------------------------
                // 受击后撤优先使用真实攻击者方向

                // 这里仍然计算“从自己指向攻击源”的方向。
                // 后面角度使用 Math.PI 后，会自动反向，
                // 所以最终冲量是远离攻击源。
                // ------------------------------------------------------------
                if (hurtBackMode && hurtBackSourceId !== "") {
                    const sourceEntity = getEntitySafe(hurtBackSourceId);

                    if (sourceEntity) {
                        const sdx = sourceEntity.location.x - uLoc.x;
                        const sdz = sourceEntity.location.z - uLoc.z;
                        const sLen = Math.sqrt(sdx * sdx + sdz * sdz) || 0.001;

                        dirX = sdx / sLen;
                        dirZ = sdz / sLen;
                    }
                }

                let distancing = 1;
                const maxConfigSpeed = config.strafeSpeed ?? 1.2;
                let finalSpeed = maxConfigSpeed;

                // 动态读取状态机比率（药水 / 减速等 Buff）
                let statusSpeedFactor = 1.0;
                try {
                    const movementComp = unit.getComponent("minecraft:movement");

                    if (movementComp) {
                        const currentMove = movementComp.currentValue;
                        const defaultMove = movementComp.defaultValue;

                        if (defaultMove > 0) {
                            statusSpeedFactor = currentMove / defaultMove;
                        }
                    }
                } catch (_) {
                    statusSpeedFactor = 1.0;
                }

                // 动态速度算法

                // 强制后撤模式：
                //   直接使用固定后撤速度

                // 正常移动目标：
                //   使用敌人实时速度 × SPEED_MULTIPLIER
                if (forcedBackMode) {
                    finalSpeed = forcedBackSpeed;

                    // 清空旧 EMA，避免后撤结束后速度追踪突然跳变
                    rgSet(unit, EMA_DP_KEY, 0);
                } else if (targetVelocity) {
                    const rawSpeed = Math.sqrt(
                        targetVelocity.x * targetVelocity.x +
                        targetVelocity.z * targetVelocity.z
                    );

                    const lastSmoothedSpeed = rgGet(unit, EMA_DP_KEY, rawSpeed);
                    const smoothedSpeed = rawSpeed * EMA_ALPHA + lastSmoothedSpeed * (1 - EMA_ALPHA);

                    rgSet(unit, EMA_DP_KEY, smoothedSpeed);

                    finalSpeed = Math.min(smoothedSpeed * SPEED_MULTIPLIER, maxConfigSpeed);
                }

                // 速度增益流水线全额结算
                finalSpeed *= statusSpeedFactor;

                // 液体减速只结算一次（water_traversal 统一口径）
                finalSpeed = applyLiquidSpeed(finalSpeed, isInLiquid, isFloatingInWater);

                // ------------------------------------------------------------
                // 强制后撤模式下屏蔽旧逻辑的后撤加速与贴脸加速
                // 避免直线后撤被旧逻辑二次放大
                // ------------------------------------------------------------
                const suppressSpeedBoost = forcedBackMode;

                // 后撤加速（设计保留；强制后撤时屏蔽）
                if (!suppressSpeedBoost && strafeDirection === 0) {
                    finalSpeed *= 1.5;
                }

                // 贴脸加速（设计保留；强制后撤时屏蔽）
                if (forcedBackMode) {
                    distancing = -1;
                } else if (activeDistSq < halfStrafeRangeSq) {
                    distancing = -1;

                    if (!suppressSpeedBoost) {
                        finalSpeed *= 1.5;
                    }
                }

                // 核心角度旋转矩阵映射

                // 强制后撤模式强制向后
                let angle = 0;

                if (forcedBackMode || strafeDirection === 0) {
                    angle = Math.PI;
                } else {
                    angle = (strafeDirection * (90 - distancing * 30)) * (Math.PI / 180);
                }

                const cosA = Math.cos(angle);
                const sinA = Math.sin(angle);

                let impulseX = dirX * cosA - dirZ * sinA;
                let impulseZ = dirX * sinA + dirZ * cosA;

                // 群怪平滑优化：防止目标突变导致冲量瞬间死锁
                let lastImpulseX = rgGet(unit, "dm:last_impulse_x", impulseX);
                let lastImpulseZ = rgGet(unit, "dm:last_impulse_z", impulseZ);

                impulseX = lastImpulseX * 0.3 + impulseX * 0.7;
                impulseZ = lastImpulseZ * 0.3 + impulseZ * 0.7;

                rgSet(unit, "dm:last_impulse_x", impulseX);
                rgSet(unit, "dm:last_impulse_z", impulseZ);

                let jumpImpulse = 0.05;

                                // 液体减速只在上面结算一次。此处原先重复乘了一次，
                                // 浮游变成 0.20 × 0.20 = 4%。预期：浮游 20% / 涉水 60%。

                                // 动态 Y 轴立体水动力解算（water_traversal 统一口径）
                if (isFloatingInWater) {
                    jumpImpulse = resolveFloatImpulse(dim, uLoc, dy, waterProbe);
                } else {
                    // 原生前方雷达防卡墙检测
                    if (distancing === -1) {
                        const checkLocationLower = {
                            x: uLoc.x + impulseX * 1.2,
                            y: uLoc.y + 1,
                            z: uLoc.z + impulseZ * 1.2
                        };

                        const checkLocationUpper = {
                            x: uLoc.x + impulseX * 1.2,
                            y: uLoc.y + 2,
                            z: uLoc.z + impulseZ * 1.2
                        };

                        try {
                            const blockLower = dim.getBlock(checkLocationLower);

                            if (blockLower && !blockLower.isAir && !blockLower.isLiquid) {
                                const blockUpper = dim.getBlock(checkLocationUpper);

                                if (blockUpper && (blockUpper.isAir || blockUpper.isLiquid)) {
                                    jumpImpulse = 0.45;
                                } else {
                                    if (strafeDirection === 0) {
                                        strafeDirection = Math.random() < 0.5 ? 1 : -1;
                                        jumpImpulse = 0.45;
                                    } else {
                                        strafeDirection *= -1;
                                    }

                                    rgSet(unit, "dm:strafe_line", strafeDirection);
                                    rgSet(unit, "dm:strafe_mode_tick", nowTick);

                                    let newAngle;

                                    if (strafeDirection === 0) {
                                        newAngle = Math.PI;
                                    } else {
                                        newAngle = (strafeDirection * (90 - distancing * 45)) * (Math.PI / 180);
                                    }

                                    const cosNew = Math.cos(newAngle);
                                    const sinNew = Math.sin(newAngle);

                                    impulseX = dirX * cosNew - dirZ * sinNew;
                                    impulseZ = dirX * sinNew + dirZ * cosNew;
                                }
                            }
                        } catch (_) {}
                    }
                }

                // 防悬崖与岩浆雷达熔断机制
                if ((impulseX !== 0 || impulseZ !== 0) && !isFloatingInWater) {
                    const probeX = uLoc.x + impulseX * 1.3;
                    const probeZ = uLoc.z + impulseZ * 1.3;

                    let isDangerous = false;

                    try {
                        const currentBlock = dim.getBlock({
                            x: uLoc.x,
                            y: floorY,
                            z: uLoc.z
                        });

                        const forwardBlock = dim.getBlock({
                            x: probeX,
                            y: floorY,
                            z: probeZ
                        });

                        const forwardBelowBlock = dim.getBlock({
                            x: probeX,
                            y: floorY - 1,
                            z: probeZ
                        });

                        if (
                            (currentBlock && currentBlock.typeId.includes("lava")) ||
                            (forwardBlock && forwardBlock.typeId.includes("lava")) ||
                            (forwardBelowBlock && forwardBelowBlock.typeId.includes("lava"))
                        ) {
                            isDangerous = true;
                        }

                        if (!isDangerous && forwardBlock && (forwardBlock.isAir || forwardBlock.isLiquid)) {
                            if (forwardBelowBlock && (forwardBelowBlock.isAir || forwardBelowBlock.isLiquid)) {
                                const deepBelowBlock = dim.getBlock({
                                    x: probeX,
                                    y: floorY - 3,
                                    z: probeZ
                                });

                                if (deepBelowBlock && (deepBelowBlock.isAir || deepBelowBlock.isLiquid)) {
                                    isDangerous = true;
                                }
                            }
                        }
                    } catch (_) {
                        isDangerous = true;
                    }

                    if (isDangerous) {
                        impulseX = 0;
                        impulseZ = 0;
                        jumpImpulse = 0;

                        if (strafeDirection === 0) {
                            strafeDirection = Math.random() < 0.5 ? 1 : -1;
                        } else {
                            strafeDirection *= -1;
                        }

                        rgSet(unit, "dm:strafe_line", strafeDirection);
                        rgSet(unit, "dm:strafe_mode_tick", nowTick);
                        rgSet(unit, "dm:strafe_cooldown", 15);
                    }
                }

                // 1x1 窄坑与矮洞刚性卡死自解脱防线
                const lastX = rgGet(unit, "dm:last_x");
                const lastZ = rgGet(unit, "dm:last_z");
                let stuckTicks = rgGet(unit, "dm:stuck_ticks", 0);

                if (!isFloatingInWater) {
                    if (lastX !== undefined && lastZ !== undefined) {
                        const realDistSq = (uLoc.x - lastX) ** 2 + (uLoc.z - lastZ) ** 2;

                        if (realDistSq < 0.005) {
                            stuckTicks += 5;
                        } else {
                            stuckTicks = Math.max(0, stuckTicks - 2);
                        }
                    }

                    if (
                        stuckTicks >= 30 ||
                        (
                            stuckTicks >= 15 &&
                            lastX !== undefined &&
                            (uLoc.x - lastX) ** 2 + (uLoc.z - lastZ) ** 2 < 0.0005
                        )
                    ) {
                        try {
                            const ceilingLoc = {
                                x: uLoc.x,
                                y: floorY + 2,
                                z: uLoc.z
                            };

                            let isCeilingBlocked = false;

                            try {
                                const ceilingBlock = dim.getBlock(ceilingLoc);

                                if (ceilingBlock && !ceilingBlock.isAir && !ceilingBlock.isLiquid) {
                                    isCeilingBlocked = true;
                                }
                            } catch (_) {}

                            unit.clearVelocity();

                            // 只清水平分量，保留 y —— 与原 setDynamicProperty 行为一致
                            const heldCmd = acquireMoveCmd(unit);
                            heldCmd.x = 0;
                            heldCmd.z = 0;

                            if (isCeilingBlocked) {
                                let escapeX = -impulseX;
                                let escapeZ = -impulseZ;

                                if (escapeX === 0 && escapeZ === 0) {
                                    const viewDir = unit.getViewDirection();
                                    escapeX = -viewDir.x;
                                    escapeZ = -viewDir.z;
                                }

                                const escapeLen = Math.sqrt(escapeX * escapeX + escapeZ * escapeZ) || 0.001;
                                escapeX /= escapeLen;
                                escapeZ /= escapeLen;

                                impulseX = escapeX * 1.8;
                                impulseZ = escapeZ * 1.8;
                                jumpImpulse = 0;

                                rgSet(unit, "dm:strafe_line", Math.random() < 0.5 ? 1 : -1);
                                rgSet(unit, "dm:strafe_mode_tick", nowTick);
                                rgSet(unit, "dm:strafe_cooldown", 20);
                            } else {
                                // 脱困抬升同样要作用在坐骑上：对骑手 teleport 会让她下马
                                let liftTarget = unit;

                                try {
                                    const rideMount = unit.getComponent("minecraft:riding")?.entityRidingOn;

                                    if (rideMount && rideMount.isValid) {
                                        liftTarget = rideMount;
                                    }
                                } catch (_) { }

                                const liftLoc = liftTarget.location;

                                liftTarget.teleport(
                                    {
                                        x: liftLoc.x,
                                        y: liftLoc.y + 0.6,
                                        z: liftLoc.z
                                    },
                                    {
                                        checkForBlocks: false
                                    }
                                );

                                jumpImpulse = 0.55;

                                rgSet(unit, "dm:strafe_line", Math.random() < 0.5 ? 1 : -1);
                                rgSet(unit, "dm:strafe_mode_tick", nowTick);
                            }
                        } catch (_) {}

                        stuckTicks = 0;
                    }

                    rgSet(unit, "dm:last_x", uLoc.x);
                    rgSet(unit, "dm:last_z", uLoc.z);
                }

                rgSet(unit, "dm:stuck_ticks", stuckTicks);

                // 受击物理抗性阻尼

                // 强制后撤必须保证能撤动，避免受击阻尼把后撤压没。
                let hurtResistance = 1.0;
                const selfHurtLog = lastDamageTickMap ? lastDamageTickMap.get(unit.id) : undefined;

                if (selfHurtLog) {
                    const hurtTick = typeof selfHurtLog === "number"
                        ? selfHurtLog
                        : selfHurtLog.tick;

                    if (typeof hurtTick === "number" && nowTick - hurtTick <= 8) {
                        hurtResistance = 0.45;
                    }
                }

                if (forcedBackMode) {
                    hurtResistance = 1.0;
                }

                // 最终解算写入物理冲量
                writeMoveCmd(
                    unit,
                    impulseX * finalSpeed * 1.0 * hurtResistance,
                    impulseZ * finalSpeed * 1.0 * hurtResistance,
                    jumpImpulse
                );
            }
        } catch (strafeError) {
            console.error(`[DM-Movement Engine Error] 走位计算决策异常: ${strafeError}`);
        }
    }
}