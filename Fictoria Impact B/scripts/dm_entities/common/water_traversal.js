// water_traversal.js — 水体通行。

// 1. 液体检测 / 分档减速 / 水中浮潜冲量
// 2. 溺水换气：受溺水伤害后交出控制，交给 behavior.float 上浮

// 近战与远程原来各有一份逐行同源的实现，已经漂移过（远程多乘一次，浮游只剩 4% 速度）。
// 收敛到这里，调水中手感只改一处。

// 约定：① 减速用 applyLiquidSpeed() 的返回值，不要写 *=；
//      ② resolveFloatImpulse 接已算好的 dy（不是坐标）；
//      ③ detectLiquid 的 out 每帧每单位新建，不要跨 tick 复用。

import { system, EntityDamageCause } from "@minecraft/server";
import {
    registerAfterHurtHandler,
    registerEntityRemoveHandler,
    AFTER_HURT_PRIORITY,
    REMOVE_PRIORITY
} from "./event_bus.js";

// 液体减速档位

//   浮游（漂在水中、脚不着地） = 正常速度 20%
//   涉水（站在水底 / 浅水行走） = 正常速度 60%
export const LIQUID_SPEED_FLOATING = 0.20;
export const LIQUID_SPEED_WADING = 0.60;

// 水中纵向冲量（jumpImpulse 通道）

//   ASCEND          上浮上限（追高处目标）
//   DESCEND         下潜下限（追深处目标）
//   SINK_AT_SURFACE 已在水面 → 压回水里，避免拍水
export const WATER_Y_ASCEND = 0.18;
export const WATER_Y_DESCEND = -0.20;
export const WATER_Y_SINK_AT_SURFACE = -0.08;

// 水下深度控制（比例控制）。旧的三档开关会和 behavior.float 打架，表现为上下颠簸；
// 连续输出在逼近目标时自然收敛。偏置 -0.06 抵消浮力，让干员稳定悬停。
export const WATER_DEPTH_GAIN = 0.22;
export const WATER_DEPTH_BIAS = -0.06;

// 水面探测的高度偏移：
// 实体脚部 y + 1.6 落在空气方块 → 视为已浮出水面
const SURFACE_PROBE_OFFSET = 1.6;

// 溺水换气：受 drowning 伤害后清空走位指令，由 behavior.float 上浮。
// 解除条件（按序）：完全出水 / 头部出水维持 SURFACE_HOLD_TICKS / 兜底超时。
// 不用固定时长：深处 20 格 4 秒浮不上来，放行后会反复溺水抽搐。

// 头部出水后需要维持的时长（tick）。
// 取 80（4 秒）略大于 breathable.inhaleTime 的 3.75 秒，保证放行时氧气已回满。
export const SURFACE_HOLD_TICKS = 80;

// 兜底上限：单次溺水最长失控时长（tick）。30 秒。
export const DROWNING_MAX_TICKS = 600;

// 溺水诊断日志（排查"为什么突然不动了"时打开）
const DEBUG_DROWNING = false;

// entityId -> { startTick, surfaceSince }

// startTick    ：首次触发时刻，用于兜底超时，**不因重复受伤刷新**
// surfaceSince ：头部开始持续出水的 tick，0 表示当前未出水

// 不用 WeakMap：以 id 为键，实体卸载后仍能靠 gc 清掉。
const DrowningRecovery = new Map();

// 取伤害枚举。若运行时缺少 drowning 成员，回退到字符串字面量
// （基岩版 EntityDamageCause 的值就是同名字符串）。
const DROWNING_CAUSE = EntityDamageCause?.drowning ?? "drowning";

// 液体检测：脚、腰两层任一为液体即算在水里（只探一层会漏判浅水）。
// out：传当次新建的空对象，回执 floorY 与腰格方块，供水面探针复用省一次 getBlock。
// 查询失败时字段留空，复用判断落空 → 退化成现查。
export function detectLiquid(dimension, location, out) {
    if (out) {
        out.floorY = NaN;
        out.waist = undefined;
    }

    if (!dimension || !location) return false;

    try {
        const floorY = Math.floor(location.y);

        const feet = dimension.getBlock({
            x: location.x,
            y: floorY,
            z: location.z
        });

        const waist = dimension.getBlock({
            x: location.x,
            y: floorY + 1,
            z: location.z
        });

        if (out) {
            out.floorY = floorY;
            out.waist = waist;
        }

        return !!((feet && feet.isLiquid) || (waist && waist.isLiquid));
    } catch (_) {
        // 未加载区块 / 无效坐标
        return false;
    }
}

// 分档减速

// ⚠ 必须用返回值，不要写成 speed *= applyLiquidSpeed(...)。
//   这里的语义是「结算一次」，不是「叠一层」。
export function applyLiquidSpeed(baseSpeed, inLiquid, isFloating) {
    if (!inLiquid) return baseSpeed;

    return baseSpeed * (isFloating ? LIQUID_SPEED_FLOATING : LIQUID_SPEED_WADING);
}

// 水面探测：y + 1.6 约等于眼位，是空气说明头顶已出水。
// known 命中条件是 fract(y) < 0.4（落在腰格），否则现查一次；known 为空时行为同旧版。
export function isAtWaterSurface(dimension, location, known) {
    if (!dimension || !location) return false;

    try {
        const probeY = Math.floor(location.y + SURFACE_PROBE_OFFSET);

        if (known && probeY === known.floorY + 1) {
            // undefined = 那次没查成，落到下面现查；null/方块对象都是有效结果
            if (known.waist !== undefined) {
                return !!(known.waist && known.waist.isAir);
            }
        }

        const block = dimension.getBlock({
            x: location.x,
            y: probeY,
            z: location.z
        });

        return !!(block && block.isAir);
    } catch (_) {
        return false;
    }
}

// 水中浮潜冲量（比例控制）：dy = 目标 y − 自身 y。
// 已在水面 -0.08 压回；下方越负压得越狠（最低 -0.20）；上方浮得更快（最高 +0.18）；
// 同深度 -0.06 抵消浮力。
export function resolveFloatImpulse(dimension, location, dy, known) {
    if (isAtWaterSurface(dimension, location, known)) {
        return WATER_Y_SINK_AT_SURFACE;
    }

    // 目标坐标异常时（NaN）退化为轻微下压，避免把 NaN 喂进 applyImpulse
    if (!Number.isFinite(dy)) {
        return WATER_DEPTH_BIAS;
    }

    const raw = dy * WATER_DEPTH_GAIN + WATER_DEPTH_BIAS;

    if (raw > WATER_Y_ASCEND) return WATER_Y_ASCEND;
    if (raw < WATER_Y_DESCEND) return WATER_Y_DESCEND;

    return raw;
}

// 溺水状态表

// 用 entityId 做键（同 typeId 可能多实例）。
// 惰性删除：查询时发现该放行就顺手清掉，不依赖定时器。

/** 标记某实体进入溺水换气恢复期 */
export function markDrowning(entityId, nowTick) {
    if (entityId === undefined || entityId === null) return;

    const tick = typeof nowTick === "number" ? nowTick : system.currentTick;

    const st = DrowningRecovery.get(entityId);

    if (st) {
        // 重复受伤：只更新诊断信息，不动 startTick 与 surfaceSince。

        // startTick 不刷新 → 兜底 30 秒从第一次溺水算起，
        //   否则持续受溺水伤害时兜底永远不到期。
        // surfaceSince 不刷新 → 否则换气途中挨一次伤害就前功尽弃。
        return;
    }

    DrowningRecovery.set(entityId, {
        startTick: tick,
        surfaceSince: 0
    });
}

/*
 * 是否仍处于「求气中」（= 该继续压制 JS 控制）。
 * @param {object|number} entity 传 id 时只按兜底超时判定，不做位置检查
 * @returns {boolean} true = 仍在求气，调用方必须交出控制权
 */
export function isDrowningRecovering(entity, nowTick) {
    const isObj = !!entity && typeof entity === "object";
    const id = isObj ? entity.id : entity;

    if (id === undefined || id === null) return false;

    const st = DrowningRecovery.get(id);

    if (st === undefined) return false;

    const tick = typeof nowTick === "number" ? nowTick : system.currentTick;

    // ── 3. 兜底超时（最先判，保证任何情况下都能终止）──
    if (tick - st.startTick >= DROWNING_MAX_TICKS) {
        DrowningRecovery.delete(id);
        return false;
    }

    // 只给了 id：没有位置信息，只能按兜底超时走
    if (!isObj) return true;

    // ── 1. 完全出水 ──
    // 严格比较 === false。属性不存在时得到 undefined，
    // 不能当作「出水」，否则这里会静默放行所有单位。
    let fullyOut = false;

    try {
        fullyOut = entity.isInWater === false;
    } catch (_) {}

    if (fullyOut) {
        DrowningRecovery.delete(id);
        return false;
    }

    // ── 2. 头部出水并维持足够久 ──
    let headOut = false;

    try {
        headOut = isAtWaterSurface(entity.dimension, entity.location);
    } catch (_) {}

    if (!headOut) {
        // 又沉下去了：计时清零，下次露头重新开始
        st.surfaceSince = 0;
        return true;
    }

    if (st.surfaceSince === 0) {
        st.surfaceSince = tick;

        if (DEBUG_DROWNING) {
            console.warn(`[Water] 开始回氧计时: #${id}`);
        }

        return true;
    }

    if (tick - st.surfaceSince >= SURFACE_HOLD_TICKS) {
        DrowningRecovery.delete(id);

        if (DEBUG_DROWNING) {
            console.warn(`[Water] 换气完成，交还控制: #${id}`);
        }

        return false;
    }

    return true;
}

/** 实体移除 / 主动放弃时清理 */
export function dropDrowningState(entityId) {
    if (entityId === undefined || entityId === null) return;
    DrowningRecovery.delete(entityId);
}

/** 兜底回收：由主循环定期调用，防止实体未走 remove 事件造成泄漏 */
export function gcDrowningState(nowTick) {
    if (DrowningRecovery.size === 0) return;

    for (const [id, st] of DrowningRecovery) {
        if (nowTick - st.startTick >= DROWNING_MAX_TICKS) {
            DrowningRecovery.delete(id);
        }
    }
}

/** 诊断 */
export function getDrowningCount() {
    return DrowningRecovery.size;
}

// 事件接线

// 必须是「受影响实体自己挨了溺水伤害」，不是旁观者。
// 用 afterHurt 而不是 beforeHurt：溺水标记不参与伤害结算，
// 放在受击后不会干扰格挡 / 支援 / 友伤拦截的优先级链。
function handleDrowningHurt(event) {
    const source = event.damageSource;

    if (!source || source.cause !== DROWNING_CAUSE) return;

    const victim = event.hurtEntity;

    if (!victim || !victim.isValid) return;

    markDrowning(victim.id, system.currentTick);

    if (DEBUG_DROWNING) {
        console.warn(`[Water] 溺水换气触发: ${victim.typeId} (#${victim.id})`);
    }
}

function handleDrowningRemove(event) {
    try {
        const id = event.removedEntity?.id;
        if (id !== undefined) dropDrowningState(id);
    } catch (_) {
        // removedEntity 在移除瞬间可能已不可读，忽略即可
    }
}

/* 注册溺水检测。必须在 initEventBus() 之前调用（先登记处理器，再统一订阅）。 */
export function initDrowningDetector() {
    registerAfterHurtHandler(
        "water.drowning",
        handleDrowningHurt,
        AFTER_HURT_PRIORITY.DROWNING_GUARD
    );

    registerEntityRemoveHandler(
        "water.drowning",
        handleDrowningRemove,
        REMOVE_PRIORITY.DROWNING_GUARD
    );
}
