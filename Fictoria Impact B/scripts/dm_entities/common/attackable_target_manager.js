import { world, system, EntityDamageCause } from "@minecraft/server";
import { MovementRanged } from "./movement_ranged.js";
import { MovementMelee, isAlliedAttacker } from "./movement_melee.js";
import { TacticalClockManager } from "./tactical_clock_manager.js";
import { DmSupportModule } from "./dm_support_system.js";
import {
    registerEntityRemoveHandler,
    registerAfterHurtHandler,
    registerDataDrivenHandler,
    REMOVE_PRIORITY,
    AFTER_HURT_PRIORITY,
    DATA_DRIVEN_PRIORITY
} from "./event_bus.js";
import {
    peekMoveCmd,
    clearMoveCmd,
    gcMoveCmd
} from "./move_command_store.js";
import {
    FACTION,
    factionOf,
    isInCombat,
    isCombatCapable
} from "./camp_faction.js";
import { PerfProbe } from "./perf_probe.js";

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
// ENEMY_SNAPSHOT_RADIUS 默认 96，是为了兼容配置里最大的 alertRange。
// 如果后续想进一步降低开销，可以改成 80 / 64。
// ============================================================
const ENEMY_FAMILY = "monster";
const ENEMY_SNAPSHOT_RADIUS = 96;
const ENEMY_CELL = 24;
const ANCHOR_CELL = 32;
const MAX_ENEMY_ANCHORS = 24;

// ============================================================
// 受管单位的家族标签
//
// 原实现按 REGISTRY_ENTRIES 逐个 typeId 调 getEntities({type})，
// 35 个注册项 = 每个维度每 5 tick 35 次查询。
//
// 现在改为按家族查询，再用 typeId 在配置表里查配置。
// dm     = 友方干员 player:dm0 ~ dm63 / asuna / kirito / test1
// demon  = 恶魔军团（当前不在配置表内，会走熔断分支）
//
// ⚠ 每个家族单独查一次，不能合并成一个数组：
//   EntityFilter.families 是 AND 语义，合并会导致一个都匹配不到。
//
// 已验证：35 个注册实体全部带 dm 家族，
// 且没有任何 component_group 会覆盖掉 dm 家族，
// 所以家族查询不会漏掉注册单位。
// ============================================================
const UNIT_FAMILIES = ["dm", "demon"];

// 每个家族的查询过滤器。
//
// 必须是模块级常量：写在调用点的 { families: [family] } 每次都是
// 新对象 + 新数组，而这里是每周期 × 每维度都要发一次的查询。
//
// demon 侧加 excludeFamilies 是防御性去重：实测 205 个实体里没有
// 同时带 dm 与 demon 的，但万一将来出现，不排除会被扫进两个桶、
// 每周期解算两次。excludeFamilies 是 OR 语义，单个值无歧义。
const UNIT_QUERY_FILTERS = {
    dm: { families: ["dm"] },
    demon: { families: ["demon"], excludeFamilies: ["dm"] }
};

// 熔断报告去重：同一 typeId 只报告一次，避免每 5 tick 刷屏
const UnregisteredUnitReported = new Set();
const MAX_UNREGISTERED_REPORT = 64;

// ============================================================
// 熔断：实体带 dm / demon 家族，但配置表里没有它
//
// 直接跳过，不跑任何 AI 分支，也不写任何 DynamicProperty。
// ============================================================
function reportUnregisteredUnit(typeId) {
    try {
        if (!typeId) return false;
        if (UnregisteredUnitReported.has(typeId)) return false;
        if (UnregisteredUnitReported.size >= MAX_UNREGISTERED_REPORT) return false;

        UnregisteredUnitReported.add(typeId);

        // 每个 typeId 只播报一次，最多 64 条，不会刷屏
        console.warn(
            `[DM-Engine] 熔断：${typeId} 带有 dm/demon 家族标签，` +
            `但不在 DmTargetRegistry 中，已跳过`
        );

        return true;
    } catch (_) {
        return false;
    }
}

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
        registerEntityRemoveHandler("target_sensor_cache", (event) => {
            try {
                const removedEntity = event.removedEntity;
                if (!removedEntity) return;

                const removedId = removedEntity.id;
                if (!removedId) return;

                this._notifyTargetRemoved(removedId);
            } catch (_) { }
        }, REMOVE_PRIORITY.TARGET_CACHE);

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
                } catch (_) { }
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
        } catch (_) { }
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

// ============================================================
// demon 默认档（宽进策略）
//
// ⚠ 绝对不要把它塞进 DmTargetRegistry。
//   processHurtSupport 的触发条件是 DmTargetRegistry[victim.typeId] 存在
//   （见下面的受击链路），一旦注册表里有 demon 项，所有 demon 挨打都会
//   走支援广播 —— 而 demon 明确不接支援系统（自然生成、数量大）。
//   保持注册表里只有 dm 项，受击链路对 demon 自动短路。
//
// supportEnabled: false 是整条支援链路的总闸门：
//   processUnit 里的压力查询 / updateUnitPressure / processMainLoopTick
//   全部包在这个开关里，false 等于完全不跑。
// ============================================================
const DEMON_DEFAULT_MODE = normalizeConfig({
    faction: "demon",

    normalRange: 24,
    alertRange: 34,

    // 目标粘性系数：与 dm 一致，不压低也不放大
    focus: 1.0,

    // 切目标冷却 = max(1, 20 - speed) = 14 tick；数值越大切得越快
    speed: 6,

    combatType: "melee",
    meleeRange: 3.5,
    strafeRange: 12,
    strafeSpeed: 0.25,

    supportEnabled: false,
    pressureRadius: 0
});

// ============================================================
// demon 精确配置（现在留空）
//
// 将来给个别 demon 单独特调时写在这里，格式与 dm 完全一致：
//
//   "demon:boss1_1": {
//       modes: {
//           0: { ...DEMON_DEFAULT_MODE, speed: 4 },
//           1: { ...DEMON_DEFAULT_MODE, speed: 3, combatType: "ranged" }
//       }
//   }
//
// 有 modes 就按 minecraft:variant 分档；没 modes 就是平铺一档。
// 分档取不到（variant 不在表里）时 demon 退回默认档，不像 dm 那样熔断。
// ============================================================
const RAW_DemonRegistry = {};

const DmTargetRegistry = normalizeConfig({
    ...RAW_DmTargetRegistry,
    ...RAW_DemonRegistry
});
// 注册表键值对。
// 说明：update() 已改为按家族一次性查询 + typeId 查表，
// 不再需要遍历这个数组做逐类型查询。
// 保留定义供诊断/回滚使用。
const REGISTRY_ENTRIES = Object.entries(DmTargetRegistry);

let GLOBAL_MAX_BROADCAST_DISTANCE = 64;

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
        } catch (_) { }
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
        } catch (_) { }
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
        } catch (_) { }
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
// demon 侧的敌人表查询
//
// demon 的敌人是 player 家族，这批实体已经在内存里（见
// buildPlayerSideIndex），不做空间网格快照。
//
// 这里只过滤有效性，距离过滤交给 processUnit 统一做 ——
// 与 dm 侧「快照给候选、processUnit 再按 currentRange 判距」的
// 语义保持一致，避免两处规则不一致导致目标时而可见时而不见。
// ============================================================
function queryNearbyFromList(list, location, range) {
    if (!list || list.length === 0 || !location || range <= 0) {
        return [];
    }

    const result = [];

    for (let i = 0; i < list.length; i++) {
        const enemy = list[i];

        if (enemy && enemy.isValid) {
            result.push(enemy);
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

        const cmd = peekMoveCmd(unit.id);
        const velX = cmd.x;
        const velZ = cmd.z;
        const velY = cmd.y;

        if (velX !== 0 || velZ !== 0 || velY > 0.02) {
            ActiveMovers.set(unit.id, {
                unit,
                tick: system.currentTick
            });
        }

        // 关键：
        // 指令速度为 0 时不要立刻删除。
        // 让 main.js 判断实际驱动速度是否已经刹停。
        // 即使 main.js 没处理，也有 MOVER_EXPIRE_TICKS 兜底。

    } catch (_) {
        try {
            if (unit && unit.id) {
                ActiveMovers.delete(unit.id);
            }
        } catch (_) { }
    }
}

// ============================================================
// 清速工具
// ============================================================
function clearMovementCommands(unit) {
    try {
        clearMoveCmd(unit);
        unit.setDynamicProperty("dm:melee_charging", 0);
    } catch (_) { }
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

// ============================================================
// 按阵营解析配置（三档）
//
// dm   ：严格。查不到 → 报警 + 熔断；variant 不命中 → 熔断。
//        35 项注册是人工维护的，漏配 / 拼错必须暴露。
// demon：宽进。查不到 → 默认档接管；有精确配置但 variant 不命中
//        → 也退回默认档。自然生成的杂兵逐个配没意义。
//
// 这里的两处 faction 判断是设计允许的「数据来源不同」，
// 不是行为分叉 —— 拿到的 config 之后走同一套引擎逻辑。
// ============================================================
function resolveUnitConfig(typeId, unit, faction) {
    const globalConfig = DmTargetRegistry[typeId];

    if (faction === FACTION.DM) {
        if (!globalConfig) {
            reportUnregisteredUnit(typeId);
            return null;
        }

        return resolveStrictConfig(globalConfig, unit);
    }

    if (faction === FACTION.DEMON) {
        if (!globalConfig) return DEMON_DEFAULT_MODE;

        return resolveStrictConfig(globalConfig, unit) ?? DEMON_DEFAULT_MODE;
    }

    return null;
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
// 分帧调度（第四优先级优化）
//
// ── 问题 ─────────────────────────────────────────────────
// 原实现每 5 tick 在「同一个 tick」里把所有受管单位全解算完：
// 索敌 + EWMA + 走位 + 姿态 + applyImpulse 准备。
//
// 60 个单位同屏时，那一个 tick 的开销是其余 4 个 tick 的
// 几十倍，表现是周期性掉帧，而不是整体卡顿。
//
// ── 方案 ─────────────────────────────────────────────────
// 周期仍是 5 tick，但把单位分成 5 组，每 tick 只处理 1 组。
//   总开销不变（每个单位仍然每 5 tick 解算一次）
//   尖峰被摊平到 5 个 tick
//
// 每 5 tick 的「重量级全局工作」仍集中在 frame 0：
//   · 全量家族查询（重建受管单位表）
//   · 敌人快照重建
//   · 支援压力配对评估
//   · 走位指令表回收
//
// frame 1~4 只做一件事：遍历自己那一桶单位并解算。
//
// ── 分组为什么用 entity.id 而不是 typeId ──────────────────
// 同一个 typeId（例如 player:dm8）同屏可能有很多个实例，
// 按 typeId 分组会让它们全部落进同一桶 —— 那一桶照样爆，
// 其余 4 桶空转，分帧完全失效。
//
// entity.id 是运行时唯一数值 ID，不同实例必然不同。
//
// 但为了应对「id 相同或高度聚集」的极端情况，
// 再叠两层保护：
//   1. 乘法散列：即使 id 连续分配，低位规律也会被打散
//   2. 遍历序号二次偏移：id 完全相同时靠序号分开
//   3. 桶容量上限：任何一桶超过 MAX_UNITS_PER_FRAME 就顺延
//      （宁可某桶多跑几个，也不能漏单位）
// ============================================================

// 一个完整周期的 tick 数（与原 runInterval 周期一致）
const UPDATE_INTERVAL = 5;

// 分帧数
const FRAME_COUNT = UPDATE_INTERVAL;

// 单桶容量下限
//
// 实际上限是「max(此值, 单位总数/帧数 × 1.25)」，
// 见 rebuildManagedUnits 里的 cap 计算。
//
// 写死常量的意义：单位很少时（十来个干员）不让个别桶
// 因为散列运气差而多扛几个相对成本高的单位。
const MAX_UNITS_PER_FRAME = 24;

// 单桶容量的动态系数
//
// 单位总数超过「帧数 × MAX_UNITS_PER_FRAME」时，
// 上限跟着总量水涨船高，否则溢出保护会退化成
// 「全部塞回首选桶」，分帧直接失效。
const FRAME_CAP_SLACK = 1.25;

// 每帧的处理桶
const FrameBuckets = [];

for (let i = 0; i < FRAME_COUNT; i++) {
    FrameBuckets.push([]);
}

// 本周期的受管单位全表
//
// 用数组而不是 Map：同一个 id 万一对应多个实体实例，
// 用 Map 会互相覆盖导致漏怪。数组允许重复。
const ManagedUnits = [];

// 各维度敌人快照缓存（frame 1~4 复用 frame 0 建好的那份）
const SnapshotCache = new Map();

// 计算单位所属帧槽
function frameSlotOf(entityId, ordinal) {
    const id = entityId | 0;

    // 乘法散列（Murmur3 的混合常数）
    let h = Math.imul(id ^ (id >>> 16), 0x9E3779B1) >>> 0;

    // 遍历序号二次打散：解决同 id 多实例
    h = (h + Math.imul(ordinal, 0x85EBCA6B)) >>> 0;

    return h % FRAME_COUNT;
}

// 入桶（带容量保护）
function assignBucket(entry, preferredSlot, cap) {
    for (let k = 0; k < FRAME_COUNT; k++) {
        const slot = (preferredSlot + k) % FRAME_COUNT;

        if (FrameBuckets[slot].length < cap) {
            FrameBuckets[slot].push(entry);
            return;
        }
    }

    // 全都满了：宁可超载也不漏单位
    FrameBuckets[preferredSlot].push(entry);
}

// ============================================================
// 重建受管单位表（每周期一次）
//
// 这一步承担原来 update() 里的全部查询工作：
// 家族查询 + 熔断 + 配置解析 + 敌人快照 + 分桶。
// ============================================================
function rebuildManagedUnits(dimStates) {
    const perfT0 = PerfProbe.now();

    ManagedUnits.length = 0;

    for (let i = 0; i < FRAME_COUNT; i++) {
        FrameBuckets[i].length = 0;
    }

    for (const state of dimStates) {
        const { dimKey, dimension, players } = state;

        // 敌人快照：每周期重建一次，frame 1~4 复用
        let enemySnapshot = null;

        try {
            enemySnapshot = collectEnemySnapshot(dimension, players);
        } catch (e) {
            enemySnapshot = null;
        }

        SnapshotCache.set(dimKey, enemySnapshot);

        // ============================================================
        // 按家族查询，取代原先的 N 次 typeId 查询
        //
        // ⚠ SAPI 语义注意：
        //   EntityFilter.families 是「AND」语义
        //   （官方原文：includes entities that match ALL of the specified families）
        //   所以写成 { families: ["dm","demon"] } 会要求实体同时属于两个家族，
        //   结果一个都匹配不到。
        //   正确做法是一个家族一次查询，逐个取。
        //
        // 旧：for (typeId of REGISTRY_ENTRIES) getEntities({ type: typeId })  → 35 次
        // 新：for (family of UNIT_FAMILIES) getEntities({ families: [family] }) → 2 次
        //
        // 覆盖范围不变：注册表 35 项全部带 dm 家族。
        // ============================================================
        for (const family of UNIT_FAMILIES) {
            // 家族决定阵营。dm 家族只可能是 dm，demon 家族只可能是 demon，
            // 两个家族实测互斥，所以这一步不需要再跑 factionOf。
            const faction = family === "dm" ? FACTION.DM : FACTION.DEMON;

            let candidates = [];

            try {
                candidates = dimension.getEntities(UNIT_QUERY_FILTERS[family]);
            } catch (e) {
                candidates = [];
            }

            for (const unit of candidates) {
                if (!unit || !unit.isValid) continue;

                const typeId = unit.typeId;

                // ============================================================
                // demon 家族里的非战斗单位
                //
                // 13 个 bullet:* 和 mob:bomb_roar 带 demon 家族但不带 monster，
                // 它们不是战斗单位。挡在配置解析之前，省掉每周期的无用功。
                // （dm 家族不需要这道：35 个注册项全部是干员）
                // ============================================================
                if (faction === FACTION.DEMON && !isCombatCapable(unit)) continue;

                // ============================================================
                // 配置解析（按阵营三档，见 resolveUnitConfig）
                //
                // dm   ：查不到 / variant 不命中 → null（熔断 + 报警一次）
                // demon：查不到 / variant 不命中 → 默认档接管
                // ============================================================
                const activeConfig = resolveUnitConfig(typeId, unit, faction);

                if (!activeConfig) continue;

                ManagedUnits.push({
                    unit,
                    config: activeConfig,
                    typeId,
                    faction,
                    dimKey
                });
            }
        }
    }

    // 分桶
    //
    // 上限随总量自适应：单位多时按均值放宽，
    // 单位少时用 MAX_UNITS_PER_FRAME 兜底。
    const unitCount = ManagedUnits.length;

    const cap = Math.max(
        MAX_UNITS_PER_FRAME,
        Math.ceil((unitCount / FRAME_COUNT) * FRAME_CAP_SLACK)
    );

    for (let i = 0; i < unitCount; i++) {
        const entry = ManagedUnits[i];
        assignBucket(entry, frameSlotOf(entry.unit.id, i), cap);
    }

    // 这一轮重建出来的单位数。配合 engine.rebuild 的耗时
    // 能算出「每单位查询成本」
    PerfProbe.count("unit.total", unitCount);

    PerfProbe.lap("engine.rebuild", perfT0);
}

// ============================================================
// 玩家侧索引 —— demon 的敌人表
//
// demon 的敌人集合是 player 家族，而这批实体本来就都在内存里：
//   · ManagedUnits 里 faction === DM 的（全部已注册干员）
//   · dimStates[].players（每帧已有的 getAllPlayers）
// 两者拼起来就是完整清单，一次 getEntities 都不用发。
//
// ⚠ 必须在 rebuildManagedUnits 之后调用：它依赖 entry.faction。
//
// 已知边界：不在注册表里的 player 家族实体（例如 mob:dm60_summon）
// 进不了这张表，demon 也就看不到它。当前无害；将来若出现
// 「不注册但该被 demon 打」的实体，这里要退回
// getEntities({ families: ["player"] })。
// ============================================================
const PlayerSideIndex = new Map();

function buildPlayerSideIndex(dimStates) {
    PlayerSideIndex.clear();

    for (const state of dimStates) {
        PlayerSideIndex.set(state.dimKey, []);
    }

    // 先放干员：它们分散在各帧桶里，必须遍历全表
    for (let i = 0; i < ManagedUnits.length; i++) {
        const entry = ManagedUnits[i];

        if (entry.faction !== FACTION.DM) continue;
        if (!entry.unit || !entry.unit.isValid) continue;

        const list = PlayerSideIndex.get(entry.dimKey);

        if (list) list.push(entry.unit);
    }

    // 再放真人玩家
    for (const state of dimStates) {
        const list = PlayerSideIndex.get(state.dimKey);

        if (!list) continue;

        for (const player of state.players) {
            list.push(player);
        }
    }
}

// ============================================================
// 支援压力配对（每周期一次，需要全量单位）
//
// evaluatePressureSupport 是「caller × responder」全局配对，
// 分帧会缩小候选池导致配对失败，所以必须看全表。
// ============================================================
function evaluateSupportForAll(dimStates) {
    if (ManagedUnits.length === 0) return;

    const perfT0 = PerfProbe.now();

    for (const state of dimStates) {
        const collected = [];

        for (let i = 0; i < ManagedUnits.length; i++) {
            const entry = ManagedUnits[i];

            if (entry.dimKey !== state.dimKey) continue;
            if (!entry.config.supportEnabled) continue;
            if (!entry.unit || !entry.unit.isValid) continue;

            collected.push(entry);
        }

        if (collected.length === 0) continue;

        try {
            DmSupportModule.evaluatePressureSupport(
                collected,
                DmTargetRegistry,
                ForcedTargets,
                GLOBAL_MAX_BROADCAST_DISTANCE
            );
        } catch (e) {
            console.error(`[DM-Engine] 支援配对异常: ${e}`);
        }
    }

    PerfProbe.lap("engine.support", perfT0);
}

// ============================================================
// DmTargetEngine 主引擎
// ============================================================
export class DmTargetEngine {
    static init() {
        engineLog("[DM-Engine] 初始化开始");

        TargetSensorManager.init();
        MovementMelee.initBlockMechanic();

        GLOBAL_MAX_BROADCAST_DISTANCE = 64;
        engineLog(`[DM-Engine] 广播距离 = ${GLOBAL_MAX_BROADCAST_DISTANCE}（固定值）`);

        registerEntityRemoveHandler("target_engine_cache", (event) => {
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
            } catch (_) { }
        }, REMOVE_PRIORITY.ENGINE_STATE);

        registerDataDrivenHandler("target_engine_tame", (event) => {
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
        }, DATA_DRIVEN_PRIORITY.TARGET_ENGINE);

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

        registerAfterHurtHandler("target_engine_hurt", (event) => {
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

                // ============================================================
                // 友方攻击不算威胁
                //
                // 玩家 / 干员 / 友军打自己人时，友伤拦截会在 before 事件里
                // 把伤害归零，但 entityHurt 的 after 事件里 attacker 依然是
                // 那个友方实体。若不过滤，会污染「索敌」与「受击记账」
                // 两条链路 —— 逐条说明见下面的闸门注释。
                // ============================================================
                const isFriendlyHurt = isAlliedAttacker(attacker, victim);

                // ── 主人补录 ──
                // 与伤害无关，所以放在友伤闸门之前：
                // 玩家第一次误敲自己的单位时，同样应该补上 ownerId。
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
                    } catch (_) { }
                }

                // ============================================================
                // 友伤到此为止
                //
                // 下面整段都是「受击记账」，一次友伤会同时污染四个通道：
                //   · VictimDamageHistoryMap.tick  → movement_ranged 后撤判定
                //   · dm_last_hurt_tick            → 支援压力刺穿错峰 + 后撤
                //   · LastDamageTick / dm:last_attack_dist → 攻击者侧压力 +20
                //   · processHurtSupport 无条件把 dm_pressure 刷到 80
                // 前两个让单位无故后撤，后两个让压力虚高、可能把保镖引出来。
                // 所以在记账之前直接返回。
                // ============================================================
                if (isFriendlyHurt) return;

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
                } catch (_) { }

                if (victimGlobalConfig && attacker && factionOf(victim) === FACTION.DM) {
                    engineLog(`[DM-Engine] 自身受击: ${victim.typeId} 反击目标=${attacker.typeId}`);

                    let isProj = false;

                    try {
                        isProj =
                            (attacker.matches && attacker.matches({ families: ["projectile"] })) ||
                            (attacker.typeId && attacker.typeId.includes("bullet"));
                    } catch (_) { }

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

                // 随从/召唤物广播
                //
                // 友伤在上面的闸门已经返回，走不到这里；
                // 保留这道判断是为了防止未来有人把闸门挪到记账之后。
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
                    } catch (_) { }
                }
            } catch (e) {
                console.error(`[DM-Engine] 受伤事件异常: ${e}`);
            }
        }, AFTER_HURT_PRIORITY.TARGET_ENGINE_HURT);

        // ============================================================
        // 分帧调度
        //
        // 周期从 5 tick 改为每 tick 调用，由 update() 内部按
        // nowTick % FRAME_COUNT 决定这一帧处理哪一组单位。
        //
        // 每个单位仍然每 5 tick 解算一次（总开销不变），
        // 但原来集中在单一 tick 的尖峰被摊平到 5 个 tick。
        // ============================================================
        system.runInterval(() => {
            try {
                DmTargetEngine.update();
            } catch (e) {
                console.error("[DM-Engine] 主循环异常: " + e);
            }
        }, 1);

        console.warn(
            `[DM-Engine] 初始化完成（敌人快照 + 非战斗拦截 + ActiveMovers + ` +
            `${FRAME_COUNT} 帧分时调度）`
        );
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
        // 探针关闭时返回 0，本次埋点总成本 = 两次函数调用
        const perfT0 = PerfProbe.now();

        const nowTick = system.currentTick;

        // 当前帧槽：0 ~ FRAME_COUNT-1 循环
        const frameIndex = ((nowTick % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;

        // ============================================================
        // 收集在线玩家所在的维度
        //
        // 每帧都做：getAllPlayers 是原生快路径，
        // 远轻于任何一次 getEntities。
        // ============================================================
        const dimStates = [];

        try {
            const seen = new Map();

            for (const player of world.getAllPlayers()) {
                try {
                    const dimension = player.dimension;
                    if (!dimension) continue;

                    const dimKey = dimension.id ?? dimension.typeId ?? "unknown";

                    let state = seen.get(dimKey);

                    if (!state) {
                        state = { dimKey, dimension, players: [] };
                        seen.set(dimKey, state);
                        dimStates.push(state);
                    }

                    state.players.push(player);
                } catch (_) { }
            }
        } catch (_) { }

        // ============================================================
        // frame 0：周期起点，承担全部重量级工作
        //
        // 必须放在「处理桶」之前 —— 否则本周期新分好的桶
        // 要等到下个周期才会被处理，单位解算间隔会从 5 tick
        // 变成 10 tick。
        // ============================================================
        if (frameIndex === 0) {
            // 走位指令表回收（兜底清理离开模拟距离、没触发 entityRemove 的条目）
            try {
                gcMoveCmd(nowTick);
            } catch (_) { }

            // 重建受管单位表 + 敌人快照 + 分桶
            try {
                rebuildManagedUnits(dimStates);
            } catch (e) {
                console.error(`[DM-Engine] 单位表重建异常: ${e}`);
            }

            // demon 的敌人表（零查询）
            //
            // 必须在 rebuildManagedUnits 之后：它读 entry.faction。
            // 放这里还有一个好处 —— demon 侧的敌人清单与受管单位表
            // 严格对齐同一周期，不会出现「目标表里有个已经被熔断的单位」。
            try {
                buildPlayerSideIndex(dimStates);
            } catch (e) {
                console.error(`[DM-Engine] 玩家侧索引异常: ${e}`);
            }
        }

        // ============================================================
        // 只解算本帧负责的那一桶
        // ============================================================
        const bucket = FrameBuckets[frameIndex];

        for (let i = 0; i < bucket.length; i++) {
            const entry = bucket[i];
            const unit = entry.unit;

            if (!unit || !unit.isValid) continue;

            // 每周期实际解算了多少单位（计数，不做计时）
            PerfProbe.count("unit.scan");

            const enemySnapshot = SnapshotCache.get(entry.dimKey) ?? null;
            const playerSideList = PlayerSideIndex.get(entry.dimKey) ?? null;

            try {
                DmTargetEngine.processUnit(
                    unit,
                    entry.config,
                    enemySnapshot,
                    entry.faction,
                    playerSideList
                );
            } catch (e) {
                console.error(`[DM-Engine] processUnit 异常 (${unit.id}): ${e}`);
            }
        }

        // ============================================================
        // frame 0 收尾：支援压力配对
        //
        // 必须在本帧 processUnit 之后 —— pressure 是在 processUnit
        // 里更新的。而且它需要全量单位，不能分帧。
        // ============================================================
        if (frameIndex === 0) {
            evaluateSupportForAll(dimStates);
        }

        PerfProbe.lap("engine.update", perfT0);
    }

    static processUnit(unit, config, enemySnapshot, faction, playerSideList) {
        // ============================================================
        // demon 早退
        //
        // 走位依旧遵循 tag：没有战斗 tag 的 demon 完全不接管，
        // 交回原版 AI 的索敌与攻击行为。
        //
        // 现在 JSON 侧 0 个 demon 有 demon_has_target，所以整个 demon
        // 群体每周期的成本 = 一次家族查询 + 一次配置解析 + 这次判断。
        // 等 JSON 侧给某个 demon 加上 tag，它才开始真正跑逻辑。
        //
        // 为什么不给 dm 也加：dm 现有链路是「先选目标、后判 tag」，
        // 脱战瞬间 tag 还没加上但 target 需要已经就绪，改了有回归风险。
        // demon 是新增路径，没有历史包袱。
        // ============================================================
        if (faction === FACTION.DEMON && !isInCombat(unit, faction)) {
            // 清一次残留标记，避免它从「曾经在战斗」切到早退时
            // 留下 PreviousCombatState 条目，导致下次进战不清理速度。
            PreviousCombatState.delete(unit.id);
            return;
        }

        // ============================================================
        // 支援系统
        //
        // 现在从敌人快照里取出压力半径内的敌人，
        // 传给 support，避免 support 自己再次 getEntities。
        // ============================================================
        const pressureRadius = config.pressureRadius ?? 12;

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
        // 获取附近敌人 —— 按阵营选敌人表
        //
        //   DM    → 空间网格快照（monster 家族，每周期每维度重建一次）
        //   DEMON → 内存里的玩家侧清单（干员 + 在线玩家，零查询）
        //
        // 不再执行：
        // unit.dimension.getEntities({
        //     location: unit.location,
        //     maxDistance: currentRange,
        //     families: ["monster"]
        // });
        // ============================================================
        let targets = [];

        if (faction === FACTION.DEMON) {
            targets = queryNearbyFromList(
                playerSideList,
                unit.location,
                currentRange
            );
        } else if (enemySnapshot && !enemySnapshot.empty) {
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
                } catch (e) { }
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
        // tag 由 JSON 层负责增删，JS 只检测。tag 名按阵营分派：
        //   dm    → dm_has_target    / dm_skill_on
        //   demon → demon_has_target / demon_skill_on
        //
        // 没有战斗 tag 的单位不进入 movement，
        // 避免 movement 内部无效读取方块。
        // ============================================================
        const isCombat = isInCombat(unit, faction);

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
                    VictimDamageHistoryMap,
                    faction
                );

                PerfProbe.count("move.melee");

                syncActiveMover(unit);

            } else if (effectiveType === "ranged") {
                MovementRanged.execute(
                    unit,
                    config,
                    closestThreat,
                    closestDistSq,
                    strafeRange,
                    VictimDamageHistoryMap,
                    faction
                );

                PerfProbe.count("move.ranged");

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