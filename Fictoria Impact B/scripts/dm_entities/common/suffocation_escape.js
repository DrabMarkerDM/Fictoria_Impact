import {
    world,
    system,
    EntityDamageCause
} from "@minecraft/server";

// ============================================================
// 窒息 / 重力方块埋压 / 液体溺水挣脱模块 (最终完整版)
//
// 职责边界：
// 1. 纯家族匹配：只处理 dm (友方) 和 demon (敌方) 家族。
// 2. 方块窒息：非液体环境中的 suffocation (含沙子垂直逃生)。
// 3. 液体窒息：drowning 或 水下 suffocation (优先向上找空气)。
// 4. 坚决不处理岩浆/火焰 (交给 maid_manager.js)。
// ============================================================

const DEBUG_SUFOCATION_ESCAPE = false;

function suffocationLog(...args) {
    if (DEBUG_SUFOCATION_ESCAPE) {
        console.warn(...args);
    }
}

// ============================================================
// 伤害原因常量
// ============================================================
const SUFFOCATION_CAUSE = EntityDamageCause?.suffocation ?? "suffocation";
const DROWNING_CAUSE = EntityDamageCause?.drowning ?? "drowning";
const LAVA_CAUSE = EntityDamageCause?.lava ?? "lava";
const FIRE_CAUSE = EntityDamageCause?.fire ?? "fire";
const FIRE_TICK_CAUSE = EntityDamageCause?.fireTick ?? "fireTick";

// ============================================================
// 配置
// ============================================================
const CONFIG = {
    // --- 通用 ---
    onlyFamilyUnits: true, // 是否只处理 dm/demon 家族

    // --- 方块窒息 ---
    solidCooldownTicks: 20,
    allowExtraUpAfterFail: true,
    horizontalRadius: 3,
    verticalSearchUp: 4,
    downSearchDepth: 2,
    sparseOuterRadius: true,
    maxFailCount: 5,
    fuseRecoverTicks: 400,
    fuseMoveDistSq: 2.25,
    cheapStandableCheck: true,

    // --- 重力方块 (沙子) ---
    gravityBlockHints: ["sand", "gravel", "concrete_powder", "suspicious_sand", "suspicious_gravel"],
    gravityVerticalMaxUp: 32,

    // --- 液体窒息 ---
    handleLiquidSuffocation: true,
    liquidCooldownTicks: 40,
    liquidHitThreshold: 2, // 连续2次溺水才救，防误触
    liquidWindowTicks: 80,
    liquidVerticalMaxUp: 16,
    liquidHorizontalRadius: 2,
    liquidRingVerticalMaxUp: 8,
    liquidMaxFailCount: 5,
    liquidFuseRecoverTicks: 600,
    liquidFuseMoveDistSq: 2.25
};

// ============================================================
// 缓存区
// ============================================================
const EscapeLastTick = new Map();
const EscapeFailCount = new Map();
const EscapeFuseState = new Map();

const LiquidEscapeLastTick = new Map();
const LiquidHitMap = new Map();
const LiquidFailState = new Map();

// ============================================================
// 实体移除清理
// ============================================================
try {
    world.beforeEvents.entityRemove.subscribe((event) => {
        try {
            const id = event.removedEntity?.id;
            if (!id) return;
            EscapeLastTick.delete(id);
            EscapeFailCount.delete(id);
            EscapeFuseState.delete(id);
            LiquidEscapeLastTick.delete(id);
            LiquidHitMap.delete(id);
            LiquidFailState.delete(id);
        } catch (_) {}
    });
} catch (_) {}

// ============================================================
// 工具：纯家族匹配 (dm 和 demon)
// ============================================================
function shouldHandle(entity) {
    try {
        if (!entity || !entity.isValid) return false;
        if (entity.typeId === "minecraft:player") return false;
        if (entity.hasTag && entity.hasTag("maid:ride_player")) return false;

        if (!CONFIG.onlyFamilyUnits) return true;

        // 优先使用 matches
        if (typeof entity.matches === "function") {
            try { if (entity.matches({ families: ["dm"] })) return true; } catch (_) {}
            try { if (entity.matches({ families: ["demon"] })) return true; } catch (_) {}
        }

        // 兼容旧版
        try {
            if (entity.hasFamily && (entity.hasFamily("dm") || entity.hasFamily("demon"))) {
                return true;
            }
        } catch (_) {}

        return false;
    } catch (_) {
        return false;
    }
}

// ============================================================
// 工具：获取液体状态
// ============================================================
function getLiquidState(entity) {
    const state = { inLiquid: false, inLava: false };
    try {
        if (!entity || !entity.isValid) return state;
        if (entity.isInWater === true) state.inLiquid = true;

        const loc = entity.location;
        const dim = entity.dimension;
        const positions = [
            { x: loc.x, y: Math.floor(loc.y + 0.2), z: loc.z },
            { x: loc.x, y: Math.floor(loc.y + 0.9), z: loc.z },
            { x: loc.x, y: Math.floor(loc.y + 1.5), z: loc.z }
        ];

        for (const pos of positions) {
            try {
                const block = dim.getBlock(pos);
                if (!block) continue;
                if (block.isLiquid) {
                    state.inLiquid = true;
                    if (block.typeId && String(block.typeId).includes("lava")) {
                        state.inLava = true;
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
    return state;
}

// ============================================================
// 工具：方块判定
// ============================================================
function isAirLike(block) { return !block || block.isAir; }
function isGroundLike(block) { return !!block && !block.isAir && !block.isLiquid; }

function isStandable(dim, x, y, z) {
    try {
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        const body = dim.getBlock({ x: bx, y: by, z: bz });
        if (!isAirLike(body)) return false;
        const head = dim.getBlock({ x: bx, y: by + 1, z: bz });
        if (!isAirLike(head)) return false;
        const ground = dim.getBlock({ x: bx, y: by - 1, z: bz });
        return isGroundLike(ground);
    } catch (_) { return false; }
}

function isEntityStandableHere(entity) {
    try { return isStandable(entity.dimension, entity.location.x, entity.location.y, entity.location.z); } 
    catch (_) { return false; }
}

// ============================================================
// 工具：获取挣脱方向
// ============================================================
function getEscapeDirection(entity) {
    let dirX = 0, dirZ = 0;
    try { dirX = entity.getDynamicProperty("dm:cmd_vel_x") ?? 0; dirZ = entity.getDynamicProperty("dm:cmd_vel_z") ?? 0; } catch (_) {}
    if (Math.abs(dirX) < 0.01 && Math.abs(dirZ) < 0.01) {
        try { const vel = entity.getVelocity(); dirX = vel.x ?? 0; dirZ = vel.z ?? 0; } catch (_) {}
    }
    if (Math.abs(dirX) < 0.01 && Math.abs(dirZ) < 0.01) {
        try { const view = entity.getViewDirection(); dirX = view.x ?? 0; dirZ = view.z ?? 0; } catch (_) {}
    }
    const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (len < 0.001) return { x: 0, z: 1 };
    return { x: dirX / len, z: dirZ / len };
}

function clearDmMovementCommands(entity) {
    try {
        entity.setDynamicProperty("dm:cmd_vel_x", 0);
        entity.setDynamicProperty("dm:cmd_vel_z", 0);
        entity.setDynamicProperty("dm:cmd_vel_y", 0);
        entity.setDynamicProperty("dm:melee_charging", 0);
    } catch (_) {}
}

// ============================================================
// 重力方块 (沙子) 判定与垂直逃生
// ============================================================
function isGravityBlock(block) {
    try {
        if (!block || block.isAir || block.isLiquid) return false;
        const id = String(block.typeId ?? "").toLowerCase();
        for (const hint of CONFIG.gravityBlockHints) { if (id.includes(hint)) return true; }
        return false;
    } catch (_) { return false; }
}

function isBuriedInGravityBlocks(entity) {
    try {
        const dim = entity.dimension, loc = entity.location;
        const feet = dim.getBlock({ x: loc.x, y: Math.floor(loc.y + 0.2), z: loc.z });
        const body = dim.getBlock({ x: loc.x, y: Math.floor(loc.y + 0.9), z: loc.z });
        const head = dim.getBlock({ x: loc.x, y: Math.floor(loc.y + 1.5), z: loc.z });
        let c = 0;
        if (isGravityBlock(feet)) c++;
        if (isGravityBlock(body)) c++;
        if (isGravityBlock(head)) c++;
        return c >= 2;
    } catch (_) { return false; }
}

function findVerticalEscapeSpot(entity, maxUp) {
    try {
        const dim = entity.dimension, loc = entity.location;
        const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);
        for (let dy = 0; dy <= maxUp; dy++) {
            if (isStandable(dim, bx, by + dy, bz)) return { x: bx + 0.5, y: by + dy, z: bz + 0.5 };
        }
        return null;
    } catch (_) { return null; }
}

// ============================================================
// 普通方块窒息：寻找挣脱点 (带缓存和稀疏采样)
// ============================================================
function findEscapeSpot(entity, maxUp = 1) {
    try {
        const dim = entity.dimension, loc = entity.location, dir = getEscapeDirection(entity);
        const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);
        const blockCache = new Map();

        function getBlockCached(x, y, z) {
            const key = `${x},${y},${z}`;
            if (blockCache.has(key)) return blockCache.get(key);
            let b = null; try { b = dim.getBlock({ x, y, z }); } catch (_) {}
            blockCache.set(key, b); return b;
        }
        function isStandableCached(x, y, z) {
            const body = getBlockCached(x, y, z); if (!body || !body.isAir) return false;
            const head = getBlockCached(x, y + 1, z); if (!head || !head.isAir) return false;
            const ground = getBlockCached(x, y - 1, z); return !!ground && !ground.isAir && !ground.isLiquid;
        }
        function makeSpot(x, y, z) { return { x: x + 0.5, y: y, z: z + 0.5 }; }

        if (isStandableCached(bx, by, bz)) return makeSpot(bx, by, bz);

        const verticalMax = Math.max(CONFIG.verticalSearchUp ?? 4, maxUp);
        for (let dy = 1; dy <= verticalMax; dy++) { if (isStandableCached(bx, by + dy, bz)) return makeSpot(bx, by + dy, bz); }

        const directionalCandidates = [];
        for (let i = 0; i < 3; i++) directionalCandidates.push({ x: Math.floor(loc.x - dir.x * (i + 1)), z: Math.floor(loc.z - dir.z * (i + 1)), score: 10 + i * 5 });
        const leftX = -dir.z, leftZ = dir.x, rightX = dir.z, rightZ = -dir.x;
        for (let i = 0; i < 2; i++) {
            directionalCandidates.push({ x: Math.floor(loc.x + leftX * (i + 1)), z: Math.floor(loc.z + leftZ * (i + 1)), score: 25 + i * 5 });
            directionalCandidates.push({ x: Math.floor(loc.x + rightX * (i + 1)), z: Math.floor(loc.z + rightZ * (i + 1)), score: 25 + i * 5 });
        }
        directionalCandidates.sort((a, b) => a.score - b.score);
        for (const p of directionalCandidates) {
            for (let dy = 0; dy >= -(CONFIG.downSearchDepth ?? 2); dy--) if (isStandableCached(p.x, by + dy, p.z)) return makeSpot(p.x, by + dy, p.z);
            for (let dy = 1; dy <= Math.min(Math.max(maxUp, 1), 2); dy++) if (isStandableCached(p.x, by + dy, p.z)) return makeSpot(p.x, by + dy, p.z);
        }

        const maxRadius = CONFIG.horizontalRadius ?? 3;
        for (let r = 1; r <= maxRadius; r++) {
            const sparse = CONFIG.sparseOuterRadius && r >= 3;
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    if (sparse && Math.abs(dx + dz) % 2 !== 0) continue;
                    const x = bx + dx, z = bz + dz;
                    for (let dy = 0; dy >= -(CONFIG.downSearchDepth ?? 2); dy--) if (isStandableCached(x, by + dy, z)) return makeSpot(x, by + dy, z);
                    for (let dy = 1; dy <= maxUp; dy++) if (isStandableCached(x, by + dy, z)) return makeSpot(x, by + dy, z);
                }
            }
        }
        return null;
    } catch (_) { return null; }
}

// ============================================================
// 液体窒息：可呼吸点与寻找逃生点
// ============================================================
function isBreathableSpot(dim, x, y, z) {
    try {
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        const body = dim.getBlock({ x: bx, y: by, z: bz });
        if (!body || (!body.isAir && !body.isLiquid)) return false;
        const head = dim.getBlock({ x: bx, y: by + 1, z: bz });
        if (!head || !head.isAir) return false;
        const below = dim.getBlock({ x: bx, y: by - 1, z: bz });
        return !!below && !below.isAir;
    } catch (_) { return false; }
}

function findLiquidEscapeSpot(entity) {
    try {
        const dim = entity.dimension, loc = entity.location;
        const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);
        if (isBreathableSpot(dim, bx, by, bz)) return { x: bx + 0.5, y: by, z: bz + 0.5 };

        for (let dy = 1; dy <= (CONFIG.liquidVerticalMaxUp ?? 16); dy++) {
            if (isBreathableSpot(dim, bx, by + dy, bz)) return { x: bx + 0.5, y: by + dy, z: bz + 0.5 };
        }

        const radius = CONFIG.liquidHorizontalRadius ?? 2;
        for (let r = 1; r <= radius; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    const x = bx + dx, z = bz + dz;
                    for (let dy = -1; dy <= (CONFIG.liquidRingVerticalMaxUp ?? 8); dy++) {
                        if (isBreathableSpot(dim, x, by + dy, z)) return { x: x + 0.5, y: by + dy, z: z + 0.5 };
                    }
                }
            }
        }
        return null;
    } catch (_) { return null; }
}

// ============================================================
// 核心执行逻辑
// ============================================================
function tryEscape(entity) {
    try {
        if (!entity || !entity.isValid) return;
        const failCount = EscapeFailCount.get(entity.id) ?? 0;

        // 1. 优先处理重力方块 (沙子)
        if (isBuriedInGravityBlocks(entity)) {
            const vSpot = findVerticalEscapeSpot(entity, CONFIG.gravityVerticalMaxUp ?? 32);
            if (vSpot) {
                try {
                    entity.teleport(vSpot, { checkForBlocks: true });
                    try { entity.clearVelocity(); } catch (_) {}
                    clearDmMovementCommands(entity);
                    EscapeFailCount.set(entity.id, 0); EscapeFuseState.delete(entity.id);
                    suffocationLog(`[SuffocationEscape] ${entity.typeId} 沙子垂直挣脱成功`);
                    return;
                } catch (_) {}
            }
        }

        // 2. 普通方块窒息
        let maxUp = (CONFIG.allowExtraUpAfterFail && failCount >= 2) ? 2 : 1;
        const spot = findEscapeSpot(entity, maxUp);
        if (spot) {
            try {
                entity.teleport(spot, { checkForBlocks: true });
                try { entity.clearVelocity(); } catch (_) {}
                clearDmMovementCommands(entity);
                EscapeFailCount.set(entity.id, 0); EscapeFuseState.delete(entity.id);
                return;
            } catch (_) {}
        }

        const newFailCount = failCount + 1;
        if (newFailCount >= CONFIG.maxFailCount) {
            const loc = entity.location;
            EscapeFuseState.set(entity.id, { tick: system.currentTick, x: loc.x, y: loc.y, z: loc.z });
            EscapeFailCount.set(entity.id, 0);
            return;
        }
        EscapeFailCount.set(entity.id, newFailCount);
        try { const dir = getEscapeDirection(entity); entity.applyImpulse({ x: -dir.x * 0.10, y: 0.12, z: -dir.z * 0.10 }); } catch (_) {}
    } catch (_) {}
}

function tryLiquidEscape(entity) {
    try {
        if (!entity || !entity.isValid) return;
        const ls = getLiquidState(entity);
        if (!ls.inLiquid || ls.inLava) return;

        const nowTick = system.currentTick, loc = entity.location;
        let failState = LiquidFailState.get(entity.id);

        if (failState && failState.count >= CONFIG.liquidMaxFailCount) {
            const moved = (loc.x - failState.x) ** 2 + (loc.y - failState.y) ** 2 + (loc.z - failState.z) ** 2 >= CONFIG.liquidFuseMoveDistSq;
            const expired = nowTick - failState.tick >= CONFIG.liquidFuseRecoverTicks;
            if (!moved && !expired) {
                try { entity.applyImpulse({ x: 0, y: 0.10, z: 0 }); } catch (_) {}
                return;
            }
            LiquidFailState.delete(entity.id); failState = undefined;
        }

        const spot = findLiquidEscapeSpot(entity);
        if (spot) {
            try {
                entity.teleport(spot, { checkForBlocks: true });
                try { entity.clearVelocity(); } catch (_) {}
                clearDmMovementCommands(entity);
                LiquidFailState.delete(entity.id); LiquidHitMap.delete(entity.id);
                suffocationLog(`[SuffocationEscape] ${entity.typeId} 液体窒息救援成功`);
                return;
            } catch (_) {}
        }

        const newCount = (failState?.count ?? 0) + 1;
        LiquidFailState.set(entity.id, { count: newCount, tick: nowTick, x: loc.x, y: loc.y, z: loc.z });
        try { entity.applyImpulse({ x: 0, y: 0.16, z: 0 }); } catch (_) {}
    } catch (_) {}
}

// ============================================================
// 事件入口：伤害检测与分流
// ============================================================
world.afterEvents.entityHurt.subscribe((event) => {
    try {
        const victim = event.hurtEntity;
        if (!shouldHandle(victim)) return;

        const cause = event.damageSource?.cause;

        // 1. 坚决不处理岩浆 / 火焰 (交给 maid_manager.js)
        if (cause === LAVA_CAUSE || cause === FIRE_CAUSE || cause === FIRE_TICK_CAUSE) return;

        const liquidState = getLiquidState(victim);
        if (liquidState.inLava) return;

        const nowTick = system.currentTick;

        // ============================================================
        // 2. 液体窒息 / 溺水分支 (必须放在普通窒息前面，且不能被 isInLiquid 拦截)
        // ============================================================
        if (CONFIG.handleLiquidSuffocation) {
            const isLiquidSuffocation = (cause === DROWNING_CAUSE) || (cause === SUFFOCATION_CAUSE && liquidState.inLiquid);
            
            if (isLiquidSuffocation) {
                let record = LiquidHitMap.get(victim.id);
                if (!record || nowTick - record.tick > CONFIG.liquidWindowTicks) record = { count: 0, tick: nowTick };
                record.count += 1; record.tick = nowTick;
                LiquidHitMap.set(victim.id, record);

                if (record.count < CONFIG.liquidHitThreshold) return;

                const lastL = LiquidEscapeLastTick.get(victim.id) ?? -9999;
                if (nowTick - lastL < CONFIG.liquidCooldownTicks) return;
                LiquidEscapeLastTick.set(victim.id, nowTick);
                LiquidHitMap.set(victim.id, { count: 0, tick: nowTick });

                system.run(() => { try { if (victim && victim.isValid) tryLiquidEscape(victim); } catch (_) {} });
                return; // 液体分支结束，直接 return
            }
        }

        // ============================================================
        // 3. 普通方块窒息分支
        // ============================================================
        if (cause !== SUFFOCATION_CAUSE) return;
        if (liquidState.inLiquid) return; // 只有普通窒息才排除液体

        // 熔断检查
        const fuse = EscapeFuseState.get(victim.id);
        if (fuse) {
            const loc = victim.location;
            const moved = (loc.x - fuse.x) ** 2 + (loc.y - fuse.y) ** 2 + (loc.z - fuse.z) ** 2 >= CONFIG.fuseMoveDistSq;
            const expired = nowTick - fuse.tick >= CONFIG.fuseRecoverTicks;
            const standable = CONFIG.cheapStandableCheck && isEntityStandableHere(victim);
            if (moved || expired || standable) {
                EscapeFuseState.delete(victim.id); EscapeFailCount.set(victim.id, 0);
            } else {
                return;
            }
        }

        const lastS = EscapeLastTick.get(victim.id) ?? -9999;
        if (nowTick - lastS < CONFIG.solidCooldownTicks) return;
        EscapeLastTick.set(victim.id, nowTick);

        system.run(() => { try { if (victim && victim.isValid) tryEscape(victim); } catch (_) {} });
    } catch (_) {}
});

suffocationLog("[SuffocationEscape] 最终完整版已加载 (纯家族匹配 + 沙子 + 液体溺水)");