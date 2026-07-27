
// 导入 Minecraft 服务器相关模块
import { system, world } from '@minecraft/server';
// 导入枪支主循环函数
import { gunLoop } from './dm_entities/common/bullet_main';
// 导入子弹击中实体的处理函数
import { bulletEntityImpact } from './dm_entities/common/bullet_manager';
// 导入灯光组件模块
import './element/light';
// 导入近战组件处理函数（从melee_manager.js 导入）
import { meleeImpactHandler } from './dm_entities/common/melee_manager';
// 导入女仆相关组件函数
import './dm_entities/dm34/maid_manager';
// 导入目标管理引擎
import { DmTargetEngine } from './dm_entities/common/attackable_target_manager';
// 导入友军防误伤模块
import './dm_entities/common/player_attack_blocker';

// 初始化目标管理引擎
DmTargetEngine.init();


const CORE_SCALE = 0.028;            
const MAX_DYNAMIC_IMPULSE = 0.32;    
                                     

// 每 1 Tick 运行一次向量移动
const driveMaidMuscles = () => {
    try {
        const activeDimensions = new Set();
        for (const player of world.getAllPlayers()) {
            if (player.dimension) activeDimensions.add(player.dimension);
        }

        // AI 实体 typeId 列表
        const targetTypes = ["player:dm34_1", "player:dm34",
            "player:dm48", "player:dm35", "player:dm32", "player:dm51",
            "player:dm26", "player:dm50", "player:dm21", "player:dm6", "player:test1",
            "player:dm31", "player:dm45", "player:dm59", "player:dm33", "player:dm24",
            "player:dm8", "player:dm25", "player:kirito", "player:asuna", "player:dm49", "player:dm62",
            "player:dm0", "player:dm63", "player:dm46", "player:dm60", "player:dm41", "player:dm61",
            "player:dm52", "player:dm56", "player:dm28"    ];

        for (const dimension of activeDimensions) {
            for (const typeId of targetTypes) {
                let units;
                try {
                    // [2.7.0] type → types
                    units = dimension.getEntities({ types: typeId });
                } catch (e) { continue; }

                for (const unit of units) {
                    if (!unit.isValid) continue;

                    const controller = unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;

                    // 读取走位引擎解算出的速度属性
                    const velX = unit.getDynamicProperty("dm:cmd_vel_x") ?? 0;
                    const velZ = unit.getDynamicProperty("dm:cmd_vel_z") ?? 0;
                    const velY = unit.getDynamicProperty("dm:cmd_vel_y") ?? 0.02;

                    if (velX !== 0 || velZ !== 0 || velY > 0.02) {
                        
                        // 1. 计算当前帧期望施加的原始横向冲量
                        let impulseX = velX * CORE_SCALE;
                        let impulseZ = velZ * CORE_SCALE;

                        // 检查当前帧算出来的冲量是否超越了“稳态上限”（MAX_DYNAMIC_IMPULSE）
                        // 如果因为卡坑触发了爆发后撤，将其强制钳制在安全区间内，允许快速脱坑但拒绝飞天
                        if (Math.abs(impulseX) > MAX_DYNAMIC_IMPULSE) {
                            impulseX = Math.sign(impulseX) * MAX_DYNAMIC_IMPULSE;
                        }
                        if (Math.abs(impulseZ) > MAX_DYNAMIC_IMPULSE) {
                            impulseZ = Math.sign(impulseZ) * MAX_DYNAMIC_IMPULSE;
                        }

                        // 3. 施加微量纯净冲量
                        controller.applyImpulse({ 
                            x: impulseX, 
                            y: (velY > 0.02) ? Math.max(-0.4, Math.min(0.4, velY)) : 0, // 维持安全的跳跃曲线
                            z: impulseZ 
                        });


                        // 不在此处强行清零横向属性，将属性控制权100%留给 movement_ranged.js 持续更新

                        // 跳跃冲量消费
                        if (velY > 0.02) {
                            unit.setDynamicProperty("dm:cmd_vel_y", 0.02);
                        }
                    }
                }
            }
        }
    } catch (error) {
        // 高频底层动力线，允许静默兜底
    }
};

// 每帧要执行的函数，主要执行枪支逻辑
const tick = () => {
    // 每一帧（1 Tick）都必须雷打不动执行女仆的肌肉驱动，确保绝对丝滑
    driveMaidMuscles();
};

// 自动运行定时任务，实现循环调用 tick 函数
const autoRunTick = () => {
    // 执行每帧逻辑
    tick();
    // 创建一个超时任务，在 1 个游戏刻后执行，控制摩擦力
    const timeoutId = system.runTimeout(() => {
        try {
            // 清除当前超时任务
            system.clearRun(timeoutId);
            // 递归调用自身，实现循环
            autoRunTick();
        } catch (error) {
            // 捕获并输出可能出现的错误
            console.warn(error);
        }
    }, 1);
};

//子弹管理器2 刻延迟，确保射速时序和子弹判定不发生错乱

const autoRunGunTick = () => {
    // 执行枪支主循环逻辑
    gunLoop();
    // 创建一个超时任务，在 2 个游戏刻后执行
    const timeoutId = system.runTimeout(() => {
        try {
            // 清除当前超时任务
            system.clearRun(timeoutId);
            // 递归调用自身，实现循环
            autoRunGunTick();
        } catch (error) {
            // 捕获并输出可能出现的错误
            console.warn(error);
        }
    }, 2); // 0x2 也可以，此处保持逻辑一致
};

// 注册游戏事件监听器
const events = () => {
    world.afterEvents.projectileHitEntity.subscribe(bulletEntityImpact);
    meleeImpactHandler();
};

// 初始化函数，启动整个系统
const init = () => {
    // 启动 1 Tick 全速丝滑动力环
    autoRunTick();
    // 启动 2 Tick 枪械逻辑动力环
    autoRunGunTick();
    // 注册事件监听器
    events();
};

// 调用初始化函数，开始整个流程
init();
