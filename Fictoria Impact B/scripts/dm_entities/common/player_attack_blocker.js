// player_attack_blocker.js
import { world } from "@minecraft/server";

// ============================================================
// 配置
// ============================================================
const ALLIED_TYPES = [
    // 友好生物和玩家
    "minecraft:horse", "minecraft:donkey", "minecraft:mule",
    "minecraft:skeleton_horse", "minecraft:zombie_horse",
    "minecraft:wolf", "minecraft:cat", "minecraft:parrot",
    "minecraft:player",
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
    "mob:protecter", "mob:robot", "mob:doctor",
];
const ALLIED_FAMILIES = ["horse", "wolf", "cat", "dm"];
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

function isProtected(entity) {
    if (!entity?.isValid) return false;
    if (hasAnyFamily(entity, ALLIED_FAMILIES)) return true;
    if (ALLIED_TYPES.includes(entity.typeId)) return true;
    return false;
}

function isDM(entity) {
    if (!entity?.isValid) return false;
    if (hasAnyFamily(entity, ["dm"])) return true;
    if (entity.typeId?.startsWith("player:")) {
        const players = world.getAllPlayers();
        for (let i = 0; i < players.length; i++) {
            if (players[i].id === entity.id) return false;
        }
        return true;
    }
    return false;
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

        // 真实玩家攻击 DM → cancel
        const players = world.getAllPlayers();
        for (let i = 0; i < players.length; i++) {
            if (players[i].id === attacker.id) {
                if (isDM(victim)) {
                    event.cancel = true;
                    event.damage = 0;
                    try { victim.clearVelocity(); } catch(e) {}
                    try { victim.extinguishFire(true); } catch(e) {}
                }
                return;
            }
        }

        // DM 攻击友方（含 DM 内讧）→ cancel
        if (!isDM(attacker)) return;
        if (isProtected(victim)) {
            event.cancel = true;
            event.damage = 0;
            try { victim.extinguishFire(true); } catch(e) {}
        }

    } catch (e) {
        console.error(`[DM-Engine] 异常: ${e}`);
    }
});

// ============================================================
// 子弹回调出口
// ============================================================
export function shouldBlockProjectileFriendlyFire(target, attacker) {
    if (!target?.isValid || !attacker?.isValid) return false;
    if (!isDM(attacker)) return false;
    return isProtected(target);
}

console.warn("[DM-Engine] 友伤拦截已载入 ✅");