import { system, world, EntityDamageCause } from "@minecraft/server";
import {
    registerBeforeHurtHandler,
    registerEntityRemoveHandler,
    HURT_PRIORITY,
    REMOVE_PRIORITY
} from "./event_bus.js";
import {
    writeMoveCmd,
    acquireMoveCmd,
    peekMoveCmd,
    clearMoveCmd
} from "./move_command_store.js";
import {
    FACTION,
    factionOf,
    isInCombat
} from "./camp_faction.js";
import {
    detectLiquid,
    applyLiquidSpeed,
    resolveFloatImpulse,
    isDrowningRecovering
} from "./water_traversal.js";
import { isPlayerMounted } from "../player/ride_guard.js";

// 日志开关
const DEBUG_MELEE = false;

// 水下冲刺（Aqua Charge）：水下浮游只有 20% 速度，贴不到近战 reach。
// 冲刺是唯一带 teleport 的路径，且 teleport 的 y 取目标位置 ——
// 水下放开冲刺门槛 == 垂直瞬移对齐深度，不新增任何机制。
// AQUA_CHARGE_H_DIST_FACTOR 限制水平距离，避免变成水下远程突进；
// 冲刺速度不豁免液体减速（试过，水下像贴地飞行，已回退）。
const AQUA_CHARGE_H_DIST_FACTOR = 3;

// 冲刺落点向上搜索层数。teleport 的 checkForBlocks 对水体判得松，
// 会传进海底方块卡住窒息，所以落点自己判一次（最多抬 3 格）。
const TELEPORT_UP_SEARCH = 3;

function meleeLog(...args) {
    if (DEBUG_MELEE) {
        console.warn(...args);
    }
}

function getDistSq(a, b) {
    if (!a || !b) return 99999;
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

// 攻击者溯源：Boss AOE 以友方位置生成弹射物时，把伤害归因给真正施法者。
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

// 友方攻击者判定：格挡是对敌防御，不该被自己人消耗。
// 总线按优先级分发（100 格挡 → 300 友伤拦截）且不因 cancel 中断，
// 所以格挡必须在自己的处理器里先判一次阵营。
// 口径与 player_attack_blocker 一致，兜底用 dm 家族（mob: 下混着敌人）。
export const ALLIED_ATTACKER_TYPES = new Set([
    // 真人玩家：不带 dm 家族，阵营兜底会判成中立 → 必须白名单
    "minecraft:player",


    // ── 原版友善 / 驯服生物：工程未覆盖，确无 dm 家族 ──
    // 这几个是白名单真正不可拆的部分：拆掉就会被判成敌人。
    "minecraft:horse",
    "minecraft:donkey",
    "minecraft:mule",
    "minecraft:skeleton_horse",
    "minecraft:zombie_horse",
    "minecraft:wolf",
    "minecraft:cat",
    "minecraft:parrot"
]);

export function isAlliedAttacker(entity, victim, victimFaction) {
    // 攻击者不可用（摔落 / 火焰 / 中毒 / 虚空 / 已移除实体）→ 不算格挡对象
    if (!entity || !entity.isValid) return true;

    // 自伤不消耗护盾
    if (victim && entity.id === victim.id) return true;

    const tid = entity.typeId;

    if (!tid) return true;

    // 快路径：常见友军直接命中，省掉一次 family 查询
    if (ALLIED_ATTACKER_TYPES.has(tid)) return true;

    // player 命名空间：dm0~dm63 / asuna / kirito / steve / test1
    // 已核实 73 个实体全部是干员与友军，没有敌人混用此前缀
    if (tid.startsWith("player:")) return true;

        // 兜底：同阵营 → 友（替代原来的 matches({ families: ["dm"] })，demon 接入后会判错）。
        // 白名单与 player: 前缀保留：带 dm 家族的省一次查询，原版马/狼只认白名单。
        // victimFaction 由调用方传入时不重复求值。
    try {
        const attackerFaction = factionOf(entity);

        if (attackerFaction !== FACTION.NEUTRAL) {
            if (!victim || !victim.isValid) return false;

            const fv = victimFaction === undefined
                ? factionOf(victim)
                : victimFaction;

            return attackerFaction === fv;
        }
    } catch (_) {}

    return false;
}

// 缓存区
const MeleeDamageLogCache = new Map();
const PendingHurtLedger = new Map();
const MeleeCycleCache = new Map();

// 优化：血量采样不再使用 DynamicProperty + JSON，
// 改为纯内存缓存，降低每 5 tick 的 JSON.parse / JSON.stringify 开销。
const HpSamplesCache = new Map();

// 战斗瞬态：每 5 tick 必读必写的一批状态。放动态属性等于每轮 8 次实体 NBT IO，
// 而且存的是绝对 tick —— currentTick 每次进世界从 0 重计，存档里上一局的
// fence_until 会让近战永久停手（nowTick <= fenceUntil 恒真）。按 entityId
// 对齐实体实例：重载即视为初次见面，宁可少触发一次栅栏，也不要拿旧快照误判。
const MeleeSnap = new Map();

function msGet(unit, key, dflt) {
    try {
        const s = MeleeSnap.get(unit.id);
        if (s && s[key] !== undefined) return s[key];
    } catch (_) { }
    return dflt;
}

function msSet(unit, key, val) {
    try {
        let s = MeleeSnap.get(unit.id);
        if (s === undefined) { s = {}; MeleeSnap.set(unit.id, s); }
        if (val === undefined) delete s[key];
        else s[key] = val;
    } catch (_) { }
}

// 实体移除时统一清理缓存，降低内存泄漏风险
registerEntityRemoveHandler("melee_cache", (event) => {
    try {
        const id = event.removedEntity?.id;
        if (!id) return;

        MeleeDamageLogCache.delete(id);
        PendingHurtLedger.delete(id);
        MeleeCycleCache.delete(id);
        HpSamplesCache.delete(id);
        MeleeSnap.delete(id);
    } catch (_) {}
}, REMOVE_PRIORITY.MELEE_CACHE);

// 区块卸载重载后 MeleeSnap 里的快照属于"上一次加载"，不可信 —— 直接丢。
try {
    world.afterEvents.entityLoad.subscribe((ev) => {
        try { MeleeSnap.delete(ev.entity.id); } catch (_) { }
    });
} catch (_) { }

/*
 * Fictoria_Impact 近战走位动力学引擎。
 * EWMA 威胁目标 / 缓冲层栅栏 / 真实受击佐证 / 统一周期引擎 / 格挡 / 冲刺 / 稳健后撤。
 * 稳健模式保留地形安全偏转（悬崖、坑、岩浆、墙），只对 balanced phase 1/2 生效；卡墙处理只做
 * 冲刺专用的两格检测，不做事前瞬移与卡死检测。性能：血量采样走内存 Map、实体移除清缓存、
 * 格挡后的实体操作延后到 system.run。
 */
export class MovementMelee {
    //  生命值工具函数
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

    //  回血速率工具函数
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

    //  攻击模式识别工具函数
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

    //  生存预测
    //  优化：允许外部传入 hpInfo，并复用 observedNetHps
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
        const fenceUntil = msGet(unit, "dm:melee_fence_until", 0);
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
            msSet(unit, "dm:emergency_burst", 1);

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

                    const lastLog = msGet(unit, "dm:melee_cycle_log_tick", 0);

                    if (nowTick - lastLog >= 40) {
                        msSet(unit, "dm:melee_cycle_log_tick", nowTick);

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

                const lastLog = msGet(unit, "dm:melee_peak_log_tick", 0);

                if (nowTick - lastLog >= 40) {
                    msSet(unit, "dm:melee_peak_log_tick", nowTick);

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

                const lastColdLog = msGet(unit, "dm:melee_cold_log_tick", 0);

                if (nowTick - lastColdLog >= 40) {
                    msSet(unit, "dm:melee_cold_log_tick", nowTick);

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

                const lastLog = msGet(unit, "dm:melee_slope_log_tick", 0);

                if (nowTick - lastLog >= 40) {
                    msSet(unit, "dm:melee_slope_log_tick", nowTick);

                    meleeLog(`[DM-Predict] 净斜率=${netHps.toFixed(1)}HP/s → 预计${timeToDeath.toFixed(1)}s死亡`);
                }
            }
        }

        const blockRetreatTick = msGet(unit, "dm:block_retreat_tick", 0);
        const isBlockRetreatActive = (nowTick - blockRetreatTick) < 30;

        if (isBlockRetreatActive && currentStrategy === "balanced") {
            return "balanced";
        }

        const EXIT_BALANCED_THRESHOLD = baseThreshold + 0.10;
        const lastHitFromLog = history[history.length - 1]?.tick ?? 0;

        if (currentStrategy === "balanced") {
            const blockCharges = msGet(unit, "dm:melee_block_charges", 0);

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

        /*
     * 重载钳制：战斗瞬态里有一批动态属性（跨存档）存的是绝对 tick。进世界后 `system.currentTick`
     * 从 0 重计 → `nowTick - 旧tick` 变成大负数 →
     * · `dm:melee_charging == 1` 永远不满足 `elapsed > chargeDur` → 每 tick 继续施加冲刺冲量；
     * · `dm:melee_phase_tick` 陈旧 → `phaseElapsed >= X` 恒假 → 卡死在 phase 1（-dir 后撤）；
     * · `dm:ranged_retaliate` 同理。
     * 空中无摩擦、`applyImpulse` 每 tick 累加 → 表现是一直往天上后撤，飞几百格摔死。
     * MeleeSnap 里没有这条 id = 本次加载后第一次见（`entityLoad` 会清它）→ 归零再跑。只动战斗瞬态，
     * 不动策略/协议本身。
     * @returns {boolean} 是否做了归零
     */
    static _sanitizeOnFirstSight(unit) {
        try {
            if (MeleeSnap.has(unit.id)) return false;
            MeleeSnap.set(unit.id, {});
        } catch (_) {
            return false;
        }

        // 布尔型：置 0（冲刺中 / 远程反击待发）
        const ZERO_PROPS = ["dm:melee_charging", "dm:ranged_retaliate"];
        // 绝对 tick 型：抹掉 → 读到 `?? 0` → 当"很久以前"，冷却立刻通过
        const TICK_PROPS = [
            "dm:melee_charge_tick",
            "dm:melee_charge_start_dist",
            "dm:melee_strategy_tick",
            "dm:melee_phase_tick",
            "dm:melee_charges_zero_tick",
            "dm:melee_emergency_tick",
            "dm:ranged_retaliate_tick",
            "dm:threat_target_tick"
        ];

        try {
            for (const k of ZERO_PROPS) unit.setDynamicProperty(k, 0);
            for (const k of TICK_PROPS) unit.setDynamicProperty(k, undefined);
            unit.setDynamicProperty("dm:threat_target_id", undefined);
        } catch (_) { /* 实体刚消失 / 只读快照 */ }

        return true;
    }

        // 目标阵营校验：受击账本 / 动态属性 / 原版索敌都可能残留友军，统一过一遍。
    static _isHostileTarget(unit, candidate, unitFaction) {
        if (!candidate || !candidate.isValid) return false;

        return !isAlliedAttacker(candidate, unit, unitFaction);
    }

    //  主执行
    static execute(unit, config, closestThreat, closestDistSq, meleeRange, lastDamageTickMap, faction = null) {
        try {
            if (!unit || !unit.isValid) {
                if (unit) {
                    MeleeDamageLogCache.delete(unit.id);
                    MeleeCycleCache.delete(unit.id);
                    HpSamplesCache.delete(unit.id);
                }

                return;
            }

                        // 本次加载后第一次见到她 → 把上一局存档里的战斗瞬态归零。
                        // 必须排在所有早退与冲量计算之前：charging/phase 一旦残留，
                        // 这一帧就会把「停不下来」的冲量再叠一次。
            MovementMelee._sanitizeOnFirstSight(unit);

            // 特殊骑乘状态硬拦截
            if (unit.hasTag("maid:ride_player")) {
                MovementMelee._clearVel(unit);
                return;
            }

                        // 玩家骑着她 → 熔断走位，方向交给玩家。
                        // 只停"移动"：攻击、格挡、受击反应照常。骑在马上还能挥刀才是玩法，
                        // 但一具身体不能有两个方向盘 —— 引擎一施力，坐骑就开始和玩家对抗。
            if (isPlayerMounted(unit)) {
                MovementMelee._clearVel(unit);
                return;
            }

            const controller = unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;

            const nowTick = system.currentTick;
            const uLoc = unit.location;

                        // 溺水换气：清空走位指令后 main.js 会把它从 ActiveMovers 摘除，
                        // 由 behavior.float 自行上浮，到期恢复接管。
                        // 传实体不是 id —— 解除条件要看是否出水 / 露头。
            if (isDrowningRecovering(unit, nowTick)) {
                clearMoveCmd(unit);
                return;
            }

            // 阵营：目标引擎在 entry 里已经算过，直接传进来。
            // 缺省（其它调用点）才现场查一次 —— matches 比 hasTag 贵一个数量级，
            // 不要放在下面的循环里重复求值。
            const unitFaction = faction ?? factionOf(unit);

            // 液体 / 漂浮检测（统一走 water_traversal）

            // waterProbe 是「本帧本单位的方块回执」：detectLiquid 把查到的
            // 脚格 / 腰格填进去，后面 resolveFloatImpulse 命中就复用，
            // 省一次水面探针的 getBlock。必须每帧新建，不要跨 tick 缓存。
            const waterProbe = {};
            const isInLiquid = detectLiquid(unit.dimension, uLoc, waterProbe);
            const isFloating = isInLiquid && !controller.isOnGround;
            const isAirborne = !controller.isOnGround && !isInLiquid;

            // TAG 总阀门（tag 名按阵营分派：dm_* / demon_*）
            const isCombat = isInCombat(unit, unitFaction);

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

                        // 候选目标必须真的是敌人：四个来源都可能被友伤污染
                        // （EWMA 账本 / dm:threat_target_id / 原版索敌），
                        // 用与格挡同一套 isAlliedAttacker 过滤。

                        // ① 最高威胁分数目标
            try {
                if (topThreatId) {
                    const threat = world.getEntity(topThreatId);

                    if (MovementMelee._isHostileTarget(unit, threat, unitFaction)) {
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

                        if (MovementMelee._isHostileTarget(unit, threat, unitFaction)) {
                            const tdsq = getDistSq(uLoc, threat.location);

                            if (tdsq <= detectRange ** 2) {
                                target = threat;
                                targetDistSq = tdsq;
                            }
                        } else if (threat && threat.isValid) {
                            // 被友伤写脏的历史目标：一次性清掉，
                            // 顺带让 movement_ranged 的受击回退也不再引用它。
                            unit.setDynamicProperty("dm:threat_target_id", undefined);
                            unit.setDynamicProperty("dm:threat_target_tick", 0);
                        }
                    }
                } catch (_) {}
            }

            // ③ 雷达最近威胁
            if (!target && MovementMelee._isHostileTarget(unit, closestThreat, unitFaction)) {
                target = closestThreat;
                targetDistSq = closestDistSq;
            }

            // ④ 原版索敌兜底
            if (
                (!target || !target.isValid || targetDistSq > detectRange ** 2) &&
                MovementMelee._isHostileTarget(unit, unit.target, unitFaction)
            ) {
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

            // 缓冲层栅栏 + 真实受击佐证
            const lastHp = msGet(unit, "dm:melee_last_hp", hp);
            const lastAbs = msGet(unit, "dm:melee_last_abs", info.absHp);
            const lastBaseMax = msGet(unit, "dm:melee_last_base_max", info.baseMax);
            const lastSnapTick = msGet(unit, "dm:melee_last_snap_tick", 0);

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

            let fenceUntil = msGet(unit, "dm:melee_fence_until", 0);

            if (buffTransition) {
                fenceUntil = nowTick + 15;

                msSet(unit, "dm:melee_fence_until", fenceUntil);
                msSet(unit, "dm:emergency_burst", 0);

                const lastFl = msGet(unit, "dm:melee_fence_log_tick", 0);

                if (nowTick - lastFl >= 60) {
                    msSet(unit, "dm:melee_fence_log_tick", nowTick);

                    meleeLog(`[DM-Melee] 🧱 缓冲层栅栏激活(15tick): absΔ=${absDelta.toFixed(0)} baseMaxΔ=${baseMaxDelta.toFixed(0)} | ${unit.typeId}`);
                }
            }

            const isFenced = nowTick <= fenceUntil;

            // 快照推进
            msSet(unit, "dm:melee_last_hp", hp);
            msSet(unit, "dm:melee_last_abs", info.absHp);
            msSet(unit, "dm:melee_last_base_max", info.baseMax);
            msSet(unit, "dm:melee_last_snap_tick", nowTick);

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
                const lastDl = msGet(unit, "dm:melee_drop_log_tick", 0);

                if (nowTick - lastDl >= 60) {
                    msSet(unit, "dm:melee_drop_log_tick", nowTick);

                    meleeLog(`[DM-Melee] 🧱 丢弃未佐证扣血 ${hpDelta.toFixed(1)} (fenced=${isFenced ? "是" : "否"}, 受击=${hurtFresh ? "有" : "无"}) | ${unit.typeId}`);
                }
            }

            // 策略预测与切换
            // 优化：把当前 info 传给 _predictSurvival，避免重复读取
            let strategy = unit.getDynamicProperty("dm:melee_strategy") ?? "aggressive";
            const lastSw = unit.getDynamicProperty("dm:melee_strategy_tick") ?? 0;

            const wish = MovementMelee._predictSurvival(unit, config, nowTick, info);

            const isEmergency = msGet(unit, "dm:emergency_burst", 0) === 1;

            if (wish !== strategy && ((nowTick - lastSw > 40) || (wish === "balanced" && isEmergency))) {
                const blockRetreatTick = msGet(unit, "dm:block_retreat_tick", 0);
                const isBlockProtected = (nowTick - blockRetreatTick) < 30;
                const isIllegalSwitch = isBlockProtected && strategy === "balanced" && wish === "aggressive";

                if (!isIllegalSwitch) {
                    strategy = wish;

                    unit.setDynamicProperty("dm:melee_strategy", strategy);
                    unit.setDynamicProperty("dm:melee_strategy_tick", nowTick);
                    msSet(unit, "dm:emergency_burst", 0);

                    if (strategy === "balanced") {
                        unit.setDynamicProperty("dm:melee_phase", 1);
                        unit.setDynamicProperty("dm:melee_phase_tick", nowTick);
                        msSet(unit, "dm:melee_block_charges", config.blockCharges ?? 3);

                        if (typeof config.blockMinDamage === "number" && config.blockMinDamage > 0) {
                            unit.setDynamicProperty("dm:melee_block_min_damage", config.blockMinDamage);
                        } else {
                            unit.setDynamicProperty("dm:melee_block_min_damage", undefined);
                        }

                        meleeLog(`[DM-Melee] 战术后撤! 已激活 ${config.blockCharges ?? 3} 次稳健格挡护盾 | 实体: ${unit.typeId}`);
                    } else if (strategy === "aggressive") {
                        msSet(unit, "dm:melee_block_charges", 0);
                    }

                    meleeLog(`[DM-Melee] 策略切换: ${strategy === "balanced" ? "稳健后撤" : "激进冲锋"}`);
                }
            }

            // 护盾自充能
            if (strategy === "balanced" && (hp / maxHp) >= 0.50) {
                const bCharges = msGet(unit, "dm:melee_block_charges", 0);

                if (bCharges <= 0) {
                    const lastZero = unit.getDynamicProperty("dm:melee_charges_zero_tick") ?? 0;

                    if (nowTick - lastZero >= 60) {
                        msSet(unit, "dm:melee_block_charges", config.blockCharges ?? 3);
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

            // 液体减速只结算一次（water_traversal 统一口径）

            // 冲刺同样吃这个减速，不做豁免：把冲刺速度提到陆地量级会变成水下贴地飞行，
            // 加成只保留配置里的 chargeSpeed。
            baseSpeed = applyLiquidSpeed(baseSpeed, isInLiquid, isFloating);

            // 水下冲刺豁免直接传布尔：isFloating 来自上方已有的双层查询，
            // 子引擎内再查会每 tick 多两次 getBlock。

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
                    jumpImpulse,
                    isFloating
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
                    jumpImpulse,
                    isFloating
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
                const prevCmd = peekMoveCmd(unit.id);
                const prevVelX = prevCmd.x;
                const prevVelZ = prevCmd.z;

                const SMOOTHING = 0.3;

                if (prevVelX !== 0 || prevVelZ !== 0) {
                    velX = prevVelX + (velX - prevVelX) * (1 - SMOOTHING);
                    velZ = prevVelZ + (velZ - prevVelZ) * (1 - SMOOTHING);
                }
            }

            // 水中浮潜（统一走 water_traversal）

            // 传 waterProbe：用的就是本次 execute 开头 detectLiquid 查到的
            // 那两格，命中水面探针时省一次 getBlock。
            if (isFloating) {
                jumpImpulse = resolveFloatImpulse(
                    unit.dimension,
                    uLoc,
                    target.location.y - uLoc.y,
                    waterProbe
                );
            }

            // 写入指令速度

            // 改造前是 3 次 setDynamicProperty（持久化通道）。
            // 这三个键在 entities/ 与资源包中 0 引用，
            // 只是给 main.js 驱动环读的瞬时指令，改为内存写入。
            writeMoveCmd(unit, velX, velZ, jumpImpulse);
        } catch (err) {
            console.error(`[DM-Melee Engine Error] ${err.name}: ${err.message}`);

            if (err.stack) {
                console.error(`[DM-Melee Engine Stack]\n${err.stack}`);
            }
        }
    }

        // 激进冲锋：原三维冲刺 / Teleport / AOE 不动，只在启动前与冲刺中加墙体检测。
    static _aggressive(unit, config, target, distSq, meleeRange, dirX, dirZ, baseSpeed, nowTick, jumpImpulse, isFloating = false) {
        let velX = 0;
        let velZ = 0;

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

        // 水平距离：水下冲刺豁免只看水平，不看三维。
        // 三维距离在目标沉到深水时会被 dy 撑大，正是要绕过的那个门槛。
        const hDistNow = Math.sqrt(dx * dx + dz * dz);

        if (isCharging) {
            // 冲刺中撞墙保护：
            // 检测到正前方是真正墙体时取消冲刺。
            // 不触发原有 Teleport，也不进入 AOE 分支。
            if (MovementMelee._isRealWallAhead(unit, dirX, dirZ)) {
                unit.setDynamicProperty("dm:melee_charging", 0);

                return {
                    velX: 0,
                    velZ: 0,
                    jumpImpulse: 0.02
                };
            }

            const chargeStart = unit.getDynamicProperty("dm:melee_charge_tick") ?? nowTick;
            const elapsed = nowTick - chargeStart;

            const startDist = unit.getDynamicProperty("dm:melee_charge_start_dist") ?? dist3D;
            const traveled = startDist - dist3D;

            const hDist = Math.sqrt(dx * dx + dz * dz);

            if (hDist < meleeRange * 1.5 || traveled >= maxChargeDist || elapsed > chargeDur) {
                unit.setDynamicProperty("dm:melee_charging", 0);

                const stopX = tLoc.x - dirX * (meleeRange * 0.8);
                const stopZ = tLoc.z - dirZ * (meleeRange * 0.8);

                // 落点先自己判一次。

                // 不合格时必须整段放弃：不 teleport、不结算 AOE。
                // 硬传进去的后果是被挤进海底方块内部持续窒息，
                // 而防窒息模块的脱困检索在水下也未必能及时找到出口。
                const landing = MovementMelee._findSafeLanding(
                    unit.dimension,
                    stopX,
                    tLoc.y,
                    stopZ
                );

                if (!landing) {
                    meleeLog(`[DM-Melee] 冲刺落点无空位，放弃 teleport | 实体: ${unit.typeId}`);

                    return {
                        velX: 0,
                        velZ: 0,
                        jumpImpulse: 0.02
                    };
                }

                // 骑乘时位移必须落在坐骑身上：对骑手 teleport 会直接打断骑乘关系，
                // 表现就是「一冲刺她就从马上掉下来」。冲量那边 main.js 早就打到
                // entityRidingOn 了，只有 teleport 漏了这一层。
                let dashTarget = unit;

                try {
                    const rideMount = unit.getComponent("minecraft:riding")?.entityRidingOn;

                    if (rideMount && rideMount.isValid) {
                        dashTarget = rideMount;
                    }
                } catch (_) { }

                try {
                    dashTarget.teleport(
                        {
                            x: landing.x,
                            y: landing.y,
                            z: landing.z
                        },
                        {
                            checkForBlocks: true
                        }
                    );

                    dashTarget.clearVelocity();
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

            const baseMinChargeRange = config.chargeRange ?? 10;
            const maxChargeRange = config.maxChargeRange ?? Infinity;

                        // 水下 + 水平已贴近 → 取消远距离门槛。冲刺内 hDist < meleeRange*1.5 走 teleport，
                        // 其 y 取目标位置 = 垂直对齐深度。陆地 isFloating 为 false，行为零变化。
            const aquaCharge = isFloating &&
                hDistNow <= meleeRange * AQUA_CHARGE_H_DIST_FACTOR;

            const minChargeRange = aquaCharge ? 0 : baseMinChargeRange;

            const inRange = dist3D >= minChargeRange && dist3D <= maxChargeRange;

            if ((nowTick - lastChargeTick) >= 100 && inRange && dy < 10.0 && target?.isValid && !MovementMelee._isRealWallAhead(unit, dirX, dirZ)) {
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

        // 冲刺落点安全检查：checkForBlocks 只保证不是完整固体，水下会落进海底。
        // 可通行 = 空气或液体（水下必须放行液体，否则海底附近永远找不到落点）。
        // 顺序：原位 → 上 1~3 → 下 1 → 四邻 1；都不行返回 null，放弃本次 teleport。
    static _findSafeLanding(dim, x, y, z) {
        try {
            if (!dim) return null;

                        // 一次性缓存去重：13 个候选位置反复查同一批格子，26 次 getBlock 降到约 14 次。
                        // 只在单次调用内有效（方块会变，跨冲刺复用会给出陈旧落点）。
            const blockCache = new Map();

            const getBlockAt = (bx, by, bz) => {
                const key = `${bx},${by},${bz}`;

                const hit = blockCache.get(key);

                if (hit !== undefined) return hit;

                let block = null;

                try {
                    // ?? null：未加载区块时 getBlock 返回 undefined，
                    // 归一成 null，否则缓存命中判断（!== undefined）会失效。
                    block = dim.getBlock({ x: bx, y: by, z: bz }) ?? null;
                } catch (_) {}

                blockCache.set(key, block);

                return block;
            };

            const passable = (bx, by, bz) => {
                const body = getBlockAt(bx, by, bz);
                if (!body) return false;
                if (!body.isAir && !body.isLiquid) return false;

                const head = getBlockAt(bx, by + 1, bz);
                if (!head) return false;
                if (!head.isAir && !head.isLiquid) return false;

                return true;
            };

            const bx = Math.floor(x);
            const by = Math.floor(y);
            const bz = Math.floor(z);

            if (passable(bx, by, bz)) return { x, y, z };

            // 水下卡底时通常只差一两格，垂直优先
            for (let dy = 1; dy <= TELEPORT_UP_SEARCH; dy++) {
                if (passable(bx, by + dy, bz)) return { x, y: by + dy, z };
            }

            if (passable(bx, by - 1, bz)) return { x, y: by - 1, z };

            // 目标贴着墙时侧移一格，落点取格子中心
            const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];

            for (let i = 0; i < offsets.length; i++) {
                const ox = offsets[i][0];
                const oz = offsets[i][1];

                if (passable(bx + ox, by, bz + oz)) {
                    return { x: bx + ox + 0.5, y: by, z: bz + oz + 0.5 };
                }

                if (passable(bx + ox, by + 1, bz + oz)) {
                    return { x: bx + ox + 0.5, y: by + 1, z: bz + oz + 0.5 };
                }
            }

            return null;
        } catch (_) { return null; }
    }

        // 冲刺专用墙体检测：只判正前方是否真正两格实体墙（半砖/楼梯/地毯不会同时填满两格）。
    static _isRealWallAhead(unit, dirX, dirZ) {
        try {
            if (!unit || !unit.isValid) return false;

            const loc = unit.location;
            const dim = unit.dimension;

            const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
            if (len < 0.0001) return false;

            const nx = dirX / len;
            const nz = dirZ / len;

            const checkAt = (dist) => {
                const px = loc.x + nx * dist;
                const pz = loc.z + nz * dist;

                const lower = dim.getBlock({
                    x: px,
                    y: Math.floor(loc.y + 0.5),
                    z: pz
                });

                const upper = dim.getBlock({
                    x: px,
                    y: Math.floor(loc.y + 1.5),
                    z: pz
                });

                return (
                    lower &&
                    upper &&
                    !lower.isAir &&
                    !lower.isLiquid &&
                    !upper.isAir &&
                    !upper.isLiquid
                );
            };

            return checkAt(0.8) || checkAt(1.3);
        } catch (_) {
            return false;
        }
    }

        // 地形探针：safe / step / wall / pit / cliff / lava
    static _probeTerrain(unit, dirX, dirZ, distance) {
        const dim = unit.dimension;
        const loc = unit.location;
        const floorY = Math.floor(loc.y);

        const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
        if (len < 0.0001) return "safe";

        const nx = dirX / len;
        const nz = dirZ / len;

        const px = loc.x + nx * distance;
        const pz = loc.z + nz * distance;

        try {
            const body = dim.getBlock({ x: px, y: floorY, z: pz });
            const below = dim.getBlock({ x: px, y: floorY - 1, z: pz });

            // ── 岩浆 ──
            if (
                (body && body.typeId && body.typeId.includes("lava")) ||
                (below && below.typeId && below.typeId.includes("lava"))
            ) {
                return "lava";
            }

            // ── 脚下悬空：悬崖 or 坑 ──
            const belowOpen = !below || below.isAir || below.isLiquid;

            if (belowOpen) {
                const deep = dim.getBlock({ x: px, y: floorY - 3, z: pz });
                const deepOpen = !deep || deep.isAir || deep.isLiquid;

                return deepOpen ? "cliff" : "pit";
            }

            // ── 前方有固体：台阶 or 高墙 ──
            const bodySolid = body && !body.isAir && !body.isLiquid;

            if (bodySolid) {
                const head = dim.getBlock({ x: px, y: floorY + 1, z: pz });
                const headSolid = head && !head.isAir && !head.isLiquid;

                return headSolid ? "wall" : "step";
            }
        } catch (_) {
            return "safe";
        }

        return "safe";
    }

        // 地形安全偏转：撞到悬崖 / 坑 / 岩浆 / 墙时把走位切到边缘切线，保持移动。
        // preferSide 由 strafeDir 决定；isFloating 时直接返回，一次方块都不查。
        // 水体必须短路：脚下是液体 → 三个方向恒判 cliff → 水平速度被砍到 3%，像原地磨蹭，
        // 而且 9 次 getBlock 换来的永远是「危险」。
    static _applyTerrainSafety(unit, velX, velZ, jumpImpulse, probeDist, preferSide, isFloating = false) {
        // 浮游：地形探针的语义不成立（见上方说明），原样返回
        if (isFloating) {
            return { velX, velZ, jumpImpulse };
        }

        const speed = Math.sqrt(velX * velX + velZ * velZ);

        if (speed < 0.001) {
            return { velX, velZ, jumpImpulse };
        }

        const nx = velX / speed;
        const nz = velZ / speed;

        const status = MovementMelee._probeTerrain(unit, nx, nz, probeDist);

        // 前方安全，直接走
        if (status === "safe") {
            return { velX, velZ, jumpImpulse };
        }

        // 一格台阶，跳过去
        if (status === "step") {
            return { velX, velZ, jumpImpulse: Math.max(jumpImpulse, 0.32) };
        }

        // ── cliff / pit / lava / wall：沿边缘切线滑动 ──
        const leftX = -nz;
        const leftZ = nx;

        const rightX = nz;
        const rightZ = -nx;

        const leftStatus = MovementMelee._probeTerrain(unit, leftX, leftZ, probeDist);
        const rightStatus = MovementMelee._probeTerrain(unit, rightX, rightZ, probeDist);

        const leftOk = (leftStatus === "safe" || leftStatus === "step");
        const rightOk = (rightStatus === "safe" || rightStatus === "step");

        let chosenX = 0;
        let chosenZ = 0;
        let chosenStatus = "safe";

        if (leftOk && rightOk) {
            // 两边都安全，按 preferSide 选，保持环绕方向一致
            if (preferSide >= 0) {
                chosenX = rightX;
                chosenZ = rightZ;
                chosenStatus = rightStatus;
            } else {
                chosenX = leftX;
                chosenZ = leftZ;
                chosenStatus = leftStatus;
            }
        } else if (leftOk) {
            chosenX = leftX;
            chosenZ = leftZ;
            chosenStatus = leftStatus;
        } else if (rightOk) {
            chosenX = rightX;
            chosenZ = rightZ;
            chosenStatus = rightStatus;
        } else {
            // 两边都危险：贴边大幅减速，但不彻底归零
            return {
                velX: velX * 0.15,
                velZ: velZ * 0.15,
                jumpImpulse
            };
        }

        let newJump = jumpImpulse;

        if (chosenStatus === "step") {
            newJump = Math.max(jumpImpulse, 0.32);
        }

        return {
            velX: chosenX * speed,
            velZ: chosenZ * speed,
            jumpImpulse: newJump
        };
    }

    //  稳健走位（含地形安全偏转）
    static _balanced(unit, config, target, targetDistSq, meleeRange, dirX, dirZ, tangentX, tangentZ, baseSpeed, nowTick, jumpImpulse, isFloating = false) {
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

        if ((retaliateActive || distanceActive) && !isCharging && chargeCooldownOk && !MovementMelee._isRealWallAhead(unit, dirX, dirZ)) {
            unit.setDynamicProperty("dm:ranged_retaliate", 0);
            unit.setDynamicProperty("dm:melee_charging", 1);
            unit.setDynamicProperty("dm:melee_charge_tick", nowTick);
            unit.setDynamicProperty("dm:melee_charge_start_dist", distNow);

            meleeLog(`[DM-Melee] 触发远程反击冲刺! 当前距离=${distNow.toFixed(1)}在[${minChargeRange}, ${maxChargeRange === Infinity ? "∞" : maxChargeRange}]区间内 | 实体: ${unit.typeId}`);
        }

        if (rangedRetaliate && (nowTick - rangedRetaliateTick) >= 60) {
            unit.setDynamicProperty("dm:ranged_retaliate", 0);
        }

        // ── 冲刺中（原样保留，不做地形安全）──
        if (isCharging) {
            // 稳健模式冲刺撞墙保护：
            // 检测到正前方是真正墙体时取消冲刺。
            if (MovementMelee._isRealWallAhead(unit, dirX, dirZ)) {
                unit.setDynamicProperty("dm:melee_charging", 0);

                return {
                    velX: 0,
                    velZ: 0,
                    jumpImpulse: 0.02
                };
            }

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

        // ── phase 走位 ──
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

                // 稳健模式地形安全偏转：只对 phase 1/2 生效，冲刺不受影响；浮游时整段跳过。
        const TERRAIN_PROBE_DIST = 1.3;

        const safe = MovementMelee._applyTerrainSafety(
            unit,
            velX,
            velZ,
            jumpImpulse,
            TERRAIN_PROBE_DIST,
            strafeDir,
            isFloating
        );

        velX = safe.velX;
        velZ = safe.velZ;
        jumpImpulse = safe.jumpImpulse;

        return {
            velX,
            velZ,
            jumpImpulse
        };
    }

    // 清速
    static _clearVel(unit) {
        clearMoveCmd(unit);
        unit.setDynamicProperty("dm:melee_charging", 0);
    }
}

// 格挡：模块顶层注册
let _blockSubscriberRegistered = false;

function registerBlockSubscriber() {
    if (_blockSubscriberRegistered) return;

    _blockSubscriberRegistered = true;

    function handleMeleeBeforeHurt(event) {
        try {
            const victim = event.hurtEntity;

            if (!victim || !victim.isValid) return;

            const isDmUnit =
                victim.typeId?.startsWith("player:") &&
                victim.typeId !== "minecraft:player";

            const hpInfo = isDmUnit ? MovementMelee._getHpInfo(victim) : null;

                        // 阵营闸门（惰性求值，每次受击最多算一次）：友伤不进受击账本、
                        // 不进 EWMA 威胁账本、不消耗格挡次数。
                        // 必须判：友伤拦截把 damage 归零之前，这里读到的还是原始伤害，
                        // 不判就会把误伤它的玩家当成威胁目标。
                        // 惰性：resolveRealAttacker 对投射物要做 24 格溯源，零伤害受击不需要。
            let gateReady = false;
            let resolvedAttacker = null;
            let attackerIsAllied = false;

            const resolveAttackerGate = () => {
                if (gateReady) return;

                gateReady = true;

                if (!isDmUnit) return;

                try {
                    const rawAtk = event.damageSource?.damagingEntity;

                    if (rawAtk && rawAtk.isValid && rawAtk.id !== victim.id) {
                        resolvedAttacker = resolveRealAttacker(rawAtk, victim);
                        attackerIsAllied = isAlliedAttacker(resolvedAttacker, victim);
                    }
                } catch (_) {}
            };

            // 账本与喂数据都要求 damage > 0，这里统一先算一次
            if (isDmUnit && event.damage > 0) resolveAttackerGate();

            // ── 真实受击账本 ──
            if (isDmUnit && event.damage > 0 && !attackerIsAllied) {
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

            // 友方攻击不喂：EWMA 威胁账本是「谁真的在打我」的账本，
            // 混进友军后，① 最高威胁目标会优先选中友军。
            if (isDmUnit && event.damage > 0 && hpInfo && !attackerIsAllied) {
                const realAttacker = resolvedAttacker;

                const isFakeHurt =
                    !realAttacker ||
                    !realAttacker.isValid ||
                    realAttacker.id === victim.id;

                if (!isFakeHurt) {
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
            const charges = msGet(victim, "dm:melee_block_charges", 0);

            if (charges <= 0) return;

            // 受击方阵营：这条链路拿不到 entry，现场判定一次。
            // 受击事件是低频路径，一次 matches 可以忽略。
            const isCombat = isInCombat(victim, factionOf(victim));

            if (!isCombat) return;

                        // 阵营闸门：只有真实敌方的攻击才消耗格挡次数（玩家/友军也会触发格挡）。
                        // 放在 charges / isCombat 之后：没护盾的实体开销不变。
            resolveAttackerGate();

            if (!resolvedAttacker || !resolvedAttacker.isValid) return;

            if (attackerIsAllied) {
                meleeLog(
                    `[DM-Melee] 友方攻击，跳过格挡 | 攻击者: ${resolvedAttacker.typeId ?? "unknown"} | 实体: ${victim.typeId}`
                );

                return;
            }

            let minBlockDamage = Math.max((hpInfo ? hpInfo.hp : 20) * 0.05, 3);

            const cfgMin = victim.getDynamicProperty("dm:melee_block_min_damage");

            if (typeof cfgMin === "number" && cfgMin > 0) {
                minBlockDamage = cfgMin;
            }

            if (event.damage < minBlockDamage) return;

            const blockedDamage = event.damage;
            const remainingCharges = charges - 1;

            msSet(victim, "dm:melee_block_charges", remainingCharges);

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

            // ===== 格挡粒子：角色身边多个随机点位 =====
            try {
                const particleCount = 5 + Math.floor(Math.random() * 4);
                for (let i = 0; i < particleCount; i++) {
                    const rx = (Math.random() - 0.5) * 1.4;
                    const ry = 0.3 + Math.random() * 1.5;
                    const rz = (Math.random() - 0.5) * 1.4;
                    v.dimension.spawnParticle("minecrafts:parry_particle", {
                        x: v.location.x + rx,
                        y: v.location.y + ry,
                        z: v.location.z + rz
                    });
                }
            } catch (_) {}

            // ===== 格挡音效 =====
            try {
                v.dimension.playSound("dm_parry", v.location, {
                    volume: 1.2,
                    pitch: 0.9 + Math.random() * 0.2
                });
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

                        msSet(v, "dm:emergency_burst", 1);
                        msSet(v, "dm:block_retreat_tick", system.currentTick);

                        try {
                            v.triggerEvent("dm:block_parry");
                        } catch (_) {}
                    }
                } catch (_) {}
            });
        } catch (_) {}
    }

    registerBeforeHurtHandler(
        "melee_block",
        handleMeleeBeforeHurt,
        HURT_PRIORITY.MELEE_BLOCK
    );

    meleeLog("[DM-Melee] 格挡已注册 (顶层注册, tag总阀门+统一周期+EWMA威胁+攻击者溯源)");
}

registerBlockSubscriber();

// manager 的 DmTargetEngine.init() 会调用 initBlockMechanic()
// 幂等，不会重复注册。
MovementMelee.initBlockMechanic = function () {
    registerBlockSubscriber();

    meleeLog("[DM-Melee] v2.28 冲刺墙检测整理版初始化完成");
};