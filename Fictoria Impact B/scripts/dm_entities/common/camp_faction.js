// camp_faction.js — 阵营真相源（双向阵营）。
//   dm    ：自我标识 dm    ，敌人 monster
//   demon ：自我标识 demon ，敌人 player
// 两者互斥。「dm 必带 player」是单向契约，player/monster 只能描述敌人集合，
// 不能用来判断「我是谁」。

// 性能：matches() 的 filter 必须是模块级常量（每次调用新建对象 = GC 负担）；
// faction 优先从 ManagedUnits 的 entry 缓存读，热路径别反复调 factionOf。

export const FACTION = {
    DM: "dm",
    DEMON: "demon",

    // 真人玩家、中立生物、以及系统实体（摔落伤害、箭矢等）
    NEUTRAL: null
};

// 自我标识：只认 dm / demon 两个专属家族
const DM_FILTER = { families: ["dm"] };
const DEMON_FILTER = { families: ["demon"] };

// 弹药与音效过滤：demon 家族 40 个里 14 个不是战斗单位（bullet:* / bomb_roar），不带 monster。
const MONSTER_FILTER = { families: ["monster"] };

// 敌人集合：模块级常量 + 预建 filter。families 是 AND 语义，一个数组塞多个家族不是 OR。
const DM_ENEMY_FAMILIES = ["monster"];   // demon 必带 monster，天然包含
const DEMON_ENEMY_FAMILIES = ["player"]; // dm 必带 player，天然包含全部干员

const DM_ENEMY_FILTER = { families: DM_ENEMY_FAMILIES };
const DEMON_ENEMY_FILTER = { families: DEMON_ENEMY_FAMILIES };

// 战斗态 tag 契约（JSON 增删，JS 只读）：${faction}_has_target / ${faction}_skill_on，两阵营各用各的。
export const COMBAT_TAGS = {
    [FACTION.DM]: { target: "dm_has_target", skill: "dm_skill_on" },
    [FACTION.DEMON]: { target: "demon_has_target", skill: "demon_skill_on" }
};

// 阵营判定：先 dm 后 demon（两者互斥，但 dm 实体多，先判能在第一次 matches 命中）。
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

// 战斗态读取：tag 名从 COMBAT_TAGS 取，热路径上别拼字符串。
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

// 战斗态 = 有索敌 tag 或在技能态。
export function isInCombat(unit, faction) {
    return hasTargetTag(unit, faction) || hasSkillTag(unit, faction);
}

// 友敌关系：同阵营 = 友，NEUTRAL 不参与判定。
// 取代原来的三层前缀判断（前缀法在 demon 侧引入召唤物时会误判）。
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
