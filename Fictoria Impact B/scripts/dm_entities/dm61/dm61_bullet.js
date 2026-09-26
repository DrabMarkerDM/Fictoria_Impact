// ============================================================
// dm61弹射物特效js
// ============================================================

export const BulletEffects61 = {
    dm61_hit: (target, _attacker, _projectile, dimension, runEffectCommands, hitLocation) => {
        // 1. 获取受影响的目标（主目标 + AOE 范围内的怪物）
        let affectedTargets = [];
        try {
            // 搜索半径 3 格（与 bullet_manager 中的 AOE 半径保持一致）
            affectedTargets = dimension.getEntities({
                location: hitLocation,
                maxDistance: 3,
                families: ["monster"]
            });
        } catch (_) {}

        // 兜底：如果因为某些原因没搜到，至少确保主目标在列表中
        if (affectedTargets.length === 0 && target && target.isValid) {
            affectedTargets.push(target);
        }

        // 2. 遍历施加效果
        for (const t of affectedTargets) {
            if (!t || !t.isValid) continue;
            if (t.hasTag("dm")) continue; // 绝对不作用于友军

            // ── 施加 255级迟缓，持续 2 秒 ──
            try {
                t.runCommand("effect @s slowness 2 255 false");
            } catch (_) {
                // 极少部分实体可能没有执行指令权限，用 dimension 兜底
                try {
                    dimension.runCommand(`effect @e[r=0.1,limit=1,sort=nearest] slowness 2 255 false`);
                } catch(_) {}
            }

            // ── 施加自定义粒子 dm:dm61_hit ──
            try {
                dimension.spawnParticle("dm:dm61_hit", {
                    x: t.location.x,
                    y: t.location.y + 1.0, // 抬高 1 格，让粒子在怪物躯干/头部爆开，而不是脚底
                    z: t.location.z
                });
            } catch (_) {
                // spawnParticle 失败时的指令兜底
                try {
                    runEffectCommands(dimension, t.location, [
                        "particle dm:dm61_hit ^ ^1 ^"
                    ]);
                } catch(_) {}
            }
        }
    }
};