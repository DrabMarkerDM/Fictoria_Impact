import { world, system, EntityDamageCause } from "@minecraft/server";
import { MovementRanged } from "./movement_ranged.js";
import { MovementMelee } from "./movement_melee.js";
import { TacticalClockManager } from "./tactical_clock_manager.js";
import { DmSupportModule } from "./dm_support_system.js";

const BlockedTargetTicks = new Map();
export const LastDamageTick = new Map(); // 导出给走位模块使用
export const VictimDamageHistoryMap = new Map(); // 💥 新增：专门存 [受击者ID -> 伤害历史队列]
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
/**
 *  ── 基础参数（通用，所有干员必填）──
 *  normalRange      {number}   正常索敌半径（格）
 *  alertRange       {number}   警戒索敌半径（格），受击协同广播时使用
 *  focus            {number}   当前目标权重倍率，越大越不容易切目标
 *  speed            {number}   目标切换冷却因子，值越大切换越快
 *  clock_time       {boolean}  是否启用战术时钟
 *  supportEnabled   {boolean}  是否启用支援系统
 *
 *  ── 走位类型（二选一或都不填）──
 *  combatType       {string}   "ranged" = 远程走位 | "melee" = 近战走位 | 不填 = 无走位
 *
 *  ── 远程专用（combatType: "ranged"）──
 *  strafeRange      {number}   远程走位检测半径（格），也是最近威胁搜索范围
 *  strafeSpeed      {number}   侧向移动基础速度，乘以Buff/液体系数后为最终速度
 *
 *  ── 近战专用（combatType: "melee"）──
 *  meleeRange       {number}   冲刺刹车距离
 *  strafeSpeed      {number}   移动基础速度，冲刺均基于此值缩放
 *  chargeSpeed      {number}   冲刺速度倍率，乘以 strafeSpeed 得到冲刺速度
 *  chargeRange      {number}   冲刺最小触发距离阈值（格），超过此距离持续3秒触发
 *  maxChargeRange   {number}   冲刺最大触发距离阈值（格），该值不指定则为无上限
 *  maxChargeDist    {number}   最大冲刺距离（格）
 *  chargeDuration   {number}   冲刺最长持续 tick，超时自动取消
 */
// 配置表
const DmTargetRegistry = {
    "player:dm34_1": {
        "modes": {
            1: { normalRange: 34, alertRange: 54, focus: 2.0, speed: 8, combatType: "ranged", strafeRange: 12, strafeSpeed: 0.35, clock_time: false, supportEnabled: true },
            2: { normalRange: 30, alertRange: 50, focus: 10.0, speed: 10.0, combatType: "ranged", strafeRange: 9, strafeSpeed: 0.25, clock_time: false, supportEnabled: true },
            3: { normalRange: 58, alertRange: 78, focus: 22.0, speed: 2, combatType: "ranged", strafeRange: 20, strafeSpeed: 0.15, clock_time: false, supportEnabled: true },
            4: { normalRange: 32, alertRange: 52, focus: 20.0, speed: 18, combatType: "melee", strafeSpeed: 0.3, chargeSpeed: 2.5, chargeRange: 10, maxChargeDist: 10, clock_time: false, supportEnabled: true },
            5: { normalRange: 28, alertRange: 48, focus: 4.0, speed: 15, combatType: "ranged", strafeRange: 10, strafeSpeed: 0.45, clock_time: false, supportEnabled: true }
        }
    },
    "player:dm34": {
        "modes": {
            1: { normalRange: 22, alertRange: 33, focus: 2.0, speed: 20, combatType: "melee", strafeSpeed: 0.3, chargeSpeed: 2.5, chargeRange: 10, maxChargeDist: 10, clock_time: false, supportEnabled: true },
            2: { normalRange: 26, alertRange: 33, focus: 8.0, speed: 10.0, combatType: "ranged", strafeRange: 10, strafeSpeed: 0.35, clock_time: false, supportEnabled: true },
            3: { normalRange: 28, alertRange: 33, focus: 15.0, speed: 5, combatType: "ranged", strafeRange: 18, strafeSpeed: 0.25, clock_time: false, supportEnabled: true },
        }
    },
    "player:dm48": { normalRange: 40, alertRange: 48, focus: 4.0, speed: 12, combatType: "ranged", strafeRange: 14, strafeSpeed: 0.4, clock_time: true, supportEnabled: true },
    "player:dm35": { normalRange: 35, alertRange: 40, focus: 10.0, speed: 5, combatType: "ranged", strafeRange: 12, strafeSpeed: 0.3, clock_time: false, supportEnabled: true },
    "player:dm32": { normalRange: 39, alertRange: 46, focus: 2.0, speed: 20, combatType: "ranged", strafeRange: 15, strafeSpeed: 0.32, clock_time: true, supportEnabled: true },
    "player:dm51": { normalRange: 32, alertRange: 37, focus: 12.0, speed: 3, combatType: "ranged", strafeRange: 10, strafeSpeed: 0.26, clock_time: true, supportEnabled: true },
    "player:dm26": { normalRange: 33, alertRange: 38, focus: 5.0, speed: 18, combatType: "ranged", strafeRange: 16, strafeSpeed: 0.35, clock_time: true, supportEnabled: true },
    "player:dm50": { normalRange: 96, alertRange: 96, focus: 25.0, speed: 2, combatType: "ranged", strafeRange: 24, strafeSpeed: 0.2, clock_time: true, supportEnabled: true },
    "player:dm21": { normalRange: 36, alertRange: 36, focus: 5.0, speed: 5, combatType: "ranged", strafeRange: 13, strafeSpeed: 0.3, clock_time: false, supportEnabled: true },
    "player:dm6": { normalRange: 36, alertRange: 36, focus: 2.0, speed: 15, combatType: "ranged", strafeRange: 12, strafeSpeed: 0.33, clock_time: false, supportEnabled: true },
    "player:dm31": { normalRange: 36, alertRange: 36, focus: 10.0, speed: 20, combatType: "ranged", strafeRange: 12, strafeSpeed: 0.35, clock_time: true, supportEnabled: true },
    "player:dm45": { normalRange: 48, alertRange: 48, focus: 15.0, speed: 15.0, combatType: "ranged", strafeRange: 8, strafeSpeed: 0.25, clock_time: true, supportEnabled: true },
    "player:dm4": { normalRange: 44, alertRange: 46, focus: 3.0, speed: 10.0, combatType: "ranged", strafeRange: 12, strafeSpeed: 0.3, clock_time: false, supportEnabled: true },
    "player:dm59": {
        normalRange: 37, alertRange: 40, focus: 2.0, speed: 15, combatType: "melee",
        strafeSpeed: 0.25, chargeSpeed: 2.5,
        chargeRange: 10, maxChargeDist: 10,
        clock_time: true, supportEnabled: true
    },
    "player:dm33": { normalRange: 36, alertRange: 46, focus: 5.0, speed: 20, combatType: "melee",
        strafeSpeed: 0.35, chargeSpeed: 2.5, chargeRange: 8,
        maxChargeDist: 10, meleeRange: 2.0,
        clock_time: false, supportEnabled: true
    },
    "player:dm24": { normalRange: 34, alertRange: 38, focus: 1.0, speed: 15, combatType: "melee",
        strafeSpeed: 0.25, chargeSpeed: 2.5, chargeRange: 10,
        maxChargeDist: 12, meleeRange: 2.5,
        clock_time: false, supportEnabled: true
    },
    "player:dm8": {
        normalRange: 36, alertRange: 68, focus: 2.0, speed: 25, combatType: "melee",
        strafeSpeed: 0.3, chargeSpeed: 2.5, chargeRange: 36,
        maxChargeDist: 20, meleeRange: 1.0,
        clock_time: true, supportEnabled: true
    },
    "player:dm25": {
        normalRange: 38, alertRange: 66, focus: 5.0, speed: 25, combatType: "melee",
        strafeSpeed: 0.25, chargeSpeed: 2.5,
        chargeRange: 10, maxChargeDist: 12,
        clock_time: true, supportEnabled: true
    },
    "player:kirito": {
        normalRange: 38, alertRange: 48, focus: 3.0, speed: 30, combatType: "melee",
        strafeSpeed: 0.3, chargeSpeed: 2.0,
        chargeRange: 9, maxChargeDist: 10,
        clock_time: true, supportEnabled: true
    },
    "player:asuna": {
        normalRange: 35, alertRange: 45, focus: 3.0, speed: 30, combatType: "melee",
        strafeSpeed: 0.4, chargeSpeed: 2.5,
        chargeRange: 10, maxChargeDist: 10,
        clock_time: true, supportEnabled: true
    },
    "player:dm49": {
        normalRange: 42, alertRange: 66, focus: 3.0, speed: 30, combatType: "melee",
        strafeSpeed: 0.35, chargeSpeed: 2.5,
        chargeRange: 8, maxChargeDist: 10,
        clock_time: true, supportEnabled: true
    },
    "player:dm62": {
        normalRange: 40, alertRange: 58, focus: 1.0, speed: 15, combatType: "melee",
        strafeSpeed: 0.15, chargeSpeed: 3.0,
        chargeRange: 6, maxChargeDist: 8,
        clock_time: true, supportEnabled: true
    },
    "player:dm0": {
        normalRange: 40, alertRange: 40, focus: 5.0, speed: 15, combatType: "melee",
        strafeSpeed: 0.35, chargeSpeed: 3.0, chargeRange: 40,
        maxChargeDist: 20, meleeRange: 1.0,
        clock_time: true, supportEnabled: true
    },
    "player:dm46": {
        normalRange: 39, alertRange: 49, focus: 8.0, speed: 10.0, combatType: "melee",
        strafeSpeed: 0.25, chargeSpeed: 2.5,
        chargeRange: 10, maxChargeDist: 12,
        clock_time: true, supportEnabled: true
    },
    "player:dm60": {
        normalRange: 42, alertRange: 54, focus: 9.0, speed: 15.0, combatType: "melee",
        strafeSpeed: 0.3, chargeSpeed: 3.0,
        chargeRange: 8, maxChargeDist: 12,
        clock_time: true, supportEnabled: true
    },
    "player:dm41": {
        normalRange: 40, alertRange: 60, focus: 15.0, speed: 10.0, combatType: "melee",
        strafeSpeed: 0.2, chargeSpeed: 2.0,
        chargeRange: 12, maxChargeDist: 8,
        clock_time: true, supportEnabled: true
    },
    "player:dm61": { normalRange: 50, alertRange: 60, focus: 20.0, speed: 5.0, clock_time: true, supportEnabled: true },
    "player:dm52": { normalRange: 51, alertRange: 51, focus: 5.0, speed: 10.0, combatType: "ranged", strafeRange: 10, strafeSpeed: 0.25, clock_time: false, supportEnabled: true },
    "player:dm56": { normalRange: 60, alertRange: 96, focus: 10.0, speed: 10.0, clock_time: false, supportEnabled: true },
    "player:dm28": {
        normalRange: 35, alertRange: 35, focus: 10.0, speed: 5.0, combatType: "melee",
        strafeSpeed: 0.25, chargeSpeed: 2.5, chargeRange: 35,
        maxChargeDist: 20, meleeRange: 1.0,
        clock_time: true, supportEnabled: true
    },
    "player:dm53": {
        normalRange: 38, alertRange: 48, focus: 5.0, speed: 15.0, combatType: "melee",
        strafeSpeed: 0.3, chargeSpeed: 2.5, chargeRange: 38,
        maxChargeDist: 20, meleeRange: 1.0,
        clock_time: true, supportEnabled: true
        },
    "player:dm63": {
        normalRange: 35, alertRange: 35, focus: 15.0, speed: 5.0, combatType: "melee",
        strafeSpeed: 0.25, chargeSpeed: 2.0, chargeRange: 35,
        maxChargeDist: 10, meleeRange: 3.5,
        clock_time: true, supportEnabled: true
        },
    "player:dm22": {
        normalRange: 36, alertRange: 42, focus: 3.0, speed: 20, combatType: "melee",
        strafeSpeed: 0.35, chargeSpeed: 2.5,
        chargeRange: 10, maxChargeDist: 10,
        clock_time: true, supportEnabled: true
    },
    "player:test1": {
        "modes": {
            1: {  // variant 1 → 远程示例
                normalRange: 36, alertRange: 36, focus: 2.0, speed: 15,
                combatType: "ranged",
                strafeRange: 12, strafeSpeed: 0.33,
                clock_time: true, supportEnabled: true
            },
            2: {  // variant 2 → 近战示例
                normalRange: 20, alertRange: 28, focus: 3.0, speed: 5,
                combatType: "melee",
                meleeRange: 3.5, strafeSpeed: 0.4,
                chargeSpeed: 2.5, chargeRange: 10, maxChargeDist: 10, chargeDuration: 80,
                clock_time: false, supportEnabled: true
            }
        }
    }
};

let GLOBAL_MAX_BROADCAST_DISTANCE = 96;

// DmTargetEngine 主引擎
export class DmTargetEngine {
    static init() {
        console.warn("[DM-Engine] 初始化开始");

        // ── 新增：初始化目标传感器 ──
        TargetSensorManager.init();

        // ── 新增：初始化近战格挡机制 ──
        MovementMelee.initBlockMechanic();

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

                const nowTick = system.currentTick;
                const damageVal = event.damage ?? 0;
                const attacker = event.damageSource?.damagingEntity;  // ← 先定义attacker（v2.26.1 提前定义用于假受伤甄别）

                // ── 💥 v2.26.1 假受伤甄别 ──
                // 伤害吸收池自然消失/刷新时，游戏可能补发 entityHurt
                //（无有效攻击者 或 攻击者==自身）。
                // 这类事件不入伤害历史、不设威胁目标、不触发远程反击，防止策略引擎被假扣血波动。
                const isFakeHurt = !attacker || !attacker.isValid || attacker.id === victim.id;
                if (isFakeHurt) {
                    if (DmTargetRegistry[victim.typeId] && damageVal >= 50) {
                        const lastFakeLog = victim.getDynamicProperty("dm:fake_hurt_log_tick") ?? 0;
                        if (nowTick - lastFakeLog >= 100) {
                            victim.setDynamicProperty("dm:fake_hurt_log_tick", nowTick);
                            console.warn(`[DM-Engine] 🧱 忽略疑似吸收池消失假受伤(伤害=${damageVal.toFixed(0)}, 无有效攻击者) | ${victim.typeId}`);
                        }
                    }
                    return;
                }

                // 💥💥💥【核心补全 1】：记录受击者的历史伤害日志 (供 Predict 实时 Console 和 TTK 计算) 💥💥💥
                let victimRecord = VictimDamageHistoryMap.get(victim.id);
                if (!victimRecord) {
                    victimRecord = { tick: nowTick, history: [] };
                }
                victimRecord.tick = nowTick;
                if (!victimRecord.history) victimRecord.history = [];

                // 压入本次受击数值
                victimRecord.history.push({
                    tick: nowTick,
                    damage: damageVal
                });

                // 只保留最近 10 秒 (200 Ticks) 内的伤害记录，防止内存泄露
                if (victimRecord.history.length > 30) {
                    victimRecord.history = victimRecord.history.filter(h => nowTick - h.tick < 200);
                }
                VictimDamageHistoryMap.set(victim.id, victimRecord);

                // ------------------ 以下保持你原有的逻辑 ------------------

                if (DmTargetRegistry[victim.typeId]) {
                    victim.setDynamicProperty("dm_last_hurt_tick", nowTick);
                }
                const damager = attacker;  // v2.26.1 attacker 已提前定义，damager 保持原别名
                if (damager && DmTargetRegistry[damager.typeId]) {
                    LastDamageTick.set(damager.id, { tick: nowTick, targetId: victim.id });
                    const dist = Math.sqrt(DmTargetEngine.getDistSq(damager.location, victim.location));
                    damager.setDynamicProperty("dm:last_attack_dist", dist);
                }
                // 💥 新增：远程攻击检测（放在attacker定义之后）
                try {
                    if (DmTargetRegistry[victim.typeId] && attacker && attacker.isValid) {
                        let victimConfig = DmTargetRegistry[victim.typeId];
                        if (victimConfig.modes) {
                            const variantComp = victim.getComponent("minecraft:variant");
                            const variant = variantComp ? variantComp.value : 0;
                            if (victimConfig.modes[variant]) {
                                victimConfig = victimConfig.modes[variant];
                            }
                        }
                        if (victimConfig.chargeRange) {
                            const atkDist = Math.sqrt(DmTargetEngine.getDistSq(victim.location, attacker.location));
                            if (atkDist >= victimConfig.chargeRange) {
                                victim.setDynamicProperty("dm:ranged_retaliate", 1);
                                victim.setDynamicProperty("dm:ranged_retaliate_tick", nowTick);
                                console.warn(`[DM-Melee] 🏹 远程攻击检测! 距离=${atkDist.toFixed(1)}格 > chargeRange=${victimConfig.chargeRange}格 | 实体: ${victim.typeId}`);
                            }
                        }
                    }
                } catch (_) {}

                if (DmTargetRegistry[victim.typeId] && victim.getDynamicProperty("ownerId") === undefined) {
                    const nearPlayers = victim.dimension.getPlayers({ location: victim.location, maxDistance: 16 });
                    if (nearPlayers.length > 0) {
                        victim.setDynamicProperty("ownerId", nearPlayers[0].id);
                        console.warn(`[DM-Engine] 交互补录主人: ${victim.typeId} 主人=${nearPlayers[0].id}`);
                    }
                }

                if (DmTargetRegistry[victim.typeId] && attacker) {
                    console.warn(`[DM-Engine] 自身受击: ${victim.typeId} 反击目标=${attacker.typeId}`);
                    // ✅【v2.25】记录"威胁目标"：正在打我的目标（供走位参照，优先于索敌目标）
                    // 修复：原版索敌可能锁着远处A，而B贴脸打你 → 走位围绕错误目标被贴脸击杀
                    // （若你上了 v2.24 溯源，这里应写 realAttacker.id，避免锁到瞬亡弹射物）
                    const isProj = (attacker.matches && attacker.matches({ families: ["projectile"] }))
                        || (attacker.typeId && attacker.typeId.includes("bullet"));
                    if (!isProj) {
                        victim.setDynamicProperty("dm:threat_target_id", attacker.id);
                        victim.setDynamicProperty("dm:threat_target_tick", nowTick);
                        DmTargetEngine.setForcedTarget(victim.id, attacker, 3);
                    }
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

                    if (ownerId === victim.id && attacker) {
                        DmTargetEngine.setForcedTarget(follower.id, attacker, 2);
                    }
                    if (attacker && ownerId === attacker.id) {
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

        // ═══ 走位引擎分发 ═══
        const rawMode = unit.getDynamicProperty("dm:combat_mode");
        let effectiveType = config.combatType;
        if (rawMode === 1) effectiveType = "melee";
        else if (rawMode === 2) effectiveType = "ranged";

        // ── 近战范围自动检测 ──
        if (effectiveType === "melee") {
            const lastDist = unit.getDynamicProperty("dm:last_attack_dist");
            if (lastDist && lastDist > 0) {
                const prev = unit.getDynamicProperty("dm:melee_detected_range");
                unit.setDynamicProperty("dm:melee_detected_range",
                    prev ? prev * 0.8 + lastDist * 0.2 : lastDist
                );
                unit.setDynamicProperty("dm:last_attack_dist", undefined);
            }
        }

        if (effectiveType === "melee") {
            const meleeRange = unit.getDynamicProperty("dm:melee_detected_range") ?? config.meleeRange ?? 3.5;
            // 💥 修改这里：将 VictimDamageHistoryMap 作为最后一个参数传给近战走位
            MovementMelee.execute(unit, config, closestThreat, closestDistSq, meleeRange, VictimDamageHistoryMap);
        } else if (effectiveType === "ranged") {
            MovementRanged.execute(unit, config, closestThreat, closestDistSq, strafeRange, VictimDamageHistoryMap);
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
        TargetSensorManager.check(unit);
    }

    static getDistSq(pos1, pos2) {
        if (!pos1 || !pos2) return 99999;
        return (pos1.x - pos2.x) ** 2 + (pos1.y - pos2.y) ** 2 + (pos1.z - pos2.z) ** 2;
    }
}