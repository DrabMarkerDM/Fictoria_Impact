import { world, system, EntityDamageCause } from "@minecraft/server";
import { MovementRanged } from "./movement_ranged.js"; 
import { TacticalClockManager } from "./tactical_clock_manager.js"; // 导入独立时钟模块
import { DmSupportModule } from "./dm_support_system.js"; // 导入外部纯逻辑支援与压力模块

const BlockedTargetTicks = new Map(); // key: entityId, value: { targetId: string, tickCount: number }
const LastDamageTick = new Map(); // key: unitId, value: { tick: number, targetId: string }
const LastSwitchTick = new Map(); // key: unitId, value: tick
const ForcedTargets = new Map();  

// 配置表
const DmTargetRegistry = {
    "player:dm34_1": {
        "modes": {
            1: { normalRange: 34, alertRange: 54, focus: 2.0, speed: 8, strafe: true, strafeRange: 12, strafeSpeed: 0.35, clock_time: false, supportEnabled: true },  // M4A1 (variant 1)
            2: { normalRange: 30, alertRange: 50, focus: 10.0, speed: 10.0, strafe: true, strafeRange: 9, strafeSpeed: 0.25, clock_time: false, supportEnabled: true }, 
            3: { normalRange: 58, alertRange: 78, focus: 22.0, speed: 2, strafe: true, strafeRange: 20, strafeSpeed: 0.15, clock_time: false, supportEnabled: true},  
            4: { normalRange: 32, alertRange: 52, focus: 20.0, speed: 18, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true },    
            5: { normalRange: 28, alertRange: 48, focus: 4.0, speed: 15, strafe: true, strafeRange: 10, strafeSpeed: 0.45, clock_time: false, supportEnabled: true }   
        }
    },
    "player:dm34": {
        "modes": {
            1: { normalRange: 22, alertRange: 33, focus: 2.0, speed: 20, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true},  
            2: { normalRange: 26, alertRange: 33, focus: 8.0, speed: 10.0, strafe: true, strafeRange: 10, strafeSpeed: 0.35, clock_time: false, supportEnabled: true }, 
            3: { normalRange: 28, alertRange: 33, focus: 15.0, speed: 5, strafe: true, strafeRange: 18, strafeSpeed: 0.25, clock_time: false, supportEnabled: true},  
        }
    },
    "player:dm48": { normalRange: 40, alertRange: 48, focus: 4.0, speed: 12, strafe: true, strafeRange: 14, strafeSpeed: 0.4, clock_time: true, supportEnabled: true},
    "player:dm35": { normalRange: 35, alertRange: 40, focus: 10.0, speed: 5, strafe: true, strafeRange: 12, strafeSpeed: 0.3, clock_time: false, supportEnabled: true},
    "player:dm32": { normalRange: 39, alertRange: 46, focus: 2.0, speed: 20, strafe: true, strafeRange: 15, strafeSpeed: 0.32,  clock_time: true, supportEnabled: true },
    "player:dm51": { normalRange: 32, alertRange: 37, focus: 12.0, speed: 3, strafe: true, strafeRange: 10, strafeSpeed: 0.26,  clock_time: true, supportEnabled: true},
    "player:dm26": { normalRange: 33, alertRange: 38, focus: 5.0, speed: 18, strafe: true, strafeRange: 16, strafeSpeed: 0.35, clock_time: true, supportEnabled: true },
    "player:dm50": { normalRange: 96, alertRange: 96, focus: 25.0, speed: 2, strafe: true, strafeRange: 24, strafeSpeed: 0.2, clock_time: true, supportEnabled: true },
    "player:dm21": { normalRange: 36, alertRange: 36, focus: 5.0, speed: 5, strafe: true, strafeRange: 13, strafeSpeed: 0.3, clock_time: false, supportEnabled: true },
    "player:dm6": { normalRange: 36, alertRange: 36, focus: 2.0, speed: 15, strafe: true, strafeRange: 12, strafeSpeed: 0.33, clock_time: false, supportEnabled: true},
    "player:dm31": { normalRange: 36, alertRange: 36, focus: 6.0, speed: 20, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true},
    "player:dm45": { normalRange: 48, alertRange: 48, focus: 12.0, speed: 5, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true},
    "player:dm59": { normalRange: 37, alertRange: 40, focus: 2.0, speed: 15, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true},
    "player:dm33": { normalRange: 36, alertRange: 46, focus: 5.0, speed: 20, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true},
    "player:dm24": { normalRange: 34, alertRange: 38, focus: 1.0, speed: 15, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true},
    "player:dm8": { normalRange: 36, alertRange: 68, focus: 2.0, speed: 25, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true},
    "player:dm25": { normalRange: 38, alertRange: 66, focus: 5.0, speed: 25, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true},
    "player:kirito": { normalRange: 38, alertRange: 48, focus: 3.0, speed: 30, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true},
    "player:asuna": { normalRange: 35, alertRange: 45, focus: 3.0, speed: 30, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true},
     "player:test1": { normalRange: 36, alertRange: 36, focus: 2.0, speed: 15, strafe: true, strafeRange: 12, strafeSpeed: 0.33, clock_time: true, supportEnabled: true}
};

let GLOBAL_MAX_BROADCAST_DISTANCE = 96;

export class DmTargetEngine {
    static init() {
        console.warn("[DM-Engine] 初始化开始");
        try {
            let maxAlert = 0;
            for (const config of Object.values(DmTargetRegistry)) {
                if (config.modes) {
                    for (const mode of Object.values(config.modes)) {
                        if (mode.alertRange > maxAlert) maxAlert = mode.alertRange;
                    }
                } else if (config.alertRange > maxAlert) {
                    maxAlert = config.alertRange;
                }
            }
            GLOBAL_MAX_BROADCAST_DISTANCE = maxAlert + 18;
            console.warn(`[DM-Engine] 广播距离 = ${GLOBAL_MAX_BROADCAST_DISTANCE}`);
        } catch (e) {
            console.warn("[DM-Engine] 计算广播距离失败，使用默认值96");
            GLOBAL_MAX_BROADCAST_DISTANCE = 96;
        }

        // 驯服监听
        world.afterEvents.dataDrivenEntityTrigger.subscribe((event) => {
            try {
                if (event.eventId === "minecraft:on_tame" && DmTargetRegistry[event.entity.typeId]) {
                    const players = event.entity.dimension.getPlayers({ location: event.entity.location, maxDistance: 16 });
                    if (players.length > 0) {
                        event.entity.setDynamicProperty("ownerId", players[0].id);
                        console.warn(`[DM-Engine] 驯服记录: ${event.entity.typeId} 主人=${players[0].id}`);
                    }
                }
            } catch (e) {
                console.error("[DM-Engine] 驯服监听异常: " + e);
            }
        });

        // 交互补录主人
        world.afterEvents.playerInteractWithEntity.subscribe((event) => {
            try {
                const entity = event.target;
                if (DmTargetRegistry[entity.typeId] && entity.getDynamicProperty("ownerId") === undefined) {
                    entity.setDynamicProperty("ownerId", event.player.id);
                     console.warn(`[DM-Engine] 交互补录主人: ${entity.typeId} 主人=${event.player.id}`);
                }
            } catch (e) {
                console.error("[DM-Engine] 交互补录异常: " + e);
            }
        });

        // 受伤协同广播
        world.afterEvents.entityHurt.subscribe((event) => {
            try {
                const victim = event.hurtEntity;
                if (!victim || !victim.isValid()) return;

                 if (DmTargetRegistry[victim.typeId]) {
                    victim.setDynamicProperty("dm_last_hurt_tick", system.currentTick);
                }

                const ALLIED_TYPES = [
                    "minecraft:horse", "minecraft:donkey", "minecraft:mule",
                    "minecraft:skeleton_horse", "minecraft:zombie_horse",
                    "minecraft:wolf", "minecraft:cat", "minecraft:parrot", "minecraft:player",
                ];
                const ALLIED_FAMILIES = ["horse", "wolf", "cat"];

                const isAllied = victim.matches({ families: ALLIED_FAMILIES }) || 
                                 ALLIED_TYPES.includes(victim.typeId);

                if (isAllied) {
                    const damageSource = event.damageSource;
                    const attacker = damageSource.damagingEntity;
                    let isMaidAttack = false;
                    
                    if (attacker && attacker.isValid() && attacker.matches({ families: ["dm"] })) {
                        isMaidAttack = true;
                    }
                    if (damageSource.cause === EntityDamageCause.projectile || 
                        damageSource.cause === EntityDamageCause.fireTick || 
                        damageSource.cause === EntityDamageCause.fire) {
                        if (!attacker || (attacker.isValid() && attacker.matches({ families: ["dm"] }))) {
                            isMaidAttack = true;
                        }
                    }
                    if (isMaidAttack) {
                        try {
                            victim.extinguishFire(true); 
                            const healthComp = victim.getComponent("minecraft:health");
                            if (healthComp) {
                                healthComp.setCurrentValue(healthComp.effectiveMax); 
                            }
                            return; 
                        } catch (err) {}
                    }
                }

                const attacker = event.damageSource.damagingEntity;
                if (!attacker) return;
                
                const damager = event.damageSource.damagingEntity;
                if (damager && DmTargetRegistry[damager.typeId]) {
                    LastDamageTick.set(damager.id, { tick: system.currentTick, targetId: victim.id });
                }
                
                if (DmTargetRegistry[victim.typeId] && victim.getDynamicProperty("ownerId") === undefined) {
                    const nearPlayers = victim.dimension.getPlayers({ location: victim.location, maxDistance: 16 });
                    if (nearPlayers.length > 0) {
                        victim.setDynamicProperty("ownerId", nearPlayers[0].id);
                        console.warn(`[DM-Engine] 受伤补录主人: ${victim.typeId} 主人=${nearPlayers[0].id}`);
                    }
                }
                
                if (DmTargetRegistry[victim.typeId]) {
                    console.warn(`[DM-Engine] 自身受击: ${victim.typeId} 反击目标=${attacker.typeId}`);
                    DmTargetEngine.setForcedTarget(victim.id, attacker, 3);

                    // 压力与保镖分发：当受击目标属于干员时，分发进独立逻辑模块，传入管理器的配置表做联动
                    DmSupportModule.processHurtSupport(victim, event, DmTargetRegistry, ForcedTargets);
                }

                const followers = victim.dimension.getEntities({
                    location: victim.location,
                    maxDistance: GLOBAL_MAX_BROADCAST_DISTANCE
                });

                for (const follower of followers) {
                    if (!follower.isValid() || !DmTargetRegistry[follower.typeId]) continue;
                    const ownerId = follower.getDynamicProperty("ownerId");
                    if (!ownerId) continue;

                    if (ownerId === victim.id) {
                        DmTargetEngine.setForcedTarget(follower.id, attacker, 2);
                    }
                    if (ownerId === attacker.id) {
                        DmTargetEngine.setForcedTarget(follower.id, victim, 1);
                    }
                }
            } catch (e) {
                console.error(`[DM-Engine] 受伤事件异常: ${e}`);
            }
        });

        // 主循环 5 ticks 步长机制
        system.runInterval(() => {
            try {
                DmTargetEngine.update();
            } catch (e) {
                console.error("[DM-Engine] 主循环异常: " + e);
            }
        }, 5);

        console.warn("[DM-Engine] 初始化完成");
    }

    static setForcedTarget(unitId, newTarget, priority) {
        const current = ForcedTargets.get(unitId);
        const nowTick = system.currentTick;
        if (!current || (nowTick - current.tick > 80) || priority >= current.priority) {
            ForcedTargets.set(unitId, { target: newTarget, priority: priority, tick: nowTick });
        }
    }

    static update() {
    const activeDimensions = new Set();
    for (const player of world.getAllPlayers()) {
        try {
            if (player.dimension) activeDimensions.add(player.dimension);
        } catch (e) {}
    }
    for (const dimension of activeDimensions) {
        // 本轮遍历中收集所有实体及其配置
        const collectedUnits = [];
        for (const [typeId, globalConfig] of Object.entries(DmTargetRegistry)) {
            let units;
            try {
                units = dimension.getEntities({ type: typeId });
            } catch (e) { continue; }
            for (const unit of units) {
                if (!unit.isValid()) continue;
                let activeConfig = globalConfig;
                if (globalConfig.modes) {
                    const variantComp = unit.getComponent("minecraft:variant");
                    const variant = variantComp ? variantComp.value : 0;
                    if (!(variant in globalConfig.modes)) continue;
                    activeConfig = globalConfig.modes[variant];
                }
                try {
                    DmTargetEngine.processUnit(unit, activeConfig);
                } catch (e) {
                    console.error(`[DM-Engine] processUnit 异常 (${unit.id}): ${e}`);
                }
                // 收集实体（只收集 supportEnabled 的，节省内存）
                if (activeConfig.supportEnabled) {
                    collectedUnits.push({ unit, config: activeConfig, typeId });
                }
            }
        }
        // 所有实体处理完毕，用收集到的数据做一次压力协同评估
        DmSupportModule.evaluatePressureSupport(collectedUnits, DmTargetRegistry, ForcedTargets, GLOBAL_MAX_BROADCAST_DISTANCE);
    }
}

    static processUnit(unit, config) {
        // 压力更新：每个 tick 动态计算更新压力状态，丢给独立支持模块计算
        if (config.supportEnabled) {
            DmSupportModule.updateUnitPressure(unit, config, [], LastDamageTick);
            DmSupportModule.processMainLoopTick(unit, config);
        }

        const forced = ForcedTargets.get(unit.id);
        const currentTarget = unit.target;

        let currentRange = config.normalRange;
        let hasValidForcedTarget = false;

        if (forced) {
            const isValid = forced.target.isValid();
            const elapsed = system.currentTick - forced.tick;
            if (isValid && elapsed < 80) {
                hasValidForcedTarget = true;
                if (forced.priority === 1 || forced.priority === 2) {
                    currentRange = config.alertRange;
                }
            } else {
                ForcedTargets.delete(unit.id);
            }
        }

        let targets = [];
        try {
            targets = unit.dimension.getEntities({
                location: unit.location,
                maxDistance: currentRange,
                families: ["monster"]
            });
        } catch (e) { return; }

        let bestTarget = null;
        let highestWeight = -1;

        let closestThreat = null;
        const strafeRange = config.strafeRange ?? 15;
        let closestDistSq = strafeRange ** 2;

        for (const target of targets) {
            if (!target.isValid()) continue;

            const distSq = DmTargetEngine.getDistSq(unit.location, target.location);
            
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestThreat = target;
            }

            let distWeight = (currentRange ** 2 - distSq) / (currentRange ** 2);
            let weight = 0;
            let isForcedThisTarget = (hasValidForcedTarget && forced.target.id === target.id);

            if (isForcedThisTarget) {
                if (forced.priority === 3) weight = 1000000 + distWeight;
                else if (forced.priority === 2) weight = 1000 + distWeight;
                else if (forced.priority === 1) weight = 1000 + distWeight;
            } else {
                weight = 100 + distWeight * 10;
            }

            if (currentTarget && currentTarget.id === target.id) {
                weight *= config.focus;
                const lastDmg = LastDamageTick.get(unit.id);
                if (lastDmg && lastDmg.targetId === currentTarget.id) {
                    if (system.currentTick - lastDmg.tick > 60) { weight *= 0.2; }
                }
            }

            if (weight > highestWeight) {
                highestWeight = weight;
                bestTarget = target;
            }
        }

        if (bestTarget && currentTarget?.id !== bestTarget.id) {
            const nowTick = system.currentTick;
            const lastSwitch = LastSwitchTick.get(unit.id) || 0;
            const cooldown = Math.max(1, 20 - config.speed);
            if (nowTick - lastSwitch >= cooldown) {
                unit.target = bestTarget;
                try {
                    unit.triggerEvent("dm:reset_target_selector");
                    LastSwitchTick.set(unit.id, nowTick);
                } catch (e) {}
            }
        }

        // ==========================================
        // 走位分发
        // ==========================================
        if (config.strafe) {
            MovementRanged.execute(unit, config, closestThreat, closestDistSq, strafeRange, LastDamageTick);
        }

        // ==========================================
        // 时钟分发
        // ==========================================
        if (config.clock_time === true) {
            // 必须是本实体“真正主观锁定的目标”存在，且该目标合法
            const realCurrentTarget = unit.target ?? bestTarget;
            let hasRealActiveThreat = false;

            if (realCurrentTarget && realCurrentTarget.isValid()) {
                // 计算与该目标的真实平方距离
                const realDistSq = DmTargetEngine.getDistSq(unit.location, realCurrentTarget.location);
                
                // 核心拦截：只有当目标处于该干员的常规打靶线（normalRange）之内，
                // 或者干员原生 JSON 层已经死死咬住目标（unit.target 存在）时，才允许激活战斗计时！
                if (realDistSq <= (config.normalRange ** 2) || unit.target !== undefined) {
                    hasRealActiveThreat = true;
                }
            }

            // 打包扔给独立的计时器模块，再也不会被旁边队友的受击广播借壳充能了
            TacticalClockManager.execute(unit, hasRealActiveThreat);
        }
    }

    static getDistSq(pos1, pos2) {
        if (!pos1 || !pos2) return 99999;
        return (pos1.x - pos2.x) ** 2 + (pos1.y - pos2.y) ** 2 + (pos1.z - pos2.z) ** 2;
    }
}