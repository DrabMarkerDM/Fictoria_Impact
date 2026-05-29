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

// 每 1 Tick 运行一次向量移动
const driveMaidMuscles = () => {
    try {
        const activeDimensions = new Set();
        for (const player of world.getAllPlayers()) {
            if (player.dimension) activeDimensions.add(player.dimension);
        }

        //  AI 实体 typeId 列表
        const targetTypes = ["player:dm34_1", "player:dm34", 
            "player:dm48", "player:dm35", "player:dm32", "player:dm51", 
            "player:dm26", "player:dm50", "player:dm21", "player:dm6"]; 

        for (const dimension of activeDimensions) {
            for (const typeId of targetTypes) {
                let units;
                try {
                    units = dimension.getEntities({ type: typeId });
                } catch (e) { continue; }

                for (const unit of units) {
                    if (!unit.isValid()) continue;

                    const controller = unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;
                    
                    // 读取增量
                    const velX = unit.getDynamicProperty("dm:cmd_vel_x") ?? 0;
                    const velZ = unit.getDynamicProperty("dm:cmd_vel_z") ?? 0;
                    const velY = unit.getDynamicProperty("dm:cmd_vel_y") ?? 0.02;

                    if (velX !== 0 || velZ !== 0) {
                        controller.applyImpulse({ x: velX, y: velY, z: velZ });
                        
                        // 在 1 Tick 里触发跳跃，防止连续累加导致飞天
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

//保持子弹管理器原本的 2 刻延迟，确保射速时序和子弹判定不发生错乱

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