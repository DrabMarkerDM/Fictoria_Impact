/*
 * farm_anim.js — 耕种动作的视觉表现（挥锄）。
 * 复用挖矿 / 砍树那支 animation.dm34_gather_swing（0.375 秒纯关键帧），由 JS 单次触发，不走动画
 * 控制器 —— 控制器只能在状态切换时换动画，做不到「每挥一下播一遍」。
 * 以前耕种没有动作：耕地走引擎行为 harvest_farm_block，JS 在门外，连「她刚收了一株」都不知道。
 * 农场时运补偿改成方块快照归因后才有这个信号：作物 growth 回落 / 变空气，就是她挥了一下锄头。
 * 触发点（全部来自 farm_fortune.js 的扫描帧）：收获 = 作物 → 空气 / 作物 → 别的方块 / growth
 * 变小（含收完立刻补种回幼苗）；播种 = 空气 → 作物，且脚下是耕地或灵魂沙。作物长在耕地上一格，
 * 所以判据要跨格看脚下；快照里连空气也记，「明确的空气 → 作物」才能与「区块刚加载」区分开。
 * 🔴 growth 变大一律不播：催熟是刻意设计的持续能力（grows_crop + fertilize_farm_block），能让
 * growth 一帧跳好几级，把「单帧跳 ≥2」当撒骨粉去播动画会变成永动机。
 * 节流：同一只女仆两次挥击至少隔 8 tick（动画 7.5 tick，正好接上）。
 * 🔴 名字必须传全名 animation.dm34_gather_swing：曾因 RP 的 animations 表里只有短键
 * gather_swing 而 JS 传全名，两条路静默落空。现在 RP 两个键都在，代码只认全名，
 * test_farmfortune.mjs 有守卫盯着。
 */

import { system } from "@minecraft/server";

const SWING_ANIM = "animation.dm34_gather_swing";
const SWING_COOLDOWN = 8;      // tick

/** entityId → 上次挥击的 tick */
const lastAt = new Map();

/** 挥一下。
 *  @returns {boolean} 真的播出去了（被冷却挡掉 / 实体没了 → false） */
export function swingFarm(entity) {
    if (!entity) return false;

    let id;
    try { id = entity.id; } catch (e) { return false; }
    if (!id) return false;

    let now;
    try { now = system.currentTick; } catch (e) { return false; }

    const last = lastAt.get(id);
    if (typeof last === "number" && now - last < SWING_COOLDOWN) return false;
    lastAt.set(id, now);

    try {
        // blendOut 0.15：动画 0.375 秒，收尾留余量，连续播才不一顿一顿
        entity.playAnimation(SWING_ANIM, { blendOutTime: 0.15 });
        return true;
    } catch (e) {
        // 老版本没有 playAnimation 时退回命令，语义一样
        try {
            entity.runCommand(`playanimation @s ${SWING_ANIM}`);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

/** 忘掉这只女仆的冷却记录（离开耕地态时调用）。
 *  否则 id 被引擎复用给新实体后，新女仆进田第一下会被陈旧记录吃掉 */
export function forgetFarmSwing(entity) {
    if (!entity) return;
    try { lastAt.delete(entity.id); } catch (e) { /* 忽略 */ }
}

/** 登记表无限增长的兜底（女仆被反复刷出来的存档），正常走不到 */
export function pruneFarmSwing(limit) {
    const cap = typeof limit === "number" && limit > 0 ? limit : 64;
    if (lastAt.size <= cap) return;
    lastAt.clear();
}
