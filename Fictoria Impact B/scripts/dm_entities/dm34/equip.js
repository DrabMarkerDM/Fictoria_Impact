/*
 * equip.js — 盔甲装配 / 卸下（dm34 / dm34_1 通用）。
 * 手持什么甲就装什么，附魔/耐久/名字原样带过去；槽位靠 armor_table 查表（SAPI 没有物品级
 * wearable 组件）。不依赖 equippable 声明盔甲槽，归还一律 dropItemNear。
 * 卸甲只认记录里的 carrier 这一本账：carrier=bag → 实物在背包，只清槽 + 清记录、不动实物；
 * 其余（含无 carrier 的老记录）→ 一律清槽 + 归还。
 * 判据不能掺「背包里有没有同款」：她身上一件、玩家背包里再放一件同款同耐久同附魔，那个判据
 * 必然成立，槽里那件被 air 掉就净少一件。
 */

import { EquipmentSlot } from "@minecraft/server";
import { ARMOR_SLOT, looksLikeArmor } from "./armor_table.js";
import { placeItem, clearSlot, readSlot, serializeItem, deserializeItem, dropItemNear, takeMainhand } from "./slot_io.js";
import {
    recordArmor, armorRecord, forgetArmor, clearArmorRecord,
    queueArmorGhost, processArmorGhosts, moveToBag, putInBag,
    forceClearArmorSlot, pseudoSlotItems, clearPseudoSlot, armorGhostSlots,
} from "./guard.js";
import { CONFIG } from "./config.js";

const ARMOR_ORDER = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet];

function comp(entity, id) {
    try {
        return entity.getComponent(id);
    } catch (e) {
        return undefined;
    }
}

function mainhandOf(player) {
    try {
        const eq = comp(player, "minecraft:equippable");
        return eq ? eq.getEquipment(EquipmentSlot.Mainhand) : undefined;
    } catch (e) {
        return undefined;
    }
}

// 归还唯一出口是 slot_io.dropItemNear()；不写玩家背包（会出幽灵槽）。

/*
 * 消耗玩家主手 1 个（创造模式不消耗）—— 全工程唯一入口。
 * 实现下沉到 slot_io.takeMainhand()：SAPI 写玩家那格会出幽灵槽，只能走命令。
 * @param {string} [itemId] 期望手上的物品 id
 */
export function consumeHand(player, itemId) {
    if (isCreative(player)) return false;
    return takeMainhand(player, itemId, 1);
}

export function isCreative(player) {
    try {
        return player.getGameMode() === "Creative";
    } catch (e) {
        return false;
    }
}

/** 手持物对应的装备槽名（"Head" 等）；不是盔甲返回 undefined */
export function armorSlotOf(itemId) {
    if (!itemId) return undefined;
    return ARMOR_SLOT[itemId];
}

/**
 * 装盔甲：把玩家手上那件装到她对应槽位，**旧件掉在玩家脚下**
 * @returns {boolean} 是否真的处理了（false = 手持不是盔甲）
 */
export function equipArmor(player, entity) {
    const hand = mainhandOf(player);
    if (!hand) return false;
    const slotName = armorSlotOf(hand.typeId);
    if (!slotName) {
        // 表里没有，但标签说是盔甲 —— 说清楚，别让它悄悄当成普通物品
        if (looksLikeArmor(hand)) {
            // 玩家反馈，不受 CONFIG.log 总闸管辖：关掉等于把失败原因藏了
            try { player.sendMessage("§c这件盔甲我认不出该穿哪个部位（可以登记进 armor_table）"); } catch (e) { /* 忽略 */ }
            return true;
        }
        return false;
    }

    const slot = EquipmentSlot[slotName];
    if (slot === undefined) return false;

    // 先取旧件：能读就读，读不到就用上次记下的那份（卸的时候也一样，保证"原样返还"）
    const rec = armorRecord(entity);
    const cur = readSlot(entity, slot);
    const prevData = rec[slotName];

    const ok = placeItem(entity, slot, hand);
    if (!ok) {
                // 引擎槽可能根本写不进去（马铠槽已从 JSON 删除），不影响语义：
                // 甲照样记进 dm34:armor，卸下按记录归还；外观由 RP 固定渲染。
        if (CONFIG.log.debug && CONFIG.log.console) {
            console.warn(`[dm34/equip] ${slotName} ${hand.typeId} 引擎槽写不进去（马铠槽已删），只按记录装备`);
        }
    }

    // 记下"这个槽由脚本装配 + 装的是什么"（守卫据此区分"玩家给的甲"和"她自己捡的甲"）
    recordArmor(entity, slotName, serializeItem(hand));

    // 旧件先塞进她的背包，背包满才掉脚下；她那边上下文坏了才退回玩家脚下。
    // 不能直接掉地上：`placeItem` 用 replaceitem/SAPI 覆盖槽位，被替换的旧甲会被引擎
    // 直接销毁（不是掉落），这里是唯一的归还出口 —— 掉地上等于换一次甲丢一次。
    // 引擎通道（nativeArmor）的旧甲由 reclaimGroundArmor 收进背包，两条路行为一致。
    // 优先用记录还原：命令写不进 lore/名字，记录里那份才是原物。
    const old = deserializeItem(prevData) || cur;
    if (old) {
        let inBag = false;
        try { inBag = putInBag(entity, old); } catch (e) { inBag = false; }
        if (!inBag && !dropItemNear(entity, old)) dropItemNear(player, old);
    }
    consumeHand(player, hand.typeId);

    try {
        entity.dimension.playSound("armor.equip_iron", entity.location, { volume: 0.8, pitch: 1.0 });
    } catch (e) { /* 忽略 */ }

    if (CONFIG.log.debug && CONFIG.log.console) console.warn(`[dm34/equip] 装备 ${hand.typeId} → ${slotName}`);
    return true;
}

/*
 * 卸下全部盔甲，原样塞进她的背包（满则掉脚下；Maid_Command 用）。
 * 清槽走「装备槽全索引 air + 伪槽实物 + 双探针复核」，复核不过就登记残留工单交给 guard，
 * 不允许「记录已抹掉、甲还挂在身上」。
 * @param {*} [report] 传对象进来 → 回填 `stuck`（没清干净的槽名数组），调用方据此提示玩家
 * @returns {number} 卸下几件
 */
export function removeAllArmor(player, entity, report) {
    const rec = armorRecord(entity);
    let n = 0;
    let kept = 0;          // 甲本来就在背包里、记录必须留着的槽数
    const ghosts = [];
    const stuck = [];      // 复核没过的槽：记录已抹、实物还挂着
    const known = {};      // 槽名 → 这一轮该槽涉及的 item id（兜底清扫时用来验证清没清掉）

    for (const slot of ARMOR_ORDER) {
        const slotName = String(slot);
        const cur = readSlot(entity, slot);
        const data = rec[slotName];
        if (!cur && !data) continue;

        // 该还的是哪件：**记录优先**（记录里带附魔/名字/耐久，槽里那件可能只是白件）
        const item = deserializeItem(data) || cur;
        const typeId = item ? item.typeId : undefined;
        if (typeId) known[slotName] = typeId;

        // carrier=bag 表示这件是放置时 putInBag 塞进背包的，从没进过槽。
        // 按记录重建就是凭空印一件；这里只清槽 + 清记录，实物留在背包。
        if (data && data.carrier === "bag") {
            clearSlot(entity, slot, typeId);
            forgetArmor(entity, slotName);
            kept++;
            continue;
        }

        // 这里**不许**再拿「背包里有没有等价的一件」当判据。
        // mob 的 equippable 恒读不到（readSlot 恒空，cur 在这里永远是 undefined），
        // 而玩家背包里放着一件同款、同耐久、同附魔的甲时，这个判据必然为真 ——
        // 于是走「只清槽不归还」，槽里那件被 air 掉，包里的仍是原来那件，净少一件。
        // 唯一可信的账是 carrier：往她背包里放甲的每条路（收球放置）都写了 carrier=bag，
        // 没写 carrier 就说明这件还在槽里，必须走下面的 forceClear + 归还。
        // 代价：极老的存档若记录已抹、实物却在背包里，会多还一件 —— 宁可多给，不许吞。

        // 强清：装备槽全索引 air + 按实物身份挖 horse 伪槽，再用两种探针复核。
        // 单靠 replaceitem 会漏 —— 重进世界后胸部甲会落在容器 1 号（马铠位），
        // 那个位置既不吃 slot.armor.chest 的 air，也不被 location 探针看见，
        // 结果就是「提示卸了 2 件、背包里也有 2 件，身上那件永远脱不下来」。
        const res = forceClearArmorSlot(entity, slotName, data || serializeItem(item));
        forgetArmor(entity, slotName);

                // 伪槽挖出来的那件是真件（耐久/附魔都在），优先用它返还。
                // res.item 拿到实物时**不要再动 item** —— 那是同一件，两边都给就是一件变两件。
        const give = res.item || item;
        if (give) {
            // 清不掉也照还：探针分不清「真在槽里」和「背包有同款」，扣着就变成吞件。
            // 宁可多给一件，也不能让玩家卸完甲什么都没拿到。
            if (!moveToBag(entity, give)) {
                if (!dropItemNear(entity, give)) dropItemNear(player, give);
            }
            n++;
        }

        // 复核没过 → 记工单（带上实物身份，巡检才能按等价去挖伪槽）+ 报给调用方。
        // 只按 clearSlot 的返回值登记是不够的：mob 的 location 探针本来就是瞎的，
        // "清不掉"会一直没人上报，外面只看到"她身上没有盔甲"。
        if (!res.cleared && typeId) {
            ghosts.push({ s: slotName, id: typeId, data: data || serializeItem(give) });
            stuck.push(slotName);
        }
    }

        // 第二轮补扫：只清「这一轮确实有记录 / 读得到实物」的槽。
        // **绝不再无条件 air 四个槽**：mob 的 equippable 读不到（readSlot 恒 undefined），
        // 一个既没记录、槽里却真挂着一件的槽，被 air 掉就是「既不入包也不落地」的凭空销毁。
        // 宁可留着（她身上那件还能靠引擎继续生效/收球时另想办法），也不能吞玩家的东西。
    for (const slot of ARMOR_ORDER) {
        const slotName = String(slot);
        const cur = readSlot(entity, slot);
        const typeId = known[slotName] || (cur ? cur.typeId : undefined);
        if (!typeId) continue;                       // 无记录、读不到 → 不动
        if (clearSlot(entity, slot, typeId)) continue;
        ghosts.push({ s: slotName, id: typeId, data: rec[slotName] });
    }

    if (ghosts.length) {
        queueArmorGhost(entity, ghosts);
        processArmorGhosts(entity);        // 立刻再清一轮，多数情况一次就好
    }

    if (n) {
                // 有「甲本来就在背包」的槽时不许整表清空：记录是收球时唯一能读到甲的地方，
                // 抹掉就成了「甲留在背包、球是空的」。
        if (!kept) clearArmorRecord(entity);
        try {
            entity.dimension.playSound("armor.unequip_iron", entity.location, { volume: 0.8, pitch: 1.0 });
        } catch (e) { /* 忽略 */ }
    }

    // 有卡住的槽就**不能**报"取下 N 件"了事：记录已抹、实物还在，玩家必须知道
    if (report) {
        try { report.stuck = stuck.slice(); } catch (e) { /* 忽略 */ }
    }
    return n;
}

/*
 * 变形前把身上的甲全脱下来掉在脚下（War Cross / Gentle Cross 用）。
 * 必须自己做：`minecraft:transformation` 整只替换实体，容器靠 `drop_inventory: true` 落地，
 * 但装备槽不属于 inventory，甲会随旧实体一起消失；这条路上没有球、没有记录可存，只能当场
 * 把实物挖出来还给地上（dropItemNear）。
 * 与 `removeAllArmor` 的差别只有一处：进背包 vs 掉脚下 —— 这里必须掉脚下，因为变形紧接着就
 * 把整个容器落地，塞进包里的东西还得指望引擎再吐一遍。carrier=bag 的记录不重建（实物本来
 * 就在背包里，重建就是凭空多一件），只抹账。
 * @returns {number} 掉出来几件
 */
export function shedAllArmor(entity) {
    const rec = armorRecord(entity);
    let n = 0;

    for (const slot of ARMOR_ORDER) {
        const slotName = String(slot);
        const data = rec[slotName];
        const cur = readSlot(entity, slot);
        if (!data && !cur) continue;

        if (data && data.carrier === "bag") {
            clearSlot(entity, slot, cur ? cur.typeId : undefined);
            forgetArmor(entity, slotName);
            continue;
        }

        // 记录优先（带附魔/名字/耐久），槽里那件只作兜底
        const item = deserializeItem(data) || cur;
        const res = forceClearArmorSlot(entity, slotName, data || (item ? serializeItem(item) : undefined));
        forgetArmor(entity, slotName);

        // 伪槽挖出来的实物优先用它，不能和记录重建的那件一起给（一件变两件）
        const give = res.item || item;
        if (!give) continue;
        if (!dropItemNear(entity, give)) continue;
        n++;
    }

    clearArmorRecord(entity);
    return n;
}

/*
 * 兜底清扫：记录里没有、槽里还挂着的残留甲。只在 removeAllArmor 一件都没找到时调用
 * （记录已被上次卸甲抹掉、槽又读不出来）。
 * 宁留不吞：只有 readSlot 真读到实物，才清槽 + 掉给她。读不到就绝不发那条 `replaceitem … air`
 * —— mob 的 equippable 恒读不到，无条件 air 等于把没有记录的一件真甲直接销毁（既不返还
 * 不落地），比「残留甲清不掉」严重得多。
 * @returns {number} 顺手还给她几件
 */
export function purgeStrayArmor(entity) {
    let dropped = 0;

    // ① 装备槽：只在真读得到实物时清（宁留不吞）
    for (const slot of ARMOR_ORDER) {
        const cur = readSlot(entity, slot);
        if (!cur) continue;                          // 读不到就不动，不猜
        clearSlot(entity, slot, cur.typeId);
        forgetArmor(entity, String(slot));
        if (!dropItemNear(entity, cur)) { /* 掉落失败就算了，别吞异常 */ }
        dropped++;
    }

        // ② 伪槽（horse 容器 0/1）：只该放鞍/马铠。出现 armor_table 里的 id，
        //    就是"身上那件掉了进去"—— 这就是「记录没了、还穿着，怎么点都说没有盔甲」的实物。
        //    有工单的槽跳过：那种情况玩家已经按记录拿到过补偿，这格是对应的影子件，
        //    交给巡检销毁，不能再还一份（否则永远多一件）。
    let pending = [];
    try { pending = armorGhostSlots(entity) || []; } catch (e) { pending = []; }
    const pendingSet = new Set(pending.map(String));

    let stash = [];
    try { stash = pseudoSlotItems(entity) || []; } catch (e) { stash = []; }
    for (const hit of stash) {
        const item = hit && hit.item;
        if (!item) continue;
        const slotName = ARMOR_SLOT[item.typeId];
        if (!slotName) continue;                     // 鞍/马铠/杂物：一概不动
        if (pendingSet.has(String(slotName))) continue;
        if (!clearPseudoSlot(entity, hit.i)) continue;
        // 没有记录 = 玩家从没拿到过补偿，这件必须还给她
        if (!moveToBag(entity, item)) {
            if (!dropItemNear(entity, item)) { /* 掉落失败也不吞异常 */ }
        }
        dropped++;
    }

    processArmorGhosts(entity);
    return dropped;
}

// collectDroppedArmor 已删除：它会把玩家自己丢的盔甲一起收走。
// 现在归还语义统一为「掉地上」，引擎已掉好的不用再捡一次。
