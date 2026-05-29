import { EntityDamageCause, Entity } from '@minecraft/server';
import { BulletEffects } from '../dm48/dm48_bullet.js'; // 导入分离的逻辑文件

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
    // 默认override伤害
    "bullet:dm34_m4a1": new BulletDamage('M4A1', "bullet_m4a1", 6),
    "bullet:dm34_moss": new BulletDamage('MOSS', "bullet_moss", 46),
    "bullet:dm34_awp": new BulletDamage('AWP', "bullet_awp", 59),
    "bullet:dm34_glock": new BulletDamage('GLOCK', "bullet_glock", 4),

    // 仅用于监听
    "bullet:dm48_s_ak_bullet": new BulletDamage('AK_S', "bullet_ak", 0, EntityDamageCause.override, BulletEffects.dm48_s_ak),
    "bullet:dm48_ak_bullet": new BulletDamage('AK', "bullet_ak", 0, EntityDamageCause.override, BulletEffects.dm48_ak),
    // 魔法magic伤害
    "bullet:amiya_shoot": new BulletDamage('amiya_shoot', "bullet_amiya_shoot", 29, EntityDamageCause.magic),
    "bullet:s_amiya_shoot": new BulletDamage('s_amiya_shoot', "bullet_s_amiya_shoot", 86, EntityDamageCause.magic),
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
        if (!target || !target.isValid() || target.hasTag("dm")) return;
        
        const attacker = bulletImpactInfo.source; // 获取攻击者

        // ================= 【核心：至高无上拦截层】 =================
        // 判定受害者是不是马
       const ALLIED_TYPES = [
    "minecraft:horse",
    "minecraft:donkey",
    "minecraft:mule",
    "minecraft:skeleton_horse",
    "minecraft:zombie_horse",
    "minecraft:wolf",       // 驯服的狼
    "minecraft:cat",        // 驯服的猫
    "minecraft:parrot",     // 鹦鹉
    "minecraft:player",
    // 未来添加更多...
];

const ALLIED_FAMILIES = ["horse", "wolf", "cat"];

const isAllied = target.matches({ families: ALLIED_FAMILIES }) || 
                 ALLIED_TYPES.includes(target.typeId);

        if (isAllied && attacker && attacker.isValid()) {
            // 如果攻击者属于 dm 家族（女仆等），直接在这里【彻底斩断流。
            if (attacker.matches({ families: ["dm"] })) {
                return; // 后面所有的伤害、特效、击退全部进不去，马儿直接免疫！
            }
        }
        // ==========================================================
        
        const dimension = target.dimension; 
        const hitLocation = { x: target.location.x, y: target.location.y, z: target.location.z };

        // 2. 应用基础伤害
        if (config.damage > 0) {
            target.applyDamage(config.damage, {
                cause: config.cause,
                damagingEntity: attacker
            });
        }

        // 3. 执行分离的特殊效果（现在由于上面 return 了，马儿绝对吃不到特效了）
       if (config.extraEffect) {
    config.extraEffect(target, attacker, projectile, dimension, runEffectCommands, hitLocation);
}
    } catch (e) {
        console.error("子弹碰撞结算异常: " + e);
    }
};