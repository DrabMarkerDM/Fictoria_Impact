import { system } from "@minecraft/server";

// ============================================================
// 保持与原版完全一致的平方距离解析辅助
// ============================================================
function getDistSq(pos1, pos2) {
    if (!pos1 || !pos2) return 99999;
    return (pos1.x - pos2.x) ** 2 +
           (pos1.y - pos2.y) ** 2 +
           (pos1.z - pos2.z) ** 2;
}

// ============================================================
// 统一清速辅助
// ============================================================
function clearRangedCmdVel(unit) {
    try {
        unit.setDynamicProperty("dm:cmd_vel_x", 0);
        unit.setDynamicProperty("dm:cmd_vel_z", 0);
        unit.setDynamicProperty("dm:cmd_vel_y", 0);
    } catch (_) {}
}

// ============================================================
// 动态速度算法常量
//
// 设计意图：
//   常态走位速度 = 敌人实时速度 × SPEED_MULTIPLIER
//   上限 = strafeSpeed（配置表）
//   后撤 / 贴脸的 ×1.5 加速保留
//   目标静止时停止走位
//
// EMA 平滑：
//   避免敌人瞬时速度波动导致走位抖动。
//   smoothed = raw × EMA_ALPHA + lastSmoothed × (1 - EMA_ALPHA)
//   EMA_ALPHA = 0.7 → 70% 新值 + 30% 旧值
//   响应快，同时过滤掉单 tick 的速度毛刺。
// ============================================================
const SPEED_MULTIPLIER = 1.3;
const EMA_ALPHA = 0.7;
const EMA_DP_KEY = "dm:ema_target_speed";

export class MovementRanged {
    /**
     * 通用战术走位动力学引擎
     * 依靠 dm_has_target 与 dm_skill_on 双重状态机实现战术接管
     */
    static execute(unit, config, closestThreat, closestDistSq, strafeRange, lastDamageTickMap) {
        try {
            if (!unit || !unit.isValid) return;

            if (unit.hasTag("maid:ride_player")) {
                clearRangedCmdVel(unit);
                return;
            }

            const controller = unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;
            const nowTick = system.currentTick;
            const uLoc = unit.location;
            const dim = unit.dimension;
            const floorY = Math.floor(uLoc.y);

            // ============================================================
            // 引入高频叠影立体液体探测
            // ============================================================
            let isInLiquid = false;
            try {
                const feetBlock = dim.getBlock({
                    x: uLoc.x,
                    y: floorY,
                    z: uLoc.z
                });
                const waistBlock = dim.getBlock({
                    x: uLoc.x,
                    y: floorY + 1,
                    z: uLoc.z
                });
                if ((feetBlock && feetBlock.isLiquid) || (waistBlock && waistBlock.isLiquid)) {
                    isInLiquid = true;
                }
            } catch (_) {}

            const isFloatingInWater = isInLiquid && !controller.isOnGround;

            const liquidSpeedFactor = isInLiquid
                ? (isFloatingInWater ? 0.20 : 0.60)
                : 1.0;

            // ============================================================
            // 空气阻尼衰减
            // ============================================================
            if (!controller.isOnGround && !isInLiquid) {
                let currentVelX = unit.getDynamicProperty("dm:cmd_vel_x") ?? 0;
                let currentVelZ = unit.getDynamicProperty("dm:cmd_vel_z") ?? 0;
                unit.setDynamicProperty("dm:cmd_vel_x", currentVelX * 0.65);
                unit.setDynamicProperty("dm:cmd_vel_z", currentVelZ * 0.65);
                unit.setDynamicProperty("dm:cmd_vel_y", 0);
                return;
            }

            // ============================================================
            // 地面战术走位 或 水中战术走位核心决策
            // ============================================================
            if (controller.isOnGround || isInLiquid) {
                const isCombat = unit.hasTag("dm_has_target") || unit.hasTag("dm_skill_on");
                if (!isCombat) {
                    clearRangedCmdVel(unit);
                    return;
                }

                // ============================================================
                // 获取当前走位参照物
                // ============================================================
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

                if (!activeTarget || !activeTarget.isValid || activeDistSq > strafeRangeSq) {
                    clearRangedCmdVel(unit);
                    return;
                }

                // ============================================================
                // 目标速度只读取一次
                // ============================================================
                let targetVelocity = null;
                try {
                    targetVelocity = activeTarget.getVelocity();
                } catch (_) {}

                // 目标静止时停止走位
                const isTargetStationary =
                    targetVelocity &&
                    (targetVelocity.x * targetVelocity.x + targetVelocity.z * targetVelocity.z) < 0.00001;

                if (isTargetStationary) {
                    clearRangedCmdVel(unit);
                    return;
                }

                // ============================================================
                // 多模态战术环绕切换判定
                // ============================================================
                let strafeDirection = unit.getDynamicProperty("dm:strafe_line");
                let lastModeTick = unit.getDynamicProperty("dm:strafe_mode_tick") ?? 0;

                const halfStrafeRange = strafeRange * 0.5;
                const halfStrafeRangeSq = halfStrafeRange * halfStrafeRange;

                if (
                    strafeDirection === undefined ||
                    (nowTick - lastModeTick >= (unit.getDynamicProperty("dm:strafe_cooldown") ?? 40))
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

                    unit.setDynamicProperty("dm:strafe_line", strafeDirection);
                    unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                    unit.setDynamicProperty("dm:strafe_cooldown", Math.floor(Math.random() * 20) + 30);
                }

                // ============================================================
                // 计算当前帧的切向与法向移动向量
                // ============================================================
                const tLoc = activeTarget.location;
                const dx = tLoc.x - uLoc.x;
                const dy = tLoc.y - uLoc.y;
                const dz = tLoc.z - uLoc.z;
                const len = Math.sqrt(dx * dx + dz * dz) || 0.001;
                const dirX = dx / len;
                const dirZ = dz / len;

                let distancing = 1;
                const maxConfigSpeed = config.strafeSpeed ?? 1.2;
                let finalSpeed = maxConfigSpeed;

                // ============================================================
                // 动态读取状态机比率（药水 / 减速等 Buff）
                // ============================================================
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

                // ============================================================
                // ★ 动态速度算法（EMA 平滑 + 倍率追踪）
                //
                // 公式：
                //   smoothedSpeed = rawSpeed × 0.7 + lastSmoothed × 0.3
                //   finalSpeed = min(smoothedSpeed × 1.3, maxConfigSpeed)
                //
                // 后撤 / 贴脸的 ×1.5 在下方叠加，不受此上限约束。
                // ============================================================
                if (targetVelocity) {
                    const rawSpeed = Math.sqrt(
                        targetVelocity.x * targetVelocity.x +
                        targetVelocity.z * targetVelocity.z
                    );

                    const lastSmoothedSpeed = unit.getDynamicProperty(EMA_DP_KEY) ?? rawSpeed;
                    const smoothedSpeed = rawSpeed * EMA_ALPHA + lastSmoothedSpeed * (1 - EMA_ALPHA);
                    unit.setDynamicProperty(EMA_DP_KEY, smoothedSpeed);

                    finalSpeed = Math.min(smoothedSpeed * SPEED_MULTIPLIER, maxConfigSpeed);
                }

                // ============================================================
                // 速度增益流水线全额结算
                // ============================================================
                finalSpeed *= statusSpeedFactor;
                finalSpeed *= liquidSpeedFactor;

                // 后撤加速（设计保留）
                if (strafeDirection === 0) {
                    finalSpeed *= 1.5;
                }

                // 贴脸加速（设计保留）
                if (activeDistSq < halfStrafeRangeSq) {
                    distancing = -1;
                    finalSpeed *= 1.5;
                }

                // ============================================================
                // 核心角度旋转矩阵映射
                // ============================================================
                let angle = 0;
                if (strafeDirection === 0) {
                    angle = Math.PI;
                } else {
                    angle = (strafeDirection * (90 - distancing * 30)) * (Math.PI / 180);
                }

                const cosA = Math.cos(angle);
                const sinA = Math.sin(angle);

                let impulseX = dirX * cosA - dirZ * sinA;
                let impulseZ = dirX * sinA + dirZ * cosA;

                // ============================================================
                // 群怪平滑优化：防止目标突变导致冲量瞬间死锁
                // ============================================================
                let lastImpulseX = unit.getDynamicProperty("dm:last_impulse_x") ?? impulseX;
                let lastImpulseZ = unit.getDynamicProperty("dm:last_impulse_z") ?? impulseZ;

                impulseX = lastImpulseX * 0.3 + impulseX * 0.7;
                impulseZ = lastImpulseZ * 0.3 + impulseZ * 0.7;

                unit.setDynamicProperty("dm:last_impulse_x", impulseX);
                unit.setDynamicProperty("dm:last_impulse_z", impulseZ);

                let jumpImpulse = 0.05;

                // ============================================================
                // 第二次液体减速（保留原逻辑）
                // ============================================================
                finalSpeed *= liquidSpeedFactor;

                // ============================================================
                // 动态 Y 轴立体水动力解算
                // ============================================================
                if (isFloatingInWater) {
                    let isAtWaterSurface = false;
                    try {
                        const surfaceCheckBlock = dim.getBlock({
                            x: uLoc.x,
                            y: Math.floor(uLoc.y + 1.6),
                            z: uLoc.z
                        });
                        if (surfaceCheckBlock && surfaceCheckBlock.isAir) {
                            isAtWaterSurface = true;
                        }
                    } catch (_) {}

                    if (dy > 0.5 && !isAtWaterSurface) {
                        jumpImpulse = 0.18;
                    } else if (dy < -0.5) {
                        jumpImpulse = -0.20;
                    } else {
                        jumpImpulse = isAtWaterSurface ? -0.08 : 0.05;
                    }
                } else {
                    // ============================================================
                    // 原生前方雷达防卡墙检测
                    // ============================================================
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

                                    unit.setDynamicProperty("dm:strafe_line", strafeDirection);
                                    unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);

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

                // ============================================================
                // 防悬崖与岩浆雷达熔断机制
                // ============================================================
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

                        unit.setDynamicProperty("dm:strafe_line", strafeDirection);
                        unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                        unit.setDynamicProperty("dm:strafe_cooldown", 15);
                    }
                }

                // ============================================================
                // 1x1 窄坑与矮洞刚性卡死自解脱防线
                // ============================================================
                const lastX = unit.getDynamicProperty("dm:last_x");
                const lastZ = unit.getDynamicProperty("dm:last_z");
                let stuckTicks = unit.getDynamicProperty("dm:stuck_ticks") ?? 0;

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
                            unit.setDynamicProperty("dm:cmd_vel_x", 0);
                            unit.setDynamicProperty("dm:cmd_vel_z", 0);

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

                                unit.setDynamicProperty("dm:strafe_line", Math.random() < 0.5 ? 1 : -1);
                                unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                                unit.setDynamicProperty("dm:strafe_cooldown", 20);
                            } else {
                                unit.teleport(
                                    {
                                        x: uLoc.x,
                                        y: uLoc.y + 0.6,
                                        z: uLoc.z
                                    },
                                    {
                                        checkForBlocks: false
                                    }
                                );

                                jumpImpulse = 0.55;

                                unit.setDynamicProperty("dm:strafe_line", Math.random() < 0.5 ? 1 : -1);
                                unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                            }
                        } catch (_) {}

                        stuckTicks = 0;
                    }

                    unit.setDynamicProperty("dm:last_x", uLoc.x);
                    unit.setDynamicProperty("dm:last_z", uLoc.z);
                }

                unit.setDynamicProperty("dm:stuck_ticks", stuckTicks);

                // ============================================================
                // 受击物理抗性阻尼
                // ============================================================
                let hurtResistance = 1.0;
                const selfHurtLog = lastDamageTickMap ? lastDamageTickMap.get(unit.id) : undefined;
                if (selfHurtLog && (nowTick - selfHurtLog.tick <= 8)) {
                    hurtResistance = 0.45;
                }

                // ============================================================
                // 最终解算写入物理冲量
                // ============================================================
                unit.setDynamicProperty("dm:cmd_vel_x", impulseX * finalSpeed * 1.0 * hurtResistance);
                unit.setDynamicProperty("dm:cmd_vel_z", impulseZ * finalSpeed * 1.0 * hurtResistance);
                unit.setDynamicProperty("dm:cmd_vel_y", jumpImpulse);
            }
        } catch (strafeError) {
            console.error(`[DM-Movement Engine Error] 走位计算决策异常: ${strafeError}`);
        }
    }
}