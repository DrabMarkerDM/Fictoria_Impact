import { system, world, EntityDamageCause } from "@minecraft/server";

// ============================================================
// 日志开关
// false：关闭高频诊断日志，性能更好
// true：恢复输出近战预测、格挡、冲刺等日志
// ============================================================
const DEBUG_MELEE = true;

function meleeLog(...args) {
    if (DEBUG_MELEE) {
        console.warn(...args);
    }
}

function getDistSq(a, b) {
    if (!a || !b) return 99999;
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

// ============================================================
// 攻击者溯源：
// Boss近战AOE以“友方位置生成弹射物”实现时，
// 把弹射物伤害归因给真正施法者（owner → 最近怪物），
// 防止污染 EWMA 威胁参照 / 决斗识别。
// ============================================================
function resolveRealAttacker(attacker, victim) {
    try {
        if (!attacker || !attacker.isValid) return attacker;

        const isProjectile =
            (attacker.matches && attacker.matches({ families: ["projectile"] })) ||
            (attacker.typeId && attacker.typeId.includes("bullet"));

        if (!isProjectile) return attacker;

        // 1) 弹射物组件 owner
        try {
            const projComp = attacker.getComponent("minecraft:projectile");
            if (projComp && projComp.owner && projComp.owner.isValid) {
                return projComp.owner;
            }
        } catch (_) {}

        // 2) entity_owner 组件
        try {
            const ownerComp = attacker.getComponent("minecraft:entity_owner");
            if (ownerComp && ownerComp.ownerId) {
                const owner = world.getEntity(ownerComp.ownerId);
                if (owner && owner.isValid) return owner;
            }
        } catch (_) {}

        // 3) 兜底：归因给受害者附近最近的怪物
        const nearby = victim.dimension.getEntities({
            location: victim.location,
            maxDistance: 24,
            families: ["monster"]
        });

        let nearest = null;
        let minD = 24 * 24;

        for (const e of nearby) {
            if (!e.isValid) continue;

            const d = getDistSq(e.location, victim.location);
            if (d < minD) {
                minD = d;
                nearest = e;
            }
        }

        if (nearest) return nearest;
    } catch (_) {}

    return attacker;
}

// ============================================================
// 缓存区
// ============================================================
const MeleeDamageLogCache = new Map();
const PendingHurtLedger = new Map();
const MeleeCycleCache = new Map();

// 优化：血量采样不再使用 DynamicProperty + JSON，
// 改为纯内存缓存，降低每 5 tick 的 JSON.parse / JSON.stringify 开销。
const HpSamplesCache = new Map();

// ============================================================
// 实体移除时统一清理缓存，降低内存泄漏风险
// ============================================================
try {
    world.beforeEvents.entityRemove.subscribe((event) => {
        try {
            const id = event.removedEntity?.id;
            if (!id) return;

            MeleeDamageLogCache.delete(id);
            PendingHurtLedger.delete(id);
            MeleeCycleCache.delete(id);
            HpSamplesCache.delete(id);
        } catch (_) {}
    });
} catch (_) {}

/**
 * Fictoria_Impact 近战走位动力学引擎 v2.26 性能优化版
 *
 * 保持原逻辑：
 * - EWMA 威胁目标
 * - 缓冲层栅栏
 * - 真实受击佐证
 * - 统一周期引擎
 * - 格挡机制
 * - 冲刺 / 稳健后撤
 * - 卡墙 / 卡死恢复
 *
 * 主要性能优化：
 * - 血量采样改内存 Map
 * - 复用 HP 信息
 * - 复用观测净斜率
 * - 实体移除清理缓存
 * - 格挡后实体操作延后到 system.run
 * - 高频日志可关闭
 */
export class MovementMelee {

    // ══════════════════════════════════════════════════
    //  生命值工具函数
    // ══════════════════════════════════════════════════

    static _getEffectiveMaxHp(unit) {
        let baseMaxHp = 20;

        try {
            const hpComp = unit.getComponent("minecraft:health") ?? unit.getComponent("health");
            if (hpComp && hpComp.defaultValue > 0) {
                baseMaxHp = hpComp.defaultValue;
            }
        } catch (_) {}

        let extraHp = 0;

        try {
            const healthBoostEffect = unit.getEffect("health_boost");
            if (healthBoostEffect) {
                extraHp += (healthBoostEffect.amplifier + 1) * 4;
            }
        } catch (_) {}

        return Math.min(baseMaxHp + extraHp, 20000);
    }

    static _getAbsorptionHp(unit) {
        try {
            const e = unit.getEffect("absorption");
            if (e) return (e.amplifier + 1) * 4;
        } catch (_) {}

        return 0;
    }

    static _getHpInfo(unit) {
        const hpComp = unit.getComponent("minecraft:health") ?? unit.getComponent("health");
        if (!hpComp) return null;

        const realHp = hpComp.currentValue;
        const baseMax = MovementMelee._getEffectiveMaxHp(unit);
        const absHp = MovementMelee._getAbsorptionHp(unit);
        const maxHp = Math.min(baseMax + absHp, 20000);

        let hp = realHp;
        if (hp <= baseMax + 1 && absHp > 0) {
            hp += absHp;
        }

        return {
            hp,
            realHp,
            maxHp,
            absHp,
            baseMax,
            hpComp
        };
    }

    static _logDamage(unit, nowTick, actualDamage) {
        let log = MeleeDamageLogCache.get(unit.id);

        if (!log) {
            log = [];
            MeleeDamageLogCache.set(unit.id, log);
        }

        log.push({
            tick: nowTick,
            amount: actualDamage
        });

        if (log.length > 30) {
            MeleeDamageLogCache.set(
                unit.id,
                log.filter(e => nowTick - e.tick < 150)
            );
        }
    }

    // ══════════════════════════════════════════════════
    //  回血速率工具函数
    // ══════════════════════════════════════════════════

    static _getRegenHps(unit) {
        try {
            const regen = unit.getEffect("regeneration");
            if (regen) {
                const interval = 50 >> regen.amplifier;
                return 20 / (interval > 0 ? interval : 1);
            }
        } catch (_) {}

        return 0;
    }

    static _getInitialModelHps(unit) {
        return MovementMelee._getRegenHps(unit);
    }

    // 观测净血量斜率（HP/s）
    // 优化：从内存 HpSamplesCache 读取，不再 JSON.parse DynamicProperty
    static _getObservedNetHps(unit) {
        try {
            const samples = HpSamplesCache.get(unit.id);

            if (!Array.isArray(samples) || samples.length < 3) {
                return null;
            }

            const deltas = [];

            for (let i = 1; i < samples.length; i++) {
                const dt = samples[i].t - samples[i - 1].t;

                if (dt <= 0 || dt > 40) continue;

                const perSec = (samples[i].h - samples[i - 1].h) / (dt / 20);

                if (Math.abs(perSec) > 200) continue;

                deltas.push(perSec);
            }

            if (deltas.length < 3) return null;

            deltas.sort((a, b) => a - b);

            return deltas[Math.floor(deltas.length / 2)];
        } catch (_) {
            return null;
        }
    }

    // ══════════════════════════════════════════════════
    //  攻击模式识别工具函数
    // ══════════════════════════════════════════════════

    static _updateMeleePattern(attackerId, victimId, rawDamage, nowTick, currentHp) {
        try {
            let p = MeleeCycleCache.get(victimId);

            if (!p) {
                p = {
                    heavyThreshold: 0,
                    lastHeavyTick: 0,
                    heavyGapTotal: 0,
                    heavyGapCount: 0,
                    heavyDamageEma: 0,
                    heavyCount: 0,
                    rawSingleEma: 0,
                    rawSingleTick: 0,
                    windowThreshold: 0,
                    lastPeakTick: 0,
                    peakGapTotal: 0,
                    peakGapCount: 0,
                    peakDmgEma: 0,
                    peakMaxSingleEma: 0,
                    peakCount: 0,
                    attackerDamage: new Map()
                };

                MeleeCycleCache.set(victimId, p);
            }

            p.heavyThreshold = Math.max(currentHp * 0.50, 15);

            // 攻击者 EWMA 威胁分数
            try {
                let ad = p.attackerDamage.get(attackerId);

                if (!ad) {
                    ad = {
                        score: 0,
                        tick: nowTick
                    };
                    p.attackerDamage.set(attackerId, ad);
                }

                ad.score = (ad.score ?? 0) + rawDamage;
                ad.tick = nowTick;

                for (const [id, rec] of p.attackerDamage) {
                    if (nowTick - rec.tick > 60) {
                        p.attackerDamage.delete(id);
                    }
                }
            } catch (_) {}

            // 重刀检测
            if (rawDamage >= p.heavyThreshold) {
                if (p.lastHeavyTick > 0) {
                    const gap = nowTick - p.lastHeavyTick;
                    if (gap > 10 && gap < 400) {
                        p.heavyGapTotal += gap;
                        p.heavyGapCount++;
                    }
                }

                p.lastHeavyTick = nowTick;
                p.heavyDamageEma = p.heavyCount === 0
                    ? rawDamage
                    : p.heavyDamageEma * 0.7 + rawDamage * 0.3;
                p.heavyCount++;
            }

            // 原始单发伤害 EMA
            try {
                const lastRawTick = p.rawSingleTick ?? 0;

                p.rawSingleEma = (nowTick - lastRawTick > 60)
                    ? rawDamage
                    : Math.max(p.rawSingleEma ?? 0, rawDamage);

                p.rawSingleTick = nowTick;
            } catch (_) {}
        } catch (_) {}
    }

    static _isDuel(pattern, nowTick) {
        try {
            if (!pattern || pattern.attackerDamage.size === 0) return true;

            let total = 0;
            let top = 0;

            for (const [id, rec] of pattern.attackerDamage) {
                if (nowTick - rec.tick > 60) continue;

                const sc = rec.score ?? 0;
                total += sc;

                if (sc > top) top = sc;
            }

            if (total <= 0) return true;

            return top / total >= 0.70;
        } catch (_) {
            return true;
        }
    }

    // 统一周期分析
    // 优化：允许外部传入 hpInfo，避免重复读取 health / effect
    static _analyzeUnifiedCycle(unit, nowTick, cacheEntry, hpInfo = null) {
        try {
            if (!cacheEntry) return null;

            const info = hpInfo ?? MovementMelee._getHpInfo(unit);
            if (!info) return null;

            const currentHp = info.hp;
            const p = cacheEntry;

            p.windowThreshold = Math.max(currentHp * 0.40, 12);

            let windowSum = 0;
            let windowMaxSingle = 0;
            let total60 = 0;

            const history = MeleeDamageLogCache.get(unit.id) ?? [];

            for (const log of history) {
                if (nowTick - log.tick <= 10 && log.amount > 0.5) {
                    windowSum += log.amount;

                    if (log.amount > windowMaxSingle) {
                        windowMaxSingle = log.amount;
                    }
                }

                if (nowTick - log.tick <= 60 && log.amount > 0.5) {
                    total60 += log.amount;
                }
            }

            if (windowSum >= p.windowThreshold && (nowTick - p.lastPeakTick) > 10) {
                if (p.lastPeakTick > 0) {
                    const gap = nowTick - p.lastPeakTick;
                    if (gap > 20 && gap < 400) {
                        p.peakGapTotal += gap;
                        p.peakGapCount++;
                    }
                }

                p.lastPeakTick = nowTick;
                p.peakDmgEma = p.peakCount === 0
                    ? windowSum
                    : p.peakDmgEma * 0.7 + windowSum * 0.3;

                p.peakMaxSingleEma = p.peakCount === 0
                    ? windowMaxSingle
                    : p.peakMaxSingleEma * 0.7 + windowMaxSingle * 0.3;

                p.peakCount++;
            }

            if (p.peakGapCount < 1 || p.lastPeakTick <= 0 || p.peakDmgEma <= 0) {
                return null;
            }

            const intervalTicks = p.peakGapTotal / p.peakGapCount;
            const intervalSeconds = intervalTicks / 20;
            const tToNext = (p.lastPeakTick + intervalTicks) - nowTick;
            const waveLethal = p.peakDmgEma >= p.windowThreshold;

            return {
                cycleSeconds: intervalSeconds,
                cycleDps: total60 / 3.0,
                tToNext,
                waveLethal,
                maxSingleEma: p.peakMaxSingleEma,
                rawSingleEma: p.rawSingleEma ?? 0
            };
        } catch (_) {
            return null;
        }
    }

    // ══════════════════════════════════════════════════
    //  生存预测
    //  优化：允许外部传入 hpInfo，并复用 observedNetHps
    // ══════════════════════════════════════════════════

    static _predictSurvival(unit, config, nowTick, hpInfo = null) {
        const info = hpInfo ?? MovementMelee._getHpInfo(unit);
        if (!info) return "aggressive";

        const currentHp = info.hp;
        const maxHp = info.maxHp;
        const hpPct = currentHp / maxHp;

        const baseThreshold = config.survivalThreshold ?? 0.35;
        const currentStrategy = unit.getDynamicProperty("dm:melee_strategy") ?? "aggressive";
        const lastSw = unit.getDynamicProperty("dm:melee_strategy_tick") ?? 0;

        const history = MeleeDamageLogCache.get(unit.id) ?? [];

        // 优化：单次预测内只计算一次观测净斜率
        const observedNetHps = MovementMelee._getObservedNetHps(unit);

        if (!history || history.length === 0) {
            return hpPct < baseThreshold ? "balanced" : "aggressive";
        }

        // ① 爆发判定
        const fenceUntil = unit.getDynamicProperty("dm:melee_fence_until") ?? 0;
        const isInFence = nowTick <= fenceUntil;

        let recentBurstDamage = 0;
        let recentHits = 0;

        if (!isInFence) {
            for (const log of history) {
                if (nowTick - log.tick <= 10 && log.amount > 0.5) {
                    recentBurstDamage += log.amount;
                    recentHits++;
                }
            }
        }

        const isHeavyDamage = recentBurstDamage >= Math.max(currentHp * 0.60, 14);
        const isBalancedBurst = currentStrategy === "balanced" && recentHits >= 3;

        if (isBalancedBurst || isHeavyDamage) {
            unit.setDynamicProperty("dm:emergency_burst", 1);
            meleeLog(`[DM-Predict] 触发紧急避险! 0.5s受击=${recentHits}次, 扣血=${recentBurstDamage.toFixed(1)}`);
            return "balanced";
        }

        let isTTKDangerous = false;

        // ②.7 统一周期判定
        const cycleCache = MeleeCycleCache.get(unit.id);
        const cycleInfo = MovementMelee._analyzeUnifiedCycle(unit, nowTick, cycleCache, info);

        if (cycleInfo !== null) {
            const isDuel = MovementMelee._isDuel(cycleCache, nowTick);

            // 决斗：周期 DPS 承受力
            if (isDuel) {
                let healingHps = MovementMelee._getRegenHps(unit);

                if (observedNetHps !== null && observedNetHps > healingHps) {
                    healingHps = observedNetHps;
                }

                const cycleDamage = cycleInfo.cycleDps * cycleInfo.cycleSeconds;
                const cycleHeal = healingHps * cycleInfo.cycleSeconds;

                const canSurviveAverage = (currentHp + cycleHeal) > cycleDamage * 1.25;

                const shieldDown = info.absHp < 4;
                const singleHitEstimate = shieldDown
                    ? Math.max(cycleInfo.maxSingleEma, cycleInfo.rawSingleEma)
                    : cycleInfo.maxSingleEma;

                const canSurviveSingleHit = singleHitEstimate <= currentHp;

                if (!canSurviveAverage || !canSurviveSingleHit) {
                    isTTKDangerous = true;

                    const lastLog = unit.getDynamicProperty("dm:melee_cycle_log_tick") ?? 0;

                    if (nowTick - lastLog >= 40) {
                        unit.setDynamicProperty("dm:melee_cycle_log_tick", nowTick);

                        meleeLog(
                            `[DM-Predict] 周期判定: 每${cycleInfo.cycleSeconds.toFixed(1)}s一轮` +
                            `(DPS=${cycleInfo.cycleDps.toFixed(1)}) 一轮${cycleDamage.toFixed(0)}伤 ` +
                            `vs 血${currentHp.toFixed(0)}+回${cycleHeal.toFixed(0)} ` +
                            `${!canSurviveAverage ? "平均扛不住" : ""}` +
                            `${!canSurviveSingleHit
                                ? `单发${singleHitEstimate.toFixed(0)}>血${currentHp.toFixed(0)}秒杀${shieldDown ? "(护盾已破)" : ""}`
                                : ""
                            } → 稳健`
                        );
                    }
                }
            }

            // 下一波峰值预判
            if (cycleInfo.tToNext > 0 && cycleInfo.tToNext <= 8 && cycleInfo.waveLethal) {
                isTTKDangerous = true;

                const lastLog = unit.getDynamicProperty("dm:melee_peak_log_tick") ?? 0;

                if (nowTick - lastLog >= 40) {
                    unit.setDynamicProperty("dm:melee_peak_log_tick", nowTick);
                    meleeLog(`[DM-Predict] 峰值预判: 下一波伤害高峰将至(<${Math.ceil(cycleInfo.tToNext)}tick) → 稳健`);
                }
            }
        }

        // ② 持续致死判定：观测净血量斜率
        let netHps = observedNetHps;

        if (netHps === null) {
            let totalActualDamage = 0;
            let hitCount = 0;
            let firstHitTick = nowTick;
            let lastHitTick = nowTick;

            for (const log of history) {
                if (nowTick - log.tick <= 30 && log.amount > 0.5) {
                    totalActualDamage += log.amount;
                    hitCount++;

                    if (log.tick < firstHitTick) firstHitTick = log.tick;
                    if (log.tick > lastHitTick) lastHitTick = log.tick;
                }
            }

            if (hitCount >= 2) {
                const spanTicks = Math.max(5, lastHitTick - firstHitTick + 1);
                const realDps = totalActualDamage / (spanTicks / 20);
                const initHps = MovementMelee._getInitialModelHps(unit);

                netHps = initHps - realDps;

                const lastColdLog = unit.getDynamicProperty("dm:melee_cold_log_tick") ?? 0;

                if (nowTick - lastColdLog >= 40) {
                    unit.setDynamicProperty("dm:melee_cold_log_tick", nowTick);
                    meleeLog(`[DM-Predict] 冷启动: 回血=${initHps.toFixed(1)}HP/s 敌DPS=${realDps.toFixed(1)} → 净=${netHps.toFixed(1)}HP/s`);
                }
            } else {
                netHps = 0;
            }
        }

        if (netHps < -1.0) {
            const timeToDeath = currentHp / Math.abs(netHps);

            if (timeToDeath < 4.0) {
                isTTKDangerous = true;

                const lastLog = unit.getDynamicProperty("dm:melee_slope_log_tick") ?? 0;

                if (nowTick - lastLog >= 40) {
                    unit.setDynamicProperty("dm:melee_slope_log_tick", nowTick);
                    meleeLog(`[DM-Predict] 净斜率=${netHps.toFixed(1)}HP/s → 预计${timeToDeath.toFixed(1)}s死亡`);
                }
            }
        }

        const blockRetreatTick = unit.getDynamicProperty("dm:block_retreat_tick") ?? 0;
        const isBlockRetreatActive = (nowTick - blockRetreatTick) < 30;

        if (isBlockRetreatActive && currentStrategy === "balanced") {
            return "balanced";
        }

        const EXIT_BALANCED_THRESHOLD = baseThreshold + 0.10;
        const lastHitFromLog = history[history.length - 1]?.tick ?? 0;

        if (currentStrategy === "balanced") {
            const blockCharges = unit.getDynamicProperty("dm:melee_block_charges") ?? 0;

            if (blockCharges <= 0 && hpPct >= 0.50 && !isTTKDangerous && (nowTick - lastSw >= 40)) {
                return "aggressive";
            }

            if (hpPct >= EXIT_BALANCED_THRESHOLD && !isTTKDangerous && (nowTick - lastHitFromLog >= 50)) {
                return "aggressive";
            }

            return "balanced";
        } else {
            if (isTTKDangerous || hpPct < baseThreshold) {
                return "balanced";
            }

            return "aggressive";
        }
    }

    // ══════════════════════════════════════════════════
    //  主执行
    // ══════════════════════════════════════════════════

    static execute(unit, config, closestThreat, closestDistSq, meleeRange, lastDamageTickMap) {
        try {
            if (!unit || !unit.isValid) {
                if (unit) {
                    MeleeDamageLogCache.delete(unit.id);
                    MeleeCycleCache.delete(unit.id);
                    HpSamplesCache.delete(unit.id);
                }
                return;
            }

            // 特殊骑乘状态硬拦截
            if (unit.hasTag("maid:ride_player")) {
                MovementMelee._clearVel(unit);
                return;
            }

            const controller = unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;
            const nowTick = system.currentTick;
            const uLoc = unit.location;

            try {
                if (MovementMelee._isInsideWall(unit)) {
                    MovementMelee._safeTeleport(unit, { x: uLoc.x, y: uLoc.y, z: uLoc.z }, 3, 5, 4);
                    unit.clearVelocity();

                    unit.setDynamicProperty("dm:melee_charging", 0);
                    unit.setDynamicProperty("dm:cmd_vel_x", 0);
                    unit.setDynamicProperty("dm:cmd_vel_z", 0);
                    unit.setDynamicProperty("dm:cmd_vel_y", 0);
                }
            } catch (_) {}

            // 液体 / 漂浮检测
            let isInLiquid = false;

            try {
                const feet = unit.dimension.getBlock({
                    x: uLoc.x,
                    y: Math.floor(uLoc.y),
                    z: uLoc.z
                });

                const waist = unit.dimension.getBlock({
                    x: uLoc.x,
                    y: Math.floor(uLoc.y + 1),
                    z: uLoc.z
                });

                if ((feet && feet.isLiquid) || (waist && waist.isLiquid)) {
                    isInLiquid = true;
                }
            } catch (_) {}

            const isFloating = isInLiquid && !controller.isOnGround;
            const isAirborne = !controller.isOnGround && !isInLiquid;

            // TAG 总阀门
            const isCombat = unit.hasTag("dm_has_target") || unit.hasTag("dm_skill_on");

            if (!isCombat) {
                MovementMelee._clearVel(unit);
                return;
            }

            // EWMA 威胁分数衰减 + 选出最高威胁者
            let topThreatId = null;

            try {
                const cc = MeleeCycleCache.get(unit.id);

                if (cc && cc.attackerDamage && cc.attackerDamage.size > 0) {
                    let topScore = 0;

                    for (const [id, rec] of cc.attackerDamage) {
                        rec.score = (rec.score ?? 0) * 0.80;

                        if (rec.score < 0.5) {
                            cc.attackerDamage.delete(id);
                            continue;
                        }

                        if (rec.score > topScore) {
                            topScore = rec.score;
                            topThreatId = id;
                        }
                    }
                }
            } catch (_) {}

            // 目标解析
            const chargeRange = config.chargeRange ?? 10;
            const detectRange = Math.max(meleeRange * 2.5, chargeRange + 5);

            let target = null;
            let targetDistSq = 99999;

            // ① 最高威胁分数目标
            try {
                if (topThreatId) {
                    const threat = world.getEntity(topThreatId);

                    if (threat && threat.isValid) {
                        const tdsq = getDistSq(uLoc, threat.location);

                        if (tdsq <= detectRange ** 2) {
                            target = threat;
                            targetDistSq = tdsq;
                        }
                    }
                }
            } catch (_) {}

            // ② 最近受击源兜底
            if (!target) {
                try {
                    const threatId = unit.getDynamicProperty("dm:threat_target_id");
                    const threatTick = unit.getDynamicProperty("dm:threat_target_tick") ?? 0;

                    if (threatId && (nowTick - threatTick) < 120) {
                        const threat = world.getEntity(threatId);

                        if (threat && threat.isValid) {
                            const tdsq = getDistSq(uLoc, threat.location);

                            if (tdsq <= detectRange ** 2) {
                                target = threat;
                                targetDistSq = tdsq;
                            }
                        }
                    }
                } catch (_) {}
            }

            // ③ 雷达最近威胁
            if (!target) {
                target = closestThreat;
                targetDistSq = closestDistSq;
            }

            // ④ 原版索敌兜底
            if ((!target || !target.isValid || targetDistSq > detectRange ** 2) && unit.target?.isValid) {
                target = unit.target;
                targetDistSq = getDistSq(uLoc, target.location);
            }

            if (!target || !target.isValid || targetDistSq > detectRange ** 2) {
                MovementMelee._clearVel(unit);
                return;
            }

            // 血量信息
            const info = MovementMelee._getHpInfo(unit);

            if (!info) {
                MovementMelee._clearVel(unit);
                return;
            }

            const hp = info.hp;
            const maxHp = info.maxHp;

            // ═══════════════════════════════════════════════════════════
            // 缓冲层栅栏 + 真实受击佐证
            // ═══════════════════════════════════════════════════════════

            const lastHp = unit.getDynamicProperty("dm:melee_last_hp") ?? hp;
            const lastAbs = unit.getDynamicProperty("dm:melee_last_abs") ?? info.absHp;
            const lastBaseMax = unit.getDynamicProperty("dm:melee_last_base_max") ?? info.baseMax;
            const lastSnapTick = unit.getDynamicProperty("dm:melee_last_snap_tick") ?? 0;

            const absDelta = info.absHp - lastAbs;
            const baseMaxDelta = info.baseMax - lastBaseMax;
            const hpDelta = (hp - lastHp) - absDelta - baseMaxDelta;

            const pendingHurt = PendingHurtLedger.get(unit.id);
            const hurtFresh = pendingHurt && (nowTick - pendingHurt.tick) <= 6;

            const absConsumedByHurt = absDelta < 0 && hurtFresh &&
                Math.abs(absDelta) <= pendingHurt.damage + 2;

            const buffTransition =
                (absDelta >= 4) ||
                Math.abs(baseMaxDelta) >= 4 ||
                (absDelta <= -4 && !absConsumedByHurt);

            let fenceUntil = unit.getDynamicProperty("dm:melee_fence_until") ?? 0;

            if (buffTransition) {
                fenceUntil = nowTick + 15;
                unit.setDynamicProperty("dm:melee_fence_until", fenceUntil);
                unit.setDynamicProperty("dm:emergency_burst", 0);

                const lastFl = unit.getDynamicProperty("dm:melee_fence_log_tick") ?? 0;

                if (nowTick - lastFl >= 60) {
                    unit.setDynamicProperty("dm:melee_fence_log_tick", nowTick);
                    meleeLog(`[DM-Melee] 🧱 缓冲层栅栏激活(15tick): absΔ=${absDelta.toFixed(0)} baseMaxΔ=${baseMaxDelta.toFixed(0)} | ${unit.typeId}`);
                }
            }

            const isFenced = nowTick <= fenceUntil;

            // 快照推进
            unit.setDynamicProperty("dm:melee_last_hp", hp);
            unit.setDynamicProperty("dm:melee_last_abs", info.absHp);
            unit.setDynamicProperty("dm:melee_last_base_max", info.baseMax);
            unit.setDynamicProperty("dm:melee_last_snap_tick", nowTick);

            // 生命值采样
            // 优化：使用内存 Map，不再 JSON.stringify 到 DynamicProperty
            try {
                let hpSamples = HpSamplesCache.get(unit.id) ?? [];

                const lastSample = hpSamples[hpSamples.length - 1];

                let sampledHp = info.realHp;

                if ((isFenced || hpDelta >= -0.01) && lastSample) {
                    sampledHp = Math.max(info.realHp, lastSample.h);
                }

                hpSamples.push({
                    t: nowTick,
                    h: sampledHp
                });

                if (hpSamples.length > 24) {
                    hpSamples = hpSamples.slice(-24);
                }

                HpSamplesCache.set(unit.id, hpSamples);
            } catch (_) {}

            // 真实受击佐证入账
            const corroborated = hurtFresh &&
                pendingHurt.tick > lastSnapTick &&
                Math.abs(hpDelta) >= 0.5 &&
                (pendingHurt.hasRealAttacker || Math.abs(hpDelta) <= 20);

            if (hpDelta < -0.01 && !isFenced && corroborated) {
                const realDmg = Math.min(Math.abs(hpDelta), info.baseMax * 1.2);

                MovementMelee._logDamage(unit, nowTick, realDmg);

                if (Math.abs(hpDelta) > info.baseMax * 1.2) {
                    meleeLog(`[DM-Melee] 血量异常扣血已钳制: ${hpDelta.toFixed(0)} → ${realDmg.toFixed(0)} | ${unit.typeId}`);
                }
            } else if (hpDelta < -0.01 && Math.abs(hpDelta) >= 4) {
                const lastDl = unit.getDynamicProperty("dm:melee_drop_log_tick") ?? 0;

                if (nowTick - lastDl >= 60) {
                    unit.setDynamicProperty("dm:melee_drop_log_tick", nowTick);
                    meleeLog(`[DM-Melee] 🧱 丢弃未佐证扣血 ${hpDelta.toFixed(1)} (fenced=${isFenced ? "是" : "否"}, 受击=${hurtFresh ? "有" : "无"}) | ${unit.typeId}`);
                }
            }

            // 策略预测与切换
            // 优化：把当前 info 传给 _predictSurvival，避免重复读取
            let strategy = unit.getDynamicProperty("dm:melee_strategy") ?? "aggressive";
            const lastSw = unit.getDynamicProperty("dm:melee_strategy_tick") ?? 0;

            const wish = MovementMelee._predictSurvival(unit, config, nowTick, info);
            const isEmergency = unit.getDynamicProperty("dm:emergency_burst") === 1;

            if (wish !== strategy && ((nowTick - lastSw > 40) || (wish === "balanced" && isEmergency))) {
                const blockRetreatTick = unit.getDynamicProperty("dm:block_retreat_tick") ?? 0;
                const isBlockProtected = (nowTick - blockRetreatTick) < 30;
                const isIllegalSwitch = isBlockProtected && strategy === "balanced" && wish === "aggressive";

                if (!isIllegalSwitch) {
                    strategy = wish;

                    unit.setDynamicProperty("dm:melee_strategy", strategy);
                    unit.setDynamicProperty("dm:melee_strategy_tick", nowTick);
                    unit.setDynamicProperty("dm:emergency_burst", 0);

                    if (strategy === "balanced") {
                        unit.setDynamicProperty("dm:melee_phase", 1);
                        unit.setDynamicProperty("dm:melee_phase_tick", nowTick);
                        unit.setDynamicProperty("dm:melee_block_charges", config.blockCharges ?? 3);

                        if (typeof config.blockMinDamage === "number" && config.blockMinDamage > 0) {
                            unit.setDynamicProperty("dm:melee_block_min_damage", config.blockMinDamage);
                        } else {
                            unit.setDynamicProperty("dm:melee_block_min_damage", undefined);
                        }

                        meleeLog(`[DM-Melee] 战术后撤! 已激活 ${config.blockCharges ?? 3} 次稳健格挡护盾 | 实体: ${unit.typeId}`);
                    } else if (strategy === "aggressive") {
                        unit.setDynamicProperty("dm:melee_block_charges", 0);
                    }

                    meleeLog(`[DM-Melee] 策略切换: ${strategy === "balanced" ? "稳健后撤" : "激进冲锋"}`);
                }
            }

            // 护盾自充能
            if (strategy === "balanced" && (hp / maxHp) >= 0.50) {
                const bCharges = unit.getDynamicProperty("dm:melee_block_charges") ?? 0;

                if (bCharges <= 0) {
                    const lastZero = unit.getDynamicProperty("dm:melee_charges_zero_tick") ?? 0;

                    if (nowTick - lastZero >= 60) {
                        unit.setDynamicProperty("dm:melee_block_charges", config.blockCharges ?? 3);
                        unit.setDynamicProperty("dm:melee_charges_zero_tick", nowTick);

                        meleeLog(`[DM-Melee] 护盾自充能! 已补 ${config.blockCharges ?? 3} 次 | 实体: ${unit.typeId}`);
                    }
                }
            }

            // 方向向量
            const dx = target.location.x - uLoc.x;
            const dz = target.location.z - uLoc.z;
            const dist = Math.sqrt(dx * dx + dz * dz) || 0.001;

            const dirX = dx / dist;
            const dirZ = dz / dist;

            const tangentX = -dirZ;
            const tangentZ = dirX;

            // 基础速度
            let baseSpeed = config.strafeSpeed ?? 0.35;

            try {
                const mc = unit.getComponent("minecraft:movement");

                if (mc && mc.defaultValue > 0) {
                    baseSpeed *= mc.currentValue / mc.defaultValue;
                }
            } catch (_) {}

            if (isInLiquid) {
                baseSpeed *= isFloating ? 0.20 : 0.60;
            }

            // 走位计算
            let velX = 0;
            let velZ = 0;
            let jumpImpulse = 0.02;

            if (strategy === "aggressive") {
                ({
                    velX,
                    velZ,
                    jumpImpulse
                } = MovementMelee._aggressive(
                    unit,
                    config,
                    target,
                    targetDistSq,
                    meleeRange,
                    dirX,
                    dirZ,
                    baseSpeed,
                    nowTick,
                    jumpImpulse
                ));
            } else {
                ({
                    velX,
                    velZ,
                    jumpImpulse
                } = MovementMelee._balanced(
                    unit,
                    config,
                    target,
                    targetDistSq,
                    meleeRange,
                    dirX,
                    dirZ,
                    tangentX,
                    tangentZ,
                    baseSpeed,
                    nowTick,
                    jumpImpulse
                ));
            }

            // 紧急 / 恐慌后撤
            const hpPct = hp / maxHp;
            const isEmergencyRetreat = hpPct < 0.25;
            const isPanicRetreat = strategy === "balanced" && hpDelta < -0.5;

            if (isEmergencyRetreat || isPanicRetreat) {
                unit.setDynamicProperty("dm:melee_charging", 0);

                const retreatPower = isEmergencyRetreat ? 1.3 : 1.0;

                velX = -dirX * baseSpeed * retreatPower;
                velZ = -dirZ * baseSpeed * retreatPower;
                jumpImpulse = isEmergencyRetreat ? 0.13 : 0.10;

                const lastEmergencyTick = unit.getDynamicProperty("dm:melee_emergency_tick") ?? 0;

                if (nowTick - lastEmergencyTick > 40) {
                    unit.setDynamicProperty("dm:melee_emergency_tick", nowTick);
                }
            }

            // 空中走位削弱
            if (isAirborne) {
                velX *= 0.45;
                velZ *= 0.45;
                jumpImpulse = 0;
            }

            // 速度惯性平滑
            if (strategy === "balanced" && !isEmergencyRetreat && !isPanicRetreat) {
                const prevVelX = unit.getDynamicProperty("dm:cmd_vel_x") ?? 0;
                const prevVelZ = unit.getDynamicProperty("dm:cmd_vel_z") ?? 0;

                const SMOOTHING = 0.3;

                if (prevVelX !== 0 || prevVelZ !== 0) {
                    velX = prevVelX + (velX - prevVelX) * (1 - SMOOTHING);
                    velZ = prevVelZ + (velZ - prevVelZ) * (1 - SMOOTHING);
                }
            }

            // 水中浮潜
            if (isFloating) {
                const dy = target.location.y - uLoc.y;

                let atSurface = false;

                try {
                    const sb = unit.dimension.getBlock({
                        x: uLoc.x,
                        y: Math.floor(uLoc.y + 1.6),
                        z: uLoc.z
                    });

                    if (sb && sb.isAir) {
                        atSurface = true;
                    }
                } catch (_) {}

                if (dy > 0.5 && !atSurface) {
                    jumpImpulse = 0.18;
                } else if (dy < -0.5) {
                    jumpImpulse = -0.20;
                } else {
                    jumpImpulse = atSurface ? -0.08 : 0.05;
                }
            }

            // 墙面检测
            if (!isFloating && !isAirborne && (velX !== 0 || velZ !== 0)) {
                try {
                    const checkLower = {
                        x: uLoc.x + velX * 0.8,
                        y: uLoc.y + 0.5,
                        z: uLoc.z + velZ * 0.8
                    };

                    const checkUpper = {
                        x: uLoc.x + velX * 0.8,
                        y: uLoc.y + 1.8,
                        z: uLoc.z + velZ * 0.8
                    };

                    const bLow = unit.dimension.getBlock(checkLower);

                    if (bLow && !bLow.isAir && !bLow.isLiquid) {
                        const bUp = unit.dimension.getBlock(checkUpper);

                        if (bUp && (bUp.isAir || bUp.isLiquid)) {
                            jumpImpulse = 0.25;
                        } else {
                            let sd = (unit.getDynamicProperty("dm:melee_strafe_dir") ?? 1) * -1;

                            unit.setDynamicProperty("dm:melee_strafe_dir", sd);

                            velX *= -0.3;
                            velZ *= -0.3;
                            jumpImpulse = 0.20;
                        }
                    }
                } catch (_) {}
            }

            // 卡死检测
            if (!isFloating && !isAirborne && (velX !== 0 || velZ !== 0)) {
                let stuckTicks = unit.getDynamicProperty("dm:stuck_ticks") ?? 0;

                const lastX = unit.getDynamicProperty("dm:last_x");
                const lastZ = unit.getDynamicProperty("dm:last_z");

                if (lastX !== undefined && lastZ !== undefined) {
                    const rd = (uLoc.x - lastX) ** 2 + (uLoc.z - lastZ) ** 2;
                    stuckTicks = rd < 0.005 ? stuckTicks + 4 : Math.max(0, stuckTicks - 2);
                }

                const stuckThreshold = isEmergencyRetreat ? 10 : 30;

                if (stuckTicks >= stuckThreshold) {
                    try {
                        unit.clearVelocity();

                        if (isEmergencyRetreat) {
                            MovementMelee._safeTeleport(
                                unit,
                                {
                                    x: uLoc.x - dirX * 1.5,
                                    y: uLoc.y + 0.8,
                                    z: uLoc.z - dirZ * 1.5
                                },
                                2,
                                3,
                                2
                            );

                            jumpImpulse = 0.30;
                        } else {
                            MovementMelee._safeTeleport(
                                unit,
                                {
                                    x: uLoc.x,
                                    y: uLoc.y + 0.4,
                                    z: uLoc.z
                                },
                                2,
                                3,
                                2
                            );

                            jumpImpulse = 0.35;
                        }
                    } catch (_) {}

                    stuckTicks = 0;
                }

                unit.setDynamicProperty("dm:last_x", uLoc.x);
                unit.setDynamicProperty("dm:last_z", uLoc.z);
                unit.setDynamicProperty("dm:stuck_ticks", stuckTicks);
            }

            // 写入指令速度
            unit.setDynamicProperty("dm:cmd_vel_x", velX);
            unit.setDynamicProperty("dm:cmd_vel_z", velZ);
            unit.setDynamicProperty("dm:cmd_vel_y", jumpImpulse);
        } catch (err) {
            console.error(`[DM-Melee Engine Error] ${err}`);
        }
    }

    // ══════════════════════════════════════════════════
    //  激进冲锋
    // ══════════════════════════════════════════════════

    static _aggressive(unit, config, target, distSq, meleeRange, dirX, dirZ, baseSpeed, nowTick, jumpImpulse) {
        let velX = 0;
        let velZ = 0;

        const chargeRange = config.chargeRange ?? 10;
        const maxChargeDist = config.maxChargeDist ?? 10;
        const chargeSpeed = config.chargeSpeed ?? 1.4;
        const chargeDur = config.chargeDuration ?? 40;

        const isCharging = unit.getDynamicProperty("dm:melee_charging") === 1;

        const uLoc = unit.location;
        const tLoc = target.location;

        const dx = tLoc.x - uLoc.x;
        const dy = tLoc.y - uLoc.y;
        const dz = tLoc.z - uLoc.z;

        const dist3D = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;

        if (isCharging) {
            const chargeStart = unit.getDynamicProperty("dm:melee_charge_tick") ?? nowTick;
            const elapsed = nowTick - chargeStart;

            const startDist = unit.getDynamicProperty("dm:melee_charge_start_dist") ?? dist3D;
            const traveled = startDist - dist3D;

            const hDist = Math.sqrt(dx * dx + dz * dz);

            if (hDist < meleeRange * 1.5 || traveled >= maxChargeDist || elapsed > chargeDur) {
                unit.setDynamicProperty("dm:melee_charging", 0);

                const stopX = tLoc.x - dirX * (meleeRange * 0.8);
                const stopZ = tLoc.z - dirZ * (meleeRange * 0.8);

                try {
                    unit.teleport(
                        {
                            x: stopX,
                            y: tLoc.y,
                            z: stopZ
                        },
                        {
                            checkForBlocks: true
                        }
                    );

                    unit.clearVelocity();
                } catch (_) {}

                const unitMaxHp = MovementMelee._getEffectiveMaxHp(unit);
                const rawDamage = unitMaxHp * 2;
                const damage = Math.min(rawDamage, 200);

                const aoeRadius = 3.5;
                const maxAoeTargets = 3;

                try {
                    const nearbyEntities = unit.dimension.getEntities({
                        location: {
                            x: tLoc.x,
                            y: tLoc.y,
                            z: tLoc.z
                        },
                        maxDistance: aoeRadius,
                        families: ["monster"]
                    });

                    const aoeTargets = nearbyEntities
                        .filter(e => e.isValid && e.id !== unit.id)
                        .sort((a, b) => {
                            const ax = tLoc.x - a.location.x;
                            const ay = tLoc.y - a.location.y;
                            const az = tLoc.z - a.location.z;

                            const bx = tLoc.x - b.location.x;
                            const by = tLoc.y - b.location.y;
                            const bz = tLoc.z - b.location.z;

                            return (ax * ax + ay * ay + az * az) - (bx * bx + by * by + bz * bz);
                        })
                        .slice(0, maxAoeTargets);

                    for (const t of aoeTargets) {
                        try {
                            if (unit.isValid && t.isValid) {
                                t.applyDamage(damage, {
                                    cause: "entityAttack",
                                    source: unit
                                });
                            }
                        } catch (e) {
                            try {
                                if (t.isValid) {
                                    t.applyDamage(damage);
                                }
                            } catch (_) {}
                        }
                    }

                    meleeLog(`[DM-Melee] 冲刺AOE命中${aoeTargets.length}个目标! 伤害=${damage.toFixed(1)}(友方HP:${unitMaxHp.toFixed(0)}) | 实体: ${unit.typeId}`);
                } catch (e) {
                    try {
                        if (unit.isValid && target.isValid) {
                            target.applyDamage(damage, {
                                cause: "entityAttack",
                                source: unit
                            });
                        }
                    } catch (_) {}
                }

                return {
                    velX: 0,
                    velZ: 0,
                    jumpImpulse: 0.02
                };
            } else {
                velX = dirX * baseSpeed * chargeSpeed;
                velZ = dirZ * baseSpeed * chargeSpeed;

                jumpImpulse = dy > 0.8
                    ? Math.min(0.40, Math.max(0.20, (dy / dist3D) * 0.45))
                    : 0.02;
            }
        } else {
            const lastChargeTick = unit.getDynamicProperty("dm:melee_charge_tick") ?? 0;

            const minChargeRange = config.chargeRange ?? 10;
            const maxChargeRange = config.maxChargeRange ?? Infinity;

            const inRange = dist3D >= minChargeRange && dist3D <= maxChargeRange;

            if ((nowTick - lastChargeTick) >= 100 && inRange && dy < 10.0 && target?.isValid) {
                unit.setDynamicProperty("dm:melee_charging", 1);
                unit.setDynamicProperty("dm:melee_charge_tick", nowTick);
                unit.setDynamicProperty("dm:melee_charge_start_dist", dist3D);

                velX = dirX * baseSpeed * chargeSpeed;
                velZ = dirZ * baseSpeed * chargeSpeed;

                jumpImpulse = dy > 0.8 ? 0.30 : 0.02;
            }
        }

        return {
            velX,
            velZ,
            jumpImpulse
        };
    }

    // ══════════════════════════════════════════════════
    //  稳健走位
    // ══════════════════════════════════════════════════

    static _balanced(unit, config, target, targetDistSq, meleeRange, dirX, dirZ, tangentX, tangentZ, baseSpeed, nowTick, jumpImpulse) {
        let velX = 0;
        let velZ = 0;

        const rangedRetaliate = unit.getDynamicProperty("dm:ranged_retaliate") === 1;
        const rangedRetaliateTick = unit.getDynamicProperty("dm:ranged_retaliate_tick") ?? 0;
        const isCharging = unit.getDynamicProperty("dm:melee_charging") === 1;

        const distNow = Math.sqrt(targetDistSq);

        const retaliateActive = rangedRetaliate && (nowTick - rangedRetaliateTick) < 60;

        const minChargeRange = config.chargeRange ?? 10;
        const maxChargeRange = config.maxChargeRange ?? Infinity;

        const distanceActive = distNow >= minChargeRange && distNow <= maxChargeRange;

        const lastChargeT = unit.getDynamicProperty("dm:melee_charge_tick") ?? 0;
        const chargeCooldownOk = (nowTick - lastChargeT) >= 20;

        if ((retaliateActive || distanceActive) && !isCharging && chargeCooldownOk) {
            unit.setDynamicProperty("dm:ranged_retaliate", 0);
            unit.setDynamicProperty("dm:melee_charging", 1);
            unit.setDynamicProperty("dm:melee_charge_tick", nowTick);
            unit.setDynamicProperty("dm:melee_charge_start_dist", distNow);

            meleeLog(`[DM-Melee] 触发远程反击冲刺! 当前距离=${distNow.toFixed(1)}在[${minChargeRange}, ${maxChargeRange === Infinity ? "∞" : maxChargeRange}]区间内 | 实体: ${unit.typeId}`);
        }

        if (rangedRetaliate && (nowTick - rangedRetaliateTick) >= 60) {
            unit.setDynamicProperty("dm:ranged_retaliate", 0);
        }

        if (isCharging) {
            const chargeStart = unit.getDynamicProperty("dm:melee_charge_tick") ?? nowTick;
            const elapsed = nowTick - chargeStart;

            const startDist = unit.getDynamicProperty("dm:melee_charge_start_dist") ?? Math.sqrt(targetDistSq);
            const dist = Math.sqrt(targetDistSq);

            const traveled = startDist - dist;

            const extendedMaxChargeDist = (config.maxChargeDist ?? 10) * 2.5;
            const chargeSpeed = config.chargeSpeed ?? 1.4;
            const extendedChargeDur = (config.chargeDuration ?? 40) * 1.5;

            if (dist < meleeRange * 1.5 || traveled >= extendedMaxChargeDist || elapsed > extendedChargeDur) {
                unit.setDynamicProperty("dm:melee_charging", 0);
            } else {
                velX = dirX * baseSpeed * chargeSpeed;
                velZ = dirZ * baseSpeed * chargeSpeed;

                const dy = target.location.y - unit.location.y;

                jumpImpulse = dy > 0.8
                    ? Math.min(0.35, Math.max(0.15, (dy / dist) * 0.4))
                    : 0.02;

                return {
                    velX,
                    velZ,
                    jumpImpulse
                };
            }
        }

        let phase = unit.getDynamicProperty("dm:melee_phase") ?? 1;
        const phaseStartTick = unit.getDynamicProperty("dm:melee_phase_tick") ?? nowTick;
        const phaseElapsed = nowTick - phaseStartTick;

        const strafeDir = unit.getDynamicProperty("dm:melee_strafe_dir") ?? 1;

        if (phase !== 1 && phase !== 2) {
            phase = 1;
            unit.setDynamicProperty("dm:melee_phase", 1);
            unit.setDynamicProperty("dm:melee_phase_tick", nowTick);
        }

        if (phase === 1) {
            const retreatSpeed = baseSpeed * 0.85;

            velX = -dirX * retreatSpeed + tangentX * strafeDir * (retreatSpeed * 0.2);
            velZ = -dirZ * retreatSpeed + tangentZ * strafeDir * (retreatSpeed * 0.2);
            jumpImpulse = 0.02;

            if (targetDistSq >= (meleeRange * 2.0) ** 2 || phaseElapsed > 12) {
                phase = 2;
                unit.setDynamicProperty("dm:melee_phase", 2);
                unit.setDynamicProperty("dm:melee_phase_tick", nowTick);
            }
        } else if (phase === 2) {
            const orbitSpeed = baseSpeed * 0.9;
            const dist = Math.sqrt(targetDistSq);

            let radialWeight = 0;

            if (dist < meleeRange * 1.3) {
                radialWeight = -0.3;
            } else if (dist > meleeRange * 2.2) {
                radialWeight = 0.2;
            }

            velX = (tangentX * strafeDir * 0.75 + dirX * radialWeight) * orbitSpeed;
            velZ = (tangentZ * strafeDir * 0.75 + dirZ * radialWeight) * orbitSpeed;

            if (phaseElapsed > 35 || Math.random() < 0.08) {
                unit.setDynamicProperty("dm:melee_phase", 1);
                unit.setDynamicProperty("dm:melee_phase_tick", nowTick);
                unit.setDynamicProperty("dm:melee_strafe_dir", Math.random() < 0.5 ? 1 : -1);
            }
        }

        return {
            velX,
            velZ,
            jumpImpulse
        };
    }

    // 清速
    static _clearVel(unit) {
        unit.setDynamicProperty("dm:cmd_vel_x", 0);
        unit.setDynamicProperty("dm:cmd_vel_z", 0);
        unit.setDynamicProperty("dm:cmd_vel_y", 0);
        unit.setDynamicProperty("dm:melee_charging", 0);
    }

    static _isClear(b) {
        return !b || b.isAir || b.isLiquid;
    }

    static _isSolidGround(b) {
        return !!b && !b.isAir && !b.isLiquid;
    }

    static _isStandable(dim, x, y, z) {
        try {
            const body = dim.getBlock({ x, y, z });
            if (!MovementMelee._isClear(body)) return false;

            const head = dim.getBlock({ x, y: y + 1, z });
            if (!MovementMelee._isClear(head)) return false;

            const ground = dim.getBlock({ x, y: y - 1, z });
            return MovementMelee._isSolidGround(ground);
        } catch (_) {
            return false;
        }
    }

    static _findSafeSpot(unit, base, hRange = 3, dyUp = 5, dyDown = 4) {
        try {
            const dim = unit.dimension;

            const bx = Math.floor(base.x);
            const by = Math.floor(base.y);
            const bz = Math.floor(base.z);

            for (let dy = 1; dy <= dyUp; dy++) {
                if (MovementMelee._isStandable(dim, bx, by + dy, bz)) {
                    return {
                        x: bx + 0.5,
                        y: by + dy,
                        z: bz + 0.5
                    };
                }
            }

            for (let r = 1; r <= hRange; r++) {
                for (let dx = -r; dx <= r; dx++) {
                    for (let dz = -r; dz <= r; dz++) {
                        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;

                        for (let dy = dyDown; dy >= -dyDown; dy--) {
                            if (MovementMelee._isStandable(dim, bx + dx, by + dy, bz + dz)) {
                                return {
                                    x: bx + dx + 0.5,
                                    y: by + dy,
                                    z: bz + dz + 0.5
                                };
                            }
                        }
                    }
                }
            }
        } catch (_) {}

        return null;
    }

    static _safeTeleport(unit, desired, hRange = 3, dyUp = 5, dyDown = 4) {
        try {
            if (!unit?.isValid) return false;

            if (MovementMelee._isStandable(
                unit.dimension,
                Math.floor(desired.x),
                Math.floor(desired.y),
                Math.floor(desired.z)
            )) {
                unit.teleport(
                    {
                        x: desired.x,
                        y: desired.y,
                        z: desired.z
                    },
                    {
                        checkForBlocks: true
                    }
                );

                return true;
            }

            const safe = MovementMelee._findSafeSpot(unit, desired, hRange, dyUp, dyDown);

            if (safe) {
                unit.teleport(safe, {
                    checkForBlocks: true
                });

                return true;
            }

            return false;
        } catch (_) {
            return false;
        }
    }

    static _isInsideWall(unit) {
        try {
            const l = unit.location;
            const dim = unit.dimension;

            const blocks = [
                dim.getBlock({
                    x: Math.floor(l.x),
                    y: Math.floor(l.y),
                    z: Math.floor(l.z)
                }),
                dim.getBlock({
                    x: Math.floor(l.x),
                    y: Math.floor(l.y + 1),
                    z: Math.floor(l.z)
                }),
                dim.getBlock({
                    x: Math.floor(l.x),
                    y: Math.floor(l.y + 2),
                    z: Math.floor(l.z)
                })
            ];

            let solid = 0;

            for (const b of blocks) {
                if (MovementMelee._isSolidGround(b)) solid++;
            }

            return solid >= 2;
        } catch (_) {
            return false;
        }
    }
}

// ════════════════════════════════════════════════════════════
// 格挡：模块顶层注册
// ════════════════════════════════════════════════════════════

let _blockSubscriberRegistered = false;

function registerBlockSubscriber() {
    if (_blockSubscriberRegistered) return;

    _blockSubscriberRegistered = true;

    world.beforeEvents.entityHurt.subscribe((event) => {
        try {
            const victim = event.hurtEntity;

            if (!victim || !victim.isValid) return;

            const isDmUnit =
                victim.typeId?.startsWith("player:") &&
                victim.typeId !== "minecraft:player";

            const hpInfo = isDmUnit ? MovementMelee._getHpInfo(victim) : null;

            // ── 真实受击账本 ──
            if (isDmUnit && event.damage > 0) {
                const atk = event.damageSource?.damagingEntity;

                const existing = PendingHurtLedger.get(victim.id);

                if (existing && system.currentTick - existing.tick <= 6) {
                    existing.damage += event.damage;
                    existing.tick = system.currentTick;

                    if (atk && atk.isValid && atk.id !== victim.id) {
                        existing.hasRealAttacker = true;
                    }
                } else {
                    PendingHurtLedger.set(victim.id, {
                        tick: system.currentTick,
                        damage: event.damage,
                        hasRealAttacker: !!(atk && atk.isValid && atk.id !== victim.id)
                    });
                }

                // 清理过期账本
                for (const [id, rec] of PendingHurtLedger) {
                    if (system.currentTick - rec.tick > 10) {
                        PendingHurtLedger.delete(id);
                    }
                }
            }

            // ── 攻击模式喂数据 ──
            if (isDmUnit && event.damage > 0 && hpInfo) {
                const attacker = event.damageSource?.damagingEntity;
                const isFakeHurt = !attacker || !attacker.isValid || attacker.id === victim.id;

                if (!isFakeHurt) {
                    const realAttacker = resolveRealAttacker(attacker, victim);

                    MovementMelee._updateMeleePattern(
                        realAttacker.id,
                        victim.id,
                        event.damage,
                        system.currentTick,
                        hpInfo.hp
                    );
                }
            }

            // ── 原格挡逻辑 ──
            const charges = victim.getDynamicProperty("dm:melee_block_charges") ?? 0;

            if (charges <= 0) return;

            const isCombat = victim.hasTag("dm_has_target") || victim.hasTag("dm_skill_on");

            if (!isCombat) return;

            let minBlockDamage = Math.max((hpInfo ? hpInfo.hp : 20) * 0.05, 3);

            const cfgMin = victim.getDynamicProperty("dm:melee_block_min_damage");

            if (typeof cfgMin === "number" && cfgMin > 0) {
                minBlockDamage = cfgMin;
            }

            if (event.damage < minBlockDamage) return;

            const blockedDamage = event.damage;
            const remainingCharges = charges - 1;

            victim.setDynamicProperty("dm:melee_block_charges", remainingCharges);

            if (remainingCharges <= 0) {
                victim.setDynamicProperty("dm:melee_charges_zero_tick", system.currentTick);
            }

            event.cancel = true;
            event.damage = 0;

            const vid = victim.id;

            // 优化：格挡后的实体修改延后到 system.run，
            // 更符合 2.7.0 before 事件上下文限制。
            system.run(() => {
                try {
                    const v = world.getEntity(vid);

                    if (v && v.isValid) {
                        try {
                            v.clearVelocity();
                        } catch (_) {}

                        meleeLog(`[DM-Melee] 格挡成功! 挡下${blockedDamage.toFixed(1)}伤害 | 剩余次数: ${remainingCharges} | 实体: ${v.typeId}`);

                        let log = MeleeDamageLogCache.get(v.id);

                        if (!log) {
                            log = [];
                            MeleeDamageLogCache.set(v.id, log);
                        }

                        log.push({
                            tick: system.currentTick,
                            amount: 0.1
                        });

                        if (log.length > 30) {
                            MeleeDamageLogCache.set(
                                v.id,
                                log.filter(e => system.currentTick - e.tick < 150)
                            );
                        }

                        v.setDynamicProperty("dm:melee_strategy", "balanced");
                        v.setDynamicProperty("dm:melee_strategy_tick", system.currentTick);
                        v.setDynamicProperty("dm:melee_phase", 1);
                        v.setDynamicProperty("dm:melee_phase_tick", system.currentTick);
                        v.setDynamicProperty("dm:emergency_burst", 1);
                        v.setDynamicProperty("dm:block_retreat_tick", system.currentTick);

                        try {
                            v.triggerEvent("dm:block_parry");
                        } catch (_) {}
                    }
                } catch (_) {}
            });
        } catch (_) {}
    });

    meleeLog("[DM-Melee] 格挡已注册 (顶层注册, tag总阀门+统一周期+EWMA威胁+攻击者溯源)");
}

registerBlockSubscriber();

// manager 的 DmTargetEngine.init() 会调用 initBlockMechanic()
// 幂等，不会重复注册。
MovementMelee.initBlockMechanic = function () {
    registerBlockSubscriber();
    meleeLog("[DM-Melee] v2.26 性能优化版初始化完成");
};