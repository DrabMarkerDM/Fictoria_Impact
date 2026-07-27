import { world, system, EntityDamageCause } from "@minecraft/server";
import { MovementRanged } from "./movement_ranged.js";
import { TacticalClockManager } from "./tactical_clock_manager.js";
import { DmSupportModule } from "./dm_support_system.js";

const BlockedTargetTicks = new Map();
const LastDamageTick = new Map();
const LastSwitchTick = new Map();
const ForcedTargets = new Map();

//TargetSensorManager — 目标获取/消失检测器
//激活条件：实体 DynamicProperty "dm:target_sensor" === "on"

const TargetSensorManager = {
    _tracking: new Map(), // Key: trackerId, Value: lastTargetId
    PROPERTY_KEY: "dm:target_sensor",
    EVENT_ACQUIRED: "attack",
    EVENT_LOST: "silent",

    init() {
        // 监听实体移除事件（主要是怪物猝死、被打掉、被/kill）
        world.beforeEvents.entityRemove.subscribe((event) => {
            const removedEntity = event.removedEntity;
            if (!removedEntity) return;
            const removedId = removedEntity.id;

            // 倒查哪些干员正在盯着这只被移除的怪
            for (const [trackerId, lastTargetId] of this._tracking.entries()) {
                if (lastTargetId === removedId) {
                    this._tracking.delete(trackerId);
                    // 借助延迟一帧，确保在实体有效上下文中执行触发
                    system.run(() => {
                        try {
                            const tracker = world.getEntity(trackerId);
                            if (tracker && tracker.isValid) {
                                tracker.triggerEvent(this.EVENT_LOST);
                            }
                        } catch (_) {}
                    });
                }
            }
        });
        console.warn("[TargetSensor] 2.7.0 修正版初始化完成");
    },

    /**
     * 每实体每 tick 调用（由 DmTargetEngine.processUnit 驱动）
     */
    check(entity) {
        if (!entity || !entity.isValid) return;

        // ── 1. 读行为包原生属性 ──
        const rawSensorValue = entity.getProperty(this.PROPERTY_KEY);
        
        // ── 2. 比对是否为 "on" ──
        const isOn = (rawSensorValue === "on");

        if (!isOn) {
            // 💥【大招修正】：如果是主动关闭传感器（off），直接悄悄抹除追踪记录，绝不触发 silent 砸了自己的大招！
            if (this._tracking.has(entity.id)) {
                this._tracking.delete(entity.id);
            }
            return;
        }

        // ── 3. 后续的核心检测保持不变 ──
        const trackerId = entity.id;
        const currentTarget = entity.target; 
        const lastTargetId = this._tracking.get(trackerId);

        // 情况 A：当前有目标，且目标依然有效
        if (currentTarget && currentTarget.isValid) {
            const currentTargetId = currentTarget.id;
            if (!lastTargetId || lastTargetId !== currentTargetId) {
                this._tracking.set(trackerId, currentTargetId);
                this._triggerEvent(entity, this.EVENT_ACQUIRED); // 触发 attack
            }
            return;
        }

        // 情况 B：当前没有目标，或者目标失效
        if (lastTargetId) {
            this._tracking.delete(trackerId);
            this._triggerEvent(entity, this.EVENT_LOST); // 触发 silent
        }
    },

    _triggerEvent(entity, eventName) {
        try { 
            if (entity && entity.isValid) {
                entity.triggerEvent(eventName); 
            }
        } catch (e) {
            console.warn(`[TargetSensor] 触发事件失败: ${entity.typeId} (${eventName}) → ${e}`);
        }
    }
};

// 配置表
const DmTargetRegistry = {
    "player:dm34_1": {
        "modes": {
            1: { normalRange: 34, alertRange: 54, focus: 2.0, speed: 8, strafe: true, strafeRange: 12, strafeSpeed: 0.35, clock_time: false, supportEnabled: true },
            2: { normalRange: 30, alertRange: 50, focus: 10.0, speed: 10.0, strafe: true, strafeRange: 9, strafeSpeed: 0.25, clock_time: false, supportEnabled: true },
            3: { normalRange: 58, alertRange: 78, focus: 22.0, speed: 2, strafe: true, strafeRange: 20, strafeSpeed: 0.15, clock_time: false, supportEnabled: true },
            4: { normalRange: 32, alertRange: 52, focus: 20.0, speed: 18, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true },
            5: { normalRange: 28, alertRange: 48, focus: 4.0, speed: 15, strafe: true, strafeRange: 10, strafeSpeed: 0.45, clock_time: false, supportEnabled: true }
        }
    },
    "player:dm34": {
        "modes": {
            1: { normalRange: 22, alertRange: 33, focus: 2.0, speed: 20, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true },
            2: { normalRange: 26, alertRange: 33, focus: 8.0, speed: 10.0, strafe: true, strafeRange: 10, strafeSpeed: 0.35, clock_time: false, supportEnabled: true },
            3: { normalRange: 28, alertRange: 33, focus: 15.0, speed: 5, strafe: true, strafeRange: 18, strafeSpeed: 0.25, clock_time: false, supportEnabled: true },
        }
    },
    "player:dm48": { normalRange: 40, alertRange: 48, focus: 4.0, speed: 12, strafe: true, strafeRange: 14, strafeSpeed: 0.4, clock_time: true, supportEnabled: true },
    "player:dm35": { normalRange: 35, alertRange: 40, focus: 10.0, speed: 5, strafe: true, strafeRange: 12, strafeSpeed: 0.3, clock_time: false, supportEnabled: true },
    "player:dm32": { normalRange: 39, alertRange: 46, focus: 2.0, speed: 20, strafe: true, strafeRange: 15, strafeSpeed: 0.32, clock_time: true, supportEnabled: true },
    "player:dm51": { normalRange: 32, alertRange: 37, focus: 12.0, speed: 3, strafe: true, strafeRange: 10, strafeSpeed: 0.26, clock_time: true, supportEnabled: true },
    "player:dm26": { normalRange: 33, alertRange: 38, focus: 5.0, speed: 18, strafe: true, strafeRange: 16, strafeSpeed: 0.35, clock_time: true, supportEnabled: true },
    "player:dm50": { normalRange: 96, alertRange: 96, focus: 25.0, speed: 2, strafe: true, strafeRange: 24, strafeSpeed: 0.2, clock_time: true, supportEnabled: true },
    "player:dm21": { normalRange: 36, alertRange: 36, focus: 5.0, speed: 5, strafe: true, strafeRange: 13, strafeSpeed: 0.3, clock_time: false, supportEnabled: true },
    "player:dm6":  { normalRange: 36, alertRange: 36, focus: 2.0, speed: 15, strafe: true, strafeRange: 12, strafeSpeed: 0.33, clock_time: false, supportEnabled: true },
    "player:dm31": { normalRange: 36, alertRange: 36, focus: 6.0, speed: 20, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm45": { normalRange: 48, alertRange: 48, focus: 12.0, speed: 5, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm59": { normalRange: 37, alertRange: 40, focus: 2.0, speed: 15, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm33": { normalRange: 36, alertRange: 46, focus: 5.0, speed: 20, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true },
    "player:dm24": { normalRange: 34, alertRange: 38, focus: 1.0, speed: 15, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true },
    "player:dm8":  { normalRange: 36, alertRange: 68, focus: 2.0, speed: 25, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true },
    "player:dm25": { normalRange: 38, alertRange: 66, focus: 5.0, speed: 25, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:kirito":{ normalRange: 38, alertRange: 48, focus: 3.0, speed: 30, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:asuna": { normalRange: 35, alertRange: 45, focus: 3.0, speed: 30, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm49": { normalRange: 42, alertRange: 66, focus: 3.0, speed: 30, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm62": { normalRange: 40, alertRange: 58, focus: 1.0, speed: 15, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm0":  { normalRange: 40, alertRange: 40, focus: 5.0, speed: 15, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm63":  { normalRange: 35, alertRange: 35, focus: 10.0, speed: 5.0, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm46":  { normalRange: 39, alertRange: 49, focus: 8.0, speed: 10.0, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm60":  { normalRange: 42, alertRange: 54, focus: 9.0, speed: 15.0, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm41":  { normalRange: 40, alertRange: 60, focus: 15.0, speed: 10.0, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm61":  { normalRange: 50, alertRange: 60, focus: 20.0, speed: 5.0, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:dm52":  { normalRange: 51, alertRange: 51, focus: 5.0, speed: 10.0, strafe: true, strafeRange: 10, strafeSpeed: 0.2, clock_time: false, supportEnabled: true },
    "player:dm56":  { normalRange: 60, alertRange: 96, focus: 10.0, speed: 10.0, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: false, supportEnabled: true },
    "player:dm28":  { normalRange: 35, alertRange: 35, focus: 10.0, speed: 5.0, strafe: false, strafeRange: 0, strafeSpeed: 0, clock_time: true, supportEnabled: true },
    "player:test1":{ normalRange: 36, alertRange: 36, focus: 2.0, speed: 15, strafe: true, strafeRange: 12, strafeSpeed: 0.33, clock_time: true, supportEnabled: true }
};

let GLOBAL_MAX_BROADCAST_DISTANCE = 96;

// DmTargetEngine 主引擎
export class DmTargetEngine {
    static init() {
        console.warn("[DM-Engine] 初始化开始");

        // ── 新增：初始化目标传感器 ──
        TargetSensorManager.init();

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

        // 后置受伤协同广播
        world.afterEvents.entityHurt.subscribe((event) => {
            try {
                const victim = event.hurtEntity;
                if (!victim || !victim.isValid) return;

                if (DmTargetRegistry[victim.typeId]) {
                    victim.setDynamicProperty("dm_last_hurt_tick", system.currentTick);
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
                    DmSupportModule.processHurtSupport(victim, event, DmTargetRegistry, ForcedTargets);
                }

                const followers = victim.dimension.getEntities({
                    location: victim.location,
                    maxDistance: GLOBAL_MAX_BROADCAST_DISTANCE
                });

                for (const follower of followers) {
                    if (!follower.isValid || !DmTargetRegistry[follower.typeId]) continue;
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
            const collectedUnits = [];
            for (const [typeId, globalConfig] of Object.entries(DmTargetRegistry)) {
                let units;
                try {
                    units = dimension.getEntities({ type: typeId });
                } catch (e) { continue; }
                for (const unit of units) {
                    if (!unit.isValid) continue;
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
                    if (activeConfig.supportEnabled) {
                        collectedUnits.push({ unit, config: activeConfig, typeId });
                    }
                }
            }
            DmSupportModule.evaluatePressureSupport(collectedUnits, DmTargetRegistry, ForcedTargets, GLOBAL_MAX_BROADCAST_DISTANCE);
        }
    }

    static processUnit(unit, config) {
        if (config.supportEnabled) {
            DmSupportModule.updateUnitPressure(unit, config, [], LastDamageTick);
            DmSupportModule.processMainLoopTick(unit, config);
        }

        const forced = ForcedTargets.get(unit.id);
        const currentTarget = unit.target;

        let currentRange = config.normalRange;
        let hasValidForcedTarget = false;

        if (forced) {
            const isValid = forced.target.isValid;
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
            if (!target.isValid) continue;

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

        if (config.strafe) {
            MovementRanged.execute(unit, config, closestThreat, closestDistSq, strafeRange, LastDamageTick);
        }

        if (config.clock_time === true) {
            const realCurrentTarget = unit.target ?? bestTarget;
            let hasRealActiveThreat = false;

            if (realCurrentTarget && realCurrentTarget.isValid) {
                const realDistSq = DmTargetEngine.getDistSq(unit.location, realCurrentTarget.location);
                if (realDistSq <= (config.normalRange ** 2) || unit.target !== undefined) {
                    hasRealActiveThreat = true;
                }
            }
            TacticalClockManager.execute(unit, hasRealActiveThreat);
        }

        // 目标传感器检测
        // 只有 dm:target_sensor === "on" 的实体才执行检测
        TargetSensorManager.check(unit);
    }

    static getDistSq(pos1, pos2) {
        if (!pos1 || !pos2) return 99999;
        return (pos1.x - pos2.x) ** 2 + (pos1.y - pos2.y) ** 2 + (pos1.z - pos2.z) ** 2;
    }
}