/**
 * crossbow_aim.js — 弩形态举弩/放下（实体属性 `dm34:aim` 驱动 RP 控制器）+ 多重射击补箭。
 *
 * 目标判定只读 attackable_target_manager 的目标传感器（已过 isValid）；
 * 不自己读 entity.target —— 目标死亡后它可能留一个失效句柄，会让女仆一直举着弩。
 * 形态自己判（variant == 3）：弓 / 剑形态同样有目标，不该进举弩与射箭那条链。
 *
 * 动作：弩形态有目标 → 举；射出（见箭生成）→ 放下 DOWN_TICKS；失去目标满 6 秒 → 放下。
 * 多重射击：基岩版生物手持的弩不出这个效果，箭生成时按附魔等级补 2 支（水平各偏 10°）。
 */

import { system } from "@minecraft/server";
import { forEachMaid } from "../../common/core/maid_registry.js";
import { variantOf } from "../core/maid_state.js";
import { hasTrackedTarget } from "../../common/tactical/attackable_target_manager.js";
import { registerEntitySpawnHandler, SPAWN_PRIORITY } from "../../common/core/event_bus.js";
import { storedWeapon } from "../inventory/weapon_store.js";

const AIM_PROP = "dm34:aim";

/** 弩形态的 variant 值（与 RP 控制器的 query.variant == 3 同一个口径） */
const CROSSBOW_VARIANT = 3;

/** 射出后保持放下的 tick 数；配合 5 tick 轮询，实际可见 0.25~0.5s */
const DOWN_TICKS = 6;

/** 失去目标后继续举着的 tick 数（≈6s）：脱战瞬间不抖，怪死了才放下 */
const HOLD_AFTER_LOSS_TICKS = 120;

/**
 * 轮询间隔：与目标传感器的更新节拍（每单位 5 tick 解算一次）对齐，
 * 更快只会重复读同一个值。放下窗口因此是 5~10 tick（0.25~0.5s）。
 */
const POLL_TICKS = 5;

/** 只有 dm34 有弩；dm34_1 与其他干员不参与 */
const AIM_TYPES = new Set(["player:dm34"]);

/** 附魔 id 在记录里可能带命名空间也可能不带 */
const MULTISHOT_IDS = new Set(["multishot", "minecraft:multishot"]);

/** 多级时的上限：基岩版只有 I 级，Java 规则每级 +2 支 / +10° */
const MULTISHOT_MAX_LEVEL = 2;

/** 每级两侧各偏的度数（原版：三支箭水平成 ±10°） */
const MULTISHOT_ANGLE = 10;

/** 原箭速度读不到时的兜底初速（blocks/tick，接近弩的正常出膛速度） */
const FALLBACK_SPEED = 3.0;

/**
 * 补箭闸门：补出来的箭同样带 owner，会再次回到 onSpawn。
 * 一次射击只补一轮；弩的 attack_interval 是 0.6~0.7s（12~14 tick），10 tick 内不可能有第二发。
 */
const MULTISHOT_GATE_TICKS = 10;

/** maidId → 上次补箭的 tick */
const MultishotAt = new Map();

/** maidId → 放下到哪个 tick（射出后） */
const DownUntil = new Map();
/** maidId → 最后一次确认有目标的 tick */
const LastSeen = new Map();

/**
 * 当前「弩形态且交战中」的女仆 id（每轮轮询重建）。
 * 箭生成是全局事件 —— 骷髅等原版怪也在射、箭还很多 —— 这张表非空才去碰事件对象和组件。
 * 弓形态的女仆有目标也不进这张表，她们的箭不会被当成弩箭。
 */
const ArmedIds = new Set();

/** 本轮在册的 dm34（复用同一个 Set，避免每轮分配） */
const LiveIds = new Set();

/** 弩上的多重射击等级。主手是替身，附魔只存在 `dm34:weapon` 记录里 */
function multishotLevelOf(maid) {
    let w;
    try { w = storedWeapon(maid); } catch (e) { return 0; }
    if (!w || w.id !== "minecraft:crossbow") return 0;
    if (!Array.isArray(w.ench)) return 0;
    for (const pair of w.ench) {
        if (!Array.isArray(pair) || !MULTISHOT_IDS.has(pair[0])) continue;
        const lvl = pair[1];
        return typeof lvl === "number" && lvl > 0 ? lvl : 1;
    }
    return 0;
}

/** 绕 Y 轴水平旋转（原版多重射击只在水平面散开） */
function yawRotate(v, deg) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}

/** 原箭的飞行速度；读不到（刚生成还没拿到引擎速度）就按女仆视线自己造一个 */
function shotVector(maid, arrow) {
    let v;
    try { v = arrow.getVelocity(); } catch (e) { v = undefined; }
    if (v && Math.hypot(v.x, v.y, v.z) > 0.5) return v;
    try { v = maid.getViewDirection(); } catch (e) { v = undefined; }
    if (!v || (!v.x && !v.y && !v.z)) return undefined;
    return { x: v.x * FALLBACK_SPEED, y: v.y * FALLBACK_SPEED, z: v.z * FALLBACK_SPEED };
}

/** 按附魔等级两侧各补 level 支箭 */
function spawnMultishot(maid, arrow) {
    const level = Math.min(multishotLevelOf(maid), MULTISHOT_MAX_LEVEL);
    if (level <= 0) return;

    const tick = system.currentTick;
    const last = MultishotAt.get(maid.id);
    if (typeof last === "number" && tick - last < MULTISHOT_GATE_TICKS) return;
    MultishotAt.set(maid.id, tick);

    const v = shotVector(maid, arrow);
    if (!v) return;

    let loc;
    try { loc = arrow.location; } catch (e) { return; }
    let dim;
    try { dim = arrow.dimension; } catch (e) { return; }

    for (let lv = 1; lv <= level; lv++) {
        for (const sign of [-1, 1]) {
            const dir = yawRotate(v, sign * MULTISHOT_ANGLE * lv);
            let extra;
            // spawnEntity 失败时可能返回 undefined 而不抛错
            try { extra = dim.spawnEntity("minecraft:arrow", loc); } catch (e) { continue; }
            if (!extra) continue;
            try {
                const pc = extra.getComponent("minecraft:projectile");
                if (!pc) { extra.remove(); continue; }
                pc.owner = maid;                    // 伤害归属女仆
                pc.shoot(dir, { uncertainty: 0 });
            } catch (e) {
                // 飞不起来就撤掉，别留一支死箭插在原地
                try { extra.remove(); } catch (e2) { /* 忽略 */ }
            }
        }
    }
}

/** 箭生成：只在有弩女仆交战时才认，且必须是这张表里的射手 */
function onSpawn(ev) {
    if (ArmedIds.size === 0) return;

    let arrow;
    try { arrow = ev.entity; } catch (e) { return; }
    if (!arrow || arrow.typeId !== "minecraft:arrow") return;

    let owner;
    try { owner = arrow.getComponent("minecraft:projectile")?.owner; } catch (e) { return; }
    if (!owner || !ArmedIds.has(owner.id)) return;

    DownUntil.set(owner.id, system.currentTick + DOWN_TICKS);

    try { spawnMultishot(owner, arrow); } catch (e) { /* 补箭失败不影响放下 */ }
}

function tickAim() {
    const tick = system.currentTick;
    ArmedIds.clear();
    LiveIds.clear();

    forEachMaid((maid) => {
        if (!AIM_TYPES.has(maid.typeId)) return;

        const id = maid.id;
        LiveIds.add(id);

        const hasTarget = hasTrackedTarget(id);
        if (hasTarget) LastSeen.set(id, tick);

        const seen = LastSeen.get(id);
        const downActive = tick < (DownUntil.get(id) || 0);
        // 脱战宽限：怪刚死、目标刚丢时继续举着，满 6 秒才放
        const graceActive = !hasTarget && seen !== undefined && tick - seen <= HOLD_AFTER_LOSS_TICKS;

        let aim;
        if (downActive) {
            aim = false;
            // 射出后目标已不在（多半是这一箭打死了）：宽限到此为止，
            // 否则放下 0.3s 后会再举起来，看起来像多举了一次
            if (!hasTarget) LastSeen.delete(id);
        } else if (hasTarget || graceActive) {
            // 有目标才读 variant：平时（没目标、没宽限）不必多一次 getComponent
            if (variantOf(maid) === CROSSBOW_VARIANT) {
                aim = true;
                if (hasTarget) ArmedIds.add(id);
            } else {
                aim = false;
                LastSeen.delete(id);
                DownUntil.delete(id);
            }
        } else {
            aim = false;
            if (seen !== undefined) LastSeen.delete(id);
        }

        try {
            if (maid.getProperty(AIM_PROP) !== aim) maid.setProperty(AIM_PROP, aim);
        } catch (e) {
            // 实体已卸载 / 属性未声明：不写，动画停在放下，不影响玩法
        }
    });

    // 收球 / 死亡 / 卸载：清掉不在册的残留，避免下次放出时带着旧计时
    for (const id of LastSeen.keys()) if (!LiveIds.has(id)) LastSeen.delete(id);
    for (const id of DownUntil.keys()) if (!LiveIds.has(id)) DownUntil.delete(id);
    for (const id of MultishotAt.keys()) if (!LiveIds.has(id)) MultishotAt.delete(id);
}

let inited = false;

export function initCrossbowAim() {
    if (inited) return;
    inited = true;

    registerEntitySpawnHandler("dm34.crossbowAim", onSpawn, SPAWN_PRIORITY.CROSSBOW_AIM);

    system.runInterval(() => {
        try { tickAim(); } catch (e) { /* 单轮异常不拆定时器 */ }
    }, POLL_TICKS);
}
