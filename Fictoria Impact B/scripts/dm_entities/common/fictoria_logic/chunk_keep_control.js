/*
 * chunk_keep_control.js — 「区块离线加载」与「边界显示」的 UI 入口。
 * 每只干员完全独立：按钮只看她自己有没有登记，开关只影响她自己那片。
 * 逻辑全在 core/chunk_keep.js，这里只做「读状态 → 调哪个 → 报结果」的分派。
 */
import { system } from "@minecraft/server";
import {
    isUnitOn, enableFollow, disableFor, getInfo, isBorderOn, setBorderOn, pruneOrphans
} from "../core/chunk_keep.js";
import { t } from "../core/i18n.js";

/**
 * 配额读数：maxChunkCount 是引擎给的硬上限，不是我方估算，直接读即可（不必堆到爆）。
 * createTickingArea 是异步的，刚点完 chunkCount 还没加，隔 2 tick 再读。
 * 走 actionbar 不占聊天栏；每次开关都给，玩家随时知道还剩多少。
 */
function showQuota(player) {
    system.runTimeout(() => {
        try {
            const info = getInfo();

            if (info.maxChunkCount > 0) {
                player.onScreenDisplay.setActionBar(
                    t("fictoria.keep.quota", info.chunkCount, info.maxChunkCount));
            }
        } catch (_) { }
    }, 2);
}

/** 按钮文案用：只看这只自己有没有登记，站进别人的片区不算。 */
export function isKeepOn(player, unit) {
    return isUnitOn(unit);
}

/** 切换：她自己开着就关自己那片，没开就新建一片。 */
export function toggleChunkKeep(player, unit) {
    if (!unit) return false;

    const on = isUnitOn(unit);

    // 开之前先清一遍无主区：/kill、收回球、旧存档留下的区没人管，
    // slideTick 靠 LastPos 读到「上次的位置」照样认为成员在原地，于是一直占着引擎配额。
    // 清完再判断容量，正好把配额让出来。
    if (!on) {
        const pruned = pruneOrphans();

        if (pruned > 0) player.sendMessage(t("fictoria.keep.pruned", pruned));
    }

    const r = on ? disableFor(unit) : enableFollow(player, unit);

    // msg 是 chunk_keep 里组好的整句 RawMessage，成功/失败都直接透传
    player.sendMessage(r.msg);

    if (!r.ok) return false;

    showQuota(player);
    return true;
}

/** 按钮文案用：这只的边界显示开着没。 */
export function isBorderShown(unit) {
    return isBorderOn(unit);
}

/**
 * 切换这只的边界显示。面板上只在她开着区块加载时才给这个按钮 —— 没有区就没有边界可画。
 * 状态存实体自身 DP，关掉区块加载不会跟着清，下次再开还保持上次的选择。
 */
export function toggleBorder(player, unit) {
    if (!unit) return false;

    const on = !isBorderOn(unit);

    if (!setBorderOn(unit, on)) {
        player.sendMessage(t("fictoria.keep.border_fail"));
        return false;
    }

    player.sendMessage(t(on ? "fictoria.keep.border_on" : "fictoria.keep.border_off"));
    return true;
}
