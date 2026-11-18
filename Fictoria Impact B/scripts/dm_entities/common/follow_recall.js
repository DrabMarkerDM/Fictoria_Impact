/*
 * follow_recall.js — 跟随模式的通用基础设施：模式判定 / 主人解析 / 落点查找 / 超距召回。
 * 单独成文件的理由：这些与载具无关，走路/骑马/坐船都要用，塞进 vehicle_follow 就得每加一种
 * 载具抄一遍。导出四样：`isFollowMode(unit)` 读 `fictoria_ui:mode`；`resolveOwner(unit)`
 * （引擎 tameable 优先、动态属性 ownerId 补录）；`findLandingSpot(entity)` 找一格能站的地面；
 * `refreshMaids() / getMaids()` 有玩家维度里的女仆表（20 tick 一刷，船跟随与召回共用，
 * 不各自 getEntities）。
 * 召回规则：跟随模式 + 没坐在载具上 + 离主人 > 38 格 → 传送到主人旁边。
 * ⚠️ 坐在载具上时必须跳过：骑手 teleport 会直接打断骑乘关系（她自己掉下马）；载具的远距
 * 由 vehicle_follow 的 checkVehicleRescue 传载具（骑手跟着走）。
 * 需要这一层是因为 JSON 的 `minecraft:behavior.follow_owner` 只负责「走」，没有超距兜底 ——
 * 掉进峡谷、绕到山背面、卡在树另一侧时它会一直「正在前往」，表现为「女仆走丢了」。
 */
import { system, world } from "@minecraft/server";

/** 和 fictoria_ui.js 的 MODE / DP 保持一致（那边没导出，照抄字面量）。 */
const MODE_FOLLOW = 0;
const DP_MODE = "fictoria_ui:mode";

/** 女仆实体类型。跟着 maid_registry 那个集合走，新增女仆形态时两边一起加。 */
const MAID_TYPE_IDS = ["player:dm34", "player:dm34_1"];

const CONFIG = {
    /** 女仆表重建周期 */
    scanIntervalTicks: 20,
    /** 召回检查周期（tick）。5 = 0.25 秒，传送这种低频事件足够了 */
    tickIntervalTicks: 5,
    /** 超过这个距离就传送 */
    recallDistance: 38,
    /** 两次召回之间的冷却，防止刚落地又被判超距（跨维度边界/读位置延迟） */
    recallCooldownTicks: 100,
    debug: false,
};

/** id -> 女仆实体 */
const Maids = new Map();

let lastScanTick = -99999;
let lastTick = -99999;

const RecallAt = new Map();

function log(...args) {
    if (CONFIG.debug) {
        console.warn(...args);
    }
}

export function isFollowMode(unit) {
    try {
        return unit.getDynamicProperty(DP_MODE) === MODE_FOLLOW;
    } catch (_) {
        return false;
    }
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
 * 重建女仆表。只扫「有玩家的维度」：跟随 / 召回的前提就是主人在场，没人的维度扫了也用不上，
 * 还白多两次查询。20 tick 一次，和 mount_follow 的骑乘表互不相干（那边只关心带骑乘 tag 的）。
 */
export function refreshMaids(nowTick) {
    if (nowTick - lastScanTick < CONFIG.scanIntervalTicks) return;
    lastScanTick = nowTick;

    const seen = new Set();

    let players;
    try {
        players = world.getAllPlayers();
    } catch (_) {
        return;
    }

    const dims = new Map();

    for (const player of players) {
        try {
            dims.set(player.dimension.id, player.dimension);
        } catch (_) { }
    }

    for (const dim of dims.values()) {
        for (const typeId of MAID_TYPE_IDS) {
            let list;

            try {
                list = dim.getEntities({ type: typeId });
            } catch (_) {
                continue;
            }

            for (const unit of list) {
                try {
                    if (!unit?.isValid) continue;
                } catch (_) {
                    continue;
                }

                seen.add(unit.id);
                Maids.set(unit.id, unit);
            }
        }
    }

    for (const id of [...Maids.keys()]) {
        if (!seen.has(id)) {
            Maids.delete(id);
            RecallAt.delete(id);
        }
    }
}

/** 当前女仆表（只读）。调用方需要最新数据时先调 refreshMaids(nowTick)。 */
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

            // 只有跟随模式才召回：随机 / 巡逻本来就该跑远
            if (!isFollowMode(unit)) continue;

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

    console.warn("[FollowRecall] 跟随超距召回（38 格）已加载");
}
