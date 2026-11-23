/*
 * follow_recall.js — 跟随模式的通用基础设施：模式判定 / 主人解析 / 落点查找 / 超距召回。
 * 单独成文件的理由：这些与载具无关，走路/骑马/坐船都要用，塞进 vehicle_follow 就得每加一种
 * 载具抄一遍。导出：`isFollowMode(unit)` 只看 UI 的 `fictoria_ui:mode`；`isFollowing(unit)` 是
 * 完整判据（UI 跟随 或 背包里有该干员的指令物品）；`resolveOwner(unit)`；`findLandingSpot(entity)`；
 * `refreshMaids() / getMaids()` 干员表（船跟随 / 骑马跟随 / 召回共用）。名单不自己扫：取自 manager
 * 的登记表（maid_registry.js 的 FEATURE_TYPES.friendly = DmTargetRegistry 全量干员），
 * 由 attackable_target_manager 每 5 tick 顺手登记。
 * 召回规则：跟随 + 没坐在载具上 + 离主人 > 38 格 → 传送到主人旁边。**全干员生效**，38 格只是兜底：
 * 引擎 `follow_owner` 14~20 格就先瞬移一次，只有 follow 组被摘掉的状态（采集 / 做饭 / 坐下）才轮得到它。
 *
 * ⚠️ resolveOwner 的两路：`minecraft:tameable` 在 `ta` 组里，`on_tame` 第一件事就是 remove 它，
 * 所以驯服后这个组件其实不存在，实际全靠 `ownerId` 动态属性（manager 在 on_tame / 交互 / 受击
 * 三处补录）。保留 tameable 那一路只为兼容没摘组的老存档实体。
 * ⚠️ 坐在载具上时必须跳过：骑手 teleport 会直接打断骑乘关系（她自己掉下马）；载具的远距
 * 由 vehicle_follow 的 checkVehicleRescue 传载具（骑手跟着走）。
 * 需要这一层是因为 JSON 的 `minecraft:behavior.follow_owner` 只负责「走」，没有超距兜底 ——
 * 掉进峡谷、绕到山背面、卡在树另一侧时它会一直「正在前往」，表现为「女仆走丢了」。
 */
import { system, world } from "@minecraft/server";
// 名单的唯一来源：manager 的登记表（全干员），本文件不再自己 getEntities
import { FEATURE_TYPES, forEachUnitOfTypes } from "../core/maid_registry.js";

/** 和 fictoria_ui.js 的 MODE / DP 保持一致（那边没导出，照抄字面量）。 */
const MODE_FOLLOW = 0;
const MODE_RANDOM = 1;
const MODE_PATROL = 2;
const DP_MODE = "fictoria_ui:mode";

/**
 * 各干员的「跟随指令物品」。与 fictoria_ui 的 commandItemOverrides / defaultCommandItem 同源：
 * dm34 系用 maid_command，其余一律 follow_command（JSON 的 `follow_test` 传感器也是这个判据）。
 * ⚠️ 新增例外表时两边一起改，`tools/dm34/test_registry.mjs` 有静态断言盯着。
 */
const COMMAND_OVERRIDES = {
    "player:dm34": "item:maid_command",
    "player:dm34_1": "item:maid_command",
};
const DEFAULT_COMMAND = "item:follow_command";

const CONFIG = {
    /** 干员表重建周期（同时重算跟随标志） */
    scanIntervalTicks: 20,
    /** 召回检查周期（tick）。5 = 0.25 秒，传送这种低频事件足够了 */
    tickIntervalTicks: 5,
    /** 超过这个距离就传送 */
    recallDistance: 38,
    /** 两次召回之间的冷却，防止刚落地又被判超距（跨维度边界/读位置延迟） */
    recallCooldownTicks: 100,
    debug: false,
};

/** id -> 干员实体 */
const Maids = new Map();

/** id -> 是否跟随（每 scanIntervalTicks 重算一次；tick 侧只读这个 Map） */
const FollowFlags = new Map();

/** id -> { at, has }：指令物品判定缓存（容器没有变化事件，只能轮询） */
const ItemCache = new Map();

let lastScanTick = -99999;
let lastTick = -99999;

const RecallAt = new Map();

function log(...args) {
    if (CONFIG.debug) {
        console.warn(...args);
    }
}

/** 这只干员判跟随用哪枚道具（与 fictoria_ui 的 commandIdOf 同源） */
function commandItemOf(typeId) {
    return COMMAND_OVERRIDES[typeId] ?? DEFAULT_COMMAND;
}

/** 背包里有没有那枚指令物品。dm3/dm12 是 horse 型容器（0 号马鞍位），扫全格无副作用。 */
function hasCommandItem(unit) {
    const want = commandItemOf(unit.typeId);
    if (!want) return false;

    let inv;
    try {
        inv = unit.getComponent("minecraft:inventory")?.container;
    } catch (_) {
        return false;
    }
    if (!inv) return false;

    try {
        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === want) return true;
        }
    } catch (_) {
        return false;
    }
    return false;
}

/** 只看 UI 写的模式 */
export function isFollowMode(unit) {
    try {
        return unit.getDynamicProperty(DP_MODE) === MODE_FOLLOW;
    } catch (_) {
        return false;
    }
}

/**
 * 「她在跟随」的完整判据：
 *   ① UI 写过 mode=0 → 跟随
 *   ② UI 写过 mode=1/2 → 明确不跟随（随机 / 巡逻本来就该跑远，不能拉回来）
 *   ③ UI 从没写过（undefined）→ 看引擎的 follow_owner 组，再看背包里的指令物品
 *      —— 覆盖「拿 follow_command / maid_command 直接切跟随、没经 UI」的老玩家，
 *         以及 dm3 / dm12 这类用原版 order 走的干员。
 * 结果缓存在 FollowFlags（refreshMaids 每 20 tick 重算），tick 侧零容器读。
 */
function computeFollowing(unit, nowTick) {
    let mode;
    try {
        mode = unit.getDynamicProperty(DP_MODE);
    } catch (_) {
        return false;
    }

    if (mode === MODE_FOLLOW) return true;
    if (mode === MODE_RANDOM || mode === MODE_PATROL) return false;

    // UI 没写过（老存档 / 原版 order 直接切的），与 fictoria_ui.isFollowing 同判据：
    // ① 引擎的 follow_owner 组还在 = 跟随（dm34 采集 / 做饭 / 坐下会把这个组摘掉）
    try {
        if (unit.hasComponent("minecraft:behavior.follow_owner")) return true;
    } catch (_) { }

    // ② 组还没挂上也可能是刚切过来（事件延迟）：看背包里的指令物品
    const cached = ItemCache.get(unit.id);
    if (cached !== undefined && nowTick - cached.at < CONFIG.scanIntervalTicks) return cached.has;

    const has = hasCommandItem(unit);
    ItemCache.set(unit.id, { at: nowTick, has });
    return has;
}

/** 她现在是不是跟随（UI 或指令物品）。未进表的实体即时算一次，不进缓存。 */
export function isFollowing(unit) {
    let id;
    try {
        id = unit.id;
    } catch (_) {
        return false;
    }

    const cached = FollowFlags.get(id);
    if (cached !== undefined) return cached;

    return computeFollowing(unit, system.currentTick);
}

/**
 * 主人解析：引擎 tameable 优先，动态属性 ownerId 只作补录。
 * 顺序不能反 —— ownerId 是「谁先碰写谁」，多人生存里会被别人写脏。
 */
export function resolveOwner(unit) {
    try {
        const tamedId = unit.getComponent("minecraft:tameable")?.tamedToPlayerId;

        if (tamedId) {
            const player = world.getEntity(tamedId);

            if (player?.isValid) return player;
        }
    } catch (_) { /* 组件不可用 / 玩家离线 */ }

    try {
        const dpId = unit.getDynamicProperty("ownerId");

        if (typeof dpId === "string" && dpId.length > 0) {
            const player = world.getEntity(dpId);

            if (player?.isValid) return player;
        }
    } catch (_) { }

    return undefined;
}

/*
 * 在目标实体周围找一格能站的地面。优先 2 格，其次 3 格，最后 1 格；八个方向挨个试。
 * 判定：目标格与上面一格都是空气，下面一格是实心。找不到就退回她/主人脚下 —— 传送总比
 * 留在原地强。
 */
export function findLandingSpot(entity) {
    const base = entity.location;
    const dim = entity.dimension;

    for (const radius of [2, 3, 1]) {
        for (let i = 0; i < 8; i++) {
            const angle = (Math.PI / 4) * i;
            const x = Math.floor(base.x + Math.cos(angle) * radius);
            const z = Math.floor(base.z + Math.sin(angle) * radius);
            const y = Math.floor(base.y);

            try {
                const feet = dim.getBlock({ x, y, z });
                const head = dim.getBlock({ x, y: y + 1, z });
                const below = dim.getBlock({ x, y: y - 1, z });

                if (!feet || !head || !below) continue;
                if (!feet.isAir || !head.isAir) continue;
                if (below.isAir || below.isLiquid) continue;

                return { x: x + 0.5, y, z: z + 0.5 };
            } catch (_) {
                // 该格不可读（未加载区块）→ 换下一个
            }
        }
    }

    return { x: base.x, y: base.y, z: base.z };
}

/*
 * 重建干员表：名单直接取 manager 的登记表（FEATURE_TYPES.friendly = 配置表全量干员），零查询。
 * 登记表每 5 tick 全量重建一次，实体引用本来就是新鲜的；这里 20 tick 同步一次：
 * ① 把「已不在表里」的 id 连同召回冷却一起清掉 ② 顺手重算各自的跟随标志（containers 只能轮询）。
 */
export function refreshMaids(nowTick) {
    if (nowTick - lastScanTick < CONFIG.scanIntervalTicks) return;
    lastScanTick = nowTick;

    const seen = new Set();

    forEachUnitOfTypes(FEATURE_TYPES.friendly, (unit) => {
        let id;
        try {
            id = unit.id;
        } catch (_) {
            return;
        }
        seen.add(id);
        Maids.set(id, unit);
        FollowFlags.set(id, computeFollowing(unit, nowTick));
    });

    for (const id of [...Maids.keys()]) {
        if (!seen.has(id)) {
            Maids.delete(id);
            RecallAt.delete(id);
            FollowFlags.delete(id);
            ItemCache.delete(id);
        }
    }
}

/** 当前干员表（只读）。调用方需要最新数据时先调 refreshMaids(nowTick)。 */
export function getMaids() {
    return Maids;
}

function ridingOn(unit) {
    try {
        return unit.getComponent("minecraft:riding")?.entityRidingOn;
    } catch (_) {
        return undefined;
    }
}

function recall(unit, owner, nowTick) {
    const last = RecallAt.get(unit.id) ?? -99999;

    if (nowTick - last < CONFIG.recallCooldownTicks) return false;

    RecallAt.set(unit.id, nowTick);

    const spot = findLandingSpot(owner);

    try {
        unit.teleport(spot, { dimension: owner.dimension });
        log(`[FollowRecall] ${unit.typeId} 超距召回 (${unit.id})`);
        return true;
    } catch (e) {
        log(`[FollowRecall] ${unit.typeId} 召回失败: ${e}`);
        return false;
    }
}

function tick() {
    const nowTick = system.currentTick;

    if (nowTick === lastTick) return;
    lastTick = nowTick;

    refreshMaids(nowTick);

    for (const [id, unit] of Maids) {
        try {
            if (!unit?.isValid) {
                Maids.delete(id);
                RecallAt.delete(id);
                continue;
            }

            // 跟随才召回：随机 / 巡逻本来就该跑远；UI 没写过 mode 的看指令物品
            if (!isFollowing(unit)) continue;

            // 坐在载具上绝对不传 —— 会断骑乘，交给载具那边传
            const mount = ridingOn(unit);

            if (mount && mount.isValid) continue;

            const owner = resolveOwner(unit);

            if (!owner || !owner.isValid) continue;
            // 跨维度（主人进了下界）不处理：那是传送门的事，硬传会把人拉回来
            if (owner.dimension.id !== unit.dimension.id) continue;

            const dx = owner.location.x - unit.location.x;
            const dz = owner.location.z - unit.location.z;
            const dist = Math.hypot(dx, dz);

            if (dist <= CONFIG.recallDistance) continue;

            recall(unit, owner, nowTick);
        } catch (_) {
            // 单只异常不拖垮整轮
        }
    }
}

export function initFollowRecall() {
    system.runInterval(tick, CONFIG.tickIntervalTicks);

    // 启动横幅默认打开；其余召回日志仍归 CONFIG.debug
    console.warn("[FollowRecall] 跟随超距召回（38 格）已加载");
}
