import { world, system } from "@minecraft/server";

// light.js — dm34 / dm34_1 的灯光跟随清理，其它实体一律不处理。

// 每 2 tick 检查位移，超过 2 格清掉旧位置光源；实体消失且之前亮着就补一次清理。
// 实体引用走缓存，重扫周期 RESCAN_INTERVAL（20 tick），查询开销比原来低一个量级。
// 过滤字段是单数 type（SAPI 里 types 无效，会被忽略或抛错被 catch 吞掉）。

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

// 主循环每 2 tick 跑一次，两个集合改成复用 + clear，省掉每秒 10 次分配。
const activeIds = new Set();
const executedCleanups = new Set();

// 安全获取清理维度

// 优先使用记录的维度。
// 如果记录维度不可用，则回退到传入的 fallbackDimension。
function getCleanupDimension(dimId, fallbackDimension) {
    if (!dimId) return fallbackDimension;

    try {
        return world.getDimension(dimId);
    } catch (_) {
        return fallbackDimension;
    }
}

// 重扫：只查 TARGET_TYPES 两个类型

// 注意字段名是单数 type，不是 types。
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

// 灯光清理命令

// executedCleanups 用于同一 tick 内去重：
// 如果多个实体在同一 tick 留下了相同旧坐标区域，
// 不重复执行同区域 fill。
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

// 主循环
system.runInterval(() => {
    try {
        const now = system.currentTick;
        const needRescan = now - lastRescanTick >= RESCAN_INTERVAL;

        // 没有跟踪对象时每 2 tick 只做一次整数比较：维度句柄、两个集合都不碰。
        if (!needRescan && CachedUnits.size === 0 && lastPositions.size === 0) return;

        let overworld;

        try {
            overworld = world.getDimension("overworld");
        } catch (_) {
            return;
        }

        if (!overworld) return;

        // ── 0. 低频重扫，刷新实体引用缓存 ──
        if (needRescan) {
            lastRescanTick = now;
            rescanTrackedUnits(overworld);
        }

        activeIds.clear();
        executedCleanups.clear();

        // 1. 遍历缓存中的 dm34 / dm34_1
        // 循环里删的是当前项，Map 迭代器允许，不需要 Array.from 快照。
        for (const [id, entity] of CachedUnits) {
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

                        // 判定用 lastData.wasLighting || isLighting：远距离 tp 会让实体卸载重载、
                        // 动画控制器重置先摘标签再加回来，此时只看当前标签会跳过清理，
                        // 而 lastPositions 是无条件覆盖的 → 旧坐标丢失、光源永久滞留。
                        // fill 是 air replace，无光源时没有副作用。
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

        // 2. 缓存清理逻辑：处理死亡、卸载或消失的实体
        // 这一轮只删不增，直接迭代 keys() 安全。
        for (const id of lastPositions.keys()) {
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
