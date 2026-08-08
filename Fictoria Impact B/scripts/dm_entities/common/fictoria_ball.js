/**
 * 幻域球回收系统（类宝可梦精灵球）— 附魔/特殊物品整合修复版
 * 适配 Fictoria Impact / SAPI 2.7.0
 *
 * 本次整合规则：
 *
 * 1. 空地图 minecraft:empty_map 可以保存。
 * 2. 已探索地图 minecraft:filled_map 无法保存，直接掉落。
 * 3. 潜影盒 / 收纳袋无法保存，直接掉落。
 * 4. 书与笔 writable_book、成书 written_book 稳妥起见掉落。
 * 5. 附魔书 enchanted_book 不再被误判为记录书，会正常保存附魔。
 * 6. 所有附魔物品都会尝试读取并保存附魔。
 * 7. 附魔恢复兼容 enchantable / stored_enchantments。
 */
import * as Server from "@minecraft/server";

const {
    world,
    system,
    ItemStack,
    Direction
} = Server;

// ============================================================
// 字符串工具
// ============================================================
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
        allowed: GOLD_BALL_TYPES,
    },
    "items:fictoria_ball_empty_blue": {
        filledCooling: "items:fictoria_ball_filled_blue_cd",
        filledReady: "items:fictoria_ball_filled_blue",
        cd: 15,
        allowed: BLUE_BALL_TYPES,
    },
    "items:fictoria_ball_empty_green": {
        filledCooling: "items:fictoria_ball_filled_green_cd",
        filledReady: "items:fictoria_ball_filled_green",
        cd: 5,
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
        allowed: cfg.allowed,
        allowedSet: cfg.allowedSet,
    };

    FILLED_MAP[cfg.filledReady] = {
        emptyId,
        cd: cfg.cd,
        allowed: cfg.allowed,
        allowedSet: cfg.allowedSet,
    };

    COOLING_TO_READY_MAP[cfg.filledCooling] = cfg.filledReady;
}

// ============================================================
// 战术 UI 状态键
// ============================================================
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

const LORE_LINE_LENGTH = 50;
const HIDE_CHAR = "\u00a7z";

const PLACE_CD_KEY = "fictoria:place_cd";
const CD_TEXTURE_SCAN_TICKS = 20;

const REQUIRE_OWNER = false;

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

// ============================================================
// 特殊物品：收回时不保存，直接原地掉落
//
// 当前规则：
//
// 1. 容器类：
//    - shulker_box：潜影盒
//    - bundle：收纳袋
//
// 2. 地图类：
//    - filled_map：已探索地图，带地图内容，无法安全重建，掉落
//    - empty_map：空地图，没有地图内容，可以保存
//
// 3. 记录类书籍：
//    - writable_book：书与笔
//    - written_book：成书
//
// 4. 附魔书：
//    - enchanted_book：不掉落，正常保存附魔
//
// 如果你连普通书 minecraft:book 也想稳妥掉落，
// 可以把 "minecraft:book" 加入 COMPLEX_DROP_EXACT_TYPES。
// 但这样会导致通过指令附魔的普通书也无法保存附魔。
// ============================================================
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

        // ============================================================
        // 附魔书强制允许保存。
        //
        // 防止未来某个模糊匹配误伤 enchanted_book。
        // ============================================================
        if (id.includes("enchanted_book")) {
            return false;
        }

        // ============================================================
        // 精确匹配记录类书籍
        // ============================================================
        if (COMPLEX_DROP_EXACT_TYPES.has(id)) {
            return true;
        }

        // ============================================================
        // 容器类 / 已探索地图模糊匹配
        // ============================================================
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

// ============================================================
// 附魔序列化
//
// 读取物品附魔。
//
// 返回格式：
// [
//   { id: "minecraft:sharpness", level: 5 },
//   ...
// ]
//
// 兼容：
// - minecraft:enchantable
// - minecraft:stored_enchantments
// ============================================================
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

/**
 * 尝试根据附魔 ID 获取可写入的附魔类型。
 *
 * 兼容：
 * - EnchantmentType 构造器
 * - MinecraftEnchantmentTypes 枚举
 * - 直接字符串 ID
 */
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

/**
 * 恢复附魔。
 *
 * 由于不同版本 SAPI 附魔接口细节可能不同，这里做多级兼容。
 *
 * 兼容：
 * - minecraft:enchantable
 * - minecraft:stored_enchantments
 * - setEnchantments
 * - addEnchantment
 */
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

// ============================================================
// 武器状态恢复映射表
// ============================================================
const VARIANT_EVENT_MAP = {
    "player:dm34": {
        1: "sword",
        2: "bow",
        3: "crossbow",
        5: "farm",
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

// ============================================================
// 皮肤恢复映射表
// ============================================================
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

// ============================================================
// DynamicProperty 兼容读取
// ============================================================
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

// ============================================================
// 字符串压缩工具
// ============================================================
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

// ============================================================
// 隐形 lore 编解码
// ============================================================
function str2Lore(strPure) {
    const lore = [];
    let rest = strPure;

    const chunkSize = LORE_LINE_LENGTH - HIDE_CHAR.length;

    while (rest.length > 0) {
        const chunk = rest.length > chunkSize ? rest.slice(0, chunkSize) : rest;
        lore.push(HIDE_CHAR + chunk);
        rest = rest.length > chunkSize ? rest.slice(chunkSize) : "";
    }

    return lore;
}

function lore2Str(lore) {
    let strLore = "";

    for (const line of lore) {
        strLore += line;
    }

    let strPure = "";

    for (let i = 0; i < strLore.length;) {
        if (strLore[i] === "\u00a7") {
            i += 2;
            continue;
        }

        strPure += strLore[i];
        i++;
    }

    return strPure;
}

// ============================================================
// 玩家主手工具
// ============================================================
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

// ============================================================
// family 兼容判定
// ============================================================
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

// ============================================================
// 可回收判定 + 主人校验
// ============================================================
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

// ============================================================
// 放置冷却
// ============================================================
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

// ============================================================
// 安全位置计算
// ============================================================
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

    // ============================================================
    // 安全判定：
    // - undefined：区块未加载，保守认为可放置
    // - isAir：空气可放置
    // - isLiquid 且不是岩浆：水中可放置
    // - 岩浆：禁止放置
    // ============================================================
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

// ============================================================
// 背包序列化
//
// 保存：
// - i：物品类型
// - n：数量
// - d：耐久
// - name：自定义名称
// - e：附魔列表
//
// 特殊物品：
// - 潜影盒 / 收纳袋 / filled_map / writable_book / written_book
// - 直接 spawnItem 掉落在原地，不写入幻域球
//
// 附魔物品：
// - enchanted_book
// - 附魔装备
// - 附魔工具
// - 其他可读取附魔的物品
// 都会尝试保存附魔。
// ============================================================
function readInventory(maid, dropComplexItems = true) {
    const container = maid.getComponent("minecraft:inventory")?.container;

    if (container === undefined) return undefined;

    const slots = [];

    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);

        if (item === undefined) {
            slots.push(null);
            continue;
        }

        // ============================================================
        // 特殊物品：不收回，直接原地掉落
        // ============================================================
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

// ============================================================
// 背包反序列化
// ============================================================
function restoreInventory(maid, bagData) {
    const container = maid.getComponent("minecraft:inventory")?.container;

    if (container === undefined || bagData === undefined) return;

    const slots = bagData.slots ?? [];

    for (let idx = 0; idx < slots.length; idx++) {
        const data = slots[idx];

        if (data === null || data === undefined) continue;

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

// ============================================================
// 收回
// ============================================================
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

        // ============================================================
        // 重要：先处理背包。
        //
        // readInventory(maid, true) 会把：
        // - 潜影盒
        // - 收纳袋
        // - filled_map
        // - writable_book
        // - written_book
        //
        // 直接掉落。
        //
        // empty_map 和 enchanted_book 会正常保存。
        // ============================================================
        const bagData = readInventory(maid, true);

        if (bagData !== undefined) {
            ball.setDynamicProperty(BAG_DP_KEY, JSON.stringify(bagData));
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

        player.onScreenDisplay.setActionBar(
            `§a回收成功，§e${cfg.cd}§a 秒后可再次放置`
        );
    } catch (e) {
        console.warn(`[FictoriaBall] 回收失败: ${e}`);
    }
}

// ============================================================
// 放置
// ============================================================
function releaseMaid(event, emptyId) {
    const player = event.player;
    const dimension = player.dimension;
    const ball = getMainHand(player);

    if (ball === undefined || FILLED_MAP[ball.typeId] === undefined) return;

    if (isBallPlaceCd(ball)) {
        player.onScreenDisplay.setActionBar(
            `§c幻域球冷却中，剩余 §e${getBallPlaceCdRemain(ball)}§c 秒`
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
        restoreInventory(maid, bagData);

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
    }, 8);

    try {
        ball.clearDynamicProperties();
    } catch (_) {}

    setMainHand(player, new ItemStack(emptyId, 1));

    player.onScreenDisplay.setActionBar("§a干员已放置！");
}

// ============================================================
// 玩家背包扣除
// ============================================================
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

// ============================================================
// 事件注册
// ============================================================
export function initFictoriaBall() {
    // ============================================================
    // 收回
    // ============================================================
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

    // ============================================================
    // 放置
    // ============================================================
    world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
        const item = event.itemStack;

        if (item === undefined) return;

        const filledCfg = FILLED_MAP[item.typeId];

        if (filledCfg === undefined) return;

        event.cancel = true;

        if (isBallPlaceCd(item)) {
            system.run(() => {
                event.player.onScreenDisplay.setActionBar(
                    `§c幻域球冷却中，剩余 §e${getBallPlaceCdRemain(item)}§c 秒`
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

    // ============================================================
    // 冷却 → 就绪贴图热交换
    // ============================================================
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

                ready.setLore(item.getLore());

                if (item.nameTag !== undefined) {
                    ready.nameTag = item.nameTag;
                }

                const bag = item.getDynamicProperty(BAG_DP_KEY);

                if (typeof bag === "string") {
                    ready.setDynamicProperty(BAG_DP_KEY, bag);
                }

                // 保留战术 UI 状态
                for (const uiKey of UI_DP_KEYS) {
                    const uiVal = getDynamicPropertyWithFallback(item, uiKey);

                    if (uiVal !== undefined) {
                        ready.setDynamicProperty(uiKey, uiVal);
                    }
                }

                container.setItem(slot, ready);
            }
        }
    }, CD_TEXTURE_SCAN_TICKS);

    console.warn("[FictoriaBall] 幻域球已加载（附魔/特殊物品整合修复版）");
}

// ============================================================
// 导出配置
// ============================================================
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