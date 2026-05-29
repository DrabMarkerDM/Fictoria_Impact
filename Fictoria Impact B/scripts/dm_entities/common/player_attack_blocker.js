import { world, system } from "@minecraft/server";

world.afterEvents.entityHurt.subscribe((event) => {
    try {
        const victim = event.hurtEntity;
        if (!victim || !victim.isValid()) return;

        const attacker = event.damageSource?.damagingEntity;
        if (!attacker || attacker.typeId !== "minecraft:player") return;
        if (!victim.matches({ families: ["dm"] })) return;

        const damageAmount = event.damage;
        if (damageAmount <= 0) return;

        // 立即执行，缩短红屏时间
        const healthComp = victim.getComponent("minecraft:health");
        if (healthComp) {
            const currentHealth = healthComp.currentValue;
            healthComp.setCurrentValue(Math.min(healthComp.effectiveMax, currentHealth + damageAmount));
        }

        // 同步清除速度
        try { victim.clearVelocity(); } catch (e) {}

        // 同步灭火
        try { victim.extinguishFire(true); } catch (e) {}

        // 防止反击
        victim.target = null;

    } catch (e) {
        // 静默处理
    }
});

console.warn("[DM-Engine] 防误伤保护已载入");