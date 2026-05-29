import { world, system, EntityDamageCause } from "@minecraft/server";

const BlockedTargetTicks = new Map(); // key: entityId, value: { targetId: string, tickCount: number }
const LastDamageTick = new Map(); // key: unitId, value: { tick: number, targetId: string }
const LastSwitchTick = new Map(); // key: unitId, value: tick

// 配置表
//range 是基础搜索半径，值越大越远
// focus 是当前目标的权重加成，值越大越执着于单一目标，值越小越分散
// speed 是切换目标的响应时间，值越大AI反应快，越小越笨重
// normalRange为自身常规和反击搜索范围，alertRange为主人受击或者攻击时的超频搜索范围
// strafe: 是否开启走位开关
// strafeRange: 触发走位与风筝拉扯的基准距离，除以2就是原版格数
// strafeSpeed: 动态滑步速度
const DmTargetRegistry = {
    "player:dm34_1": {
        "modes": {
            1: { normalRange: 34, alertRange: 54, focus: 2.0, speed: 8, strafe: true, strafeRange: 12, strafeSpeed: 0.35 },  // M4A1 (variant 1)
            2: { normalRange: 30, alertRange: 50, focus: 10.0, speed: 10.0, strafe: true, strafeRange: 9, strafeSpeed: 0.25 }, // mossberg (variant 2)
            3: { normalRange: 58, alertRange: 78, focus: 22.0, speed: 2, strafe: true, strafeRange: 20, strafeSpeed: 0.15 },  // awp (variant 3)
            4: { normalRange: 32, alertRange: 52, focus: 20.0, speed: 18, strafe: false, strafeRange: 0, strafeSpeed: 0 },    // 近战 (variant 4)
            5: { normalRange: 28, alertRange: 48, focus: 4.0, speed: 15, strafe: true, strafeRange: 10, strafeSpeed: 0.45 }   // glock (variant 5)
        }
    },
    "player:dm34": {
        "modes": {
            1: { normalRange: 22, alertRange: 33, focus: 2.0, speed: 20, strafe: false, strafeRange: 0, strafeSpeed: 0 },  // 近战 (variant 1)
            2: { normalRange: 26, alertRange: 33, focus: 8.0, speed: 10.0, strafe: true, strafeRange: 10, strafeSpeed: 0.35 }, // 弓箭模式 (variant 2)
            3: { normalRange: 28, alertRange: 33, focus: 15.0, speed: 5, strafe: true, strafeRange: 18, strafeSpeed: 0.25 },  // 十字弩模式 (variant 3)
        }
    },
    "player:dm48": { normalRange: 40, alertRange: 48, focus: 4.0, speed: 12, strafe: true, strafeRange: 14, strafeSpeed: 0.4 },

    "player:dm35": { normalRange: 40, alertRange: 40, focus: 10.0, speed: 5, strafe: true, strafeRange: 12, strafeSpeed: 0.3 },

    "player:dm32": { normalRange: 39, alertRange: 46, focus: 2.0, speed: 20, strafe: true, strafeRange: 15, strafeSpeed: 0.32 },

     "player:dm51": { normalRange: 32, alertRange: 37, focus: 12.0, speed: 3, strafe: true, strafeRange: 10, strafeSpeed: 0.26 },

     "player:dm26": { normalRange: 42, alertRange: 42, focus: 5.0, speed: 18, strafe: true, strafeRange: 16, strafeSpeed: 0.35 },

     "player:dm50": { normalRange: 96, alertRange: 96, focus: 25.0, speed: 2, strafe: true, strafeRange: 24, strafeSpeed: 0.2 },

     "player:dm21": { normalRange: 36, alertRange: 36, focus: 5.0, speed: 5, strafe: true, strafeRange: 13, strafeSpeed: 0.3 },

     "player:dm6": { normalRange: 36, alertRange: 36, focus: 2.0, speed: 15, strafe: true, strafeRange: 12, strafeSpeed: 0.33 }
    
    
};
const ForcedTargets = new Map();
let GLOBAL_MAX_BROADCAST_DISTANCE = 96;

export class DmTargetEngine {
    static init() {
        console.warn("[DM-Engine] 初始化开始");
        try {
            let maxAlert = 0;
            for (const config of Object.values(DmTargetRegistry)) {
                if (config.modes) {
                    for (const mode of Object.values(config.modes)) {
                        if (mode.alertRange > maxAlert) maxAlert = mode.alertRange;
                    }
                } else if (config.alertRange > maxAlert) {
                    maxAlert = config.alertRange;
                }
            }
            GLOBAL_MAX_BROADCAST_DISTANCE = maxAlert + 18;
            console.warn(`[DM-Engine] 广播距离 = ${GLOBAL_MAX_BROADCAST_DISTANCE}`);
        } catch (e) {
            console.warn("[DM-Engine] 计算广播距离失败，使用默认值96");
            GLOBAL_MAX_BROADCAST_DISTANCE = 96;
        }

        // 驯服监听
        world.afterEvents.dataDrivenEntityTrigger.subscribe((event) => {
            try {
                if (event.eventId === "minecraft:on_tame" && DmTargetRegistry[event.entity.typeId]) {
                    const players = event.entity.dimension.getPlayers({ location: event.entity.location, maxDistance: 16 });
                    if (players.length > 0) {
                        event.entity.setDynamicProperty("ownerId", players[0].id);
                        console.warn(`[DM-Engine] 驯服记录: ${event.entity.typeId} 主人=${players[0].id}`);
                    }
                }
            } catch (e) {
                console.error("[DM-Engine] 驯服监听异常: " + e);
            }
        });

        // 交互补录主人
        world.afterEvents.playerInteractWithEntity.subscribe((event) => {
            try {
                const entity = event.target;
                if (DmTargetRegistry[entity.typeId] && entity.getDynamicProperty("ownerId") === undefined) {
                    entity.setDynamicProperty("ownerId", event.player.id);
                     console.warn(`[DM-Engine] 交互补录主人: ${entity.typeId} 主人=${event.player.id}`);
                }
            } catch (e) {
                console.error("[DM-Engine] 交互补录异常: " + e);
            }
        });

        // 受伤协同广播
        world.afterEvents.entityHurt.subscribe((event) => {
            try {
                const victim = event.hurtEntity;
                if (!victim || !victim.isValid()) return;

                // 定义所有需要保护的友军类型
                const ALLIED_TYPES = [
                    "minecraft:horse",
                    "minecraft:donkey",
                    "minecraft:mule",
                    "minecraft:skeleton_horse",
                    "minecraft:zombie_horse",
                    "minecraft:wolf",       // 狼
                    "minecraft:cat",        // 猫
                    "minecraft:parrot",     // 鹦鹉
                    "minecraft:player",
                ];

                const ALLIED_FAMILIES = ["horse", "wolf", "cat"];

                const isAllied = victim.matches({ families: ALLIED_FAMILIES }) || 
                                 ALLIED_TYPES.includes(victim.typeId);

                if (isAllied) {
                    const damageSource = event.damageSource;
                    const attacker = damageSource.damagingEntity;
                    let isMaidAttack = false;
                    
                    if (attacker && attacker.isValid() && attacker.matches({ families: ["dm"] })) {
                        isMaidAttack = true;
                    }
                    if (damageSource.cause === EntityDamageCause.projectile || 
                        damageSource.cause === EntityDamageCause.fireTick || 
                        damageSource.cause === EntityDamageCause.fire) {
                        if (!attacker || (attacker.isValid() && attacker.matches({ families: ["dm"] }))) {
                            isMaidAttack = true;
                        }
                    }
                    if (isMaidAttack) {
                        try {
                            victim.extinguishFire(true); 
                            const healthComp = victim.getComponent("minecraft:health");
                            if (healthComp) {
                                healthComp.setCurrentValue(healthComp.effectiveMax); 
                            }
                            return; 
                        } catch (err) {}
                    }
                }

                const attacker = event.damageSource.damagingEntity;
                if (!attacker) return;
                
                const damager = event.damageSource.damagingEntity;
                if (damager && DmTargetRegistry[damager.typeId]) {
                    LastDamageTick.set(damager.id, { tick: system.currentTick, targetId: victim.id });
                }
                
                if (DmTargetRegistry[victim.typeId] && victim.getDynamicProperty("ownerId") === undefined) {
                    const nearPlayers = victim.dimension.getPlayers({ location: victim.location, maxDistance: 16 });
                    if (nearPlayers.length > 0) {
                        victim.setDynamicProperty("ownerId", nearPlayers[0].id);
                        console.warn(`[DM-Engine] 受伤补录主人: ${victim.typeId} 主人=${nearPlayers[0].id}`);
                    }
                }
                
                if (DmTargetRegistry[victim.typeId]) {
                    console.warn(`[DM-Engine] 自身受击: ${victim.typeId} 反击目标=${attacker.typeId}`);
                    DmTargetEngine.setForcedTarget(victim.id, attacker, 3);
                }

                const followers = victim.dimension.getEntities({
                    location: victim.location,
                    maxDistance: GLOBAL_MAX_BROADCAST_DISTANCE
                });
                console.warn(`[DM-Engine] 协同扫描: 附近实体数=${followers.length}, 距离=${GLOBAL_MAX_BROADCAST_DISTANCE}`);

                for (const follower of followers) {
                    if (!follower.isValid() || !DmTargetRegistry[follower.typeId]) continue;
                    const ownerId = follower.getDynamicProperty("ownerId");
                    if (!ownerId) continue;

                    if (ownerId === victim.id) {
                        console.warn(`[DM-Engine] 护主: ${follower.typeId} 保护主人 ${victim.id}`);
                        DmTargetEngine.setForcedTarget(follower.id, attacker, 2);
                    }
                    if (ownerId === attacker.id) {
                         console.warn(`[DM-Engine] 协同集火: ${follower.typeId} 与主人 ${ownerId} 一起攻击 ${victim.typeId}`);
                        DmTargetEngine.setForcedTarget(follower.id, victim, 1);
                    }
                }
            } catch (e) {
                console.error(`[DM-Engine] 受伤事件异常: ${e} | ${e.stack}`);
            }
        });

        // 主循环
        system.runInterval(() => {
            try {
                DmTargetEngine.update();
            } catch (e) {
                console.error("[DM-Engine] 主循环异常: " + e);
            }
        }, 5);

        console.warn("[DM-Engine] 初始化完成");
    }

    static setForcedTarget(unitId, newTarget, priority) {
        const current = ForcedTargets.get(unitId);
        const nowTick = system.currentTick;
        if (!current || (nowTick - current.tick > 80) || priority >= current.priority) {
            ForcedTargets.set(unitId, { target: newTarget, priority: priority, tick: nowTick });
        }
    }

    static update() {
        const activeDimensions = new Set();
        for (const player of world.getAllPlayers()) {
            try {
                if (player.dimension) activeDimensions.add(player.dimension);
            } catch (e) {}
        }

        for (const dimension of activeDimensions) {
            for (const [typeId, globalConfig] of Object.entries(DmTargetRegistry)) {
                let units;
                try {
                    units = dimension.getEntities({ type: typeId });
                    console.warn(`[DM-Engine] 扫描类型 ${typeId}: 数量=${units.length}`);
                } catch (e) { continue; }

                for (const unit of units) {
                    if (!unit.isValid()) continue;

                    let activeConfig = globalConfig;
                    if (globalConfig.modes) {
                        const variantComp = unit.getComponent("minecraft:variant");
                        const variant = variantComp ? variantComp.value : 0;

                        if (!(variant in globalConfig.modes)) {
                            console.warn(`[DM-Engine] 女仆 ${unit.id} variant=${variant} 未配置，跳过索敌/走位`);
                            continue;
                        }

                        activeConfig = globalConfig.modes[variant];
                        console.warn(`[DM-Engine] 女仆 ${unit.id} variant=${variant}, 配置 mode=${variant}`);
                    }

                    try {
                        DmTargetEngine.processUnit(unit, activeConfig);
                    } catch (e) {
                        console.error(`[DM-Engine] processUnit 异常 (${unit.id}): ${e}`);
                    }
                }
            }
        }
    }

  static processUnit(unit, config) {
        console.warn(`[DM-Engine] processUnit 开始: ${unit.id}, normalRange=${config.normalRange}`);
        const forced = ForcedTargets.get(unit.id);
        const currentTarget = unit.target;

        let currentRange = config.normalRange;
        let hasValidForcedTarget = false;

        // 优先检查外部强制锁定机制
        if (forced) {
            const isValid = forced.target.isValid();
            const elapsed = system.currentTick - forced.tick;
            if (isValid && elapsed < 80) { // 4秒强锁有效期
                hasValidForcedTarget = true;
                if (forced.priority === 1 || forced.priority === 2) {
                    currentRange = config.alertRange; // 拔刀/警惕状态拓宽索敌边界
                }
            } else {
                ForcedTargets.delete(unit.id); // 超时销毁
            }
        }

        let targets = [];
        try {
            // 获取当前维度内的潜在怪物目标
            targets = unit.dimension.getEntities({
                location: unit.location,
                maxDistance: currentRange,
                families: ["monster"]
            });
        } catch (e) {  
            return;
        }

        let bestTarget = null;
        let highestWeight = -1;

        // 预留走位用的最近威胁检测器
        let closestThreat = null;
        const strafeRange = config.strafeRange ?? 15;
        let closestDistSq = strafeRange ** 2;

        // 遍历所有目标进行核心权重动态解析
        for (const target of targets) {
            if (!target.isValid()) continue;

            const distSq = DmTargetEngine.getDistSq(unit.location, target.location);
            
            // 实时捕获进入走位警戒线内的最近实体
            if (distSq < closestDistSq) {
                closestDistSq = distSq;
                closestThreat = target;
            }

            // 基础距离权重项：距离越近，权重基数越高
            let distWeight = (currentRange ** 2 - distSq) / (currentRange ** 2);
            let weight = 0;
            let isForcedThisTarget = (hasValidForcedTarget && forced.target.id === target.id);

            // 动态权重阶梯状态机
            if (isForcedThisTarget) {
                if (forced.priority === 3) weight = 1000000 + distWeight; // 优先级3：超高级绝对锁定（受击反击）
                else if (forced.priority === 2) weight = 1000 + distWeight;   // 优先级2：高级指令锁定
                else if (forced.priority === 1) weight = 1000 + distWeight;   // 优先级1：普通视觉感知
            } else {
                weight = 100 + distWeight * 10; // 无强锁状态下的自主边缘择优
            }

            // 专注度（Focus）修正：对当前已有目标施加记忆惯性，防止多怪高频乱转头
            if (currentTarget && currentTarget.id === target.id) {
                weight *= config.focus;
                // 仇恨流失检测：若当前专注目标长时间没有对自己造成过伤害，降低其权重
                const lastDmg = LastDamageTick.get(unit.id);
                if (lastDmg && lastDmg.targetId === currentTarget.id) {
                    if (system.currentTick - lastDmg.tick > 60) { weight *= 0.2; }
                }
            }

            // 竞争出最适合当前女仆决策的最高权重目标
            if (weight > highestWeight) {
                highestWeight = weight;
                bestTarget = target;
            }
        }

        // 执行最终的目标更替与原件事件驱动触发
        if (bestTarget && currentTarget?.id !== bestTarget.id) {
            const nowTick = system.currentTick;
            const lastSwitch = LastSwitchTick.get(unit.id) || 0;
            const cooldown = Math.max(1, 20 - config.speed); // 换目标最小冷却时间，受机动性系数反向调控
            if (nowTick - lastSwitch >= cooldown) {
                unit.target = bestTarget;
                try {
                    unit.triggerEvent("dm:reset_target_selector");
                    LastSwitchTick.set(unit.id, nowTick);
                } catch (e) {}
            }
        }

        // 全状态闭环控制机制
        if (config.strafe) {
            try {
            if (unit.hasTag("maid:ride_player")) {
            unit.setDynamicProperty("dm:cmd_vel_x", 0);
            unit.setDynamicProperty("dm:cmd_vel_z", 0);
            unit.setDynamicProperty("dm:cmd_vel_y", 0);
            return;
        }
                const controller = unit.getComponent("minecraft:riding")?.entityRidingOn ?? unit;
                const nowTick = system.currentTick;
                const uLoc = unit.location;
 if (controller.typeId === "mob:hug_maid") {
            // 女仆骑在 hug_maid 上，但未标记 ride_player（已在上方返回），
            // 这里只处理边缘情况：直接使用 unit 自身，不向 hug_maid 施加冲量
            // 正常情况下，上方标签检测会先拦截掉
        }
                // 如果女仆处于非地面状态（被击飞/卡坑强行弹射），强制进行空气阻尼衰减
                if (!controller.isOnGround) {
                    let currentVelX = unit.getDynamicProperty("dm:cmd_vel_x") ?? 0;
                    let currentVelZ = unit.getDynamicProperty("dm:cmd_vel_z") ?? 0;
                    
                    // 施加 0.65 的高空柔性刹车阻尼，防止漂移
                    unit.setDynamicProperty("dm:cmd_vel_x", currentVelX * 0.65);
                    unit.setDynamicProperty("dm:cmd_vel_z", currentVelZ * 0.65);
                    unit.setDynamicProperty("dm:cmd_vel_y", 0); // 垂直动力交由原版重力惯性处理
                    return; // 空中不进行任何新的走位向量注入，直接返回
                }
                
                // 以下为正常的地面战术走位决策逻辑
                if (controller.isOnGround) {
                    const updatedTarget = unit.target;

                    // 战术威胁源选择判定（近战威胁怪优先于远程大目标）
                    let activeTarget = closestThreat;
                    let activeDistSq = closestDistSq;

                    if (!activeTarget && updatedTarget && updatedTarget.isValid()) {
                        const currentDistSq = DmTargetEngine.getDistSq(uLoc, updatedTarget.location);
                        if (currentDistSq <= strafeRange ** 2) {
                            activeTarget = updatedTarget;
                            activeDistSq = currentDistSq;
                        }
                    }

                    // 视野内无任何威胁，切断动力静止
                    if (!activeTarget) {
                        unit.setDynamicProperty("dm:cmd_vel_x", 0);
                        unit.setDynamicProperty("dm:cmd_vel_z", 0);
                        return;
                    }

                   
                    // 检查目标是否彻底丧失移动能力（如卡墙里、被高等级迟缓Buff定身、处于非加载硬壳中）
                    let isTargetStationary = false;
                    try {
                        const tVel = activeTarget.getVelocity();
                        // 如果目标在水平方向的速度几乎为 0 (小于 0.001)
                        if (tVel && (tVel.x * tVel.x + tVel.z * tVel.z) < 0.00001) {
                            isTargetStationary = true;
                        }
                    } catch (velErr) {}

                    if (isTargetStationary) {
                        // 目标已成活靶子，女仆强制原地“挂空挡”静止输出，拒绝无效走位，同时完美节省雷达开销
                        unit.setDynamicProperty("dm:cmd_vel_x", 0);
                        unit.setDynamicProperty("dm:cmd_vel_z", 0);
                        unit.setDynamicProperty("dm:cmd_vel_y", 0);
                        return;
                    }

                    // 时钟与多模态切换检测 (平移、环绕、无动力拉扯)
                    let strafeDirection = unit.getDynamicProperty("dm:strafe_line"); 
                    let lastModeTick = unit.getDynamicProperty("dm:strafe_mode_tick") ?? 0;
                    
                    if (strafeDirection === undefined || (nowTick - lastModeTick >= (unit.getDynamicProperty("dm:strafe_cooldown") ?? 40))) {
                        const rand = Math.random();
                        const isCloseRange = activeDistSq < (strafeRange * 0.5) ** 2; // 是否踩入贴脸红线

                        if (isCloseRange) {
                            // 贴脸状态下：70% 概率直线极速后撤倒车，30% 概率左右环绕拉扯
                            if (rand < 0.70) {
                                strafeDirection = 0; 
                            } else {
                                strafeDirection = Math.random() < 0.5 ? 1 : -1;
                            }
                        } else {
                            // 中距离常规风筝状态：40%正向滑步，40%反向滑步，20%直线前冲/突击
                            if (rand < 0.40) {
                                strafeDirection = 1; 
                            } else if (rand < 0.80) {
                                strafeDirection = -1; 
                            } else {
                                strafeDirection = 0; 
                            }
                        }

                        unit.setDynamicProperty("dm:strafe_line", strafeDirection);
                        unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                        unit.setDynamicProperty("dm:strafe_cooldown", Math.floor(Math.random() * 20) + 30); // 随机化下一个战术周期的长短
                    }

                    // 计算切向与法向移动向量
                    const dx = activeTarget.location.x - uLoc.x;
                    const dz = activeTarget.location.z - uLoc.z;
                    const len = Math.sqrt(dx * dx + dz * dz) || 0.001;
                    const dirX = dx / len;
                    const dirZ = dz / len;

                    let distancing = 1; // 默认拉锯向
                    let finalSpeed = config.strafeSpeed ?? 0.45; 

                    if (strafeDirection === 0) {
                        finalSpeed *= 1.5; // 直线拉扯时给予 1.5 倍爆发生速
                    }

                    if (activeDistSq < (strafeRange * 0.5) ** 2) {
                        distancing = -1; // 触发红线，法向向量反转为“绝对后撤”
                        finalSpeed *= 1.2; 
                    }

                    // 核心角度旋转矩阵映射
                    let angle = 0;
                    if (strafeDirection === 0) {
                        angle = Math.PI; // 直线倒车：180度
                    } else {
                        angle = (strafeDirection * (90 - distancing * 45)) * (Math.PI / 180); // 环绕切向夹角计算
                    }

                    const cosA = Math.cos(angle);
                    const sinA = Math.sin(angle);
                    
                    let impulseX = dirX * cosA - dirZ * sinA;
                    let impulseZ = dirX * sinA + dirZ * cosA;

                    let jumpImpulse = 0.01; 

                    // 原生前方雷达防卡墙检测
                    if (distancing === -1) {
                        const checkLocationLower = { x: uLoc.x + impulseX * 1.2, y: uLoc.y + 1, z: uLoc.z + impulseZ * 1.2 };
                        const checkLocationUpper = { x: uLoc.x + impulseX * 1.2, y: uLoc.y + 2, z: uLoc.z + impulseZ * 1.2 };

                        try {
                            const blockLower = unit.dimension.getBlock(checkLocationLower);
                            if (blockLower && !blockLower.isAir && !blockLower.isLiquid) {
                                const blockUpper = unit.dimension.getBlock(checkLocationUpper);
                                if (blockUpper && (blockUpper.isAir || blockUpper.isLiquid)) {
                                    jumpImpulse = 0.28; // 1格高障碍自动小跳越过
                                } else {
                                    // 2格高刚性死墙：强制揉碎当前战术时钟，执行反向全面横移
                                    if (strafeDirection === 0) {
                                        strafeDirection = Math.random() < 0.5 ? 1 : -1;
                                        jumpImpulse = 0.28;
                                    } else {
                                        strafeDirection *= -1;
                                    }
                                    unit.setDynamicProperty("dm:strafe_line", strafeDirection);
                                    unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);

                                    let newAngle;
                                    if (strafeDirection === 0) {
                                        newAngle = Math.PI;
                                    } else {
                                        newAngle = (strafeDirection * (90 - distancing * 45)) * (Math.PI / 180);
                                    }
                                    const cosNew = Math.cos(newAngle);
                                    const sinNew = Math.sin(newAngle);
                                    impulseX = dirX * cosNew - dirZ * sinNew;
                                    impulseZ = dirX * sinNew + dirZ * cosNew;
                                }
                            }
                        } catch (e) {}
                    }

                    // 防悬崖与岩浆雷达熔断机制
                    if (impulseX !== 0 || impulseZ !== 0) {
                        const probeX = uLoc.x + impulseX * 1.3;
                        const probeZ = uLoc.z + impulseZ * 1.3;
                        const floorY = Math.floor(uLoc.y);
                        
                        let isDangerous = false;
                        let dangerType = ""; 
                        
                        try {
                            const currentBlock = unit.dimension.getBlock({ x: uLoc.x, y: floorY, z: uLoc.z });
                            const forwardBlock = unit.dimension.getBlock({ x: probeX, y: floorY, z: probeZ });
                            const forwardBelowBlock = unit.dimension.getBlock({ x: probeX, y: floorY - 1, z: probeZ });

                            if ((currentBlock && currentBlock.typeId.includes("lava")) || 
                                (forwardBlock && forwardBlock.typeId.includes("lava")) ||
                                (forwardBelowBlock && forwardBelowBlock.typeId.includes("lava"))) {
                                isDangerous = true;
                                dangerType = "lava";
                            }

                            if (!isDangerous && forwardBlock && (forwardBlock.isAir || forwardBlock.isLiquid)) {
                                if (forwardBelowBlock && (forwardBelowBlock.isAir || forwardBelowBlock.isLiquid)) {
                                    const deepBelowBlock = unit.dimension.getBlock({ x: probeX, y: floorY - 3, z: probeZ });
                                    if (deepBelowBlock && (deepBelowBlock.isAir || deepBelowBlock.isLiquid)) {
                                        isDangerous = true;
                                        dangerType = "cliff";
                                    }
                                }
                            }
                        } catch (pErr) {
                            isDangerous = true; 
                            dangerType = "unloaded_edge";
                        }

                        if (isDangerous) {
                            console.warn(`[DM-Engine Radar] 🚨 熔断触发! 实体 ${unit.id} 前方遭遇 [${dangerType}]，拦截动力并重洗时钟方向。`);
                            impulseX = 0;
                            impulseZ = 0;
                            jumpImpulse = 0;

                            if (strafeDirection === 0) {
                                strafeDirection = Math.random() < 0.5 ? 1 : -1;
                            } else {
                                strafeDirection *= -1;
                            }
                            
                            unit.setDynamicProperty("dm:strafe_line", strafeDirection);
                            unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                            unit.setDynamicProperty("dm:strafe_cooldown", 15); 
                        }
                    }

                    // 1x1 窄坑与矮洞刚性卡死检测线
                    const lastX = unit.getDynamicProperty("dm:last_x");
                    const lastZ = unit.getDynamicProperty("dm:last_z");
                    let stuckTicks = unit.getDynamicProperty("dm:stuck_ticks") ?? 0;

                    if (lastX !== undefined && lastZ !== undefined) {
                        const realDistSq = (uLoc.x - lastX) ** 2 + (uLoc.z - lastZ) ** 2;
                        if (realDistSq < 0.005) {
                            stuckTicks += 5;
                        } else {
                            stuckTicks = Math.max(0, stuckTicks - 2);
                        }
                    }

                    if (stuckTicks >= 30 || (stuckTicks >= 15 && lastX !== undefined && (uLoc.x - lastX) ** 2 + (uLoc.z - lastZ) ** 2 < 0.0005)) {
                        try {
                            // 探查头顶上方第 2 格（通常是实体身高之上的压顶块）
                            const ceilingLoc = { x: uLoc.x, y: Math.floor(uLoc.y) + 2, z: uLoc.z };
                            let isCeilingBlocked = false;
                            try {
                                const ceilingBlock = unit.dimension.getBlock(ceilingLoc);
                                if (ceilingBlock && !ceilingBlock.isAir && !ceilingBlock.isLiquid) {
                                    isCeilingBlocked = true;
                                }
                            } catch (e) {}

                            // 脱困前硬断电，清空原本残存的多维动力缓存
                            unit.clearVelocity();
                            unit.setDynamicProperty("dm:cmd_vel_x", 0);
                            unit.setDynamicProperty("dm:cmd_vel_z", 0);

                            if (isCeilingBlocked) {
                                // 【矮洞卡死应对方案】：头顶有方块封死，严禁向上瞬移和跳跃！
                                console.warn(`[DM-Engine Stuck] 🛑 检测到实体 ${unit.id} 头顶被封死（矮洞/矿道卡死）。执行反向水平喷气弹射！`);
                                
                                // 采用现存移动意向向量的“反向激进矢量”，如果没向量（原地卡死）则利用视角强行往后推
                                let escapeX = -impulseX;
                                let escapeZ = -impulseZ;
                                if (escapeX === 0 && escapeZ === 0) {
                                    const viewDir = unit.getViewDirection();
                                    escapeX = -viewDir.x;
                                    escapeZ = -viewDir.z;
                                }
                                
                                // 归一化逃生矢量
                                const escapeLen = Math.sqrt(escapeX * escapeX + escapeZ * escapeZ) || 0.001;
                                escapeX /= escapeLen;
                                escapeZ /= escapeLen;

                                // 注入一个瞬间强力的水平“倒车推力”（不给垂直 Y 速度），将其向外推弹出2格空间
                                impulseX = escapeX * 2.2;
                                impulseZ = escapeZ * 2.2;
                                jumpImpulse = 0; // 零跳跃，贴地滑行

                                // 强制重置时钟，让下一周期保持这个逃生偏向
                                unit.setDynamicProperty("dm:strafe_line", Math.random() < 0.5 ? 1 : -1);
                                unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                                unit.setDynamicProperty("dm:strafe_cooldown", 20); // 留出 1 秒不被打断的逃生帧
                            } else {
                                // 梯形常规卡死应对方案：头顶安全，允许正常拔高出坑
                                unit.teleport(
                                    { x: uLoc.x, y: uLoc.y + 0.6, z: uLoc.z },
                                    { checkForBlocks: false }
                                );
                                jumpImpulse = 0.42; 

                                unit.setDynamicProperty("dm:strafe_line", Math.random() < 0.5 ? 1 : -1);
                                unit.setDynamicProperty("dm:strafe_mode_tick", nowTick);
                            }
                        } catch (tpErr) {}
                        stuckTicks = 0;
                    }

                    unit.setDynamicProperty("dm:last_x", uLoc.x);
                    unit.setDynamicProperty("dm:last_z", uLoc.z);
                    unit.setDynamicProperty("dm:stuck_ticks", stuckTicks);

                    // 受击物理抗性阻尼
                    let hurtResistance = 1.0;
                    const selfHurtLog = LastDamageTick.get(unit.id);
                    if (selfHurtLog && (nowTick - selfHurtLog.tick <= 8)) {
                        hurtResistance = 0.45; // 刚受击的 8 ticks 内，大幅压低自主控制力，让位给原版受击退物理
                    }

                    // 写入最后计算出来的地面移动增量（如果是矮洞脱困，此时 impulseX/Z 已经是被放大的逃生向量）
                    unit.setDynamicProperty("dm:cmd_vel_x", impulseX * finalSpeed * 0.35 * hurtResistance);
                    unit.setDynamicProperty("dm:cmd_vel_z", impulseZ * finalSpeed * 0.35 * hurtResistance);
                    unit.setDynamicProperty("dm:cmd_vel_y", jumpImpulse);
                }
            } catch (strafeError) {
                console.error(`[DM-Engine Core Error] 走位计算决策异常: ${strafeError}`);
            }
        }
        // =========================================================================
    }

    static getDistSq(pos1, pos2) {
        if (!pos1 || !pos2) return 99999;
        return (pos1.x - pos2.x) ** 2 + (pos1.y - pos2.y) ** 2 + (pos1.z - pos2.z) ** 2;
    }
}