/*
 * gather.js — 采集模式（挖矿 / 砍树）。
 * 分工：JS 扫到合法目标（自然树 / 矿石）后，在那块方块上摆一个裂痕空壳当假实体
 * （dm34:block_crack，family = dm_crack_effect），走位 / 转头 / 停下全交给
 * nearest_attackable_target → move_towards_target → look_at_target 这条原生索敌链，JS 只负责
 * 选哪一块、敲多久。
 * 不要退回 `minecraft:behavior.move_to_block`：它只挑「旁边有可站立格」的方块，矿石被石头包住、
 * 树干被树冠围住时永远寻路失败，人原地不动而 AI 全在正常跑。
 * 连锁采集（planChain）：砍一块原木整棵推倒，挖一块矿整条矿脉采完，省掉为高处第二块垫柱子；
 * 代价是必须分清自然树与玩家搭的原木建筑，判据全在 planTree / analyzeColumn 里。
 * 状态：采集单开组件组与 variant（挖矿 6 / 砍树 7），进门移除 in1，与待命态互斥；交互规则复用
 * in1 的 state 表（生成器里声明为别名状态）。
 * 不用 `minecraft:break_blocks` 敲方块：它只在她走进去时触发，破坏谁由引擎挑，掉落归属和时机都
 * 拿不到；只用来撞碎挡路的树叶。
 */

import { EquipmentSlot, ItemStack, system, world } from "@minecraft/server";
// 只为了取可选的 `BlockVolume`（批量扫方块）。用命名导入的话，万一某版本没导出
// 这个类，整个模块会在加载期就炸掉 —— 命名空间导入拿不到只会是 undefined。
import * as SAPI from "@minecraft/server";
import { CONFIG, gatherKindOf } from "./config.js";
import {
    storedGatherTool, storeGatherTool, returnGatherTool, restoreGatherDisplay,
} from "./gather_store.js";
import { clearSlot, readSlot, readMainhand, dropItemNear } from "./slot_io.js";
import { consumeHand } from "./equip.js";
import { stashItem } from "./cook.js";
import { variantOf, ownerIdOf } from "./maid_state.js";
import { forEachMaid } from "./maid_registry.js";
import { hasFarmTool } from "./farm_store.js";        // 只读记录，不反向依赖（无循环）
import { hasWeaponRecord } from "./weapon_store.js";
import { ticksWithTool, hasSilkTouch, fortuneAmount } from "./enchant.js";

const DM34 = "player:dm34";

/*
 * 挖矿目标（矿石 + 远古残骸）。
 * ⚠ 不要写 minecraft:lit_redstone_ore —— 那是 Java 版 id，基岩只有一个 redstone_ore。
 * 写进 JSON 的 breakable_blocks / target_blocks 会让整个组件加载失败，连带 break_blocks 报废
 */
const MINES = new Set([
    "minecraft:coal_ore", "minecraft:deepslate_coal_ore",
    "minecraft:iron_ore", "minecraft:deepslate_iron_ore",
    "minecraft:copper_ore", "minecraft:deepslate_copper_ore",
    "minecraft:gold_ore", "minecraft:deepslate_gold_ore", "minecraft:nether_gold_ore",
    "minecraft:redstone_ore", "minecraft:deepslate_redstone_ore",
    "minecraft:lapis_ore", "minecraft:deepslate_lapis_ore",
    "minecraft:diamond_ore", "minecraft:deepslate_diamond_ore",
    "minecraft:emerald_ore", "minecraft:deepslate_emerald_ore",
    "minecraft:quartz_ore",
    "minecraft:ancient_debris",
]);

/** 砍树目标（原木 + 下界菌柄） */
const CHOPS = new Set([
    "minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log",
    "minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log",
    "minecraft:mangrove_log", "minecraft:cherry_log", "minecraft:pale_oak_log",
    "minecraft:crimson_stem", "minecraft:warped_stem",
]);

/** 给 `dimension.getBlocks(volume, { includeTypes })` 用的数组形式（Set 传不进去） */
const CHOP_IDS = Array.from(CHOPS);
const MINE_IDS = Array.from(MINES);

/*
 * 树叶。判定自然树时用作「向上那条链的终点」（见 analyzeColumn）：
 * 从树干任意一块向上走、一路同种原木、最后碰到树叶才算树。旧 id leaves / leaves_2 一并收
 */
const LEAVES = new Set([
    "minecraft:oak_leaves", "minecraft:spruce_leaves", "minecraft:birch_leaves",
    "minecraft:jungle_leaves", "minecraft:acacia_leaves", "minecraft:dark_oak_leaves",
    "minecraft:mangrove_leaves", "minecraft:cherry_leaves", "minecraft:pale_oak_leaves",
    "minecraft:azalea_leaves", "minecraft:flowering_azalea_leaves",
    "minecraft:leaves", "minecraft:leaves_2",
]);
/** 批量扫树冠用（必须在 LEAVES 之后，否则模块加载期就 TDZ 炸掉 —— 2026-11-15 事故） */
const LEAF_IDS = Array.from(LEAVES);

/** 下界菌没有树叶，用"菌盖"当树冠。菌盖没有 persistent_bit，只能作为"这里有树冠"的证据 */
const CAPS = new Set([
    "minecraft:nether_wart_block", "minecraft:warped_wart_block", "minecraft:shroomlight",
]);

/*
 * 树能扎根的地面。原版生成的树下面一定是这一类，玩家木屋墙脚是木板 / 圆石 / 自铺地板或悬空。
 * 这一条是「树冠正好盖在房顶上」的最后一道闸（苍白橡是 pale_moss_block，红树是 mud，下界菌是 nylium）
 */
const SOIL = new Set([    "minecraft:grass_block", "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:rooted_dirt",
    "minecraft:podzol", "minecraft:mycelium", "minecraft:mud", "minecraft:clay",
    "minecraft:sand", "minecraft:red_sand", "minecraft:moss_block", "minecraft:pale_moss_block",
    "minecraft:mangrove_roots", "minecraft:muddy_mangrove_roots",
    "minecraft:crimson_nylium", "minecraft:warped_nylium", "minecraft:netherrack",
    "minecraft:soul_sand", "minecraft:soul_soil",
]);


/** 空方块（判断"下面悬空"用） */
const AIRS = new Set(["minecraft:air", "minecraft:cave_air", "minecraft:void_air"]);

/**
 * 矿石分族：`iron_ore` 和 `deepslate_iron_ore` 是同一个矿脉的两种外壳，
 * `lit_redstone_ore` 是踩亮的红石矿。连锁只在同族内扩，不跨矿种。
 */
const ORE_FAMILY = {
    "minecraft:coal_ore": "coal", "minecraft:deepslate_coal_ore": "coal",
    "minecraft:iron_ore": "iron", "minecraft:deepslate_iron_ore": "iron",
    "minecraft:copper_ore": "copper", "minecraft:deepslate_copper_ore": "copper",
    "minecraft:gold_ore": "gold", "minecraft:deepslate_gold_ore": "gold",
    "minecraft:nether_gold_ore": "gold",
    "minecraft:redstone_ore": "redstone",
    "minecraft:deepslate_redstone_ore": "redstone",
    "minecraft:lapis_ore": "lapis", "minecraft:deepslate_lapis_ore": "lapis",
    "minecraft:diamond_ore": "diamond", "minecraft:deepslate_diamond_ore": "diamond",
    "minecraft:emerald_ore": "emerald", "minecraft:deepslate_emerald_ore": "emerald",
    "minecraft:quartz_ore": "quartz",
    "minecraft:ancient_debris": "debris",
};

/** 矿脉是 3D 团块，26 邻接（含斜向）才能串起来 */
const NEIGHBOR26 = [];
for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx || dy || dz) NEIGHBOR26.push([dx, dy, dz]);
        }
    }
}

/** 树干只往上 / 往四边扩，**绝不往下** —— 往下就是地板、地基、地下其余原木。
 *  dy=2 是为了跨过"树干中间被抽掉一格"的断口（玩家开洞 / 她自己挖的）。 */
const TRUNK_DIRS = [
    [0, 1, 0], [0, 2, 0], [0, -1, 0], [0, -2, 0],
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
];

/** 破坏后产出的**基础**数量。写的是原版一次挖取的下限（时运由 enchant.js 再乘）。
 *  语义是"她替你把矿挖出来了"，不是"假装挖矿"——少给比多给安全。
 *  精准采集不走这张表，直接掉方块本体。 */
/*
 * 方块 → 掉落物表。格式 [物品id, 最小数量, 最大数量?, 时运模型?]
 * 🔴 数量是原版无时运的下限~上限，不是固定值：铜 2-5、青金石 4-9、下界金 2-6 是范围随机；
 * 红石是离散均匀（时运每级上限 +1）；其余走倍率型（见 enchant.js 的 fortuneAmount）。
 * ⚠ 不要写 Java 版 id（lit_redstone_ore 之类）
 */
const DROPS = {
    "minecraft:coal_ore": ["minecraft:coal", 1],
    "minecraft:deepslate_coal_ore": ["minecraft:coal", 1],
    "minecraft:iron_ore": ["minecraft:raw_iron", 1],
    "minecraft:deepslate_iron_ore": ["minecraft:raw_iron", 1],
    "minecraft:copper_ore": ["minecraft:raw_copper", 2, 5],
    "minecraft:deepslate_copper_ore": ["minecraft:raw_copper", 2, 5],
    "minecraft:gold_ore": ["minecraft:raw_gold", 1],
    "minecraft:deepslate_gold_ore": ["minecraft:raw_gold", 1],
    "minecraft:nether_gold_ore": ["minecraft:gold_nugget", 2, 6],
    "minecraft:redstone_ore": ["minecraft:redstone", 4, 5, "uniform"],
    "minecraft:deepslate_redstone_ore": ["minecraft:redstone", 4, 5, "uniform"],
    "minecraft:lapis_ore": ["minecraft:lapis_lazuli", 4, 9],
    "minecraft:deepslate_lapis_ore": ["minecraft:lapis_lazuli", 4, 9],
    "minecraft:diamond_ore": ["minecraft:diamond", 1],
    "minecraft:deepslate_diamond_ore": ["minecraft:diamond", 1],
    "minecraft:emerald_ore": ["minecraft:emerald", 1],
    "minecraft:deepslate_emerald_ore": ["minecraft:emerald", 1],
    "minecraft:quartz_ore": ["minecraft:quartz", 1],
    // 远古残骸：原版不吃时运（NO_FORTUNE 拦掉），只掉自己
    "minecraft:ancient_debris": ["minecraft:ancient_debris", 1],
};

/** 硬度 → 需要几 tick（按"拿对工具的人"折算，只求手感，不求精确）。
 *  查不到的木/石走 CONFIG.gather.defaultTicks。 */
/*
 * 方块硬度 → 铁级且拿对工具时的敲击 tick 数。
 * 数值 = 硬度 × 5（wiki：t = 硬度 × 1.5 / 工具速度，铁 6 速、20 tick/秒）。
 * 其它材质由 ticksWithTool 按 6/实际速度 折算，同一张表就够。
 * 对照：石头 1.5→8t、原木 2→10t、钻石矿 3→15t、远古残骸 30→150t
 */
const HARDNESS = {
    "minecraft:ancient_debris": 150,
    "minecraft:coal_ore": 15,
    "minecraft:copper_ore": 15,
    "minecraft:iron_ore": 15,
    "minecraft:gold_ore": 15,
    "minecraft:redstone_ore": 15,
    "minecraft:lapis_ore": 15,
    "minecraft:diamond_ore": 15,
    "minecraft:emerald_ore": 15,
    "minecraft:nether_gold_ore": 15,
    "minecraft:nether_quartz_ore": 4,
    "minecraft:deepslate_coal_ore": 23,
    "minecraft:deepslate_copper_ore": 23,
    "minecraft:deepslate_iron_ore": 23,
    "minecraft:deepslate_gold_ore": 23,
    "minecraft:deepslate_redstone_ore": 23,
    "minecraft:deepslate_lapis_ore": 23,
    "minecraft:deepslate_diamond_ore": 23,
    "minecraft:deepslate_emerald_ore": 23,
};

/*
 * 垫柱时可就地挖穿的自然方块（洞穴顶挡路的岩层 / 土层）。
 * 刻意不收：基岩、液体、容器、带方块实体的方块、任何建造材质（圆石 / 木板 / 砖），
 * 所以玩家的石头房会被挖（石头本身是自然材质）但圆石墙不会。挖出的原物进她包里，正好当垫块
 */
const TUNNEL = new Set([
    "minecraft:stone", "minecraft:granite", "minecraft:diorite", "minecraft:andesite",
    "minecraft:tuff", "minecraft:calcite", "minecraft:deepslate",
    "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:rooted_dirt",
    "minecraft:grass_block", "minecraft:podzol", "minecraft:mycelium", "minecraft:mud",
    "minecraft:sand", "minecraft:red_sand", "minecraft:sandstone", "minecraft:red_sandstone",
    "minecraft:clay", "minecraft:gravel",
    "minecraft:netherrack", "minecraft:basalt", "minecraft:smooth_basalt",
    "minecraft:blackstone", "minecraft:soul_sand", "minecraft:soul_soil",
]);

/** 挖穿后的产出（原版一次挖取的结果）。没列的掉自身。 */
const TUNNEL_DROP = {
    "minecraft:stone": "minecraft:cobblestone",
    "minecraft:deepslate": "minecraft:cobbled_deepslate",
    "minecraft:grass_block": "minecraft:dirt",
    "minecraft:mycelium": "minecraft:dirt",
    "minecraft:podzol": "minecraft:dirt",
    "minecraft:clay": "minecraft:clay_ball",
    "minecraft:gravel": "minecraft:gravel",
};

/** 敲击中的进度。**只在内存里**，不落盘 —— 重进世界后进度归零只是"多敲两下"，
 *  落盘反而会出现"上次未敲完的方块坐标"这种脏记录（战斗瞬态的教训）。 */
const Progress = new Map();   // entityId → { key, ticks, total, loc }

/*
 * 已废弃：以前的连锁队列（entityId → 坐标数组）逐轮推进，现在改成一键同 tick 全清。
 * 常量与散布各处的 delete 先留着 —— 删常量会让那些调用全部 ReferenceError
 */
const Chains = new Map();

/*
 * 伐木任务记忆（entityId → { id, blocks:Set, yTop, until }）。
 * 照 AI 玩家 Addon 的 FeatureCache：把整根树干记成坐标列表，方块被挖掉只是从列表剔除，
 * 所以悬空残段、木桩也能收干净。
 * 以前每轮都用 naturalTrunk 重算整棵树，树干一断当场判「不是树」→ 残骸永远留在空中
 */
const ChopTask = new Map();

function chopTaskOf(entity, kind) {
    if (kind !== "chop") return undefined;
    const t = ChopTask.get(entity.id);
    if (!t) return undefined;
    if (farClock >= t.until) {
        ChopTask.delete(entity.id);
        if (Trail.has(entity.id)) TrailCleanup.set(entity.id, farClock);   // 任务超时也要把柱子收掉
        return undefined;
    }
    return t;
}

/** 这块原木是不是"我正在收尾的那棵树"里的（O(1) 查表） */
function inChopTask(entity, kind, x, y, z, id) {
    const t = chopTaskOf(entity, kind);
    if (!t || t.id !== id) return false;
    return t.blocks.has(`${x},${y},${z}`);
}

/*
 * 砍树候选的统一闸：任务范围内直接放行，否则过自然树判定。
 * midPick / nearestTarget / farTarget 都走这一个口，免得三处判据各不相同
 */
function trunkOk(entity, kind, dim, x, y, z, id) {
    if (inChopTask(entity, kind, x, y, z, id)) return true;
    return !!naturalTrunk(dim, x, y, z, id);
}

/*
 * 正在显示的方块裂痕（entityId → { key, crack, stage }）。
 * 基岩没有「给方块设破坏进度」的接口，破坏进度是纯客户端叠加层。
 * 这里用一个 16³ 空壳实体套在方块外，贴 10 帧竖排裂纹图，由 RP 的 render_controller
 * 按 dm34:crack_duration 属性滚帧。JS 只负责 spawn 一个 + 告诉它敲多久，不逐帧喂进度。
 * 实体在 JSON 里已设 0 碰撞 / 无重力 / 不可选中 / transient，不参与任何 AI 与战斗判定
 */
const Crack = new Map();

/*
 * 同一块方块的裂痕重建退避（entityId → { key, want, at, n }）。
 * 裂痕壳若 1~2 帧内失效，每 0.5 秒重摆一次等于给索敌每 0.5 秒换一次目标，
 * acquire/lose 反复触发 target_sound。所以同一块 + 同一时长按 crackRetryTicks 指数退避；
 * 换目标才拆旧摆新，只换时长用 setProperty 就够了
 */
const CrackRetry = new Map();

/*
 * 「连续几轮扫不到目标」计数（entityId → n）。
 * 真扫那轮可能因树叶遮挡 / 方块刚碎而返回空，单轮空不算目标消失；
 * 连续 crackGraceRounds 轮都空才拆壳，否则就是放上又移除、0.5 秒一循环
 */
const CrackMiss = new Map();

/** 最近一次 `spawnCrack` 的失败原因（空 = 上次成功）。只给诊断行看 ——
 *  裂痕实体生成失败过去是**彻底静默**的，症状和"引擎没锁上"一模一样。 */
let crackErr = "";

/** SAPI 的 `system.currentTick`（1.7.0+）。读不到就退回墙钟 —— 退避精度差一点也不致命。 */
function tickNow() {
    try { return system.currentTick; } catch (e) { return Math.floor(Date.now() / 50); }
}

/** 垫柱升空的状态机（entityId → 状态）。**只在内存里**：重进世界柱子还在，
 *  但状态丢了只是"这次不垫了"，下一轮发现够不到会重新开始。 */
const Pillar = new Map();

/*
 * 垫柱刚结束时要敲的那一块（entityId → { x, y, z, until }）。
 * 垫柱状态机只负责往上垫、不敲方块，期间 tickOne 在 ③ 就 return 了 —— 于是「垫到顶」
 * 与「开始敲」之间有一段真空：走位组挂回去后引擎拽她、一站就掉，中景重建又让她几轮没目标，
 * 最后 collapseTrail 开始拆柱，她自己走下来而那块木头一次都没敲。
 * 所以垫柱成功时记住「为哪一块爬上来」并开保护窗：窗内不拆柱、不挂走位组、
 * tickOne 直接敲这块，窗口过了或敲完才把走位交还引擎
 */
const PillarDone = new Map();

/*
 * 放弃过的目标（"x,y,z" → 到期轮）。
 * 目标粘性的副作用：够不到的高处木头还在 midReach 内、垂直也在选点窗内，
 * stickyTarget 就无条件粘住它，每轮「奔向它 → 够不到 → 什么都不做」，旁边贴脸的方块永远轮不到。
 * 所以站着不动连续 giveUpRounds 轮就拉黑它 giveUpCooldown 轮，换目标照样干活
 */
const GiveUp = new Map();

/*
 * 同一块目标垫了几次柱（entityId → { key, n }）。
 * 防「垫上去 → 够不到 → 掉下来 → 再垫」死循环：垫 pillarTries 次还敲不到，
 * 说明问题不在高度（多半在树冠里或别的方块包着），拉黑换一块
 */
const PillarTries = new Map();

/*
 * 悬崖搭桥的账本（entityId → { key, n, at, lx, lz }）：n 已搭几格，at 最后一格的轮次，
 * lx/lz 最后一格坐标 —— 她必须站上去才允许再往前搭一格。
 * 🔴 不判「她站在哪」就会每轮往前丢一格，5 秒铺出十格悬空桥而人还在起点。
 * 不复用 Dig 账本：挖掘额度 digMaxBlocks(80) 与搭桥上限 bridgeMax(24) 是两个预算，混用会互相误伤
 */
const Bridge = new Map();

/*
 * 全局自然树判定缓存（跨轮、跨女仆共享）："x,z" → { id, at, n, r }。
 * analyzeColumn 一次要向下 32 格 + 向上 40 格，约 70 次跨界读；只有每轮清空的 ColumnCache 时，
 * 同一棵树会被每只女仆各验一遍、10 秒重扫后又各验一遍。结果只跟 (x,z,id) 有关，同一列所有原木
 * 答案必然相同，天然可共享；方块被挖掉时必须立刻作废（bustTrunkMemo），否则旧结论会毒化判定。
 */
const TrunkMemo = new Map();

/** 把这列（含左右各 1 列）的自然树判定作废 —— 砍断树干后相邻列也可能变 */
function bustTrunkMemo(x, z) {
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            TrunkMemo.delete(`${x + dx},${z + dz}`);
        }
    }
}

/** 形态抢回的连续失败次数（entityId → n）。`tickOne` ① 用：
 *  采集组被外部摘掉时先 `gather_mine/chop` 抢回来，连试 3 轮不行才真收工。 */
const FormFix = new Map();

/** 她垫过的柱子（entityId → [{x,y,z,id}]）。走开以后逐格拆回来还给她，
 *  所以"垫上去能挖回来"是真的能挖回来，不用玩家自己动手。 */
const Trail = new Map();

/*
 * 柱子待清理（entityId → true）。任务结束时置位，collapseTrail 见到就从高到低一路拆，
 * 不再等她走开 / 闲够轮数。脚下那格例外 —— 拆了就是摔下去，留到她离开那一列
 */
const TrailCleanup = new Map();


/** 卡住检测（entityId → { x, y, z, rounds }）。只有连位置都没变才认"走不过去"，
 *  免得她正常走路时被误判成卡住然后开始垫柱。 */
const Stuck = new Map();

/*
 * 空闲计时（entityId → 连续没有任何目标的巡检轮数）。
 * 只给拆柱用：柱子既是够高处目标的立足点，也是收工后的垃圾，拆不拆看她还用不用得上
 */
const Idle = new Map();

/*
 * 挖穿挡路岩层的账本（entityId → { key, at, tries }）。
 * key 是目标方块坐标，换目标即重置；同一块最多挖 tunnelTries 次，
 * 两次之间至少隔 tunnelCooldownRounds 轮，留时间让她走进去
 */
const TunnelCd = new Map();

/*
 * 赶路卡住（entityId → { x, z, ticks }），与 Stuck 是两回事：
 * Stuck 管「身边够不到目标、她站定了」→ 要不要垫柱；
 * PathStuck 管「目标锁着、引擎在拉，但她一步没挪」→ 要不要清树叶。两者触发条件互斥
 */
const PathStuck = new Map();

/*
 * 卡住自救的挖掘账本（entityId → { key, at, n }）。
 * 照 AI 玩家 RecoverPathProcedure：卡住 → 只拆挡路那一格 → 交回导航 → 还卡再拆下一格。
 * n 到 digMaxBlocks 还没够到就拉黑换目标，否则她会一路挖到基岩
 */
const Dig = new Map();

/*
 * 绝不许拆的方块（照 AI 玩家 RestrictedBlocks：箱子 / 工作台 / 床 / 蜂箱，
 * 再补上不可破坏方块与液体）。表外一切都可以为走到矿跟前让路，拆掉的原物掉她包里
 */
const NO_DIG = new Set([
    // 容器 / 功能方块（拆了会掉玩家家当，AI 玩家也是明确排除的）
    "minecraft:chest", "minecraft:trapped_chest", "minecraft:ender_chest",
    "minecraft:barrel", "minecraft:shulker_box", "minecraft:furnace",
    "minecraft:lit_furnace", "minecraft:blast_furnace", "minecraft:lit_blast_furnace",
    "minecraft:smoker", "minecraft:lit_smoker", "minecraft:brewing_stand",
    "minecraft:cauldron", "minecraft:hopper", "minecraft:dispenser",
    "minecraft:dropper", "minecraft:beacon", "minecraft:conduit",
    "minecraft:enchanting_table", "minecraft:anvil", "minecraft:chipped_anvil",
    "minecraft:damaged_anvil", "minecraft:grindstone", "minecraft:smithing_table",
    "minecraft:cartography_table", "minecraft:fletching_table", "minecraft:loom",
    "minecraft:stonecutter_block", "minecraft:lectern", "minecraft:bell",
    "minecraft:campfire", "minecraft:soul_campfire", "minecraft:bed",
    "minecraft:bee_nest", "minecraft:beehive", "minecraft:composter",
    "minecraft:decorated_pot", "minecraft:chiseled_bookshelf", "minecraft:bookshelf",
    "minecraft:crafter", "minecraft:vault", "minecraft:trial_spawner",
    "minecraft:spawner", "minecraft:mob_spawner", "minecraft:copper_chest",
    // 不可破坏 / 破坏会导致世界损坏
    "minecraft:bedrock", "minecraft:barrier", "minecraft:command_block",
    "minecraft:chain_command_block", "minecraft:repeating_command_block",
    "minecraft:structure_block", "minecraft:structure_void", "minecraft:jigsaw",
    "minecraft:end_portal_frame", "minecraft:reinforced_deepslate",
    "minecraft:light_block", "minecraft:deny", "minecraft:allow", "minecraft:border_block",
]);

/** 她自己的发光模式光源（2026-11-15 查明：开了发光模式会一直挖光源 → 卡死）。
 *  这几个**不算路障**：既不拆，也不因此放弃目标，直接当空气穿过去。 */
const SKIP_DIG = new Set(["block:dm_light", "block:dm_light_1"]);

/** 液体不拆（拆了是"挖穿水源"，会灌她一脸）。 */
const LIQUID = new Set([
    "minecraft:water", "minecraft:flowing_water",
    "minecraft:lava", "minecraft:flowing_lava",
]);

/*
 * 到位自救计时（entityId → 连续「引擎撒手且她不动」的轮数）。
 * 只在「有目标但不在 reach」里累加：引擎把她放到 3~4.5 格就撒手（within_radius 2.5 算的是
 * 实体距离，不是方块中心），于是每轮都在那儿 return，永远进不了敲击。
 * 累到 forceReachAfter 就把 reach 放宽 forceReachExtra 直接开敲；还在动就清零
 */
const NoProg = new Map();

/*
 * 接近进度（entityId → { key, dh, n }）。
 * 判「走不过去」不能只看相邻两轮位移：顶墙时引擎一直推，她左右滑 0.3~0.5 格，
 * 位移判据永远判「在走路」，就成了面壁死磕。这里记到目标的水平距离，
 * approachRounds 轮都没缩短 approachGain 才算真走不过去
 */
const Approach = new Map();

function approachTrack(entity, target, loc) {
    const key = keyOfTarget(target);
    const dh = Math.hypot(loc.x - (target.x + 0.5), loc.z - (target.z + 0.5));
    let ap = Approach.get(entity.id);
    if (!ap) {
        ap = { key, dh, n: 0 };
        Approach.set(entity.id, ap);
        return ap;
    }
    // 换目标了：基线换成新距离，但"一直没接近"照样累计 ——
    // 目标来回抖时要是把 n 清零，计时永远涨不起来，就又变回死磕。
    if (ap.key !== key) {
        ap.key = key;
        ap.dh = dh;
        ap.n++;
        return ap;
    }
    if (dh <= ap.dh - (CONFIG.gather.approachGain || 1)) {
        ap.dh = dh;
        ap.n = 0;
        return ap;
    }
    ap.n++;
    return ap;
}

/*
 * 目标扫描缓存（entityId → { clock, kind, target }）。
 * scanReach 24 内可能有上百块原木 / 矿石，每 0.5 秒全扫太贵，所以按 scanEvery 轮真扫一次，
 * 中间沿用上次结果。方块被敲掉时要主动删这格缓存，否则她会对着空气再站一秒
 */
const ScanCache = new Map();

/*
 * 远景引导（move_to_block）的开关状态。
 * dm_guide_mine / dm_guide_chop 里只有 behavior.move_to_block(64)，负责「远处有树/矿就先往那片走」；
 * JS 在扫描圈内扫到合法目标就摘掉它 —— 近距离精确走位交给索敌牵引，两个行为同时拉会打架。
 * GuideOn 记当前挂着哪个组，只在状态变化时才调 guide_on_* / guide_off
 */
const GuideOn = new Map();
const GuideQuiet = new Map();
// 🔴 2026-11-13 二次修：原来还有一个 `GuideOff`（"已摘掉"的集合），**初始视为"挂着"**，
//    因为那时 `gather_mine` / `gather_chop` 事件里默认就 add 了 `dm_guide_mine`。
//    结果是个死循环：
//      JSON 默认挂着 → JS 认为挂着 → 第一次 `setGuide(false)` 触发 guide_off 去摘
//      → `stopPillar(restoreWalk)` 又触发 `gather_walk_mine`，那个事件里**也** add 了
//        `dm_guide_mine`，`move_to_block` 悄悄回来了
//      → 但 `GuideOff` 里还记着"已摘"，JS 从此**再也不摘** → `move_to_block`（priority 1）
//        永久压着 `move_towards_target`（priority 6）：一个朝引擎自己挑的方块、一个朝 JS
//        摆的裂痕，两股劲对拉 → **原地抖动、位移 0、裂痕反复消失**。
//    修法是把 `dm_guide_*` 从四个 gather 事件里**全部剥离**（见 dm34.json），
//    让"引导"只由本文件的 `guide_on_*` / `guide_off` 独占控制；
//    状态判据也统一成 `GuideOn` —— **默认就是没挂**，不再需要"取反"。
//    验证器有一条静态检查守着"四个 gather 事件不许 add dm_guide_*"。

/*
 * 漫游计时（entityId → 进入漫游的 farClock），仅供诊断行显示。
 * 场景：move_to_block 把她领到一片原木边上，JS 一验全是玩家搭的墙。
 * 🔴 不用「停 60 秒」那种冷却 —— 冷却只把拉锯推后。判据换成 HadCands：
 * 只要扫描圈内还有木头候选（哪怕全是建筑）就一律不挂引导，这个环从根上不存在。
 * 摘掉后 random_stroll 不再被压制，她自己溜达；走出圈后候选归零，引导自动挂回
 */
const RoamSince = new Map();

/*
 * 上次扫到的木头候选数（entityId → n），含全部候选、不论合法与否 —— 引导开关的唯一判据：
 * n > 0 说明她就在有木头的地方，不挂引导；n == 0 才挂上让她去更远处找
 */
const HadCands = new Map();

/*
 * 引擎锁不上目标的连续轮数（entityId → n）。
 * target（JS 扫出来的）与 entity.target（引擎真锁到的）是两回事：裂痕摆好了，
 * 认不认还取决于 follow_range / within_radius / 寻路可达。曾因 dm_walk_* 没写 follow_range、
 * 引擎按默认 16 封顶，20 格外的树就成了「原地抖动一步不挪」。
 * 这里数「JS 有目标但引擎锁不到」的轮数，够 guideFallbackRounds 就把引导挂回去；锁上即清零
 */
const LockMiss = new Map();

// ── **试走验证**（2026-11-15 ，照 `AI玩家 Add-On BP` 的 `feature_reacher`）──────
//
//  它那套：发一个**飞行**探针（`can_fly` + `navigation.hover` + `has_collision:false`）
//  去 `move_to_block`，走到了才把这块矿记进"可达表"。这里改用她**自己**的 `dm_probe_*`
//  组做同一件事 —— 她挂的是走路导航，测出来的可达性才是真的（飞行探针能钻的缝，她走不过）。
//
//  🔴 不新增实体、不依赖新 API：
//    到达信号 = JSON 的 `on_reach` → `probe_hit_*` → `queue_command: tag @s add`，
//    JS 每轮读 tag。**刻意不用 `dataDrivenEntityTrigger`** —— AI 玩家包要 SAPI 2.8.0，
//    本包 manifest 是 2.7.0，那条事件在不在没有把握；tag 这条路只用既有能力。
//
//  三档（**关键：不放弃**）：
//    ① `Verified` 里有   → 直接挖（已经证明走得到）
//    ② 未验证 + 距离远   → 挂 `dm_probe_*` 试走一次，走到才挖
//    ③ 近处 / 试过超时   → 走原有链路，`repairReach`（垫柱 / 挖走廊）兜底
//
//  和 AI 玩家最大的区别就在 ③：它走不到直接换目标、被石头包住的矿**永不挖**；
//  这里只是把"够不到才去修"换成"先验证、修作为最后手段"，深矿能力一点没丢。
const Verified = new Map();      // maidId → Map("x,y,z" → 记下时的 farClock)
const ProbeTried = new Map();    // maidId → Map("x,y,z" → 冷却到期时的 farClock)
const Probe = new Map();         // maidId → { key, until, kind }
/** `probe_hit_*` 里用 `queue_command` 打的到达标记；JS 读完立刻摘。 */
const PROBE_HIT_TAG = "dm34_probe_hit";

/*
 * 挂上 / 摘掉远景引导组，只在状态变化时下发。
 * ⚠ SAPI 的 Entity 没有 addComponentGroup，开关必须走 JSON 事件
 * （guide_on_mine / guide_on_chop / guide_off，后者两个组一起摘）
 */
function setGuide(entity, kind, want) {
    const onEv = kind === "mine" ? "guide_on_mine" : "guide_on_chop";
    const on = GuideOn.get(entity.id);          // undefined = 没挂
    // 状态没变 → **一个事件都不发**。这一句是防抖的全部：
    // 她连着几十轮"有目标"时不该每轮都去 triggerEvent 一次 guide_off。
    if (want ? on === onEv : !on) return;
    try {
        // 换工种（mine ↔ chop）时先把旧组摘掉，别让两个 move_to_block 同时在场
        if (on) entity.triggerEvent("guide_off");
        entity.triggerEvent(want ? onEv : "guide_off");
        if (want) GuideOn.set(entity.id, onEv);
        else GuideOn.delete(entity.id);
    } catch (e) {
        log(`远景引导${want ? "挂上" : "摘掉"}失败（${want ? onEv : "guide_off"}）: ${e}`);
    }
}

/*
 * 引擎此刻真锁到谁了 —— 返回 typeId，没锁 / 读不到返回空串。
 * 🔴 与 scanTarget 不是一回事：那个是 JS 想敲哪块，这个才是索敌认不认脚本摆的裂痕。
 * 两者长期不一致 = 没人拉她走（见 LockMiss）。采集态走位全靠它非空
 */
function engineTargetOf(entity) {
    try {
        const t = entity.target;
        return t ? String(t.typeId || "?") : "";
    } catch (e) {
        return "";                       // 实体还没 tick / 维度卸载 → 当没锁
    }
}

/** 远目标扫描的节流计数（全局，所有女仆共享一个节拍） */
let farClock = 0;

/** 一轮巡检内的"这块原木算不算树"缓存（"x,y,z" → {top,canopy} | null）。
 *  每轮巡检开头清空 —— 不跨轮缓存是因为树会被砍、玩家会放方块。 */
let ColumnCache = new Map();

/** 最近一次判定被哪一关拒的（只用于报给人看） */
let columnWhy = "";

/** 连锁判定原因还有几条可以报进聊天框（前 12 条，之后自动静音） */
let reportBudget = 12;

/** "这些原木不算树"的提示单独计数，免得把连锁报告的名额吃光 */
let rejectBudget = 6;

/** "边上这些原木被判成不是树"的最近一次候选集合（entityId → 指纹），用来去重报信 */
const RejectNote = new Map();

function log(msg) {
    if (!CONFIG.log.console) return;
    try { console.warn(`[dm34/gather] ${msg}`); } catch (e) { /* 忽略 */ }
}

/** 异常日志的限流计数（key → 已报次数） */
const ErrBudget = new Map();

/*
 * 异常日志（限流但绝不静默）：同一条最多报 max 次（默认 3）之后安静。
 * 空 catch 会把上层 bug 吞成「她只是没反应」—— 没目标、没裂痕、没敲击，日志干干净净只能靠猜
 */
function logErr(key, e, max) {
    const cap = max || 3;
    const n = (ErrBudget.get(key) || 0) + 1;
    ErrBudget.set(key, n);
    if (n > cap) return;
    const msg = e && e.message ? e.message : String(e);
    log(`${key}: ${msg}${n === cap ? "（这条之后不再报）" : ""}`);
}

/** 把"为什么连锁 / 为什么不连锁"直接报到离她最近的玩家聊天框。
 *  只在 CONFIG.gather.reportChain 开着时有动作，且一辈子只报 reportBudget 条。 */
function report(entity, msg) {
    try { console.warn(`[dm34/gather] ${msg}`); } catch (e) { /* 忽略 */ }
    if (!CONFIG.gather.reportChain || reportBudget <= 0) return;
    reportBudget--;
    try {
        const loc = entity.location;
        let best, bestSq = Infinity;
        for (const p of world.getAllPlayers()) {
            const d = p.location;
            const dx = d.x - loc.x, dy = d.y - loc.y, dz = d.z - loc.z;
            const sq = dx * dx + dy * dy + dz * dz;
            if (sq < bestSq) { bestSq = sq; best = p; }
        }
        if (!best) return;
        const tail = reportBudget === 0 ? " §8（之后不再提示）" : "";
        best.sendMessage(`§8[采集] §7${msg}${tail}`);
    } catch (e) { /* 玩家已下线 / 维度不对 */ }
}

/** 最近一次选中的目标键（给 `forceTrace` 用，纯诊断） */
const TraceTarget = new Map();

/*
 * 强制状态行：每 20 秒一条，不经过 tickOne 的早退点。
 * tickOne 里的 trace 排在 leashCheck / Pillar / probe 之后，卡在那些地方就一条都不打，
 * 现场等于没跑脚本。这条由 tickAll 直接调用，采集态每个分支状态都摊开
 */
function forceTrace(entity) {
    if ((CONFIG.gather.traceEvery || 40) <= 0) return;
    const kind = jobOf(entity);
    let v = "?";
    try { v = String(variantOf(entity)); } catch (e) { /* 忽略 */ }
    let pos = "?";
    try {
        const l = entity.location;
        pos = `(${l.x.toFixed(1)},${l.y.toFixed(1)},${l.z.toFixed(1)})`;
    } catch (e) { /* 忽略 */ }
    const pst = Pillar.get(entity.id);
    const pd = PillarDone.get(entity.id);
    const snap = Snapshots.get(entity.id);
    let nch = 0, ncell = 0;
    if (snap) { nch = snap.chunks.size; for (const c of snap.chunks.values()) ncell += c.cells.length; }
    const tr = Trail.get(entity.id);
    const task = ChopTask.get(entity.id);
    const ap = Approach.get(entity.id);
    const cr = Crack.has(entity.id) ? "有" : "-";
    log(`[状态] job=${kind || "无"} variant=${v} ${pos} 柱=${pst ? "ON" : "-"}`
        + ` 柱窗=${pd ? Math.max(0, pd.until - farClock) : "-"} 柱块=${tr ? tr.length : 0}`
        + ` 任务=${task ? task.blocks.size : 0} 拉黑=${GiveUp.size} 接近=${ap ? ap.n : 0}`
        + ` 闲=${Idle.get(entity.id) || 0} 壳=${cr} 中景=${nch}区/${ncell}块`
        + ` 目标=${TraceTarget.get(entity.id) || "无"} 原因=${Why.get(entity.id) || "-"}`);
}

function jobOf(entity) {
    try {
        const v = entity.getDynamicProperty(CONFIG.gather.jobProp);
        return v === "mine" || v === "chop" ? v : undefined;
    } catch (e) {
        return undefined;
    }
}

/**
 * **"为什么不动"** —— 每个女仆只在原因**变化**时打一行，同一条不重复刷。
 * 排查"面壁"时最缺的就是这句：日志里干净得只剩"她没反应"。
 */
const Why = new Map();
function whyNot(entity, msg) {
    if (Why.get(entity.id) === msg) return;
    Why.set(entity.id, msg);
    log(`卡住原因：${msg}`);
}

/** 状态快照：每 entity 最多 `traceEvery` 轮一条，只进控制台。 */
const TraceAt = new Map();
function trace(entity, target, inReach) {
    const every = CONFIG.gather.traceEvery || 40;
    if (every <= 0) return;
    const last = TraceAt.get(entity.id) || -1e9;
    if (farClock - last < every) return;
    TraceAt.set(entity.id, farClock);
    let s = "位置?";
    try {
        const l = entity.location;
        s = `(${l.x.toFixed(1)},${l.y.toFixed(1)},${l.z.toFixed(1)})`;
    } catch (e) { /* 忽略 */ }
    if (target === undefined) {
        TraceTarget.delete(entity.id);
        log(`状态 ${s} 无目标`);
        return;
    }
    TraceTarget.set(entity.id, `${target.x},${target.y},${target.z}`);
    let dh = 0, dv = 0;
    try {
        const l = entity.location;
        dh = Math.hypot(l.x - (target.x + 0.5), l.z - (target.z + 0.5));
        dv = (target.y + 0.5) - l.y;
    } catch (e) { /* 忽略 */ }
    const ap = Approach.get(entity.id);
    const dg = Dig.get(entity.id);
    const pil = Pillar.has(entity.id) ? "柱中" : "-";
    const pd = PillarDone.get(entity.id);
    const idle = Idle.get(entity.id) || 0;
    const snap = Snapshots.get(entity.id);
    let nch = 0, ncell = 0;
    if (snap) { nch = snap.chunks.size; for (const c of snap.chunks.values()) ncell += c.cells.length; }
    const tr = Trail.get(entity.id);
    log(`状态 ${s} 目标(${target.x},${target.y},${target.z}) dh=${dh.toFixed(1)} dv=${dv.toFixed(1)}`
        + ` ${inReach ? "够到" : "够不到"} 接近轮=${ap ? ap.n : 0} 已拆=${dg ? dg.n : 0}`
        + ` ${pil} 柱窗=${pd ? Math.max(0, pd.until - farClock) : "-"} 闲=${idle}`
        + ` 柱块=${tr ? tr.length : 0} 拉黑=${GiveUp.size} 中景=${nch}区/${ncell}块`);
}

// ---------------------------------------------------------------------------
// 临时诊断（2026-11-12 晚，排完把这一整块 + config 里的 diag / diagEvery 删掉）
//
// 走位链路一共四段，任何一段断了都是"她站着不动"，光看聊天栏分不清：
//   ① JS 扫到目标了吗（scanReach 圈内）
//   ② 裂痕摆出来了吗（spawnEntity 成功没）
//   ③ 引擎锁上它了吗（nearest_attackable_target 认不认 0 碰撞箱 + health 1）
//   ④ 锁上之后真的迈步了吗（move_towards_target 有没有干活）
// 每 diagEvery tick 报一行，四段各一项，一眼定位。预算 diagBudget 条，不会刷屏。
// ---------------------------------------------------------------------------
let diagBudget = 80;
const DiagClock = new Map();     // maidId -> 上次报的 currentTick
const DiagLastLoc = new Map();   // maidId -> 上次报的位置（算位移）

function maybeDiag(entity, target, inReach) {
    if (!CONFIG.gather.diag || diagBudget <= 0) return;
    let now, loc;
    try { now = system.currentTick; loc = entity.location; } catch (e) { return; }
    const last = DiagClock.get(entity.id) ?? -99999;
    if (now - last < (CONFIG.gather.diagEvery || 60)) return;
    DiagClock.set(entity.id, now);

    // ④ 位移：两次报之间的水平距离。站着恒为 0.00
    const prev = DiagLastLoc.get(entity.id);
    const moved = prev ? Math.hypot(loc.x - prev.x, loc.z - prev.z) : -1;
    DiagLastLoc.set(entity.id, { x: loc.x, y: loc.y, z: loc.z });

    // ③ 引擎锁到的目标（SAPI 的 `Entity.target`，2.7 有，只读）
    //
    //  🔴 上一版我把它写成了“SAPI 没有这个属性”并印 `n/a`，**那是错的**（纠正：
    //     「2.7.0 是有 target 的，我测试过，不要信文档」）。本包自己的
    //     `common/attackable_target_manager.js:231` 就一直在用 `entity.target`。
    //     教训：接口存不存在，去**这个仓库里跑通的代码**里找，别信记忆、别信文档。
    let engineTarget = "无";
    try {
        const t = entity.target;
        if (t) engineTarget = t.typeId || "有";
    } catch (e) { engineTarget = "读不到"; }

    // ② 场上裂痕：24 格内几个、最近多远
    let cracks = 0, near = -1;
    try {
        // 统计半径跟着中景走（48），不能再用 24：
        // 中景 48 格选的锚点在 24~48 之间时，这里会显示 `裂痕 0`，
        // 但那颗壳其实在场、引擎也锁着它 —— 复盘时会把"有锚点"误读成"没锚点"。
        for (const c of entity.dimension.getEntities({
            type: "dm34:block_crack", location: loc,
            maxDistance: Math.max(24, CONFIG.gather.midReach || 48),
        })) {
            cracks++;
            let cl;
            try { cl = c.location; } catch (e) { continue; }
            const d = Math.hypot(cl.x - loc.x, cl.y - loc.y, cl.z - loc.z);
            if (near < 0 || d < near) near = d;
        }
    } catch (e) { /* 维度没加载 */ }

    // ① 扫描结果
    const scan = target
        ? `(${target.x},${target.y},${target.z}) ${inReach ? "够到" : "够不到"}`
        : "无";

    const tag = entity.hasTag("dm_has_target") ? "Y" : "N";
    // ⑥ 中景快照：`12/24区` = 窗口里 24 个子区块已扫完 12 个（还在补），
    //    `93块` = 地图里一共 93 个命中格子；`无` = 没建（那就只剩小扫描 + move_to_block）
    //    🔴 只要 `ready` 不是 0，`midPick` 就已经在干活了（懒读取，不等扫完）。
    const sp = Snapshots.get(entity.id);
    const snapInfo = !sp ? "无"
        : `${sp.ready}/${sp.total}区 ${sp.n}块`;
    // ⑤ 远景引导（move_to_block）此刻挂没挂。三态一眼可辨：
    //    "开"           = 圈内没木头，正在派她去远处找
    //    "关"           = 有合法目标，交给 ranged_attack 牵引
    //    "关(漫游12s)"  = 圈内有木头但都不能挖（玩家建筑），让她自己溜达，已溜 12 秒
    let guide = GuideOn.has(entity.id) ? "开" : "关";
    const roamFrom = RoamSince.get(entity.id);
    if (roamFrom !== undefined) {
        guide += `(漫游${Math.round((farClock - roamFrom) / 20)}s)`;
    }
    // 裂痕这一栏要能区分三种"0"：
    //   `裂痕 0`            = 没摆过 / 已经正常撤掉
    //   `裂痕 0(退避3x)`  = 摆了但壳活不过一帧，正在按等级退避重建（病，括号是退避等级）
    //   `裂痕 0(spawn ...)` = 实体根本生成不出来，括号里是引擎的报错（病）
    const _rt = CrackRetry.get(entity.id);
    const crackTag = (_rt && _rt.n > 0)
        ? `§c(退避${_rt.n}x)`
        : (crackErr ? `§c(${crackErr})` : "");
    const _lm = LockMiss.get(entity.id) || 0;
    const _lmTag = !_lm ? ""
        : (engineTarget === "n/a" ? ` §8(n/a 兜底)` : ` §c(锁不上${_lm}轮)`);

    // ⑦ **当前阶段** —— 以后"为什么不敲"一眼就能看出来，不用再靠猜：
    //    `垫柱` 状态机在往上垫 / `柱后` 刚垫完的保护窗 / `无目标` 扫描空了 /
    //    `够不到` 有目标但在 reach 外 / `就位` 站在方块旁边没开始敲 / `敲N%` 正在敲
    let phase;
    if (Pillar.has(entity.id)) phase = "垫柱";
    else if (PillarDone.has(entity.id)) phase = "柱后";
    else if (!target) phase = "无目标";
    else if (!inReach) phase = "够不到";
    else {
        const pr = Progress.get(entity.id);
        phase = pr ? `敲${Math.min(99, Math.round((pr.ticks / Math.max(1, pr.total)) * 100))}%` : "就位";
    }
    const _gu = GiveUp.size ? ` §8| §7拉黑 ${GiveUp.size}` : "";

    const msg = `§b[诊断] §7扫描 ${scan} §8| §7裂痕 ${cracks}${near >= 0 ? `(${near.toFixed(1)}格)` : ""}${crackTag}`
        + ` §8| §7引擎目标 ${engineTarget} §8| §7tag ${tag}`
        + ` §8| §7引导 ${guide}${_lmTag}`
        + ` §8| §7态 ${phase}${_gu}`
        + ` §8| §7候选 ${HadCands.get(entity.id) || 0}`
        + ` §8| §7扫距 ${CONFIG.gather.scanReach}`
        + ` §8| §7中景 ${snapInfo}`
        + (bulkOk === false ? "§c(逐格)" : `§8(批量命中${bulkHits})`)
        + ` §8| §7位移 ${moved < 0 ? "首次" : moved.toFixed(2)} §8| §7y ${loc.y.toFixed(1)}`;

    diagBudget--;
    try {
        let best, bestSq = Infinity;
        for (const p of world.getAllPlayers()) {
            const d = p.location;
            const dx = d.x - loc.x, dy = d.y - loc.y, dz = d.z - loc.z;
            const sq = dx * dx + dy * dy + dz * dz;
            if (sq < bestSq) { bestSq = sq; best = p; }
        }
        if (!best) return;
        best.sendMessage(msg + (diagBudget === 0 ? " §8（诊断结束）" : ""));
    } catch (e) { /* 玩家下线 */ }
}

function setJob(entity, kind) {
    try { entity.setDynamicProperty(CONFIG.gather.jobProp, kind || undefined); } catch (e) { /* 忽略 */ }
}

/** 有没有在采集（给烹饪的自动开锅用：忙着挖矿就别掏锅） */
export function hasGatherJob(entity) {
    return !!jobOf(entity);
}

/** 挥手动画的开关（资源包 dm34_gather 控制器读它） */
function setBusy(entity, on) {
    try { entity.setProperty("dm34:gather", !!on); } catch (e) { /* 属性没声明 / 实体已卸载 */ }
}

/*
 * 进采集模式。调用方（interact_router）已把旧状态交代干净并回到 in1。
 * @param {"mine"|"chop"} kind 工种
 * @param {*} handStack 玩家手里那把镐 / 斧
 * @param {boolean} giveBack 退出时要不要还（创造模式给的是复制品，记 false）
 */
export function startGather(player, entity, kind, handStack, giveBack) {
    // 读不到手持物 → 吞掉本次点击（返回 false 会让引擎弹出她的背包）
    if (!handStack) return true;

    // 已经在这个模式：**同一把**才算同义重复；换了品质/材质就当场换下来
    // （2026-11-15 "手持合金斧时用铁斧右键她换不过去"）。
    //
    // 换法**照抄剑/弓/弩/长矛那套**：先走既有的 `stopGather` 把这一份交代干净，
    // 再走下面的 `storeGatherTool` + `consumeHand` 装新的。不另写替换逻辑 ——
    // `stopGather` 内部已经把旧工具按既定方式还回去（掉在**她**脚下，不是玩家脚下），
    // 自己再去调 `returnGatherTool` 才是重复造轮子，还容易漏掉形态/快照的收尾。
    if (jobOf(entity) === kind) {
        const cur = storedGatherTool(entity);
        if (cur && cur.id === handStack.typeId) return true;   // 同一把 → 什么都不做
        stopGather(player, entity, { keepSilent: true, why: "换采集工具" });
    }

    // 换类别：先把上一堆还了（记录里那把是玩家的真件）
    if (jobOf(entity) && jobOf(entity) !== kind) {
        stopGather(player, entity, { keepSilent: true, why: "换采集类别" });
    }

    if (!storeGatherTool(entity, handStack, giveBack)) {
        try { player.sendMessage("§c这把工具存不下来"); } catch (e) { /* 忽略 */ }
        return true;
    }

    // **必须从玩家背包扣掉那件**。storeGatherTool 只是把 ItemStack 序列化进她的
    // 动态属性，没动玩家的容器 —— 漏了这一句，玩家手上的镐原封不动，
    // 而收工时 returnGatherTool 又还他一把，每右键一次就白得一把（1 → 3 → 10 把）。
    // 与换武器那条路径完全同构：storeWeapon 之后紧接 consumeHand。
    // 创造模式由 consumeHand 内部拦掉（isCreative 直接 return false），不扣也不还。
    consumeHand(player, handStack.typeId);

    setJob(entity, kind);

    // 进采集态时 `gather_mine` / `gather_chop` **不再** add guide 组（2026-11-13 从 JSON 剥离），
    // 引导现在默认是"没挂"，由 tickOne 按 `HadCands` 决定要不要 `guide_on_*`。
    // 状态表照样清零：上一次采集残留的记录不能带进这一轮。
    GuideOn.delete(entity.id);
    GuideQuiet.delete(entity.id);
    RoamSince.delete(entity.id);
    HadCands.delete(entity.id);      // 首次扫描前按 0 算：会先挂引导，扫到再说
    LockMiss.delete(entity.id);      // 引擎账本从 0 起算
    Idle.delete(entity.id);
    TunnelCd.delete(entity.id);
    Dig.delete(entity.id);        // 自救挖掘账本跟着一起清
    PillarDone.delete(entity.id);     // 上一轮"垫完要敲的那块"不能带进这一轮
    PillarTries.delete(entity.id);
    GiveUp.clear();                   // 拉黑名单是上一轮的结论，新的一轮重新判
    // 聊天栏报告的名额**每进一次采集态重置一次**。原来是一辈子 12 条：
    // 前面「连锁采集：还要再拆 N 格」刷几条之后，后面真正有用的
    // 「垫柱升空 / 矿在墙后 → 挖开 N 格」就再也不出现了 —— 排查时等于没有日志。
    reportBudget = 12;

    // 兜底：万一上一轮异常退出时 guide 组还挂着（JSON 事件失败 / 热重载），
    // 这里先明确摘一次。成败不影响后面 tickOne 的判断 —— 它会按 GuideOn 重来。
    try { entity.triggerEvent("guide_off"); } catch (e) { /* 没挂过 */ }

    try {
        entity.triggerEvent(kind === "mine" ? "gather_mine" : "gather_chop");
    } catch (e) {
        log(`triggerEvent 失败: ${e}`);
    }

    // 中景地图：**每次切到斧/镐模式时重建一张**（定的刷新点）。
    // 放在 triggerEvent 之后 —— 组件组结算完 `jobOf()` 才稳定，
    // `snapWorker` 每柱都要用它确认"这活还该干"。
    snapBuild(entity, kind);

    // 组件组结算完再摆主手替身：铺一个 100 tick 的窗口，命令幂等。
    //
    // 🔴 以前只 +1 / +3 两枪。而**上个状态**的组件组收尾（典型：farm 组的
    //    `minecraft:equipment` 把主手刷回铁锄）晚到第几 tick 没有保证 ——
    //    于是替身被盖回去，玩家看到"用斧头换掉锄头，锄头还我了、状态也切了，
    //    可她手上还是锄头去砍树"。与 interact_router 的 TOOL_SYNC_TICKS 同一套理由。
    // 不再用 `jobOf()` 当闸门：切状态的瞬间它可能还读不到，
    // 读到不就读不到都不该拦着"把记录里那把摆上去"（restoreGatherDisplay 自己会判记录）。
    const place = () => {
        try { restoreGatherDisplay(entity); } catch (e) { /* 忽略 */ }
    };
    for (const t of [1, 2, 4, 6, 10, 16, 24, 40, 64, 100]) system.runTimeout(place, t);

    log(`进采集：${kind}（${handStack.typeId}）`);
    return true;
}

/** 出采集模式：还工具、撤组件组、关挥手 */
export function stopGather(player, entity, opts) {
    const silent = !!(opts && opts.keepSilent);
    // 默认回待命（gather_back = 摘组 + 补 in1）。
    // 被打断（already 在别的形态）时传 noRevert，只摘组 —— 否则会凭空塞一份
    // in1 进去，和 sword / bow 的 variant 打架。
    const revert = !(opts && opts.noRevert);
    const had = !!jobOf(entity);
    // **不允许静默收工**：每次收工都留一行，带是谁干的 + 收工前的形态/工具记录。
    // 以前这里是纯静默的，"看着还在采集、其实已经闲置"根本查不出来。
    log(`收工 why=${(opts && opts.why) || "未标记"} revert=${revert}`
        + ` variant=${variantOf(entity)} 有记录=${!!storedGatherTool(entity)} 有job=${had}`);

    Progress.delete(entity.id);
    Chains.delete(entity.id);
    ChopTask.delete(entity.id);
    if (Trail.has(entity.id)) TrailCleanup.set(entity.id, farClock);   // 柱子交给 collapseTrail 收
    clearCrack(entity.id);           // 收工时把正在显示的裂痕一起撤掉
    sweepCracks(entity, 0);          // 连同周围的野壳一起清，别留着当假目标
    stopPillar(entity, false);       // 收工时**不**拆柱子（她可能还站在上面），Trail 留着慢慢拆
    Stuck.delete(entity.id);
    PathStuck.delete(entity.id);
    NoProg.delete(entity.id);        // 到位自救的计数别带进下一次采集
    Approach.delete(entity.id);
    ScanCache.delete(entity.id);
    snapDrop(entity);                // 中景地图 + 扫描任务一起收（任务还在跑的话先 clearJob）
    DiagClock.delete(entity.id);     // 诊断节流表跟着收工一起清，别按 id 攒着
    DiagLastLoc.delete(entity.id);
    // 远景引导必须跟着收工一起摘：`gather_back` / `gather_off` 事件里也写了 remove，
    // 但那条只在她**还带着采集态**时有效；先摘一遍保证不残留（残留 = 她在待命态也会跑去砍树）
    GuideOn.delete(entity.id);
    GuideQuiet.delete(entity.id);
    RoamSince.delete(entity.id);      // 漫游计时跟着收工清掉
    HadCands.delete(entity.id);       // 候选数是上一轮采集的残留，别带进下一次
    LockMiss.delete(entity.id);
    Idle.delete(entity.id);
    TunnelCd.delete(entity.id);
    Dig.delete(entity.id);        // 自救挖掘账本跟着一起清
    Bridge.delete(entity.id);     // 搭桥账本一起清（桥**不拆**：她可能还站在上面）
    PillarDone.delete(entity.id);     // 保护窗跟着收工结束（不然下一份活儿一上来就被"钉"在旧目标上）
    PillarTries.delete(entity.id);
    Probe.delete(entity.id);          // 试走的进度/冷却/可达表一起收，别按 id 攒着
    Verified.delete(entity.id);
    ProbeTried.delete(entity.id);
    Approach.delete(entity.id);
    Why.delete(entity.id);
    TraceAt.delete(entity.id);
    try { entity.triggerEvent("guide_off"); } catch (e) { /* 组没挂过 */ }
    setBusy(entity, false);
    setJob(entity, undefined);
    resetLook(entity);               // 头摆正

    try { entity.triggerEvent(revert ? "gather_back" : "gather_off"); } catch (e) { /* 组没加上也无所谓 */ }

    let back = false;
    try { back = returnGatherTool(entity, player); } catch (e) { log(`归还异常: ${e}`); }
    // 兜底：记录丢了但主手还挂着一把真件/替身（重进世界 / 球收回 / 中途异常）。
    // 🔴 这里**必须是"掉出来"**，不能像以前那样直接 clearSlot ——
    //    清了就是把她手上那件镐/斧凭空删掉，玩家的工具再也不会出现。
    if (!back) {
        const hand = readMainhand(entity);
        if (hand && gatherKindOf(hand.typeId)) {
            if (dropItemNear(entity, hand) || dropItemNear(player, hand)) {
                clearSlot(entity, EquipmentSlot.Mainhand);
                log(`记录缺失 → 主手 ${hand.typeId} 已掉还`);
            } else {
                log(`记录缺失且 ${hand.typeId} 掉不出去 → 留在主手（不清空）`);
            }
        }
    }

    if (had && !silent && player) {
        try { player.sendMessage("§7她放下了手里的活。"); } catch (e) { /* 忽略 */ }
    }
    return had;
}

// ── 巡检 ─────────────────────────────────────────────────────────────

let inited = false;

export function initGather() {
    if (inited) return;
    inited = true;

    // 启动清扫：上一局/重载前留下的裂痕壳在 `Crack` 表里没有记录（表是新 Map），
    // 没人续期也没人 remove → 它们会一直站着当"假目标"，她满图追壳、低头盯壳。
    // 分维度各扫一次就够（壳全在采集现场，三个维度一并清）。
    system.run(() => {
        for (const name of ["overworld", "nether", "the_end"]) {
            try {
                for (const o of world.getDimension(name).getEntities({ type: "dm34:block_crack" })) {
                    try { o.remove(); } catch (e) { /* 已经没了 */ }
                }
            } catch (e) { logErr("crack_sweep", e); }
        }
    });

    system.runInterval(() => {
        try { tickAll(); } catch (e) { log(`巡检异常: ${e}`); }
    }, CONFIG.gather.intervalTicks);
}

function tickAll() {
    if (!CONFIG.gather.enabled) return;
    farClock++;                      // 远扫描的节拍（几轮巡检才真扫一次）
    ColumnCache = new Map();         // 自然树判定每轮重算（树会被砍、玩家会补方块）
    const live = new Set();
    forEachMaid((entity) => {
        live.add(entity.id);
        try {
            // **孤儿垫柱 / 超龄垫柱**：`Pillar` 活着但状态机没在跑（handle 为空），
            // 或者跑了太久还没收尾 —— 两者都会让 `tickOne` ③ 每轮直接 return：
            // 她站在柱子上不动、不扫描、不选树、不拆柱。
            // 这里兜底收掉（不依赖 `tickPillar` 有没有被调度），把走位交还引擎。
            const pst = Pillar.get(entity.id);
            if (pst) {
                const age = system.currentTick - (pst.born || 0);
                if (pst.handle === undefined) {
                    log(`孤儿垫柱（无调度）→ 强制收尾，已 ${age} tick`);
                    stopPillar(entity, true);
                } else if (age > (CONFIG.gather.pillarHardCapTicks || 600)) {
                    log(`垫柱硬上限 ${age} tick → 强制收尾`);
                    stopPillar(entity, true);
                }
            }
            // 柱子回收放在这里而不是 tickOne：收工（job 没了）以后还得继续把柱子拆回来，
            // tickOne 第一行就因为没 job 返回了。
            if (Trail.has(entity.id)) collapseTrail(entity);
            // 裂痕空壳的失效处理**不在这里做**（2026-11-13）。
            // 原来这里是 `if (rec && !rec.crack.isValid) Crack.delete(...)` ——
            // 一删记录，`ensureCrack` 下一轮就看到"没有壳"，于是直接重摆，
            // 把 `crackRetryTicks` 那套退避完全绕过：壳一失效就 0.5 秒重摆一次，
            // 引擎跟着反复 acquire/lose → 原地抖动 + 索敌语音连播。
            // 现在失效判定和退避重建统一在 `ensureCrack` 里，这里只管收工后的柱子。
            tickOne(entity);
            // **强制状态行**：不走 `tickOne` 里那条（那条在好几个早退点之后，
            // 一旦卡在垫柱/牵绳上就一条都不打）。这里每 20 秒必打一行，
            // 采集态到底卡在哪一段一眼可见。
            if (farClock % (CONFIG.gather.traceEvery || 40) === 0) forceTrace(entity);
            // 收工后也得管：属性是持久化的，采集时留下的头部角度不清就永远垂着头
            if (!jobOf(entity)) clearLookResidue(entity);
        } catch (e) { logErr("单只巡检异常", e); }
    });

    // 女仆被删掉 / 世界重载后 id 对不上了 → 快照跟着清。
    // 一张地图是上千个格子对象，攒着就是纯泄漏（而且永远不可能再被读到）。
    if (Snapshots.size) {
        for (const id of Snapshots.keys()) {
            if (live.has(id)) continue;
            Snapshots.delete(id);
            const job = SnapJobs.get(id);
            if (job !== undefined) {
                SnapJobs.delete(id);
                try { system.clearJob(job); } catch (e) { /* 已经跑完 */ }
            }
        }
    }
    // 试走的三张表同理：按 entityId 攒，实体没了就是永久泄漏。
    for (const [id] of Probe) if (!live.has(id)) Probe.delete(id);
    for (const [id] of Verified) if (!live.has(id)) Verified.delete(id);
    for (const [id] of ProbeTried) if (!live.has(id)) ProbeTried.delete(id);
    for (const [id] of Approach) if (!live.has(id)) Approach.delete(id);
    for (const [id] of Bridge) if (!live.has(id)) Bridge.delete(id);
    for (const [id] of ChopTask) if (!live.has(id)) ChopTask.delete(id);
    for (const [id] of TrailCleanup) if (!live.has(id)) TrailCleanup.delete(id);
    for (const [id] of Why) if (!live.has(id)) Why.delete(id);
    for (const [id] of TraceAt) if (!live.has(id)) TraceAt.delete(id);
}

function tickOne(entity) {
    if (String(entity.typeId) !== DM34) return;
    const kind = jobOf(entity);
    if (!kind) return;

    // ① 组件组被外部摘掉了（`back` / `gather_off` / 坐下 / 换肤 / 别的形态事件）→
    //    variant 不再是 6（挖矿）或 7（砍树）。
    //
    //  🔴 **先抢回来，别当场收工**（2026-11-15 "搭方块砍树拆方块下来，
    //     立刻变成假状态——看着还在采集，实际已经闲置，右键才真正生效"）。
    //
    //     原来的写法是 `stopGather(noRevert: true)`：摘掉采集组但**不补 in1、
    //     不还工具**。于是 her 身上既没有 `dm_chop`（variant 回落成 0）、
    //     也没有一份完整的待命形态，工具还举在手上 —— 就是所谓"假状态"。
    //
    //     现在：先 `gather_mine`/`gather_chop` 把组抢回来（这两个事件会 add
    //     `dm_mine`/`dm_chop` 并 remove `in1`），variant 回来就继续干活。
    //     连试 3 轮都回不来（真的被别的形态占了）才认收工，而且是**真收工**：
    //     补 `gather_back`（完整 in1）+ 把工具还回去，绝不留半截状态。
    const wantVariant = kind === "mine" ? 6 : 7;
    const v = variantOf(entity);
    if (v !== wantVariant) {
        // 🔴 **她已经被玩家交给别的形态 → 这是"交接"，不是"组件组被外部摘掉"，不许抢回来。**
        //
        //   下面那段抢回逻辑是为"搭方块/拆方块/换肤导致组件组掉了"设计的。
        //   但如果她此刻身上有耕地（dm34:hoe）或武器（dm34:weapon）记录，说明玩家刚用
        //   锄头/剑把她切走了 —— 再 `gather_mine` 抢回来，就等于**每 tick 把 farm/sword 组
        //   摘一次**，两套补摆链各写各的主手：玩家看到的是"手上镐和锄来回夺舍，
        //   潜行退出时两样东西一起掉"（2026-11-16 实测）。
        //   这条闸门是**第二层保险**：即使将来又漏了某条交接路径（这次的 enterFarm 就是），
        //   也只会安静收工，不会与另一个形态互相顶。
        let otherForm = false;
        try { otherForm = hasFarmTool(entity) || hasWeaponRecord(entity); } catch (e) { otherForm = false; }
        if (otherForm) {
            log(`形态已被别的形态接管（variant=${v}，有耕地/武器记录）→ 收工，不抢回`);
            stopGather(null, entity, { keepSilent: true, noRevert: true, why: "已被别的形态接管" });
            return;
        }
        try { entity.triggerEvent(kind === "mine" ? "gather_mine" : "gather_chop"); }
        catch (e) { logErr("恢复采集形态失败", e); }
        if (variantOf(entity) === wantVariant) {
            FormFix.delete(entity.id);
            log(`形态被外部改掉（variant=${v}）→ 已抢回采集形态，继续干活`);
        } else {
            const retry = (FormFix.get(entity.id) || 0) + 1;
            FormFix.set(entity.id, retry);
            if (retry < 4) {
                log(`形态被外部改掉（variant=${v}）→ 第 ${retry} 次抢回失败，下轮再试`);
                return;
            }
            FormFix.delete(entity.id);
            log(`variant=${v} 连补 ${retry} 次都回不来 → 真收工（还工具）`);
            stopGather(null, entity, { keepSilent: true, why: "形态补不回来" });
        }
        return;
    }
    FormFix.delete(entity.id);

    // ② 组还在但工具记录没了（球收回 / 玩家取走）→ 回待命，不留下孤儿状态
    //
    // 🔴 **先尝试自愈，别当场收工**（2026-11-15 "砍完高处的树下来后自行返回闲置，
    //    手上还拿着工具，右键就直接待命、工具消失"）。
    //    动态属性偶尔会读到空（实体重载 / 写入被吞），原来这里静默收工：
    //    job 清掉、variant 交给 gather_back 变回 in1、工具因为 `noRevert` 留在手上 ——
    //    表现就是"看着还在采集，其实已经待命了"。
    //    主手那把如果还是同类工具，就直接用它把记录重建回来，继续干活。
    if (!storedGatherTool(entity)) {
        let revived = false;
        try {
            const cur = readSlot(entity, EquipmentSlot.Mainhand);
            if (cur && cur.typeId && gatherKindOf(cur.typeId) === kind) {
                revived = storeGatherTool(entity, cur, false);
                if (revived) log(`工具记录读到空 → 用主手 ${cur.typeId} 重建，继续采集`);
            }
        } catch (e) { logErr("工具记录自愈失败", e); }
        if (revived) {
            // 重建成功 → 这一轮照常往下跑（别收工）
        } else {
        log("工具记录丢失且主手没有同类工具 → 收工");
        setJob(entity, undefined);
        setBusy(entity, false);
        Progress.delete(entity.id);
        Chains.delete(entity.id);
        ChopTask.delete(entity.id);
        if (Trail.has(entity.id)) TrailCleanup.set(entity.id, farClock);
        clearCrack(entity.id);
        stopPillar(entity, false);
        Stuck.delete(entity.id);
        PathStuck.delete(entity.id);
        NoProg.delete(entity.id);
        Approach.delete(entity.id);
        ScanCache.delete(entity.id);
        snapDrop(entity);
        GuideOn.delete(entity.id);
        GuideQuiet.delete(entity.id);
        RoamSince.delete(entity.id);
        HadCands.delete(entity.id);
        LockMiss.delete(entity.id);
        Idle.delete(entity.id);
        TunnelCd.delete(entity.id);
        Dig.delete(entity.id);        // 自救挖掘账本跟着一起清
        PillarDone.delete(entity.id);
        PillarTries.delete(entity.id);
        ChopTask.delete(entity.id);   // 这份活儿结束了，伐木任务记忆别留给下一份
        Probe.delete(entity.id);
        Verified.delete(entity.id);
        ProbeTried.delete(entity.id);
        Approach.delete(entity.id);
        Why.delete(entity.id);
        TraceAt.delete(entity.id);
        resetLook(entity);
        try { entity.triggerEvent("gather_back"); } catch (e) { /* 忽略 */ }
        return;
        }
    }

    // ②·5 牵绳：离主人太远 → 拉黑当前目标 + 撤锚点 + 收柱子，传送回身边。
    //      采集态不跟随、中景又能选到 48 格外的方块，玩家站着不动她就会走出视野。
    //      `leashRadius`（32）远大于任何单块目标的距离，正常采集碰不到这条。
    if (leashCheck(entity, kind)) {
        whyNot(entity, "牵绳：离主人太远，传送回身边");
        return;
    }

    // ③ 正在垫柱 → 由独立的一 tick 循环推进，巡检让位（别两头同时推状态机）
    if (Pillar.has(entity.id)) {
        const pst0 = Pillar.get(entity.id);
        whyNot(entity, `垫柱状态机占用中（${pst0 ? pst0.phase : "?"}，已 ${system.currentTick - ((pst0 && pst0.born) || system.currentTick)} tick）`);
        return;
    }

    // ③' 采集态不是战斗态：把引擎"锁定裂痕"时顺手加上的 `dm_has_target` 摘掉。
    //
    //     `nearest_attackable_target` 一锁上目标，`minecraft:on_target_acquired`
    //     就会触发 `target_sound`，那条命令是**无条件** `tag @s add dm_has_target`
    //     外加计分板 +1（满 9 次才播音效）。裂痕是脚本自己摆的锚点，不是敌人：
    //       · tactical_clock_manager 靠这条 tag 判"在战斗"，她会一直被当战斗单位
    //       · 连挖几十块之后开始反复播"发现目标"音效
    //     所以只要还在采集态，就定期清一次。真在打架时（挨打反击）由 damage_sensor
    //     那条链路负责，采集态本身不该有战斗目标。
    if (farClock % 5 === 0 && entity.hasTag("dm_has_target")) {
        try {
            entity.removeTag("dm_has_target");
            // `target_sound` 里那条 `scoreboard players add @s dm34 1` 是**无条件**累加的，
            // 满 9 次就播一声。只摘 tag 不清分，裂痕反复重建时照样每 9 次响一声 ——
            // "频繁索敌语音"就是这个。摘 tag 的同时把计数归零。
            entity.runCommand("scoreboard players set @s dm34 0");
        } catch (e) { /* 忽略 */ }
    }

    // ④ 找目标 —— 索敌半径 scanReach（24 格），按 scanEvery 节流。
    //
    //    这里**不再让 `move_to_block` 负责精确走位**：它要求"方块旁边有可站立的格子"，
    //    矿石四面被石头包住时永远寻路失败、树被树冠围住也一样 —— 表现就是
    //    "她明明能走路，却一步都不朝树 / 矿迈"。实测确认过这一点。
    //    所以它现在只当**远景粗引导**（`dm_guide_*` 组，64 格，见下面的开关）。
    //
    //    现在的分工：
    //      JS     扫到合法目标（自然树 / 矿石）→ 在那块方块上摆一个裂痕空壳当"假实体"
    //      引擎   dm_walk_* 挂着 nearest_attackable_target（认 `dm_crack_effect`）
    //             + move_towards_target（走过去）+ look_at_target（转脑袋）
    //    这是真正的"正经索敌"：转头、走位、停下全由原版 AI 做，
    //    JS 只负责"选哪一块"和"敲多久"。
    //
    //    中景地图放在这里平移窗口（`snapSync`）：她走动了就把新进 48 格的子区块排进队列，
    //    走出 `midReach + midKeepPad` 的才淘汰 —— **已经扫过的子区块永远不重扫**。
    //    成本是 49 次 Map 查找，纯 JS 不跨边界。
    snapSync(entity, kind);
    let target = scanTarget(entity, kind);

    // ③·**垫柱刚结束** → 这几轮只认"我是为哪一块爬上来的"（2026-11-13 
    //    「垫上去为什么不挖啊，然后女仆自己就走下来了」）。
    //
    //    垫柱期间 `tickOne` 一直在 ③ return（状态机只管往上垫、不敲方块），所以
    //    "垫到顶"和"开始敲"之间原本是一片真空：`stopPillar` 把走位组挂回去 →
    //    引擎重新拽她 → 她站在 1×1 的柱顶一步踏空就掉下去；同时中景正在按垂直跳变
    //    重建、`scanTarget` 返回 undefined → `Idle` 数到 4 → `collapseTrail` 拆柱 →
    //    **她自己一格一格走下来**，那块木头一次都没被敲过。
    //
    //    现在：垫过的目标直接当目标（跳过扫描，方块还在就敲），保护窗内
    //    `stopPillar` 不挂走位组、`collapseTrail` 不拆柱。敲完 / 窗过期才交还。
    let pd = PillarDone.get(entity.id);
    if (pd && farClock >= pd.until) {
        // 保护窗过期 → 高度用完了，走位组交还引擎，下一轮正常扫描
        PillarDone.delete(entity.id);
        restoreWalkGroup(entity);
        // 这个高度她不再用了 → 柱子进入强制回收（挖矿也走这条，别再留一根土柱在那儿）
        if (Trail.has(entity.id)) TrailCleanup.set(entity.id, farClock);
        pd = undefined;
    }
    if (pd) {
        const forced = blockIfTarget(entity, kind, pd);
        if (forced) {
            target = forced;                 // 就敲这一块，别让扫描改主意
        } else if (target && withinReach(entity, target, CONFIG.gather.forceReachExtra)) {
            // 那块敲掉了，但手边（同一高度）还有一块 → 就在这根柱子上接着干。
            // ⚠ 只有"站在这里就敲得到"才续期：否则她会一边被保护窗按在柱顶、
            //    一边眼巴巴看着几十格外的树（走位组没挂，她连走都走不了）。
            PillarDone.set(entity.id, {
                x: target.x, y: target.y, z: target.z,
                until: farClock + Math.max(4, CONFIG.gather.pillarGraceRounds || 10),
            });
        } else {
            // 手边没活 / 只剩远处的目标 → 结束保护窗，把走位交还引擎（她可以下来了）
            PillarDone.delete(entity.id);
            restoreWalkGroup(entity);
            ScanCache.delete(entity.id);
            if (Trail.has(entity.id)) TrailCleanup.set(entity.id, farClock);   // 柱子开始回收
        }
    }
    const inReach = !!target && withinReach(entity, target);

    // ④·**试走验证**（2026-11-15 ，照 `AI玩家 Add-On BP` 的 feature_reacher）。
    //
    //    排在"引擎账本 / 远景引导开关"**之前**是刻意的：
    //      · 试走期间壳是空的，`nearest_attackable_target` 必然锁不到 → `LockMiss` 会
    //        一路涨到 `guideFallbackRounds` → 把 `dm_guide_*` 挂回来 → 和 `dm_probe_*`
    //        两个 `move_to_block` 各拉一个方向 = 2026-11-13 那次原地抖动。
    //      · 所以这两段账本在试走期间**根本不该跑**，由 `probeEnter/probeLeave` 负责
    //        把 `LockMiss` 和引导状态都清干净。
    //
    //    返回 true = 本轮由它接管（正在试走 / 刚判定完），下面的挖与摆壳全部让位。
    if (probeTick(entity, kind, target, inReach)) return;

    // ④·引擎账本：JS 想敲这块，引擎到底锁上了没有？
    //
    //   `entity.target` 非空 = `nearest_attackable_target` 真锁到了脚本摆的裂痕，
    //   `move_towards_target` / `ranged_attack` 才会拉她走。它空着而 JS 却"有目标"，
    //   就是 2026-11-13 那次「远处的树原地抖动、一步不挪」——根因是 JSON 两个
    //   `dm_walk_*` 组没写 `follow_range`（引擎默认 16 给锁敌封顶，48 格的
    //   `within_radius` 等于白写）。已补 `follow_range: 100`，这里留一手兜底。
    const engineLocked = engineTargetOf(entity);
    const lockMiss = (target && !engineLocked)
        ? (LockMiss.get(entity.id) || 0) + 1
        : 0;
    if (lockMiss) LockMiss.set(entity.id, lockMiss); else LockMiss.delete(entity.id);

    // ④·远景引导开关（`dm_guide_mine` / `dm_guide_chop` 里的 `move_to_block`）。
    //
    //    三态，判据只有一个 —— **扫描圈里有没有木头候选**（`HadCands`），不是"有没有合法目标"：
    //      ① 有合法目标            → 摘引导（WORK）。精确走位交给 `ranged_attack` 的牵引，
    //                                两个行为同时活着会各拉一个方向。
    //      ② 有候选但全是玩家建筑  → 摘引导（ROAM）。**这是防卡死的关键**：
    //        引导挂着的唯一作用就是"朝这片木头走"，而这片已经验过不能挖；
    //        挂上只会让她走到墙边被摘、再挂、再走 —— 拉锯。所以只要圈内有候选就不挂，
    //        她会被 `default` 组的 `random_stroll`（priority 8）带着自己溜达。
    //      ③ 圈内一片木头都没有 → 挂引导（GUIDE）。数 `guideQuietRounds` 轮防抖
    //        （裂痕刚清、缓存刷新的空档不该来回切组），然后派她去 82 格范围找。
    //
    //    ★ ① 有一个例外（`LockMiss`）：有目标但**引擎锁不上**、连续
    //      `guideFallbackRounds` 轮都这样 → 还是把引导挂回来。此时没有任何行为在拉她，
    //      挂着不会跟谁对拉，是唯一能让她迈步的东西。
    //      已经在 reach 里就**不挂** —— 手边这块还派她走开纯属添乱。
    //
    //    脱身路径：②→③ 不是靠计时，而是靠"她自己走出扫描圈"。走出去候选归零，
    //    引导自动挂回来 —— 这就是期望的"完全随缘"。她要是困在超大建筑群里出不来，
    //    那也只是不干活（不会撞墙），诊断行会一直显示"漫游"。
    const cands = HadCands.get(entity.id) || 0;
    // 🔴 **有候选就绝不挂引导**（2026-11-15 "砍完高处的树下来后不砍任何树，
    //    自顾自走远"）。原来的判据只看 `lockMiss`（引擎 6 轮锁不上裂痕就挂引导），
    //    但"锁不上"是裂痕/摆位问题，不该变成"派她去 82 格外找目标"——
    //    那会把她从一片好好的树林里拖走，而且走远了更锁不上，正反馈。
    //    候选 > 0 时宁可让她站着（repairReach 会挖/垫自愈），也不许拽走。
    const lockDead = cands === 0
        && !inReach
        && lockMiss >= (CONFIG.gather.guideFallbackRounds || 6);

    if (target) {
        RoamSince.delete(entity.id);
        GuideQuiet.delete(entity.id);
        Idle.delete(entity.id);          // 有目标 = 没闲，柱子（要是踩着）先留着
        setGuide(entity, kind, lockDead);
    } else if (cands > 0) {
        GuideQuiet.delete(entity.id);        // 有候选就不算"安静"，别攒着到时偷偷挂上
        if (!RoamSince.has(entity.id)) RoamSince.set(entity.id, farClock);
        setGuide(entity, kind, false);
    } else {
        RoamSince.delete(entity.id);
        const n = (GuideQuiet.get(entity.id) || 0) + 1;
        GuideQuiet.set(entity.id, n);
        if (n >= CONFIG.gather.guideQuietRounds) setGuide(entity, kind, true);
    }
    // 垫柱保护窗内**一根引导都不许挂**：她正站在 1×1 的柱顶上敲，
    // `move_to_block` 只会把她从柱子上拽下去（"垫上去不挖、自己走下来"就是这么来的）。
    if (PillarDone.has(entity.id)) setGuide(entity, kind, false);

    // ④·诊断（临时）：把「扫到没 / 裂痕几个 / 引擎锁到没 / 位移多少」报到聊天栏
    maybeDiag(entity, target, inReach);
    trace(entity, target, inReach);

    // ④' 目标在敲击半径之外 → 摆好目标锚点，剩下的交给引擎。
    if (target && !inReach) {
        setBusy(entity, false);
        Progress.delete(entity.id);
        Stuck.delete(entity.id);          // 有明确目标 = 没卡住
        ensureCrack(entity, target, CONFIG.gather.markTicks);
        // 引擎会带她走，但**寻路是按方块算的**：整片树冠横在中间时它直接放弃，
        // ranged 的牵引还在扯她，表现就是原地踏步。这里补一手：真卡住了就清条缝。
        clearLeavesOnPath(entity, target, kind);

        // ④'·**到位自救**（2026-11-13 实测"走进树/矿旁边就干愣"）。
        //
        //  引擎不负责"精确走到敲击半径内"：`move_towards_target` 的 within_radius
        //  是 2.5，只要落进 2.5 它就判定"到了"并退出；可她的 reach 判定看的是
        //  **方块中心**，站位差半格、目标方块在斜上方/坑里，就会卡在 3~4.5 格之间：
        //  目标在、裂痕在、引擎已经撒手 → 每轮都从这条分支 return，
        //  表现就是"人走到跟前了，站着不动也不敲"。
        //
        //  判据只认**真的没在动**（水平速度 ≤ 0.08）且连续 forceReachAfter 轮：
        //  还在走就清零，所以正常赶路绝不会误判；放宽的幅度只有 forceReachExtra（1.5 格），
        //  最多隔 4.5 格动手，视觉上仍是"站在旁边敲"，不会变成隔空拍方块。
        const softOk = withinReach(entity, target, CONFIG.gather.forceReachExtra);
        // 🔴 判"没在走"一律用**位移**，不用速度（2026-11-15 "面壁思过还是很严重"）。
        //    顶着墙推 / 被方块夹住时 velocity 会有微小抖动，速度判据（≤0.08）经常漏判，
        //    于是 `wait` 永远攒不起来 → 自救一次都不触发 → 她就那么杵着。
        //    位移是硬的：半秒挪不到 0.25 格，就是一步没往前。
        let loc;
        try { loc = entity.location; } catch (e) { loc = null; }
        const np = NoProg.get(entity.id);
        const moved = (np && loc) ? Math.hypot(loc.x - np.x, loc.z - np.z) : 99;
        const still = moved <= 0.25;
        const wait = still ? ((np && np.n) || 0) + 1 : 0;

        // 🔴 **贴墙即挖**（2026-11-15 "矿被墙面挡住时她面壁思过很久才动手"）。
        //
        //    原来的挖掘只由两条计时触发：`wait >= forceReachAfter`(2 秒，要位移真不动)
        //    或 `stuckApproach`(4 秒，要距离真不缩短)。顶着墙推的时候她会有
        //    0.3~0.5 格的小幅滑动，`still` 经常不成立 → 只能等满 4 秒。
        //    这 4 秒就是"罚站面壁"。
        //
        //    这里加一条**不看时钟**的通道：目标就在跟前（≤ reach+2 格）、同一层，
        //    而两点连线中间已经横着实心方块 —— 那就是墙，没有走过去的可能，
        //    立刻交给 `repairReach`（→ `digStepToward` 拆第一格）。
        //    `digStepRounds` 仍然限速，不会一帧挖穿一座山。
        if (still && loc) {
            let dtmp;
            try { dtmp = entity.dimension; } catch (e) { dtmp = null; }
            const dvy = (target.y + 0.5) - loc.y;
            const dhx = Math.hypot(loc.x - (target.x + 0.5), loc.z - (target.z + 0.5));
            if (dtmp && dvy > -2 && dvy < 2.5
                && dhx <= (CONFIG.gather.wallDigDist || 5)
                && pathBlocked(dtmp, loc, target)) {
                whyNot(entity, `贴墙：${dhx.toFixed(1)} 格内被方块挡住 → 立刻开挖`);
                repairReach(entity, kind, target);
                return;
            }
        }


        // 🔴 第二把尺子：**离目标有没有真的变近**。
        //    顶墙时引擎一直推，她左右滑 0.3~0.5 格 → `still` 永远不成立 → `wait` 永远 0
        //    → 既不挖墙也不换目标，就是所谓"面壁死磕"。距离不会骗人。
        const ap = loc ? approachTrack(entity, target, loc) : null;
        const stuckApproach = !!ap && ap.n >= (CONFIG.gather.approachRounds || 8);
        const stuckLong = !!ap && ap.n >= Math.max(4, CONFIG.gather.giveUpRounds || 12);

        // 🔴 **够不到太久 → 放弃这一块，换一块**（2026-11-13 
        //    「一旦这次高处的没有挖掉女仆掉下来了，此后无论距离她多近的，
        //     即便是和她贴脸的方块也永远不会再挖了」）。
        //
        //    根因是**目标粘性把她钉死在一块永远够不到的方块上**：那块木头还在
        //    `midReach` 内、垂直也在选点窗内，`stickyTarget` 就无条件粘住它；
        //    于是每轮都"奔向它 → 够不到 → 什么都不做"，旁边贴脸的方块永远轮不到。
        //    拉黑它以后 `stickyTarget` 立刻放行、扫描也会跳过它，她就重新看见近处了。
        if (stuckLong || (still && wait >= Math.max(4, CONFIG.gather.giveUpRounds || 12))) {
            giveUpTarget(entity, kind, target);
            resetLook(entity);
            return;
        }

        if (!(softOk && wait >= CONFIG.gather.forceReachAfter)) {
            if (still && loc) NoProg.set(entity.id, { n: wait, x: loc.x, z: loc.z });
            else NoProg.delete(entity.id);
            // 🔴 走不动了 → 这一步**不是**"再走一步"能解决的：
            //    目标在头顶就垫柱，在墙后就挖穿（`repairReach`）。
            //    以前这两条只在"完全没有目标"（⑤ 分支）里跑，中景快照上线后
            //    几乎永远有目标 → 垫柱再没触发过，实测就是"不搭方块"。
            if (stuckApproach || wait >= CONFIG.gather.forceReachAfter) {
                repairReach(entity, kind, target);
            }
            // 这个出口以前什么都不做 → 头保留上一帧的角度。她在"敲脚下的矿"之后
            // 立刻转成"这块够不到"时，那个 45~55° 的低头就一直挂着，
            // 看起来像**脑袋冲着地面发呆**（2026-11-13 故障）。
            // 这里把朝向交还引擎：她要去哪儿，头就看哪儿。
            resetLook(entity);
            return;
        }
        NoProg.delete(entity.id);
        // 只进控制台，不进聊天栏：树林里她绕到树干另一侧时会反复触发，报一次刷一次屏
        log(`到位自救：引擎停在 ${CONFIG.gather.reach + CONFIG.gather.forceReachExtra} 格外撒手 → 就地开敲`);
    } else {
        NoProg.delete(entity.id);
        Approach.delete(entity.id);
    }
    // 走起来了（or 进了够得着的范围）→ 卡路计数归零，下次卡住重新计时
    PathStuck.delete(entity.id);

    // ④'' 正在赶路就先别敲。
    //     引擎带着她走（move_towards_target / 被别的行为拖走）时边走边抡很怪，
    //     进度也会被反复重置（永远敲不完一块）。
    //     阈值 0.08：原版 walk 速度约 0.2，站着时的微小抖动远低于这个数。
    //
    // 🔴 **但"已经在敲击半径里"时不许被这条拦住**（2026-11-13 
    //    「即便是和她贴脸的方块也永远不会再挖了」）。
    //    引擎锁着 48 格外的裂痕时会一直拽着她走，她绕着树根打转、速度永远 > 0.08，
    //    于是每轮都在这里 return —— 哪怕脚下就有一块原木。判据改成
    //    "**离手里这块还远**才不许敲"：够得着就敲，边走边敲也比一块不敲强。
    let moving = false;
    try {
        const vel = entity.getVelocity();
        moving = Math.hypot(vel.x, vel.z) > 0.08;
    } catch (e) { /* 读不到速度就当站着 */ }
    const nearEnough = inReach || withinReach(entity, target, CONFIG.gather.forceReachExtra);
    if (moving && !nearEnough) {
        setBusy(entity, false);
        Progress.delete(entity.id);
        // 🔴 **这里绝不能 clearCrack**（2026-11-13 实测"原地抖动 + 频繁索敌语音"）。
        //
        //    那个壳就是引擎的目标锚点。赶路时清掉 =
        //      `nearest_attackable_target` 立刻丢目标 → `move_towards_target` 退出
        //      → 她停下 → 下一轮巡检（0.5 秒后）再摆一个 → 引擎重新 acquire
        //      → `on_target_acquired` → `target_sound`（又一声索敌语音）→ 走两步再清…
        //    表现就是人钉在原地抖、语音连播、一步不挪。壳的生命周期统一交给
        //    `ensureCrack`（同块同时长不重建，失效才按 crackRetryTicks 退避重建）。
        if (target) lookAt(entity, target); else resetLook(entity);
        return;
    }

    // ⑤ 站定了：附近没有目标 → 让引擎继续找 / 垫柱
    //
    // 🔴 **单轮扫空不许拆裂痕**（"放上又移除"）。
    //    `scanTarget` 每 `scanEvery` 轮才真扫一次，中间读缓存不会空；但真扫那一轮可能
    //    因为树叶挡住（`blockingLeaf`）、方块刚被她敲碎、或中景候选暂时验不过而返回 undefined。
    //    原来这里立刻 `clearCrack` → 引擎丢锁 → 她停下 → 下一轮又扫到 → 重摆 →
    //    引擎重新 acquire（音效）→ … 0.5 秒一循环，正是"硬控"那种抖。
    //    现在给 `crackGraceRounds` 轮宽限（默认 2 轮 = 1 秒）：连续这么多轮都没目标才拆。
    if (!target) {
        setBusy(entity, false);
        Progress.delete(entity.id);
        Idle.set(entity.id, (Idle.get(entity.id) || 0) + 1);
        // 真的闲下来了（附近没目标）→ 她踩过的柱子进强制回收队列，别留一根土柱在野地里
        if ((Idle.get(entity.id) || 0) >= (CONFIG.gather.descendIdleRounds || 4)) {
            if (Trail.has(entity.id)) TrailCleanup.set(entity.id, farClock);
            // 拉黑名单也该重判了：她已经被判定"没活干"，说明之前那些"够不到"多半是
            // 站位/高度问题，不是那些方块本身的问题。不清空的话会一直选不上任何树。
            if (GiveUp.size) GiveUp.clear();
        }
        const miss = (CrackMiss.get(entity.id) || 0) + 1;
        CrackMiss.set(entity.id, miss);
        if (miss >= (CONFIG.gather.crackGraceRounds || 2)) clearCrack(entity.id);
        resetLook(entity);           // 头摆正 —— 走路时歪着脖子很怪
        // 近处没有就看看高处：垂直够不到且她已经走不动了 → 垫柱子上去
        considerPillar(entity, kind);
        return;
    }
    CrackMiss.delete(entity.id);     // 有目标了 → 空窗计数归零
    Stuck.delete(entity.id);         // 有活干 = 没卡住

    const key = `${target.x},${target.y},${target.z}`;
    let pr = Progress.get(entity.id);
    if (!pr || pr.key !== key) {
        pr = {
            key,
            ticks: 0,
            total: ticksFor(target.typeId, storedGatherTool(entity)),
            loc: target,
        };
        Progress.set(entity.id, pr);
    }

    setBusy(entity, true);

    // 真的敲上了 → 保护窗续期（这个高度还在用，别在这时候拆柱 / 把走位交还引擎），
    // 同时把"垫了几次柱"的账清零：这一块已经解决了，下次高处的目标重新计数。
    if (PillarDone.has(entity.id)) {
        PillarDone.set(entity.id, {
            x: target.x, y: target.y, z: target.z,
            until: farClock + Math.max(4, CONFIG.gather.pillarGraceRounds || 10),
        });
    }
    PillarTries.delete(entity.id);

    // 每轮巡检 = 敲一下：挥手 + 音效 + 碎屑一起给，才有"在敲"的感觉。
    // （原来只靠资源包那条 Molang 循环动画摆臂，引擎里不刷新 → 举着手不动）
    lookAt(entity, target);
    swingOnce(entity);
    playDig(entity, target, kind);
    sprayDebris(entity, target, 4);

    pr.ticks += CONFIG.gather.intervalTicks;

    // 方块表面的裂痕：基岩版没有破坏进度接口，只能靠空壳实体假装。
    // 只在第一次敲的时候摆出来，帧推进由 RP 的 uv_anim 按 life_time 自己走完。
    ensureCrack(entity, target, pr.total);

    if (pr.ticks < pr.total) return;

    Progress.delete(entity.id);
    clearCrack(entity.id);           // 方块要没了，裂痕壳先撤，别在空气里挂着
    // 顺手清掉周围的野壳：不清她挖完会立刻锁上一颗假目标，往那边走过去
    sweepCracks(entity, 0);
    breakAt(entity, target, kind, { chain: true });
}

/*
 * 命中目标的敲击时长（tick）。基准数是铁级、拿对工具的值，
 * 再按手里那把的材质与效率附魔折算（见 enchant.js）：木 ×3、石 ×1.5、铁 ×1、金 ×0.5、
 * 钻 ×0.75、合金 ×0.67，效率按 (基础速度 / (基础速度 + L²+1))。树叶不折算
 */
/*
 * 赶路被树叶挡住 → 现场清一条缝。她锁着裂痕、引擎也在拉，但寻路按「方块能不能站」算，
 * 整片树冠横在中间时寻路直接放弃，ranged 还在扯她 —— 表现就是原地踏步。
 * 判据是真的没挪窝：连续 stuckPathTicks 内水平位移 < 0.5 格才动手，正常走路绝不会触发。
 * 口径与 clearLeaves 一致：只认 LEAVES、不碰装饰叶、只清朝目标那一侧、只在砍树时用
 */
function clearLeavesOnPath(entity, target, kind) {
    if (kind !== "chop") return;
    if (!CONFIG.gather.clearPathLeaves) return;

    let loc, dim;
    try { loc = entity.location; dim = entity.dimension; } catch (e) { return; }
    if (!loc) return;

    const rec = PathStuck.get(entity.id);
    if (!rec) {
        PathStuck.set(entity.id, { x: loc.x, z: loc.z, ticks: 0 });
        return;
    }
    if (Math.hypot(loc.x - rec.x, loc.z - rec.z) > 1.0) {
        // 挪过窝了 → 重新计时。阈值取 1 格而不是 0.5：她要是"蹭着走"（半挡着，
        // 3 秒蠕动半格），0.5 会让计数一直清零、永远等不到清路的那一下。
        PathStuck.set(entity.id, { x: loc.x, z: loc.z, ticks: 0 });
        return;
    }
    rec.ticks += CONFIG.gather.intervalTicks;
    if (rec.ticks < CONFIG.gather.stuckPathTicks) {
        PathStuck.set(entity.id, rec);
        return;
    }
    // 清完从"当前站的位置"重新计时：否则起点一直是几秒前那个旧坐标，
    // 她只挪了不到 1 格也会被当成"还在原地"，下一轮接着清（等于连着剃）。
    PathStuck.set(entity.id, { x: loc.x, z: loc.z, ticks: 0 });

    const n = chopPathLeaves(dim, loc, target, entity);
    if (n > 0) {
        ScanCache.delete(entity.id);      // 方块变了，下一轮立刻重扫
        report(entity, `路被树叶挡死 → 清掉 ${n} 片开路`);
    }
    // n = 0：卡她的不是树叶（坑 / 落差 / 半砖），这里什么都不做 ——
    // 下一轮 ⑤ 分支的 considerPillar 会接手垫柱，两条链路各管各的。
}

/*
 * 把她身边朝目标那一侧的自然树叶敲掉最多 clearPathMax 片，每片顺带清掉正上方一格
 * （1 格高的洞她钻不过去，她要占 2 格）。开路不产出。
 * @returns {number} 实际清掉几片
 */
function chopPathLeaves(dim, loc, target, entity) {
    const R = CONFIG.gather.clearPathRadius;
    const max = CONFIG.gather.clearPathMax;
    const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);

    // 朝目标方向（只看水平）：只清这一侧，背后那半圈留着
    let ux = 0, uz = 0;
    const dx0 = target.x + 0.5 - loc.x;
    const dz0 = target.z + 0.5 - loc.z;
    const len = Math.hypot(dx0, dz0);
    const useDir = len > 0.8;
    if (useDir) { ux = dx0 / len; uz = dz0 / len; }

    const cands = [];
    // dy 从 0 开始，**绝不下探到 -1**：她走在树冠顶上时，脚下那格是树叶。
    // 挖掉 = 直接漏下去（下面可能是十几格空气），开路变成自杀。
    // 只清身体（by）到头顶（by+2），她占 2 格高，开出来的缝才钻得过去。
    for (let dy = 0; dy <= 2; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            for (let dz = -R; dz <= R; dz++) {
                const sq = dx * dx + dz * dz;
                if (sq > R * R) continue;
                if (useDir && dx * ux + dz * uz < -0.6) continue;   // 背向目标，不碰
                const x = bx + dx, y = by + dy, z = bz + dz;
                let b;
                try { b = dim.getBlock({ x, y, z }); } catch (e) { continue; }
                if (!b || !LEAVES.has(b.typeId)) continue;
                if (isPersistentLeaf(b)) continue;
                cands.push({ x, y, z, typeId: b.typeId, sq });
            }
        }
    }
    if (!cands.length) return 0;
    cands.sort((a, b) => a.sq - b.sq);

    let n = 0;
    for (const c of cands) {
        if (n >= max) break;
        // 这一列（她自己 + 头顶）一起开，别只开一格让她卡在洞门口
        for (let k = 0; k <= 1 && n < max; k++) {
            const y = c.y + k;
            // 她自己占着的那一格绝不挖：她半陷在树冠里时 by 这一格就是叶子，
            // 挖掉 = 脚下一空直接掉下去（下面十几格空气）。头顶那格可以挖（顶着她的头）。
            if (c.x === bx && c.z === bz && y === by) continue;
            let b;
            try { b = dim.getBlock({ x: c.x, y, z: c.z }); } catch (e) { break; }
            if (!b || !LEAVES.has(b.typeId)) continue;
            if (isPersistentLeaf(b)) continue;
            const id = b.typeId;
            try { b.setType("minecraft:air"); } catch (e) { continue; }
            playDig(entity, { x: c.x, y, z: c.z, typeId: id }, "chop", false);
            sprayDebris(entity, { x: c.x, y, z: c.z }, 4);
            n++;
        }
    }
    return n;
}

function ticksFor(typeId, tool) {
    if (LEAVES.has(typeId)) return Math.max(1, CONFIG.gather.leafTicks || 4);
    // 原木统一按原版硬度 2.0（铁级 10 tick）；树种类太多，不值得逐条列。
    const h = HARDNESS[typeId];
    const base = h !== undefined
        ? h
        : (CHOPS.has(typeId) ? (CONFIG.gather.logTicks || 10) : CONFIG.gather.defaultTicks);
    // 乘 digPace 让 10 帧裂纹看得见（见 config.digPace；要"原版速度"就设 1）；压上限防木镐拖太久
    const pace = Math.max(1, CONFIG.gather.digPace || 1);
    const cap = Math.max(1, CONFIG.gather.digMaxTicks || 200);
    const raw = Math.round(ticksWithTool(base, tool) * pace);
    // 下限就是一轮巡检：再短也是下一轮才结算，没必要拖成两轮
    return Math.min(cap, Math.max(CONFIG.gather.intervalTicks, raw));
}

/*
 * 方块材质 → 原版音效族。只按 id 猜，SAPI 拿不到 material。
 * 顺序要紧：先判木头 / 树叶再判土石 —— grass_block 同时含 grass 和 block，
 * 但它在原版用的是 gravel 那套（泥土音）。音效只用原版确定存在的几族：
 * wood / stone / grass / gravel / sand / glass / cloth 的 dig.* 与 hit.*
 */
const SOUND_RULES = [
    // 木：原木 / 菌柄 / 木板 / 木制成品
    [/(_log|_stem|_planks|_wood)$|_fence|_door$|_trapdoor$|_barrel$|_chest$|_sign$|_ladder$|_scaffolding$/, "wood"],
    // 玻璃 / 冰 / 紫水晶：清脆
    [/(_glass|glass_pane|_ice$|amethyst|_beacon$)/, "glass"],
    // 毛线 / 地毯：布料
    [/(_wool$|_carpet$|_bed$|_banner$)/, "cloth"],
    // 沙 / 砂砾 / 黏土 / 粉末
    [/(_sand$|sandstone|_gravel$|_clay$|_concrete_powder$|soul_sand$)/, "sand"],
    // 草 / 叶 / 苔 / 藤 / 农作物 / 菌盖
    [/(leaves|_grass$|grass_block|_fern$|_moss|_vine$|_lily|_wart_block$|_azalea|_roots$|_sprouts$|wheat$|_crop)/, "grass"],
    // 泥土类：原版走 gravel 那套闷响
    [/(^minecraft:dirt$|_dirt$|_mud$|farmland|podzol|mycelium|_nylium$|soul_soil$|_path$|_terracotta$)/, "gravel"],
];

/** @returns {"wood"|"stone"|"grass"|"gravel"|"sand"|"glass"|"cloth"} */
function soundMaterialOf(typeId) {
    if (!typeId) return "stone";
    for (const [re, mat] of SOUND_RULES) {
        if (re.test(typeId)) return mat;
    }
    return "stone";   // 矿石 / 深板岩 / 石头 / 未知一律石头
}

/** 方块材质 → 音效 id。敲的过程中用 hit.*（原版玩家每一下就是这个），
 *  破坏瞬间用 dig.*（碎裂声）。
 *  loc 不一定带 typeId（Chains 队列里带、巡检找到的也带），缺了就用 kind 兜。 */
function digSoundOf(typeId, kind, breaking) {
    const mat = typeId ? soundMaterialOf(typeId) : (kind === "chop" ? "wood" : "stone");
    return `${breaking ? "dig" : "hit"}.${mat}`;
}

/** 敲击 / 破坏音效。位置定在方块中心（有方向感），音量按"敲"和"破"分开。 */
function playDig(entity, loc, kind, loud) {
    try {
        entity.dimension.playSound(digSoundOf(loc.typeId, kind, !!loud), {
            x: loc.x + 0.5, y: loc.y + 0.5, z: loc.z + 0.5,
        }, { volume: loud ? 1.0 : 0.85, pitch: loud ? 0.9 : 1.0 });
    } catch (e) { /* 忽略 */ }
}

/*
 * 挥击动画。不用动画控制器算角度 —— 靠 query.life_time 的循环动画在引擎里求值不刷新，
 * 表现是举着手一动不动。改成 JS 每敲一下直接播一遍：纯关键帧 0.45 秒，与 10 tick 巡检对齐
 */
function swingOnce(entity) {
    try {
        // blendOut 0.15：动画 0.375 秒、巡检 0.5 秒，收尾留一点余量才不"一顿一顿"
        entity.playAnimation("animation.dm34_gather_swing", { blendOutTime: 0.15 });
    } catch (e) {
        // 老版本没有 playAnimation 时退回命令，语义一样
        try { entity.runCommand("playanimation @s animation.dm34_gather_swing"); } catch (e2) { /* 忽略 */ }
    }
}

/** 方块碎屑。基岩版没有"给方块加裂纹"的命令接口（破坏阶段是纯客户端渲染的叠加层），
 *  所以用破坏粒子在方块表面飞一点碎屑，作为"正在被打"的视觉反馈。
 *  粒子名不存在时自动降级到暴击星（那个一定在），只降一次。 */
let debrisParticle = "minecraft:block_destruct";

function sprayDebris(entity, loc, count) {
    let dim;
    try { dim = entity.dimension; } catch (e) { return; }   // 她已经被收走
    for (let i = 0; i < count; i++) {
        const at = {
            x: loc.x + 0.5 + (Math.random() - 0.5) * 0.6,
            y: loc.y + 0.5 + (Math.random() - 0.5) * 0.6,
            z: loc.z + 0.5 + (Math.random() - 0.5) * 0.6,
        };
        try {
            dim.spawnParticle(debrisParticle, at);
        } catch (e) {
            if (debrisParticle === "minecraft:basic_crit_particle") continue;   // 已经降到底了
            debrisParticle = "minecraft:basic_crit_particle";
            try { dim.spawnParticle(debrisParticle, at); } catch (e2) { /* 区块没加载，算了 */ }
        }
    }
}

// ── 方块裂痕（空壳实体） ─────────────────────────────────────────────

/** 在方块中心摆一个裂痕空壳。失败（区块没加载 / 实体没注册）就放弃，不影响挖矿本身
 *  @param {number} duration 这块要敲几 tick —— 决定裂纹从第 0 帧滚到第 9 帧的速度 */
function spawnCrack(entity, target, duration) {
    let c;
    try {
        c = entity.dimension.spawnEntity("dm34:block_crack", {
            x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5,
        });
    } catch (e) {
        crackErr = `spawn ${e}`.slice(0, 70);
        log(`裂痕实体 spawn 失败: ${e}`);
        return undefined;
    }
    // 🔴 `spawnEntity` 失败时**可能返回 undefined 而不抛错**（实体没注册 / 超上限）。
    //    原来这里直接 `c.setProperty(...)`，抛出的 TypeError 被下面的 catch 当成
    //    "属性没同步"吞掉，接着 `runTimeout` 里的 `c.isValid` 又被吞一次，
    //    最后 `return c` = undefined —— **一行日志都没有**，诊断只剩 `裂痕 0`。
    //    这就是 2026-11-13"裂纹放了就没、她原地抖"最难查的一环。
    if (!c) {
        crackErr = "spawn 返回空";
        log("裂痕实体 spawn 返回空（dm34:block_crack 没注册？）");
        return undefined;
    }
    try {
        c.setProperty("dm34:crack_duration", Math.max(1, Math.min(1200, Math.round(duration || 20))));
    } catch (e) {
        // 读不到就退回实体 JSON 的 default(20 tick) → 10 帧 1 秒闪完，看着像"只有两帧"
        logErr("crack_prop_spawn", e);
    }
    crackErr = "";

    // 🔴 摆新的之前，把 48 格内**别的**壳清掉（`midReach` = 她的管辖范围）。
    //
    //    残留壳是"她挖完还在走来走去 + 低头"的唯一来源：`dm_walk_mine/_chop` 的
    //    `nearest_attackable_target` 只认 `dm_crack_effect`，一颗没有对应方块的壳
    //    就是一个假目标 —— 引擎锁它、`move_towards_target` 拉她过去、`look_at_target`
    //    把脑袋拧向它。壳越多她越忙，而且永远挖不到真方块。
    sweepCracks(entity, 0, c);

    // 兜底：JS 侧记录断了（她被收进球 / 世界重载）也不让空壳永远挂在那儿。
    //
    // 🔴 必须是**续期**，不能"到点就删"：敲击时长 `pr.total` 只有几十 tick，
    //    原来 `life = total + 60` ≈ 4 秒，敲到一半壳就自己没了 → 下一轮巡检发现
    //    失效 → 重摆一颗 → 引擎 lose 再 acquire 各一次（又是一声索敌语音 + 抖一下）。
    //    现在每 20 秒检查一次：`Crack` 里记的还是这一颗、壳还活着 → 继续续命；
    //    记录没了（收工走 clearCrack 会显式 remove / 世界重载后表清空）→ 这才删。
    //    JSON timer 是最后一道闸（90 秒），只管"连续期都没人管"的野壳。
    const arm = () => {
        system.runTimeout(() => {
            let alive = false;
            try { alive = !!(c && c.isValid); } catch (e) { alive = false; }
            if (!alive) return;
            let stillMine = false;
            try { stillMine = Crack.get(entity.id)?.crack === c; } catch (e) { stillMine = false; }
            if (stillMine) { arm(); return; }          // 还在用 → 续期
            try { c.remove(); } catch (e) { /* 已经没了 */ }
        }, 400);
    };
    arm();
    return c;
}

function killCrack(rec) {
    if (!rec) return;
    try { if (rec.crack && rec.crack.isValid) rec.crack.remove(); } catch (e) { /* 忽略 */ }
}

/** 撤掉某只女仆正在显示的裂痕（换目标 / 方块挖掉 / 收工 / 目标丢失） */
function clearCrack(maidId) {
    const rec = Crack.get(maidId);
    // 退避 / 空窗计数一起清：主动撤壳（换目标 / 敲完 / 收工）是"新的开始"，
    // 不该让她下次为同一块再多等一个 crackRetryMax，也不该把上一轮的空窗带过来。
    CrackRetry.delete(maidId);
    CrackMiss.delete(maidId);
    if (!rec) return;
    killCrack(rec);
    Crack.delete(maidId);
}

/*
 * 清掉她周围没人认领的裂痕壳。
 * 🔴 这是「挖完还在索敌、脑袋盯地、来回走」的唯一解药：dm_walk_* 的攻击目标就是裂痕壳，
 * 没有对应方块的壳 = 假目标，引擎会一直锁它、拖她过去、把脑袋拧向它。
 * @param {number} radius 半径（0 / 空 = midReach）
 * @param {object} keep 要保留的壳（自己刚摆的那颗）；不传 = 连自己的一起清
 */
function sweepCracks(entity, radius, keep) {
    let dim, loc;
    try { dim = entity.dimension; loc = entity.location; } catch (e) { return 0; }
    if (!dim || !loc) return 0;
    const R = radius > 0 ? radius : Math.max(4, CONFIG.gather.midReach || 48);

    // 别的女仆正在用的壳不动（同屏多只作业时互不拆台）。
    // 自己那条记录不算 —— 自己上一颗壳就该被 `keep` 之外清掉。
    const busy = new Set();
    for (const [id, r] of Crack) {
        if (id === entity.id) continue;
        if (r && r.crack && r.crack.id !== undefined) busy.add(r.crack.id);
    }

    let n = 0;
    try {
        for (const o of dim.getEntities({ type: "dm34:block_crack", location: loc, maxDistance: R })) {
            if (keep && o.id === keep.id) continue;
            if (busy.has(o.id)) continue;
            try { o.remove(); n++; } catch (e) { /* 已经没了 */ }
        }
    } catch (e) { logErr("sweep_crack", e); }
    return n;
}

/**
 * 保证「正在敲的那一块」有裂痕。
 * 帧推进交给 RP：render_controller 的 uv_anim 用 `query.life_time / crack_duration`
 * 连续算 offset，所以这里只要摆一次、把总时长告诉它，之后什么都不用管。
 */
function ensureCrack(entity, target, duration) {
    const key = `${target.x},${target.y},${target.z}`;
    const want = Math.max(1, Math.min(1200, Math.round(duration || 20)));
    const now = tickNow();
    let rec = Crack.get(entity.id);
    let rt = CrackRetry.get(entity.id);
    const same = !!(rt && rt.key === key && rt.want === want);

    // 🔴🔴 **同一个方块，壳一旦摆上就只许改属性，绝不许销毁重建**
    //     （2026-11-13 「相当于我给你面前放了个僵尸，0.5 秒后移除了，
    //      再隔 0.5 秒又放僵尸，硬控你」）
    //
    //     旧代码这里是 `rec.key !== key || rec.duration !== want` 一起判 → 只要**时长变了**
    //     也走 `clearCrack` + 重新 spawn。而时长天然有两个值：
    //        · 走位阶段传 `markTicks`(1200)，到位后传 `pr.total`（几十 tick）
    //     她站在 reach 边界上时 `inReach` 会来回翻（引擎在 2.5 格撒手、她又被速度残余推
    //     半格、中景目标在 3~4 格），于是两个时长每轮交替 →
    //     **每 0.5 秒 clearCrack + spawnCrack 一次** → `nearest_attackable_target`
    //     反复 lose/acquire → `target_sound` 连播、`move_towards_target` 每轮重来
    //     → 原地抖、净位移 0。和 JSON 一点关系都没有。
    //
    //     所以现在：**换块才拆**；只是时长不同就 `setProperty` 改一下（实体不动，
    //     引擎的目标 ID 不变，不会丢锁）。走位记号 → 真实敲击时长只改一次，
    //     改完打 `punched` 标记；万一 `inReach` 又翻回 false（传回 1200），
    //     有 `punched` 就不再改回去 —— 裂纹视觉停在"敲击节奏"上，但锁一直在。
    if (rec && rec.key !== key) {
        clearCrack(entity.id);               // 真的换了目标块 → 必须拆（否则敲错块）
        CrackRetry.delete(entity.id);
        rec = undefined; rt = undefined;
    }
    if (rec && rec.crack && rec.crack.isValid) {
        // 🔴 走位壳 → 敲击壳：必须**重摆一颗新壳**，不能只 setProperty。
        //    RP 算帧号是 `life_time * 20 / duration`，`life_time` 只增不减。
        //    走位那颗壳已经活了十几秒（`markTicks` 1200 = 60 秒才走满 10 帧），
        //    把 duration 改成几十 tick 的瞬间帧号直接顶到 0.9 —— 表现就是
        //    "中间只有一两帧，镐子碰一下方块就碎"。重摆 = life_time 归零 = 从第 0 帧长起。
        //
        //    只在"这一块第一次进入敲击"时重摆一次，之后 `punched` 锁住：
        //    `inReach` 在 reach 边界抖动时不会再拆壳（那才是原地抖的根源）。
        if (want < CONFIG.gather.markTicks && !rec.punched) {
            clearCrack(entity.id);
            rec = undefined; rt = undefined;
        } else {
            return;
        }
    }

    // 走到这里 = 没壳 / 壳已失效。**必须先记一次失败，再按窗口决定**。
    //
    //  🔴 2026-11-13：这一步以前是"失效就立刻重摆"，于是变成
    //     摆上 →（1~2 帧内被引擎清掉）→ 下一轮巡检（0.5 秒）立刻再摆 → …
    //     每 0.5 秒给 `nearest_attackable_target` 换一次目标，acquire/lose 反复触发
    //     `target_sound`。表现就是"身体原地抖 + 索敌语音连播 + 一步不挪"。
    //
    //  退避次数 `n` 的算法：看**上一颗壳活了多久**（`rec.at`）。
    //    · 活不过 `crackRetryTicks`（1 秒）→ 它在抖，n+1 → 20/40/80/100 递增
    //    · 活够久（正常情况，走位那一颗能活 60 秒）→ n 归 0，1 秒后重摆
    //  这样"成功 → 立刻失效 → 成功 → 立刻失效"的循环也会被逐级拉长，
    //  不会因为"每次都 spawn 成功"就把节流重置掉。
    if (rec) {
        const base0 = Math.max(1, CONFIG.gather.crackRetryTicks || 20);
        const lived = (rec.at === undefined) ? 1e9 : now - rec.at;
        const shaky = lived < base0;
        Crack.delete(entity.id);
        CrackRetry.set(entity.id, {
            key, want, at: now,
            n: shaky ? (same ? rt.n + 1 : 1) : 0,
        });
        rt = CrackRetry.get(entity.id);
    }
    if (rt && rt.key === key && rt.want === want) {
        const base = Math.max(1, CONFIG.gather.crackRetryTicks || 20);
        const cap = Math.max(base, CONFIG.gather.crackRetryMax || 100);
        const wait = Math.min(cap, base * Math.pow(2, Math.min(3, rt.n)));
        if (now - rt.at < wait) return;       // 还在退避窗口里 → 这一轮不摆
    }

    const c = spawnCrack(entity, target, want);
    if (!c) {
        CrackRetry.set(entity.id, {
            key, want, at: now,
            n: same ? rt.n + 1 : 0,
        });
        return;
    }
    // 摆成功了：计数**不清零**，留给下一颗判断"它活了多久"。
    // （清了就退化成固定 20 tick，连续抖动拉不开口子。）
    CrackRetry.set(entity.id, { key, want, at: now, n: (same && rt ? rt.n : 0) });
    // 敲击壳从摆上那一刻就带 punched：`inReach` 在边界抖动不会再触发重摆
    Crack.set(entity.id, {
        key, duration: want, crack: c, at: now,
        punched: want < CONFIG.gather.markTicks,
    });
}

/** 掉落物飞向她。先真的生成一个物品实体（所以看得见"掉出来"），
 *  再用 teleport 每 tick 往她胸口拉一段，7 tick 后收进包里。
 *  中途被别人捡走（isValid 变 false）就不再补一份 —— 宁可少给，也不复制。 */
const FLY_TICKS = 7;

function popDrop(entity, itemId, amount, loc) {
    let item;
    try {
        item = entity.dimension.spawnItem(new ItemStack(itemId, amount || 1), {
            x: loc.x + 0.5, y: loc.y + 0.45, z: loc.z + 0.5,
        });
    } catch (e) {
        item = undefined;
    }
    if (!item) {                       // 生不出实体（物品 id 写错 / 区块问题）→ 直接进包，别丢东西
        stashItem(entity, itemId, amount);
        return;
    }

    let ticks = 0;
    const handle = system.runInterval(() => {
        try {
            if (!item.isValid) { system.clearRun(handle); return; }   // 被别人捡了
            const to = entity.location;
            const from = item.location;
            const k = 0.5;
            item.teleport({
                x: from.x + (to.x - from.x) * k,
                y: from.y + (to.y + 0.9 - from.y) * k,
                z: from.z + (to.z - from.z) * k,
            }, { dimension: entity.dimension });
            if (++ticks >= FLY_TICKS) {
                system.clearRun(handle);
                try { item.kill(); } catch (e) { /* 忽略 */ }
                stashItem(entity, itemId, amount);
            }
        } catch (e) {
            // 她中途没了（被收进球 / 卸载 / 传送丢块）→ 东西就地留着，不 kill、不硬塞，
            // 宁可掉在地上给人捡，也不能凭空吞掉。
            system.clearRun(handle);
        }
    }, 1);
}

/** 她自己垫上去的方块坐标集合（"x,y,z"）。没有垫过就是 undefined（省掉建 Set） */
function placedKeys(entity) {
    const trail = Trail.get(entity.id);
    if (!trail || !trail.length) return undefined;
    const s = new Set();
    for (const p of trail) s.add(`${p.x},${p.y},${p.z}`);
    return s;
}

/** 目标方块 → `"x,y,z"` 键 */
function keyOfTarget(t) {
    return t ? `${t.x},${t.y},${t.z}` : "";
}

/** 这块是不是"刚放弃、暂时不许选"的。顺手清理过期记录（惰性，不需要定时器） */
function giveUpActive(key) {
    if (!key) return false;
    const until = GiveUp.get(key);
    if (until === undefined) return false;
    if (farClock >= until) { GiveUp.delete(key); return false; }
    return true;
}

/** 当前所有"还在冷静期"的方块键（交给 `midPick` / 小扫描过滤） */
function giveUpSet() {
    if (!GiveUp.size) return undefined;
    const s = new Set();
    for (const [k, until] of GiveUp) {
        if (farClock >= until) GiveUp.delete(k);
        else s.add(k);
    }
    return s.size ? s : undefined;
}

/**
 * 放弃一块目标：拉黑一段时间，撤掉锚点，下一轮重选。
 * 这是"永远只盯那一块、旁边贴脸的都不挖"的解药。
 */
function giveUpTarget(entity, kind, target) {
    const key = keyOfTarget(target);
    GiveUp.set(key, farClock + Math.max(20, CONFIG.gather.giveUpCooldown || 240));
    // 🔴 **拉黑表要有上限**（2026-11-15 "下来后选不中任何树，只会漫步"）。
    //    每块够不到的方块都会进来、冷静期 2 分钟；她在一片够不到的大树上来回试，
    //    很快就能把周围几十块全拉黑 → `nearestTarget` 全被过滤 → 无目标 → 漫游。
    //    超量就丢最早的（Map 保持插入顺序），保留最近的判断。
    const cap = CONFIG.gather.giveUpMax || 48;
    while (GiveUp.size > cap) {
        const oldest = GiveUp.keys().next();
        if (oldest.done) break;
        GiveUp.delete(oldest.value);
    }
    Progress.delete(entity.id);
    NoProg.delete(entity.id);
    Approach.delete(entity.id);
    clearCrack(entity.id);          // 锚点撤掉，引擎别继续朝它走
    sweepCracks(entity, 0);         // 野壳一并清：她的攻击目标只有壳，留着就是假目标
    ScanCache.delete(entity.id);    // 下一轮立刻重选（会跳过这一块）
    report(entity, `(${target.x},${target.y},${target.z}) 站定 ${Math.round((CONFIG.gather.giveUpRounds || 16) / 2)} 秒还是够不到 → 先放一放，换一块`);
    log(`放弃目标 (${target.x},${target.y},${target.z})，冷静 ${CONFIG.gather.giveUpCooldown} 轮`);
}

// ---------------------------------------------------------------------------
// 采集牵绳（2026-11-14：跑出去砍树后人找不到了）
//
// 采集态是**不跟随**的（`gather_*` 会把 `follow` / `follow_test` 整组摘掉），
// 而选目标的中景半径是 `midReach`（48）—— 玩家站着不动，她能一路追到 48 格外。
// 这条绳子只管一件事：超距就把她传送回主人身边，别把女仆弄丢。
// ---------------------------------------------------------------------------

/** maidId → 上次牵绳传送的 farClock（巡检轮） */
const LeashClock = new Map();

/** 这只女仆的主人。离线 / 没主人 / 读不到 → undefined */
function ownerPlayerOf(entity) {
    try {
        const id = ownerIdOf(entity);
        if (!id) return undefined;
        for (const p of world.getAllPlayers()) {
            if (p.id === id) return p;
        }
    } catch (e) { logErr("读主人失败", e); }
    return undefined;
}

/*
 * 主人身边一个能站人的格子（优先离主人 1 格的八方向）。
 * 不直接传到主人坐标上：两人叠在一格时引擎会把她们互相挤开，挤到墙里就是一次窒息伤害
 */
function safeSpotNear(owner) {
    let o;
    try { o = owner.location; } catch (e) { return undefined; }
    const dim = owner.dimension;
    const bx = Math.floor(o.x), by = Math.floor(o.y), bz = Math.floor(o.z);
    const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (const [dx, dz] of ring) {
        const x = bx + dx, z = bz + dz;
        try {
            const below = dim.getBlock({ x, y: by - 1, z });
            const feet = dim.getBlock({ x, y: by, z });
            const head = dim.getBlock({ x, y: by + 1, z });
            if (below && !below.isAir && feet && feet.isAir && head && head.isAir) {
                return { x: x + 0.5, y: by, z: z + 0.5 };
            }
        } catch (e) { /* 区块没加载 */ }
    }
    return { x: o.x, y: o.y, z: o.z };
}

/*
 * 牵绳检查：离主人超过 leashRadius 就传送回身边。
 * 传送前必须把「她为什么跑那么远」整条拆掉，否则传回来下一轮又朝同一块走：
 * ① 拉黑当前目标 ② 撤裂痕 ③ 停垫柱状态机（句柄要 clearRun）④ 清敲击进度与节流表
 * ⑤ 中景整张作废（位置瞬移，旧地图全错）。柱子的方块不在这里拆 —— Trail 保留着，
 * 传送后位置差 > 3 格，collapseTrail 会按「已走开」分支一轮一格拆干净。
 * @returns true = 已传送，本轮巡检到此为止
 */
function leashCheck(entity, kind) {
    const g = CONFIG.gather;
    const R = g.leashRadius || 0;
    if (R <= 0) return false;
    const owner = ownerPlayerOf(entity);
    if (!owner) return false;                     // 主人不在线 → 不管她
    let loc;
    try { loc = owner.location; } catch (e) { return false; }
    let d;
    try {
        const l = entity.location;
        d = Math.hypot(l.x - loc.x, l.z - loc.z);
    } catch (e) { return false; }
    if (d <= R) return false;

    const now = farClock;
    if (now - (LeashClock.get(entity.id) ?? -99999) < (g.leashCooldown || 40)) return false;
    LeashClock.set(entity.id, now);

    // ① 目标
    let cached;
    try { cached = ScanCache.get(entity.id); } catch (e) { cached = undefined; }
    if (cached && cached.target) {
        try { giveUpTarget(entity, kind, cached.target); } catch (e) { logErr("牵绳拉黑目标失败", e); }
    }
    // ②③ 锚点 / 柱子
    try { clearCrack(entity.id); } catch (e) { logErr("牵绳清裂痕失败", e); }
    try { stopPillar(entity, false); } catch (e) { logErr("牵绳停垫柱失败", e); }
    // ④ 各种逐只的状态
    Progress.delete(entity.id);
    Idle.delete(entity.id);
    NoProg.delete(entity.id);
    Approach.delete(entity.id);
    PathStuck.delete(entity.id);
    Stuck.delete(entity.id);
    ScanCache.delete(entity.id);
    PillarDone.delete(entity.id);
    TunnelCd.delete(entity.id);
    Dig.delete(entity.id);        // 自救挖掘账本跟着一起清
    collapseTrail(entity);                        // 让 Trail 有机会清自己（拦不住就下一轮）

    const spot = safeSpotNear(owner);
    if (!spot) return false;
    try {
        entity.teleport(spot);
    } catch (e) {
        logErr("牵绳传送失败", e);
        return false;
    }
    resetLook(entity);
    snapDrop(entity);                             // ⑤ 位置变了，中景整张作废
    restoreWalkGroup(entity);                     // 传送后引擎得重新有"走"的力
    report(entity, `离你 ${d.toFixed(0)} 格 → 传送回身边`);
    log(`牵绳：${d.toFixed(1)} 格 → 传送回主人身边`);
    return true;
}

/*
 * 把 dm_walk_* 走位组挂回来（索敌 / ranged / move_towards 都在里面），垫柱开始时整组摘掉。
 * 🔴 失败必须报出来：没挂回来 = 引擎永远锁不到裂痕，症状和她「不会走路」一模一样
 */
function restoreWalkGroup(entity) {
    const kind = jobOf(entity);
    const want = kind === "mine" ? 6 : (kind === "chop" ? 7 : 0);
    if (!want) return;
    if (variantOf(entity) !== want) {
        logErr("恢复走位组时 variant 已不是采集态", `variant=${variantOf(entity)} 应 ${want}`);
        return;
    }
    try {
        entity.triggerEvent(kind === "mine" ? "gather_walk_mine" : "gather_walk_chop");
    } catch (e) {
        logErr("恢复走位组失败", e);
    }
}

/** 读某一格，确认它还是合法的采集目标（垫柱完成后"就敲这一块"要用） */
function blockIfTarget(entity, kind, t) {
    if (!t) return undefined;
    let b;
    try { b = entity.dimension.getBlock({ x: t.x, y: t.y, z: t.z }); } catch (e) { return undefined; }
    if (!b) return undefined;
    const set = kind === "chop" ? CHOPS : MINES;
    if (!set.has(b.typeId)) return undefined;
    return { x: t.x, y: t.y, z: t.z, typeId: b.typeId };
}

/*
 * 带节流的目标扫描（entityId 级缓存）。scanReach 拉大后每次要读上千方块，而树不会自己跑，
 * 所以每 scanEvery 轮真扫一次，其余沿用上次结果。方块被敲掉必须主动删缓存，否则她对着空气再站一秒
 */
function scanTarget(entity, kind) {
    // 🔴 **缓存里存的是"裸扫描结果"，粘性判断放在缓存外面**。
    //    要是把粘性结果写回 `ScanCache`，这张地图就永远自锁在第一次挑的那块上了。
    let fresh;
    const c = ScanCache.get(entity.id);
    if (c && c.kind === kind && farClock - c.clock < CONFIG.gather.scanEvery) {
        fresh = c.target;
    } else {
        let t;
        try { t = nearestTarget(entity, kind); } catch (e) { logErr("扫描异常", e); t = undefined; }
        ScanCache.set(entity.id, { clock: farClock, kind, target: t });
        fresh = t;
    }
    return stickyTarget(entity, kind, fresh);
}

/*
 * 目标粘性：手上这块还能用就别换。
 * 换目标 = 裂痕 key 变 = 拆壳重建 = 索敌 lose 再 acquire（各一次 target_sound）+ move_towards
 * 从头追 + 敲击进度归零。同距离候选一大把、排序每轮都可能变，于是 0.5~1 秒换一次 = 原地抖、
 * 语音连播、一块都没敲掉。
 * 判据（保守，只拦无意义地换）：旧目标还在且同类才考虑；仍在敲击半径内无条件粘住；否则只有新
 * 目标不明显更近（距离 ≥ 旧/1.2）时才粘；旧目标超出 midReach 或垂直离谱就放行。
 * @param {{x,y,z,typeId}|undefined} fresh 裸扫描结果
 * @returns {{x,y,z,typeId}|undefined} 实际要用的目标
 */
function stickyTarget(entity, kind, fresh) {
    const rec = Crack.get(entity.id);
    if (!rec) return fresh;                                  // 没在敲任何东西 → 直接用新结果
    // 这块刚被判定"怎么都够不到"→ 立刻放行换新的（否则她会永远粘着它，贴脸的都不挖）
    if (giveUpActive(rec.key)) return fresh;
    const fk = fresh ? `${fresh.x},${fresh.y},${fresh.z}` : "";
    if (fk === rec.key) return fresh;                        // 同一个块，没得选

    const p = String(rec.key).split(",");
    const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fresh;

    // ① 那块方块还在吗？还是原来的类别吗（被她敲掉 / 被别人换掉 → 立刻放行）
    let tid = "";
    try {
        const b = entity.dimension.getBlock({ x, y, z });
        tid = b ? String(b.typeId) : "";
    } catch (e) { return fresh; }
    if (kind === "chop" ? !CHOPS.has(tid) : !MINES.has(tid)) return fresh;

    const old = { x, y, z, typeId: tid };
    // ② 正在敲它（在敲击半径内）→ 无条件粘住
    if (withinReach(entity, old)) return old;

    // ②' 新目标就在手边、旧的不在 → 立刻换。「眼前的先挖」，别为远处的拆壳重锁
    if (fresh && withinReach(entity, fresh)) return fresh;

    // ③ 走位阶段：旧目标得还在"她愿意去的范围"里，否则她早就走开了
    let loc;
    try { loc = entity.location; } catch (e) { return fresh; }
    const oDx = x + 0.5 - loc.x, oDy = y - loc.y, oDz = z + 0.5 - loc.z;
    const lim = CONFIG.gather.midReach || CONFIG.gather.scanReach;
    if (oDx * oDx + oDz * oDz > lim * lim) return fresh;
    // 🔴 垂直口径必须跟 `midPick` 的**选点窗**一致（-2 .. midUp+1），
    //    **不是** `withinReach` 的敲击窗。这里以前用敲击窗，后果很隐蔽：
    //    垫柱途中她每升一格，旧目标的 oDy 就变一次，很快滑出敲击窗 →
    //    目标判死刑 → 拆柱下来重选 → 再垫 → 再丢 …… 表现就是
    //    「会搭方块了但搭上去就不挖了」（2026-11-13 实测）。
    //    粘性的语义是"我要不要继续去这块"，那就该用"去不去得了"的尺子。
    const stickyUp = Math.max(3, Math.round(CONFIG.gather.midUp ?? 6)) + 1;
    if (oDy < -2 || oDy > stickyUp) return fresh;

    if (!fresh) return old;                                  // 新扫描啥也没有 → 当然接着用旧的
    const nDx = fresh.x + 0.5 - loc.x, nDy = fresh.y - loc.y, nDz = fresh.z + 0.5 - loc.z;
    const oldSq = oDx * oDx + oDy * oDy + oDz * oDz;
    const newSq = nDx * nDx + nDy * nDy + nDz * nDz;
    // 1.44 = 1.2²：新目标得比旧目标近 20% 以上才值得为它拆壳重锁
    return (oldSq <= newSq * 1.44) ? old : fresh;
}

/*
 * 敲击半径的垂直容差：方块最多在她脚下 2.6 格、头顶 2.6 格。
 * 🔴 只有 withinReach（判现在能不能敲到）用这对常量；midPick / stickyTarget 用另一把尺子
 * （midUp + 1）—— 「选目标」与「判敲击」是两件事，混用会让高处目标形同虚设。
 * 上界放宽到 -2.6 是为了让垫柱收敛：垫到目标下方 1~2 格时那块正好落在这段里，
 * 原来的 -1.2 会判「够不到」→ 再垫一格 → 冲过头 → 落回去
 */
const REACH_DY_MIN = -2.6;
const REACH_DY_MAX = 2.6;

/*
 * 目标方块在不在敲击半径里（切比雪夫 + 垂直容差）。扫描半径是 10 格，必须显式判断，
 * 否则她会隔着 9 格抡镐子。
 * @param {number} [extra=0] 额外余量。只有到位自救会传 forceReachExtra
 * （引擎已撒手、她也不动了，宽容这 1.5 格直接开敲），别处一律传 0
 */
function withinReach(entity, t, extra) {
    let loc;
    try { loc = entity.location; } catch (e) { return false; }
    const R = CONFIG.gather.reach + (extra || 0);
    const dx = loc.x - (t.x + 0.5);
    const dz = loc.z - (t.z + 0.5);
    const dy = loc.y - t.y;
    return Math.abs(dx) <= R && Math.abs(dz) <= R && dy >= REACH_DY_MIN && dy <= REACH_DY_MAX;
}

/** 批量扫是否可用：null = 还没试过，true / false = 上次结果（诊断行会显示"逐格"兜底） */
let bulkOk = null;

/** 上一次批量扫命中多少块（诊断用）。-1 = 这轮没走批量、走的是逐格 */
let bulkHits = -1;

/** 批量读的自检是否已有结论（一次就够，结论永久生效） */
let bulkSelfTest = false;

/*
 * 批量扫方块：一次原生调用把整块体积交给引擎筛，只吐回命中的方块。
 * 瓶颈不是读方块而是每次 JS ↔ 引擎过一次边界：逐格 R=24 是 9604 次，
 * getBlocks(volume, {includeTypes}, true) 是 1 次，体积变大开销几乎不涨。
 * ① BlockVolume 用命名空间导入拿：某版本没导出时这里是 undefined 而不是加载期炸掉，调用方
 * 自动退回逐格扫；② allowUnloadedChunks = true：体积超出已加载区块时跳过而不是抛错，她在区块
 * 边缘时必需；③ includeTypes 只能写确切 id、写不了正则 —— 清单外的木头只有逐格路径看得见。
 * @returns {Array<{x,y,z,typeId}>|null} null = 读不出来，调用方兜底
 */
function bulkScanRaw(dim, from, to, ids) {
    const Ctor = SAPI.BlockVolume;
    if (typeof Ctor !== "function" || typeof dim.getBlocks !== "function") return null;
    let vol;
    try {
        vol = dim.getBlocks(new Ctor(from, to), { includeTypes: ids }, true);
    } catch (e) {
        return null;
    }
    // ⚠ 返回 null（而不是抛错）也算"读不出来"。2026-11-13 这里漏设 bulkOk=false，
    //    结果会以 scanReach 逐格扫一辈子；虽然逐格兜底还能干活，但开销是批量的两个数量级。
    if (!vol) return null;

    const out = [];
    // 🔴🔴 **`getBlocks()` 返回的是「体积对象」，不是数组。**
    //
    //    它返回 `ListBlockVolume`（或 `BlockVolume`），两者都继承 `BlockVolumeBase`，
    //    官方 API 里只有 `getBlockLocationIterator()` / `getCapacity()` / `getMin()` /
    //    `getMax()` / `getSpan()` / `getClosest()` —— **没有 `length`、没有下标**。
    //
    //    2026-11-13 事故：这里写成 `const n = list.length || 0` → 恒 0 →
    //    每次都返回**空数组**（不是 null，所以不会降级）→ `scanTarget` 永远"没目标"
    //    → 裂痕实体永不出现 → 她只剩 JSON 的 `move_to_block` 把她带到树/矿旁边站着。
    //    症状看着像"JSON 优先级问题"，其实是这里读不出来。
    //
    //    唯一正确的读法：`getBlockLocationIterator()`。它只吐**坐标**，拿 `typeId`
    //    要再 `getBlock()` 一次 —— 但命中的只有几十块，比逐格 9604 次便宜两个数量级。
    let it = null;
    if (typeof vol.getBlockLocationIterator === "function") {
        try { it = vol.getBlockLocationIterator(); } catch (e) { it = null; }
    }
    if (it) {
        for (let step = it.next(); step && !step.done; step = it.next()) {
            const loc = step.value;
            if (!loc) continue;
            let b;
            try { b = dim.getBlock(loc); } catch (e) { continue; }
            if (!b) continue;
            out.push({ x: loc.x, y: loc.y, z: loc.z, typeId: b.typeId });
        }
    } else if (typeof vol.length === "number") {
        // 兜底：万一某个版本的实现回吐的是「Block 数组」（老文档这么写过）
        for (let i = 0; i < vol.length; i++) {
            const b = vol[i];
            if (!b) continue;
            const l = b.location;
            if (!l) continue;
            out.push({ x: l.x, y: l.y, z: l.z, typeId: b.typeId });
        }
    } else {
        // 两种读法都不成立 = 这个返回值不认识。
        // **必须当"批量不可用"退回逐格** —— 否则就是静默地永远扫不到东西（上面那次事故）。
        return null;
    }
    return out;
}

/*
 * 批量扫方块（带诊断的包装）。拆两层是因为中景快照要连扫几十柱，它走裸实现，
 * 不会把 bulkHits 刷成「最后一柱命中 3 块」这种无意义值。这层只记一次扫描的成败
 */
function bulkScan(dim, from, to, ids) {
    const out = bulkScanRaw(dim, from, to, ids);
    if (out === null) {
        bulkOk = false;
        return null;
    }
    bulkOk = true;
    bulkHits = out.length;
    return out;
}

/**
 * **兜底逐格扫**（`bulkScan` 不可用时）。R=24 时是 9604 次跨边界，根本不能每轮跑，
 * 所以只在 API 缺失 / 抛错时才走这条路。
 */
function slowScan(dim, bx, by, bz, R, kind) {
    bulkHits = -1;      // 诊断行据此显示"逐格"
    const out = [];
    for (let dy = -1; dy <= 2; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            for (let dz = -R; dz <= R; dz++) {
                const x = bx + dx, y = by + dy, z = bz + dz;
                let b;
                try { b = dim.getBlock({ x, y, z }); } catch (e) { continue; }
                if (!b) continue;
                const id = b.typeId;
                if (kind === "chop" ? !CHOPS.has(id) : !MINES.has(id)) continue;
                out.push({ x, y, z, typeId: id });
            }
        }
    }
    return out;
}

// ── 中景快照（三层眼睛的第二层）───────────────────────────────────────
//
// 2026-11-13 ：**照 AI 玩家 Addon 的做法** ——
//   16³ 子区块（世界坐标对齐）· 扫过的一辈子不重扫 · 由近到远壳层遍历 ·
//   一帧一个子区块（`system.runJob`）· 懒读取（不等整张图扫完）。
//
// 为什么必须是"世界对齐的子区块"而不是上一版"以她为心的柱"：
//   以她为心切的柱子，她一走远就整张作废（旧版 `midRebuildDist 28` 就干这个）——
//   等于每隔一会儿把 48 格全部重扫一遍，白烧预算，而且重建期间地图是空的
//   （`!done` 一律不读 → 中景成了一段一段的瞎子）。
//   子区块按 `Math.floor(x / 16)` 对齐世界：她往前走时只有**新进窗口**的那几个要扫，
//   身后扫过的直接命中缓存。这才是"只大规模扫一次"的正确形态。
//
// 🔴 `midReach` 必须等于 JSON `dm_walk_*` 的 `within_radius` / `max_dist`：
//    快照里 48 格的树能摆出裂痕，但引擎只在 within_radius 内认它 → 锁不上 =
//    她站在原地看着裂痕发呆（和 2026-11-13 那次"干愣"是同一副面孔）。验证器卡这条。
//
// ⚠ 与 AI 玩家 Addon **唯一**的不同：它靠"家"实体圈范围保护玩家建筑，
//   这里仍走 `analyzeColumn` 逐块判自然树 —— 要求不拆玩家建筑。
//   代价是选点时可能要验 `naturalTrunk`（约 70 次读），所以结果记进 `cell.ok`
//   永久缓存：同一个方块一辈子只验一次。

/** entityId → 快照 `{ kind, dim, dimId, cx, cy, cz, chunks, plan, n, built, overflow }` */
const Snapshots = new Map();

/** entityId → `system.runJob` 返回的 jobId */
const SnapJobs = new Map();

/** 停掉正在跑的扫描任务（不删已经扫到的数据） */
function snapCancel(entity) {
    const job = SnapJobs.get(entity.id);
    if (job === undefined) return;
    SnapJobs.delete(entity.id);
    try { system.clearJob(job); } catch (e) { /* 已经跑完了 */ }
}

/** 收工 / 换工种：任务和地图一起清，别留孤儿 */
function snapDrop(entity) {
    snapCancel(entity);
    Snapshots.delete(entity.id);
}

/** 世界坐标 → 子区块坐标（AI 玩家 Addon 的 `getSubchunkKey` 同款，**必须 16 对齐**） */
function chunkKey(bx, bz) {
    return Math.floor(bx / 16) + "," + Math.floor(bz / 16);
}

/*
 * 建一张新地图（切工种 / 换维度 / 垂直跳变时调）。这里只开空图 + 算出第一批要扫的子区块，
 * 真正的扫描在 snapWorker 里一帧一个地推进，建图本身零成本，所以可以频繁调
 */
function snapBuild(entity, kind) {
    const g = CONFIG.gather;
    snapCancel(entity);
    Snapshots.delete(entity.id);
    if (!g.snapshotEnabled || typeof system.runJob !== "function") {
        // 没开 / 老引擎没有 runJob → 整层关掉，退回"小扫描 + move_to_block"
        return;
    }
    let loc, dim, dimId = "";
    try {
        loc = entity.location;
        dim = entity.dimension;
        dimId = String(dim.id);
    } catch (e) { return; }

    const snap = {
        kind, dim, dimId,
        cx: Math.floor(loc.x), cy: Math.floor(loc.y), cz: Math.floor(loc.z),
        // **建图时的 y，永不更新**：所有子区块的扫描层都以它为中心，换层就整张作废
        oy: Math.floor(loc.y),
        chunks: new Map(),      // "ccx,ccz" → { mx, mz, cells, keys, scanned }
        plan: [],               // 待扫子区块，按离她由近到远排
        n: 0,                   // 已存命中格子总数（不用每次遍历求和）
        ready: 0,               // 窗口内已扫完的子区块数
        total: 0,               // 窗口内应有的子区块总数
        built: farClock,
        overflow: false,
    };
    Snapshots.set(entity.id, snap);
    snapSync(entity, kind);     // 立刻算出窗口，排队，启任务
}

/*
 * 快照保鲜 = 跟着她平移窗口，而不是重建整张图。
 * · 已扫完的子区块平时不重扫，但每 snapRefreshTicks 整张打回未扫一遍，补上新露出的方块；
 * · 新进窗口的排进 plan 由 worker 由近到远补扫；
 * · 走出 midReach + midKeepPad 的扔掉（内存有限，回来时重扫）。
 * 只有换维度、垂直跳变才整张作废
 */
function snapSync(entity, kind) {
    const g = CONFIG.gather;
    if (!g.snapshotEnabled) return;

    const snap = Snapshots.get(entity.id);
    if (!snap || snap.kind !== kind) { snapBuild(entity, kind); return; }

    let loc, dimId = "";
    try { loc = entity.location; dimId = String(entity.dimension.id); } catch (e) { return; }
    if (snap.dimId && dimId && snap.dimId !== dimId) { snapBuild(entity, kind); return; }

    const cx = Math.floor(loc.x), cy = Math.floor(loc.y), cz = Math.floor(loc.z);
    // 垂直跳变：旧图扫的是 "oy-8..oy+6" 那 15 层，她现在跑到了别的层，图里的方块
    // 对她已经没有意义了（她不会往下挖，也不会为了目标往上垫）。
    //
    // 🔴 比的是 **`snap.oy`（建图时的 y，永不更新）**，不是 `snap.cy`。
    //    踩过的坑：`snap.cy` 每轮都跟着她更新，于是她慢慢走下坡 20 格也永远
    //    "只差 1 格" → 永远不重建；更糟的是 `snapWorker` 用 `snap.cy` 算扫描层，
    //    新扫的子区块在低处、旧子区块在高处，同一张图里两套 y 基准。
    const dyLim = Math.max(4, Math.round(((g.midDown ?? 8) + (g.midUp ?? 6)) / 2));
    if (Math.abs(cy - snap.oy) > dyLim) { snapBuild(entity, kind); return; }
    snap.cx = cx; snap.cy = cy; snap.cz = cz;    // cy 只给诊断看，扫描层永远用 oy

    const R = Math.max(16, Math.round(g.midReach || 48));
    const keep = R + Math.max(0, Math.round(g.midKeepPad || 16));
    const C = 16;

    // ① 淘汰走出窗口的子区块（**只**淘汰，不动剩下的缓存）
    for (const [k, ch] of snap.chunks) {
        const dx = ch.mx - loc.x, dz = ch.mz - loc.z;
        if (dx * dx + dz * dz > keep * keep) snap.chunks.delete(k);
    }

    // ①·5 定期**全量重扫**（默认 200 tick = 10 秒）：
    //      "扫完就永不重扫"会留盲区 —— 她挖开一层岩壁、后面露出来的矿，
    //      那块子区块早就 `scanned = true` 了，永远进不了图。
    //      只把标记打回未扫，`cells` 原样留着：地图不会出现空窗，
    //      新方块由 worker 补、消失的由 `midPick` 惰性 `snapForget` 清。
    // 🔴 `snapRefreshTicks` 是 tick，`farClock` 是巡检轮 → 必须除 intervalTicks。
    const refreshTicks = Math.max(40, Math.round(g.snapRefreshTicks || 200));
    const refresh = Math.max(1, Math.round(refreshTicks / Math.max(1, g.intervalTicks || 10)));
    if (farClock - (snap.refreshAt ?? snap.built) >= refresh) {
        snap.refreshAt = farClock;
        for (const ch of snap.chunks.values()) {
            if (ch.scanned === true) ch.scanned = false;   // "wip" 的不动
            // 🔴 **旧的自然树判定也要一起作废**。`cell.ok` 是永久缓存，
            //    而树会被砍矮（向下 gap 超过 trunkGap 就再也不是"自然树"）、
            //    玩家也会补种新树。不清的话那一片永远 `ok=false`：
            //    老树砍完、新树长出来，她一块都选不上（2026-11-15 实测）。
            for (const c of ch.cells) c.ok = undefined;
        }
    }

    // ② 重建待扫队列：窗口**圆柱内**、还没扫完、也没在扫的子区块
    const plan = [];
    let ready = 0, total = 0;
    const c0x = Math.floor((cx - R) / C), c1x = Math.floor((cx + R) / C);
    const c0z = Math.floor((cz - R) / C), c1z = Math.floor((cz + R) / C);
    for (let ccx = c0x; ccx <= c1x; ccx++) {
        for (let ccz = c0z; ccz <= c1z; ccz++) {
            const mx = ccx * C + C / 2, mz = ccz * C + C / 2;
            const dx = mx - cx, dz = mz - cz;
            const d2 = dx * dx + dz * dz;
            if (d2 > R * R) continue;                       // 圆柱，不是方盒
            total++;
            const k = ccx + "," + ccz;
            const ch = snap.chunks.get(k);
            if (ch && ch.scanned === true) { ready++; continue; }   // 扫过 → 一辈子不重扫
            if (ch && ch.scanned === "wip") continue;               // 正在扫
            plan.push({ key: k, ccx, ccz, mx, mz, d2 });
        }
    }
    plan.sort((a, b) => a.d2 - b.d2);       // 由近到远 = AI 玩家的壳层遍历
    snap.plan = plan;
    snap.ready = ready;
    snap.total = total;

    snapPump(entity, snap);
}

/** 有活干、又没在跑 → 起一个 `runJob`。一帧一个子区块，不卡主线程。 */
function snapPump(entity, snap) {
    if (SnapJobs.has(entity.id)) return;
    if (!snap.plan.length) return;
    const ids = snap.kind === "chop" ? CHOP_IDS : MINE_IDS;
    try {
        SnapJobs.set(entity.id, system.runJob(snapWorker(entity, snap, ids)));
    } catch (e) {
        logErr("快照任务启动失败", e);
        snap.plan = [];      // 空计划比"永远卡在未完成"好：至少退回小扫描
    }
}

/*
 * 快照生成器：一帧扫一个 16³ 子区块。体积 16×21×16 = 5376 格，比小扫描的 9604 还便宜；
 * 48 格圆柱 = 32 个子区块约 1.6 秒扫完，而她脚下那个第 1 帧就有数据（midPick 懒读取）。
 * 每帧前确认这活还该干：收工了 / 换工种了 / 图已被替换 → 立刻退出，别往旧对象里白写
 */
function* snapWorker(entity, snap, ids) {
    const g = CONFIG.gather;
    const cap = Math.max(64, Math.round(g.midMaxCells || 4000));
    const down = Math.max(0, Math.round(g.midDown ?? 8));
    const up = Math.max(0, Math.round(g.midUp ?? 6));

    while (snap.plan.length) {
        let alive = false;
        try { alive = entity.isValid && jobOf(entity) === snap.kind; } catch (e) { alive = false; }
        if (!alive || Snapshots.get(entity.id) !== snap) {
            // 🔴 **收工/换工种时必须把任务记录清掉**，否则 `snapPump` 会一直以为"还在跑"
            //    （`SnapJobs.has()` → return），新画出来的计划永远没人扫 ——
            //    表现是诊断行永远停在 `0/32区`，而她只能靠小扫描 24 格。
            //    只在"图还是我这张"时清：图被换掉说明 `snapCancel` 已经删过记录，
            //    新的 `snapPump` 可能已经写入了新 jobId，这时候再删就是误杀。
            if (Snapshots.get(entity.id) === snap) SnapJobs.delete(entity.id);
            return;
        }

        const p = snap.plan.shift();
        let ch = snap.chunks.get(p.key);
        if (!ch) {
            ch = { mx: p.mx, mz: p.mz, cells: [], keys: new Set(), scanned: "wip" };
            snap.chunks.set(p.key, ch);
        }
        ch.scanned = "wip";

        let hits = null;
        try {
            // 子区块在 x/z 上对齐世界坐标，y 用**建图时**她脚下那一层为中心
            hits = bulkScanRaw(
                snap.dim,
                { x: p.ccx * 16, y: snap.oy - down, z: p.ccz * 16 },
                { x: p.ccx * 16 + 15, y: snap.oy + up, z: p.ccz * 16 + 15 },
                ids,
            );
        } catch (e) { logErr("快照扫描异常", e); }

        if (hits) {
            for (const h of hits) {
                if (snap.n >= cap) { snap.overflow = true; break; }
                const kk = `${h.x},${h.y},${h.z}`;
                if (ch.keys.has(kk)) continue;
                ch.keys.add(kk);
                ch.cells.push({ x: h.x, y: h.y, z: h.z, typeId: h.typeId });
                snap.n++;
            }
        }
        ch.scanned = true;      // 本轮扫完；下一轮 `snapRefreshTicks` 到点会再打回 false 重扫
        snap.ready++;           // 诊断行直接读这个数，不用等下一轮 snapSync
        yield;                  // 引擎每 tick 给一个时间片
    }
    SnapJobs.delete(entity.id);
    if (snap.overflow) log(`快照命中超过 ${cap} 块 → 只留先扫到的（近处优先）`);
}

/** 从地图上抹掉一格（方块已经被挖掉 / 被替换） */
function snapForget(snap, cell) {
    const ch = snap.chunks.get(chunkKey(cell.x, cell.z));
    if (!ch || !ch.keys.delete(`${cell.x},${cell.y},${cell.z}`)) return;
    const i = ch.cells.indexOf(cell);
    if (i >= 0) ch.cells.splice(i, 1);
    if (snap.n > 0) snap.n--;
}

/*
 * 小扫描每轮都能看见 24 格内的真实情况，把新出现的补进地图。
 * 「挖掉的删」不在这里做（要给几百格逐个 getBlock 校验，太贵），改成惰性：
 * midPick 用到某一格时才验一次，验不过当场 snapForget。成本只是每命中一次 Set 查找
 */
function snapAdd(entity, kind, h) {
    const snap = Snapshots.get(entity.id);
    if (!snap || snap.kind !== kind) return;
    const k = chunkKey(h.x, h.z);
    let ch = snap.chunks.get(k);
    if (!ch) {
        // 小扫描能看见的子区块，中景迟早会扫到。先建个空壳接住这条命中；
        // `scanned` 保持 false，`snapSync` 会照常把它排进队列（不会漏扫）。
        ch = {
            mx: Math.floor(h.x / 16) * 16 + 8,
            mz: Math.floor(h.z / 16) * 16 + 8,
            cells: [], keys: new Set(), scanned: false,
        };
        snap.chunks.set(k, ch);
    }
    const kk = `${h.x},${h.y},${h.z}`;
    if (ch.keys.has(kk)) return;
    if (snap.n >= (CONFIG.gather.midMaxCells || 4000)) return;
    ch.keys.add(kk);
    ch.cells.push({ x: h.x, y: h.y, z: h.z, typeId: h.typeId });
    snap.n++;
}

/*
 * 从中景快照里挑一个引擎锁得上的目标（midReach 内）。
 * 这是三层里优先级最高的一层（范围最大、数据最全），nearestTarget 每轮把它与小扫描结果合并
 * 排序，谁近用谁，不是备胎。
 * 成本：遍历排序（纯算术）+ 逐块 getBlock 验真（挖掉的顺手抹掉）+ 砍树过一次 naturalTrunk
 * （约 70 次读，结果写进 cell.ok，同一方块一辈子只验一次）。gone > 64 是防呆：整片林子被烧时
 * 别为清图在一轮里读上千次。
 * @param {Set<string>} [skip] 已验过、明确不要的格子
 * @returns {{x,y,z,typeId,sq}|undefined}
 */
function midPick(entity, kind, bx, by, bz, skip) {
    const snap = Snapshots.get(entity.id);
    if (!snap || snap.kind !== kind || !snap.chunks.size) return undefined;

    const g = CONFIG.gather;
    const R = g.midReach || 48;
    const lim = R * R;

    const near = [];
    // 🔴 **选目标的垂直窗 ≠ 敲击的垂直窗**（2026-11-13 实测，这是个大 bug）
    //
    //    这里以前用的是 `REACH_DY_MIN/MAX`（-1.2..2.6）—— 等于"只有我现在这个高度
    //    够得着的方块才算目标"。
    //      「对高处的木头以及矿物的检测形同虚设，我测试中只有头顶正上方的才能检测到」
    //    完全正确：树干往上长、矿脉在岩层里高低起伏，比她高 3 格以上的部分在
    //    **选点**阶段就被删掉了 → `repairReach` 的垫柱永远没有出场机会
    //    （它要靠"有目标但够不到"才会被调用，目标都没了自然不调）。
    //
    //    选点该问的是"这块值不值得去"，够不够得着是第二步（垫柱 / 挖穿去解决）。
    //    所以上方放到 `midUp + 1`（默认 7 格，`maxPillar` 12 够得着）；
    //    下方仍然卡 2 格 —— 她不会往下挖，选出脚下的矿只会干愣，这条限制不变。
    //    排序分两档：平层 / 近高的先排（走过去就能敲），高处的排后面，同档按距离。
    const upLim = Math.max(3, Math.round(g.midUp ?? 6)) + 1;
    // 收尾中的那棵树：上界抬到树顶以上，否则悬空树冠永远进不了候选（选不上就没人去砍）。
    const task = chopTaskOf(entity, kind);
    const upTask = task ? Math.min(96, Math.ceil(task.yTop - by) + 4) : upLim;
    for (const ch of snap.chunks.values()) {
        if (!ch.cells.length) continue;
        // 整个子区块都在 48 格球外就先跳过，省几百次算术（16*16 是子区块半径的平方）
        const hx = ch.mx - bx, hz = ch.mz - bz;
        if (hx * hx + hz * hz > lim + 16 * 16 * 2) continue;
        for (const c of ch.cells) {
            const dx = c.x - bx, dy = c.y - by, dz = c.z - bz;
            if (dy > upTask) continue;         // 太高：垫柱也修不到，别排她的队
            if (dy < -2) continue;             // 太低：她不会往下挖
            const sq = dx * dx + dy * dy + dz * dz;
            if (sq > lim) continue;
            // tier 0 = 现在这个高度就敲得到（走过去即可）；tier 1 = 得先垫柱上去
            near.push({ c, sq, tier: (dy >= -2 && dy <= 2) ? 0 : 1 });
        }
    }
    if (!near.length) return undefined;
    near.sort((a, b) => (a.tier - b.tier) || (a.sq - b.sq));   // 稳两档，同档按距离

    const set = kind === "chop" ? CHOPS : MINES;
    const probeMax = Math.max(1, Math.round(g.midProbe || 24));
    let probed = 0, gone = 0;
    for (const item of near) {
        if (probed >= probeMax || gone > 64) break;
        const c = item.c;
        const ck = `${c.x},${c.y},${c.z}`;
        if (skip && skip.has(ck)) continue;
        let b;
        try { b = snap.dim.getBlock({ x: c.x, y: c.y, z: c.z }); } catch (e) { b = undefined; }
        if (!b || !set.has(b.typeId)) { snapForget(snap, c); gone++; continue; }
        probed++;
        // 砍树仍要过自然树闸 —— 要求不拆玩家建筑，这条不能省。
        // 例外：**正在收尾的那棵树**里的残骸直接放行（木桩 / 悬空树干本来就追不到树叶）。
        if (kind === "chop" && g.naturalOnly
            && !inChopTask(entity, kind, c.x, c.y, c.z, b.typeId)) {
            if (c.ok === undefined) {
                c.ok = !!naturalTrunk(snap.dim, c.x, c.y, c.z, b.typeId);
            }
            if (!c.ok) continue;
        }
        return { x: c.x, y: c.y, z: c.z, typeId: b.typeId, sq: item.sq };
    }
    return undefined;
}

/*
 * 在半径内找最近的目标方块。砍树比挖矿多两道闸，都是实测踩出来的：
 * ① 跳过她自己垫的方块（Trail）：否则垫一格 → 脚边那块被当成最近的树砍掉 → 掉下来 → 再垫；
 * ② 只认自然树（analyzeColumn）：玩家搭的桩子 / 房梁不该进目标表。
 * 候选按距离由近到远依次过闸，第一个过的就是目标
 */
function nearestTarget(entity, kind) {
    // 扫描半径用 scanReach（24），**不是**敲击半径 reach（3）。
    // 找到之后由 tickOne 判断"在不在 reach 里"：不在就摆假实体让引擎带她过去。
    // 批量接口不可用（老引擎 / 调用抛错）时自动退回 12：逐格扫 9604 格太贵，
    // 半径换小是唯一能保住手感又不掉 TPS 的降级方式。
    const R = bulkOk === false
        ? Math.min(CONFIG.gather.scanReach, 12)
        : CONFIG.gather.scanReach;

    // ① **伐木任务优先**（照 `AI玩家 Add-On BP` 的 `feature.blocks`）：
    //    正在收尾的那棵树直接按坐标表逐个处理，完全不依赖快照 / 自然树判定。
    //    表里已经变成空气的顺手剔除；表空了 = 整棵树收干净，任务结束。
    //    木桩、被砍断后悬空的残段都在这张表里，所以它们不会再"消失"。
    const task = chopTaskOf(entity, kind);
    if (task) {
        // 🔴 **有任务表就是"有候选"**。不设这一条的话，`tickOne` 里
        //    `cands = HadCands.get()` 会读到上一轮的 0 → 走"圈内没木头"分支 →
        //    攒够 `guideQuietRounds` 把 `dm_guide_*` 挂上 → `move_to_block` 82 格
        //    把她拖走。表现就是"下来后无视一切树木走远了"。
        HadCands.set(entity.id, 1);

        // 上一轮那块一直够不到（`Approach` 攒满）→ **从任务表剔除**。
        // 走 `giveUpTarget` 会污染全局拉黑表，把正常扫描的目标也一起封掉，
        // 所以这里只删表项，让它回到正常扫描。
        const ap = Approach.get(entity.id);
        if (ap && ap.key && ap.n >= Math.max(4, CONFIG.gather.chopTaskDropRounds || 8)) {
            if (task.blocks.delete(ap.key)) {
                log(`任务表剔除够不到的 ${ap.key}（接近轮 ${ap.n}）`);
                Approach.delete(entity.id);
            }
        }

        let bst, bstSq = Infinity;
        let loc, tdim;
        try { loc = entity.location; tdim = entity.dimension; } catch (e) { loc = null; }
        if (loc) {
            for (const k of Array.from(task.blocks)) {
                const p = k.split(",");
                const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
                let b;
                try { b = tdim.getBlock({ x, y, z }); } catch (e) { continue; }
                if (!b || b.typeId !== task.id) { task.blocks.delete(k); continue; }
                // 这一块刚被判"够不到"→ 先跳过，换表里下一块（照 AI 玩家"挖失败塞回队尾"）
                if (GiveUp.size && giveUpActive(k)) continue;
                const dx = x - loc.x, dy = y - loc.y, dz = z - loc.z;
                const sq = dx * dx + dy * dy + dz * dz;
                if (sq < bstSq) { bstSq = sq; bst = { x, y, z, typeId: b.typeId, sq }; }
            }
            // 🔴 **必须限距**（2026-11-15 "面前的树半天扫不到"）。
            //    这里如果不限距，表里只要还留着几块够不到的悬空枝干，
            //    每轮都会把它们当答案返回 → 正常扫描（小扫描 / 中景）根本轮不到 →
            //    面前贴脸的新树永远选不上。超出小扫描半径就让位给正常链路；
            //    远处残骸由中景（`inChopTask` 放行，48 格）照样选得到。
            if (bst && bstSq <= R * R) return bst;
        }
        if (task.blocks.size === 0) {
            ChopTask.delete(entity.id);              // 收干净了
            if (Trail.has(entity.id)) TrailCleanup.set(entity.id, farClock);   // 柱子开始强制回收
        }
    }

    // 扫描半径 R 已在函数开头算好
    const dim = entity.dimension;
    let base;
    try { base = entity.location; } catch (e) { return undefined; }

    const bx = Math.floor(base.x), by = Math.floor(base.y), bz = Math.floor(base.z);
    const mine = kind === "chop" ? placedKeys(entity) : undefined;

    // 快路径：一次原生批量筛；不可用就退回逐格。
    let hits = bulkScan(
        dim,
        { x: bx - R, y: by - 1, z: bz - R },
        { x: bx + R, y: by + 2, z: bz + R },
        kind === "chop" ? CHOP_IDS : MINE_IDS,
    );
    if (hits === null) hits = slowScan(dim, bx, by, bz, R, kind);

    // 🛡 **批量读的自检**（只做一次，结论出来就永久生效）。
    //
    //    批量接口最危险的失败不是"抛错"（那有 try/catch + 降级），而是**不抛错但读出来是空的**：
    //    2026-11-13 就是这样——`getBlocks()` 返回体积对象，代码按数组读 `list.length`，
    //    恒 0、无异常、`bulkOk` 还写着 true → 永远"没目标"、裂痕不出现、
    //    她只剩 JSON 的 move_to_block 把她带到树旁边站着。这种静默失败没有日志、没有报错。
    //
    //    所以：第一次批量扫出来是 0 块时，用**半径 8 的逐格扫**复核一次（1156 次读，一辈子一次）。
    //      · 逐格也 0 块 → 这地方真没目标，自检**不算完**，下轮再验
    //      · 逐格有块   → 批量读是坏的，永久标记 bulkOk=false，本轮直接用逐格结果
    if (!bulkSelfTest && bulkOk === true && hits !== null) {
        if (hits.length > 0) {
            bulkSelfTest = true;                       // 批量确实读得出东西
        } else {
            const probe = slowScan(dim, bx, by, bz, 8, kind);
            if (probe.length > 0) {
                bulkSelfTest = true;
                bulkOk = false;
                log("批量扫描返回空但近处有目标 → 判定批量读不可用，退回逐格（半径压到 12）");
                hits = probe;
            }
        }
    }

    const cands = [];
    const skip = giveUpSet();          // 刚被放弃的方块这一轮不许再选
    for (const h of hits) {
        const dx = h.x - bx, dy = h.y - by, dz = h.z - bz;
        if (mine && mine.has(`${h.x},${h.y},${h.z}`)) continue;   // 那是她自己垫的
        if (skip && skip.has(`${h.x},${h.y},${h.z}`)) continue;   // 刚放弃的
        // 快路径按 includeTypes 筛过了，这里再核一遍防引擎回吐别的东西
        if (kind === "chop" ? !CHOPS.has(h.typeId) : !MINES.has(h.typeId)) continue;
        snapAdd(entity, kind, h);      // 第三层更新第二层：新出现的补进中景地图
        cands.push({ x: h.x, y: h.y, z: h.z, typeId: h.typeId, sq: dx * dx + dy * dy + dz * dz });
    }

    // 🔴 **中景优先级最高**（2026-11-13）。
    //
    //    它范围最大（midReach 48）、数据最全，所以**不是**"小扫描空了才轮到"的备胎：
    //    这里每轮都取一次，和小扫描的结果**比距离**，谁近用谁。两个后果都是想要的：
    //      · 小扫描圈里全是玩家建筑（过不了 naturalTrunk）时，中景能直接给出 24 格外的真树
    //      · 小扫描被 `naturalProbe 8` 块上限挡住时，中景不必再走一遍那条昂贵的路
    //
    //    成本不用担心：`midPick` 按 `cell.ok` 永久缓存自然树验证结果，
    //    第 2 轮起每条候选最多 1 次 `getBlock`；调用点已被 `scanTarget` 节流到 1 秒一次。
    const mid = midPick(entity, kind, bx, by, bz, skip);

    if (!cands.length) {
        // 先按"圈内一片木头都没有"记账（`guideQuietRounds` 靠它数），
        // 下面的中景命中就把它改回去 —— 这样"里外都没有"这条出口天然带着 0，
        // 不需要在每个 return 前面再补一遍（漏一个引导就永远挂不回来）。
        HadCands.set(entity.id, 0);
        if (mid) {
            RejectNote.delete(entity.id);
            HadCands.set(entity.id, 1);   // 48 格内有真目标 → 别挂引导，让 ranged_attack 拉她过去
            return mid;
        }
        return undefined;
    }

    cands.sort((a, b) => a.sq - b.sq);
    HadCands.set(entity.id, cands.length);   // 有候选（不论合法与否）→ 引导不挂
    if (kind !== "chop" || !CONFIG.gather.naturalOnly) {
        return (mid && mid.sq < cands[0].sq) ? mid : cands[0];
    }

    // 圈内可能几十块原木，每块都跑 analyzeColumn（向上追树冠 + 抽样）太贵。
    // 按距离从近到远最多试 naturalProbe 块，都不合格就算了 —— 下一轮再试，
    // 真有好树的时候最近的几块大概率就是。
    const probeMax = CONFIG.gather.naturalProbe || 8;
    let probed = 0, bestLocal;
    for (const c of cands) {
        // 已知"不是树"的候选不占探测名额 —— 一片悬空残骸就能把 8 个名额全吃光，
        // 后面的真树永远轮不到（2026-11-15 日志："边上 8 块原木都不是自然树"）。
        if (c.ok === false) continue;
        if (probed++ >= probeMax) break;
        const okk = trunkOk(entity, kind, dim, c.x, c.y, c.z, c.typeId);
        c.ok = okk;
        if (okk) { bestLocal = c; break; }
    }
    if (bestLocal) {
        RejectNote.delete(entity.id);
        HadCands.set(entity.id, cands.length);
        return (mid && mid.sq < bestLocal.sq) ? mid : bestLocal;
    }
    // 边上全是"不像树"的原木（玩家搭的）→ 报一次，别让她站在墙边发呆还查不出原因。
    // 只在候选变了才报，同一堆方块不会每 0.5 秒刷一遍。
    const note = cands.slice(0, probeMax).map((c) => `${c.x},${c.y},${c.z}`).join("|");
    if (RejectNote.get(entity.id) !== note && rejectBudget > 0) {
        rejectBudget--;
        RejectNote.set(entity.id, note);
        report(entity, `边上 ${cands.length} 块原木都不是自然树（${columnWhy}）→ 不碰它`);
    }

    // 最后一道：附近确实有自然树，但她一片都够不到 —— 树干被天然树叶包住了
    // （丛林小树、云杉幼树、树长在 1 格宽的坑里都是这种情况）。
    // 口径："进不去就拆门" —— 把离她最近的那片自然树叶当临时目标挖掉，
    // 挖通一格她就能靠到树干上，下一轮自然接上连锁。
    // 玩家放的叶子（persistent_bit = true）不算，避免顺手拆了人家院子里的装饰。
    if (CONFIG.gather.clearLeaves) {
        // 🔴 半径是 leafDoorRadius（4），**不是** R（24）。blockingLeaf 是逐格 getBlock：
        //    拿 24 去扫 = 14406 次跨界，一秒一次，把 bulkScan 省下的全吃掉。
        const leaf = blockingLeaf(dim, bx, by, bz, CONFIG.gather.leafDoorRadius, entity, kind);
        if (leaf) {
            if (RejectNote.get(entity.id) !== "leaf") {
                RejectNote.set(entity.id, "leaf");
                report(entity, "够不到树干，先拆开挡路的自然树叶");
            }
            HadCands.set(entity.id, cands.length);
            return leaf;
        }
    }

    // 走到这里 = 圈内**有原木候选，但一块自然树都不算**，连能拆的自然树叶也没有
    // → 这就是"玩家建筑 / 人造木结构"。
    //
    // 但"这片是玩家盖的"不等于"世界上没树了"：中景地图（48 格）里要是有真树就过去 ——
    // 否则她会站在玩家木屋旁边一直漫游，明明旁边就是树林。
    // 这里直接用开头那次 `midPick` 的结果：它自己带 `cell.ok` 缓存，刚验过"不是树"的
    // 那批会在下一轮永久跳过，不需要再传一份 `skip` 重算一遍。
    if (mid) {
        RejectNote.delete(entity.id);
        HadCands.set(entity.id, cands.length + 1);
        return mid;
    }

    // 🔴 **不挂引导**（判据是 `HadCands > 0`，由 tickOne 决定）：有人可能以为该停几十秒
    //   再试，但冷却只是把拉锯推后 —— 到点 `move_to_block` 照样把她拽回同一堵墙。
    //   正确的做法是"这片有木头，我就不派你出去"，让她自己漫步走开。
    //
    // 报告只在候选变了才发（`RejectNote` 里已有同一份指纹，见上），这里不再刷屏。
    return undefined;
}

/*
 * 离她最近的一片该拆的自然树叶：本身是天然叶（persistent_bit = false），
 * 且周围 26 格内连着自然树的树干（挡掉「只是路过树林」）。只在 reach 内没有原木时才调用
 */
function blockingLeaf(dim, bx, by, bz, R, entity, kind) {
    // R 只该是 CONFIG.gather.leafDoorRadius（4），不是 scanReach。
    // 这里只找"她身边那几片挡路的叶子"，逐格扫描的代价与 R² 成正比。
    const cands = [];
    for (let dy = -1; dy <= 4; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            for (let dz = -R; dz <= R; dz++) {
                const x = bx + dx, y = by + dy, z = bz + dz;
                let b;
                try { b = dim.getBlock({ x, y, z }); } catch (e) { continue; }
                if (!b || !LEAVES.has(b.typeId)) continue;
                if (isPersistentLeaf(b)) continue;
                if (!trunkNearby(dim, x, y, z, entity, kind)) continue;
                cands.push({ x, y, z, typeId: b.typeId, leaf: true, sq: dx * dx + dy * dy + dz * dz });
            }
        }
    }
    if (!cands.length) return undefined;
    cands.sort((a, b) => a.sq - b.sq);
    return cands[0];
}

/** 这片叶子的 3×3×3 邻域里有没有一根"自然树"的树干 */
function trunkNearby(dim, x, y, z, entity, kind) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (!dx && !dy && !dz) continue;
                const nx = x + dx, ny = y + dy, nz = z + dz;
                let b;
                try { b = dim.getBlock({ x: nx, y: ny, z: nz }); } catch (e) { continue; }
                if (!b || !CHOPS.has(b.typeId)) continue;
                if (trunkOk(entity, kind, dim, nx, ny, nz, b.typeId)) return true;
            }
        }
    }
    return false;
}

// ── 转头 / 垫柱升空 ───────────────────────────────────────────────────

/** 折到 -180..180 */
function wrap180(a) {
    while (a > 180) a -= 360;
    while (a < -180) a += 360;
    return a;
}

/*
 * 「头看向正在敲的方块」交还引擎：dm_mine / dm_chop 的 look_at_target 保持 probability 1.0，
 * 壳就摆在目标方块中心，头对准的就是要敲的那一格。
 * 以前用 JS 按「眼睛→方块中心」硬算 look_pitch / look_yaw，0.5 秒才更新一次，
 * 而 look_yaw 是「方块世界角 − 当前身体朝向」，走位时身体一直在转 → 头一帧猛甩、下一帧甩回。
 * 而且 look_pitch 是持久属性，收工不清就永久卡在低头 45°
 */
function lookAt(entity) {
    clearLookProps(entity);
}

/** 只清"谁说了算"和 JS 那两个角度。**绝不动实体俯仰** —— 有目标时引擎正靠着它低头看方块。 */
function clearLookProps(entity) {
    // hold=1 → 引擎的 target_x_rotation 生效（打架盯目标、采集盯方块都靠它）
    try { entity.setProperty("dm34:look_hold", 1); } catch (e) { /* 忽略 */ }
    try { entity.setProperty("dm34:look_pitch", 0); } catch (e) { /* 忽略 */ }
    try { entity.setProperty("dm34:look_yaw", 0); } catch (e) { /* 忽略 */ }
}

/** 没目标 / 收工：清属性 **并把实体俯仰抬正**。 */
function resetLook(entity) {
    clearLookProps(entity);
    // 实体俯仰被引擎（盯裂痕壳）拧下去后自己不会抬回来，而 head 骨骼是
    // relative_to entity 的 —— 属性全归零也还是垂着头。只动 x，绝不碰 yaw。
    try {
        const r = entity.getRotation();
        if (r && Math.abs(r.x) > 8) entity.setRotation({ x: 0, y: r.y });
    } catch (e) { /* 忽略 */ }
}

/**
 * 非采集态兜底：属性是持久化的，上一版残留的非零角度不会自己消失，她会永远垂着头。
 * 只在读到脏值时才写，避免每轮巡检都发属性同步。
 */
function clearLookResidue(entity) {
    let hold, pitch, yaw;
    try {
        hold = entity.getProperty("dm34:look_hold");
        pitch = entity.getProperty("dm34:look_pitch");
        yaw = entity.getProperty("dm34:look_yaw");
    } catch (e) { return; }              // 属性没声明，别反复试
    let dirty = !(hold === 1 && !pitch && !yaw);
    if (!dirty) {
        try {
            const r = entity.getRotation();
            dirty = !!r && Math.abs(r.x) > 8;
        } catch (e) { return; }
    }
    if (dirty) resetLook(entity);
}

/*
 * 近处扫不到时的补扫：只看头顶 + 近旁，专找高处的矿。返回值三态：
 * undefined = 本轮按节流跳过（调用方别据此清状态）；null = 扫了确实没有；{...} = 找到了
 */
function farTarget(entity, kind) {
    if (farClock % CONFIG.gather.farEvery !== 0) return undefined;
    const R = CONFIG.gather.farReach;
    // 收尾中的那棵树：上界抬到树顶，否则悬空树冠（常常 15~30 格高）根本扫不到，
    // 也就没人触发垫柱上去。
    const task = chopTaskOf(entity, kind);
    const up = task ? Math.min(96, Math.ceil(task.yTop - base.y) + 2) : CONFIG.gather.farUp;
    let base, dim;
    try { base = entity.location; dim = entity.dimension; } catch (e) { return null; }

    const bx = Math.floor(base.x), by = Math.floor(base.y), bz = Math.floor(base.z);
    const mine = kind === "chop" ? placedKeys(entity) : undefined;
    let best, bestSq = Infinity;

    for (let dy = 2; dy <= up; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            for (let dz = -R; dz <= R; dz++) {
                const x = bx + dx, z = bz + dz;
                if (mine && mine.has(`${x},${by + dy},${z}`)) continue;
                let b;
                try { b = dim.getBlock({ x, y: by + dy, z }); } catch (e) { continue; }
                if (b) {
                    if (kind === "chop" ? !CHOPS.has(b.typeId) : !MINES.has(b.typeId)) continue;
                    if (GiveUp.size && giveUpActive(`${x},${by + dy},${z}`)) continue;   // 刚放弃的
                    // 砍树时"高处的木头"同样只认自然树，不然她会往上垫着去拆玩家搭的桩子；
                    // 正在收尾的那棵树例外，否则悬空树冠没人去砍。
                    if (kind === "chop" && CONFIG.gather.naturalOnly
                        && !inChopTask(entity, kind, x, by + dy, z, b.typeId)
                        && !naturalTrunk(dim, x, by + dy, z, b.typeId)) continue;
                    const sq = dx * dx + dy * dy + dz * dz;
                    if (sq < bestSq) {
                        bestSq = sq;
                        best = { x, y: by + dy, z, typeId: b.typeId };
                    }
                }
            }
        }
    }
    return best || null;
}

/*
 * 够不到目标时真去解决。
 * 老逻辑里「垫柱 / 挖穿」只有完全没目标时才进；有了中景快照后 scanTarget 几乎永远给得出目标
 * （哪怕在 40 格外），于是 considerPillar 再没被调用过：高树上面那截、墙里的矿全停在干等。
 * 按空间关系分两条：目标在头顶且水平很近 → 垫柱上去；目标在墙后 / 坡里 → 挖一条 2 格高走廊。
 * 两个都做不了就什么都不做（正常走过去才是对的）。
 * // ── 试走验证的四个动作（照 AI 玩家的 feature_reacher 思路）──
 */
function probeVerified(entity, target) {
    const m = Verified.get(entity.id);
    if (!m) return false;
    const k = keyOfTarget(target);
    const at = m.get(k);
    if (at === undefined) return false;
    if (farClock - at >= (CONFIG.gather.probeTriedRounds || 200)) { m.delete(k); return false; }
    return true;
}

/** 这一格矿是不是刚试走失败过（冷却中）。冷却中直接走原有链路（含 `repairReach`）。 */
function probeTriedRecently(entity, target) {
    const m = ProbeTried.get(entity.id);
    if (!m) return false;
    const k = keyOfTarget(target);
    const until = m.get(k);
    if (until === undefined) return false;
    if (farClock < until) return true;
    m.delete(k);
    return false;
}

/*
 * 把她此刻站的地方周边 probeRadius 内的矿全记成可达。
 * 不记「她当初挑的那一格」是因为 move_to_block 的 target_selection_method 是 nearest，
 * 引擎自己挑方块、JS 没法指定，能确认的只有脚下这一带走得到
 */
function probeMarkAround(entity, kind) {
    let loc;
    try { loc = entity.location; } catch (e) { return 0; }
    const R = CONFIG.gather.probeRadius || 2;
    const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);
    const ids = kind === "mine" ? MINE_IDS : CHOP_IDS;
    const hits = bulkScanRaw(
        entity.dimension,
        { x: bx - R, y: by - R, z: bz - R },
        { x: bx + R, y: by + R, z: bz + R },
        ids
    );
    if (!hits || !hits.length) return 0;
    let m = Verified.get(entity.id);
    if (!m) { m = new Map(); Verified.set(entity.id, m); }
    for (const h of hits) m.set(`${h.x},${h.y},${h.z}`, farClock);
    return hits.length;
}

/** 进入试走：挂 `dm_probe_*`（自带 `on_reach`），撤壳、撤引导，别的走路力全部让位。 */
function probeEnter(entity, kind, target) {
    const k = keyOfTarget(target);
    Probe.set(entity.id, {
        key: k,
        until: farClock + (CONFIG.gather.probeTimeoutRounds || 12),
        kind,
    });
    // ⚠ 两个 `move_to_block`（`dm_guide_*` 和 `dm_probe_*`）不许同时在场 ——
    //    它们各朝一个方块走，就是 2026-11-13 那次"原地抖动、位移 0"。
    setGuide(entity, kind, false);
    // 壳是"追着打"的锚点；试走靠 `move_to_block`，留着壳只会跟它抢方向。
    clearCrack(entity.id);
    Progress.delete(entity.id);
    // "到位自救"那个计数是**上一块**攒的，带进试走会在她还没走到时就把目标判成"放弃"。
    NoProg.delete(entity.id);
    setBusy(entity, false);
    // 试走期间引擎必然锁不到壳（壳被清了），这个账本要是留着旧值，
    // 结束那一轮会被误判成 `lockDead` → 立刻把 `dm_guide_*` 挂回来自相打架。
    LockMiss.delete(entity.id);
    // 上一轮残留的到达标记会让她"一进试走就自认到了"，先摘干净。
    try { if (entity.hasTag(PROBE_HIT_TAG)) entity.removeTag(PROBE_HIT_TAG); } catch (e) { /* 忽略 */ }
    try {
        entity.triggerEvent(kind === "mine" ? "probe_on_mine" : "probe_on_chop");
    } catch (e) {
        logErr("probe_on", e);
        Probe.delete(entity.id);      // 挂不上就别把她卡在"永远不挖"的状态里
        return;
    }
    report(entity, `试走验证 → 先确认 ${k} 走不走得到`);
}

/** 退出试走：摘组、清 tag、把走位还给引擎。 */
function probeLeave(entity, kind) {
    Probe.delete(entity.id);
    try { entity.triggerEvent("probe_off"); } catch (e) { logErr("probe_off", e); }
    setGuide(entity, kind, false);
    LockMiss.delete(entity.id);      // 试走期间的"锁不到"不算数，别带进下一轮
    try { if (entity.hasTag(PROBE_HIT_TAG)) entity.removeTag(PROBE_HIT_TAG); } catch (e) { /* 忽略 */ }
    // `probe_off` 只摘 probe 组；`dm_walk_*` 是 `probe_hit_*` 里加的 —— 超时那条路
    // 那个事件根本没跑过，不在这里补挂她会**彻底没有走路行为**（站着不动）。
    restoreWalkGroup(entity);
}

/** 她到目标方块的水平距离（按方块中心算，和 `withinReach` 同口径）。 */
function dhTo(entity, target) {
    try {
        const loc = entity.location;
        return Math.hypot(loc.x - (target.x + 0.5), loc.z - (target.z + 0.5));
    } catch (e) {
        return 0;                 // 读不到位置 → 当"很近"，不试走，别卡死
    }
}

/*
 * 每轮巡检的试走进度机。
 * @returns {boolean} true = 本轮已由它处理，tickOne 必须让位（别去挖 / 别摆壳）
 */
function probeTick(entity, kind, target, inReach) {
    // 总闸关掉时，把残留的试走组摘干净，走路交还引擎（否则她会一直站着）。
    if (!CONFIG.gather.probeVerify) {
        if (Probe.has(entity.id)) probeLeave(entity, kind);
        return false;
    }
    const rec = Probe.get(entity.id);

    // ① 正在试走
    if (rec) {
        // 到了 —— JSON 的 `on_reach` 已经把 `dm_walk_*` 加回来、并打了 tag
        let hit = false;
        try { hit = entity.hasTag(PROBE_HIT_TAG); } catch (e) { /* 读不到 tag 就当没到 */ }
        if (hit) {
            const n = probeMarkAround(entity, rec.kind);
            probeLeave(entity, rec.kind);
            ScanCache.delete(entity.id);       // 按新数据重挑，别用试走前的缓存
            report(entity, `试走到了 → 身边 ${n} 块记成"可达"`);
            return true;
        }
        // 目标没了 / 已经够得着 → 试走自然成功，交回正常链路
        if (!target || inReach) {
            probeLeave(entity, kind);
            return false;
        }
        // 超时 → 记冷却，这段时间内不再试走这块，改用 `repairReach` 兜底
        if (farClock >= rec.until) {
            let m = ProbeTried.get(entity.id);
            if (!m) { m = new Map(); ProbeTried.set(entity.id, m); }
            m.set(rec.key, farClock + (CONFIG.gather.probeTriedRounds || 200));
            probeLeave(entity, kind);
            ScanCache.delete(entity.id);
            report(entity, `试走超时（${rec.key}）→ 先换目标，之后才垫柱 / 挖走廊`);
            return true;
        }
        // 还在走 → 不许挖、不许摆壳
        clearCrack(entity.id);
        resetLook(entity);
        return true;
    }

    // ② 该不该开一次试走
    if (!target || inReach) return false;
    // 🔴 垫柱保护窗内**不试走**：那几轮的目标是"我专程爬上来敲的这块"，
    //    派她去试走 = 把她从 1×1 的柱顶上拽下来（`dm_guide_*` 有同样的禁令）。
    if (PillarDone.has(entity.id)) return false;
    if (dhTo(entity, target) <= (CONFIG.gather.probeMinDist || 12)) return false;  // 近处不必磨蹭
    if (probeVerified(entity, target)) return false;        // 已验证 → 直接挖
    if (probeTriedRecently(entity, target)) return false;   // 冷却中 → 走 repairReach
    probeEnter(entity, kind, target);
    return true;
}

/*
 * 把「目标在头顶 / 墙后」分派给垫柱或挖走廊。
 * @param {{x,y,z}} target 已选定的那一块（不再重扫）
 */
/*
 * 她到目标之间水平连线上有没有实心方块挡着。只认脚 + 头两层，
 * 树叶不算挡（clearLeavesOnPath 管那个），她摆的光源也不算（SKIP_DIG）。
 * @returns {boolean} true = 路被墙挡住，该直接挖
 */
function pathBlocked(dim, loc, target) {
    const by = Math.floor(loc.y);
    const dx = (target.x + 0.5) - loc.x;
    const dz = (target.z + 0.5) - loc.z;
    const dh = Math.hypot(dx, dz);
    if (dh < 0.9) return false;                 // 已经贴上了，不是"挡"的问题
    const steps = Math.min(8, Math.ceil(dh));
    const ux = dx / dh, uz = dz / dh;
    for (let i = 1; i <= steps; i++) {
        const x = Math.floor(loc.x + ux * i);
        const z = Math.floor(loc.z + uz * i);
        for (const yy of [by, by + 1]) {
            let b;
            try { b = dim.getBlock({ x, y: yy, z }); } catch (e) { continue; }
            if (!b) continue;
            const id = b.typeId;
            if (AIRS.has(id) || LIQUID.has(id)) continue;
            if (LEAVES.has(id)) continue;        // 树叶是"开路"另一条路管
            if (SKIP_DIG.has(id)) continue;      // 她自己摆的光源
            return true;
        }
    }
    return false;
}

/*
 * 悬崖搭桥 —— 目标在同层对岸、中间是空的，就往前方脚下一格补泥土。
 * digStepToward 的入口判据是「前面有没有可拆的方块」，悬崖对岸全是空气 → 它返回 false，
 * repairReach 到此为止，表现为矿在对面墙上、她站在崖边一动不动。
 * 判据（全中才搭）：① 够不到 dh > reach；② 同层 |dv| <= bridgeDy；③ 她踩在实地上；
 * ④ 前方脚下是空气或水；⑤ 前方身体两格是空气（实心那是墙，归 digStepToward）；⑥ 前方脚下
 * 不是岩浆（泥土会被吞掉）。
 * 不摘走位组：桥面放在 by-1，放下去就是平路，引擎的 move_towards_target 自然带她走上去；摘了
 * 反而要自己推冲量，还得跟「同时只许一股走的力」打架。也不用 runInterval（它有全局额度）。
 * 不拆桥：她走过去就踩在上面，拆了等于直接摔进深渊。
 * @returns {boolean} 这一轮有没有真的放下一格
 */
function bridgeToward(entity, kind, target) {
    if (!CONFIG.gather.bridgeEnabled) return false;
    // 刚被放弃的块不为它搭桥（否则"放弃"当场就被这条路径撤销了）
    if (giveUpActive(keyOfTarget(target))) return false;

    let loc, dim;
    try { loc = entity.location; dim = entity.dimension; } catch (e) { return false; }

    const dh = Math.hypot(loc.x - (target.x + 0.5), loc.z - (target.z + 0.5));
    const dv = (target.y + 0.5) - loc.y;

    // ① 够得到 → 交回（走过去敲就行）
    if (dh <= CONFIG.gather.reach) return false;
    // ② 不同层 → 交回（头顶走垫柱、脚下走往下挖）
    if (Math.abs(dv) > (CONFIG.gather.bridgeDy || 1.5)) return false;

    const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);

    // ③ 她必须踩在实地上
    let here;
    try { here = dim.getBlock({ x: bx, y: by - 1, z: bz }); } catch (e) { return false; }
    if (!here) return false;
    if (here.typeId === "minecraft:air" || LIQUID.has(here.typeId)) return false;

    // 主轴只认 4 个正方向（斜着搭会搭出锯齿，她自己反而走不直）
    const dx = (target.x + 0.5) - loc.x;
    const dz = (target.z + 0.5) - loc.z;
    const ax = Math.abs(dx) >= Math.abs(dz) ? (Math.sign(dx) || 1) : 0;
    const az = ax === 0 ? (Math.sign(dz) || 1) : 0;
    const nx = bx + ax, nz = bz + az;

    // ── 账本（必须在下面的"前方脚下"判据之前读：那条要问"这格是不是我自己搭的"）──
    const key = keyOfTarget(target);
    const now = farClock;
    const maxN = Math.max(1, CONFIG.gather.bridgeMax || 24);
    let rec = Bridge.get(entity.id);
    if (!rec || rec.key !== key) {
        rec = { key, n: 0, at: -99999, lx: 0, lz: 0 };
        Bridge.set(entity.id, rec);
    }

    // ④⑤⑥ 前方身体两格 + 前方脚下
    let foot, b0, b1;
    try {
        foot = dim.getBlock({ x: nx, y: by - 1, z: nz });
        b0 = dim.getBlock({ x: nx, y: by, z: nz });
        b1 = dim.getBlock({ x: nx, y: by + 1, z: nz });
    } catch (e) { return false; }
    if (!foot || !b0 || !b1) return false;
    // ⑤ 身体两格有实心 = 墙，不是崖 → 交回挖掘
    if (b0.typeId !== "minecraft:air" || b1.typeId !== "minecraft:air") return false;
    // ⑥ 岩浆上不搭
    if (foot.typeId === "minecraft:lava" || foot.typeId === "minecraft:flowing_lava") return false;
    // ④ 前方脚下必须是空洞（空气/液体）。
    //    🔴 **例外：那格正是我自己上一格搭的桥面时放行** —— 否则搭完第一格，
    //    下一轮（她还没走上去）会把那块泥土当成"正常地面"直接返回 false，
    //    连"等她走上去 / 超时收手"这一段都进不去，账本就永远挂在那儿。
    const isOurDeck = rec.n > 0 && nx === rec.lx && nz === rec.lz;
    if (!isOurDeck && foot.typeId !== "minecraft:air" && !LIQUID.has(foot.typeId)) return false;

    if (rec.n >= maxN) {
        report(entity, `桥搭了 ${rec.n} 格还是够不到 → 换一块`);
        Bridge.delete(entity.id);
        giveUpTarget(entity, kind, target);
        return false;
    }

    // 🔴 她必须站到上一格上，才允许往前再搭一格。
    //    不等的话就是"每 0.5 秒往前丢一格"，5 秒铺十格悬空桥、人还在起点 ——
    //    表现就是"隔空搭桥"。超时说明她没跟上来（被拽住 / 掉下去 / 方向错），
    //    停手交回原链路，让 `digStepToward` 与 `stuckLong` 那套兜底接手。
    if (rec.n > 0 && (bx !== rec.lx || bz !== rec.lz)) {
        const waited = now - rec.at;
        if (waited < (CONFIG.gather.bridgeWaitRounds || 8)) return false;
        whyNot(entity, `搭好一格后 ${waited} 轮没走上去 → 停搭桥（已 ${rec.n}/${maxN} 格）`);
        Bridge.delete(entity.id);
        return false;
    }
    if (now - rec.at < Math.max(0, CONFIG.gather.bridgeStepRounds || 1)) return false;

    // ── 放桥面 ──
    if (!placeBlock(entity, nx, by - 1, nz, "minecraft:dirt")) {
        whyNot(entity, `搭桥放不下泥土 @(${nx},${by - 1},${nz})`);
        return false;
    }
    rec.n++;
    rec.at = now;
    rec.lx = nx; rec.lz = nz;

    // 地形变了 → 下一轮重扫；空闲计时归零（她正在干活，不是闲站着等拆柱）
    Idle.delete(entity.id);
    Why.delete(entity.id);
    ScanCache.delete(entity.id);
    // 🔴 **`Approach` / `NoProg` 一律不清** —— 和 `digStepToward` 里那段同一个教训：
    //    "我放了一格方块"只证明体力上在推进，**不证明离目标更近了**（她完全可能
    //    还没迈步）。清掉这两个计时 → `stuckApproach` 永远攒不满 → 永远不放弃，
    //    最后被 82 格的 `move_to_block` 拽走，那就是 2026-11-15 那次
    //    "砍完高处的树下来后不砍任何树、自顾自走远"。距离由 `approachTrack`
    //    按真实位移判，不靠"我干了活"。

    if (rec.n === 1) {
        report(entity, `悬崖对岸（${dh.toFixed(0)} 格，落差 ${dv.toFixed(1)}）→ 用泥土搭桥过去`);
    }
    log(`搭桥 ${rec.n}/${maxN} 格 → (${nx},${by - 1},${nz})  目标 dh=${dh.toFixed(1)} dv=${dv.toFixed(1)}`);
    return true;
}

function repairReach(entity, kind, target) {    // 刚被放弃的块不再为它垫柱 / 挖穿（否则"放弃"当场就被这条路径撤销了）    if (giveUpActive(keyOfTarget(target))) return false;
    let loc;
    try { loc = entity.location; } catch (e) { return false; }

    const dh = Math.hypot(loc.x - (target.x + 0.5), loc.z - (target.z + 0.5));
    const dv = (target.y + 0.5) - loc.y;          // 正数 = 在她的头顶

    // ① 头顶：只有水平够近才垫（柱子是原地往上垫的，隔 5 格垫了也够不着）
    //    阈值取 `-REACH_DY_MIN`（= 头顶 2.6 格）= 敲击能覆盖的上界。
    //    以前写的是 `REACH_DY_MAX`，数值碰巧一样，但语义是"脚下容差"，改个数字就会错。
    if (dv > -REACH_DY_MIN && dh <= CONFIG.gather.pillarSpread) {
        if (!Pillar.has(entity.id)) {
            report(entity, `目标在头顶 ${dv.toFixed(1)} 格 → 垫柱上去`);
            startPillar(entity, target);
        }
        return true;
    }

    // ② **悬崖对岸：搭桥过去**（2026-11-16 要求）。
    //
    //    必须排在挖掘**前面**：悬崖场景前方根本没有方块可挖（全是空气），
    //    `digStepToward` 会在 `!found` 处直接返回 false —— 那就是"她站在崖边
    //    一动不动"的病灶。反过来，前方是**墙**的时候 `bridgeToward` 会自己
    //    返回 false（身体两格被占），照样走下面的挖掘，两条路不冲突。
    if (bridgeToward(entity, kind, target)) return true;

    // ③ 其余情况一律"现场挖过去"，**没有距离上限**（2026-11-15 
    //    「碰到这种情况直接就破坏沿途方块，一点点挖到够得着为止」）。
    //    以前这里卡着 `dh <= tunnelMaxLen(14)`：目标在 15 格外、中间隔着一道山，
    //    她就一步不挖、干站着面壁 —— 这就是"面壁思过"的主因。
    return digStepToward(entity, kind, target);
}

/*
 * 卡住就拆掉挡在路上的那一格，照 AI 玩家的 RecoverPathProcedure：卡住 → 只做一件事 → 交回导航
 * → 还卡再做下一件，从不「规划一条走廊一次挖通」。
 * ① free 被方块夹住（脚 / 身那格实心）先拆它；② dig 目标在脚下 1 格以上，拆脚下一格让她落下去；
 * ③ tunnel 正前方 1~3 格、脚 + 头两层，拆第一个实心的。
 * 硬约束：一轮只拆一格且间隔 digStepRounds 轮（留时间给她走进去）；NO_DIG 一格不碰，碰上就换
 * 目标；同一块最多拆 digMaxBlocks 格，到量还没够到就拉黑换块（否则一路挖到基岩）。
 * 拆掉的原物按原版产出掉进她包里。
 * @returns {boolean} 这一轮有没有真拆掉东西
 */
function digStepToward(entity, kind, target) {
    let loc, dim;
    try { loc = entity.location; dim = entity.dimension; } catch (e) { return false; }

    const key = keyOfTarget(target);
    const now = farClock;
    let rec = Dig.get(entity.id);
    if (!rec || rec.key !== key) {
        rec = { key, at: -9999, n: 0 };
        Dig.set(entity.id, rec);
    }
    if (rec.n >= (CONFIG.gather.digMaxBlocks || 80)) {
        report(entity, `这条路挖了 ${rec.n} 格还是够不到 → 换一块`);
        Dig.delete(entity.id);
        giveUpTarget(entity, kind, target);
        return false;
    }
    if (now - rec.at < Math.max(1, CONFIG.gather.digStepRounds || 2)) return false;

    const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);
    const dx = (target.x + 0.5) - loc.x;
    const dz = (target.z + 0.5) - loc.z;
    const dvY = (target.y + 0.5) - loc.y;

    // 目标在头顶 2 格以上、水平又超出垫柱范围 → 这是"要她爬崖"。
    // 横着挖只会挖出一个死洞（她爬不上去），宁可交回走位绕路 / 等走近了再垫柱。
    if (dvY >= 2 && Math.hypot(dx, dz) > (CONFIG.gather.pillarSpread || 2.8)) {
        whyNot(entity, `目标在头顶 ${dvY.toFixed(1)} 格且水平 ${Math.hypot(dx, dz).toFixed(1)} 格（爬不上去，等走位）`);
        return false;
    }

    // 只认 4 个正方向：斜着挖会挖出"洞中洞"，她自己反而走不出去
    const ax = Math.abs(dx) >= Math.abs(dz) ? (Math.sign(dx) || 1) : 0;
    const az = ax === 0 ? (Math.sign(dz) || 1) : 0;
    const reach = Math.max(1, Math.round(CONFIG.gather.digReach || 6));
    const burstMax = Math.max(1, Math.round(CONFIG.gather.digBurst || 4));
    // **连续挖掘**（2026-11-15 "首次挖到障碍后还是到不了，立刻再挖一次"）：
    // 一轮巡检里连挖 `digChain` 批，中途够到 / 前面空了 / 到上限就收手，
    // 不必每次挖完都干等 0.5 秒。
    const chain = Math.max(1, Math.round(CONFIG.gather.digChain || 3));
    let total = 0;

    for (let round = 0; round < chain; round++) {
        // 每批现算清单：上一批拆掉后地形已经变了
        const cells = [];
        cells.push([bx, by, bz], [bx, by + 1, bz]);                 // ① free
        if (dvY <= -1) cells.push([bx, by - 1, bz]);                // ② dig
        // ③ tunnel：按 `digReach` 往前铺（默认 6 格）。
        //    原来只铺 3 格 —— 墙厚超过 3 格时前 3 格挖完就"没东西可拆"，返回 false，
        //    她一步不动也不再挖 → 6 秒后放弃 → 看到的"不会挖墙、只会死磕"。
        for (let step = 1; step <= reach; step++) {
            const x = bx + ax * step, z = bz + az * step;
            cells.push([x, by, z], [x, by + 1, z]);
            if (dvY >= 1) cells.push([x, by + 2, z]);
        }

        // 找这一批的第一个可拆格
        let ax0 = 0, ay0 = 0, az0 = 0, aid = "";
        let found = false;
        for (const [x, y, z] of cells) {
            let b;
            try { b = dim.getBlock({ x, y, z }); } catch (e) { continue; }
            if (!b) continue;
            const id = b.typeId;
            if (id === "minecraft:air" || LIQUID.has(id)) continue;
            if (SKIP_DIG.has(id)) continue;         // 她自己摆的光源：不当路障，也不拆
            if (NO_DIG.has(id)) {
                // 面前是基岩 / 箱子这类拆不得的 → 这条路走不通，别原地死磕
                report(entity, `挡路的是 ${id.split(":")[1]}（不可拆）→ 换一块`);
                Dig.delete(entity.id);
                giveUpTarget(entity, kind, target);
                return total > 0;
            }
            ax0 = x; ay0 = y; az0 = z; aid = id; found = true;
            break;
        }
        if (!found) {
            // 前面已经挖空了（人也该走进去了）→ 别空转
            if (total === 0) whyNot(entity, `正前方 1~${reach} 格全是空气/液体，没有可拆的（dh=${Math.hypot(dx, dz).toFixed(1)}）`);
            break;
        }

        if (!breakForPath(entity, { x: ax0, y: ay0, z: az0 }, aid, true)) break;

        // **小范围同类连锁**（2026-11-15 好几秒才挖一块，太慢）：
        // 以这一格为心，把清单里 3×3×3 邻域、**同一种方块**的一起拆掉，
        // 一批最多 `digBurst` 格。她占 2 格高，脚+头本来就得同时开，
        // 所以实际是"一次推进一整格隧道"，不是一格一格磨。
        let broken = 1;
        for (const [x2, y2, z2] of cells) {
            if (broken >= burstMax) break;
            if (x2 === ax0 && y2 === ay0 && z2 === az0) continue;
            if (Math.abs(x2 - ax0) > 1 || Math.abs(y2 - ay0) > 1 || Math.abs(z2 - az0) > 1) continue;
            let b2;
            try { b2 = dim.getBlock({ x: x2, y: y2, z: z2 }); } catch (e) { continue; }
            if (!b2 || b2.typeId !== aid) continue;         // 只连锁同类型，别顺手挖矿/挖箱子
            if (LIQUID.has(b2.typeId)) continue;
            if (!breakForPath(entity, { x: x2, y: y2, z: z2 }, b2.typeId, false)) continue;
            broken++;
        }

        total += broken;
        rec.n += broken;
        // ⚠ 只进控制台，不进聊天栏：卡一次拆一批，聊天栏会被刷屏（`report` 有配额也顶不住）
        log(`自救拆除 ${aid} ×${broken} @ (${ax0},${ay0},${az0}) 第 ${round + 1} 批 计 ${rec.n} 格 → (${target.x},${target.y},${target.z})`);

        // 够到了 / 到上限 → 这一轮收手，剩下的交给走位
        if (withinReach(entity, target, CONFIG.gather.forceReachExtra)) break;
        if (rec.n >= (CONFIG.gather.digMaxBlocks || 80)) break;
    }

    if (!total) return false;
    rec.at = now;
    // 拆掉了 = 体力上在推进，但**到目标的距离没变** —— `Approach` 不能清零。
    // 🔴 清掉它的后果（2026-11-15 "砍完高处的树下来后不砍任何树，自顾自走远"）：
    //    头顶那块够不到的残骸 → `digStepToward` 每轮都拆掉一格地面/墙 →
    //    每轮都把接近计时清零 → 永远攒不满 → 永远不放弃 → 她一直盯着那块残骸，
    //    最后 `lockMiss` 攒满挂上 `dm_guide_*`，被 82 格的 `move_to_block` 拖走。
    //    真正的"接近"由 `approachTrack` 按距离判，不靠"我挖了一格"。
    NoProg.delete(entity.id);
    Why.delete(entity.id);
    ScanCache.delete(entity.id);          // 地形变了 → 下一轮立刻重扫
    PathStuck.delete(entity.id);
    return true;
}

/** 自救时拆一格：置空气 + 掉原物 + 音效碎屑。@returns 是否真的拆掉了
 *  @param {boolean} [visual] 要不要生成"飞向她"的掉落物实体。
 *  每个飞行掉落物都要占一条 `system.runInterval`，而它**有全局上限** ——
 *  自救一轮能拆十几格，全飞就把额度吃光，紧接着的垫柱调度挂不上（见 startPillar）。 */
function breakForPath(entity, c, id, visual) {
    if (SKIP_DIG.has(id) || NO_DIG.has(id)) return false;   // 光源 / 容器 / 基岩一律不碰
    let dim;
    try { dim = entity.dimension; } catch (e) { return false; }
    let b;
    try { b = dim.getBlock(c); } catch (e) { return false; }
    if (!b || b.typeId !== id) return false;
    try { b.setType("minecraft:air"); } catch (e) { return false; }
    // 拆的正好是原木（收尾时拆残骸）→ 这列的自然树结论作废
    if (CHOPS.has(id)) bustTrunkMemo(c.x, c.z);
    try { swingOnce(entity); } catch (e) { /* 动作失败不影响挖 */ }
    try { playDig(entity, { x: c.x, y: c.y, z: c.z, typeId: id }, "mine", !!visual); } catch (e) { /* 音效失败不影响挖 */ }
    try { sprayDebris(entity, c, 6); } catch (e) { /* 同上 */ }
    if (!LEAVES.has(id)) {
        const itemId = TUNNEL_DROP[id] || id;
        try {
            if (visual) popDrop(entity, itemId, 1, c);
            else stashItem(entity, itemId, 1);
        } catch (e) { /* 背包满就算了 */ }
    }
    return true;
}

/*
 * 算一条从她脚下到目标方块的 2 格高走廊，返回要挖的格子（由近到远）。
 * 走线取脚下 → 目标中心的直线（按长度等分取整），沿途每格挖脚 + 头两格（她占 2 格高）；
 * 终点上方那格也挖 —— 矿嵌在墙角时不挖它只有一格缝，打不到矿面。
 * 只返回坐标，挖不挖由调用方按 TUNNEL 白名单决定（原木 / 矿石 / 圆石墙都不在里面）。
 * @returns {Array<{x,y,z}>|null} null = 距离超预算 / 站在原地
 */
function planTunnel(dim, from, target) {
    const x0 = Math.floor(from.x), y0 = Math.floor(from.y), z0 = Math.floor(from.z);
    const dx = target.x - x0, dy = target.y - y0, dz = target.z - z0;
    const len = Math.max(Math.abs(dx), Math.abs(dz), Math.abs(dy));
    if (len < 1 || len > (CONFIG.gather.tunnelMaxLen || 14)) return null;

    const cells = [], seen = new Set();
    const push = (x, y, z) => {
        // 她自己站的那两格绝不进清单：挖掉 = 脚下一空
        if (x === x0 && z === z0 && (y === y0 || y === y0 + 1)) return;
        const k = `${x},${y},${z}`;
        if (seen.has(k)) return;
        seen.add(k);
        cells.push({ x, y, z });
    };

    for (let i = 1; i <= len; i++) {
        const t = i / len;
        const x = Math.round(x0 + dx * t);
        const y = Math.round(y0 + dy * t);
        const z = Math.round(z0 + dz * t);
        push(x, y, z);
        push(x, y + 1, z);
        if (i === len) push(x, y + 2, z);      // 终点上方留一格（矿嵌在墙角时要用）
    }
    return cells;
}

/*
 * 挖穿到目标：算走廊 → 按白名单拆 → 掉原物进她包。
 * 三道节流：同一块最多挖 tunnelTries 次（挖完还够不到说明不是墙的问题）；
 * 两次之间至少隔 tunnelCooldownRounds 轮（留时间走进去）；一条走廊最多拆 tunnelMaxCells 格。
 * @returns {boolean} 这一轮有没有真挖掉东西
 */
function digTunnelTo(entity, target) {
    const key = `${target.x},${target.y},${target.z}`;
    const now = farClock;
    let rec = TunnelCd.get(entity.id);
    if (!rec || rec.key !== key) {
        rec = { key, at: -99999, tries: 0 };
        TunnelCd.set(entity.id, rec);
    }
    if (rec.tries >= (CONFIG.gather.tunnelTries || 2)) return false;
    if (now - rec.at < (CONFIG.gather.tunnelCooldownRounds || 24)) return false;

    let loc, dim;
    try { loc = entity.location; dim = entity.dimension; } catch (e) { return false; }

    const plan = planTunnel(dim, loc, target);
    if (!plan || !plan.length) return false;

    rec.at = now;
    rec.tries++;

    let n = 0;
    let visDrop = Math.max(0, CONFIG.gather.dropVisualPerBatch || 4);
    for (const c of plan) {
        if (n >= (CONFIG.gather.tunnelMaxCells || 64)) break;
        let b;
        try { b = dim.getBlock({ x: c.x, y: c.y, z: c.z }); } catch (e) { continue; }
        if (!b) continue;
        const id = b.typeId;
        if (!TUNNEL.has(id)) continue;              // 原木 / 矿石 / 玩家方块一律不碰

        try { b.setType("minecraft:air"); } catch (e) { continue; }
        playDig(entity, { x: c.x, y: c.y, z: c.z, typeId: id }, "mine", true);
        sprayDebris(entity, { x: c.x, y: c.y, z: c.z }, 3);
        // 🔴 **掉落物实体预算**：一条走廊最多 `tunnelMaxCells`(64) 格。
        //    每格都 `popDrop` = 一帧内开 64 条 `system.runInterval`，
        //    直接把全局额度吃满 → 紧接着的垫柱调度挂不上 → 她卡在柱子上。
        //    超出预算的直接入包，一格不少给，只是没有飞行动画。
        if (visDrop > 0) {
            visDrop--;
            popDrop(entity, TUNNEL_DROP[id] || id, 1, { x: c.x, y: c.y, z: c.z });
        } else {
            stashItem(entity, TUNNEL_DROP[id] || id, 1);
        }
        n++;
    }

    // 一格没拆（走廊全被原木/空气占着）→ 不算一次尝试，也别报信
    if (!n) { rec.tries--; rec.at = -99999; return false; }

    ScanCache.delete(entity.id);       // 地形变了 → 下一轮立刻重扫
    PathStuck.delete(entity.id);
    // 挖穿一条走廊也算"动手了"，但**不清 Approach** —— 见 digStepToward 里那段：
    // 清掉会让"够不到"永远攒不满，她会一直盯着一块到不了的目标。
    report(entity, `矿在墙后 → 挖开 ${n} 格开路`);
    log(`挖穿 ${n} 格 → (${target.x},${target.y},${target.z})`);
    return true;
}

/*
 * 完全没有目标时的补扫（⑤ 分支）：先攒「她到底动没动」，再分两种处理。
 * ⚠ 有目标但够不到不走这里，走 repairReach。
 * 垫柱（全满足才动）：① reach 内没目标 ② 上方 farUp 格里有目标 ③ 垂直差 ≥ 2（差 1 格原版
 * can_jump 自己就跳了）④ 水平距离 ≤ pillarSpread ⑤ 连续 stuckRounds 次位置没动。
 * 挖穿（⑤ 成立但 ③/④ 不成立时才走）：问题不是够不着而是路上堵着，挖掉朝目标那侧脚 + 头两格
 * 的自然岩层 / 树叶，原版产出掉出来，接着成了垫柱的料。两种都不成立就交给原生寻路（原版 A*
 * 比自写寻路强）。
 */
function considerPillar(entity, kind) {
    let loc;
    try { loc = entity.location; } catch (e) { return; }

    const far = farTarget(entity, kind);
    if (far === undefined) return;              // 这轮没扫，别乱清状态

    // ⑤ 先攒够"没在动"的轮数，两种处理共用这一个计数
    if (!stuckLongEnough(entity, loc)) return;

    if (!far) {
        Stuck.delete(entity.id);
        // 排障用：她明明站定不动、近处和高处都没有目标 → 说明是"没有可走的目标"，
        // 而不是被谁钉住。真出问题时这一行能立刻区分这两种情况。
        report(entity, `站定不动，近处/高处都没有目标（y=${loc.y.toFixed(1)}）`);
        return;
    }

    const dh = Math.hypot(loc.x - (far.x + 0.5), loc.z - (far.z + 0.5));
    const dv = (far.y + 0.5) - loc.y;

    Stuck.delete(entity.id);

    if (dv >= 2 && dh <= CONFIG.gather.pillarSpread) {
        report(entity, `垫柱升空（差 ${dv.toFixed(1)} 格，水平 ${dh.toFixed(1)}）`);
        startPillar(entity, far);
        return;
    }

    // 挖矿优先走"走廊"（同层但被岩层挡住，14 格内一次挖 2 格高打通）；
    // 走廊预算外 / 走廊挖了两趟还够不到 → 退化成一格一格拆（`digStepToward`）。
    // 砍树不走走廊（树冠里挖大洞会把她自己埋进空中），直接一格一格来。
    if (kind === "mine" && digTunnelTo(entity, far)) {
        return;
    }
    if (digStepToward(entity, kind, far)) {
        return;
    }
    report(entity, `卡住了但既垫不上去也挖不动（dv=${dv.toFixed(1)} dh=${dh.toFixed(1)}）`);
}

/**
 * ⑤ 的计数：连续 stuckRounds 轮巡检位置几乎没动（水平位移 < 0.4 格）才认卡住。
 * @returns {boolean} 是否已经卡住
 */
function stuckLongEnough(entity, loc) {
    const st = Stuck.get(entity.id);

    if (!st) {
        Stuck.set(entity.id, { x: loc.x, z: loc.z, rounds: 0 });
        return false;
    }

    if (Math.hypot(loc.x - st.x, loc.z - st.z) > 0.4) {
        st.x = loc.x;
        st.z = loc.z;
        st.rounds = 0;                          // 还在动，重新计时
        return false;
    }

    st.rounds++;
    return st.rounds >= CONFIG.gather.stuckRounds;
}


/** 开始垫柱：摘掉 move_to_block（不然导航一直把她往够不到的目标上拽），
 *  然后起一个每 tick 的状态机 —— 巡检间隔 10 tick 太慢，等不到起跳的最高点。 */
function startPillar(entity, far) {
    // 同一块目标最多垫 `pillarTries` 次：垫上去还是敲不到，问题就不在高度了
    // （树冠里被挡住 / 四面被方块包着）。拉黑它，换一块 —— 否则就是
    // 「垫上去 → 掉下来 → 再垫」的无限循环（2026-11-13 实测）。
    const key = keyOfTarget(far);
    const kindNow = jobOf(entity);
    const prevTry = PillarTries.get(entity.id);
    const tries = (prevTry && prevTry.key === key) ? prevTry.n + 1 : 1;
    if (tries > Math.max(1, CONFIG.gather.pillarTries || 3)) {
        PillarTries.delete(entity.id);
        log(`这一块已经垫了 ${tries - 1} 次柱还是敲不到 → 放弃 (${far.x},${far.y},${far.z})`);
        if (kindNow) giveUpTarget(entity, kindNow, far);
        return;
    }
    PillarTries.set(entity.id, { key, n: tries });

    const st = {
        targetY: far.y + 0.5,
        // 记住"我是为哪一块爬上来的"：垫到顶以后 `tickOne` 直接敲它，不等扫描
        key,
        far: { x: far.x, y: far.y, z: far.z },
        levels: 0, fails: 0, timer: 0,
        phase: "start", handle: undefined,
        bx: 0, by: 0, bz: 0,
        born: system.currentTick,      // 看门狗用：状态机卡死时强制收尾
    };
    Pillar.set(entity.id, st);
    PillarDone.delete(entity.id);    // 上一轮的"垫完要敲的那块"作废，别混进来
    Idle.delete(entity.id);          // 垫柱开始 → 空闲计时归零，别一下来就被拆
    NoProg.delete(entity.id);        // "够不到"的计时也归零：这一段是主动在解决
    // 🔴 `gather_walk_off` 会把 `dm_walk_*` **和两个 `dm_guide_*`** 一起摘掉。
    //    `GuideOn` 是"我以为挂着"的账本，不清就会在垫柱结束后出现
    //    "账本说挂着、实体上其实没有" → 引导再也不会上场（她站在树下不走了）。
    GuideOn.delete(entity.id);
    try { entity.triggerEvent("gather_walk_off"); } catch (e) { /* 组没在也无所谓 */ }
    // 🔴 `runInterval` 有数量上限（连锁掉落物就开了二十来条）。挂不上时**必须**
    //    把 `Pillar` 撤掉 —— 留着它就是 `tickOne` ③ 永远 return：她站在柱子上愣住、
    //    不扫描、不选树、不拆柱，而且永不恢复（2026-11-15 已复现）。
    try {
        st.handle = system.runInterval(() => {
            try { tickPillar(entity, st); } catch (e) { logErr("垫柱状态机异常", e); stopPillar(entity, true); }
        }, 1);
    } catch (e) {
        logErr("垫柱启动失败", e);
        st.handle = undefined;
        Pillar.delete(entity.id);
        restoreWalkGroup(entity);
        return;
    }
    log(`开始垫柱 → 目标 y=${far.y}`);
}

/** 垫柱状态机（每 tick） */
function tickPillar(entity, st) {
    let loc, vel;
    try {
        loc = entity.location;
        vel = entity.getVelocity();
    } catch (e) { stopPillar(entity, true); return; }

    st.timer++;

    // 🔴 **看门狗**：垫柱状态机一旦因为任何原因卡住（冲量没生效 / 被方块卡住 /
    //    某个 phase 的 return 条件永远成立），`tickOne` 的 ③ 会**每轮直接 return** ——
    //    她站在柱子上不动、不扫描、不选树、不拆柱，而且不会自愈。
    //    2026-11-15 已知现象："搭方块砍完树后站在柱子上愣住，
    //    下来后也选不中任何树，只会随机漫步"。
    //    超过 `pillarWatchdogTicks`（默认 400 tick = 20 秒）强制收尾。
    if (st.born !== undefined
        && system.currentTick - st.born > (CONFIG.gather.pillarWatchdogTicks || 400)) {
        log(`垫柱看门狗：状态机跑了 ${system.currentTick - st.born} tick 没收尾 → 强制结束`);
        stopPillar(entity, true);
        return;
    }

    if (st.levels >= CONFIG.gather.maxPillar) { stopPillar(entity, true); return; }
    if (st.phase !== "start" && loc.y >= st.targetY - 1.2) { stopPillar(entity, true); return; }

    if (st.phase === "start") {
        // 先把头顶三格挖开：不挖的话她在岩层里起跳，头一顶就被按住
        clearHeadroom(entity);
        st.bx = Math.floor(loc.x);
        st.by = Math.floor(loc.y);
        st.bz = Math.floor(loc.z);
        try { entity.applyImpulse({ x: 0, y: CONFIG.gather.pillarJump, z: 0 }); } catch (e) { }
        st.phase = "lift";
        st.timer = 0;
        return;
    }

    if (st.phase === "lift") {
        // 等过了最高点再放：放早了方块会塞进她身体里把她挤出去
        if (vel.y > 0.02 && st.timer <= 16) return;
        // **她要是根本没离开原格（冲量没顶起来 / 头顶被挡），这一格绝对不放块**：
        // 方块会直接生成在她身体里，把她封死在这一格 —— 表现就是"完全动不了、被钉住"。
        // 顶多等 20 tick，还是没上去就放弃垫柱，把 move_to_block 挂回去。
        if (Math.floor(loc.y) <= st.by) {
            if (st.timer < 20) return;
            stopPillar(entity, true);
            return;
        }
        // 垫块凭空生成（泥土），不消耗她背包里的任何东西。
        // 以前从背包拿方块：包里没料就垫不上去，垫完还要还给她 —— 两头都别扭。
        const id = "minecraft:dirt";
        if (placeBlock(entity, st.bx, st.by, st.bz, id)) {
            const trail = Trail.get(entity.id) || [];
            trail.push({ x: st.bx, y: st.by, z: st.bz, id });
            Trail.set(entity.id, trail);
        }
        st.phase = "settle";
        st.timer = 0;
        return;
    }

    // settle：等她站稳，再垫下一格
    if (st.timer < 3 || Math.abs(vel.y) > 0.08) return;
    if (loc.y <= st.by + 0.35) {
        st.fails++;                              // 没上去（被挡住 / 冲量不够）
        if (st.fails >= 3) { stopPillar(entity, true); return; }
    } else {
        st.fails = 0;
        st.levels++;
    }
    st.phase = "start";
    st.timer = 0;
}

/** 结束垫柱。restoreWalk=true 时**稍后**把走位组挂回去，并给一段缓降。 */
function stopPillar(entity, restoreWalk) {
    const st = Pillar.get(entity.id);
    if (st) {
        if (st.handle !== undefined) { try { system.clearRun(st.handle); } catch (e) { /* 忽略 */ } }
        Pillar.delete(entity.id);
        if (st.levels > 0 && restoreWalk) {
            log(`垫柱结束，升高 ${st.levels} 格`);
            // 🔴 **垫上去了就立刻敲，先别把走位交还引擎**（2026-11-13 第三次故障）：
            //    `gather_walk_*` 里既有 `nearest_attackable_target` 又有
            //    `move_towards_target`(within_radius 2.5)。她站在 1×1 的泥柱顶上，
            //    引擎一锁上裂痕就又开始拽 → 一步踏空就掉下去，那块木头一次都没敲过。
            //    所以这里开一个保护窗：窗内不挂走位组（没人拽她）、不拆柱（站得稳）、
            //    `tickOne` 直接敲 `st.far` 那一块。窗过了 / 敲完了才交还走位组。
            PillarDone.set(entity.id, {
                x: st.far.x, y: st.far.y, z: st.far.z,
                until: farClock + Math.max(4, CONFIG.gather.pillarGraceRounds || 10),
            });
            // 垫完之后图是旧的（垂直跳变还没结算），强制下一轮重扫，别拿旧结论判"没目标"
            ScanCache.delete(entity.id);
            NoProg.delete(entity.id);
            Approach.delete(entity.id);
            Idle.delete(entity.id);
            giveSlowFalling(entity);
            return;              // ← 不在这里挂走位组
        }
    }
    if (!restoreWalk) return;
    restoreWalkGroup(entity);
    giveSlowFalling(entity);
}

/** 短时缓降。用状态效果而不是 slow_falling 组件 —— 组件没有"到时自动摘"的能力
 *  （以前给过 infinite，结果是永久慢落），效果的时长是引擎自己管的。 */
function giveSlowFalling(entity) {
    try { entity.runCommand("effect @s slow_falling 12 0 true"); } catch (e) { /* 忽略 */ }
}

/** 挖掉她头顶（脚所在格 +0/+1/+2）的自然岩层 */
function clearHeadroom(entity) {
    let loc, dim;
    try { loc = entity.location; dim = entity.dimension; } catch (e) { return; }
    const bx = Math.floor(loc.x), by = Math.floor(loc.y), bz = Math.floor(loc.z);

    for (let dy = 2; dy >= 0; dy--) {
        let b;
        try { b = dim.getBlock({ x: bx, y: by + dy, z: bz }); } catch (e) { continue; }
        if (!b || !TUNNEL.has(b.typeId)) continue;
        const id = b.typeId;
        try { b.setType("minecraft:air"); } catch (e) { continue; }
        playDig(entity, { x: bx, y: by + dy, z: bz, typeId: id }, "mine", false);
        sprayDebris(entity, { x: bx, y: by + dy, z: bz }, 3);
        // 挖穿的方块照样掉东西 —— 挖石头出圆石，正好又成了垫块
        popDrop(entity, TUNNEL_DROP[id] || id, 1, { x: bx, y: by + dy, z: bz });
    }
}

/** 往世界里放一块（只接受空气格，绝不覆盖别的方块） */
function placeBlock(entity, x, y, z, id) {
    // 绝不往她自己占据的两格里放块 —— 那等于把她封在方块里，直接卡死（垫柱升空时最容易踩到）
    let b;
    try {
        const l = entity.location;
        if (x === Math.floor(l.x) && z === Math.floor(l.z)) {
            const by = Math.floor(l.y);
            if (y === by || y === by + 1) return false;
        }
    } catch (e) { /* 读不到位置就按原逻辑走 */ }
    try { b = entity.dimension.getBlock({ x, y, z }); } catch (e) { return false; }
    if (!b || b.typeId !== "minecraft:air") return false;
    try { b.setType(id); } catch (e) { return false; }
    return true;
}

/*
 * 拆柱子。泥土是凭空放的，拆掉就消失，不入包也不产出。
 * 她还在柱子上（x/z 同列、脚下正好是柱子）→ 从脚下开始拆，一轮一格顺着一格一格落下来；
 * 已经离开（水平 ≥ 3 格）→ 从最低一格开始清
 */
function collapseTrail(entity) {
    const trail = Trail.get(entity.id);
    if (!trail || !trail.length) { Trail.delete(entity.id); TrailCleanup.delete(entity.id); return; }

    // ★ **任务结束后的强制回收**（2026-11-15 "砍完树 / 挖完矿泥土柱留在那儿不动"）。
    //   这条排在 Progress / Idle 之前：只要这次任务已经收尾，她的柱子就是垃圾。
    //   规则：
    //     ① 她**还站在柱子所在那一列** → 这一列一格不动（拆了就是摔下去），
    //        只有真的闲够 `descendIdleRounds` 轮（收工了）才拆脚下那格，并给缓降；
    //     ② 她已经离开那一列 / 别的列 → 从**最高**一格往下拆（拆上面的绝不让她掉）。
    //   挖矿和砍树共用这一段：`Trail` 本来就不分 job。
    if (TrailCleanup.get(entity.id) !== undefined && !Pillar.has(entity.id)) {
        let l2, d2;
        try { l2 = entity.location; d2 = entity.dimension; } catch (e) { return; }
        const bx2 = Math.floor(l2.x), by2 = Math.floor(l2.y), bz2 = Math.floor(l2.z);
        const idle2 = Idle.get(entity.id) || 0;
        const onCol = trail.some((p) => p.x === bx2 && p.z === bz2);
        // 置位时存的是 farClock。等够 `trailIdleFallbackRounds`（默认 20 轮 = 10 秒）
        // 就**不再等 Idle** —— 她可能一直有目标却永远够不到，Idle 恒 0，
        // 于是一直站在柱子上（2026-11-15 "站柱子上愣住不动，也不拆柱"）。
        const mark = TrailCleanup.get(entity.id);
        const waited = typeof mark === "number" ? farClock - mark : 9999;
        const canDescend = idle2 >= (CONFIG.gather.descendIdleRounds || 4)
            || waited >= (CONFIG.gather.trailIdleFallbackRounds || 20);

        // ① 脚下那格：可以下来了才拆（拆完她落一格，下一轮继续，逐格下来）
        if (canDescend) {
            const i0 = trail.findIndex((p) => p.x === bx2 && p.z === bz2 && p.y === by2 - 1);
            if (i0 >= 0) {
                const q0 = trail[i0];
                let b0;
                try { b0 = d2.getBlock({ x: q0.x, y: q0.y, z: q0.z }); } catch (e) { trail.splice(i0, 1); return; }
                if (!b0 || b0.typeId !== q0.id) { trail.splice(i0, 1); return; }
                giveSlowFalling(entity);                 // 柱顶直接拆会摔，先给缓降
                try { b0.setType("minecraft:air"); } catch (e) { return; }
                trail.splice(i0, 1);
                if (!trail.length) { Trail.delete(entity.id); TrailCleanup.delete(entity.id); }
                return;
            }
        }

        // ② 其余（她不在那一列了，或者别的列）：从高到低，**一轮清一小把**
        //    （拆的都是她不在的那一列，拆多少都不会让她掉）
        let done = 0;
        const burst = Math.max(1, Math.round(CONFIG.gather.trailCollapseBurst || 3));
        while (done < burst && trail.length) {
            let idx2 = -1, hy = -Infinity;
            for (let i = 0; i < trail.length; i++) {
                const p = trail[i];
                if (onCol && p.x === bx2 && p.z === bz2) continue;   // 她脚下这一列整个留着
                if (p.y > hy) { hy = p.y; idx2 = i; }
            }
            if (idx2 < 0) break;
            const q = trail[idx2];
            let bb;
            try { bb = d2.getBlock({ x: q.x, y: q.y, z: q.z }); } catch (e) { trail.splice(idx2, 1); done++; continue; }
            if (!bb || bb.typeId !== q.id) { trail.splice(idx2, 1); done++; continue; }
            try { bb.setType("minecraft:air"); } catch (e) { break; }
            trail.splice(idx2, 1);
            done++;
        }
        if (!trail.length) { Trail.delete(entity.id); TrailCleanup.delete(entity.id); }
        return;
    }

    // 🔴 **她正站在柱子上敲头顶那块 → 这一轮绝对不拆**（2026-11-13 实测
    //    "很高很大的橡树连锁不完、也够不到"）。
    //
    //    拆柱的节拍是**每次巡检（0.5 秒）**，而敲一块原木要 24 tick 起。她刚垫上去、
    //    刚挥第一下，脚下那格泥土就被拆了 → 掉回地面 → `farTarget` 再触发垫柱 →
    //    再拆… 表现就是"在树下反复起跳、永远够不到高处那一截"。
    //
    //    `Progress` 有记录 = 站定 + 有目标 + 已经在敲（三条分支都会 delete，
    //    见 tickOne 的 ④' / `!target` / `moving`）。所以这条只在"正干活"时生效，
    //    砍完一棵树 / 走开 之后照常一轮拆一格落下来。
    if (Progress.has(entity.id)) return;

    // 🔴 **正在垫柱 → 一根都不许拆**（2026-11-13 第二次拆柱事故）。
    //
    //   实测：“搭两格方块后会拆掉地面的方块，然后连拆两个又掉下来，白搭”。
    //   垫柱时 `Progress` 一定是空的（还没够到目标、根本敲不到），所以上一条拦不住；
    //   而 `Pillar` 活着 = 状态机正靠脚下这根柱子往上垫，拆一格就前功尽弃。
    if (Pillar.has(entity.id)) return;

    // 🔴 **刚垫到顶的那个保护窗里也不许拆**（2026-11-13 "垫上去为什么不挖，
    //    然后女仆自己就走下来了"）。垫完的那几轮 `scanTarget` 可能正好在重建中景 /
    //    缓存过期，返回 undefined → `Idle` 数到 4（2 秒）就开始拆柱 → 她一脚踩空
    //    掉回地面，而那块木头一次都没敲过。保护窗内的高度是她**正要用的**。
    const pd = PillarDone.get(entity.id);
    if (pd && farClock < pd.until) return;
    if (pd) PillarDone.delete(entity.id);

    let loc, dim;
    try { loc = entity.location; dim = entity.dimension; } catch (e) { return; }

    const bx = Math.floor(loc.x), bz = Math.floor(loc.z), by = Math.floor(loc.y);
    const idle = Idle.get(entity.id) || 0;

    // ① 脚下的那一格（她正踩着柱子）
    let idx = trail.findIndex((p) => p.x === bx && p.z === bz && p.y === by - 1);

    // 🔴 **踩在自己柱子上时，没"闲够"就不拆。**
    //
    //   刚垫上去那两格，她还在走位 / 找落点 / 准备敲，`Progress` 也是空的
    //   （`moving` 分支和 ④' 分支都会 delete）。这时按老逻辑拆脚下那格，
    //   她立刻掉回地面，再垫、再拆 —— 就是"连拆两个又掉下来"。
    //   只有连续 `descendIdleRounds` 轮真的没目标，才认她收工，开始一格一格降。
    if (idx >= 0 && idle < (CONFIG.gather.descendIdleRounds || 4)) return;

    if (idx < 0) {
        const onColumn = trail.some((p) => p.x === bx && p.z === bz);

        // 还在同一列（下落途中 / 差半格）→ 拆这一列里她下面最高的一格
        // 同样要"闲够"：她在空中那一下（起跳 / 落点）拆了这格，就是直接掉下去。
        if (onColumn && idle >= (CONFIG.gather.descendIdleRounds || 4)) {
            let bestY = -Infinity;
            for (let i = 0; i < trail.length; i++) {
                const p = trail[i];
                if (p.x !== bx || p.z !== bz) continue;
                if (p.y >= by) continue;
                if (p.y > bestY) { bestY = p.y; idx = i; }
            }
        }

        // ② 已经走开：只清水平 ≥ 3 格的，从最低一格开始
        if (idx < 0) {
            let bestY = Infinity;
            for (let i = 0; i < trail.length; i++) {
                const p = trail[i];
                if (Math.hypot(loc.x - (p.x + 0.5), loc.z - (p.z + 0.5)) < 3) continue;
                if (p.y < bestY) { bestY = p.y; idx = i; }
            }
        }
        if (idx < 0) return;
    }

    const p = trail[idx];
    let b;
    try { b = dim.getBlock({ x: p.x, y: p.y, z: p.z }); } catch (e) { trail.splice(idx, 1); return; }
    if (!b || b.typeId !== p.id) { trail.splice(idx, 1); return; }   // 被别人换掉了

    try { b.setType("minecraft:air"); } catch (e) { return; }
    trail.splice(idx, 1);
    if (!trail.length) Trail.delete(entity.id);
}

/*
 * 敲掉一块 + 产出。
 * @param {{x,y,z,typeId}} loc 方块
 * @param {boolean} chain 是否连带推倒整棵树 / 整条矿脉
 */
function breakAt(entity, loc, kind, opts) {
    const dim = entity.dimension;
    let block;
    try { block = dim.getBlock({ x: loc.x, y: loc.y, z: loc.z }); } catch (e) { return; }
    if (!block) return;

    const id = block.typeId;
    const isLeaf = LEAVES.has(id);
    // 树叶只作为"开路"被单独敲掉，不算砍树目标
    if (!(kind === "chop" ? CHOPS.has(id) : MINES.has(id)) && !(kind === "chop" && isLeaf)) return;

    // 先规划连带目标（此时方块还在，邻接关系才准）。
    // 树叶**绝不连锁** —— 一片叶子后面是整片树冠，连锁下去会把她头顶的树林剃秃。
    let link = [];
    if (opts && opts.chain && !isLeaf) link = planChain(dim, loc, kind, entity);

    // 砍树：把这些（含起点）记成一次伐木任务 —— 照 AI 玩家的 `feature.blocks`，
    // 记**精确坐标**而不是包围盒：木桩/悬空残段都在表里，且不会误伤旁边的玩家原木。
    if (kind === "chop" && !isLeaf) {
        const col = analyzeColumn(dim, loc.x, loc.y, loc.z, id, true);
        // 确认是树才记（玩家木屋的一根梁不该换来一张通行证）
        if (link.length || col) {
            const blocks = new Set();
            let yTop = loc.y;
            const put = (x, y, z) => {
                blocks.add(`${x},${y},${z}`);
                if (y > yTop) yTop = y;
            };
            put(loc.x, loc.y, loc.z);
            for (const L of link) put(L.x, L.y, L.z);
            // 起点这一列补全到树根：她常常从树干中段开砍，下面那截也得在表里
            if (col) for (let y = col.rootY; y <= col.topY; y++) put(loc.x, y, loc.z);
            ChopTask.set(entity.id, {
                id, blocks, yTop,
                root: { x: loc.x, y: col ? col.rootY : loc.y, z: loc.z },
                until: farClock + (CONFIG.gather.chopTaskRounds || 1200),
            });
        }
    }

    try {
        block.setType("minecraft:air");
    } catch (e) {
        return;
    }
    // 这一列的"是不是自然树"结论立刻作废（树干被挖断，判据必须重算）
    bustTrunkMemo(loc.x, loc.z);
    // 这一格已经没了 → 缓存的"最近目标"作废，下一轮立刻重新扫，
    // 不然她会对着空气再站一秒（scanEvery 的代价）
    ScanCache.delete(entity.id);

    // 破坏反馈：一声闷响 + 一把碎屑 —— 方块不是"凭空消失"
    playDig(entity, { x: loc.x, y: loc.y, z: loc.z, typeId: id }, kind, true);
    sprayDebris(entity, { x: loc.x, y: loc.y, z: loc.z }, 8);

    // 产出：先真的掉出来再飞进包里（popDrop 内部有"生不出实体就直接入包"的兜底）
    dropOf(entity, kind, loc, id, true);

    if (!link.length) return;

    // ── 一键连锁（照主流连锁采集 Addon 的做法）────────────────────────────
    // 同一 tick 内把整棵 / 整条全清掉，不做分轮推进：玩家的预期是"敲一下就整片没了"，
    // 而不是等一两秒看它一斧一斧往下倒。逐块 popDrop 保证每块都真的有掉落物飞出来。
    //
    // 掉落实体数封顶：48 格的大树如果全刷成 item 实体，同一 tick 会有几十个实体 +
    // 几十条 runInterval，手机端会顿一下。超过上限的那些直接入包（stashItem），
    // 一格都不会少给 —— 只是省掉它们的飞行动画。
    let visual = 1;                  // 首块已经生成过实体了
    let debrisBudget = 3;
    for (const L of link) {
        let b;
        try { b = dim.getBlock({ x: L.x, y: L.y, z: L.z }); } catch (e) { continue; }
        if (!b || b.typeId !== L.typeId) continue;   // 这一 tick 里被别人挖了
        try { b.setType("minecraft:air"); } catch (e) { continue; }

        if (debrisBudget > 0) { debrisBudget--; sprayDebris(entity, L, 2); }
        const canShow = visual < CONFIG.gather.maxDropEntities;
        if (canShow) visual++;
        dropOf(entity, kind, L, L.typeId, canShow);
    }

    // 连锁清掉的每一列也要作废自然树缓存（这一 tick 里树干整根没了）
    const cols = new Set();
    for (const L of link) cols.add(`${L.x},${L.z}`);
    for (const k of cols) {
        const p = k.split(",");
        bustTrunkMemo(Number(p[0]), Number(p[1]));
    }
}

/*
 * 一块方块的产出。visual=true 走「真掉实体 + 飞向她」，false 直接入包。
 * @returns {boolean} true = 生成了实体（调用方用来计数），false = 直接入包
 * 附魔在这里结算：精准采集掉方块本体（钻石矿掉钻石矿），时运按 [1, L+1] 逐块掷
 * （远古残骸不吃时运）。两者互斥，有精准就不看时运
 */
function dropOf(entity, kind, loc, typeId, visual) {
    // 树叶是开路挖的，不产出（原版概率掉树苗/苹果，这里简化成不掉 ——
    // 否则一路开路就能刷出一堆树叶方块塞满包）
    if (LEAVES.has(typeId)) return false;

    const tool = storedGatherTool(entity);

    let itemId, amount;
    if (kind === "chop") {
        itemId = typeId;                     // 原木原地原样产出（斧头的附魔不影响掉木头）
        amount = 1;
    } else if (hasSilkTouch(tool)) {
        itemId = typeId;                     // 精准采集：方块本体
        amount = 1;
    } else {
        const drop = DROPS[typeId];
        if (!drop) return false;
        itemId = drop[0];
        amount = fortuneAmount(drop, typeId, tool);   // 整项传进去：里面要读 min/max/模型
    }
    if (visual === false) {
        stashItem(entity, itemId, amount);
        return false;
    }
    popDrop(entity, itemId, amount, loc);
    return true;
}

/*
 * 规划一次连锁。返回还要继续挖的坐标（不含起点，起点由调用方刚挖掉）。
 * 采矿走 26 邻接同族 BFS；砍树先过自然树判定，再过几何过滤。
 * 判定不过就返回空数组 —— 行为和加连锁之前一模一样，绝不多拆一格。
 * @param {"mine"|"chop"} kind
 */
function planChain(dim, loc, kind, entity) {
    if (!CONFIG.gather.chainEnabled) return [];      // 总开关（关掉 = 老行为）
    let list;
    if (kind === "chop") {
        list = planTree(dim, loc);
    } else {
        list = planOre(dim, loc);
        columnWhy = list.length ? "" : "这条矿脉只有这一块";
    }
    // 排查用：把判定结果直接报到聊天框（CONFIG.gather.reportChain）
    if (entity) {
        if (list.length) report(entity, `连锁采集：还要再拆 ${list.length} 格`);
        else report(entity, `只拆这一块 —— ${columnWhy || "没有可连带的目标"}`);
    }
    return list;
}

/*
 * 矿脉连锁。同类矿石的 26 邻接团块，硬上限 chainOre。
 * 玩家不会用 iron_ore 搭房子（搭房用的是 iron_block），所以不做自然物判定
 */
function planOre(dim, start) {
    const family = ORE_FAMILY[start.typeId];
    if (!family) return [];

    const limit = CONFIG.gather.chainOre;
    const found = [];
    const seen = new Set([`${start.x},${start.y},${start.z}`]);
    const queue = [start];

    while (queue.length && found.length < limit) {
        const cur = queue.shift();
        for (const [dx, dy, dz] of NEIGHBOR26) {
            const x = cur.x + dx, y = cur.y + dy, z = cur.z + dz;
            const k = `${x},${y},${z}`;
            if (seen.has(k)) continue;
            seen.add(k);
            let b;
            try { b = dim.getBlock({ x, y, z }); } catch (e) { continue; }
            if (!b || ORE_FAMILY[b.typeId] !== family) continue;
            found.push({ x, y, z, typeId: b.typeId, kind: "mine" });
            queue.push({ x, y, z });
            if (found.length >= limit) break;
        }
    }
    return found;
}

/*
 * 这块原木算不算一棵自然树的一部分 —— 照搬 AI 玩家插件 TreeFeatureType.computeTree()。
 * 它只有两条链，比之前的四道闸（竖轴 / 扎根 / 截面 ≤4 / 树冠抽样）更简单也更准：
 * ① 向下：一路同种原木，穿过树干最终落到土类方块（SOIL），碰到别的方块就不是树（房梁下面是
 * 屋顶 / 悬空）；② 向上：一路同种原木，穿过树干最终碰到树叶（LEAVES / 下界菌盖），碰到别的
 * 方块就不是树。
 * 两条一起过，误判基本堵死：立桩向上第一格就是空气；墙 / 横梁向下碰到木板或圆石；房顶木垛两头
 * 都不过。与原版仅两处差别：① 加深度上限（原版 while(true)，坏存档会卡死主线程）；② 不再要求
 * pillar_axis（大丛林的横向枝干也是树干，该一起推掉）。
 * @returns {{rootY, topY}|null} 这一列的树干范围，不是树返回 null（原因写进 columnWhy）
 */
function analyzeColumn(dim, x, y, z, id, relaxed) {
    // 🔴 缓存键按**列 + 种类**（x,z,id），**不按方块坐标**。
    //    同一棵树有 6~10 块原木，从任何一块问起，向下到泥土 / 向上到树叶的结果都一样
    //    （rootY / topY 相同）。按 (x,y,z) 缓存等于一棵树重算 8 遍 ——
    //    naturalProbe 8 次就变成 8 × 最多 72 次跨边界 = 576 次，而现在 72 次。
    const ck = `${x},${z},${id},${relaxed ? "R" : "N"}`;
    const hit = ColumnCache.get(ck);
    if (hit !== undefined) return hit;

    // L2：全局共享缓存（跨轮、跨女仆）。命中就直接回填 L1。
    const mk = `${x},${z}`;
    const ttl = Math.max(20, CONFIG.gather.trunkMemoTtl || 240);
    let memo = TrunkMemo.get(mk);
    if (memo && (memo.id !== id || farClock - memo.at > ttl)) memo = undefined;
    if (memo) {
        const mout = relaxed ? memo.r : memo.n;
        if (mout !== undefined) {
            ColumnCache.set(ck, mout);
            return mout;
        }
    }

    let out = null;
    do {
        // ① 向下：一路同种原木 → 必须落到土
        //
        //  🔴 **允许穿过一小段空气**（`trunkGap`，2026-11-13 实测"很高很大的橡树
        //     砍一半就停住、连锁不完、也不垫柱"）。
        //
        //     她是从下往上砍的：砍掉底部几格之后，剩下那截树干必然**悬空**。
        //     老判据"下一格必须是泥土"会让同一个方块突然"不再是树"——
        //       · `planTree` 每格都验不过 → **连锁中断**（日志"还要再拆 12 格"之后没下文）
        //       · `farTarget` 不认高处的树干 → **不触发垫柱** → 站在树下干愣
        //       · `midPick` 还会把 `cell.ok=false` 记一辈子，连候选都消失
        //     日志实拍就是：`扫描 无 | 裂痕 0 | 候选 0 | 中景 27/27区 26块` ——
        //     26 块原木都在图里，一块都选不出来（垂直超限 + 验不过）。
        //
        //     放宽的只是"断口"，不是"悬空"：一路空气到底才碰到土的（玩家把木梁
        //     挑在半空）照样会被 ② 挡掉 —— ② 要求上方有**自然叶**，玩家的梁上没有。
        let ry = y, guard = 0, rooted = false, gap = 0;
        const gapMax = CONFIG.gather.trunkGap ?? 12;
        while (guard++ < 32) {
            let b;
            try { b = dim.getBlock({ x, y: ry, z }); } catch (e) { break; }
            if (!b) break;
            if (SOIL.has(b.typeId)) { rooted = true; break; }
            if (b.typeId === id) { ry--; continue; }
            if (AIRS.has(b.typeId) && gap < gapMax) { gap++; ry--; continue; }
            break;
        }
        if (!rooted) {
            columnWhy = gap > 0
                ? `向下悬空 ${gap} 格还没碰到泥土`
                : "向下走不到泥土（玩家铺的地板 / 圆石）";
            break;
        }

        // ② 向上：一路同种原木 → 必须碰到树叶
        let ty = y, guard2 = 0, leafed = false, stopAt = "";
        while (guard2++ < 40) {
            ty++;
            let b;
            try { b = dim.getBlock({ x, y: ty, z }); } catch (e) { break; }
            if (!b) break;
            if (CAPS.has(b.typeId)) { leafed = true; break; }   // 下界菌盖
            if (LEAVES.has(b.typeId)) {
                // 自然叶（persistent_bit = false）立刻算通过；
                // 玩家用剪刀采下再放回去的叶子是 true —— 不算数，继续往上找。
                // 这一步是 AI 玩家那版没有的加分项：原木柱 + 玩家放的几片叶
                // 冒充的"假树"会被挡掉，而自然树被剪过又放回去的树冠照样通过。
                if (!isPersistentLeaf(b)) { leafed = true; break; }
                continue;
            }
            if (b.typeId !== id) { stopAt = b.typeId; break; }
        }
        // 🔴 `relaxed` = 这列属于**已经确认过的一棵树**（连锁扩张时用）：
        //    只验 ①（向下扎在土里），不要求 ②（向上碰到树叶）。
        //    树干被从下往上砍掉几格后，下方残段向上是空气 → 严格判据当场"不是树"
        //    → 连锁断在这里、木桩再也选不上。2026-11-15 报的"留一截木桩不动"
        //    和"连锁连不完、树冠悬空"都是这一条造成的。
        if (!leafed && !relaxed) {
            columnWhy = stopAt && !AIRS.has(stopAt)
                ? `向上走到 ${stopAt} 就断了（不是树）`
                : "向上是空气（原木柱子 / 房梁，不是树）";
            break;
        }

        out = { rootY: ry, topY: ty };
    } while (false);

    ColumnCache.set(ck, out);

    // 写回全局缓存（同一列的两套判定各占一格）
    if (!memo) {
        memo = { id, at: farClock, n: undefined, r: undefined };
        TrunkMemo.set(mk, memo);
        const cap = Math.max(256, CONFIG.gather.trunkMemoMax || 4096);
        while (TrunkMemo.size > cap) {
            const oldest = TrunkMemo.keys().next();
            if (oldest.done) break;
            TrunkMemo.delete(oldest.value);
        }
    }
    if (relaxed) memo.r = out; else memo.n = out;
    memo.at = farClock;
    return out;
}

/** 这块原木算不算"一棵自然树"的一部分 */
function naturalTrunk(dim, x, y, z, id) {
    return !!analyzeColumn(dim, x, y, z, id);
}

/*
 * 砍树连锁 —— 防「把原木房子当树拆了」的重点。
 * 起点必须先过 analyzeColumn（向下扎根到土、向上追到树叶）；扩张时每一列只验扎根（relaxed）——
 * 高处枝干列向下是十几格空气，严格判据会把整棵大树砍成残骸；不接地也不要紧，
 * 只要落在树冠包围盒（canopy）里就算同株。
 * 于是玩家搭的立桩（向上第一格是空气）、墙与横梁（向下碰到木板 / 圆石）都进不来
 */
function planTree(dim, start) {
    const id = start.typeId;

    // 起点这一列先过"自然树"两条链，不是树就一格都不连锁
    const col0 = analyzeColumn(dim, start.x, start.y, start.z, id);
    if (!col0) {
        log(`连锁跳过：${columnWhy}`);
        return [];
    }

    // **树冠包围盒**：大橡树除了主干还有一堆斜向枝干，它们既不接地（判不出 rooted），
    // 也不在 TRUNK_DIRS 的 6 个方向里 → 原来的 BFS 根本连不过去，砍完主干就留一树零碎。
    // 这里先把树冠框出来，凡是在框内的同种原木都算这棵树的（照 AI 玩家 `planTree`
    // 第三层"不落在树冠包围盒之外即视为同株"）。
    const canopy = canopyBox(dim, start.x, col0.topY, start.z);

    // BFS 用 **26 邻接**：斜向枝干是 45° 长的，6 向永远走不到。
    const limit = CONFIG.gather.maxChain;
    const found = [];
    const seen = new Set([`${start.x},${start.y},${start.z}`]);
    const queue = [start];
    const colCache = new Map();

    while (queue.length && found.length < limit) {
        const cur = queue.shift();
        for (const [dx, dy, dz] of NEIGHBOR26) {
            const x = cur.x + dx, y = cur.y + dy, z = cur.z + dz;
            const k = `${x},${y},${z}`;
            if (seen.has(k)) continue;
            seen.add(k);
            let b;
            try { b = dim.getBlock({ x, y, z }); } catch (e) { continue; }
            if (!b || b.typeId !== id) continue;

            const col = `${x},${z}`;
            let ok = colCache.get(col);
            if (ok === undefined) {
                // 起点已经确认过是自然树了，扩张时只验"扎在土里"（relaxed）——
                // 高处枝干列向下是十几格空气，严格判据会把整棵大树砍成残骸。
                ok = !!analyzeColumn(dim, x, y, z, id, true);
                colCache.set(col, ok);
            }
            // 不接地也不要紧：只要落在树冠包围盒里，就是这棵树的一部分
            if (!ok && !inBox(canopy, x, y, z)) continue;

            found.push({ x, y, z, typeId: id, kind: "chop" });
            queue.push({ x, y, z });
            if (found.length >= limit) break;
        }
    }
    return found;
}

/**
 * 树冠包围盒：以树干顶端为心，用一次批量读扫出所有树叶的包围盒。
 * 读不到树叶（被砍光的残树 / 树冠已经被她自己清掉）返回 null。
 */
function canopyBox(dim, x, topY, z) {
    const R = Math.max(2, CONFIG.gather.canopyRadius || 8);
    const DY = Math.max(2, CONFIG.gather.canopyUp || 8);
    let hits;
    try {
        hits = bulkScanRaw(dim,
            { x: x - R, y: topY - 4, z: z - R },
            { x: x + R, y: topY + DY, z: z + R },
            LEAF_IDS);
    } catch (e) { hits = null; }
    // 批量读不可用 → **放弃树冠包围盒**，退回"只认接地枝干"的老行为。
    // 🔴 不要逐格兜底：17×17×13 = 3757 次 getBlock 全在**一帧内**同步跑完，
    //    表现就是砍下去那一下整个世界顿住（2026-11-15 "无响应"）。
    if (hits === null) return null;
    if (!hits.length) return null;
    let x0 = x, x1 = x, y0 = topY, y1 = topY, z0 = z, z1 = z;
    for (const h of hits) {
        if (h.x < x0) x0 = h.x;
        if (h.x > x1) x1 = h.x;
        if (h.y < y0) y0 = h.y;
        if (h.y > y1) y1 = h.y;
        if (h.z < z0) z0 = h.z;
        if (h.z > z1) z1 = h.z;
    }
    return { x0, x1, y0, y1, z0, z1 };
}

function inBox(box, x, y, z) {
    if (!box) return false;
    return x >= box.x0 - 1 && x <= box.x1 + 1
        && y >= box.y0 - 2 && y <= box.y1 + 2
        && z >= box.z0 - 1 && z <= box.z1 + 1;
}

/**
 * 这片树叶是不是"玩家放的"（persistent_bit = true）。
 * 状态名双保险：`persistent_bit` 是基岩版的名字，`persistent` 是 Java 版。
 * 读不到状态时按自然叶处理（宁可多砍一棵，也不能让整条连锁废掉）。
 */
function isPersistentLeaf(block) {
    for (const name of ["persistent_bit", "persistent"]) {
        try {
            const v = block.permutation.getState(name);
            if (v === true || v === 1) return true;
            if (v === false || v === 0) return false;
        } catch (e) { /* 这个名字不存在，试下一个 */ }
    }
    return false;
}
