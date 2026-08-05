/**
 * ============================================================
 *  幻域球回收系统（类宝可梦精灵球）— 适配 Fictoria Impact
 *  SAPI 2.7.0
 * ============================================================
 *  功能：
 *    1.【收回】手持「空球」右键已驯服的 dm 干员 → 封印进物品
 *       · 状态存 lore（压缩字符串，20行×50字符限制内）
 *       · 背包物品存 ItemStack 动态属性（不落地，随物品保存）
 *    2.【放置】手持「满球」对方块右键 → 按原类型生成并恢复状态
 *       · 恢复：主人/HP/名字/武器variant/skin/背包
 *       · 【方案B】同 tick 立即恢复，消除随机皮肤闪烁
 *    3.【武器状态】按 typeId + variant 查表触发对应事件恢复
 *    4.【主人校验】全部在 JS 里做（读项目已存的 ownerId 动态属性）
 *    5.【多色球 + 独立CD + 白名单】
 *       · 金/蓝/绿三种球各有独立冷却（25/15/5 秒），CD 存球上
 *       · 每种球有各自的"可收容干员"白名单（对应 card 三分支）
 *    6.【冷却/就绪双贴图】
 *       · 收回时生成「冷却版」满球：items:fictoria_ball_filled_<色>_cd
 *       · CD 到期后自动热交换为「就绪版」满球：items:fictoria_ball_filled_<色>
 *       · 扫描间隔 1 秒（20 tick），仅扫玩家背包
 *    7.【战术状态保留】（v2 新增）
 *       · 收回时保存 fictoria_ui 的战术模式/锚点到球
 *       · 放置时恢复；巡逻以放置位置为新锚点
 * ============================================================
 *  已知限制（v1）：
 *    · 背包物品仅保留 typeId+数量+耐久，附魔/自定义名会降级丢失
 *    · 装备（equipment 组件）不额外保存，依赖行为包 loot 表自动装备
 *    · 女仆皮肤已通过 SKIN_EVENT_MAP（maid_1~20 事件）支持；无映射实体保持随机
 *    · 冷却球若放在箱子/容器里，贴图不会自动变（功能不受影响，
 *      拿出来后最多 1 秒内会被换成就绪版）
 * ============================================================
 */

import { world, system, ItemStack, Direction } from "@minecraft/server";

/* ============================================================
 *  ★★★ 配置表①：金球可收容的干员类型（对应 card_3 驯服分支）★★★
 * ============================================================ */
const GOLD_BALL_TYPES = [
    "player:dm0", 
    "player:dm4", 
    "player:dm25", 
    "player:dm32", 
    "player:dm35", 
    "player:dm41", 
    "player:dm45", "player:dm46",
    "player:dm48", "player:dm49", "player:dm50",
    "player:dm51", "player:dm52", "player:dm53", 
    "player:dm56", 
    "player:dm60", "player:dm61", "player:dm62",
    "player:dm63",
    "player:kirito", "player:asuna"
];

/* ============================================================
 *  ★★★ 配置表②：蓝球可收容的干员类型（对应 card_2 驯服分支）★★★
 * ============================================================ */
const BLUE_BALL_TYPES = [
    "player:dm3",
    "player:dm6", "player:dm7", "player:dm8",
    "player:dm10", "player:dm11", "player:dm12",
    "player:dm13", "player:dm14", 
    "player:dm18", "player:dm20",
    "player:dm21", "player:dm22", "player:dm23", "player:dm24",
    "player:dm26", "player:dm27", "player:dm28", "player:dm29",
    "player:dm30", "player:dm31", "player:dm33", 
    "player:dm36", "player:dm37", "player:dm38",
    "player:dm39", "player:dm40", 
    "player:dm54",
    "player:dm59"
];

/* ============================================================
 *  ★★★ 配置表③：绿球可收容的干员类型（对应 card_1 驯服分支）★★★
 * ============================================================ */
const GREEN_BALL_TYPES = [
    "player:dm1", "player:dm2", "player:dm5",
    "player:dm9", "player:dm15", "player:dm16", "player:dm17",
    "player:dm19", "player:dm34", "player:dm34_1",
];

/* ==================== 幻域球配置 ==================== */

/**
 * 幻域球表：空球ID → 配置
 *   filledCooling : 冷却版满球 ID（收回时生成，冷却贴图）
 *   filledReady   : 就绪版满球 ID（CD 到期后热交换，无冷却贴图）
 *   cd            : 冷却秒数（金25 / 蓝15 / 绿5）
 *   allowed       : 可收容干员白名单（引用上面配置表，空数组=不限制）
 */
const BALL_TYPES = {
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

/** 反向索引：任意满球ID（冷却/就绪两版）→ { emptyId, cd, allowed } */
const FILLED_MAP = {};
/** 冷却版满球 → 就绪版满球（CD 到期热交换用） */
const COOLING_TO_READY_MAP = {};
for (const [emptyId, cfg] of Object.entries(BALL_TYPES)) {
  FILLED_MAP[cfg.filledCooling] = { emptyId, cd: cfg.cd, allowed: cfg.allowed };
  FILLED_MAP[cfg.filledReady] = { emptyId, cd: cfg.cd, allowed: cfg.allowed };
  COOLING_TO_READY_MAP[cfg.filledCooling] = cfg.filledReady;
}

/* 战术 UI 状态在球上的动态属性键（与 fictoria_ui.js 的 DP 键对应，字符串桥接） */
const UI_DP_KEYS = ["fictoria:ui_mode", "fictoria:ui_home", "fictoria:ui_home_dim"];
/** 实体上的战术状态键 → 球上的保存键 */
const UI_ENTITY_TO_BALL = {
  "fictoria_ui:mode": "fictoria:ui_mode",
  "fictoria_ui:home": "fictoria:ui_home",
  "fictoria_ui:home_dim": "fictoria:ui_home_dim",
};
/** 球上的保存键 → 实体上的战术状态键（恢复用，精确映射避免 replace 错位） */
const UI_BALL_TO_ENTITY = {
  "fictoria:ui_mode": "fictoria_ui:mode",
  "fictoria:ui_home": "fictoria_ui:home",
  "fictoria:ui_home_dim": "fictoria_ui:home_dim",
};

const BAG_DP_KEY = "fictoria:bag_data";   // 背包数据存 ItemStack 动态属性的键
const OWNER_DP_KEY = "ownerId"; // 主人动态属性键——与 attackable_target_manager.js 保持一致

const LORE_LINE_LENGTH = 50;   // lore 每行上限（官方限制 20行×50字符）
const HIDE_CHAR = "\u00a7z";   // §z 隐形颜色码

/* 放置冷却：CD 时间戳存在球的 ItemStack 动态属性上（各球独立），时长按球色从配置表取 */
const PLACE_CD_KEY = "fictoria:place_cd"; // 球动态属性：冷却结束时间戳（毫秒）

/* 冷却→就绪贴图热交换的扫描间隔（tick），20 = 1 秒 */
const CD_TEXTURE_SCAN_TICKS = 20;

/* 主人校验严格度：true=必须能读到主人ID才允许收回；false=主人信息缺失时仅凭"已驯服"放行 */
const REQUIRE_OWNER = false;

/**
 * 排除列表：dm 家族中"不可回收"的单位（即使可驯服）
 * 例如某些剧情/BOSS单位。留空数组则默认只按 ownerId/驯服标记判定。
 */
const EXCLUDE_TYPES = [
    "player:dm42", "player:dm42_1", "player:dm43", "player:dm44",
    "player:dm47", "player:dm55", "player:dm57", "player:dm58",
    "player:steve",
    "mob:protecter", "mob:robot", "mob:doctor", "mob:mon3tr",
];

/**
 * 显式包含列表：即使没有 ownerId/驯服标记也允许回收（需自行保证主人校验可行）
 * 默认留空。
 */
const INCLUDE_TYPES = [];

/**
 * 武器状态恢复映射表：typeId → { variant值: 恢复事件名 }
 * （variant 含义因实体而异，必须按实体分别配置）
 *   player:dm34   : 0=近战/背包, 1=sword, 2=bow, 3=crossbow, 5=farm
 *   player:dm34_1 : 1=m4a1, 2=moss(berg), 3=awp, 4=sword, 5=glock
 *   player:dm46   : 0=sword模式(attack), 1=air站立(silent/默认)
 * 事件触发后行为包会自动切换组件组 + 按 loot 表装备武器
 */
const VARIANT_EVENT_MAP = {
  "player:dm34":   { 1: "sword", 2: "bow", 3: "crossbow", 5: "farm" },
  "player:dm34_1": { 1: "m4a1", 2: "moss", 3: "awp", 4: "sword", 5: "glock" },
  "player:dm46":   { 0: "attack", 1: null }, // null = 保持 spawn 默认（on_tame 后即 air 站立态）
};

/**
 * 皮肤恢复映射表：typeId → { skin_id值: 恢复事件名 }
 * 女仆通过 maid_N 事件设置皮肤（maid_N = 加 skin_N 组件组 + 补全驯服状态）。
 * ⚠️ maid_N 会把 variant 重置为 0，因此必须在武器事件【之前】触发。
 */
const SKIN_EVENT_MAP = {
  "player:dm34": {
    1: "maid_1", 2: "maid_2", 3: "maid_3", 4: "maid_4", 5: "maid_5",
    6: "maid_6", 7: "maid_7", 8: "maid_8", 9: "maid_9", 10: "maid_10",
    11: "maid_11", 12: "maid_12", 13: "maid_13", 14: "maid_14", 15: "maid_15",
    16: "maid_16", 17: "maid_17", 18: "maid_18", 19: "maid_19", 20: "maid_20",
  },
  "player:dm34_1": {
    1: "maid_1", 2: "maid_2", 3: "maid_3", 4: "maid_4", 5: "maid_5",
    6: "maid_6", 7: "maid_7", 8: "maid_8", 9: "maid_9", 10: "maid_10",
    11: "maid_11", 12: "maid_12", 13: "maid_13", 14: "maid_14", 15: "maid_15",
    16: "maid_16", 17: "maid_17", 18: "maid_18", 19: "maid_19", 20: "maid_20",
  },
};

/* ============================================================
 *  一、字符串压缩工具（StrHelper）
 *  数字用 Unicode 私有区 0xA000+ 编码，2字符存16bit整数
 * ============================================================ */

const StrHelper = {
  int2str(num) {
    return String.fromCodePoint(0xa000 + Math.floor(num / 0x100)) +
           String.fromCodePoint(0xa000 + (num % 0x100));
  },
  str2int(str) {
    return (str.charCodeAt(0) - 0xa000) * 0x100 + (str.charCodeAt(1) - 0xa000);
  },
  short2str(num) {
    return String.fromCodePoint(0xa000 + num);
  },
  str2short(str) {
    return str.charCodeAt(0) - 0xa000;
  },
};

/* ============================================================
 *  二、隐形 lore 编解码（状态存这里）
 *  格式：H<当前HP><最大HP>V<variant>K<skin>N<JSON数组>
 *  JSON数组: ["主人ID","主人名","干员名","实体typeId"]
 * ============================================================ */

function str2Lore(strPure) {
  const lore = [];
  let rest = strPure;
  const chunkSize = LORE_LINE_LENGTH - HIDE_CHAR.length; // 48（每行留出 §z 的位置）
  while (rest.length > 0) {
    const chunk = rest.length > chunkSize ? rest.slice(0, chunkSize) : rest;
    lore.push(HIDE_CHAR + chunk); // 每行都加 §z 前缀，整条 lore 都是隐藏的
    rest = rest.length > chunkSize ? rest.slice(chunkSize) : "";
  }
  return lore;
}

function lore2Str(lore) {
  let strLore = "";
  for (const line of lore) strLore += line;
  let strPure = "";
  // 从 i=0 开始：遇到 § 就跳过颜色码（§ + 后一位），正确剥离所有 §z 前缀
  for (let i = 0; i < strLore.length; ) {
    if (strLore[i] === "\u00a7") { i += 2; continue; }
    strPure += strLore[i];
    i++;
  }
  return strPure;
}

/* ============================================================
 *  三、玩家主手工具
 * ============================================================ */

function getMainHand(player) {
  return player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex);
}

function setMainHand(player, item) {
  player.getComponent("minecraft:inventory")?.container?.setItem(player.selectedSlotIndex, item);
}

/* ============================================================
 *  四、可回收判定 + 主人校验（全 JS，无需改实体）
 * ============================================================ */

/**
 * 判断实体是否属于某家族（全版本兼容，自动适配新旧 API）
 */
function entityHasFamily(entity, family) {
  // 旧版：Entity 直连方法
  if (typeof entity.hasFamily === "function") {
    return entity.hasFamily(family);
  }
  // 新版：minecraft:type_family 组件
  const tf = entity.getComponent("minecraft:type_family");
  if (tf === undefined) return false;
  // 当前版本：hasTypeFamily 方法
  if (typeof tf.hasTypeFamily === "function") {
    return tf.hasTypeFamily(family);
  }
  // 过渡版本：hasFamily 方法
  if (typeof tf.hasFamily === "function") {
    return tf.hasFamily(family);
  }
  // 当前版本：getTypeFamilies() 方法返回数组
  if (typeof tf.getTypeFamilies === "function") {
    return tf.getTypeFamilies().includes(family);
  }
  // 过渡版本：families 数组属性
  if (Array.isArray(tf.families)) {
    return tf.families.includes(family);
  }
  return false;
}

/** 可回收判定：已归属干员（ownerId 动态属性 = 你项目驯服/交互时写入的） */
function isCapturable(entity) {
  if (EXCLUDE_TYPES.includes(entity.typeId)) return false;
  if (INCLUDE_TYPES.includes(entity.typeId)) return true;
  // 核心：项目机制——驯服/交互时 manager 已写入 ownerId，有即视为"已归属干员"
  if (entity.getDynamicProperty(OWNER_DP_KEY) !== undefined) return true;
  // 兜底：dm 家族 + 驯服标记（覆盖 ownerId 还没写上的边缘情况）
  if (!entityHasFamily(entity, "dm")) return false;
  return entity.hasTag("dm_tamed") ||
         entity.hasComponent("minecraft:is_tamed") ||
         entity.hasComponent("minecraft:tameable");
}

/** 获取主人 ID：优先你项目已存的 ownerId 动态属性，兜底 tameable 组件 */
function getOwnerId(entity) {
  // 你项目机制：attackable_target_manager.js 在驯服(minecraft:on_tame)/交互时写入 ownerId
  const dpOwner = entity.getDynamicProperty(OWNER_DP_KEY);
  if (dpOwner !== undefined) return dpOwner;
  // 兜底：tameable 组件（未驯服但可驯服的实体上有，tamedToPlayerId 为 undefined 时忽略）
  const tameable = entity.getComponent("minecraft:tameable");
  if (tameable !== undefined && tameable.tamedToPlayerId !== undefined) {
    return tameable.tamedToPlayerId;
  }
  return undefined;
}

/** 主人校验 */
function isOwner(entity, player) {
  const ownerId = getOwnerId(entity);
  // 能确认主人 → 必须匹配
  if (ownerId !== undefined) return ownerId === player.id;
  // 主人信息缺失：默认按"已驯服"放行，配 REQUIRE_OWNER=true 可强制要求可校验
  return !REQUIRE_OWNER &&
    (entity.hasTag("dm_tamed") || entity.hasComponent("minecraft:is_tamed"));
}

/** 检查目标 typeId 是否在该球的白名单内（allowed 为空 = 不限制） */
function isAllowedType(allowed, typeId) {
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.includes(typeId);
}

/* ============================================================
 *  五、放置冷却（CD）——按"每个球独立"设计
 *  冷却时间戳存在球的 ItemStack 动态属性上（球是非堆叠物品可存 DP），
 *  每个球从自己被收回的那一刻独立倒计时，时长按球色配置；
 *  物品栏上方字幕（setActionBar）实时提示剩余秒数
 * ============================================================ */

/** 球的冷却是否进行中（true=冷却中） */
function isBallPlaceCd(ball) {
  const end = ball.getDynamicProperty(PLACE_CD_KEY);
  return typeof end === "number" && end > Date.now();
}

/** 球剩余冷却秒数（0=不在冷却） */
function getBallPlaceCdRemain(ball) {
  const end = ball.getDynamicProperty(PLACE_CD_KEY);
  if (typeof end !== "number" || end <= Date.now()) return 0;
  return Math.ceil((end - Date.now()) / 1000);
}

/** 收回时给球写入冷却（cdSeconds 由球色配置决定） */
function startPlaceCd(ball, cdSeconds) {
  ball.setDynamicProperty(PLACE_CD_KEY, Date.now() + cdSeconds * 1000);
}

/* ============================================================
 *  六、安全位置计算（车万女仆做法：点击面偏移 + 两格空间）
 * ============================================================ */

function getSafeLocation(dimension, blockLocation, blockFace) {
  const location = { x: blockLocation.x, y: blockLocation.y, z: blockLocation.z };
  switch (blockFace) {
    case Direction.Down: location.y--; break;
    case Direction.Up: location.y++; break;
    case Direction.East: location.x++; break;
    case Direction.West: location.x--; break;
    case Direction.South: location.z++; break;
    case Direction.North: location.z--; break;
    default: return undefined;
  }
  const isSafe = (pos) => {
    const b = dimension.getBlock(pos);
    return b === undefined || b.isAir;
  };
  if (!isSafe(location)) return undefined;
  const up = { x: location.x, y: location.y + 1, z: location.z };
  if (!isSafe(up)) {
    const down = { x: location.x, y: location.y - 1, z: location.z };
    return isSafe(down) ? down : undefined;
  }
  return location;
}

/* ============================================================
 *  七、背包序列化（存 ItemStack 动态属性，不落地）
 * ============================================================ */

/** 读取实体背包 → JSON 数据（含容器尺寸，用于恢复时校验） */
function readInventory(maid) {
  const container = maid.getComponent("minecraft:inventory")?.container;
  if (container === undefined) return undefined;
  const slots = [];
  for (let i = 0; i < container.size; i++) {
    const item = container.getItem(i);
    if (item === undefined) { slots.push(null); continue; }
    const dur = item.getComponent("minecraft:durability");
    slots.push({ i: item.typeId, n: item.amount, d: dur !== undefined ? dur.damage : 0 });
  }
  return { size: container.size, slots };
}

/** 从 JSON 数据恢复背包（超出新实体容量的部分爆到地上兜底） */
function restoreInventory(maid, bagData) {
  const container = maid.getComponent("minecraft:inventory")?.container;
  if (container === undefined || bagData === undefined) return;
  const slots = bagData.slots ?? [];
  for (let idx = 0; idx < slots.length; idx++) {
    const data = slots[idx];
    if (data === null || data === undefined) continue;
    try {
      const item = new ItemStack(data.i, data.n);
      if (data.d > 0) {
        const dur = item.getComponent("minecraft:durability");
        if (dur !== undefined) dur.damage = data.d;
      }
      if (idx < container.size) {
        container.setItem(idx, item);
      } else {
        // 新实体容器更小：剩余物品落到地面，不丢失
        maid.dimension.spawnItem(item, maid.location);
      }
    } catch {}
  }
}

/* ============================================================
 *  八、核心：收回（封印）
 *  cfg = 空球配置 { filledCooling, filledReady, cd, allowed }
 * ============================================================ */

function captureMaid(player, maid, cfg) {
  try {
    // 再次确认主手物品确实是空球
    const item = getMainHand(player);
    if (item === undefined || BALL_TYPES[item.typeId] === undefined) return;

    // 1. 读取状态
    const health = maid.getComponent("minecraft:health");
    const variantComp = maid.getComponent("minecraft:variant");
    const skinComp = maid.getComponent("minecraft:skin_id");
    const ownerId = getOwnerId(maid);

    const curHp = health !== undefined ? health.currentValue : 0;
    const maxHp = health !== undefined ? health.defaultValue : 0;
    const variant = variantComp !== undefined ? variantComp.value : 0;
    const skin = skinComp !== undefined ? skinComp.value : 0;

    // 2. 压缩状态 → 字符串（HP/变体/皮肤用私有区编码，字符串数据进 JSON）
    const jsonData = JSON.stringify([
      ownerId ?? "",        // 主人ID
      player.name,          // 主人名
      maid.nameTag ?? "",   // 干员名
      maid.typeId,          // 实体类型（关键）
    ]);
    const stateStr =
      `H${StrHelper.int2str(curHp)}${StrHelper.int2str(maxHp)}` +
      `V${StrHelper.short2str(variant)}` +
      `K${StrHelper.short2str(skin)}` +
      `N${jsonData}`;

    // 3. 生成【冷却版】满球（CD 未结束前显示冷却贴图）
    const ball = new ItemStack(cfg.filledCooling, 1);
    ball.setLore(str2Lore(stateStr));

    // 4. 背包 → ItemStack 动态属性（不落地，随物品保存）
    const bagData = readInventory(maid);
    if (bagData !== undefined) {
      ball.setDynamicProperty(BAG_DP_KEY, JSON.stringify(bagData));
    }

    // ── v2：保存战术 UI 状态（跟随/随机/巡逻 + 锚点）到球 ──
    // 键名与 fictoria_ui.js 的 DP 键对应（字符串桥接，零 import 耦合）
    for (const [entityKey, ballKey] of Object.entries(UI_ENTITY_TO_BALL)) {
      const v = maid.getDynamicProperty(entityKey);
      if (v !== undefined) ball.setDynamicProperty(ballKey, v);
    }

    // 5. 球的名字显示干员名（宝可梦球风格）
    if (maid.nameTag !== undefined && maid.nameTag !== "") {
      ball.nameTag = `§r${maid.nameTag}`;
    }

    // 6. 静默移除女仆（不触发死亡动画/不掉落）
    try { maid.remove(); } catch {}

    // 7. 启动放置冷却 —— 必须放在 setMainHand 之前！
    //    container.setItem 会序列化当前 ItemStack 状态；
    //    放进去之后再改 ball 的动态属性，不会反映到背包里的物品上。
    startPlaceCd(ball, cfg.cd);

    // 8. 替换主手
    setMainHand(player, ball);

    player.onScreenDisplay.setActionBar(
      `§a回收成功，§e${cfg.cd}§a 秒后可再次放置`
    );
  } catch (e) {
    console.warn(`[FictoriaBall] 回收失败: ${e}`);
  }
}

/* ============================================================
 *  九、核心：放置（解封）
 *  emptyId = 满球对应的空球ID（放置后返还）
 * ============================================================ */

function releaseMaid(event, emptyId) {
  const player = event.player;
  const dimension = player.dimension;

  // 先读取满球（冷却版/就绪版均可放置；CD 存在球上，必须先拿到球才能查）
  const ball = getMainHand(player);
  if (ball === undefined || FILLED_MAP[ball.typeId] === undefined) return;

  // 双重校验冷却（每个球独立）
  if (isBallPlaceCd(ball)) {
    player.onScreenDisplay.setActionBar(
      `§c幻域球冷却中，剩余 §e${getBallPlaceCdRemain(ball)}§c 秒`
    );
    return;
  }

  // 安全位置
  const location = getSafeLocation(dimension, event.block.location, event.blockFace);
  if (location === undefined) {
    player.onScreenDisplay.setActionBar("§c空间不足，无法放置干员");
    return;
  }
  location.x += 0.5;
  location.z += 0.5;

  // 解析状态
  const lore = ball.getLore();
  if (lore.length === 0) return;
  const stateStr = lore2Str(lore);

  const hp = { cur: 0, max: 0 };
  const vIdx = stateStr.indexOf("V");
  const kIdx = stateStr.indexOf("K");
  const nIdx = stateStr.indexOf("N");
  if (vIdx === -1 || nIdx === -1) {
    player.onScreenDisplay.setActionBar("§c幻域球数据损坏");
    return;
  }
  hp.cur = StrHelper.str2int(stateStr.slice(1, 3));       // H 后 2 字符
  hp.max = StrHelper.str2int(stateStr.slice(3, 5));
  const variant = StrHelper.str2short(stateStr.slice(vIdx + 1, vIdx + 2));
  const skin = StrHelper.str2short(stateStr.slice(kIdx + 1, kIdx + 2));
  let jsonArr;
  try { jsonArr = JSON.parse(stateStr.slice(nIdx + 1)); } catch { jsonArr = undefined; }
  if (jsonArr === undefined || jsonArr.length < 4) {
    player.onScreenDisplay.setActionBar("§c幻域球数据损坏");
    return;
  }
  const [ownerId, ownerName, maidName, typeId] = jsonArr;

  // 主人校验（JS）
  if (ownerId !== "" && ownerId !== player.id) {
    player.onScreenDisplay.setActionBar("§c你不是该干员的主人");
    return;
  }

  // 读取背包数据（动态属性）
  let bagData;
  try {
    const raw = ball.getDynamicProperty(BAG_DP_KEY);
    if (typeof raw === "string") bagData = JSON.parse(raw);
  } catch { bagData = undefined; }

  // 生成干员
  let maid;
  try {
    maid = dimension.spawnEntity(typeId, location);
  } catch {
    player.onScreenDisplay.setActionBar(`§c无法生成 ${typeId}`);
    return;
  }
  // ⚠️ 必须在 clearDynamicProperties() 之前读球！函数末尾会清空球，tick 8 再读就晚了
  const savedUiState = {};
  for (const [ballKey, entityKey] of Object.entries(UI_BALL_TO_ENTITY)) {
    try {
      const v = ball.getDynamicProperty(ballKey);
      if (v !== undefined) savedUiState[entityKey] = v;
    } catch {}
  }

  // ============================================================
  //  【方案B】同一 tick 内立即恢复状态（消除皮肤闪烁）
  //  spawnEntity 返回时 entity_spawned 已同步执行完（ta+default+随机皮肤已挂上），
  //  因此在这里马上 tame / 皮肤 / 武器，客户端在 tick 结束时
  //  只收到最终状态，看不到随机皮肤的中间帧。
  // ============================================================

  let tameOk = false;

  // ① 驯服（此时 ta 组已存在，tameable 组件可用；触发 on_tame → on_ta + tag dm_tamed）
  try {
    const tameable = maid.getComponent("minecraft:tameable");
    if (tameable !== undefined) {
      tameable.tame(player);
      tameOk = true;

      // 【防漏清理：带重试机制的多余物品抹除】
      if (maid.typeId === "player:dm34" || maid.typeId === "player:dm34_1") {
        let attempts = 0;
        const maxAttempts = 3; // 最多重试 3 次 (每 tick 一次)

        const cleanJob = () => {
          attempts++;
          let cleaned = false;

          // 1. 优先扫描并清除地面掉落物
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
          } catch (e) {}

          // 2. 地上没有，尝试从背包扣除 1 个
          if (!cleaned) {
            cleaned = removePlayerItemStack(player, "item:maid_command", 1);
          }

          // 3. 如果前两次都没捕捉到（可能引擎延迟发货），下一 tick 继续尝试
          if (!cleaned && attempts < maxAttempts) {
            system.runTimeout(cleanJob, 1);
          }
        };

        // 延迟 1 tick 启动检测
        system.runTimeout(cleanJob, 1);
      }
    }
    maid.addTag("dm_tamed");
    if (ownerName !== "") maid.setDynamicProperty("fictoria:owner_name", ownerName);
    if (ownerId !== "") maid.setDynamicProperty(OWNER_DP_KEY, ownerId);
  } catch (e) {
    console.warn(`[FictoriaBall] 同tick驯服失败: ${e}`);
  }

  // ② 恢复 HP / 名字（独立 try，失败不影响后续）
  try {
    if (hp.max > 0) {
      maid.getComponent("minecraft:health")?.setCurrentValue(Math.min(hp.cur, hp.max));
    }
  } catch {}
  try {
    if (maidName !== "") maid.nameTag = maidName;
  } catch {}

  // ③ 皮肤：先触发（maid_N 会把 variant 重置为 0，必须在武器事件之前）
  try {
    const skinMap = SKIN_EVENT_MAP[maid.typeId];
    if (skinMap !== undefined && skinMap[skin] !== undefined) {
      maid.triggerEvent(skinMap[skin]);
    }
  } catch (e) {
    console.warn(`[FictoriaBall] 同tick皮肤失败: ${e}`);
  }

  // ④ 武器：后触发（覆盖皮肤事件重置的 variant，恢复正确武器）
  try {
    const eventMap = VARIANT_EVENT_MAP[maid.typeId];
    if (eventMap !== undefined && eventMap[variant] !== undefined && eventMap[variant] !== null) {
      maid.triggerEvent(eventMap[variant]);
    }
  } catch (e) {
    console.warn(`[FictoriaBall] 同tick武器失败: ${e}`);
  }

  // ============================================================
  //  兜底 / 收尾（幂等，重复执行无副作用）
  // ============================================================

  // ⑤ 若同 tick 驯服失败（组件未就绪等），tick 2 再试一次
  if (!tameOk) {
    system.runTimeout(() => {
      try {
        const tameable = maid.getComponent("minecraft:tameable");
        if (tameable !== undefined) tameable.tame(player);
        maid.addTag("dm_tamed");
        if (ownerName !== "") maid.setDynamicProperty("fictoria:owner_name", ownerName);
        if (ownerId !== "") maid.setDynamicProperty(OWNER_DP_KEY, ownerId);
      } catch {}
    }, 2);
  }

  // ⑥ tick 5：重放皮肤 + 武器（幂等）。
  //    必要性：tame() 触发的 on_tame 若异步重挂 in1（variant=0），
  //    会覆盖同 tick 设置的武器状态，这里再盖回去。
  system.runTimeout(() => {
    try {
      const skinMap = SKIN_EVENT_MAP[maid.typeId];
      if (skinMap !== undefined && skinMap[skin] !== undefined) {
        maid.triggerEvent(skinMap[skin]);
      }
      const eventMap = VARIANT_EVENT_MAP[maid.typeId];
      if (eventMap !== undefined && eventMap[variant] !== undefined && eventMap[variant] !== null) {
        maid.triggerEvent(eventMap[variant]);
      }
    } catch (e) {
      console.warn(`[FictoriaBall] 状态恢复失败: ${e}`);
    }
  }, 5);

  // ⑦ tick 8：恢复背包（等 on_ta 的 inventory 容器就绪）
  system.runTimeout(() => {
    restoreInventory(maid, bagData);
    // ── v2：恢复战术 UI 状态（用局部变量，球已被清空也不受影响）──
    try {
      for (const [entityKey, v] of Object.entries(savedUiState)) {
        maid.setDynamicProperty(entityKey, v);
      }
    } catch (e) {}
    // ── v2：通知 UI 系统重新登记巡逻名单 / 补充门控物品（放置位置为新锚点）──
    try {
      if (globalThis.FICTORIA_UI_SYNC) {
        globalThis.FICTORIA_UI_SYNC.resumeState(maid);
      }
    } catch (e) {}
  }, 8);

  // 清空球的动态属性（含 CD 与背包数据），变回对应颜色的空球
  try { ball.clearDynamicProperties(); } catch {}
  setMainHand(player, new ItemStack(emptyId, 1));
  player.onScreenDisplay.setActionBar("§a干员已放置！");


}
/**
 * 专为可堆叠物品设计的无痕扣除函数
 * @returns {boolean} 是否成功扣除了物品
 */
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
      container.setItem(slot, undefined); // 刚好 1 个时清空格子，不留残留
      success = true;
      if (remaining <= 0) break;
    }
  }

  return success;
}
/* ============================================================
 *  十、事件注册
 * ============================================================ */

export function initFictoriaBall() {
  /**
   * 【收回】全局拦截实体交互
   * - 只处理手持空球的情况；其他情况直接 return 放行原交互
   * - before 事件 cancel 可阻止实体 interact 组件的后续处理
   * - before 回调是受限执行，所有 setActionBar 必须用 system.run 延后
   */
  world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    // 1. 手持空球（任意颜色）→ 取该球的配置
    const cfg = BALL_TYPES[event.itemStack?.typeId];
    if (cfg === undefined) return;
    const target = event.target;

    // 2. 球色白名单检查：该球能否收容这种干员
    if (!isAllowedType(cfg.allowed, target.typeId)) {
      system.run(() => {
        event.player.onScreenDisplay.setActionBar("§c此球无法回收该干员");
      });
      return;
    }

    // 3. 可回收判定（ownerId / dm + 驯服标记 + 排除列表）
    if (!isCapturable(target)) return;

    // 4. 主人校验（JS）
    if (!isOwner(target, event.player)) {
      system.run(() => {
        event.player.onScreenDisplay.setActionBar("§c这不是你的干员，无法回收");
      });
      return;
    }

    // 5. 拦截默认交互，延后执行（把球色配置传进去）
    event.cancel = true;
    system.run(() => captureMaid(event.player, target, cfg));
  });

  /**
   * 【放置】手持满球（冷却版/就绪版均可）对方块右键
   * 空球对方块右键无操作（不加入随机召唤）
   */
  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const item = event.itemStack;
    if (item === undefined) return;
    // 满球（冷却版/就绪版）→ 对应空球ID
    const filledCfg = FILLED_MAP[item.typeId];
    if (filledCfg === undefined) return;

    // 默认取消方块交互
    event.cancel = true;

    // 放置冷却：读球的 CD（各球独立）；before 回调受限，提示用 system.run 延后
    if (isBallPlaceCd(item)) {
      system.run(() => {
        event.player.onScreenDisplay.setActionBar(
          `§c幻域球冷却中，剩余 §e${getBallPlaceCdRemain(item)}§c 秒`
        );
      });
      return;
    }

    // 容器方块且非潜行 → 放行（允许把球放进箱子）
    const bid = event.block.typeId;
    const isContainer = bid.includes("chest") || bid.includes("barrel") ||
      bid.includes("shulker") || bid.includes("hopper") ||
      bid.includes("dispenser") || bid.includes("dropper") || bid.includes("furnace");
    if (isContainer && !event.player.isSneaking) {
      event.cancel = false;
      return;
    }

    // 放置后返还对应颜色的空球
    system.run(() => releaseMaid(event, filledCfg.emptyId));
  });

  /**
   * 【冷却→就绪贴图热交换】每 1 秒（20 tick）扫描所有在线玩家背包，
   * 把 CD 已到期的「冷却版」满球换成「就绪版」满球。
   * 只扫玩家背包（性能考虑）；放在箱子里的冷却球不受影响，
   * 拿出来后最多 1 秒内也会被换成就绪版。
   */
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      const container = player.getComponent("minecraft:inventory")?.container;
      if (container === undefined) continue;
      for (let slot = 0; slot < container.size; slot++) {
        const item = container.getItem(slot);
        if (item === undefined) continue;
        const readyId = COOLING_TO_READY_MAP[item.typeId];
        if (readyId === undefined) continue; // 不是冷却版球

        // CD 仍在进行中 → 跳过
        const end = item.getDynamicProperty(PLACE_CD_KEY);
        if (typeof end === "number" && end > Date.now()) continue;

        // 组装就绪版（保留 lore / nameTag / 背包数据；CD DP 不复制 = 可直接放置）
        const ready = new ItemStack(readyId, 1);
        ready.setLore(item.getLore());                   // 保留干员状态 lore
        if (item.nameTag !== undefined) {
          ready.nameTag = item.nameTag;                  // 保留干员名
        }
        const bag = item.getDynamicProperty(BAG_DP_KEY);
        if (typeof bag === "string") {
          ready.setDynamicProperty(BAG_DP_KEY, bag);     // 保留背包数据
        }
        // ── v2：保留战术 UI 状态（否则 CD 到期热交换后丢失）──
        for (const uiKey of UI_DP_KEYS) {
          const uiVal = item.getDynamicProperty(uiKey);
          if (uiVal !== undefined) ready.setDynamicProperty(uiKey, uiVal);
        }
        // 全部数据设置完再放入背包（先设属性，再 setItem）
        container.setItem(slot, ready);
      }
    }
  }, CD_TEXTURE_SCAN_TICKS);

  console.warn("[FictoriaBall] 幻域球已加载 (SAPI 2.7.0) 多色球+白名单+双贴图+同tick恢复");
  
}

export { GOLD_BALL_TYPES, BLUE_BALL_TYPES, GREEN_BALL_TYPES };
// 注册全局配置供 fictoria_ui.js 运行时读取（零 import 耦合）
globalThis.FICTORIA_BALL_TYPES = {
    gold:  GOLD_BALL_TYPES,
    blue:  BLUE_BALL_TYPES,
    green: GREEN_BALL_TYPES,
};