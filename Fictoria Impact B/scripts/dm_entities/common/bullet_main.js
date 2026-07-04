// 从 '@minecraft/server' 模块导入所需的对象和类型
import { world } from '@minecraft/server';

// 定义一个变量 tick 用于记录循环次数，初始值为 0
let tick = 0;

  //基础循环框架

export const gunLoop = () => {
    // 每次调用函数时，tick 加 1
    tick++;
    // 每 2 次循环执行一次内部逻辑
    if (tick % 2 === 0) {
        // 遍历世界中的所有玩家
        world.getAllPlayers().forEach(player => {
            // 检查玩家对象是否有效
            // [2.0.0 变更] isValid 从方法变为只读属性，去掉括号
            if (!player || !player.isValid) {
                return;
            }
        });
        // 重置 tick 为 0
        tick = 0;
    }
};