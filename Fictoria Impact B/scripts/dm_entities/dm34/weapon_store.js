/**
 * weapon_store.js — 真武器保管。
 *
 * 真武器不占她背包：序列化后存进 dm34:weapon（id/数量/名字/lore/附魔/耐久），
 * 主手只放同外观替身，解除形态时掉在玩家脚下。存原始损伤值 ——
 * 她拿武器打架会掉耐久，归还时要复原成原样。
 */

import { EnchantmentTypes, EquipmentSlot, system } from "@minecraft/server";
import { CONFIG, weaponFamilyOf } from "./config.js";
import {
    placeItem, clearSlot, clearMainhand, readMainhand, makeItem, dropItemNear, syncMainhand,
} from "./slot_io.js";
import { readObject, hasRaw, writeRaw, clearRaw } from "./record_store.js";

const WEAPON_PROP = "dm34:weapon";   // JSON：{id, n, name, lore, ench:[[id,lvl]], dmg}
const GIVE_PROP = "dm34:wgive";      // 1 = 归还时给玩家（创造模式给的是复制品，记 0）

/** 归还路径日志，跟 log.console 总闸 */
function warn(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/weapon] ${msg}`); } catch (e) { /* 忽略 */ }
}

// 记录读写全部走 record_store（回读校验 + 世界镜像 + 读时自愈），本文件不直接碰 DP

function getNum(entity, key, dflt) {
    try {
        const v = entity.getDynamicProperty(key);
        return typeof v === "number" ? v : dflt;
    } catch (e) {
        return dflt;
    }
}

function setNum(entity, key, v) {
    try { entity.setDynamicProperty(key, v); } catch (e) { /* 忽略 */ }
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

/** ItemStack → 可存进动态属性的普通对象 */
export function serializeWeapon(item) {
    if (!item) return undefined;
    let dmg = 0;
    try {
        const d = item.getComponent("minecraft:durability");
        if (d) dmg = d.damage || 0;
    } catch (e) { dmg = 0; }
    let lore = [];
    try { lore = item.getLore() || []; } catch (e) { lore = []; }
    return {
        id: item.typeId,
        n: item.amount || 1,
        name: item.nameTag || "",
        lore,
        ench: enchOf(item).map((e) => [e.type.id, e.level]),
        dmg,
    };
}

/** 普通对象 → ItemStack（能还原多少还原多少） */
export function deserializeWeapon(data) {
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
                    const id = pair[0];
                    const lvl = pair[1];
                    let type;
                    try { type = EnchantmentTypes.get(id); } catch (e) { type = undefined; }
                    if (!type) continue;
                    try { c.addEnchantment({ type, level: lvl }); } catch (e) { /* 忽略 */ }
                }
            }
        } catch (e) { /* 忽略 */ }
    }
    if (data.dmg) {
        try {
            const d = it.getComponent("minecraft:durability");
            if (d) d.damage = data.dmg;
        } catch (e) { /* 忽略 */ }
    }
    return it;
}

/** 现在存着的武器数据（没存返回 undefined） */
export function storedWeapon(entity) {
    return readObject(entity, WEAPON_PROP);
}

/** 进武器形态：记下这件武器，主手摆一件外观一致的
 *  @returns {boolean} 记录是否确实写进去了（false 时调用方不许扣玩家物品） */
export function storeWeapon(entity, itemStack, giveBack) {
    const data = serializeWeapon(itemStack);
    if (!data) return false;
    if (!writeRaw(entity, WEAPON_PROP, JSON.stringify(data))) return false;
    setNum(entity, GIVE_PROP, giveBack ? 1 : 0);
    lastPlaceAt.delete(entity.id);        // 换了武器，节流窗口重新给
    syncMainhand(entity, itemStack);      // 命令 + SAPI 两条通道都打
    return true;
}

/** 主手放/刷新这件武器的外观 */
export function setDisplay(entity, itemStack) {
    if (!itemStack) return clearDisplay(entity);
    return placeItem(entity, EquipmentSlot.Mainhand, itemStack);
}

/** 清空主手 */
export function clearDisplay(entity) {
    return clearSlot(entity, EquipmentSlot.Mainhand);
}

/** 出形态：把手上的真件掉在她脚下（不写背包）。
 *  顺序必须是「先给东西 → 再清主手 → 最后清记录」，
 *  否则重建或掉落失败时会变成"记录已清 + 物品没给"，剑凭空蒸发。
 *  三道兜底：① 按记录重建 ② 主手替身 ③ 同 id 干净件
 *  @returns {boolean} 是否真的还了什么 */
export function returnWeapon(entity, player, forceClear) {
    const data = storedWeapon(entity);
    const give = getNum(entity, GIVE_PROP, 1) === 1;
    const hand = readMainhand(entity);

    // 记录丢了：主手还握着武器，那就是玩家那把的替身，先交出去、绝不清空。
    // 限制在剑/弓/弩/长矛 —— leaveState 也会走这里，那时主手可能是锄头或食物
    if (!data) {
        if (hand && weaponFamilyOf(hand.typeId)) {
            if (!give) {
                debugWeapon(`记录缺失 + 创造模式：按设计不归还 ${hand.typeId}`);
                return false;
            }
            if (dropItemNear(entity, hand) || dropItemNear(player, hand)) {
                clearDisplay(entity);
                warn(`记录缺失，按主手替身归还：${hand.typeId} give=${give ? 1 : 0}`);
                return true;
            }
            warn(`记录缺失，替身掉落失败（保留主手）：${hand.typeId}`);
            return false;
        }
        warn(
            `记录缺失且主手没有可识别的武器（hand=${hand ? hand.typeId : "-"} ` +
            `player=${player ? player.name : "无"}），无可归还`
        );
        return false;
    }

    // 优先按记录重建；手上那件只在重建失败时兜底（可能是白板，会吞附魔）
    let item = deserializeWeapon(data);
    let source = "记录";

    if (!item && hand && hand.typeId === data.id) {
        item = hand;
        source = "替身";
    }

    if (!item) {
        item = makeItem(data.id, data.n || 1);
        source = "干净件";
        warn(`重建失败，改给干净件：${data.id}（附魔/名字会丢，但物品不会消失）`);
    }

    if (!item) {
        warn(`归还彻底失败：${data.id} ×${data.n || 1}（记录保留，等下次再还）`);
        return false;
    }

    // 耐久恢复成她拿的时候的样子
    if (data.dmg !== undefined) {
        try {
            const d = item.getComponent("minecraft:durability");
            if (d) d.damage = data.dmg;
        } catch (e) { /* 忽略 */ }
    }

    // ① 先交出去
    if (give) {
        if (!dropItemNear(entity, item) && !dropItemNear(player, item)) {
            warn(`归还失败（${data.id} 掉不出去）：记录保留`);
            return false;
        }
    } else {
        // 创造模式放进来的是复制品，按设计不归还；留日志免得被当成吞物品
        debugWeapon(`创造模式放入，按设计不归还：${data.id}`);
    }

    // ② 再清主手。forceClear = 调用方已确认她就在这个武器态，主手只可能是替身，
    //    无条件清 —— 不能先读一次当闸门（读槽返回 undefined 时整段会被跳过）。
    //    反向兜底路径（状态不是武器态、记录却残留）不传 forceClear：
    //    那时主手可能是锄头或食物，无条件清会删掉她的生产工具
    try {
        if (forceClear) {
            clearMainhand(entity);
        } else {
            const cur = readMainhand(entity) || hand;
            if (cur && (cur.typeId === data.id || weaponFamilyOf(cur.typeId))) clearDisplay(entity);
        }
    } catch (e) { /* 忽略 */ }

    // ③ 最后清记录
    clearRaw(entity, WEAPON_PROP);
    setNum(entity, GIVE_PROP, 0);

    warn(
        `归还 ${data.id} ×${data.n || 1}：来源=${source} give=${give ? 1 : 0} ` +
        `hand=${hand ? hand.typeId : "-"} player=${player ? player.name : "无"}`
    );

    return true;
}

/** 有没有武器记录 —— 只看「有没有写过」，不看能不能解析。
 *  用 storedWeapon() 会把解析失败当成"武器被取走"而触发 back，记录却还挂着 */
export function hasWeaponRecord(entity) {
    return hasRaw(entity, WEAPON_PROP);
}

/** 武器还在不在（存在动态属性里，玩家没法从背包拿走） */
export function ensureWeaponPresent(entity) {
    return hasWeaponRecord(entity);
}

/** 重摆节流：同一只女仆 10 tick 内最多写一次（见 gather_store 同名表）。
 *  旧的盲摆额度会在真机上耗尽，之后主手再没人管 */
const lastPlaceAt = new Map();
const PLACE_GAP_TICKS = 10;

function placeDue(entity) {
    let now = 0;
    try { now = system.currentTick; } catch (e) { now = 0; }
    const prev = lastPlaceAt.get(entity.id);
    if (typeof prev === "number" && now - prev < PLACE_GAP_TICKS) return false;
    lastPlaceAt.set(entity.id, now);
    return true;
}

/** 主手替身对齐真货（她打架会磨损替身，按存下的 dmg 复原外观）。
 *  @returns {boolean} 主手是否确认已是应有的样子（读不到时 false，但写入已做） */
export function refreshWeaponDisplay(entity) {
    try {
        const w = storedWeapon(entity);
        if (!w) return false;
        // 读槽在女仆身上不可靠（equippable 只声明了马鞍槽），一律走 readMainhand
        const cur = readMainhand(entity);
        if (cur && cur.typeId === w.id) {
            // 同款且在手上就算到位，不比 dmg
            return true;
        }
        if (!placeDue(entity)) return false;
        // 读不到时也要写：那恰恰是最该写的时刻
        const item = deserializeWeapon(w);
        if (!item) return false;
        const r = syncMainhand(entity, item);
        if (r === false) return false;    // 明确读到别的件才算失败（读不到不算）
        return true;
    } catch (e) {
        return false;
    }
}

export function debugWeapon(msg) {
    if (CONFIG.log.debug && CONFIG.log.console) {
        try { console.warn(`[dm34/weapon] ${msg}`); } catch (e) { /* 忽略 */ }
    }
}
