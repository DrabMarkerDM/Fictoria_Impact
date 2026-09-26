import { system, world, EntityDamageCause } from "@minecraft/server";

const VALID_FAMILIES = ["dm", "player", "villager", "iron_golem", "snow_golem"];

const EXPLOSION_RADIUS = 4.0;
const EXPLOSION_DAMAGE = 20;
const EXPLOSION_KNOCKBACK = 1.0;
const LIGHT_BLOCK = "block:dm_light_1";
const LIGHT_DURATION_TICKS = 2;
const TRIGGER_RADIUS = 1.0;
const CHECK_INTERVAL = 3;
const MAX_ACTIVE_TICKS = 180 * 20; // 180秒后熔断半径检测，只保留 onStepOn

function hasValidFamily(entity) {
    const familyComp = entity.getComponent("minecraft:type_family");
    if (!familyComp) return false;
    for (const family of VALID_FAMILIES) {
        if (familyComp.hasTypeFamily(family)) return true;
    }
    return false;
}

function applyExplosionDamage(dimension, location) {
    const center = {
        x: location.x + 0.5,
        y: location.y + 0.5,
        z: location.z + 0.5
    };

    const allEntities = dimension.getEntities({
        location: center,
        maxDistance: EXPLOSION_RADIUS,
        excludeTypes: ["minecraft:item"]
    });

    const targets = allEntities.filter(e => {
        if (!e.isValid) return false;
        if (e.typeId === "minecraft:item") return false;
        return hasValidFamily(e);
    });

    for (const target of targets) {
        try {
            target.applyDamage(EXPLOSION_DAMAGE, {
                cause: EntityDamageCause.override
            });

            const dx = target.location.x - center.x;
            const dz = target.location.z - center.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > 0.01) {
                target.applyImpulse({
                    x: (dx / dist) * EXPLOSION_KNOCKBACK,
                    y: 0.6,
                    z: (dz / dist) * EXPLOSION_KNOCKBACK
                });
            }
        } catch (e) {}
    }
}

function triggerExplosion(dimension, location) {
    // ★ 防重复：方块已不是地雷说明已经炸过
    try {
        const currentBlock = dimension.getBlock(location);
        if (!currentBlock || currentBlock.typeId !== "block:demon_landmine") return;
    } catch (e) { return; }

    dimension.playSound("demon_landmine", location, { volume: 1.0, pitch: 1.0 });

    const particleLocation = {
        x: location.x + 0.5,
        y: location.y + 0.5,
        z: location.z + 0.5
    };

    dimension.spawnParticle("dm:dm_smoke", particleLocation);
    dimension.spawnParticle("minecraft:huge_explosion_emitter", particleLocation);
    dimension.spawnParticle("minecraft:large_explosion", particleLocation);
    dimension.spawnParticle("dm:smash_particle", particleLocation);
    dimension.spawnParticle("dm:dust_particle", particleLocation);

    applyExplosionDamage(dimension, location);

    const lightLocation = { x: location.x, y: location.y + 1, z: location.z };
    try {
        dimension.setBlockType(lightLocation, LIGHT_BLOCK);
        system.runTimeout(() => {
            try {
                const currentBlock = dimension.getBlock(lightLocation);
                if (currentBlock && currentBlock.typeId === LIGHT_BLOCK) {
                    dimension.setBlockType(lightLocation, "minecraft:air");
                }
            } catch (e) {}
        }, LIGHT_DURATION_TICKS);
    } catch (e) {}

    // 清除地雷（必须在连锁检测之前，防止重复触发自身）
    dimension.setBlockType(location, "minecraft:air");

    // ★ 连锁爆炸：搜索范围内其他地雷
    chainExplode(dimension, location);

    const capturedDimensionId = dimension.id;
    system.run(() => {
        try {
            const dim = world.getDimension(capturedDimensionId);
            const players = dim.getPlayers();
            if (players.length > 0) {
                players[0].runCommand("function explosion");
            }
        } catch (e) {}
    });
}

// ★ 连锁爆炸：搜索爆炸范围内其他地雷并延迟触发
function chainExplode(dimension, location) {
    const chainRadius = Math.floor(EXPLOSION_RADIUS);
    const chainTargets = [];

    for (let dx = -chainRadius; dx <= chainRadius; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dz = -chainRadius; dz <= chainRadius; dz++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                if (dx * dx + dy * dy + dz * dz > chainRadius * chainRadius) continue;

                const checkPos = {
                    x: location.x + dx,
                    y: location.y + dy,
                    z: location.z + dz
                };

                try {
                    const block = dimension.getBlock(checkPos);
                    if (block && block.typeId === "block:demon_landmine") {
                        chainTargets.push({ x: checkPos.x, y: checkPos.y, z: checkPos.z });
                    }
                } catch (e) {}
            }
        }
    }

    if (chainTargets.length > 0) {
        system.runTimeout(() => {
            for (const target of chainTargets) {
                try {
                    triggerExplosion(dimension, target);
                } catch (e) {}
            }
        }, 3); // 延迟3tick，连锁有视觉层次感
    }
}

system.beforeEvents.startup.subscribe((initEvent) => {
    initEvent.blockComponentRegistry.registerCustomComponent(
        "block:demon_landmine",
        {
            onPlace(event) {
                const { block } = event;
                block.dimension.playSound("demon_landmine", block.location, { volume: 1.0, pitch: 1.0 });

                const capturedDimensionId = block.dimension.id;
                const capturedLocation = { x: block.location.x, y: block.location.y, z: block.location.z };
                const placeTick = system.currentTick;

                const checkInterval = system.runInterval(() => {
                    try {
                        const dim = world.getDimension(capturedDimensionId);

                        // ★ 熔断：播放提示音效，停止半径检测
                        if (system.currentTick - placeTick > MAX_ACTIVE_TICKS) {
                            try {
                                dim.playSound("demon_landmine", capturedLocation, { volume: 1.0, pitch: 1.0 });
                            } catch (e) {}
                            system.clearRun(checkInterval);
                            return;
                        }

                        const currentBlock = dim.getBlock(capturedLocation);

                        // 区块未加载：跳过本次检测，不清除定时器
                        if (!currentBlock) {
                            return;
                        }

                        // 方块真的被替换了，清除定时器
                        if (currentBlock.typeId !== "block:demon_landmine") {
                            system.clearRun(checkInterval);
                            return;
                        }

                        const blockCenter = {
                            x: capturedLocation.x + 0.5,
                            y: capturedLocation.y + 0.5,
                            z: capturedLocation.z + 0.5
                        };

                        const nearbyEntities = dim.getEntities({
                            location: blockCenter,
                            maxDistance: TRIGGER_RADIUS,
                            excludeTypes: ["minecraft:item", "minecraft:xp_orb", "minecraft:arrow"]
                        });

                        for (const entity of nearbyEntities) {
                            if (!entity.isValid) continue;
                            if (!hasValidFamily(entity)) continue;

                            const ex = entity.location.x;
                            const ey = entity.location.y;
                            const ez = entity.location.z;

                            if (Math.abs(ex - blockCenter.x) <= TRIGGER_RADIUS &&
                                Math.abs(ez - blockCenter.z) <= TRIGGER_RADIUS &&
                                ey >= capturedLocation.y - 0.5 &&
                                ey <= capturedLocation.y + 1.5) {
                                system.clearRun(checkInterval);
                                triggerExplosion(dim, capturedLocation);
                                return;
                            }
                        }
                    } catch (e) {
                        // 异常不清除定时器，可能是区块卸载导致的临时错误
                    }
                }, CHECK_INTERVAL);
            },

            onStepOn(event) {
                const { block, entity } = event;
                if (!entity || !entity.isValid) return;
                if (!hasValidFamily(entity)) return;

                try {
                    const currentBlock = block.dimension.getBlock(block.location);
                    if (!currentBlock || currentBlock.typeId !== "block:demon_landmine") return;
                } catch (e) { return; }

                triggerExplosion(block.dimension, block.location);
            }
        }
    );
});