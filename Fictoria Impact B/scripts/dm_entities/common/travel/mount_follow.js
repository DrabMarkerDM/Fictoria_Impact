/*
 * mount_follow.js — 骑乘：上马 / 下马 + 跟随模式下的载具驱动与朝向。
 * 分工：上马 → 引擎 `find_mount`（mount_ride 组，priority 1，半径 16），她会自己走过去跨上
 * 最近的坐骑，本模块的 `/ride` 只做兜底；战斗走位归引擎（mount_pathing + 攻击行为），近战 /
 * 远程 / 冲刺的冲量由 main.js 打在她本人身上，不再推载具；只有「跟随玩家」模式才推载具，走本
 * 模块的独立通道（直接 applyImpulse）。船 / 竹筏 / 带箱子的船不在本模块 —— 见
 * `common/travel/vehicle_follow.js`，脱困传送（太远 / 卡住 + 前方有坎）两边共用它的实现。
 * 跟随不交给 main.js 的原因：群骑纷争之后引擎对载具的物理处理变了（驯服马无鞍一步不动、带鞍
 * 一顿一顿），载具跟随的冲量若再走「她 → entityRidingOn」那条共用通道会和载具物理打架。
 * 三个修正（都源自「冲量只能推、不能转」）：
 * ① 朝向：applyImpulse 不改变 rotation，载具的 AI 会乱转 →「马身朝后、被推着倒着走」。驱动时
 * 把载具朝向强行对准玩家，女仆也用 setRotation 对齐（她不能 teleport，那会断骑乘）。
 * ⚠️ 转朝向的 teleport 必须带 keepVelocity，否则每转一次就把速度清零一次。
 * ② 速度：SAPI 没有写 `minecraft:movement` 的接口，能给载具加移速的只有 `speed` 效果，远距离
 * 补一层（近距离不补，避免贴脸冲刺）。
 * ③ 载具泛化：不再 `type=horse`，而是任意带 `minecraft:rideable` 的生物载具；船 / 矿车 /
 * 运输船排除（不吃冲量也不吃 speed）。
 * 门控：跟随才推 —— UI 的 `fictoria_ui:mode === 0`，或 UI 没写过时背包里有她的指令物品
 * （dm34 系 maid_command，其余 follow_command，判据在 follow_recall.isFollowing）。随机 / 巡逻一律松手。
 */
import { system, world } from "@minecraft/server";
import { isInCombat, factionOf } from "../core/camp_faction.js";
import { isPlayerMounted } from "./ride_guard.js";
import { checkVehicleRescue } from "./vehicle_follow.js";
import { refreshMaids, getMaids, isFollowing } from "./follow_recall.js";

const RIDE_TAG = "maid:mount_ride";

/** 非生物载具：船 / 各种矿车 / 运输船。它们不归本模块 ——
 *  船 / 竹筏 / 带箱子的船由 `common/travel/vehicle_follow.js` 单独驱动（冲量尺度不同）。 */
const NON_MOB_VEHICLE = ["boat", "minecart"];

/**
 * 冲量尺度：与 main.js 的 `CORE_SCALE = 0.028 * 34` 对齐。
 * 这边直接把速度乘成冲量打给载具，不经过 main.js 的 ActiveMovers。
 */
const IMPULSE_SCALE = 0.028 * 34;

/** 每 tick 最大速度变化（平滑，避免第一拍就把载具抽出去）。 */
const MAX_ACCEL = 0.02;

const CONFIG = {
    scanIntervalTicks: 20,
    // 上马
    mountSearchRadius: 16,
    // find_mount 是主力（引擎自己寻路走过去跨上），JS 的 /ride 只做兜底。
    // 兜底给足 10 秒：跟引擎抢「谁来上马」只会互相打断。
    mountRetryTicks: 200,
    // 下马重试：每 4 tick 发一次，最多 12 次（约 2.4 秒）
    dismountRetryTicks: 4,
    dismountAttempts: 12,
    // 跟随驱动的迟滞
    startDistance: 6,
    stopDistance: 2.5,
    // 指令速度（格/tick）。本模块自己乘 IMPULSE_SCALE 打给载具
    speed: 0.26,
    // 朝向修正间隔：太快会和载具自己的转身动画打架
    faceIntervalTicks: 4,
    // 朝向偏差小于这个角度就不动载具 —— 每一次 teleport 都是一次扰动
    faceDeadZoneDeg: 25,
    // 远处补一层移速效果；近距离不补，免得贴脸时冲得太猛
    boostEnabled: true,
    boostDistance: 7,
    boostDurationTicks: 40,
    boostAmplifier: 1,
    // 上坡辅助：水平冲量推不上一格台阶，卡住了补一下向上的冲量。
    // 0.62 是"马这种大碰撞箱"能稳定踩上一格台阶的量；前三跳用它，
    // 还上不去就用 climbHopY * climbHopBoost 再猛一档（陡坡 / 两格坡）。
    climbSampleTicks: 8,
    climbMinMove: 0.4,
    climbHopY: 0.62,
    climbHopBoost: 1.5,
    climbHopCooldown: 5,
    climbHopMax: 10,
    // 跳满 climbHopMax 还没挪窝就作废重来，别让一次陡坡把她永久判死
    climbResetTicks: 60,
    debug: false,
};

const YAW_PER_RAD = 180 / Math.PI;

/** id -> entity。只放「带骑乘 tag」的单位。 */
const Tracked = new Map();

/** id -> { unit, left, next }。正在等下马生效的单位。 */
const Dismounting = new Map();

/** id -> 上次尝试上马的 tick。 */
const MountAttempt = new Map();

/** id -> tick。刚下马的单位在这段时间内不许重新上马。 */
const MountBlockedUntil = new Map();

/** id -> true。当前正在被跟随驱动推的单位（阈值迟滞用）。 */
const Driving = new Set();

/** id -> 上次朝向修正的 tick。 */
const LastFace = new Map();

/** id -> { x, z } 平滑后的驱动速度（每 tick 施加到载具）。 */
const Drive = new Map();

/** id -> { x, z, t, tries, next }。上坡辅助的位移采样。 */
const Climb = new Map();

function log(...args) {
    if (CONFIG.debug) {
        console.warn(...args);
    }
}

// 限流日志：上坡辅助这类"错了就变成马原地蹬腿"的地方不许静默。
const ErrCount = new Map();
function logErr(key, e, max = 3) {
    const n = (ErrCount.get(key) || 0) + 1;
    if (n > max) return;
    ErrCount.set(key, n);
    console.warn(`[MountFollow] 异常 ${key}: ${e}`);
}

function ridingOn(unit) {
    try {
        return unit.getComponent("minecraft:riding")?.entityRidingOn;
    } catch (_) {
        return undefined;
    }
}

/**
 * 主人解析：引擎 tameable 优先，动态属性 ownerId 只作补录。
 * 顺序不能反 —— ownerId 是「谁先碰写谁」，多人生存里会被别人写脏。
 */
function resolveOwner(unit) {
    try {
        const tameable = unit.getComponent("minecraft:tameable");
        const tamedId = tameable?.tamedToPlayerId;

        if (tamedId) {
            const player = world.getEntity(tamedId);

            if (player?.isValid) return player;
        }
    } catch (_) { /* 组件不可用 / 玩家离线 */ }

    try {
        const dpId = unit.getDynamicProperty("ownerId");

        if (typeof dpId === "string" && dpId.length > 0) {
            const player = world.getEntity(dpId);

            if (player?.isValid) return player;
        }
    } catch (_) { }

    return undefined;
}

function scan(nowTick) {
    // 名单抄 manager 的登记表（全干员，零查询）；只留「打过骑乘标」的那几只。
    // 骑乘标由 JSON 的 mount_on 事件打，所以她跨上载具后才进这张表。
    refreshMaids(nowTick ?? system.currentTick);

    const seen = new Set();

    for (const [id, unit] of getMaids()) {
        try {
            if (!unit?.isValid || !unit.hasTag(RIDE_TAG)) continue;
        } catch (_) {
            continue;
        }

        seen.add(id);
        Tracked.set(id, unit);
    }

    for (const id of [...Tracked.keys()]) {
        if (!seen.has(id)) {
            Tracked.delete(id);
            MountAttempt.delete(id);
            Driving.delete(id);
            Drive.delete(id);
            LastFace.delete(id);
            Climb.delete(id);
        }
    }
}

function release(id) {
    Driving.delete(id);
    Drive.delete(id);
    LastFace.delete(id);
    Climb.delete(id);
}

/** 前方是不是"可以跨上去的台阶"：脚下那格实心、上面那格透气。
 *  两格高的墙跳上去也没用，交给 teleport 救援。
 *  查 0.9 / 1.4 两档：马的碰撞箱宽，差半格没贴上去时 1.1 那一档会读成空气。 */
function stepAhead(mount, dx, dz, dist) {
    try {
        const loc = mount.location;
        const dim = mount.dimension;
        const inv = 1 / (dist || 1);
        const fy = Math.floor(loc.y + 0.2);

        for (const ahead of [0.9, 1.4]) {
            const fx = Math.floor(loc.x + dx * inv * ahead);
            const fz = Math.floor(loc.z + dz * inv * ahead);

            const foot = dim.getBlock({ x: fx, y: fy, z: fz });
            const head = dim.getBlock({ x: fx, y: fy + 1, z: fz });

            if (!foot || !head) continue;
            if (foot.isAir || foot.isLiquid) continue;
            if (!head.isAir) continue;
            return true;
        }
        return false;
    } catch (e) {
        logErr("climb_step", e);
        return false;
    }
}

/** 上坡辅助：卡住 + 前方有台阶 → 补一小股向上的冲量。
 *  纯水平冲量没有"抬腿"，马会一直顶着台阶原地蹬。 */
function climbAssist(mount, id, dx, dz, dist, drive, nowTick) {
    const loc = mount.location;
    let rec = Climb.get(id);

    if (!rec) {
        Climb.set(id, { x: loc.x, z: loc.z, t: nowTick, tries: 0, next: 0 });
        return;
    }

    if (nowTick - rec.t < CONFIG.climbSampleTicks) return;

    const moved = Math.hypot(loc.x - rec.x, loc.z - rec.z);

    rec.x = loc.x;
    rec.z = loc.z;
    rec.t = nowTick;

    if (moved >= CONFIG.climbMinMove) {
        rec.tries = 0;
        return;
    }

    if (rec.tries >= CONFIG.climbHopMax) {
        // 跳满了还是没挪窝 → 隔 climbResetTicks 重开一轮。永久判死 = 永远爬不上去
        if (nowTick - rec.t >= (CONFIG.climbResetTicks || 60)) {
            rec.tries = 0;
            rec.next = 0;
        } else {
            return;
        }
    }
    if (nowTick < rec.next) return;
    if (!stepAhead(mount, dx, dz, dist)) return;

    rec.tries += 1;
    rec.next = nowTick + CONFIG.climbHopCooldown;
    rec.lastHop = nowTick;      // 救援判定看这个：正在爬坡就先别传送

    // 前几跳正常力度，连续跳不动说明坡更陡 → 再抬一档
    const hopY = rec.tries > 3
        ? CONFIG.climbHopY * (CONFIG.climbHopBoost || 1.5)
        : CONFIG.climbHopY;

    try {
        mount.applyImpulse({
            x: drive.x * IMPULSE_SCALE,
            y: hopY,
            z: drive.z * IMPULSE_SCALE,
        });
        log(`[MountFollow] ${mount.typeId} 上坡，补 ${hopY.toFixed(2)} 冲量（第 ${rec.tries} 次）`);
    } catch (e) {
        logErr("climb_hop", e);
    }
}

/** 最近刚补过向上冲量 = 正在爬坡，这时候别传送（传送会把"爬上去"变成"闪现过去"）。 */
function climbBusy(id, nowTick) {
    const rec = Climb.get(id);
    if (!rec || !rec.lastHop) return false;
    return nowTick - rec.lastHop < (CONFIG.climbResetTicks || 60);
}

/**
 * 判断一只实体能不能当载具：
 * 有 `minecraft:rideable`、座位空着、不是船 / 矿车、不是她自己。
 */
function isMountable(e, selfId, selfType) {
    if (!e || !e.isValid || e.id === selfId) return false;

    // 不骑同类：两只女仆互相骑会叠罗汉，也不是「载具」
    if (e.typeId === selfType) return false;

    const tid = e.typeId;

    for (const bad of NON_MOB_VEHICLE) {
        if (tid.includes(bad)) return false;
    }

    try {
        const rideable = e.getComponent("minecraft:rideable");

        if (!rideable) return false;

        const riders = rideable.getRiders?.() ?? [];

        return riders.length === 0;
    } catch (_) {
        return false;
    }
}

/** 就近找一只可骑的生物载具。不限定物种，马 / 驴 / 猪 / 羊驼都行。 */
function findVehicle(unit) {
    let list;

    try {
        list = unit.dimension.getEntities({
            location: unit.location,
            maxDistance: CONFIG.mountSearchRadius,
            families: ["mob"],
        });
    } catch (_) {
        return undefined;
    }

    const ul = unit.location;
    let best;
    let bestSq = Infinity;

    for (const e of list) {
        if (!isMountable(e, unit.id, unit.typeId)) continue;

        const loc = e.location;
        const dx = loc.x - ul.x;
        const dz = loc.z - ul.z;
        const sq = dx * dx + dz * dz;

        if (sq < bestSq) {
            bestSq = sq;
            best = e;
        }
    }

    return best;
}

/*
 * 用指令让她骑上最近的生物载具。
 * 不用引擎的 `find_mount`：它会先寻路到载具边再跨上去，而那套导航和 `mount_pathing` 是配套的，
 * 这里只要「坐下」这一个动作。用 `type=<typeId>` 精确匹配：`/ride` 的选择器没法排除她自己，
 * 靠类型锁住目标最省事（同类多只时选最近的，差别不大）。
 */
function tryMount(unit, nowTick) {
    const blocked = MountBlockedUntil.get(unit.id) ?? -1;

    if (nowTick < blocked) return;

    const last = MountAttempt.get(unit.id) ?? -99999;

    if (nowTick - last < CONFIG.mountRetryTicks) return;

    MountAttempt.set(unit.id, nowTick);

    const vehicle = findVehicle(unit);

    if (!vehicle) return;

    try {
        unit.runCommand(
            `ride @s start_riding @e[type=${vehicle.typeId},c=1,r=4]`
        );
        log(`[MountFollow] ${unit.typeId} → 上 ${vehicle.typeId}`);
    } catch (_) { /* 没座位 / 距离不够 / 已被骑 → 下一轮再试 */ }
}

function sendDismount(unit) {
    try {
        unit.runCommand("ride @s stop_riding");
    } catch (_) { /* 已经不在马上 / 命令失败 → 下一轮重试 */ }
}

/*
 * 立刻让她下马，并在之后约 2.4 秒内重试。由 UI 的「解除骑乘」调用。
 * 单发 `stop_riding` 有失败可能（载具旁边没有落点、区块刚加载等），表现为「点了解除骑乘，
 * 她还在上面」。同时 SAPI 直接摘 tag：`mount_off` 的 tag 移除走的是 queue_command，那条命令
 * 要是没跑成 tag 会留到下一轮，`tryMount` 就会把她又骑回去。
 */
export function dismountNow(unit) {
    if (!unit || !unit.isValid) return;

    try {
        unit.removeTag(RIDE_TAG);
    } catch (_) { }

    Tracked.delete(unit.id);
    MountAttempt.delete(unit.id);
    MountBlockedUntil.set(unit.id, system.currentTick + 100);

    Dismounting.set(unit.id, {
        unit,
        left: CONFIG.dismountAttempts,
        next: system.currentTick,
    });

    sendDismount(unit);
    log(`[MountFollow] ${unit.typeId} → 下马`);
}

function pumpDismount(nowTick) {
    for (const [id, rec] of Dismounting) {
        const unit = rec.unit;

        if (!unit || !unit.isValid) {
            Dismounting.delete(id);
            continue;
        }

        const mount = ridingOn(unit);

        if (!mount || !mount.isValid) {
            Dismounting.delete(id);
            continue;
        }

        if (rec.left <= 0) {
            log(`[MountFollow] ${unit.typeId} 下马重试耗尽`);
            Dismounting.delete(id);
            continue;
        }

        if (nowTick < rec.next) continue;

        rec.left -= 1;
        rec.next = nowTick + CONFIG.dismountRetryTicks;
        sendDismount(unit);
    }
}

/** 上马：只处理「带 tag 却不在载具上」，绝不干预已在载具上的单位。 */
function pumpMount(nowTick) {
    for (const [id, unit] of Tracked) {
        try {
            if (!unit.isValid) {
                Tracked.delete(id);
                MountAttempt.delete(id);
                continue;
            }

            if (Dismounting.has(id)) continue;

            const mount = ridingOn(unit);

            if (mount && mount.isValid) continue;

            if (isPlayerMounted(unit)) continue;

            tryMount(unit, nowTick);
        } catch (_) { }
    }
}

function yawToward(from, tx, tz) {
    const dx = tx - from.x;
    const dz = tz - from.z;

    if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) return undefined;

    // Bedrock：yaw 0 面向 +Z，90 面向 -X
    return Math.atan2(-dx, dz) * YAW_PER_RAD;
}

/*
 * 强行把载具转向目标。
 * 不用 `setRotation`：mob 的朝向由行为系统每 tick 重写（转头功能上已踩过），`teleport` 的
 * rotation 是引擎在位移之后写入的，能撑到下一个 AI 决策。传送到自身当前位置，不产生位移、
 * 不会把她甩下坐骑。
 * ⚠️ 必须带 `keepVelocity: true`：teleport 会清零载具速度，而跟随是靠逐 tick 冲量加速度的 ——
 * 每 4 tick 清一次就是「走三步顿一下」，视觉上和掉帧一样，加多少级速度 buff 都没用（buff 加的
 * 是上限，被清零的是当前速度）。偏差小于 25° 时干脆不转，少一次 teleport 就少一次扰动。
 */
function faceVehicle(mount, tx, tz) {
    const yaw = yawToward(mount.location, tx, tz);

    if (yaw === undefined) return;

    try {
        const now = mount.getRotation().y;
        let delta = yaw - now;

        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;

        if (Math.abs(delta) < CONFIG.faceDeadZoneDeg) return;
    } catch (_) {
        // 读不到朝向就照转，宁可视差不要倒退走
    }

    try {
        mount.teleport(mount.location, {
            rotation: { x: 0, y: yaw },
            keepVelocity: true,
        });
    } catch (_) { }
}

/*
 * 跟随驱动：只在「跟随玩家」模式、非战斗、她自己骑在载具上时，把冲量直接打到载具身上。
 * 不走 main.js 的 ActiveMovers：那条通道是她的「走位引擎」，冲量必须落在她本人身上 —— 骑乘时
 * 打给载具会和群骑纷争之后的载具物理互相打架；跟随是另一件事，单独开一条通道。
 * 每 tick 施加一次，速度经 MAX_ACCEL 平滑；松手时只是不再加，交给载具自己的阻尼收住 ——
 * 直接 clearVelocity 会更顿。
 */
function pumpFollow(nowTick) {
    for (const [id, unit] of Tracked) {
        try {
            if (!unit.isValid) {
                release(id);
                Tracked.delete(id);
                continue;
            }

            const mount = ridingOn(unit);

            if (!mount || !mount.isValid) {
                release(id);
                continue;
            }

            if (Dismounting.has(id) || isPlayerMounted(unit)) {
                release(id);
                continue;
            }

            // 战斗：走位归引擎（mount_pathing + 攻击行为），这里整块让位。
            if (isInCombat(unit, factionOf(unit))) {
                release(id);
                continue;
            }

            // 硬门控：跟随才推（UI 的 mode=0，或 UI 没写过时背包里有 maid_command /
            // follow_command）。随机 / 巡逻一律松手。
            if (!isFollowing(unit)) {
                release(id);
                continue;
            }

            const owner = resolveOwner(unit);

            if (!owner || !owner.isValid || owner.dimension.id !== unit.dimension.id) {
                release(id);
                continue;
            }

            const dx = owner.location.x - unit.location.x;
            const dz = owner.location.z - unit.location.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            // 先过「要不要驱动」这道闸，再谈救援 ——
            // 她乖乖停在主人旁边（dist < startDistance）时马本来就不该动，
            // 这时候去判「1.5 秒没挪窝」会把站着不动的马当成卡住，一有坎就乱传。
            if (!Driving.has(id)) {
                if (dist < CONFIG.startDistance) continue;

                Driving.add(id);
            } else if (dist <= CONFIG.stopDistance) {
                release(id);
                continue;
            }

            // 脱困：离主人太远 / 正在赶路却卡住且前方有坎 → 只把马传送过去
            // （她跟着走，两个都传会直接断骑乘）。由 vehicle_follow 统一实现，船也用它。
            // 只在真的「追不上」（超过 startDistance）时启用：贴脸停着的马不算卡住。
            // ⚠ 刚补过爬坡冲量时先不传送 —— 让她自己爬上去，别打断成"闪现"。
            if (dist > CONFIG.startDistance
                && !climbBusy(id, nowTick)
                && checkVehicleRescue(mount, owner, nowTick)) {
                release(id);
                continue;
            }

            const inv = 1 / (dist || 1);

            // 越近越慢，避免贴到主人身上再被推开
            const fade = Math.min(1, (dist - CONFIG.stopDistance) / CONFIG.startDistance);
            const speed = CONFIG.speed * (0.35 + 0.65 * fade);

            let drive = Drive.get(id);

            if (!drive) {
                drive = { x: 0, z: 0 };
                Drive.set(id, drive);
            }

            drive.x = approachStep(drive.x, dx * inv * speed, MAX_ACCEL);
            drive.z = approachStep(drive.z, dz * inv * speed, MAX_ACCEL);

            try {
                mount.applyImpulse({
                    x: drive.x * IMPULSE_SCALE,
                    y: 0,
                    z: drive.z * IMPULSE_SCALE,
                });
            } catch (e) {
                logErr("drive_impulse", e);
            }

            // 顶着台阶时补一下向上的冲量（放在救援之前，多数情况不用传送）
            climbAssist(mount, id, dx, dz, dist, drive, nowTick);

            // 朝向：马头必须冲着玩家。
            // 载具用 teleport 的 rotation（AI 每 tick 重写 setRotation）；
            // 她自己只能 setRotation —— 对骑手 teleport 会直接断骑乘。
            const lastFace = LastFace.get(id) ?? -99999;

            if (nowTick - lastFace >= CONFIG.faceIntervalTicks) {
                LastFace.set(id, nowTick);

                faceVehicle(mount, owner.location.x, owner.location.z);

                const yaw = yawToward(unit.location, owner.location.x, owner.location.z);

                if (yaw !== undefined) {
                    try {
                        unit.setRotation({ x: 0, y: yaw });
                    } catch (_) { }
                }
            }

            // 远处补一层 speed：载具的 movement 有上限，纯冲量顶不上去。
            if (CONFIG.boostEnabled && dist > CONFIG.boostDistance) {
                const opts = {
                    amplifier: CONFIG.boostAmplifier,
                    showParticles: false,
                };

                try {
                    mount.addEffect("speed", CONFIG.boostDurationTicks, opts);
                } catch (_) { }

                try {
                    unit.addEffect("speed", CONFIG.boostDurationTicks, opts);
                } catch (_) { }
            }

            log(`[MountFollow] ${unit.typeId} on ${mount.typeId} → ${dist.toFixed(1)} 格，speed=${speed.toFixed(2)}`);
        } catch (_) {
            // 单个单位异常不拖垮整轮
        }
    }
}

/** 速度平滑：每 tick 最多变 maxDelta，避免第一拍就把载具抽出去。 */
function approachStep(cur, target, maxDelta) {
    const diff = target - cur;

    if (diff > maxDelta) return cur + maxDelta;
    if (diff < -maxDelta) return cur - maxDelta;

    return target;
}

function tick() {
    const nowTick = system.currentTick;

    pumpDismount(nowTick);
    pumpMount(nowTick);
    pumpFollow(nowTick);
}

export function initMountFollow() {
    scan(system.currentTick);

    system.runInterval(() => scan(system.currentTick), CONFIG.scanIntervalTicks);
    // 上/下马每 2 tick 一次都嫌密；但跟随的冲量必须每 tick —— 它是按拍累加的。
    // 这一条路径只遍历 Tracked（通常 0-3 只），空转成本可以忽略。
    system.runInterval(tick, 1);

    // 启动横幅默认打开；其余骑乘日志仍归 CONFIG.debug
    console.warn("[MountFollow] 骑乘：上/下马 + 跟随驱动（每 tick 推载具 + 朝向）已加载");
}
