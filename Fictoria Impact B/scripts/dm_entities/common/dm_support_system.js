import { world, system, EntityDamageCause } from "@minecraft/server";

// 不再定义自己的 ForcedTargets，改用传入参数

export class DmSupportModule {

    static releaseSupportLock(followerId, leaderId) {
        try {
            const follower = world.getEntity(followerId);
            if (follower && follower.isValid()) {
                follower.setDynamicProperty("dm:supporting_leader", undefined);
                follower.setDynamicProperty("dm:support_target_monster", undefined);
            }
        } catch(e) {}
        try {
            const leader = world.getEntity(leaderId);
            if (leader && leader.isValid()) {
                leader.setDynamicProperty("dm:has_supporter", undefined);
            }
        } catch(e) {}
        console.warn(`[DM-Engine Support] 双向锁安全解开。`);
    }

    // 新增 forcedTargets 参数
    static processHurtSupport(victim, event, sharedRegistry, forcedTargets) {
        if (!victim || !victim.isValid() || !sharedRegistry) return;
        if (!sharedRegistry[victim.typeId]) return;

        const victimPressure = victim.getDynamicProperty("dm_pressure") ?? 0;
        
        if (victimPressure >= 60 && !victim.getDynamicProperty("dm:has_supporter")) {
            let trueAttacker = event.damageSource.damagingEntity; 
            if (!trueAttacker || !trueAttacker.isValid()) {
                const forcedLog = forcedTargets.get(victim.id);   // 使用传入的 forcedTargets
                if (forcedLog && forcedLog.target && forcedLog.target.isValid()) {
                    trueAttacker = forcedLog.target;
                }
            }

            if (trueAttacker && trueAttacker.isValid() && trueAttacker.matches({ families: ["monster"] })) {
                // 计算广播距离（复用原逻辑）
                let maxAlert = 0;
                for (const config of Object.values(sharedRegistry)) {
                    if (config.modes) {
                        for (const mode of Object.values(config.modes)) {
                            if (mode.alertRange > maxAlert) maxAlert = mode.alertRange;
                        }
                    } else if (config.alertRange > maxAlert) {
                        maxAlert = config.alertRange;
                    }
                }
                const broadcastDist = maxAlert + 18;

                const followers = victim.dimension.getEntities({
                    location: victim.location,
                    maxDistance: broadcastDist
                });

                for (const follower of followers) {
                    if (!follower.isValid() || !sharedRegistry[follower.typeId]) continue;
                    if (follower.id === victim.id) continue;
                    if (follower.getDynamicProperty("dm:supporting_leader")) continue;

                    let followerModeConfig = sharedRegistry[follower.typeId];
                    if (followerModeConfig.modes) {
                        const variantComp = follower.getComponent("minecraft:variant");
                        const variant = variantComp ? variantComp.value : 0;
                        if (followerModeConfig.modes[variant]) {
                            followerModeConfig = followerModeConfig.modes[variant];
                        } else continue;
                    }
                    if (!followerModeConfig.supportEnabled) continue;

                    const followerPressure = follower.getDynamicProperty("dm_pressure") ?? 0;
                    if (followerPressure > 25) continue;

                    const lastSupportTick = follower.getDynamicProperty("dm:last_support_tick") ?? 0;
                    const cooldownSetting = followerModeConfig.supportCooldown ?? 200;
                    if (system.currentTick - lastSupportTick < cooldownSetting) continue;
                    
                    const followerId = follower.id;
                    const victimId = victim.id;
                    const attackerId = trueAttacker.id;
                    
                    follower.setDynamicProperty("dm:supporting_leader", victimId);
                    follower.setDynamicProperty("dm:support_target_monster", attackerId);
                    victim.setDynamicProperty("dm:has_supporter", true);
                    follower.setDynamicProperty("dm:support_triggered", true);
                    follower.setDynamicProperty("dm:last_support_tick", system.currentTick);

                    console.warn(`[DM-Engine Support] 双向锁建立! 支援者 B(${follower.typeId}) ➔ 前往护航 A(${victim.typeId})，拉怪目标:${trueAttacker.typeId}`);

                    system.run(() => {
                        const supporter = world.getEntity(followerId);
                        const monster = world.getEntity(attackerId);
                        
                        if (supporter && monster && supporter.isValid() && monster.isValid()) {
                            supporter.applyDamage(0.5, {
                                cause: EntityDamageCause.entityAttack,
                                damagingEntity: monster
                            });
                            const health = supporter.getComponent("minecraft:health");
                            if (health) {
                                health.setCurrentValue(Math.min(health.currentValue + 0.5, health.effectiveMax));
                            }
                            system.runTimeout(() => {
                                const s = world.getEntity(followerId);
                                if (s && s.isValid()) s.setDynamicProperty("dm:support_triggered", undefined);
                            }, 3);
                        } else {
                            DmSupportModule.releaseSupportLock(followerId, victimId);
                        }
                    });
                    
                    break; // 只选第一个合适的支援者
                }
            }
        }
    }

    static updateUnitPressure(unit, config, targets, lastDamageTickMap) {
        if (!unit || !unit.isValid()) return 0;

        let nearbyMonsterCount = 0;
        const pressureRadius = config.pressureRadius ?? 8;
        try {
            const pressureTargets = unit.dimension.getEntities({
                location: unit.location,
                maxDistance: pressureRadius,
                families: ["monster"]
            });
            nearbyMonsterCount = pressureTargets.length;
        } catch (e) {}

        // 怪物压力贡献改为每个15点，上限60（之前是每个10，上限50）
        let pressureValue = Math.min(nearbyMonsterCount * 15, 60);

        // 检查是否最近受伤（新增）
        const lastHurtTick = unit.getDynamicProperty("dm_last_hurt_tick") ?? 0;
        if (system.currentTick - lastHurtTick <= 100) {
            pressureValue += 20;
        }

        // 保留原有的攻击记录检查（攻击别人时也加分，但不再是唯一受伤途径）
        const selfHurtLog = lastDamageTickMap.get(unit.id); // 原来的逻辑（记录的是攻击者）
        if (selfHurtLog && (system.currentTick - selfHurtLog.tick) <= 100) {
            pressureValue += 20;
        }

        pressureValue = Math.min(pressureValue, 100);
        unit.setDynamicProperty("dm_pressure", pressureValue);
        
        return pressureValue;
    }

    static processMainLoopTick(unit, config) {
        // 此函数内不需要用到 ForcedTargets，所以保持不变
        const leaderId = unit.getDynamicProperty("dm:supporting_leader");
        if (!leaderId) return;

        let needRelease = false;
        try {
            const leader = world.getEntity(leaderId);
            if (!leader || !leader.isValid() || (leader.getDynamicProperty("dm_pressure") ?? 0) <= 25) {
                needRelease = true;
            } else {
                const monsterId = unit.getDynamicProperty("dm:support_target_monster");
                let monster = monsterId ? world.getEntity(monsterId) : null;

                if (!monster || !monster.isValid()) {
                    // 目标怪猝死，寻找新怪物（略，保持不变）
                    // ...
                }
            }
        } catch(err) {
            needRelease = true;
        }

        if (needRelease) {
            DmSupportModule.releaseSupportLock(unit.id, leaderId);
        }
    }

    static evaluatePressureSupport(collectedUnits, sharedRegistry, forcedTargets, globalBroadcastDistance) {
        // 此函数已经通过参数接收 forcedTargets，直接使用
        // ... 保持不变，但注意原代码中使用了本地变量 forcedTargets，现在用传入的。
        // 内部所有 forcedTargets 引用均指向传入参数，无需修改。
        const callers = [];
        const responders = [];

        for (const { unit, config } of collectedUnits) {
            const pressure = unit.getDynamicProperty("dm_pressure") ?? 0;
            if (pressure >= 60 && !unit.getDynamicProperty("dm:has_supporter")) {
                callers.push({ unit, pressure, config });
            } else if (pressure <= 24 && !unit.getDynamicProperty("dm:supporting_leader")) {
                responders.push({ unit, pressure, config });
            }
        }

        if (callers.length === 0 || responders.length === 0) return;

        for (const caller of callers) {
            const callerTarget = caller.unit.target;
            if (!callerTarget || !callerTarget.isValid()) continue;

            let bestResponder = null;
            let bestDistSq = globalBroadcastDistance ** 2;

            for (const responder of responders) {
                if (responder.unit.getDynamicProperty("dm:supporting_leader")) continue;

                const forced = forcedTargets.get(responder.unit.id); // 使用传入的 forcedTargets
                if (forced && (system.currentTick - forced.tick) < 80) continue;

                const lastSupportTick = responder.unit.getDynamicProperty("dm:last_support_tick") ?? 0;
                const cooldown = responder.config.supportCooldown ?? 200;
                if (system.currentTick - lastSupportTick < cooldown) continue;

                const dx = caller.unit.location.x - responder.unit.location.x;
                const dy = caller.unit.location.y - responder.unit.location.y;
                const dz = caller.unit.location.z - responder.unit.location.z;
                const distSq = dx * dx + dy * dy + dz * dz;
                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    bestResponder = responder;
                }
            }

            if (bestResponder) {
                bestResponder.unit.setDynamicProperty("dm:supporting_leader", caller.unit.id);
                bestResponder.unit.setDynamicProperty("dm:support_target_monster", callerTarget.id);
                caller.unit.setDynamicProperty("dm:has_supporter", true);
                bestResponder.unit.setDynamicProperty("dm:support_triggered", true);
                bestResponder.unit.setDynamicProperty("dm:last_support_tick", system.currentTick);

                console.warn(`[DM-Engine Support] 压力协同触发! ...`);

                const followerId = bestResponder.unit.id;
                const targetId = callerTarget.id;
                system.run(() => {
                    const supporter = world.getEntity(followerId);
                    const target = world.getEntity(targetId);
                    if (supporter && target && supporter.isValid() && target.isValid()) {
                        supporter.setDynamicProperty("dm:support_triggered", true);
                        supporter.applyDamage(0.5, {
                            cause: EntityDamageCause.entityAttack,
                            damagingEntity: target
                        });
                        const health = supporter.getComponent("minecraft:health");
                        if (health) health.setCurrentValue(Math.min(health.currentValue + 0.5, health.effectiveMax));
                        system.runTimeout(() => {
                            const s = world.getEntity(followerId);
                            if (s && s.isValid()) s.setDynamicProperty("dm:support_triggered", undefined);
                        }, 10);
                    }
                });
            }
        }
    }
}