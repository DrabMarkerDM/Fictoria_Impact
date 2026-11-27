/*
 * chunk_keep.js — 常加载区域（ticking area）的唯一控制点，多个区域并存。
 * 只有本包创建的区域能被 SAPI 查询，/tickingarea 加的区查不到，所以开关必须走这里。
 * 每只干员自己一片，跟着她自己滑动，独立开关 —— 不与别人的合并，也不影响别人的开关。
 * ticking area 不写存档：状态存 world DP，脚本加载后第一个 tick 按 DP 重建。
 * 绑定是实体 id，跨存档失效 → 玩家开启时在干员身上打实体 DP，重载后按标记 + 距离重新分配。
 * 读取侧（attackable_target_manager）只用 getDims / getAnchors，都是内存读，无查询。
 */
import { system, world } from "@minecraft/server";
import { safeRun } from "./safe_exec.js";
import { FEATURE_TYPES, forEachUnitOfTypes } from "./maid_registry.js";
import { t } from "./i18n.js";

const ID_PREFIX = "fictoria_keep_";
const FOLLOW_PREFIX = `${ID_PREFIX}follow_`;
const DP_KEY = "fictoria:chunk_keep";

/**
 * 实体 DP：这只的区块加载开着。跨存档用来找回归属。
 * 只存 1，不存区 id —— 区 id 每次滑动都换，重载后靠距离重新分配。
 */
const FOLLOW_DP = "fictoria:keep_follow";

/** 边界显示开关。存实体自身 DP，实体没了就跟着没了，不需要清理。 */
const BORDER_DP = "fictoria:keep_border";

/** 区域边长（区块）。3×3 = 48×48 格。旧存档里的其他尺寸在 loadState 时按这个降级。 */
const SIZE_PRESETS = [3];
const DEFAULT_SIZE = 3;

/**
 * 每片 3×3 声明 9 区块，但引擎按「唯一区块」计费：同区块两只各开一片，配额仍是 9 而不是 18。
 * 所以重叠区不需要任何合并逻辑。实测 maxChunkCount = 300，30 片全分散开最多 270，留 30 给滑动时的短暂并存。
 */
const MAX_AREAS = 30;

/** 无玩家维度的敌人锚点：区域半宽 + 这个余量。 */
const ANCHOR_MARGIN = 16;

/** 自检周期：区域被外部移除 / 重载后没重建时补一次。 */
const VERIFY_TICKS = 200;

/** 跟随区：检查周期，以及离中心超过多远就搬。搬之前她仍在区内（step < 半宽 - 10）。 */
const SLIDE_TICKS = 10;
/** 连续多少轮读不到她就放弃等下一轮（区留在原地，重进后由 rebindOnce 找回）。 */
const MISS_LIMIT = 20;

/** 重载后找回跟随目标：每 20t 一轮，最多 20 轮（等区块加载 + manager 登记）。 */
const REBIND_TICKS = 20;
const REBIND_ROUNDS = 20;

/** id -> 最后一次读到的位置。区块没加载时 getEntity 摸不到，靠它认出成员在哪。 */
const LastPos = new Map();

/** 跟随区 id 序号：滑动时新旧并存，序号保证 id 不撞。 */
let followSeq = 0;

/** id -> { id, dimId, x0, z0, size, y, radius, ready }。x0/z0 是方块坐标左下角。 */
const Areas = new Map();

let size = DEFAULT_SIZE;

/** 空集常量：无区域时读取侧拿到它们，size 为 0 直接跳过。 */
const EMPTY_DIMS = new Set();
const EMPTY_ANCHORS = [];

let dims = EMPTY_DIMS;
const AnchorMap = new Map();

/** dimId -> [area]：围栏按维度遍历用，重建时一起换，读取侧不碰 Map 遍历。 */
const AreaMap = new Map();

function dimTag(dimId) {
    if (dimId === "minecraft:overworld") return "ow";
    if (dimId === "minecraft:nether") return "ne";
    if (dimId === "minecraft:the_end") return "end";
    return String(dimId).replace(/[^a-z0-9]/gi, "_").slice(0, 12);
}

function cellTag(n) {
    return n < 0 ? `m${-n}` : `${n}`;
}

/** 网格吸附：左下角落在 span 的整数倍上，同一格只可能有一个区域。 */
function gridOf(dimensionId, location, span16) {
    const span = span16 * 16;
    const gx = Math.floor(location.x / span);
    const gz = Math.floor(location.z / span);
    return { gx, gz, x0: gx * span, z0: gz * span, span };
}

function areaId(dimId, gx, gz) {
    return `${ID_PREFIX}${dimTag(dimId)}_${cellTag(gx)}_${cellTag(gz)}`;
}

/** 覆盖判定按矩形，不用网格 —— 移除时玩家可能站在别的尺寸的区域里。 */
function areaAt(dimensionId, location) {
    for (const a of Areas.values()) {
        if (a.dimId !== dimensionId) continue;

        const span = a.size * 16;
        if (location.x >= a.x0 && location.x < a.x0 + span &&
            location.z >= a.z0 && location.z < a.z0 + span) {
            return a;
        }
    }
    return undefined;
}

function buildOptions(area) {
    const span = area.size * 16;
    const y = Math.floor(area.y);

    return {
        dimension: world.getDimension(area.dimId),
        from: { x: area.x0, y: y - 16, z: area.z0 },
        to: { x: area.x0 + span - 1, y: y + 16, z: area.z0 + span - 1 }
    };
}

/** 重建两份读取缓存。区域表变动时调一次，读取侧就不碰 Map 遍历。 */
function rebuildCaches() {
    AreaMap.clear();

    if (Areas.size === 0) {
        dims = EMPTY_DIMS;
        AnchorMap.clear();
        return;
    }

    const nextDims = new Set();
    AnchorMap.clear();

    for (const a of Areas.values()) {
        nextDims.add(a.dimId);

        const half = (a.size * 16) / 2;
        const anchor = {
            x: a.x0 + half,
            y: a.y,
            z: a.z0 + half,
            radius: a.radius
        };

        const list = AnchorMap.get(a.dimId);
        if (list) list.push(anchor);
        else AnchorMap.set(a.dimId, [anchor]);

        const areas = AreaMap.get(a.dimId);
        if (areas) areas.push(a);
        else AreaMap.set(a.dimId, [a]);
    }

    dims = nextDims;
}

/** 绑定标记：重载后靠它认出同一只干员。setDynamicProperty 在 restricted execution 会抛，只从 UI / 定时器调。 */
function markFollow(entityId) {
    if (!entityId) return;

    try {
        const e = world.getEntity(entityId);
        if (e?.isValid) e.setDynamicProperty(FOLLOW_DP, 1);
    } catch (e) {
        console.warn(`[ChunkKeep] 跟随标记写入失败: ${e}`);
    }
}

function unmarkFollow(entityId) {
    if (!entityId) return;

    try {
        const e = world.getEntity(entityId);
        if (e?.isValid && e.getDynamicProperty(FOLLOW_DP) !== undefined) {
            e.setDynamicProperty(FOLLOW_DP, undefined);
        }
    } catch (_) { }
}

/** 这只的边界要不要画。只认实体自身 DP，读不到就当关。 */
export function isBorderOn(entity) {
    if (!entity) return false;

    try {
        return entity.isValid && entity.getDynamicProperty(BORDER_DP) === 1;
    } catch (_) {
        return false;
    }
}

/** on=false 时清 DP，不留 0，省得以后判据要区分 undefined 和 0。 */
export function setBorderOn(entity, on) {
    if (!entity) return false;

    try {
        entity.setDynamicProperty(BORDER_DP, on ? 1 : undefined);
        return true;
    } catch (e) {
        console.warn(`[ChunkKeep] 边界开关写入失败: ${e}`);
        return false;
    }
}

/**
 * 读位置并记进缓存。读得到就以实时位置为准。
 * 走开之后她所在区块不再被加载 → getEntity 摸不到，这时只能信上次的位置；
 * 她在没加载的区块里也不会移动，所以缓存不会过期。
 */
function posOf(entityId, dimId) {
    try {
        const e = world.getEntity(entityId);
        if (e?.isValid) {
            const l = e.location;
            const p = { x: l.x, y: l.y, z: l.z, dimId: e.dimension.id };

            LastPos.set(entityId, p);

            return p;
        }
    } catch (_) { }

    const p = LastPos.get(entityId);

    if (!p) return undefined;
    if (dimId && p.dimId !== dimId) return undefined;

    return p;
}

/** 记一次位置（开启时就写，之后由 posOf 刷新）。 */
function rememberPos(entity) {
    try {
        const l = entity.location;
        LastPos.set(entity.id, { x: l.x, y: l.y, z: l.z, dimId: entity.dimension.id });
    } catch (_) { }
}

function forgetPos(entityId) {
    LastPos.delete(entityId);
}

function saveState() {
    const list = [];

    for (const a of Areas.values()) {
        // 滑动中待删的旧区不写进存档，否则重载会建出两个重叠区
        if (a.dying) continue;

        const half = (a.size * 16) / 2;

        const item = {
            d: a.dimId,
            x: a.x0 + half,
            y: a.y,
            z: a.z0 + half,
            s: a.size
        };

        // 只记「这是跟随区」。绑定的 entityId 跨存档无效，重载后按标记 + 距离重新分配（rebindOnce）
        if (a.isFollow) item.f = 1;

        list.push(item);
    }

    try {
        world.setDynamicProperty(DP_KEY, JSON.stringify({ s: size, a: list }));
    } catch (e) {
        console.warn(`[ChunkKeep] 状态写入失败: ${e}`);
    }
}

/**
 * 删掉滑动时被替换的旧区（表 + 引擎）。
 * 必须独立：新区完成回调有两条出口，以前「新区已被取消」那条直接 return，
 * 旧区就永远留在引擎里 —— 表里也没有它，verify 又跳过 dying，只能重进世界。
 */
function dropPrev(prevId) {
    if (!prevId) return;

    Areas.delete(prevId);

    try {
        const mgr = world.tickingAreaManager;
        if (mgr?.hasTickingArea(prevId)) mgr.removeTickingArea(prevId);
    } catch (e) {
        console.warn(`[ChunkKeep] 旧区移除失败(${prevId}): ${e}`);
    }

    rebuildCaches();
}

/** 建一个区域。同步做容量判断，异步等区块加载。返回 false 表示已回滚。
 *  onReady 在区块真正加载完后调 —— 跟随区靠它在"新区落地"之后才删旧区，中间不留真空。 */
function createArea(area, onReady) {
    let mgr;
    let opts;

    try {
        mgr = world.tickingAreaManager;
        if (!mgr) throw new Error("tickingAreaManager 不可用");

        opts = buildOptions(area);
        if (!opts.dimension) throw new Error(`维度无效: ${area.dimId}`);

        if (mgr.hasTickingArea(area.id)) mgr.removeTickingArea(area.id);
        if (!mgr.hasCapacity(opts)) return false;
    } catch (e) {
        console.warn(`[ChunkKeep] 准备失败(${area.id}): ${e}`);
        return false;
    }

    try {
        mgr.createTickingArea(area.id, opts).then(() => {
            // 加载期间被移除：引擎里已经落地，补删一次；旧区也得跟着走，否则它成永久孤儿
            if (!Areas.has(area.id)) {
                try { mgr.removeTickingArea(area.id); } catch (_) { }
                dropPrev(area.prevId);
                return;
            }

            area.ready = true;

            if (onReady) {
                try { onReady(); } catch (e) { console.warn(`[ChunkKeep] 就绪回调失败(${area.id}): ${e}`); }
            }
        }).catch((e) => {
            Areas.delete(area.id);

            // 滑动建新区失败：复活旧区，否则它挂 dying 卡死（不滑、UI 判未开启、verify 跳过）
            const prev = area.prevId ? Areas.get(area.prevId) : undefined;
            if (prev) {
                prev.dying = false;
                prev.sliding = false;
            }

            // 重载重建失败的保留 DP：否则启动瞬间一次失败就把这个区永久抹掉
            if (!area.restored) saveState();

            rebuildCaches();
            console.warn(`[ChunkKeep] 创建失败(${area.id}): ${e}`);
        });

        return true;
    } catch (e) {
        console.warn(`[ChunkKeep] 调用失败(${area.id}): ${e}`);
        return false;
    }
}

function addArea(dimensionId, location, nextSize, restored) {
    const span16 = SIZE_PRESETS.includes(nextSize) ? nextSize : size;
    const g = gridOf(dimensionId, location, span16);
    const id = areaId(dimensionId, g.gx, g.gz);

    if (Areas.has(id)) return { ok: false, msg: t("fictoria.keep.exists") };
    if (Areas.size >= MAX_AREAS) return { ok: false, msg: t("fictoria.keep.max", MAX_AREAS) };

    const area = {
        id,
        dimId: dimensionId,
        x0: g.x0,
        z0: g.z0,
        size: span16,
        y: typeof location.y === "number" ? location.y : 64,
        radius: span16 * 8 + ANCHOR_MARGIN,
        ready: false,
        restored: !!restored
    };

    Areas.set(id, area);

    if (!createArea(area)) {
        Areas.delete(id);
        return { ok: false, msg: t("fictoria.keep.no_capacity") };
    }

    saveState();
    rebuildCaches();
    return { ok: true, msg: t("fictoria.keep.on_size", span16, span16) };
}

/**
 * 以 loc 所在区块为中心的矩形，取整规则与 buildFollow 完全一致。
 * 中心落在区块边界上（x0/16 是整数），存档往返不漂移。
 */
function followRect(loc, size16) {
    const half = (size16 - 1) / 2;

    return {
        x0: (Math.floor(loc.x / 16) - half) * 16,
        z0: (Math.floor(loc.z / 16) - half) * 16,
        span: size16 * 16
    };
}

/**
 * 跟随区的矩形：以她所在区块为中心，前后各 (size-1)/2 个区块。
 * 每片只装她一只（users 恒为长度 0 或 1）；保留数组是为了重载重绑与滑动期间新旧并存时的归属判断。
 */
function buildFollow(dimId, loc, size16, users, y, restored) {
    const rect = followRect(loc, size16);
    const list = Array.isArray(users) ? users.filter(Boolean) : [];

    return {
        id: `${FOLLOW_PREFIX}${dimTag(dimId)}_${++followSeq}`,
        dimId,
        x0: rect.x0,
        z0: rect.z0,
        size: size16,
        y: typeof y === "number" ? y : (typeof loc.y === "number" ? loc.y : 64),
        radius: size16 * 8 + ANCHOR_MARGIN,
        ready: false,
        restored: !!restored,
        isFollow: true,
        users: list,
        follow: list[0]
    };
}

/** 滑动步长：留 10 格垫底，3×3 是 14、5×5 和 7×7 是 24。 */
function slideStep(area) {
    const half = (area.size * 16) / 2;
    return Math.max(8, Math.min(24, half - 10));
}

/** 新区照原顺序继承绑定。 */
function orderedUsers(area) {
    const lead = area.follow;
    const rest = (area.users ?? []).filter((id) => id && id !== lead);
    return lead ? [lead, ...rest] : rest;
}

/**
 * 跟随区平移：先建新区，等它加载完（onReady）再删旧区。
 * 顺序反了会有一瞬间两个区都不覆盖她，那就是永久冻结。
 */
function slideFollow(area, loc) {
    const oldId = area.id;
    const next = buildFollow(area.dimId, loc, area.size, orderedUsers(area), loc.y);

    // 新区记住旧区 id：任何一条退出路径都要能把旧区带走，否则它成引擎里的孤儿
    next.prevId = oldId;

    // 新区 ready 之前旧区还在表里，必须拦住下一轮，否则每 10 tick 叠一个区
    area.sliding = true;
    area.slideAt = system.currentTick;
    area.dying = true;       // saveState 跳过它，重载不会建出两个重叠区

    Areas.set(next.id, next);
    rebuildCaches();

    const started = createArea(next, () => {
        dropPrev(oldId);
        saveState();
    });

    if (!started) {
        area.sliding = false;
        area.dying = false;
        Areas.delete(next.id);
        rebuildCaches();
        return false;
    }

    return true;
}

/** 建跟随区。**不打实体标记** —— 标记只在玩家点击开启时上（见 enableFollow），重载重建也走这里。 */
function addFollowArea(dimId, loc, size16, users, restored) {
    if (Areas.size >= MAX_AREAS) return { ok: false, msg: t("fictoria.keep.max", MAX_AREAS) };

    const area = buildFollow(dimId, loc, size16, users, undefined, restored);

    Areas.set(area.id, area);

    if (!createArea(area)) {
        Areas.delete(area.id);
        return { ok: false, msg: t("fictoria.keep.no_capacity") };
    }

    saveState();
    rebuildCaches();
    return { ok: true, msg: t("fictoria.keep.on_size", size16, size16) };
}

/**
 * 成员位置的中心。每片只有一只，等价于她的位置；读不到时返回 null。
 * 用 posOf 而不是直接 getEntity：有人走出加载区就摸不到了，只按读得到的算会让区越滑越偏。
 * 返回 null 表示她从没被读到过位置。
 */
function groupCenter(area) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let sumY = 0;
    let count = 0;

    for (const id of area.users ?? []) {
        const p = posOf(id, area.dimId);
        if (!p) continue;

        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;

        sumY += p.y;
        count++;
    }

    if (count === 0) return null;

    return { x: (minX + maxX) / 2, y: sumY / count, z: (minZ + maxZ) / 2 };
}

/** 跟随循环：组中心离区域中心超过步长就搬一次。 */
function slideTick() {
    if (Areas.size === 0) return;

    for (const a of [...Areas.values()]) {
        if (!Areas.has(a.id)) continue;  // 遍历期间可能已被移除
        if (!a.isFollow || (a.users ?? []).length === 0) continue;
        if (!a.ready) continue;          // 上一轮还在加载，别叠加
        if (a.dying) continue;           // 滑动中的旧区，等 onReady 删掉

        // 上一轮滑动的承诺没兑现（既没 then 也没 catch）就先放开，别永久卡住
        if (a.sliding) {
            if (system.currentTick - (a.slideAt ?? 0) > 100) a.sliding = false;
            else continue;
        }

        const center = groupCenter(a);

        // 读不到她：区留原地等人回来，重进后由 rebindOnce 按标记找回
        if (!center) {
            a.miss = (a.miss ?? 0) + 1;
            if (a.miss === MISS_LIMIT) console.warn("[ChunkKeep] 成员失联，区域留在原位");
            continue;
        }

        a.miss = 0;

        const half = (a.size * 16) / 2;
        const dx = center.x - (a.x0 + half);
        const dz = center.z - (a.z0 + half);
        const step = slideStep(a);

        if (dx * dx + dz * dz <= step * step) continue;

        slideFollow(a, center);
    }
}

/** 还有别的区在用它（滑动期间新旧并存时会命中）。 */
function isBoundAnywhere(entityId) {
    for (const a of Areas.values()) if ((a.users ?? []).includes(entityId)) return true;
    return false;
}

function removeArea(area) {
    Areas.delete(area.id);

    // 先解标记再拆区：反了的话归属记录丢了，干员身上会留一个找不到归属的标记。
    // 滑动期间新旧两区并存，同一只可能同时在两边，另一片还在用它就不清。
    for (const id of area.users ?? []) {
        if (isBoundAnywhere(id)) continue;

        unmarkFollow(id);
        forgetPos(id);
    }

    saveState();
    rebuildCaches();

    try {
        const mgr = world.tickingAreaManager;
        if (mgr?.hasTickingArea(area.id)) mgr.removeTickingArea(area.id);
    } catch (e) {
        console.warn(`[ChunkKeep] 移除失败(${area.id}): ${e}`);
    }

    // 关掉的正好是滑动中的新区：旧区还在引擎里，必须一起删，否则关不掉
    dropPrev(area.prevId);
}

/** 自检：区域在就补标记，不在了按原位置重建，重建失败就淘汰。 */
function verify() {
    if (Areas.size === 0) return;

    let mgr;
    try {
        mgr = world.tickingAreaManager;
    } catch (_) {
        return;
    }
    if (!mgr) return;

    for (const a of [...Areas.values()]) {
        if (a.dying) continue;           // 滑动中的旧区，别在这里复活它

        try {
            if (mgr.hasTickingArea(a.id)) {
                a.ready = true;
                continue;
            }
        } catch (_) {
            continue;
        }

        if (!createArea(a)) {
            Areas.delete(a.id);
            if (!a.restored) saveState();
            rebuildCaches();
        }
    }
}

function loadState() {
    let raw;

    try {
        raw = world.getDynamicProperty(DP_KEY);
    } catch (_) {
        return;
    }

    if (typeof raw !== "string" || raw.length === 0) return;

    let o;
    try {
        o = JSON.parse(raw);
    } catch (e) {
        console.warn(`[ChunkKeep] 状态解析失败: ${e}`);
        return;
    }
    if (!o) return;

    if (SIZE_PRESETS.includes(o.s)) size = o.s;

    // 旧格式：单区域 {e,d,x,y,z,s}
    if (o.e && typeof o.d === "string") {
        addArea(o.d, { x: o.x, y: o.y, z: o.z }, size);
        return;
    }

    if (!Array.isArray(o.a)) return;

    for (const it of o.a) {
        if (!it || typeof it.d !== "string") continue;
        if (typeof it.x !== "number" || typeof it.z !== "number") continue;

        const s = SIZE_PRESETS.includes(it.s) ? it.s : size;

        // 跟随区的绑定是实体 id，跨存档无效：先按最后位置重建，后续由 rebindOnce 用 DP 标记 + 距离找回
        if (it.f) addFollowArea(it.d, { x: it.x, y: it.y, z: it.z }, s, [], true);
        else addArea(it.d, { x: it.x, y: it.y, z: it.z }, s, true);
    }
}

/**
 * 一轮重绑：把带标记的干员分配给最近的待绑区。
 * 贪心配对，每只只认一个区 —— 逐区各找最近的话，两只夹在两片中间时会抢同一片。
 * 返回仍未解决的待绑区数，0 表示处理完可以停表。
 */
function rebindOnce() {
    const pending = [];

    for (const a of Areas.values()) {
        if (!a.isFollow || (a.users ?? []).length > 0) continue;
        if (a.ready) pending.push(a);   // 区块没加载完就扫不到人，等下一轮
    }

    if (pending.length > 0) {
        const marked = [];

        forEachUnitOfTypes(FEATURE_TYPES.friendly, (entity) => {
            try {
                if (entity.getDynamicProperty(FOLLOW_DP) !== undefined) marked.push(entity);
            } catch (_) { }
        });

        for (const unit of marked) {
            try {
                const dimId = unit.dimension.id;
                const loc = unit.location;

                let best;
                let bestIdx = -1;
                let bestD = Infinity;

                for (let i = 0; i < pending.length; i++) {
                    const a = pending[i];
                    if (a.dimId !== dimId) continue;

                    const span = a.size * 16;
                    const half = span / 2;
                    const dx = loc.x - (a.x0 + half);
                    const dz = loc.z - (a.z0 + half);
                    const d = dx * dx + dz * dz;

                    // 离太远不认领：她被传走了，或这片本来就不是她的
                    if (d > (half + 16) ** 2) continue;
                    if (d < bestD) { bestD = d; best = a; bestIdx = i; }
                }

                // 每只独立一片，找不到自己的待绑区就放弃：不能塞进别人的片，那是别人的开关
                if (!best) continue;

                best.users = [unit.id];
                best.follow = unit.id;
                rememberPos(unit);
                pending.splice(bestIdx, 1);
                saveState();
            } catch (_) { }
        }
    }

    let left = 0;

    for (const a of Areas.values()) {
        if (a.isFollow && (a.users ?? []).length === 0) left++;
    }

    return left;
}

/** 当前有区域的维度集合。无区域时返回空集。 */
export function getDims() {
    return dims;
}

/** 跟随区矩形快照（画边界用）。跳过滑动中待删的旧区、以及没有成员的片。 */
export function getAreaRects() {
    const out = [];

    for (const a of Areas.values()) {
        if (!a.isFollow || a.dying) continue;
        if ((a.users ?? []).length === 0) continue;

        // ready = 引擎已确认这片落地。滑动中的新区在 promise resolve 之前只在表里，
        // 引擎里还没有它 —— 那时画出来就是画在一个不存在的区上。
        if (!a.ready) continue;

        // unit = 这片的主人。边界模块拿它去读各自的显示开关
        out.push({
            dimId: a.dimId, x0: a.x0, z0: a.z0, span: a.size * 16, unit: a.follow ?? null
        });
    }

    return out;
}

/** 该维度的全部敌人锚点（仅常加载维度、且无玩家时使用）。 */
export function getAnchors(dimKey) {
    return AnchorMap.get(dimKey) ?? EMPTY_ANCHORS;
}

/** 这只在哪片跟随区里。滑动中的旧区不算（它马上被删，关了等于没关）。 */
function areaOfUnit(entityId) {
    if (!entityId) return undefined;

    for (const a of Areas.values()) {
        if (a.isFollow && !a.dying && (a.users ?? []).includes(entityId)) return a;
    }

    return undefined;
}

/**
 * 这只自己登记了区块加载吗。UI 按钮文案用。
 * 只看名册，不看站位 —— 每只独立开关，站进别人的片区不影响自己的按钮。
 */
export function isUnitOn(entity) {
    return !!entity && !!areaOfUnit(entity.id);
}

/** 在带标记的活体里找一只来认领这片区。离得太远不认 —— 她多半是别处的区。 */
function claimableBy(area, marked) {
    const half = (area.size * 16) / 2;
    const limit = (half + 16) ** 2;

    let best;
    let bestD = Infinity;

    for (const e of marked) {
        let dimId;
        let loc;

        try {
            dimId = e.dimension.id;
            loc = e.location;
        } catch (_) {
            continue;
        }

        if (dimId !== area.dimId) continue;
        if (isBoundAnywhere(e.id)) continue;

        const dx = loc.x - (area.x0 + half);
        const dz = loc.z - (area.z0 + half);
        const d = dx * dx + dz * dz;

        if (d > limit) continue;
        if (d < bestD) { bestD = d; best = e; }
    }

    return best;
}

/** 上次清理的 tick：一次批量开关里别每只都扫一遍全服。 */
let lastPruneTick = -999;

/**
 * 清掉「主人已经不在」的跟随区，以及旧版遗留的无主区。
 *
 * 泄漏来源：`/kill`、收回球、旧存档 —— 成员的 id 已经不在世界里，slideTick 靠 LastPos
 * 还能读到「上次的位置」，于是既不滑动也不报错，区一直占着引擎配额（每片 3×3 九个区块）。
 *
 * 判据只认活体名册：users 里还有 id 在 `FEATURE_TYPES.friendly` 里就保留（哪怕她跑出了区）；
 * 全是死 id 就先清空，再交给带 `FOLLOW_DP` 标记的干员按距离认领，认领不到才删。
 * 一只友方都扫不到时整体放弃 —— 那时玩家多半待在没加载的维度，删区会误杀。
 */
export function pruneOrphans() {
    if (system.currentTick - lastPruneTick < 5) return 0;

    lastPruneTick = system.currentTick;

    const live = new Set();
    const marked = [];

    forEachUnitOfTypes(FEATURE_TYPES.friendly, (e) => {
        live.add(e.id);

        try {
            if (e.getDynamicProperty(FOLLOW_DP) !== undefined) marked.push(e);
        } catch (_) { }
    });

    if (live.size === 0) return 0;

    /** 这只还在不在世。名册优先（manager 全类型扫描），名册没刷到时直接按 id 查实体。 */
    const isAlive = (id) => {
        if (!id) return false;
        if (live.has(id)) return true;

        try {
            return !!world.getEntity(id)?.isValid;
        } catch (_) {
            return false;
        }
    };

    let removed = 0;

    for (const a of [...Areas.values()]) {
        if (a.dying || !a.ready || a.sliding) continue;

        // 旧版遗留的「整片加载」区：没有主人，UI 里也看不到、关不掉，纯占配额
        if (!a.isFollow) {
            removeArea(a);
            removed++;
            continue;
        }

        const users = a.users ?? [];

        if (users.some(isAlive)) continue;

        // 老记录里的 id 全都不在了：先清空，再按标记尝试认领（重进存档后 users 本来就是空的）
        a.users = [];
        a.follow = null;

        const owner = claimableBy(a, marked);

        if (owner) {
            a.users = [owner.id];
            a.follow = owner.id;
            rememberPos(owner);
            saveState();
            continue;
        }

        removeArea(a);
        removed++;
    }

    if (removed > 0) console.warn(`[ChunkKeep] 清理无主区 ${removed} 片`);

    return removed;
}

/** 按 loc 新建一片（每只自己一片，不与别人的合并）。玩家点开启、重载重绑都走这里。 */
function attach(entityId, loc, dimId) {    const r = addFollowArea(dimId, loc, size, [entityId]);

    // 首次开启才上 DP：这是「这只被玩家选中跟着加载」的唯一写入点
    if (r.ok) markFollow(entityId);

    return { ...r, count: 1 };
}

/** 给一只干员开区块加载。她自己一片，不与别人的合并，也不影响别人的开关。 */
export function enableFollow(player, unit) {
    if (!player || !unit) return { ok: false, msg: t("fictoria.keep.no_unit") };

    let dimId;
    let loc;

    try {
        dimId = unit.dimension.id;
        loc = unit.location;
    } catch (e) {
        return { ok: false, msg: t("fictoria.keep.pos_fail") };
    }

    if (areaOfUnit(unit.id)) return { ok: false, msg: t("fictoria.keep.already") };

    rememberPos(unit);
    return attach(unit.id, loc, dimId);
}

/**
 * 实体要消失（收回球 / 死亡）时把它那片区摘掉，静默、不播报。
 * 不摘的话 members 全失效，slideTick 只在 miss 到上限时打一行日志，区会永久留在
 * Areas 与 world DP 里 —— 每收回一次堆一片，攒到 MAX_AREAS 就再也开不了新的。
 */
export function releaseFor(entity) {
    if (!entity) return false;

    const area = areaOfUnit(entity.id);

    if (!area) return false;

    removeArea(area);
    return true;
}

/** 关掉这只自己那片。每只独立，不动别人的区。 */
export function disableFor(entity) {
    if (!entity) return { ok: false, msg: t("fictoria.keep.no_unit") };

    const area = areaOfUnit(entity.id);

    if (!area) return { ok: false, msg: t("fictoria.keep.not_on") };

    removeArea(area);

    return { ok: true, msg: t("fictoria.keep.off") };
}

/** 表单展示用快照。chunkCount / maxChunkCount 是引擎实际配额。 */
export function getInfo(player) {
    let chunkCount = -1;
    let maxChunkCount = -1;

    try {
        const mgr = world.tickingAreaManager;
        if (mgr) {
            chunkCount = mgr.chunkCount;
            maxChunkCount = mgr.maxChunkCount;
        }
    } catch (_) { }

    const list = [];
    for (const a of Areas.values()) {
        const half = (a.size * 16) / 2;
        list.push({
            dimId: a.dimId,
            x: Math.floor(a.x0 + half),
            z: Math.floor(a.z0 + half),
            size: a.size,
            ready: a.ready,
            isFollow: !!a.isFollow,
            users: (a.users ?? []).length,
            follow: a.follow ?? null
        });
    }

    let here;
    if (player) {
        try {
            here = areaAt(player.dimension.id, player.location);
        } catch (_) { }
    }

    return {
        count: Areas.size,
        size,
        chunkCount,
        maxChunkCount,
        areas: list,
        coveredHere: !!here,
        hereSize: here ? here.size : 0
    };
}

export function initChunkKeep() {
    // tickingAreaManager 在 early execution 不可读，排到第一个 tick 再读 DP 重建
    system.run(() => {
        loadState();
        rebuildCaches();
        system.runInterval(verify, VERIFY_TICKS);
        system.runInterval(() => safeRun("chunk_keep.slide", slideTick), SLIDE_TICKS);

        // 待绑的跟随区：等区块加载完、manager 登记完，按实体 DP 找回原目标
        let rounds = 0;

        const timer = system.runInterval(() => {
            const pending = safeRun("chunk_keep.rebind", rebindOnce, -1);

            if (pending === 0 || ++rounds >= REBIND_ROUNDS) system.clearRun(timer);
        }, REBIND_TICKS);
    });

    console.warn("[ChunkKeep] 常加载区块控制已加载");
}
