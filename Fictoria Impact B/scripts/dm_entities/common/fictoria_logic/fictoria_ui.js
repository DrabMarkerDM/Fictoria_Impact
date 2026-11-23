// fictoria_ui.js — 战术指挥 UI + 守卫（巡逻）系统。

// 巡逻单位靠 DP.home（JSON 字符串）与持久 tag 恢复，重进后自动扫描重建 patrolUnits。
// 守卫主循环校验 DP.mode；getUnitStatus 打开 UI 时补回 patrolUnits。
// 性能：配置字符串 trim、别名改 Set、背包门控去重、isRemoved → isValid、
// 实体移除时清 patrolUnits / pendingVerify、诊断日志接 CONFIG.debug。
import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import {
    registerEntityRemoveHandler,
    registerDataDrivenHandler,
    registerEntityHitHandler,
    REMOVE_PRIORITY,
    DATA_DRIVEN_PRIORITY,
    ENTITY_HIT_PRIORITY
} from "../core/event_bus.js";
import { dismountNow } from "../travel/mount_follow.js";
// 友方名单唯一来源 = manager 配置表（见 attackable_target_manager.js 里的 setFriendlyTypes）。
// 本文件不再自己 getEntities，也不再从幻域球的收纳表推断"谁算友方"。
import { FEATURE_TYPES, forEachUnitOfTypes, isFriendlyTypeId } from "../core/maid_registry.js";

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
    // 背包门控实体：跟随与否由「背包里有没有那枚道具」表达的，只有这几只。
    // 其余友方的 follow_command 是「玩家手上拿着右键」用的交互物（写在各实体 sit 组的 interact 里），
    // 背包里没有对应 sensor 去读，塞进去也没人认 —— 所以不进这张表，仍走 follow/sit 事件。
    itemGatedTypes: [
        "player:dm34",
        "player:dm34_1",
        "player:dm3",
        "player:dm12",
        "player:asuna",
        "player:kirito",
        "player:dm48",
        "player:dm32",
        "player:dm51",
        "player:dm26",
        "player:dm61",
        "player:dm52",
        "player:dm56",
        "player:dm63",
        "player:dm35",
        "player:dm50",
        "player:dm31",
        "player:dm45",
    ],
    // 指令物品分流：只列例外。dm34 系用 maid_command，**其余一律 defaultCommandItem（follow_command）**。
    // 新增门控实体不用改这里，自动落默认项。
    commandItemOverrides: {
        "player:dm34": "item:maid_command",
        "player:dm34_1": "item:maid_command",
    },
    defaultCommandItem: "item:follow_command",
    // 门控实体在「切到跟随」时补打一次跟随事件（顺序必须是先塞道具、再发事件）。
    // dm34 系靠 environment_sensor 自己切；dm3 需要它，因为坐姿期间检测组已被摘掉，
    // 光塞道具没人读，她会一直坐着不动。
    followEventByType: {
        "player:dm3": "follow",
        "player:dm12": "follow",
        "player:asuna": "follow",
        "player:kirito": "follow",
        "player:dm48": "follow",
        "player:dm32": "follow",
        "player:dm51": "follow",
        "player:dm26": "follow",
        "player:dm61": "follow",
        "player:dm52": "follow",
        "player:dm56": "follow",
        "player:dm63": "follow",
        "player:dm35": "follow",
        "player:dm50": "follow",
        "player:dm31": "follow",
        "player:dm45": "follow",
    },
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

// 骑乘 tag：和「跟随 / 随机 / 巡逻」是**不同维度**，三者不互斥，可并存。
// 只由 mount_on / mount_off 两个实体事件写入，UI 只读不写。
const RIDE_TAG = "maid:mount_ride";

// 字符串工具
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

// 常用 Set
const COMMAND_ITEM_OVERRIDES = CONFIG.commandItemOverrides ?? {};
const ITEM_GATED_SET = trimArrayToSet(CONFIG.itemGatedTypes ?? []);
const FOLLOW_ALIAS_SET = trimArrayToSet(CONFIG.followAliases);
const SIT_ALIAS_SET = trimArrayToSet(CONFIG.sitAliases);

function uiLog(...args) {
    if (CONFIG.debug) {
        console.warn(...args);
    }
}

// ---------- 友方名单 ----------
// 来源：attackable_target_manager.js 的 RAW_DmTargetRegistry（37 个配置过的干员），
// 由 setFriendlyTypes() 写进 maid_registry 的 FEATURE_TYPES.friendly，manager 每 5 tick
// 扫 dm 家族时顺手登记。本文件不再维护自己的一份类型表，也不再 getEntities。
// 幻域球收纳表（60 个）里那些没进配置表的类型，组件本来就不全，不接 UI。

const patrolUnits = new Set();
const uiCooldowns = new Map();
const pendingVerify = new Map();

// 实体移除清理
registerEntityRemoveHandler("fictoria_ui_cache", (event) => {
    try {
        const id = event.removedEntity?.id;
        if (!id) return;

        patrolUnits.delete(id);
        pendingVerify.delete(id);
    } catch (_) {}
}, REMOVE_PRIORITY.FICTORIA_UI_CACHE);

// 核心逻辑
function initFictoriaUI() {

    //  锚点存取（JSON 字符串持久化）

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

    //  巡逻 tag 管理

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

    //  2D 方形范围判定

    function pointInArea2D(x, z, minX, minZ, maxX, maxZ) {
        return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
    }

    //  单次守卫检查

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
            // 骑乘时传坐骑：对骑手 teleport 会直接打断骑乘关系（她自己掉下马）
            let tpTarget = unit;

            try {
                const rideMount = unit.getComponent("minecraft:riding")?.entityRidingOn;

                if (rideMount && rideMount.isValid) {
                    tpTarget = rideMount;
                }
            } catch (_) { }

            try {
                tpTarget.teleport(
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

    //  重进存档后巡逻恢复

    let patrolRehydrated = false;

    function rehydratePatrolUnits() {
        try {
            // 名单来自 manager 登记表（每 5 tick 全量重建），本函数零查询。
            // 原来：按 60 个友方类型各 getEntities 一次 + 一次 tag 全表查询，300 tick 一轮。
            let scanned = 0;

            forEachUnitOfTypes(FEATURE_TYPES.friendly, (unit) => {
                let mode;

                try {
                    mode = unit.getDynamicProperty(DP.mode);
                } catch (_) {
                    return;
                }

                scanned++;

                if (mode === MODE.PATROL) {
                    ensurePatrol(unit);
                }

                // tag 是持久的，mount_ride 组件组不持久：重进世界后
                // tag 还在、组没了 → UI 显示「骑乘中」却根本不找马。
                // 这里补一次 mount_on（重复 add 同一组无副作用）。
                if (isRidingMount(unit)) {
                    try {
                        unit.triggerEvent("mount_on");
                    } catch (_) {}
                }
            });

            patrolRehydrated = true;

            uiLog(
                `[FictoriaUI] 巡逻恢复完成，` +
                `扫描 ${scanned} 只 · 当前巡逻单位数: ${patrolUnits.size}`
            );
        } catch (_) {}
    }

    //  守卫主循环（30 tick）

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

    //  启动后延迟恢复

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

    //  驯服判定

    function isTamed(unit) {
        if (!unit || !unit.isValid) return false;

        if (unit.getDynamicProperty(CONFIG.ownerIdKey) !== undefined) return true;

        return (
            unit.hasComponent("minecraft:is_tamed") ||
            unit.hasTag("dm_tamed")
        );
    }

    //  背包门控工具

    function isItemGated(unit) {
        // 没背包的实体（dm26/dm32/dm48…）即使列了表也塞不进去，直接按非门控处理
        return ITEM_GATED_SET.has(unit.typeId) && unit.hasComponent("minecraft:inventory");
    }

    /** 该实体判跟随用的那枚道具：dm34 系走例外表，其余一律 follow_command */
    function commandIdOf(unit) {
        return COMMAND_ITEM_OVERRIDES[unit.typeId] ?? CONFIG.defaultCommandItem;
    }

    /** 道具短名，只用于聊天提示 */
    function commandName(itemId) {
        return String(itemId ?? "").replace(/^item:/, "");
    }

    function hasFollowComponent(unit) {
        return CONFIG.followComponent && unit.hasComponent(CONFIG.followComponent);
    }

    function inventoryHasCommand(unit) {
        const want = commandIdOf(unit);
        if (!want) return false;

        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;

        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === want) {
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

    // 跟随判据就是包里这枚道具，取走后切回「跟随」必须补发一枚。
    function addCommandToInventory(unit) {
        const want = commandIdOf(unit);
        if (!want) return false;

        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;

        let emptySlot = -1;

        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === want) {
                return true;
            }
            if (emptySlot === -1 && it === undefined) {
                emptySlot = i;
            }
        }

        if (emptySlot !== -1) {
            inv.setItem(emptySlot, new ItemStack(want, 1));
            return true;
        }

        return false;
    }

    // 扣掉包里全部命令道具（沿用旧包行为：逐格扫，命中即清空整格）。
    function removeCommandFromInventory(unit) {
        const want = commandIdOf(unit);
        if (!want) return false;

        const inv = unit.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;

        let removed = false;
        let hasCommand = false;

        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (it && it.typeId === want) {
                hasCommand = true;
                inv.setItem(i, undefined);
                removed = true;
            }
        }

        return removed || !hasCommand;
    }

    //  状态检测
    //  打开 UI 时如果 DP.mode 是 PATROL 而 patrolUnits 里没有它，补回一次，防止重进后丢失。

    function getUnitStatus(unit) {
        if (!unit || !unit.isValid) return MODE.UNKNOWN;

        if (isFollowing(unit)) return MODE.FOLLOW;

        const jsMode = unit.getDynamicProperty(DP.mode);

        if (!isItemGated(unit) && jsMode === MODE.FOLLOW) {
            return MODE.FOLLOW;
        }

        if (jsMode === MODE.PATROL || patrolUnits.has(unit.id)) {
            // 打开 UI 时补回 patrolUnits
            if (jsMode === MODE.PATROL) {
                patrolUnits.add(unit.id);
                markPatrol(unit);
            }
            return MODE.PATROL;
        }

        if (jsMode === MODE.RANDOM) return MODE.RANDOM;

        return MODE.UNKNOWN;
    }

    //  骑乘（独立维度）
    //  和 MODE（跟随/随机/巡逻）是两条正交的轴：可以「跟随中 + 骑乘中」。
    //  开关只碰 mount_ride 组件组，**不写 DP.mode**，所以不会互相覆盖。

    function isRidingMount(unit) {
        if (!unit || !unit.isValid) return false;
        try {
            return unit.hasTag(RIDE_TAG);
        } catch (_) {
            return false;
        }
    }

    function toggleRide(player, unit) {
        if (!unit || !unit.isValid) {
            player.sendMessage("§c骑乘切换失败：目标已失效");
            return;
        }

        const on = isRidingMount(unit);

        try {
            unit.triggerEvent(on ? "mount_off" : "mount_on");
        } catch (e) {
            player.sendMessage(`§c骑乘切换失败：实体未找到事件（${e.message}）`);
            return;
        }

        if (on) {
            // mount_off 里的 `ride @s stop_riding` 走 queue_command，单发一次有失败可能
            // （马身旁没落点、区块刚加载）。这里在下马指令之外再兜一层重试，
            // 否则表现就是「点了解除，她还在马上」。
            dismountNow(unit);
            player.sendMessage("§7[骑乘] 已解除，她不再主动寻找坐骑");
        } else {
            player.sendMessage("§b[骑乘] 已启用，附近 16 格内有可骑的生物（马 / 驴 / 猪 / 羊驼…）就会骑上去");
        }

        //  tag 由 mount_on 的 queue_command 写入，下一 tick 才落地，
        //  所以要等几 tick 再重开，否则菜单读到的还是旧状态。
        system.runTimeout(() => {
            try {
                if (player && player.isValid && unit && unit.isValid) {
                    openStrategyMenu(player, unit);
                }
            } catch (_) {}
        }, 3);
    }

    //  JS 层状态落盘（含 tag 管理）

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

    //  周期互斥同步

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

    //  全局监听 dataDrivenEntityTrigger

    registerDataDrivenHandler("fictoria_ui_data_driven", ({ entity, eventId }) => {
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
    }, DATA_DRIVEN_PRIORITY.FICTORIA_UI);

    //  切换指令 + 验证反馈

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

        //  进入巡逻

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
                        player.sendMessage(
                            `§c指令失败：背包已满，无法放入 ${commandName(commandIdOf(unit))}`
                        );
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

        //  退出巡逻 / 切跟随 / 切随机

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

            // 先塞道具、再发事件，顺序不能反 —— 反了会被 follow_2（背包无指令）立刻打回待命。
            // 需要这一下的原因：坐姿期间检测组已被摘掉，只塞道具没有任何东西会去读它。
            if (wantFollow) {
                const followEv = CONFIG.followEventByType?.[unit.typeId];
                if (followEv) {
                    try {
                        unit.triggerEvent(followEv);
                    } catch (_) {
                        // 实体没有这个事件就跳过，道具已经在包里，sensor 会自己接上
                    }
                }
            }

            system.runTimeout(() => {
                try {
                    if (!unit || !unit.isValid) return;

                    if (isFollowing(unit) === wantFollow) {
                        player.sendMessage(`§a✔ 指令已生效：${MODE_NAME[mode]}`);
                    } else {
                        player.sendMessage(
                            `§c✘ 切换未完全生效：背包 ${commandName(commandIdOf(unit))} 未按预期变化（但已退出巡逻）`
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

    //  战术指令 UI

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
        const riding = isRidingMount(unit);

        const form = new ActionFormData()
            .title("战术指令")
            .body(
                `正在指挥：${unit.nameTag || unit.typeId}\n` +
                `当前状态：${statusText(status)}\n` +
                `骑乘模式：${riding ? "§b骑乘中" : "§7未启用"}\n` +
                `§8（骑乘是独立开关，与上面三项互不冲突，可同时存在）`
            )
            .button(`§8【状态】${statusText(status)}`)
            .button("-跟随玩家-", "textures/ui/follow_mode")
            .button("-随机移动-", "textures/ui/random_mode")
            .button("-巡逻守家-", "textures/ui/patrol_mode")
            .button(riding ? "§8-解除骑乘-" : "§b-骑乘模式-", "textures/ui/ride_mode");

        form.show(player).then((res) => {
            if (res.canceled) return;

            if (res.selection === 0) {
                openStrategyMenu(player, unit);
                return;
            }

            // 第 5 个按钮是骑乘开关：不走 assignStrategy，不碰 MODE。
            if (res.selection === 4) {
                toggleRide(player, unit);
                return;
            }

            assignStrategy(player, unit, res.selection - 1);
        }).catch(() => {});
    }

    //  友方判定

    function isFriendlyUnit(entity) {
        // 判定表 = manager 配置表（37 个干员）。配置表里没有的实体本来组件就不全，
        // 面板上的指令发下去也执行不了，所以不认。
        return isFriendlyTypeId(entity.typeId);
    }

    //  入口：shift + 左键友方干员 → 弹 UI

    registerEntityHitHandler("fictoria_ui_menu", ({ damagingEntity, hitEntity }) => {
        if (damagingEntity.typeId !== "minecraft:player") return;

        const player = damagingEntity;
        if (!player.isSneaking) return;
        if (!isFriendlyUnit(hitEntity)) return;
        if (CONFIG.requireTamed && !isTamed(hitEntity)) return;

        const now = system.currentTick;
        if ((uiCooldowns.get(player.id) ?? -Infinity) > now) return;
        uiCooldowns.set(player.id, now + CONFIG.uiCooldown);

        openStrategyMenu(player, hitEntity);
    }, ENTITY_HIT_PRIORITY.FICTORIA_UI);

    //  globalThis 桥接：供 fictoria_ball.js 在精灵球放置后恢复状态

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

    // 启动横幅默认打开；其余 UI 日志仍归 CONFIG.debug
    console.warn("[FictoriaUI] 战术指挥系统已加载（巡逻持久化修复版）");
}

// 顶层只调用一次初始化
try {
    initFictoriaUI();
} catch (e) {
    console.warn(`[FictoriaUI] 初始化失败（不影响其他脚本）: ${e}`);
}