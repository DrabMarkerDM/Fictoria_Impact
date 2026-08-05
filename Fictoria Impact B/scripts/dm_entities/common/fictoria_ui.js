// ============================================================
// fictoria_ui.js — 战术指挥 UI + 守卫（巡逻）系统（防崩 v5.8）
// 适用 SAPI：@minecraft/server 2.7.0 / @minecraft/server-ui 2.0.0
//
// v5.8 新增：精灵球状态恢复桥接
//   · 暴露 globalThis.FICTORIA_UI_SYNC.resumeState(unit)
//   · 供 fictoria_ball.js 放置干员后恢复战术状态
//   · 巡逻恢复时以【放置位置】为新锚点（无条件 saveHome）
//   · 跟随恢复时补放 maid_command / 随机&巡逻清空物品
//
// v5.7 未驯服不弹 UI；v5.6 驯服前置；v5.5 防死锁；
// v5.3 精确空操作判断；v5.2 背包真值验证；
// v5 背包门控（dm34/dm34_1 专属）
// ============================================================
import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

// ---------- 配置区 ----------
const CONFIG = {
    homeRadius: 32,          // 巡逻/守家半径（2D 方形半宽）
    checkInterval: 30,       // 守卫传送检查间隔（tick）
    statusCheckTicks: 20,    // 状态周期检测间隔（tick）
    uiCooldown: 10,          // UI 防连点冷却（tick）
    verifyWaitTicks: 10,     // 验证等待（tick）

    // ★ 驯服前置
    requireTamed: true,      // true=必须已驯服才能下达指令 / 未驯服不弹 UI
    ownerIdKey: "ownerId",   // 驯服动态属性键（与 attackable_target_manager.js 一致）

    followComponent: "minecraft:behavior.follow_owner", // 仅非门控实体用

    // 事件名（仅非门控实体 triggerEvent 用）
    followEvent: "follow",
    sitEvent: "sit",
    // 事件别名：兼容传感器新旧命名
    followAliases: ["follow", "follow_1"],
    sitAliases: ["sit", "follow_2"],

    // ★ 走"背包门控"的实体
    itemGatedEntities: ["player:dm34", "player:dm34_1"],
    maidCommandId: "item:maid_command",

    debug: false,            // 调试日志
};

const MODE = { FOLLOW: 0, RANDOM: 1, PATROL: 2, UNKNOWN: -1 };
const MODE_NAME = ["跟随玩家", "随机移动", "巡逻守家"];

const DP = {
    home: "fictoria_ui:home",
    dim:  "fictoria_ui:home_dim",
    mode: "fictoria_ui:mode",
};

// ---------- 从 globalThis 读取三张配置表（fictoria_ball.js 注册） ----------
let FRIENDLY_TYPES = null;
try {
    const t = globalThis.FICTORIA_BALL_TYPES;
    if (t && Array.isArray(t.gold) && Array.isArray(t.blue) && Array.isArray(t.green)) {
        FRIENDLY_TYPES = new Set([...t.gold, ...t.blue, ...t.green]);
    } else {
        console.warn("[FictoriaUI] 未找到 globalThis.FICTORIA_BALL_TYPES，" +
            "请确认 fictoria_ball.js 已先加载。UI 将临时禁用友方判定。");
    }
} catch (e) {
    console.warn(`[FictoriaUI] 读取配置失败: ${e}`);
}

const patrolUnits = new Set();    // 巡逻单位 id 集合
const uiCooldowns = new Map();    // 玩家 UI 冷却
const pendingVerify = new Map();  // entityId -> { eventIds[], player, mode, deadline }

// ============================================================
//  核心逻辑
// ============================================================
function initFictoriaUI() {
    // --- 锚点存取 ---
    function saveHome(unit) {
        const l = unit.location;
        unit.setDynamicProperty(DP.home, { x: l.x, y: l.y, z: l.z });
        unit.setDynamicProperty(DP.dim, unit.dimension.id);
    }

    // --- 2D 方形范围判定 ---
    function pointInArea2D(x, z, minX, minZ, maxX, maxZ) {
        return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
    }

    // --- 单次守卫检查 ---
    function guardCheck(unit) {
        const home = unit.getDynamicProperty(DP.home);
        const dim  = unit.getDynamicProperty(DP.dim);
        if (!home || !dim) { saveHome(unit); return; }

        let inHome = unit.dimension.id === dim;
        if (inHome) {
            inHome = pointInArea2D(unit.location.x, unit.location.z,
                home.x - CONFIG.homeRadius, home.z - CONFIG.homeRadius,
                home.x + CONFIG.homeRadius, home.z + CONFIG.homeRadius);
        }
        if (!inHome) {
            try {
                unit.teleport({ x: home.x, y: home.y, z: home.z },
                    { dimension: world.getDimension(dim) });
            } catch { /* 目标维度已卸载，忽略 */ }
        }
    }

    // --- 守卫主循环（30 tick）---
    system.runInterval(() => {
        if (patrolUnits.size === 0) return;
        for (const id of [...patrolUnits]) {
            const unit = world.getEntity(id);
            if (!unit || unit.isRemoved) { patrolUnits.delete(id); continue; }
            guardCheck(unit);
        }
    }, CONFIG.checkInterval);

    // ============================================================
    // ★ 驯服判定（前置条件）
    //   与 attackable_target_manager.js 共用 ownerId 动态属性
    // ============================================================
    function isTamed(unit) {
        if (!unit || !unit.isValid) return false;
        // 主判定：manager 驯服时写入的 ownerId
        if (unit.getDynamicProperty(CONFIG.ownerIdKey) !== undefined) return true;
        // 兜底：is_tamed 组件 / dm_tamed 标签
        return unit.hasComponent("minecraft:is_tamed") || unit.hasTag("dm_tamed");
    }

    // ============================================================
    // ★ 背包门控工具（喂/清 maid_command）
    // ============================================================

    /** JSON 层跟随特征组件是否存在（仅非门控实体可靠） */
    function hasFollowComponent(unit) {
        return CONFIG.followComponent && unit.hasComponent(CONFIG.followComponent);
    }

    /** 背包中是否已有 maid_command */
    function inventoryHasCommand(unit) {
        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;
        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === CONFIG.maidCommandId) return true;
        }
        return false;
    }

    /** 状态真值判定：门控实体看背包，其他实体看组件 */
    function isFollowing(unit) {
        if (CONFIG.itemGatedEntities.includes(unit.typeId)) {
            return inventoryHasCommand(unit);
        }
        return hasFollowComponent(unit);
    }

    /** 放入 1 个 maid_command（已有则不动）→ 触发传感器进入跟随 */
    function addCommandToInventory(unit) {
        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;
        if (inventoryHasCommand(unit)) return true;
        for (let i = 0; i < inv.size; i++) {
            if (inv.getItem(i) === undefined) {
                inv.setItem(i, new ItemStack(CONFIG.maidCommandId, 1));
                return true;
            }
        }
        return false;
    }

    /** 清空背包里的 maid_command → 触发传感器取消跟随 */
    function removeCommandFromInventory(unit) {
        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;
        let removed = false;
        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === CONFIG.maidCommandId) {
                inv.setItem(i, undefined);
                removed = true;
            }
        }
        return removed || !inventoryHasCommand(unit);
    }

    // ============================================================
    //  C. 状态检测（背包真值优先）
    // ============================================================
    function getUnitStatus(unit) {
        if (!unit || !unit.isValid) return MODE.UNKNOWN;
        // ★ v5.9 修复：FOLLOW 只认"真实真值"（follow_owner 组件 / 背包 maid_command），
        //   不认 JS 乐观落盘的 DP.mode——实体没有 follow 事件/组件时，
        //   即使 UI 按过"跟随玩家"（DP.mode 被乐观写为 FOLLOW），状态栏也不再误显示"跟随中"
        if (isFollowing(unit)) return MODE.FOLLOW;
        const jsMode = unit.getDynamicProperty(DP.mode);
        if (jsMode === MODE.PATROL || patrolUnits.has(unit.id)) return MODE.PATROL;
        if (jsMode === MODE.RANDOM) return MODE.RANDOM;
        return MODE.UNKNOWN;
    }

    // --- JS 层状态落盘 ---
    function applyJsState(unit, mode) {
        switch (mode) {
            case MODE.FOLLOW:
                patrolUnits.delete(unit.id);
                unit.setDynamicProperty(DP.mode, MODE.FOLLOW);
                break;
            case MODE.RANDOM:
                patrolUnits.delete(unit.id);
                unit.setDynamicProperty(DP.mode, MODE.RANDOM);
                break;
            case MODE.PATROL:
                saveHome(unit);
                unit.setDynamicProperty(DP.mode, MODE.PATROL);
                patrolUnits.add(unit.id);
                break;
            default:
                break;
        }
    }

    // --- 周期互斥同步（外部触发 follow → 自动移出巡逻名单）---
    system.runInterval(() => {
        for (const id of [...patrolUnits]) {
            const unit = world.getEntity(id);
            if (!unit || unit.isRemoved) { patrolUnits.delete(id); continue; }
            if (isFollowing(unit)) {
                patrolUnits.delete(id);
                unit.setDynamicProperty(DP.mode, MODE.FOLLOW);
            }
        }
    }, CONFIG.statusCheckTicks);

    // ============================================================
    // ★ 全局监听 dataDrivenEntityTrigger（验证 + 互斥同步）
    // ============================================================
    world.afterEvents.dataDrivenEntityTrigger.subscribe(({ entity, eventId }) => {
        if (!entity || !entity.isValid) return;

        // debug：打印门控实体实际收到的事件名
        if (CONFIG.debug && CONFIG.itemGatedEntities.includes(entity.typeId)) {
            try {
                console.warn(`[FictoriaUI][调试] 收到事件: ${eventId} (${entity.typeId})`);
            } catch {}
        }

        // ① 验证（巡逻进入的 sit 确认 / 非门控切换都走这里）
        const p = pendingVerify.get(entity.id);
        if (p && p.eventIds.includes(eventId) && system.currentTick <= p.deadline) {
            pendingVerify.delete(entity.id);
            applyJsState(entity, p.mode);
            p.player.sendMessage(`§a✔ 指令已生效：${MODE_NAME[p.mode]}`);
            return;
        }

        // ② 全局互斥同步：任意来源触发的模式事件
        if (CONFIG.followAliases.includes(eventId)) {
            patrolUnits.delete(entity.id);
            entity.setDynamicProperty(DP.mode, MODE.FOLLOW);
            return;
        }
        if (CONFIG.sitAliases.includes(eventId)) {
            patrolUnits.delete(entity.id);
            if (entity.getDynamicProperty(DP.mode) === MODE.FOLLOW) {
                entity.setDynamicProperty(DP.mode, MODE.RANDOM);
            }
        }
    });

    // ============================================================
    //  A. 切换指令 + 验证反馈（v5.7 · 驯服前置 + 防死锁）
    // ============================================================

    /** 等待 sit 类事件确认后激活巡逻（等不到 → 巡逻不激活） */
    function waitSitThenPatrol(player, unit, mode) {
        pendingVerify.set(unit.id, {
            eventIds: CONFIG.sitAliases.slice(),   // ["sit","follow_2"]
            player, mode,
            deadline: system.currentTick + CONFIG.verifyWaitTicks,
        });
        system.runTimeout(() => {
            const p = pendingVerify.get(unit.id);
            if (!p || p.mode !== mode) return;     // 已成功
            pendingVerify.delete(unit.id);
            player.sendMessage(`§c✘ 巡逻未激活：该实体未检测到 sit 事件（可能不具备取消跟随能力），已保持原状态`);
        }, CONFIG.verifyWaitTicks);
    }

    function assignStrategy(player, unit, mode) {
        const itemGated = CONFIG.itemGatedEntities.includes(unit.typeId);
        const wantFollow = (mode === MODE.FOLLOW);

        // ★ 驯服前置：必须已驯服才能下达战术指令（二次拦截，兜底）
        if (CONFIG.requireTamed && !isTamed(unit)) {
            player.sendMessage(`§c指令失败：该实体未驯服，无法下达战术指令`);
            return;
        }

        let before = [];
        if (CONFIG.debug) {
            try { before = unit.getComponents().map(c => c.typeId).sort(); } catch {}
        }

        // 0) 精确空操作判断（杜绝误报）
        if (getUnitStatus(unit) === mode) {
            player.sendMessage(`§7[状态] 该干员已是${MODE_NAME[mode]}状态，无需切换`);
            return;
        }

        // ============================================================
        // 【进入巡逻】严格事件验证：必须收到 sit 事件才激活（防无能力实体进入）
        // ============================================================
        if (mode === MODE.PATROL) {
            const wasFollowing = isFollowing(unit);

            if (itemGated) {
                if (wasFollowing) {
                    // 本在跟随：清物品 → 传感器触发 sit → 等确认
                    if (!removeCommandFromInventory(unit)) {
                        player.sendMessage(`§c指令失败：无法访问该干员背包`);
                        return;
                    }
                    waitSitThenPatrol(player, unit, mode);
                } else {
                    // 本在随机：先放 1 个触发 follow，下一 tick 清触发 sit → 制造完整事件链
                    if (!addCommandToInventory(unit)) {
                        player.sendMessage(`§c指令失败：背包已满，无法放入 maid_command`);
                        return;
                    }
                    system.runTimeout(() => {
                        try {
                            if (!unit || unit.isRemoved) return;
                            removeCommandFromInventory(unit);
                            waitSitThenPatrol(player, unit, mode);
                        } catch {}
                    }, 2);
                }
            } else {
                // 非门控：触发 sit 事件
                try {
                    unit.triggerEvent(CONFIG.sitEvent);
                } catch (e) {
                    player.sendMessage(`§c巡逻未激活：实体未找到事件 "${CONFIG.sitEvent}"（${e.message}）`);
                    return;
                }
                waitSitThenPatrol(player, unit, mode);
            }
            return;
        }

        // ============================================================
        // 【退出巡逻 / 切跟随 / 切随机】无条件放行（防卡死）
        // 立即移出巡逻名单 + 落盘 JS 状态，事件只是附带动作
        // ============================================================
        patrolUnits.delete(unit.id);
        const prevMode = unit.getDynamicProperty(DP.mode);
        unit.setDynamicProperty(DP.mode, mode);

        // 执行状态切换
        if (itemGated) {
            const ok = wantFollow
                ? addCommandToInventory(unit)
                : removeCommandFromInventory(unit);
            if (!ok) {
                player.sendMessage(`§c切换异常：${wantFollow ? "背包已满" : "无法访问背包"}（但已退出巡逻，未卡死）`);
                return;
            }
            // 背包真值验证（仅提示性，不影响已退出的巡逻）
            system.runTimeout(() => {
                try {
                    if (!unit || unit.isRemoved) return;
                    if (isFollowing(unit) === wantFollow) {
                        player.sendMessage(`§a✔ 指令已生效：${MODE_NAME[mode]}`);
                    } else {
                        player.sendMessage(`§c✘ 切换未完全生效：背包 maid_command 未按预期变化（但已退出巡逻）`);
                    }
                } catch {}
            }, CONFIG.verifyWaitTicks);
        } else {
            // 非门控：触发事件（无事件也只是提示，绝不卡死）
            const eventId = mode === MODE.FOLLOW ? CONFIG.followEvent : CONFIG.sitEvent;
            try {
                unit.triggerEvent(eventId);
            } catch (e) {
                // ★ v5.9 事件不存在时回滚乐观状态：防止"假跟随"（DP.mode 被误标为 FOLLOW）
                if (mode === MODE.FOLLOW) {
                    unit.setDynamicProperty(DP.mode, prevMode ?? MODE.UNKNOWN);
                }
                player.sendMessage(`§e提示：实体未找到事件 "${eventId}"，但已退出巡逻`);
                return;
            }
            pendingVerify.set(unit.id, {
                eventIds: [eventId],
                player, mode,
                deadline: system.currentTick + CONFIG.verifyWaitTicks,
            });
            system.runTimeout(() => {
                const p = pendingVerify.get(unit.id);
                if (!p || p.mode !== mode) return;
                pendingVerify.delete(unit.id);
                player.sendMessage(
                    `§c✘ 事件 "${eventId}" 未在 ${CONFIG.verifyWaitTicks} tick 内生效（已退出巡逻，未卡死）`);
            }, CONFIG.verifyWaitTicks);
        }
    }

    // ============================================================
    //  B. 战术指令 UI（含状态显示按钮）
    // ============================================================
    function statusText(status) {
        switch (status) {
            case MODE.FOLLOW: return "§a跟随中";
            case MODE.RANDOM: return "§e自由活动";
            case MODE.PATROL: return "§b巡逻守家中";
            default:          return "§7未知";
        }
    }

    function openStrategyMenu(player, unit) {
        const status = getUnitStatus(unit);

        const form = new ActionFormData()
            .title("战术指令")
            .body(`正在指挥：${unit.nameTag || unit.typeId}\n当前状态：${statusText(status)}`)
            .button(`§8【状态】${statusText(status)}`)
            .button("-跟随玩家-")
            .button("-随机移动-")
            .button("-巡逻守家-");

        form.show(player).then((res) => {
            if (res.canceled) return;
            if (res.selection === 0) {
                player.sendMessage(`§7[状态] ${unit.nameTag || unit.typeId}：${statusText(getUnitStatus(unit))}`);
                return;
            }
            assignStrategy(player, unit, res.selection - 1);
        }).catch(() => {});
    }

    // --- 友方判定 ---
    function isFriendlyUnit(entity) {
        return FRIENDLY_TYPES !== null && FRIENDLY_TYPES.has(entity.typeId);
    }

    // --- 入口：shift + 左键友方干员 → 弹 UI ---
    world.afterEvents.entityHitEntity.subscribe(({ damagingEntity, hitEntity }) => {
        if (damagingEntity.typeId !== "minecraft:player") return;
        const player = damagingEntity;
        if (!player.isSneaking) return;
        if (!isFriendlyUnit(hitEntity)) return;

        // ★ 未驯服单位不弹 UI（直接拦截，不给反馈也不弹窗）
        if (CONFIG.requireTamed && !isTamed(hitEntity)) return;

        const now = system.currentTick;
        if ((uiCooldowns.get(player.id) ?? -Infinity) > now) return;
        uiCooldowns.set(player.id, now + CONFIG.uiCooldown);

        openStrategyMenu(player, hitEntity);
    });

    // ============================================================
    // ★ v5.8 globalThis 桥接：供 fictoria_ball.js 在精灵球放置后恢复状态
    //   零 import 耦合（与 FICTORIA_BALL_TYPES 同理）
    // ============================================================
    globalThis.FICTORIA_UI_SYNC = {
        /**
         * 精灵球放置后调用：根据实体的 DP.mode 恢复完整战术状态
         * 巡逻恢复时以【放置位置】为新锚点（无条件 saveHome）
         * @param {Entity} unit 放置出来的干员
         */
        resumeState(unit) {
            try {
                if (!unit || !unit.isValid) return;
                const m = unit.getDynamicProperty(DP.mode);
                const home = unit.getDynamicProperty(DP.home);
                const dim = unit.getDynamicProperty(DP.dim);
                // 诊断：打全三个键的实际值，防止再次出现键错位问题
                console.warn(`[FictoriaUI][桥接] 读取状态 | mode=${m} | home=${home ? "有" : "无"} | dim=${dim || "无"}`);
                if (m === MODE.PATROL) {
                    // 巡逻：非跟随（清空物品）+ 以放置位置为新锚点 + 重新登记名单
                    removeCommandFromInventory(unit);
                    saveHome(unit);                        // 放置位置成为新锚点
                    patrolUnits.add(unit.id);
                } else if (m === MODE.FOLLOW) {
                    // 跟随：背包放 maid_command（门控真值，防传感器撤销）
                    patrolUnits.delete(unit.id);
                    addCommandToInventory(unit);
                } else {
                    // 随机/未知：确保清空物品，移出名单
                    patrolUnits.delete(unit.id);
                    removeCommandFromInventory(unit);
                }
                console.warn(`[FictoriaUI][桥接] 状态恢复: ${unit.typeId} mode=${m}`);
            } catch (e) {
                console.warn(`[FictoriaUI][桥接] 恢复失败: ${e}`);
            }
        }
    };

    console.warn("[FictoriaUI] 战术指挥系统已加载 ");
}

// ============================================================
//  顶层只调用一次初始化，全部异常吞掉——绝不拖垮其他脚本
// ============================================================
try {
    initFictoriaUI();
} catch (e) {
    console.warn(`[FictoriaUI] 初始化失败（不影响其他脚本）: ${e}`);
}