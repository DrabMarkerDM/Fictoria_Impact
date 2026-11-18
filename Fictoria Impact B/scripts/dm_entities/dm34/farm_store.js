/**
 * farm_store.js — 耕地锄头保管。
 *
 * 原生只认 iron_hoe，且切状态时不还锄头，所以和真武器同构：
 * 玩家那把序列化存进记录，主手摆替身，离开耕地态归还。
 *
 * 两条不变式：
 *  ① 记录写进去才算收下 —— storeFarmTool 返回 false 时调用方不许扣玩家物品；
 *  ② 归还顺序是「先给东西 → 再清主手 → 最后清记录」，任何一步失败都保留记录。
 */

import { system } from "@minecraft/server";
import { isHoeId, CONFIG } from "./config.js";
import {
    clearMainhand, deserializeItem, dropItemNear, makeItem, readMainhand, serializeItem, syncMainhand,
} from "./slot_io.js";
import { readObject, hasRaw, writeRaw, clearRaw } from "./record_store.js";

const HOE_PROP = "dm34:hoe";      // JSON：{id, n, name, lore, ench, dmg}
const GIVE_PROP = "dm34:hgive";   // 1 = 归还时给玩家（创造模式给的是复制品，记 0）

/** 归还路径日志，跟 log.console 总闸 */
function warn(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/farm] ${msg}`); } catch (e) { /* 忽略 */ }
}

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

/** 现在存着的锄头数据（没存 / 解析失败返回 undefined） */
export function storedFarmTool(entity) {
    return readObject(entity, HOE_PROP);
}

/** 有没有写过记录。解析失败也算有，否则会把"没还"当成"已还清" */
export function hasFarmTool(entity) {
    return hasRaw(entity, HOE_PROP);
}

/** 耕地态主手该显示的 typeId（守卫用）；没有记录返回 undefined */
export function farmToolId(entity) {
    const d = storedFarmTool(entity);
    return d ? d.id : undefined;
}

/** 进耕地态：记下这把锄头，主手留到 farm 组 equipment（铁锄）结算后再摆
 *  @returns {boolean} 记录是否确实写进去了（false 时调用方不许扣玩家物品） */
export function storeFarmTool(entity, itemStack, giveBack) {
    const data = serializeItem(itemStack);
    if (!data) return false;
    // 锄头有耐久、正常不可堆叠，强制 1 以免手里一叠时归还成一叠
    data.n = 1;
    if (!writeRaw(entity, HOE_PROP, JSON.stringify(data))) return false;
    setNum(entity, GIVE_PROP, giveBack ? 1 : 0);
    lastPlaceAt.delete(entity.id);      // 换了锄头，节流窗口重新给
    return true;
}

/** 主手里到底是什么：true 是这件 / false 明确是别的件 / undefined 读不到。
 *  只认真读槽位：hasitem 探针对她在主手上会假阳性（握着铁锄也报"有钻石锄"），
 *  据此判断"已摆好"会导致一次都不摆 */
function displayState(entity, id) {
    const hand = readMainhand(entity);
    if (!hand || !hand.typeId) return undefined;
    return hand.typeId === id;
}

/** 明确读对才算对（读不到当没到位，但不会据此清空任何东西） */
function displayInSlot(entity, id) {
    return displayState(entity, id) === true;
}

/** 重摆节流：同一只女仆 10 tick 内最多写一次。
 *  读不到可以，但不许从此不写 —— 旧的"盲摆额度"会在真机上被永久耗尽 */
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

/** 把玩家给的那把摆到她主手上（钻石锄看起来还是钻石锄）
 *  @returns {boolean} 主手是否确认已是记录里那一件（读不到时 false，但写入已做） */
export function restoreFarmDisplay(entity) {
    const data = storedFarmTool(entity);
    if (!data) return false;

    const cur = displayState(entity, data.id);
    if (cur === true) return true;                 // 已在位，不重复发命令
    if (!placeDue(entity)) return false;           // 刚写过，等下一个窗口

    const item = deserializeItem(data) || makeItem(data.id, 1);
    if (!item) return false;

    // 读不到或读到别的件都照写：replaceitem 管客户端可见，SAPI 管服务端可靠
    const r = syncMainhand(entity, item);
    if (r === false) {
        warn(`摆件复核未通过：主手回读≠${data.id}（记录保留，守卫会继续补）`);
        return false;
    }
    return true;
}

/** 主手那把是不是该清掉的替身：记录里那件，或任意锄头。
 *  只用于日志判断，不能当"要不要清手"的闸门（读不到会误判成没有） */
function isHoeOnHand(entity, data) {
    if (data && displayInSlot(entity, data.id)) return true;
    const hand = readMainhand(entity);
    return !!hand && isHoeId(hand.typeId);
}

/** 出耕地态：锄头掉在她/玩家脚下（不写背包）。
 *  三道兜底：① 按记录重建 ② 主手那把替身 ③ 同 id 干净件。
 *  @returns {boolean} 是否真的还了什么 */
export function returnFarmTool(entity, player) {
    const data = storedFarmTool(entity);
    const hand = readMainhand(entity);

    // 记录丢了：主手那件可能就是玩家给的替身。铁锄例外 ——
    // farm 组的 equipment 会刷出铁锄，那不是玩家的东西，掉出去等于每次退出白送一把
    if (!data) {
        if (hand && isHoeId(hand.typeId) && hand.typeId !== "minecraft:iron_hoe") {
            if (dropItemNear(entity, hand) || dropItemNear(player, hand)) {
                clearMainhand(entity);
                warn(`记录缺失，按主手替身归还：${hand.typeId}`);
                return true;
            }
            warn(`记录缺失，替身掉落失败（保留主手）：${hand.typeId}`);
            return false;
        }
        if (hasRaw(entity, HOE_PROP)) {
            warn("有记录但解析不出来，且主手没有锄头：记录保留，等信息修好");
        }
        return false;
    }

    const give = getNum(entity, GIVE_PROP, 1) === 1;

    // ① 按记录重建（附魔/名字/耐久都在）
    let item = deserializeItem(data);
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
    if (!item && give) {
        // 连干净件都造不出来就绝不能动记录，留到下次（死亡掉落 / 球 还能捞回来）
        warn(`归还失败（造不出 ${data.id}）：记录保留`);
        return false;
    }

    // ② 先交出去
    if (give) {
        // 掉在她脚下（朝远离玩家的方向推开），她上下文坏了才退回玩家脚下
        if (!dropItemNear(entity, item) && !dropItemNear(player, item)) {
            warn(`归还失败（${data.id} 掉不出去）：记录保留`);
            return false;
        }
    } else {
        warn(`创造模式放入，按设计不归还：${data.id}`);
    }

    // ③ 再无条件清主手。耕地态主手只可能是替身 / farm 组的铁锄 / 空，三种都该清；
    //    之前以"读得到锄头"为闸门，读不到就整段跳过，替身会留在她手上继续干活
    try {
        const was = isHoeOnHand(entity, data);
        clearMainhand(entity);
        if (was) warn("清手：主手替身已扫空");
    } catch (e) { /* 忽略 */ }

    // ④ 最后清记录：中途任何一步抛错都还有下一次机会
    clearRaw(entity, HOE_PROP);
    setNum(entity, GIVE_PROP, 0);

    warn(
        `归还 ${data.id}：来源=${source} give=${give ? 1 : 0} ` +
        `hand=${hand ? hand.typeId : "-"} player=${player ? player.name : "无"}`
    );
    return true;
}
