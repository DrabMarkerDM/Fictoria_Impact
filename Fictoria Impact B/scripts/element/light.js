import { world, system } from "@minecraft/server";

// 缓存记录表：存储 ID -> { 坐标, 是否亮着 }
let lastPositions = new Map();
// 待检测的实体类型列表
const targetTypes = ["player:dm34", "player:dm34_1"];

system.runInterval(() => {
    const overworld = world.getDimension('overworld');
    
    // 1. 收集当前世界中所有相关的活体实体
    let currentActiveEntities = [];
    for (const type of targetTypes) {
        const found = overworld.getEntities({ type: type });
        currentActiveEntities.push(...found);
    }

    // 创建当前存活 ID 的集合，用于后续对比清理缓存
    const activeIds = new Set(currentActiveEntities.map(e => e.id));

    // 2. 遍历活着的实体，处理跟随和传送清理
    for (const entity of currentActiveEntities) {
        const currentPos = entity.location;
        const lastData = lastPositions.get(entity.id);
        const isLighting = entity.hasTag("is_lighting");

        if (lastData && isLighting) {
            // 计算水平位移距离
            const dist = Math.sqrt(
                Math.pow(currentPos.x - lastData.pos.x, 2) + 
                Math.pow(currentPos.z - lastData.pos.z, 2)
            );

            // 如果位移超过 2 格（传送或跑太快），脚本代为清理老位置
            if (dist > 2) {
                const dim = world.getDimension(entity.dimension.id);
                const { x, y, z } = lastData.pos;
                dim.runCommandAsync(`fill ${Math.floor(x)-2} ${Math.floor(y)-1} ${Math.floor(z)-2} ${Math.floor(x)+2} ${Math.floor(y)+3} ${Math.floor(z)+2} air replace block:dm_light_1`);
            }
        }

        // 更新（或新增）缓存记录
        lastPositions.set(entity.id, { 
            pos: { x: currentPos.x, y: currentPos.y, z: currentPos.z }, 
            wasLighting: isLighting 
        });
    }

    // 3. 缓存清理逻辑：处理死亡、卸载或消失的实体
    for (const [id, data] of lastPositions) {
        if (!activeIds.has(id)) {
            // 如果这个实体不见了，且它消失前是亮着的，补一次“临终清理”
            if (data.wasLighting) {
                const { x, y, z } = data.pos;
                // 注意：这里默认回退到主世界清理，或者你可以根据记录的 dimensionId 优化
                overworld.runCommandAsync(`fill ${Math.floor(x)-2} ${Math.floor(y)-1} ${Math.floor(z)-2} ${Math.floor(x)+2} ${Math.floor(y)+3} ${Math.floor(z)+2} air replace block:dm_light_1`);
            }
            // 彻底从 Map 中删除，释放内存
            lastPositions.delete(id);
        }
    }

}, 2); // 每 0.1 秒运行一次