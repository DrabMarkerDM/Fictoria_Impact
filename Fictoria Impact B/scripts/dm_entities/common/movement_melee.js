import { system, world, EntityDamageCause } from "@minecraft/server";

function getDistSq(a, b) {
    if (!a || !b) return 99999;
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

// 攻击者溯源：Boss近战AOE以"友方位置生成弹射物"实现时，
// 把弹射物伤害归因给真正施法者（owner → 最近怪物），防止污染EWMA威胁参照/决斗识别
function resolveRealAttacker(attacker, victim) {
    try {
        if (!attacker || !attacker.isValid) return attacker;
        const isProjectile = (attacker.matches && attacker.matches({ families: ["projectile"] }))
            || (attacker.typeId && attacker.typeId.includes("bullet"));
        if (!isProjectile) return attacker;

        // 1) 弹射物组件 owner（若Boss召唤时设置了owner）
        try {
            const projComp = attacker.getComponent("minecraft:projectile");
            if (projComp && projComp.owner && projComp.owner.isValid) {
                return projComp.owner;
            }
        } catch (_) { }
        // 2) entity_owner 组件
        try {
            const ownerComp = attacker.getComponent("minecraft:entity_owner");
            if (ownerComp && ownerComp.ownerId) {
                const owner = world.getEntity(ownerComp.ownerId);
                if (owner && owner.isValid) return owner;
            }
        } catch (_) { }
        // 3) 兜底：归因给受害者附近最近的怪物（近战AOE的施法者通常就在近旁）
        const nearby = victim.dimension.getEntities({
            location: victim.location,
            maxDistance: 24,
            families: ["monster"]
        });
        let nearest = null, minD = 24 * 24;
        for (const e of nearby) {
            if (!e.isValid) continue;
            const d = getDistSq(e.location, victim.location);
            if (d < minD) { minD = d; nearest = e; }
        }
        if (nearest) return nearest;
    } catch (_) { }
    return attacker;
}

const MeleeDamageLogCache = new Map();

// ════════════════════════════════════════════════════════════
//  v2.26.1 真实受击账本：victimId -> { tick, damage, hasRealAttacker }
//  由顶层 entityHurt 订阅者写入，execute() 用它佐证"真实扣血"，
//  从而区分：【盾被真实攻击消耗】 与 【吸收池消失/刷新造成的假波动】。
// ════════════════════════════════════════════════════════════
const PendingHurtLedger = new Map();

// 敌人攻击模式缓存：按受击者记录，识别周期性重刀
// 存的是【被格挡前的原始伤害】——格挡不影响对 Boss 输出节奏的识别
// v2.16.1 增加 attackerDamage：统计各攻击者伤害占比 → 决斗/群战识别
// 聚合伤害峰值节奏：检测"总伤害流"的周期性高峰（Boss招小怪/怪群同步技能）
// 统一周期缓存：合并 1v1 重刀周期 与 群战峰值节奏为单一引擎
// attackerDamage 升级为 EWMA 威胁分数（受击累加，每execute衰减）
const MeleeCycleCache = new Map(); // victimId -> CyclePattern（重刀字段+峰值字段+attackerDamage）

/**
 * Fictoria_Impact 近战走位动力学引擎 v2.26
 * v2.8  空中走位 / cancel语法修复
 * v2.9  吸收值参与生存计算 / 稳健死锁破除
 * v2.10 格挡订阅者移到模块顶层注册
 * v2.11 同步扣次数（防超额格挡）/ 格挡标记过滤
 * v2.12 恢复 tag 总阀门（与 movement_ranged.js 完全一致）
 * v2.13 生存预测重构：观测净血量斜率(中位数) + 爆发阈值基于当前血量
 *       + 删除旧 weightedDps=单次伤害×20 的虚高公式
 * v2.14 再生公式修正为官方 bit-shift 精确算法；冷启动初始模型
 * v2.16 周期伤害预测模型（1v1 Boss 特化）：识别敌方周期性重刀
 * v2.16.1 🛡 决斗识别：单一攻击者占比≥70%才启用 1v1 周期模型
 * v2.16.2 ⚖ 双重判据：周期平均扛得住 && 单发不致死
 * v2.18 格挡低伤门槛（DoT不消耗护盾）/ 攻击模式只认实体攻击者
 * v2.19 护盾自充能（防周期锁死无盾稳健）
 * v2.20 空中目标冲刺修复（水平距离收尾 + 传送拉Y）
 * v2.21 超级冲刺距离直检（不依赖被打标记）
 * v2.22 聚合伤害峰值节奏模型（群战周期）：检测总伤害流的周期性高峰
 * v2.23  统一周期引擎：合并 1v1 重刀周期 与 群战峰值节奏
 *   - 单一缓存 MeleeCycleCache + 单一引擎 _analyzeUnifiedCycle
 *   - 窗口峰值事件为主（天然涵盖单发重刀），峰值内最大单发承接"单发致死"判据
 *   - 双输出：周期DPS(决斗用) + 下一波预判(任何情况用)
 * v2.25 EWMA威胁目标走位参照：
 *   - attackerDamage 升级为 EWMA 威胁分数（受击累加，每execute衰减至80%）
 *   - 走位参照 = 最高威胁分数目标（绕"打我最疼的"走）
 *   - 突入者首击即上位（即时响应），停手者自然退场（稳定）
 *   - 顺带：_isDuel 改用分数，决斗识别更平滑
 * v2.25.1 攻击者溯源：弹射物伤害归因给真正施法者（owner → 最近怪物）
 *   - 修复：Boss近战AOE用"友方位置生成弹射物"实现时，EWMA威胁参照与决斗识别被弹射物ID污染
 * v2.26 血池修复（核心）：
 *   - 伤害记录从"含buff的有效血量差值"改为"刨掉吸收池(absDelta) + 最大血量变化(baseMaxDelta)"后的真实扣血
 *   - 修复：伤害吸收(255级=1024血) 或 生命值提升 消失瞬间，被误判为扣血上千 → 假触发稳健后撤/环绕
 *   - 生命值提升(health_boost) 仍作为真实血量纳入预测（realHp含boost）；吸收作为独立护盾层不计入伤害
 * v2.26.1 缓冲层栅栏 + 真实受击佐证（根治吸收/生命提升 消失·刷新·添加 的假扣血波动）：
 *   - ① 缓冲层栅栏：战斗无法解释的缓冲层变化 → 拉15tick栅栏，钳制采样/跳过入账/清紧急标记
 *   - ② 真实受击佐证：hpDelta 仅在"快照之后新发生的真实受击"佐证时入账；无攻击者大额下降一律丢弃
 *   - ③ 快照原子初始化：lastHp/lastAbs/lastBaseMax 首次观测即取当前值，不再默认0
 *   - ④ 上限提到20000：兼容 5000 血大招（setDefaultValue）的 5000↔29 切换
 *   - ⑤ 顶层entityHurt 登记真实受击账本 + 假受伤甄别（无攻击者/自伤 不喂周期模型）
 * v2.26.2 护盾击穿感知（修复"穿透5点被误判成敌人只有5点攻击力"）：
 *   - 新增 rawSingleEma：最近3秒内最狠的原始单发伤害（含被吸收部分）
 *   - 单发致死判据护盾感知：护盾已破(<4血)时，按 rawSingleEma 估算下一击，不再用被护盾稀释的真实扣血
 */
export class MovementMelee {

    // ══════════════════════════════════════════════════
    //  生命值工具函数
    // ══════════════════════════════════════════════════
    static _getEffectiveMaxHp(unit) {
        let baseMaxHp = 20;
        try {
            const hpComp = unit.getComponent("minecraft:health") ?? unit.getComponent("health");
            if (hpComp && hpComp.defaultValue > 0) baseMaxHp = hpComp.defaultValue;
        } catch (_) { }
        let extraHp = 0;
        try {
            const healthBoostEffect = unit.getEffect("health_boost");
            if (healthBoostEffect) extraHp += (healthBoostEffect.amplifier + 1) * 4;
        } catch (_) { }
        // ★ v2.26.1 上限提到 20000：兼容 5000 血大招（5000+1024吸收=6024 < 20000）
        return Math.min(baseMaxHp + extraHp, 20000);
    }

    // 吸收值HP（sss技能 absorption 255级 = 1024血）
    static _getAbsorptionHp(unit) {
        try {
            const e = unit.getEffect("absorption");
            if (e) return (e.amplifier + 1) * 4;
        } catch (_) { }
        return 0;
    }

    // 统一取当前血量/最大血量，防御两种引擎语义（currentValue 是否含吸收）
    static _getHpInfo(unit) {
        const hpComp = unit.getComponent("minecraft:health") ?? unit.getComponent("health");
        if (!hpComp) return null;
        const realHp = hpComp.currentValue;              // ★ 真实基础血量（含 health_boost，不含吸收层）
        const baseMax = MovementMelee._getEffectiveMaxHp(unit);
        const absHp = MovementMelee._getAbsorptionHp(unit);
        const maxHp = Math.min(baseMax + absHp, 20000);  // ★ v2.26.1 兼容 5000 血大招
        let hp = realHp;
        if (hp <= baseMax + 1 && absHp > 0) hp += absHp; // 有效血量 = 真实 + 吸收
        return { hp, realHp, maxHp, absHp, baseMax, hpComp };
    }

    static _logDamage(unit, nowTick, actualDamage) {
        let log = MeleeDamageLogCache.get(unit.id);
        if (!log) { log = []; MeleeDamageLogCache.set(unit.id, log); }
        log.push({ tick: nowTick, amount: actualDamage });
        if (log.length > 30) {
            MeleeDamageLogCache.set(unit.id, log.filter(e => nowTick - e.tick < 150));
        }
    }

    // ══════════════════════════════════════════════════
    //  回血速率工具函数
    // ══════════════════════════════════════════════════

    // 再生回血速率（HP/s）——官方bit-shift精确算法
    // 原版：每 (50 >> amplifier) tick 回1血；结果≤0时每tick回1（20HP/s）
    static _getRegenHps(unit) {
        try {
            const regen = unit.getEffect("regeneration");
            if (regen) {
                const interval = 50 >> regen.amplifier;
                return 20 / (interval > 0 ? interval : 1);
            }
        } catch (_) { }
        return 0;
    }

    // 冷启动初始模型：确定性已知回血下限（观测数据不足时兜底）
    static _getInitialModelHps(unit) {
        return MovementMelee._getRegenHps(unit);
    }

    // 观测净血量斜率（HP/s）——主判定（群战天然聚合）
    // 相邻采样对的每秒净变化 → 中位数（抗吸收耗尽幻象、爆发治疗等单点毛刺）
    static _getObservedNetHps(unit) {
        try {
            const raw = unit.getDynamicProperty("dm:melee_hp_samples");
            if (typeof raw !== "string") return null;
            const samples = JSON.parse(raw);
            if (!Array.isArray(samples) || samples.length < 3) return null;

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
        } catch (_) { return null; }
    }

    // ══════════════════════════════════════════════════
    //  攻击模式识别工具函数
    // ══════════════════════════════════════════════════

    // 受击喂数据：记录原始伤害 + 攻击者伤害占比
    // attackerId 用于决斗/群战识别；原始伤害用于重刀检测（格挡不影响节奏识别）
    // 写入统一周期缓存（MeleeCycleCache），窗口峰值由 _analyzeUnifiedCycle 扫描
    // attackerDamage 从"累计dmg"升级为"EWMA威胁分数score"
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
                    attackerDamage: new Map(),
                };
                MeleeCycleCache.set(victimId, p);
            }
            p.heavyThreshold = Math.max(currentHp * 0.50, 15);

            // ── 攻击者EWMA威胁分数（决斗/群战识别 + 走位威胁参照）──
            try {
                let ad = p.attackerDamage.get(attackerId);
                if (!ad) { ad = { score: 0, tick: nowTick }; p.attackerDamage.set(attackerId, ad); }
                // 受击累加分数（衰减由 execute 每tick执行）
                ad.score = (ad.score ?? 0) + rawDamage;
                ad.tick = nowTick;
                for (const [id, rec] of p.attackerDamage) {
                    if (nowTick - rec.tick > 60) p.attackerDamage.delete(id);
                }
            } catch (_) { }

            // ── 重刀检测（相对当前生存池）──
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

            // ── v2.26.2 原始单发伤害EMA（护盾击穿后"单发致死"预判用）──
            // 取最近3秒(60tick)内最狠的原始单发（含被吸收的部分），
            // 供 _predictSurvival 在护盾已破时估算"下一击会不会秒杀"
            // 注意：吸收池消失补发的假entityHurt已被 isFakeHurt 过滤，不会污染此值
            try {
                const lastRawTick = p.rawSingleTick ?? 0;
                p.rawSingleEma = (nowTick - lastRawTick > 60)
                    ? rawDamage
                    : Math.max(p.rawSingleEma ?? 0, rawDamage);
                p.rawSingleTick = nowTick;
            } catch (_) { }
        } catch (_) { }
    }

    // 决斗识别：60tick内单一攻击者伤害占比 ≥ 70% 才视为1v1
    // 群战（混合伤害无主导者）→ false → 周期DPS输出禁用，只留峰值预判
    // 改用EWMA威胁分数，识别更平滑
    static _isDuel(pattern, nowTick) {
        try {
            if (!pattern || pattern.attackerDamage.size === 0) return true;
            let total = 0, top = 0;
            for (const [id, rec] of pattern.attackerDamage) {
                if (nowTick - rec.tick > 60) continue;
                const sc = rec.score ?? 0;
                total += sc;
                if (sc > top) top = sc;
            }
            if (total <= 0) return true;
            return top / total >= 0.70;
        } catch (_) { return true; }
    }

    // 统一周期分析：合并 1v1 重刀周期 与 群战峰值节奏
    // 窗口峰值事件为主（10tick总伤≥40%生存池，天然涵盖单发重刀）
    // 峰值内最大单发EMA 承接原"单发致死"判据
    // 返回 { cycleSeconds, cycleDps, tToNext, waveLethal, maxSingleEma } 或 null
    static _analyzeUnifiedCycle(unit, nowTick, cacheEntry) {
        try {
            if (!cacheEntry) return null;
            const info = MovementMelee._getHpInfo(unit);
            if (!info) return null;
            const currentHp = info.hp;

            const p = cacheEntry;
            p.windowThreshold = Math.max(currentHp * 0.40, 12);

            // 扫描伤害日志：窗口总伤 / 窗口内最大单发 / 近3秒总伤
            let windowSum = 0;
            let windowMaxSingle = 0;
            let total60 = 0;
            const history = MeleeDamageLogCache.get(unit.id) ?? [];
            for (const log of history) {
                if (nowTick - log.tick <= 10 && log.amount > 0.5) {
                    windowSum += log.amount;
                    if (log.amount > windowMaxSingle) windowMaxSingle = log.amount;
                }
                if (nowTick - log.tick <= 60 && log.amount > 0.5) {
                    total60 += log.amount;
                }
            }

            // 峰值事件（窗口总伤达标 且 距上次峰值>10tick：同一波不重复计数）
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

            // 未学到节奏 → null
            if (p.peakGapCount < 1 || p.lastPeakTick <= 0 || p.peakDmgEma <= 0) return null;

            const intervalTicks = p.peakGapTotal / p.peakGapCount;
            const intervalSeconds = intervalTicks / 20;
            const tToNext = (p.lastPeakTick + intervalTicks) - nowTick;
            const waveLethal = p.peakDmgEma >= p.windowThreshold;

            return {
                cycleSeconds: intervalSeconds,
                cycleDps: total60 / 3.0,        // 近3秒总DPS（含轻重刀与波次）
                tToNext,
                waveLethal,
                maxSingleEma: p.peakMaxSingleEma,
                rawSingleEma: p.rawSingleEma ?? 0,   // ★ v2.26.2 原始单发（含被吸收部分）
            };
        } catch (_) { return null; }
    }

    // ══════════════════════════════════════════════════
    //  生存预测
    // ══════════════════════════════════════════════════
    static _predictSurvival(unit, config, nowTick) {
        const info = MovementMelee._getHpInfo(unit);
        if (!info) return "aggressive";

        const currentHp = info.hp;
        const maxHp = info.maxHp;
        const hpPct = currentHp / maxHp;

        const baseThreshold = config.survivalThreshold ?? 0.35;
        const currentStrategy = unit.getDynamicProperty("dm:melee_strategy") ?? "aggressive";
        const lastSw = unit.getDynamicProperty("dm:melee_strategy_tick") ?? 0;

        const history = MeleeDamageLogCache.get(unit.id) ?? [];

        if (!history || history.length === 0) {
            return hpPct < baseThreshold ? "balanced" : "aggressive";
        }

        // ── ① 爆发判定（0.5s瞬间穿透：回血来不及，伤害日志最准）──
        // v2.26.1 栅栏期兜底：缓冲层刚波动（吸收消失/刷新），伤害账本不可信 → 跳过burst
        const fenceUntil = unit.getDynamicProperty("dm:melee_fence_until") ?? 0;
        const isInFence = nowTick <= fenceUntil;
        let recentBurstDamage = 0;
        let recentHits = 0;
        if (!isInFence) {
            for (const log of history) {
                // 0.1 = 格挡标记，不参与"受击次数"统计
                if (nowTick - log.tick <= 10 && log.amount > 0.5) {
                    recentBurstDamage += log.amount;
                    recentHits++;
                }
            }
        }
        // 爆发阈值基于「当前血量」+绝对下限
        const isHeavyDamage = recentBurstDamage >= Math.max(currentHp * 0.60, 14);
        const isBalancedBurst = currentStrategy === "balanced" && recentHits >= 3;
        if (isBalancedBurst || isHeavyDamage) {
            unit.setDynamicProperty("dm:emergency_burst", 1);
            console.warn(`[DM-Predict]  触发紧急避险! 0.5s受击=${recentHits}次, 扣血=${recentBurstDamage.toFixed(1)}`);
            return "balanced";
        }

        let isTTKDangerous = false;

        // ── ②.7 统一周期判定（v2.23）──
        // 合并 ②.5(1v1重刀周期) 与 ②.6(群战峰值)：单一引擎，双输出
        //   - 决斗：用 周期DPS(输出①) + 预判(输出②)
        //   - 群战：只用 预判(输出②)，周期DPS交给观测净斜率（防过度稳健）
        const cycleCache = MeleeCycleCache.get(unit.id);
        const cycleInfo = MovementMelee._analyzeUnifiedCycle(unit, nowTick, cycleCache);
        if (cycleInfo !== null) {
            const isDuel = MovementMelee._isDuel(cycleCache, nowTick);

            // 输出①：周期DPS承受力（仅决斗，含 v2.16.2 双重判据）
            if (isDuel) {
                let healingHps = MovementMelee._getRegenHps(unit);
                const observed = MovementMelee._getObservedNetHps(unit);
                if (observed !== null && observed > healingHps) healingHps = observed;

                const cycleDamage = cycleInfo.cycleDps * cycleInfo.cycleSeconds;
                const cycleHeal = healingHps * cycleInfo.cycleSeconds;
                // 双重判据：周期平均扛得住 && 单发不致死（峰值内最大单发承接）
                const canSurviveAverage = (currentHp + cycleHeal) > cycleDamage * 1.25;
                // ★ v2.26.2 护盾击穿感知：
                //   吸收盾存在时，真实扣血历史=穿透部分（例：25伤害打20盾 → 只记5）
                //   一旦护盾被击穿(<4血)，下一击将吃到全额原始伤害 → 改用"最近3秒最狠原始单发"估算
                //   修复：不再把"穿透5点"误判为敌人只有5点攻击力
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
                        console.warn(`[DM-Predict]  周期判定: 每${cycleInfo.cycleSeconds.toFixed(1)}s一轮(DPS=${cycleInfo.cycleDps.toFixed(1)}) 一轮${cycleDamage.toFixed(0)}伤 vs 血${currentHp.toFixed(0)}+回${cycleHeal.toFixed(0)} ${!canSurviveAverage ? "平均扛不住" : ""}${!canSurviveSingleHit ? `单发${singleHitEstimate.toFixed(0)}>血${currentHp.toFixed(0)}秒杀${shieldDown ? "(护盾已破)" : ""}` : ""} → 稳健`);
                    }
                }
            }

            // 输出②：下一波峰值预判（任何情况，含群战）
            if (cycleInfo.tToNext > 0 && cycleInfo.tToNext <= 8 && cycleInfo.waveLethal) {
                isTTKDangerous = true;
                const lastLog = unit.getDynamicProperty("dm:melee_peak_log_tick") ?? 0;
                if (nowTick - lastLog >= 40) {
                    unit.setDynamicProperty("dm:melee_peak_log_tick", nowTick);
                    console.warn(`[DM-Predict]  峰值预判: 下一波伤害高峰将至(<${Math.ceil(cycleInfo.tToNext)}tick) → 稳健`);
                }
            }
        }

        // ── ② 持续致死判定：观测净血量斜率（自动含所有回血来源，群战主通道）──
        let netHps = MovementMelee._getObservedNetHps(unit);
        if (netHps === null) {
            // 冷启动：观测不足 → 用「伤害日志真实DPS − 初始模型回血」预判
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
                // 修正后的时间跨度DPS（非旧虚高公式）
                const spanTicks = Math.max(5, lastHitTick - firstHitTick + 1);
                const realDps = totalActualDamage / (spanTicks / 20);
                const initHps = MovementMelee._getInitialModelHps(unit);
                netHps = initHps - realDps;
                // 冷启动初始模型首次生效日志（节流，每2秒一条）
                const lastColdLog = unit.getDynamicProperty("dm:melee_cold_log_tick") ?? 0;
                if (nowTick - lastColdLog >= 40) {
                    unit.setDynamicProperty("dm:melee_cold_log_tick", nowTick);
                    console.warn(`[DM-Predict]  冷启动: 回血=${initHps.toFixed(1)}HP/s 敌DPS=${realDps.toFixed(1)} → 净=${netHps.toFixed(1)}HP/s`);
                }
            } else {
                netHps = 0;
            }
        }

        if (netHps < -1.0) {
            const timeToDeath = currentHp / Math.abs(netHps);
            if (timeToDeath < 4.0) {
                isTTKDangerous = true;
                // 节流打日志（每2秒最多一条），方便核对净曲线
                const lastLog = unit.getDynamicProperty("dm:melee_slope_log_tick") ?? 0;
                if (nowTick - lastLog >= 40) {
                    unit.setDynamicProperty("dm:melee_slope_log_tick", nowTick);
                    console.warn(`[DM-Predict]  净斜率=${netHps.toFixed(1)}HP/s → 预计${timeToDeath.toFixed(1)}s死亡`);
                }
            }
        }
        // netHps >= -1 → 血量平稳/回稳 → 打不死 → 保持激进

        const blockRetreatTick = unit.getDynamicProperty("dm:block_retreat_tick") ?? 0;
        const isBlockRetreatActive = (nowTick - blockRetreatTick) < 30;

        if (isBlockRetreatActive && currentStrategy === "balanced") {
            return "balanced";
        }

        const EXIT_BALANCED_THRESHOLD = baseThreshold + 0.10;
        const lastHitFromLog = history[history.length - 1]?.tick ?? 0;

        if (currentStrategy === "balanced") {
            const blockCharges = unit.getDynamicProperty("dm:melee_block_charges") ?? 0;
            // 稳健死锁破除：护盾用完+血量健康+不会被秒+已稳健≥2秒 → 反击
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
    //  主执行（结构对齐 movement_ranged.js）
    // ══════════════════════════════════════════════════
    static execute(unit, config, closestThreat, closestDistSq, meleeRange, lastDamageTickMap) {
        try {
            if (!unit || !unit.isValid) {
                if (unit) {
                    MeleeDamageLogCache.delete(unit.id);
                    MeleeCycleCache.delete(unit.id);   // 统一缓存清理
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
            } catch (_) { }
            // 液体/漂浮检测
            let isInLiquid = false;
            try {
                const feet = unit.dimension.getBlock({ x: uLoc.x, y: Math.floor(uLoc.y), z: uLoc.z });
                const waist = unit.dimension.getBlock({ x: uLoc.x, y: Math.floor(uLoc.y + 1), z: uLoc.z });
                if ((feet && feet.isLiquid) || (waist && waist.isLiquid)) isInLiquid = true;
            } catch (_) { }
            const isFloating = isInLiquid && !controller.isOnGround;
            const isAirborne = !controller.isOnGround && !isInLiquid;
            // ═══════════════════════════════════════════════════
            //  TAG 总阀门（与 movement_ranged.js 完全一致）
            //  只有 dm_has_target / dm_skill_on 存在时才允许移动开销。
            //  main.js / 目标传感器 通过增删这两个 tag 直接开关整套走位。
            // ═══════════════════════════════════════════════════
            const isCombat = unit.hasTag("dm_has_target") || unit.hasTag("dm_skill_on");
            if (!isCombat) {
                MovementMelee._clearVel(unit);
                return;
            }

            // EWMA威胁分数衰减 + 选出最高威胁者（走位参照用）
            // 每execute(5tick)所有攻击者分数×0.8（≈0.8秒半衰）
            // 突入者首击即高分（即时响应），停手者自然退场（稳定）
            let topThreatId = null;
            try {
                const cc = MeleeCycleCache.get(unit.id);
                if (cc && cc.attackerDamage && cc.attackerDamage.size > 0) {
                    let topScore = 0;
                    for (const [id, rec] of cc.attackerDamage) {
                        rec.score = (rec.score ?? 0) * 0.80;
                        if (rec.score < 0.5) { cc.attackerDamage.delete(id); continue; }
                        if (rec.score > topScore) { topScore = rec.score; topThreatId = id; }
                    }
                }
            } catch (_) { }

            // 目标解析：威胁目标(EWMA最高分数) > 最近受击源 > 雷达最近 > 原版索敌
            const chargeRange = config.chargeRange ?? 10;
            const detectRange = Math.max(meleeRange * 2.5, chargeRange + 5);
            let target = null;
            let targetDistSq = 99999;

            // ① 最高威胁分数目标：绕"打我最疼的"走
            // 修复：原版索敌锁定远处A、B贴脸输出时，围绕B走位（后撤/环绕/格挡方向全对）
            try {
                if (topThreatId) {
                    const threat = world.getEntity(topThreatId);
                    if (threat && threat.isValid) {
                        const tdsq = getDistSq(uLoc, threat.location);
                        if (tdsq <= detectRange ** 2) { target = threat; targetDistSq = tdsq; }
                    }
                }
            } catch (_) { }

            // ② 最近受击源兜底（即时响应，覆盖EWMA首tick前的空窗）
            if (!target) {
                try {
                    const threatId = unit.getDynamicProperty("dm:threat_target_id");
                    const threatTick = unit.getDynamicProperty("dm:threat_target_tick") ?? 0;
                    if (threatId && (nowTick - threatTick) < 120) {
                        const threat = world.getEntity(threatId);
                        if (threat && threat.isValid) {
                            const tdsq = getDistSq(uLoc, threat.location);
                            if (tdsq <= detectRange ** 2) { target = threat; targetDistSq = tdsq; }
                        }
                    }
                } catch (_) { }
            }

            // ③ 雷达最近威胁（原逻辑）
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
            // 血量信息（含吸收）
            const info = MovementMelee._getHpInfo(unit);
            if (!info) { MovementMelee._clearVel(unit); return; }
            const hp = info.hp;
            const maxHp = info.maxHp;

            // ═══════════════════════════════════════════════════════════
            //  ★ v2.26.1 缓冲层栅栏 + 真实受击佐证
            //  （根治：伤害吸收/生命值提升 自然消失·刷新·添加 造成的假扣血波动）
            //
            //  ① 缓冲层栅栏：战斗无法解释的缓冲层变化 → 拉15tick栅栏，
            //     栅栏期钳制血量采样、跳过伤害入账、清紧急标记（杜绝假斜率/假burst）
            //  ② 真实受击佐证：hpDelta 仅在"快照之后新发生的真实受击"佐证时入账，
            //     无攻击者的大额下降一律当作吸收消失怪癖丢弃
            //  ③ 快照原子初始化：lastHp/lastAbs/lastBaseMax 首次观测即取当前值，
            //     不再默认 0，从根上消除"带buff出生/召唤"造成的假差值
            // ═══════════════════════════════════════════════════════════
            const lastHp = unit.getDynamicProperty("dm:melee_last_hp") ?? hp;
            const lastAbs = unit.getDynamicProperty("dm:melee_last_abs") ?? info.absHp;   // ★ 不再默认0
            const lastBaseMax = unit.getDynamicProperty("dm:melee_last_base_max") ?? info.baseMax;
            const lastSnapTick = unit.getDynamicProperty("dm:melee_last_snap_tick") ?? 0;
            const absDelta = info.absHp - lastAbs;                    // 吸收池变化（消失=-1024）
            const baseMaxDelta = info.baseMax - lastBaseMax;          // 最大血量变化（boost消失=-104）
            const hpDelta = (hp - lastHp) - absDelta - baseMaxDelta;  // 代数上的真实扣血

            // ── ① 缓冲层栅栏判定 ──
            const pendingHurt = PendingHurtLedger.get(unit.id);
            const hurtFresh = pendingHurt && (nowTick - pendingHurt.tick) <= 6;
            // 盾被真实攻击消耗：窗口内累积受击伤害 ≥ 吸收池降幅（含2点浮点容差），属正常战斗，不拉栅栏
            // 不再要求"伤害≈盾降"（会漏掉"一击远超护盾"的击穿场景），
            //   只要"伤害足以解释盾的下降"即可——伤害打黄条永远是先扣吸收、再穿透真血，
            //   所以 盾降 ≤ 窗口总伤害 即视为战斗消耗，而非自然消失
            const absConsumedByHurt = absDelta < 0 && hurtFresh
                && Math.abs(absDelta) <= pendingHurt.damage + 2;
            // 真正的缓冲层波动（战斗无法解释的变化）→ 拉栅栏
            const buffTransition = (absDelta >= 4)                                   // 吸收被添加/刷新
                || Math.abs(baseMaxDelta) >= 4                                       // 生命提升 变化
                || (absDelta <= -4 && !absConsumedByHurt);                           // 吸收骤降且无攻击解释（自然消失）
            let fenceUntil = unit.getDynamicProperty("dm:melee_fence_until") ?? 0;
            if (buffTransition) {
                fenceUntil = nowTick + 15;
                unit.setDynamicProperty("dm:melee_fence_until", fenceUntil);
                unit.setDynamicProperty("dm:emergency_burst", 0);   // 清掉可能残留的假紧急标记
                const lastFl = unit.getDynamicProperty("dm:melee_fence_log_tick") ?? 0;
                if (nowTick - lastFl >= 60) {                       // 节流日志
                    unit.setDynamicProperty("dm:melee_fence_log_tick", nowTick);
                    console.warn(`[DM-Melee] 🧱 缓冲层栅栏激活(15tick): absΔ=${absDelta.toFixed(0)} baseMaxΔ=${baseMaxDelta.toFixed(0)} | ${unit.typeId}`);
                }
            }
            const isFenced = nowTick <= fenceUntil;
            // 快照推进（栅栏期内照常推进，保持代数自洽）
            unit.setDynamicProperty("dm:melee_last_hp", hp);
            unit.setDynamicProperty("dm:melee_last_abs", info.absHp);
            unit.setDynamicProperty("dm:melee_last_base_max", info.baseMax);
            unit.setDynamicProperty("dm:melee_last_snap_tick", nowTick);

            // 生命值采样（观测回血模型）：栅栏期一律钳制，杜绝假负斜率
            try {
                let hpSamples = [];
                const rawSamples = unit.getDynamicProperty("dm:melee_hp_samples");
                if (typeof rawSamples === "string") {
                    const parsed = JSON.parse(rawSamples);
                    if (Array.isArray(parsed)) hpSamples = parsed;
                }
                const lastSample = hpSamples[hpSamples.length - 1];
                let sampledHp = info.realHp;
                if ((isFenced || hpDelta >= -0.01) && lastSample) {
                    // 栅栏期或未受击：采样值不得低于上次（滤除吸收消失的假断崖）
                    sampledHp = Math.max(info.realHp, lastSample.h);
                }
                hpSamples.push({ t: nowTick, h: sampledHp });
                if (hpSamples.length > 24) hpSamples = hpSamples.slice(-24);
                unit.setDynamicProperty("dm:melee_hp_samples", JSON.stringify(hpSamples));
            } catch (_) { }

            // ── ② 真实受击佐证入账 ──
            // 只有"快照之后新发生的受击"才能佐证一次真实扣血；
            // 无攻击者的受击仅认小额（跌落/DoT），大额一律当作吸收消失怪癖丢弃
            const corroborated = hurtFresh
                && pendingHurt.tick > lastSnapTick
                && Math.abs(hpDelta) >= 0.5
                && (pendingHurt.hasRealAttacker || Math.abs(hpDelta) <= 20);
            if (hpDelta < -0.01 && !isFenced && corroborated) {
                const realDmg = Math.min(Math.abs(hpDelta), info.baseMax * 1.2);
                MovementMelee._logDamage(unit, nowTick, realDmg);
                if (Math.abs(hpDelta) > info.baseMax * 1.2) {
                    console.warn(`[DM-Melee] 血量异常扣血已钳制: ${hpDelta.toFixed(0)} → ${realDmg.toFixed(0)} | ${unit.typeId}`);
                }
            } else if (hpDelta < -0.01 && Math.abs(hpDelta) >= 4) {
                // 未被佐证的大额下降 → 吸收/buff波动 假数据，直接丢弃（节流日志便于核对）
                const lastDl = unit.getDynamicProperty("dm:melee_drop_log_tick") ?? 0;
                if (nowTick - lastDl >= 60) {
                    unit.setDynamicProperty("dm:melee_drop_log_tick", nowTick);
                    console.warn(`[DM-Melee] 🧱 丢弃未佐证扣血 ${hpDelta.toFixed(1)} (fenced=${isFenced ? '是' : '否'}, 受击=${hurtFresh ? '有' : '无'}) | ${unit.typeId}`);
                }
            }

            // 策略预测与切换
            let strategy = unit.getDynamicProperty("dm:melee_strategy") ?? "aggressive";
            const lastSw = unit.getDynamicProperty("dm:melee_strategy_tick") ?? 0;
            const wish = MovementMelee._predictSurvival(unit, config, nowTick);
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
                        // 可选：写入配置化的格挡低伤门槛（不配则订阅者走启发式 max(hp×5%,3)）
                        if (typeof config.blockMinDamage === "number" && config.blockMinDamage > 0) {
                            unit.setDynamicProperty("dm:melee_block_min_damage", config.blockMinDamage);
                        } else {
                            unit.setDynamicProperty("dm:melee_block_min_damage", undefined);
                        }
                        console.warn(`[DM-Melee] 战术后撤! 已激活 ${config.blockCharges ?? 3} 次稳健格挡护盾 | 实体: ${unit.typeId}`);
                    } else if (strategy === "aggressive") {
                        unit.setDynamicProperty("dm:melee_block_charges", 0);
                    }
                    console.warn(`[DM-Melee] 策略切换: ${strategy === "balanced" ? "稳健后撤" : "激进冲锋"}`);
                }
            }
            // 护盾自充能：稳健模式下护盾耗尽且血量健康 → 3秒后直接补次数
            if (strategy === "balanced" && (hp / maxHp) >= 0.50) {
                const bCharges = unit.getDynamicProperty("dm:melee_block_charges") ?? 0;
                if (bCharges <= 0) {
                    const lastZero = unit.getDynamicProperty("dm:melee_charges_zero_tick") ?? 0;
                    if (nowTick - lastZero >= 60) {
                        unit.setDynamicProperty("dm:melee_block_charges", config.blockCharges ?? 3);
                        unit.setDynamicProperty("dm:melee_charges_zero_tick", nowTick);
                        console.warn(`[DM-Melee]  护盾自充能! 已补 ${config.blockCharges ?? 3} 次 | 实体: ${unit.typeId}`);
                    }
                }
            }
            // 方向向量
            const dx = target.location.x - uLoc.x;
            const dz = target.location.z - uLoc.z;
            const dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
            const dirX = dx / dist, dirZ = dz / dist;
            const tangentX = -dirZ, tangentZ = dirX;
            // 基础速度
            let baseSpeed = config.strafeSpeed ?? 0.35;
            try {
                const mc = unit.getComponent("minecraft:movement");
                if (mc && mc.defaultValue > 0) baseSpeed *= mc.currentValue / mc.defaultValue;
            } catch (_) { }
            if (isInLiquid) baseSpeed *= isFloating ? 0.20 : 0.60;
            // 走位计算
            let velX = 0, velZ = 0, jumpImpulse = 0.02;
            if (strategy === "aggressive") {
                ({ velX, velZ, jumpImpulse } = MovementMelee._aggressive(
                    unit, config, target, targetDistSq, meleeRange, dirX, dirZ, baseSpeed, nowTick, jumpImpulse
                ));
            } else {
                ({ velX, velZ, jumpImpulse } = MovementMelee._balanced(
                    unit, config, target, targetDistSq, meleeRange, dirX, dirZ, tangentX, tangentZ, baseSpeed, nowTick, jumpImpulse
                ));
            }
            // 紧急/恐慌后撤
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
            // 空中走位削弱（区别于 ranged 的空中冻结：近战被击飞仍可漂移脱身）
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
                    const sb = unit.dimension.getBlock({ x: uLoc.x, y: Math.floor(uLoc.y + 1.6), z: uLoc.z });
                    if (sb && sb.isAir) atSurface = true;
                } catch (_) { }
                if (dy > 0.5 && !atSurface) jumpImpulse = 0.18;
                else if (dy < -0.5) jumpImpulse = -0.20;
                else jumpImpulse = atSurface ? -0.08 : 0.05;
            }
            // 墙面检测 & 卡死检测（仅地面/水中）
            if (!isFloating && !isAirborne && (velX !== 0 || velZ !== 0)) {
                try {
                    const checkLower = { x: uLoc.x + velX * 0.8, y: uLoc.y + 0.5, z: uLoc.z + velZ * 0.8 };
                    const checkUpper = { x: uLoc.x + velX * 0.8, y: uLoc.y + 1.8, z: uLoc.z + velZ * 0.8 };
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
                } catch (_) { }
            }
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
                            // ★ v2.36 安全传送：卡死恢复不再可能传进方块（非冲刺逻辑）
                            MovementMelee._safeTeleport(unit, { x: uLoc.x - dirX * 1.5, y: uLoc.y + 0.8, z: uLoc.z - dirZ * 1.5 }, 2, 3, 2);
                            jumpImpulse = 0.30;
                        } else {
                            MovementMelee._safeTeleport(unit, { x: uLoc.x, y: uLoc.y + 0.4, z: uLoc.z }, 2, 3, 2);
                            jumpImpulse = 0.35;
                        }
                    } catch (_) { }
                    stuckTicks = 0;
                }
                unit.setDynamicProperty("dm:last_x", uLoc.x);
                unit.setDynamicProperty("dm:last_z", uLoc.z);
                unit.setDynamicProperty("dm:stuck_ticks", stuckTicks);
            }
            // 写入指令速度（供 main.js 的 driveMaidMuscles 每tick应用）
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
        let velX = 0, velZ = 0;
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
            // 用【水平距离】判断收尾：悬空目标不再因垂直高度差永远冲不到
            const hDist = Math.sqrt(dx * dx + dz * dz);
            if (hDist < meleeRange * 1.5 || traveled >= maxChargeDist || elapsed > chargeDur) {
                unit.setDynamicProperty("dm:melee_charging", 0);
                const stopX = tLoc.x - dirX * (meleeRange * 0.8);
                const stopZ = tLoc.z - dirZ * (meleeRange * 0.8);
                try {
                    // 收尾拉Y到目标高度：悬空目标直接传送至其高度命中
                    unit.teleport({ x: stopX, y: tLoc.y, z: stopZ }, { checkForBlocks: true });
                    unit.clearVelocity();
                } catch (_) { }
                // 冲刺伤害基于友方基础最大HP（不含吸收，保持数值平衡）
                const unitMaxHp = MovementMelee._getEffectiveMaxHp(unit);
                const rawDamage = unitMaxHp * 2;
                const damage = Math.min(rawDamage, 200);
                const aoeRadius = 3.5;
                const maxAoeTargets = 3;
                try {
                    const nearbyEntities = unit.dimension.getEntities({
                        location: { x: tLoc.x, y: tLoc.y, z: tLoc.z },
                        maxDistance: aoeRadius,
                        families: ["monster"]
                    });
                    const aoeTargets = nearbyEntities
                        .filter(e => e.isValid && e.id !== unit.id)
                        .sort((a, b) => {
                            const ax = tLoc.x - a.location.x, ay = tLoc.y - a.location.y, az = tLoc.z - a.location.z;
                            const bx = tLoc.x - b.location.x, by = tLoc.y - b.location.y, bz = tLoc.z - b.location.z;
                            return (ax * ax + ay * ay + az * az) - (bx * bx + by * by + bz * bz);
                        })
                        .slice(0, maxAoeTargets);
                    for (const t of aoeTargets) {
                        try {
                            if (unit.isValid && t.isValid) {
                                t.applyDamage(damage, { cause: "entityAttack", source: unit });
                            }
                        } catch (e) {
                            try { if (t.isValid) t.applyDamage(damage); } catch (_) { }
                        }
                    }
                    console.warn(`[DM-Melee]  冲刺AOE命中${aoeTargets.length}个目标! 伤害=${damage.toFixed(1)}(友方HP:${unitMaxHp.toFixed(0)}) | 实体: ${unit.typeId}`);
                } catch (e) {
                    try {
                        if (unit.isValid && target.isValid) {
                            target.applyDamage(damage, { cause: "entityAttack", source: unit });
                        }
                    } catch (_) { }
                }
                return { velX: 0, velZ: 0, jumpImpulse: 0.02 };
            } else {
                velX = dirX * baseSpeed * chargeSpeed;
                velZ = dirZ * baseSpeed * chargeSpeed;
                // 冲刺中垂直抬升增强（目标在上方时）
                jumpImpulse = dy > 0.8 ? Math.min(0.40, Math.max(0.20, (dy / dist3D) * 0.45)) : 0.02;
            }
        } else {
            const lastChargeTick = unit.getDynamicProperty("dm:melee_charge_tick") ?? 0;

            // 💥 1. 读取上限配置（若未配置则默认为 Infinity，即无上限）
            const minChargeRange = config.chargeRange ?? 10;
            const maxChargeRange = config.maxChargeRange ?? Infinity;

            // 💥 2. 检查距离是否落在 [min, max] 区间内
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
        return { velX, velZ, jumpImpulse };
    }

    // ══════════════════════════════════════════════════
    //  稳健走位
    // ══════════════════════════════════════════════════
    static _balanced(unit, config, target, targetDistSq, meleeRange, dirX, dirZ, tangentX, tangentZ, baseSpeed, nowTick, jumpImpulse) {
        let velX = 0, velZ = 0;

        const rangedRetaliate = unit.getDynamicProperty("dm:ranged_retaliate") === 1;
        const rangedRetaliateTick = unit.getDynamicProperty("dm:ranged_retaliate_tick") ?? 0;
        const isCharging = unit.getDynamicProperty("dm:melee_charging") === 1;
        // 超级冲刺触发（距离直检为主，标记为辅）：
        //   - distanceActive：目标距离 ≥ chargeRange 即可触发（不依赖被打/afterEvents）
        //   - retaliateActive：被远程打的标记（兼容旧逻辑，保留）
        //   - chargeCooldownOk：1秒间隔，防止冲刺失败后原地连冲死循环
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
            console.warn(`[DM-Melee] 触发远程反击冲刺! 当前距离=${distNow.toFixed(1)}在[${minChargeRange}, ${maxChargeRange === Infinity ? '∞' : maxChargeRange}]区间内 | 实体: ${unit.typeId}`);
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
                jumpImpulse = dy > 0.8 ? Math.min(0.35, Math.max(0.15, (dy / dist) * 0.4)) : 0.02;
                return { velX, velZ, jumpImpulse };
            }
        }

        // 防御：phase 只允许 1/2
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
        }
        else if (phase === 2) {
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

        return { velX, velZ, jumpImpulse };
    }

    // 清速（顺带清掉残留冲刺状态，防止下次进场莫名传送）
    static _clearVel(unit) {
        unit.setDynamicProperty("dm:cmd_vel_x", 0);
        unit.setDynamicProperty("dm:cmd_vel_z", 0);
        unit.setDynamicProperty("dm:cmd_vel_y", 0);
        unit.setDynamicProperty("dm:melee_charging", 0);
    }
    static _isClear(b) {
        return !b || b.isAir || b.isLiquid;
    }
    // 方块是否实心（可站立的固体）
    static _isSolidGround(b) {
        return !!b && !b.isAir && !b.isLiquid;
    }
    // (x,y,z) 整数坐标是否可作为站立点：身体/头部两格可通行 + 脚下实心
    static _isStandable(dim, x, y, z) {
        try {
            const body = dim.getBlock({ x, y, z });
            if (!MovementMelee._isClear(body)) return false;
            const head = dim.getBlock({ x, y: y + 1, z });
            if (!MovementMelee._isClear(head)) return false;
            const ground = dim.getBlock({ x, y: y - 1, z });
            return MovementMelee._isSolidGround(ground);
        } catch (_) { return false; }
    }
    // 以 base 为中心搜索安全落点：优先头顶正上方，再水平螺旋
    static _findSafeSpot(unit, base, hRange = 3, dyUp = 5, dyDown = 4) {
        try {
            const dim = unit.dimension;
            const bx = Math.floor(base.x), by = Math.floor(base.y), bz = Math.floor(base.z);
            for (let dy = 1; dy <= dyUp; dy++) {
                if (MovementMelee._isStandable(dim, bx, by + dy, bz)) {
                    return { x: bx + 0.5, y: by + dy, z: bz + 0.5 };
                }
            }
            for (let r = 1; r <= hRange; r++) {
                for (let dx = -r; dx <= r; dx++) {
                    for (let dz = -r; dz <= r; dz++) {
                        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                        for (let dy = dyDown; dy >= -dyDown; dy--) {
                            if (MovementMelee._isStandable(dim, bx + dx, by + dy, bz + dz)) {
                                return { x: bx + dx + 0.5, y: by + dy, z: bz + dz + 0.5 };
                            }
                        }
                    }
                }
            }
        } catch (_) { }
        return null;
    }
    // 安全传送：目标点安全→直接传；不安全→搜索附近安全点；都失败→不传（绝不进方块）
    static _safeTeleport(unit, desired, hRange = 3, dyUp = 5, dyDown = 4) {
        try {
            if (!unit?.isValid) return false;
            if (MovementMelee._isStandable(unit.dimension, Math.floor(desired.x), Math.floor(desired.y), Math.floor(desired.z))) {
                unit.teleport({ x: desired.x, y: desired.y, z: desired.z }, { checkForBlocks: true });
                return true;
            }
            const safe = MovementMelee._findSafeSpot(unit, desired, hRange, dyUp, dyDown);
            if (safe) {
                unit.teleport(safe, { checkForBlocks: true });
                return true;
            }
            return false;
        } catch (_) { return false; }
    }
    // 是否卡进方块（脚/腰/头三格中 ≥2 格实心 = 已被嵌入，必然窒息）
    static _isInsideWall(unit) {
        try {
            const l = unit.location;
            const dim = unit.dimension;
            const blocks = [
                dim.getBlock({ x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) }),
                dim.getBlock({ x: Math.floor(l.x), y: Math.floor(l.y + 1), z: Math.floor(l.z) }),
                dim.getBlock({ x: Math.floor(l.x), y: Math.floor(l.y + 2), z: Math.floor(l.z) })
            ];
            let solid = 0;
            for (const b of blocks) if (MovementMelee._isSolidGround(b)) solid++;
            return solid >= 2;
        } catch (_) { return false; }
    }

}

// ════════════════════════════════════════════════════════════
//  格挡：模块顶层注册（manager 的 initBlockMechanic() 为幂等兼容入口）
//  与 dm_support_system.js / player_attack_blocker.js 同款顶层写法
// ════════════════════════════════════════════════════════════
let _blockSubscriberRegistered = false;

function registerBlockSubscriber() {
    if (_blockSubscriberRegistered) return;
    _blockSubscriberRegistered = true;
    world.beforeEvents.entityHurt.subscribe((event) => {
        try {
            const victim = event.hurtEntity;
            if (!victim || !victim.isValid) return;
            const isDmUnit = victim.typeId?.startsWith("player:") && victim.typeId !== "minecraft:player";
            const hpInfo = isDmUnit ? MovementMelee._getHpInfo(victim) : null;
            // ── v2.26.1 真实受击账本：任何针对Dm单位的受击都登记 ──
            // 供 execute() 佐证"真实扣血"，区分：盾被击中消耗 vs 吸收池消失/刷新假波动
            if (isDmUnit && event.damage > 0) {
                const atk = event.damageSource?.damagingEntity;
                // v2.26.2 账本改为【窗口内累积】：5tick主循环内可能多次受击（高速攻击者/多怪齐射），
                //   若只记最后一次，护盾被多段伤害打穿时会被误判为"自然消失"→ 误拉栅栏 → 真实扣血被丢
                const existing = PendingHurtLedger.get(victim.id);
                if (existing && system.currentTick - existing.tick <= 6) {
                    existing.damage += event.damage;   // 累积窗口内总伤害
                    existing.tick = system.currentTick;
                    if (atk && atk.isValid && atk.id !== victim.id) existing.hasRealAttacker = true;
                } else {
                    PendingHurtLedger.set(victim.id, {
                        tick: system.currentTick,
                        damage: event.damage,
                        // 吸收池自然消失时补发的 entityHurt：无攻击者 或 攻击者==自身 → 视为假
                        hasRealAttacker: !!(atk && atk.isValid && atk.id !== victim.id),
                    });
                }
                // 顺手清理过期账本（只保留最近10tick），防内存增长
                for (const [id, rec] of PendingHurtLedger) {
                    if (system.currentTick - rec.tick > 10) PendingHurtLedger.delete(id);
                }
            }
            // 攻击模式喂数据：只认【有实体的攻击者】且【非假受伤】
            //   - 有实体（僵尸/Boss/蜘蛛）→ 记录节奏，供周期模型识别
            //   - 凋零/中毒/火焰等【无实体的DoT】→ 不喂，避免污染决斗识别
            //   - 吸收池消失/刷新补发的entityHurt（无攻击者/攻击者==自身）→ 不喂
            if (isDmUnit && event.damage > 0 && hpInfo) {
                const attacker = event.damageSource?.damagingEntity;
                const isFakeHurt = !attacker || !attacker.isValid || attacker.id === victim.id;
                if (!isFakeHurt) {
                    // 攻击者溯源：弹射物伤害归因给真正施法者（Boss）
                    // 修复：Boss近战AOE用"友方位置生成弹射物"实现时，
                    //      EWMA威胁参照/决斗识别/周期模型不被弹射物ID污染
                    const realAttacker = resolveRealAttacker(attacker, victim);
                    MovementMelee._updateMeleePattern(
                        realAttacker.id, victim.id, event.damage, system.currentTick, hpInfo.hp
                    );
                }
            }
            // —— 原格挡逻辑 ——
            const charges = victim.getDynamicProperty("dm:melee_block_charges") ?? 0;
            if (charges <= 0) return;
            // 格挡也受 tag 总阀门约束
            const isCombat = victim.hasTag("dm_has_target") || victim.hasTag("dm_skill_on");
            if (!isCombat) return;
            // 低伤门槛：凋零/中毒/火焰等低伤高频DoT【不消耗】格挡次数
            let minBlockDamage = Math.max((hpInfo ? hpInfo.hp : 20) * 0.05, 3);
            const cfgMin = victim.getDynamicProperty("dm:melee_block_min_damage");
            if (typeof cfgMin === "number" && cfgMin > 0) minBlockDamage = cfgMin;
            if (event.damage < minBlockDamage) return;
            const blockedDamage = event.damage;
            const remainingCharges = charges - 1;
            victim.setDynamicProperty("dm:melee_block_charges", remainingCharges);
            if (remainingCharges <= 0) {
                victim.setDynamicProperty("dm:melee_charges_zero_tick", system.currentTick);
            }
            event.cancel = true;
            event.damage = 0;
            try { victim.clearVelocity(); } catch (_) { }
            const vid = victim.id;
            system.run(() => {
                try {
                    const v = world.getEntity(vid);
                    if (v && v.isValid) {
                        console.warn(`[DM-Melee]  格挡成功! 挡下${blockedDamage.toFixed(1)}伤害 | 剩余次数: ${remainingCharges} | 实体: ${v.typeId}`);
                        let log = MeleeDamageLogCache.get(v.id);
                        if (!log) { log = []; MeleeDamageLogCache.set(v.id, log); }
                        log.push({ tick: system.currentTick, amount: 0.1 });
                        if (log.length > 30) {
                            MeleeDamageLogCache.set(v.id, log.filter(e => system.currentTick - e.tick < 150));
                        }
                        v.setDynamicProperty("dm:melee_strategy", "balanced");
                        v.setDynamicProperty("dm:melee_strategy_tick", system.currentTick);
                        v.setDynamicProperty("dm:melee_phase", 1);
                        v.setDynamicProperty("dm:melee_phase_tick", system.currentTick);
                        v.setDynamicProperty("dm:emergency_burst", 1);
                        v.setDynamicProperty("dm:block_retreat_tick", system.currentTick);
                        try { v.triggerEvent("dm:block_parry"); } catch (_) { }
                    }
                } catch (_) { }
            });
        } catch (_) { }
    });
    console.warn("[DM-Melee]  格挡已注册  (顶层注册, tag总阀门+统一周期+EWMA威胁+攻击者溯源)");
}

registerBlockSubscriber(); // 模块加载即注册！

// manager 的 DmTargetEngine.init() 会调用 initBlockMechanic() → 幂等，不会重复注册
MovementMelee.initBlockMechanic = function () {
    registerBlockSubscriber();
    console.warn("[DM-Melee] v2.26 初始化完成");
};