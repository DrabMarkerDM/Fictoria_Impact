import { system, world } from "@minecraft/server";

// ============================================================
// 世界会话防线
//
// 每次重进存档、或者执行 /reload，这个变量都会被重新初始化。
// 用于清理旧会话缓存，重新探测时钟轨道。
// ============================================================
const CURRENT_WORLD_SESSION = Math.floor(Math.random() * 1000000) + 1;

// ============================================================
// 日志开关
//
// false：关闭时钟诊断日志，性能更好
// true：输出时钟熔断、初始化等日志
// ============================================================
const DEBUG_CLOCK = false;

function clockLog(...args) {
    if (DEBUG_CLOCK) {
        console.warn(...args);
    }
}

// ============================================================
// 时钟常量
// ============================================================

// 每个轨道触发周期：20 tick = 1 秒
const TRIGGER_INTERVAL = 20;

// 调度器步进：5 tick
// 与原 DmTargetEngine.update 的 5 tick 步长保持一致
const SCHEDULER_STEP = 5;

// 相位数量：
// 20 tick / 5 tick = 4 个相位
const PHASE_COUNT = 4;

// ============================================================
// 缓存区
// ============================================================

// 所有注册过的时钟实体缓存
// key: unit.id
const ClockRegistry = new Map();

// 当前有时钟任务需要运行的实体
// key: unit.id
const ActiveClockEntries = new Map();

// ============================================================
// 实体移除清理
//
// 防止实体死亡、被幻域球收回、被 /kill 后缓存残留。
// ============================================================
try {
    world.beforeEvents.entityRemove.subscribe((event) => {
        try {
            const id = event.removedEntity?.id;

            if (!id) return;

            ClockRegistry.delete(id);
            ActiveClockEntries.delete(id);
        } catch (_) {}
    });
} catch (_) {}

// ============================================================
// 工具函数
// ============================================================

function hashPhase(id) {
    try {
        let hash = 0;

        const str = String(id);

        for (let i = 0; i < str.length; i++) {
            hash = (hash + str.charCodeAt(i)) | 0;
        }

        return Math.abs(hash) % PHASE_COUNT;
    } catch (_) {
        return 0;
    }
}

function clearEntryDues(entry) {
    if (!entry) return;

    entry.mainDue = undefined;
    entry.extDue = {};
}

function removeClockEntry(id) {
    if (!id) return;

    ClockRegistry.delete(id);
    ActiveClockEntries.delete(id);
}

function getOrCreateEntry(unit) {
    const id = unit.id;

    let entry = ClockRegistry.get(id);

    if (!entry) {
        entry = {
            id,
            typeId: unit.typeId,

            // 实体引用，由 execute 更新。
            // 调度器优先使用这个引用，避免频繁 world.getEntity。
            entity: unit,

            // 会话
            session: 0,

            // 轨道模式：single / multi
            trackMode: undefined,

            // 多轨列表，例如 [1, 3, 6]
            activeTracks: [],

            // 多轨状态，例如 { 1: "on", 3: "off" }
            trackStates: {},

            // 相位偏移：0 ~ 3
            // 用于错开大量单位的 dm_scores 触发时间
            phaseOffset: hashPhase(id),

            // 主轨是否被熔断
            mainDisabled: false,

            // 主轨下一次触发 tick
            mainDue: undefined,

            // 扩展轨下一次触发 tick
            extDue: {},

            // 扩展轨是否被熔断
            extDisabled: {},

            // 当前激活的扩展轨列表，由 execute 更新
            extOn: [],

            // 主轨当前是否允许运行，由 execute 更新
            mainActive: false,

            // 最近一次被 DmTargetEngine 驱动到的 tick
            lastSeenTick: 0
        };

        ClockRegistry.set(id, entry);
    }

    return entry;
}

// ============================================================
// 轨道探测
//
// 用于首次会话刷新时判断 single / multi。
// ============================================================
function detectTracks(unit) {
    const activeTracks = [];
    const trackStates = {};

    for (let i = 1; i <= 9; i++) {
        try {
            const propValue = unit.getProperty(`dm:clock_time_${i}`);

            if (propValue !== undefined) {
                activeTracks.push(i);
                trackStates[i] = propValue;
            }
        } catch (_) {
            break;
        }
    }

    const trackMode = activeTracks.length > 0 ? "multi" : "single";

    return {
        activeTracks,
        trackStates,
        trackMode
    };
}

// ============================================================
// ★ 修复核心：
// 每次 execute 都刷新扩展轨状态。
//
// 原版逻辑就是每 5 tick 重新读取：
// dm:clock_time_1 ~ dm:clock_time_9
//
// 上一版优化把这里缓存了，
// 导致行为包运行中把轨道从 off 切成 on 时，
// JS 层仍然认为它是 off，扩展轨全部不运行。
//
// 现在恢复为：
// 多轨实体每次 execute 都重新读取扩展轨状态。
// ============================================================
function refreshExtensionTracks(unit, entry) {
    if (entry.trackMode !== "multi") {
        entry.activeTracks = [];
        entry.trackStates = {};
        return;
    }

    const activeTracks = [];
    const trackStates = {};

    for (let i = 1; i <= 9; i++) {
        try {
            const propValue = unit.getProperty(`dm:clock_time_${i}`);

            if (propValue !== undefined) {
                activeTracks.push(i);
                trackStates[i] = propValue;
            }
        } catch (_) {
            break;
        }
    }

    entry.activeTracks = activeTracks;
    entry.trackStates = trackStates;
}

// ============================================================
// 会话与轨道缓存刷新
// ============================================================
function ensureSession(unit, entry) {
    try {
        const entityLastSession = unit.getDynamicProperty("dm:last_session_id");

        const needRefresh =
            entry.session !== CURRENT_WORLD_SESSION ||
            entityLastSession !== CURRENT_WORLD_SESSION ||
            !entry.trackMode;

        if (!needRefresh) return;

        // 会话刷新：清除主轨熔断标记
        unit.setDynamicProperty("dm:clock_main_track_disabled", undefined);

        entry.mainDisabled = false;
        entry.mainActive = false;
        entry.mainDue = undefined;

        entry.extDue = {};
        entry.extDisabled = {};
        entry.extOn = [];

        // 首次探测轨道，判断 single / multi
        const detected = detectTracks(unit);

        entry.activeTracks = detected.activeTracks;
        entry.trackStates = detected.trackStates;
        entry.trackMode = detected.trackMode;

        entry.session = CURRENT_WORLD_SESSION;

        unit.setDynamicProperty("dm:clock_track_mode", entry.trackMode);
        unit.setDynamicProperty("dm:last_session_id", CURRENT_WORLD_SESSION);

        clockLog(
            `[DM-Clock] ${unit.typeId} 会话刷新 | 模式=${entry.trackMode} | 扩展轨=${entry.activeTracks.join(",") || "无"}`
        );
    } catch (e) {
        console.error(`[DM-Clock] 会话刷新异常 (${unit.typeId}): ${e}`);
    }
}

// ============================================================
// 主轨触发
// ============================================================
function triggerMainTrack(unit, entry) {
    try {
        unit.triggerEvent("dm_scores");
    } catch (e) {
        const errMsg = String(e && e.message ? e.message : e);

        if (errMsg.includes("does not exist")) {
            // 事件不存在：
            // 例如某些实体只有 dm_scores_1 / dm_scores_6，没有 dm_scores。
            entry.mainDisabled = true;
            entry.mainDue = undefined;

            try {
                unit.setDynamicProperty("dm:clock_main_track_disabled", 1);
            } catch (_) {}

            clockLog(`[DM-Clock] ${unit.typeId} 缺少 dm_scores 事件 → 本会话熔断主时钟轨`);
        } else {
            console.error(`[DM-Clock] 主轨触发异常（非缺事件，不熔断）: ${errMsg}`);
        }
    }
}

// ============================================================
// 扩展轨触发
// ============================================================
function triggerExtensionTrack(unit, entry, trackIndex) {
    try {
        unit.triggerEvent(`dm_scores_${trackIndex}`);
    } catch (e) {
        const errMsg = String(e && e.message ? e.message : e);

        if (errMsg.includes("does not exist")) {
            // 扩展轨事件不存在：
            // 熔断该扩展轨，防止每 20 tick 重复报错。
            entry.extDisabled[trackIndex] = true;
            entry.extDue[trackIndex] = undefined;

            clockLog(
                `[DM-Clock] ${unit.typeId} 缺少 dm_scores_${trackIndex} 事件 → 本会话熔断该扩展轨`
            );
        } else {
            console.error(
                `[DM-Clock] 扩展轨 dm_scores_${trackIndex} 触发异常（非缺事件，不熔断）: ${errMsg}`
            );
        }
    }
}

// ============================================================
// 全局时钟调度器
//
// 每 5 tick 运行一次。
// 只处理最近被 DmTargetEngine 驱动过、并且当前有时钟任务的实体。
// ============================================================
system.runInterval(() => {
    try {
        const now = system.currentTick;

        for (const id of Array.from(ActiveClockEntries.keys())) {
            const entry = ActiveClockEntries.get(id);

            if (!entry) continue;

            // 如果该实体最近没有被目标引擎驱动，
            // 说明它可能不在活跃维度，或者已经不再参与主循环。
            // 为避免改变原逻辑，这里不继续驱动时钟。
            if (now - entry.lastSeenTick > 25) {
                ActiveClockEntries.delete(id);
                clearEntryDues(entry);
                continue;
            }

            const unit = entry.entity;

            if (!unit || !unit.isValid) {
                removeClockEntry(id);
                continue;
            }

            // ============================================================
            // 0 号主轨
            // ============================================================
            if (entry.mainActive && !entry.mainDisabled) {
                if (entry.mainDue === undefined) {
                    // 首次激活：
                    // 20 tick 基础周期 + 相位偏移。
                    // 相位偏移最大为 3 × 5 = 15 tick，
                    // 用于避免大量单位同一 tick 触发 dm_scores。
                    entry.mainDue = now + TRIGGER_INTERVAL + entry.phaseOffset * SCHEDULER_STEP;
                }

                if (now >= entry.mainDue) {
                    triggerMainTrack(unit, entry);

                    if (!entry.mainDisabled) {
                        entry.mainDue = now + TRIGGER_INTERVAL;
                    } else {
                        entry.mainDue = undefined;
                    }
                }
            } else {
                entry.mainDue = undefined;
            }

            // ============================================================
            // 1 ~ 9 号扩展轨
            // ============================================================
            if (entry.trackMode === "multi") {
                for (const trackIndex of entry.activeTracks) {
                    const isOn =
                        entry.trackStates[trackIndex] === "on" &&
                        !entry.extDisabled[trackIndex] &&
                        entry.extOn.includes(trackIndex);

                    if (isOn) {
                        if (entry.extDue[trackIndex] === undefined) {
                            // ★ 扩展轨首次激活：
                            // 保持更贴近原版：20 tick 后触发。
                            // 不额外叠加相位偏移，避免看起来像没运行。
                            entry.extDue[trackIndex] = now + TRIGGER_INTERVAL;
                        }

                        if (now >= entry.extDue[trackIndex]) {
                            triggerExtensionTrack(unit, entry, trackIndex);

                            if (!entry.extDisabled[trackIndex]) {
                                entry.extDue[trackIndex] = now + TRIGGER_INTERVAL;
                            } else {
                                entry.extDue[trackIndex] = undefined;
                            }
                        }
                    } else {
                        entry.extDue[trackIndex] = undefined;
                    }
                }
            }
        }
    } catch (e) {
        console.error(`[DM-Clock] 全局调度器异常: ${e}`);
    }
}, SCHEDULER_STEP);

// ============================================================
// TacticalClockManager
//
// 对外仍然保留 execute(unit, _ignoredThreat)。
// 调用方不需要修改。
// ============================================================
export class TacticalClockManager {

    /**
     * 自适应多轨战斗时钟引擎（全局调度修复版）
     * @param {Entity} unit 目标实体对象
     * @param {boolean} _ignoredThreat （已弃用：不再信任且不再处理任何雷达威胁）
     */
    static execute(unit, _ignoredThreat) {
        if (!unit || !unit.isValid) {
            if (unit && unit.id) {
                removeClockEntry(unit.id);
            }
            return;
        }

        try {
            const now = system.currentTick;
            const entry = getOrCreateEntry(unit);

            entry.entity = unit;
            entry.typeId = unit.typeId;
            entry.lastSeenTick = now;

            // 会话刷新 + 首次轨道模式判定
            ensureSession(unit, entry);

            // ============================================================
            // ★ 修复：
            // 多轨实体每次 execute 都重新读取扩展轨状态。
            //
            // 这样才能保证行为包运行中切换：
            // dm:clock_time_1 ~ dm:clock_time_9
            // 从 off 到 on，或者从 on 到 off 时，
            // JS 层能立即感知。
            // ============================================================
            if (entry.trackMode === "multi") {
                refreshExtensionTracks(unit, entry);
            } else {
                entry.activeTracks = [];
                entry.trackStates = {};
            }

            // 读取战斗 Tag
            const hasTargetTag = unit.hasTag("dm_has_target");
            const isSkillActive = unit.hasTag("dm_skill_on");

            // ============================================================
            // 0 号主轨闸门
            //
            // 单轨：完全看有没有进战 Tag
            // 多轨：有进战 Tag，且不能处于大招期间
            // ============================================================
            const mainGateActive =
                entry.trackMode === "single"
                    ? hasTargetTag
                    : (hasTargetTag && !isSkillActive);

            entry.mainActive = mainGateActive && !entry.mainDisabled;

            // ============================================================
            // 扩展轨激活状态
            //
            // 扩展轨保持原逻辑：
            // 只要轨道属性为 "on"，就允许参与时钟调度。
            // ============================================================
            entry.extOn = [];

            if (entry.trackMode === "multi") {
                for (const trackIndex of entry.activeTracks) {
                    if (
                        entry.trackStates[trackIndex] === "on" &&
                        !entry.extDisabled[trackIndex]
                    ) {
                        entry.extOn.push(trackIndex);
                    }
                }
            }

            // ============================================================
            // 加入 / 移出全局调度器
            // ============================================================
            if (entry.mainActive || entry.extOn.length > 0) {
                ActiveClockEntries.set(unit.id, entry);
            } else {
                ActiveClockEntries.delete(unit.id);
                clearEntryDues(entry);
            }
        } catch (e) {
            console.error(
                `[DM-Clock-Manager Error] 实体名(${unit.typeId}) ID(${unit.id}): ${e}`
            );
        }
    }
}