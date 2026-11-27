/**
 * maid_state.js — 女仆当前状态读取（纯读，不改世界）。
 *
 * 只依赖三个值（组件组 SAPI 读不到）：
 *   variant      主状态（0 徒手 / 1~3,5 武器或专用 / 4 烹饪）
 *   mark_variant 徒手子状态（0 站立 in1 / 1 坐着 in2）
 *   dm34:cook    食材编号与生熟（n*2 生 / n*2+1 熟）
 */

import { EquipmentSlot } from "@minecraft/server";
import { ENTITIES } from "./interact_tables.js";
import { CONFIG } from "../config.js";

/** 本模块认的两个女仆实体 id */
export const MAID_IDS = Object.keys(ENTITIES);

export function isMaid(entity) {
    try {
        return !!entity && !!ENTITIES[entity.typeId];
    } catch (e) {
        return false;
    }
}

/** 能不能穿甲 —— 只有 player:dm34 能，dm34_1 的外观是 RP 写死的一整套。
 *  只此一处判断，router / nativeArmor / recordArmor 都必须调它：漏判会消耗玩家的甲并凭空生出一件 */
export function acceptsArmor(entity) {
    try {
        return !!entity && entity.typeId === "player:dm34";
    } catch (e) {
        return false;
    }
}

function comp(entity, id) {
    try {
        return entity.getComponent(id);
    } catch (e) {
        return undefined;
    }
}

export function variantOf(entity) {
    const c = comp(entity, "minecraft:variant");
    return c ? c.value : 0;
}

export function markOf(entity) {
    const c = comp(entity, "minecraft:mark_variant");
    return c ? c.value : 0;
}

/** 烹饪编码：n*2（烹饪中）/ n*2+1（已完成）/ 0（没在做饭） */
export function cookCode(entity) {
    try {
        const v = entity.getDynamicProperty(CONFIG.cook.prop);
        return typeof v === "number" ? v : 0;
    } catch (e) {
        return 0;
    }
}

export function setCookCode(entity, code) {
    try {
        entity.setDynamicProperty(CONFIG.cook.prop, code);
    } catch (e) {
        /* 忽略：实体已卸载 */
    }
}

/** 解析状态键（对应 interact_tables.js 的 states 键）
 *  @returns {{ key: string, st: any, cookN: number, cookDone: boolean } | null} */
export function resolveState(entity) {
    const ent = ENTITIES[entity.typeId];
    if (!ent) return null;

    if (ent.cookVariant !== null && variantOf(entity) === ent.cookVariant) {
        const code = cookCode(entity);
        const n = code >> 1;
        const done = (code & 1) === 1;
        const st = ent.states[done ? "cook_b" : "cook_a"];
        return st ? { key: done ? "cook_b" : "cook_a", st, cookN: n, cookDone: done } : null;
    }

    const v = variantOf(entity);
    const m = markOf(entity);
    for (const [key, vm] of Object.entries(ent.variants)) {
        if (vm[0] === v && vm[1] === m) {
            const st = ent.states[key];
            if (st) return { key, st, cookN: 0, cookDone: false };
        }
    }

    return null;
}

/** 读玩家主手的 ItemStack（不是 id） */
export function handItemOf(player) {
    const eq = comp(player, "minecraft:equippable");
    if (!eq) return undefined;
    try {
        return eq.getEquipment(EquipmentSlot.Mainhand);
    } catch (e) {
        return undefined;
    }
}

/** 物品标签；读不到当空数组 */
function tagsOfStack(itemStack) {
    try {
        const t = itemStack && itemStack.getTags ? itemStack.getTags() : [];
        return Array.isArray(t) ? t : [];
    } catch (e) {
        return [];
    }
}

/** 玩家主手的 typeId，空手返回 undefined */
export function handIdOf(player) {
    const eq = comp(player, "minecraft:equippable");
    if (!eq) return undefined;
    try {
        const item = eq.getEquipment(EquipmentSlot.Mainhand);
        return item ? item.typeId : undefined;
    } catch (e) {
        return undefined;
    }
}

/** 实体 id 归一化：不同版本给的大小写 / 分隔符可能不同 */
function normId(id) {
    if (typeof id !== "string") return "";
    return id.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
}

/** 主人 id 的动态属性键 —— 全项目共用（attackable_target_manager 写，球和 UI 读） */
export const OWNER_DP_KEY = "ownerId";

/** 读主人 id，顺序：ownerId → tameable.tamedToPlayerId → is_tamed.tamedToPlayerId */
export function ownerIdOf(entity) {
    try {
        const dp = entity.getDynamicProperty(OWNER_DP_KEY);
        if (typeof dp === "string" && dp.length > 0) return dp;
    } catch (e) { /* 忽略 */ }

    for (const cid of ["minecraft:tameable", "minecraft:is_tamed"]) {
        const c = comp(entity, cid);
        if (!c) continue;
        try {
            if (c.tamedToPlayerId) return c.tamedToPlayerId;
        } catch (e) { /* 忽略 */ }
        try {
            const p = c.tamedToPlayer;
            if (p && p.id) return p.id;
        } catch (e) { /* 忽略 */ }
    }
    return undefined;
}

/** 只读引擎权威的主人口径（驯服那一击写下的，不可伪造），不看动态属性 */
function engineOwnerOf(entity) {
    for (const cid of ["minecraft:tameable", "minecraft:is_tamed"]) {
        const c = comp(entity, cid);
        if (!c) continue;
        try {
            if (c.tamedToPlayerId) return c.tamedToPlayerId;
        } catch (e) { /* 忽略 */ }
        try {
            const p = c.tamedToPlayer;
            if (p && p.id) return p.id;
        } catch (e) { /* 忽略 */ }
    }
    return undefined;
}

/** 动态属性里的 ownerId（可能是补录来的，不能单独当权威） */
function dpOwnerOf(entity) {
    try {
        const dp = entity.getDynamicProperty(OWNER_DP_KEY);
        if (typeof dp === "string" && dp.length > 0) return dp;
    } catch (e) { /* 忽略 */ }
    return undefined;
}

/** 是不是这只女仆的主人。顺序：引擎主人 > ownerId > 野生放行。
 *  引擎主人存在时只认它 —— 补录的 ownerId 被占也不会把真主人锁在外面、也不会让人蹭甲。
 *  读不出主人时只放行完全没被认领的野生女仆（驯服那一击） */
export function isOwner(player, entity) {
    try {
        const eid = engineOwnerOf(entity);
        if (eid) return normId(eid) === normId(player.id);

        const oid = dpOwnerOf(entity);
        if (oid) {
            // 有 ownerId 没有引擎主人（老存档 / 球放出来的），仍严格比对
            return normId(oid) === normId(player.id);
        }

        // 既无引擎主人也无 ownerId：野生女仆，允许第一次右键（驯服 / 认领）。
        // 已驯服却读不出 id 属于引擎口径整体失效，此时拒绝会把真主人也锁死，只能放行
        if (entity.hasTag && entity.hasTag("dm_tamed")) return true;
    } catch (e) {
        /* 落到下面 */
    }
    return !!(CONFIG.owner && CONFIG.owner.allowUntamed !== false);
}

/** 补录主人（同 attackable_target_manager）：只在她完全没有 ownerId 时写。
 *  有引擎主人时写引擎那份，绝不当成"当前玩家" */
export function ensureOwnerDp(entity, player) {
    try {
        const cur = entity.getDynamicProperty(OWNER_DP_KEY);
        if (typeof cur === "string" && cur.length > 0) return;
        const eid = engineOwnerOf(entity);
        const who = eid || (player && player.id);
        if (!who) return;
        entity.setDynamicProperty(OWNER_DP_KEY, who);
    } catch (e) { /* 忽略 */ }
}

export function isRiding(entity) {
    return !!comp(entity, "minecraft:riding");
}

export function isLeashed(entity) {
    try {
        const c = comp(entity, "minecraft:leashable");
        return !!(c && c.isLeashed);
    } catch (e) {
        return false;
    }
}

/** 组装规则判定上下文（对应原生过滤器的几个 test） */
export function buildCtx(player, entity) {
    let sneaking = false;
    try {
        sneaking = !!player.isSneaking;
    } catch (e) { /* 忽略 */ }

    let tag = false;
    try {
        tag = entity.hasTag("maid:player_ride");
    } catch (e) { /* 忽略 */ }

    // 骑马模式（马铠装在马铠槽，mount_on 打的 tag）。与 tag 分开存：
    // 一个是「玩家骑她」，一个是「她骑别人」，右键语义相反
    let mountTag = false;
    try {
        mountTag = entity.hasTag("maid:mount_ride");
    } catch (e) { /* 忽略 */ }

    const handStack = handItemOf(player);

    return {
        hand: handStack ? handStack.typeId : undefined,
        handTags: tagsOfStack(handStack),
        riding: isRiding(entity),
        sneaking,
        leashed: isLeashed(entity),
        tag,
        mountTag,
    };
}

/** 一条紧凑元组在当前上下文下是否命中 */
export function ruleMatches(rule, ctx) {
    switch (rule[0]) {
        // 骑马模式不算「抱着/被骑」：放行后落回原版物品栏，
        // 否则 ["n"] 把右键吃掉，玩家拿不出马铠、也就永远下不了马
        case "n": return ctx.riding && !ctx.mountTag;
        case "b": return ctx.sneaking;
        // 骑马时手持鞍不再走 ride_test：两条骑乘链同时解算会把人原地弹飞
        case "r": return ctx.hand === "minecraft:saddle" && !ctx.mountTag;
        case "s":
            // 原生 sit_1/sit_2：hand != lead（空手也算不是拴绳）→ 空手右键坐下
            return ctx.hand !== "minecraft:lead" && !ctx.riding && !ctx.leashed && !ctx.tag;
        case "h": return ctx.hand === rule[1] && !ctx.riding;
        case "H": return ctx.hand === rule[1];
        default: return false;
    }
}

/** 从命中的元组里取 { event, use, drop } */
export function tupleInfo(rule) {
    if (rule[0] === "n") return { event: null, use: false, drop: false };
    const isHand = rule[0] === "h" || rule[0] === "H";
    return {
        event: rule[isHand ? 2 : 1] ?? null,
        use: rule[isHand ? 3 : 2] === 1,
        drop: rule[isHand ? 4 : 3] === 1,
    };
}
