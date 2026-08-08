import { world, system } from "@minecraft/server";

// ============================================================
// light.js — dm34 / dm34_1 灯光跟随清理模块（稳定版保守优化）
//
// 保留原逻辑：
//   · 每 2 tick 检查一次
//   · 只检查 player:dm34 / player:dm34_1
//   · 带 is_lighting 标签的实体移动超过 2 格时清理旧位置
//   · 实体消失且消失前处于 is_lighting 状态时补一次清理
//
// 优化点：
//   · 位移判断改用平方距离，去掉 Math.sqrt
//   · fill 命令统一封装并加 try/catch
//   · 记录实体维度，清理旧灯光时优先使用旧位置所在维度
//   · 同一 tick 相同旧位置清理去重
//   · 不再额外创建 currentActiveEntities 数组
// ============================================================

// 运行频率：每 2 tick
const LIGHT_CLEANUP_INTERVAL_TICKS = 2;

// 待检测的实体类型列表
const TARGET_TYPES = ["player:dm34", "player:dm34_1"];

// 触发清理的位移阈值：2 格
// 使用平方距离避免 Math.sqrt
const MOVE_DIST_SQ = 2 * 2;

// fill 清理范围
const FILL_X_RADIUS = 2;
const FILL_Y_BELOW = 1;
const FILL_Y_ABOVE = 3;

// 缓存记录表：存储 entityId -> { pos, wasLighting, dimId }
const lastPositions = new Map();

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

        // 当前存活 ID 集合，用于后续对比清理缓存
        const activeIds = new Set();

        // 同一 tick 内的清理去重表
        const executedCleanups = new Set();

        // ============================================================
        // 1. 收集当前主世界中所有相关活体实体，并直接处理
        //
        // 保留原来的逐类型查询写法：
        // overworld.getEntities({ types: type })
        // ============================================================
        for (const type of TARGET_TYPES) {
            let found;

            try {
                found = overworld.getEntities({ types: type });
            } catch (_) {
                continue;
            }

            for (const entity of found) {
                if (!entity || !entity.isValid) continue;

                activeIds.add(entity.id);

                let currentPos;

                try {
                    currentPos = entity.location;
                } catch (_) {
                    continue;
                }

                const lastData = lastPositions.get(entity.id);

                let isLighting = false;

                try {
                    isLighting = entity.hasTag("is_lighting");
                } catch (_) {}

                if (lastData && isLighting) {
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
                } catch (_) {}

                // 更新 / 新增缓存记录
                lastPositions.set(entity.id, {
                    pos: {
                        x: currentPos.x,
                        y: currentPos.y,
                        z: currentPos.z
                    },
                    wasLighting: isLighting,
                    dimId: dimId
                });
            }
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