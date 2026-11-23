/*
 * shield.js — dm34 的盾牌：装备 / 卸下 / 记录，以及何时举盾。
 * 格挡判定（锥形、cancel、时长、冷却、击退）在 common/tactical/shield_block.js，本文件只管三件事：
 * ① 真盾的装备与记录 —— 引擎的 equip_item_slot(offhand) 搬真件，脚本只抄一份序列化记录
 * dm34:shield，卸盾 / 丢件自愈按记录重建。副手是字符串槽、与整数鞍槽 0 共存，不要为副手删掉
 * 鞍槽（整数与字符串槽混排会让整个 slots 数组被 schema 丢弃）。
 * ② 触发条件 —— 真的在交战才举盾（自己锁定的 target / 挨打记下的威胁 / range 内贴脸），装好盾
 * 默认收着；做饭、耕地、闲置（in1/in2）不持盾。
 * ③ 表现 —— animation.dm34_shield_hold，由 RP 的动画控制器按实体属性切档。
 * 不结算耐久：盾是真件，耐久归玩家自己修。
 */

import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { clearSlot, cmdHasItem, deserializeItem, dropItemNear } from "./slot_io.js";
import { factionOf, enemyFilterOf, isHostile } from "../common/core/camp_faction.js";
import { HURT_PRIORITY, REMOVE_PRIORITY } from "../common/core/event_bus.js";
import { forEachMaid } from "../common/core/maid_registry.js";
import { resolveState } from "./maid_state.js";
import { putInBag } from "./guard.js";
import { registerShieldBlocker } from "../common/tactical/shield_block.js";

const DM34 = "player:dm34";

/*
 * 真盾记录（唯一真相源）：{id, n, name, lore, ench, dmg}。
 * 副手实物由引擎持有、脚本读不到它的附魔与耐久，所以卸盾重建、丢件自愈全靠这份记录
 */
const SHIELD_DP = "dm34:shield";

/*
 * 举盾姿势：RP 三个动画 + 一个控制器，关键帧取自原版 animation.player.shield_block_off_hand，
 * 骨骼名换成 geometry.dm34 的写法（全小写的 leftarm/leftitem 对不上会静默不生效）。leftItem 是
 * leftArm 的子骨骼，父骨骼转到哪盾就跟到哪，所以拉弓 / 托弩时要单独降幅度：
 * · 空手 / 剑 / 锄 → shield_hold：完整幅度 + override_previous_animation；
 * · 弓 / 弩 → shield_hold_bow / _crossbow：只给几度微调，让弓弩自己的抬臂动作主导。
 * 选档由 controller.animation.dm34_shield 按 query.property('dm34:shield_up') + variant 自己切，
 * 脚本只写那个 bool —— AC 同一时刻只有一个 state 生效，不会两条 loop 抢同一根骨骼。
 */
const SHIELD_PROP = "dm34:shield_up";

/* entityId → 上次写进属性的值。只在变化时写：每 5t set 一次等于白送客户端一次同步 */
const poseOf = new Map();

/* 通用格挡模块的句柄（initShield 里创建） */
let blocker;

/*
 * 装盾挂起表：entityId → rec。2 tick 后验证通过才落账（写 DP + tag）。
 * 只存还没验证的那一下，验证完无论成败都删，实体失效的回调直接 return，不会堆积
 */
const pending = new Map();

function debug(msg) {
    if (!CONFIG.log.debug || !CONFIG.log.console) return;
    try { console.warn(`[dm34/shield] ${msg}`); } catch (e) { /* 忽略 */ }
}

/* 玩家可见的失败原因。不归 CONFIG.log 管：只在出错时出现，关掉等于藏原因 */
function tell(msg) {
    try { console.warn(`[dm34/shield] ${msg}`); } catch (e) { /* 忽略 */ }
}

// ── 记录读写 ──

/*
 * 真盾记录（唯一真相源）：副手那件由引擎持有，脚本读不到它的耐久与附魔，
 * 卸盾重建与丢件自愈都以这份记录为准
 */
export function shieldRecord(entity) {
    try {
        const raw = entity.getDynamicProperty(SHIELD_DP);
        if (typeof raw !== "string" || !raw) return undefined;
        const rec = JSON.parse(raw);
        return rec && rec.id ? rec : undefined;
    } catch (e) {
        return undefined;
    }
}

export function hasShield(entity) {
    return !!shieldRecord(entity);
}

/*
 * 与 dm34.json 盾牌条目的 none_of 一一对应：有这枚 tag 就不许再装第二面。
 * 不用 has_equipment(self)：dm34 的 equippable 只声明了鞍槽，hand 槽能否被 filter 看到没有保证；
 * tag 是自己写的，完全可控
 */
const SHIELD_TAG = "dm34:has_shield";

function writeRecord(entity, rec) {
    try {
        entity.setDynamicProperty(SHIELD_DP, rec ? JSON.stringify(rec) : undefined);
        if (rec) entity.addTag(SHIELD_TAG);
        else entity.removeTag(SHIELD_TAG);
    } catch (e) {
        tell(`写 dm34:shield 失败：${e}`);
    }
}

/*
 * 装盾后记账（index.js 的 after 回调调用）：引擎搬完真件、主手已空，只有 ev.beforeItemStack 还留着
 * 那面盾的完整数据。
 * 必须先验证后落账：equip_item_slot 异步落库，同 tick 读副手一定读不到，验证放到 2 tick 后。而 tag
 * dm34:has_shield 是 JSON 条目 none_of 的唯一闸门 —— 先写 tag 再验证的话，引擎没搬进槽时 tag 会
 * 留下，之后每次右键都被挡掉，表现为「提示有盾却看不见盾」。
 * @param {import("@minecraft/server").Player} [player] 用来给一句准确的反馈
 * @returns {boolean} 是否受理（不代表已装上，装上与否看 2 tick 后的验证）
 */
export function recordShield(entity, rec, player) {
    if (!rec || !rec.id) return false;
        // 闲置态不持盾：JSON 那侧已经不给装，这里是 after 回调的兜底闸，
        // 否则闲置态右键也会挂起一条 pending，2t 后报「没接住」
    if (isIdleState(entity)) return false;

    let eid;
    try { eid = entity.id; } catch (e) { return false; }
    pending.set(eid, rec); // 只挂起，不写 DP、不写 tag

    if (blocker) {
        const st = blocker.stateOf(entity);
        st.data.fresh = 20; // 见 onTick：这段时间内不许判丢件
        blocker.lower(entity, "equip");
    }

        // 两 tick 后验一次：equip_item_slot 是引擎侧动作，同 tick 读副手可能还没落地
        // 验不过就什么账都不留，否则她会挂着一面不存在的盾（永久幽灵账）
    try {
        system.runTimeout(() => {
            try {
                if (!entity || !entity.isValid) return;
                if (pending.get(eid) !== rec) return; // 已被后来那一下顶掉
                pending.delete(eid);

                const ok = cmdHasItem(entity, "Offhand", rec.id) || cmdHasItem(entity, "Mainhand", rec.id);
                if (ok) {
                    writeRecord(entity, rec); // 现在才落账 + 上 tag
                    try { player.sendMessage("§7成功装载盾牌！"); } catch (e) { /* 忽略 */ }
                    return;
                }

                if (blocker) blocker.forget(entity);
                                // 引擎没搬 → 盾大概率还在玩家手上，这时再掉一件就是复制
                                // 只有玩家手上确实没有了（搬了却没落进槽）才按记录重建一件还她脚下
                if (!playerHolds(player, rec.id)) {
                    const back = deserializeItem(rec);
                    if (back) { try { dropItemNear(entity, back); } catch (e) { /* 忽略 */ } }
                }
                try { player.sendMessage("§c副手槽没接住这面盾，盾还留在你手上。"); } catch (e) { /* 忽略 */ }
            } catch (e) { /* 忽略 */ }
        }, 2);
    } catch (e) { /* 忽略 */ }
    return true;
}

/*
 * 玩家身上还有没有这件东西（主手 + 副手 + 背包）。
 * 用来区分「引擎压根没搬」与「搬走了但没落进副手」—— 前者不能再掉一件
 */
function playerHolds(player, id) {
    try {
        const eq = player.getComponent("minecraft:equippable");
        if (eq) {
            for (const slot of ["Mainhand", "Offhand"]) {
                const it = eq.getEquipment(slot);
                if (it && it.typeId === id) return true;
            }
        }
    } catch (e) { /* 忽略 */ }
    try {
        const inv = player.getComponent("minecraft:inventory");
        const c = inv && inv.container;
        if (c) {
            for (let i = 0; i < c.size; i++) {
                const it = c.getItem(i);
                if (it && it.typeId === id) return true;
            }
        }
    } catch (e) { /* 忽略 */ }
    return false;
}

/*
 * 手持盾牌右键 → 装盾。真件的搬运不在这里：dm34.json 的盾牌条目带
 * equip_item_slot: slot.weapon.offhand，引擎在交互那一刻把玩家手上那件原样搬进副手，附魔 / 耐久 /
 * 名字都不丢 —— 这是唯一能保真的通路（脚本侧 equippable 对自定义生物不存在，replaceitem 的
 * components 也带不了附魔与耐久）。本函数只管拦截与反馈，记账在 index.js 的 after 回调里。
 * @returns {boolean} 是否已被接管
 */
export function equipShield(player, entity) {
    if (!CONFIG.shield.enabled) return false;
    if (String(entity.typeId) !== DM34) return false;

        // 闲置态不持盾：in1/in2 的 JSON 没有装盾条目，手持盾右键命中拦截条目 →
        // 这里只给一句提示，不记账不搬件。闲置态的盾既不渲染也举不起来，装上就是幽灵
    if (isIdleState(entity)) {
        try { player.sendMessage("§7她现在是待命/闲置状态，不持盾。先给她一把武器再装。"); } catch (e) { /* 忽略 */ }
        return true;
    }

    if (hasShield(entity)) {
                // filter 的 none_of 已经拦过引擎装备，走到这里补一句人话即可
        try { player.sendMessage("§7她已经有一面盾牌了，先取下来再换。"); } catch (e) { /* 忽略 */ }
        return true;
    }

    debug("引擎装盾 → slot.weapon.offhand（记账在 after 回调）");
    return true;
}

/*
 * 卸下盾牌：按记录重建真件 → 清副手槽 → 抹记录 → 真件掉她脚下。
 * 顺序不能反：clearSlot 会销毁槽里实物，重建必须在前，否则记录一删就真丢了。
 * 掉落统一走 slot_io.dropItemNear，不写玩家容器（会留幽灵槽）。
 * @param {boolean} [quiet] 静默模式（回收残留时用）
 * @returns {number} 交出去的件数（0 = 本来没有 / 还原失败没敢动）
 */
export function removeShield(player, entity, quiet) {
    const rec = shieldRecord(entity);
    if (!rec) return 0;

    const item = deserializeItem(rec); // 先造出来，再动槽
    if (!item) {
        tell(`盾牌数据还原失败（${rec.id}），这一件先不动。`);
        return 0;
    }

        // 先清副手；主手只在那一格确实是盾时才补清（早期主手版本留下的残留）
        // clearSlot 会全索引 sweep，补清前必须用 cmdHasItem 校验，否则会扫掉她的武器
    try { clearSlot(entity, "Offhand", rec.id); } catch (e) { /* 忽略 */ }
    try {
        if (cmdHasItem(entity, "Mainhand", rec.id)) clearSlot(entity, "Mainhand", rec.id);
    } catch (e) { /* 忽略 */ }

    writeRecord(entity, undefined);
    if (blocker) {
        blocker.lower(entity, "unequip");
        blocker.forget(entity);
    }

    if (!quiet) {
        try { dropItemNear(entity, item); } catch (e) { /* 忽略 */ }
        debug("卸盾 ← Offhand");
    }
    return 1;
}

/*
 * 幻域球放出来时把盾还进她背包（ball_sync.js 的 apply 末尾调用）。
 * 不直接摆回副手：副手实物只认引擎搬件，脚本 replaceitem 写不进附魔与耐久，摆上去就是一面白板盾，
 * 等于把玩家的真件洗了。所以按记录重建塞进背包，玩家再装一次。
 * 记录必须同时清掉：实物已在背包里，留着 dm34:shield 会让巡检认为盾丢了，又把背包这面复制一份
 * 掉地上 —— 收放一次多一面盾。
 * @returns {number} 交回来的件数
 */
export function restoreShieldToBag(entity) {
    const rec = shieldRecord(entity);
    if (!rec) return 0;

    const item = deserializeItem(rec);
    writeRecord(entity, undefined);
    if (blocker) {
        blocker.lower(entity, "ball");
        blocker.forget(entity);
    }
    if (!item) {
        tell(`盾牌数据还原失败（${rec.id}），这一件先不动。`);
        return 0;
    }

    let inBag = false;
    try { inBag = putInBag(entity, item); } catch (e) { inBag = false; }
    if (inBag) return 1;

    try { dropItemNear(entity, item); } catch (e) { /* 忽略 */ }
    return 1;
}

/*
 * 闲置态不持盾：把副手那面真盾收进她的背包（满则掉脚下）。
 * 顺序同 removeShield：先重建 → 再清槽 → 再抹记录，反了这面盾就没了。
 * 收进背包而不是丢地上：切个状态就掉一地东西太离谱，背包满才退化成掉落。
 * @returns {number} 收起来的件数
 */
export function stowShield(entity) {
    const rec = shieldRecord(entity);
    if (!rec) return 0;

    const item = deserializeItem(rec);
    if (!item) {
        tell(`盾牌数据还原失败（${rec.id}），这一件先不动。`);
        return 0;
    }

    try { clearSlot(entity, "Offhand", rec.id); } catch (e) { /* 忽略 */ }
    try {
        if (cmdHasItem(entity, "Mainhand", rec.id)) clearSlot(entity, "Mainhand", rec.id);
    } catch (e) { /* 忽略 */ }

    writeRecord(entity, undefined);
    if (blocker) {
        blocker.lower(entity, "stow");
        blocker.forget(entity);
    }

    let inBag = false;
    try { inBag = putInBag(entity, item); } catch (e) { inBag = false; }
    if (!inBag) { try { dropItemNear(entity, item); } catch (e) { /* 忽略 */ } }
    return 1;
}

// ── 表现 ──

/*
 * 把举盾开关写给 RP：dm34:shield_up 是实体属性（client_sync: true），
 * controller.animation.dm34_shield 按它 + query.variant 自己选档（2 弓 / 3 弩 / 其余完整幅度）。
 * 不在脚本里播动画：命令播的动画会叠加进混合栈，换武器还得手动停旧的；
 * AC 切档由引擎做，不会双播。只在值变化时写，每 5t 都 set 等于白送同步。
 * @param {boolean} [onOverride] 举盾开关；不传则读通用模块的状态
 */
function applyPose(entity, onOverride) {
    const st = blocker ? blocker.stateOf(entity) : undefined;
    const on = onOverride === undefined ? !!(st && st.on) : !!onOverride;

    let id;
    try { id = entity.id; } catch (e) { return; }
    if (poseOf.get(id) === on) return;

    try {
        entity.setProperty(SHIELD_PROP, on);
        poseOf.set(id, on);
    } catch (e) {
        debug(`setProperty(${SHIELD_PROP}) 失败：${e}`);
    }
}

/*
 * 举盾减速：压 `minecraft:movement.currentValue`，放下时还原。
 * 基准取 `defaultValue` 而不是写死 0.31：dm34 的 movement 写在组件组里（default 0.31 / sit 与 cook
 * 都是 1e-19）。写死基准的话，坐着卸盾会把速度还成 0.31 —— 坐着走路；读 defaultValue 则组件组
 * 切到哪就还到哪。
 * 幂等：同一状态重复调用是空操作，所以 onTick 每轮都能重刷一次 —— 坐下 / 做饭切组件组时引擎会把
 * 值重置回该组的值，靠这次重刷把减速补回来。
 */
function applySlow(entity, on) {
    try {
        const mc = entity.getComponent("minecraft:movement");
        if (!mc) return;
        const base = mc.defaultValue > 0 ? mc.defaultValue : 0.31;
        const want = on ? base * CONFIG.shield.slowFactor : base;
        if (Math.abs(mc.currentValue - want) < 1e-6) return;
        mc.setCurrentValue(want);
    } catch (e) {
        // 玩家类实体没有写权限；dm34 正常不会走到这里
    }
}

// ── 触发条件（dm34 自己的事） ────────────────────────────────

/** 她的状态键能不能举盾：做饭、耕地时不抬盾（手上/动画都不对） */
function canHoldShield(entity) {
    try {
        const st = resolveState(entity);
        if (!st) return true;
        if (st.key === "cook_a" || st.key === "cook_b") return false;
        if (st.key === "farm") return false;
        return true;
    } catch (e) {
        return true;
    }
}

/** 闲置（徒手）状态：in1 站立 / in2 坐着 —— 不持盾。
 *
 *  这两种状态既不能装盾，也不保留已装的盾（巡检收进背包），更不举盾格挡：
 *  闲置态的盾既不在举盾姿态里、也不会渲染到左臂，留着只是"看不见但存在"的幽灵。
 *  想让她持盾 → 先给一把武器进战斗形态。 */
function isIdleState(entity) {
    try {
        const st = resolveState(entity);
        if (!st) return false;
        // 采集态（dm_mine / dm_chop）与待命同等对待：手上是镐斧，盾必然收进背包。
        return st.key === "in1" || st.key === "in2" || st.key === "dm_mine" || st.key === "dm_chop";
    } catch (e) {
        return false;
    }
}

/** 全维度敌人名单缓存（只在 range <= 0 的「不限距离」模式用）。
 *  一次 getEntities 供所有女仆共用，否则 N 只女仆每 5 tick 各扫一遍整个维度。
 *  TTL 10t（两轮巡检）；只缓存实体引用，命中时仍逐个 isValid。
 *  键带家族名：以后别的阵营来查也不会互相顶掉缓存。 */
const foeCache = new Map();
const FOE_CACHE_TTL = 10;

function foeList(dimension, filter) {
    const now = system.currentTick;
    const key = `${dimension.id}|${filter.families ? filter.families.join(",") : ""}`;
    const c = foeCache.get(key);
    if (c && now - c.tick < FOE_CACHE_TTL) return c.list;

    let list = [];
    try { list = dimension.getEntities(filter); } catch (e) { list = []; }
    foeCache.set(key, { tick: now, list });
    return list;
}

/** 最近的敌对目标（没有返回 undefined）。
 *  range > 0 走带半径的原生查询（常态）；range <= 0 走全维度缓存。
 *  **别把 range 配成 0**：那是"本维度有怪就举"的老行为，会让她一路举盾慢走。 */
function nearestFoe(entity) {
    let faction;
    let filter;
    try {
        faction = factionOf(entity);
        filter = enemyFilterOf(faction);
    } catch (e) {
        return undefined;
    }
    if (!filter) return undefined;

    const range = CONFIG.shield.range;
    let list;
    try {
        list = range > 0
            ? entity.dimension.getEntities(Object.assign({ location: entity.location, maxDistance: range }, filter))
            : foeList(entity.dimension, filter);
    } catch (e) {
        return undefined;
    }
    if (!list || !list.length) return undefined;

    // 名单本身就是「该阵营的敌人集合」（camp_faction 里同一个 filter），
    // 所以不用再逐个 isHostile（那等于把 matches 重跑一遍）。
    let best;
    let bestSq = Infinity;
    const p = entity.location;
    for (const e of list) {
        if (!e || !e.isValid || e.id === entity.id) continue;
        let l;
        try { l = e.location; } catch (err) { continue; }
        const dsq = (l.x - p.x) ** 2 + (l.y - p.y) ** 2 + (l.z - p.z) ** 2;
        if (dsq < bestSq) {
            bestSq = dsq;
            best = e;
        }
    }
    return best;
}

/*
 * 贴脸探测的轮次计数：entityId → 已空跑的轮数。
 * 装盾不打架是常态，恰好每轮都要走第三档，不节流就是每只女仆每 5 tick 一次 getEntities。
 * 用轮次而不是绝对 tick：重进世界后 currentTick 归零，绝对 tick 会算出负数导致永不查询。
 * 每 probeRounds 轮探一次，间隔内挨打会由威胁记忆立刻接上，不会漏挡。
 */
const foeProbe = new Map();

function probeFoe(entity) {
    let id;
    try { id = entity.id; } catch (e) { return undefined; }
    const rounds = CONFIG.shield.probeRounds > 0 ? CONFIG.shield.probeRounds : 1;
    const n = ((foeProbe.get(id) || 0) + 1) % rounds;
    foeProbe.set(id, n);
    if (foeProbe.size > 64) foeProbe.clear(); // 实体卸载后 id 会变，别让它无限长
    if (n !== 0) return undefined;
    return nearestFoe(entity);
}

/* 两实体距离的平方（读不到位置按无穷远处理） */
function distSq(a, b) {
    try {
        const p = a.location;
        const q = b.location;
        return (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
    } catch (e) {
        return Infinity;
    }
}

/*
 * 她真的在交战吗 —— 举盾的唯一判据，三档从严到宽：
 * ① 索敌给她设的 entity.target；② 受击记下的威胁 dm:threat_target_id（6 秒有效）；
 * ③ range 格内的敌对目标（贴脸、还没锁定也得挡）。
 * 三档都没有 = 没在打架 = 不举盾。举盾要乘 slowFactor，全维度扫描会让她一路举盾慢走。
 */
function engagedFoe(entity) {
        // ① 她锁定的目标。超出 lockRange 不算：nearest_attackable_target 的 max_dist 是 24，
        // 照单全收会变成「24 格外刚看见怪就举盾慢走」
    try {
        const t = entity.target;
        if (t && t.isValid && isHostile(entity, t) && distSq(entity, t) <= CONFIG.shield.lockRange ** 2) {
            return t;
        }
    } catch (e) { /* target 读不到就当没锁定 */ }

        // ② 挨打记下的威胁。tick 是绝对 tick：负数说明是上一局残留（重进世界后归零），丢
    try {
        const tid = entity.getDynamicProperty("dm:threat_target_id");
        const ttick = entity.getDynamicProperty("dm:threat_target_tick") ?? 0;
        const age = system.currentTick - ttick;
        if (typeof tid === "string" && tid && age >= 0 && age < 120) {
            const t = world.getEntity(tid);
            if (t && t.isValid && isHostile(entity, t)) return t;
        }
    } catch (e) { /* 忽略 */ }

        // ③ 贴脸兜底（节流：每 probeRounds 轮探一次，见 probeFoe）
    return probeFoe(entity);
}

/*
 * 脱战宽限 —— 完全交给 manager，JS 不记账、不轮询、不存时间戳。
 *
 * 引擎侧的完整链条在 attackable_target_manager.js 的 TargetSensorManager（EVENT_ACQUIRED = "attack"、
 * EVENT_LOST = "silent"）：每帧对已注册干员检查 entity.target ——
 *   ① 锁定目标 / 换人        → triggerEvent("attack")
 *   ② 目标没了（走远、被清）  → triggerEvent("silent")
 *   ③ 目标实体被移除（死亡）  → entityRemove 钩子 _notifyTargetRemoved 补发 "silent"
 * 前置是实体属性 dm:target_sensor === "on"（dm34 / dm34_1 默认就是 on），否则它整段不工作。
 *
 * dm34.json / dm34_1.json 里接的是与 dm0 同构的两级衰减：
 *   attack           → 摘 attack_reset / shield_grace，`tag @s add dm_shield_hold`（+ dm_has_target）
 *   silent           → 挂 attack_reset（1.5s 循环 timer，去抖，只走一次就自摘）
 *   attack_reset     → 摘 attack_reset、挂 shield_grace、摘 dm_has_target
 *   shield_grace     → 12s 一次性 timer
 *   shield_grace_end → 摘 shield_grace、`tag @s remove dm_shield_hold`
 *
 * 所以「12 秒」写在 JSON 的 shield_grace 组（minecraft:timer.time），改时长动 JSON，不动这里。
 * JS 只认一个 tag：零状态、零 Map、零额外 getEntities，也不碰任何 movement 组。
 * 注意超时是 1.5s 去抖 + 12s 计时 = 最后一次看见敌人后约 13.5s 放盾。
 */
const GRACE_TAG = "dm_shield_hold";

function hasGrace(entity) {
    try { return entity.hasTag(GRACE_TAG); } catch (e) { return false; }
}

/* 战斗姿态：索敌到 / 挨过打 / 贴脸才举盾（见 engagedFoe）。闲置态直接不举 —— 那时她连盾都不该有 */
function shouldBlock(entity) {
    if (isIdleState(entity)) return false;
    if (!canHoldShield(entity)) return false;
    if (engagedFoe(entity)) return true;
        // 敌人没了但 manager 的 12 秒宽限还没走完 → 继续举着（姿势与慢速一起保留）
    return hasGrace(entity);
}

/*
 * 巡检前杂务：判「记录还在、手上那面盾却没了」→ 作废记录 + 真盾还地。
 * 脚本无法把真件写回引擎槽（SAPI equippable 对生物恒不存在），所以不补摆，
 * 只能作废记录并把真盾还到她脚下，否则就是一条永远兑现不了的账。
 * @returns {boolean} false = 盾已经不算数了，让通用模块立刻收盾
 */
function onTick(entity) {
        // 组件组切换（坐下 / 做饭）会把 movement 重置回该组的值 → 每轮补刷，幂等
    applySlow(entity, !!(blocker && blocker.isBlocking(entity)));

        // 举盾中切武器（剑→弓 / 弓→弩）要换动画；区块重载丢动画也靠这里补
    applyPose(entity);

    const st = blocker ? blocker.stateOf(entity) : undefined;

        // 闲置态不持盾：从战斗态切回闲置、或坐下待命时，把副手那面盾收进背包
        // 必须排在丢件自愈之前 —— 收完记录就空了，后面全是空转
        // 收盾就不留宽限 tag，免得回战斗态又凭旧 tag 虚举一下。
        // 组件组摘不了（SAPI 没有 removeComponentGroup），由 shield_grace 的 12s timer 自己到期。
    if (isIdleState(entity)) {
        const n = stowShield(entity);
        if (n) tell("待命/闲置状态不持盾，盾牌已收进背包。");
        try { entity.removeTag(GRACE_TAG); } catch (e) { /* 忽略 */ }
        return false; // 交给通用模块立刻收盾
    }

        // 刚装上的 20 tick 内不判丢件：equip_item_slot 落库与巡检是两条独立时序，
        // 抢在中间会误判成「盾不在手上」→ 凭空多掉一面盾。首次校验交给 recordShield
    if (st && st.data.fresh > 0) {
        st.data.fresh = Math.max(0, st.data.fresh - CONFIG.shield.pollTicks);
        return true;
    }

    const rec = shieldRecord(entity);
    if (!rec) return false;

    let onArm = true;
    try {
        onArm = cmdHasItem(entity, "Offhand", rec.id) || cmdHasItem(entity, "Mainhand", rec.id);
    } catch (e) {
        onArm = true; // 探测失败按「还在」处理，宁可晚一轮也别误删
    }
    if (onArm) return true;

        // 实物确实不在了：把记录还原成真件，先塞背包，塞不进才掉脚下
        // 不这样做的话，记录一删这面盾就永久消失（附魔 / 耐久无处可寻）
    restoreShieldToBag(entity);
    tell("她手上的盾牌不见了，已按记录还原（先进背包，满则掉在脚下）。");
    return false; // 收盾交给通用模块
}

// ── 初始化 ──

export function initShield() {
    if (blocker) return;

    if (!CONFIG.shield.enabled) return;

    blocker = registerShieldBlocker({
        id: "dm34_shield",
        accepts: (entity) => String(entity.typeId) === DM34,
        forEachEntity: (fn) => forEachMaid(fn),
        hasShield: (entity) => !!shieldRecord(entity),
        shouldBlock: (entity) => shouldBlock(entity),
        setPose: (entity, on) => {
            applyPose(entity, on);
            applySlow(entity, on); // 立刻生效，别等下一轮巡检
        },
        isHostile: (self, attacker) => isHostile(self, attacker),
        onTick: (entity) => onTick(entity),
        pollTicks: CONFIG.shield.pollTicks,
        yawDeg: CONFIG.shield.yawDeg,
        pitchDeg: CONFIG.shield.pitchDeg,
        holdTicks: CONFIG.shield.holdTicks,
                /* 统一 2.5s 窗口（闲置态已经不持盾，不再有「永不放下」那一档） */
        holdTicksOf: () => CONFIG.shield.holdTicks,
        cooldownTicks: CONFIG.shield.cooldownTicks,
        knockbackHorizontal: CONFIG.shield.knockbackHorizontal,
        knockbackVertical: CONFIG.shield.knockbackVertical,
        knockbackProjectiles: CONFIG.shield.knockbackProjectiles,
        deflectProjectiles: CONFIG.shield.deflectProjectiles,
        ambientCauses: CONFIG.shield.ambientCauses,
        hurtPriority: HURT_PRIORITY.SHIELD_BLOCK,
        removePriority: REMOVE_PRIORITY.SHIELD_CACHE,
        debug: (msg) => debug(msg),
    });

    debug("已初始化");
}
