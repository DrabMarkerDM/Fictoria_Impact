import { world, system } from "@minecraft/server";

// ============================================================
// light.js — dm34 / dm34_1 灯光跟随清理模块
//
// 只服务两个实体：
//   player:dm34     女仆
//   player:dm34_1   女仆二阶段
// 其它实体一律不扫描、不处理。
//
// 原逻辑：
//   · 每 2 tick 检查一次
//   · 只检查 player:dm34 / player:dm34_1
//   · 带 is_lighting 标签的实体移动超过 2 格时清理旧位置
//   · 实体消失且消失前处于 is_lighting 状态时补一次清理
//
// 本次修复与优化：
//   1. 【修复】原来用 getEntities({ types: type }) 过滤，
//      但 SAPI 的 EntityFilter 里包含过滤字段是单数 type?: string，
//      复数只有 excludeTypes?: string[]（排除）。
//      传一个字符串给 types 属于无效字段，
//      实际要么被忽略（返回全维度实体）、要么直接抛错被 catch 吞掉。
//      现在改为 { type }。
//
//   2. 【优化】实体引用改为缓存 + 低频重扫：
//      原来每 2 tick 做 2 次维度级 getEntities（全维度迭代）。
//      现在每 2 tick 只做位移计算，实体引用走缓存；
//      重扫周期 RESCAN_INTERVAL = 20 tick。
//      查询开销降低约 10 倍，且扫描范围严格限定这两个类型。
//
//   3. 其它保留：平方距离判断、同 tick 清理去重、
//      跨维度残留清理、临终补清理。
// ============================================================

// 位移检测 + 清理的执行频率（每 2 tick）
const LIGHT_CLEANUP_INTERVAL_TICKS = 2;

// 实体引用重扫周期（每 20 tick 一次）
const RESCAN_INTERVAL = 20;

// 只扫描这两个实体，其它一律不管
const TARGET_TYPES = ["player:dm34", "player:dm34_1"];

// 触发清理的位移阈值：2 格（用平方距离避免 Math.sqrt）
const MOVE_DIST_SQ = 2 * 2;

// fill 清理范围
const FILL_X_RADIUS = 2;
const FILL_Y_BELOW = 1;
const FILL_Y_ABOVE = 3;

// 缓存记录表：entityId -> { pos, wasLighting, dimId }
const lastPositions = new Map();

// 实体引用缓存：entityId -> Entity
// 只可能包含 player:dm34 / player:dm34_1
const CachedUnits = new Map();

let lastRescanTick = -RESCAN_INTERVAL;

// ============================================================
// 安全获取清理维度
//
// 优先使用记录的维度。
// 如果记录维度不可用，则回退到传入的 fallbackDimension。
// ============================================================
function getCleanupDimension(dimId, fallbackDimension) {
    if (!dimId) return fallbackDimension;

    try {
        return world.getDimension(dimId);
    } catch (_) {
        return fallbackDimension;
    }
}

// ============================================================
// 重扫：只查 TARGET_TYPES 两个类型
//
// 注意字段名是单数 type，不是 types。
// ============================================================
function rescanTrackedUnits(dimension) {
    for (const type of TARGET_TYPES) {
        let found;

        try {
            found = dimension.getEntities({ type: type });
        } catch (_) {
            continue;
        }

        for (const entity of found) {
            try {
                if (entity && entity.isValid) {
                    CachedUnits.set(entity.id, entity);
                }
            } catch (_) { }
        }
    }
}

// ============================================================
// 灯光清理命令
//
// executedCleanups 用于同一 tick 内去重：
// 如果多个实体在同一 tick 留下了相同旧坐标区域，
// 不重复执行同区域 fill。
// ============================================================
function runCleanupLight(dimension, pos, executedCleanups) {
    if (!dimension || !pos) return;

    const fx = Math.floor(pos.x);
    const fy = Math.floor(pos.y);
    const fz = Math.floor(pos.z);

    const cleanupKey = `${dimension.id ?? "unknown"}|${fx}|${fy}|${fz}`;

    if (executedCleanups && executedCleanups.has(cleanupKey)) {
        return;
    }

    if (executedCleanups) {
        executedCleanups.add(cleanupKey);
    }

    const minX = fx - FILL_X_RADIUS;
    const minY = fy - FILL_Y_BELOW;
    const minZ = fz - FILL_X_RADIUS;

    const maxX = fx + FILL_X_RADIUS;
    const maxY = fy + FILL_Y_ABOVE;
    const maxZ = fz + FILL_X_RADIUS;

    try {
        dimension.runCommand(
            `fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} air replace block:dm_light_1`
        );
    } catch (_) {
        // 命令失败时静默兜底，避免影响后续灯光清理循环
    }
}

// ============================================================
// 主循环
// ============================================================
system.runInterval(() => {
    try {
        let overworld;

        try {
            overworld = world.getDimension("overworld");
        } catch (_) {
            return;
        }

        if (!overworld) return;

        const now = system.currentTick;

        // ── 0. 低频重扫，刷新实体引用缓存 ──
        if (now - lastRescanTick >= RESCAN_INTERVAL) {
            lastRescanTick = now;
            rescanTrackedUnits(overworld);
        }

        // 当前存活 ID 集合，用于后续对比清理缓存
        const activeIds = new Set();

        // 同一 tick 内的清理去重表
        const executedCleanups = new Set();

        // ============================================================
        // 1. 遍历缓存中的 dm34 / dm34_1
        // ============================================================
        for (const [id, entity] of Array.from(CachedUnits.entries())) {
            // 实体已失效：从缓存摘除，交给下面的临终清理
            let isValid = false;

            try {
                isValid = !!entity && entity.isValid;
            } catch (_) {
                isValid = false;
            }

            if (!isValid) {
                CachedUnits.delete(id);
                continue;
            }

            activeIds.add(id);

            let currentPos;

            try {
                currentPos = entity.location;
            } catch (_) {
                continue;
            }

            const lastData = lastPositions.get(id);

            let isLighting = false;

            try {
                isLighting = entity.hasTag("is_lighting");
            } catch (_) { }

            // ============================================================
            // 判定条件：lastData.wasLighting || isLighting
            //
            // 【修复】远距离瞬移后光源滞留
            //
            // 原判定只用了 isLighting（当前标签状态），这是个时序竞态：
            // 光源由 animation_controllers/dm34_light_detector 驱动，
            // glow_pulse_a / glow_pulse_b 每 tick 交替执行 /function dynamic_light，
            // 而 is_lighting 标签只在 default / cleanup 的 on_entry 被移除。
            //
            // 远距离 tp 会让实体卸载重载 → 动画控制器重置 →
            // default 的 on_entry 执行 /tag @s remove is_lighting，
            // 下一两个 tick 才在 glow_pulse_a 重新加上。
            //
            // 如果这期间刚好检测到大位移，isLighting 为 false → 跳过清理，
            // 而下面 lastPositions.set 是无条件覆盖的，
            // 旧坐标当场丢失 → 旧位置光源永久滞留。
            //
            // 要清的是「旧位置可能残留的光源」，是否残留由【上次记录时】的状态决定，
            // 与当前标签状态无关。所以任一为真都清理。
            // fill 是 air replace block:dm_light_1，无光源时不会产生任何效果。
            // ============================================================
            if (lastData && (lastData.wasLighting || isLighting)) {
                // 计算水平位移平方距离
                const dx = currentPos.x - lastData.pos.x;
                const dz = currentPos.z - lastData.pos.z;
                const distSq = dx * dx + dz * dz;

                // 如果位移超过 2 格，清理旧位置
                if (distSq > MOVE_DIST_SQ) {
                    // 优先使用旧位置记录的维度，而不是当前实体维度。
                    // 这样实体跨维度传送时，也能清理旧维度残留灯光。
                    const cleanupDim = getCleanupDimension(
                        lastData.dimId,
                        entity.dimension
                    );

                    runCleanupLight(cleanupDim, lastData.pos, executedCleanups);
                }
            }

            // 记录当前维度，方便后续清理
            let dimId = "overworld";

            try {
                dimId = entity.dimension.id;
            } catch (_) { }

            // 更新 / 新增缓存记录
            lastPositions.set(id, {
                pos: {
                    x: currentPos.x,
                    y: currentPos.y,
                    z: currentPos.z
                },
                wasLighting: isLighting,
                dimId: dimId
            });
        }

        // ============================================================
        // 2. 缓存清理逻辑：处理死亡、卸载或消失的实体
        // ============================================================
        for (const id of Array.from(lastPositions.keys())) {
            if (activeIds.has(id)) continue;

            const data = lastPositions.get(id);

            if (!data) {
                lastPositions.delete(id);
                continue;
            }

            // 如果这个实体不见了，且它消失前是亮着的，补一次“临终清理”
            if (data.wasLighting) {
                const cleanupDim = getCleanupDimension(data.dimId, overworld);

                runCleanupLight(cleanupDim, data.pos, executedCleanups);
            }

            // 彻底从 Map 中删除，释放内存
            lastPositions.delete(id);
        }
    } catch (_) {
        // 灯光模块属于辅助视觉效果，异常静默兜底，避免拖垮主脚本循环
    }
}, LIGHT_CLEANUP_INTERVAL_TICKS);
