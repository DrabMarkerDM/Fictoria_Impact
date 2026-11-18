import { system, EntityDamageCause } from '@minecraft/server';
import { applyBuffModifier } from "./damage_buff_calculator.js";
import {
    registerEntityHitHandler,
    registerAfterHurtHandler,
    ENTITY_HIT_PRIORITY,
    AFTER_HURT_PRIORITY
} from "./event_bus.js";

// 核心伤害配置表
const MELEE_CONFIG = {
    "player:dm8": {
        "sss": {
            damage: 48,
            cause: EntityDamageCause.magic,
            radius: 6, // 脚本 AOE 伤害半径
            limit: 4,  // 脚本 AOE 伤害上限
            // 指令组，由主目标执行
            commands: [
                "effect @e[family=monster,r=6,c=6,tag=!dm] weakness 8 8 ",
                "execute at @e[tag=!dm,family=monster,r=6,c=4] run particle dm:dm8_particle_1 ^ ^ ^ "
            ]
        }
    },
    // 实体 2：示例精英怪
    "dm:elite_knight ": {
        "heavy_strike ": {
            damage: 50,
            cause: EntityDamageCause.entityAttack
        },
        "ground_smash ": {
            damage: 20,
            cause: EntityDamageCause.override,
            radius: 3,
            commands: [
                "effect @e[r=3, c=10] slowness 2 1 true "
            ]
        }
    }
};

const PROPERTY_KEY = "dm:attack_state";

export const meleeImpactHandler = () => {
    registerEntityHitHandler("melee_impact", (event) => {
        const attacker = event.damagingEntity;
        const mainTarget = event.hitEntity;

        // [2.7.0] isValid 是属性，不是方法
        if (!attacker?.isValid || !mainTarget?.isValid) return;

        const entityConfigs = MELEE_CONFIG[attacker.typeId];
        if (!entityConfigs) return;

        // 读取实体的 Property (对应 dm8.json 中的定义)
        const state = attacker.getProperty(PROPERTY_KEY);
        const config = entityConfigs[state];
        if (!config) return;

        system.run(() => {
            // 0. 计算经过力量/虚弱修正的伤害（基岩版公式）

            // 只计算一次，主目标和 AOE 共用。
            const buffedDamage = applyBuffModifier(config.damage, attacker);

            // 1. 脚本应用主目标伤害
            mainTarget.applyDamage(buffedDamage, {
                'cause': config.cause,
                'damagingEntity': attacker
            });

            // 2. 指令组现在只在主目标身上运行
            // 遍历执行数组中的所有指令
            if (config.commands && Array.isArray(config.commands)) {
                for (const cmd of config.commands) {
                    try {
                        mainTarget.runCommand(cmd);
                    } catch (e) {
                        // 某条指令失败不影响整体
                    }
                }
            }

            // 3. 脚本继续处理范围内的高额伤害
            if (config.radius) {
                let splashTargets = attacker.dimension.getEntities({
                    location: mainTarget.location,
                    maxDistance: config.radius,
                    excludeEntities: [attacker, mainTarget],
                    families: ["monster"]
                });

                // 排序
                splashTargets.sort((a, b) => {
                    const distA = Vector3Distance(mainTarget.location, a.location);
                    const distB = Vector3Distance(mainTarget.location, b.location);
                    return distA - distB;
                });

                // 脚本限额截取
                if (config.limit && splashTargets.length > config.limit) {
                    splashTargets = splashTargets.slice(0, config.limit);
                }

                // 施加脚本层面的伤害（使用修正后的伤害）
                for (const sideTarget of splashTargets) {
                    sideTarget.applyDamage(buffedDamage, {
                        'cause': config.cause,
                        'damagingEntity': attacker
                    });
                }
                attacker.dimension.spawnParticle("minecraft:large_explosion", mainTarget.location);
            }
        });
    }, ENTITY_HIT_PRIORITY.MELEE_IMPACT);
};

function Vector3Distance(loc1, loc2) {
    return Math.sqrt(
        Math.pow(loc1.x - loc2.x, 2) +
        Math.pow(loc1.y - loc2.y, 2) +
        Math.pow(loc1.z - loc2.z, 2)
    );
}

// ═══════════════════════════════════════════════════════════════
// 女仆长矛：戳刺动画 + 小范围群攻（2026-11-12 加）
//
// 和上面的 MELEE_CONFIG 那条链无关：那条是"按属性表给指定实体发脚本伤害"，
// 这条只处理 player:dm34 / dm34_1 在长矛形态（variant 8）下的命中。
//
//   ① 动画：控制器靠 variable.attack_time 进出攻击态，那变量在 mob 上不保证
//      两次攻击之间归零，状态卡着就不重播（"打好几下才播一次""走路时完全不播"）。
//      每次命中 playAnimation 一遍才精确对齐。
//   ② 群攻：主目标挨的是**引擎算好的实伤** —— 长矛品质、附魔、力量 buff、
//      目标护甲全在里面。溅射按比例摊给主目标周围的敌人，不再叠第二遍公式。
// ═══════════════════════════════════════════════════════════════

const MAID_SPEAR_IDS = ["player:dm34", "player:dm34_1"];
const SPEAR_VARIANT = 8;

const SPEAR_AOE = {
    animation: "animation.dm34_spear_attack",
    radius: 2.2,        // 以主目标为圆心的群攻半径（格）
    maxTargets: 3,      // 最多额外命中几个（不含主目标）
    factor: 0.55,       // 溅射伤害 = 主目标实伤 × 系数
    minDamage: 2,
    capDamage: 24,

    // 命中后给自己挂 3 秒速度 II（60 tick，amplifier 1），无粒子
    buffTicks: 60,
    buffAmplifier: 1,

    // 主目标额外击退：盾牌格挡用 1.2 / 0.45，这里不到一半
    knockHorizontal: 0.55,
    knockVertical: 0.18,
};

const SpearHitLock = new Map();     // 实体 id -> 锁到哪一 tick（含）
let spearSplashBusy = false;        // 同步重入闸

function spearVariantOf(entity) {
    try {
        const c = entity.getComponent("minecraft:variant");
        return c ? c.value : 0;
    } catch (e) {
        return 0;
    }
}

function playSpearStab(entity) {
    try {
        entity.playAnimation(SPEAR_AOE.animation, { blendOutTime: 0.06 });
    } catch (e) {
        try {
            entity.runCommand(`playanimation @s ${SPEAR_AOE.animation}`);
        } catch (e2) { /* 忽略 */ }
    }
}

function spearDist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

/** 命中后给自己挂 3 秒速度 II（无粒子）。
 *  已有更持久的同级/更强效果时不覆盖（别用 3 秒盖掉玩家喂的 10 秒）；速度 I 会被升级。 */
function spearBuffSelf(unit) {
    let cur;
    try { cur = unit.getEffect("speed"); } catch (e) { cur = undefined; }

    if (cur &&
        cur.amplifier >= SPEAR_AOE.buffAmplifier &&
        cur.duration > SPEAR_AOE.buffTicks) {
        return;
    }

    try {
        unit.addEffect("speed", SPEAR_AOE.buffTicks, {
            amplifier: SPEAR_AOE.buffAmplifier,
            showParticles: false,
        });
    } catch (e) { /* 忽略 */ }
}

/** 主目标额外被推开一点：方向 = 女仆 → 目标，同 shield_block.knockBack，力度减半 */
function spearShove(unit, victim) {
    let dx = 0;
    let dz = 0;

    try {
        dx = victim.location.x - unit.location.x;
        dz = victim.location.z - unit.location.z;
    } catch (e) {
        return;
    }

    const len = Math.sqrt(dx * dx + dz * dz);

    try {
        if (len < 1e-4) {
            victim.applyKnockback({ x: 0, z: 0 }, SPEAR_AOE.knockVertical);
            return;
        }
        victim.applyKnockback(
            {
                x: (dx / len) * SPEAR_AOE.knockHorizontal,
                z: (dz / len) * SPEAR_AOE.knockHorizontal,
            },
            SPEAR_AOE.knockVertical
        );
    } catch (e) { /* 不可击退 / 旧签名，忽略 */ }
}

function spearSplash(unit, main, rawDamage) {
    const base = typeof rawDamage === "number" && rawDamage > 0 ? rawDamage : 0;
    const damage = Math.min(SPEAR_AOE.capDamage, Math.max(SPEAR_AOE.minDamage, base * SPEAR_AOE.factor));

    let list;

    try {
        list = unit.dimension.getEntities({
            location: main.location,
            maxDistance: SPEAR_AOE.radius,
            families: ["monster"],
        });
    } catch (e) {
        return;
    }

    if (!list || list.length === 0) return;

    const picks = [];

    for (const e of list) {
        if (!e || !e.isValid) continue;
        if (e.id === unit.id || e.id === main.id) continue;
        picks.push(e);
    }

    if (picks.length === 0) return;

    picks.sort((a, b) => spearDist2(a.location, main.location) - spearDist2(b.location, main.location));

    const targets = picks.slice(0, SPEAR_AOE.maxTargets);

    spearSplashBusy = true;

    try {
        for (const t of targets) {
            try {
                if (!t.isValid) continue;
                t.applyDamage(damage, {
                    cause: "entityAttack",
                    damagingEntity: unit,
                });
            } catch (e) {
                try {
                    if (t.isValid) t.applyDamage(damage);
                } catch (e2) { /* 忽略 */ }
            }
        }
    } finally {
        spearSplashBusy = false;
    }
}

function onMaidSpearHurt(event) {
    try {
        const src = event.damageSource;

        if (!src) return;

        const unit = src.damagingEntity;

        if (!unit || !unit.isValid) return;
        if (MAID_SPEAR_IDS.indexOf(unit.typeId) < 0) return;

        const victim = event.hurtEntity;

        if (!victim || !victim.isValid) return;
        if (victim.id === unit.id) return;

        // 只认近战（她自己戳出去的那一下）
        if (src.cause !== "entityAttack") return;

        const tick = system.currentTick;
        const locked = SpearHitLock.get(unit.id) || -1;

        if (tick <= locked) return;
        if (spearSplashBusy) return;

        SpearHitLock.set(unit.id, tick + 1);

        if (spearVariantOf(unit) !== SPEAR_VARIANT) return;

        playSpearStab(unit);
        spearBuffSelf(unit);         // 3 秒速度 II（无粒子）
        spearShove(unit, victim);    // 主目标额外被推开一点
        spearSplash(unit, victim, event.damage);
    } catch (e) {
        // 高频链路：静默
    }
}

/** 女仆长矛命中层。和 meleeImpactHandler 一起在 events() 里挂。 */
export const maidSpearImpact = () => {
    registerAfterHurtHandler("maid_spear_impact", onMaidSpearHurt, AFTER_HURT_PRIORITY.MELEE_IMPACT);
};
