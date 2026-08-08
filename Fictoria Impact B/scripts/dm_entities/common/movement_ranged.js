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

export class MovementRanged {

    /**
     * 通用战术走位动力学引擎
     * 依靠 dm_has_target 与 dm_skill_on 双重状态机实现战术接管
     */
    static execute(unit, config, closestThreat, closestDistSq, strafeRange, lastDamageTickMap) {
        try {
            // [2.0.0 变更] isValid 从方法变为只读属性，去掉括号
            if (!unit || !unit.isValid) return;

            // 特殊骑乘状态硬拦截（如某些特定机制或待机挂载）
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

            // 是否处于完全脱离地面的“深水悬浮/游泳”状态
            const isFloatingInWater = isInLiquid && !controller.isOnGround;

            // ============================================================
            // 优化：液体减速系数提取
            //
            // 原逻辑里有两处液体减速判定。
            // 为了不改变原有最终速度表现，这里保留“两次乘法”，
            // 但把分支判断合并成一个系数。
            // ============================================================
            const liquidSpeedFactor = isInLiquid
                ? (isFloatingInWater ? 0.20 : 0.60)
                : 1.0;

            // ============================================================
            // 空气阻尼衰减
            // 非地面状态 且 完全不在水中时：
            // 被击飞 / 弹射硬直时，平滑削减冲量。
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

                // 无论是平 A 锁敌还是开启大招，未进入战斗状态前，
                // 绝对不发生任何无动力移动开销。
                const isCombat = unit.hasTag("dm_has_target") || unit.hasTag("dm_skill_on");

                if (!isCombat) {
                    clearRangedCmdVel(unit);
                    return;
                }

                // ============================================================
                // 获取当前走位参照物
                // 优先雷达 threat，其次原生真实 target
                // ============================================================
                let activeTarget = closestThreat;
                let activeDistSq = closestDistSq;

                // 优化：预计算走位半径平方
                const strafeRangeSq = strafeRange * strafeRange;

                // [2.0.0 变更] isValid 从方法变为只读属性，去掉括号
                if (
                    (!activeTarget || !activeTarget.isValid || activeDistSq > strafeRangeSq) &&
                    unit.target &&
                    unit.target.isValid
                ) {
                    activeTarget = unit.target;
                    activeDistSq = getDistSq(uLoc, unit.target.location);
                }

                // 极端熔断：
                // 如果战场彻底清理干净，或没有任何有效目标在走位半径内
                // [2.0.0 变更] isValid 从方法变为只读属性，去掉括号
                if (!activeTarget || !activeTarget.isValid || activeDistSq > strafeRangeSq) {
                    clearRangedCmdVel(unit);
                    return;
                }

                // ============================================================
                // 优化：目标速度只读取一次
                //
                // 原逻辑：
                // 1. 目标静止检测读取一次 getVelocity()
                // 2. 目标速度动态追踪又读取一次 getVelocity()
                //
                // 现在合并为一次。
                // ============================================================
                let targetVelocity = null;

                try {
                    targetVelocity = activeTarget.getVelocity();
                } catch (_) {}

                // 目标状态判定（活靶子挂空挡机制：目标静止时不瞎抖动）
                const isTargetStationary =
                    targetVelocity &&
                    (targetVelocity.x * targetVelocity.x + targetVelocity.z * targetVelocity.z) < 0.00001;

                if (isTargetStationary) {
                    clearRangedCmdVel(unit);
                    return;
                }

                // ============================================================
                // 多模态战术环绕切换判定
                // 平移、左/右环绕、无动力拉扯
                // ============================================================
                let strafeDirection = unit.getDynamicProperty("dm:strafe_line");
                let lastModeTick = unit.getDynamicProperty("dm:strafe_mode_tick") ?? 0;

                // 优化：预计算半半径平方
                const halfStrafeRange = strafeRange * 0.5;
                const halfStrafeRangeSq = halfStrafeRange * halfStrafeRange;

                if (
                    strafeDirection === undefined ||
                    (nowTick - lastModeTick >= (unit.getDynamicProperty("dm:strafe_cooldown") ?? 40))
                ) {
                    const rand = Math.random();

                    // 是否踩入贴脸红线
                    const isCloseRange = activeDistSq < halfStrafeRangeSq;

                    if (isCloseRange) {
                        if (rand < 0.70) {
                            strafeDirection = 0; // 触发后撤
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
                const dy = tLoc.y - uLoc.y; // 引入 Y 轴高度差，用于水中立体解算
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
                // 目标速度动态追踪
                //
                // 优化：复用前面已经读取过的 targetVelocity
                // ============================================================
                if (targetVelocity) {
                    const targetSpeedHorizontal = Math.sqrt(
                        targetVelocity.x * targetVelocity.x +
                        targetVelocity.z * targetVelocity.z
                    );

                    const speedFactor = Math.min(1.0, 0.35 + (targetSpeedHorizontal * 2.0));

                    finalSpeed = maxConfigSpeed * speedFactor;
                }

                // ============================================================
                // 速度增益流水线全额结算
                // 状态 Buff * 液体阻尼
                // ============================================================
                finalSpeed *= statusSpeedFactor; // 全局享受 Buff 缩放（如缓慢 0.85，神速 1.2）

                // 第一次液体减速（保留原逻辑位置）
                finalSpeed *= liquidSpeedFactor;

                if (strafeDirection === 0) {
                    finalSpeed *= 1.5;
                }

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

                // 允许当前帧的向量在上一帧的基础上有 25% 的线性柔和修正，抵抗群怪切换抖动
                impulseX = lastImpulseX * 0.3 + impulseX * 0.7;
                impulseZ = lastImpulseZ * 0.3 + impulseZ * 0.7;

                unit.setDynamicProperty("dm:last_impulse_x", impulseX);
                unit.setDynamicProperty("dm:last_impulse_z", impulseZ);

                // 默认初始弹跳力
                let jumpImpulse = 0.05;

                // ============================================================
                // 第二次液体减速
                //
                // 注意：
                // 原逻辑中存在两次液体减速。
                // 为了不改变原有水中速度表现，这里保留第二次乘法。
                //
                // 如果你确认这是复制粘贴导致的重复逻辑，
                // 可以删除下面这一行，水中速度会明显变快。
                // ============================================================
                finalSpeed *= liquidSpeedFactor;

                // ============================================================
                // 动态 Y 轴立体水动力解算
                // ============================================================
                if (isFloatingInWater) {

                    // 检测头顶上一格是不是空气。
                    // 如果是空气，说明已经到水面了，强行禁止继续上浮防漂浮。
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
                        jumpImpulse = 0.18; // 上浮冲量，V2 中需要更大力才能克服浮力
                    } else if (dy < -0.5) {
                        jumpImpulse = -0.20; // 下潜冲量
                    } else {
                        jumpImpulse = isAtWaterSurface ? -0.08 : 0.05;
                    }
                } else {

                    // ============================================================
                    // 原生前方雷达防卡墙检测
                    // 仅在陆地 / 浅水非完全悬浮时工作，
                    // 完整复原初版精细转向逻辑。
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
                                    jumpImpulse = 0.45; // 防卡墙跳跃：V2 中需足够力跳上 1 格高
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
                // 非完全悬浮状态下计算
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
                // 非完全悬浮状态下计算
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

                                // V2 中 applyImpulse 真正生效，1.8 倍冲量用于脱困逃生
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

                                jumpImpulse = 0.55; // 脱困跳跃：需跳到 1.5 格高

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

                // 优化：安全访问 lastDamageTickMap
                const selfHurtLog = lastDamageTickMap ? lastDamageTickMap.get(unit.id) : undefined;

                if (selfHurtLog && (nowTick - selfHurtLog.tick <= 8)) {
                    hurtResistance = 0.45;
                }

                // ============================================================
                // 最终解算写入物理冲量
                //
                // Bedrock 物理：稳态速度 = impulse / 0.454
                // 系数 1.0 让 strafeSpeed 直接对应单帧冲量，便于直观调参
                //
                // 例：
                // strafeSpeed = 1.2 → 远距离稳态 ~2.6 blocks/sec（接近疾跑）
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