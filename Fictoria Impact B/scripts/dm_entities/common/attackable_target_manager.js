import { world, system, EntityDamageCause } from "@minecraft/server";
import { MovementRanged } from "./movement_ranged.js";
import { MovementMelee } from "./movement_melee.js";
import { TacticalClockManager } from "./tactical_clock_manager.js";
import { DmSupportModule } from "./dm_support_system.js";

// ============================================================
// 日志开关
// ============================================================
const DEBUG_ENGINE = false;

function engineLog(...args) {
    if (DEBUG_ENGINE) {
        console.warn(...args);
    }
}

// ============================================================
// 缓存区
// ============================================================
const BlockedTargetTicks = new Map();
export const LastDamageTick = new Map();
export const VictimDamageHistoryMap = new Map();
const LastSwitchTick = new Map();
const ForcedTargets = new Map();

// ============================================================
// ActiveMovers
//
// 长期方案 B：
// main.js 不再查询所有 DM 实体。
// manager 在 movement 执行后，把当前有速度的单位同步到这里。
// main.js 每 tick 只遍历这个 Map。
// ============================================================
export const ActiveMovers = new Map();

// ============================================================
// 非战斗清速状态
//
// 用于记录上一轮是否处于战斗。
// 当 tag 被 JSON 层移除后，只清理一次速度，避免反复写 0。
// ============================================================
const PreviousCombatState = new Set();

// ============================================================
// 敌人快照常量
//
// 现在不再让每个单位单独查询附近怪物，
// 而是每个维度根据玩家位置建立一次敌人快照。
//
// ENEMY_SNAPSHOT_RADIUS 默认 96，是为了兼容你配置里最大的 alertRange。
// 如果后续想进一步降低开销，可以改成 80 / 64。
// ============================================================
const ENEMY_FAMILY = "monster";
const ENEMY_SNAPSHOT_RADIUS = 96;
const ENEMY_CELL = 24;
const ANCHOR_CELL = 32;
const MAX_ENEMY_ANCHORS = 24;

// ============================================================
// 配置规范化工具
// ============================================================
function normalizeConfig(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeConfig);
    }

    if (value && typeof value === "object") {
        const out = {};

        for (const [k, v] of Object.entries(value)) {
            const newKey = typeof k === "string" ? k.trim() : k;
            out[newKey] = normalizeConfig(v);
        }

        return out;
    }

    if (typeof value === "string") {
        return value.trim();
    }

    return value;
}

// ============================================================
// TargetSensorManager
// ============================================================
const TargetSensorManager = {
    _tracking: new Map(),
    _byTarget: new Map(),

    PROPERTY_KEY: "dm:target_sensor",
    EVENT_ACQUIRED: "attack",
    EVENT_LOST: "silent",

    init() {
        try {
            world.beforeEvents.entityRemove.subscribe((event) => {
                try {
                    const removedEntity = event.removedEntity;
                    if (!removedEntity) return;

                    const removedId = removedEntity.id;
                    if (!removedId) return;

                    this._notifyTargetRemoved(removedId);
                } catch (_) {}
            });
        } catch (_) {}

        engineLog("[TargetSensor] 初始化完成");
    },

    _addTracking(trackerId, targetId) {
        if (!trackerId || !targetId) return;

        const oldTargetId = this._tracking.get(trackerId);
        if (oldTargetId === targetId) return;

        if (oldTargetId !== undefined) {
            this._removeTracking(trackerId);
        }

        this._tracking.set(trackerId, targetId);

        let set = this._byTarget.get(targetId);
        if (!set) {
            set = new Set();
            this._byTarget.set(targetId, set);
        }

        set.add(trackerId);
    },

    _removeTracking(trackerId) {
        if (!trackerId) return;

        const oldTargetId = this._tracking.get(trackerId);
        if (oldTargetId === undefined) return;

        this._tracking.delete(trackerId);

        const set = this._byTarget.get(oldTargetId);
        if (set) {
            set.delete(trackerId);

            if (set.size === 0) {
                this._byTarget.delete(oldTargetId);
            }
        }
    },

    _notifyTargetRemoved(removedTargetId) {
        const trackerSet = this._byTarget.get(removedTargetId);

        if (!trackerSet || trackerSet.size === 0) {
            this._byTarget.delete(removedTargetId);
            return;
        }

        this._byTarget.delete(removedTargetId);

        const lostEvent = this.EVENT_LOST;

        for (const trackerId of trackerSet) {
            this._tracking.delete(trackerId);

            system.run(() => {
                try {
                    const tracker = world.getEntity(trackerId);

                    if (tracker && tracker.isValid) {
                        tracker.triggerEvent(lostEvent);
                    }
                } catch (_) {}
            });
        }
    },

    check(entity) {
        if (!entity || !entity.isValid) return;

        try {
            const rawSensorValue = entity.getProperty(this.PROPERTY_KEY);
            const isOn = rawSensorValue === "on";

            if (!isOn) {
                if (this._tracking.has(entity.id)) {
                    this._removeTracking(entity.id);
                }
                return;
            }

            const trackerId = entity.id;
            const currentTarget = entity.target;
            const lastTargetId = this._tracking.get(trackerId);

            if (currentTarget && currentTarget.isValid) {
                const currentTargetId = currentTarget.id;

                if (!lastTargetId || lastTargetId !== currentTargetId) {
                    this._addTracking(trackerId, currentTargetId);
                    this._triggerEvent(entity, this.EVENT_ACQUIRED);
                }

                return;
            }

            if (lastTargetId) {
                this._removeTracking(trackerId);
                this._triggerEvent(entity, this.EVENT_LOST);
            }
        } catch (_) {}
    },

    _triggerEvent(entity, eventName) {
        try {
            if (entity && entity.isValid) {
                entity.triggerEvent(eventName);
            }
        } catch (e) {
            engineLog(`[TargetSensor] 触发事件失败: ${entity.typeId} (${eventName}) → ${e}`);
        }
    }
};

// ============================================================
// 配置表
// ============================================================
const RAW_DmTargetRegistry = {
    "player:dm34_1": {
        modes: {
            1: {
                normalRange: 34,
                alertRange: 54,
                focus: 2.0,
                speed: 8,
                combatType: "ranged",
                strafeRange: 12,
                strafeSpeed: 0.35,
                clock_time: false,
                supportEnabled: true
            },
            2: {
                normalRange: 30,
                alertRange: 50,
                focus: 10.0,
                speed: 10.0,
                combatType: "ranged",
                strafeRange: 9,
                strafeSpeed: 0.25,
                clock_time: false,
                supportEnabled: true
            },
            3: {
                normalRange: 58,
                alertRange: 78,
                focus: 22.0,
                speed: 2,
                combatType: "ranged",
                strafeRange: 20,
                strafeSpeed: 0.15,
                clock_time: false,
                supportEnabled: true
            },
            4: {
                normalRange: 32,
                alertRange: 52,
                focus: 20.0,
                speed: 18,
                combatType: "melee",
                strafeSpeed: 0.3,
                chargeSpeed: 2.5,
                chargeRange: 10,
                maxChargeDist: 10,
                clock_time: false,
                supportEnabled: true
            },
            5: {
                normalRange: 28,
                alertRange: 48,
                focus: 4.0,
                speed: 15,
                combatType: "ranged",
                strafeRange: 10,
                strafeSpeed: 0.45,
                clock_time: false,
                supportEnabled: true
            }
        }
    },

    "player:dm34": {
        modes: {
            1: {
                normalRange: 22,
                alertRange: 33,
                focus: 2.0,
                speed: 20,
                combatType: "melee",
                strafeSpeed: 0.3,
                chargeSpeed: 2.5,
                chargeRange: 10,
                maxChargeDist: 10,
                clock_time: false,
                supportEnabled: true
            },
            2: {
                normalRange: 26,
                alertRange: 33,
                focus: 8.0,
                speed: 10.0,
                combatType: "ranged",
                strafeRange: 10,
                strafeSpeed: 0.35,
                clock_time: false,
                supportEnabled: true
            },
            3: {
                normalRange: 28,
                alertRange: 33,
                focus: 15.0,
                speed: 5,
                combatType: "ranged",
                strafeRange: 18,
                strafeSpeed: 0.25,
                clock_time: false,
                supportEnabled: true
            }
        }
    },

    "player:dm48": {
        normalRange: 40,
        alertRange: 48,
        focus: 4.0,
        speed: 12,
        combatType: "ranged",
        strafeRange: 14,
        strafeSpeed: 0.4,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm35": {
        normalRange: 35,
        alertRange: 40,
        focus: 10.0,
        speed: 5,
        combatType: "ranged",
        strafeRange: 12,
        strafeSpeed: 0.3,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm32": {
        normalRange: 39,
        alertRange: 46,
        focus: 2.0,
        speed: 20,
        combatType: "ranged",
        strafeRange: 15,
        strafeSpeed: 0.32,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm51": {
        normalRange: 32,
        alertRange: 37,
        focus: 12.0,
        speed: 3,
        combatType: "ranged",
        strafeRange: 10,
        strafeSpeed: 0.26,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm26": {
        normalRange: 33,
        alertRange: 38,
        focus: 5.0,
        speed: 18,
        combatType: "ranged",
        strafeRange: 16,
        strafeSpeed: 0.35,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm50": {
        normalRange: 96,
        alertRange: 96,
        focus: 25.0,
        speed: 2,
        combatType: "ranged",
        strafeRange: 24,
        strafeSpeed: 0.2,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm21": {
        normalRange: 36,
        alertRange: 36,
        focus: 5.0,
        speed: 5,
        combatType: "ranged",
        strafeRange: 13,
        strafeSpeed: 0.3,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm6": {
        normalRange: 36,
        alertRange: 36,
        focus: 2.0,
        speed: 15,
        combatType: "ranged",
        strafeRange: 12,
        strafeSpeed: 0.33,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm31": {
        normalRange: 36,
        alertRange: 36,
        focus: 10.0,
        speed: 20,
        combatType: "ranged",
        strafeRange: 12,
        strafeSpeed: 0.35,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm45": {
        normalRange: 48,
        alertRange: 48,
        focus: 15.0,
        speed: 15.0,
        combatType: "ranged",
        strafeRange: 8,
        strafeSpeed: 0.25,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm4": {
        normalRange: 44,
        alertRange: 46,
        focus: 3.0,
        speed: 10.0,
        combatType: "ranged",
        strafeRange: 12,
        strafeSpeed: 0.3,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm59": {
        normalRange: 37,
        alertRange: 40,
        focus: 2.0,
        speed: 15,
        combatType: "melee",
        strafeSpeed: 0.25,
        chargeSpeed: 2.5,
        chargeRange: 10,
        maxChargeDist: 10,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm33": {
        normalRange: 36,
        alertRange: 46,
        focus: 5.0,
        speed: 20,
        combatType: "melee",
        strafeSpeed: 0.35,
        chargeSpeed: 2.5,
        chargeRange: 8,
        maxChargeDist: 10,
        meleeRange: 2.0,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm24": {
        normalRange: 34,
        alertRange: 38,
        focus: 1.0,
        speed: 15,
        combatType: "melee",
        strafeSpeed: 0.25,
        chargeSpeed: 2.5,
        chargeRange: 10,
        maxChargeDist: 12,
        meleeRange: 2.5,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm8": {
        normalRange: 36,
        alertRange: 68,
        focus: 2.0,
        speed: 25,
        combatType: "melee",
        strafeSpeed: 0.3,
        chargeSpeed: 2.5,
        chargeRange: 36,
        maxChargeDist: 20,
        meleeRange: 1.0,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm25": {
        normalRange: 38,
        alertRange: 66,
        focus: 5.0,
        speed: 25,
        combatType: "melee",
        strafeSpeed: 0.25,
        chargeSpeed: 2.5,
        chargeRange: 10,
        maxChargeDist: 12,
        clock_time: true,
        supportEnabled: true
    },

    "player:kirito": {
        normalRange: 38,
        alertRange: 48,
        focus: 3.0,
        speed: 30,
        combatType: "melee",
        strafeSpeed: 0.3,
        chargeSpeed: 2.0,
        chargeRange: 9,
        maxChargeDist: 10,
        clock_time: true,
        supportEnabled: true
    },

    "player:asuna": {
        normalRange: 35,
        alertRange: 45,
        focus: 3.0,
        speed: 30,
        combatType: "melee",
        strafeSpeed: 0.4,
        chargeSpeed: 2.5,
        chargeRange: 10,
        maxChargeDist: 10,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm49": {
        normalRange: 42,
        alertRange: 66,
        focus: 3.0,
        speed: 30,
        combatType: "melee",
        strafeSpeed: 0.35,
        chargeSpeed: 2.5,
        chargeRange: 8,
        maxChargeDist: 10,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm62": {
        normalRange: 40,
        alertRange: 58,
        focus: 1.0,
        speed: 15,
        combatType: "melee",
        strafeSpeed: 0.15,
        chargeSpeed: 3.0,
        chargeRange: 6,
        maxChargeDist: 8,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm0": {
        normalRange: 40,
        alertRange: 40,
        focus: 5.0,
        speed: 15,
        combatType: "melee",
        strafeSpeed: 0.35,
        chargeSpeed: 3.0,
        chargeRange: 40,
        maxChargeDist: 20,
        meleeRange: 1.0,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm46": {
        normalRange: 39,
        alertRange: 49,
        focus: 8.0,
        speed: 10.0,
        combatType: "melee",
        strafeSpeed: 0.25,
        chargeSpeed: 2.5,
        chargeRange: 10,
        maxChargeDist: 12,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm60": {
        normalRange: 42,
        alertRange: 54,
        focus: 9.0,
        speed: 15.0,
        combatType: "melee",
        strafeSpeed: 0.3,
        chargeSpeed: 3.0,
        chargeRange: 8,
        maxChargeDist: 12,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm41": {
        normalRange: 40,
        alertRange: 60,
        focus: 15.0,
        speed: 10.0,
        combatType: "melee",
        strafeSpeed: 0.2,
        chargeSpeed: 2.0,
        chargeRange: 12,
        maxChargeDist: 8,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm61": {
        normalRange: 50,
        alertRange: 60,
        focus: 20.0,
        speed: 5.0,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm52": {
        normalRange: 51,
        alertRange: 51,
        focus: 5.0,
        speed: 10.0,
        combatType: "ranged",
        strafeRange: 10,
        strafeSpeed: 0.25,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm56": {
        normalRange: 60,
        alertRange: 96,
        focus: 10.0,
        speed: 10.0,
        clock_time: false,
        supportEnabled: true
    },

    "player:dm28": {
        normalRange: 35,
        alertRange: 35,
        focus: 10.0,
        speed: 5.0,
        combatType: "melee",
        strafeSpeed: 0.25,
        chargeSpeed: 2.5,
        chargeRange: 35,
        maxChargeDist: 20,
        meleeRange: 1.0,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm53": {
        normalRange: 38,
        alertRange: 48,
        focus: 5.0,
        speed: 15.0,
        combatType: "melee",
        strafeSpeed: 0.3,
        chargeSpeed: 2.5,
        chargeRange: 38,
        maxChargeDist: 20,
        meleeRange: 1.0,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm63": {
        normalRange: 35,
        alertRange: 35,
        focus: 15.0,
        speed: 5.0,
        combatType: "melee",
        strafeSpeed: 0.25,
        chargeSpeed: 2.0,
        chargeRange: 35,
        maxChargeDist: 10,
        meleeRange: 3.5,
        clock_time: true,
        supportEnabled: true
    },

    "player:dm22": {
        normalRange: 36,
        alertRange: 42,
        focus: 3.0,
        speed: 20,
        combatType: "melee",
        strafeSpeed: 0.35,
        chargeSpeed: 2.5,
        chargeRange: 10,
        maxChargeDist: 10,
        clock_time: true,
        supportEnabled: true
        },

    "player:dm54": {
        normalRange: 36,
        alertRange: 36,
        focus: 10.0,
        speed: 5.0,
        combatType: "melee",
        strafeSpeed: 0.25,
        chargeSpeed: 2.5,
        chargeRange: 9,
        maxChargeDist: 9,
        clock_time: true,
        supportEnabled: true
    },

    "player:test1": {
        modes: {
            1: {
                normalRange: 36,
                alertRange: 36,
                focus: 2.0,
                speed: 15,
                combatType: "ranged",
                strafeRange: 12,
                strafeSpeed: 0.33,
                clock_time: true,
                supportEnabled: true
            },
            2: {
                normalRange: 20,
                alertRange: 28,
                focus: 3.0,
                speed: 5,
                combatType: "melee",
                meleeRange: 3.5,
                strafeSpeed: 0.4,
                chargeSpeed: 2.5,
                chargeRange: 10,
                maxChargeDist: 10,
                chargeDuration: 80,
                clock_time: false,
                supportEnabled: true
            }
        }
    }
};

const DmTargetRegistry = normalizeConfig(RAW_DmTargetRegistry);
const REGISTRY_ENTRIES = Object.entries(DmTargetRegistry);

let GLOBAL_MAX_BROADCAST_DISTANCE = 96;

// ============================================================
// 敌人快照工具
// ============================================================
function collectEnemySnapshot(dimension, players) {
    const enemyMap = new Map();
    const anchorMap = new Map();

    const addAnchor = (loc, radius) => {
        if (!loc || typeof radius !== "number" || radius <= 0) return;

        const key = `${Math.floor(loc.x / ANCHOR_CELL)},${Math.floor(loc.z / ANCHOR_CELL)}`;

        const old = anchorMap.get(key);
        if (!old || radius > old.radius) {
            anchorMap.set(key, {
                x: loc.x,
                y: loc.y,
                z: loc.z,
                radius
            });
        }
    };

    // 基于玩家位置建立扫描锚点
    for (const player of players) {
        try {
            if (player.isValid) {
                addAnchor(player.location, ENEMY_SNAPSHOT_RADIUS);
            }
        } catch (_) {}
    }

    const anchors = Array.from(anchorMap.values()).slice(0, MAX_ENEMY_ANCHORS);

    for (const anchor of anchors) {
        try {
            const enemies = dimension.getEntities({
                location: {
                    x: anchor.x,
                    y: anchor.y,
                    z: anchor.z
                },
                maxDistance: anchor.radius,
                families: [ENEMY_FAMILY]
            });

            for (const enemy of enemies) {
                if (enemy.isValid) {
                    enemyMap.set(enemy.id, enemy);
                }
            }
        } catch (_) {}
    }

    const count = enemyMap.size;

    if (count === 0) {
        return {
            empty: true,
            count: 0
        };
    }

    // 敌人较少时直接返回数组
    if (count <= 64) {
        return {
            empty: false,
            enemies: Array.from(enemyMap.values()),
            count
        };
    }

    // 敌人较多时建立空间桶
    const grid = new Map();

    for (const enemy of enemyMap.values()) {
        try {
            const x = Math.floor(enemy.location.x / ENEMY_CELL);
            const z = Math.floor(enemy.location.z / ENEMY_CELL);
            const key = `${x},${z}`;

            if (!grid.has(key)) {
                grid.set(key, []);
            }

            grid.get(key).push(enemy);
        } catch (_) {}
    }

    return {
        empty: false,
        grid,
        cell: ENEMY_CELL,
        count
    };
}

function queryNearbyEnemies(snapshot, location, range) {
    if (!snapshot || snapshot.empty || !location || range <= 0) {
        return [];
    }

    if (snapshot.enemies) {
        return snapshot.enemies;
    }

    const result = [];

    const cx = Math.floor(location.x / snapshot.cell);
    const cz = Math.floor(location.z / snapshot.cell);

    const radius = Math.ceil(range / snapshot.cell);

    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const key = `${cx + dx},${cz + dz}`;
            const arr = snapshot.grid.get(key);

            if (!arr) continue;

            for (const enemy of arr) {
                if (enemy.isValid) {
                    result.push(enemy);
                }
            }
        }
    }

    return result;
}

// ============================================================
// ActiveMovers 同步器
// ============================================================
function syncActiveMover(unit) {
    try {
        if (!unit || !unit.isValid) {
            if (unit && unit.id) {
                ActiveMovers.delete(unit.id);
            }
            return;
        }

        const velX = unit.getDynamicProperty("dm:cmd_vel_x") ?? 0;
        const velZ = unit.getDynamicProperty("dm:cmd_vel_z") ?? 0;
        const velY = unit.getDynamicProperty("dm:cmd_vel_y") ?? 0.02;

        if (velX !== 0 || velZ !== 0 || velY > 0.02) {
            ActiveMovers.set(unit.id, {
                unit,
                tick: system.currentTick
            });
        } else {
            ActiveMovers.delete(unit.id);
        }
    } catch (_) {
        try {
            if (unit && unit.id) {
                ActiveMovers.delete(unit.id);
            }
        } catch (_) {}
    }
}

// ============================================================
// 清速工具
// ============================================================
function clearMovementCommands(unit) {
    try {
        unit.setDynamicProperty("dm:cmd_vel_x", 0);
        unit.setDynamicProperty("dm:cmd_vel_z", 0);
        unit.setDynamicProperty("dm:cmd_vel_y", 0);
        unit.setDynamicProperty("dm:melee_charging", 0);
    } catch (_) {}

    try {
        ActiveMovers.delete(unit.id);
    } catch (_) {}
}

// ============================================================
// 配置解析辅助
// ============================================================
function resolveStrictConfig(globalConfig, unit) {
    if (!globalConfig) return null;

    if (!globalConfig.modes) {
        return globalConfig;
    }

    try {
        const variantComp = unit.getComponent("minecraft:variant");
        const variant = variantComp ? variantComp.value : 0;

        if (!(variant in globalConfig.modes)) {
            return null;
        }

        return globalConfig.modes[variant];
    } catch (_) {
        return null;
    }
}

function resolveConfigWithFallback(globalConfig, unit) {
    if (!globalConfig) return null;

    if (!globalConfig.modes) {
        return globalConfig;
    }

    try {
        const variantComp = unit.getComponent("minecraft:variant");
        const variant = variantComp ? variantComp.value : 0;

        return globalConfig.modes[variant] ?? globalConfig;
    } catch (_) {
        return globalConfig;
    }
}

function computeMaxBroadcastDistance() {
    let maxAlert = 0;

    for (const config of Object.values(DmTargetRegistry)) {
        if (config.modes) {
            for (const mode of Object.values(config.modes)) {
                if (typeof mode.alertRange === "number" && mode.alertRange > maxAlert) {
                    maxAlert = mode.alertRange;
                }
            }
        } else if (typeof config.alertRange === "number" && config.alertRange > maxAlert) {
            maxAlert = config.alertRange;
        }
    }

    return maxAlert + 18;
}

// ============================================================
// DmTargetEngine 主引擎
// ============================================================
export class DmTargetEngine {
    static init() {
        engineLog("[DM-Engine] 初始化开始");

        TargetSensorManager.init();
        MovementMelee.initBlockMechanic();

        try {
            GLOBAL_MAX_BROADCAST_DISTANCE = computeMaxBroadcastDistance();
            engineLog(`[DM-Engine] 广播距离 = ${GLOBAL_MAX_BROADCAST_DISTANCE}`);
        } catch (e) {
            console.warn("[DM-Engine] 计算广播距离失败，使用默认值96");
            GLOBAL_MAX_BROADCAST_DISTANCE = 96;
        }

        try {
            world.beforeEvents.entityRemove.subscribe((event) => {
                try {
                    const id = event.removedEntity?.id;
                    if (!id) return;

                    BlockedTargetTicks.delete(id);
                    LastDamageTick.delete(id);
                    VictimDamageHistoryMap.delete(id);
                    LastSwitchTick.delete(id);
                    ForcedTargets.delete(id);

                    ActiveMovers.delete(id);
                    PreviousCombatState.delete(id);

                    TargetSensorManager._removeTracking(id);
                } catch (_) {}
            });
        } catch (_) {}

        world.afterEvents.dataDrivenEntityTrigger.subscribe((event) => {
            try {
                if (
                    event.eventId === "minecraft:on_tame" &&
                    DmTargetRegistry[event.entity.typeId]
                ) {
                    const players = event.entity.dimension.getPlayers({
                        location: event.entity.location,
                        maxDistance: 16
                    });

                    if (players.length > 0) {
                        event.entity.setDynamicProperty("ownerId", players[0].id);
                        engineLog(`[DM-Engine] 驯服记录: ${event.entity.typeId} 主人=${players[0].id}`);
                    }
                }
            } catch (e) {
                console.error("[DM-Engine] 驯服监听异常: " + e);
            }
        });

        world.afterEvents.playerInteractWithEntity.subscribe((event) => {
            try {
                const entity = event.target;

                if (
                    DmTargetRegistry[entity.typeId] &&
                    entity.getDynamicProperty("ownerId") === undefined
                ) {
                    entity.setDynamicProperty("ownerId", event.player.id);
                    engineLog(`[DM-Engine] 交互补录主人: ${entity.typeId} 主人=${event.player.id}`);
                }
            } catch (e) {
                console.error("[DM-Engine] 交互补录异常: " + e);
            }
        });

        world.afterEvents.entityHurt.subscribe((event) => {
            try {
                const victim = event.hurtEntity;
                if (!victim || !victim.isValid) return;

                const nowTick = system.currentTick;
                const damageVal = event.damage ?? 0;
                const attacker = event.damageSource?.damagingEntity;

                const victimTypeId = victim.typeId;
                const victimGlobalConfig = DmTargetRegistry[victimTypeId];

                const isFakeHurt =
                    !attacker ||
                    !attacker.isValid ||
                    attacker.id === victim.id;

                if (isFakeHurt) {
                    return;
                }

                let victimRecord = VictimDamageHistoryMap.get(victim.id);

                if (!victimRecord) {
                    victimRecord = {
                        tick: nowTick,
                        history: []
                    };
                }

                victimRecord.tick = nowTick;

                if (!victimRecord.history) {
                    victimRecord.history = [];
                }

                victimRecord.history.push({
                    tick: nowTick,
                    damage: damageVal
                });

                if (victimRecord.history.length > 30) {
                    victimRecord.history = victimRecord.history.filter(
                        h => nowTick - h.tick < 200
                    );
                }

                VictimDamageHistoryMap.set(victim.id, victimRecord);

                if (victimGlobalConfig) {
                    victim.setDynamicProperty("dm_last_hurt_tick", nowTick);
                }

                const damager = attacker;
                const damagerGlobalConfig = damager ? DmTargetRegistry[damager.typeId] : undefined;

                if (damager && damagerGlobalConfig) {
                    LastDamageTick.set(damager.id, {
                        tick: nowTick,
                        targetId: victim.id
                    });

                    const dist = Math.sqrt(
                        DmTargetEngine.getDistSq(damager.location, victim.location)
                    );

                    damager.setDynamicProperty("dm:last_attack_dist", dist);
                }

                try {
                    if (victimGlobalConfig && attacker && attacker.isValid) {
                        const victimConfig = resolveConfigWithFallback(victimGlobalConfig, victim);

                        if (victimConfig && typeof victimConfig.chargeRange === "number") {
                            const atkDistSq = DmTargetEngine.getDistSq(victim.location, attacker.location);
                            const chargeRangeSq = victimConfig.chargeRange * victimConfig.chargeRange;

                            if (atkDistSq >= chargeRangeSq) {
                                victim.setDynamicProperty("dm:ranged_retaliate", 1);
                                victim.setDynamicProperty("dm:ranged_retaliate_tick", nowTick);
                            }
                        }
                    }
                } catch (_) {}

                if (
                    victimGlobalConfig &&
                    victim.getDynamicProperty("ownerId") === undefined
                ) {
                    try {
                        const nearPlayers = victim.dimension.getPlayers({
                            location: victim.location,
                            maxDistance: 16
                        });

                        if (nearPlayers.length > 0) {
                            victim.setDynamicProperty("ownerId", nearPlayers[0].id);
                            engineLog(`[DM-Engine] 受击补录主人: ${victim.typeId} 主人=${nearPlayers[0].id}`);
                        }
                    } catch (_) {}
                }

                if (victimGlobalConfig && attacker) {
                    engineLog(`[DM-Engine] 自身受击: ${victim.typeId} 反击目标=${attacker.typeId}`);

                    let isProj = false;

                    try {
                        isProj =
                            (attacker.matches && attacker.matches({ families: ["projectile"] })) ||
                            (attacker.typeId && attacker.typeId.includes("bullet"));
                    } catch (_) {}

                    if (!isProj) {
                        victim.setDynamicProperty("dm:threat_target_id", attacker.id);
                        victim.setDynamicProperty("dm:threat_target_tick", nowTick);

                        DmTargetEngine.setForcedTarget(victim.id, attacker, 3);
                    }

                    DmSupportModule.processHurtSupport(
                        victim,
                        event,
                        DmTargetRegistry,
                        ForcedTargets
                    );
                }

                if (attacker && attacker.isValid) {
                    try {
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
                    } catch (_) {}
                }
            } catch (e) {
                console.error(`[DM-Engine] 受伤事件异常: ${e}`);
            }
        });

        system.runInterval(() => {
            try {
                DmTargetEngine.update();
            } catch (e) {
                console.error("[DM-Engine] 主循环异常: " + e);
            }
        }, 5);

        console.warn("[DM-Engine] 初始化完成（敌人快照 + 非战斗拦截 + ActiveMovers）");
    }

    static setForcedTarget(unitId, newTarget, priority) {
        if (!unitId || !newTarget || !newTarget.isValid) return;

        const current = ForcedTargets.get(unitId);
        const nowTick = system.currentTick;

        if (
            !current ||
            (nowTick - current.tick > 80) ||
            priority >= current.priority
        ) {
            ForcedTargets.set(unitId, {
                target: newTarget,
                priority: priority,
                tick: nowTick
            });
        }
    }

    static update() {
        const activeDimensions = new Set();
        const playersByDimension = new Map();

        for (const player of world.getAllPlayers()) {
            try {
                if (!player.dimension) continue;

                activeDimensions.add(player.dimension);

                const dimKey = player.dimension.id ?? player.dimension.typeId ?? "unknown";

                if (!playersByDimension.has(dimKey)) {
                    playersByDimension.set(dimKey, []);
                }

                playersByDimension.get(dimKey).push(player);
            } catch (_) {}
        }

        for (const dimension of activeDimensions) {
            const dimKey = dimension.id ?? dimension.typeId ?? "unknown";
            const players = playersByDimension.get(dimKey) ?? [];

            // 每个维度建立一次敌人快照
            const enemySnapshot = collectEnemySnapshot(dimension, players);

            const collectedUnits = [];

            for (const [typeId, globalConfig] of REGISTRY_ENTRIES) {
                let units;

                try {
                    units = dimension.getEntities({ type: typeId });
                } catch (e) {
                    continue;
                }

                for (const unit of units) {
                    if (!unit.isValid) continue;

                    const activeConfig = resolveStrictConfig(globalConfig, unit);
                    if (!activeConfig) continue;

                    try {
                        DmTargetEngine.processUnit(unit, activeConfig, enemySnapshot);
                    } catch (e) {
                        console.error(`[DM-Engine] processUnit 异常 (${unit.id}): ${e}`);
                    }

                    if (activeConfig.supportEnabled) {
                        collectedUnits.push({
                            unit,
                            config: activeConfig,
                            typeId
                        });
                    }
                }
            }

            DmSupportModule.evaluatePressureSupport(
                collectedUnits,
                DmTargetRegistry,
                ForcedTargets,
                GLOBAL_MAX_BROADCAST_DISTANCE
            );
        }
    }

    static processUnit(unit, config, enemySnapshot) {
        // ============================================================
        // 支援系统
        //
        // 现在从敌人快照里取出压力半径内的敌人，
        // 传给 support，避免 support 自己再次 getEntities。
        // ============================================================
        const pressureRadius = config.pressureRadius ?? 8;

        let pressureTargets = [];

        if (config.supportEnabled && enemySnapshot && !enemySnapshot.empty) {
            try {
                pressureTargets = queryNearbyEnemies(
                    enemySnapshot,
                    unit.location,
                    pressureRadius
                );
            } catch (_) {
                pressureTargets = [];
            }
        }

        if (config.supportEnabled) {
            DmSupportModule.updateUnitPressure(
                unit,
                config,
                pressureTargets,
                LastDamageTick
            );

            DmSupportModule.processMainLoopTick(unit, config);
        }

        // ============================================================
        // ForcedTarget / 当前目标
        // ============================================================
        const forced = ForcedTargets.get(unit.id);
        const currentTarget = unit.target;

        let currentRange = config.normalRange;
        let hasValidForcedTarget = false;

        if (forced) {
            const isValid = forced.target && forced.target.isValid;
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

        // ============================================================
        // 从敌人快照获取附近敌人
        //
        // 不再执行：
        // unit.dimension.getEntities({
        //     location: unit.location,
        //     maxDistance: currentRange,
        //     families: ["monster"]
        // });
        // ============================================================
        let targets = [];

        if (enemySnapshot && !enemySnapshot.empty) {
            try {
                targets = queryNearbyEnemies(
                    enemySnapshot,
                    unit.location,
                    currentRange
                );
            } catch (_) {
                targets = [];
            }
        }

        let bestTarget = null;
        let highestWeight = -1;
        let closestThreat = null;

        const strafeRange = config.strafeRange ?? 15;
        let closestDistSq = strafeRange * strafeRange;

        const rangeSq = currentRange * currentRange;
        const nowTick = system.currentTick;

        for (const target of targets) {
            if (!target.isValid) continue;

            const distSq = DmTargetEngine.getDistSq(unit.location, target.location);

            // 快照可能返回略大于 currentRange 的空间桶候选，
            // 因此这里必须再次过滤距离。
            if (distSq > rangeSq) continue;

            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestThreat = target;
            }

            let distWeight = (rangeSq - distSq) / rangeSq;
            let weight = 0;

            const isForcedThisTarget =
                hasValidForcedTarget &&
                forced.target.id === target.id;

            if (isForcedThisTarget) {
                if (forced.priority === 3) {
                    weight = 1000000 + distWeight;
                } else if (forced.priority === 2) {
                    weight = 1000 + distWeight;
                } else if (forced.priority === 1) {
                    weight = 1000 + distWeight;
                }
            } else {
                weight = 100 + distWeight * 10;
            }

            if (currentTarget && currentTarget.id === target.id) {
                weight *= config.focus;

                const lastDmg = LastDamageTick.get(unit.id);

                if (lastDmg && lastDmg.targetId === currentTarget.id) {
                    if (nowTick - lastDmg.tick > 60) {
                        weight *= 0.2;
                    }
                }
            }

            if (weight > highestWeight) {
                highestWeight = weight;
                bestTarget = target;
            }
        }

        if (bestTarget && currentTarget?.id !== bestTarget.id) {
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

        // ============================================================
        // 走位引擎分发
        // ============================================================
        const rawMode = unit.getDynamicProperty("dm:combat_mode");

        let effectiveType = config.combatType;

        if (rawMode === 1) {
            effectiveType = "melee";
        } else if (rawMode === 2) {
            effectiveType = "ranged";
        }

        // ============================================================
        // TAG 总阀门
        //
        // dm_has_target / dm_skill_on 由 JSON 层负责增删。
        // JS 只检测。
        //
        // 没有战斗 tag 的单位不进入 movement，
        // 避免 movement 内部无效读取方块。
        // ============================================================
        const isCombat =
            unit.hasTag("dm_has_target") ||
            unit.hasTag("dm_skill_on");

        if (isCombat) {
            PreviousCombatState.add(unit.id);

            // 近战范围自动检测
            if (effectiveType === "melee") {
                const lastDist = unit.getDynamicProperty("dm:last_attack_dist");

                if (lastDist && lastDist > 0) {
                    const prev = unit.getDynamicProperty("dm:melee_detected_range");

                    unit.setDynamicProperty(
                        "dm:melee_detected_range",
                        prev ? prev * 0.8 + lastDist * 0.2 : lastDist
                    );

                    unit.setDynamicProperty("dm:last_attack_dist", undefined);
                }
            }

            if (effectiveType === "melee") {
                const meleeRange =
                    unit.getDynamicProperty("dm:melee_detected_range") ??
                    config.meleeRange ??
                    3.5;

                MovementMelee.execute(
                    unit,
                    config,
                    closestThreat,
                    closestDistSq,
                    meleeRange,
                    VictimDamageHistoryMap
                );

                syncActiveMover(unit);

            } else if (effectiveType === "ranged") {
                MovementRanged.execute(
                    unit,
                    config,
                    closestThreat,
                    closestDistSq,
                    strafeRange,
                    VictimDamageHistoryMap
                );

                syncActiveMover(unit);

            } else {
                ActiveMovers.delete(unit.id);
            }
        } else {
            // ============================================================
            // 非战斗状态
            //
            // 只在从战斗转为非战斗时清理一次速度。
            // ============================================================
            if (PreviousCombatState.has(unit.id)) {
                PreviousCombatState.delete(unit.id);
                clearMovementCommands(unit);
            }
        }

        // ============================================================
        // 战术时钟
        // ============================================================
        if (config.clock_time === true) {
            const realCurrentTarget = unit.target ?? bestTarget;

            let hasRealActiveThreat = false;

            if (realCurrentTarget && realCurrentTarget.isValid) {
                const realDistSq = DmTargetEngine.getDistSq(unit.location, realCurrentTarget.location);
                const normalRangeSq = config.normalRange * config.normalRange;

                if (realDistSq <= normalRangeSq || unit.target !== undefined) {
                    hasRealActiveThreat = true;
                }
            }

            TacticalClockManager.execute(unit, hasRealActiveThreat);
        }

        // ============================================================
        // 目标传感器检测
        // ============================================================
        TargetSensorManager.check(unit);
    }

    static getDistSq(pos1, pos2) {
        if (!pos1 || !pos2) return 99999;

        return (pos1.x - pos2.x) ** 2 +
               (pos1.y - pos2.y) ** 2 +
               (pos1.z - pos2.z) ** 2;
    }
}