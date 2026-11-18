// event_bus.js — 全局事件统一总线。

// 原来同一事件被多个模块各自订阅（entityRemove ×9、entityHurt ×4…），每次触发要跨 9 次
// JS↔原生边界，且执行顺序取决于 import 顺序。现在每个事件只订阅一次，
// 模块登记处理函数 + 优先级，分发顺序由 priority 写死。

// 三条硬约束：不因 event.cancel 提前中断；单处理器异常隔离；
// 顺序 = 改造前的实际注册顺序。

import { world } from "@minecraft/server";

// 优先级表：数字小的先执行。

// ── beforeEvents.entityHurt ──────────────────────────────
export const HURT_PRIORITY = {
    SHIELD_BLOCK: 50,       // dm_entities/common/shield_block.js 盾牌格挡（先于近战格挡，盾挡下的不扣后撤次数）
    MELEE_BLOCK: 100,       // movement_melee.js    受击账本 + 近战格挡
    SUPPORT_SILENCE: 200,   // dm_support_system.js 支援者消音
    FRIENDLY_FIRE: 300,     // player_attack_blocker 友伤拦截
    PLAYER_SWORD: 400       // dm_player_sword_attack 蓄力倍率 + 弹反
};

// ── beforeEvents.entityRemove ── 缓存清理，彼此独立，顺序无实质影响。
export const REMOVE_PRIORITY = {
    MELEE_CACHE: 100,           // movement_melee.js
    TACTICAL_CLOCK: 200,        // tactical_clock_manager.js
    SHIELD_CACHE: 250,          // dm_entities/common/shield_block.js 举盾状态表
    SUPPORT_CACHE: 300,         // dm_support_system.js
    TARGET_CACHE: 400,          // attackable_target_manager.js（模块顶层）
    FRIENDLY_FIRE_CACHE: 500,   // player_attack_blocker.js
    FICTORIA_UI_CACHE: 600,     // fictoria_ui.js
    SUFFOCATION_CACHE: 700,     // suffocation_escape.js
    ENGINE_STATE: 800,          // attackable_target_manager.js（init 阶段）
    DRIVE_CACHE: 900,           // main.js DriveVelCache
    MOVE_COMMAND: 950,          // move_command_store.js 走位指令表
    DROWNING_GUARD: 960         // water_traversal.js 溺水换气表
};

// ── afterEvents.entityHurt ── 顺序照改造前的注册次序排列。
export const AFTER_HURT_PRIORITY = {
    MAID_HURT: 100,
    SUFFOCATION_HURT: 200,
    MELEE_IMPACT: 300,      // melee_manager.js 长矛戳刺动画 + 小范围群攻
    FRIENDLY_WARY_MARK: 350,  // player_attack_blocker.js 误伤友军 → 给受害者打 dm_wary 标签
    TARGET_ENGINE_HURT: 400,
    DROWNING_GUARD: 500     // water_traversal.js 溺水换气标记
};

// ── afterEvents.dataDrivenEntityTrigger ──────────────────
export const DATA_DRIVEN_PRIORITY = {
    FICTORIA_UI: 100,       // fictoria_ui.js（import 阶段）
    TARGET_ENGINE: 200      // attackable_target_manager.js（init 阶段）
};

// ── afterEvents.entityHitEntity ──────────────────────────
export const ENTITY_HIT_PRIORITY = {
    FICTORIA_UI: 100        // fictoria_ui.js（import 阶段，潜行+左键弹指挥菜单）
};

// 通道定义。resolve 用函数包一层，避免加载早期访问 world.beforeEvents。
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

// 注册（内部）
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

// 对外注册接口

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

// 启动：必须在所有模块 import 完成后调用（main.js 的 init），幂等。
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

// 诊断
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

// 兼容别名：旧代码用 initDamageEventBus / listBeforeHurtHandlers。
export const initDamageEventBus = initEventBus;
export const listBeforeHurtHandlers = () => listHandlers("beforeHurt");
