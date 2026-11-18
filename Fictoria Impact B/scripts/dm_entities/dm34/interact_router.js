/*
 * interact_router.js — 交互路由：手持物 + 右键 → 一条原生事件。
 * 判定顺序见 handleInteract 内的编号（① 甲 → 盾 → ② 生食 → ②' 锄 → ③ 武器 →
 * ④ Maid_Command → ⑨.5 骑乘 → ④' 闲置潜行 → ⑤ 烹饪 → ⑥ 解除状态 → ⑦ 规则表）。
 * 军械女仆（player:dm34_1）不套用规则表，分发全部在 handleGunMaid。
 * 音效、粒子、计分板等动作链留在 JSON 事件里，这里只 triggerEvent。
 */

import { GameMode, system } from "@minecraft/server";
import {
    CONFIG, COOK_START_RE, weaponFamilyOf, hoeFamilyOf, gatherKindOf, isHoeId, isGatherToolId,
} from "./config.js";
import { FOODS } from "./interact_tables.js";
import { clearSlot, dropItemNear, makeItem, readMainhand } from "./slot_io.js";
import { isMaid, isOwner, ensureOwnerDp, resolveState, buildCtx, ruleMatches, tupleInfo, variantOf, handItemOf } from "./maid_state.js";
import { startCook, clearCook, abortCook, cookSneakAction, cookWithFood } from "./cook.js";
import { armorSlotOf, equipArmor, removeAllArmor, purgeStrayArmor, shedAllArmor, consumeHand } from "./equip.js";
import { looksLikeArmor } from "./armor_table.js";
import { storeWeapon, returnWeapon, ensureWeaponPresent, hasWeaponRecord, refreshWeaponDisplay } from "./weapon_store.js";
import { storeFarmTool, returnFarmTool, restoreFarmDisplay, hasFarmTool } from "./farm_store.js";
import { storedGatherTool, restoreGatherDisplay } from "./gather_store.js";
import { startGather, stopGather, hasGatherJob } from "./gather.js";
import { equipShield, removeShield, hasShield } from "./shield.js";
import { isPlayerMounted } from "../player/ride_guard.js";

const DM34 = "player:dm34";

/*
 * 军械女仆（player:dm34_1）：不穿甲、不认原版武器/生食/锄头，只认 item:mode_* 与 item:dm34_gentle_maid。
 * 手持物是 variant 组 + RP 模型、不是真件 —— 任何把 sp 变掉落物或写进主手的路径都必须对她关掉
 * （见 selfItemOf 与盔甲分支）。
 */
const DM34_1 = "player:dm34_1";

/** 驯服道具（两个女仆 `ta` 组的 `tameable.tame_items`）。驯服那一击同样会走一次
 *  playerInteractWithEntity，需要单独拦，见 ⓪。 */
const TAME_ITEMS = new Set(["items:card_1"]);

/** 「平静态」：身上没挂武器形态，随时可以被打断/接管。
 *  in1/in2 是待命；dm_mine/dm_chop 是采集态（variant 6/7），手里只有镐斧、
 *  交互规则与待命完全一致（生成器里声明为 in1 的别名状态），所以同样按平静态处理。
 *  spear 不在此列 —— 它是 sword 的副本，属于战斗形态。 */
function isIdleState(key) {
    return key === "in1" || key === "in2" || key === "dm_mine" || key === "dm_chop";
}

/** 手持物品是哪一种生食（1..10）；不是生食返回 0 */
function rawFoodN(itemId) {
    if (!itemId) return 0;
    const f = FOODS.find((x) => x.raw === itemId);
    return f ? f.n : 0;
}

/** 当前是不是武器形态（dm34 的 sword/bow/crossbow 三态） */
function isWeaponState(st) {
    return st.st.spKind === "weapon";
}

/*
 * 军械女仆（dm34_1）离开形态时交还手上的 item:mode_*。原生靠 interact 条目的 spawn_items
 * 生成，条目压成 catch-all 后这条链断了，而 selfItemOf 对她返回 null，不补就凭空消失。
 * 只还五个武装态（in1/in2 不在表里）；dm34 不走这里，它的武器态由 returnWeapon 还真件。
 * @returns {boolean} 是否已处理（true 时调用方不要再走 selfItemOf）
 */
function spawnOwnItem(entity, st) {
    if (!entity || String(entity.typeId) !== DM34_1) return false;
    const stDef = st && st.st;
    // 形态道具写死在这里，不靠 stDef.spTable：那张表由白名单条目编译而来，
    // 她的 JSON 已改成 catch-all，重编后会变成 null → 旧枪凭空蒸发。
    const itemId = GUN_STATE_ITEM.get(st.key) || (stDef && stDef.sp);
    if (!itemId) return false;
    dropItem(entity, itemId);
    debug(`离开 ${st.key} → 交还 ${itemId}`);
    return true;
}

/** 五个武装态各自手里那件（离开形态时交还的虚拟件） */
const GUN_STATE_ITEM = new Map([
    ["m4a1", "item:mode_m4a1"],
    ["glock", "item:mode_glock"],
    ["sword", "item:mode_sword"],
    ["moss", "item:mode_mossberg"],
    ["awp", "item:mode_awp"],
]);

/*
 * 军械女仆（dm34_1）的专用交互总闸：不走规则表。
 * 她的 JSON 条目是 catch-all（in1/in2 各两条、gun_hub 两条），interact_tables.js 按旧白名单
 * 编译、识别不了 catch-all（compile() 见到 is_sneaking 就判成潜行条目）→ 拿表里没有的东西
 * 右键会命中不了任何规则，return false 就让引擎弹出物品栏。
 * 判据只用 hand + 状态键 + 是否潜行：换枪 / 变回 Gentle Cross / 喂面包 / 抱放（鞍）/ 坐起 /
 * 潜行退出形态 / 潜行开背包，认不出的一律吞掉 + 一行 actionbar；交回原版只有闲置态潜行
 * （开背包）与武装态空手（查看容器）。拴绳不在此拦：非潜行 lead 被 JSON `hand != lead` 挡掉。
 * st / ctx / beforeId（beforeItemStack.typeId，引擎有时会先清空主手）→ @returns 是否已接管
 */
function handleGunMaid(player, entity, st, ctx, beforeId) {
    const key = st.key;
    const hand = ctx.hand || beforeId;

    // 玩家正骑着她：方向盘归玩家，右键一律静默。
    // 不能连 `ctx.riding`（她被 hug_maid 抱着）一起拦 —— 放下她靠的就是这次右键命中 ride_test。
    if (isPlayerMounted(entity)) return true;

    // 她被 hug_maid 抱着（ctx.riding）：只允许放下（鞍），其余静默，与 dm34 的 `n` 兜底同义。
    // 骑马模式（mountTag）要放行 —— 那时右键该落回原版物品栏，
    // 否则玩家永远拿不出马铠，她也就永远下不了马。
    if (ctx.riding && !ctx.mountTag) {
        if (hand === "minecraft:saddle") {
            triggerMaidEvent(entity, "ride_test", { event: "ride_test", use: 0, drop: 0 });
            debug("被抱着 + 鞍 → 放下");
        }
        return true;
    }

    // 拴绳不在这里拦：条目已被 JSON 的 `hand != lead` 命中过，return false 也回退不到牵引，
    // 只会变成右键毫无反应。

    if (ctx.sneaking) {
        // 潜行 + Maid_Command：她不穿甲（acceptsArmor 只认 dm34），只可能有残留的盾 → 摘掉。
        if (hand === "item:maid_command") {
            if (CONFIG.shield.enabled && hasShield(entity)) {
                removeShield(player, entity);
                msg(player, "§7取下盾牌。");
            }
            return true;
        }
        // 闲置态潜行 = 交回原版开背包（她身上没甲可卸）
        if (isIdleState(key)) return false;
        // 武装态潜行 = 解除形态（把手里的 mode_* 交还玩家）
        leaveState(player, entity, st);
        return true;
    }

    // ── 以下都是非潜行 ─────────────────────────────────────────────

    // 空手：戴鞍 → 骑上去；闲置态 → 坐下/起身；武装态 → 交回原版（查看她的容器）
    if (!hand) {
        // 戴鞍 + 空手 → 骑上去（与 dm34 的 ⑨.5 同一语义，排在 sit 之前）
        if (isSaddleMounted(entity)) {
            try { entity.runCommand("ride @p start_riding @s"); } catch (e) { /* 没座位 / 已在骑 */ }
            debug("戴鞍 + 空手 → 骑上去");
            return true;
        }
        // 被拴绳牵着 / 身上还挂着 maid:player_ride：空手右键不该坐下（会打断牵引）
        if (ctx.leashed || ctx.tag) return false;
        if (key === "in1") { triggerMaidEvent(entity, "sit_1", { event: "sit_1", use: 0, drop: 0 }); return true; }
        if (key === "in2") { triggerMaidEvent(entity, "sit_2", { event: "sit_2", use: 0, drop: 0 }); return true; }
        return false;
    }

    // 换枪：吃掉手上那把，她原来那把掉在脚下（等价于原生 use_item + spawn_items）
    const ev = GUN_MODE_EVENTS.get(hand);
    if (ev) {
        if (key === ev) {
            debug(`军械女仆已是 ${ev}，忽略同名换枪`);
            return true;
        }
        spawnOwnItem(entity, st);
        consumeHand(player, hand);
        triggerMaidEvent(entity, ev, { event: ev, use: 1, drop: 1 });
        debug(`${key} → ${ev}`);
        return true;
    }

    // 变回 Gentle Cross（dm34）：整只替换实体，先把穿戴物挖出来掉脚下
    if (hand === "item:dm34_gentle_maid") {
        spawnOwnItem(entity, st);
        consumeHand(player, hand);
        shedBeforeTransform(player, entity);
        triggerMaidEvent(entity, "gentle_maid", { event: "gentle_maid", use: 1, drop: 0 });
        debug(`${key} → gentle_maid`);
        return true;
    }

    // 面包：任何状态都能喂（含坐着）
    if (hand === "minecraft:bread") {
        consumeHand(player, hand);
        triggerMaidEvent(entity, "buff", { event: "buff", use: 1, drop: 0 });
        debug(`喂面包（${key}）`);
        return true;
    }

    // 鞍：只抱起/放下，永不装鞍（见 ① 的说明）
    if (hand === "minecraft:saddle") {
        triggerMaidEvent(entity, "ride_test", { event: "ride_test", use: 0, drop: 0 });
        debug(`鞍 → ride_test（${key}）`);
        return true;
    }

    // 非潜行 Maid_Command：不卸甲（与 dm34 的 ④ 一致），静默吞掉
    if (hand === "item:maid_command") {
        debug("非潜行 Maid_Command → 忽略");
        return true;
    }

    // 其余全部吞掉：盔甲 / 盾 / 原版剑弓弩 / 生食 / 锄头 / 方块 / 别的模组物品。
    // 静默吞掉 —— return false 会让引擎弹背包。
    debug(`军械女仆不接受 ${hand}（${key}）→ 已吞掉`);
    return true;
}

/** 她认识的 mode_* → 形态事件 */
const GUN_MODE_EVENTS = new Map([
    ["item:mode_m4a1", "m4a1"],
    ["item:mode_glock", "glock"],
    ["item:mode_sword", "sword"],
    ["item:mode_mossberg", "moss"],
    ["item:mode_awp", "awp"],
]);

/** 一行提示：优先 actionbar（不刷聊天栏），失败退回聊天 */
function msg(player, text) {
    try {
        player.onScreenDisplay.setActionBar(text);
        return;
    } catch (e) { /* 忽略 */ }
    try { player.sendMessage(text); } catch (e) { /* 忽略 */ }
}

/** 她是不是已经戴鞍（player_ride 组里有 minecraft:is_saddled）→ 右键该是"骑上去" */
function isSaddleMounted(entity) {
    try { return entity.hasComponent("minecraft:is_saddled"); } catch (e) { return false; }
}

/*
 * 处理一次玩家右键女仆。
 * @param {{nativeArmor?: boolean, beforeTypeId?: string}} [opts]
 * nativeArmor = 这次已被原生 equip_item_slot 处理过（真件已进槽），JS 不能再放一次甲；
 * beforeTypeId = beforeItemStack.typeId —— 引擎装甲会清空主手，after 事件里读不到，只能靠它
 * 知道刚才拿的是甲。
 * @returns {boolean} 是否被脚本接管
 */
export function handleInteract(player, entity, opts) {
    const nativeArmor = !!(opts && opts.nativeArmor);
    if (!isMaid(entity)) return false;
    if (!isOwner(player, entity)) return false;
    // 还没有主人记录时补录一次（与 attackable_target_manager 的补录逻辑一致）
    ensureOwnerDp(entity, player);

    const st = resolveState(entity);
    if (!st) {
        // 状态解不出来 = 下面每条分支都不会执行，JS 等于完全没参与这次右键。
        // 她这时看着"右键毫无反应"，而排查者只能猜 —— 留一行痕迹（限 5 条）。
        weirdState(entity);
        return false;
    }

    const ctx = buildCtx(player, entity);
    const hand = ctx.hand;
    const beforeId = opts && opts.beforeTypeId ? opts.beforeTypeId : undefined;
    // 引擎有可能在 after 事件之前就把手持物吃掉（条目 use_item=true / equip_item_slot）。
    // 这时 `hand` 已经是空的，只剩这份"动手之前"的栈 —— 锄头/武器落不落记录全靠它。
    const beforeStack = opts && opts.beforeStack ? opts.beforeStack : undefined;

    // 耕地态取证（见 logFarm）：一次右键一行，先记"她是什么状态、玩家拿的是什么"。
    // 后面每条会离开 farm 的分支都会再补一行，合起来就是这次右键的完整路径。
    const tracingFarm = st.key === "farm";
    if (tracingFarm) {
        logFarm(`右键 hand=${hand || "空手"} sneak=${!!ctx.sneaking} ride=${!!ctx.riding} `
            + `tag=${!!ctx.tag} hasHoe=${hasFarmTool(entity)} → 进入路由`);
    }

    // ⓪ 驯服那一击：tame_items 是 items:card_1，引擎当场吃掉一张，after 事件里主手已空 →
    //    会被当成空手右键命中 `["s","sit_1"]`，刚驯服就自己坐下。beforeItemStack 是唯一
    //    还留着那张卡的证据。创造模式不消耗时 hand 仍是 card_1，两个都要拦。
    if ((beforeId && TAME_ITEMS.has(beforeId)) || (hand && TAME_ITEMS.has(hand))) {
        debug(`驯服道具右键（${beforeId || hand}）→ 交给 on_tame，脚本不做其它动作`);
        return true;
    }

    // 军械女仆（dm34_1）：分发全部收回 handleGunMaid，不走下面的规则表
    if (entity.typeId === DM34_1) return handleGunMaid(player, entity, st, ctx, beforeId);

    // ── 盔甲判定提前算 ─────────────────────────────────────
    // 「戴鞍 → 骑」和「手持盔甲 → 装甲」共用这几个值；算晚了会出现一次点击两个动作
    // （甲穿了、人也骑上去了）。
    const handStack = handItemOf(player);
    const armorInHand = !!hand && (!!armorSlotOf(hand) || looksLikeArmor(handStack));
    const nativeArmorDone = nativeArmor && !ctx.sneaking;
    const beforeWasArmor = !!beforeId && !!armorSlotOf(beforeId) && !ctx.sneaking;
    const armorInHandOrNative = CONFIG.armor.enabled && (armorInHand || nativeArmorDone || beforeWasArmor);

    // ── 先对账：状态还在、记录没了（重进世界最常见）─────────────────────
    // 必须排在「真武器被取走 → back」之前：那条闸一命中就直接 return，
    // 她手上那把玩家的剑会留在手上，而记录已经是空的 —— 从此再没人认领它。
    reclaimOrphan(player, entity, st);

    // ① 鞍：脚本永不装鞍。
    //    手持鞍右键 = 只抱起/放下（规则表 `["r","ride_test"]`，被她骑的 hug_maid 再骑玩家）。
    //    装鞍只能打开她的背包手动放进马鞍位（container_type: horse 的 0 号伪槽 →
    //    equippable.on_equip → ride_on）。
    //    不能在这一次右键里顺手装：装鞍 = player_ride 组（她变可骑），抱起 = 她骑 hug_maid，
    //    两条骑乘链同时成立会互相解算，把两个人原地弹飞。
    //    另外各状态的 interact 条目都含鞍且 use_item: false，引擎的 equippable 不会接管，
    //    这是「右键只抱起」成立的前提。
    //
    // ①' 戴鞍后的「骑上去」不在这里，挪到 ⑨.5（所有手持物分支之后）。排最前面会截走
    //    剑/锄/生食/Maid_Command，变成「装上鞍后只能骑乘」，连潜行背包也开不了。

    // 真武器被玩家从背包取走 → 立刻解除武器形态
    if (isWeaponState(st) && !ensureWeaponPresent(entity)) {
        debug(`真武器被取走，解除 ${st.key}`);
        clearCook(entity);
        safeTrigger(entity, "back");
        return true;
    }

    // 反向兜底：状态已不是武器态但记录还挂着（variant 与记录不同步过）。
    // 不还的话武器永远锁在动态属性里，下次装新武器会被覆盖。
    if (!isWeaponState(st) && hasWeaponRecord(entity)) {
        debug(`状态=${st.key} 但武器记录残留 → 补归还`);
        returnWeapon(entity, player);
    }

    // 反向兜底（锄头）：同理，不还会被下一把锄头覆盖。
    if (st.key !== "farm" && hasFarmTool(entity)) {
        debug(`状态=${st.key} 但锄头记录残留 → 补归还`);
        returnFarmTool(entity, player);
    }

    // ① 盔甲：任意状态、任意盔甲，优先于背包。查不到表就靠 is_armor 标签兜底。
    //    nativeArmor / beforeWasArmor 已在开头算好：引擎会当场拿走那件甲，
    //    after 事件里 armorInHand 为 false，只看它会跑成「穿甲 + 切待命」。
    if (armorInHandOrNative) {
        // 军械女仆不穿甲：不消耗、不写记录、不掉东西、不提示（外观是 RP 写死的一整套）
        if (entity.typeId === DM34_1) return true;
        // 引擎已经原封不动穿上了 → 什么都不做（再放一次会盖成白板）。
        // !ctx.sneaking 是第二道闸：潜行时 JSON 不会装甲，nativeArmor 为真是误判，
        // 误判会直接 return false，后面的潜行退出 / 中断烹饪全失效。
        if (nativeArmorDone || beforeWasArmor) return false;
        if (!(CONFIG.armor.unlessSneaking && ctx.sneaking)) {
            equipArmor(player, entity);
            return true;
        }
    }

    // ①'' 手持盾牌 → 装盾（任意状态都能装）。潜行不抢：非闲置态的潜行是解除状态。
    //       真件由 JSON 的 equip_item_slot(slot.weapon.offhand) 交给引擎搬，脚本只记账；
    //       引擎搬完主手就空了，after 事件里读不到盾 —— 靠 beforeTypeId 兜住，
    //       否则会被当成空手右键走 sit_1，一次点击两个结果。
    //       副手与主手独立，装盾不影响持械（左手盾右手剑）。
    const beforeIsShield = beforeId === "minecraft:shield" && !ctx.sneaking;
    if (CONFIG.shield.enabled && entity.typeId === DM34 && !ctx.sneaking
        && (hand === "minecraft:shield" || beforeIsShield)) {
        return equipShield(player, entity);
    }

    // ①''' 手持镐 / 斧（非潜行）→ 采集模式（挖矿 / 砍树）。
    //       不占 variant：她留在 in1，靠附加组件组 dm_mine / dm_chop 的原生
    //       move_to_block 自己走过去，脚本只负责敲（见 gather.js 文件头）。
    //       先离开当前状态，否则 weapon_hub 那套还挂着 → 她会一边打怪一边挖矿。
    //
    // 采集态的右键分工（2026-11-12 定案，和"潜行开背包"的通用规则相反）：
    //   非潜行 + 空手 → **什么都不做**。dm_mine / dm_chop 的末条 catch-all 只认潜行，
    //                   这一次点击零命中 → 引擎执行默认右键 = 打开她的容器。
    //                   玩家要拿她挖回来的矿，走的就是这条路。
    //   潜行         → 卸下手里的活（镐/斧还你）。入口是同一套 JSON 的潜行 catch-all，
    //                   处理在下面的 ④''。
    //   ⚠ 别把"空手收工"写回非潜行：那样右键只会收工、永远开不了背包。
    if (CONFIG.gather.enabled && entity.typeId === DM34 && !ctx.sneaking && !ctx.riding) {
        const kind = gatherKindOf(hand, ctx.handTags);
        if (kind) {
            if (tracingFarm) logFarm(`→ 采集 ${kind}（先离开耕地态）`);
            if (!isIdleState(st.key)) leaveState(player, entity, st);
            // 主手读不到（引擎先吃了）→ 用动手之前那份栈，别把玩家的镐扔在原地
            const stack = handStack || (gatherKindOf(beforeId) ? beforeStack : undefined);
            return startGather(player, entity, kind, stack, !isCreative(player));
        }
    }

    // ② 手持生食 → 无论她在做什么都直接进烹饪（只有普通女仆会做饭）
    const rawN = rawFoodN(hand);
    if (rawN && entity.typeId === DM34) {
        // 先把当前状态的东西交代清楚：武器还玩家、锄头还玩家、锅里的入包
        if (st.key !== "cook_a" && st.key !== "cook_b") releaseStateItem(player, entity, st);
        if (cookWithFood(entity, rawN)) {
            consumeHand(player, hand);
            debug(`生食交互 → cook_${rawN}a`);
            return true;
        }
    }

    // ②' 手持锄头 → 耕地态（任意材质，原生只写了铁锄）。
    // 同真武器一套做法：玩家那把序列化存进 dm34:hoe，离开时归还。
    // !ctx.riding 是原生语义（骑乘时 h 条目都不命中）；耕地态也走这里 = 换一把锄头。
    if (
        CONFIG.farm.enabled && entity.typeId === DM34 && !ctx.sneaking && !ctx.riding &&
        hoeFamilyOf(hand, ctx.handTags)
    ) {
        return enterFarm(player, entity, st, handStack, beforeStack);
    }

    // ③ 换武器形态（只对 dm34；dm34_1 的枪械靠 item:mode_* 走 handleGunMaid）
    const fam = weaponFamilyOf(hand, ctx.handTags);
    if (CONFIG.weapon.enabled && fam && entity.typeId === DM34 && !ctx.sneaking) {
        if (tracingFarm) logFarm(`→ 换武器 ${fam}（先离开耕地态）`);
        // 采集态换武器：先把镐/斧还了、摘掉 dm_mine，再切。
        // 不这么做就是「dm_mine 组 + sword 组同时挂着」→ 两个 variant 打架，
        // 而且会一边挥剑一边继续往矿脉走。
        if (CONFIG.gather.enabled && hasGatherJob(entity)) {
            // noRevert：只摘 dm_mine/dm_chop 组，**不要** gather_back 那一份 in1。
            // 紧接着的 switchWeapon 会自己 add sword/spear 的完整组；
            // 多塞一份 in1 就是两个 variant 同时挂着（"换武器后她变回待命"）。
            stopGather(player, entity, { keepSilent: true, noRevert: true, why: "换武器" });
        }
        return switchWeapon(player, entity, st, fam, hand, beforeStack);
    }

    // ④ Maid_Command：只有潜行右键才卸甲/卸盾。
    //    返回 0 不等于真没甲：记录可能已被上次卸甲抹掉、槽又读不出来，
    //    所以 0 件时再走 purgeStrayArmor 清一遍（只清读得到的槽）。
    //    非潜行必须在这里吞掉：JSON 的 catch-all 与规则表都含 maid_command，
    //    漏了这一闸就是「不潜行右键也在卸甲」。
    if (hand === "item:maid_command") {
        if (!ctx.sneaking) {
            debug("非潜行 Maid_Command → 不卸甲（要卸请潜行右键）");
            return true;
        }
        // 潜行 + 有盾 = 卸盾，盾在手上时优先于卸甲
        if (CONFIG.shield.enabled && hasShield(entity)) {
            removeShield(player, entity);
            try { player.sendMessage("§7取下盾牌。"); } catch (e) { /* 忽略 */ }
            return true;
        }
        // 以下提示不受 CONFIG.log 总闸管辖：只在失败/有结果时出现，不刷屏
        const report = { stuck: [] };
        const n = removeAllArmor(player, entity, report);
        // 卡槽细节只进日志：甲已经到手了，红字没有可执行意义（见 ghostLog）
        if (report.stuck && report.stuck.length) {
            ghostLog(`还有 ${report.stuck.length} 件卡在装备槽里，已登记自动重试（${report.stuck.join(" / ")}）`);
        }
        if (n) {
            try {
                player.sendMessage(`§7取下 ${n} 件盔甲。`);
            } catch (e) { /* 忽略 */ }
            return true;
        }
        const stray = purgeStrayArmor(entity);
        try {
            player.sendMessage(stray ? `§7取下 ${stray} 件残留盔甲。` : "§7她身上没有盔甲。");
        } catch (e) { /* 忽略 */ }
        return true;
    }

    // ⑨.5 戴鞍 + 空手（非潜行）→ 骑上去。这是兜底，不是优先：
    //      剑/弓/弩/锄/生食/盾/鞍/盔甲/Maid_Command 都在上面各自 return 了，
    //      走到这里说明手上真没东西。潜行不进这支（闲置态归 ④'，其它状态归 ⑥）。
    //      代价：戴鞍时空手右键不再触发 sit_1，要她待命请先卸鞍。
    if (!ctx.sneaking && isSaddleMounted(entity) && !hand) {
        // 已被 hug_maid 抱着时 start_riding 会失败，吞掉即可，别再走 sit_1
        if (!ctx.riding) {
            try { entity.runCommand("ride @p start_riding @s"); } catch (e) { /* 没座位 / 已在骑 */ }
        }
        debug("戴鞍 + 空手 → 骑上去");
        return true;
    }

    // ④'' 采集态 + 潜行 = 卸下手里的活（镐 / 斧还给你）。
    //      必须排在 ④' 之前：采集态的 state 表与待命共用（isIdleState 为真），
    //      ④' 会直接 return false 交回引擎 —— 而这一次右键已经被 JSON 的
    //      潜行 catch-all 判给 js_interact 了，放行只会变成"右键毫无反应"。
    //      走到这里说明前面那些"有功能的手持物"都没接住：
    //      盔甲 / 盾 / 生食 / 锄 / 武器 / Maid_Command 各自在 ① ~ ④ 就 return 了。
    if (CONFIG.gather.enabled && entity.typeId === DM34 && ctx.sneaking && hasGatherJob(entity)) {
        stopGather(player, entity, { why: "玩家右键收工" });
        return true;
    }

    // ④' 闲置态 + 潜行 → 交回引擎弹物品栏，JS 不补动作。
    // in1/in2 的 JSON 只留两条 JS 条目（非潜行非拴绳 / 潜行 + Maid_Command），
    // 其余不命中，引擎按原版弹背包。JS 若继续跑规则表就会双触发（shift+右键既开背包又待命）。
    if (ctx.sneaking && isIdleState(st.key)) {
        debug(`闲置态潜行 → 交回原版物品栏（hand=${ctx.hand ?? "空手"}）`);
        return false;
    }

    // ⑤ 烹饪态 + 潜行 = 中断 / 提前取熟食
    if (ctx.sneaking && (st.key === "cook_a" || st.key === "cook_b")) {
        cookSneakAction(player, entity, st);
        return true;
    }

    // ⑥ 非空手态 + 潜行 = 解除状态
    if (ctx.sneaking && !isIdleState(st.key)) {
        leaveState(player, entity, st);
        return true;
    }

    // 采集态兜底：走到这里说明手上那件不是她认的任何功能物（泥土、苹果、模组杂物）
    // 且**没潜行** —— dm_mine / dm_chop 的第 5 条（`hand != lead` + 非潜行）把它交过来了。
    // ⑦ 的规则表是 in1 的副本，不吞掉会命中 sit_1：她这会儿正在干活，
    // 一坐就停、还会保持坐姿继续敲。引擎侧已经命中过条目，不会自己开容器，
    // 吞掉就是"右键没反应"，可接受。（想开背包请空手，那条零命中 → 引擎弹容器。）
    if (CONFIG.gather.enabled && entity.typeId === DM34 && hasGatherJob(entity)) {
        debug(`采集态不接受 ${ctx.hand ?? "空手"} → 已吞掉`);
        return true;
    }

    // ⑦ 规则表（原生顺序即优先级）
    if (tracingFarm) logFarm(`→ 落到规则表（前面没有分支接住 hand=${hand || "空手"}）`);
    const skipEv = st.st.skipSelf && st.cookN ? `cook_${st.cookN}a` : null;

    let hit = null;
    for (const rule of st.st.rules) {
        if (skipEv && rule[2] === skipEv) continue;
        if (ruleMatches(rule, ctx)) {
            hit = rule;
            break;
        }
    }

    // 这里不开 JS 背包：某状态组里没有条目命中的点击，引擎会自己弹出原版物品栏
    // （马/驴那种）。JS 再插一手会把它顶掉。
    if (!hit) {
        if (tracingFarm) logFarm("规则表零命中 → 交回引擎（不扣任何东西）");
        return false;
    }

    // 骑乘中的静默兜底
    if (hit[0] === "n") {
        debug(`骑乘态兜底 (${st.key})`);
        return true;
    }

    const info = tupleInfo(hit);

    // 离开烹饪态却没有任何掉落条目 → 锅里的东西收进背包，不能凭空消失
    const wasCooking = st.key === "cook_a" || st.key === "cook_b";
    if (wasCooking && !info.drop && COOK_START_RE.test(String(info.event))) {
        abortCook(entity);
    }

    // 命中这条一般意味着会离开当前状态：
    //   武器态 → 真武器必须还；耕地态 → 锄头必须还；其它按原生 spawn_items。
    // buff（喂面包）必须排除：它只切 particle/sound/effect，
    // 按「命中即离开」处理会把武器替身清掉、真武器还给玩家。
    if (!staysInState(info)) {
        if (isWeaponState(st)) {
            returnWeapon(entity, player);
        } else if (st.key === "farm") {
            releaseFarmTool(player, entity, st);
        } else if (info.drop) {
            // dm34_1：原生 spawn_items 的替代（她的 sp 是虚拟件，必须交还）
            if (!spawnOwnItem(entity, st)) {
                const selfItem = selfItemOf(st, entity);
                if (selfItem) dropItem(entity, selfItem);
            }
        }
    }

    // 原生 use_item：吃掉一个手持物（创造模式不消耗）
    if (info.use) consumeHand(player);

    // 变形（War Cross → dm34_1 / Gentle Cross → dm34）整只替换实体：
    // 容器靠 JSON 的 `drop_inventory: true` 落地，但装备槽不属于 inventory，
    // 甲和盾会随旧实体一起消失。这条路上没有球、也没有记录可留，
    // 只能在触发变形前把实物挖出来掉在脚下。必须在 triggerMaidEvent 之前 ——
    // 事件里就会 add trans_N（transformation 立即执行）。
    if (TRANSFORM_EVENTS.has(String(info.event))) {
        const shed = shedBeforeTransform(player, entity);
        if (shed) {
            try { player.sendMessage(`§7切换形态：${shed} 件装备已取下，掉在脚下。`); } catch (e) { /* 忽略 */ }
        }
    }

    // 原生 on_interact.event
    if (info.event) triggerMaidEvent(entity, info.event, info);

    debug(`${st.key} hand=${ctx.hand ?? "空手"} sneak=${ctx.sneaking} → ${info.event ?? "null"}`);
    return true;
}

/** 换形态就清掉自适应近战距离。
 *  `dm:melee_detected_range` 只在**命中时**学习（attackable_target_manager 里 0.8/0.2 平滑），
 *  长矛的 box_attack reach 3.2 学到 3.2 之后，换回剑（reach 2.0）她会停在够不着的地方，
 *  而够不着就打不中 → 学不回来 → 永久卡在攻击距离外。换武器必须重新学。 */
function resetMeleeRangeLearned(entity) {
    try {
        entity.setDynamicProperty("dm:melee_detected_range", undefined);
        entity.setDynamicProperty("dm:last_attack_dist", undefined);
    } catch (e) { /* 忽略 */ }
}

/** 切到某个武器形态：归还旧真武器 → 存新真武器（数据进记录层、主手放同款替身）→ 触发事件 */
function switchWeapon(player, entity, st, fam, handId, beforeStack) {
    const eq = getEq(player);
    let real;
    try {
        real = eq ? eq.getEquipment("Mainhand") : undefined;
    } catch (e) {
        real = undefined;
    }
    // 引擎可能已经把手上那件吃了（条目 use_item）→ 用动手之前那份栈，并按"已扣过"处理
    let fromBefore = false;
    if (!real && beforeStack && weaponFamilyOf(beforeStack.typeId)) {
        real = beforeStack;
        fromBefore = true;
    }
    if (!real) {
        // 读不到主手：要么引擎已经把手上那件吃掉了（条目 use_item），要么玩家是空手。
        // 这里必须 return true —— 返回 false 会让引擎弹出她的背包，
        // 玩家看到的就是"换个武器把箱子打开了"。
        debug(`换武器 ${fam}：主手读不到（handId=${handId ?? "-"}），吞掉本次交互`);
        return true;
    }

    // 当前状态自己的东西先交代清楚：武器/锄头还玩家，锅里的先入包
    if (st.key === "cook_a" || st.key === "cook_b") abortCook(entity);
    else releaseStateItem(player, entity, st);

    const giveBack = !isCreative(player);
    if (!storeWeapon(entity, real, giveBack)) {
        try { player.sendMessage("§c这把武器存不下来"); } catch (e) { /* 忽略 */ }
        return true;
    }

    if (!fromBefore) consumeHand(player, real.typeId);
    else debug("引擎已吃掉手持物 → 不再扣第二次");
    resetMeleeRangeLearned(entity);
    // 长矛是独立组件组（variant 8），事件名带 _on 后缀；其余形态事件名 = 家族名。
    safeTrigger(entity, fam === "spear" ? "spear_on" : fam);
    debug(`换武器 → ${fam}`);
    // 组结算 / 旧状态的 equipment 收尾都可能晚于这一 tick，所以像进采集那样多点补摆。
    scheduleToolDisplay(entity);
    return true;
}

/** 解除当前状态回闲置 */
function leaveState(player, entity, st) {
    // 状态不是武器态却还挂着武器记录 —— 先把武器还了，再走原生掉落逻辑；
    // 不补这一下，记录会拖到下次装武器时才被覆盖，玩家的剑就没了。
    if (!isWeaponState(st) && hasWeaponRecord(entity)) returnWeapon(entity, player);
    // 武器态 → 真武器；耕地态 → 玩家的锄头；其它 → 原生语义掉在脚下
    releaseStateItem(player, entity, st);
    if (st.key === "cook_a" || st.key === "cook_b") abortCook(entity);
    resetMeleeRangeLearned(entity);
    safeTrigger(entity, "back");
    clearCook(entity);
    return true;
}

/*
 * 这条命中是否不会离开当前状态（纯效果事件）。
 * 判据：事件体里只有 queue_command / sequence 里的命令，没有 add/remove.component_groups。
 * 白名单只能写在代码里（interact_tables 是自动生成的，没有这一列）。
 * `ride_test`（手持鞍右键 = 抱起/放下）只招一只 mob:hug_maid 并互相 start_riding，不动组件组
 * → 她还在原状态。漏了它，命中就会被判成「离开状态」走 returnWeapon()：替身被清、真武器
 * 还给玩家，表现为「用鞍右键，武器脱落」。
 */
const STAY_EVENTS = new Set(["buff", "ride_test"]);

function staysInState(info) {
    return !!info && STAY_EVENTS.has(String(info.event || ""));
}

/**
 * 会整只替换实体的事件：`war_maid`（→ dm34_1）与 `gentle_maid`（→ dm34）。
 * 两者都挂 `minecraft:transformation`，旧实体连同装备槽一起消失，见 shedBeforeTransform。
 */
const TRANSFORM_EVENTS = new Set(["war_maid", "gentle_maid"]);

/*
 * 变形前把穿戴物取下来掉在脚下。
 * 盾走 removeShield（按记录重建真件 → 掉脚下 → 抹账）；甲走 shedAllArmor（强清槽 + 挖伪槽
 * → 掉脚下 → 抹账）。
 * @returns {number} 取下几件
 */
function shedBeforeTransform(player, entity) {
    let n = 0;
    if (CONFIG.shield.enabled && entity.typeId === DM34 && hasShield(entity)) {
        try { n += removeShield(player, entity); } catch (e) { /* 忽略 */ }
    }
    if (CONFIG.armor.enabled) {
        try { n += shedAllArmor(entity); } catch (e) { /* 忽略 */ }
    }
    return n;
}

/*
 * 离开当前状态：把这个状态自己的东西交还出去。
 * 武器态 → returnWeapon；耕地态 → 还锄头；其它 → 原生 spawn_items。
 * @returns {boolean} 是否处理了什么东西
 */
function releaseStateItem(player, entity, st) {
    // 🔴 采集态必须走 `stopGather`，**不能**只靠下面的 selfItemOf 掉一件虚拟件。
    //
    //   现象（2026-11-16）：「手持镐/斧时用锄头替换 → 不返还镐斧，而是同时持有
    //   锄头和镐斧，像互相夺舍一样来回切换；潜行右键时两样一起掉」。
    //   根因就在这里：采集态（dm_mine/dm_chop）的 `sp` 是 null，selfItemOf 什么都不掉，
    //   于是 ① 真镐留在 `dm34:gtool` 里没还 ② 采集 job 没清、dm_mine 相关的
    //   tick 逻辑还在跑 ③ 主手同时被两条补摆链写（gather 记着镐、farm 记着锄）→ 夺舍。
    //   换武器那边早就有这一段（见 ③ 里的 stopGather），采集→耕地这条路漏了。
    //   条件里带 `storedGatherTool`：状态已不是采集态、记录却还在（旧存档/中途异常）
    //   也在这里顺手还掉，等价于武器那条 `!isWeaponState(st) && hasWeaponRecord()` 的反向兜底。
    let handled = false;
    if (CONFIG.gather.enabled && (hasGatherJob(entity) || storedGatherTool(entity))) {
        try {
            stopGather(player, entity, { keepSilent: true, noRevert: true, why: "离开采集态" });
        } catch (e) { logFarm(`stopGather 异常（采集交接可能没做全）：${e}`); }
        // ⚠ 这里**不许 return**：两条记录并存的烂账（旧存档）里，
        //   gather 记录和 farm/weapon 记录是两笔独立的账，得各还一次。
        //   镐/斧由 stopGather 里的 returnGatherTool 还掉，接着往下把锄头/剑也交代干净。
        handled = true;
    }
    if (spawnOwnItem(entity, st)) return true;   // dm34_1：交还 item:mode_*（原生 spawn_items）
    // forceClear：st 已确认是武器态，主手那件只可能是替身 → 无条件清（见 returnWeapon 注释）
    if (isWeaponState(st)) return returnWeapon(entity, player, true);
    if (st.key === "farm") return releaseFarmTool(player, entity, st);
    const self = selfItemOf(st, entity);
    if (self) {
        dropItem(entity, self);
        return true;
    }
    return handled;
}

/** 耕地态退出：优先还玩家给的那把真锄头；没有记录才退回原生的"掉一把铁锄" */
function releaseFarmTool(player, entity, st) {
    if (returnFarmTool(entity, player)) return true;
    if (st && st.st && st.st.sp) {
        dropItem(entity, st.st.sp);
        debug(`耕地态没有锄头记录 → 退回原生：掉一把 ${st.st.sp}`);
    }
    return false;
}

/*
 * 记录 ↔ 主手 对账的「B 方向」：状态还在、记录没了。
 * A 方向（有记录、状态不对）在上面两段反向兜底里。B 方向以前没人管：重进世界 / 属性写失败 /
 * 被指令清过之后动态属性读回空，而主手那件实物还在 —— 它既是玩家那把的替身，又是唯一还能
 * 证明玩家给过东西的证据；下一个替身一摆就把它盖掉，表现为「替换成功了，可 a 没回来」。
 * 故把它掉回她脚边（= 还给你）再清槽。不清记录（本来就没有），也不碰状态 —— 状态由调用方
 * 按这次的手持物重新决定。
 * 铁锄例外：farm 组自带 `minecraft:equipment`（loot_tables/iron_hoe.json），那把铁锄是引擎塞
 * 的、不属于玩家，掉出去等于「每右键一次白送一把」。
 * @returns {boolean} 是否捡回了一件孤儿
 */
function reclaimOrphan(player, entity, st) {
    if (!st) return false;
    const key = st.key;

    let want = false;
    if (isWeaponState(st)) want = !hasWeaponRecord(entity);
    else if (key === "farm") want = !hasFarmTool(entity);
    else if (key === "dm_mine" || key === "dm_chop") want = !storedGatherTool(entity);
    if (!want) return false;

    const hand = readMainhand(entity);
    if (!hand || !hand.typeId) return false;

    let orphan = false;
    if (isWeaponState(st)) orphan = !!weaponFamilyOf(hand.typeId);
    else if (key === "farm") orphan = isHoeId(hand.typeId) && hand.typeId !== "minecraft:iron_hoe";
    else orphan = isGatherToolId(hand.typeId);
    if (!orphan) return false;

    if (!dropItemNear(entity, hand) && !dropItemNear(player, hand)) {
        logFarm(`记录缺失，替身 ${hand.typeId} 掉不出去 → 留在主手（不清空）`);
        return false;
    }
    clearSlot(entity, "Mainhand");
    logFarm(`记录缺失 → 主手 ${hand.typeId} 已掉回她脚边（状态 ${key}）`);
    return true;
}

/*
 * 进耕地态后把玩家那把锄头摆到她主手上。
 * farm 组自带 `minecraft:equipment`（loot_tables/iron_hoe.json），组结算会把主手刷成铁锄，
 * 而「结算发生在第几 tick」没有保证。摆一两次赶不上，结算更晚时刚摆好的那把被铁锄盖回去，
 * 表现为「给什么锄头都还是铁锄」，而玩家手上那件已被扣走。
 * 对策两层：① 这里摆 12 次（1..100 tick，覆盖 5 秒），每次都真读槽位复核（不用 hasitem 探针，
 * 它在她身上既会假阳性也会假阴性）；② guard.js 的巡检 + entityLoad 还有一道长期守卫 ——
 * 重进世界后组会再结算一次，那一枪必须有人补（见 repairToolDisplay）。
 * 摆不上不回滚：读槽不可靠，「失败」可能是假阴性，一还就把玩家的锄头退回去。记录留着，
 * 退出耕地态时按记录原样归还。
 */
/** 切换形态后的主手补摆窗口（覆盖组件组结算、旧状态 equipment 收尾）。
 *  farm 那边的 12 枪是同一套理由：**结算发生在第几 tick 没有保证**，
 *  只摆一两次时，晚到的那次结算会把替身盖回上一件（"用斧头换锄头，手上还是锄头"）。 */
const TOOL_SYNC_TICKS = [1, 2, 4, 6, 10, 16, 24, 40, 64, 100];

/**
 * 按**当前**状态把主手替身补齐（幂等）。切换形态后调用一次，之后由守卫接长班。
 * 不用传"想进哪个状态"：读状态比传参可靠 —— 事件触发失败时传参会骗自己。
 */
function scheduleToolDisplay(entity) {
    for (const t of TOOL_SYNC_TICKS) {
        system.runTimeout(() => {
            try {
                const st = resolveState(entity);
                if (!st) return;
                const k = st.key;
                if (k === "farm") {
                    if (hasFarmTool(entity)) restoreFarmDisplay(entity);
                } else if (k === "dm_mine" || k === "dm_chop") {
                    if (storedGatherTool(entity)) restoreGatherDisplay(entity);
                } else if (isWeaponState(k)) {
                    refreshWeaponDisplay(entity);
                }
            } catch (e) { /* 实体已卸载 */ }
        }, t);
    }
}

const FARM_DISPLAY_TICKS = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 72, 100];

function scheduleFarmDisplay(player, entity) {
    const last = FARM_DISPLAY_TICKS.length - 1;
    FARM_DISPLAY_TICKS.forEach((t, i) => {
        system.runTimeout(() => {
            try {
                if (!hasFarmTool(entity)) return;     // 这中间被换掉 / 收回了
                if (restoreFarmDisplay(entity)) return;
                if (i !== last) return;               // 还没到最后一次，继续等组结算
                // 🔴 不在这里回滚还锄头：读槽在女仆身上会假阴性，一"失败"就把玩家的锄头
                //    退回去，看起来就是"给不进去"。记录留着，交给守卫每 20t 继续补摆，
                //    真还的时候（退出耕地态）仍按记录原样归还。
                logFarm("主手摆了 12 次还没对上 → 交给守卫继续补（记录保留）");
            } catch (e) { /* 实体已卸载 */ }
        }, t);
    });
}

/*
 * 进耕地态。
 * 原生是 equipment 塞死铁锄、spawn_items 掉铁锄，材质不留痕；这里改成「存原件 + 摆替身」，
 * 与真武器同构。
 * 🔴 次序：① 先把旧状态交代干净（还剑 / 还镐 / 锅里的收进包）；② 再确认手持物（读不到就用
 * beforeItemStack 兜，引擎有可能已经吃掉了）；③ 记录写进去了才扣玩家那件。
 * 旧版把「读不到手持物」的判断放在最前面，引擎先吃掉就直接 return —— 旧状态的剑没还、
 * 新锄头没记，表现为「给了锄头，剑没了、锄头也没进记录」。
 */
function enterFarm(player, entity, st, handStack, beforeStack) {
    // ⓪ 从采集态过来：先按**正规收工**把镐/斧还掉、清 job、摘 dm_mine/dm_chop 组。
    //    这一段以前完全没有 —— 换武器那条路有（③ 里的 stopGather），耕地这条路漏了，
    //    于是「用锄头换掉手里的镐」实际只是挂上了 farm 组：
    //      · 真镐还在 `dm34:gtool` 里，没还给你（你看到的是"不返还"）；
    //      · 采集 job 没清，她一边耕着地一边继续算矿脉；
    //      · farm 记录 + gather 记录同时在，两条补摆链各写各的 → 手上镐/锄来回夺舍；
    //      · 潜行退出时 farm 还锄头、采集那边也还一次 → 两样东西一起掉。
    //    noRevert：不要 gather_back 那份 in1，紧接着的 farm 事件会自己挂完整组
    //    （多塞一份 in1 就是两个 variant 打架，跟换武器那边同一个理由）。
    if (CONFIG.gather.enabled && (st.key === "dm_mine" || st.key === "dm_chop" || hasGatherJob(entity))) {
        stopGather(player, entity, { keepSilent: true, noRevert: true, why: "换耕地工具" });
    }

    // ① 旧状态的东西先交代清楚（与规则表路径同语义，别让剑/锅里的菜凭空消失）
    if (st.key === "cook_a" || st.key === "cook_b") {
        const self = selfItemOf(st, entity);
        if (self) dropItem(entity, self);
        clearCook(entity);
    } else {
        releaseStateItem(player, entity, st);
    }

    // ② 手持物：主手读不到就退回"动手之前"那份栈
    //    fromBefore = 手上已经空了，说明**引擎先吃掉**了（条目 use_item / equip_item_slot）。
    //    这种时候再 consumeHand 一次就是"玩家带两把、被吃两把"，所以跳过。
    let stack = handStack;
    let fromBefore = false;
    if (!stack && beforeStack && isHoeId(beforeStack.typeId)) {
        stack = beforeStack;
        fromBefore = true;
    }
    if (!stack) {
        logFarm("enterFarm：读不到手持物 → 吞掉本次点击（旧状态已交代，不扣任何东西）");
        return true;
    }

    // 已经在耕地态 → 这次是换一把锄头：旧锄头还玩家、新锄头存下来，
    // 但不能再触发一次 farm 事件（组已加过，重复只会重放音效/粒子）。
    // 注意 alreadyFarm 必须在 releaseStateItem **之后**再取：releaseFarmTool 会清记录，
    // 但状态本身没变（还停在 farm），所以这里用开头那个 st.key 判断 —— 两者一致。
    const alreadyFarm = st.key === "farm";
    logFarm(`enterFarm：${stack.typeId} alreadyFarm=${alreadyFarm}`);

    const giveBack = !isCreative(player);
    if (!storeFarmTool(entity, stack, giveBack)) {
        // 记录写不进去 = 没有任何凭证能把这把锄头还回去 → 绝不扣
        try { player.sendMessage("§c锄头存不下来（记录写不进去），这次没换。"); } catch (e) { /* 忽略 */ }
        logFarm("enterFarm：storeFarmTool 失败 → 不扣");
        return true;
    }

    if (fromBefore) logFarm("引擎已吃掉手持物（after 里主手为空）→ 不再扣第二次");
    else consumeHand(player, stack.typeId);
    if (!alreadyFarm) safeTrigger(entity, "farm");
    debug(`锄头 → farm（${stack.typeId}${alreadyFarm ? "，换锄头" : ""}）`);

    // 命令幂等、多补几次远比被铁锄盖掉便宜（时序解释见 scheduleFarmDisplay 的注释）
    scheduleFarmDisplay(player, entity);

    return true;
}

/** 触发事件；顺手维护烹饪状态与烹饪计时器 */
function triggerMaidEvent(entity, eventName, info) {
    const before = variantOf(entity);
    try {
        entity.triggerEvent(eventName);
    } catch (e) {
        debug(`triggerEvent(${eventName}) 失败: ${e}`);
        return;
    }

    const m = COOK_START_RE.exec(eventName);
    if (m) {
        // 走这条的只有玩家交互（交互表里的 cook_Na 条目），开锅语音不受冷却限制
        startCook(entity, +m[1], true);
        return;
    }
    if (before === 4 && variantOf(entity) !== 4) {
        // 离开烹饪态：锅里的东西要么已经掉了（drop），要么就得收进背包
        if (info && info.drop) clearCook(entity);
        else abortCook(entity);
    }
}

/** 该状态自身物品：普通状态是定值；烹饪态按 cookN 查 FOODS[n].raw / .cooked */
function selfItemOf(st, entity) {
    // 军械女仆的形态道具是虚拟件，交还由 spawnOwnItem 处理；
    // 这里返回 null 是为了不让通用掉落路径碰她的状态。
    if (entity && String(entity.typeId) === DM34_1) return null;
    // 武器形态：主手是替身、真货在她背包里，离开时由 returnWeapon 还玩家，不再掉一件
    if (st.st.spKind === "weapon") return null;
    if (st.st.spKind === "raw" || st.st.spKind === "cooked") {
        const f = FOODS.find((x) => x.n === st.cookN);
        return f ? f[st.st.spKind] : null;
    }
    return st.st.sp;
}

/** 在实体脚下掉一个物品 */
function dropItem(entity, itemId) {
    const it = makeItem(itemId, 1);
    if (!it) {
        debug(`掉落 ${itemId} 失败：造不出 ItemStack`);
        return;
    }
    // 统一走 slot_io.dropItemNear（全工程唯一的掉落实现）
    dropItemNear(entity, it);
}

function getEq(player) {
    try {
        return player.getComponent("minecraft:equippable");
    } catch (e) {
        return undefined;
    }
}

function isCreative(player) {
    try {
        return player.getGameMode() === GameMode.Creative;
    } catch (e) {
        return false;
    }
}

// consumeHand 只有一份实现：equip.js → slot_io.takeMainhand()（引擎命令）。
// 本地副本已删：直接写玩家主手槽会留幽灵槽，且两份实现改哪份都不生效。

function safeTrigger(entity, eventName) {
    try {
        entity.triggerEvent(eventName);
    } catch (e) {
        debug(`triggerEvent(${eventName}) 失败: ${e}`);
    }
}

function debug(msg) {
    if (CONFIG.log.debug && CONFIG.log.console) {
        try { console.warn(`[dm34/interact] ${msg}`); } catch (e) { /* 忽略 */ }
    }
}

/*
 * 耕地态交互取证：只在 st=farm 时打，一次右键一行，总配额 40 条。
 * 不耕地时零输出，所以可以常开（见 CONFIG.log.farmTrace）。它是分清「JS 没跑到」/
 * 「跑到了哪条分支」的唯一证据 —— 平时没有它只能猜。
 */
let farmTraceLeft = 40;
function logFarm(msg) {
    if (!CONFIG.log.farmTrace) return;
    if (farmTraceLeft <= 0) return;
    farmTraceLeft--;
    try { console.warn(`[dm34/farmswap] ${msg}`); } catch (e) { /* 忽略 */ }
}

/** 状态键解析不出来（variant/mark_variant 对不上表）—— 只在 CONFIG.log.console 开时记 5 条。
 *  这时候 JS 全程不参与，任何"右键没反应/像被吞了"的现象都要先排除这一条。 */
let weirdLeft = 5;
function weirdState(entity) {
    if (!CONFIG.log.console) return;
    if (weirdLeft <= 0) return;
    weirdLeft--;
    let v = "?", m = "?";
    try { const c = entity.getComponent("minecraft:variant"); v = c ? c.value : "无"; } catch (e) { v = "读错"; }
    try { const c = entity.getComponent("minecraft:mark_variant"); m = c ? c.value : "无"; } catch (e) { m = "读错"; }
    try { console.warn(`[dm34/farmswap] 状态解析失败 variant=${v} mark=${m} → JS 不接管本次右键`); } catch (e) { /* 忽略 */ }
}

/*
 * 卸甲残留告警：只进控制台，永不进聊天框（开关 CONFIG.log.armorGhost，默认开）。
 * 它描述的是内部槽位状态（记录已抹、实物还挂在槽里、工单排队重试），玩家该做的操作刚做完、
 * 甲也拿到了，打红字只会让人以为要重进世界。
 */
function ghostLog(msg) {
    if (!CONFIG.log.armorGhost) return;
    try { console.warn(`[dm34/armor] ${msg}`); } catch (e) { /* 忽略 */ }
}
