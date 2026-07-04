import { EntityDamageCause } from '@minecraft/server';

export const BulletEffects = {
    // dm48_s_ak 的函数
    dm48_s_ak: (target, attacker, projectile, dimension, runEffectCommands, hitLocation) => {
        if (Math.random() < 0.05) {
            const targets = dimension.getEntities({
                location: hitLocation,
                maxDistance: 8,
                closest: 3
            });

            for (const t of targets) {
                // [2.7.0] isValid() 方法 → isValid 属性
                if (!t.isValid) continue;
                t.applyDamage(34, { cause: EntityDamageCause.override, damagingEntity: attacker });
                t.applyDamage(34, { cause: EntityDamageCause.override, damagingEntity: attacker });
            }

            runEffectCommands(dimension, hitLocation, [
                "playsound dm.ak_shoot @a[r=33] ~~~ 2.8 1.5",
                "playsound dm.ak_shoot @a[r=33] ~~~ 2.8 1.5",
                "execute at @e[tag=!dm,family=monster,r=8,c=3] run particle dm:dm48_satt ^0.3 ^2 ^",
                "execute at @e[tag=!dm,family=monster,r=8,c=3] run particle dm:dm48_satt ^ ^2.1 ^",
                "execute at @e[tag=!dm,family=monster,r=8,c=3] run particle dm:dm48_satt ^ ^2 ^0.2"
            ]);
        }
    },

    // dm48_ak 的函数
    dm48_ak: (target, attacker, projectile, dimension, runEffectCommands, hitLocation) => {
        if (Math.random() < 0.03) {
            const targets = dimension.getEntities({
                location: hitLocation,
                maxDistance: 6,
                closest: 2
            });

            for (const t of targets) {
                // [2.7.0] isValid() 方法 → isValid 属性
                if (!t.isValid) continue;
                t.applyDamage(21, { cause: EntityDamageCause.override, damagingEntity: attacker });
                t.applyDamage(21, { cause: EntityDamageCause.override, damagingEntity: attacker });
            }

            runEffectCommands(dimension, hitLocation, [
                "playsound dm.ak_shoot @a[r=33] ~~~ 2.8 1.4",
                "playsound dm.ak_shoot @a[r=33] ~~~ 2.8 1.4",
                "execute at @e[tag=!dm,family=monster,r=6,c=2] run particle dm:dm48_att ^0.3 ^2 ^",
                "execute at @e[tag=!dm,family=monster,r=6,c=2] run particle dm:dm48_att ^ ^2.1 ^",
                "execute at @e[tag=!dm,family=monster,r=6,c=2] run particle dm:dm48_att ^ ^2 ^0.2"
            ]);
        }
    }
};
