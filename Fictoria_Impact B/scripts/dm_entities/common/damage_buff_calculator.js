// ============================================================
// 基岩版力量 / 虚弱伤害修正计算器
//
// 力量（通项）：d_n = 1.3^n × d_0 + (1.3^n − 1) / 0.3
// 虚弱（通项）：d_n = 0.8^n × d_0 + (0.8^n − 1) / 0.4
// 顺序：先力量后虚弱；n = amplifier + 1
// ============================================================

function getEffectLevel(entity, effectType) {
    try {
        if (!entity || !entity.isValid) return 0;
        const effect = entity.getEffect(effectType);
        if (!effect) return 0;
        return effect.amplifier + 1;
    } catch (_) {
        return 0;
    }
}

function applyStrength(baseDamage, n) {
    if (n <= 0) return baseDamage;
    const f = Math.pow(1.3, n);
    return f * baseDamage + (f - 1) / 0.3;
}

function applyWeakness(baseDamage, n) {
    if (n <= 0) return baseDamage;
    const f = Math.pow(0.8, n);
    return f * baseDamage + (f - 1) / 0.4;
}

export function applyBuffModifier(baseDamage, attacker) {
    try {
        if (!attacker || !attacker.isValid) return baseDamage;
        let d = baseDamage;
        
        const s = getEffectLevel(attacker, "strength");
        if (s > 0) d = applyStrength(d, s);
        
        const w = getEffectLevel(attacker, "weakness");
        if (w > 0) d = applyWeakness(d, w);
        
        return Math.max(0, d);
    } catch (_) {
        return baseDamage;
    }
}