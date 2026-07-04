import { world, EntityDamageCause, system } from "@minecraft/server";

world.afterEvents.entityHurt.subscribe((event) => {
    const victim = event.hurtEntity;
    const cause = event.damageSource.cause;

    // 基础判定
    // [2.7.0] victim.isValid() → victim.isValid
    if (!victim || !victim.isValid) return;

    // 特殊女仆
    const isSpecialMaid = victim.typeId === "player:dm34" || victim.typeId === "player:dm34_1";

    // 通用 dm 友方实体
    const isDmEntity = victim.matches({ families: ["dm"] });
    // 敌方 demon 实体
    const isDemonEntity = victim.matches({ families: ["demon"] });

    // 既不是特殊女仆、不是 dm 家族、也不是 demon 家族，直接退出
    if (!isSpecialMaid && !isDmEntity && !isDemonEntity) return;

    // ======================== 【特殊女仆：完整保护流程】 ========================
    if (isSpecialMaid) {
        // Tag校验
        if (!victim.hasTag("dm_tamed")) return;
        if (victim.hasTag("dm:teleport_cooldown")) return;

        // 多级过滤方案-第一级：伤害原因过滤
        if (cause !== EntityDamageCause.lava && cause !== EntityDamageCause.fireTick && cause !== EntityDamageCause.fire) return;

        // 带抗火时不触发传送
        try {
            if (victim.getEffect("fire_resistance")) return;
        } catch(e) {}

        // 多级过滤方案-第二级：物理环境校对
        let realInLava = false;
        try {
            const footBlock = victim.dimension.getBlock(victim.location);
            // [2.7.0] footBlock.isValid() → footBlock.isValid
            if (footBlock && footBlock.isValid && footBlock.typeId.includes("lava")) {
                realInLava = true;
            }
        } catch (e) { return; }

        if (!realInLava) return;

        // ======================== 【验证通过，上锁并准备传送】 ========================
        try {
            victim.addTag("dm:teleport_cooldown");
            victim.addEffect("fire_resistance", 40, { showParticles: false });
            victim.extinguishFire(true);
        } catch(e) { return; }

        // 寻找最近的玩家
        let closestPlayer = null;
        let minDistance = 999999;

        try {
            const playersInDimension = victim.dimension.getPlayers();
            const victimLoc = victim.location;

            for (const player of playersInDimension) {
                const playerLoc = player.location;
                const dx = playerLoc.x - victimLoc.x;
                const dy = playerLoc.y - victimLoc.y;
                const dz = playerLoc.z - victimLoc.z;
                const distSq = dx * dx + dy * dy + dz * dz;

                if (distSq < minDistance) {
                    minDistance = distSq;
                    closestPlayer = player;
                }
            }
        } catch (err) {}

        // 计算安全点
        if (closestPlayer) {
            const target = closestPlayer;
            const dimension = target.dimension;

            let safeLocation = { x: target.location.x, y: target.location.y + 0.5, z: target.location.z };
            let needFindLand = false;

            try {
                const playerBlock = dimension.getBlock(target.location);
                // [2.7.0] playerBlock.isValid() → playerBlock.isValid
                if (playerBlock && playerBlock.isValid && playerBlock.typeId.includes("lava")) {
                    needFindLand = true;
                }
            } catch (e) {}

            // 核心防窒息算法切入点
            if (needFindLand) {
                let foundLand = false;
                const pX = Math.floor(target.location.x);
                const pY = Math.floor(target.location.y);
                const pZ = Math.floor(target.location.z);

                outerLoop:
                for (let xOffset = -3; xOffset <= 3; xOffset++) {
                    for (let zOffset = -3; zOffset <= 3; zOffset++) {
                        for (let yOffset = -2; yOffset <= 2; yOffset++) {
                            try {
                                const checkX = pX + xOffset;
                                const checkY = pY + yOffset;
                                const checkZ = pZ + zOffset;

                                const currentBlock = dimension.getBlock({ x: checkX, y: checkY, z: checkZ });
                                // [2.7.0] currentBlock.isValid() → currentBlock.isValid
                                if (!currentBlock || !currentBlock.isValid) continue;

                                // 地面绝对不能是空气、水或者岩浆
                                if (currentBlock.isAir || currentBlock.typeId.includes("lava") || currentBlock.typeId.includes("water")) continue;

                                // 精准抓取脚底和头顶两个高度的方块
                                const standBlock = dimension.getBlock({ x: checkX, y: checkY + 1, z: checkZ });
                                const headBlock = dimension.getBlock({ x: checkX, y: checkY + 2, z: checkZ });

                                // [2.7.0] standBlock.isValid() / headBlock.isValid() → 属性访问
                                if (standBlock && standBlock.isValid && headBlock && headBlock.isValid) {
                                    // 必须同时满足"脚底是空气"且"头顶也是空气"，提供足足2格高的净空人形生存空间
                                    if (standBlock.isAir && headBlock.isAir) {
                                        safeLocation = { x: checkX + 0.5, y: checkY + 1.05, z: checkZ + 0.5 };
                                        foundLand = true;
                                        break outerLoop;
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                }
            }

            // 执行同步秒传，彻底断绝排队烫死
            try {
                victim.teleport(safeLocation, { dimension: dimension });
                victim.extinguishFire(true);

                target.playSound("mob.endermen.portal");
                dimension.spawnParticle("minecraft:endrod", safeLocation);

                if (needFindLand) {
                    target.sendMessage("§e<女仆酱> 主人笨蛋！我先溜啦！");
                } else {
                    target.sendMessage("§e<女仆酱> 烫死啦！呜呜呜~");
                }
            } catch (e) {}

            // 1.5秒后释放冷却锁
            system.runTimeout(() => {
                try {
                    // [2.7.0] victim.isValid() → victim.isValid
                    if (victim && victim.isValid) {
                        victim.removeTag("dm:teleport_cooldown");
                    }
                } catch(e) {}
            }, 30);
        } else {
            try { victim.removeTag("dm:teleport_cooldown"); } catch(e) {}
        }
    }

    // 通用实体部分，执行弹跳
    else if (isDmEntity || isDemonEntity) {
        // 基本伤害类型过滤
        if (cause !== EntityDamageCause.lava &&
            cause !== EntityDamageCause.fireTick &&
            cause !== EntityDamageCause.fire) return;

        // 带抗火时不触发弹跳
        try {
            if (victim.getEffect("fire_resistance")) return;
        } catch(e) {}

        // 简单环境校对：确认确实站在岩浆里
        let realInLava = false;
        try {
            const footBlock = victim.dimension.getBlock(victim.location);
            // [2.7.0] footBlock.isValid() → footBlock.isValid
            if (footBlock && footBlock.isValid && footBlock.typeId.includes("lava")) {
                realInLava = true;
            }
        } catch (e) { return; }
        if (!realInLava) return;


        // 不加冷却标签、不加抗火、不灭火，直接温和弹跳挣脱
        // 寻找附近的安全方向
        const currentPos = victim.location;
        const searchRadius = 3;
        let safeX = 0;
        let safeZ = 0;
        let foundSafe = false;

        for (let dx = -searchRadius; dx <= searchRadius && !foundSafe; dx++) {
            for (let dz = -searchRadius; dz <= searchRadius && !foundSafe; dz++) {
                try {
                    const checkX = Math.floor(currentPos.x) + dx;
                    const checkZ = Math.floor(currentPos.z) + dz;
                    const checkY = Math.floor(currentPos.y);

                    const groundBlock = victim.dimension.getBlock({ x: checkX, y: checkY, z: checkZ });
                    // [2.7.0] groundBlock.isValid() → groundBlock.isValid
                    if (!groundBlock || !groundBlock.isValid) continue;

                    if (!groundBlock.typeId.includes("lava") &&
                        !groundBlock.isAir &&
                        !groundBlock.typeId.includes("water")) {

                        const standBlock = victim.dimension.getBlock({ x: checkX, y: checkY + 1, z: checkZ });
                        // [2.7.0] standBlock.isValid() → standBlock.isValid
                        if (standBlock && standBlock.isValid && standBlock.isAir) {
                            safeX = checkX + 0.5 - currentPos.x;
                            safeZ = checkZ + 0.5 - currentPos.z;
                            foundSafe = true;
                        }
                    }
                } catch(e) {}
            }
        }

        // 没找到安全地块时随机选一个方向
        if (!foundSafe) {
            safeX = (Math.random() - 0.5) * 2;
            safeZ = (Math.random() - 0.5) * 2;
        }

        // 归一化方向
        const len = Math.sqrt(safeX * safeX + safeZ * safeZ) || 1;

        // 温和弹跳：水平 0.2 + 垂直 0.5，刚好跳出岩浆
        try {
            victim.clearVelocity();
            victim.applyImpulse({
                x: (safeX / len) * 0.2,
                y: 0.5,
                z: (safeZ / len) * 0.2
            });
        } catch(e) {}
    }
});
