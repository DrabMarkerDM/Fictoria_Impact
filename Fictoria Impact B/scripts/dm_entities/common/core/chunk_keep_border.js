/**
 * chunk_keep_border.js — 给常加载区画虚线外框，只画给开了显示开关的那只。
 *
 * 做法照 Chunk Borders Lite：粒子 lifetime 1.15s、每 20t 重画，新旧重叠所以不断线；
 * player.spawnParticle 只发给本人，不用额外做可见性过滤。
 * 画的是干员那片 3×3（48×48）的外框，不是玩家所在区块；粒子定义在 RP：
 * fictoria:ck_border_hx / _hz / _v（共用一张软边贴图，颜色靠 tint 染绿）。
 *
 * 开关是每只干员的（实体 DP，见 chunk_keep.js 的 isBorderOn），关掉只影响她那片。
 */
import { world, system } from "@minecraft/server";
import { getAreaRects, isBorderOn } from "./chunk_keep.js";
import { safeRun } from "./safe_exec.js";

// 必须小于粒子 lifetime（1.15s），否则线会闪断。
const PERIOD = 20;

// 区中心离玩家超过这个距离就不画：粒子只在视距内可见，远处画了纯浪费。
const VIEW_DIST = 128;

// 四角竖线高度：玩家上下各这么多格。
const VERTICAL = 24;

// 同屏最多画几片。一片 48×48 外框约 384 颗/次（水平 192 + 竖柱 192）。
const MAX_AREAS = 4;

// 每格一颗、位置取格中点（+0.5），单颗 0.5 格长 —— 与 Chunk Borders Lite 同一节奏。
// 颗粒贴图四边都是软边，两端淡出成虚线，四角各留 0.25 格空也看不出缺口。
const STEP = 1;

const HX = "fictoria:ck_border_hx";
const HZ = "fictoria:ck_border_hz";
const VT = "fictoria:ck_border_v";

/** 这片的主人有没有开边界显示。实体取不到（不在加载区块）就当关。 */
function unitWantsBorder(id) {
    if (!id) return false;

    try {
        const e = world.getEntity(id);
        return e?.isValid ? isBorderOn(e) : false;
    } catch (_) {
        return false;
    }
}

function draw(player, a, py) {
    const x0 = a.x0;
    const z0 = a.z0;
    const x1 = x0 + a.span;
    const z1 = z0 + a.span;
    const y = py + 0.2;

    // 四条水平边：每 STEP 格一颗，中心落在格中点
    for (let i = 0; i < a.span; i += STEP) {
        const n = i + STEP / 2;

        player.spawnParticle(HX, { x: x0 + n, y, z: z0 });
        player.spawnParticle(HX, { x: x0 + n, y, z: z1 });
        player.spawnParticle(HZ, { x: x0, y, z: z0 + n });
        player.spawnParticle(HZ, { x: x1, y, z: z0 + n });
    }

    // 四个角柱：只画玩家上下这一段，铺满世界高度没必要
    const base = Math.floor(py);
    const top = base + VERTICAL;
    const bot = base - VERTICAL;

    for (let y2 = bot; y2 < top; y2 += STEP) {
        const n = y2 + STEP / 2;

        player.spawnParticle(VT, { x: x0, y: n, z: z0 });
        player.spawnParticle(VT, { x: x1, y: n, z: z0 });
        player.spawnParticle(VT, { x: x0, y: n, z: z1 });
        player.spawnParticle(VT, { x: x1, y: n, z: z1 });
    }
}

function drawNear(player, rects) {
    const loc = player.location;
    const dimId = player.dimension.id;

    // 先按维度与距离筛，再按远近取前几片 —— 30 片全开时也只画最近的
    const near = [];

    for (const a of rects) {
        if (a.dimId !== dimId) continue;

        const dx = loc.x - (a.x0 + a.span / 2);
        const dz = loc.z - (a.z0 + a.span / 2);
        const d2 = dx * dx + dz * dz;

        if (d2 > VIEW_DIST * VIEW_DIST) continue;

        near.push({ a, d2 });
    }

    if (near.length === 0) return;

    if (near.length > MAX_AREAS) {
        near.sort((p, q) => p.d2 - q.d2);
        near.length = MAX_AREAS;
    }

    // 开关放在取前几片之后读：最多 4 次 getEntity，不是 30 次
    for (const it of near) {
        if (!unitWantsBorder(it.a.unit)) continue;
        draw(player, it.a, loc.y);
    }
}

function tick() {
    const rects = getAreaRects();

    if (rects.length === 0) return;

    for (const player of world.getAllPlayers()) {
        // 玩家退出瞬间 location 会抛，属正常路径，静默跳过
        safeRun("ck_border.draw", () => drawNear(player, rects), undefined, { silent: true });
    }
}

export function initChunkKeepBorder() {
    system.runInterval(() => safeRun("ck_border.tick", tick), PERIOD);

    console.warn("[ChunkKeep] 常加载区边界粒子已启动");
}
