/* slot_io.js — 装备槽读写。命令优先（replaceitem 客户端才刷新），equippable 只做回读校验 */

import { EnchantmentTypes, ItemStack } from "@minecraft/server";
import { CONFIG } from "./config.js";

/** EquipmentSlot → replaceitem 的槽位名 */
export const SLOT_ID = {
    Head: "slot.armor.head",
    Chest: "slot.armor.chest",
    Legs: "slot.armor.legs",
    Feet: "slot.armor.feet",
    Mainhand: "slot.weapon.mainhand",
    Offhand: "slot.weapon.offhand",
    Body: "slot.armor.body",
};

/*
 * 容器里比 `inventory_size`(36) 多出来的格数 —— 只用于**诊断日志**，不参与 replaceitem 的索引。
 * 她只有马鞍槽且马鞍槽是 `container_type: horse` 的 0 号位，容器实测 36 格 → 这里恒 0。
 * 🔴 别拿它当「slot.armor 能清到哪」的上限：那是**另一个容器**（见下）。
 */
function pseudoCountOf(entity) {
    try {
        const c = entity.getComponent("minecraft:inventory")?.container;
        const size = c && c.size;
        if (typeof size === "number" && size > 36) return size - 36;
    } catch (e) { /* 忽略 */ }
    return 0;
}

/*
 * 四个甲槽的 replaceitem slotId。`slot.armor.head/chest/legs/feet` 对应 **0/1/2/3**。
 *
 * 🔴 铁律：`slot.armor.*` 走的是**引擎的盔甲容器**，与 `minecraft:inventory`（背包 + 0 号马鞍位）
 *    **是两个互不相干的容器**。`replaceitem entity @s slot.armor.chest 1 air 1` 动的是胸甲位，
 *    永远碰不到背包格。而她的甲是 JSON 的 `equip_item_slot: "slot.armor.X"` 直接塞进盔甲容器的，
 *    全包只有马鞍一个 `equippable` 声明 → `readSlot`/`setEquipment` 这两条 SAPI 通道**全是瞎的**，
 *    于是 `replaceitem` 是唯一能把她身上的甲取下来的手段。
 *    2026-11-20 20:28 的事故：把这里当成容器索引、盔甲分支返回空数组 →
 *    清槽通道全灭 → 「甲已返还到背包、身上还穿着一件」（记录被抹 + 实物没离身 = 一件变两件）。
 */
const ARMOR_SLOT_ID = { Head: 0, Chest: 1, Legs: 2, Feet: 3 };

/** 槽位索引候选：主手沿用原包 AC 的 1，副手 0；盔甲用部位号优先、其余兜底全试 */
function slotIndexCandidates(entity, slot) {
    if (slot === "Mainhand" || slot === "Offhand") return [1, 0];
    const own = ARMOR_SLOT_ID[slot];
    if (own === undefined) return [0, 1, 2, 3];
    const out = [own];
    for (const i of [0, 1, 2, 3]) if (i !== own) out.push(i);
    return out;
}

/*
 * 清槽要扫的索引比放的时候宽：放只写一个，清必须把可能写过的都清，
 * 否则「落在 1、只清了 0」→ 甲留在身上收不回。
 * 盔甲这里就是 `slot.armor` 的四个部位号 —— 与背包容器无关，多扫几个不会碰到玩家的东西。
 */
function clearIndexCandidates(entity, slot) {
    if (slot === "Mainhand" || slot === "Offhand") return [0, 1];
    return slotIndexCandidates(entity, slot);
}

function comp(entity, id) {
    try {
        return entity.getComponent(id);
    } catch (e) {
        return undefined;
    }
}

export function equippableOf(entity) {
    return comp(entity, "minecraft:equippable");
}

/*
 * 组件探针（只读）：区分「组件组还没生效」与「equippable JSON 被引擎丢弃」，
 * 顺带记录 getEquipmentSlot 是否存在（容器级寻址，与 getEquipment 是两套实现）
 */
export function probeComponents(entity) {
    const out = { equippable: false, inventory: false, slotApi: false, size: 0, ids: [] };
    try {
        const eq = equippableOf(entity);
        out.equippable = !!eq;
        if (eq) {
            try { out.slotApi = typeof eq.getEquipmentSlot === "function"; } catch (e) { /* 忽略 */ }
        }
    } catch (e) { /* 忽略 */ }
    try {
        const inv = comp(entity, "minecraft:inventory");
        out.inventory = !!inv;
        if (inv && inv.container) out.size = inv.container.size || 0;
    } catch (e) { /* 忽略 */ }
    try {
        if (typeof entity.getComponents === "function") {
            out.ids = entity.getComponents()
                .map((c) => String(c && c.typeId ? c.typeId : c))
                .filter((id) => id.indexOf("equip") >= 0 || id.indexOf("inventory") >= 0 || id.indexOf("armor") >= 0);
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 用 equippable 读槽位（组件不可用时返回 undefined，不抛） */
export function readSlot(entity, slot) {
    try {
        const eq = equippableOf(entity);
        if (!eq) return undefined;
        return eq.getEquipment(slot);
    } catch (e) {
        return undefined;
    }
}

/*
 * 读主手那件（比 readSlot 多一条通道）。
 * 女仆的 equippable 只声明了 0 号马鞍槽，getEquipment(Mainhand) 在组刚结算 / 槽没建好时
 * 直接给 undefined，于是所有「主手那把是什么」的回退路径全部哑火。
 * 这里补 getEquipmentSlot(Mainhand).getItem()（容器级寻址），两条都不行才算读不到。
 * @returns {*} ItemStack | undefined
 */
export function readMainhand(entity) {
    const a = readSlot(entity, "Mainhand");
    if (a && a.typeId) return a;
    try {
        const eq = equippableOf(entity);
        const cs = eq && typeof eq.getEquipmentSlot === "function"
            ? eq.getEquipmentSlot("Mainhand")
            : undefined;
        const b = cs && typeof cs.getItem === "function" ? cs.getItem() : undefined;
        if (b && b.typeId) return b;
    } catch (e) { /* 槽位没声明 / 实体已卸载 */ }
    return undefined;
}

/** 主手里到底有没有东西（连 ItemStack 都读不到时的最后判据） */
export function mainhandHasAnything(entity) {
    try {
        return cmdHasItem(entity, "Mainhand");
    } catch (e) {
        return false;
    }
}

/*
 * 主手的第二条通道：不走 replaceitem，直接用 SAPI 写组件。
 * 她不是玩家，setEquipment(Mainhand, undefined) 不会留下幽灵槽；万一写歪，
 * clearSlot 的 sweep 也能收回。
 * @returns {*} 写完回读到的 ItemStack（读不到返回 undefined）
 */
export function forceMainhand(entity, item) {
    const eq = equippableOf(entity);
    if (!eq || !item) return readMainhand(entity);
    const cloneOf = () => {
        try { return item.clone ? item.clone() : item; } catch (e) { return item; }
    };
    try {
        const cs = typeof eq.getEquipmentSlot === "function" ? eq.getEquipmentSlot("Mainhand") : undefined;
        if (cs && typeof cs.setItem === "function") cs.setItem(cloneOf());
    } catch (e) { /* 槽位没声明 */ }
    try {
        if (typeof eq.setEquipment === "function") eq.setEquipment("Mainhand", cloneOf());
    } catch (e) { /* 忽略 */ }
    const back = readMainhand(entity);
    diagLog("force-mainhand",
        `SAPI 直写主手 ${item.typeId} → 回读=${back ? back.typeId : "读不到"}`);
    return back;
}

/*
 * 主手「照写不误」：命令通道 + SAPI 直写，两条都打。
 * readMainhand 的两条通道在这只女仆身上都会间歇性返回 undefined，所以任何「读到对才写」的逻辑都会
 * 在读不出发射条件时整段不执行，主手就停在上一个状态的替身上 —— 表现为「换不了」。写是幂等的，
 * 多打一次远比永不对好。顺序：replaceitem 先（客户端可见），SAPI 后（服务端数据一定对，附魔 /
 * 名字 / 耐久带得过去）。
 * @returns {true|false|undefined} 三态，调用方必须区分：true = 回读到就是这件；undefined = 读不到
 * （写过了，没证据说失败）；false = 明确读到别的件。旧版把 undefined 也当 false，守卫的「连续 5
 * 次停手」会在读不到时误停，比不判更糟。
 */
export function syncMainhand(entity, item) {
    if (!item) {
        clearMainhand(entity);
        return undefined;
    }
    placeItem(entity, "Mainhand", item);
    const back = readMainhand(entity);
    if (back && back.typeId === item.typeId) return true;
    forceMainhand(entity, item); // 读不到 / 读到别的件 → SAPI 再打一次
    const after = readMainhand(entity);
    if (!after || !after.typeId) return undefined; // 读不到 → 没证据
    return after.typeId === item.typeId;
}

/*
 * 清主手：无条件扫 air（命令 index 0/1 各一遍 + SAPI setEquipment(undefined)）。
 * 返回 false 只代表「读不到、清没清干净没有证据」，绝不代表「没清」——
 * 调用方不许因此跳过后续的清记录 / 归还
 */
export function clearMainhand(entity) {
    let before;
    try { before = readMainhand(entity); } catch (e) { before = undefined; }
    clearSlot(entity, "Mainhand");
        // 引擎有时要一 tick 才落地，再扫一轮无害（命令幂等），
        // 但不要先读一次当判据 —— 读不到就整段不执行是这个模块的老毛病
    clearSlot(entity, "Mainhand");
    let after;
    try { after = readMainhand(entity); } catch (e) { after = undefined; }
    diagLog("clear-mainhand",
        `清主手：读前=${before ? before.typeId : "读不到"} 读后=${after ? after.typeId : "读不到"}`);
    return !(after && after.typeId);
}

/*
 * 用命令探槽里有没有东西（equippable 读不到时用）。
 * @param {string} [itemId] 给出时问「这个槽里是不是这件」。
 * 必须带 item=：hasitem 的 slot= 是容器格索引，套在装备槽上恒 false
 */
export function cmdHasItem(entity, slot, itemId) {
    const sid = SLOT_ID[slot];
    if (!sid) return false;

    if (itemId) {
        try {
            entity.runCommand(`testfor @s[hasitem={item=${itemId},location=${sid}}]`);
            return true;
        } catch (e) {
            return false;
        }
    }

    for (const idx of slotIndexCandidates(entity, slot)) {
        try {
            entity.runCommand(`testfor @s[hasitem={location=${sid},slot=${idx}}]`);
            return true;
        } catch (e) { /* 这一格没有，试下一个 */ }
    }
    return false;
}

function enchOf(item) {
    if (!item) return [];
    try {
        const c = item.getComponent("minecraft:enchantable");
        return c ? c.getEnchantments() || [] : [];
    } catch (e) {
        return [];
    }
}

export function enchKey(item) {
    return enchOf(item)
        .map((e) => `${e.type.id}=${e.level}`)
        .sort()
        .join(",");
}

function damageOf(item) {
    if (!item) return 0;
    try {
        const c = item.getComponent("minecraft:durability");
        return c ? c.damage || 0 : 0;
    } catch (e) {
        return 0;
    }
}

function nameOf(item) {
    try {
        return item && item.nameTag ? String(item.nameTag) : "";
    } catch (e) {
        return "";
    }
}
/** 附魔列表 → [["sharpness",5], …] */
function enchPairs(item) {
    return enchOf(item).map((e) => [String(e.type.id), e.level]);
}

/*
 * 拼 replaceitem 的 item components —— 只带附魔，名字 / 耐久一律不写。
 * 附魔名不能带 minecraft: 前缀，否则整个 components 被静默忽略（白件来源）。
 * 新旧两种写法连发，第二条失败不影响第一条
 */
function enchantComponents(item) {
    const pairs = enchPairs(item)
        .map(([id, lvl]) => [String(id).replace(/^minecraft:/, ""), lvl])
        .filter(([id]) => !!id);
    if (!pairs.length) return [];
    const body = pairs.map(([id, lvl]) => `${JSON.stringify(id)}:${lvl}`).join(",");
    return [
        `{"minecraft:enchantments":{"levels":{${body}}}}`,
        `{"minecraft:enchantments":{${body}}}`,
    ];
}

function runCmd(entity, cmd) {
    try {
        entity.runCommand(cmd);
        return true;
    } catch (e) {
        return false;
    }
}

/** 她自己的背包容器（自检用；读不到返回 undefined） */
function bagContainerOf(entity) {
    try {
        const inv = entity.getComponent("minecraft:inventory");
        const c = inv && inv.container;
        return c && typeof c.size === "number" ? c : undefined;
    } catch (e) {
        return undefined;
    }
}

/** 自检结论缓存：null = 还没测过 */
let COMPONENTS_ENCH = null;

/*
 * 自检：replaceitem 的 components 到底能不能带附魔。
 * 判据用读得到的容器：同件物品写进背包空格再读回附魔比对（写前快照、写完复原）。
 * @returns {boolean} true = 能带附魔
 */
function componentsCarryEnchant(entity, item) {
    if (COMPONENTS_ENCH !== null) return COMPONENTS_ENCH;

    const variants = enchantComponents(item);
    const want = enchKey(item);
    if (!variants.length || !want) return false;

    const c = bagContainerOf(entity);
    if (!c) return false;

    let size = 0;
    try { size = c.size || 0; } catch (e) { size = 0; }
    if (!size) return false;

    const before = new Map();
    let empty = -1;
    for (let i = 0; i < size; i++) {
        let it;
        try { it = c.getItem(i); } catch (e) { it = undefined; }
        if (it) before.set(i, it);
        else if (empty < 0) empty = i;
    }
    if (empty < 0) return false;                 // 背包满，这次测不了

    let wrote = false;
    for (const slotType of ["slot.inventory", "slot.chest"]) {
        for (const cj of variants) {
            if (runCmd(entity,
                `replaceitem entity @s ${slotType} ${empty} ${item.typeId} 1 0 ${cj}`)) {
                wrote = true;
                break;
            }
        }
        if (wrote) break;
    }
    if (!wrote) return false;

        // 整包扫，找出被改动的那一格
    let hit = -1, hitEnch = "";
    for (let i = 0; i < size; i++) {
        let it;
        try { it = c.getItem(i); } catch (e) { it = undefined; }
        const now = it ? `${it.typeId}#${enchKey(it)}` : "";
        const old = before.has(i) ? `${before.get(i).typeId}#${enchKey(before.get(i))}` : "";
        if (now !== old) { hit = i; hitEnch = it ? enchKey(it) : ""; break; }
    }
    if (hit < 0) return false; // 命令说成功，可哪儿都没变

        // 复原（原本有东西就写回去，原本是空格就清掉）
    try {
        if (before.has(hit)) c.setItem(hit, before.get(hit));
        else c.setItem(hit, undefined);
    } catch (e) { /* 忽略 */ }

    COMPONENTS_ENCH = (hitEnch === want);
    diagLog("comp-probe",
        `附魔 components 自检：写 ${item.typeId} → 回读=[${hitEnch || "-"}] 期望=[${want}] ` +
        `→ ${COMPONENTS_ENCH ? "能带附魔" : "带不了"}`);
    return COMPONENTS_ENCH;
}

/*
 * 全实体探针：她身上任意位置（四装备槽 + 主手/副手 + 背包）还有没有这件 id。
 * 不带 location=：装备槽对 SAPI/`hasitem{location}` 都是隐形的，只带 location 会漏。
 * @returns {boolean} 还能不能找到（含背包里的同款，调用方自己按身份复核）
 */
export function cmdHasAnywhere(entity, itemId) {
    if (!itemId) return false;
    try {
        entity.runCommand(`testfor @s[hasitem={item=${itemId}}]`);
        return true;
    } catch (e) {
        return false;
    }
}

/*
 * 清空装备槽：候选索引全发一遍 air → SAPI setEquipment(undefined) → 校验。
 * @param {string} [typeId] 给出时用 hasitem 精确探针判定是否清掉
 * @returns {boolean} 是否确实清空
 */
export function clearSlot(entity, slot, typeId) {
    const sid = SLOT_ID[slot];
    const idxs = clearIndexCandidates(entity, slot);

    // 🔴 这里**不许**按 `pseudoCountOf` 裁剪索引。盔甲槽的 slotId 是 `slot.armor` 容器的部位号，
    //    不是 `minecraft:inventory` 的格号：背包被吞是 guard 的 `Container.setItem` 干的
    //    （伪槽段上界），与这条命令无关。2026-11-20 20:28 裁成空数组的后果是甲彻底卸不下来。
    const sweep = () => {
        if (!sid) return;
        for (const idx of idxs) runCmd(entity, `replaceitem entity @s ${sid} ${idx} air 1`);
        try {
            const eq = equippableOf(entity);
                        // 玩家永远不许走这条 SAPI 兜底：setEquipment(Mainhand, undefined) 在玩家身上
                        // 会把那一格写成非法栈（幽灵槽）。玩家侧只有 takeMainhand() 的命令实现
            if (eq && entity.typeId !== "minecraft:player") eq.setEquipment(slot, undefined);
        } catch (e) { /* 槽位没声明 / 实体已消失 */ }
    };

    sweep();

    if (typeId && sid) {
        if (!cmdHasItem(entity, slot, typeId)) return true;
                // 还在 → 再扫一轮（引擎有时要一 tick 才落地，重复发无害）
        sweep();
        return !cmdHasItem(entity, slot, typeId);
    }

    const got = readSlot(entity, slot);
    return !got;
}

const warned = new Set();
// 诊断用：同一条路径最多打 6 次，够看清「每次实际走了哪条」又不刷屏
const diagCount = new Map();
function diagLog(key, msg) {
    if (!CONFIG.log.console) return;      // 总闸见 config.js
    const n = (diagCount.get(key) || 0) + 1;
    diagCount.set(key, n);
    if (n > 6) return;
    try { console.warn(`[dm34/place] ${msg}`); } catch (e) { /* 忽略 */ }
}
function warnOnce(key, msg) {
    if (!CONFIG.log.console) return;
    if (warned.has(key)) return;
    warned.add(key);
    try { console.warn(msg); } catch (e) { /* 忽略 */ }
}

/** 把真件（附魔/名字/耐久）直接写进装备槽 —— SAPI 兜底通道，排在 replaceitem components 之后。
 *  两种写法都试：getEquipmentSlot(slot).setItem() → setEquipment(slot)。
 *  能回读就严格比类型+附魔；回读不到用 hasitem 探针，探不到算失败。
 *  @returns {boolean} 真件是否进槽 */
function writeRealItem(entity, slot, real, want) {
    const eq = equippableOf(entity);
    if (!eq) {
        diagLog(`nosapi-${slot}`, `${slot} 拿不到 minecraft:equippable，SAPI 通道不可用`);
        return false;
    }
    const cloneOf = () => {
        try { return real.clone ? real.clone() : real; } catch (e) { return real; }
    };

    const judge = (how) => {
        const got = readSlot(entity, slot);
        if (got) {
            const ok = got.typeId === real.typeId && enchKey(got) === want;
            diagLog(`real-${how}-${slot}`,
                `${slot} ${how} 回读=${got.typeId}[${enchKey(got)}] 期望=[${want}] ok=${ok ? 1 : 0}`);
            return ok;
        }
        let has = false;
        try { has = cmdHasItem(entity, slot, real.typeId); } catch (e) { has = false; }
        diagLog(`real-${how}-${slot}`,
            `${slot} ${how} 槽读不到 → hasitem 探针=${has ? 1 : 0}（只看服务端有没有这件）`);
        return has;
    };

    // ① ContainerSlot 直写
    try {
        const cs = eq.getEquipmentSlot(slot);
        if (cs && typeof cs.setItem === "function") {
            cs.setItem(cloneOf());
            if (judge("getEquipmentSlot")) return true;
        }
    } catch (e) {
        diagLog(`real-cs-${slot}`,
            `${slot} getEquipmentSlot 不可用：${e && e.message ? e.message : e}`);
    }

    // ② 组件方法
    try {
        if (eq.setEquipment(slot, cloneOf()) && judge("setEquipment")) return true;
    } catch (e) {
        diagLog(`real-se-${slot}`,
            `${slot} setEquipment 抛错：${e && e.message ? e.message : e}`);
    }
    return false;
}

/** 把物品放进装备槽。主手和盔甲走不同的路，别统一：
 *  盔甲/副手：replaceitem 干净件 → 补附魔 components → 命令被拒才退 SAPI → 都不行留日志
 *  主手：replaceitem 干净件 → /enchant（只接受玩家目标，对女仆常失败）
 *  主手不能优先 setEquipment：服务端对、客户端不刷新。
 *  @param {string} slot EquipmentSlot 值
 *  @returns {boolean} */
export function placeItem(entity, slot, item) {
    if (!item) return clearSlot(entity, slot);
    const sid = SLOT_ID[slot];
    if (!sid) return false;
    let real;
    try { real = item.clone ? item.clone() : item; } catch (e) { real = item; }
    if (!real) return clearSlot(entity, slot);

    const want = enchKey(real);
    const wantName = nameOf(real);
    const pairs = enchPairs(real);
    const dmg = damageOf(real);
    const needExtra = !!want || dmg > 0 || !!wantName;

        // ① 先放干净件，客户端立刻可见。
        // runCommand 不抛错 ≠ 放上了：放完必探一次，probe=0 进日志。
    let idx = -1;
    for (const i of slotIndexCandidates(entity, slot)) {
        if (runCmd(entity, `replaceitem entity @s ${sid} ${i} ${real.typeId} 1`)) { idx = i; break; }
    }
    if (idx < 0) {
        /*
         * 四个部位号全被命令拒 = `slot.armor` 这套槽在她身上根本不存在（整只实体加载失败、
         * 或被 transformation 换成别的实体）。此时**只能**退 SAPI，绝不许退回"往索引 0 写"：
         * 0 号是马鞍槽/背包格，写进去的甲既不显示也卸不下来，记录里还多一件。
         * SAPI 也只采信 readSlot 的真回读，不拿 hasitem 探针当成功证据（那只女仆上它会假阳/假阴），
         * 否则会骗调用方"摆上了"而不入包。
         */
        if (slot !== "Mainhand" && slot !== "Offhand") {
            diagLog(`noslot-${slot}`, `${slot} 四个部位号全被拒（伪槽=${pseudoCountOf(entity)}）→ 只走 SAPI：${real.typeId}`);
            writeRealItem(entity, slot, real, want);
            let back;
            try { back = readSlot(entity, slot); } catch (e) { back = undefined; }
            const ok = !!back && back.typeId === real.typeId;
            diagLog(`sapi-${slot}`, `${slot} SAPI 回读=${back ? back.typeId : "读不到"} ok=${ok ? 1 : 0}`);
            if (ok) {
                warnOnce(`place-sapi-${slot}`, `[dm34] ${slot} 用 SAPI 写入真件（无命令通道）：${real.typeId}`);
                return true;
            }
            return false;      // 交调用方入包 / 掉落，绝不假装摆上了
        }
        diagLog(`noidx-${slot}`, `${slot} ${real.typeId}：slot.weapon 的 index 全部被拒（该槽组可能不存在）`);
        return false;
    }

    let probeOk = false;
    try { probeOk = cmdHasItem(entity, slot, real.typeId); } catch (e) { probeOk = false; }

        // probe 失败多为实体刚 spawn，同 tick 重发一次（命令幂等）。
        // 🔴 **探不到也不换 index、更不许清空刚写的那格**（2026-11-16 血的教训）：
        //    `testfor @s[hasitem={item=…,location=slot.weapon.mainhand}]` 在这只女仆身上
        //    会**假阴性**（东西明明摆上去了也报没有）。照着它清格 = 把刚摆好的替身亲手删掉：
        //    · 武器/斧/剑 → 主手空着，"给什么都看不见"；
        //    · 锄头 → 清空后 farm 组 equipment 的铁锄又露出来，"给什么锄头都是铁锄"。
        //    换 index 也会把件挪进马鞍槽/背包格。所以探针只写日志，绝不据此做破坏性动作。
    if (!probeOk) {
        runCmd(entity, `replaceitem entity @s ${sid} ${idx} ${real.typeId} 1`);
        try { probeOk = cmdHasItem(entity, slot, real.typeId); } catch (e) { probeOk = false; }
    }

    // 回写复核：真读槽位（equippable / getEquipmentSlot 两条通道），探针只作参考。
    // 下一轮排查"摆上了但看不见"就靠这行区分「没写进去」和「写进去了渲染没跟上」。
    if (slot === "Mainhand") {
        const back = readMainhand(entity);
        diagLog("readback-Mainhand",
            `主手回读=${back ? back.typeId : "-"} 期望=${real.typeId} ` +
            `idx=${idx} hasitem=${probeOk ? 1 : 0}`);
    }

    if (slot === "Mainhand" || !needExtra) {
        diagLog("start", `${slot} ${real.typeId} idx=${idx} probe=${probeOk ? 1 : 0} ench=[${pairs.map(([a, b]) => a + ":" + b).join(",")}] name=${wantName || "-"} dmg=${dmg}`);
    }
    if (!needExtra) return true;

    const probe = readSlot(entity, slot);
    const canRead = !!probe && probe.typeId === real.typeId;
    diagLog("canread", `${slot} needExtra=${needExtra} canRead=${canRead}`);

        // ② /enchant 只接受玩家目标，对女仆必失败，留着仅为兼容。
    if (slot === "Mainhand" && pairs.length) {
        diagLog("enchant-try", `${slot} 准备发 /enchant：${pairs.map(([a]) => a).join(",")}`);
        let okCount = 0;
        for (const [rawName, lvl] of pairs) {
            const nm = String(rawName).replace(/^minecraft:/, "");
            if (runCmd(entity, `enchant @s ${nm} ${lvl}`)) okCount += 1;
        }
        diagLog("enchant-res", `${slot} ok=${okCount}/${pairs.length} canRead=${canRead}`);
        if (okCount > 0) {
            warnOnce("place-enchant",
                `[dm34] ${slot} 用 /enchant 上了 ${okCount}/${pairs.length} 条附魔：${real.typeId}`);
            return true;
        }
    }

        // ③ 盔甲/副手先让 SAPI 搬真件：以前 components 抢在前面并"读不到就收手"，
        //    writeRealItem 从没被执行过。getEquipmentSlot 是容器级寻址，行不行只能跑一次。
    if (slot !== "Mainhand" && needExtra) {
                // 先清白件再探针，否则 hasitem 恒真、SAPI 没写也判成功。
        runCmd(entity, `replaceitem entity @s ${sid} ${idx} air 1`);
        if (writeRealItem(entity, slot, real, want)) {
            warnOnce(`place-real-${slot}`,
                `[dm34] ${slot} 用 SAPI 写入真件（含附魔）：${real.typeId} [${want}]`);
            return true;
        }
        diagLog(`realmiss-${slot}`,
            `${slot} SAPI 搬真件失败（看上面 real-* 那几行）→ 试命令 components`);
    }

        // ④ components 兜底：只认回读到的附魔列表，读不到就算失败。
    if (slot !== "Mainhand") {
        const variants = enchantComponents(real);
        if (variants.length) {
            // 先自检这条命令能不能带附魔（判据是读得到的背包，不是 readSlot）
            const trust = componentsCarryEnchant(entity, real);
            let sent = 0;
            for (const cj of variants) {
                if (runCmd(entity, `replaceitem entity @s ${sid} ${idx} ${real.typeId} 1 0 ${cj}`)) { sent = 1; break; }
            }
            const got = readSlot(entity, slot);
            const readable = !!got && got.typeId === real.typeId;
            // 槽读不到时**只能**问 hasitem"在不在位"，附魔由自检背书
            let present = false;
            if (!readable) {
                try { present = cmdHasItem(entity, slot, real.typeId); } catch (e) { present = false; }
            }
            const ok = readable ? (enchKey(got) === want) : (sent > 0 && trust && present);
            diagLog("components",
                `${slot} 附魔 components 发出=${sent} 自检=${trust ? 1 : 0} ` +
                `读回=${got ? `${got.typeId}[${enchKey(got)}]` : "读不到"} ` +
                `槽内=${present ? 1 : 0} ok=${ok ? 1 : 0}`);
            if (ok) {
                warnOnce("place-components",
                    `[dm34] ${slot} 用命令 components 写入附魔：${real.typeId} [${want}]`);
                return true;
            }
        }
    }

        // ④' 主手到此为止：命令写不进附魔/损伤，mob 也拿不到 equippable。
        //    `minecraft:durability` 物品组件只有 max_durability / damage_chance，**没有当前损伤值**，
        //    所以非满耐久的白板弓/弩在手上永远只能是满耐久的同款替身。
        //    以前这里跟盔甲共用 ⑤ 清槽 → 「她收走了武器、手上空的」，玩家得等解除形态才拿得回来。
        //    主手替身只是外观件（真件数据在 dm34:weapon，归还时按 dmg 复原），空手才是真丢，
        //    所以主手**绝不清槽**，写不进就留干净件。
    if (slot === "Mainhand") {
        diagLog("plain-mainhand",
            `${slot} ${real.typeId} 写不进附魔/损伤 → 保留干净件 dmg=${dmg} name=${wantName || "-"}`);
        return true;
    }

        // ⑤ 盔甲/副手放不进真件就清槽返回 false，绝不留白板（调用方把真件掉她脚下）。
    diagLog("nodata",
        `${slot} 真件通道全失败 → 清槽，改由调用方掉落真件：${real.typeId}`);
    clearSlot(entity, slot);
    warnOnce("place-drop",
        `[dm34] ${slot} 写不进附魔/耐久：${real.typeId} → 不摆白板，改把真件交还（掉落）`);
    return false;
}

/** 落点外推距离（格）。半宽约 0.3，推 0.7 保证物品在她体外。 */
const DROP_OUT = 0.7;
const DROP_LIFT = 0.2;

/** 落点：女仆脚下，朝远离最近玩家的方向外推。
 *  落点一旦由玩家位置推导就会出幽灵槽，所以跟着"东西从哪来"走。
 *  依次试 4 个方向，撞墙 / 进液体就换下一个。 */
function dropPointFrom(source, loc) {
    let ux = 0, uz = 1;
    let found = false;

    try {
        const ps = source.dimension.getPlayers({ location: loc, maxDistance: 16 });
        let best = -1, bx = 0, bz = 0;
        for (const p of ps) {
            const pl = p.location;
            if (!pl) continue;
            const d = Math.hypot(pl.x - loc.x, pl.z - loc.z);
            if (best < 0 || d < best) { best = d; bx = pl.x; bz = pl.z; }
        }
        if (best >= 0) {
            const dx = loc.x - bx, dz = loc.z - bz;
            const len = Math.hypot(dx, dz);
            if (len > 0.05) { ux = dx / len; uz = dz / len; found = true; }
        }
    } catch (e) { /* 沙盘 / 旧版没有 getPlayers → 用朝向兜底 */ }

    if (!found) {
        // 没有玩家在场（例如她自己背包满往外掉）：按她的朝向反方向，纯为了不卡在身体里
        try {
            const d = source.getViewDirection && source.getViewDirection();
            const len = d ? Math.hypot(d.x, d.z) : 0;
            if (len > 0.01) { ux = -d.x / len; uz = -d.z / len; }
        } catch (e) { /* 忽略 */ }
    }

    const dirs = [[ux, uz], [-uz, ux], [-ux, -uz], [uz, -ux]];
    let fallback = null;
    for (const [ax, az] of dirs) {
        const at = { x: loc.x + ax * DROP_OUT, y: loc.y + DROP_LIFT, z: loc.z + az * DROP_OUT };
        if (!fallback) fallback = at;
        let clear = true;
        try {
            const b = source.dimension.getBlock({ x: at.x, y: loc.y + 0.3, z: at.z });
            if (b && (!b.isAir || b.isLiquid)) clear = false;   // 墙里 / 岩浆里，换方向
        } catch (e) { /* 区块没加载 / 没 getBlock → 就按这个落点走 */ }
        if (clear) return at;
    }
    return fallback;
}

/** 把物品掉在 source 脚边 —— 全工程唯一的"还东西"实现。
 *  绝不写玩家容器（addItem / setItem / setEquipment 都会留幽灵槽）。
 *  @param {{location: object, dimension: object}} source 东西从谁手里出来（女仆），不是接收者
 *  @returns {boolean} 是否真的掉出去了 */
export function dropItemNear(source, itemStack) {
    if (!itemStack || !source) return false;
    try {
        const loc = source.location;
        if (!loc) return false;

        const at = dropPointFrom(source, loc);
        source.dimension.spawnItem(itemStack, at);

        // 给个"物品落地"的反馈，免得玩家以为东西被吞了
        try { source.dimension.playSound("random.pop", at); } catch (e) { /* 忽略 */ }

        // 诊断（前 6 次）：万一还有幽灵槽，这行能看出落点到底在哪、离她多远
        const d = Math.hypot(at.x - loc.x, at.z - loc.z);
        diagLog("drop", `掉落 ${itemStack.typeId} 落点距来源 ${d.toFixed(2)} 格 ` +
            `@ ${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}`);
        return true;
    } catch (e) {
        return false;
    }
}

/** 从玩家主手拿走 N 个 —— 全工程唯一的"消耗手持物"实现。
 *  同样不写玩家容器，交给 /replaceitem，引擎自己负责客户端同步。
 *  只有手上确实是这件才动手；玩家主手索引 0，她的是 1，两个都试。
 *  @param {string} [itemId] 不给就用读到的
 *  @param {number} [amount] 默认 1
 *  @returns {boolean} 是否确实拿走 */
export function takeMainhand(target, itemId, amount = 1) {
    if (!target) return false;
    let cur;
    try { cur = readSlot(target, "Mainhand"); } catch (e) { cur = undefined; }
    const id = itemId || (cur && cur.typeId);
    if (!id) return false;
    // 明确读到了别的东西 → 不动手（宁可多留一件，也不要删错）
    if (cur && cur.typeId !== id) return false;

    const have = cur ? (cur.amount || 1) : Math.max(1, amount);
    const left = have - amount;
    const gone = () => {
        let now;
        try { now = readSlot(target, "Mainhand"); } catch (e) { return true; }
        if (!now || now.typeId !== id) return true;
        return (now.amount || 1) < have;
    };

    // 数量还有剩 → 用剩余数量重写；否则置 air。两条都是命令，不碰 SAPI 容器。
    for (const idx of [0, 1]) {
        const cmd = left > 0
            ? `replaceitem entity @s slot.weapon.mainhand ${idx} ${id} ${left}`
            : `replaceitem entity @s slot.weapon.mainhand ${idx} air 1`;
        if (runCmd(target, cmd) && gone()) return true;
    }

    // 兜底：`/clear` 也是引擎命令，只清 N 件同 id（仍然不碰 SAPI 容器）
    if (runCmd(target, `clear @s ${id} -1 ${amount}`) && gone()) return true;

    warnOnce(
        `take-mainhand:${id}`,
        `[dm34] 主手取物失败：${id} ×${amount}（手上可能还留着，重进世界可清幽灵槽）`
    );
    return false;
}

/** 单格上限。读不到（旧版 SAPI）按 64 试 —— 猜大的代价只是 setItem 抛错后被跳过，
 *  回退成"写空格"，不会写坏数据。 */
function stackCapOf(item) {
    let n = 0;
    try { n = item && item.maxAmount; } catch (e) { n = 0; }
    return (typeof n === "number" && n >= 1) ? n : 64;
}

/** 堆叠等价键：任何一项不同都不能并（带附魔的剑并进白件 = 附魔凭空消失） */
function stackKeyOf(item) {
    let lore = "";
    try { lore = (item.getLore() || []).join("\u0001"); } catch (e) { lore = ""; }
    return `${item.typeId}\u0002${nameOf(item)}\u0002${enchKey(item)}\u0002${damageOf(item)}\u0002${lore}`;
}

/** 能不能并进同一格：同 typeId 且名字 / 附魔 / 耐久 / lore 全一致 */
function sameStackable(a, b) {
    if (!a || !b) return false;
    if (a.typeId !== b.typeId) return false;
    return stackKeyOf(a) === stackKeyOf(b);
}

/** 取 amount 为 n 的副本；n<=0 返回 undefined */
function withAmount(item, n) {
    if (n <= 0) return undefined;
    let out;
    try { out = item.clone ? item.clone() : item; } catch (e) { out = item; }
    try { out.amount = n; } catch (e) { return undefined; }
    return out;
}

/*
 * 把物品放进容器：先并进同类堆，塞满再找空格；每格都回读校验。
 * 不先合并就会一块一块平铺，几十格背包很快见底。只给女仆自己的容器用（玩家背包一律 dropItemNear）。
 * @param {number} [from] 起始格；0 号是马鞍槽，传 `bagFirstOf()`（=1）
 * @returns {*} 剩余物品（undefined = 已全部放入）
 */
export function putIntoContainer(container, itemStack, from) {
    if (!container || !itemStack) return itemStack;
    let size = 0;
    try { size = container.size; } catch (e) { return itemStack; }
    let start = typeof from === "number" && from > 0 ? from : 0;
    if (start > size) start = size;

    let rest = itemStack;
    const cap = stackCapOf(rest);

        // ① 合并阶段：只认同类且没满的格子
    for (let i = start; i < size; i++) {
        const want = rest.amount || 1;
        if (want <= 0) return undefined;
        let cur;
        try { cur = container.getItem(i); } catch (e) { continue; }
        if (!sameStackable(rest, cur)) continue;
        const have = cur.amount || 1;
        if (have >= cap) continue;

        const move = Math.min(cap - have, want);
        try {
            const merged = withAmount(cur, have + move);
            if (!merged) continue;
            container.setItem(i, merged);
                        // 回读校验：引擎可能 clamp 或静默忽略，按实际增量算剩余
            const back = container.getItem(i);
            const gained = (back ? (back.amount || 1) : 0) - have;
            if (gained <= 0) continue;
            rest = withAmount(rest, want - gained);
            if (!rest) return undefined;
        } catch (e) { /* 超上限被拒 / 这格写不进，试下一格 */ }
    }

        // ② 没并完的找空格放
    for (let i = start; i < size; i++) {
        let cur;
        try { cur = container.getItem(i); } catch (e) { continue; }
        if (cur) continue;                       // 只往空槽写，绝不覆盖

        try {
            container.setItem(i, rest);
                        // 回读校验：写进去了才算数（setItem 也可能静默失败）
            const back = container.getItem(i);
            if (back && back.typeId === rest.typeId) return undefined;
        } catch (e) { /* 这一格写不进，试下一格 */ }
    }
    return rest;
}

/*
 * 把同类散堆合并回靠前的几格（幂等：没散堆时只读不写）。
 * 只在总量守恒的前提下重写原格，写失败保持原样，不会丢件。
 * @returns {number} 实际改动的格子数
 */
export function compactStacks(container, from) {
    if (!container) return 0;
    let size = 0;
    try { size = container.size; } catch (e) { return 0; }
    const start = typeof from === "number" && from > 0 ? from : 0;

    const groups = new Map();
    for (let i = start; i < size; i++) {
        let it;
        try { it = container.getItem(i); } catch (e) { continue; }
        if (!it) continue;
        const cap = stackCapOf(it);
        if (cap <= 1) continue;                  // 不可堆叠（工具/盔甲）不碰
        const key = stackKeyOf(it);
        let g = groups.get(key);
        if (!g) { g = { cap, item: it, slots: [] }; groups.set(key, g); }
        g.slots.push({ i, n: it.amount || 1 });
    }

    let touched = 0;
    for (const g of groups.values()) {
        if (g.slots.length < 2) continue;        // 本来就只占一格
        let left = 0;
        for (const s of g.slots) left += s.n;
        for (const s of g.slots) {
            const want = Math.min(g.cap, left);
            if (want === s.n) { left -= want; continue; }
            let ok = false;
            try {
                if (want <= 0) {
                    container.setItem(s.i, undefined);
                    ok = !container.getItem(s.i);
                } else {
                    container.setItem(s.i, withAmount(g.item, want));
                    const back = container.getItem(s.i);
                    ok = !!back && back.typeId === g.item.typeId && (back.amount || 1) === want;
                }
            } catch (e) { ok = false; }
            if (ok) { left -= want; touched += 1; }
            else { left -= s.n; } // 没改成 → 它原有的数量还占着位置
        }
    }
    return touched;
}

/** 造一个 ItemStack */
export function makeItem(typeId, amount) {
    try {
        return new ItemStack(typeId, amount || 1);
    } catch (e) {
        return undefined;
    }
}

/* ItemStack → 可存进动态属性的普通对象（附魔/耐久/名字/lore 全留） */
export function serializeItem(item) {
    if (!item) return undefined;
    let lore = [];
    try { lore = item.getLore() || []; } catch (e) { lore = []; }
    return {
        id: item.typeId,
        n: item.amount || 1,
        name: nameOf(item),
        lore,
        ench: enchOf(item).map((e) => [e.type.id, e.level]),
        dmg: damageOf(item),
    };
}

/* 普通对象 → ItemStack（能还原多少还原多少） */
export function deserializeItem(data, restoreDamage) {
    if (!data || !data.id) return undefined;
    const it = makeItem(data.id, data.n || 1);
    if (!it) return undefined;
    if (data.name) {
        try { it.nameTag = data.name; } catch (e) { /* 忽略 */ }
    }
    if (data.lore && data.lore.length) {
        try { it.setLore(data.lore); } catch (e) { /* 忽略 */ }
    }
    if (data.ench && data.ench.length) {
        try {
            const c = it.getComponent("minecraft:enchantable");
            if (c) {
                for (const pair of data.ench) {
                    let type;
                    try { type = EnchantmentTypes.get(pair[0]); } catch (e) { type = undefined; }
                    if (!type) continue;
                    try { c.addEnchantment({ type, level: pair[1] }); } catch (e) { /* 忽略 */ }
                }
            }
        } catch (e) { /* 忽略 */ }
    }
    if (restoreDamage !== false && data.dmg) {
        try {
            const d = it.getComponent("minecraft:durability");
            if (d) d.damage = data.dmg;
        } catch (e) { /* 忽略 */ }
    }
    return it;
}


