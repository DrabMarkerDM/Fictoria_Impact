// dm_player_sword_attack.js
import {
    world,
    system,
    Player,
    EntityDamageCause,
    EffectTypes
} from "@minecraft/server";

// ==================== 调试开关 ====================

const DEBUG_ENGINE = false;

function debugLog(...args) {
    if (DEBUG_ENGINE) {
        console.warn(...args);
    }
}

// ==================== 武器配置 ====================

const WEAPON_CONFIG = {
    sword:   { key: "dm_cd_sword",   step: 10 / (0.75 * 20), chargeMax: 1.5 },
    axe:     { key: "dm_cd_axe",     step: 10 / (1.35 * 20), chargeMax: 2.5 },
    pickaxe: { key: "dm_cd_pickaxe", step: 1 / 4,             chargeMax: 1.5 },
    mace:    { key: "dm_cd_mace",    step: 10 / (1.65 * 20), chargeMax: 3.0 },
    trident: { key: "dm_cd_trident", step: 10 / (1.0 * 20),  chargeMax: 2.0 },
    hoe:     { key: "dm_cd_hoe",     step: 1,                 chargeMax: 1.5 },
    shovel:  { key: "dm_cd_shovel",  step: 1,                 chargeMax: 1.5 }
};

const MAX_COOLDOWN = 10;
const CHARGE_MIN_MULTIPLIER = 0.5;

// ==================== 格挡配置 ====================

const PARRY_DURATION_TICKS = 20;
const PARRY_COOLDOWN_TICKS = 10;
const PARRY_MAX_DISTANCE = 6;
const HORIZONTAL_THRESHOLD = 120;
const VERTICAL_THRESHOLD = 120;

// ==================== 横扫配置 ====================

const SWEEP_OFFSET = 2.0;
const SWEEP_RANGE = 2.1;
const SWEEP_DAMAGE_RATIO = 0.5;
const SWEEP_EXTRA_ENCHANT_RATIO = 0.5;

// ==================== 蓄力条 UI ====================

const HUD_MAX_DISTANCE = 3.5;
const PROGRESS_CHARS = Array.from({ length: 81 }, (_, i) => `!jc.${i.toString().padStart(2, "0")}`);

// ==================== 攻击粒子 ====================

const MAX_PARTICLES = 10;

// ==================== 特效开关 ====================

const ENABLE_ATTACK_PARTICLES = true;
const ENABLE_SWEEP_EFFECTS = true;
const ENABLE_PARRY_EFFECTS = true;

// ==================== 动态属性 Key ====================

const PARRY_STATE_KEY = "dm_parry_state";
const PARRY_TIMER_KEY = "dm_parry_timer";
const PARRY_COOLDOWN_KEY = "dm_parry_cooldown";
const PARRY_SOUND_KEY = "dm_parry_sound";
const PARRY_REFLECT_KEY = "dm_parry_reflect";
const SWEEP_READY_KEY = "dm_sweep_ready";
const SWEEP_AOE_KEY = "dm_sweep_aoe";
const SWEEP_TOKEN_KEY = "dm_sweep_token";

const PARRY_IMMUNE_CAUSES = new Set([
    "entityAttack",
    "blockExplosion",
    "entityExplosion",
    "projectile"
]);

// ==================== 内存缓存 ====================

const lastHudValue = new Map();
const lastSelectedSlot = new Map();

// ==================== 工具函数 ====================

function isValidEntity(entity) {
    try {
        if (!entity) return false;
        if (typeof entity.isValid === "function") return entity.isValid();
        return entity.isValid === true;
    } catch (e) {
        return false;
    }
}

function runCommandSafe(executor, command) {
    try {
        executor.runCommand(command);
    } catch (e) {}
}

function setTitleCached(player, text) {
    const cached = lastHudValue.get(player.id);
    if (cached !== text) {
        try {
            player.onScreenDisplay.setTitle(text, {
                fadeInDuration: 0,
                stayDuration: 999999,
                fadeOutDuration: 0
            });
        } catch (e) {}
        lastHudValue.set(player.id, text);
    }
}

function clearTitle(player) {
    setTitleCached(player, "!hide");
}

function getMainhandItem(player) {
    try {
        const equippable = player.getComponent("minecraft:equippable");
        if (!equippable) return null;
        return equippable.getEquipment("Mainhand");
    } catch (e) {
        return null;
    }
}

function getWeaponType(item) {
    if (!item) return null;
    const typeId = item.typeId;
    if (typeId.includes("sword")) return "sword";
    if (typeId.includes("axe")) return "axe";
    if (typeId.includes("pickaxe")) return "pickaxe";
    if (typeId === "minecraft:mace") return "mace";
    if (typeId === "minecraft:trident") return "trident";
    if (typeId.includes("hoe")) return "hoe";
    if (typeId.includes("shovel")) return "shovel";
    return null;
}

function getHeldWeaponType(player) {
    return getWeaponType(getMainhandItem(player));
}

function isHoldingSword(player) {
    return getHeldWeaponType(player) === "sword";
}

function getEnchantLevel(itemStack, enchantId) {
    try {
        const enchantable = itemStack.getComponent("minecraft:enchantable");
        if (!enchantable) return 0;
        const enchant =
            enchantable.getEnchantment(enchantId) ??
            enchantable.getEnchantment(`minecraft:${enchantId}`);
        return enchant ? enchant.level : 0;
    } catch (e) {
        return 0;
    }
}

function getEffectLevel(player, effectId) {
    try {
        const effectType = EffectTypes.get(effectId);
        if (!effectType) return 0;
        const effect = player.getEffect(effectType);
        return effect ? effect.amplifier + 1 : 0;
    } catch (e) {
        return 0;
    }
}

function horizontalDistance(pos1, pos2) {
    const dx = pos1.x - pos2.x;
    const dz = pos1.z - pos2.z;
    return Math.sqrt(dx * dx + dz * dz);
}

function isInFront(source, target, horizontalThreshold = HORIZONTAL_THRESHOLD) {
    try {
        const sourcePos = source.location;
        const targetPos = target.location;
        const dx = targetPos.x - sourcePos.x;
        const dy = targetPos.y - sourcePos.y;
        const dz = targetPos.z - sourcePos.z;
        if (dx === 0 && dy === 0 && dz === 0) return true;
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (length === 0) return true;
        if (length < 1.0) return true;
        const vx = dx / length;
        const vy = dy / length;
        const vz = dz / length;
        let targetYaw = Math.atan2(vx, vz) * (180 / Math.PI);
        targetYaw = -targetYaw;
        const targetPitch = Math.asin(vy) * (180 / Math.PI);
        const sourceRotation = source.getRotation();
        let yawDiff = targetYaw - sourceRotation.y;
        yawDiff = ((yawDiff % 360) + 360) % 360;
        if (yawDiff > 180) yawDiff -= 360;
        const pitchDiff = targetPitch - sourceRotation.x;
        return Math.abs(yawDiff) <= horizontalThreshold && Math.abs(pitchDiff) <= VERTICAL_THRESHOLD;
    } catch (e) {
        return false;
    }
}

// ==================== 反推减免前原始伤害 ====================

const ARMOR_STATS = {
    "minecraft:leather_helmet":       { armor: 1, toughness: 0 },
    "minecraft:leather_chestplate":   { armor: 3, toughness: 0 },
    "minecraft:leather_leggings":     { armor: 2, toughness: 0 },
    "minecraft:leather_boots":        { armor: 1, toughness: 0 },
    "minecraft:chainmail_helmet":     { armor: 2, toughness: 0 },
    "minecraft:chainmail_chestplate": { armor: 5, toughness: 0 },
    "minecraft:chainmail_leggings":   { armor: 4, toughness: 0 },
    "minecraft:chainmail_boots":      { armor: 1, toughness: 0 },
    "minecraft:iron_helmet":          { armor: 2, toughness: 0 },
    "minecraft:iron_chestplate":      { armor: 6, toughness: 0 },
    "minecraft:iron_leggings":        { armor: 5, toughness: 0 },
    "minecraft:iron_boots":           { armor: 2, toughness: 0 },
    "minecraft:golden_helmet":        { armor: 2, toughness: 0 },
    "minecraft:golden_chestplate":    { armor: 5, toughness: 0 },
    "minecraft:golden_leggings":      { armor: 3, toughness: 0 },
    "minecraft:golden_boots":         { armor: 1, toughness: 0 },
    "minecraft:diamond_helmet":       { armor: 3, toughness: 2 },
    "minecraft:diamond_chestplate":   { armor: 8, toughness: 2 },
    "minecraft:diamond_leggings":     { armor: 6, toughness: 2 },
    "minecraft:diamond_boots":        { armor: 3, toughness: 2 },
    "minecraft:netherite_helmet":     { armor: 3, toughness: 3 },
    "minecraft:netherite_chestplate": { armor: 8, toughness: 3 },
    "minecraft:netherite_leggings":   { armor: 6, toughness: 3 },
    "minecraft:netherite_boots":      { armor: 3, toughness: 3 },
    "minecraft:turtle_helmet":        { armor: 2, toughness: 0 }
};

function getOriginalDamage(player, finalDamage, damageCause) {
    let resistanceLevel = 0;
    try {
        const effects = player.getEffects();
        for (const effect of effects) {
            if (effect.typeId.includes("resistance") && !effect.typeId.includes("fire_resistance")) {
                resistanceLevel = effect.amplifier + 1;
                break;
            }
        }
    } catch (e) {}
    const resistanceReduction = Math.min(1, resistanceLevel * 0.2);

    let damageAfterProtection = finalDamage;
    if (resistanceReduction < 1 && resistanceReduction > 0) {
        damageAfterProtection = finalDamage / (1 - resistanceReduction);
    }

    let totalProtection = 0;
    try {
        const equippable = player.getComponent("minecraft:equippable");
        if (equippable) {
            const slots = ["Head", "Chest", "Legs", "Feet"];
            for (const slot of slots) {
                try {
                    const item = equippable.getEquipment(slot);
                    if (!item) continue;
                    const enchantable = item.getComponent("minecraft:enchantable");
                    if (!enchantable) continue;

                    let enchant = null;
                    if (damageCause === "projectile") {
                        enchant = enchantable.getEnchantment("minecraft:projectile_protection")
                            ?? enchantable.getEnchantment("projectile_protection")
                            ?? enchantable.getEnchantment("minecraft:protection")
                            ?? enchantable.getEnchantment("protection");
                    } else if (damageCause === "fire" || damageCause === "lava") {
                        enchant = enchantable.getEnchantment("minecraft:fire_protection")
                            ?? enchantable.getEnchantment("fire_protection")
                            ?? enchantable.getEnchantment("minecraft:protection")
                            ?? enchantable.getEnchantment("protection");
                    } else if (damageCause === "entityExplosion" || damageCause === "blockExplosion") {
                        enchant = enchantable.getEnchantment("minecraft:blast_protection")
                            ?? enchantable.getEnchantment("blast_protection")
                            ?? enchantable.getEnchantment("minecraft:protection")
                            ?? enchantable.getEnchantment("protection");
                    } else {
                        enchant = enchantable.getEnchantment("minecraft:protection")
                            ?? enchantable.getEnchantment("protection");
                    }

                    if (enchant) totalProtection += enchant.level;
                } catch (e) {}
            }
        }
    } catch (e) {}

    totalProtection = Math.min(totalProtection, 20);
    const protectionReduction = totalProtection / 25;

    let damageAfterArmor = damageAfterProtection;
    if (protectionReduction > 0 && protectionReduction < 1) {
        damageAfterArmor = damageAfterProtection / (1 - protectionReduction);
    }

    let defense = 0;
    let toughness = 0;

    try {
        const armorComp = player.getComponent("minecraft:armor");
        if (armorComp) {
            defense = armorComp.value ?? 0;
        }
    } catch (e) {}

    try {
        const equippable = player.getComponent("minecraft:equippable");
        if (equippable) {
            const slots = ["Head", "Chest", "Legs", "Feet"];
            let computedArmor = 0;
            let computedToughness = 0;
            for (const slot of slots) {
                try {
                    const item = equippable.getEquipment(slot);
                    if (!item) continue;
                    const stats = ARMOR_STATS[item.typeId];
                    if (stats) {
                        computedArmor += stats.armor;
                        computedToughness += stats.toughness;
                    }
                } catch (e) {}
            }
            if (computedArmor > 0) {
                defense = computedArmor;
                toughness = computedToughness;
            }
        }
    } catch (e) {}

    let originalDamage = damageAfterArmor;
    if (defense > 0) {
        for (let i = 0; i < 10; i++) {
            const reduction = Math.min(20, Math.max(defense / 5, defense - originalDamage / (2 + toughness / 4))) / 25;
            if (reduction >= 1) break;
            originalDamage = damageAfterArmor / (1 - reduction);
        }
    }

    debugLog(`[反推] 最终伤害=${finalDamage} | 抗性等级=${resistanceLevel} | 保护附魔=${totalProtection} | 护甲=${defense} 韧性=${toughness} | 反推结果=${originalDamage.toFixed(2)}`);

    return originalDamage;
}

// ==================== 蓄力条 UI ====================

function isFacingTarget(player, maxDistance = HUD_MAX_DISTANCE) {
    try {
        const weaponType = getHeldWeaponType(player);
        let distance = maxDistance;
        if (weaponType === "trident") distance = 6.5;
        const entities = player.getEntitiesFromViewDirection({
            maxDistance: distance,
            excludeTypes: ["minecraft:item", "minecraft:xp_orb", "minecraft:arrow", "minecraft:snowball", "minecraft:egg", "minecraft:painting", "minecraft:tnt", "minecraft:falling_block"]
        });
        return entities.length > 0;
    } catch (e) {
        return false;
    }
}

function getCurrentCooldown(player, weaponType) {
    if (!weaponType) return MAX_COOLDOWN;
    const config = WEAPON_CONFIG[weaponType];
    if (!config) return MAX_COOLDOWN;
    return player.getDynamicProperty(config.key) ?? 0;
}

function setCurrentCooldown(player, weaponType, value) {
    if (!weaponType) return;
    const config = WEAPON_CONFIG[weaponType];
    if (!config) return;
    value = Math.min(MAX_COOLDOWN, Math.max(0, value));
    player.setDynamicProperty(config.key, value);
}

function updateHud(player) {
    try {
        if (!isValidEntity(player)) return;
        const weaponType = getHeldWeaponType(player);
        if (!weaponType) {
            clearTitle(player);
            return;
        }
        const current = getCurrentCooldown(player, weaponType);
        const isFull = current >= MAX_COOLDOWN;
        const facingTarget = isFacingTarget(player);
        if (!isFull || facingTarget) {
            let index;
            if (current >= MAX_COOLDOWN) {
                index = PROGRESS_CHARS.length - 1;
            } else {
                const ratio = Math.min(current / MAX_COOLDOWN, 1);
                index = Math.floor(ratio * (PROGRESS_CHARS.length - 1));
                index = Math.max(0, Math.min(index, PROGRESS_CHARS.length - 1));
            }
            setTitleCached(player, PROGRESS_CHARS[index]);
        } else {
            clearTitle(player);  
        }
    } catch (e) {
        clearTitle(player);  
    }
}

function forceUpdateHud(player) {
    lastHudValue.delete(player.id);
    updateHud(player);
}

function resetCooldownForPlayer(player) {
    const weaponType = getHeldWeaponType(player);
    setCurrentCooldown(player, weaponType, 0);
    forceUpdateHud(player);
}

// ==================== 蓄力倍率计算 ====================

function getChargeMultiplier(weaponType, cooldown) {
    const config = WEAPON_CONFIG[weaponType];
    if (!config) return 1.0;
    const chargeMax = config.chargeMax ?? 1.5;

    if (cooldown < MAX_COOLDOWN) {
        return CHARGE_MIN_MULTIPLIER + (cooldown / MAX_COOLDOWN) * (chargeMax - CHARGE_MIN_MULTIPLIER);
    } else {
        return chargeMax;
    }
}

// ==================== 格挡激活 ====================

function tryActivateParry(player) {
    if (!(player instanceof Player)) return;
    if (!isValidEntity(player)) return;
    if (!isHoldingSword(player)) return;

    const parryCooldown = player.getDynamicProperty(PARRY_COOLDOWN_KEY) ?? 0;
    if (parryCooldown > 0) return;

    let state = player.getDynamicProperty(PARRY_STATE_KEY) ?? 0;

    if (state === 1) return;

    runCommandSafe(player, `/playanimation @s animation.player.parry default 0`);
    runCommandSafe(player, `/playanimation @s animation.player.parry none 999`);
    player.setDynamicProperty(PARRY_STATE_KEY, 1);
    player.setDynamicProperty(PARRY_TIMER_KEY, PARRY_DURATION_TICKS);
}

world.afterEvents.itemUse.subscribe((event) => {
    tryActivateParry(event.source);
});

function deactivateParry(player) {
    try {
        player.setDynamicProperty(PARRY_STATE_KEY, 0);
        player.setDynamicProperty(PARRY_TIMER_KEY, 0);
        runCommandSafe(player, `/playanimation @s animation.player.parry default 0`);
    } catch (e) {}
}

// ==================== 主循环 ====================

system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        if (!isValidEntity(player)) continue;

        // ========== 格挡状态维护 ==========

        const holdingSword = isHoldingSword(player);
        let parryState = player.getDynamicProperty(PARRY_STATE_KEY) ?? 0;
        let parryTimer = player.getDynamicProperty(PARRY_TIMER_KEY) ?? 0;
        let parryCooldown = player.getDynamicProperty(PARRY_COOLDOWN_KEY) ?? 0;

        if (!holdingSword && parryState === 1) {
            deactivateParry(player);
            player.setDynamicProperty(PARRY_COOLDOWN_KEY, PARRY_COOLDOWN_TICKS);
        } else if (parryState === 1) {
            if (parryTimer > 0) {
                parryTimer -= 1;
                player.setDynamicProperty(PARRY_TIMER_KEY, parryTimer);
                if (parryTimer === 0) {
                    deactivateParry(player);
                    player.setDynamicProperty(PARRY_COOLDOWN_KEY, PARRY_COOLDOWN_TICKS);
                }
            } else {
                deactivateParry(player);
                player.setDynamicProperty(PARRY_COOLDOWN_KEY, PARRY_COOLDOWN_TICKS);
            }
        }

        if (parryCooldown > 0) {
            player.setDynamicProperty(PARRY_COOLDOWN_KEY, parryCooldown - 1);
        }

        // ========== 格挡成功特效 / 音效 ==========

        const parrySoundFlag = player.getDynamicProperty(PARRY_SOUND_KEY) ?? 0;
        if (parrySoundFlag === 1) {
            player.setDynamicProperty(PARRY_SOUND_KEY, 0);
            if (ENABLE_PARRY_EFFECTS) {
                runCommandSafe(player, `particle minecrafts:parry_particle ^^1.7 ^0.6`);
                try {
                    player.dimension.playSound("random.anvil_land", player.location, {
                        volume: 1.2,
                        pitch: 1.4 + Math.random() * 0.2
                    });
                } catch (e) {}
            }
        }

        // ========== 只恢复当前持有武器的冷却 ==========

        const weaponType = getHeldWeaponType(player);
        if (weaponType) {
            const config = WEAPON_CONFIG[weaponType];
            let cooldown = player.getDynamicProperty(config.key) ?? 0;
            if (cooldown < MAX_COOLDOWN) {
                cooldown += config.step;
                if (cooldown > MAX_COOLDOWN) cooldown = MAX_COOLDOWN;
                player.setDynamicProperty(config.key, cooldown);
            }
        }

        // ========== 切槽位检测 ==========

        const currentSlot = player.selectedSlotIndex;
        const previousSlot = lastSelectedSlot.get(player.id);
        if (previousSlot !== undefined && currentSlot !== previousSlot) {
            resetCooldownForPlayer(player);
        }
        lastSelectedSlot.set(player.id, currentSlot);

        // ========== 蓄力条 UI（每tick） ==========

        updateHud(player);
    }
}, 1);

// ==================== 攻击粒子 ====================

function spawnAttackParticles(player, hurtEntity, damage) {
    if (!ENABLE_ATTACK_PARTICLES) return;
    try {
        if (!player || !hurtEntity) return;
        if (!isValidEntity(player) || !isValidEntity(hurtEntity)) return;
        let count = Math.floor(damage / 3);
        if (count <= 0) return;
        count = Math.min(count, MAX_PARTICLES);
        let halfHeight = 0.9;
        try {
            const collisionBox = hurtEntity.getComponent("minecraft:collision_box");
            if (collisionBox && collisionBox.height) halfHeight = collisionBox.height / 2;
        } catch (e) {}
        for (let i = 0; i < count; i++) {
            hurtEntity.runCommand(`particle critical_heart ^^${halfHeight}^`);
        }
    } catch (e) {}
}

// ==================== 弹反伤害执行 ====================

function executeReflectDamage(reflectTarget, reflectDamage, hurtEntity) {
    try {
        reflectTarget.setDynamicProperty(PARRY_REFLECT_KEY, true);

        const capturedTarget = reflectTarget;
        const capturedDamage = reflectDamage;
        const capturedSource = hurtEntity;

        system.run(() => {
            try {
                capturedTarget.applyDamage(capturedDamage, {
                    cause: EntityDamageCause.override,
                    damagingEntity: capturedSource
                });
                debugLog(`[弹反执行] 对 ${capturedTarget.typeId} 造成 ${capturedDamage} 点伤害（override）`);
            } catch (e) {
                debugLog(`[弹反执行失败] ${e}`);
            }
            system.runTimeout(() => {
                try {
                    if (isValidEntity(capturedTarget)) {
                        capturedTarget.setDynamicProperty(PARRY_REFLECT_KEY, false);
                    }
                } catch (e) {}
            }, 2);
        });
    } catch (e) {
        debugLog(`[弹反设置失败] ${e}`);
        try {
            if (isValidEntity(reflectTarget)) {
                reflectTarget.setDynamicProperty(PARRY_REFLECT_KEY, false);
            }
        } catch (e2) {}
    }
}

// ==================== 伤害处理：蓄力倍率 + 格挡弹反 ====================

world.beforeEvents.entityHurt.subscribe((event) => {
    try {
        const hurtEntity = event.hurtEntity;
        const damageSource = event.damageSource;

        if (hurtEntity instanceof Player && hurtEntity.getDynamicProperty(PARRY_REFLECT_KEY) === true) {
            hurtEntity.setDynamicProperty(PARRY_REFLECT_KEY, false);
            return;
        }

        // ========== 攻击者蓄力伤害（按武器类型独立倍率） ==========

        const attacker = damageSource.damagingEntity;
        if (
            attacker instanceof Player &&
            isValidEntity(attacker) &&
            attacker.getDynamicProperty(SWEEP_AOE_KEY) !== true
        ) {
            const weaponType = getHeldWeaponType(attacker);
            if (weaponType) {
                const cooldown = getCurrentCooldown(attacker, weaponType);
                const multiplier = getChargeMultiplier(weaponType, cooldown);
                event.damage *= multiplier;
            }
        }

        // ========== 玩家格挡弹反 ==========

        if (!(hurtEntity instanceof Player)) return;
        if (!isValidEntity(hurtEntity)) return;

        const cause = damageSource.cause;
        if (!PARRY_IMMUNE_CAUSES.has(cause)) return;

        const parryState = hurtEntity.getDynamicProperty(PARRY_STATE_KEY) ?? 0;
        const parryTimer = hurtEntity.getDynamicProperty(PARRY_TIMER_KEY) ?? 0;

        if (parryState !== 1) return;
        if (parryTimer <= 0) return;
        if (!isHoldingSword(hurtEntity)) return;

        const incomingDamage = getOriginalDamage(hurtEntity, event.damage, cause);

        const parryAttacker = damageSource.damagingEntity;

        let reflectTarget = null;

        if (parryAttacker && isValidEntity(parryAttacker)) {
            if (!isInFront(hurtEntity, parryAttacker)) {
                return;
            }

            reflectTarget = parryAttacker;

            try {
                const projectileComp = parryAttacker?.getComponent?.("minecraft:projectile");
                if (projectileComp?.owner && isValidEntity(projectileComp.owner)) {
                    reflectTarget = projectileComp.owner;
                }
            } catch (e) {}

        } else {
            const nearbyEntities = hurtEntity.dimension.getEntities({
                location: hurtEntity.location,
                maxDistance: PARRY_MAX_DISTANCE,
                excludeTypes: [
                    "minecraft:item", "minecraft:xp_orb", "minecraft:arrow",
                    "minecraft:snowball", "minecraft:egg", "minecraft:painting",
                    "minecraft:tnt", "minecraft:falling_block"
                ]
            });

            let closestEnemy = null;
            let closestDist = Infinity;

            for (const entity of nearbyEntities) {
                if (!isValidEntity(entity)) continue;
                if (entity === hurtEntity) continue;
                if (entity.typeId === "minecraft:player") continue;
                const dist = horizontalDistance(hurtEntity.location, entity.location);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestEnemy = entity;
                }
            }

            if (!closestEnemy) {
                event.cancel = true;
                hurtEntity.setDynamicProperty(PARRY_SOUND_KEY, 1);
                return;
            }

            reflectTarget = closestEnemy;
        }

        event.cancel = true;
        hurtEntity.setDynamicProperty(PARRY_SOUND_KEY, 1);

        if (parryAttacker instanceof Player && isValidEntity(parryAttacker)) {
            parryAttacker.setDynamicProperty(SWEEP_READY_KEY, false);
        }

        if (reflectTarget && isValidEntity(reflectTarget)) {
            const reflectDist = horizontalDistance(hurtEntity.location, reflectTarget.location);

            if (reflectDist <= PARRY_MAX_DISTANCE) {
                executeReflectDamage(reflectTarget, incomingDamage, hurtEntity);
            }
        }
    } catch (e) {}
});

// ==================== 横扫激活 ====================

function handleSweepActivation(event) {
    const damagingEntity = event.damagingEntity;
    if (!(damagingEntity instanceof Player)) return;
    if (!isValidEntity(damagingEntity)) return;
    if (!isHoldingSword(damagingEntity)) return;
    if (damagingEntity.getDynamicProperty(SWEEP_AOE_KEY) === true) return;

    const cooldownBefore = getCurrentCooldown(damagingEntity, "sword");

    setCurrentCooldown(damagingEntity, "sword", 0);
    damagingEntity.setDynamicProperty(SWEEP_READY_KEY, false);
    forceUpdateHud(damagingEntity);

    if (damagingEntity.isFalling) return;
    if (damagingEntity.isSprinting) return;
    if (cooldownBefore < MAX_COOLDOWN) return;

    const token = (damagingEntity.getDynamicProperty(SWEEP_TOKEN_KEY) ?? 0) + 1;
    damagingEntity.setDynamicProperty(SWEEP_TOKEN_KEY, token);
    damagingEntity.setDynamicProperty(SWEEP_READY_KEY, true);

    if (ENABLE_SWEEP_EFFECTS) {
        runCommandSafe(damagingEntity, `particle sweep_attack ^-0.3 ^1.3 ^2.1`);
        try {
            damagingEntity.dimension.playSound("sweep_attack", damagingEntity.location, {
                volume: 1.0,
                pitch: 1.0
            });
        } catch (e) {}
    }

    system.runTimeout(() => {
        if (!isValidEntity(damagingEntity)) return;
        const ready = damagingEntity.getDynamicProperty(SWEEP_READY_KEY);
        const currentToken = damagingEntity.getDynamicProperty(SWEEP_TOKEN_KEY);
        if (ready === true && currentToken === token) {
            damagingEntity.setDynamicProperty(SWEEP_READY_KEY, false);
        }
    }, 10);
}

// ==================== 命中实体事件 ====================

world.afterEvents.entityHitEntity.subscribe((event) => {
    const damagingEntity = event.damagingEntity;

    if (damagingEntity instanceof Player && isValidEntity(damagingEntity)) {
        // 左键攻击立刻解除格挡
        const parryState = damagingEntity.getDynamicProperty(PARRY_STATE_KEY) ?? 0;
        if (parryState === 1) {
            deactivateParry(damagingEntity);
            damagingEntity.setDynamicProperty(PARRY_COOLDOWN_KEY, PARRY_COOLDOWN_TICKS);
        }

        const weaponType = getHeldWeaponType(damagingEntity);

        if (weaponType === "sword") {
            // 剑：走横扫逻辑（内部读取冷却值 → 重置冷却 → 判断横扫）
            try {
                handleSweepActivation(event);
            } catch (e) {}
        } else if (weaponType) {
            // 其他武器：直接重置冷却
            setCurrentCooldown(damagingEntity, weaponType, 0);
            forceUpdateHud(damagingEntity);
        }
    }
});

// ==================== 命中粒子 + 横扫伤害结算 ====================

world.afterEvents.entityHurt.subscribe((event) => {
    let sweepAttacker = null;

    try {
        const attacker = event.damageSource?.damagingEntity;

        if (
            attacker instanceof Player &&
            isValidEntity(attacker) &&
            attacker.getDynamicProperty(SWEEP_AOE_KEY) !== true
        ) {
            spawnAttackParticles(attacker, event.hurtEntity, event.damage);
        }

        if (!(attacker instanceof Player)) return;
        if (!isValidEntity(attacker)) return;
        if (attacker.getDynamicProperty(SWEEP_AOE_KEY) === true) return;
        if (attacker.getDynamicProperty(SWEEP_READY_KEY) !== true) return;

        sweepAttacker = attacker;
        attacker.setDynamicProperty(SWEEP_READY_KEY, false);

        if (!attacker.isOnGround) return;
        if (!isHoldingSword(attacker)) return;

        const hurtEntity = event.hurtEntity;
        if (!isValidEntity(hurtEntity)) return;

        const mainhand = getMainhandItem(attacker);
        const sharpness = getEnchantLevel(mainhand, "sharpness");
        const strength = getEffectLevel(attacker, "strength");
        const weakness = getEffectLevel(attacker, "weakness");

        let sweepDamage = event.damage * SWEEP_DAMAGE_RATIO + 1;
        sweepDamage += sharpness * SWEEP_EXTRA_ENCHANT_RATIO;
        sweepDamage += strength * 0.5;
        sweepDamage -= weakness * 0.5;
        if (sweepDamage < 0) sweepDamage = 0;

        const rotation = attacker.getRotation();
        const yawRad = rotation.y * Math.PI / 180;
        const dirX = -Math.sin(yawRad);
        const dirZ = Math.cos(yawRad);
        const offsetPos = {
            x: attacker.location.x + dirX * SWEEP_OFFSET,
            y: attacker.location.y,
            z: attacker.location.z + dirZ * SWEEP_OFFSET
        };

        const entities = attacker.dimension.getEntities({
            location: offsetPos,
            maxDistance: SWEEP_RANGE,
            excludeTypes: []
        });

        attacker.setDynamicProperty(SWEEP_AOE_KEY, true);

        for (const entity of entities) {
            if (!isValidEntity(entity)) continue;
            if (entity === attacker) continue;
            if (entity === hurtEntity) continue;
            try {
                const tamed = entity.getComponent("minecraft:is_tamed");
                if (tamed) continue;
            } catch (e) {}
            try {
                entity.applyDamage(sweepDamage, {
                    cause: EntityDamageCause.entityAttack,
                    damagingEntity: attacker
                });
            } catch (e) {}
        }
    } catch (e) {
    } finally {
        if (sweepAttacker) {
            try {
                sweepAttacker.setDynamicProperty(SWEEP_AOE_KEY, false);
            } catch (e) {}
        }
    }
});

// ==================== 玩家生成 / 离开 ====================

world.afterEvents.playerSpawn.subscribe((event) => {
    try {
        const player = event.player;
        if (!isValidEntity(player)) return;

        lastSelectedSlot.set(player.id, player.selectedSlotIndex);

        for (const [type, config] of Object.entries(WEAPON_CONFIG)) {
            player.setDynamicProperty(config.key, 0);
        }

        player.setDynamicProperty(SWEEP_READY_KEY, false);
        player.setDynamicProperty(SWEEP_AOE_KEY, false);
        player.setDynamicProperty(SWEEP_TOKEN_KEY, 0);

        player.setDynamicProperty(PARRY_STATE_KEY, 0);
        player.setDynamicProperty(PARRY_TIMER_KEY, 0);
        player.setDynamicProperty(PARRY_COOLDOWN_KEY, 0);
        player.setDynamicProperty(PARRY_SOUND_KEY, 0);
        player.setDynamicProperty(PARRY_REFLECT_KEY, false);

        clearTitle(player);  
    } catch (e) {}
});

world.afterEvents.playerLeave.subscribe((event) => {
    try {
        lastSelectedSlot.delete(event.playerId);
        lastHudValue.delete(event.playerId);
    } catch (e) {}
});

// ==================== 打方块 / 破坏方块重置冷却 ====================

world.afterEvents.entityHitBlock.subscribe((event) => {
    try {
        const damagingEntity = event.damagingEntity;
        if (!(damagingEntity instanceof Player)) return;
        if (!isValidEntity(damagingEntity)) return;
        resetCooldownForPlayer(damagingEntity);
    } catch (e) {}
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
    try {
        const player = event.player;
        if (!(player instanceof Player)) return;
        if (!isValidEntity(player)) return;
        resetCooldownForPlayer(player);
    } catch (e) {}
});