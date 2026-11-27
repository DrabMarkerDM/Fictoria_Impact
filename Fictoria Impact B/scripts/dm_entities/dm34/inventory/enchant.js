/*
 * enchant.js — 工具附魔 / 品质 → 采掘参数（dm34 采集态专用）。纯计算，不碰世界。
 * 输入是 gather_store / farm_store 存下的记录（`{id, n, name, lore, ench:[[附魔id, 等级]], dmg}`），
 * 输出是「敲几下」「掉几件」。不在 JSON 里靠 `minecraft:break_blocks` 让引擎结算：那条路拿不到
 * 掉落的归属与时机，引擎也不会替算效率/时运/精准采集，只能在这里按原版公式补。
 * 公式取 wiki 基岩版（Mining / Enchanting，与 Java 版一致）：效率 L → 挖掘速度 = 工具基础
 * 速度 + L² + 1（L > 0 时）；时运 L → 矿类产出 ×[1, L+1] 均匀随机倍数；精准 → 掉方块本体。
 * 两条照抄原版的例外：时运对远古残骸无效；精准与时运互斥（有精准就跳过时运）。
 */

/** 工具材质 → 原版挖掘速度（wiki：木 2 / 石 4 / 铜 5 / 铁 6 / 金 12 / 钻石 8 / 下界合金 9） */
const TOOL_SPEED = {
    wooden: 2,
    stone: 4,
    copper: 5,
    iron: 6,
    golden: 12,
    diamond: 8,
    netherite: 9,
};

/** 基准速度 = 铁质。gather.js 的 HARDNESS 表是按"拿对工具、铁级"折算出来的，
 *  所以铁镐敲同一块 = 原表 tick 数，木镐 ×3，钻石镐 ×0.75，钻石+效率 V ×0.18。 */
const REF_SPEED = 6;

/** 敲击时长的下限（tick）。低于这个数她还来不及挥完手方块就没了，看着像"空气挖矿" */
const MIN_TICKS = 4;

/** 时运无效的方块（远古残骸） */
const NO_FORTUNE = new Set(["minecraft:ancient_debris"]);

/** 附魔 id 归一：去掉命名空间、转小写。
 *  `Enchantment.type.id` 在不同版本里给过 "efficiency" 和 "minecraft:efficiency" 两种，
 *  同一个包里也可能混着，所以两边都认。 */
function normId(id) {
    if (typeof id !== "string" || !id) return "";
    const s = id.toLowerCase();
    const i = s.indexOf(":");
    return i >= 0 ? s.slice(i + 1) : s;
}

/** 记录里的某一级附魔。record 可以是 undefined（没记录 / 空手） */
export function enchLevelOf(record, enchantId) {
    if (!record || !Array.isArray(record.ench)) return 0;
    const want = normId(enchantId);
    for (const pair of record.ench) {
        if (!Array.isArray(pair)) continue;
        if (normId(pair[0]) !== want) continue;
        const lvl = Number(pair[1]);
        if (Number.isFinite(lvl) && lvl > 0) return Math.floor(lvl);
    }
    return 0;
}

/** 工具 id → 基础挖掘速度。读不出来按基准速度（铁）算，宁可慢一点也别算快。 */
export function toolSpeedOf(itemId) {
    if (typeof itemId !== "string" || !itemId) return REF_SPEED;
    const s = itemId.toLowerCase();
    for (const key of Object.keys(TOOL_SPEED)) {
        if (s.indexOf(`${key}_`) >= 0) return TOOL_SPEED[key];
    }
    return REF_SPEED;
}

/** 记录 → 实际挖掘速度（含效率附魔） */
export function digSpeedOf(record) {
    const base = toolSpeedOf(record && record.id);
    const eff = enchLevelOf(record, "efficiency");
    return eff > 0 ? base + eff * eff + 1 : base;
}

/*
 * 一块方块要敲多久（tick）。
 * @param {number} baseTicks 铁级、拿对工具时的 tick 数（gather.js 的 HARDNESS 表）
 * @param {object} [record] gather_store 存下的工具记录
 */
export function ticksWithTool(baseTicks, record) {
    const base = Number(baseTicks);
    if (!Number.isFinite(base) || base <= 0) return MIN_TICKS;

    const speed = digSpeedOf(record);
    if (speed <= 0) return Math.max(MIN_TICKS, Math.round(base));

    const ticks = Math.round((base * REF_SPEED) / speed);
    return Math.max(MIN_TICKS, ticks);
}

/** 有没有精准采集 */
export function hasSilkTouch(record) {
    return enchLevelOf(record, "silk_touch") > 0;
}

/** 时运等级（远古残骸上按 0 处理） */
export function fortuneLevelOf(record, blockId) {
    if (blockId && NO_FORTUNE.has(blockId)) return 0;
    return enchLevelOf(record, "fortune");
}

/*
 * 一次产出的数量（时运已结算）。按 wiki《Fortune》分两种模型，不是「×[1, L+1] 均匀倍率」。
 * 倍率型（多数矿石：煤/铁/金/铜/青金石/钻石/绿宝石/下界石英/下界金）：`2/(2+L)` 概率不加成，
 * 其余概率下掉落数在 `2 .. L+1` 等概率取值、乘在基础上。L=1 → 1.33×；L=2 → 1.75×；
 * L=3 → 2.2×（不是 2.5×）。多掉落矿石（铜 2-5、青金石 4-9、下界金 2-6）是「先随机基础、再乘
 * 系数」，所以表里写 `[id, min, max]` 而非固定数。
 * 离散均匀型（红石 4-5、荧石、西瓜…）：每级把上限 +1，不倍乘 —— 红石 III = 4-8，不是 4-16。
 * 明确不吃时运（wiki 里不在表内）：石头 / 圆石 / 深板岩 / 黏土 / 远古残骸；前四个本来也不进
 * `DROPS`，远古残骸由 `NO_FORTUNE` 挡掉。
 * @param {[string, number, number?, string?]} drop `DROPS` 表项 `[物品id, 最小数量, 最大数量?, 模型?]`，
 * 模型省略 = 倍率型｜@param {string} blockId 方块 id（判远古残骸 / 时运无效项）
 * @param {object} [record] 工具记录
 */
export function fortuneAmount(drop, blockId, record) {
    const arr = Array.isArray(drop) ? drop : [drop, 1];
    const min = Math.max(1, Math.floor(Number(arr[1]) || 1));
    const max = Math.max(min, Math.floor(Number(arr[2]) || min));
    const model = arr[3] || "mult";

    const rollBase = () => min + Math.floor(Math.random() * (max - min + 1));
    const lvl = fortuneLevelOf(record, blockId);
    if (lvl <= 0) return rollBase();

    if (model === "uniform") {
        // 离散均匀：每级上限 +1（红石 4-5 → 时运 III 4-8）
        const hi = max + lvl;
        return min + Math.floor(Math.random() * (hi - min + 1));
    }

    // 倍率型：2/(2+L) 概率不加成，其余在 2..L+1 等概率
    if (Math.random() < 2 / (2 + lvl)) return rollBase();
    const k = 2 + Math.floor(Math.random() * lvl);      // 2 .. L+1
    return rollBase() * k;
}
