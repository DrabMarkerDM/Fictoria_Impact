/*
 * maid_registry.js — 友方登记表（登记的唯一所有者）。
 * 登记：attackable_target_manager 每 5 tick 扫一次 dm 家族，typeId 落在 FEATURE_TYPES 的表里就地登记。
 * 读取：功能侧按自己那张表取名单 —— forEachUnitOfTypes(FEATURE_TYPES.light, fn)；
 *      forEachMaid() 是 FEATURE_TYPES.maid 的简写，dm34 那套（卸甲 / 做饭 / 采集 / 盾 / 火把巡检）专用。
 * 铁律：不许自己 getEntities 建表。新增需轮询的友方 = FEATURE_TYPES 加一行 + 功能侧调 forEachUnitOfTypes。
 * 登记必须早于配置解析：待命时 variant=0 不在 modes 表里，resolveStrictConfig 会熔断返回 null。
 * 边界：只有有玩家的维度会被重建，没玩家的维度巡检晚一轮。
 * 本文件被 dm34/ 与 common 的 manager 反向 import，是唯一一处反向依赖。
 */

/**
 * 功能类型表：key = 功能名，value = 这个功能管哪些 typeId。
 * 登记与分发的唯一配置点 —— manager 只登记这里出现过的类型。
 */
export const FEATURE_TYPES = {
    /** dm34 那套干员逻辑（卸甲 / 做饭 / 采集 / 盾 / 火把巡检）的名单 */
    maid: new Set(["player:dm34", "player:dm34_1"]),
    /** 通用动态光源：背包里有火把就点亮。全部是 horse 型容器，能读背包 */
    light: new Set(["player:dm3", "player:dm12", "player:asuna", "player:kirito",
        "player:dm48", "player:dm32", "player:dm51", "player:dm26",
        "player:dm61", "player:dm52", "player:dm56", "player:dm63",
        "player:dm35", "player:dm50", "player:dm31", "player:dm45",
        "player:dm4", "player:dm59", "player:dm33", "player:dm24",
        "player:dm8", "player:dm25", "player:dm49", "player:dm62",
        "player:dm0", "player:dm46", "player:dm60", "player:dm41",
        "player:dm28", "player:dm53", "player:dm22", "player:dm54",
        "player:dm21", "player:dm6"]),

    /**
     * UI 侧「友方」全集（巡逻恢复 / shift+左键弹面板的判定）。
     * 初值只放两只女仆，是兜底：万一 fictoria_ball.js 没加载，dm34 的巡逻恢复照样能跑。
     * 正常启动时由 fictoria_ball.js 调 setFriendlyTypes() 并入幻域球三张表（60 个）。
     * 凑数的实体（bullet:* 83 个、roar 特效、召唤物）**一律不进这张表** —— 它们不接 UI。
     */
    friendly: new Set(["player:dm34", "player:dm34_1"]),
};

/** 所有表的并集：manager 用它判"这只要不要登记"，一张表都不在就跳过（子弹 / 特效不占表） */
const REGISTERED_TYPES = new Set();

for (const types of Object.values(FEATURE_TYPES)) {
    for (const typeId of types) REGISTERED_TYPES.add(typeId);
}

/** entityId → Entity（每 5 tick 全量重建一次） */
const Units = new Map();

/** 这个 typeId 有没有功能在管（manager 登记前的唯一判据） */
export function isRegisteredType(typeId) {
    return REGISTERED_TYPES.has(typeId);
}

/**
 * 友方名单的唯一写入方：fictoria_ball.js 在注册幻域球收纳表时调用一次。
 *
 * 为什么不把这些 typeId 直接写死在 FEATURE_TYPES 里：那是第三份拷贝，
 * 幻域球加减可收纳干员时要改三个地方。这里把"什么算友方"的定义权留在幻域球那张表上，
 * 登记表只负责并入 —— 并进去之后 manager 就会登记它们，UI 侧零查询遍历。
 */
export function setFriendlyTypes(typeIds) {
    if (!typeIds) return;

    for (const raw of typeIds) {
        if (typeof raw !== "string") continue;
        const typeId = raw.trim();
        if (!typeId) continue;

        FEATURE_TYPES.friendly.add(typeId);
        // 同步进登记判据，否则 manager 扫到也不会登记，forEachUnitOfTypes 拿不到人
        REGISTERED_TYPES.add(typeId);
    }
}

/** 是不是 UI 认的友方（shift+左键判定用，O(1)） */
export function isFriendlyTypeId(typeId) {
    return FEATURE_TYPES.friendly.has(typeId);
}

/** 周期起点清空（由 attackable_target_manager 在重建前调用） */
export function clearUnits() {
    Units.clear();
}

/** 登记一只（由 attackable_target_manager 在家族查询结果里调用） */
export function registerUnit(entity) {
    if (!entity) return;
    let id;
    try {
        id = entity.id;
    } catch (_) {
        return;
    }
    Units.set(id, entity);
}

/**
 * 遍历某张表里的单位。回调抛异常只跳过那一只；顺手清掉 isValid === false 的。
 * 表格传 FEATURE_TYPES 里的 Set，或功能自备的 Set（必须与登记表有交集才有结果）。
 */
export function forEachUnitOfTypes(types, fn) {
    if (!types || types.size === 0) return;

    for (const [id, entity] of Units) {
        let alive = false;
        let typeId;
        try {
            alive = !!entity.isValid;
            if (alive) typeId = entity.typeId;
        } catch (_) {
            alive = false;
        }

        if (!alive) {
            Units.delete(id);
            continue;
        }

        if (!types.has(typeId)) continue;

        try {
            fn(entity);
        } catch (_) {
            /* 单只出错不影响其它 */
        }
    }
}

/** 遍历女仆（FEATURE_TYPES.maid 的简写） */
export function forEachMaid(fn) {
    forEachUnitOfTypes(FEATURE_TYPES.maid, fn);
}
