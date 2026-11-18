/*
 * death_drop.js — 女仆死亡时把她身上属于玩家的东西掉回原地。
 * 引擎那套「死亡掉落装备」是原版生物专属的 C++ 逻辑，dm34 死的那一刻：`minecraft:equippable`
 * 槽（主手 / 副手盾 / 四甲）静默消失，`minecraft:inventory`（horse 型，34 格背包）不保证掉落。
 * SAPI 读不到 mob 的装备槽（equippable 只有玩家有），所以不读槽、只读记录：`dm34:shield` /
 * `dm34:weapon` / `dm34:hoe` / `dm34:armor` 是唯一真相源，重建后掉在死亡点；背包容器逐格取出
 * （前 `bagFirstOf` 格是鞍 / 马铠伪槽，跳过）。
 * 覆盖不到的是主手那些没有记录的杂项 —— 装备槽无法枚举，只能认记录；三条主手通道
 * （武器 / 锄头 / 盾）都有记录，值钱的都在。
 * 掉落不清空容器：宁可引擎哪天也掉一份，也不能因为 spawnItem 失败 + 已清空而蒸发。
 */

import { system, world } from "@minecraft/server";
import { isMaid } from "./maid_state.js";
import { armorRecord, bagFirstOf } from "./guard.js";
import { storedWeapon } from "./weapon_store.js";
import { storedFarmTool } from "./farm_store.js";
import { shieldRecord } from "./shield.js";
import { deserializeItem, dropItemNear, serializeItem } from "./slot_io.js";
import { CONFIG } from "./config.js";

let inited = false;

function log(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/death] ${msg}`); } catch (e) { /* 忽略 */ }
}

function containerOf(entity) {
    try {
        const inv = entity.getComponent("minecraft:inventory");
        return inv ? inv.container : undefined;
    } catch (e) {
        return undefined;
    }
}

/** 收集"该还给玩家的东西"——只存**序列化数据**，ItemStack 一律等下一 tick 再建。
 *  实体在事件回调结束后随时会被移除，拿在手上的 ItemStack 引用并不可靠。 */
function collect(entity) {
    const datas = [];
    const seen = new Set();

    /** @param {object} d 序列化物品
     *  @param {boolean} [equip] 装备类记录：同 id + 名字 + 附魔 + 耐久只算一件。
     *    武器 / 锄头 / 盾三条通道本该互斥，但脏数据里可能两处指向同一件，
     *    真掉了两份等于凭空刷装备。 */
    const add = (d, equip) => {
        if (!d || !d.id) return;
        if (equip) {
            const key = `${d.id}|${d.name || ""}|${JSON.stringify(d.ench || [])}|${d.dmg || 0}`;
            if (seen.has(key)) return;
            seen.add(key);
        }
        datas.push(d);
    };

    // ① 盾：副手真件的记录
    try { add(shieldRecord(entity), true); } catch (e) { /* 忽略 */ }

    // ② 武器：主手真件的记录（只在武器态存在）
    try { add(storedWeapon(entity), true); } catch (e) { /* 忽略 */ }

    // ②' 锄头：耕地态主手那件**原件**（序列化时带了附魔 / 名字 / 耐久）。
    //    合金锄、附魔效率/时运锄都在这条记录里 —— 不补这条，玩家投一把合金锄就是白送。
    try { add(storedFarmTool(entity), true); } catch (e) { /* 忽略 */ }

    // ③ 四甲：记录里每个槽一份。
    //    **carrier=bag 的槽必须跳过**：那是幻域球放置时"实物已经塞进背包"的影子记录，
    //    背包那段（④）本来就会把那件掉一次。两边都算就是一件甲掉两份（凭空多一件）。
    try {
        const rec = armorRecord(entity) || {};
        for (const k of Object.keys(rec)) {
            if (rec[k] && rec[k].carrier === "bag") continue;
            add(rec[k], true);
        }
    } catch (e) { /* 忽略 */ }

    // ④ 背包
    const bag = containerOf(entity);
    if (bag) {
        let first = 2;
        try { first = bagFirstOf(bag); } catch (e) { first = 2; }
        let size = 0;
        try { size = bag.size || 0; } catch (e) { size = 0; }
        for (let i = first; i < size; i++) {
            let it;
            try { it = bag.getItem(i); } catch (e) { it = undefined; }
            if (!it) continue;
            try { add(serializeItem(it)); } catch (e) { /* 忽略 */ }
        }
    }

    return datas;
}

function onDie(ev) {
    const dead = ev.deadEntity;
    if (!dead) return;

    let maid = false;
    try { maid = isMaid(dead); } catch (e) { maid = false; }
    if (!maid) return;

    let loc;
    let dim;
    try {
        loc = dead.location;
        dim = dead.dimension;
    } catch (e) {
        return;
    }
    if (!loc || !dim) return;

    const datas = collect(dead);
    if (!datas.length) return;

    // 坐标先抄成纯数字：实体移除后 location 不能再用
    const at = { x: loc.x, y: loc.y, z: loc.z };

    // 下一 tick 再生成物品：死亡当 tick 的实体清理还没做完，直接 spawn 有被吞的先例
    system.run(() => {
        // dropItemNear 只要 { location, dimension }，伪 source 就够（它会算一个不卡进身体的落点）
        const src = { location: at, dimension: dim };
        let n = 0;
        for (const d of datas) {
            try {
                const it = deserializeItem(d);
                if (it && dropItemNear(src, it)) n++;
            } catch (e) { /* 单件失败不影响其余 */ }
        }
        if (n < datas.length) log(`死亡掉落：${n}/${datas.length} 件成功（失败的多半是无效物品 id）`);
    });
}

export function initDeathDrop() {
    if (inited) return;
    inited = true;

    try {
        world.afterEvents.entityDie.subscribe((ev) => {
            try { onDie(ev); } catch (e) { log(`死亡处理异常：${e}`); }
        });
    } catch (e) {
        log(`entityDie 订阅失败：${e}`);
    }
}
