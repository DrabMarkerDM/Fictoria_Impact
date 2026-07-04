import { world, system, EntityDamageCause } from "@minecraft/server";

// 纯 JS 内存集合：记录哪些女仆正在执行拉怪，凡是在这里的实体，受击事件将会被铁血取消
const cancelHurtFollowerIds = new Set();

// 记录当前怪物正在被哪个干员“接单”拉仇恨，防止多干员抢单导致 AI 脑瘫
const monsterAggroLock = new Map(); // Key: monsterId, Value: followerId

// ============================================================
// 免疫红光与击退
// ============================================================
world.beforeEvents.entityHurt.subscribe((event) => {
    const { hurtEntity } = event;
    if (!hurtEntity || !hurtEntity.isValid) return;

    if (cancelHurtFollowerIds.has(hurtEntity.id)) {
        event.cancel = true; // 💥 铁血拦截物理效果
        cancelHurtFollowerIds.delete(hurtEntity.id); // 消费掉单次特权
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
            }
        } catch(e) {}
        try {
            const leader = world.getEntity(leaderId);
            if (leader && leader.isValid) {
                leader.setDynamicProperty("dm:has_supporter", undefined);
            }
        } catch(e) {}

        cancelHurtFollowerIds.delete(followerId);
        for (const [mId, fId] of monsterAggroLock.entries()) {
            if (fId === followerId) {
                monsterAggroLock.delete(mId);
            }
        }
        console.warn(`[DM-Engine Support] 双向锁及内存资产安全解开。`);
    }

    /**
     * 主循环 Tick：状态维持 + 超时熔断 + 动态仇恨传播
     */
    static processMainLoopTick(unit, config) {
        if (!unit || !unit.isValid) return;
        
        const leaderId = unit.getDynamicProperty("dm:supporting_leader");
        if (!leaderId) return;

        let needRelease = false;
        try {
            const leader = world.getEntity(leaderId);
            const startTick = unit.getDynamicProperty("dm:support_start_tick") ?? system.currentTick;
            
            if (system.currentTick - startTick > 600) { 
                console.warn(`[DM-Engine Support] 警告：支援行动超过30秒未果，触发物理隔离死锁熔断！`);
                needRelease = true;
            }
            else if (!leader || !leader.isValid || (leader.getDynamicProperty("dm_pressure") ?? 0) <= 25) {
                needRelease = true;
            } else {
                const monsterId = unit.getDynamicProperty("dm:support_target_monster");
                let monster = monsterId ? world.getEntity(monsterId) : null;

                if (!monster || !monster.isValid) {
                    console.warn(`[DM-Engine Support] 目标怪猝死！正在执行广播级仇恨转移...`);
                    if (monsterId) monsterAggroLock.delete(monsterId);

                    const searchRadius = config.pressureRadius ?? 8;
                    const nearbyMonsters = unit.dimension.getEntities({
                        location: unit.location,
                        maxDistance: searchRadius,
                        families: ["monster"]
                    });

                    let closestMonster = null;
                    let minDistSq = searchRadius * searchRadius;

                    for (const m of nearbyMonsters) {
                        if (!m.isValid) continue;
                        if (monsterAggroLock.has(m.id) && monsterAggroLock.get(m.id) !== unit.id) continue;

                        const dx = m.location.x - unit.location.x;
                        const dy = m.location.y - unit.location.y;
                        const dz = m.location.z - unit.location.z;
                        const distSq = dx * dx + dy * dy + dz * dz;
                        
                        if (distSq < minDistSq) {
                            minDistSq = distSq;
                            closestMonster = m;
                        }
                    }

                    if (closestMonster) {
                        const newMonsterId = closestMonster.id;
                        unit.setDynamicProperty("dm:support_target_monster", newMonsterId);
                        monsterAggroLock.set(newMonsterId, unit.id);
                        console.warn(`[DM-Engine Support] 仇恨成功传染 ➔ 新目标: ${closestMonster.typeId}`);

                        const followerId = unit.id;
                        system.run(() => {
                            const supporter = world.getEntity(followerId);
                            const target = world.getEntity(newMonsterId);
                            if (supporter && supporter.isValid && target && target.isValid) {
                                cancelHurtFollowerIds.add(followerId);
                                supporter.applyDamage(0.5, {
                                    cause: EntityDamageCause.entityAttack,
                                    damagingEntity: target
                                });
                                try {
                                    target.target = supporter;
                                } catch(e) {
                                    target.runCommand(`damage @s 0 entity_attack entity "${supporter.id}"`);
                                }
                            }
                        });
                    } else {
                        console.warn(`[DM-Engine Support] 周围已肃清，无敌对目标，支援功成身退。`);
                        needRelease = true;
                    }
                }
            }
        } catch(err) {
            needRelease = true;
        }

        if (needRelease) {
            DmSupportModule.releaseSupportLock(unit.id, leaderId);
        }
    }

    /**
     * 性能降频优化网（融入受击实时通道）
     */
    static updateUnitPressure(unit, config, targets, lastDamageTickMap) {
        if (!unit || !unit.isValid) return 0;

        const lastHurtTick = unit.getDynamicProperty("dm_last_hurt_tick") ?? 0;
        const tickSinceHurt = system.currentTick - lastHurtTick;

        // 只要在 5 秒（100 tick）内受过伤，直接强行刺穿 10 tick 错峰限制，立刻实时更新压力
        if (tickSinceHurt > 100) {
            const idHash = unit.id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
            const offset = idHash % 10;
            if (system.currentTick % 10 !== offset) {
                return unit.getDynamicProperty("dm_pressure") ?? 0;
            }
        }

        // --- 空间环境压力探测逻辑 ---
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

        let pressureValue = Math.min(nearbyMonsterCount * 15, 60);

        // 挨打立刻瞬间飙升 60 点基础压力
        if (tickSinceHurt <= 100) {
            pressureValue += 60; 
        }

        const selfHurtLog = lastDamageTickMap.get(unit.id); 
        if (selfHurtLog && (system.currentTick - selfHurtLog.tick) <= 100) {
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
        if (!sharedRegistry[victim.typeId]) return;

        // 1. 无论有没有保镖，只要进入此受伤监听，立刻将内存压力刷至 80 确保拉满！
        victim.setDynamicProperty("dm_pressure", 80);

        // 2. 核心修复：如果是已有保镖时的“后续受击”，我们不需要再发起广播抢单，但【必须】把它的 ID 重新塞进拦截名单，防止闪红光！
        if (victim.getDynamicProperty("dm:has_supporter")) {
            cancelHurtFollowerIds.add(victim.id); // 💥 精准兜底：强行吞掉后续攻击带来的红光与击退！
            return; // 已有支援，安全打道回府
        }
        
        // 3. 以下是没有保镖时，第一次受击发起的高灵敏呼叫流
        let trueAttacker = event.damageSource.damagingEntity; 
        if (!trueAttacker || !trueAttacker.isValid) {
            const forcedLog = forcedTargets.get(victim.id);   
            if (forcedLog && forcedLog.target && forcedLog.target.isValid) {
                trueAttacker = forcedLog.target;
            }
        }

        if (trueAttacker && trueAttacker.isValid && trueAttacker.matches({ families: ["monster"] })) {
            if (monsterAggroLock.has(trueAttacker.id)) return;

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
                if (!follower.isValid || !sharedRegistry[follower.typeId]) continue;
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
                const cooldownSetting = followerModeConfig.supportCooldown ?? 80;
                if (system.currentTick - lastSupportTick < cooldownSetting) continue;
                
                const followerId = follower.id;
                const victimId = victim.id;
                const attackerId = trueAttacker.id;
                
                // 登记双向状态
                follower.setDynamicProperty("dm:supporting_leader", victimId);
                follower.setDynamicProperty("dm:support_target_monster", attackerId);
                follower.setDynamicProperty("dm:support_start_tick", system.currentTick);
                victim.setDynamicProperty("dm:has_supporter", true);
                follower.setDynamicProperty("dm:support_triggered", true);
                follower.setDynamicProperty("dm:last_support_tick", system.currentTick);
                
                monsterAggroLock.set(attackerId, followerId); 

                console.warn(`[DM-Engine Support] 瞬发呼叫支援！准备执行全消音护航...`);

                system.run(() => {
                    const supporter = world.getEntity(followerId);
                    const monster = world.getEntity(attackerId);
                    
                    if (supporter && monster && supporter.isValid && monster.isValid) {
                        // 保镖自己上场碰瓷，丢进保镖拦截队列
                        cancelHurtFollowerIds.add(followerId);

                        supporter.applyDamage(0.5, {
                            cause: EntityDamageCause.entityAttack,
                            damagingEntity: monster
                        });

                        try {
                            monster.target = supporter; 
                        } catch(e) {
                            monster.runCommand(`damage @s 0 entity_attack entity "${supporter.id}"`);
                        }

                        system.runTimeout(() => {
                            cancelHurtFollowerIds.delete(followerId);
                            const s = world.getEntity(followerId);
                            if (s && s.isValid) s.setDynamicProperty("dm:support_triggered", undefined);
                        }, 3);
                    } else {
                        DmSupportModule.releaseSupportLock(followerId, victimId);
                    }
                });
                
                break; 
            }
        }
    }

    /**
     * 压力被动协同支援判定
     */
    static evaluatePressureSupport(collectedUnits, sharedRegistry, forcedTargets, globalBroadcastDistance) {
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
            if (!callerTarget || !callerTarget.isValid) continue;
            if (monsterAggroLock.has(callerTarget.id)) continue; 

            let bestResponder = null;
            let bestDistSq = globalBroadcastDistance ** 2;

            for (const responder of responders) {
                if (responder.unit.getDynamicProperty("dm:supporting_leader")) continue;

                const forced = forcedTargets.get(responder.unit.id); 
                if (forced && (system.currentTick - forced.tick) < 80) continue;

                const lastSupportTick = responder.unit.getDynamicProperty("dm:last_support_tick") ?? 0;
                const cooldown = responder.config.supportCooldown ?? 80;
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
                const followerId = bestResponder.unit.id;
                const targetId = callerTarget.id;

                bestResponder.unit.setDynamicProperty("dm:supporting_leader", caller.unit.id);
                bestResponder.unit.setDynamicProperty("dm:support_target_monster", targetId);
                bestResponder.unit.setDynamicProperty("dm:support_start_tick", system.currentTick);
                caller.unit.setDynamicProperty("dm:has_supporter", true);
                bestResponder.unit.setDynamicProperty("dm:support_triggered", true);
                bestResponder.unit.setDynamicProperty("dm:last_supporter_tick", system.currentTick);

                monsterAggroLock.set(targetId, followerId);

                console.warn(`[DM-Engine Support] 压力协同触发!`);

                system.run(() => {
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
                        } catch(e) {
                            target.runCommand(`damage @s 0 entity_attack entity "${supporter.id}"`);
                        }

                        system.runTimeout(() => {
                            cancelHurtFollowerIds.delete(followerId);
                            if (supporter.isValid) supporter.setDynamicProperty("dm:support_triggered", undefined);
                        }, 10);
                    }
                });
            }
        }
    }
}