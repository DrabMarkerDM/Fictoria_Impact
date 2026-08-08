import { world, system, EntityDamageCause } from "@minecraft/server";

// ============================================================
// 日志开关
// false：关闭高频支援日志，性能更好
// true：恢复输出支援系统日志
// ============================================================
const DEBUG_SUPPORT = false;

function supportLog(...args) {
    if (DEBUG_SUPPORT) {
        console.warn(...args);
    }
}

// ============================================================
// 纯 JS 内存集合：
// 记录哪些干员正在执行拉怪。
// 凡是在这里的实体，受击事件将会被铁血取消。
// ============================================================
const cancelHurtFollowerIds = new Set();

// ============================================================
// 怪物仇恨锁：
// 记录当前怪物正在被哪个干员“接单”拉仇恨，
// 防止多干员抢单导致 AI 脑瘫。
// ============================================================
const monsterAggroLock = new Map();          // monsterId -> followerId

// 优化：反向索引
// followerId -> Set<monsterId>
// 释放支援锁时不再全表遍历 monsterAggroLock。
const followerLockedMonsters = new Map();

// ============================================================
// 压力错峰缓存
//
// 修复版：
// 不再存储 offset，而是存储“下一次允许更新压力的 tick”。
// ============================================================
const PressureOffsetCache = new Map();

// 压力更新周期：10 tick
const PRESSURE_UPDATE_INTERVAL = 10;

// 优化：支援模式配置缓存
// key: `${typeId}:${variant}`
const SupportModeConfigCache = new Map();

// 优化：注册表广播距离缓存
let SUPPORT_CACHE_READY = false;
let SUPPORT_MAX_ALERT = 0;

// ============================================================
// 仇恨锁工具
// ============================================================
function addAggroLock(monsterId, followerId) {
    if (!monsterId || !followerId) return;

    monsterAggroLock.set(monsterId, followerId);

    let set = followerLockedMonsters.get(followerId);
    if (!set) {
        set = new Set();
        followerLockedMonsters.set(followerId, set);
    }

    set.add(monsterId);
}

function removeAggroLock(monsterId) {
    if (!monsterId) return;

    const followerId = monsterAggroLock.get(monsterId);
    if (followerId === undefined) return;

    monsterAggroLock.delete(monsterId);

    const set = followerLockedMonsters.get(followerId);
    if (set) {
        set.delete(monsterId);

        if (set.size === 0) {
            followerLockedMonsters.delete(followerId);
        }
    }
}

function releaseFollowerAggroLocks(followerId) {
    if (!followerId) return;

    const set = followerLockedMonsters.get(followerId);
    if (!set) return;

    followerLockedMonsters.delete(followerId);

    for (const monsterId of set) {
        if (monsterAggroLock.get(monsterId) === followerId) {
            monsterAggroLock.delete(monsterId);
        }
    }
}

// ============================================================
// 配置工具
// ============================================================
function cleanString(value) {
    return typeof value === "string" ? value.trim() : value;
}

// 兼容注册表 key 可能带尾随空格的情况
function getRegistryEntry(sharedRegistry, typeId) {
    if (!sharedRegistry || !typeId) return undefined;

    const raw = String(typeId);
    const trimmed = raw.trim();

    return (
        sharedRegistry[raw] ??
        sharedRegistry[trimmed] ??
        sharedRegistry[raw + " "] ??
        sharedRegistry[trimmed + " "]
    );
}

// 只计算一次最大 alertRange
function ensureSupportRegistryCache(sharedRegistry) {
    if (SUPPORT_CACHE_READY || !sharedRegistry) return;

    let maxAlert = 0;

    try {
        for (const config of Object.values(sharedRegistry)) {
            if (!config) continue;

            const modes = config.modes ?? config["modes "];

            if (modes) {
                for (const mode of Object.values(modes)) {
                    if (
                        mode &&
                        typeof mode.alertRange === "number" &&
                        mode.alertRange > maxAlert
                    ) {
                        maxAlert = mode.alertRange;
                    }
                }
            } else if (
                typeof config.alertRange === "number" &&
                config.alertRange > maxAlert
            ) {
                maxAlert = config.alertRange;
            }
        }
    } catch (_) {}

    SUPPORT_MAX_ALERT = maxAlert;
    SUPPORT_CACHE_READY = true;
}

// 解析支援单位当前 variant 对应的模式配置
function resolveSupportModeConfig(sharedRegistry, follower) {
    try {
        if (!sharedRegistry || !follower || !follower.isValid) return null;

        const typeId = follower.typeId;
        const globalConfig = getRegistryEntry(sharedRegistry, typeId);
        if (!globalConfig) return null;

        const modes = globalConfig.modes ?? globalConfig["modes "];
        if (!modes) {
            return globalConfig;
        }

        const variantComp = follower.getComponent("minecraft:variant");
        const variant = variantComp ? variantComp.value : 0;

        const cacheKey = `${cleanString(typeId)}:${variant}`;

        if (SupportModeConfigCache.has(cacheKey)) {
            return SupportModeConfigCache.get(cacheKey);
        }

        const modeConfig = modes[variant] ?? null;

        SupportModeConfigCache.set(cacheKey, modeConfig);

        return modeConfig;
    } catch (_) {
        return null;
    }
}

// ============================================================
// 实体移除清理
//
// 不改变支援逻辑，只清理内存资产，降低长期运行泄漏风险。
// ============================================================
try {
    world.beforeEvents.entityRemove.subscribe((event) => {
        try {
            const id = event.removedEntity?.id;
            if (!id) return;

            cancelHurtFollowerIds.delete(id);
            PressureOffsetCache.delete(id);

            // 如果移除的是怪物，解除该怪物的仇恨锁
            if (monsterAggroLock.has(id)) {
                removeAggroLock(id);
            }

            // 如果移除的是支援者，解除它名下所有仇恨锁
            releaseFollowerAggroLocks(id);
        } catch (_) {}
    });
} catch (_) {}

// ============================================================
// 免疫红光与击退
// ============================================================
world.beforeEvents.entityHurt.subscribe((event) => {
    const { hurtEntity } = event;

    if (!hurtEntity || !hurtEntity.isValid) return;

    if (cancelHurtFollowerIds.has(hurtEntity.id)) {
        event.cancel = true;
        cancelHurtFollowerIds.delete(hurtEntity.id);
    }
});

export class DmSupportModule {
    /**
     * 安全释放双向锁与内存清理
     */
    static releaseSupportLock(followerId, leaderId) {
        try {
            const follower = world.getEntity(followerId);

            if (follower && follower.isValid) {
                follower.setDynamicProperty("dm:supporting_leader", undefined);
                follower.setDynamicProperty("dm:support_target_monster", undefined);
                follower.setDynamicProperty("dm:support_start_tick", undefined);

                // 清理仇恨传导保护期
                follower.setDynamicProperty("dm:support_transfer_tick", undefined);
            }
        } catch (_) {}

        try {
            const leader = world.getEntity(leaderId);

            if (leader && leader.isValid) {
                leader.setDynamicProperty("dm:has_supporter", undefined);
            }
        } catch (_) {}

        cancelHurtFollowerIds.delete(followerId);

        // 优化：使用反向索引释放，不再全表遍历
        releaseFollowerAggroLocks(followerId);

        supportLog("[DM-Engine Support] 双向锁及内存资产安全解开。");
    }

    /**
     * 主循环 Tick：
     * 状态维持 + 超时熔断 + 动态仇恨传播
     *
     * 修复版：
     * 原逻辑会先判断 leader 压力是否 <= 25。
     * 如果目标怪死亡后 leader 压力下降，会先释放支援锁，
     * 导致后面的仇恨传导逻辑无法执行。
     *
     * 现在改为：
     * 1. 先检查支援目标是否死亡。
     * 2. 如果目标死亡，优先尝试把仇恨传导给最近敌人。
     * 3. 传导成功则继续支援，不释放锁。
     * 4. 传导失败才释放支援锁。
     *
     * 范围保持不变：
     * 仍然使用 config.pressureRadius ?? 8。
     */
    static processMainLoopTick(unit, config) {
        if (!unit || !unit.isValid) return;

        const leaderId = unit.getDynamicProperty("dm:supporting_leader");
        if (!leaderId) return;

        const nowTick = system.currentTick;

        let needRelease = false;

        try {
            const leader = world.getEntity(leaderId);
            const startTick = unit.getDynamicProperty("dm:support_start_tick") ?? nowTick;

            // 30 秒超时熔断
            if (nowTick - startTick > 600) {
                supportLog("[DM-Engine Support] 警告：支援行动超过30秒未果，触发物理隔离死锁熔断！");
                needRelease = true;
            } else {
                const monsterId = unit.getDynamicProperty("dm:support_target_monster");
                let monster = monsterId ? world.getEntity(monsterId) : null;

                // ============================================================
                // ★ 核心修复：
                // 目标怪死亡 / 失效时，优先尝试仇恨传导。
                // 不要先因为 leader 压力下降而释放支援锁。
                // ============================================================
                if (!monster || !monster.isValid) {
                    supportLog("[DM-Engine Support] 目标怪猝死！正在执行广播级仇恨转移...");

                    if (monsterId) {
                        removeAggroLock(monsterId);
                    }

                    if (leader && leader.isValid) {
                        const transferred = DmSupportModule._transferSupportTarget(
                            unit,
                            config,
                            leaderId,
                            nowTick
                        );

                        if (transferred) {
                            return;
                        }
                    }

                    supportLog("[DM-Engine Support] 周围已肃清或无法传导仇恨，支援结束。");
                    needRelease = true;
                } else {
                    // ============================================================
                    // 仇恨刚传导成功后，给 30 tick 保护期。
                    //
                    // 防止目标怪刚死亡、仇恨刚传导到新怪时，
                    // leader 的 dm_pressure 还没来得及刷新，
                    // 支援锁就因为 pressure <= 25 被立刻释放。
                    // ============================================================
                    const transferTick = unit.getDynamicProperty("dm:support_transfer_tick") ?? 0;
                    const inTransferGrace = (nowTick - transferTick) < 30;

                    if (
                        !leader ||
                        !leader.isValid ||
                        (
                            (leader.getDynamicProperty("dm_pressure") ?? 0) <= 25 &&
                            !inTransferGrace
                        )
                    ) {
                        needRelease = true;
                    }
                }
            }
        } catch (_) {
            needRelease = true;
        }

        if (needRelease) {
            DmSupportModule.releaseSupportLock(unit.id, leaderId);
        }
    }

    /**
     * 支援目标死亡后的仇恨传导
     *
     * 从支援者附近寻找最近的未被其他支援者锁定的怪物，
     * 然后把支援目标切换过去，并重新制造仇恨。
     *
     * 范围保持不变：
     * 仍然使用 config.pressureRadius ?? 8。
     */
    static _transferSupportTarget(unit, config, leaderId, nowTick) {
        try {
            if (!unit || !unit.isValid) return false;

            const searchRadius = config.pressureRadius ?? 8;
            const searchRadiusSq = searchRadius * searchRadius;

            let closestMonster = null;
            let minDistSq = searchRadiusSq;

            let nearbyMonsters = [];

            try {
                nearbyMonsters = unit.dimension.getEntities({
                    location: unit.location,
                    maxDistance: searchRadius,
                    families: ["monster"]
                });
            } catch (_) {
                nearbyMonsters = [];
            }

            for (const m of nearbyMonsters) {
                if (!m.isValid) continue;

                const lockedFollower = monsterAggroLock.get(m.id);

                // 已经被其他支援者锁定的怪物不抢
                if (
                    lockedFollower !== undefined &&
                    lockedFollower !== unit.id
                ) {
                    continue;
                }

                const dx = m.location.x - unit.location.x;
                const dy = m.location.y - unit.location.y;
                const dz = m.location.z - unit.location.z;

                const distSq = dx * dx + dy * dy + dz * dz;

                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    closestMonster = m;
                }
            }

            if (!closestMonster) {
                return false;
            }

            const newMonsterId = closestMonster.id;
            const followerId = unit.id;

            unit.setDynamicProperty("dm:support_target_monster", newMonsterId);

            // 重置支援开始时间，避免传导后立刻被 30 秒熔断
            unit.setDynamicProperty("dm:support_start_tick", nowTick);

            // 记录仇恨传导保护期
            unit.setDynamicProperty("dm:support_transfer_tick", nowTick);

            addAggroLock(newMonsterId, followerId);

            supportLog(
                `[DM-Engine Support] 仇恨成功传染 ➔ 新目标: ${closestMonster.typeId}`
            );

            system.run(() => {
                try {
                    const supporter = world.getEntity(followerId);
                    const target = world.getEntity(newMonsterId);

                    if (
                        supporter &&
                        supporter.isValid &&
                        target &&
                        target.isValid
                    ) {
                        cancelHurtFollowerIds.add(followerId);

                        supporter.applyDamage(0.5, {
                            cause: EntityDamageCause.entityAttack,
                            damagingEntity: target
                        });

                        try {
                            target.target = supporter;
                        } catch (_) {
                            try {
                                target.runCommand(
                                    `damage @s 0 entity_attack entity "${supporter.id}"`
                                );
                            } catch (_) {}
                        }

                        system.runTimeout(() => {
                            cancelHurtFollowerIds.delete(followerId);
                        }, 3);
                    } else {
                        DmSupportModule.releaseSupportLock(followerId, leaderId);
                    }
                } catch (_) {}
            });

            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * 性能降频优化网（融入受击实时通道）
     *
     * 修复：
     * 原错峰逻辑使用 nowTick % 10 === offset。
     * 由于 manager 是 5 tick 一次，很多 offset 永远无法命中，
     * 导致“范围内敌人数量多”无法正常升压。
     *
     * 现在改为“到期制”：
     * 每个单位记录下一次允许更新压力的 tick。
     */
    static updateUnitPressure(unit, config, targets, lastDamageTickMap) {
        if (!unit || !unit.isValid) return 0;

        const nowTick = system.currentTick;

        const lastHurtTick = unit.getDynamicProperty("dm_last_hurt_tick") ?? 0;
        const tickSinceHurt = nowTick - lastHurtTick;

        // ============================================================
        // 只要在 5 秒（100 tick）内受过伤，
        // 直接强行刺穿错峰限制，立刻实时更新压力。
        // ============================================================
        if (tickSinceHurt > 100) {
            let nextDueTick = PressureOffsetCache.get(unit.id);

            if (
                nextDueTick === undefined ||
                typeof nextDueTick !== "number" ||
                !Number.isFinite(nextDueTick)
            ) {
                let hash = 0;
                const id = unit.id;

                for (let i = 0; i < id.length; i++) {
                    hash = (hash + id.charCodeAt(i)) | 0;
                }

                const offset = Math.abs(hash) % PRESSURE_UPDATE_INTERVAL;

                nextDueTick = nowTick + offset;
                PressureOffsetCache.set(unit.id, nextDueTick);
            }

            if (nowTick < nextDueTick) {
                return unit.getDynamicProperty("dm_pressure") ?? 0;
            }

            // 本次已更新，下一次压力更新推迟 10 tick
            PressureOffsetCache.set(unit.id, nowTick + PRESSURE_UPDATE_INTERVAL);
        }

        // ============================================================
        // 空间环境压力探测逻辑
        //
        // 范围保持不变：
        // config.pressureRadius ?? 8
        // ============================================================
        let nearbyMonsterCount = 0;
        const pressureRadius = config.pressureRadius ?? 8;

        // 优化：如果上游已经传入目标列表，则优先复用，减少一次 getEntities
        if (Array.isArray(targets) && targets.length > 0) {
            const pressureRadiusSq = pressureRadius * pressureRadius;

            for (const target of targets) {
                if (!target || !target.isValid) continue;

                const dx = target.location.x - unit.location.x;
                const dy = target.location.y - unit.location.y;
                const dz = target.location.z - unit.location.z;

                if (dx * dx + dy * dy + dz * dz <= pressureRadiusSq) {
                    nearbyMonsterCount++;
                }
            }
        } else {
            try {
                const pressureTargets = unit.dimension.getEntities({
                    location: unit.location,
                    maxDistance: pressureRadius,
                    families: ["monster"]
                });

                nearbyMonsterCount = pressureTargets.length;
            } catch (_) {}
        }

        let pressureValue = Math.min(nearbyMonsterCount * 15, 60);

        // 挨打立刻瞬间飙升 60 点基础压力
        if (tickSinceHurt <= 100) {
            pressureValue += 60;
        }

        const selfHurtLog = lastDamageTickMap
            ? lastDamageTickMap.get(unit.id)
            : undefined;

        if (selfHurtLog && (nowTick - selfHurtLog.tick) <= 100) {
            pressureValue += 20;
        }

        pressureValue = Math.min(pressureValue, 100);

        unit.setDynamicProperty("dm_pressure", pressureValue);

        return pressureValue;
    }

    /**
     * 受到伤害触发的支援判定（铁血修复版）
     */
    static processHurtSupport(victim, event, sharedRegistry, forcedTargets) {
        if (!victim || !victim.isValid || !sharedRegistry) return;
        if (!getRegistryEntry(sharedRegistry, victim.typeId)) return;

        // 优化：只计算一次广播距离
        ensureSupportRegistryCache(sharedRegistry);

        // 1. 无论有没有保镖，只要进入此受伤监听，立刻将内存压力刷至 80 确保拉满！
        victim.setDynamicProperty("dm_pressure", 80);

        // 2. 核心修复：如果是已有保镖时的“后续受击”，不再发起广播抢单，
        //    但必须把它的 ID 重新塞进拦截名单，防止闪红光！
        if (victim.getDynamicProperty("dm:has_supporter")) {
            cancelHurtFollowerIds.add(victim.id);
            return;
        }

        // 3. 以下是没有保镖时，第一次受击发起的高灵敏呼叫流
        let trueAttacker = event.damageSource?.damagingEntity;

        if (!trueAttacker || !trueAttacker.isValid) {
            const forcedLog = forcedTargets ? forcedTargets.get(victim.id) : undefined;

            if (forcedLog && forcedLog.target && forcedLog.target.isValid) {
                trueAttacker = forcedLog.target;
            }
        }

        let attackerIsMonster = false;

        try {
            attackerIsMonster =
                trueAttacker &&
                trueAttacker.isValid &&
                trueAttacker.matches &&
                trueAttacker.matches({ families: ["monster"] });
        } catch (_) {}

        if (!attackerIsMonster) return;
        if (monsterAggroLock.has(trueAttacker.id)) return;

        const broadcastDist = SUPPORT_MAX_ALERT + 18;

        let followers;

        try {
            followers = victim.dimension.getEntities({
                location: victim.location,
                maxDistance: broadcastDist
            });
        } catch (_) {
            return;
        }

        const nowTick = system.currentTick;

        for (const follower of followers) {
            if (!follower.isValid || follower.id === victim.id) continue;
            if (!getRegistryEntry(sharedRegistry, follower.typeId)) continue;
            if (follower.getDynamicProperty("dm:supporting_leader")) continue;

            const followerModeConfig = resolveSupportModeConfig(sharedRegistry, follower);
            if (!followerModeConfig || !followerModeConfig.supportEnabled) continue;

            const followerPressure = follower.getDynamicProperty("dm_pressure") ?? 0;
            if (followerPressure > 25) continue;

            const lastSupportTick = follower.getDynamicProperty("dm:last_support_tick") ?? 0;
            const cooldownSetting = followerModeConfig.supportCooldown ?? 80;

            if (nowTick - lastSupportTick < cooldownSetting) continue;

            const followerId = follower.id;
            const victimId = victim.id;
            const attackerId = trueAttacker.id;

            // 登记双向状态
            follower.setDynamicProperty("dm:supporting_leader", victimId);
            follower.setDynamicProperty("dm:support_target_monster", attackerId);
            follower.setDynamicProperty("dm:support_start_tick", nowTick);

            victim.setDynamicProperty("dm:has_supporter", true);

            follower.setDynamicProperty("dm:support_triggered", true);
            follower.setDynamicProperty("dm:last_support_tick", nowTick);

            addAggroLock(attackerId, followerId);

            supportLog("[DM-Engine Support] 瞬发呼叫支援！准备执行全消音护航...");

            system.run(() => {
                try {
                    const supporter = world.getEntity(followerId);
                    const monster = world.getEntity(attackerId);

                    if (supporter && supporter.isValid && monster && monster.isValid) {
                        // 保镖自己上场碰瓷，丢进保镖拦截队列
                        cancelHurtFollowerIds.add(followerId);

                        supporter.applyDamage(0.5, {
                            cause: EntityDamageCause.entityAttack,
                            damagingEntity: monster
                        });

                        try {
                            monster.target = supporter;
                        } catch (_) {
                            try {
                                monster.runCommand(
                                    `damage @s 0 entity_attack entity "${supporter.id}"`
                                );
                            } catch (_) {}
                        }

                        system.runTimeout(() => {
                            cancelHurtFollowerIds.delete(followerId);

                            const s = world.getEntity(followerId);

                            if (s && s.isValid) {
                                s.setDynamicProperty("dm:support_triggered", undefined);
                            }
                        }, 3);
                    } else {
                        DmSupportModule.releaseSupportLock(followerId, victimId);
                    }
                } catch (_) {}
            });

            break;
        }
    }

    /**
     * 压力被动协同支援判定
     */
    static evaluatePressureSupport(
        collectedUnits,
        sharedRegistry,
        forcedTargets,
        globalBroadcastDistance
    ) {
        if (!Array.isArray(collectedUnits) || collectedUnits.length === 0) return;

        const nowTick = system.currentTick;

        const callers = [];
        const responders = [];

        for (const entry of collectedUnits) {
            const unit = entry?.unit;
            const config = entry?.config;

            if (!unit || !unit.isValid || !config) continue;

            const pressure = unit.getDynamicProperty("dm_pressure") ?? 0;

            if (
                pressure >= 60 &&
                !unit.getDynamicProperty("dm:has_supporter")
            ) {
                callers.push({
                    unit,
                    pressure,
                    config
                });
            } else if (
                pressure <= 24 &&
                !unit.getDynamicProperty("dm:supporting_leader")
            ) {
                responders.push({
                    unit,
                    pressure,
                    config
                });
            }
        }

        if (callers.length === 0 || responders.length === 0) return;

        const maxDistSq = (globalBroadcastDistance ?? 96) ** 2;

        for (const caller of callers) {
            const callerTarget = caller.unit.target;

            if (!callerTarget || !callerTarget.isValid) continue;
            if (monsterAggroLock.has(callerTarget.id)) continue;

            let bestResponder = null;
            let bestDistSq = maxDistSq;

            for (const responder of responders) {
                if (!responder || !responder.unit || !responder.unit.isValid) continue;
                if (responder.unit.getDynamicProperty("dm:supporting_leader")) continue;

                const forced = forcedTargets
                    ? forcedTargets.get(responder.unit.id)
                    : undefined;

                if (forced && (nowTick - forced.tick) < 80) continue;

                const lastSupportTick =
                    responder.unit.getDynamicProperty("dm:last_support_tick") ?? 0;

                const cooldown = responder.config.supportCooldown ?? 80;

                if (nowTick - lastSupportTick < cooldown) continue;

                const dx = caller.unit.location.x - responder.unit.location.x;
                const dy = caller.unit.location.y - responder.unit.location.y;
                const dz = caller.unit.location.z - responder.unit.location.z;

                const distSq = dx * dx + dy * dy + dz * dz;

                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    bestResponder = responder;
                }
            }

            if (!bestResponder) continue;

            const followerId = bestResponder.unit.id;
            const targetId = callerTarget.id;

            bestResponder.unit.setDynamicProperty(
                "dm:supporting_leader",
                caller.unit.id
            );

            bestResponder.unit.setDynamicProperty(
                "dm:support_target_monster",
                targetId
            );

            bestResponder.unit.setDynamicProperty(
                "dm:support_start_tick",
                nowTick
            );

            caller.unit.setDynamicProperty("dm:has_supporter", true);

            bestResponder.unit.setDynamicProperty("dm:support_triggered", true);

            // 修复/兼容：
            // 原逻辑这里写的是 dm:last_supporter_tick，
            // 但冷却读取的是 dm:last_support_tick。
            // 现在两个都写，既修复冷却，也兼容旧逻辑。
            bestResponder.unit.setDynamicProperty("dm:last_support_tick", nowTick);
            bestResponder.unit.setDynamicProperty("dm:last_supporter_tick", nowTick);

            addAggroLock(targetId, followerId);

            supportLog("[DM-Engine Support] 压力协同触发!");

            system.run(() => {
                try {
                    const supporter = world.getEntity(followerId);
                    const target = world.getEntity(targetId);

                    if (supporter && supporter.isValid && target && target.isValid) {
                        cancelHurtFollowerIds.add(followerId);

                        supporter.applyDamage(0.5, {
                            cause: EntityDamageCause.entityAttack,
                            damagingEntity: target
                        });

                        try {
                            target.target = supporter;
                        } catch (_) {
                            try {
                                target.runCommand(
                                    `damage @s 0 entity_attack entity "${supporter.id}"`
                                );
                            } catch (_) {}
                        }

                        system.runTimeout(() => {
                            cancelHurtFollowerIds.delete(followerId);

                            const s = world.getEntity(followerId);

                            if (s && s.isValid) {
                                s.setDynamicProperty("dm:support_triggered", undefined);
                            }
                        }, 10);
                    } else {
                        DmSupportModule.releaseSupportLock(followerId, caller.unit.id);
                    }
                } catch (_) {}
            });
        }
    }
}