import { system } from "@minecraft/server";

// 世界会话防线。每次重进存档、或者执行 /reload，这个变量都会被重新初始化
const CURRENT_WORLD_SESSION = Math.floor(Math.random() * 1000000) + 1;

export class TacticalClockManager {
    /**
     * 自适应多轨战斗时钟引擎（纯被动 JSON Tag 驱动版）
     * @param {Entity} unit 目标实体对象
     * @param {boolean} _ignoredThreat （已弃用：不再信任且不再处理任何雷达威胁）
     */
    static execute(unit, _ignoredThreat) {
        if (!unit || !unit.isValid()) return;

        try {
            const nowTick = system.currentTick;

            // =================================================================
            // 静态自适应审计（进档自动刷新 + 免重复探测）
            // =================================================================
            let trackMode = unit.getDynamicProperty("dm:clock_track_mode");
            const entityLastSession = unit.getDynamicProperty("dm:last_session_id");

            if (entityLastSession !== CURRENT_WORLD_SESSION) {
                trackMode = undefined; // 强行擦除历史缓存
            }

            let activeExtensionTracks = [];
            let trackStates = {};

            if (trackMode === undefined) {
                for (let i = 1; i <= 9; i++) {
                    try {
                        const propValue = unit.getProperty(`dm:clock_time_${i}`);
                        if (propValue !== undefined) {
                            activeExtensionTracks.push(i);
                            trackStates[i] = propValue;
                        }
                    } catch (e) {
                        break; 
                    }
                }

                if (activeExtensionTracks.length > 0) {
                    unit.setDynamicProperty("dm:clock_track_mode", "multi");
                    trackMode = "multi";
                } else {
                    unit.setDynamicProperty("dm:clock_track_mode", "single");
                    trackMode = "single";
                }
                unit.setDynamicProperty("dm:last_session_id", CURRENT_WORLD_SESSION);

            } else if (trackMode === "multi") {
                for (let i = 1; i <= 9; i++) {
                    try {
                        const propValue = unit.getProperty(`dm:clock_time_${i}`);
                        if (propValue !== undefined) {
                            activeExtensionTracks.push(i);
                            trackStates[i] = propValue;
                        }
                    } catch (e) { 
                        break; 
                    }
                }
            }

            const isMultiTrack = trackMode === "multi";
            const isSkillActive = unit.hasTag("dm_skill_on"); 
            const hasTargetTag = unit.hasTag("dm_has_target"); 
            // =================================================================
            // 0号主轨逻辑分支
            // =================================================================
            const isSingleTrack = trackMode === "single";
            
            // 闸门判定：
            // 单轨：完全看有没有进战 Tag 
            // 多轨：有进战 Tag，且不能处于大招期间 (你原汁原味的设定)
            const isSingleTrackAndActive = isSingleTrack && hasTargetTag;
            const isMultiTrackAndActive = !isSingleTrack && hasTargetTag && !isSkillActive;

            if (isSingleTrackAndActive || isMultiTrackAndActive) {
                let lastClockTick0 = unit.getDynamicProperty("dm:last_clock_tick");
                if (lastClockTick0 === undefined) {
                    unit.setDynamicProperty("dm:last_clock_tick", nowTick);
                    lastClockTick0 = nowTick;
                }
                
                // 满 20 ticks (1秒) 平滑驱动默认 0 号轨常规得分事件
                if (nowTick - lastClockTick0 >= 20) {
                    unit.triggerEvent("dm_scores"); 
                    unit.setDynamicProperty("dm:last_clock_tick", nowTick);
                }
            } else {
                // 一旦 JSON 层把 dm_has_target 标签拔掉，当帧平滑挂起，清理缓存，绝不震荡
                unit.setDynamicProperty("dm:last_clock_tick", undefined);
            }

            // =================================================================
            // 1~9号扩展轨逻辑分支
            // =================================================================
            if (isMultiTrack) {
                for (const i of activeExtensionTracks) {
                    if (trackStates[i] === "on") { 
                        let lastClockTick = unit.getDynamicProperty(`dm:last_clock_tick_${i}`);
                        
                        if (lastClockTick === undefined) {
                            unit.setDynamicProperty(`dm:last_clock_tick_${i}`, nowTick);
                            lastClockTick = nowTick;
                        }

                        if (nowTick - lastClockTick >= 20) {
                            unit.triggerEvent(`dm_scores_${i}`); 
                            unit.setDynamicProperty(`dm:last_clock_tick_${i}`, nowTick);
                        }
                    } else { 
                        unit.setDynamicProperty(`dm:last_clock_tick_${i}`, undefined);
                    }
                }
            }

        } catch (e) {
            console.error(`[DM-Clock-Manager Pure-Passive Error] 实体名(${unit.typeId}) ID(${unit.id}): ${e}`);
        }
    }
}