/** 幻域球扩展：收放女仆时保住装备槽 + 自定义动态属性。
 *  fictoria_ball 只存 36 格背包，装备和属性随 remove() 消失。
 *  装备必须序列化（附魔/名字/耐久），只记 id 等于洗成白板。
 *  capture（收回）/ read（放置前）/ apply（生成后）各管一段。 */

import { EquipmentSlot, system, world } from "@minecraft/server";

import { CONFIG } from "./config.js";
import { isMaid, cookCode, acceptsArmor, resolveState, variantOf, markOf } from "./maid_state.js";
import { readSlot, placeItem, serializeItem, deserializeItem, cmdHasItem, enchKey, dropItemNear, probeComponents } from "./slot_io.js";
import { startCook, resumeStore } from "./cook.js";
import { deserializeWeapon } from "./weapon_store.js";
import { recordArmor, putInBag, takeOneFromBag, bagFirstOf } from "./guard.js";
import { restoreShieldToBag } from "./shield.js";
import { storedGatherTool, restoreGatherDisplay } from "./gather_store.js";
import { storedFarmTool, restoreFarmDisplay } from "./farm_store.js";
import { heal, mirror } from "./record_store.js";

/** 球上的存档键（球清属性前会被 read 读走） */
export const BALL_EQUIP_DP = "dm34:equip";

/** 需要跟着女仆走的动态属性（装备/武器/耕地工具/采集工具/烹饪状态） */
const PROP_KEYS = [
    "dm34:weapon", "dm34:armor", "dm34:cook", "dm34:autocook",
        // 耕地锄头记录要跟着球走（球不还原 variant），否则玩家的锄头锁死在实体上。
    "dm34:hoe", "dm34:hgive",
        // 采集镐 / 斧（含长矛）：同一件事。少了这三条，放置后变回闲置（gjob 没了 =
        // 采集态直接消失），真件留在记录里但永远没人归还 —— 表现为"工具被吞了"。
    "dm34:gtool", "dm34:ggive", "dm34:gjob",
        // 盾：记录跟着球走。副手实物随旧实体销毁（SLOTS 只存主手 + 四件甲），
        // 放置时由 applyToMaid 调 restoreShieldToBag 按这份记录重建真件塞进背包。
    "dm34:shield",
];

/** 装备槽顺序（主手 + 四个盔甲位） */
const SLOTS = [EquipmentSlot.Mainhand, EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet];

/** 延迟复检阶梯（累计 1 / 2 / 4 tick）。
 *  摆装备和「容器还原 + 状态重放」挤在同一 tick，装备槽还没建好，replaceitem 必被吞。
 *  两条探针在此场景常同时失灵，所以多试几档 —— 重摆是幂等的。 */
const RESTORE_RECHECK_STEPS = [1, 1, 2, 8, 20, 40];

/** 穿甲窗口已废除：改由 on_ta 常驻的 equip_item + shareables，捡到就穿。 */

/** 认盔甲用的 typeId 正则（shareables 白名单里的四类） */
const ARMOR_ITEM_RE = /helmet|chestplate|leggings|boots/;

/** 生成事件兜底：等多久确认 tick8 扩展调用没来。
 *  releaseMaid 的回调里 restoreInventory 没有 try，抛一次就整段中断、apply 永不执行。 */
const SPAWN_FALLBACK_TICKS = 12;

/** 待还原记录的有效期（tick）。`read` 与 `spawnEntity` 在同一个 tick 内完成，
 *  所以只容忍 1 tick 误差；窗口放大反而会让"另一只女仆生成"误领这份存档。 */
const PENDING_TTL_TICKS = 1;

/** 待还原队列：read() 登记，apply() 认领；12 tick 无人认领 → 生成事件补还原。 */
const PENDING = [];


function warn(msg) {
    if (!CONFIG.log.console) return;     // 总闸见 config.js
    try { console.warn(`[dm34/ball] ${msg}`); } catch (e) { /* 忽略 */ }
}

/** 她背包里还剩几件盔甲（typeId 列表）。
 *  从 bagFirstOf() 起扫：前 2 格是装备伪槽，甲不占容器格，出现在背包段就是没穿上。 */
function armorInBag(entity) {
    const out = [];
    try {
        const c = entity.getComponent("minecraft:inventory")?.container;
        if (!c) return out;
        const first = bagFirstOf(c);
        for (let i = first; i < c.size; i++) {
            let cur;
            try { cur = c.getItem(i); } catch (e) { cur = undefined; }
            const t = cur && cur.typeId ? cur.typeId : "";
            if (ARMOR_ITEM_RE.test(t)) out.push(t.replace("minecraft:", ""));
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 她周围 8 格内还躺着几件盔甲掉落物（去前缀的 typeId 列表） */
function armorOnGround(entity) {
    const out = [];
    try {
        const list = entity.dimension.getEntities({
            type: "minecraft:item",
            location: entity.location,
            maxDistance: 8,
        });
        for (const it of list) {
            let stack;
            try { stack = it.getComponent("minecraft:item")?.itemStack; } catch (e) { stack = undefined; }
            const t = stack && stack.typeId ? stack.typeId : "";
            if (ARMOR_ITEM_RE.test(t)) out.push(t.replace("minecraft:", ""));
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 登记一条待还原记录（`read` 时调用） */
function rememberPending(data) {
    if (!data) return;
    try {
        const rec = { data, tick: system.currentTick, claimed: false, applied: false };
        PENDING.push(rec);
        if (PENDING.length > 8) PENDING.splice(0, PENDING.length - 8);
    } catch (e) { /* 忽略 */ }
}

/** 认领（apply 开头调用），防止被别的生成抢走。不在这里置 applied —— 还原真跑完才算数。 */
function claimPending(data) {
    if (!data) return;
    for (let i = 0; i < PENDING.length; i++) {
        if (PENDING[i].data === data) { PENDING[i].claimed = true; return; }
    }
}

/** 还原完整跑完（`apply` 末尾调用） */
function markApplied(data) {
    if (!data) return;
    for (let i = 0; i < PENDING.length; i++) {
        if (PENDING[i].data === data) { PENDING[i].applied = true; return; }
    }
}

/** 存档摘要（诊断用，存/取两侧都打，一眼能看出断在哪） */
function summarize(data) {
    if (!data) return "(没有存档)";
    return `v=${data.v} slots=[${Object.keys(data.slots || {}).join(",") || "-"}] ` +
        `props=[${Object.keys(data.props || {}).join(",") || "-"}]` +
        (data.sit ? " sit=1" : "");
}

/** 她是不是坐着（待命 in2）。
 *  球只存 variant，而待命靠 mark_variant，放出来永远是 variant 0，
 *  所以自己存一个布尔，放置后补触发一次 sit_1。 */
function isSitting(maid) {
    try {
        const st = resolveState(maid);
        return !!st && st.key === "in2";
    } catch (e) {
        return false;
    }
}

/*
 * 采集 / 耕地的主手替身重建。
 * 真件（玩家给的那把镐/斧/锄）序列化在 `dm34:gtool` / `dm34:hoe` 里，跟着球走过来；主手那件
 * 「外观件」是随旧实体销毁的，球不存 EquipmentSlot 之外的实物。没有这一步，放出来就是
 * 「带着 gjob 空手挖矿」，看起来像工具被吞了。
 * tick8 时装备槽刚结算完，replaceitem 常被吞 → 两档都试（`restoreXxxDisplay` 幂等，已经摆对
 * 就直接 return，不会放两件）。
 */
function restoreToolDisplay(maid) {
    const tryOnce = () => {
        let alive = false;
        try { alive = !!maid.isValid; } catch (e) { alive = false; }
        if (!alive) return;

        // 🔴 **按状态只摆一份**。以前是不判状态、两个记录都摆：
        //    只要 `dm34:gtool` 与 `dm34:hoe` 同时非空（「采集态用锄头换掉镐」留下的烂账），
        //    这里就会先摆镐、再摆锄 —— 玩家看到手上"来回夺舍"，
        //    潜行退出时两条记录各还一次 = 两样一起掉（2026-11-16 实测）。
        //    状态读不到（刚放出来、variant 还没结算）时才退回"都试一遍"，保住容错。
        let key = "";
        try { const st = resolveState(maid); key = st ? st.key : ""; } catch (e) { key = ""; }

        if (key === "farm") {
            try { if (storedFarmTool(maid)) restoreFarmDisplay(maid); } catch (e) { /* 忽略 */ }
            return;
        }
        if (key === "dm_mine" || key === "dm_chop") {
            try { if (storedGatherTool(maid)) restoreGatherDisplay(maid); } catch (e) { /* 忽略 */ }
            return;
        }
        if (key !== "") return;      // 武器/待命/烹饪：主手不归这两份记录管，别抢

        try { if (storedGatherTool(maid)) restoreGatherDisplay(maid); } catch (e) { /* 忽略 */ }
        try { if (storedFarmTool(maid)) restoreFarmDisplay(maid); } catch (e) { /* 忽略 */ }
    };
    system.runTimeout(tryOnce, 2);
    system.runTimeout(tryOnce, 12);
}

/** 放置后补回待命姿态。apply 跑在 tick8，组件组可能还在结算，所以回读验证、最多试 3 档。
 *  只在「她还是 variant 0」时补 —— 玩家中途换过状态就不抢。 */
function restoreSit(maid) {
    let tries = 0;
    const trySit = () => {
        let alive = true;
        try { alive = !!maid.isValid; } catch (e) { alive = false; }
        if (!alive) return;

        let v = 0;
        let m = 0;
        try {
            v = variantOf(maid);
            m = markOf(maid);
        } catch (e) { return; }

        if (v === 0 && m === 1) return;      // 已经坐下了
        if (v !== 0) return;                  // 被别的状态接管 → 不抢

        try { maid.triggerEvent("sit_1"); } catch (e) { /* 忽略 */ }
        tries++;
        if (tries < 3) system.runTimeout(trySit, 2);
    };
    system.runTimeout(trySit, 2);
}

/** 读 `dm34:armor` 记录（`{Head:{…序列化物品…}}`） */
function armorRecordOf(maid) {
    try {
        const raw = maid.getDynamicProperty("dm34:armor");
        if (typeof raw === "string" && raw !== "") return JSON.parse(raw);
    } catch (e) { /* 忽略 */ }
    return {};
}

/** 剔掉 dm34:armor 里 carrier=bag 的槽（实物在背包里，背包自己会存档）。剔空返回 undefined。 */
function stripBagArmor(raw) {
    if (typeof raw !== "string" || raw === "") return undefined;
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { return raw; }
    if (!rec || typeof rec !== "object") return raw;
    let removed = 0;
    for (const k of Object.keys(rec)) {
        if (rec[k] && rec[k].carrier === "bag") { delete rec[k]; removed++; }
    }
    if (!removed) return raw;
    if (!Object.keys(rec).length) return undefined;
    try { return JSON.stringify(rec); } catch (e) { return raw; }
}

/** 读 `dm34:weapon` 记录（真武器的序列化数据） */
function weaponRecordOf(maid) {
    try {
        const raw = maid.getDynamicProperty("dm34:weapon");
        if (typeof raw === "string" && raw !== "") return JSON.parse(raw);
    } catch (e) { /* 忽略 */ }
    return undefined;
}

/** 收回：把装备槽 + 自定义动态属性写进球里 */
export function captureToBall(maid, ball) {
    if (!isMaid(maid) || !ball) return;

    const data = { v: 2, slots: {}, props: {} };
    const rec = armorRecordOf(maid);
    const weapon = weaponRecordOf(maid);
    /** 诊断：哪些槽"真的能读出来"（读不到的必须靠记录兜底） */
    const readable = [];

    for (const slot of SLOTS) {
        let item;
        try { item = readSlot(maid, slot); } catch (e) { item = undefined; }
        if (item) readable.push(String(slot));

                // 记录优先，读槽只作兜底。
                // 槽里是 replaceitem 写进去的白件（命令带不了附魔），读得到 ≠ 是完整的那件。
                // 记录来自玩家手里的原件，附魔/名字/耐久都在，它才是真相源。
        const slotName = String(slot);
        let fromRecord;
        if (slot === EquipmentSlot.Mainhand) {
            if (weapon) fromRecord = deserializeWeapon(weapon);
        } else if (rec && rec[slotName]) {
                        // carrier=bag 表示这件已在背包里，由 readInventory 单独存档。
                        // 这里再写进 data.slots，放置时就会再放一件（收放一次多一件）。
            if (rec[slotName].carrier === "bag") continue;
            fromRecord = deserializeItem(rec[slotName], true);
        }
        if (fromRecord) item = fromRecord;

        if (!item) continue;
        const packed = serializeItem(item);
        if (packed) data.slots[slotName] = packed;
    }

    if (weapon) data.weapon = weapon;

    // 待命（坐姿）：球本身只认 `variant`，in1/in2 的差别在 mark_variant 上，必须自己存。
    if (isSitting(maid)) data.sit = true;

    // 记录有可能只活在"世界镜像"里（实体那份被读空过 / 重进世界后丢了）。
    // 抓取前先按镜像补回实体，否则球会存到一份空记录 —— 放出来就是"手上握着替身、
    // 记录却是空的"，那件真货再也还不回去。
    try { heal(maid, ["dm34:weapon", "dm34:hoe", "dm34:gtool"]); } catch (e) { /* 忽略 */ }

    for (const key of PROP_KEYS) {
        // 军械女仆不穿甲：脏记录不往球里带（否则下次放置又会被"复检补摆"装上）
        if (key === "dm34:armor" && !acceptsArmor(maid)) continue;
        try {
            const v = maid.getDynamicProperty(key);
            if (v === undefined) continue;
            // `carrier: "bag"` 的槽指的是"实物已经在她背包里"的影子，背包本身会被
            // `readInventory()` 完整存档 —— 记录跟着球走只会在放置时再放一件。
            if (key === "dm34:armor") {
                const kept = stripBagArmor(v);
                if (kept === undefined) continue;
                data.props[key] = kept;
                continue;
            }
            data.props[key] = v;
        } catch (e) { /* 忽略 */ }
    }

    // 采集三件套要么一起走、要么都不走。只剩 `dm34:gjob` 没有 `dm34:gtool`
    // = 放出来她"空手挖矿"，而那份真件永远没人归还（玩家看到的就是工具被吞）。
    // 这种情况只会出现在老存档 / 半路被打断，顺手清掉，别把它带过球。
    if (data.props["dm34:gtool"] === undefined) {
        delete data.props["dm34:gjob"];
        delete data.props["dm34:ggive"];
    }

    warn(
        `收回 ${maid.typeId}：${summarize(data)} ` +
        `读槽=[${readable.join(",") || "-"}] armor记录=[${Object.keys(rec).join(",") || "-"}] ` +
        `weapon=${weapon ? weapon.id : "-"}`
    );

    // 空手待命的女仆可能身上什么记录都没有 —— 但她"坐着"这件事也得存下来，
    // 否则 `data.sit` 会因为下面这行提前 return 而永远写不进球里。
    if (Object.keys(data.slots).length === 0 && Object.keys(data.props).length === 0 && !data.sit) {
        warn("收回时什么都没存到（既读不到槽位也没有记录）");
        return;
    }

    try {
        const payload = JSON.stringify(data);
        ball.setDynamicProperty(BALL_EQUIP_DP, payload);

        // 回读校验：ItemStack 的动态属性写入**可能静默失败**（长度上限、该物品栈不支持）。
        // 不校验的话，收回看起来"成功"，放置时才空手 —— 正是最难定位的那种失败。
        const back = ball.getDynamicProperty(BALL_EQUIP_DP);
        const backLen = typeof back === "string" ? back.length : -1;
        if (backLen !== payload.length) {
            warn(`存档回读不一致：写入 ${payload.length} 字符，回读 ${backLen < 0 ? "无" : backLen}`);
        }
    } catch (e) {
        warn(`存档写入失败: ${e && e.message ? e.message : e}`);
    }
}

/** 放置：球上的属性马上要被清掉，先把数据读进内存 */
export function readFromBall(ball) {
    if (!ball) return undefined;
    try {
        const raw = ball.getDynamicProperty(BALL_EQUIP_DP);
        if (typeof raw !== "string" || raw === "") return undefined;
        const data = JSON.parse(raw);
        // 登记：万一幻域球的 tick8 扩展调用没来，生成事件那条兜底通道要靠它
        rememberPending(data);
        return data;
    } catch (e) {
        warn(`存档读取失败: ${e && e.message ? e.message : e}`);
        return undefined;
    }
}

/** 放置后还原：先写动态属性，再摆装备。
 *  记录必须比槽位先到位，否则 guard 巡检会把刚摆上的甲当成她捡的。 */
export function applyToMaid(maid, data) {
    // 入口先打一行：之前只有走到末尾才打日志，
    // 于是「压根没被调用」和「进来就 return 了」在日志上完全无法区分。
    let typeId = "?";
    try { typeId = maid && maid.typeId ? maid.typeId : "?"; } catch (e) { typeId = "?"; }
    warn(`apply 进入 ${typeId}：${data ? "有存档" : "无存档"}`);

    if (!isMaid(maid)) {
        warn(`apply 跳过：${typeId} 不在女仆表里（isMaid=false）`);
        return 0;
    }
    if (!data) {
        // 以前这里静默 return —— 于是"球上压根没数据"和"摆了但没生效"
        // 在日志里长得一模一样（都没有 `[dm34/ball] 放置` 那行），没法区分。
        warn(`放置 ${maid.typeId}：球上没有 dm34:equip 存档（收回时没写进去，或换了另一颗球）`);
        return 0;
    }

    // 正常路径已接管 → 生成事件的兜底通道不必再补
    claimPending(data);

        // ① 先写回动态属性（含 dm34:armor / dm34:weapon），记录要早于槽位。
        //    军械女仆（dm34_1）不穿甲：dm34:armor 一律不写回，并清掉旧残留。
    const armorOk = acceptsArmor(maid);
    for (const [key, v] of Object.entries(data.props || {})) {
        if (!armorOk && key === "dm34:armor") continue;
        try { maid.setDynamicProperty(key, v); } catch (e) { /* 忽略 */ }
    }
    if (!armorOk) {
        try { maid.setDynamicProperty("dm34:armor", undefined); } catch (e) { /* 忽略 */ }
    }
    // ①'' 新实体是**新的 id**，镜像里没有它的条目 —— 只靠"读时自愈"补不出来，
    //      必须主动把这三份记录镜像一遍，否则这个存档再丢一次就真没凭证了。
    try { mirror(maid, ["dm34:weapon", "dm34:hoe", "dm34:gtool"]); } catch (e) { /* 忽略 */ }

        // ①' 采集 / 耕地：主手那件"替身"随旧实体一起销毁了，真件在 dm34:gtool / dm34:hoe
        //     记录里（已由 ① 写回）。这里按记录重建替身，否则她带着 gjob 空手挖矿。
        //     tick8 时装备槽刚结算完，replaceitem 常被吞 → +2 / +12 各补一次（幂等）。
    try { restoreToolDisplay(maid); } catch (e) { /* 忽略 */ }

        // 盾：副手不在 SLOTS 里（收回时只存档主手 + 四件甲），实物已经随旧实体销毁，
        // 只有 dm34:shield 记录被 PROP_KEYS 带了过来。这里按记录重建**真件**塞进背包并清掉记录 ——
        // 不清记录的话，shield.js 的巡检会把"有记录没实物"当丢件，把背包这面又复制一份掉到地上。
        // 脚本摆不回副手（附魔/耐久会丢），所以玩家取出来右键重装一次，真件保真。
    try {
        const n = restoreShieldToBag(maid);
        if (n) warn(`幻域球：盾牌已放回 ${maid.typeId} 的背包`);
    } catch (e) { warn(`盾牌回背包失败: ${e && e.message ? e.message : e}`); }

        // 穿甲窗口已删除（开关组件组会连带撤走装备定义，甲越穿越少）。
        // 现在 on_ta 常驻：equip_item + behavior.equip_item + shareables（不写 stored_in_inventory）
        // → 捡到就穿；equippable 只留马鞍槽，甲穿在引擎内建槽里，不占容器格。
        // 保留 +60t 诊断：容器前 8 格 + 背包段 + 地上的甲，唯一能看见引擎把甲放哪的手段。
    system.runTimeout(() => {
        let alive = false;
        try { alive = maid.isValid; } catch (e) { alive = false; }
        if (!alive) return;
        const front = [];
        let invInfo = "?";
        try {
            const c = maid.getComponent("minecraft:inventory")?.container;
            if (c) {
                invInfo = `${c.size}格/背包起${bagFirstOf(c)}`;
                for (let i = 0; i < Math.min(8, c.size); i++) {
                    let it;
                    try { it = c.getItem(i); } catch (e) { it = undefined; }
                    front.push(`${i}:${it ? String(it.typeId).replace("minecraft:", "") : "-"}`);
                }
            } else {
                invInfo = "无容器";
            }
        } catch (e) { /* 忽略 */ }
        warn(`放球后 +60t：容器=${invInfo} 前8格=[${front.join(" ")}] ` +
            `背包甲=[${armorInBag(maid).join(",") || "-"}] 地上甲=[${armorOnGround(maid).join(",") || "-"}]`);
    }, 60);

    let placed = 0;
    const filled = {};   // 槽名 → 摆上去的物品（用于补记录）
    const tried = {};    // 槽名 → 已经处理过（成功或失败都算，避免 ③④ 两段重复摆放）
    const failed = [];
    const dropped = [];  // 背包塞不进 → 真件掉在她脚下的槽名
    // （`wear` 数组已删：穿甲通道整体回退，盔甲一律先进背包）
    const bagged = [];   // 写槽失败 → 先原封不动存进她背包保命的槽名
    const stashed = {};  // 槽名 → 暂存在背包里的真件（复检写槽成功后要取走，否则一件变两份）

    const put = (slotName, item) => {
        const slot = EquipmentSlot[slotName];
        if (slot === undefined) return false;
        // 同一个槽只处理一次：③ ④ 覆盖同一批槽，只用 filled 去重会让失败槽再掉一次
        // （掉落表里会出现 [Head,Head]）。
        if (tried[slotName]) return false;
        tried[slotName] = true;

        // 先试穿，穿不上才进背包。
        // equippable 是 player-only，getComponent() 在生物上恒 undefined，
        // 不能用它判断「槽声明被丢弃」。
        if (slotName !== "Mainhand") {
            // 回退：原封不动放进背包，背包满才落地。
            // 已排除的穿甲途径：SAPI 写槽 / replaceitem components / equip_item / shareables /
            // 声明 slot 2..5 / 猪灵同构 —— 都会吞件或根本没穿上。基岩版无法把带附魔的真甲
            // 穿到自定义生物上并保真；要她穿甲请用甲右键（interact 的 equip_item_slot
            // 是原生通道，附魔不丢）。
            let inBag = false;
            try { inBag = putInBag(maid, item); } catch (e) { inBag = false; }
            if (inBag) {
                bagged.push(slotName);
            } else {
                let loose = false;
                try { loose = dropItemNear(maid, item); } catch (e) { loose = false; }
                if (loose) dropped.push(slotName);
                else failed.push(`${slotName}(丢出失败)`);
            }
                        // 记录照写并打 carrier=bag：captureToBall 不再写 data.slots，
                        // removeAllArmor 也知道没有东西可还，不会凭空重建一件。
            if (armorOk) {
                try {
                    const packed = serializeItem(item);
                    if (packed) recordArmor(maid, slotName, { ...packed, carrier: "bag" });
                } catch (e) { /* 忽略 */ }
            }
            return false;
        }

        // 主手照旧：写槽 + `/enchant` 保附魔（武器这条通道一直是好的）
        let ok = false;
        try { ok = placeItem(maid, slot, item); } catch (e) { ok = false; }
        if (ok) { placed++; filled[slotName] = item; return true; }
        failed.push(slotName);
        return false;
    };

    // ② 主手：按 `dm34:weapon` 记录重建替身（setDisplay 与 placeItem(Mainhand) 等价，
    //    走 put 只是为了让 placed / filled 把主手也统计进去）
    //
    //    🔴 **没有 weapon 记录时，data.slots.Mainhand 也必须摆回去**（否则长矛 / 镐 / 斧
    //    放进球再放出来，背包里没有、手上也没有，等于被吞）。
    //    采集态（dm_mine / dm_chop）主手那件是"镐/斧替身"，它不在 dm34:weapon 里，
    //    而 ④ 又显式 `slotName === "Mainhand" → continue`（那边约定主手只由这里处理）——
    //    两头都不接，那件就凭空消失。真件在 dm34:gtool 记录里，替身只是外观，缺了它就空手挖矿。
    if (data.weapon) {
        try {
            const real = deserializeWeapon(data.weapon);
            if (real) put("Mainhand", real);
            else failed.push("Mainhand(反序列化失败)");
        } catch (e) {
            failed.push("Mainhand(异常)");
        }
    } else if (data.slots && data.slots.Mainhand) {
        let item;
        try { item = deserializeItem(data.slots.Mainhand, true); } catch (e) { item = undefined; }
        if (item) put("Mainhand", item);
        else failed.push("Mainhand(存档反序列化失败)");
    }

        // ③ 记录优先：data.slots 里的甲是白件（只带 typeId），顺序反了就用白件盖掉记录，
        //    表现正是「收球再放出来附魔没了」。
    let rec = {};
    try { rec = armorRecordOf(maid); } catch (e) { rec = {}; }
    for (const [slotName, packed] of Object.entries(rec || {})) {
        if (filled[slotName]) continue;
        // `carrier: "bag"` = 这件甲已经在背包里（放置时放进去的），不要再放第二件。
        // 正常收球时 `captureToBall` 已经把这类槽剔掉，这里是老存档 / 手改数据的兜底。
        if (packed && packed.carrier === "bag") continue;
        const slot = EquipmentSlot[slotName];
        if (slot === undefined || slot === EquipmentSlot.Mainhand) continue;
        let item;
        try { item = deserializeItem(packed, true); } catch (e) { item = undefined; }
        if (!item) continue;
        put(slotName, item);
    }

    // ④ 存档里的其它槽位作兜底（记录里没有的才用，主手已由 ② 处理）
    for (const [slotName, packed] of Object.entries(data.slots || {})) {
        if (slotName === "Mainhand") continue;
        const slot = EquipmentSlot[slotName];
        if (slot === undefined) continue;
        if (filled[slotName]) continue;
        let item;
        try { item = deserializeItem(packed, true); } catch (e) { item = undefined; }
        if (!item) continue;
        put(slotName, item);
    }

        // ⑤ 补记录已挪进 put() 的盔甲分支（甲直接进背包，那一刻就写记录）。
        // ⑥ 回读只剩主手有意义：盔甲槽读不到，hasitem 会因背包里有甲而假阳性。
    const after = [];
    for (const slotName of ["Mainhand", "Head", "Chest", "Legs", "Feet"]) {
        let got;
        try { got = readSlot(maid, EquipmentSlot[slotName]); } catch (e) { got = undefined; }
        // `hasitem` 只在主手兜底。盔甲那边它会说谎 —— 她刚把甲捡进背包时探针也是 true。
        let mark = "";
        if (!got && slotName === "Mainhand") {
            let has = false;
            try { has = cmdHasItem(maid, slotName); } catch (e) { has = false; }
            if (has) mark = "(命令说有)";
        }
        after.push(`${slotName}=${got ? `${got.typeId}[${enchKey(got) || "-"}]` : "-"}${mark}`);
    }

        // 组件探针：equippable=无 + inventory=有 → 组件组生效但拿不到 equippable。
    let pr = { equippable: false, slotApi: false, inventory: false, size: 0, ids: [] };
    try { pr = probeComponents(maid); } catch (e) { /* 忽略 */ }

    warn(
        `放置 ${maid.typeId}：${summarize(data)} 摆上=${placed} ` +
        `入包=[${bagged.join(",") || "-"}] ` +
        `落地=[${dropped.join(",") || "-"}] ` +
        `失败=[${failed.join(",") || "-"}] ` +
        `回读[${after.join(" ")}] ` +
        `组件[equippable=${pr.equippable ? "有" : "无"} slotApi=${pr.slotApi ? "有" : "无"} ` +
        `inv=${pr.inventory ? "有" : "无"}(${pr.size}格)]`
    );

        // ⑦ 延迟复检 + 自动补摆。清单按「该有哪些」建（首摆失败的恰恰最需要补），
        //    实体刚 spawn 时 replaceitem 会被吞。
    const expect = [];
    const pushExpect = (slotName, item) => {
        if (!slotName || !item) return;
        if (expect.some(([n]) => n === slotName)) return;
        expect.push([slotName, item]);
    };

        // 只把暂存进背包的几件放进清单；dropped 的已在脚下，再摆就是凭空多一件。
    if (data.weapon) {
        try { pushExpect("Mainhand", deserializeWeapon(data.weapon)); } catch (e) { /* 忽略 */ }
    }
    for (const [slotName, item] of Object.entries(stashed)) pushExpect(slotName, item);

    if (expect.length) {
                // 逐档补摆 1 → 1 → 2 tick（累计 1/2/4），每档重新判缺失，任一说在位就收手。
        let step = 0;

        const recheck = () => {
            system.runTimeout(() => {
                let alive = false;
                try { alive = maid.isValid; } catch (e) { alive = false; }
                if (!alive) return;

                const missing = [];
                for (const [slotName, item] of expect) {
                    // 首轮已经判定"写不进"并把真件交还玩家的槽，**不许再补摆**：
                    // 她脚下/背包里已经有那件真件了，再摆一次就是凭空多一件。
                    if (dropped.indexOf(slotName) >= 0) continue;
                    let got;
                    try { got = readSlot(maid, EquipmentSlot[slotName]); } catch (e) { got = undefined; }
                    if (got && got.typeId === item.typeId) {
                                                // 类型对上还不够：replaceitem 放进去的是白件，
                                                // 读得到就收手会把白板甲留到重进世界。有附魔就一起比。
                        if (slotName === "Mainhand" || enchKey(got) === enchKey(item)) continue;
                    }

                    let has = false;
                    try { has = cmdHasItem(maid, slotName, item.typeId); } catch (e) { has = false; }
                                        // hasitem 只在主手当兜底：她刚把甲捡进背包时它也是 true，会让复检第一档就收敛。
                    if (!got && has && slotName === "Mainhand") continue;

                    missing.push([slotName, item]);
                }

                // 探针确认到位 → 收敛，不再往后试
                if (!missing.length) return;

                const isLast = step === RESTORE_RECHECK_STEPS.length - 1;

                                // 组件探针只打第一档和最后一档，区分组件组没生效与 equippable 被丢。
                if (step === 0 || isLast) {
                    const pr = probeComponents(maid);
                    warn(
                        `组件探针（复检#${step + 1}）：equippable=${pr.equippable ? "有" : "无"} ` +
                        `getEquipmentSlot=${pr.slotApi ? "有" : "无"} ` +
                        `inventory=${pr.inventory ? "有" : "无"}(${pr.size}格) ` +
                        `相关=[${pr.ids.join(",") || "-"}]`
                    );
                }

                let fixed = 0;
                for (const [slotName, item] of missing) {
                    let ok = false;
                    try { ok = placeItem(maid, EquipmentSlot[slotName], item); } catch (e) { ok = false; }
                    if (!ok) continue;
                    fixed++;
                    filled[slotName] = item;
                    if (slotName !== "Mainhand") {
                        if (armorOk) {
                            try { recordArmor(maid, slotName, serializeItem(item)); } catch (e) { /* 忽略 */ }
                        }
                    }
                    // 写槽成功 → 把先前存进背包保命的那份取走，否则一件变两份
                    if (stashed[slotName]) {
                        try { takeOneFromBag(maid, item.typeId); } catch (e) { /* 忽略 */ }
                        delete stashed[slotName];
                    }
                }

                const next = step + 1;
                warn(
                    `复检#${step + 1}（+${RESTORE_RECHECK_STEPS[step]}t，累计 ${RESTORE_RECHECK_STEPS.slice(0, step + 1).reduce((a, b) => a + b, 0)}t）：` +
                    `缺失=[${missing.map(([n]) => n).join(",")}] 补摆=${fixed}` +
                    (next < RESTORE_RECHECK_STEPS.length ? "（还会再看一次）" : "（最后一次）")
                );

                step = next;
                if (step < RESTORE_RECHECK_STEPS.length) recheck();
            }, RESTORE_RECHECK_STEPS[step]);
        };

        recheck();
    }

    // 收回时她可能正在锅里：state 被球恢复成 cook_Na 了，但计时器随实体一起没了。
    // 不重新续上就会永远卡在烹饪态，所以按存档里的进度补一发。
    try {
        const code = cookCode(maid);
        if (code > 0) {
            const n = Math.floor(code / 2);
            if (n >= 1 && n <= 10) {
                if (code % 2 === 0) startCook(maid, n);        // 还在煮 → 重新计时
                else resumeStore(maid, n, 1);                   // 已煮好 → 直接出锅入包
            }
        }
    } catch (e) {
        warn(`烹饪进度恢复失败: ${e && e.message ? e.message : e}`);
    }

        // ⑧ 待命姿态还原：放最后，切姿态只改组，提前切会让上面的 variant 判断错位。
    if (data.sit) {
        try { restoreSit(maid); } catch (e) { warn(`待命还原失败: ${e && e.message ? e.message : e}`); }
    }

    markApplied(data);
    return placed;
}

/** 生成兜底：生成后 12 tick 仍无人认领待还原记录，说明 tick8 扩展调用没到，补一次 applyToMaid。 */
function initSpawnFallback() {
    try {
        world.afterEvents.entitySpawn.subscribe((ev) => {
            let entity;
            try { entity = ev.entity; } catch (e) { return; }
            if (!entity) return;

            let maid = false;
            try { maid = isMaid(entity); } catch (e) { maid = false; }
            if (!maid) return;

            let now = 0;
            try { now = system.currentTick; } catch (e) { now = 0; }

            // 过期记录直接丢掉，避免很久以后误配到另一只女仆
            for (let i = PENDING.length - 1; i >= 0; i--) {
                if (now - PENDING[i].tick > PENDING_TTL_TICKS) PENDING.splice(i, 1);
            }

            let rec;
            for (let i = 0; i < PENDING.length; i++) {
                if (!PENDING[i].claimed) { rec = PENDING[i]; break; }
            }
            if (!rec) return;

            // 生成当刻就占住：一份存档只对应一只女仆，
            // 否则同一 tick 里再生成一只会重复领到别人的装备。
            rec.claimed = true;

            system.runTimeout(() => {
                // 正常路径（tick8 的扩展 apply）已经还原过 → 不重复摆一遍
                if (rec.applied) return;
                let alive = false;
                try { alive = entity.isValid; } catch (e) { alive = false; }
                if (!alive) return;

                warn(`兜底恢复 ${entity.typeId}：幻域球扩展 apply 未执行（tick8 链路中断），改由生成事件补还原`);
                try { applyToMaid(entity, rec.data); } catch (e) {
                    warn(`兜底恢复失败: ${e && e.message ? e.message : e}`);
                }
            }, SPAWN_FALLBACK_TICKS);
        });
    } catch (e) {
        warn(`生成事件兜底订阅失败: ${e && e.message ? e.message : e}`);
    }
}

/** 注册到幻域球的扩展点（在 index.js 里调用一次） */
export function initBallSync(registerBallExtension) {
    if (typeof registerBallExtension !== "function") {
        warn("注册失败：registerBallExtension 不是函数");
        return;
    }
    registerBallExtension({
        capture: captureToBall,
        read: readFromBall,
        apply: applyToMaid,
    });
    // 注册成功必须有回执：这一行不在，就说明 index.js 那次调用压根没跑到
    warn("扩展已注册（收回 / 读取 / 还原 + 生成事件兜底）");
    initSpawnFallback();
}
