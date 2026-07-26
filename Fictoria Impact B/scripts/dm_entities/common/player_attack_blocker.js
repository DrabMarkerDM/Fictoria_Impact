// player_attack_blocker.js
import { world } from "@minecraft/server";

// ============================================================
// 配置
// ============================================================

// 原版友善/驯服生物（仅对 DM 实体生效保护，玩家可以正常打）
const VANILLA_FRIENDLY_TYPES = [
    "minecraft:horse", "minecraft:donkey", "minecraft:mule",
    "minecraft:skeleton_horse", "minecraft:zombie_horse",
    "minecraft:wolf", "minecraft:cat", "minecraft:parrot"
];

// 自定义友军与 DM 实体（对 玩家 和 DM 统一生效保护）
const CUSTOM_ALLIED_TYPES = [
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
    "player:kirito", "player:asuna", "player:steve",
    // 非 player 命名空间的友军
    "mob:protecter", "mob:robot", "mob:doctor", "mob:mon3tr",
];

const VANILLA_FAMILIES = ["horse", "wolf", "cat"];
const DM_FAMILIES = ["dm", "mob"];

function hasAnyFamily(entity, familyList) {
    try {
        if (!entity?.isValid) return false;
        const comp = entity.getComponent("minecraft:type_family");
        if (!comp) return false;
        return comp.getFamilyNames().some(f => familyList.includes(f));
    } catch (e) {
        return false;
    }
}

// 判断受害者是否为 DM 实体
function isDM(entity) {
    if (!entity?.isValid) return false;
    if (hasAnyFamily(entity, ["dm"])) return true;
    if (entity.typeId?.startsWith("player:")) {
        return entity.typeId !== "minecraft:player";
    }
    return false;
}

// 判定：对【玩家】免伤的受害者（仅含 DM 实体 和 自定义 mob:xxx 友军）
function isProtectedFromPlayer(entity) {
    if (!entity?.isValid) return false;
    if (hasAnyFamily(entity, DM_FAMILIES)) return true;
    if (CUSTOM_ALLIED_TYPES.includes(entity.typeId)) return true;
    return false;
}

// 判定：对【DM 实体】免伤的受害者（含 玩家、DM实体、自定义友军 + 原版马狼猫）
function isProtectedFromDM(entity) {
    if (!entity?.isValid) return false;
    // 如果受害者是真实玩家，保护！
    if (entity.typeId === "minecraft:player") return true;
    // 自定义友军与 DM 族群，保护！
    if (isProtectedFromPlayer(entity)) return true;
    // 原版友善生物（马、狼等），保护！
    if (hasAnyFamily(entity, VANILLA_FAMILIES)) return true;
    if (VANILLA_FRIENDLY_TYPES.includes(entity.typeId)) return true;

    return false;
}

function isRealPlayer(entity) {
    return entity?.isValid && entity.typeId === "minecraft:player";
}

// ============================================================
// 全局拦截
// ============================================================
world.beforeEvents.entityHurt.subscribe((event) => {
    try {
        const victim = event.hurtEntity;
        if (!victim?.isValid) return;

        const attacker = event.damageSource?.damagingEntity;
        if (!attacker?.isValid) return;

        // 场景 A：真实玩家攻击 -> 仅阻断对 DM 实体和自定义 mob:xxx 的伤害（玩家可以打马/狼）
        if (isRealPlayer(attacker)) {
            if (isProtectedFromPlayer(victim)) {
                event.cancel = true;
                event.damage = 0;
                try { victim.clearVelocity(); } catch(e) {}
                try { victim.extinguishFire(true); } catch(e) {}
            }
            return;
        }

        // 场景 B：DM 实体攻击 -> 阻断一切友军伤害（包括玩家、其他 DM、mob:xxx 以及 马/狼等原版友军）
        if (isDM(attacker)) {
            if (isProtectedFromDM(victim)) {
                event.cancel = true;
                event.damage = 0;
                try { victim.extinguishFire(true); } catch(e) {}
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
    if (!target?.isValid || !attacker?.isValid) return false;
    
    if (isRealPlayer(attacker)) {
        return isProtectedFromPlayer(target);
    }
    if (isDM(attacker)) {
        return isProtectedFromDM(target);
    }
    return false;
}

console.warn("[DM-Engine] 友伤分流拦截已载入 ✅");