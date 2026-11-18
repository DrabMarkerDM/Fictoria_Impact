/*
 * maid_registry.js — 女仆登记表（登记与读取的唯一所有者）。
 * 写入：attackable_target_manager 每 5 tick 重建受管表时顺手登记（candidates 里本来就有两只
 * 女仆），零额外查询。读取：guard（火把巡检）与 cook（自动烹饪 / 卡死自愈），这两处不再各自
 * getEntities。登记必须早于配置解析：待命时 variant=0 不在 modes 表里，resolveStrictConfig 会
 * 熔断返回 null，而待命最需要巡检。
 * 边界：只有有玩家的维度会被重建，没玩家的维度巡检晚一轮，无实际影响。本文件在 dm34/、common
 * 的 manager 反向 import 它，是唯一一处反向依赖；要复用到别的实体包，改成回调注入再把文件挪回去。
 */

const MAID_TYPE_IDS = new Set(["player:dm34", "player:dm34_1"]);

/** entityId → Entity（每 5 tick 全量重建一次） */
const MaidUnits = new Map();

/** 这个 typeId 是不是女仆 */
export function isMaidTypeId(typeId) {
    return MAID_TYPE_IDS.has(typeId);
}

/** 周期起点清空（由 attackable_target_manager 在重建前调用） */
export function clearMaids() {
    MaidUnits.clear();
}

/** 登记一只（由 attackable_target_manager 在家族查询结果里调用） */
export function registerMaid(entity) {
    if (!entity) return;
    let id;
    try {
        id = entity.id;
    } catch (_) {
        return;
    }
    MaidUnits.set(id, entity);
}

/** 遍历登记到的女仆。回调抛异常只跳过那一只；顺手清掉 isValid === false 的。 */
export function forEachMaid(fn) {
    for (const [id, entity] of MaidUnits) {
        let alive = false;
        try {
            alive = !!entity.isValid;
        } catch (_) {
            alive = false;
        }

        if (!alive) {
            MaidUnits.delete(id);
            continue;
        }

        try {
            fn(entity);
        } catch (_) {
            /* 单只出错不影响其它 */
        }
    }
}
