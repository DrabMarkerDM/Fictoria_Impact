/*
 * guard.js — 女仆巡检（dm34 / dm34_1）。
 * 每 CONFIG.guard.intervalTicks 一轮 + entityLoad 补扫，做两件事：
 * ① 火把：维护 is_lighting 标签 + 每 2 tick 驱动 /function dynamic_light；
 * ② 残留盔甲工单重试（工单由 equip.removeAllArmor 登记）。
 * 火把只能轮询：玩家在背包 UI 里取放、原版拾取都不发事件。常态每轮只读一次
 * `emptySlotsCount`（没变化就沿用上次结论），只有背包真的增删时才全扫 36 格；
 * 交互与 putInBag 另有两个即时入口。
 * 名单来源 forEachMaid()，不自己 getEntities。容器只在"清残留甲"时按身份碰 0 号马鞍槽，
 * 1 号起是背包，一个字节都不动。
 */

import { EquipmentSlot, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { clearSlot, serializeItem, cmdHasAnywhere, cmdHasItem } from "./slot_io.js";
// 女仆清单直接用目标管理引擎每周期扫出来的那份，不再自己 getEntities
import { forEachMaid } from "../common/core/maid_registry.js";
import { resolveState } from "./maid_state.js";
import { hasFarmTool, restoreFarmDisplay } from "./farm_store.js";
import { storedGatherTool, restoreGatherDisplay } from "./gather_store.js";
import { refreshWeaponDisplay } from "./weapon_store.js";

const ARMOR_PROP = "dm34:armor";        // {"Head":{id,n,name,lore,ench,dmg}, ...}
const MAID_IDS = ["player:dm34", "player:dm34_1"];
const TORCH_ID = "minecraft:torch";

/** 内容日志总闸（CONFIG.log.console，默认关）。排查残留甲/火把时再打开 */
function glog(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/guard] ${msg}`); } catch (e) { /* 忽略 */ }
}

/*
 * 她的容器是 horse 型，`inventory_size: 36`（SAPI 实测 `inv=有(36格)`）。
 * **`equippable` 只声明了 slot 0 = saddle，没有马铠槽**；`container_type: horse` 的 0 号格是**马鞍位**
 * （装鞍就是往 0 号格放，`equippable.on_equip` 才能触发 `ride_on` —— 见 interact_router ① 的说明）。
 * 所以：**索引 0 = 马鞍槽，索引 1 起才是背包**，`bagFirstOf = 1`。
 *
 * 🔴 2026-11-20 的「卸甲后背包第 1 格空出来、往里放甲就被一件一件清掉」根因就是这里写成了 2：
 *   · 0 号是马鞍槽，**1 号就是玩家看到的第一格**；写 2 相当于把背包第 1 格当成"伪槽"；
 *   · `pseudoSlotItems` / `takeSameFromPseudoSlots` 扫 0..2 → 命中索引 1 的甲，
 *     `clearPseudoSlot` / `c.setItem(i, undefined)` 直接把它**从容器里抹掉**（SAPI 直写，不经命令）；
 *   · `purgeStrayArmor` 的伪槽段只认 armor_table 里的 id → **只有盔甲会被清，泥土/食物放着不动**；
 *   · 抹掉后 `putInBag` 又从 bagFirst 起塞 → 甲被挪到后面，第一格空着，于是"放一个清一个"。
 *   日志原话：`[dm34/guard] 从伪槽 0 号取出 minecraft:iron_chestplate`。
 *
 * ⚠ 这条链**不是 `replaceitem` 造成的**：`replaceitem slot.armor.X <n>` 的 `<n>` 是槽位参数，
 *   不是容器索引，它碰不到背包。真正能删背包格子的是 `Container.setItem(i, undefined)`，
 *   也就是上面那两个函数 —— 所以 `i` 的边界必须精确到 1。
 */
const BAG_FIRST = 1;                 // 0 号 = 马鞍槽，背包从 1 开始（她只有这一个伪槽）

export function bagFirstOf(bag) {
    // 只做一次合理性判断：容器读得到、格数不对劲时留个日志，结论仍然是 1。
    // 理由：0 号是马鞍位这件事由 `container_type: horse` + `equippable slot 0 = saddle` 决定，
    // 跟格数无关。改用"size - 36"之类的公式会算错（她的 inventory_size 是总格数，已含马鞍位）。
    try {
        const size = bag && bag.size;
        if (typeof size === "number" && size < 2) {
            glog(`容器格数异常 size=${size}，按 1 处理（0 号马鞍槽）`);
        }
    } catch (e) { /* 忽略 */ }
    return BAG_FIRST;
}

function comp(entity, id) {
    try {
        return entity.getComponent(id);
    } catch (e) {
        return undefined;
    }
}

function containerOf(entity) {
    const inv = comp(entity, "minecraft:inventory");
    return inv ? inv.container : undefined;
}

function readArmor(entity) {
    try {
        const raw = entity.getDynamicProperty(ARMOR_PROP);
        if (typeof raw !== "string" || !raw) return {};
        const o = JSON.parse(raw);
        return o && typeof o === "object" ? o : {};
    } catch (e) {
        return {};
    }
}

function writeArmor(entity, obj) {
    try {
        const keys = Object.keys(obj || {});
        if (!keys.length) entity.setDynamicProperty(ARMOR_PROP, undefined);
        else entity.setDynamicProperty(ARMOR_PROP, JSON.stringify(obj));
    } catch (e) { /* 忽略 */ }
}

/** 记下"这个槽由脚本装配 + 装的是什么"；传 undefined/falsy 表示擦掉 */
export function recordArmor(entity, slotName, itemOrId) {
    if (!slotName) return;
    const rec = readArmor(entity);
    if (itemOrId) rec[slotName] = typeof itemOrId === "string" ? { id: itemOrId } : itemOrId;
    else delete rec[slotName];
    writeArmor(entity, rec);
}

/** 当前记录（槽名 → 序列化物品） */
export function armorRecord(entity) {
    return readArmor(entity);
}

/** 擦掉某个槽的记录 */
export function forgetArmor(entity, slotName) {
    recordArmor(entity, slotName, undefined);
}

/** 清掉所有记录（卸甲时用） */
export function clearArmorRecord(entity) {
    writeArmor(entity, {});
}

// ── 残留盔甲工单（清不掉的白板甲） ──────────────────────────
// 附魔写不进 replaceitem 的 components，槽里只剩白件；清槽又可能只清了 0 号索引。
// 修好这两条也救不了存档里已有的脏甲，所以清不掉时把 {槽, 物品 id} 记在实体上，
// 巡检每轮重试，直到 hasitem 探不到。记 id 是因为槽读不到时只有它能当探针。
const GHOST_PROP = "dm34:armorghost";
const GHOST_MAX_TRIES = 15;          // 15 轮 × 20t ≈ 15 秒

function readGhosts(entity) {
    try {
        const raw = entity.getDynamicProperty(GHOST_PROP);
        if (typeof raw !== "string" || !raw) return [];
        const a = JSON.parse(raw);
        return Array.isArray(a) ? a.filter((x) => x && x.s && x.id) : [];
    } catch (e) {
        return [];
    }
}

function writeGhosts(entity, arr) {
    try {
        if (!arr || !arr.length) entity.setDynamicProperty(GHOST_PROP, undefined);
        else entity.setDynamicProperty(GHOST_PROP, JSON.stringify(arr));
    } catch (e) { /* 忽略 */ }
}

/** 记一条"这个槽里还有一件清不掉的甲"（幂等）。
 *  data = 序列化物品（新版工单带上它，巡检才能按实物身份去容器伪槽里挖）。
 *  老工单没有 data，只能按 id 清装备槽。 */
export function queueArmorGhost(entity, entries) {
    if (!entries || !entries.length) return;
    const cur = readGhosts(entity);
    for (const e of entries) {
        if (!e || !e.s || !e.id) continue;
        const hit = cur.find((x) => x.s === e.s && x.id === e.id);
        if (hit) {
            if (e.data && !hit.data) hit.data = e.data;    // 老工单补上身份
            continue;
        }
        const item = { s: e.s, id: e.id, n: 0 };
        if (e.data) item.data = e.data;
        cur.push(item);
    }
    writeGhosts(entity, cur);
}

/*
 * 列出「伪槽段」（`bagFirstOf` 之前那几格）里实际存在的东西。
 * 🔴 这只女仆 `bagFirstOf = 1` → **只扫索引 0，也就是马鞍槽**；索引 1 起是背包，绝不进来。
 *    马鞍槽里正常只有鞍（`ARMOR_SLOT[saddle]` 查不到 → `purgeStrayArmor` 不会动它）。
 *    这里曾经是 2，等于把背包第 1 格也当伪槽 —— 玩家放进去的甲就是被这条路径抹掉的。
 * @returns {Array<{i:number, item:*}>}
 */
export function pseudoSlotItems(entity) {
    const out = [];
    const c = containerOf(entity);
    if (!c) return out;
    try {
        const size = c.size;
        const last = Math.min(bagFirstOf(c), size);
        for (let i = 0; i < last; i++) {
            let it;
            try { it = c.getItem(i); } catch (e) { it = undefined; }
            if (it) out.push({ i, item: it });
        }
    } catch (e) { /* 忽略 */ }
    return out;
}

/** 清掉伪槽的某一格（读回校验）。 */
export function clearPseudoSlot(entity, index) {
    const c = containerOf(entity);
    if (!c || typeof index !== "number") return false;
    try {
        c.setItem(index, undefined);
        return !c.getItem(index);
    } catch (e) {
        return false;
    }
}

/** 当前挂着的残留甲工单里，涉及哪些槽名（"Head" 等）。 */
export function armorGhostSlots(entity) {
    return readGhosts(entity).map((g) => g.s);
}

/*
 * 宽松指纹（不含耐久）：只比 id / 名字 / lore / 附魔。
 * 甲穿在身上会被打掉耐久，记录里那份 dmg 是穿上去那一刻的快照，按它比对永远对不上。
 * （这个函数目前只被"伪槽段"用到，而伪槽段在这只女仆上是空的；留着以便容器变大后复用。）
 */
function sigLooseOf(data) {
    if (!data || !data.id) return "";
    const ench = (data.ench || [])
        .map((p) => `${p && p[0]}:${p && p[1]}`)
        .sort()
        .join(",");
    const lore = (data.lore || []).join("\u0001");
    return `${data.id}|${data.name || ""}|${lore}|${ench}`;
}

/*
 * 按实物身份（id/名字/lore/附魔等价，耐久不比快照）从「伪槽段」取出那件甲。
 * 🔴 这只女仆 `bagFirstOf = 1` → `last = 1`，**只扫索引 0（马鞍槽）**，索引 1 起是背包、绝不进来。
 *    历史用途是「重进世界后胸甲落到容器伪槽，`replaceitem slot.armor.chest … air` 清不到也看不见」；
 *    现在唯一的伪槽是马鞍位，里面只可能有鞍，所以本函数实际不会动任何东西。
 *    ⚠ 边界必须是 1：写成 2 就会扫到索引 1 = 玩家看到的第一格，`setItem(i, undefined)` 直接抹掉
 *      —— 那就是「卸一次甲、背包第一格空一格，再往里放甲还被清」的现场。
 * @returns {*} 取到的 ItemStack（undefined = 伪槽段里没有等价的）
 */
export function takeSameFromPseudoSlots(entity, data) {
    if (!data || !data.id) return undefined;
    const c = containerOf(entity);
    if (!c) return undefined;
    const want = sigLooseOf(data);
    try {
        const size = c.size;
        const last = Math.min(bagFirstOf(c), size);     // 只到伪槽为止（不含背包段）
        for (let i = 0; i < last; i++) {
            let cur;
            try { cur = c.getItem(i); } catch (e) { cur = undefined; }
            if (!cur || cur.typeId !== data.id) continue;
            if (sigLooseOf(serializeItem(cur)) !== want) continue;
            try {
                c.setItem(i, undefined);
                if (c.getItem(i)) continue;             // 写不进去 → 找下一格
            } catch (e) { continue; }
            glog(`从伪槽 ${i} 号取出 ${data.id}`);
            return cur;
        }
    } catch (e) { /* 忽略 */ }
    return undefined;
}

/*
 * 强清一件甲：① 按槽全索引 air ② 按实物身份挖伪槽 ③ 复核是否真的离身。
 * 三段缺一不可：① 解决实体装备槽，② 解决 horse 1 号伪槽，③ 决定要不要继续挂工单。
 * 读不到的东西一律不动（宁留不吞）：伪槽只抹全字段等价的那一件，背包段一个字节都不碰。
 * @param {string} slotName "Head"/"Chest"/"Legs"/"Feet"｜@param {*} data 记录里的序列化物品
 * @returns {{cleared: boolean, item: *}} item = 从伪槽挖出的真件（优先用它返还，别重建）
 */
export function forceClearArmorSlot(entity, slotName, data) {
    const typeId = data && data.id;
    const slot = EquipmentSlot[slotName];

    // ① 实体装备槽（replaceitem 全索引 + SAPI 兜底）
    if (slot !== undefined) {
        try { clearSlot(entity, slot, typeId); } catch (e) { /* 槽没声明 */ }
    }
    if (!typeId) return { cleared: true, item: undefined };

    // ② 伪槽里的实物（探针看不见的落点只有这一条能清）
    const taken = takeSameFromPseudoSlots(entity, data);

    // ③ 复核：装备槽探针 / 全实体探针（后者会和背包同款撞车，用 hasLooseInBag 抵掉）
    let stillSlot = false;
    try { stillSlot = cmdHasItem(entity, slotName, typeId); } catch (e) { stillSlot = false; }

    let anywhere = false;
    try { anywhere = cmdHasAnywhere(entity, typeId); } catch (e) { anywhere = false; }

    const bagHasIt = hasLooseInBag(entity, data);
    const bodyLeft = stillSlot || (anywhere && !bagHasIt && !taken);

    return { cleared: !bodyLeft, item: taken };
}

/**
 * 重试清理残留盔甲
 * @returns {number} 这一轮清掉几件
 */
export function processArmorGhosts(entity) {
    const list = readGhosts(entity);
    if (!list.length) return 0;

    const left = [];
    let cleared = 0;

    for (const g of list) {
        const slot = EquipmentSlot[g.s];
        if (slot === undefined) continue;

        // 这个槽已经有记录 = 玩家重新装了甲（可能是同款）→ 旧工单作废。
        // 同 id 也算重装：分不清「还是原来那件」和「又穿了一件同款」，
        // 继续清就会"装了自动卸"，循环往复。
        if (readArmor(entity)[g.s]) continue;

        // 工单里存了实物身份（新版）就三段全走；老工单只有 id，只能清槽。
        if (g.data) {
            const r = forceClearArmorSlot(entity, g.s, g.data);
            if (r.cleared) {
                cleared++;
                // 挖出来的那件不再入包：登记工单时玩家已按记录拿到等价补偿，
                // 这件是同一件的影子，再塞进去就是永远多一件。只留日志备查。
                glog(`残留盔甲已清除：${g.s} ${g.id}` + (r.item ? `（伪槽里的影子件已销毁）` : ""));
                continue;
            }
        } else if (clearSlot(entity, slot, g.id)) {
            cleared++;
            glog(`残留盔甲已清除：${g.s} ${g.id}`);
            continue;
        }
        g.n = (g.n || 0) + 1;
        if (g.n <= GHOST_MAX_TRIES) {
            left.push(g);
        } else {
            // 到点还清不掉：留着工单没意义（每轮刷屏），但必须让人知道
            glog(`残留盔甲清不掉：${g.s} ${g.id}（试了 ${GHOST_MAX_TRIES} 轮，可能需要重进世界）`);
        }
    }

    writeGhosts(entity, left);
    return cleared;
}

/** 数一数她的背包里有几件这个 id（只统计背包段，不含装备槽） */
export function countInBag(entity, typeId) {
    const c = containerOf(entity);
    if (!c) return 0;
    let n = 0;
    try {
        const size = c.size;
        const first = bagFirstOf(c);
        for (let i = first; i < size; i++) {
            let cur;
            try { cur = c.getItem(i); } catch (e) { cur = undefined; }
            if (cur && cur.typeId === typeId) n += cur.amount || 1;
        }
    } catch (e) { /* 忽略 */ }
    return n;
}

/**
 * 从她背包取出指定 id 的物品（整格取出）。返回 ItemStack，没有则 undefined。
 * 只在「写槽确实成功」后调用，取走 putInBag 存的那份，否则同一件甲变两份。
 */
export function takeOneFromBag(entity, typeId) {
    const c = containerOf(entity);
    if (!c) return undefined;
    try {
        const size = c.size;
        const first = bagFirstOf(c);
        for (let i = first; i < size; i++) {
            let cur;
            try { cur = c.getItem(i); } catch (e) { cur = undefined; }
            if (!cur || cur.typeId !== typeId) continue;
            try { c.setItem(i, undefined); } catch (e) { continue; }
            return cur;
        }
    } catch (e) { /* 忽略 */ }
    return undefined;
}

/*
 * 背包里是否有身份等价的一件（不比耐久）。只给「清槽复核」用，不参与要不要返还 ——
 * 卸甲是否归还只看记录里的 carrier（见 equip.js）。这里只判断「全实体探针命中的是不是
 * 背包里本来就有的那件」，耐久快照天然对不上，所以必须去 dmg 比。
 */
function hasLooseInBag(entity, data) {
    if (!data || !data.id) return false;
    const c = containerOf(entity);
    if (!c) return false;
    const want = sigLooseOf(data);
    try {
        const size = c.size;
        const first = bagFirstOf(c);
        for (let i = first; i < size; i++) {
            let cur;
            try { cur = c.getItem(i); } catch (e) { cur = undefined; }
            if (!cur || cur.typeId !== data.id) continue;
            if (sigLooseOf(serializeItem(cur)) === want) return true;
        }
    } catch (e) { /* 忽略 */ }
    return false;
}

/**
 * 只往她背包里塞，绝不落地。返回是否塞进去（false = 拿不到容器 或 背包满）。
 * 与 moveToBag 分开，调用方才能区分「进包」和「掉地上」。
 */
export function putInBag(entity, itemStack) {
    if (!itemStack) return false;
    const c = containerOf(entity);
    if (!c) return false;
    try {
        const size = c.size;
        const first = bagFirstOf(c);
        for (let i = first; i < size; i++) {
            let cur;
            try { cur = c.getItem(i); } catch (e) { cur = undefined; }
            if (cur) continue;
            try {
                c.setItem(i, itemStack);
            } catch (e) { continue; }   // 换下一格
            // 火把进包立刻开灯，别等兜底巡检。刷新失败不影响入包结果。
            if (itemStack.typeId === TORCH_ID) {
                try { refreshTorchTag(entity); } catch (e) { /* 忽略 */ }
            }
            return true;
        }
    } catch (e) { /* 满 */ }
    return false;
}

/** 塞回她的容器；满了掉在她脚下。返回是否塞进了容器 */
export function moveToBag(entity, itemStack) {
    if (!itemStack) return false;
    if (putInBag(entity, itemStack)) return true;
    try {
        entity.dimension.spawnItem(itemStack, entity.location);
    } catch (e) { /* 忽略 */ }
    return false;
}

/*
 * 换甲后回收引擎掉的旧甲。
 * 原生 `equip_item_slot` 换装时用 `drop_item_slot` 把旧甲丢在她脚边，没人捡就 5 分钟后消失，
 * 表现为「胸甲没了」。只在换装后 1 tick 调一次，半径 2.5 格、只收一件、只认一个 typeId，
 * 避免误收玩家自己丢的同类。
 */
export function reclaimGroundArmor(entity, typeId) {
    if (!entity || !typeId) return;
    system.runTimeout(() => {
        let alive = false;
        try { alive = entity.isValid; } catch (e) { alive = false; }
        if (!alive) return;

        let list = [];
        try {
            list = entity.dimension.getEntities({
                type: "minecraft:item",
                location: entity.location,
                maxDistance: 2.5,
            });
        } catch (e) { return; }

        for (const it of list) {
            let stack;
            try { stack = it.getComponent("minecraft:item")?.itemStack; } catch (e) { stack = undefined; }
            if (!stack || stack.typeId !== typeId) continue;

            // 先摘实体再入包：少了这步，同一件会同时躺在地上和背包里
            try { it.remove(); } catch (e) { continue; }
            if (!putInBag(entity, stack)) {
                try { entity.dimension.spawnItem(stack, entity.location); } catch (e) { /* 忽略 */ }
                return;
            }
            glog(`换甲回收：${typeId} 已收回她的背包`);
            return;
        }
    }, 1);
}

/*
 * 火把 → is_lighting 标签，并由脚本驱动发光（单一所有者）。
 * 背包任意一格有 torch → 加标签 + 每 2 tick 执行 /function dynamic_light；拿出 → 摘标签 + 清光源。
 * has_torch 主动摘掉，让旧 AC 停在 default，避免两边抢着 fill。
 * RP 读脚本标签不可靠（同步 + 重载两道关，静默失效），所以整条链路放 BP。
 */
const TORCH_TAG = "has_torch";      // 旧 AC 用的开关，保留常量但不再添加
const LIGHT_TAG = "is_lighting";    // 真正的开关：guard.js + element/light.js 共用

/** 光源刷新频率（tick），与 light.js 的清理频率保持一致 */
const LIGHT_INTERVAL_TICKS = 2;

/** 火把轮询间隔（tick）。10 = 0.5 秒 —— 见 hasTorchInBag 的说明：引擎不给"容器变化"
 *  事件，只能轮询，而常态每轮只读一次 emptySlotsCount，成本与频率无关。 */
const TORCH_POLL_TICKS = 10;

/** 当前"手里有火把"的女仆缓存：entityId → Entity（20 tick 由巡检刷新） */
const litUnits = new Map();

/** 火把扫描结论缓存：entityId → { empty, size, slot }（slot = -1 表示没有） */
const torchScanCache = new Map();

/*
 * 背包任意一格（含伪槽）有火把。
 * 引擎没有「容器变化」事件，只能轮询。为不每轮扫 36 格，用 `emptySlotsCount` 判断这一轮
 * 有没有增删：空槽数变了 → 全扫；没变且上次没火把 → 结论仍成立；没变且上次有火把 → 必须
 * 再验那个槽位（拿走火把、塞进木棍，净空槽不变），验槽失败退回全扫。
 * 最坏永远全扫一遍，不会漏判；常态是 1 次 emptySlotsCount（+ 有火把时 1 次 getItem）。
 * 读不到 `emptySlotsCount`（老版本）时不写缓存 —— 否则 -1 === -1 会让它永远命中。
 */
function hasTorchInBag(entity) {
    const bag = containerOf(entity);
    if (!bag) return false;

    let size = 0, empty = -1;
    try {
        size = bag.size || 0;
        empty = bag.emptySlotsCount;
    } catch (e) { return false; }

    let id;
    try { id = entity.id; } catch (e) { return false; }

    const rec = torchScanCache.get(id);
    if (rec && empty >= 0 && rec.empty === empty && rec.size === size) {
        if (rec.slot < 0) return false;
        let it;
        try { it = bag.getItem(rec.slot); } catch (e) { it = undefined; }
        if (it && it.typeId === TORCH_ID) return true;
        // 那一格换了东西（或火把被挪走）→ 下面全扫
    }

    let slot = -1;
    for (let i = 0; i < size; i++) {
        let it;
        try { it = bag.getItem(i); } catch (e) { it = undefined; }
        if (it && it.typeId === TORCH_ID) { slot = i; break; }
    }
    if (empty >= 0) torchScanCache.set(id, { empty, size, slot });
    return slot >= 0;
}

/** 清掉她周围 5×5×5 的临时光源 */
function clearLightAround(entity) {
    try {
        entity.runCommand("fill ~-2 ~-1 ~-2 ~2 ~3 ~2 air replace block:dm_light_1");
    } catch (e) { /* 实体已消失 / 区块卸载 */ }
}

/*
 * 脚下是不是土径。
 * 不在 mcfunction 里判：本版本可能叫 grass_path，未知方块 id 会让整个函数加载失败
 * （连清理命令都不执行，且没有日志）。放脚本里写错只是判不中。
 */
const DIRT_PATH_IDS = ["minecraft:dirt_path", "minecraft:grass_path"];

function standOnDirtPath(entity) {
    let loc;
    try { loc = entity.location; } catch (e) { return false; }

    try {
        const b = entity.dimension.getBlock({
            x: Math.floor(loc.x),
            y: Math.floor(loc.y),
            z: Math.floor(loc.z),
        });
        if (b && b.typeId) return DIRT_PATH_IDS.includes(String(b.typeId));
    } catch (e) { /* 区块没加载 → 走下面的兜底 */ }

    // 兜底：15/16 高的方块会让 floor(y) 落到本体格，小数部分是 0.9375。
    // 站普通方块时 y 是整数 → 0。
    return loc.y - Math.floor(loc.y) > 0.5;
}

/** 在她脚边放光源（dynamic_light* 内部就是清旧 + 放新）。
 *  土径上走 _high（放 ~2，避免压成泥土），其余走 dynamic_light（~1）。 */
function pulseLight(entity) {
    let fn = "dynamic_light";
    try { if (standOnDirtPath(entity)) fn = "dynamic_light_high"; } catch (e) { /* 忽略 */ }
    try {
        entity.runCommand(`function ${fn}`);
    } catch (e) { /* 实体已消失 / 区块卸载 */ }
}

export function refreshTorchTag(entity) {
    const has = hasTorchInBag(entity);

    let tagged;
    try { tagged = entity.hasTag(LIGHT_TAG); } catch (e) { return; }

    // 旧 AC 的开关永远清掉：发光已经全在脚本侧，别让两边抢着放光源
    try {
        if (entity.hasTag(TORCH_TAG)) entity.removeTag(TORCH_TAG);
    } catch (e) { /* 忽略 */ }

    let id;
    try { id = entity.id; } catch (e) { return; }

    if (has === tagged) {
        // 状态没变，只维持缓存（她可能被 tp / 重新加载过）
        if (has) litUnits.set(id, entity);
        else litUnits.delete(id);
        return;
    }

    try {
        if (has) {
            entity.addTag(LIGHT_TAG);
            litUnits.set(id, entity);
            // 立刻给一次光，别等 2 tick 后的循环
            pulseLight(entity);
        } else {
            entity.removeTag(LIGHT_TAG);
            litUnits.delete(id);
            clearLightAround(entity);
        }
    } catch (e) {
        return;     // 实体刚消失 / 维度卸载
    }

    // 带上 id：同屏多只女仆时，光看 typeId 会把"两只状态不同"误读成"同一只在反复开关"
    glog(`火把${has ? "入手" : "离手"} → 灯光${has ? "开" : "关"}（${entity.typeId} #${id}）`);
}

// ── 主手替身守卫 ─────────────────────────────────────────────────────
// 她手上那件是**替身**：真件在记录里（dm34:hoe / dm34:gtool / dm34:weapon）。
// 替身会在三种情况下变回原样或消失：
//   ① farm 组的 `minecraft:equipment`（loot_tables/iron_hoe.json）在组结算时把主手刷成铁锄；
//   ② 重进世界 / 球放出来，实体重新加载，槽位重新结算；
//   ③ 她拿武器打架，替身掉耐久。
// 交互时那几次重摆覆盖不到 ②③，所以巡检里补一道"只在不对的时候才动"的守卫。

/** 战斗形态（替身是武器） */
const WEAPON_STATE_KEYS = new Set(["sword", "bow", "crossbow", "spear"]);
/** 连续摆失败这么多次就停手（说明引擎每次都把主手刷回去，再抢只会闪） */
const REPAIR_LIMIT = 5;
/** 摆失败计数：entityId → { key, n } */
const repairFails = new Map();

/**
 * 把她主手那件替身修回记录里那一件。
 * 只在她**正处在该状态**且**有记录**时动手；余额（记录缺失）交给交互时的 reclaimOrphan。
 */
export function repairToolDisplay(entity) {
    if (!CONFIG.farm.repaintGuard) return false;
    let st;
    try { st = resolveState(entity); } catch (e) { return false; }
    if (!st) return false;

    const key = st.key;

    if (WEAPON_STATE_KEYS.has(key)) {
        // 武器替身不需要"修"，refreshWeaponDisplay 内部按 typeId 比对，不同才重摆
        try { refreshWeaponDisplay(entity); } catch (e) { /* 忽略 */ }
        return true;
    }

    let want = false;
    if (key === "farm") want = hasFarmTool(entity);
    else if (key === "dm_mine" || key === "dm_chop") want = !!storedGatherTool(entity);
    if (!want) return false;                       // 没记录 = 没东西可摆（交互时由 reclaimOrphan 处理）

    const fail = repairFails.get(entity.id);
    if (fail && fail.key === key && fail.n >= REPAIR_LIMIT) return false;   // 已判定抢不过，别再抢

    let ok = false;
    try {
        ok = key === "farm" ? restoreFarmDisplay(entity) : restoreGatherDisplay(entity);
    } catch (e) { ok = false; }

    if (ok) {
        if (fail) repairFails.delete(entity.id);
        return true;
    }

    const rec = fail && fail.key === key ? fail : { key, n: 0 };
    rec.n += 1;
    repairFails.set(entity.id, rec);
    if (rec.n === REPAIR_LIMIT) {
        try {
            console.warn(`[dm34/guard] ${key} 主手替身连续 ${REPAIR_LIMIT} 次摆不上 → 停手：` +
                `这多半是组里的 minecraft:equipment 每次结算都把主手刷回去`);
        } catch (e) { /* 忽略 */ }
    }
    return false;
}

/** 装守卫：定时巡检 + 实体加载时补扫一次 */
export function initGuard() {
    if (!CONFIG.guard.enabled) return;

    // 启动横幅：以后"火把不亮"这类问题，先看这行有没有出现。默认打开，不受 CONFIG.log.console 管辖
    try {
        console.warn(`[dm34/guard] 巡检已启动：火把轮询 ${TORCH_POLL_TICKS}t、残留甲 ${CONFIG.guard.intervalTicks}t、光源刷新 ${LIGHT_INTERVAL_TICKS}t`);
    } catch (e) { /* 忽略 */ }

    try {
        world.afterEvents.entityLoad.subscribe((ev) => {
            const e = ev.entity;
            if (!MAID_IDS.includes(e.typeId)) return;
            // 重载前的扫描结论不可信（背包可能被外部指令改过），先丢再刷
            try { torchScanCache.delete(e.id); } catch (err) { /* 忽略 */ }
            // 等一 tick，让原版的拾取/装备结算完再扫
            system.runTimeout(() => {
                try { refreshTorchTag(e); } catch (err) { /* 忽略 */ }
                try { processArmorGhosts(e); } catch (err) { /* 忽略 */ }
                // 重进世界：槽位会重新结算一次，farm 组的铁锄会把替身盖掉 —— 这里补回去
                try { repairToolDisplay(e); } catch (err) { /* 忽略 */ }
            }, 2);
            // 组结算/槽位重建常常晚于 +2t，再补一枪（repairToolDisplay 幂等）
            system.runTimeout(() => {
                try { repairToolDisplay(e); } catch (err) { /* 忽略 */ }
            }, 10);
        });
    } catch (e) { /* 忽略 */ }

    // 实体销毁后把扫描缓存清掉，否则 Map 会随"放置—收回"次数一直长
    try {
        world.afterEvents.entityRemove.subscribe((ev) => {
            const id = ev.removedEntityId !== undefined ? ev.removedEntityId : (ev.entity && ev.entity.id);
            if (id === undefined) return;
            try { torchScanCache.delete(id); } catch (err) { /* 忽略 */ }
            try { repairFails.delete(id); } catch (err) { /* 忽略 */ }
        });
    } catch (e) { /* 忽略 */ }

    // 火把独立跑 10t。玩家在她背包 UI 里取放、原版拾取都发不出任何事件，
    // 轮询是唯一手段；常态一轮只读一次 emptySlotsCount，所以频率可以给高。
    system.runInterval(() => {
        forEachMaid((e) => {
            try { refreshTorchTag(e); } catch (err) { /* 单只出错不影响其它 */ }
        });
    }, TORCH_POLL_TICKS);

    // 残留甲工单：只有卸甲/换甲清不掉时才有内容，空工单早退，20t 足够。
    // 同一轮顺手守一下主手替身（耕地/采集/战斗各自比对一次，对不上才重摆）。
    system.runInterval(() => {
        forEachMaid((e) => {
            try { processArmorGhosts(e); } catch (err) { /* 单只出错不影响其它 */ }
            try { repairToolDisplay(e); } catch (err) { /* 单只出错不影响其它 */ }
        });
    }, CONFIG.guard.intervalTicks);

    // 容器取证入口：`/scriptevent dm34:bag`。
    // 只读取证，不改任何东西。2026-11-20 那次「背包第 1 格被清」的排查里，半天都卡在
    // "容器第 0 格到底是背包格还是马鞍槽"这个没人验证过的假设上 —— 用这条命令一眼看穿：
    //   · `size=36 背包起=0` → 36 格全是箱子格，索引 0 就是玩家 UI 的第一格（马鞍槽不在容器里）
    //   · 前 4 格的实际内容 + 有没有鞍（`is_saddled`）→ 装鞍后鞍会不会出现在容器里
    try {
        system.afterEvents.scriptEventReceive.subscribe((ev) => {
            if (ev.id !== "dm34:bag") return;
            const lines = [];
            forEachMaid((e) => {
                const c = containerOf(e);
                let size = -1;
                const parts = [];
                if (c) {
                    try { size = c.size; } catch (err) { size = -1; }
                    const n = Math.min(4, size > 0 ? size : 0);
                    for (let i = 0; i < n; i++) {
                        let it;
                        try { it = c.getItem(i); } catch (err) { it = undefined; }
                        parts.push(`${i}=${it ? `${it.typeId}×${it.amount || 1}` : "空"}`);
                    }
                }
                let saddled = false;
                try { saddled = e.hasComponent("minecraft:is_saddled"); } catch (err) { saddled = false; }
                lines.push(`${e.typeId} size=${size} 背包起=${c ? bagFirstOf(c) : "-"} 鞍=${saddled ? 1 : 0} [${parts.join(" ") || "无容器"}]`);
            });
            const text = lines.length ? lines.join(" || ") : "没有已加载的女仆";
            try { console.warn(`[dm34/bag] ${text}`); } catch (err) { /* 忽略 */ }
            try {
                const p = ev.sourceEntity;
                if (p && typeof p.sendMessage === "function") p.sendMessage(`§7[容器] ${text}`);
            } catch (err) { /* 忽略 */ }
        });
    } catch (e) { /* 旧版没有 scriptEventReceive */ }

    // 光源跟随：只跑手里有火把的，每 2 tick 一次（接管原 AC 的 glow_pulse）。    // 删的是当前项，直接迭代安全；没人拿火把时整轮只是一次 size 判断。
    system.runInterval(() => {
        if (litUnits.size === 0) return;

        for (const [id, e] of litUnits) {
            let alive = false;
            try { alive = !!e.isValid; } catch (err) { alive = false; }
            if (!alive) {
                litUnits.delete(id);
                clearLightAround(e);    // 她没了，但地上那块光要收掉
                continue;
            }
            pulseLight(e);
        }
    }, LIGHT_INTERVAL_TICKS);
}
