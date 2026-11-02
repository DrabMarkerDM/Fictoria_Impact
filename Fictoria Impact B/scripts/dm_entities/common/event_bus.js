// ============================================================
// event_bus.js — 全局事件统一总线
//
// （原 damage_event_bus.js，因职责从「受击」扩展到全部重复订阅而更名）
//
// ── 解决的问题 ────────────────────────────────────────────
// 改造前全工程共有 30 处 .subscribe()，其中大量是「同一事件被
// 多个模块各自订阅一遍」：
//
//   beforeEvents.entityRemove     × 9
//   afterEvents.entityHurt        × 4
//   afterEvents.entityHitEntity   × 3
//   afterEvents.dataDrivenEntityTrigger × 2
//
// 后果：
//   1. 每次事件触发要跨 9 次 JS↔原生边界，跑 9 遍
//      `if (map.has(id)) map.delete(id)` 这种一模一样的清理。
//   2. 执行顺序完全取决于 main.js 的 import 顺序 ——
//      任何一次 import 位置调整都可能悄悄改变战斗结果。
//
// ── 现在的模型 ────────────────────────────────────────────
//   · 每个事件全工程只订阅 1 次
//   · 各模块只登记处理函数 + 优先级数字
//   · 分发顺序由 priority 写死，与 import 顺序彻底解耦
//
// ── 行为等价性（三条硬约束）────────────────────────────────
//   1. 不因 event.cancel 提前中断
//      原实现里前面的处理器 cancel 之后，后面的照样跑。
//      例如友伤拦截 cancel 后，蓄力倍率/弹反仍然执行。
//
//   2. 单处理器异常隔离
//      一个 handler 抛异常只影响它自己，后续继续分发。
//
//   3. 分发顺序 = 改造前的实际注册顺序
//      每个优先级数值都是照原 import 图推算出来的，注释里标了出处。
// ============================================================

import { world } from "@minecraft/server";

// ============================================================
// 优先级表
//
// 数字小的先执行。
// ============================================================

// ── beforeEvents.entityHurt ──────────────────────────────
export const HURT_PRIORITY = {
    MELEE_BLOCK: 100,       // movement_melee.js    受击账本 + 近战格挡
    SUPPORT_SILENCE: 200,   // dm_support_system.js 支援者消音
    FRIENDLY_FIRE: 300,     // player_attack_blocker 友伤拦截
    PLAYER_SWORD: 400       // dm_player_sword_attack 蓄力倍率 + 弹反
};

// ── beforeEvents.entityRemove ────────────────────────────
//
// 主体是各模块的缓存清理，彼此独立，顺序无实质影响。
// 数值仍按改造前的注册先后排列，便于对照。
export const REMOVE_PRIORITY = {
    MELEE_CACHE: 100,           // movement_melee.js
    TACTICAL_CLOCK: 200,        // tactical_clock_manager.js
    SUPPORT_CACHE: 300,         // dm_support_system.js
    TARGET_CACHE: 400,          // attackable_target_manager.js（模块顶层）
    FRIENDLY_FIRE_CACHE: 500,   // player_attack_blocker.js
    FICTORIA_UI_CACHE: 600,     // fictoria_ui.js
    SUFFOCATION_CACHE: 700,     // suffocation_escape.js
    ENGINE_STATE: 800,          // attackable_target_manager.js（init 阶段）
    DRIVE_CACHE: 900,           // main.js DriveVelCache
    MOVE_COMMAND: 950           // move_command_store.js 走位指令表
};

// ── afterEvents.entityHurt ───────────────────────────────
//
// 改造前实际注册顺序：
//   maid_manager:3        （import 阶段，main.js 第 14 行）
//   suffocation_escape:428（import 阶段，第 32 行）
//   dm_player_sword:806   （import 阶段，第 35 行）
//   target_manager:1153   （init 阶段，第 50 行）
export const AFTER_HURT_PRIORITY = {
    MAID_HURT: 100,
    SUFFOCATION_HURT: 200,
    PLAYER_SWORD_HURT: 300,
    TARGET_ENGINE_HURT: 400
};

// ── afterEvents.dataDrivenEntityTrigger ──────────────────
export const DATA_DRIVEN_PRIORITY = {
    FICTORIA_UI: 100,       // fictoria_ui.js（import 阶段）
    TARGET_ENGINE: 200      // attackable_target_manager.js（init 阶段）
};

// ── afterEvents.entityHitEntity ──────────────────────────
export const ENTITY_HIT_PRIORITY = {
    FICTORIA_UI: 100,       // fictoria_ui.js（import 阶段，第 29 行）
    PLAYER_SWORD: 200,      // dm_player_sword_attack.js（第 35 行）
    MELEE_IMPACT: 300       // melee_manager.js（events() 内，init 最后）
};

// ============================================================
// 通道定义
//
// resolve 用函数包一层，避免模块加载早期访问 world.beforeEvents
// 触发不必要的原生调用。
// ============================================================
const CHANNELS = [
    {
        key: "beforeHurt",
        label: "受击前",
        eventLabel: "beforeEvents.entityHurt",
        resolve: () => world.beforeEvents.entityHurt
    },
    {
        key: "entityRemove",
        label: "实体移除",
        eventLabel: "beforeEvents.entityRemove",
        resolve: () => world.beforeEvents.entityRemove
    },
    {
        key: "afterHurt",
        label: "受击后",
        eventLabel: "afterEvents.entityHurt",
        resolve: () => world.afterEvents.entityHurt
    },
    {
        key: "dataDriven",
        label: "数据驱动事件",
        eventLabel: "afterEvents.dataDrivenEntityTrigger",
        resolve: () => world.afterEvents.dataDrivenEntityTrigger
    },
    {
        key: "entityHit",
        label: "实体互击",
        eventLabel: "afterEvents.entityHitEntity",
        resolve: () => world.afterEvents.entityHitEntity
    }
];

// 每个通道的运行态
const ChannelState = new Map();

for (const def of CHANNELS) {
    ChannelState.set(def.key, {
        def,
        handlers: [],
        names: new Set(),
        subscribed: false
    });
}

let initialized = false;

// ============================================================
// 注册（内部）
// ============================================================
function register(channelKey, name, handler, priority) {
    const state = ChannelState.get(channelKey);

    if (!state) {
        console.error(`[DM-EventBus] 未知通道：${channelKey}（${name}）`);
        return false;
    }

    if (typeof handler !== "function") {
        console.error(`[DM-EventBus] 注册失败：${name} 的 handler 不是函数`);
        return false;
    }

    if (state.names.has(name)) {
        console.warn(`[DM-EventBus] 重复注册已忽略：${channelKey}/${name}`);
        return false;
    }

    state.names.add(name);

    state.handlers.push({
        name,
        handler,
        priority: typeof priority === "number" ? priority : 999
    });

    // priority 升序；同优先级保持注册先后（Array.sort 在 V8 上稳定）
    state.handlers.sort((a, b) => a.priority - b.priority);

    return true;
}

// ============================================================
// 对外注册接口
// ============================================================

/** 受击前（beforeEvents.entityHurt）：可修改 damage / cancel */
export function registerBeforeHurtHandler(name, handler, priority) {
    return register("beforeHurt", name, handler, priority);
}

/** 实体移除前（beforeEvents.entityRemove）：清理各自缓存 */
export function registerEntityRemoveHandler(name, handler, priority) {
    return register("entityRemove", name, handler, priority);
}

/** 受击后（afterEvents.entityHurt）：只读通知 */
export function registerAfterHurtHandler(name, handler, priority) {
    return register("afterHurt", name, handler, priority);
}

/** 数据驱动实体事件（afterEvents.dataDrivenEntityTrigger） */
export function registerDataDrivenHandler(name, handler, priority) {
    return register("dataDriven", name, handler, priority);
}

/** 实体互击（afterEvents.entityHitEntity） */
export function registerEntityHitHandler(name, handler, priority) {
    return register("entityHit", name, handler, priority);
}

// ============================================================
// 启动
//
// 必须在所有模块 import 完成之后调用（main.js 的 init 里）。
// 幂等：重复调用不会重复订阅。
// ============================================================
export function initEventBus() {
    if (initialized) return;

    initialized = true;

    const summary = [];

    for (const state of ChannelState.values()) {
        const { def, handlers } = state;

        if (handlers.length === 0) {
            continue;
        }

        let source;

        try {
            source = def.resolve();
        } catch (e) {
            console.error(`[DM-EventBus] ${def.eventLabel} 不可用: ${e}`);
            continue;
        }

        if (!source || typeof source.subscribe !== "function") {
            console.error(`[DM-EventBus] ${def.eventLabel} 没有 subscribe 方法`);
            continue;
        }

        // 每个通道只订阅一次
        source.subscribe((event) => {
            // 关键：不在 cancel 或异常时中断分发
            for (let i = 0; i < handlers.length; i++) {
                const entry = handlers[i];

                try {
                    entry.handler(event);
                } catch (e) {
                    console.error(
                        `[DM-EventBus] ${def.key}/${entry.name} 处理器异常: ${e}`
                    );
                }
            }
        });

        state.subscribed = true;

        summary.push(
            `${def.label}(${handlers.length}): ` +
            handlers.map(h => `${h.priority}:${h.name}`).join(" -> ")
        );
    }

    console.warn(
        `[DM-EventBus] 总线已启动 | 通道 ${summary.length} 个\n` +
        summary.map(s => "  · " + s).join("\n")
    );
}

// ============================================================
// 诊断
// ============================================================
export function listHandlers(channelKey) {
    const state = ChannelState.get(channelKey);

    if (!state) return [];

    return state.handlers.map(h => ({
        name: h.name,
        priority: h.priority
    }));
}

export function listAllHandlers() {
    const out = {};

    for (const [key, state] of ChannelState) {
        out[key] = listHandlers(key);
    }

    return out;
}

// ============================================================
// 兼容别名
//
// 旧代码里写的是 initDamageEventBus / listBeforeHurtHandlers。
// 保留别名，避免改造过程中漏改一处就整包启动失败。
// ============================================================
export const initDamageEventBus = initEventBus;
export const listBeforeHurtHandlers = () => listHandlers("beforeHurt");
