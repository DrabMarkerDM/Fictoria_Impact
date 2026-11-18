import { system, world, EntityDamageCause } from "@minecraft/server";

// demon_landmine.js — 恶魔地雷。

// 全工程只有 1 个全局调度器（3 tick）遍历地雷坐标表，每颗雷不持有定时器
// （原实现是每颗雷一个 runInterval，100 颗雷 = 100 个定时器）。
// 触发：实体水平 ±1、脚下 0.5~头顶 1.5；黑名单模式（demon/monster 家族、item、xp_orb 不触发）。
// 180 秒后熔断半径检测，只保留 onStepOn；仍有连锁爆炸与临时光源。
// 雷被破坏会由方块校验摘表；旧存档里没走过 onPlace 的雷在被踩时补登记。

// 常量

const MINE_ID = "block:demon_landmine";

// 黑名单模式：除了 demon 和 monster 家族外的所有实体都会触发爆炸。
// item、xp_orb 等非生物实体不触发。
const EXCLUDED_FAMILIES = ["demon", "monster"];
const EXCLUDED_TYPES = ["minecraft:item", "minecraft:xp_orb"];

const EXPLOSION_RADIUS = 4.0;
const EXPLOSION_DAMAGE = 20;
const EXPLOSION_KNOCKBACK = 1.0;
const LIGHT_BLOCK = "block:dm_light_1";
const LIGHT_DURATION_TICKS = 2;
const TRIGGER_RADIUS = 1.0;

// 全局调度器步长（与原每颗雷的定时器周期一致）
const CHECK_INTERVAL = 3;

// 每颗雷的方块存活校验周期
// 校验比半径检测便宜，但没必要每 3 tick 都做
const VALIDATE_INTERVAL = 20;

// 180 秒后熔断半径检测，只保留 onStepOn
const MAX_ACTIVE_TICKS = 180 * 20;

// 地雷坐标表：key = `${dimId}|${x}|${y}|${z}`
// value = { key, dimId, x, y, z, center, expireTick, expireFlagged, nextValidateTick }
const MineTable = new Map();

// 维度缓存，避免每次 getDimensions 查表
const DimensionCache = new Map();

function getDimensionSafe(dimId) {
    if (!dimId) return undefined;

    const cached = DimensionCache.get(dimId);
    if (cached) return cached;

    try {
        const dim = world.getDimension(dimId);
        if (dim) {
            DimensionCache.set(dimId, dim);
            return dim;
        }
    } catch (_) { }

    return undefined;
}

function makeMineKey(dimId, x, y, z) {
    return `${dimId}|${x}|${y}|${z}`;
}

// 登记 / 注销
function registerMine(dimension, location) {
    try {
        if (!dimension || !location) return undefined;

        const dimId = dimension.id;
        const x = Math.floor(location.x);
        const y = Math.floor(location.y);
        const z = Math.floor(location.z);

        const key = makeMineKey(dimId, x, y, z);

        const existing = MineTable.get(key);
        if (existing) return existing;

        const now = system.currentTick;

        const entry = {
            key,
            dimId,
            x,
            y,
            z,
            center: {
                x: x + 0.5,
                y: y + 0.5,
                z: z + 0.5
            },
            expireTick: now + MAX_ACTIVE_TICKS,
            expireFlagged: false,
            nextValidateTick: now + VALIDATE_INTERVAL
        };

        MineTable.set(key, entry);

        return entry;
    } catch (_) {
        return undefined;
    }
}

function unregisterMine(entry) {
    if (!entry) return;
    entry.removed = true;
    MineTable.delete(entry.key);
}

function unregisterMineAt(dimension, location) {
    try {
        if (!dimension || !location) return;
        const key = makeMineKey(
            dimension.id,
            Math.floor(location.x),
            Math.floor(location.y),
            Math.floor(location.z)
        );
        MineTable.delete(key);
    } catch (_) { }
}

// 黑名单判定：
// 排除 demon 和 monster 家族，其余全部触发。
// 没有 family 组件的实体也触发。
function shouldTrigger(entity) {
    try {
        if (!entity || !entity.isValid) return false;

        const typeId = entity.typeId;
        if (typeId === "minecraft:item" || typeId === "minecraft:xp_orb") return false;

        const familyComp = entity.getComponent("minecraft:type_family");
        if (!familyComp) return true;

        for (const family of EXCLUDED_FAMILIES) {
            if (familyComp.hasTypeFamily(family)) return false;
        }

        return true;
    } catch (e) {
        return false;
    }
}

// 爆炸伤害
function applyExplosionDamage(dimension, location) {
    const center = {
        x: location.x + 0.5,
        y: location.y + 0.5,
        z: location.z + 0.5
    };

    let allEntities;

    try {
        allEntities = dimension.getEntities({
            location: center,
            maxDistance: EXPLOSION_RADIUS,
            excludeTypes: EXCLUDED_TYPES
        });
    } catch (e) {
        return;
    }

    const targets = allEntities.filter(e => {
        try {
            if (!e.isValid) return false;
            return shouldTrigger(e);
        } catch (_) {
            return false;
        }
    });

    for (const target of targets) {
        try {
            target.applyDamage(EXPLOSION_DAMAGE, {
                cause: EntityDamageCause.override
            });

            const dx = target.location.x - center.x;
            const dz = target.location.z - center.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist > 0.01) {
                target.applyImpulse({
                    x: (dx / dist) * EXPLOSION_KNOCKBACK,
                    y: 0.6,
                    z: (dz / dist) * EXPLOSION_KNOCKBACK
                });
            }
        } catch (_) { }
    }
}

// 触发爆炸
function triggerExplosion(dimension, location) {
    // 防重复：方块已不是地雷说明已经炸过
    try {
        const currentBlock = dimension.getBlock(location);
        if (!currentBlock || currentBlock.typeId !== MINE_ID) return;
    } catch (_) {
        return;
    }

    // 先从坐标表摘掉，避免同一 tick 内被重复遍历到
    unregisterMineAt(dimension, location);

    dimension.playSound("demon_landmine", location, { volume: 1.0, pitch: 1.0 });

    const particleLocation = {
        x: location.x + 0.5,
        y: location.y + 0.5,
        z: location.z + 0.5
    };

    dimension.spawnParticle("dm:dm_smoke", particleLocation);
    dimension.spawnParticle("minecraft:huge_explosion_emitter", particleLocation);
    dimension.spawnParticle("minecraft:large_explosion", particleLocation);
    dimension.spawnParticle("dm:smash_particle", particleLocation);
    dimension.spawnParticle("dm:dust_particle", particleLocation);

    try {
        applyExplosionDamage(dimension, location);
    } catch (e) { }

    const lightLocation = { x: location.x, y: location.y + 1, z: location.z };

    try {
        dimension.setBlockType(lightLocation, LIGHT_BLOCK);
        system.runTimeout(() => {
            try {
                const currentBlock = dimension.getBlock(lightLocation);
                if (currentBlock && currentBlock.typeId === LIGHT_BLOCK) {
                    dimension.setBlockType(lightLocation, "minecraft:air");
                }
            } catch (e) { }
        }, LIGHT_DURATION_TICKS);
    } catch (e) { }

    // 清除地雷（必须在连锁检测之前，防止重复触发自身）
    dimension.setBlockType(location, "minecraft:air");

    // 搜索范围内其他地雷
    chainExplode(dimension, location);

    // 保存地雷坐标，由维度直接执行，使用基岩版正确的 positioned 语法
    const capturedDimensionId = dimension.id;
    const capturedLocation = location;

    system.run(() => {
        try {
            const dim = world.getDimension(capturedDimensionId);
            const x = Math.floor(capturedLocation.x);
            const y = Math.floor(capturedLocation.y);
            const z = Math.floor(capturedLocation.z);

            dim.runCommand(`execute positioned ${x} ${y} ${z} run function explosion`);
        } catch (e) {
            console.error(`[DM-Landmine] 触发 function 失败: ${e}`);
        }
    });
}

// 连锁爆炸：搜索爆炸范围内其他地雷并延迟触发
function chainExplode(dimension, location) {
    const chainRadius = Math.floor(EXPLOSION_RADIUS);
    const chainTargets = [];

    for (let dx = -chainRadius; dx <= chainRadius; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dz = -chainRadius; dz <= chainRadius; dz++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                if (dx * dx + dy * dy + dz * dz > chainRadius * chainRadius) continue;

                const checkPos = {
                    x: location.x + dx,
                    y: location.y + dy,
                    z: location.z + dz
                };

                try {
                    const block = dimension.getBlock(checkPos);
                    if (block && block.typeId === MINE_ID) {
                        chainTargets.push({ x: checkPos.x, y: checkPos.y, z: checkPos.z });
                    }
                } catch (e) { }
            }
        }
    }

    if (chainTargets.length > 0) {
        system.runTimeout(() => {
            for (const target of chainTargets) {
                try {
                    triggerExplosion(dimension, target);
                } catch (e) { }
            }
        }, 3); // 延迟3tick，连锁有视觉层次感
    }
}

// 单颗地雷的半径检测

// 返回 true 表示已触发（表项已由 triggerExplosion 摘除）
function checkMineProximity(entry, now, dimension) {
    // 180 秒后熔断半径检测，只保留 onStepOn
    if (now > entry.expireTick) {
        if (!entry.expireFlagged) {
            entry.expireFlagged = true;
            try {
                dimension.playSound("demon_landmine", { x: entry.x, y: entry.y, z: entry.z }, {
                    volume: 1.0,
                    pitch: 1.0
                });
            } catch (_) { }
        }
        return false;
    }

    let nearbyEntities;

    try {
        nearbyEntities = dimension.getEntities({
            location: entry.center,
            maxDistance: TRIGGER_RADIUS,
            excludeTypes: EXCLUDED_TYPES
        });
    } catch (_) {
        return false;
    }

    for (const entity of nearbyEntities) {
        if (!entity.isValid) continue;
        if (!shouldTrigger(entity)) continue;

        let loc;

        try {
            loc = entity.location;
        } catch (_) {
            continue;
        }

        if (
            Math.abs(loc.x - entry.center.x) <= TRIGGER_RADIUS &&
            Math.abs(loc.z - entry.center.z) <= TRIGGER_RADIUS &&
            loc.y >= entry.y - 0.5 &&
            loc.y <= entry.y + 1.5
        ) {
            triggerExplosion(dimension, { x: entry.x, y: entry.y, z: entry.z });
            return true;
        }
    }

    return false;
}

// 方块存活校验

// 返回 false 表示该雷已不存在，应从表里摘除
function validateMineBlock(entry, dimension) {
    try {
        const block = dimension.getBlock({ x: entry.x, y: entry.y, z: entry.z });

        // 区块未加载时 getBlock 可能返回 undefined，
        // 这时无法判断，保留表项，等下次再校验
        if (!block) return true;

        return block.typeId === MINE_ID;
    } catch (_) {
        // 越界 / 未加载等异常，同样保留
        return true;
    }
}

// 全局调度器

// 全工程唯一的定时器。
// 遍历 MineTable，按需做方块校验 + 半径检测。
// 表为空时直接返回，零开销。
system.runInterval(() => {
    if (MineTable.size === 0) return;

    const now = system.currentTick;

    // 快照 key 列表，避免遍历时删除导致的迭代语义问题
    for (const entry of Array.from(MineTable.values())) {
        if (entry.removed) continue;
        if (!MineTable.has(entry.key)) continue;

        const dimension = getDimensionSafe(entry.dimId);
        if (!dimension) continue;

        // ── 1. 按周期校验方块是否还在 ──
        if (now >= entry.nextValidateTick) {
            entry.nextValidateTick = now + VALIDATE_INTERVAL;

            if (!validateMineBlock(entry, dimension)) {
                unregisterMine(entry);
                continue;
            }
        }

        // ── 2. 半径检测 ──
        try {
            checkMineProximity(entry, now, dimension);
        } catch (_) { }
    }
}, CHECK_INTERVAL);

// 自定义组件注册
system.beforeEvents.startup.subscribe((initEvent) => {
    initEvent.blockComponentRegistry.registerCustomComponent(
        "block:demon_landmine",
        {
            onPlace(event) {
                const { block } = event;

                block.dimension.playSound("demon_landmine", block.location, {
                    volume: 1.0,
                    pitch: 1.0
                });

                // 登记到全局坐标表，由统一调度器接管
                registerMine(block.dimension, block.location);
            },

            onBreak(event) {
                // 被玩家/爆炸/指令移除时立刻摘除，不等校验周期
                try {
                    unregisterMineAt(event.block.dimension, event.block.location);
                } catch (_) { }
            },

            onStepOn(event) {
                const { block, entity } = event;

                if (!entity || !entity.isValid) return;
                if (!shouldTrigger(entity)) return;

                // 自我修复：旧存档里没走过 onPlace 的雷，在这里补登记
                registerMine(block.dimension, block.location);

                try {
                    const currentBlock = block.dimension.getBlock(block.location);
                    if (!currentBlock || currentBlock.typeId !== MINE_ID) return;
                } catch (_) {
                    return;
                }

                triggerExplosion(block.dimension, block.location);
            }
        }
    );
});
