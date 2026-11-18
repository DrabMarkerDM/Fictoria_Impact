/**
 * record_store.js — 「玩家那件真货」的记录层。
 *
 * 主手那件只是替身，真件只存在于记录（dm34:hoe / dm34:gtool / dm34:weapon）里。
 * setDynamicProperty 会静默失败，实体动态属性也可能读回空（重进世界 / 球重建 / 被清过），
 * 所以：① 写完回读校验 ② 同一份再写进 world 动态属性做镜像 ③ 读时按镜像自愈。
 * 调用方只有在 writeRaw 返回 true 时才允许扣玩家物品。
 */

import { world } from "@minecraft/server";

/** 镜像键：<前缀><实体id>:<原键>。实体 id 唯一，不会串到别的女仆身上 */
const MIRROR = "dm34:rec:";

function mirrorKey(entity, key) {
    try {
        return `${MIRROR}${entity.id}:${key}`;
    } catch (e) {
        return undefined;
    }
}

/** 只读实体自己那份（不查镜像、不写任何东西） */
export function ownRaw(entity, key) {
    try {
        const v = entity.getDynamicProperty(key);
        return typeof v === "string" && v.length > 0 ? v : undefined;
    } catch (e) {
        return undefined;
    }
}

/** 写记录：实体 DP + 世界镜像各写一次并回读校验
 *  @returns {boolean} 至少有一处确实写进去了（false = 调用方不许扣物品） */
export function writeRaw(entity, key, json) {
    if (typeof json !== "string" || !json) return false;

    let okEntity = false;
    try {
        entity.setDynamicProperty(key, json);
        okEntity = ownRaw(entity, key) === json;
    } catch (e) {
        okEntity = false;
    }

    let okWorld = false;
    const mk = mirrorKey(entity, key);
    if (mk) {
        try {
            world.setDynamicProperty(mk, json);
            okWorld = world.getDynamicProperty(mk) === json;
        } catch (e) {
            okWorld = false;
        }
    }

    if (!okEntity && !okWorld) {
        try { console.warn(`[dm34/record] 记录写不进去：${key}`); } catch (e) { /* 忽略 */ }
        return false;
    }
    return true;
}

/** 读记录原文：实体那份优先，没有就查镜像并顺手补回实体
 *  @returns {string|undefined} */
export function readRaw(entity, key) {
    const own = ownRaw(entity, key);
    if (own) return own;

    const mk = mirrorKey(entity, key);
    if (!mk) return undefined;

    let m;
    try { m = world.getDynamicProperty(mk); } catch (e) { m = undefined; }
    if (typeof m !== "string" || !m.length) return undefined;

    // 自愈：补写失败不要紧，下次读还会再试，镜像才是兜底
    try { entity.setDynamicProperty(key, m); } catch (e) { /* 忽略 */ }
    return m;
}

/** 读记录对象（解析失败当"没有"，但 hasRaw 仍认它有） */
export function readObject(entity, key) {
    const raw = readRaw(entity, key);
    if (!raw) return undefined;
    try {
        const o = JSON.parse(raw);
        return o && o.id ? o : undefined;
    } catch (e) {
        return undefined;
    }
}

/** 有没有写过这份记录。解析失败也算有 —— 否则「还有东西没还」会被当成「已经还清」 */
export function hasRaw(entity, key) {
    return typeof readRaw(entity, key) === "string";
}

/** 抹掉记录：实体 + 镜像都清。只能在"东西确实还出去之后"调用 */
export function clearRaw(entity, key) {
    try { entity.setDynamicProperty(key, undefined); } catch (e) { /* 忽略 */ }
    const mk = mirrorKey(entity, key);
    if (!mk) return;
    try { world.setDynamicProperty(mk, undefined); } catch (e) { /* 忽略 */ }
}

/** 把镜像里的记录补回实体（球抓取前调一次，否则球会存到空记录）。幂等 */
export function heal(entity, keys) {
    if (!entity || !keys) return;
    for (const key of keys) {
        try { readRaw(entity, key); } catch (e) { /* 单条出错不影响其它 */ }
    }
}

/** 把实体那份抄进世界镜像（球放置后调一次）。
 *  放置后实体 id 变了，镜像里没有新 id 的条目，只靠读时自愈补不出来 */
export function mirror(entity, keys) {
    if (!entity || !keys) return;
    for (const key of keys) {
        try {
            const own = ownRaw(entity, key);
            if (own) writeRaw(entity, key, own);
        } catch (e) { /* 单条出错不影响其它 */ }
    }
}
