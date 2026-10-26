import { EntityDamageCause } from '@minecraft/server';
import { BulletEffects } from '../dm48/dm48_bullet.js';
import { BulletEffects61 } from '../dm61/dm61_bullet.js';
import { shouldBlockProjectileFriendlyFire } from "./player_attack_blocker.js";
import { applyBuffModifier } from "./damage_buff_calculator.js";

// ============================================================
// BulletDamage 类
//
// 第 6 个参数 aoeConfig（对群配置，和 melee_manager 风格一致）：
// {
//     aoeEnabled: boolean,  // 对群总开关（默认 false / 不传 = 关闭）
//     radius: number,       // 对群范围（格），默认 3
//     limit: number         // 最大攻击敌人数量，0 = 无限制，默认 4
// }
//
// 对群模式只有一种：命中后对群（dm48 模式）。
// 命中瞬间以命中点为中心做范围伤害。
// 贯穿对群已移交 JSON 层（area_attack / 动画控制器）。
// ============================================================
class BulletDamage {
    constructor(gun, caliber, damage, cause = EntityDamageCause.override, extraEffect = null, aoeConfig = null) {
        this.gun = gun;
        this.caliber = caliber;
        this.damage = damage;
        this.cause = cause;
        this.extraEffect = extraEffect;

        if (aoeConfig && typeof aoeConfig === "object" && aoeConfig.aoeEnabled === true) {
            this.aoeConfig = {
                aoeEnabled: true,
                radius: (typeof aoeConfig.radius === "number" && aoeConfig.radius > 0) ? aoeConfig.radius : 3,
                limit: (typeof aoeConfig.limit === "number" && aoeConfig.limit >= 0) ? Math.floor(aoeConfig.limit) : 4
            };
        } else {
            this.aoeConfig = null;
        }
    }
}

// ============================================================
// DAMAGE 配置表
// ============================================================
const DAMAGE = {
    "bullet:dm34_m4a1": new BulletDamage('M4A1', "bullet_m4a1", 6),
    "bullet:dm34_moss": new BulletDamage('MOSS', "bullet_moss", 46),
    "bullet:dm34_awp": new BulletDamage('AWP', "bullet_awp", 59),
    "bullet:dm34_glock": new BulletDamage('GLOCK', "bullet_glock", 4),
    "bullet:dm48_s_ak_bullet": new BulletDamage('AK_S', "bullet_ak", 0, EntityDamageCause.override, BulletEffects.dm48_s_ak),
    "bullet:dm48_ak_bullet": new BulletDamage('AK', "bullet_ak", 0, EntityDamageCause.override, BulletEffects.dm48_ak),
    "bullet:amiya_shoot": new BulletDamage('amiya_shoot', "bullet_amiya_shoot", 29, EntityDamageCause.magic),
    "bullet:s_amiya_shoot": new BulletDamage('s_amiya_shoot', "bullet_s_amiya_shoot", 106, EntityDamageCause.magic),
    "bullet:lightball": new BulletDamage('lightball', "bullet_lightball", 25, EntityDamageCause.magic),
    "bullet:lightball_1": new BulletDamage('lightball_1', "bullet_lightball_1", 30, EntityDamageCause.magic),

    // dm61：命中后对群，3 格范围，无数量限制
    "bullet:dm61_bullet_1": new BulletDamage(
        'dm61_bullet_1', 
        "bullet_dm61_bullet_1", 
        161, 
        EntityDamageCause.magic, 
        BulletEffects61.dm61_hit, // 绑定特效
        {
            aoeEnabled: true,
            radius: 3,
            limit: 0
        }
    )
};

// ============================================================
// 辅助函数：安全执行指令
// ============================================================
const runEffectCommands = (dimension, loc, commands) => {
    const { x, y, z } = loc;
    for (const cmd of commands) {
        try {
            dimension.runCommand(`execute positioned ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)} run ${cmd}`);
        } catch (e) {}
    }
};

// ============================================================
// 主碰撞结算
//
// 流程：
// 1. 主目标受基础伤害（带力量/虚弱修正）
// 2. 若开启对群：以命中点为中心做范围伤害（带修正）
// 3. 执行 extraEffect（dm48 特效等）
// ============================================================
export const bulletEntityImpact = (bulletImpactInfo) => {
    try {
        const projectile = bulletImpactInfo.projectile;
        if (!projectile) return;

        const config = DAMAGE[projectile.typeId];
        if (!config) return;

        const hitRecord = bulletImpactInfo.getEntityHit();
        if (!hitRecord) return;

        const target = hitRecord.entity;
        if (!target || !target.isValid || target.hasTag("dm")) return;

        const attacker = bulletImpactInfo.source;
        if (shouldBlockProjectileFriendlyFire(target, attacker)) return;

        const dimension = target.dimension;
        const hitLocation = {
            x: target.location.x,
            y: target.location.y,
            z: target.location.z
        };

        // ── 1. 主目标基础伤害（带 buff 修正）──
        if (config.damage > 0) {
            const buffedDamage = applyBuffModifier(config.damage, attacker);
            target.applyDamage(buffedDamage, {
                cause: config.cause,
                damagingEntity: attacker
            });
        }

        // ── 2. 命中后对群（dm48 模式）──
        if (config.aoeConfig) {
            const aoe = config.aoeConfig;
            let aoeTargets;
            try {
                const queryOptions = {
                    location: hitLocation,
                    maxDistance: aoe.radius,
                    excludeEntities: [attacker, target],
                    families: ["monster"]
                };
                // limit > 0 时用 closest 让引擎直接返回最近的 N 个
                if (aoe.limit > 0) queryOptions.closest = aoe.limit;
                aoeTargets = dimension.getEntities(queryOptions);
            } catch (_) {
                aoeTargets = [];
            }

            if (aoeTargets && aoeTargets.length > 0) {
                const buffedAoeDamage = applyBuffModifier(config.damage, attacker);
                for (const t of aoeTargets) {
                    if (!t || !t.isValid) continue;
                    if (t.hasTag("dm")) continue;
                    if (shouldBlockProjectileFriendlyFire(t, attacker)) continue;
                    try {
                        t.applyDamage(buffedAoeDamage, {
                            cause: config.cause,
                            damagingEntity: attacker
                        });
                    } catch (_) {}
                }
            }
        }

        // ── 3. 特殊效果 ──
        if (config.extraEffect) {
            config.extraEffect(target, attacker, projectile, dimension, runEffectCommands, hitLocation);
        }
    } catch (e) {
        console.error("子弹碰撞结算异常: " + e);
    }
};