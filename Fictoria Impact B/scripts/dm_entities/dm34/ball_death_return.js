/**
 * ball_death_return.js — 干员死亡 → 回成一颗满球，塞进主人背包，满了掉在脚下。
 * 收背包（`fictoria:bag_data`，与活着收回同源，不经 isMaid，60 只通用）与装备记录
 * （`dm34:equip`，仅 dm34 / dm34_1 有内容）。
 * 载体：同色空球（预约格子）→ 当场造一颗 → 掉在脚下。
 * 地面清理按配额删（配额 = 球里实收数量）。
 * 事件登记在 event_bus：beforeHurt / afterHurt / entityDie；BALL_DEATH(100) 先于 DEATH_DROP(200)。
 */

import { system, world } from "@minecraft/server";

import { CONFIG } from "./config.js";
import { snapshotEquipRecords, writeEquipPayload, BALL_EQUIP_DP } from "./ball_sync.js";
import { deserializeItem, dropItemNear } from "./slot_io.js";
import {
    ballInfoFor,
    buildFilledBallFor,
    readInventory,
    readInventoryReadOnly,
    spillBag,
} from "../common/fictoria_logic/fictoria_ball.js";
import {
    AFTER_HURT_PRIORITY,
    DEATH_PRIORITY,
    HURT_PRIORITY,
    registerAfterHurtHandler,
    registerBeforeHurtHandler,
    registerEntityDieHandler,
} from "../common/core/event_bus.js";
import { markBallHandled } from "./death_drop.js";

/** 与 `fictoria_ball.js` 里的私有常量 `BAG_DP_KEY` 同值；这里单独声明只为回读校验。 */
const BAG_DP = "fictoria:bag_data";

/** 地面清理阶梯（相对死亡的 tick）。引擎抛物品可能晚一两 tick，所以多扫几遍（幂等）。 */
const SWEEP_STEPS = [2, 4, 8, 20, 40];

/** 清理半径：只收她脚下这一小圈，别碰别人的掉落。 */
const SWEEP_RADIUS = 3;

/** 玩家容器的第一个可用格。0 号在 `container_type: horse` 下是马鞍槽，
 *  球进去玩家看不到（背包 UI 从 1 起显示），也拿不出来。 */
const BAG_FIRST = 1;

/** 同 tick 可能多只一起死，空球一格一颗，不预约会挑中同一格，后写覆盖前一只。
 *  新造球不用预约：`system.run` 回调顺序执行，后一只扫描时已能看见占用。 */
const reservedSlots = new Set();

/** 死亡前背包预快照：entityId -> bagData。
 *  引擎在死亡时先把 inventory 抛到地上并清空，`entityDie` 读到的已是空容器，
 *  因此在 `beforeEvents.entityHurt`（血量未扣）预判致命伤并纯读一份。
 *  restricted execution 下只能用 `readInventoryReadOnly`。
 */
const pendingBag = new Map();

/** 预快照存活时长（tick）。30 秒足够死亡流程走完；超时自动作废，防止误判留垃圾。 */
const PENDING_TTL = 600;

/** 抢一份背包预快照（幂等：同一只只存第一次）。
 *  @param {import("@minecraft/server").Entity} entity
 *  @param {string} why */
function takeBagSnapshot(entity, why) {
    let id;
    try { id = entity.id; } catch (e) { return; }

    if (pendingBag.has(id)) return;

    let typeId;
    try { typeId = entity.typeId; } catch (e) { return; }

    // 只关心球名单里的干员（其余 0 成本放过）
    if (ballInfoFor(typeId) === undefined) return;

    let bagData;
    try {
        bagData = readInventoryReadOnly(entity);
    } catch (e) {
        return;
    }

    if (bagData === undefined) return;

    let n = 0;
    if (Array.isArray(bagData.slots)) {
        for (const s of bagData.slots) if (s) n++;
    }

    pendingBag.set(id, bagData);

    if (n > 0) log(`${typeId} 背包预快照 ${n} 件（${why}）`);

    try {
        system.runTimeout(() => {
            if (pendingBag.delete(id)) log(`${typeId} 预快照超时作废`);
        }, PENDING_TTL);
    } catch (e) { /* 忽略 */ }
}

let inited = false;

function log(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/ball-death] ${msg}`); } catch (e) { /* 忽略 */ }
}

/** 主人 id：先认球系统的 `ownerId`，再回落引擎的 tameable。
 *  @param {import("@minecraft/server").Entity} entity */
function ownerOf(entity) {
    try {
        const dp = entity.getDynamicProperty("ownerId");
        if (typeof dp === "string" && dp !== "") return dp;
    } catch (e) { /* 忽略 */ }

    try {
        const t = entity.getComponent("minecraft:tameable");
        if (t && typeof t.tamedToPlayerId === "string" && t.tamedToPlayerId !== "") {
            return t.tamedToPlayerId;
        }
    } catch (e) { /* 忽略 */ }

    return undefined;
}

/** 玩家背包里第一颗这种颜色的空球。从 1 起扫：0 号是马鞍槽，写进去玩家看不到也拿不出。
 *  @param {boolean} [skipReserved] 跳过已被其它死亡预约掉的格子
 *  @returns {{container: any, slot: number} | undefined} */
function findEmptyBall(player, emptyId, skipReserved) {
    let inv;
    try { inv = player.getComponent("minecraft:inventory")?.container; } catch (e) { inv = undefined; }
    if (!inv) return undefined;

    let size = 0;
    try { size = inv.size || 0; } catch (e) { size = 0; }

    let pid = "";
    try { pid = player.id; } catch (e) { pid = ""; }

    for (let i = BAG_FIRST; i < size; i++) {
        let it;
        try { it = inv.getItem(i); } catch (e) { it = undefined; }
        if (!it || it.typeId !== emptyId) continue;
        if (skipReserved && reservedSlots.has(pid + "#" + i)) continue;
        return { container: inv, slot: i };
    }

    return undefined;
}

/** 玩家背包里第一格真空位，同样从 1 起扫（0 号是马鞍槽）。
 *  @returns {{container: any, slot: number} | undefined} */
function findEmptySlot(player) {
    let inv;
    try { inv = player.getComponent("minecraft:inventory")?.container; } catch (e) { inv = undefined; }
    if (!inv) return undefined;

    let size = 0;
    try { size = inv.size || 0; } catch (e) { size = 0; }

    let pid = "";
    try { pid = player.id; } catch (e) { pid = ""; }

    for (let i = BAG_FIRST; i < size; i++) {
        if (reservedSlots.has(pid + "#" + i)) continue;
        let it;
        try { it = inv.getItem(i); } catch (e) { it = undefined; }
        if (!it) return { container: inv, slot: i };
    }

    return undefined;
}

/** 写进球后从容器回读一次。冷却→就绪的热交换在同一 tick 内可能把 cooling 换成 ready，
 *  两者都算成功。 */
function readBack(container, slot, info) {
    let back;
    try { back = container.getItem(slot); } catch (e) { back = undefined; }
    if (!back) return false;
    return back.typeId === info.filledCooling || back.typeId === info.filledReady;
}

/** 用玩家背包里现有的空球：优先预约的那一格，其次另一颗没被预约的空球。
 *  都没有就丢在脚上（不覆盖任何东西）。 */
function handOverBall(owner, ball, info, reservedSlot) {
    const pick = () => {
        if (reservedSlot !== undefined) {
            let inv, it;
            try { inv = owner.getComponent("minecraft:inventory")?.container; } catch (e) { inv = undefined; }
            if (inv) {
                try { it = inv.getItem(reservedSlot); } catch (e) { it = undefined; }
                if (it && it.typeId === info.emptyId) return { container: inv, slot: reservedSlot };
            }
        }
        return findEmptyBall(owner, info.emptyId, true);
    };

    const target = pick();

    if (target !== undefined) {
        try {
            target.container.setItem(target.slot, ball);
        } catch (e) {
            log(`写背包失败：${e}`);
            return { ok: false, dropped: false };
        }

        if (readBack(target.container, target.slot, info)) {
            return { ok: true, slot: target.slot, dropped: false };
        }
        log(`回读校验失败，物品可能没落格`);
        return { ok: false, dropped: false };
    }

    return dropBall(owner, ball);
}

/** 现造的球：优先塞任意空格，没有空格就丢在脚下。
 *  绝不覆盖已有物品 —— 这里只认"什么都没有"的格子。 */
function handOverFreshBall(owner, ball, info) {
    const target = findEmptySlot(owner);

    if (target !== undefined) {
        try {
            target.container.setItem(target.slot, ball);
        } catch (e) {
            log(`新球写背包失败：${e}`);
        }

        if (readBack(target.container, target.slot, info)) {
            return { ok: true, slot: target.slot, dropped: false };
        }

        // 写坏了就把这颗清掉，别在玩家背包里留一颗来路不明的球
        try { target.container.setItem(target.slot, undefined); } catch (e) { /* 忽略 */ }
        log(`新球回读不一致，改走落地`);
    }

    return dropBall(owner, ball);
}

/** 在玩家附近找回刚掉出去的那颗球（`dropItemNear` 不返回实体）。
 *  只认 2.5 格内、typeId 对得上的物品实体，取最近的一颗。 */
function findDroppedBall(owner, typeId) {
    let list;
    try {
        list = owner.dimension.getEntities({
            location: owner.location,
            maxDistance: 2.5,
            type: "minecraft:item",
        });
    } catch (e) {
        return undefined;
    }

    let base;
    try { base = owner.location; } catch (e) { return undefined; }

    let best, bestD = Infinity;
    for (const e of list) {
        let st;
        try { st = e.getComponent("minecraft:item")?.itemStack; } catch (err) { continue; }
        if (!st || st.typeId !== typeId) continue;

        let loc;
        try { loc = e.location; } catch (err) { continue; }
        const d = Math.hypot(loc.x - base.x, loc.y - base.y, loc.z - base.z);
        if (d < bestD) { bestD = d; best = e; }
    }

    return best;
}

/** 载体③：背包满时球掉在主人脚下。
 *  用 `dropItemNear`（会避让玩家身体并播放落地音）；`spawnItem(owner.location)` 落在身体中心，
 *  会被挤出或卡进方块。 */
function dropBall(owner, ball) {
    if (!dropItemNear(owner, ball)) {
        log("背包无空格且落地失败（dropItemNear 返回 false）");
        return { ok: false, dropped: false, entity: undefined };
    }

    // 落是落出来了，但得拿到实体才能验它带没带存档；拿不到就交给上层保守处理
    return { ok: false, dropped: true, entity: findDroppedBall(owner, ball.typeId) };
}

/** 配额：球里实际收进去的数量，按 typeId 累加（背包按 `n`，装备按件）。
 *  只统计写成功的部分 —— 写失败的那部分已经掉回死亡点，计入会把它删掉。 */
function fillQuota(quota, bagData, typeIds) {
    if (bagData && Array.isArray(bagData.slots)) {
        for (const s of bagData.slots) {
            if (!s || typeof s.i !== "string" || s.i === "") continue;
            const n = Number.isFinite(s.n) && s.n > 0 ? s.n : 1;
            quota.set(s.i, (quota.get(s.i) || 0) + n);
        }
    }

    for (const id of typeIds || []) {
        if (typeof id !== "string" || id === "") continue;
        quota.set(id, (quota.get(id) || 0) + 1);
    }
}

/** 按配额清掉死亡点附近的重复掉落。
 *  @param {Map<string, number>} quota 会被就地消耗（跨阶梯扫描共享，避免重复删）
 *  @returns {number} 清掉几件 */
function sweepGround(dim, at, quota) {
    if (!dim || !at || !quota || quota.size === 0) return 0;

    let left = 0;
    for (const v of quota.values()) left += v;
    if (left <= 0) return 0;

    let list;
    try {
        list = dim.getEntities({ location: at, maxDistance: SWEEP_RADIUS });
    } catch (e) {
        return 0;
    }

    let removed = 0;

    for (const e of list) {
        if (!e || !e.isValid) continue;
        if (e.typeId !== "minecraft:item") continue;

        let comp;
        try { comp = e.getComponent("minecraft:item"); } catch (err) { comp = undefined; }
        if (!comp) continue;

        let stack;
        try { stack = comp.itemStack; } catch (err) { stack = undefined; }
        if (!stack) continue;

        const want = quota.get(stack.typeId) || 0;
        if (want <= 0) continue;

        const amt = stack.amount > 0 ? stack.amount : 1;

        if (amt <= want) {
            try {
                e.remove();
                removed += amt;
                quota.set(stack.typeId, want - amt);
            } catch (err) { /* 忽略 */ }
        } else {
            // 只删球里对应的那几个，剩下的还给玩家
            try {
                stack.amount = amt - want;
                comp.itemStack = stack;
                removed += want;
                quota.set(stack.typeId, 0);
            } catch (err) { /* 忽略 */ }
        }
    }

    return removed;
}

/** 球没造出来 / 存档没写上 / 球交不出去时的兜底：把记录与背包都还回死亡点。
 *  宁可多掉一次让人捡，也不能因为球这条链出问题就把东西蒸发掉。 */
function rebuildAndDrop(props, bagData, dim, at) {
    if (!dim || !at) return 0;

    const src = { location: at, dimension: dim };
    let n = 0;

    if (props) {
        for (const key of Object.keys(props)) {
            let data;
            try { data = JSON.parse(props[key]); } catch (e) { continue; }
            if (!data || typeof data !== "object" || typeof data.id !== "string") continue;
            try {
                const it = deserializeItem(data);
                if (it && dropItemNear(src, it)) n++;
            } catch (e) { /* 单件失败不影响其余 */ }
        }
    }

    try { n += spillBag(bagData, dim, at); } catch (e) { /* 忽略 */ }

    return n;
}

function onDie(ev) {
    const dead = ev.deadEntity;
    if (!dead) {
        log("收到死亡事件但拿不到 deadEntity → 不回球");
        return;
    }

    let typeId;
    try { typeId = dead.typeId; } catch (e) {
        log("死亡实体读不到 typeId（已被移除？）→ 不回球");
        return;
    }

    // 诊断锚点：日志里连这一行都没有 = `entityDie` 根本没触发（她是被 remove / despawn 掉的，
    // 不是死掉的），那就不是本模块的问题。带 `player:` 前缀才打，避免鸡牛羊刷屏。
    if (typeId.indexOf("player:") === 0) log(`entityDie ${typeId}`);

    // 不在任何一颗球的名单里 → 不管
    const info = ballInfoFor(typeId);
    if (info === undefined) {
        // 本包所有干员都在 `player:` 命名空间；其余（鸡 / 僵尸 / 掉落物）死亡一律静默，否则刷屏
        if (typeId.indexOf("player:") === 0) {
            log(`${typeId} 不在任何一颗球的名单里 → 不回球（装备交给 death_drop）`);
        }
        return;
    }

    // ---------- 先做完全部同步读取（实体随时会被移除） ----------
    const ownerId = ownerOf(dead);
    if (ownerId === undefined) {
        log(`${typeId} 没有主人（无 ownerId / 未驯服）→ 不回球`);
        return;
    }

    let owner;
    try { owner = world.getAllPlayers().find((p) => p.id === ownerId); } catch (e) { owner = undefined; }
    if (owner === undefined) {
        log(`${typeId} 的主人 ${ownerId} 不在线 → 不回球`);
        return;
    }

    // ---------- 选载体：有同色空球就借（预约那一格），没有就下一 tick 现造 ----------
    let gate;
    try { gate = findEmptyBall(owner, info.emptyId, true); } catch (e) { gate = undefined; }

    let pid = "";
    try { pid = owner.id; } catch (e) { pid = ""; }

    let resKey;
    if (gate !== undefined) {
        resKey = pid + "#" + gate.slot;
        reservedSlots.add(resKey);
    }

    const release = () => {
        if (resKey === undefined) return;
        try { reservedSlots.delete(resKey); } catch (e) { /* 忽略 */ }
        resKey = undefined;
    };

    let at, dim;
    try {
        const loc = dead.location;
        dim = dead.dimension;
        at = { x: loc.x, y: loc.y, z: loc.z };
    } catch (e) {
        release();
        log(`${typeId} 读不到死亡坐标 / 维度（实体已失效）→ 不回球`);
        return;
    }

    let skin = 0;
    try {
        const s = dead.getComponent("minecraft:skin_id");
        if (s) skin = s.value;
    } catch (e) { skin = 0; }

    // 形态：带回死亡时的 variant（持剑 / 持弓 / 采集 / 耕地）。写 0 会放成待命态但主手已摆剑、
    // 记录仍在，右键撞 interact_router 的反向兜底把真剑还掉。
    // 能否重放由 `buildFilledBallFor` 按 VARIANT_EVENT_MAP 过滤。
    let variant = 0;
    try {
        const v = dead.getComponent("minecraft:variant");
        if (v) variant = v.value;
    } catch (e) { variant = 0; }

    let nameTag;
    try { nameTag = dead.nameTag; } catch (e) { nameTag = undefined; }

    let snap;
    try {
        snap = snapshotEquipRecords(dead);
    } catch (e) {
        release();
        log(`记录快照失败：${e}`);
        return;                                   // 没接管 → death_drop 照常走
    }

    // 背包：优先用「伤害前」抢到的预快照 —— `entityDie` 时引擎已经把容器抛空，
    // 此刻容器已被引擎清空，`readInventory` 只读到 null；实时读仅作兜底。
    let bagData;
    let bagFrom = "预快照";

    try {
        const pre = pendingBag.get(dead.id);
        if (pre !== undefined) {
            bagData = pre;
            pendingBag.delete(dead.id);
        } else {
            bagFrom = "实时";
            bagData = readInventory(dead, true);
        }
    } catch (e) {
        bagData = undefined;
        log(`${typeId} 背包快照失败：${e}`);
    }

    let bagCount = 0;
    if (bagData && Array.isArray(bagData.slots)) {
        for (const s of bagData.slots) if (s) bagCount++;
    }

    const payload = { v: 2, slots: {}, props: snap.props };

    // 主手真件走 data.weapon（`applyToMaid` 用的是这个键，不是 props 里那条）
    try {
        const raw = snap.props["dm34:weapon"];
        if (typeof raw === "string" && raw !== "") payload.weapon = JSON.parse(raw);
    } catch (e) { /* 忽略 */ }

    // 到这里才算"由球接管"，后面的 death_drop 必须让路
    try {
        markBallHandled(dead.id);
    } catch (e) {
        release();
        log(`${typeId} 打不上「球已接管」标记（${e}）→ 交回 death_drop`);
        return;                                   // 标记不上就别接管，交回 death_drop
    }

    /** 球真的拿着这套记录、并且交到玩家手里了 → 地面上那份才算"重复"，才可以清。
     *  没做到就绝不能清：那时清掉的是唯一一份。 */
    let sweepAllowed = false;

    /** 配额跨阶梯扫描共享，在下一 tick 按"实际写成功了什么"重填（可能是空的）。 */
    const quota = new Map();

    // ---------- 下一 tick：造球 → 写记录+背包 → 交给玩家 → 才清地面 ----------
    system.run(() => {
        try {
            const ball = buildFilledBallFor(typeId, {
                ownerId,
                ownerName: owner.name,
                nameTag,
                skin,
                variant,
                bagData,
                // 死亡回球走独立的冷却表（金 75 / 蓝 45 / 绿 15，= 正常收回的 3 倍）。
                // 三条载体（借空球 / 现造 / 落地）都吃这一颗球，所以只在这一处定就够了。
                cdKind: "death",
            });

            if (ball === undefined) {
                log(`${typeId} 造球失败（球型表里查不到）`);
                rebuildAndDrop(snap.props, bagData, dim, at);
                return;
            }

            // 装备记录
            const payloadOk = writeEquipPayload(ball, payload);
            const hasPayload = Object.keys(snap.props).length > 0;
            if (!payloadOk && hasPayload) {
                log(`${typeId} 装备记录回读不一致（${Object.keys(snap.props).length} 条）`);
            }

            // 背包：回读一次，DP 是设在 ItemStack 上的，不需要先入容器
            let bagOk = true;
            if (bagData !== undefined && bagCount > 0) {
                try {
                    const back = ball.getDynamicProperty(BAG_DP);
                    bagOk = typeof back === "string" && back.length > 0;
                } catch (e) { bagOk = false; }
                if (!bagOk) log(`${typeId} 背包存档回读不一致（${bagCount} 件）`);
            }

            // 载体：有预约到的空球就用那颗，否则现造一颗进空格（满了落地）
            const res = (gate !== undefined)
                ? handOverBall(owner, ball, info, gate.slot)
                : handOverFreshBall(owner, ball, info);

            // 写失败的那部分按数据掉回死亡点（只掉失败的那部分，不重复掉）
            let rescued = 0;
            if (!payloadOk && hasPayload) rescued += rebuildAndDrop(snap.props, null, dim, at);
            if (!bagOk && bagData !== undefined) rescued += rebuildAndDrop(null, bagData, dim, at);
            if (rescued > 0) log(`${typeId} 未上球的 ${rescued} 件已掉回死亡点`);

            if (!res.ok && !res.dropped) {
                // 球既没进背包也没落地 → ItemStack 连同存档一起消失，未掉过的部分全部还回死亡点。
                // 已掉过的部分在上面 `rescued` 处理过，这里传 null 避免双份。
                log(`${typeId} 球既没进背包也没落地`);
                const n = rebuildAndDrop(
                    payloadOk ? snap.props : null,
                    bagOk ? bagData : null,
                    dim,
                    at,
                );
                if (n > 0) log(`${typeId} 补充掉落 ${n} 件`);
                return;
            }

            // 只有"确实进了球"的那部分才允许清地面
            const allowSweep = () => {
                fillQuota(quota, bagOk ? bagData : undefined, payloadOk ? snap.typeIds : undefined);
                sweepAllowed = true;
            };

            const where = res.ok
                ? `槽位 ${res.slot}`
                : `背包满，球已丢在脚下`;
            const carrier = (gate !== undefined) ? info.emptyId : `新造 ${info.filledCooling}`;
            log(`${typeId} → ${carrier}（背包 ${bagCount} 件/来源 ${bagFrom} / 记录 ${Object.keys(snap.props).length} 条，${where}）`);

            // 背包一件都没收到 = 预快照没抢到（多半是 /kill 之类不发 entityHurt 的死法），
            // 东西这会儿应该正躺在地上，玩家自己捡。
            if (bagCount === 0) log(`${typeId} 背包为空（${bagFrom}），本次不带背包回去`);

            // actionbar 提示：死亡回球用独立冷却（金 75 / 蓝 45 / 绿 15），秒数取 deathCd。
            try {
                const cdSec = Number.isFinite(info.deathCd) ? info.deathCd : "?";
                owner.onScreenDisplay.setActionBar(
                    `§c干员已自行撤回，还需 §e${cdSec}§c 秒`
                );
            } catch (e) { /* 提示失败不影响回球 */ }

            if (res.ok) {
                allowSweep();
                const n = sweepGround(dim, at, quota);
                if (n > 0) log(`${typeId} 清掉地面重复掉落 ${n} 件`);
                return;
            }

            // 落地这颗 ItemStack 可能丢动态属性：验到存档齐全才放行地面清理，否则地上那份是唯一一份。
            // `dropItemNear` 不返回实体，当场 getEntities 可能还看不到，所以查找延后 1t。
            const ent0 = res.entity;

            system.runTimeout(() => {
                let ent = ent0;
                try { if (!ent || !ent.isValid) ent = undefined; } catch (e) { ent = undefined; }
                if (!ent) ent = findDroppedBall(owner, ball.typeId);

                if (!ent) {
                    // 抓不到实体就无法确认存档在不在 → 不放行清理，地上那份保留（宁可多一份）。
                    log(`${typeId} 落地球抓不到实体 → 不放行清理，地上那批保留`);
                    return;
                }

                const needBag = bagCount > 0 && bagOk;
                const needEquip = Object.keys(snap.props).length > 0 && payloadOk;

                const probe = () => {
                    try {
                        const stack = ent.getComponent("minecraft:item")?.itemStack;
                        return {
                            bag: stack ? stack.getDynamicProperty(BAG_DP) : undefined,
                            equip: stack ? stack.getDynamicProperty(BALL_EQUIP_DP) : undefined,
                        };
                    } catch (e) {
                        return { bag: undefined, equip: undefined };
                    }
                };

                const lost = (g) =>
                    (needBag && (typeof g.bag !== "string" || g.bag.length === 0)) ||
                    (needEquip && (typeof g.equip !== "string" || g.equip.length === 0));

                let got = probe();

                // 落地这份 ItemStack 有丢动态属性的先例。手里这颗 `ball` 就是刚写好存档的
                // 原件 —— 直接塞回去覆盖空壳，比重建数据可靠（也不会因为重建失败再丢一次）。
                if (lost(got)) {
                    try {
                        const comp = ent.getComponent("minecraft:item");
                        if (comp) comp.itemStack = ball;
                    } catch (e) { /* 塞不回去就走下面的兜底 */ }
                    got = probe();
                }

                if (lost(got)) {
                    // 实体已失效 = 球被玩家捡走 / 自己没了。存档**可能就在那颗球上**，
                    // 再掉一份就是复制 —— 只保留地上那批，不还回死亡点。
                    let alive = true;
                    try { alive = !!ent.isValid; } catch (e) { alive = false; }
                    if (!alive) {
                        log(`${typeId} 落地球已被捡走，存档无法回读 → 不对账，地上那批保留`);
                        return;
                    }

                    const loseBag = needBag && (typeof got.bag !== "string" || got.bag.length === 0);
                    const loseEquip = needEquip && (typeof got.equip !== "string" || got.equip.length === 0);

                    const n = rebuildAndDrop(
                        loseEquip ? snap.props : null,
                        loseBag ? bagData : null,
                        dim,
                        at,
                    );
                    log(`${typeId} 落地球补写后仍读不到存档（空壳），${n} 件已还回死亡点，地上不再清`);
                    return;             // 不放行 → 地上那批保留
                }

                allowSweep();
            }, 1);
        } catch (e) {
            log(`${typeId} 回球异常：${e}`);
        } finally {
            release();
        }
    });

    // 后续阶梯复扫（幂等）：引擎可能晚几 tick 才抛。
    // `sweepAllowed` 由"球拿到数据并交给玩家"那一步放行 —— 没放行就说明地上那批是唯一一份。
    for (const step of SWEEP_STEPS) {
        system.runTimeout(() => {
            if (!sweepAllowed) return;
            const n = sweepGround(dim, at, quota);
            if (n > 0) log(`地面复扫 +${step}t 清掉 ${n} 件（${typeId}）`);
        }, step);
    }
}

export function initBallDeathReturn() {
    if (inited) return;
    inited = true;

    // ---------- ① 伤害应用之前：预判这一下会不会打死，抢背包快照 ----------
    // 这是唯一还能读到完整容器的时机（引擎在死亡流程里就把内容抛到地上并清空）。
    try {
        registerBeforeHurtHandler("ballDeath.beforeHurt", (ev) => {
            try {
                const e = ev.hurtEntity;
                if (!e) return;

                let hp;
                try {
                    hp = e.getComponent("minecraft:health")?.currentValue;
                } catch (err) {
                    return;
                }

                if (typeof hp !== "number") return;

                const dmg = typeof ev.damage === "number" ? ev.damage : 0;

                // 打不死就不用管；<= 0 是保守预判（免伤 / 免死会多存一份，超时自清）
                if (hp - dmg > 0) return;

                takeBagSnapshot(e, "致命伤预判");
            } catch (err) { /* 忽略：抢不到还有后面两道 */ }
        }, HURT_PRIORITY.BALL_DEATH);
    } catch (e) {
        log(`beforeHurt 注册失败：${e}`);
    }

    // ---------- ② 伤害应用之后：血量已归零、死亡流程可能还没跑（兜底补一份） ----------
    try {
        registerAfterHurtHandler("ballDeath.afterHurt", (ev) => {
            try {
                const e = ev.hurtEntity;
                if (!e) return;

                let hp;
                try {
                    hp = e.getComponent("minecraft:health")?.currentValue;
                } catch (err) {
                    return;
                }

                if (typeof hp === "number" && hp > 0) return;

                takeBagSnapshot(e, "血量归零");
            } catch (err) { /* 忽略 */ }
        }, AFTER_HURT_PRIORITY.BALL_DEATH);
    } catch (e) {
        log(`afterHurt 注册失败：${e}`);
    }

    // ---------- ③ 死亡：用预快照，没有才实时读 ----------
    // 走总线（DEATH_PRIORITY.BALL_DEATH 先于 death_drop），标记才来得及让后面的模块让路。
    registerEntityDieHandler(
        "ballDeath.onDie",
        (ev) => {
            try { onDie(ev); } catch (e) { log(`死亡回球异常：${e}`); }
        },
        DEATH_PRIORITY.BALL_DEATH,
    );
}
