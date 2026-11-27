/**
 * gather_store.js — 采集工具（镐 / 斧）保管。
 *
 * 与 farm_store 同构：真件序列化存进记录，主手摆替身，退出采集时掉在她脚下归还。
 * 记录键分开存（dm34:gtool ≠ dm34:hoe），否则"耕地途中切采集"会让两边记录互相覆盖。
 * 不变式同 farm_store：写不进去就不许扣；先给东西，再清主手，最后清记录。
 */

import { system } from "@minecraft/server";
import { isGatherToolId, CONFIG } from "../config.js";
import {
    clearMainhand, deserializeItem, dropItemNear, makeItem, readMainhand,
    serializeItem, syncMainhand,
} from "../core/slot_io.js";
import { readObject, hasRaw, writeRaw, clearRaw } from "../core/record_store.js";

const TOOL_PROP = "dm34:gtool";   // JSON：{id, n, name, lore, ench, dmg}
const GIVE_PROP = "dm34:ggive";   // 1 = 归还时给玩家（创造模式给的是复制品，记 0）

/** 归还路径日志，跟 log.console 总闸 */
function warn(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/gather] ${msg}`); } catch (e) { /* 忽略 */ }
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

/** 现在存着的工具数据（没存 / 解析失败返回 undefined） */
export function storedGatherTool(entity) {
    return readObject(entity, TOOL_PROP);
}

/** 有没有写过记录（只看有没有写） */
export function hasGatherTool(entity) {
    return hasRaw(entity, TOOL_PROP);
}

/** 进采集模式：记下这把工具
 *  @returns {boolean} 记录是否确实写进去了 */
export function storeGatherTool(entity, itemStack, giveBack) {
    const data = serializeItem(itemStack);
    if (!data) return false;
    // 工具带耐久、正常不可堆叠，强制 1 以免手里一叠时归还成一叠
    data.n = 1;
    if (!writeRaw(entity, TOOL_PROP, JSON.stringify(data))) return false;
    setNum(entity, GIVE_PROP, giveBack ? 1 : 0);
    lastPlaceAt.delete(entity.id);      // 换了工具，节流窗口重新给
    return true;
}

/** 主手里到底是什么：true 是这件 / false 明确是别的件 / undefined 读不到。
 *  不用 hasitem 探针：它假阳性会让"已摆好"的判断永远成立（一次都不摆），
 *  假阴性则会诱发清空，把刚摆上去的那件删掉 */
function displayState(entity, id) {
    const hand = readMainhand(entity);
    if (!hand || !hand.typeId) return undefined;
    return hand.typeId === id;
}

/** 主手里是不是记录里那一件（明确读到才算） */
function displayInSlot(entity, id) {
    return displayState(entity, id) === true;
}

/** 重摆节流：同一只女仆 10 tick 内最多写一次（见 farm_store 同名表）。
 *  旧的"盲摆额度"在真机上会被永久耗尽，之后一次都不写，主手停在上一个状态的替身上 */
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

/** 把玩家给的那把摆到她主手上（钻石镐看起来还是钻石镐）
 *  @returns {boolean} 主手是否确认已是记录里那一件（读不到时 false，但写入已做） */
export function restoreGatherDisplay(entity) {
    const data = storedGatherTool(entity);
    if (!data) return false;

    const cur = displayState(entity, data.id);
    if (cur === true) return true;
    if (!placeDue(entity)) return false;

    const item = deserializeItem(data) || makeItem(data.id, 1);
    if (!item) return false;

    // 三态：只有"明确读到别的件"才算失败，读不到不算（否则守卫会停手不再补）
    const r = syncMainhand(entity, item);
    if (r === false) {
        warn(`摆件复核未通过：主手回读≠${data.id}（记录保留，守卫会继续补）`);
        return false;
    }
    return true;
}

/** 出采集模式：工具掉在她/玩家脚下（不写背包）。
 *  记录缺失时主手若还握着镐/斧（玩家的替身），照样还回去。
 *  @returns {boolean} 是否真的还了什么 */
export function returnGatherTool(entity, player) {
    const data = storedGatherTool(entity);
    const hand = readMainhand(entity);

    // 记录丢了
    if (!data) {
        if (hand && isGatherToolId(hand.typeId)) {
            if (dropItemNear(entity, hand) || dropItemNear(player, hand)) {
                clearMainhand(entity);
                warn(`记录缺失，按主手替身归还：${hand.typeId}`);
                return true;
            }
            warn(`记录缺失，替身掉落失败（保留主手）：${hand.typeId}`);
            return false;
        }
        if (hasRaw(entity, TOOL_PROP)) {
            warn("有记录但解析不出来，且主手没有镐/斧：记录保留");
        }
        return false;
    }

    const give = getNum(entity, GIVE_PROP, 1) === 1;

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
        warn(`归还失败（造不出 ${data.id}）：记录保留`);
        return false;
    }

    if (give) {
        if (!dropItemNear(entity, item) && !dropItemNear(player, item)) {
            warn(`归还失败（${data.id} 掉不出去）：记录保留`);
            return false;
        }
    } else {
        warn(`创造模式放入，按设计不归还：${data.id}`);
    }

    // 无条件清主手：采集态主手只可能是替身或空，以"读得到工具"为闸门会因读不到而整段跳过
    try {
        clearMainhand(entity);
    } catch (e) { /* 忽略 */ }

    clearRaw(entity, TOOL_PROP);
    setNum(entity, GIVE_PROP, 0);

    warn(
        `归还 ${data.id}：来源=${source} give=${give ? 1 : 0} ` +
        `hand=${hand ? hand.typeId : "-"} player=${player ? player.name : "无"}`
    );
    return true;
}
