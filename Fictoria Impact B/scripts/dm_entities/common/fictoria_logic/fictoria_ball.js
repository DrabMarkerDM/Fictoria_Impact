/*
 * 幻域球回收系统（类宝可梦精灵球）。保存：背包 36 格 + 附魔/名字/耐久（兼容 enchantable /
 * stored_enchantments）。直接掉落：潜影盒、收纳袋、filled_map、书与笔、成书；空地图与附魔书
 * 正常保存。套娃保护：filled 幻域球（含 _cd、带 fictoria:bag_data 的）一律不收回，原地掉落。
 */
import * as Server from "@minecraft/server";

/** 本文件日志开关（只影响 fictoria_ball.js）。排查球的存取/还原时打开 */
const DEBUG_BALL = false;

const {
    world,
    system,
    ItemStack,
    Direction
} = Server;

// 字符串工具
function trimString(value) {
    return typeof value === "string" ? value.trim() : value;
}

function trimArray(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(trimString);
}

function trimArrayToSet(arr) {
    return new Set(trimArray(arr));
}

// ============================================================
// 配置表①：金球可收容干员
// ============================================================
const GOLD_BALL_TYPES = trimArray([
    "player:dm0",
    "player:dm4",
    "player:dm25",
    "player:dm32",
    "player:dm35",
    "player:dm41",
    "player:dm45",
    "player:dm46",
    "player:dm48",
    "player:dm49",
    "player:dm50",
    "player:dm51",
    "player:dm52",
    "player:dm53",
    "player:dm56",
    "player:dm60",
    "player:dm61",
    "player:dm62",
    "player:dm63",
    "player:kirito",
    "player:asuna"
]);

// ============================================================
// 配置表②：蓝球可收容干员
// ============================================================
const BLUE_BALL_TYPES = trimArray([
    "player:dm3",
    "player:dm6",
    "player:dm7",
    "player:dm8",
    "player:dm10",
    "player:dm11",
    "player:dm12",
    "player:dm13",
    "player:dm14",
    "player:dm18",
    "player:dm20",
    "player:dm21",
    "player:dm22",
    "player:dm23",
    "player:dm24",
    "player:dm26",
    "player:dm27",
    "player:dm28",
    "player:dm29",
    "player:dm30",
    "player:dm31",
    "player:dm33",
    "player:dm36",
    "player:dm37",
    "player:dm38",
    "player:dm39",
    "player:dm40",
    "player:dm54",
    "player:dm59"
]);

// ============================================================
// 配置表③：绿球可收容干员
// ============================================================
const GREEN_BALL_TYPES = trimArray([
    "player:dm1",
    "player:dm2",
    "player:dm5",
    "player:dm9",
    "player:dm15",
    "player:dm16",
    "player:dm17",
    "player:dm19",
    "player:dm34",
    "player:dm34_1"
]);

// ============================================================
// 幻域球配置
// ============================================================
const RAW_BALL_TYPES = {
    "items:fictoria_ball_empty_yellow": {
        filledCooling: "items:fictoria_ball_filled_yellow_cd",
        filledReady: "items:fictoria_ball_filled_yellow",
        cd: 25,
        // 死亡回球专用冷却（= 正常值的 3 倍）。与 `cd` 分开存，便于单边调整。
        deathCd: 75,
        allowed: GOLD_BALL_TYPES,
    },
    "items:fictoria_ball_empty_blue": {
        filledCooling: "items:fictoria_ball_filled_blue_cd",
        filledReady: "items:fictoria_ball_filled_blue",
        cd: 15,
        deathCd: 45,
        allowed: BLUE_BALL_TYPES,
    },
    "items:fictoria_ball_empty_green": {
        filledCooling: "items:fictoria_ball_filled_green_cd",
        filledReady: "items:fictoria_ball_filled_green",
        cd: 5,
        deathCd: 15,
        allowed: GREEN_BALL_TYPES,
    },
};

// 规范化 BALL_TYPES，并给每个球配置生成 allowedSet
const BALL_TYPES = {};

for (const [rawEmptyId, rawCfg] of Object.entries(RAW_BALL_TYPES)) {
    const emptyId = trimString(rawEmptyId);

    const cfg = {
        filledCooling: trimString(rawCfg.filledCooling),
        filledReady: trimString(rawCfg.filledReady),
        cd: rawCfg.cd,
        deathCd: rawCfg.deathCd,
        allowed: trimArray(rawCfg.allowed),
    };

    cfg.allowedSet = trimArrayToSet(cfg.allowed);

    BALL_TYPES[emptyId] = cfg;
}

// 反向索引：任意满球 ID → 配置
const FILLED_MAP = {};

// 冷却版满球 → 就绪版满球
const COOLING_TO_READY_MAP = {};

for (const [emptyId, cfg] of Object.entries(BALL_TYPES)) {
    FILLED_MAP[cfg.filledCooling] = {
        emptyId,
        cd: cfg.cd,
        deathCd: cfg.deathCd,
        allowed: cfg.allowed,
        allowedSet: cfg.allowedSet,
    };

    FILLED_MAP[cfg.filledReady] = {
        emptyId,
        cd: cfg.cd,
        deathCd: cfg.deathCd,
        allowed: cfg.allowed,
        allowedSet: cfg.allowedSet,
    };

    COOLING_TO_READY_MAP[cfg.filledCooling] = cfg.filledReady;
}

// 战术 UI 状态键
const UI_DP_KEYS = trimArray([
    "fictoria:ui_mode",
    "fictoria:ui_home",
    "fictoria:ui_home_dim"
]);

const UI_ENTITY_TO_BALL = {
    "fictoria_ui:mode": "fictoria:ui_mode",
    "fictoria_ui:home": "fictoria:ui_home",
    "fictoria_ui:home_dim": "fictoria:ui_home_dim",
};

const UI_BALL_TO_ENTITY = {
    "fictoria:ui_mode": "fictoria_ui:mode",
    "fictoria:ui_home": "fictoria_ui:home",
    "fictoria:ui_home_dim": "fictoria_ui:home_dim",
};

const BAG_DP_KEY = "fictoria:bag_data";
const OWNER_DP_KEY = "ownerId";

// 扩展点：幻域球不认识的装备槽 / 自定义动态属性由使用方注册接管
// （原问题：收回女仆只存 36 格，装备槽与动态属性随 remove() 消失）。
//   capture(maid, ball) 写球属性 / read(ball) 在清属性前读进内存 / apply(maid, data) 还原
// 不注册就完全不影响现有行为。
const BALL_EXTENSIONS = [];

export function registerBallExtension(ext) {
    if (ext !== null && typeof ext === "object" && BALL_EXTENSIONS.indexOf(ext) === -1) {
        BALL_EXTENSIONS.push(ext);
    }
}

const LORE_LINE_LENGTH = 50;
const HIDE_CHAR = "\u00a7z";

const PLACE_CD_KEY = "fictoria:place_cd";

/** 死亡回球那一颗球的标记（布尔）。只用来把「被拦提示」分成两句：
 *  普通收回仍是「幻域球冷却中，剩余 X 秒」，死亡回球才是「幻域球恢复中，还剩 X 秒」。
 *  与 PLACE_CD_KEY 同命：换成就绪球时一起丢掉。 */
const DEATH_CD_KEY = "fictoria:death_cd";
const CD_TEXTURE_SCAN_TICKS = 20;

const REQUIRE_OWNER = false;

// 排除 / 包含列表
// ============================================================
// 排除 / 包含列表
// ============================================================
const EXCLUDE_TYPES = trimArray([
    "player:dm42",
    "player:dm42_1",
    "player:dm43",
    "player:dm44",
    "player:dm47",
    "player:dm55",
    "player:dm57",
    "player:dm58",
    "player:steve",
    "mob:protecter",
    "mob:robot",
    "mob:doctor",
    "mob:mon3tr",
]);

const INCLUDE_TYPES = trimArray([]);

const EXCLUDE_TYPE_SET = trimArrayToSet(EXCLUDE_TYPES);
const INCLUDE_TYPE_SET = trimArrayToSet(INCLUDE_TYPES);

// 特殊物品：收回时不保存，直接原地掉落 —— 潜影盒、收纳袋、filled_map、
// 书与笔、成书。空地图（无内容）与附魔书（要保附魔）正常保存。
const COMPLEX_DROP_TYPE_PATTERNS = [
    "shulker_box",
    "bundle",
    "filled_map"
];

const COMPLEX_DROP_EXACT_TYPES = new Set([
    "minecraft:writable_book",
    "minecraft:written_book"
]);

function isComplexDroppableItem(item) {
    try {
        if (!item || !item.typeId) return false;

        const id = String(item.typeId).toLowerCase();

        // 附魔书强制允许保存。

        // 防止未来某个模糊匹配误伤 enchanted_book。
        if (id.includes("enchanted_book")) {
            return false;
        }

        // 精确匹配记录类书籍
        if (COMPLEX_DROP_EXACT_TYPES.has(id)) {
            return true;
        }

        // 容器类 / 已探索地图模糊匹配
        for (const pattern of COMPLEX_DROP_TYPE_PATTERNS) {
            if (id.includes(pattern)) {
                return true;
            }
        }

        return false;
    } catch (_) {
        return false;
    }
}

// 套娃保护：empty_* 放行；filled_* 与 filled_*_cd 拦截；带 fictoria:bag_data 的也拦截。
function isFilledFictoriaBallTypeId(typeId) {
    try {
        if (!typeId) return false;

        const rawId = String(typeId);
        const trimmedId = rawId.trim();
        const lowerId = trimmedId.toLowerCase();

        if (FILLED_MAP[rawId]) return true;
        if (FILLED_MAP[trimmedId]) return true;

        if (lowerId.includes("fictoria_ball_filled")) {
            return true;
        }

        return false;
    } catch (_) {
        return false;
    }
}

function isFilledFictoriaBall(item) {
    try {
        if (!item || !item.typeId) return false;

        if (isFilledFictoriaBallTypeId(item.typeId)) {
            return true;
        }

        // 兜底：如果某个物品上携带幻域球背包数据，也禁止套娃保存。
        try {
            const bag = item.getDynamicProperty(BAG_DP_KEY);

            if (typeof bag === "string" && bag.length > 0) {
                return true;
            }
        } catch (_) {}

        return false;
    } catch (_) {
        return false;
    }
}

function dropItemEntity(entity, item) {
    try {
        if (!entity || !entity.isValid || !item) return false;

        const dropLocation = {
            x: entity.location.x,
            y: entity.location.y + 0.35,
            z: entity.location.z
        };

        entity.dimension.spawnItem(item, dropLocation);

        return true;
    } catch (_) {
        return false;
    }
}

// 读取物品附魔 → [{ id, level }]，兼容 enchantable / stored_enchantments。
function serializeEnchantments(item) {
    try {
        if (!item || !item.typeId) return undefined;

        let comp = undefined;

        try {
            comp = item.getComponent("minecraft:enchantable");
        } catch (_) {}

        if (!comp) {
            try {
                comp = item.getComponent("minecraft:stored_enchantments");
            } catch (_) {}
        }

        if (!comp) {
            return undefined;
        }

        let enchantments = undefined;

        if (typeof comp.getEnchantments === "function") {
            enchantments = comp.getEnchantments();
        } else if (Array.isArray(comp.enchantments)) {
            enchantments = comp.enchantments;
        } else {
            return undefined;
        }

        if (!Array.isArray(enchantments) || enchantments.length === 0) {
            return undefined;
        }

        const saved = [];

        for (const ench of enchantments) {
            const id =
                ench?.type?.id ??
                (typeof ench?.type === "string" ? ench.type : undefined);

            const level = ench?.level;

            if (id && typeof level === "number") {
                saved.push({
                    id: String(id),
                    level: level
                });
            }
        }

        return saved.length > 0 ? saved : undefined;
    } catch (_) {
        return undefined;
    }
}

/** 附魔 ID → 可写入的附魔类型。兼容 EnchantmentType / MinecraftEnchantmentTypes / 字符串。 */
function getEnchantmentTypeById(id) {
    if (!id) return undefined;

    const rawId = String(id);

    try {
        if (typeof Server.EnchantmentType === "function") {
            try {
                return new Server.EnchantmentType(rawId);
            } catch (_) {}
        }

        const vanillaMap = Server.MinecraftEnchantmentTypes;

        if (vanillaMap) {
            if (vanillaMap[rawId]) {
                return vanillaMap[rawId];
            }

            const bareId = rawId.replace(/^minecraft:/, "");

            if (vanillaMap[bareId]) {
                return vanillaMap[bareId];
            }

            const upperId = bareId.toUpperCase();

            if (vanillaMap[upperId]) {
                return vanillaMap[upperId];
            }
        }
    } catch (_) {}

    // 最后兜底：直接返回字符串，部分 API 可能接受字符串 ID
    return rawId;
}

/** 恢复附魔。多级兼容：enchantable / stored_enchantments / setEnchantments / addEnchantment。 */
function restoreEnchantments(item, savedEnchantments) {
    if (!Array.isArray(savedEnchantments) || savedEnchantments.length === 0) return;

    try {
        let comp = undefined;

        try {
            comp = item.getComponent("minecraft:enchantable");
        } catch (_) {}

        if (!comp) {
            try {
                comp = item.getComponent("minecraft:stored_enchantments");
            } catch (_) {}
        }

        if (!comp) return;

        const enchantList = [];

        for (const saved of savedEnchantments) {
            const type = getEnchantmentTypeById(saved.id);
            const level = Math.max(1, saved.level | 0);

            if (type) {
                enchantList.push({
                    type,
                    level
                });
            }
        }

        if (enchantList.length === 0) return;

        // 方案一：批量设置
        if (typeof comp.setEnchantments === "function") {
            try {
                comp.setEnchantments(enchantList);
                return;
            } catch (_) {}
        }

        // 方案二：逐个添加
        if (typeof comp.addEnchantment === "function") {
            for (const ench of enchantList) {
                try {
                    comp.addEnchantment(ench);
                    continue;
                } catch (_) {}

                try {
                    comp.addEnchantment({
                        type: ench.type?.id ?? ench.type,
                        level: ench.level
                    });
                } catch (_) {}
            }
        }
    } catch (_) {}
}

// 武器状态恢复映射表
//
// 键是 `minecraft:variant`，值是"进这个形态"的实体事件名（**不是组件组名**）。
// 🔴 6 / 7 / 8（挖矿 / 砍树 / 长矛）曾整版漏掉（2026-11-14），放置后直接回到闲置模式。
//    漏了的后果不是"少一个外观"：variant 6/7/8 放出来没人接手 → 她留在 variant 0，
//    而 `dm34:gjob` 又已经跟着球回来了 → 采集态凭空消失、她的镐斧留在记录里没人归还。
const VARIANT_EVENT_MAP = {
    "player:dm34": {
        1: "sword",
        2: "bow",
        3: "crossbow",
        5: "farm",
        6: "gather_mine",
        7: "gather_chop",
        8: "spear_on",
    },
    "player:dm34_1": {
        1: "m4a1",
        2: "moss",
        3: "awp",
        4: "sword",
        5: "glock",
    },
    "player:dm46": {
        0: "attack",
        1: null,
    },
};

// 皮肤恢复映射表
const SKIN_EVENT_MAP = {
    "player:dm34": {
        1: "maid_1",
        2: "maid_2",
        3: "maid_3",
        4: "maid_4",
        5: "maid_5",
        6: "maid_6",
        7: "maid_7",
        8: "maid_8",
        9: "maid_9",
        10: "maid_10",
        11: "maid_11",
        12: "maid_12",
        13: "maid_13",
        14: "maid_14",
        15: "maid_15",
        16: "maid_16",
        17: "maid_17",
        18: "maid_18",
        19: "maid_19",
        20: "maid_20",
    },
    "player:dm34_1": {
        1: "maid_1",
        2: "maid_2",
        3: "maid_3",
        4: "maid_4",
        5: "maid_5",
        6: "maid_6",
        7: "maid_7",
        8: "maid_8",
        9: "maid_9",
        10: "maid_10",
        11: "maid_11",
        12: "maid_12",
        13: "maid_13",
        14: "maid_14",
        15: "maid_15",
        16: "maid_16",
        17: "maid_17",
        18: "maid_18",
        19: "maid_19",
        20: "maid_20",
    },
};

// DynamicProperty 兼容读取
function getDynamicPropertyWithFallback(target, key) {
    try {
        let value = target.getDynamicProperty(key);

        if (value !== undefined) return value;

        value = target.getDynamicProperty(`${key} `);

        return value;
    } catch (_) {
        return undefined;
    }
}

// 动态属性整体克隆：冷却球 → 就绪球必须重建 ItemStack（typeId 只读）。
// 只搬背包和 UI 状态会丢掉 dm34:equip 这类扩展键，表现是收回时记下了剑、
// 球上却没存档、放出来空手。这里按 getDynamicPropertyIds() 全量搬运。
function copyAllDynamicProperties(from, to) {
    if (from === undefined || to === undefined) return { count: 0, extra: [] };

    const builtin = [BAG_DP_KEY, PLACE_CD_KEY, DEATH_CD_KEY, ...UI_DP_KEYS];

    let ids;

    try {
        ids =
            typeof from.getDynamicPropertyIds === "function"
                ? from.getDynamicPropertyIds()
                : undefined;
    } catch (_) {
        ids = undefined;
    }

    if (Array.isArray(ids) === false) {
        // 老引擎没有枚举接口 → 退回已知名单，至少保住背包 + 战术 UI
        console.warn(
            "[FictoriaBall] 无法枚举球的动态属性，扩展存档可能丢失（仅搬运已知键）"
        );

        ids = builtin.slice();
    }

    let count = 0;
    const extra = [];

    for (const id of ids) {
        try {
            // 冷却标记不搬：换球的前提就是冷却已结束，就绪球本来就不带它。
            // 搬过去虽然也只多一次过期比较，但会让"就绪球有没有冷却"变成两种状态。
            // 死亡档标记同理 —— 就绪球不需要知道自己是"怎么回来的"。
            if (id === PLACE_CD_KEY || id === `${PLACE_CD_KEY} `) continue;
            if (id === DEATH_CD_KEY || id === `${DEATH_CD_KEY} `) continue;

            const v = from.getDynamicProperty(id);

            if (v === undefined) continue;

            to.setDynamicProperty(id, v);
            count++;

            if (builtin.indexOf(id) === -1) extra.push(id);
        } catch (_) {}
    }

    return { count, extra };
}

// 字符串压缩工具
const StrHelper = {
    int2str(num) {
        return (
            String.fromCodePoint(0xa000 + Math.floor(num / 0x100)) +
            String.fromCodePoint(0xa000 + (num % 0x100))
        );
    },

    str2int(str) {
        return (
            (str.charCodeAt(0) - 0xa000) * 0x100 +
            (str.charCodeAt(1) - 0xa000)
        );
    },

    short2str(num) {
        return String.fromCodePoint(0xa000 + num);
    },

    str2short(str) {
        return str.charCodeAt(0) - 0xa000;
    },
};

// 隐形 lore 编解码
/** 状态串 → lore。
 *
 *  `noteLines` 是可选的**可见说明行**（玩家悬停时看到），一律排在最前面：
 *  `§z` 是未知格式码、只吞自己那一行，说明行放在隐藏数据之前就不受它影响。
 *  解码侧 `lore2Str()` 只认 `§z` 开头的行，所以说明行不参与解析。
 */
function str2Lore(strPure, noteLines) {
    const lore = [];

    if (Array.isArray(noteLines)) {
        for (const line of noteLines) {
            if (typeof line === "string" && line !== "") lore.push(line);
        }
    }

    let rest = strPure;

    const chunkSize = LORE_LINE_LENGTH - HIDE_CHAR.length;

    while (rest.length > 0) {
        const chunk = rest.length > chunkSize ? rest.slice(0, chunkSize) : rest;
        lore.push(HIDE_CHAR + chunk);
        rest = rest.length > chunkSize ? rest.slice(chunkSize) : "";
    }

    return lore;
}

/** 只留隐藏数据行 —— 冷却球 → 就绪球时用：就绪球不该顶着一句"干员已自行撤回"。 */
function hiddenLoreOf(lore) {
    const out = [];

    for (const line of lore || []) {
        if (typeof line === "string" && line.startsWith(HIDE_CHAR)) out.push(line);
    }

    return out;
}

/** 状态串解码：**只取 §z 开头的隐藏行**。
 *  可见说明行整行跳过 —— 旧写法是"把所有行拼起来再丢 § 对"，那样一句人话就会
 *  被拼进 H/V/K/N 串、把 N 后面的 JSON 尾巴弄坏，放球时直接判"数据损坏"。 */
function lore2Str(lore) {
    let strPure = "";

    for (const raw of lore || []) {
        if (typeof raw !== "string" || !raw.startsWith(HIDE_CHAR)) continue;

        const line = raw.slice(HIDE_CHAR.length);

        for (let i = 0; i < line.length;) {
            if (line[i] === "\u00a7") {
                i += 2;
                continue;
            }

            strPure += line[i];
            i++;
        }
    }

    return strPure;
}

// 玩家主手工具
function getMainHand(player) {
    return player
        .getComponent("minecraft:inventory")
        ?.container
        ?.getItem(player.selectedSlotIndex);
}

function setMainHand(player, item) {
    player
        .getComponent("minecraft:inventory")
        ?.container
        ?.setItem(player.selectedSlotIndex, item);
}

// family 兼容判定
function entityHasFamily(entity, family) {
    if (typeof entity.hasFamily === "function") {
        return entity.hasFamily(family);
    }

    const tf = entity.getComponent("minecraft:type_family");

    if (tf === undefined) return false;

    if (typeof tf.hasTypeFamily === "function") {
        return tf.hasTypeFamily(family);
    }

    if (typeof tf.hasFamily === "function") {
        return tf.hasFamily(family);
    }

    if (typeof tf.getTypeFamilies === "function") {
        return tf.getTypeFamilies().includes(family);
    }

    if (Array.isArray(tf.families)) {
        return tf.families.includes(family);
    }

    return false;
}

// 可回收判定 + 主人校验
function isCapturable(entity) {
    if (EXCLUDE_TYPE_SET.has(entity.typeId)) return false;
    if (INCLUDE_TYPE_SET.has(entity.typeId)) return true;

    if (entity.getDynamicProperty(OWNER_DP_KEY) !== undefined) return true;

    if (!entityHasFamily(entity, "dm")) return false;

    return (
        entity.hasTag("dm_tamed") ||
        entity.hasComponent("minecraft:is_tamed") ||
        entity.hasComponent("minecraft:tameable")
    );
}

function getOwnerId(entity) {
    const dpOwner = entity.getDynamicProperty(OWNER_DP_KEY);

    if (dpOwner !== undefined) return dpOwner;

    const tameable = entity.getComponent("minecraft:tameable");

    if (tameable !== undefined && tameable.tamedToPlayerId !== undefined) {
        return tameable.tamedToPlayerId;
    }

    return undefined;
}

function isOwner(entity, player) {
    const ownerId = getOwnerId(entity);

    if (ownerId !== undefined) return ownerId === player.id;

    return (
        !REQUIRE_OWNER &&
        (
            entity.hasTag("dm_tamed") ||
            entity.hasComponent("minecraft:is_tamed")
        )
    );
}

/**
 * 白名单判断。
 * 支持 Set / Array。
 */
function isAllowedType(allowed, typeId) {
    if (!allowed) return true;

    if (allowed instanceof Set) {
        if (allowed.size === 0) return true;
        return allowed.has(typeId);
    }

    if (Array.isArray(allowed)) {
        if (allowed.length === 0) return true;
        return allowed.includes(typeId);
    }

    return true;
}

// 放置冷却
function isBallPlaceCd(ball) {
    const end = ball.getDynamicProperty(PLACE_CD_KEY);
    return typeof end === "number" && end > Date.now();
}

function getBallPlaceCdRemain(ball) {
    const end = ball.getDynamicProperty(PLACE_CD_KEY);

    if (typeof end !== "number" || end <= Date.now()) return 0;

    return Math.ceil((end - Date.now()) / 1000);
}

function startPlaceCd(ball, cdSeconds) {
    ball.setDynamicProperty(PLACE_CD_KEY, Date.now() + cdSeconds * 1000);
}

/** 这颗冷却球是不是死亡回球带回来的（看动态属性，不看物品文字）。
 *  只用来分措辞：普通收回「幻域球冷却中，剩余 X 秒」/ 死亡回球「幻域球恢复中，还剩 X 秒」。 */
function isDeathCdBall(ball) {
    try {
        return ball.getDynamicProperty(DEATH_CD_KEY) === true;
    } catch (e) {
        return false;
    }
}

// 安全位置计算
function getSafeLocation(dimension, blockLocation, blockFace) {
    const location = {
        x: blockLocation.x,
        y: blockLocation.y,
        z: blockLocation.z,
    };

    switch (blockFace) {
        case Direction.Down:
            location.y--;
            break;
        case Direction.Up:
            location.y++;
            break;
        case Direction.East:
            location.x++;
            break;
        case Direction.West:
            location.x--;
            break;
        case Direction.South:
            location.z++;
            break;
        case Direction.North:
            location.z--;
            break;
        default:
            return undefined;
    }

    // 安全判定：
    // - undefined：区块未加载，保守认为可放置
    // - isAir：空气可放置
    // - isLiquid 且不是岩浆：水中可放置
    // - 岩浆：禁止放置
    const isSafe = (pos) => {
        const b = dimension.getBlock(pos);

        if (b === undefined) return true;

        if (b.isAir) return true;

        if (b.isLiquid) {
            try {
                if (b.typeId && b.typeId.includes("lava")) {
                    return false;
                }
            } catch (_) {}

            return true;
        }

        return false;
    };

    if (!isSafe(location)) return undefined;

    const up = {
        x: location.x,
        y: location.y + 1,
        z: location.z,
    };

    if (!isSafe(up)) {
        const down = {
            x: location.x,
            y: location.y - 1,
            z: location.z,
        };

        return isSafe(down) ? down : undefined;
    }

    return location;
}

// 背包序列化：i 类型 / n 数量 / d 耐久 / name 名称 / e 附魔。
// 特殊物品（潜影盒、收纳袋、filled_map、书与笔、成书）原地掉落不写入；
// filled 幻域球被套娃保护拦截，空幻域球正常保存。
export function readInventory(maid, dropComplexItems = true) {
    const container = maid.getComponent("minecraft:inventory")?.container;

    if (container === undefined) return undefined;

    const slots = [];

    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);

        if (item === undefined) {
            slots.push(null);
            continue;
        }

                // 套娃保护：filled 幻域球不收回，原地掉落（empty_* 不含 filled，自然放行）。
        if (isFilledFictoriaBall(item)) {
            const dropped = dropItemEntity(maid, item);

            try {
                container.setItem(i, undefined);
            } catch (_) {}

            slots.push(null);

            if (!dropped) {
                console.warn(
                    "[FictoriaBall] filled幻域球掉落失败，为防止套娃已强制从背包移除。"
                );
            }

            continue;
        }

        // 特殊物品：不收回，直接原地掉落
        if (dropComplexItems && isComplexDroppableItem(item)) {
            const dropped = dropItemEntity(maid, item);

            if (dropped) {
                try {
                    container.setItem(i, undefined);
                } catch (_) {}

                slots.push(null);
                continue;
            }

            // 如果掉落失败，则继续按普通物品保存，避免物品直接消失。
        }

        const dur = item.getComponent("minecraft:durability");

        const entry = {
            i: item.typeId,
            n: item.amount,
            d: dur !== undefined ? dur.damage : 0,
        };

        // 保存自定义名称
        try {
            if (item.nameTag !== undefined && item.nameTag !== "") {
                entry.name = item.nameTag;
            }
        } catch (_) {}

        // 保存附魔
        const enchantments = serializeEnchantments(item);

        if (enchantments) {
            entry.e = enchantments;
        }

        slots.push(entry);
    }

    return {
        size: container.size,
        slots,
    };
}

/**
 * 纯读背包快照：只为「死亡前抢救」服务，全程**不碰容器**（不 setItem、不 spawnItem）。
 *
 * 与 `readInventory` 的差别：
 *  - 复杂物品（潜影盒 / 收纳袋 / 成书 / 套娃球）**不存**，留给引擎自己掉完整件。
 *    若在这里存成普通条目，放置时 `restoreInventory` 只能还原成空壳。
 *  - filled 幻域球同样跳过（套娃保护，也交给引擎掉）。
 *
 * 为什么需要它：引擎在实体死亡时会先把 `minecraft:inventory` 的内容抛到地上并清空容器，
 * `afterEvents.entityDie`（afterEvent）拿到的已经是空容器 —— 实测 dm26 / dm34 都是
 * "球里没背包、物品掉一地"。所以要在**伤害应用之前**抢一份，且那里是 restricted
 * execution，只能读不能写，`readInventory` 的掉落分支不能用来这儿。
 *
 * @param {import("@minecraft/server").Entity} entity
 * @returns {{size:number, slots:Array<object|null>} | undefined} 容器不可读时返回 undefined
 */
export function readInventoryReadOnly(entity) {
    let container;

    try {
        container = entity.getComponent("minecraft:inventory")?.container;
    } catch (_) {
        return undefined;
    }

    if (container === undefined) return undefined;

    let size = 0;

    try {
        size = container.size;
    } catch (_) {
        return undefined;
    }

    const slots = [];

    for (let i = 0; i < size; i++) {
        let item;

        try {
            item = container.getItem(i);
        } catch (_) {
            item = undefined;
        }

        if (item === undefined) {
            slots.push(null);
            continue;
        }

        // 套娃保护：filled 幻域球不收回（交给引擎掉）
        if (isFilledFictoriaBall(item)) {
            slots.push(null);
            continue;
        }

        // 复杂物品不存（交给引擎掉完整件，避免还原成空壳）
        if (isComplexDroppableItem(item)) {
            slots.push(null);
            continue;
        }

        const entry = { i: item.typeId, n: item.amount, d: 0 };

        try {
            const dur = item.getComponent("minecraft:durability");
            if (dur !== undefined) entry.d = dur.damage;
        } catch (_) {}

        try {
            if (item.nameTag !== undefined && item.nameTag !== "") {
                entry.name = item.nameTag;
            }
        } catch (_) {}

        try {
            const enchantments = serializeEnchantments(item);
            if (enchantments) entry.e = enchantments;
        } catch (_) {}

        slots.push(entry);
    }

    return { size, slots };
}

// 背包反序列化
function restoreInventory(maid, bagData) {
    const container = maid.getComponent("minecraft:inventory")?.container;

    if (container === undefined || bagData === undefined) return;

    const slots = bagData.slots ?? [];

    for (let idx = 0; idx < slots.length; idx++) {
        const data = slots[idx];

        if (data === null || data === undefined) continue;

        // 旧存档套娃保护：老版本可能错误保存过 filled 幻域球，
        // 这里不再把它放回背包，而是作为掉落物丢出来。
        if (isFilledFictoriaBallTypeId(data.i)) {
            try {
                const droppedItem = new ItemStack(data.i, data.n);

                if (typeof data.name === "string" && data.name !== "") {
                    try {
                        droppedItem.nameTag = data.name;
                    } catch (_) {}
                }

                if (Array.isArray(data.e)) {
                    restoreEnchantments(droppedItem, data.e);
                }

                maid.dimension.spawnItem(droppedItem, maid.location);
            } catch (_) {}

            continue;
        }

        try {
            const item = new ItemStack(data.i, data.n);

            // 恢复耐久
            if (data.d > 0) {
                const dur = item.getComponent("minecraft:durability");

                if (dur !== undefined) {
                    dur.damage = data.d;
                }
            }

            // 恢复自定义名称
            if (typeof data.name === "string" && data.name !== "") {
                try {
                    item.nameTag = data.name;
                } catch (_) {}
            }

            // 恢复附魔
            if (Array.isArray(data.e)) {
                restoreEnchantments(item, data.e);
            }

            if (idx < container.size) {
                container.setItem(idx, item);
            } else {
                maid.dimension.spawnItem(item, maid.location);
            }
        } catch (_) {}
    }
}

/** 把一份背包存档原样吐回世界（死亡回球失败时的兜底）。
 *  解码逻辑与 `restoreInventory` 完全一致，只是目标从容器换成掉落物 ——
 *  宁可多掉一次让人捡，也不能因为球没造出来就把背包蒸发掉。
 *  @param {{size:number, slots:(object|null)[]}|undefined} bagData
 *  @param {import("@minecraft/server").Dimension} dimension
 *  @param {{x:number,y:number,z:number}} location
 *  @returns {number} 成功吐回几件
 */
export function spillBag(bagData, dimension, location) {
    if (bagData === undefined || bagData === null || !dimension || !location) return 0;

    const slots = bagData.slots ?? [];
    let n = 0;

    for (const data of slots) {
        if (data === null || data === undefined) continue;

        try {
            const amount = Number.isFinite(data.n) && data.n > 0 ? data.n : 1;
            const item = new ItemStack(data.i, amount);

            if (data.d > 0) {
                const dur = item.getComponent("minecraft:durability");
                if (dur !== undefined) dur.damage = data.d;
            }

            if (typeof data.name === "string" && data.name !== "") {
                try { item.nameTag = data.name; } catch (_) {}
            }

            if (Array.isArray(data.e)) restoreEnchantments(item, data.e);

            dimension.spawnItem(item, location);
            n++;
        } catch (_) { /* 单件失败不影响其余 */ }
    }

    return n;
}

/*
 * 造一颗已装好指定干员的幻域球，不依赖世界里真有那只实体。
 * 球的状态全在 lore 编码串里（H 血量 / V 形态 / K 皮肤 / N 四元组）。主人 id 刻意留空：放置时
 * 由释放者当场驯服，避免存档之间 UUID 失效。血量写 0/0 —— releaseMaid 只在 max > 0 时覆盖，
 * 所以放出来是满血。
 * @param {string} typeId 干员实体 id，必须在该颜色球的 allowed 名单里
 * @param {string} [ownerName] 预填的主人名（仅显示用，不参与权限判定）
 * @returns {import("@minecraft/server").ItemStack | undefined}
 */
export function createMaidBall(typeId, ownerName) {
    const emptyId = Object.keys(BALL_TYPES).find((id) =>
        BALL_TYPES[id].allowedSet.has(typeId)
    );

    if (emptyId === undefined) return undefined;

    const cfg = BALL_TYPES[emptyId];
    const ball = new ItemStack(cfg.filledReady, 1);

    const stateStr =
        `H${StrHelper.int2str(0)}${StrHelper.int2str(0)}` +
        `V${StrHelper.short2str(0)}` +
        `K${StrHelper.short2str(0)}` +
        `N${JSON.stringify(["", String(ownerName ?? ""), "", typeId])}`;

    ball.setLore(str2Lore(stateStr));

    return ball;
}

/** 查这只干员属于哪种球。
 *  三色名单彼此不重叠（60 只去重后全覆盖），所以"符合自己品质"是唯一解，不存在歧义。
 *  @param {string} typeId
 *  @returns {{emptyId:string, filledCooling:string, filledReady:string, cd:number, deathCd:number}|undefined} */
export function ballInfoFor(typeId) {
    if (typeof typeId !== "string" || typeId === "") return undefined;

    for (const emptyId of Object.keys(BALL_TYPES)) {
        const cfg = BALL_TYPES[emptyId];
        if (cfg.allowedSet.has(typeId)) {
            return {
                emptyId,
                filledCooling: cfg.filledCooling,
                filledReady: cfg.filledReady,
                cd: cfg.cd,
                deathCd: cfg.deathCd,
            };
        }
    }

    return undefined;
}

/** 造一颗「死亡回收」用的满球（冷却版）。
 *
 *  血量写 0/0：`releaseMaid` 只在 `max > 0` 时覆盖血量，0/0 放出来是满血；写 0/max 会当场再死。
 *
 *  variant 取 `o.variant`，但只在 `VARIANT_EVENT_MAP` 有映射且该档非 null 时才写
 *  （仅 dm34 / dm34_1 / dm46），其余一律落 0 —— 放球端不会重放的值写进去是假状态。
 *  写 0 会让持剑死亡变成待命态而 `dm34:weapon` 记录仍在，命中 `interact_router`
 *  的反向兜底（`!isWeaponState && hasWeaponRecord` → `returnWeapon`），右键第一下把真剑还掉。
 *
 *  skin 保留：`SKIN_EVENT_MAP` 无映射时触发事件无副作用。
 *
 *  `bagData` 与正常收回同键（`fictoria:bag_data`）同编码，`restoreInventory` 无需改动；
 *  背包链通用，因此覆盖全部 60 只，仅 `dm34:equip` 受 `isMaid` 限定。
 *
 *  @param {string} typeId
 *  @param {{ownerId?:string, ownerName?:string, nameTag?:string, skin?:number, variant?:number,
 *           noCd?:boolean, cdKind?:"death"|"normal", cdOverride?:number,
 *           bagData?:{size:number, slots:(object|null)[]}}} [opt]
 *  @returns {import("@minecraft/server").ItemStack | undefined} */
export function buildFilledBallFor(typeId, opt) {
    const cfg = ballInfoFor(typeId);
    if (cfg === undefined) return undefined;

    const o = opt || {};
    const skin = Number.isFinite(o.skin) && o.skin > 0 ? Math.floor(o.skin) : 0;

    // 形态只在"有事件映射、且该档不是 null"时才写（见上方 variant 说明）。
    const wantVariant = Number.isFinite(o.variant) ? Math.floor(o.variant) : 0;
    const variantMap = VARIANT_EVENT_MAP[typeId];
    const variant =
        (variantMap !== undefined &&
            variantMap[wantVariant] !== undefined &&
            variantMap[wantVariant] !== null)
            ? wantVariant
            : 0;

    const stateStr =
        `H${StrHelper.int2str(0)}${StrHelper.int2str(0)}` +
        `V${StrHelper.short2str(variant)}` +
        `K${StrHelper.short2str(skin)}` +
        `N${JSON.stringify([
            String(o.ownerId ?? ""),
            String(o.ownerName ?? ""),
            String(o.nameTag ?? ""),
            typeId,
        ])}`;

    const ball = new ItemStack(cfg.filledCooling, 1);

    // 球名 = `§r` + 干员自定义名，与 `captureMaid` 一致。冷却球换就绪球时名字会原样搬走，只写这一处。
    if (o.nameTag !== undefined && o.nameTag !== "") {
        ball.nameTag = `§r${o.nameTag}`;
    }

    // 只有死亡回球那颗带可见说明行（正常收回不长这一行）——
    // 说明行不写秒数：球在背包里放久了那句话也不会失真，秒数由 actionbar 播报。
    ball.setLore(str2Lore(
        stateStr,
        o.cdKind === "death" ? [`§c干员已自行撤回`] : undefined
    ));

    // 背包存档：与正常收回完全同键同格式，放置端 restoreInventory 直接吃。
    // 写失败（存档过大 / 引擎拒收）不阻断 —— 退化成人回得来、背包留在死亡点。
    if (o.bagData !== undefined) {
        try {
            ball.setDynamicProperty(BAG_DP_KEY, JSON.stringify(o.bagData));
        } catch (e) { /* 忽略 */ }
    }

    // 冷却键是球上的动态属性（不是定时器）——不写就是"拿到立刻能放"。
    // 两套数：正常收回 `cd`（金 25 / 蓝 15 / 绿 5），死亡回球 `deathCd`（金 75 / 蓝 45 / 绿 15，= 3 倍）。
    // 「死亡惩罚」= 装备与四甲留在死亡点 + 这颗球要等更久，但也不该一声不响就让人当场复活。
    const cdSec = Number.isFinite(o.cdOverride)
        ? o.cdOverride
        : (o.cdKind === "death" && Number.isFinite(cfg.deathCd) ? cfg.deathCd : cfg.cd);

    if (!o.noCd && cdSec > 0) {
        try {
            ball.setDynamicProperty(PLACE_CD_KEY, Date.now() + cdSec * 1000);
        } catch (e) { /* 忽略 */ }
    }

    // 打上"死亡回球"标记：只影响放置被拦时那句提示的措辞（普通收回仍用原句）。
    // 与冷却键同寿命 —— 换成就绪球时由 copyAllDynamicProperties 跳过。
    if (o.cdKind === "death") {
        try {
            ball.setDynamicProperty(DEATH_CD_KEY, true);
        } catch (e) { /* 忽略 */ }
    }

    return ball;
}

// 收回
function captureMaid(player, maid, cfg) {
    try {
        const item = getMainHand(player);

        if (item === undefined || BALL_TYPES[item.typeId] === undefined) return;

        const health = maid.getComponent("minecraft:health");
        const variantComp = maid.getComponent("minecraft:variant");
        const skinComp = maid.getComponent("minecraft:skin_id");

        const ownerId = getOwnerId(maid);

        const curHp = health !== undefined ? health.currentValue : 0;
        const maxHp = health !== undefined ? health.defaultValue : 0;
        const variant = variantComp !== undefined ? variantComp.value : 0;
        const skin = skinComp !== undefined ? skinComp.value : 0;

        const jsonData = JSON.stringify([
            ownerId ?? "",
            player.name,
            maid.nameTag ?? "",
            maid.typeId,
        ]);

        const stateStr =
            `H${StrHelper.int2str(curHp)}${StrHelper.int2str(maxHp)}` +
            `V${StrHelper.short2str(variant)}` +
            `K${StrHelper.short2str(skin)}` +
            `N${jsonData}`;

        const ball = new ItemStack(cfg.filledCooling, 1);

        ball.setLore(str2Lore(stateStr));

                // 先处理背包：readInventory 会把潜影盒 / 收纳袋 / filled_map / 书直接掉落，
                // 空地图和附魔书正常保存，filled 幻域球被套娃保护拦截。
        const bagData = readInventory(maid, true);

        if (bagData !== undefined) {
            ball.setDynamicProperty(BAG_DP_KEY, JSON.stringify(bagData));
        }

        // 扩展点：把背包没覆盖的东西（装备槽 / 自定义动态属性）也存到球上
        for (const ext of BALL_EXTENSIONS) {
            try {
                if (typeof ext.capture === "function") ext.capture(maid, ball);
            } catch (e) {
                console.warn(`[FictoriaBall] 扩展保存失败: ${e}`);
            }
        }

        // 保存战术 UI 状态
        for (const [entityKey, ballKey] of Object.entries(UI_ENTITY_TO_BALL)) {
            const v = getDynamicPropertyWithFallback(maid, entityKey);

            if (v !== undefined) {
                ball.setDynamicProperty(ballKey, v);
            }
        }

        if (maid.nameTag !== undefined && maid.nameTag !== "") {
            ball.nameTag = `§r${maid.nameTag}`;
        }

        try {
            maid.remove();
        } catch (_) {}

        startPlaceCd(ball, cfg.cd);

        setMainHand(player, ball);

        // 回读校验：新建的 ItemStack 写进容器之后，动态属性是否真的落在物品上。
        // 在一次会话里对着同一个 JS 对象读自己永远是"成功"的，
        // 必须从容器重新取一份才算数 —— 否则"收回成功、放置却空手"
        // 这种黑洞还会再来一次（本轮就是栽在这上面）。
        try {
            const back = getMainHand(player);

            if (back === undefined) {
                console.warn("[FictoriaBall] 回读校验：主手取不到刚写进去的球");
            } else if (bagData !== undefined) {
                const backBag = back.getDynamicProperty(BAG_DP_KEY);

                if (typeof backBag !== "string") {
                    console.warn(
                        "[FictoriaBall] 回读校验：球上的动态属性没有落盘（背包存档读不回来）"
                    );
                }
            }
        } catch (_) {}

        player.onScreenDisplay.setActionBar(
            `§a回收成功，§e${cfg.cd}§a 秒后可再次放置`
        );
    } catch (e) {
        console.warn(`[FictoriaBall] 回收失败: ${e}`);
    }
}

// 放置
function releaseMaid(event, emptyId) {
    const player = event.player;
    const dimension = player.dimension;
    const ball = getMainHand(player);

    if (ball === undefined || FILLED_MAP[ball.typeId] === undefined) return;

    if (isBallPlaceCd(ball)) {
        const remain = getBallPlaceCdRemain(ball);
        player.onScreenDisplay.setActionBar(
            isDeathCdBall(ball)
                ? `§c幻域球恢复中，还剩 §e${remain}§c 秒`
                : `§c幻域球冷却中，剩余 §e${remain}§c 秒`
        );
        return;
    }

    const location = getSafeLocation(
        dimension,
        event.block.location,
        event.blockFace
    );

    if (location === undefined) {
        player.onScreenDisplay.setActionBar("§c空间不足，无法放置干员");
        return;
    }

    location.x += 0.5;
    location.z += 0.5;

    const lore = ball.getLore();

    if (lore.length === 0) return;

    const stateStr = lore2Str(lore);

    const hp = {
        cur: 0,
        max: 0,
    };

    const vIdx = stateStr.indexOf("V");
    const kIdx = stateStr.indexOf("K");
    const nIdx = stateStr.indexOf("N");

    if (vIdx === -1 || nIdx === -1) {
        player.onScreenDisplay.setActionBar("§c幻域球数据损坏");
        return;
    }

    hp.cur = StrHelper.str2int(stateStr.slice(1, 3));
    hp.max = StrHelper.str2int(stateStr.slice(3, 5));

    const variant = StrHelper.str2short(stateStr.slice(vIdx + 1, vIdx + 2));
    const skin = StrHelper.str2short(stateStr.slice(kIdx + 1, kIdx + 2));

    let jsonArr;

    try {
        jsonArr = JSON.parse(stateStr.slice(nIdx + 1));
    } catch (_) {
        jsonArr = undefined;
    }

    if (jsonArr === undefined || jsonArr.length < 4) {
        player.onScreenDisplay.setActionBar("§c幻域球数据损坏");
        return;
    }

    const [ownerId, ownerName, maidName, typeId] = jsonArr;

    if (ownerId !== "" && ownerId !== player.id) {
        player.onScreenDisplay.setActionBar("§c你不是该干员的主人");
        return;
    }

    let bagData;

    try {
        const raw = ball.getDynamicProperty(BAG_DP_KEY);

        if (typeof raw === "string") {
            bagData = JSON.parse(raw);
        }
    } catch (_) {
        bagData = undefined;
    }

    // 扩展点：球上的动态属性马上会被 clearDynamicProperties() 清掉，
    // 所以这里先把数据读进内存，等新女仆生成后再 apply。
    const extState = [];

    for (const ext of BALL_EXTENSIONS) {
        try {
            extState.push(typeof ext.read === "function" ? ext.read(ball) : undefined);
        } catch (e) {
            extState.push(undefined);
        }
    }

    let maid;

    try {
        maid = dimension.spawnEntity(typeId, location);
    } catch (_) {
        player.onScreenDisplay.setActionBar(`§c无法生成 ${typeId}`);
        return;
    }

    // 必须在 clearDynamicProperties() 之前读取球上的 UI 状态
    const savedUiState = {};

    for (const [ballKey, entityKey] of Object.entries(UI_BALL_TO_ENTITY)) {
        const v = getDynamicPropertyWithFallback(ball, ballKey);

        if (v !== undefined) {
            savedUiState[entityKey] = v;
        }
    }

    let tameOk = false;

    // ① 驯服
    try {
        const tameable = maid.getComponent("minecraft:tameable");

        if (tameable !== undefined) {
            tameable.tame(player);
            tameOk = true;

            if (maid.typeId === "player:dm34" || maid.typeId === "player:dm34_1") {
                let attempts = 0;
                const maxAttempts = 3;

                const cleanJob = () => {
                    attempts++;

                    let cleaned = false;

                    try {
                        const items = maid.dimension.getEntities({
                            type: "minecraft:item",
                            location: maid.location,
                            maxDistance: 3.0,
                        });

                        for (const itemEntity of items) {
                            const itemStack = itemEntity.getComponent("minecraft:item")?.itemStack;

                            if (itemStack && itemStack.typeId === "item:maid_command") {
                                itemEntity.remove();
                                cleaned = true;
                                break;
                            }
                        }
                    } catch (_) {}

                    if (!cleaned) {
                        cleaned = removePlayerItemStack(player, "item:maid_command", 1);
                    }

                    if (!cleaned && attempts < maxAttempts) {
                        system.runTimeout(cleanJob, 1);
                    }
                };

                system.runTimeout(cleanJob, 1);
            }
        }

        maid.addTag("dm_tamed");

        if (ownerName !== "") {
            maid.setDynamicProperty("fictoria:owner_name", ownerName);
        }

        if (ownerId !== "") {
            maid.setDynamicProperty(OWNER_DP_KEY, ownerId);
        }
    } catch (e) {
        console.warn(`[FictoriaBall] 同tick驯服失败: ${e}`);
    }

    // ② 恢复 HP / 名字
    try {
        if (hp.max > 0) {
            maid.getComponent("minecraft:health")?.setCurrentValue(
                Math.min(hp.cur, hp.max)
            );
        }
    } catch (_) {}

    try {
        if (maidName !== "") {
            maid.nameTag = maidName;
        }
    } catch (_) {}

    // ③ 皮肤
    try {
        const skinMap = SKIN_EVENT_MAP[maid.typeId];

        if (skinMap !== undefined && skinMap[skin] !== undefined) {
            maid.triggerEvent(skinMap[skin]);
        }
    } catch (e) {
        console.warn(`[FictoriaBall] 同tick皮肤失败: ${e}`);
    }

    // ④ 武器
    try {
        const eventMap = VARIANT_EVENT_MAP[maid.typeId];

        if (
            eventMap !== undefined &&
            eventMap[variant] !== undefined &&
            eventMap[variant] !== null
        ) {
            maid.triggerEvent(eventMap[variant]);
        }
    } catch (e) {
        console.warn(`[FictoriaBall] 同tick武器失败: ${e}`);
    }

    // ⑤ 驯服兜底
    if (!tameOk) {
        system.runTimeout(() => {
            try {
                const tameable = maid.getComponent("minecraft:tameable");

                if (tameable !== undefined) {
                    tameable.tame(player);
                }

                maid.addTag("dm_tamed");

                if (ownerName !== "") {
                    maid.setDynamicProperty("fictoria:owner_name", ownerName);
                }

                if (ownerId !== "") {
                    maid.setDynamicProperty(OWNER_DP_KEY, ownerId);
                }
            } catch (_) {}
        }, 2);
    }

    // ⑥ tick 5：重放皮肤 + 武器
    system.runTimeout(() => {
        try {
            const skinMap = SKIN_EVENT_MAP[maid.typeId];

            if (skinMap !== undefined && skinMap[skin] !== undefined) {
                maid.triggerEvent(skinMap[skin]);
            }

            const eventMap = VARIANT_EVENT_MAP[maid.typeId];

            if (
                eventMap !== undefined &&
                eventMap[variant] !== undefined &&
                eventMap[variant] !== null
            ) {
                maid.triggerEvent(eventMap[variant]);
            }
        } catch (e) {
            console.warn(`[FictoriaBall] 状态恢复失败: ${e}`);
        }
    }, 5);

    // ⑦ tick 8：恢复背包 + 战术 UI 状态
    system.runTimeout(() => {
        if (DEBUG_BALL) console.warn(`[FictoriaBall] tick8 进入 | 扩展=${BALL_EXTENSIONS.length}`);

        // 背包还原必须单独兜住：它排在扩展循环之前，一抛（新实体刚 spawn 时
        // getComponent 可能出错）整段回调就中断，扩展 apply 永远不执行。
        try {
            restoreInventory(maid, bagData);
        } catch (e) {
            console.warn(`[FictoriaBall] 背包还原失败（已继续，不取消装备还原）: ${e}`);
        }

        // 扩展点：还原装备槽（主手替身 / 盔甲）与它自己的动态属性
        for (let i = 0; i < BALL_EXTENSIONS.length; i++) {
            const ext = BALL_EXTENSIONS[i];

            if (typeof ext.apply !== "function") continue;

            try {
                ext.apply(maid, extState[i]);
            } catch (e) {
                console.warn(`[FictoriaBall] 扩展还原失败（#${i}）: ${e}`);
            }
        }

        try {
            for (const [entityKey, v] of Object.entries(savedUiState)) {
                maid.setDynamicProperty(entityKey, v);
            }
        } catch (_) {}

        try {
            if (globalThis.FICTORIA_UI_SYNC) {
                globalThis.FICTORIA_UI_SYNC.resumeState(maid);
            }
        } catch (_) {}

        if (DEBUG_BALL) console.warn("[FictoriaBall] tick8 完成");
    }, 8);

    try {
        ball.clearDynamicProperties();
    } catch (_) {}

    setMainHand(player, new ItemStack(emptyId, 1));

    player.onScreenDisplay.setActionBar("§a干员已放置！");
}

// 玩家背包扣除
function removePlayerItemStack(player, itemTypeId, countToRemove = 1) {
    const container = player.getComponent("minecraft:inventory")?.container;

    if (!container) return false;

    let remaining = countToRemove;
    let success = false;

    for (let slot = 0; slot < container.size; slot++) {
        const item = container.getItem(slot);

        if (!item || item.typeId !== itemTypeId) continue;

        if (item.amount > remaining) {
            item.amount -= remaining;
            container.setItem(slot, item);

            remaining = 0;
            success = true;

            break;
        } else {
            remaining -= item.amount;
            container.setItem(slot, undefined);

            success = true;

            if (remaining <= 0) break;
        }
    }

    return success;
}

// 事件注册
export function initFictoriaBall() {
    // 收回
    world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
        const cfg = BALL_TYPES[event.itemStack?.typeId];

        if (cfg === undefined) return;

        const target = event.target;

        if (!isAllowedType(cfg.allowedSet ?? cfg.allowed, target.typeId)) {
            system.run(() => {
                event.player.onScreenDisplay.setActionBar("§c此球无法回收该干员");
            });
            return;
        }

        if (!isCapturable(target)) return;

        if (!isOwner(target, event.player)) {
            system.run(() => {
                event.player.onScreenDisplay.setActionBar("§c这不是你的干员，无法回收");
            });
            return;
        }

        event.cancel = true;

        system.run(() => captureMaid(event.player, target, cfg));
    });

    // 放置
    world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
        const item = event.itemStack;

        if (item === undefined) return;

        const filledCfg = FILLED_MAP[item.typeId];

        if (filledCfg === undefined) return;

        event.cancel = true;

        if (isBallPlaceCd(item)) {
            system.run(() => {
                const remain = getBallPlaceCdRemain(item);
                event.player.onScreenDisplay.setActionBar(
                    isDeathCdBall(item)
                        ? `§c幻域球恢复中，还剩 §e${remain}§c 秒`
                        : `§c幻域球冷却中，剩余 §e${remain}§c 秒`
                );
            });
            return;
        }

        const bid = event.block.typeId;

        const isContainer =
            bid.includes("chest") ||
            bid.includes("barrel") ||
            bid.includes("shulker") ||
            bid.includes("hopper") ||
            bid.includes("dispenser") ||
            bid.includes("dropper") ||
            bid.includes("furnace");

        if (isContainer && !event.player.isSneaking) {
            event.cancel = false;
            return;
        }

        system.run(() => releaseMaid(event, filledCfg.emptyId));
    });

    // 冷却 → 就绪贴图热交换
    system.runInterval(() => {
        const players = world.getAllPlayers();

        if (players.length === 0) return;

        for (const player of players) {
            const container = player.getComponent("minecraft:inventory")?.container;

            if (container === undefined) continue;

            for (let slot = 0; slot < container.size; slot++) {
                const item = container.getItem(slot);

                if (item === undefined) continue;

                const readyId = COOLING_TO_READY_MAP[item.typeId];

                if (readyId === undefined) continue;

                const end = item.getDynamicProperty(PLACE_CD_KEY);

                if (typeof end === "number" && end > Date.now()) continue;

                const ready = new ItemStack(readyId, 1);

                // 只搬隐藏数据行：就绪球再顶着"干员已自行撤回"就是骗人了
                ready.setLore(hiddenLoreOf(item.getLore()));

                if (item.nameTag !== undefined) {
                    ready.nameTag = item.nameTag;
                }

                // 全量搬运动态属性：只搬"背包 + 战术 UI"会静默丢掉扩展存档
                // （dm34:equip = 主手武器 + 四件甲 + 动态属性），收回时日志正常、放置时空手。
                const moved = copyAllDynamicProperties(item, ready);

                if (moved.extra.length > 0) {
                    console.warn(
                        `[FictoriaBall] 冷却球→就绪球：搬运 ${moved.count} 条动态属性` +
                            `（含扩展键 ${moved.extra.join(",")}）`
                    );
                }

                container.setItem(slot, ready);
            }
        }
    }, CD_TEXTURE_SCAN_TICKS);

    console.warn("[FictoriaBall] 幻域球已加载（附魔/特殊物品整合修复版 + 幻域球套娃保护）");
}

// 导出配置
export {
    GOLD_BALL_TYPES,
    BLUE_BALL_TYPES,
    GREEN_BALL_TYPES,
};

// 注册全局配置供 fictoria_ui.js 运行时读取
globalThis.FICTORIA_BALL_TYPES = {
    gold: GOLD_BALL_TYPES,
    blue: BLUE_BALL_TYPES,
    green: GREEN_BALL_TYPES,
};