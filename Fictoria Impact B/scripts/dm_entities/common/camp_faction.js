// ============================================================
// 阵营真相源（DM Engine 双向阵营）
//
//   dm    阵营：自我标识 = dm     敌人集合 = monster
//   demon 阵营：自我标识 = demon  敌人集合 = player
//
// 两者互斥（实测 205 个实体，无一同时带 dm 与 demon）。
// 「dm 必带 player」「demon 必带 monster」是单向契约，反向不成立：
// 真人玩家也带 player，普通怪物也带 monster。
// 所以 player / monster 只能用来描述「敌人集合」，
// 永远不能用来判断「我是谁」。
//
// ⚠ 性能约定（详见《DM Engine 双向阵营架构方案》6.1）
//   1. matches() 的 filter 必须是模块级常量。写在调用点上的
//      matches({ families: ["dm"] }) 每次执行都会分配一个对象 +
//      一个数组，在每 tick 的路径上是纯 GC 负担。
//   2. faction 从 ManagedUnits 的 entry 缓存读，不要在热路径上反复
//      调 factionOf——它内部走 matches()，比 hasTag 贵一个数量级。
//      只有拿不到 entry 的地方（受击处理器里的 victim）才现场算。
//
// 本模块不 import @minecraft/server，只用传入的实体对象，
// 便于脱离运行时做单元测试。
// ============================================================

export const FACTION = {
    DM: "dm",
    DEMON: "demon",

    // 真人玩家、中立生物、以及系统实体（摔落伤害、箭矢等）
    NEUTRAL: null
};

// ============================================================
// 自我标识：只认 dm / demon 这两个专属家族
// ============================================================
const DM_FILTER = { families: ["dm"] };
const DEMON_FILTER = { families: ["demon"] };

// 弹药与音效过滤：demon 家族 40 个里有 14 个不是战斗单位
// （13 个 bullet:* + 1 个 mob:bomb_roar），它们不带 monster 家族。
// 这个常量给 rebuildManagedUnits 用，避免每周期给它们解析配置。
const MONSTER_FILTER = { families: ["monster"] };

// ============================================================
// 敌人集合：模块级常量数组 + 预建的 filter 对象
//
// 注意 families 是 AND 语义（"match all of the specified families"），
// 一个数组里塞多个家族不是 OR。这里每边只有一个家族，正好。
// ============================================================
const DM_ENEMY_FAMILIES = ["monster"];   // demon 必带 monster，天然包含
const DEMON_ENEMY_FAMILIES = ["player"]; // dm 必带 player，天然包含全部干员

const DM_ENEMY_FILTER = { families: DM_ENEMY_FAMILIES };
const DEMON_ENEMY_FILTER = { families: DEMON_ENEMY_FAMILIES };

// ============================================================
// 战斗态 tag 契约（JSON ↔ JS）
//
// JSON 层负责增删，JS 层只读。命名规则统一为
//   ${faction}_has_target  —— 正在索敌
//   ${faction}_skill_on    —— 技能态
//
// 两个阵营各用各的 tag，不共用：
// 同一实体不会同时挂两套，所以实体身上的 tag 总数与改造前一致。
// tag 名长度对 hasTag 的开销无影响（哈希查找，只在命中时结算一次）。
//
// 当前 demon 侧这两个 tag 在 JSON 里的出现次数为 0，
// 属于「留着的位置」：JS 侧先按契约读，JSON 侧什么时候加，什么时候生效。
// ============================================================
export const COMBAT_TAGS = {
    [FACTION.DM]: { target: "dm_has_target", skill: "dm_skill_on" },
    [FACTION.DEMON]: { target: "demon_has_target", skill: "demon_skill_on" }
};

// ============================================================
// 阵营判定
//
// 判定顺序：先 dm 后 demon。两者互斥，顺序理论上无关，
// 但 dm 的实体数量（157）远多于 demon（40），
// 先判 dm 能让绝大多数调用在第一次 matches 就命中返回。
// ============================================================
export function factionOf(entity) {
    if (!entity) return FACTION.NEUTRAL;

    try {
        if (!entity.isValid) return FACTION.NEUTRAL;
        if (entity.matches(DM_FILTER)) return FACTION.DM;
        if (entity.matches(DEMON_FILTER)) return FACTION.DEMON;
    } catch (_) {
        // InvalidEntityError / 实体已移除：当作中立，不参与任何阵营判断
    }

    return FACTION.NEUTRAL;
}

export function enemyFamiliesOf(faction) {
    if (faction === FACTION.DM) return DM_ENEMY_FAMILIES;
    if (faction === FACTION.DEMON) return DEMON_ENEMY_FAMILIES;
    return null;
}

// 给 getEntities / 快照查询用的 filter（不要自己再写字面量）
export function enemyFilterOf(faction) {
    if (faction === FACTION.DM) return DM_ENEMY_FILTER;
    if (faction === FACTION.DEMON) return DEMON_ENEMY_FILTER;
    return null;
}

// demon 家族里只有带 monster 的才是战斗单位（26 个），
// 弹药 / 吼叫音效（14 个）不带，直接挡在配置解析之前。
export function isCombatCapable(entity) {
    if (!entity) return false;
    try {
        if (!entity.isValid) return false;
        return entity.matches(MONSTER_FILTER);
    } catch (_) {
        return false;
    }
}

// ============================================================
// 战斗态读取
//
// tag 名一律从 COMBAT_TAGS 取常量，禁止在热路径上拼字符串
// `${faction}_has_target`——那会每个调用分配一个新字符串。
// ============================================================
export function targetTagOf(faction) {
    const entry = COMBAT_TAGS[faction];
    return entry ? entry.target : null;
}

export function skillTagOf(faction) {
    const entry = COMBAT_TAGS[faction];
    return entry ? entry.skill : null;
}

export function hasTargetTag(unit, faction) {
    const tag = targetTagOf(faction);
    if (!tag || !unit) return false;
    try {
        return unit.hasTag(tag);
    } catch (_) {
        return false;
    }
}

export function hasSkillTag(unit, faction) {
    const tag = skillTagOf(faction);
    if (!tag || !unit) return false;
    try {
        return unit.hasTag(tag);
    } catch (_) {
        return false;
    }
}

// 战斗态 = 有索敌 tag 或 在技能态。
// 战术时钟的主轨闸门需要把两个 tag 分开取（语义不同），
// 所以不要把它当成 hasTargetTag 的替代品用在时钟里。
export function isInCombat(unit, faction) {
    return hasTargetTag(unit, faction) || hasSkillTag(unit, faction);
}

// ============================================================
// 友敌关系
//
// 同阵营 = 友。NEUTRAL（真人玩家、中立生物）不参与判定：
// 既不算友，也不算「同阵营敌人」。
//
// 这取代了 movement_melee.js 原来的三层判断
// （typeId 以 player: 开头 → 友 / families:["dm"] → 友 / 白名单 → 友）。
// 前缀法必须废掉：demon 用 demon: 前缀，将来 demon 侧引入召唤物时
// 可能不叫 demon: 但带 demon 家族，前缀会误判。
// ============================================================
export function isAlly(a, b) {
    const fa = factionOf(a);
    if (fa === FACTION.NEUTRAL) return false;
    return fa === factionOf(b);
}

export function isHostile(a, b) {
    const fa = factionOf(a);
    if (fa === FACTION.NEUTRAL || !b) return false;

    const filter = enemyFilterOf(fa);
    if (!filter) return false;

    try {
        if (!b.isValid) return false;
        return b.matches(filter);
    } catch (_) {
        return false;
    }
}
