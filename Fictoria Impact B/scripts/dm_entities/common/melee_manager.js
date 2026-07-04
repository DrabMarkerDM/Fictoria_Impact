import { world, system, EntityDamageCause } from '@minecraft/server';

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
                "effect @e[family=monster,r=6,c=6,tag=!dm] weakness 8 8",
                "execute at @e[tag=!dm,family=monster,r=6,c=4] run particle dm:dm8_particle_1 ^ ^ ^"
            ]
        }
    },
    // 实体 2：示例精英怪
    "dm:elite_knight": {
        "heavy_strike": { 
            damage: 50, 
            cause: EntityDamageCause.entityAttack 
        },
        "ground_smash": {
            damage: 20,
            cause: EntityDamageCause.override,
            radius: 3,
            commands: [
                "effect @e[r=3, c=10] slowness 2 1 true"
            ]
        }
    }
};

const PROPERTY_KEY = "dm:attack_state"; //

export const meleeImpactHandler = () => {
    world.afterEvents.entityHitEntity.subscribe((event) => {
        const attacker = event.damagingEntity;
        const mainTarget = event.hitEntity;

        // [2.0.0 变更] isValid 从方法变为只读属性，去掉括号
        if (!attacker?.isValid || !mainTarget?.isValid) return;

        const entityConfigs = MELEE_CONFIG[attacker.typeId];
        if (!entityConfigs) return; 

        // 读取实体的 Property (对应 dm8.json 中的定义)
        const state = attacker.getProperty(PROPERTY_KEY);
        const config = entityConfigs[state];
        if (!config) return; 

        system.run(() => {
            // 1. 脚本应用主目标伤害
            mainTarget.applyDamage(config.damage, {
                'cause': config.cause,
                'damagingEntity': attacker
            });

            // 2. 【核心修改】指令组现在只在主目标身上运行
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

            // 3. 脚本继续处理范围内的 5500 高额伤害
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

                // 施加脚本层面的伤害
                for (const sideTarget of splashTargets) {
                    sideTarget.applyDamage(config.damage, {
                        'cause': config.cause,
                        'damagingEntity': attacker
                    });
                }

                attacker.dimension.spawnParticle("minecraft:large_explosion", mainTarget.location);
            }
        });
    });
};

function Vector3Distance(loc1, loc2) {
    return Math.sqrt(
        Math.pow(loc1.x - loc2.x, 2) +
        Math.pow(loc1.y - loc2.y, 2) +
        Math.pow(loc1.z - loc2.z, 2)
    );
}