/*
 * farm_fortune.js — 耕地时运补偿（方块快照归因）。
 * 不走事件：@minecraft/server 2.7 没有 itemSpawn；entityItemDrop 只在实体主动丢物品时派发，
 * harvest_farm_block 的作物掉落走方块 loot 表，不触发它。所以改成看她脚下的方块：variant=5 时
 * 每 4 tick 扫一次 7×7×3，记一帧快照 —— 作物记 (typeId, growth)，耕地/灵魂沙记 soil，空气记 air
 * （播种判据要靠「明确的空气」，否则分不清刚种下与区块刚加载）。
 * 收获方向（三种转移，全部朝「变少」）：① 作物 → 空气（西瓜/南瓜由 break_blocks 破坏，或收货后
 * 不补种）；② 作物 → 别的方块；③ 作物 → growth 变小（收完立刻补种回幼苗，最常见）。判据取
 * growth 变小而不是同格 id，所以不用维护成熟度表（各作物上限不一）。
 * 播种方向：空气 → 作物且脚下是耕地/灵魂沙 —— 播动作，不补时运（没产出）。
 * 🔴 作物长在耕地上一格，判据必须跨格看脚下（soilUnder）。
 * 🔴 growth 变大一律不认：催熟是刻意设计的能力（grows_crop charges 13 / chance 0.25 +
 * behavior.fertilize_farm_block），能让 growth 一帧跳好几级；把「单帧跳 ≥2」当撒骨粉会变成动画
 * 永动机。催熟照旧工作，只是不逐次配动作。
 * 🔴 南瓜 / 西瓜的 block state 没有 growth（只有 cardinal_direction），growthOf 返回 undefined；
 * 同 id 时只认「变小」，其余 continue —— 否则田里摆一块南瓜就每 4 tick 白补一次时运。
 * 玩家干扰：判据完全不看物品实体，唯一能骗过它的是玩家在旁边手动收同一茬，所以用
 * playerCloserTo() —— 只有她比玩家离那块地更近时才补。
 * 补量：不区分原版口径，所有作物（含 wheat / beetroot / pumpkin 主产物）一律吃时运，每个产物
 * 各掷一次 rand(0, L)。
 * 可观测性：armed / tracking（扫到几株）/ harvest 各留一行，共 12 条配额后静默 —— 前两版之所以能
 * 静默空转，就是因为没生效时日志里连个响都没有。
 */

import { ItemStack, system } from "@minecraft/server";
import { variantOf } from "../core/maid_state.js";
import { enchLevelOf } from "../inventory/enchant.js";
import { storedFarmTool } from "../inventory/farm_store.js";
import { forEachMaid } from "../../common/core/maid_registry.js";
import { swingFarm, forgetFarmSwing, pruneFarmSwing } from "./farm_anim.js";

/** 耕地态。与 interact_router / gather 里那套 variant 编号一致 */
const FARM_VARIANT = 5;

/** 扫描节奏与窗口 */
const SCAN_INTERVAL = 4;      // tick
const R = 3;                  // 水平半径（她收获时一定贴着方块，3 格足够）
const Y_LO = -1;              // 垂直窗：作物可能和她同层，也可能低一层（她站在路上）
const Y_HI = 1;
const MAX_MAIDS = 4;          // 单轮最多扫几只，防她自己开一队

/*
 * 作物方块 → 产物 id 列表。
 * 🔴 键是方块 id，不是物品 id。基岩里两者常常不同名：`minecraft:carrots` / `minecraft:potatoes`
 * （方块）vs `minecraft:carrot` / `minecraft:potato`（物品）；`minecraft:melon_block`（方块）vs
 * `minecraft:melon_slice`（物品）。两个写法都放进表里（别名），省得靠记忆赌哪一个 —— 猜错的
 * 表现是「这一种作物永远不补」。
 * `minecraft:melon_block` / `minecraft:pumpkin` 由 farm 组的 `minecraft:break_blocks` 破坏
 * （dm34.json 实锤），也走这条补量。
 */
const CROP_DROPS = new Map([
    ["minecraft:wheat", ["minecraft:wheat", "minecraft:wheat_seeds"]],
    ["minecraft:carrots", ["minecraft:carrot"]],
    ["minecraft:carrot", ["minecraft:carrot"]],              // 方块别名兜底
    ["minecraft:potatoes", ["minecraft:potato"]],
    ["minecraft:potato", ["minecraft:potato"]],              // 方块别名兜底
    ["minecraft:beetroot", ["minecraft:beetroot", "minecraft:beetroot_seeds"]],
    ["minecraft:nether_wart", ["minecraft:nether_wart"]],
    ["minecraft:cocoa", ["minecraft:cocoa_beans"]],
    ["minecraft:melon_block", ["minecraft:melon_slice"]],
    ["minecraft:pumpkin", ["minecraft:pumpkin"]],
    ["minecraft:sweet_berry_bush", ["minecraft:sweet_berries"]],
    ["minecraft:torchflower_crop", ["minecraft:torchflower", "minecraft:torchflower_seeds"]],
    ["minecraft:pitcher_crop", ["minecraft:pitcher_plant", "minecraft:pitcher_pod"]],
]);

/** 生长值所在的 state 名。基岩全量作物只用这两个之一。 */
const GROWTH_STATES = ["growth", "age"];

/*
 * 可种植基质。
 * 🔴 作物不在耕地那一格，长在耕地上一格。所以「播种」不是同格转移，而是：上一帧这格是空气 +
 * 脚下是耕地 → 这一帧这格长出作物。这就是扫描时为什么还要把空气也记进快照 —— 空气从「没有数据」
 * 变成「明确记录的一格」，判据才能写成 `p.air → 作物`；否则只能拿「prev 里没有这个 key」当证据，
 * 而那既可能是「刚种下」也可能是「区块刚加载」，两者分不开。
 * `minecraft:farmland` 湿润与否只是 `moisturized_amount` state，id 不变；`minecraft:soul_sand` 是
 * 下界疣的基质。
 */
const SOIL_BLOCKS = new Set(["minecraft:farmland", "minecraft:soul_sand"]);

/*
 * 播种后会出现的方块。基本就是 `CROP_DROPS` 的键，但要额外补两种秧苗：西瓜 / 南瓜种下去长的是
 * stem，不是瓜本体 —— stem 不产掉落（所以不在 CROP_DROPS 里），但它确实是「她种下了一株」，
 * 该有动作。收瓜时才走 melon_block / pumpkin 的补量。
 */
const SOW_TARGETS = new Set([
    ...CROP_DROPS.keys(),
    "minecraft:melon_stem",
    "minecraft:pumpkin_stem",
]);

/** 限流日志（同 key 最多 3 条）。不许空 catch —— 不补时至少留一行。 */
const errSeen = new Map();
function logErr(key, e) {
    const n = (errSeen.get(key) || 0) + 1;
    errSeen.set(key, n);
    if (n > 3) return;
    const msg = e && e.message ? e.message : String(e);
    try { console.warn(`[dm34/farm_fortune] ${key}: ${msg}`); } catch (e2) { /* 控制台都没了 */ }
}

/** 连通性探针：前 12 条，之后静默。见文件头「可观测性」。 */
/** 本文件日志开关（只影响 farm_fortune.js）。排查耕地时运有没有生效时打开 */
const LOG_TRACE = false;
let traceLeft = 12;
function trace(msg) {
    if (!LOG_TRACE || traceLeft <= 0) return;
    traceLeft--;
    try { console.warn(`[dm34/farm_fortune] ${msg}`); } catch (e) { /* 忽略 */ }
}

function growthOf(block) {
    let perm;
    try { perm = block.permutation; } catch (e) { return undefined; }
    if (!perm) return undefined;
    for (const name of GROWTH_STATES) {
        try {
            const v = perm.getState(name);
            if (typeof v === "number") return v;
        } catch (e) { /* 该方块没有这个 state —— 正常，换下一个 */ }
    }
    return undefined;
}

function posKey(x, y, z) {
    return x + "," + y + "," + z;
}

/** maidId → { snap: Map<key, {x,y,z,id,g}>|null, miss: number } */
const trackers = new Map();

/** 一株被收了：按产物表补时运量 */
let noLuckLogged = 0;
function onHarvest(maid, dim, p) {
    const tool = storedFarmTool(maid);
    const lvl = tool ? enchLevelOf(tool, "fortune") : 0;
    if (lvl <= 0) {
        // 没有时运锄就什么都不做。只留前 2 行 —— 否则一把无附魔锄头会把 12 条配额打光，
        // 之后真命中时反而看不到日志。
        if (noLuckLogged < 2) {
            noLuckLogged++;
            trace(`harvest ${p.id} @${p.x},${p.y},${p.z}（无时运锄，跳过）`);
        }
        return;
    }

    const outs = CROP_DROPS.get(p.id);
    if (!outs) return;

    let given = 0;
    for (const oid of outs) {
        const extra = Math.floor(Math.random() * (lvl + 1));   // 0 .. L，0 就是不补
        if (extra <= 0) continue;
        try {
            dim.spawnItem(new ItemStack(oid, extra), {
                x: p.x + 0.5, y: p.y + 0.45, z: p.z + 0.5,
            });
            given += extra;
        } catch (e) {
            logErr("spawn", e);
        }
    }
    trace(`harvest ${p.id} @${p.x},${p.y},${p.z} L=${lvl} +${given}`);
}

/**
 * 这个位置是不是**玩家**比女仆离得更近。
 *
 * 用来挡掉"玩家蹲在她旁边手动收同一块地"：玩家自己已经拿到了引擎掉落，
 * 脚本再补一份就是白送。判据是距离比较而不是绝对阈值 —— 她收获时一定贴到
 * 方块旁边（`move_to_block` 的语义），玩家在她外侧看是正常的，不会被误挡。
 */
function playerCloserTo(dim, bx, by, bz, maidDist) {
    const cx = bx + 0.5, cy = by + 0.5, cz = bz + 0.5;
    let players;
    try {
        players = dim.getPlayers({ location: { x: cx, y: cy, z: cz }, maxDistance: 4 });
    } catch (e) {
        return false;                 // 查不到就按"不是玩家"处理，宁可多补也不漏补
    }
    if (!players || !players.length) return false;

    for (const pl of players) {
        let l;
        try { l = pl.location; } catch (e) { continue; }
        if (!l) continue;
        const d = Math.hypot(l.x - cx, l.y - cy, l.z - cz);
        // 0.5 的容差：玩家和她都在同一块地旁边时不要误判
        if (d < maidDist - 0.5) return true;
    }
    return false;
}

/**
 * 这个位置**脚下**是不是可种植基质（耕地 / 灵魂沙）。
 *
 * 播种判据必须跨格看：作物长在耕地上一格，所以"这一格从空气变成作物"时，
 * 下面那一格才是证据。独立查而不是从快照里取 —— 作物可能在扫描窗口下沿，
 * 它的基质就落在窗口外了。
 */
function soilUnder(dim, x, y, z) {
    try {
        const b = dim.getBlock({ x, y: y - 1, z });
        return !!(b && SOIL_BLOCKS.has(b.typeId));
    } catch (e) {
        return false;     // 未加载 / 越界
    }
}

/** 扫一只：出这一帧的快照，跟上一帧比，补时运 + 触发挥锄动作 */
function scanOne(maid) {
    let loc, dim, maidId;
    try {
        loc = maid.location;
        dim = maid.dimension;
        maidId = maid.id;
    } catch (e) { return; }
    if (!loc || !dim || !maidId) return;

    const base = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) };

    let tr = trackers.get(maidId);
    if (!tr) { tr = { snap: null, miss: 0 }; trackers.set(maidId, tr); }
    tr.miss = 0;

    const next = new Map();
    let cropCells = 0, soilCells = 0;
    for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
            for (let dy = Y_LO; dy <= Y_HI; dy++) {
                const bx = base.x + dx, by = base.y + dy, bz = base.z + dz;
                let b;
                try { b = dim.getBlock({ x: bx, y: by, z: bz }); } catch (e) { continue; }
                if (!b) continue;                                  // 区块没加载 / y 越界

                let tid;
                try { tid = b.typeId; } catch (e) { continue; }
                const isCrop = CROP_DROPS.has(tid);
                const isSoil = !isCrop && SOIL_BLOCKS.has(tid);
                // 空气也要记：播种判据是 `空气 → 作物`，没有"明确的空气"这一帧就写不出来
                const isAir = !isCrop && !isSoil && tid === "minecraft:air";
                if (!isCrop && !isSoil && !isAir) continue;

                if (isCrop) cropCells++;
                else if (isSoil) soilCells++;
                next.set(posKey(bx, by, bz), {
                    x: bx, y: by, z: bz, id: tid,
                    g: isCrop ? growthOf(b) : undefined,
                    soil: isSoil ? 1 : 0,
                    air: isAir ? 1 : 0,
                });
            }
        }
    }

    const prev = tr.snap;
    const firstFrame = prev === null;
    /** 这一帧她"动了手"→ 末尾播一次挥锄。同一帧最多一次（动画 override 会重头播，会抖）。 */
    let acted = false;

    if (prev && prev.size) {
        for (const [, p] of prev) {
            // 只比对**这一帧仍在窗口内**的位置。她走开导致的"整片消失"不是收获。
            const dx = p.x - base.x, dy = p.y - base.y, dz = p.z - base.z;
            if (dx < -R || dx > R || dz < -R || dz > R || dy < Y_LO || dy > Y_HI) continue;

            const cur = next.get(posKey(p.x, p.y, p.z));

            // 基质本身的变化（耕地被踩坏 / 被挖走）不算她干活
            if (p.soil) continue;

            // ── 播种：上一帧这格是**空气**，这一帧长出作物，且**脚下是耕地/灵魂沙** ──
            // 🔴 作物长在耕地**上一格**，所以判据必须跨格看脚下，不能只比同格 id。
            //    "明确的空气 → 作物"还顺带排除了区块刚加载 —— 那种情况 prev 里根本没这一格
            //    的 key，走不到这里（以前 cur 为 undefined 会被当成"变空气"误判收获）。
            //    播种不产生掉落，**不补时运**，只播一个挥锄动作。
            if (p.air) {
                if (cur && !cur.air && !cur.soil && SOW_TARGETS.has(cur.id)
                    && soilUnder(dim, p.x, p.y, p.z)) {
                    const sd = Math.hypot(
                        loc.x - (p.x + 0.5), loc.y - (p.y + 0.5), loc.z - (p.z + 0.5),
                    );
                    if (!playerCloserTo(dim, p.x, p.y, p.z, sd)) acted = true;
                }
                continue;   // 空气位置不存在"收获"，到这里就结束
            }

            // 这一格这一帧没扫到 = 区块未加载 / y 越界，不是"变空气"。
            // 真正的"作物被收走"现在会读到 `minecraft:air` 对象，不会走到这里。
            // 少了这一行，她贴着未加载区块边缘时每 4 tick 白补一次 + 白挥一次。
            if (!cur) continue;

            // 同一个方块还在 → **只有 growth 变小**才放行（= 收了 / 收完补种回幼苗）。
            // 🔴 growth 变大（自然随机刻、grows_crop 自动催熟、fertilize_farm_block 施肥）
            //    一律跳过：那是背景自动行为，不是她挥了一锄，不该有动作。
            // 🔴 growth 读不出来（南瓜 / 西瓜没有 growth state）也跳过：以前这里会漏到
            //    下面的收获分支，导致田里有南瓜时每 4 tick 白补一次 + 白挥一次。
            if (cur && cur.id === p.id) {
                if (!(typeof cur.g === "number" && typeof p.g === "number" && cur.g < p.g)) continue;
            }
            // 走到这里只剩三种转移（全部朝"变少"方向）：
            //   ① cur 是空气   —— 收走了没补种（西瓜/南瓜，或收完不 replant 的作物）
            //   ② cur.id 变了  —— 原地换成了别的方块（她补种成另一种 / 被踩成耕地）
            //   ③ cur.g < p.g  —— 收完立刻补种回幼苗（上一段放行的）
            // 三种都只在"她比玩家离这块地更近"时认 —— 玩家蹲在她旁边手动收的不补，
            // 否则玩家自己已经拿到引擎掉落，脚本再补就是白送一份。
            const maidDist = Math.hypot(
                loc.x - (p.x + 0.5), loc.y - (p.y + 0.5), loc.z - (p.z + 0.5),
            );
            if (playerCloserTo(dim, p.x, p.y, p.z, maidDist)) continue;
            try { onHarvest(maid, dim, p); } catch (e) { logErr("harvest", e); }
            acted = true;
        }
    }

    tr.snap = next;

    // 首次给这只建快照时打一行：能看到"确实在扫、窗口里扫到 N 个作物 / 多少块耕地"。
    // crops=0 且 soil=0 就是最有用的一条 —— 她不在菜地，问题不在这个模块。
    if (firstFrame) {
        trace(`tracking ${String(maidId).slice(0, 8)} crops=${cropCells} soil=${soilCells} @${base.x},${base.y},${base.z}`);
    }

    if (acted) swingFarm(maid);
}

function tickScans() {
    let budget = MAX_MAIDS;
    forEachMaid((maid) => {
        if (budget <= 0) return;

        let v;
        try { v = variantOf(maid); } catch (e) { return; }
        if (v !== FARM_VARIANT) {
            // 离开耕地态：快照立刻丢掉，免得下次进形态拿旧帧比出"一整片收获"
            try { trackers.delete(maid.id); } catch (e) { /* 忽略 */ }
            forgetFarmSwing(maid);
            return;
        }

        budget--;
        try { scanOne(maid); } catch (e) { logErr("scan", e); }
    });

    // 没见到的（已回收 / 预算不够）累计 miss，太久就丢 —— 防 trackers 无限长。
    // 扫过的在 scanOne 里把 miss 归零，所以这里只处理"这一轮没轮到它"的。
    for (const [id, tr] of trackers) {
        if (tr.miss === 0) continue;
        tr.miss += 1;
        if (tr.miss > 40) trackers.delete(id);   // 40 轮 ≈ 8 秒
    }

    pruneFarmSwing(64);   // 挥击冷却表兜底，正常永远走不到
}

let inited = false;

export function initFarmFortune() {
    if (inited) return;
    inited = true;

    try {
        // 包一层：回调抛错引擎会**每 4 tick 重复报一次**，日志会被刷爆
        system.runInterval(() => {
            try { tickScans(); } catch (e) { logErr("tick", e); }
        }, SCAN_INTERVAL);
    } catch (e) {
        logErr("interval", e);
        return;
    }

    trace(`armed: every ${SCAN_INTERVAL}t, r=${R}, y[${Y_LO},${Y_HI}], ${CROP_DROPS.size} 种方块`);
}
