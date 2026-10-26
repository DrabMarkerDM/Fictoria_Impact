// ============================================================
// fictoria_ui.js — 战术指挥 UI + 守卫（巡逻）系统
// 适用 SAPI：@minecraft/server 2.7.0 / @minecraft/server-ui 2.0.0
//
// 本次修复：
//   · 退出重进后 patrolUnits 内存清空导致巡逻传送失效
//   · DP.home 改用 JSON 字符串持久化，兼容旧版对象
//   · 给巡逻单位加持久 tag，启动后自动扫描恢复
//   · 守卫主循环增加 DP.mode 校验
//   · resumeState 桥接同步加 tag
//   · getUnitStatus 打开 UI 时自动补回 patrolUnits
//
// 保留原优化：
//   · 配置字符串统一 trim
//   · itemGatedEntities / followAliases / sitAliases 改 Set
//   · dataDrivenEntityTrigger 快速短路
//   · 背包门控减少重复扫描
//   · unit.isRemoved 改 unit.isValid
//   · 实体移除清理 patrolUnits / pendingVerify
//   · 高频诊断日志接入 CONFIG.debug
// ============================================================
import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// ---------- 配置区 ----------
const CONFIG = {
    homeRadius: 32,
    checkInterval: 30,
    statusCheckTicks: 20,
    uiCooldown: 10,
    verifyWaitTicks: 10,
    requireTamed: true,
    ownerIdKey: "ownerId",
    followComponent: "minecraft:behavior.follow_owner",
    followEvent: "follow",
    sitEvent: "sit",
    followAliases: ["follow", "follow_1"],
    sitAliases: ["sit", "follow_2"],
    itemGatedEntities: ["player:dm34", "player:dm34_1"],
    maidCommandId: "item:maid_command",
    debug: false,
    autoReopenAfterSwitch: false,
};

const MODE = {
    FOLLOW: 0,
    RANDOM: 1,
    PATROL: 2,
    UNKNOWN: -1
};

const MODE_NAME = ["跟随玩家", "随机移动", "巡逻守家"];

const DP = {
    home: "fictoria_ui:home",
    dim: "fictoria_ui:home_dim",
    mode: "fictoria_ui:mode",
};

// 巡逻 tag，用于重进存档后恢复
const PATROL_TAG = "fictoria_patrol";

// ============================================================
// 字符串工具
// ============================================================
function trimString(value) {
    return typeof value === "string" ? value.trim() : value;
}

function trimArrayToSet(arr) {
    const set = new Set();
    if (!Array.isArray(arr)) return set;
    for (const value of arr) {
        set.add(trimString(value));
    }
    return set;
}

// ============================================================
// 常用 Set
// ============================================================
const ITEM_GATED_SET = trimArrayToSet(CONFIG.itemGatedEntities);
const FOLLOW_ALIAS_SET = trimArrayToSet(CONFIG.followAliases);
const SIT_ALIAS_SET = trimArrayToSet(CONFIG.sitAliases);

function uiLog(...args) {
    if (CONFIG.debug) {
        console.warn(...args);
    }
}

// ---------- 从 globalThis 读取三张配置表（fictoria_ball.js 注册） ----------
let FRIENDLY_TYPES = null;
try {
    const t = globalThis.FICTORIA_BALL_TYPES;
    if (t && Array.isArray(t.gold) && Array.isArray(t.blue) && Array.isArray(t.green)) {
        FRIENDLY_TYPES = new Set(
            [...t.gold, ...t.blue, ...t.green].map(trimString)
        );
    } else {
        console.warn(
            "[FictoriaUI] 未找到 globalThis.FICTORIA_BALL_TYPES，" +
            "请确认 fictoria_ball.js 已先加载。UI 将临时禁用友方判定。"
        );
    }
} catch (e) {
    console.warn(`[FictoriaUI] 读取配置失败: ${e}`);
}

const patrolUnits = new Set();
const uiCooldowns = new Map();
const pendingVerify = new Map();

// ============================================================
// 实体移除清理
// ============================================================
try {
    world.beforeEvents.entityRemove.subscribe((event) => {
        try {
            const id = event.removedEntity?.id;
            if (!id) return;

            patrolUnits.delete(id);
            pendingVerify.delete(id);
        } catch (_) {}
    });
} catch (_) {}

// ============================================================
// 核心逻辑
// ============================================================
function initFictoriaUI() {

    // ══════════════════════════════════════════════════════════
    //  锚点存取（JSON 字符串持久化）
    // ══════════════════════════════════════════════════════════

    function saveHome(unit) {
        try {
            const l = unit.location;
            unit.setDynamicProperty(
                DP.home,
                JSON.stringify({ x: l.x, y: l.y, z: l.z })
            );
            unit.setDynamicProperty(
                DP.dim,
                unit.dimension.id ?? unit.dimension.typeId ?? "minecraft:overworld"
            );
        } catch (_) {}
    }

    function readHome(unit) {
        try {
            const raw = unit.getDynamicProperty(DP.home);
            if (!raw) return null;

            // 新版：JSON 字符串
            if (typeof raw === "string") {
                try {
                    const parsed = JSON.parse(raw);
                    if (
                        parsed &&
                        typeof parsed.x === "number" &&
                        typeof parsed.y === "number" &&
                        typeof parsed.z === "number"
                    ) {
                        return parsed;
                    }
                } catch (_) {}
            }

            // 兼容旧版：普通对象 / Vector3
            if (
                typeof raw === "object" &&
                typeof raw.x === "number" &&
                typeof raw.y === "number" &&
                typeof raw.z === "number"
            ) {
                return raw;
            }

            return null;
        } catch (_) {
            return null;
        }
    }

    // ══════════════════════════════════════════════════════════
    //  巡逻 tag 管理
    // ══════════════════════════════════════════════════════════

    function markPatrol(unit) {
        try {
            unit.addTag(PATROL_TAG);
        } catch (_) {}
    }

    function unmarkPatrol(unit) {
        try {
            unit.removeTag(PATROL_TAG);
        } catch (_) {}
    }

    function ensurePatrol(unit) {
        try {
            if (!unit || !unit.isValid) return;

            const mode = unit.getDynamicProperty(DP.mode);

            if (mode !== MODE.PATROL) {
                patrolUnits.delete(unit.id);
                unmarkPatrol(unit);
                return;
            }

            const home = readHome(unit);
            const dim = unit.getDynamicProperty(DP.dim);

            if (!home || !dim) {
                saveHome(unit);
            }

            patrolUnits.add(unit.id);
            markPatrol(unit);
        } catch (_) {}
    }

    // ══════════════════════════════════════════════════════════
    //  2D 方形范围判定
    // ══════════════════════════════════════════════════════════

    function pointInArea2D(x, z, minX, minZ, maxX, maxZ) {
        return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
    }

    // ══════════════════════════════════════════════════════════
    //  单次守卫检查
    // ══════════════════════════════════════════════════════════

    function guardCheck(unit) {
        const home = readHome(unit);
        const dim = unit.getDynamicProperty(DP.dim);

        if (!home || !dim) {
            saveHome(unit);
            return;
        }

        let inHome = unit.dimension.id === dim;

        if (inHome) {
            inHome = pointInArea2D(
                unit.location.x,
                unit.location.z,
                home.x - CONFIG.homeRadius,
                home.z - CONFIG.homeRadius,
                home.x + CONFIG.homeRadius,
                home.z + CONFIG.homeRadius
            );
        }

        if (!inHome) {
            try {
                unit.teleport(
                    {
                        x: home.x,
                        y: home.y,
                        z: home.z
                    },
                    {
                        dimension: world.getDimension(dim)
                    }
                );
            } catch (_) {
                // 目标维度已卸载，忽略
            }
        }
    }

    // ══════════════════════════════════════════════════════════
    //  重进存档后巡逻恢复
    // ══════════════════════════════════════════════════════════

    let patrolRehydrated = false;

    function rehydratePatrolUnits() {
        try {
            const dims = new Set();

            for (const player of world.getAllPlayers()) {
                try {
                    if (player.dimension) {
                        dims.add(player.dimension);
                    }
                } catch (_) {}
            }

            if (dims.size === 0) {
                return;
            }

            for (const dim of dims) {
                // ── 第一优先：通过 tag 恢复 ──
                try {
                    const taggedUnits = dim.getEntities({
                        tags: [PATROL_TAG]
                    });

                    for (const unit of taggedUnits) {
                        ensurePatrol(unit);
                    }
                } catch (_) {}

                // ── 第二优先：兼容旧存档，按友方类型扫描 DP.mode ──
                if (FRIENDLY_TYPES) {
                    for (const typeId of FRIENDLY_TYPES) {
                        try {
                            const units = dim.getEntities({
                                type: typeId
                            });

                            for (const unit of units) {
                                if (!unit || !unit.isValid) continue;

                                const mode = unit.getDynamicProperty(DP.mode);

                                if (mode === MODE.PATROL) {
                                    ensurePatrol(unit);
                                }
                            }
                        } catch (_) {}
                    }
                }
            }

            patrolRehydrated = true;

            uiLog(
                `[FictoriaUI] 巡逻恢复完成，` +
                `当前巡逻单位数: ${patrolUnits.size}`
            );
        } catch (_) {}
    }

    // ══════════════════════════════════════════════════════════
    //  守卫主循环（30 tick）
    // ══════════════════════════════════════════════════════════

    let guardCounter = 0;

    system.runInterval(() => {
        guardCounter++;

        // 如果当前内存里没有巡逻单位，偶尔尝试重建一次
        if (patrolUnits.size === 0) {
            if (guardCounter % 10 === 0) {
                rehydratePatrolUnits();
            }

            if (patrolUnits.size === 0) {
                return;
            }
        }

        for (const id of [...patrolUnits]) {
            const unit = world.getEntity(id);

            if (!unit || !unit.isValid) {
                patrolUnits.delete(id);
                continue;
            }

            // 如果实体身上的 mode 已经不是 PATROL，就移除
            try {
                const mode = unit.getDynamicProperty(DP.mode);
                if (mode !== MODE.PATROL) {
                    patrolUnits.delete(id);
                    unmarkPatrol(unit);
                    continue;
                }
            } catch (_) {}

            guardCheck(unit);
        }
    }, CONFIG.checkInterval);

    // ══════════════════════════════════════════════════════════
    //  启动后延迟恢复
    // ══════════════════════════════════════════════════════════

    // 世界刚加载时可能还没有玩家 / 实体，延迟扫描
    system.runTimeout(() => {
        rehydratePatrolUnits();
    }, 100);

    // 如果第一次扫描时玩家还没进来，则继续尝试几次
    system.runInterval(() => {
        if (!patrolRehydrated && world.getAllPlayers().length > 0) {
            rehydratePatrolUnits();
        }
    }, 100);

    // ══════════════════════════════════════════════════════════
    //  驯服判定
    // ══════════════════════════════════════════════════════════

    function isTamed(unit) {
        if (!unit || !unit.isValid) return false;

        if (unit.getDynamicProperty(CONFIG.ownerIdKey) !== undefined) return true;

        return (
            unit.hasComponent("minecraft:is_tamed") ||
            unit.hasTag("dm_tamed")
        );
    }

    // ══════════════════════════════════════════════════════════
    //  背包门控工具
    // ══════════════════════════════════════════════════════════

    function isItemGated(unit) {
        return ITEM_GATED_SET.has(unit.typeId);
    }

    function hasFollowComponent(unit) {
        return CONFIG.followComponent && unit.hasComponent(CONFIG.followComponent);
    }

    function inventoryHasCommand(unit) {
        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;

        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === CONFIG.maidCommandId) {
                return true;
            }
        }
        return false;
    }

    function isFollowing(unit) {
        if (isItemGated(unit)) {
            return inventoryHasCommand(unit);
        }
        return hasFollowComponent(unit);
    }

    function addCommandToInventory(unit) {
        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;

        let emptySlot = -1;

        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === CONFIG.maidCommandId) {
                return true;
            }
            if (emptySlot === -1 && it === undefined) {
                emptySlot = i;
            }
        }

        if (emptySlot !== -1) {
            inv.setItem(emptySlot, new ItemStack(CONFIG.maidCommandId, 1));
            return true;
        }

        return false;
    }

    function removeCommandFromInventory(unit) {
        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;

        let removed = false;
        let hasCommand = false;

        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === CONFIG.maidCommandId) {
                hasCommand = true;
                inv.setItem(i, undefined);
                removed = true;
            }
        }

        return removed || !hasCommand;
    }

    // ══════════════════════════════════════════════════════════
    //  状态检测
    //
    //  ★ 修复：
    //  打开 UI 时如果 DP.mode 是 PATROL，
    //  自动补回 patrolUnits，防止退出重进后丢失。
    // ══════════════════════════════════════════════════════════

    function getUnitStatus(unit) {
        if (!unit || !unit.isValid) return MODE.UNKNOWN;

        if (isFollowing(unit)) return MODE.FOLLOW;

        const jsMode = unit.getDynamicProperty(DP.mode);

        if (!isItemGated(unit) && jsMode === MODE.FOLLOW) {
            return MODE.FOLLOW;
        }

        if (jsMode === MODE.PATROL || patrolUnits.has(unit.id)) {
            // ★ 打开 UI 时自动补回 patrolUnits
            if (jsMode === MODE.PATROL) {
                patrolUnits.add(unit.id);
                markPatrol(unit);
            }
            return MODE.PATROL;
        }

        if (jsMode === MODE.RANDOM) return MODE.RANDOM;

        return MODE.UNKNOWN;
    }

    // ══════════════════════════════════════════════════════════
    //  JS 层状态落盘（含 tag 管理）
    // ══════════════════════════════════════════════════════════

    function applyJsState(unit, mode) {
        switch (mode) {
            case MODE.FOLLOW:
                patrolUnits.delete(unit.id);
                unmarkPatrol(unit);
                unit.setDynamicProperty(DP.mode, MODE.FOLLOW);
                break;

            case MODE.RANDOM:
                patrolUnits.delete(unit.id);
                unmarkPatrol(unit);
                unit.setDynamicProperty(DP.mode, MODE.RANDOM);
                break;

            case MODE.PATROL:
                saveHome(unit);
                unit.setDynamicProperty(DP.mode, MODE.PATROL);
                patrolUnits.add(unit.id);
                markPatrol(unit);
                break;

            default:
                break;
        }
    }

    // ══════════════════════════════════════════════════════════
    //  周期互斥同步
    // ══════════════════════════════════════════════════════════

    system.runInterval(() => {
        if (patrolUnits.size === 0) return;

        for (const id of [...patrolUnits]) {
            const unit = world.getEntity(id);
            if (!unit || !unit.isValid) {
                patrolUnits.delete(id);
                continue;
            }

            if (isFollowing(unit)) {
                patrolUnits.delete(unit.id);
                unmarkPatrol(unit);
                unit.setDynamicProperty(DP.mode, MODE.FOLLOW);
            }
        }
    }, CONFIG.statusCheckTicks);

    // ══════════════════════════════════════════════════════════
    //  全局监听 dataDrivenEntityTrigger
    // ══════════════════════════════════════════════════════════

    world.afterEvents.dataDrivenEntityTrigger.subscribe(({ entity, eventId }) => {
        if (!entity || !entity.isValid) return;

        if (CONFIG.debug && ITEM_GATED_SET.has(entity.typeId)) {
            uiLog(`[FictoriaUI][调试] 收到事件: ${eventId} (${entity.typeId})`);
        }

        const p = pendingVerify.get(entity.id);

        if (
            !p &&
            !FOLLOW_ALIAS_SET.has(eventId) &&
            !SIT_ALIAS_SET.has(eventId)
        ) {
            return;
        }

        // ① 验证
        if (p && p.eventIds.includes(eventId) && system.currentTick <= p.deadline) {
            pendingVerify.delete(entity.id);
            applyJsState(entity, p.mode);
            p.player.sendMessage(`§a✔ 指令已生效：${MODE_NAME[p.mode]}`);
            return;
        }

        // ② 全局互斥同步
        if (FOLLOW_ALIAS_SET.has(eventId)) {
            patrolUnits.delete(entity.id);
            unmarkPatrol(entity);
            entity.setDynamicProperty(DP.mode, MODE.FOLLOW);
            return;
        }

        if (SIT_ALIAS_SET.has(eventId)) {
            patrolUnits.delete(entity.id);
            unmarkPatrol(entity);

            if (entity.getDynamicProperty(DP.mode) === MODE.FOLLOW) {
                entity.setDynamicProperty(DP.mode, MODE.RANDOM);
            }
        }
    });

    // ══════════════════════════════════════════════════════════
    //  切换指令 + 验证反馈
    // ══════════════════════════════════════════════════════════

    function waitSitThenPatrol(player, unit, mode) {
        pendingVerify.set(unit.id, {
            eventIds: CONFIG.sitAliases.slice(),
            player,
            mode,
            deadline: system.currentTick + CONFIG.verifyWaitTicks,
        });

        system.runTimeout(() => {
            const p = pendingVerify.get(unit.id);
            if (!p || p.mode !== mode) return;
            pendingVerify.delete(unit.id);

            player.sendMessage(
                `§c✘ 巡逻未激活：该实体未检测到 sit 事件（可能不具备取消跟随能力），已保持原状态`
            );
        }, CONFIG.verifyWaitTicks);
    }

    function scheduleStrategyMenuRefresh(player, unit) {
        if (!CONFIG.autoReopenAfterSwitch) return;

        system.runTimeout(() => {
            try {
                if (player && player.isValid && unit && unit.isValid) {
                    openStrategyMenu(player, unit);
                }
            } catch (_) {}
        }, CONFIG.verifyWaitTicks + 2);
    }

    function assignStrategy(player, unit, mode) {
        const itemGated = isItemGated(unit);
        const wantFollow = (mode === MODE.FOLLOW);

        if (CONFIG.requireTamed && !isTamed(unit)) {
            player.sendMessage(`§c指令失败：该实体未驯服，无法下达战术指令`);
            return;
        }

        if (CONFIG.debug) {
            try {
                const before = unit.getComponents().map(c => c.typeId).sort();
                uiLog(`[FictoriaUI][调试] 切换前组件: ${before.join(", ")}`);
            } catch (_) {}
        }

        // 精确空操作判断
        if (getUnitStatus(unit) === mode) {
            player.sendMessage(`§7[状态] 该干员已是${MODE_NAME[mode]}状态，无需切换`);
            return;
        }

        // ══════════════════════════════════════════════════════
        //  进入巡逻
        // ══════════════════════════════════════════════════════

        if (mode === MODE.PATROL) {
            const wasFollowing = isFollowing(unit);

            if (itemGated) {
                if (wasFollowing) {
                    if (!removeCommandFromInventory(unit)) {
                        player.sendMessage(`§c指令失败：无法访问该干员背包`);
                        return;
                    }
                    waitSitThenPatrol(player, unit, mode);
                } else {
                    if (!addCommandToInventory(unit)) {
                        player.sendMessage(`§c指令失败：背包已满，无法放入 maid_command`);
                        return;
                    }

                    system.runTimeout(() => {
                        try {
                            if (!unit || !unit.isValid) return;
                            removeCommandFromInventory(unit);
                            waitSitThenPatrol(player, unit, mode);
                        } catch (_) {}
                    }, 2);
                }
            } else {
                try {
                    unit.triggerEvent(CONFIG.sitEvent);
                } catch (e) {
                    player.sendMessage(
                        `§c巡逻未激活：实体未找到事件 "${CONFIG.sitEvent}"（${e.message}）`
                    );
                    return;
                }
                waitSitThenPatrol(player, unit, mode);
            }

            scheduleStrategyMenuRefresh(player, unit);
            return;
        }

        // ══════════════════════════════════════════════════════
        //  退出巡逻 / 切跟随 / 切随机
        // ══════════════════════════════════════════════════════

        patrolUnits.delete(unit.id);
        unmarkPatrol(unit);

        const prevMode = unit.getDynamicProperty(DP.mode);
        unit.setDynamicProperty(DP.mode, mode);

        if (itemGated) {
            const ok = wantFollow
                ? addCommandToInventory(unit)
                : removeCommandFromInventory(unit);

            if (!ok) {
                player.sendMessage(
                    `§c切换异常：${wantFollow ? "背包已满" : "无法访问背包"}（但已退出巡逻，未卡死）`
                );
                scheduleStrategyMenuRefresh(player, unit);
                return;
            }

            system.runTimeout(() => {
                try {
                    if (!unit || !unit.isValid) return;

                    if (isFollowing(unit) === wantFollow) {
                        player.sendMessage(`§a✔ 指令已生效：${MODE_NAME[mode]}`);
                    } else {
                        player.sendMessage(
                            `§c✘ 切换未完全生效：背包 maid_command 未按预期变化（但已退出巡逻）`
                        );
                    }
                } catch (_) {}
            }, CONFIG.verifyWaitTicks);

            scheduleStrategyMenuRefresh(player, unit);
            return;
        }

        const eventId = mode === MODE.FOLLOW ? CONFIG.followEvent : CONFIG.sitEvent;

        try {
            unit.triggerEvent(eventId);
        } catch (e) {
            if (mode === MODE.FOLLOW) {
                unit.setDynamicProperty(DP.mode, prevMode ?? MODE.UNKNOWN);
            }

            player.sendMessage(`§e提示：实体未找到事件 "${eventId}"，但已退出巡逻`);
            scheduleStrategyMenuRefresh(player, unit);
            return;
        }

        pendingVerify.set(unit.id, {
            eventIds: [eventId],
            player,
            mode,
            deadline: system.currentTick + CONFIG.verifyWaitTicks,
        });

        system.runTimeout(() => {
            const p = pendingVerify.get(unit.id);
            if (!p || p.mode !== mode) return;
            pendingVerify.delete(unit.id);

            player.sendMessage(
                `§c✘ 事件 "${eventId}" 未在 ${CONFIG.verifyWaitTicks} tick 内生效（已退出巡逻，未卡死）`
            );
        }, CONFIG.verifyWaitTicks);

        scheduleStrategyMenuRefresh(player, unit);
    }

    // ══════════════════════════════════════════════════════════
    //  战术指令 UI
    // ══════════════════════════════════════════════════════════

    function statusText(status) {
        switch (status) {
            case MODE.FOLLOW:
                return "§a跟随中";
            case MODE.RANDOM:
                return "§e自由活动";
            case MODE.PATROL:
                return "§b巡逻守家中";
            default:
                return "§7未知";
        }
    }

    function openStrategyMenu(player, unit) {
        const status = getUnitStatus(unit);

        const form = new ActionFormData()
            .title("战术指令")
            .body(
                `正在指挥：${unit.nameTag || unit.typeId}\n` +
                `当前状态：${statusText(status)}`
            )
            .button(`§8【状态】${statusText(status)}`)
            .button("-跟随玩家-")
            .button("-随机移动-")
            .button("-巡逻守家-");

        form.show(player).then((res) => {
            if (res.canceled) return;

            if (res.selection === 0) {
                openStrategyMenu(player, unit);
                return;
            }

            assignStrategy(player, unit, res.selection - 1);
        }).catch(() => {});
    }

    // ══════════════════════════════════════════════════════════
    //  友方判定
    // ══════════════════════════════════════════════════════════

    function isFriendlyUnit(entity) {
        return FRIENDLY_TYPES !== null && FRIENDLY_TYPES.has(entity.typeId);
    }

    // ══════════════════════════════════════════════════════════
    //  入口：shift + 左键友方干员 → 弹 UI
    // ══════════════════════════════════════════════════════════

    world.afterEvents.entityHitEntity.subscribe(({ damagingEntity, hitEntity }) => {
        if (damagingEntity.typeId !== "minecraft:player") return;

        const player = damagingEntity;
        if (!player.isSneaking) return;
        if (!isFriendlyUnit(hitEntity)) return;
        if (CONFIG.requireTamed && !isTamed(hitEntity)) return;

        const now = system.currentTick;
        if ((uiCooldowns.get(player.id) ?? -Infinity) > now) return;
        uiCooldowns.set(player.id, now + CONFIG.uiCooldown);

        openStrategyMenu(player, hitEntity);
    });

    // ══════════════════════════════════════════════════════════
    //  globalThis 桥接：供 fictoria_ball.js 在精灵球放置后恢复状态
    // ══════════════════════════════════════════════════════════

    globalThis.FICTORIA_UI_SYNC = {
        resumeState(unit) {
            try {
                if (!unit || !unit.isValid) return;

                const m = unit.getDynamicProperty(DP.mode);

                uiLog(
                    `[FictoriaUI][桥接] 读取状态 | mode=${m} | ` +
                    `home=${unit.getDynamicProperty(DP.home) ? "有" : "无"} | ` +
                    `dim=${unit.getDynamicProperty(DP.dim) || "无"}`
                );

                if (m === MODE.PATROL) {
                    removeCommandFromInventory(unit);
                    saveHome(unit);
                    patrolUnits.add(unit.id);
                    markPatrol(unit);
                } else if (m === MODE.FOLLOW) {
                    patrolUnits.delete(unit.id);
                    unmarkPatrol(unit);
                    addCommandToInventory(unit);
                } else {
                    patrolUnits.delete(unit.id);
                    unmarkPatrol(unit);
                    removeCommandFromInventory(unit);
                }

                uiLog(`[FictoriaUI][桥接] 状态恢复: ${unit.typeId} mode=${m}`);
            } catch (e) {
                console.warn(`[FictoriaUI][桥接] 恢复失败: ${e}`);
            }
        }
    };

    console.warn("[FictoriaUI] 战术指挥系统已加载（巡逻持久化修复版）");
}

// ============================================================
// 顶层只调用一次初始化
// ============================================================
try {
    initFictoriaUI();
} catch (e) {
    console.warn(`[FictoriaUI] 初始化失败（不影响其他脚本）: ${e}`);
}