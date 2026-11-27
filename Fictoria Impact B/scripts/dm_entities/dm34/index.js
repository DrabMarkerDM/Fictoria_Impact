/**
 * index.js — dm34 交互层入口（被 main.js import 一次即生效）。
 *
 * 只挂 afterEvents.playerInteractWithEntity：原生动作已执行、能拿到 beforeItemStack。
 * before 通道已移除（同 tick 会互相顶掉去重表）。
 */

import { system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { isMaid, isOwner, ownerIdOf, variantOf, markOf, handIdOf, acceptsArmor } from "./core/maid_state.js";
import { handleInteract } from "./core/interact_router.js";
import { initCook } from "./life/cook.js";
import { refreshWeaponDisplay } from "./inventory/weapon_store.js";
import { initGuard, recordArmor, armorRecord, reclaimGroundArmor, refreshTorchTag } from "./combat/guard.js";
import { armorSlotOf } from "./inventory/equip.js";
import { ARMOR_SLOT } from "./core/armor_table.js";
import { serializeItem } from "./core/slot_io.js";
import { initBallSync } from "./ball/ball_sync.js";
import { initShield, recordShield, shieldRecord } from "./combat/shield.js";
import { initCrossbowAim } from "./combat/crossbow_aim.js";
import { initDeathDrop } from "./life/death_drop.js";
import { initBallDeathReturn } from "./ball/ball_death_return.js";
import { initGather } from "./gather/gather.js";
import { initFarmFortune } from "./gather/farm_fortune.js";
import { registerBallExtension } from "../common/fictoria_logic/fictoria_ball.js";

let inited = false;

/** 同一 tick 内同一对玩家/实体只处理一次 */
const handled = new Map();

/** 交互链路诊断剩余配额，总闸在 CONFIG.log */
let diagLeft = CONFIG.log.debug && CONFIG.log.chat ? CONFIG.log.diagQuota : 0;

function diag(msg) {
    if (!CONFIG.log.debug) return;
    if (CONFIG.log.console) {
        try { console.warn(`[dm34/diag] ${msg}`); } catch (e) { /* 忽略 */ }
    }
    if (diagLeft > 0) {
        diagLeft--;
        try { world.sendMessage(`§8[dm34] §7${msg}`); } catch (e) { /* 忽略 */ }
    }
}

function logError(msg) {
    if (CONFIG.log.console) {
        try { console.warn(`[dm34/interact] ${msg}`); } catch (e) { /* 忽略 */ }
    }
    if (CONFIG.log.chat) {
        try { world.sendMessage(`§c[dm34] ${msg}`); } catch (e) { /* 忽略 */ }
    }
}

/** 已记过「跳过非女仆」的 typeId：交互事件对任何实体都触发，按类型只记一次 */
const nonMaidLogged = new Set();

/** 一次交互的公共入口（channel 只用于诊断） */
function onInteract(player, target, channel, opts) {
    // 先判是不是女仆再碰状态，否则与牛/村民交互也会写 handled、耗光聊天栏配额
    let maid = false;
    try { maid = isMaid(target); } catch (e) { maid = false; }
    if (!maid) {
        const tid = (target && target.typeId) || "?";
        if (!nonMaidLogged.has(tid)) {
            nonMaidLogged.add(tid);
            if (CONFIG.log.debug && CONFIG.log.console) {
                try { console.warn(`[dm34/diag] ${channel}: 跳过非女仆实体（${tid}），后续同类不再记录`); } catch (e) { /* 忽略 */ }
            }
        }
        return;
    }

    let key;
    try {
        key = `${player.id}|${target.id}`;
    } catch (e) {
        return;
    }
    const tick = system.currentTick;
    if (handled.get(key) === tick) return;
    handled.set(key, tick);
    if (handled.size > 400) handled.clear();

    try {
        if (diagLeft > 0) {
            diag(`${channel}: ${target.typeId} variant=${variantOf(target)} mark=${markOf(target)} hand=${handIdOf(player) || "空手"} owner=${isOwner(player, target)} sneak=${!!player.isSneaking}`);
            let dpRaw = "(无)";
            try { dpRaw = JSON.stringify(target.getDynamicProperty("ownerId")); } catch (e) { dpRaw = "(读异常)"; }
            diag(`  ownerId=${ownerIdOf(target) || "(读不出)"} playerId=${player.id} dp.ownerId=${dpRaw}`);
        }
        handleInteract(player, target, opts);
    } catch (e) {
        logError(`交互处理异常: ${e && e.message ? e.message : e}`);
        if (CONFIG.log.console) {
            try { console.warn(e && e.stack ? e.stack : e); } catch (e2) { /* 忽略 */ }
        }
    }
}

export function initDm34Interact() {
    if (inited) return;
    inited = true;

    // 烹饪：计时器 + 自动烹饪 + 出锅入包 + 存档补时
    try { initCook(); } catch (e) { logError(`initCook 失败: ${e}`); }

    // 巡检：火把 → 发光标签；残留盔甲工单重试
    try { initGuard(); } catch (e) { logError(`initGuard 失败: ${e}`); }

    // 幻域球兼容：收回时保住装备槽 + 脚本写的动态属性，放置时装回去
    try { initBallSync(registerBallExtension); } catch (e) { logError(`initBallSync 失败: ${e}`); }

    // 盾牌：举盾巡检 + beforeEvents.entityHurt 格挡。必须在 initEventBus 之前登记
    try { initShield(); } catch (e) { logError(`initShield 失败: ${e}`); }

    // 弩：举弩/放下时机由 JS 写 dm34:aim（动画控制器读不到的"射出"信号只能在这里拿）
    try { initCrossbowAim(); } catch (e) { logError(`initCrossbowAim 失败: ${e}`); }

    // 死亡回球：必须排在 initDeathDrop 之前 —— 它先判定玩家背包里有没有对应颜色的空球，
    // 有就 markBallHandled，后面的 death_drop 让路（否则同一条记录会在地上再丢一份真件）
    try { initBallDeathReturn(); } catch (e) { logError(`initBallDeathReturn 失败: ${e}`); }

    // 死亡掉落：自定义实体不会掉装备槽，靠记录把真件还给玩家
    try { initDeathDrop(); } catch (e) { logError(`initDeathDrop 失败: ${e}`); }

    // 采集：敲击巡检（寻路交给原生 move_to_block）
    try { initGather(); } catch (e) { logError(`initGather 失败: ${e}`); }

    // 耕地时运补偿：引擎的 harvest_farm_block 不吃主手附魔，靠掉落物事件补量
    try { initFarmFortune(); } catch (e) { logError(`initFarmFortune 失败: ${e}`); }

    // ② after：原生交互成功之后
    try {
        world.afterEvents.playerInteractWithEntity.subscribe((ev) => {
            const before = ev.beforeItemStack;
            // 潜行时 JSON 的盔甲条目全带 is_sneaking == false，引擎不会装甲。
            // 这里不排除潜行的话 router 会误以为原生已处理而 return false，
            // 潜行该走的 leaveState / 中断烹饪全失效，还会凭空记一笔甲
            let sneaking = false;
            try { sneaking = !!ev.player.isSneaking; } catch (e) { /* 忽略 */ }

            // 是否由原生的 equip_item_slot 条目处理：是则 JS 必须放手，
            // 否则会用命令摆一件白板副本，把带附魔的真件盖掉
            let nativeArmor = false;
            try {
                nativeArmor = !!(before && ARMOR_SLOT[before.typeId] && acceptsArmor(ev.target) && !sneaking);
            } catch (e) { /* 忽略 */ }

            // beforeItemStack 必须传：引擎已把她手里那件甲拿走，after 里主手是空的，
            // 只读主手会跳过盔甲分支 → 空手兜底 sit_1 命中，一次右键两个动作
            onInteract(ev.player, ev.target, "after", {
                nativeArmor,
                beforeTypeId: before ? before.typeId : undefined,
                // 栈本身也要传：锄头/武器/镐斧的真件数据只能从这里拿到
                beforeStack: before,
            });
            // 盾牌：引擎的 equip_item_slot(offhand) 已把真件搬进副手，这里补记 dm34:shield
            //（卸盾重建、丢件自愈靠它）。已有记录时不覆盖
            try {
                if (before && before.typeId === "minecraft:shield" && !sneaking
                    && String(ev.target.typeId) === "player:dm34" && !shieldRecord(ev.target)) {
                    recordShield(ev.target, serializeItem(before), ev.player);
                }
            } catch (e) { /* 忽略 */ }
            // 原生 equip_item_slot 不经过 equipArmor，必须补记 dm34:armor（卸甲按它还原）；
            // 旧甲被引擎的 drop_item_slot 掉在附近，要捞回来，否则就是"甲被吞了"
            try {
                if (before && ARMOR_SLOT[before.typeId] && acceptsArmor(ev.target) && !sneaking) {
                    const target = ev.target;
                    const slotName = armorSlotOf(before.typeId);
                    if (slotName) {
                        let oldRec;
                        try { oldRec = armorRecord(target)[slotName]; } catch (e) { oldRec = undefined; }
                        try { recordArmor(target, slotName, serializeItem(before)); } catch (e) { /* 忽略 */ }
                        // carrier=bag 的记录表示实物在背包里，槽里那件是残影，不收
                        if (oldRec && oldRec.id && !oldRec.carrier) {
                            try { reclaimGroundArmor(target, oldRec.id); } catch (e) { /* 忽略 */ }
                        }
                    }
                }
            } catch (e) { /* 忽略 */ }

            // 这次交互可能给她或从她那儿拿走火把：等 1 tick 让引擎结算完再判
            try {
                const tgt = ev.target;
                if (isMaid(tgt)) {
                    system.runTimeout(() => {
                        try { refreshTorchTag(tgt); } catch (e) { /* 实体已失效 */ }
                    }, 1);
                }
            } catch (e) { /* 忽略 */ }
        });
        diag("订阅 afterEvents.playerInteractWithEntity 成功");
    } catch (e) {
        diag(`订阅 afterEvents 失败: ${e && e.message ? e.message : e}`);
    }

    // 她挥砍时主手替身会掉耐久：拉回与真货一致，打碎了就重建
    try {
        world.afterEvents.entityHitEntity.subscribe((ev) => {
            try {
                const attacker = ev.damagingEntity;
                if (!attacker || !isMaid(attacker)) return;
                if (attacker.typeId !== "player:dm34") return;
                refreshWeaponDisplay(attacker);
            } catch (e) { /* 忽略 */ }
        });
    } catch (e) {
        logError(`订阅 entityHitEntity 失败: ${e}`);
    }

    // 启动横幅只进内容日志，聊天栏只留玩家操作结果
    system.runTimeout(() => {
        try {
            console.warn("[dm34] 交互层已加载（JS 路由 + 盔甲 + 真武器 + 烹饪计时器 + 自动烹饪 + 背包 + 火把巡检）");
        } catch (e) { /* 忽略 */ }
    }, 40);
}

// import 即生效
initDm34Interact();
