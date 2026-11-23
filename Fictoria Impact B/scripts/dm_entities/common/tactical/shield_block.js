/*
 * shield_block.js — 通用盾牌格挡模块（任何实体都能用，不绑定 dm34）。
 * 基岩版 `minecraft:equippable` 只有玩家有 → 生物举盾引擎不认，盾只是挂在副手的普通物品，
 * 所以格挡必须自己算：举不举盾由各实体自己决定，本模块管「挡不挡得住」「举多久放下」「冷却
 * 多久」「挨打时攻击者被击退多少」。挡不挡得住 = 锥形判定 + beforeEvents.entityHurt 里 cancel；
 * 贴身（自身所在格 / 1 格内）不分朝向一律挡下，否则爆炸溅射会随机漏；凋零 / 中毒这类无攻击者
 * 的持续伤害只要举着盾就静默挡掉。
 * 用法：registerShieldBlocker({ id, forEachEntity, accepts, hasShield, shouldBlock, setPose,
 * isHostile, onTick?, onBlocked?, 数值 }) → { isBlocking, lower, hitsOf, stateOf }。数值都有默认值
 * （见 DEFAULT），`holdTicksOf(e)` 返回 0 = 该实体永不因时长放下。
 * 刻意的做法：状态存内存 Map、不写实体属性，cd 存剩余 tick 而非绝对 tick（重进世界不会恒真）；
 * 计数与 cancel 都在 beforeEvents.entityHurt（分到 after 计数会让被 cancel 的箭白挡）；放下判据
 * 是时间窗口不是次数（首次挡下起倒数 holdTicks，此后挨多少下都不续命）；冷却自己算，不用
 * attack_cooldown（那个组件会连带改动攻击节奏）；挡下箭矢把箭弹回（反折 + 减速 + 略上挑，能
 * 反伤射手），弹回的箭打 tag，再撞同一面盾直接吞掉。
 */

import { system, world } from "@minecraft/server";
import { registerBeforeHurtHandler, registerEntityRemoveHandler } from "../core/event_bus.js";

/*
 * 能触发格挡的伤害来源（参考包白名单 + 基岩版实际会遇到的几种）。
 * `sonicBoom` 是监守者（Warden）的远程音波：独立 damageCause，既不是 `entityAttack` 也不是
 * `projectile`，参考包白名单里没有 → 整条绕过盾、连锥形判定都进不去。它有攻击者
 * （`damagingEntity` = 守者本体），能正常做正面判定，直接并进来即可。
 * 想再放宽可以自己加 `ramAttack`（山羊冲撞）等。
 */
const DEFAULT_HIT_CAUSES = ["entityAttack", "projectile", "entityExplosion", "blockExplosion", "sonicBoom"];

/** 无方向、无攻击者的持续伤害（buff / 药水类）：举着盾就挡，静默处理。
 *  这些是「每 N tick 扣一点」的高频伤害，举盾期间挡不住就会一直掉血。
 *  想扩大就自己往 ambientCauses 里加：campfire / fireTick / lava / contact / freezing / suffocation。
 *  注意 `magic` 也包含瞬间伤害药水与毒 —— 只想挡凋零就把它删掉，只留 wither。 */
const DEFAULT_AMBIENT_CAUSES = ["wither", "magic"];

/** 会被击退的伤害来源。原版只有近战挡下时推攻击者，箭矢挡下不推射手 */
const DEFAULT_KNOCKBACK_CAUSES = ["entityAttack"];

const DEFAULT = {
    pollTicks: 5,
        /*
     * 正面锥形：水平 / 垂直半角（度）。
     * 垂直方向默认关闭（90），只判水平朝向。判定坐标是实体 `location`（脚底）而非命中点 ——
     * 怪物比她高 2~3 格时（监守者 / 铁傀儡 / 骑乘单位），斜上方来的攻击垂直夹角远超 30°，会被
     * 判成「不在正面」直接漏挡；而真正正上方（horiz ≈ 0）又被下面那道放行分支无条件通过，等于
     * 这条限制只在「斜上方」制造盲区。想恢复严格判定就调回 30（< 89.9 即启用）。
     */
    yawDeg: 70,
    pitchDeg: 90,
    /** 贴身距离（格）：这个范围内不分朝向一律算正面挡下。
     *  爆炸 / 溅射的伤害源坐标几乎和她重合，此时她的 yaw 没有意义，
     *  按锥形判会随机失败 —— 所以「自身所在格」必须无条件覆盖。 */
    pointBlank: 1.0,
    /** 无方向、无攻击者的持续伤害（凋零 / 中毒等 buff），举盾即挡 */
    ambientCauses: DEFAULT_AMBIENT_CAUSES,
    /** 从**首次挡下**开始，连续举盾最多多少 tick，到点放下并进冷却。
     *  期间再挨打不会重置（否则一直挨打就永远不放）；没被攻击过就一直举着。
     *  <= 0 = 永不因时长放下 */
    holdTicks: 50,
    /** 放下后冷却多少 tick。50 = 2.5 秒 */
    cooldownTicks: 50,
    /** 挡下时推攻击者的力度（原版盾挡 ≈ 水平 0.5 + 一点上挑） */
    knockbackHorizontal: 0.5,
    knockbackVertical: 0.2,
    knockbackProjectiles: false,
    /** 挡下箭矢时把箭**弹回去**（原版行为：沿来路反折、减速、略上挑，能反伤射手） */
    deflectProjectiles: true,
    /** 弹回的力度 = 原速度 * damp，再抬 lift */
    deflectDamp: 0.6,
    deflectLift: 0.15,
    sound: "item.shield.block",
    volume: 1,
    pitch: 1,
    /** 受击处理器优先级：默认排在近战格挡（100）之前，盾挡下的那一下不再扣后撤次数 */
    hurtPriority: 200,
    removePriority: 260,
    debug: null,
};

/** entityId → { cfg, on, hits, hold, cd, data }
 *  hold / cd 都是**剩余 tick**，不是绝对 tick（退游戏回来不会恒真）。
 *  data 是给调用方放私货的（比如「刚装盾的宽限期」），本模块不碰 */
const STATES = new Map();

function stateOfCfg(cfg, entity) {
    const id = entity.id;
    let st = STATES.get(id);
    if (!st || st.cfg !== cfg) {
        st = { cfg, on: false, hits: 0, hold: 0, cd: 0, data: {} };
        STATES.set(id, st);
    }
    return st;
}

function logOf(cfg, msg) {
    if (typeof cfg.debug !== "function") return;
    try { cfg.debug(msg); } catch (e) { /* 忽略 */ }
}

// ── 姿势 ────────────────────────────────────────────────────

function setBlocking(cfg, entity, on, reason) {
    const st = stateOfCfg(cfg, entity);
    const changed = st.on !== on;
    st.on = on;
    st.hits = 0;                      // 每一段举盾单独计数（只用于日志/回调）
    st.hold = 0;                      // 0 = 计时未开始 → 只要没挨打就一直举着
    if (changed) {
        try { cfg.setPose(entity, on, st); } catch (e) { logOf(cfg, `setPose 失败：${e}`); }
        try { if (cfg.onChanged) cfg.onChanged(entity, on, reason); } catch (e) { /* 忽略 */ }
        logOf(cfg, `${on ? "抬盾" : "收盾"}(${reason || ""}) | ${entity.typeId}`);
    }
    return changed;
}

// ── 受击判定 ────────────────────────────────────────────────

/** 目标是否在 source 的正前方锥形里（水平 yaw / 垂直 pitch 分开判）。
 *  贴身例外：同一方块格、或水平 distance < pointBlank 且高差 <= 1.5 时不分朝向。
 *  没有这个例外，爆炸/溅射（伤害源几乎和她重叠、yaw 无意义）会随机漏挡。 */
export function isInFront(source, target, yawDeg, pitchDeg, pointBlank) {
    let sp;
    let tp;
    try {
        sp = source.location;
        tp = target.location;
    } catch (e) {
        return false;
    }
    return isPointInFront(source, sp, tp, yawDeg, pitchDeg, pointBlank === undefined ? 1.0 : pointBlank);
}

/** 同上，但直接给一个坐标点（方块爆炸只有方块坐标，没有实体） */
export function isPointInFront(source, sp, tp, yawDeg, pitchDeg, pointBlank) {
    const dx = tp.x - sp.x;
    const dy = tp.y - sp.y;
    const dz = tp.z - sp.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);

    // ① 自身所在格 / 贴脸：她没转身的余地，一律算正面挡下
    if (Math.abs(dy) <= 1.5) {
        if (horiz < (pointBlank === undefined ? 1.0 : pointBlank)) return true;
        if (Math.floor(sp.x) === Math.floor(tp.x) && Math.floor(sp.z) === Math.floor(tp.z)) return true;
    }
    if (horiz < 1e-6) return true;

    let rot;
    try {
        rot = source.getRotation();
    } catch (e) {
        return false;
    }

    // MC 的 yaw：0 = +Z，顺时针为正 → atan2(-dx, dz)
    let dyaw = (Math.atan2(-dx, dz) * 180 / Math.PI) - rot.y;
    dyaw = ((dyaw % 360) + 360) % 360;
    if (dyaw > 180) dyaw -= 360;

    if (Math.abs(dyaw) > yawDeg) return false;

    // 垂直方向默认不判（pitchDeg = 90）：攻击源坐标是脚底，怪高一点垂直夹角就爆掉，
    // 而正上方已被上面的 horiz≈0 / 贴身分支无条件放行，这条限制只剩副作用。
    if (!(pitchDeg < 89.9)) return true;

    // MC 的 pitch：低头为正 → 目标在上方时 dy > 0，要取负号才对得上 rot.x
    const dpitch = (Math.atan2(-dy, horiz) * 180 / Math.PI) - rot.x;

    return Math.abs(dpitch) <= pitchDeg;
}

/** 方块中心（爆炸源方块用）。老版本没有 center() 就退化成 location + 0.5 */
function blockCenter(block) {
    try {
        const c = block.center();
        if (c) return c;
    } catch (e) { /* 忽略 */ }
    try {
        const l = block.location;
        return { x: l.x + 0.5, y: l.y + 0.5, z: l.z + 0.5 };
    } catch (e) {
        return undefined;
    }
}

/** 把攻击者沿「盾牌 → 攻击者」方向推开 */
function knockBack(attacker, origin, horizontal, vertical) {
    const dx = attacker.location.x - origin.x;
    const dz = attacker.location.z - origin.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    attacker.applyKnockback({ x: (dx / len) * horizontal, z: (dz / len) * horizontal }, vertical);
}

/** 被弹回去的抛射物打上这枚 tag：它再撞上同一面盾时直接吞掉，
 *  不计数、不再弹、不推人 —— 否则箭停在身体里会连挡十下，盾直接被打脱手 */
const REFLECT_TAG = "shield_block_reflected";

function tagOf(entity, tag) {
    try { return !!entity.hasTag(tag); } catch (e) { return false; }
}

/** 这次 projectile 伤害到底是哪一支箭/投掷物。
 *  优先用事件自带的 `damagingProjectile`；拿不到（老版本/异常）就退化找「她身边 3 格内最近的抛射物」 */
function resolveProjectile(src, victim) {
    try {
        const p = src.damagingProjectile;
        if (p && p.isValid) return p;
    } catch (e) { /* 该版本没有这个字段 */ }

    try {
        const list = victim.dimension.getEntities({ location: victim.location, maxDistance: 3 });
        const p0 = victim.location;
        let best;
        let bestSq = Infinity;
        for (const e of list) {
            if (!e || !e.isValid) continue;
            try {
                if (!e.getComponent("minecraft:projectile")) continue;
            } catch (err) {
                continue;
            }
            const l = e.location;
            const dsq = (l.x - p0.x) ** 2 + (l.y - p0.y) ** 2 + (l.z - p0.z) ** 2;
            if (dsq < bestSq) {
                bestSq = dsq;
                best = e;
            }
        }
        return best;
    } catch (e) {
        return undefined;
    }
}

/** 把箭沿来路弹回：速度反折 + 减速 + 略上挑。
 *  原版挡箭就是这个观感（反折约一半速度、轻微上抬），且弹回去的箭能反伤射手。 */
function deflectProjectile(proj, cfg) {
    try {
        if (tagOf(proj, REFLECT_TAG)) return false;
        proj.addTag(REFLECT_TAG);

        let vx = 0;
        let vy = 0;
        let vz = 0;
        try {
            const v = proj.getVelocity();
            vx = v.x;
            vy = v.y;
            vz = v.z;
        } catch (e) { /* 读不到速度就只给个上挑，至少不会原地不动 */ }

        const damp = cfg.deflectDamp;
        const vel = { x: -vx * damp, y: -vy * damp * 0.5 + cfg.deflectLift, z: -vz * damp };

        const pc = proj.getComponent("minecraft:projectile");
        if (pc && typeof pc.shoot === "function") {
            pc.shoot(vel);
            return true;
        }
        // 没有 projectile 组件的模组投掷物：退化成冲量
        try { proj.clearVelocity(); } catch (e) { /* 忽略 */ }
        proj.applyImpulse(vel);
        return true;
    } catch (e) {
        logOf(cfg, `弹箭失败：${e}`);
        return false;
    }
}

/** 诊断：这一下为什么没挡住。只在 debug 打开时用，每只实体 40t 最多一条
 *  （围殴时否则会刷满）。**不改任何行为**，纯观察。 */
const MISS_LOG = new Map();          // entityId → 上次打印的 currentTick

function logMiss(cfg, victim, event, why) {
    try {
        const t = system.currentTick;
        const last = MISS_LOG.get(victim.id);
        if (last !== undefined && t - last < 40) return;
        if (MISS_LOG.size > 128) MISS_LOG.clear();
        MISS_LOG.set(victim.id, t);

        let cause = "?";
        let who = "无";
        let dmg = "?";
        try { cause = String(event.damageSource?.cause ?? "?"); } catch (e) { /* 忽略 */ }
        try {
            const de = event.damageSource?.damagingEntity;
            who = de ? String(de.typeId) : "无";
        } catch (e) { /* 忽略 */ }
        try { dmg = String(event.damage); } catch (e) { /* 忽略 */ }
        logOf(cfg, `未格挡（${why}）：${cause}｜来源 ${who}｜伤害 ${dmg}`);
    } catch (e) { /* 忽略 */ }
}

function makeHurtHandler(cfg) {
    return (event) => {
        try {
            const victim = event.hurtEntity;
            if (!victim || !victim.isValid) return;

            const st = STATES.get(victim.id);
            const mine = !!st && st.cfg === cfg;

            if (!mine || !st.on) {                            // 没举盾 → 不挡
                // debug 下把"该挡却没举盾"的情形打出来：这类案子最后八成是
                // 盾不在副手（被收进背包 / 记录与实物不一致），不是格挡逻辑的问题。
                if (typeof cfg.debug === "function") {
                    let isMine = mine;
                    if (!isMine) {
                        try { isMine = !!(cfg.accepts && cfg.accepts(victim)); } catch (e) { /* 忽略 */ }
                    }
                    if (isMine) logMiss(cfg, victim, event, "盾没举");
                }
                return;
            }

            const src = event.damageSource;
            if (!src) return;
            const cause = src.cause;          // 事件对象出栈后不一定还能读，先抄出来
            if (!cfg.causeSet.has(cause)) {
                // 举着盾却吃了白名单外的伤害 —— 这就是"某种攻击怎么都挡不住"的现场。
                // 只在 debug 打开时记一行，顺手带上伤害源类型，省得再猜。
                if (typeof cfg.debug === "function") {
                    let who = "无";
                    try { who = src.damagingEntity ? String(src.damagingEntity.typeId) : "无"; } catch (e) { /* 忽略 */ }
                    logOf(cfg, `举盾中，但该伤害不在格挡白名单：${cause}（来源 ${who}）`);
                }
                return;
            }

            // ① 无方向、无攻击者的持续伤害（凋零 / 中毒 / 魔法）：举着盾就静默挡掉。
            //    不计数、不播音效、不进 hold 计时 —— 站在凋零区时每 2 秒响一次格挡音太吵，
            //    而且那也不是"挡下一击"，不该推进放下倒计时。
            if (cfg.ambientSet.has(cause)) {
                event.cancel = true;
                event.damage = 0;
                return;
            }

            // ② 抛射物：先认出这支箭 / 投掷物
            let proj;
            if (cause === "projectile") proj = resolveProjectile(src, victim);

            // 「谁打的」：近战就是 damagingEntity；抛射物在部分版本里给的是箭本身，
            // 那就换成射手（projectile.owner）。换不出来时用箭的位置做锥形判定、跳过阵营检查
            // —— 箭都贴脸了，宁可挡住也别让它穿过去。
            let attacker = src.damagingEntity;
            if (proj && attacker && attacker.id === proj.id) {
                let owner;
                try { owner = proj.getComponent("minecraft:projectile")?.owner; } catch (e) { /* 忽略 */ }
                attacker = owner && owner.isValid ? owner : undefined;
            }

            // ③ 判定用的坐标点：有实体用实体；方块爆炸（床 / 重生锚）只有方块，用方块中心
            let aimPoint;
            const aim = attacker || proj;
            if (aim && aim.isValid) {
                if (aim.id === victim.id) return;
                // 爆炸不看阵营：TNT / 苦力怕不认敌我，自己人的炸药也得举盾挡
                const isBlast = cause === "entityExplosion" || cause === "blockExplosion";
                if (!isBlast && attacker && cfg.isHostile && !cfg.isHostile(victim, attacker)) {
                    if (typeof cfg.debug === "function") logMiss(cfg, victim, event, "攻击者不算敌人");
                    return;
                }
                try { aimPoint = aim.location; } catch (e) { return; }
            } else {
                // 无攻击实体、无伤害方块：
                //   · cause = entityAttack → 某些引擎内部近战（**监守者的 melee_box_attack**、
                //     部分模组的范围盒攻击）只给 cause、不给 attacking entity。这种伤害必然
                //     贴身发生，方向判定没有意义 —— 按"举盾即挡"处理，别让它整条漏过去。
                //   · 其余无方向伤害 → 依旧不挡，不在这里凭空免伤。
                if (!src.damagingBlock && cause === "entityAttack") {
                    aimPoint = victim.location;
                    if (typeof cfg.debug === "function") logOf(cfg, `${cause} 没有攻击实体，按贴身处理（举盾即挡）`);
                } else if (!src.damagingBlock) {     // 既无实体也无方块 → 无方向可判，不挡
                    if (typeof cfg.debug === "function") logOf(cfg, `举盾中，但伤害源既无实体也无方块：${cause}（无法判定朝向）`);
                    return;
                } else {
                    aimPoint = blockCenter(src.damagingBlock);
                    if (!aimPoint) return;
                }
            }

            // 背面受击：不算格挡成功、不计数、不放下（参考包同）。
            // 贴身 / 自身所在格由 isPointInFront 无条件放行，溅射不会漏。
            if (!isPointInFront(victim, victim.location, aimPoint, cfg.yawDeg, cfg.pitchDeg, cfg.pointBlank)) {
                if (typeof cfg.debug === "function") logMiss(cfg, victim, event, "不在正面");
                return;
            }

            // 已被弹回的那支再撞上来 → 直接吞掉，不计数、不再弹、不推人
            // （否则箭卡在身体里会连挡十下，盾直接被打脱手）
            if (proj && tagOf(proj, REFLECT_TAG)) {
                event.cancel = true;
                event.damage = 0;
                return;
            }

            // 挡下
            event.cancel = true;
            event.damage = 0;

            st.hits += 1;
            // 首次挡下才开始计时；倒数中再挨打不重置（否则被围殴就永远不放盾）。
            // holdTicksOf 允许调用方按实体覆盖（0 = 纯防御模式，永不因时长放下）
            let holdTicks = cfg.holdTicks;
            if (typeof cfg.holdTicksOf === "function") {
                try {
                    const v = cfg.holdTicksOf(victim);
                    if (typeof v === "number") holdTicks = v;
                } catch (e) { /* 忽略，退回静态值 */ }
            }
            if (holdTicks > 0 && st.hold <= 0) {
                st.hold = holdTicks;
            }
            const hits = st.hits;
            const hold = st.hold;

            const vid = victim.id;
            const aid = attacker ? attacker.id : undefined;
            const loc = victim.location;
            const dim = victim.dimension;
            const projId = proj ? proj.id : undefined;
            const doDeflect = !!cfg.deflectProjectiles && projId !== undefined;
            const doKnock = cfg.knockSet.has(cause)
                || (cfg.knockbackProjectiles && cause === "projectile");

            // before 事件是只读上下文：音效 / 动画 / 击退一律推到下一 tick
            system.run(() => {
                const v = world.getEntity(vid);
                if (!v || !v.isValid) return;

                try { dim.playSound(cfg.sound, loc, { volume: cfg.volume, pitch: cfg.pitch }); } catch (e) { /* 忽略 */ }

                // 箭：沿来路弹回去（原版观感，能反伤射手）
                if (doDeflect) {
                    try {
                        const p = world.getEntity(projId);
                        if (p && p.isValid) deflectProjectile(p, cfg);
                    } catch (e) { /* 忽略 */ }
                }

                if (doKnock && aid !== undefined) {
                    try {
                        const a = world.getEntity(aid);
                        if (a && a.isValid) knockBack(a, loc, cfg.knockbackHorizontal, cfg.knockbackVertical);
                    } catch (e) { /* 忽略 */ }
                }

                try {
                    if (cfg.onBlocked) cfg.onBlocked(v, { cause, hits, hold, attackerId: aid, deflected: doDeflect });
                } catch (e) { /* 忽略 */ }

                logOf(cfg, `挡下 ${cause}（本段第 ${hits} 下，举盾剩 ${hold > 0 ? hold : "∞"}t）`);
            });
        } catch (e) {
            logOf(cfg, `受击结算抛错：${e}`);
        }
    };
}

// ── 巡检 ────────────────────────────────────────────────────

function updateOne(cfg, entity) {
    const st = STATES.get(entity.id);

    let has = false;
    try { has = !!cfg.hasShield(entity); } catch (e) { has = !!(st && st.on); }

    if (!has) {
        if (st && st.on) setBlocking(cfg, entity, false, "no-shield");
        if (st) STATES.delete(entity.id);
        return;
    }

    // 调用方的杂务（丢件自愈等）。返回 false = 「盾已经不算数了，立刻收」
    if (cfg.onTick) {
        let alive = true;
        try { alive = cfg.onTick(entity) !== false; } catch (e) { logOf(cfg, `onTick 抛错：${e}`); }
        if (!alive) {
            if (st && st.on) setBlocking(cfg, entity, false, "onTick");
            return;
        }
    }

    if (st && st.cd > 0) {
        st.cd -= cfg.pollTicks;
        if (st.cd < 0) st.cd = 0;
        if (st.on) setBlocking(cfg, entity, false, "cooldown");
        return;
    }

    // 举盾时长窗口：首次挡下起倒数，到点放下并进冷却。
    // hold = 0 表示还没挨过打 → 一直举着，敌人不攻击就不放。
    if (st && st.on && st.hold > 0) {
        st.hold -= cfg.pollTicks;
        if (st.hold <= 0) {
            setBlocking(cfg, entity, false, "hold-timeout");
            st.cd = cfg.cooldownTicks;
            logOf(cfg, `举盾 ${cfg.holdTicks}t 到点 → 放下，冷却 ${cfg.cooldownTicks}t`);
            return;
        }
    }

    let want = false;
    try { want = !!cfg.shouldBlock(entity); } catch (e) { logOf(cfg, `shouldBlock 抛错：${e}`); return; }

    if (want === !!(st && st.on)) return;
    setBlocking(cfg, entity, want, want ? "trigger" : "idle");
}

// ── 注册 ────────────────────────────────────────────────────

/*
 * 登记一个「盾牌持有者」。触发时机与条件完全由 cfg.shouldBlock 决定。
 * @param {object} cfg 见文件头的用法示例｜@returns 操作句柄
 */
export function registerShieldBlocker(cfg) {
    if (!cfg || !cfg.id) throw new Error("registerShieldBlocker: 缺少 id");
    if (typeof cfg.forEachEntity !== "function") throw new Error("registerShieldBlocker: 缺少 forEachEntity");
    if (typeof cfg.hasShield !== "function") throw new Error("registerShieldBlocker: 缺少 hasShield");
    if (typeof cfg.shouldBlock !== "function") throw new Error("registerShieldBlocker: 缺少 shouldBlock");
    if (typeof cfg.setPose !== "function") throw new Error("registerShieldBlocker: 缺少 setPose");

    const c = Object.assign({}, DEFAULT, cfg);
    const ambient = Array.isArray(c.ambientCauses) ? c.ambientCauses : DEFAULT_AMBIENT_CAUSES;
    c.ambientSet = new Set(ambient);
    // 环境伤害必须并进 causeSet，否则上面那道白名单会先把它挡掉
    c.causeSet = new Set([...(cfg.hitCauses || DEFAULT_HIT_CAUSES), ...ambient]);
    c.knockSet = new Set(cfg.knockbackCauses || DEFAULT_KNOCKBACK_CAUSES);

    // 受击：每个持有者一份处理器（优先级可各自指定）
    try {
        registerBeforeHurtHandler(`${c.id}_block`, makeHurtHandler(c), c.hurtPriority);
    } catch (e) {
        console.warn(`[shield_block/${c.id}] 注册受击处理器失败：${e}`);
    }

    // 实体移除：清状态表，防止 entityId 复用
    try {
        registerEntityRemoveHandler(`${c.id}_cache`, (event) => {
            try {
                const id = event.removedEntity?.id;
                if (!id) return;
                const st = STATES.get(id);
                if (st && st.cfg === c) STATES.delete(id);
            } catch (e) { /* 忽略 */ }
        }, c.removePriority);
    } catch (e) { /* 忽略 */ }

    // 巡检：决定抬不抬盾
    try {
        system.runInterval(() => {
            try {
                c.forEachEntity((entity) => {
                    try {
                        if (!entity || !entity.isValid) return;
                        if (c.accepts && !c.accepts(entity)) return;
                        updateOne(c, entity);
                    } catch (e) { /* 单只异常不影响其他 */ }
                });
            } catch (e) { /* 忽略 */ }
        }, c.pollTicks);
    } catch (e) {
        console.warn(`[shield_block/${c.id}] 巡检挂不上：${e}`);
    }

    logOf(c, "已登记");

    return {
        id: c.id,
        isBlocking: (entity) => {
            const st = STATES.get(entity.id);
            return !!(st && st.cfg === c && st.on);
        },
        hitsOf: (entity) => {
            const st = STATES.get(entity.id);
            return st && st.cfg === c ? st.hits : 0;
        },
        cooldownOf: (entity) => {
            const st = STATES.get(entity.id);
            return st && st.cfg === c ? st.cd : 0;
        },
        /** 这一段举盾还剩多少 tick（0 = 还没挨过打，或者根本没举） */
        holdOf: (entity) => {
            const st = STATES.get(entity.id);
            return st && st.cfg === c ? st.hold : 0;
        },
        /** 调用方私货（比如装盾宽限期）。会创建状态。 */
        stateOf: (entity) => stateOfCfg(c, entity),
        /** 立刻举 / 放盾（绕开 shouldBlock，用于脚本强制） */
        setBlocking: (entity, on, reason) => setBlocking(c, entity, on, reason || "manual"),
        /** 收盾（等价 setBlocking(entity, false)） */
        lower: (entity, reason) => setBlocking(c, entity, false, reason || "manual"),
        /** 丢弃状态（卸盾、回收残留时用） */
        forget: (entity) => {
            const st = STATES.get(entity.id);
            if (st && st.cfg === c) STATES.delete(entity.id);
        },
        config: c,
    };
}
