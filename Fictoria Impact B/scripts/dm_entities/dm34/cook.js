/*
 * cook.js — 烹饪：JS 计时器（进度存动态属性）+ 连续烹饪 + 空炒 + 自动开锅。
 * 出锅后收进背包；背包还有生食就立刻下一锅，没有也不 back —— 保持 variant 4 的空炒动画
 * （RP 由 query.variant == 4 驱动），等新食材或玩家中断。
 * 进入：手持生食右键（任何状态）/ 空手闲置时背包有生食。潜行右键打断会置
 * dm34:autocook=0，之后不再自动开锅。
 * 每一步各自 try：整段一个大 try 会一次抛错就永远跑不到收尾（卡在动画里）。
 */

import { ItemStack, system, world } from "@minecraft/server";
import { CONFIG } from "./config.js";
import { FOODS } from "./interact_tables.js";
import { isMaid, variantOf, cookCode, setCookCode, resolveState } from "./maid_state.js";
import { dropItemNear, putIntoContainer, compactStacks } from "./slot_io.js";
import { bagFirstOf } from "./guard.js";
// 女仆名单直接用目标管理引擎每 5 tick 扫出来的那份，不再自己 getEntities
import { forEachMaid } from "../common/core/maid_registry.js";

const DM34 = "player:dm34";
const AUTO_PROP = "dm34:autocook";   // 1 / 未设置 = 允许自动烹饪；0 = 玩家手动中断过，暂停自动
/** 背包整理每几轮巡检做一次。巡检 40t 一轮 → 200t（10 秒）一次，
 *  扫 36 格纯读，比每轮都扫省一个数量级。 */
const TIDY_EVERY = 5;

/*
 * 正在跑的计时器：entityId → { n, stage, at, tok }
 * stage cook = 等这锅烧完；stage store = 已出锅，等熟食进背包；
 * at = 登记时的 system.currentTick，用来判「这条记录挂太久了」（计时器丢了没人收）；
 * tok = 单调递增的锅号，每条计时器回调都带着自己的 tok。
 * 需要 tok 的理由：同种食材连做两锅时 n 完全相同，旧计时器醒来只看 `cookCode === n*2`
 * 会把自己的判断套在新锅上（新锅刚开始，进度也是 n*2），于是新锅被提前出锅；用 tok 认领，
 * 过期回调一律不认。巡检靠 n/stage 判断「计时器是真丢了还是在正常烧」。
 */
const liveCook = new Map();
let tokSeq = 0;

function idOf(entity) {
    try { return entity.id; } catch (e) { return undefined; }
}

function nowTick() {
    try { return system.currentTick; } catch (e) { return 0; }
}

/** 登记一条新的计时器，返回它的锅号。同一实体上会覆盖旧记录（旧回调随之作废） */
function beginTimer(entity, n, stage) {
    const tok = ++tokSeq;
    const id = idOf(entity);
    if (id !== undefined) liveCook.set(id, { n, stage, at: nowTick(), tok });
    return tok;
}

function untrack(entity) {
    const id = idOf(entity);
    if (id === undefined) return;
    liveCook.delete(id);
}

/** 只删自己的那条（tok 对得上才删），别误删已经接管的新锅 */
function untrackTok(entity, tok) {
    const id = idOf(entity);
    if (id === undefined) return;
    const e = liveCook.get(id);
    if (e && e.tok === tok) liveCook.delete(id);
}

/** 这条回调是不是当前有效的那一条 */
function stillMine(entity, tok) {
    const id = idOf(entity);
    if (id === undefined) return false;
    const e = liveCook.get(id);
    return !!e && e.tok === tok;
}

/** 这条记录挂了多久（tick）。没有记录返回 -1 */
function ageOf(entity, n, stage) {
    const id = idOf(entity);
    if (id === undefined) return -1;
    const e = liveCook.get(id);
    if (!e || e.n !== n || e.stage !== stage) return -1;
    return Math.max(0, nowTick() - e.at);
}

function comp(entity, id) {
    try {
        return entity.getComponent(id);
    } catch (e) {
        return undefined;
    }
}

function containerOf(entity) {
    const inv = comp(entity, "minecraft:inventory");
    return inv ? inv.container : undefined;
}

function foodByN(n) {
    return FOODS.find((x) => x.n === n);
}

/** 自动烹饪是否被玩家手动中断过 */
export function autoSuppressed(entity) {
    try {
        return entity.getDynamicProperty(AUTO_PROP) === 0;
    } catch (e) {
        return false;
    }
}

export function setAutoSuppressed(entity, on) {
    try {
        entity.setDynamicProperty(AUTO_PROP, on ? 0 : 1);
    } catch (e) { /* 忽略 */ }
}

/** 玩家用手持生食交互 → 解除"手动中断"的封印 */
export function clearAutoSuppress(entity) {
    setAutoSuppressed(entity, false);
}

/** 把一件物品塞进她的背包；满了就掉在脚下 */
export function stashItem(entity, itemId, amount) {
    if (!itemId) return;
    let left;
    try {
        left = new ItemStack(itemId, amount || 1);
    } catch (e) {
        return;      // 造不出这件物品（id 写错）—— 静默，别把调用方的流程带崩
    }
    const c = containerOf(entity);
    if (c) {
                // 这是她自己的容器，仍用 putIntoContainer（addItem 满包时会动已有格子）。
                // 从 bagFirstOf 起写：这只女仆容器 36 格没有伪槽 → 起点 0，即玩家看到的第 1 格。
        try {
            left = putIntoContainer(c, left, bagFirstOf(c));
        } catch (e) {
            /* 保持 left 原样，下面落地 */
        }
    }
    if (!left) return;
    try {
        entity.dimension.spawnItem(left, entity.location);
    } catch (e) { /* 忽略 */ }
}

/** 日志总闸（CONFIG.log.console，默认关）。排查"有食材不炒"时打开 */
function clog(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/cook] ${msg}`); } catch (e) { /* 忽略 */ }
}

/*
 * 烹饪语音（开锅 dm34_cook_start / 出锅 dm34_cook_over）的冷却表：entityId → 上次播报的 tick。
 * 这两声原来挂在 cook_Na / cook_Nb 事件里（queue_command 的 playsound），只能随事件播；自动
 * 连锅时一锅 3 秒，每锅「开始」+「好了」两声，连着做十块肉就是二十声。事件不能条件化，只能
 * 把声音挪到 JS：按 CONFIG.cook.voiceCoolTicks 节流，冷却内只留第一声。
 * 玩家亲手用生食喂的那一锅 manual=true，永远播（主动操作总得有反馈）。
 */
const lastVoice = new Map();

function voice(entity, soundId, manual) {
    const now = nowTick();
    const id = idOf(entity);
    if (id !== undefined) {
        const last = lastVoice.get(id);
        if (!manual && last !== undefined && now - last < CONFIG.cook.voiceCoolTicks) return;
        lastVoice.set(id, now);
        // 实体卸载后 id 会变，表定期清一次，免得无限长
        if (lastVoice.size > 64) {
            for (const [k, v] of lastVoice) {
                if (now - v > CONFIG.cook.voiceCoolTicks * 4) lastVoice.delete(k);
            }
        }
    }
    try {
        entity.dimension.playSound(soundId, entity.location, {
            volume: CONFIG.cook.voiceVolume,
            pitch: 1.0,
        });
    } catch (e) { /* 实体已卸载 / 维度读不到，静默 */ }
}

/*
 * 背包里第一份生食的食材编号，并扣掉 1 个；没有返回 0。
 * 从 0 号格扫起（比 bagFirstOf=1 多扫一格马鞍槽）：这里只认同 FOODS 表里的那 10 种生食材，
 * 鞍或别的物品都不会被误匹配，多扫一格是安全的。历史教训：以前以为前 2 格是伪槽、从
 * `bagFirstOf`(2) 起扫，结果玩家放进第 1 格的生食永远扫不到，表现为锅里空转、背包里
 * 明明有肉却怎么都不下锅。
 */
function takeRawFoodFromBag(entity) {
    const c = containerOf(entity);
    if (!c) return 0;
    let size = 0;
    try {
        size = c.size;
    } catch (e) {
        return 0;      // 容器读不到（实体正在卸载）→ 当作没有食材
    }
    let scanned = 0;
    for (let i = 0; i < size; i++) {
        let item;
        try {
            item = c.getItem(i);
        } catch (e) {
            item = undefined;
        }
        if (!item) continue;
        const f = FOODS.find((x) => x.raw === item.typeId);
        if (!f) continue;
        scanned++;
        try {
            if (item.amount > 1) {
                item.amount -= 1;
                c.setItem(i, item);
            } else {
                c.setItem(i, undefined);
            }
        } catch (e) {
            continue;
        }
        clog(`取食材 n=${f.n} @格${i}（共 ${scanned} 处生食）`);
        return f.n;
    }
    clog(`背包无生食（扫了 ${size} 格，size=${size}，bagFirst=${bagFirstOf(c)}）`);
    return 0;
}

/*
 * 开始一锅（假定组已经切到 cook_Na）
 * @param {number} n 食材编号 1..10｜@param {boolean} [manual] 玩家亲手喂的 → 语音不受冷却限制
 */
export function startCook(entity, n, manual) {
    if (!n) return;
    setCookCode(entity, n * 2);
    voice(entity, "dm34_cook_start", manual);
    const tok = beginTimer(entity, n, "cook");
    system.runTimeout(() => finishCook(entity, n, tok), CONFIG.cook.ticks);
}

/** 出锅：切到 cook_Nb（熟食挂手上），再过 1 秒自动收进背包 */
export function finishCook(entity, n, tok) {
    try {
        if (!entity || !entity.isValid) {
            untrackTok(entity, tok);
            return;
        }
        // 这条回调是过期的那一条（同种食材又开了一锅，新锅已接管）→ 什么都不碰
        if (!stillMine(entity, tok)) return;
        if (cookCode(entity) !== n * 2) {             // 被打断 / 被换菜（这条计时器已作废）
            untrackTok(entity, tok);
            return;
        }
        if (variantOf(entity) !== 4) {
            // 人已经不在烹饪态了：进度作废，东西由离开路径（abortCook / back）处理
            setCookCode(entity, 0);
            untrackTok(entity, tok);
            return;
        }
        entity.triggerEvent(`cook_${n}b`);
        setCookCode(entity, n * 2 + 1);
        voice(entity, "dm34_cook_over", false);
        const tok2 = beginTimer(entity, n, "store");
        system.runTimeout(() => storeFinished(entity, n, tok2), CONFIG.cook.storeDelayTicks);
    } catch (e) {
        /* 实体已卸载等，静默 */
    }
}

/**
 * 出锅 1 秒后：熟食收进背包 → 有生食就下一锅 → 没食材就回闲置。
 * 每一步各自兜异常。
 */
export function storeFinished(entity, n, tok) {
    // 异常兜底：中途抛错就照旧回闲置，别留一个半截的烹饪态
    let clean = false;
    try {
        if (!entity || !entity.isValid) {
            untrackTok(entity, tok);
            return;
        }
        if (!stillMine(entity, tok)) return;
        if (cookCode(entity) !== n * 2 + 1) {
            // 玩家已提前取走 / 这一锅被换掉：只撤掉自己的登记
            untrackTok(entity, tok);
            return;
        }

        const f = foodByN(n);
        setCookCode(entity, 0);
        untrack(entity);
        clean = true;

        if (f) {
            try { stashItem(entity, f.cooked, 1); } catch (e) { /* 熟了没塞进包 → 进背包是尽力而为 */ }
        }

        // 连锅：还有生食就继续，保持 variant==4，动画不中断
        if (canKeepCooking(entity)) {
            const next = takeRawFoodFromBag(entity);
            if (next) {
                try {
                    entity.triggerEvent(`cook_${next}a`);
                    startCook(entity, next);
                    return;                            // 已开下一锅，动画继续
                } catch (e) {
                    // 切不过去就把这份食材还回去，不能吞掉玩家的东西
                    try { stashItem(entity, (foodByN(next) || {}).raw, 1); } catch (e2) { /* 忽略 */ }
                }
            }
        }
    } catch (e) {
        /* 落到下面的兜底 */
    }
    if (!clean) {
        goIdle(entity);        // 出错 → 老实回闲置，别卡在半个烹饪态上
        untrack(entity);
        return;
    }
    // 没食材 → **保持展示熟食**（`holdDone`）。
    // `cook_Nb` 组还挂着，里面自带一件熟食展示件；`cookCode` 已是 0（锅是空的），
    // 下一轮巡检的 ② 分支会继续盯着背包 —— 一放生食就接着下锅。
    // 只有 `canKeepCooking` 为假（潜行右键封印 / 骑乘 / 自动关）才回闲置。
    if (CONFIG.cook.holdDone === false) goIdle(entity);
    untrack(entity);
}

/**
 * 能不能一直待在烹饪动画里（空炒也走这个判断）。为假才回闲置：
 * 自动烹饪关 / 被潜行右键封印 / 骑乘中 / variant 已不是 4。
 */
function canKeepCooking(entity) {
    if (!CONFIG.cook.auto) return false;
    if (autoSuppressed(entity)) return false;
    try {
        if (variantOf(entity) !== 4) return false;
        if (entity.getComponent("minecraft:riding")) return false;
    } catch (e) {
        return false;
    }
    return true;
}

/** 触发 back 回闲置空手 */
function goIdle(entity) {
    try {
        entity.triggerEvent("back");
    } catch (e) {
        /* 忽略 */
    }
}

/** 玩家手持生食右键 → 无论当前什么状态，直接开这锅。
 *  @returns {boolean} 是否真的开了 */
export function cookWithFood(entity, n) {
    if (!n) return false;
    clearAutoSuppress(entity);          // 玩家主动喂 → 解除中断封印
    abortCook(entity);                  // 锅里原来的东西先退回背包
    try {
        entity.triggerEvent(`cook_${n}a`);
    } catch (e) {
        return false;
    }
    startCook(entity, n, true);         // 玩家亲手喂 → 开锅语音必播
    return true;
}

/** 烹饪态下潜行右键：cook_a 中断（生食退回背包）/ cook_b 熟食给玩家。
 *  两种都算手动中断，之后不再自动开锅。
 *  @returns {boolean} 是否处理了 */
export function cookSneakAction(player, entity, st) {
    const n = st.cookN;
    const code = cookCode(entity);
    setAutoSuppressed(entity, true);
    if (!n) {
        setCookCode(entity, 0);
        untrack(entity);
        goIdle(entity);
        return true;
    }
    const f = foodByN(n);
    if (code === n * 2 + 1) {
        // 已出锅：熟食掉在**她脚下**（A 方案，见 slot_io.dropItemNear）——
        // 这就是"提前在 1 秒前获取熟食"
        setCookCode(entity, 0);
        if (f) {
            const food = new ItemStack(f.cooked, 1);
            if (!dropItemNear(entity, food)) dropItemNear(player, food);
        }
    } else {
        // 还在烧：生食退回她的背包
        setCookCode(entity, 0);
        if (f) stashItem(entity, f.raw, 1);
    }
    untrack(entity);
    goIdle(entity);
    return true;
}

/** 因别的原因离开烹饪态：锅里的东西不能凭空消失，生食退回背包、熟食进背包。 */
export function abortCook(entity) {
    const code = cookCode(entity);
    if (!code) return;
    setCookCode(entity, 0);
    untrack(entity);
    const n = code >> 1;
    const done = (code & 1) === 1;
    const f = foodByN(n);
    if (!f) return;
    stashItem(entity, done ? f.cooked : f.raw, 1);
}

/** 立刻清空烹饪进度（不产出任何东西；只有"东西本来就不存在"的场合才用） */
export function clearCook(entity) {
    if (cookCode(entity) !== 0) setCookCode(entity, 0);
    untrack(entity);
}

/*
 * 外部补一锅收尾（幻域球放回时用）：登记 + 排一次 storeFinished。
 * 收尾必须带自己的锅号，所以由 cook.js 内部生成，调用方拿不到也不用管。
 * @param {number} delay 延迟多少 tick 补收，默认 1
 */
export function resumeStore(entity, n, delay) {
    if (!n) return;
    const tok = beginTimer(entity, n, "store");
    system.runTimeout(() => storeFinished(entity, n, tok), delay || 1);
}

/** 自动烹饪巡检：只在她空手闲置时把背包生食下锅；战斗/耕种/持物态一律不动。 */
export function tryAutoCook(entity) {
    if (!CONFIG.cook.auto) return false;
    if (!entity || !entity.isValid) return false;
    if (entity.typeId !== DM34) return false;
    if (cookCode(entity) !== 0) return false;
    if (autoSuppressed(entity)) return false;

    const st = resolveState(entity);
    if (!st || st.key !== "in1") return false;
    // 采集任务在身（挖矿 / 砍树）→ 别掏锅：她正扛着镐，切烹饪会把工具留在记录里
    try {
        if (entity.getDynamicProperty(CONFIG.gather.jobProp)) return false;
    } catch (e) { /* 忽略 */ }
    try {
        if (entity.getComponent("minecraft:riding")) return false;
    } catch (e) { /* 忽略 */ }

    const n = takeRawFoodFromBag(entity);
    if (!n) return false;

    try {
        entity.triggerEvent(`cook_${n}a`);
    } catch (e) {
        stashItem(entity, (foodByN(n) || {}).raw, 1);   // 进不去就把食材还回去
        return false;
    }
    startCook(entity, n);
    return true;
}

/*
 * 巡检：保证烹饪动画和锅里的东西对得上。
 * variant 4 + 进度 0 = 链条断了（空炒已取消）：能接着做就做，否则回闲置。
 * 其余：状态不在烹饪态 → 进度作废；在烧但计时器丢了/挂太久 → 重挂；已出锅但收尾丢了/
 * 挂太久 → 补一次。计时器在不在看 liveCook 表 + 悬挂时长，不靠时间估算。
 */
export function recoverStuckCook(entity) {
    if (!entity || !entity.isValid) return;
    if (entity.typeId !== DM34) return;

    let v = 0;
    try { v = variantOf(entity); } catch (e) { return; }

    // ① 状态已经不在烹饪态了：进度残留一律清掉
    if (v !== 4) {
        if (cookCode(entity) !== 0) setCookCode(entity, 0);
        untrack(entity);
        return;
    }

    const code = cookCode(entity);

    // ② 动画在、锅是空的 —— 链条断了。有食材就接着下锅，没食材就回闲置
    if (!code) {
        if (!canKeepCooking(entity)) {     // 封印 / 骑乘 / 自动烹饪关 / 状态已变
            goIdle(entity);
            return;
        }
        const next = takeRawFoodFromBag(entity);   // 有新食材就接着下锅
        if (next) {
            try {
                entity.triggerEvent(`cook_${next}a`);
                startCook(entity, next);
            } catch (e) {
                try { stashItem(entity, (foodByN(next) || {}).raw, 1); } catch (e2) { /* 忽略 */ }
            }
            return;
        }
        // 没食材 → **保持展示熟食**（`holdDone`）：`cook_Nb` 组继续挂着，
        // 手上那件熟食是组自带的展示件，看起来就是"端着刚做好的菜"。
        // 玩家潜行右键会设封印度 → `canKeepCooking` 为假 → 上面那条已经 `goIdle` 了。
        if (CONFIG.cook.holdDone === false) goIdle(entity);
        return;
    }

    const n = code >> 1;
    if (!n) {                             // 进度不可能出现的值 → 直接作废
        setCookCode(entity, 0);
        goIdle(entity);
        return;
    }

    // ③ 还在烧：计时器丢了，或者挂得远超一锅的时间（回调静默失败）→ 重挂
    if ((code & 1) === 0) {
        const age = ageOf(entity, n, "cook");
        if (age < 0 || age > CONFIG.cook.ticks + 60) {
            if (age > 0) clog(`③ 计时器悬挂 ${age}t（阈值 ${CONFIG.cook.ticks + 60}），重挂 n=${n}`);
            startCook(entity, n);
        }
        return;
    }

    // ④ 已出锅但没人收：记录丢了，或者挂得远超收尾时间 → 补收一次
    const storeAge = ageOf(entity, n, "store");
    if (storeAge < 0 || storeAge > CONFIG.cook.storeDelayTicks + 60) {
        if (storeAge > 0) clog(`④ 收尾悬挂 ${storeAge}t（阈值 ${CONFIG.cook.storeDelayTicks + 60}），补收 n=${n}`);
        resumeStore(entity, n, 1);
    }
}

/** 上次巡检看到的生食总份数：entityId → 数量。只在"被封印"的女仆上记账 */
const rawSeen = new Map();

/** 背包里生食材的总份数（只数 FOODS 里的原料，熟食不算） */
function rawFoodTotal(entity) {
    const c = containerOf(entity);
    if (!c) return 0;
    let size = 0;
    try { size = c.size; } catch (e) { return 0; }
    let total = 0;
    for (let i = 0; i < size; i++) {
        let it;
        try { it = c.getItem(i); } catch (e) { continue; }
        if (!it) continue;
        if (FOODS.some((x) => x.raw === it.typeId)) total += (it.amount || 1);
    }
    return total;
}

/*
 * 玩家主动往她背包里塞生食材 = 明确想让她做饭 → 解除「手动中断」的封印。
 * 容器没有变化事件，只能靠巡检比对生食总数是否变多。没被封印的女仆不记账也不扫描（常态零开销）。
 */
function noteRawFood(entity) {
    const id = idOf(entity);
    if (id === undefined) return;
    if (!autoSuppressed(entity)) {
        if (rawSeen.size) rawSeen.delete(id);
        return;
    }
    const total = rawFoodTotal(entity);
    const prev = rawSeen.get(id);
    if (prev !== undefined && total > prev) {
        clearAutoSuppress(entity);
        clog(`玩家放入生食（${prev} → ${total} 份）→ 解除自动烹饪封印`);
    }
    rawSeen.set(id, total);
}

/** 启动：存档补时 + 自动烹饪巡检 + 卡死自愈 */
export function initCook() {
    // ① 存档里还留着"烹饪中"：重进世界后接着烧
    try {
        world.afterEvents.entityLoad.subscribe((ev) => {
            const entity = ev.entity;
            if (!isMaid(entity)) return;
            const code = cookCode(entity);
            if (!code) return;
            if ((code & 1) === 1) {
                const n = code >> 1;
                if (variantOf(entity) === 4) {
                    resumeStore(entity, n, 20);
                } else {
                    setCookCode(entity, 0);
                    untrack(entity);
                }
                return;
            }
            if (variantOf(entity) === 4) {
                const n = code >> 1;
                // 存档补时是"1 秒后出锅"，不是重新烧一整锅 —— 只登记一下正在跑，
                // 好让巡检的"计时器丢了"判据不误判。
                const tok = beginTimer(entity, n, "cook");
                system.runTimeout(() => finishCook(entity, n, tok), 20);
            } else {
                setCookCode(entity, 0);
                untrack(entity);
            }
        });
    } catch (e) { /* 旧版本没有 entityLoad，忽略 */ }

        // ② 巡检：卡死自愈无条件跑（手动喂食也会卡），自动开锅才看 CONFIG.cook.auto。
    let running = false;
    let round = 0;                    // 巡检轮次，用来把背包整理压到低频
    system.runInterval(() => {
        if (running) return;          // 上一轮还没跑完（实体多的时候防重入）
        running = true;
        round = (round + 1) % TIDY_EVERY;
        try {
            // 名单来自目标管理引擎（每 5 tick 重建受管单位表时顺手登记），
            // 不再自己 getEntities。那份名单同时含 dm34_1，这里按 typeId 过滤。
            forEachMaid((e) => {
                if (e.typeId !== DM34) return;
                // 先记账再动手：takeRawFoodFromBag 会扣食材，顺序反了会把"扣掉"当成"玩家取走"
                try { noteRawFood(e); } catch (err) { /* 单只出错不影响其它 */ }
                try { recoverStuckCook(e); } catch (err) { /* 单只出错不影响其它 */ }
                try { tryAutoCook(e); } catch (err) { /* 单只出错不影响其它 */ }
                // 熟肉按锅产出，一格一块会把背包平铺满 —— 定期收拢一次历史散堆。
                // 只扫烹饪态：散堆的唯一来源就是出锅入包（那时必是 variant 4），
                // 闲置女仆的背包不会自己长出散堆，没必要为它付扫描成本。
                if (round === 0 && variantOf(e) === 4) {
                    try {
                        const c = containerOf(e);
                        if (c) compactStacks(c, bagFirstOf(c));
                    } catch (err) { /* 单只出错不影响其它 */ }
                }
            });
        } catch (e) {
            /* 忽略 */
        } finally {
            running = false;
            // 实体卸载后 id 会变，记账表定期清一次，免得无限增长
            if (rawSeen.size > 64) rawSeen.clear();
        }
    }, CONFIG.cook.autoIntervalTicks);
}
