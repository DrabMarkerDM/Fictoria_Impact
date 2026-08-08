// player_attack_blocker.js
import { world, system } from "@minecraft/server";

// ============================================================
// 配置
// ============================================================

// 原版友善 / 驯服生物
// 仅对 DM 实体攻击生效保护，玩家可以正常打
const RAW_VANILLA_FRIENDLY_TYPES = [
    "minecraft:horse",
    "minecraft:donkey",
    "minecraft:mule",
    "minecraft:skeleton_horse",
    "minecraft:zombie_horse",
    "minecraft:wolf",
    "minecraft:cat",
    "minecraft:parrot"
];

// 自定义友军与 DM 实体
// 对玩家和 DM 统一生效保护
const RAW_CUSTOM_ALLIED_TYPES = [
    // DM 实体 player:dm0 ~ player:dm63
    "player:dm0", "player:dm1", "player:dm2", "player:dm3",
    "player:dm4", "player:dm5", "player:dm6", "player:dm7",
    "player:dm8", "player:dm9", "player:dm10", "player:dm11",
    "player:dm12", "player:dm13", "player:dm14", "player:dm15",
    "player:dm16", "player:dm17", "player:dm18", "player:dm19",
    "player:dm20", "player:dm21", "player:dm22", "player:dm23",
    "player:dm24", "player:dm25", "player:dm26", "player:dm27",
    "player:dm28", "player:dm29", "player:dm30", "player:dm31",
    "player:dm32", "player:dm33", "player:dm34", "player:dm34_1",
    "player:dm35", "player:dm36", "player:dm37", "player:dm38",
    "player:dm39", "player:dm40", "player:dm41", "player:dm42",
    "player:dm42_1",
    "player:dm43", "player:dm44", "player:dm45", "player:dm46",
    "player:dm47", "player:dm48", "player:dm49", "player:dm50",
    "player:dm51", "player:dm52", "player:dm53", "player:dm54",
    "player:dm55", "player:dm56", "player:dm57", "player:dm58",
    "player:dm59", "player:dm60", "player:dm61", "player:dm62",
    "player:dm63",

    // 特殊命名
    "player:kirito",
    "player:asuna",
    "player:steve",

    // 非 player 命名空间的友军
    "mob:protecter",
    "mob:robot",
    "mob:doctor",
    "mob:mon3tr"
];

const RAW_VANILLA_FAMILIES = ["horse", "wolf", "cat"];

// ============================================================
// ★ 修复核心：
// 这里不能再使用 ["dm", "mob"]。
//
// "mob" 太宽泛，会把大量普通实体都误判成友方，
// 导致玩家和友方几乎无法伤害任何实体。
//
// 因此这里只保留 "dm"。
// 如果你以后需要保护更多自定义友军：
// 1. 把它们的 typeId 加进 RAW_CUSTOM_ALLIED_TYPES
// 2. 或者给它们加专用 family，例如 "dm_ally"
// ============================================================
const RAW_DM_FAMILIES = ["dm"];

// ============================================================
// 优化：
// 1. 所有配置字符串统一 trim，防止尾随空格导致判断失效。
// 2. 数组 includes 改成 Set.has，减少每次 entityHurt 的线性查找。
// ============================================================
function trimArrayToSet(arr) {
    const set = new Set();

    for (const value of arr) {
        if (typeof value === "string") {
            set.add(value.trim());
        } else {
            set.add(value);
        }
    }

    return set;
}

const VANILLA_FRIENDLY_TYPES = trimArrayToSet(RAW_VANILLA_FRIENDLY_TYPES);
const CUSTOM_ALLIED_TYPES = trimArrayToSet(RAW_CUSTOM_ALLIED_TYPES);
const VANILLA_FAMILY_SET = trimArrayToSet(RAW_VANILLA_FAMILIES);
const DM_FAMILY_SET = trimArrayToSet(RAW_DM_FAMILIES);

// ============================================================
// family 缓存
//
// 原版每次受击都会读取：
// entity.getComponent("minecraft:type_family")
//
// 这里按 typeId 缓存 family 集合，减少高频 entityHurt 下的组件读取。
// ============================================================
const EMPTY_FAMILY_SET = new Set();
const FAMILY_CACHE = new Map();

function getEntityFamilySet(entity) {
    try {
        if (!entity || !entity.isValid) return EMPTY_FAMILY_SET;

        const cacheKey = entity.typeId;

        if (cacheKey && FAMILY_CACHE.has(cacheKey)) {
            return FAMILY_CACHE.get(cacheKey);
        }

        const comp = entity.getComponent("minecraft:type_family");

        if (!comp) {
            if (cacheKey) FAMILY_CACHE.set(cacheKey, EMPTY_FAMILY_SET);
            return EMPTY_FAMILY_SET;
        }

        let names = [];

        if (typeof comp.getFamilyNames === "function") {
            names = comp.getFamilyNames();
        } else if (typeof comp.getTypeFamilies === "function") {
            names = comp.getTypeFamilies();
        } else if (Array.isArray(comp.families)) {
            names = comp.families;
        }

        const familySet = new Set(names);

        if (cacheKey) {
            FAMILY_CACHE.set(cacheKey, familySet);
        }

        return familySet;
    } catch (e) {
        return EMPTY_FAMILY_SET;
    }
}

function hasAnyFamily(entity, targetFamilySet) {
    try {
        if (!entity || !entity.isValid) return false;
        if (!targetFamilySet || targetFamilySet.size === 0) return false;

        const entityFamilySet = getEntityFamilySet(entity);

        if (!entityFamilySet || entityFamilySet.size === 0) return false;

        for (const family of targetFamilySet) {
            if (entityFamilySet.has(family)) {
                return true;
            }
        }

        return false;
    } catch (e) {
        return false;
    }
}

// ============================================================
// 判断实体是否为 DM 友方
//
// ★ 修复：
// 这里只检查 "dm" family。
// 不能再检查 "mob" family。
// ============================================================
function isDM(entity) {
    if (!entity || !entity.isValid) return false;

    if (hasAnyFamily(entity, DM_FAMILY_SET)) return true;

    if (entity.typeId?.startsWith("player:")) {
        return entity.typeId !== "minecraft:player";
    }

    return false;
}

// ============================================================
// 判定：对【玩家】免伤的受害者
//
// 仅包含：
// 1. dm family 实体
// 2. CUSTOM_ALLIED_TYPES 白名单实体
//
// ★ 修复：
// 不再因为受害者有 "mob" family 就保护它。
// ============================================================
function isProtectedFromPlayer(entity) {
    if (!entity || !entity.isValid) return false;

    if (hasAnyFamily(entity, DM_FAMILY_SET)) return true;

    if (CUSTOM_ALLIED_TYPES.has(entity.typeId)) return true;

    return false;
}

// ============================================================
// 判定：对【DM 实体】免伤的受害者
//
// 包含：
// 1. 真实玩家
// 2. DM 实体 / 自定义友军
// 3. 原版马、狼、猫等友善生物
// ============================================================
function isProtectedFromDM(entity) {
    if (!entity || !entity.isValid) return false;

    // 如果受害者是真实玩家，保护
    if (entity.typeId === "minecraft:player") return true;

    // 自定义友军与 DM 族群，保护
    if (isProtectedFromPlayer(entity)) return true;

    // 原版友善生物，保护
    if (hasAnyFamily(entity, VANILLA_FAMILY_SET)) return true;

    if (VANILLA_FRIENDLY_TYPES.has(entity.typeId)) return true;

    return false;
}

function isRealPlayer(entity) {
    return entity && entity.isValid && entity.typeId === "minecraft:player";
}

// ============================================================
// 全局拦截
//
// beforeEvents.entityHurt 上下文中直接修改实体可能受限。
// 因此 event.cancel / event.damage 仍然立即处理，
// 但 clearVelocity / extinguishFire 延后到 system.run。
// ============================================================
world.beforeEvents.entityHurt.subscribe((event) => {
    try {
        const victim = event.hurtEntity;

        if (!victim || !victim.isValid) return;

        const attacker = event.damageSource?.damagingEntity;

        if (!attacker || !attacker.isValid) return;

        // ============================================================
        // 场景 A：真实玩家攻击
        //
        // 仅阻断对 DM 实体和自定义 mob:xxx 友军的伤害。
        // 玩家可以正常打普通怪物、动物、马 / 狼等原版生物。
        // ============================================================
        if (isRealPlayer(attacker)) {
            if (isProtectedFromPlayer(victim)) {
                event.cancel = true;
                event.damage = 0;

                const victimId = victim.id;

                system.run(() => {
                    try {
                        const v = world.getEntity(victimId);

                        if (!v || !v.isValid) return;

                        try {
                            v.clearVelocity();
                        } catch (_) {}

                        try {
                            v.extinguishFire(true);
                        } catch (_) {}
                    } catch (_) {}
                });
            }

            return;
        }

        // ============================================================
        // 场景 B：DM 实体攻击
        //
        // 阻断 DM 对友军的伤害：
        // 1. 玩家
        // 2. 其他 DM
        // 3. 自定义友军
        // 4. 马 / 狼 / 猫等原版友军
        //
        // ★ 修复后：
        // 普通怪物、普通动物不会被误判成友方。
        // ============================================================
        if (isDM(attacker)) {
            if (isProtectedFromDM(victim)) {
                event.cancel = true;
                event.damage = 0;

                const victimId = victim.id;

                system.run(() => {
                    try {
                        const v = world.getEntity(victimId);

                        if (!v || !v.isValid) return;

                        try {
                            v.extinguishFire(true);
                        } catch (_) {}
                    } catch (_) {}
                });
            }

            return;
        }
    } catch (e) {
        console.error(`[DM-Engine] 友伤拦截异常: ${e}`);
    }
});

// ============================================================
// 子弹回调出口
// ============================================================
export function shouldBlockProjectileFriendlyFire(target, attacker) {
    if (!target || !target.isValid || !attacker || !attacker.isValid) return false;

    if (isRealPlayer(attacker)) {
        return isProtectedFromPlayer(target);
    }

    if (isDM(attacker)) {
        return isProtectedFromDM(target);
    }

    return false;
}

console.warn("[DM-Engine] 友伤分流拦截已载入 ✅");