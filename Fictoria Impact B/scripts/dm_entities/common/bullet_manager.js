import { EntityDamageCause, Entity, world } from '@minecraft/server';
import { BulletEffects } from '../dm48/dm48_bullet.js';
import { shouldBlockProjectileFriendlyFire } from "./player_attack_blocker.js";
// BulletDamage 类
class BulletDamage {
    constructor(gun, caliber, damage, cause = EntityDamageCause.override, extraEffect = null) {
        this.gun = gun;
        this.caliber = caliber;
        this.damage = damage;
        this.cause = cause;
        this.extraEffect = extraEffect; 
    }
}
// 3.1 配置 DAMAGE 表
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
    "bullet:dm61_bullet_1": new BulletDamage('dm61_bullet_1', "bullet_dm61_bullet_1", 161, EntityDamageCause.magic)
};
// 辅助函数：安全执行指令
const runEffectCommands = (dimension, loc, commands) => {
    const { x, y, z } = loc;
    for (const cmd of commands) {
        try {
            dimension.runCommand(`execute positioned ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)} run ${cmd}`);
        } catch (e) {}
    }
};
export const bulletEntityImpact = (bulletImpactInfo) => {
    try {
        const projectile = bulletImpactInfo.projectile;
        if (!projectile) return;
        const bulletTypeId = projectile.typeId;
        const config = DAMAGE[bulletTypeId];
        if (!config) return;
        const hitRecord = bulletImpactInfo.getEntityHit();
        if (!hitRecord) return;
        const target = hitRecord.entity;
        // 1. 基础合法性与原有 tag 过滤
        // ★★★ 关键：isValid 是属性不是方法，不要加括号 ★★★
        if (!target || !target.isValid || target.hasTag("dm")) return;
        
        const attacker = bulletImpactInfo.source; // 获取攻击者
        // 2. 弹射物友伤拦截（调用统一函数）
        if (shouldBlockProjectileFriendlyFire(target, attacker)) {
            return; // 拦截：不应用伤害和特效
        }
        
        const dimension = target.dimension; 
        const hitLocation = { x: target.location.x, y: target.location.y, z: target.location.z };
        // 3. 应用基础伤害
        if (config.damage > 0) {
            target.applyDamage(config.damage, {
                cause: config.cause,
                damagingEntity: attacker
            });
        }
        // 4. 执行分离的特殊效果
        if (config.extraEffect) {
            config.extraEffect(target, attacker, projectile, dimension, runEffectCommands, hitLocation);
        }
    } catch (e) {
        console.error("子弹碰撞结算异常: " + e);
    }
};