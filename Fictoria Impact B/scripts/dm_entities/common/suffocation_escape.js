import {
    system,
    EntityDamageCause
} from "@minecraft/server";
import {
    registerEntityRemoveHandler,
    registerAfterHurtHandler,
    REMOVE_PRIORITY,
    AFTER_HURT_PRIORITY
} from "./event_bus.js";
import {
    writeMoveCmd,
    peekMoveCmd,
    clearMoveCmd
} from "./move_command_store.js";

// 窒息 / 重力方块埋压 / 液体溺水挣脱模块

const DEBUG_SUFOCATION_ESCAPE = false;

function suffocationLog(...args) {
    if (DEBUG_SUFOCATION_ESCAPE) {
        console.warn(...args);
    }
}

// 伤害原因常量
const SUFFOCATION_CAUSE = EntityDamageCause?.suffocation ?? "suffocation";
const DROWNING_CAUSE = EntityDamageCause?.drowning ?? "drowning";
const LAVA_CAUSE = EntityDamageCause?.lava ?? "lava";
const FIRE_CAUSE = EntityDamageCause?.fire ?? "fire";
const FIRE_TICK_CAUSE = EntityDamageCause?.fireTick ?? "fireTick";

// 配置
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
    // 与 water_traversal 并存：本模块只在「连续 N 次溺水」后做**粗粒度救援**
    // （传送 / 上推），water_traversal 负责每 tick 的换气跟随。
    // 想关掉这里（避免两套同时作用）把 handleLiquidSuffocation 置 false。
    handleLiquidSuffocation: true,
    liquidCooldownTicks: 40,
    liquidHitThreshold: 2,        // 连续 2 次溺水才救，防误触
    liquidWindowTicks: 80,
    liquidVerticalMaxUp: 16,
    liquidHorizontalRadius: 2,
    liquidRingVerticalMaxUp: 8,
    liquidMaxFailCount: 5,
    liquidFuseRecoverTicks: 600,
    liquidFuseMoveDistSq: 2.25
};

// 缓存区
const EscapeLastTick = new Map();
const EscapeFailCount = new Map();
const EscapeFuseState = new Map();

// 液体救援账本（旧 F 版的能力，D 版当年删掉了）
const LiquidEscapeLastTick = new Map();
const LiquidHitMap = new Map();
const LiquidFailState = new Map();

// 实体移除清理
registerEntityRemoveHandler("suffocation_cache", (event) => {
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
}, REMOVE_PRIORITY.SUFFOCATION_CACHE);

// 工具：纯家族匹配 (dm 和 demon)
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

// 工具：获取液体状态
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

// 工具：方块判定
function isGroundLike(block) { return !!block && !block.isAir && !block.isLiquid; }

// 可通行 = 空气或液体。

// 液体也算「能站」，是为了水下脱困：
// 被 teleport 挤进海底方块时，脱困落点必然还在水体里，
// 如果坚持要求空气，水下永远找不到落点，脱困会静默失败。
function isPassableLike(block) { return !block || block.isAir || block.isLiquid; }

function isStandable(dim, x, y, z) {
    try {
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        const body = dim.getBlock({ x: bx, y: by, z: bz });
        if (!isPassableLike(body)) return false;
        const head = dim.getBlock({ x: bx, y: by + 1, z: bz });
        if (!isPassableLike(head)) return false;

        // 身体格是液体 → 悬浮在水中，不要求脚下有固体。
        // 水柱中间本来就没有「地面」，坚持要地面会让水下脱困全线找不到落点。
        if (body && body.isLiquid) return true;

        const ground = dim.getBlock({ x: bx, y: by - 1, z: bz });
        return isGroundLike(ground);
    } catch (_) { return false; }
}

// 脚部所在格是否为固体 —— 即「已被挤进方块内部」。

// 用来区分两种同时成立的状态：
//   · 在水里正常溺水（脚格是水）      → 不该走方块脱困
//   · 卡进水底方块里（脚格是石头沙子）→ 必须走方块脱困
function isEntityInsideSolid(entity) {
    try {
        const dim = entity.dimension;
        const loc = entity.location;
        const feet = dim.getBlock({
            x: Math.floor(loc.x),
            y: Math.floor(loc.y + 0.2),
            z: Math.floor(loc.z)
        });
        return isGroundLike(feet);
    } catch (_) { return false; }
}

function isEntityStandableHere(entity) {
    try { return isStandable(entity.dimension, entity.location.x, entity.location.y, entity.location.z); } 
    catch (_) { return false; }
}

// 工具：获取挣脱方向
function getEscapeDirection(entity) {
    let dirX = 0, dirZ = 0;
    try {
        const escapeCmd = peekMoveCmd(entity.id);
        dirX = escapeCmd.x;
        dirZ = escapeCmd.z;
    } catch (_) {}
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
        clearMoveCmd(entity);
        entity.setDynamicProperty("dm:melee_charging", 0);
    } catch (_) {}
}

// 重力方块 (沙子) 判定与垂直逃生
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

// 普通方块窒息：寻找挣脱点 (带缓存和稀疏采样)
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
            // 与模块级 isStandable 同口径：液体也算可通行，
            // 否则水下卡方块时这条搜索路径永远返回 null。
            const body = getBlockCached(x, y, z); if (!isPassableLike(body)) return false;
            const head = getBlockCached(x, y + 1, z); if (!isPassableLike(head)) return false;
            // 悬浮在水中时不要求脚下有固体
            if (body && body.isLiquid) return true;
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
// 液体窒息：可呼吸点 → 逃生点 → 救援
//
// 与 water_traversal 的分工：那边每 tick 管换气跟随，这边只在**连续溺水**后
// 做粗粒度救援（找一个能呼吸的落点直接传过去）。两套都留着，见 CONFIG 注释。
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

function tryLiquidEscape(entity) {
    try {
        if (!entity || !entity.isValid) return;
        const ls = getLiquidState(entity);
        if (!ls.inLiquid || ls.inLava) return;

        const nowTick = system.currentTick, loc = entity.location;
        let failState = LiquidFailState.get(entity.id);

        // 连续失败太多次：只在「挪窝了」或「冷静期过了」之后才重试，
        // 期间给一点点浮力，别让她沉底。
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
                // 骑乘时连载具一起送走（teleportEscapeTarget 内部处理降级）
                teleportEscapeTarget(entity, spot, { checkForBlocks: true });
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

/*
 * 脱困传送：骑乘时把载具一起送走。
 * 对她本人 teleport 会直接断掉骑乘关系（人掉下来、载具留在原地），所以骑乘时目标是
 * `entityRidingOn` —— 她作为骑手会跟着载具过去，两个一起脱困。
 * 载具体积比她大，同一个落点可能放不下（teleport 的 checkForBlocks 会抛错），这时退化为她本人
 * 脱困：会下马，但先保命。
 */
function teleportEscapeTarget(entity, spot, options) {
    let mount;

    try {
        mount = entity.getComponent("minecraft:riding")?.entityRidingOn;
    } catch (_) {
        mount = undefined;
    }

    if (mount && mount.isValid) {
        try {
            mount.teleport(spot, options);
            try { mount.clearVelocity(); } catch (_) { }
            return;
        } catch (_) {
            // 落点放不下载具 → 走下面的降级路径
        }
    }

    entity.teleport(spot, options);
    try { entity.clearVelocity(); } catch (_) { }
}

// 核心执行逻辑
function tryEscape(entity) {
    try {
        if (!entity || !entity.isValid) return;
        const failCount = EscapeFailCount.get(entity.id) ?? 0;

        // 1. 优先处理重力方块 (沙子)
        if (isBuriedInGravityBlocks(entity)) {
            const vSpot = findVerticalEscapeSpot(entity, CONFIG.gravityVerticalMaxUp ?? 32);
            if (vSpot) {
                try {
                    teleportEscapeTarget(entity, vSpot, { checkForBlocks: true });
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
                teleportEscapeTarget(entity, spot, { checkForBlocks: true });
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

// 事件入口：伤害检测与分流
registerAfterHurtHandler("suffocation_escape", (event) => {
    try {
        const victim = event.hurtEntity;
        if (!shouldHandle(victim)) return;

        const cause = event.damageSource?.cause;

        // 1. 坚决不处理岩浆 / 火焰 (交给 maid_manager.js)
        if (cause === LAVA_CAUSE || cause === FIRE_CAUSE || cause === FIRE_TICK_CAUSE) return;

        const liquidState = getLiquidState(victim);
        if (liquidState.inLava) return;

        const nowTick = system.currentTick;

        // 脚格是否为固体 —— 液体分支与方块分支共用，只算一次。
        // 只有溺水 / 窒息两种 cause 用得到，其它伤害（箭、摔落、爆炸）不浪费 getBlock。
        const needSolidProbe = (cause === DROWNING_CAUSE || cause === SUFFOCATION_CAUSE);
        const insideSolid = needSolidProbe ? isEntityInsideSolid(victim) : false;

        // 2. 液体窒息 / 溺水
        //
        // 🔴 脚格是固体（`insideSolid`）时**一律不走这里**：那是「被挤进方块」，
        //    上浮永远出不来，只能走下面的方块脱困分支去找空位钻出去。
        //    这也是 D 版当初加的 isEntityInsideSolid 存在的意义。
        if (CONFIG.handleLiquidSuffocation && needSolidProbe) {
            const isLiquidSuffocation = !insideSolid
                && (cause === DROWNING_CAUSE
                    || (cause === SUFFOCATION_CAUSE && liquidState.inLiquid));

            if (isLiquidSuffocation) {
                let record = LiquidHitMap.get(victim.id);
                if (!record || nowTick - record.tick > CONFIG.liquidWindowTicks) {
                    record = { count: 0, tick: nowTick };
                }
                record.count += 1;
                record.tick = nowTick;
                LiquidHitMap.set(victim.id, record);

                // 连击不够就放着 —— 单次溺水交给 water_traversal 的换气
                if (record.count < CONFIG.liquidHitThreshold) return;

                const lastL = LiquidEscapeLastTick.get(victim.id) ?? -9999;
                if (nowTick - lastL < CONFIG.liquidCooldownTicks) return;
                LiquidEscapeLastTick.set(victim.id, nowTick);
                LiquidHitMap.set(victim.id, { count: 0, tick: nowTick });

                system.run(() => {
                    try { if (victim && victim.isValid) tryLiquidEscape(victim); } catch (_) {}
                });
                return;
            }
        }

        // 2b. 单纯溺水但不救（开关关掉时）→ 交 water_traversal
        if (cause === DROWNING_CAUSE) return;

        // 3. 普通方块窒息分支
        if (cause !== SUFFOCATION_CAUSE) return;

        // 是否已经被挤进固体方块内部。
        //
        // 「在水里」和「卡在方块里」会同时成立：近战水下冲刺 teleport
        // 落点被方块占据就是这种状态。方块窒息必须找空位钻出去，
        // 靠上浮是出不来的。（insideSolid 在上面已算过，这里直接复用）

        // 这里原先是 `if (liquidState.inLiquid) return;`

        // 那条短路会把「水下被挤进方块」整个挡在门外：
        // 近战水下冲刺 teleport 落点被方块占据时，
        // 实体同时满足 inLiquid（周围是水）和 suffocation（身在方块里），
        // 于是被当成普通溺水跳过，卡在里面一路窒息到死。

        // 改为：只有「确实没卡在固体方块里」才短路。
        if (liquidState.inLiquid && !insideSolid) return;

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
}, AFTER_HURT_PRIORITY.SUFFOCATION_HURT);

suffocationLog("[SuffocationEscape] 防窒息模块已加载");