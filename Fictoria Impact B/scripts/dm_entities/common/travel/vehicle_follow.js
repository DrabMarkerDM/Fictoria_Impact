/*
 * vehicle_follow.js — 跟随模式下的「非生物载具」调度：船 / 竹筏 / 带箱子的船。
 * 分工：骑马跟随（common/travel/mount_follow.js）只管生物载具（马、驴、猪、羊驼）；船 / 竹筏 / 矿车
 * 是另一套物理（吃冲量但不吃 speed 效果、会漂、有浮力），塞进 mount_follow 会把调好的马匹
 * 参数搅乱。通用部分不在本文件 —— 模式判定、主人解析、落点查找、38 格召回全在
 * `common/travel/follow_recall.js`，那里是任何实体都能用的基础设施；本文件只留「船」这一件事，
 * 外加两边共用的脱困判定。
 * 两件事：① 划船跟随 —— 她坐在船上、处于跟随模式 → 每 tick 给船加冲量并修正朝向。船型不
 * 枚举（基岩 1.20+ 把 boat 拆成 oak_boat / spruce_boat / bamboo_raft / oak_chest_boat /
 * bamboo_chest_raft …），统一按后缀 `boat` / `raft` 判定，新船型自动覆盖。
 * ② 脱困 —— 载具 1.5 秒位移过小 + 前方有明显高度差 → 传送到主人身边；离主人 > 40 格也直接
 * 传一次。马和船共用 `checkVehicleRescue`。
 * 性能：先读跟随标志（UI 的 mode，或没写过时看指令物品），不是跟随立刻跳过，随机 / 巡逻零开销。
 * 干员表由 follow_recall 维护（20 tick 一刷，名单 = manager 配置表全量干员），本模块不重复 getEntities。
 */
import { system } from "@minecraft/server";
import { isPlayerMounted } from "./ride_guard.js";
import {
    isFollowing,
    resolveOwner,
    findLandingSpot,
    refreshMaids,
    getMaids,
} from "./follow_recall.js";

const YAW_PER_RAD = 180 / Math.PI;

const CONFIG = {
    // --- 上船 ---
    // 只有主人**正坐在船上**时才让她上船；主人在岸上时不上，
    // 否则她会见船就爬，把停在岸边的船当坐骑。
    boardRange: 16,
    boardRetryTicks: 100,

    // --- 船驱动 ---
    startDistance: 7,
    stopDistance: 3,
    speed: 0.42,
    maxAccel: 0.03,
    // 船比马重，冲量放大 1.6 倍；仍按 main.js 的尺度做基准
    impulseScale: 0.028 * 34 * 1.6,
    faceIntervalTicks: 6,
    faceDeadZoneDeg: 20,

    // --- 脱困 ---
    // 每 10 tick 采样一次位移，连续 3 次（30 tick = 1.5 秒）都小于
    // stuckMinMove 就算卡住；卡住同时前方有高度差才传送。
    stuckSampleTicks: 10,
    stuckMinMove: 0.6,
    stuckTriggerTicks: 30,
    heightStep: 1.0,
    // 载具离主人超过这个距离，不等卡住判定了，直接送过去
    farTeleportDistance: 40,
    rescueCooldownTicks: 40,

    debug: false,
};

/** 载具 id -> { x, z, t, since }，脱困采样 */
const Stuck = new Map();

/** 载具 id -> tick，传送冷却 */
const RescueAt = new Map();

/** 女仆 id -> tick，上次尝试上船 */
const BoardAt = new Map();

/** 女仆 id -> { x, z } 平滑后的驱动速度 */
const Drive = new Map();

/** 女仆 id -> tick，上次修正朝向 */
const LastFace = new Map();

function log(...args) {
    if (CONFIG.debug) {
        console.warn(...args);
    }
}

function ridingOn(unit) {
    try {
        return unit.getComponent("minecraft:riding")?.entityRidingOn;
    } catch (_) {
        return undefined;
    }
}

/*
 * 载具分类。
 * 不写死类型清单：基岩 1.20+ 把 boat 拆成 oak_boat / spruce_boat / mangrove_boat /
 * cherry_boat / bamboo_raft / oak_chest_boat / bamboo_chest_raft …（竹筏和带箱子的船都在内），
 * 后续再出新木种也不必回来改这里。
 */
export function vehicleKind(entity) {
    if (!entity) return undefined;

    const id = entity.typeId;

    if (id.includes("boat") || id.includes("raft")) return "boat";
    if (id.includes("minecart")) return "minecart";

    return undefined;
}

// ============================================================
// 脱困（马 / 船共用）
// ============================================================

/*
 * 采样载具位移，判断是否卡住。
 * 用「周期性采样 + 连续 N 次都动不了」而不是「每 tick 算速度」：载具在被推、被 AI 拽、被水流
 * 带的时候瞬时速度会反复归零，逐 tick 判会误报；按 10 tick 窗口看净位移才靠谱。
 */
function trackStuck(vehicle, nowTick) {
    const loc = vehicle.location;
    const rec = Stuck.get(vehicle.id);

    if (!rec) {
        Stuck.set(vehicle.id, { x: loc.x, z: loc.z, t: nowTick, since: -1 });
        return false;
    }

    if (nowTick - rec.t < CONFIG.stuckSampleTicks) return false;

    const moved = Math.hypot(loc.x - rec.x, loc.z - rec.z);

    rec.x = loc.x;
    rec.z = loc.z;
    rec.t = nowTick;

    if (moved >= CONFIG.stuckMinMove) {
        rec.since = -1;
        return false;
    }

    if (rec.since < 0) {
        rec.since = nowTick;
        return false;
    }

    if (nowTick - rec.since >= CONFIG.stuckTriggerTicks) {
        rec.since = -1;   // 报一次就复位，别每 tick 都喊卡住
        return true;
    }

    return false;
}

/** 从 (x, y, z) 往上 2 格开始往下找第一块实心地面，找不到返回 undefined。 */
function groundY(dimension, x, y, z) {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const top = Math.floor(y) + 2;

    for (let by = top; by >= top - 6; by--) {
        try {
            const block = dimension.getBlock({ x: bx, y: by, z: bz });

            if (block && !block.isAir && !block.isLiquid) return by;
        } catch (_) {
            return undefined;
        }
    }

    return undefined;
}

/*
 * 前方是否有明显高度差。
 * 沿「载具 → 主人」方向取 2 格处的地面高度，和自己脚下的比。差 1 格以上就算 —— 马跨不过
 * 一格陡坎、船在落差处会搁浅，正是「被地形卡住」的典型形态。
 */
function hasHeightStep(vehicle, target, dimension) {
    const loc = vehicle.location;
    const dx = target.x - loc.x;
    const dz = target.z - loc.z;
    const len = Math.hypot(dx, dz);

    if (len < 0.5) return false;

    const here = groundY(dimension, loc.x, loc.y, loc.z);
    const there = groundY(
        dimension,
        loc.x + (dx / len) * 2,
        loc.y,
        loc.z + (dz / len) * 2
    );

    if (here === undefined || there === undefined) return false;

    return Math.abs(there - here) >= CONFIG.heightStep;
}

/*
 * 把载具传送到主人身边。
 * ⚠️ 只传载具，不传骑手 —— 骑手会跟着载具一起过去（引擎行为）。两个都传反而会让她下马
 * （骑手 teleport 会断骑乘关系）。
 */
export function teleportVehicleNearPlayer(vehicle, owner) {
    const spot = findLandingSpot(owner);

    try {
        vehicle.teleport(spot, { dimension: owner.dimension });
        Stuck.delete(vehicle.id);

        return true;
    } catch (e) {
        log(`[VehicleFollow] ${vehicle.typeId} 传送失败: ${e}`);
        return false;
    }
}

/*
 * 载具救援：远距 → 传送；卡住 + 前方高度差 → 传送。由 mount_follow（马）和本模块（船）共用。
 * @returns {boolean} 这一轮是否已经传送过（调用方应跳过本 tick 的驱动）
 */
export function checkVehicleRescue(vehicle, owner, nowTick) {
    if (!vehicle?.isValid || !owner?.isValid) return false;

    const last = RescueAt.get(vehicle.id) ?? -99999;

    if (nowTick - last < CONFIG.rescueCooldownTicks) return false;

    const loc = vehicle.location;
    const ol = owner.location;
    const dist = Math.hypot(loc.x - ol.x, loc.z - ol.z);

    // ① 太远：不再等卡住判定，直接送过去
    if (dist > CONFIG.farTeleportDistance) {
        RescueAt.set(vehicle.id, nowTick);

        if (teleportVehicleNearPlayer(vehicle, owner)) {
            log(`[VehicleFollow] ${vehicle.typeId} 太远（${dist.toFixed(1)}）→ 传送`);
            return true;
        }

        return false;
    }

    // ② 卡住 + 前方有坎
    const stuck = trackStuck(vehicle, nowTick);

    if (!stuck) return false;

    if (!hasHeightStep(vehicle, ol, vehicle.dimension)) return false;

    RescueAt.set(vehicle.id, nowTick);

    if (teleportVehicleNearPlayer(vehicle, owner)) {
        log(`[VehicleFollow] ${vehicle.typeId} 卡住 → 传送`);
        return true;
    }

    return false;
}

// ============================================================
// 船
// ============================================================

function yawToward(from, tx, tz) {
    const dx = tx - from.x;
    const dz = tz - from.z;

    if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) return undefined;

    // Bedrock：yaw 0 面向 +Z，90 面向 -X
    return Math.atan2(-dx, dz) * YAW_PER_RAD;
}

/*
 * 船的朝向。
 * 船不吃 `setRotation`（会被物理每 tick 重写），改用「传送到自身位置 + rotation」。必须带
 * keepVelocity，否则每转一次就把推进速度清零，表现为「划两下停一拍」。
 */
function faceBoat(boat, tx, tz) {
    const yaw = yawToward(boat.location, tx, tz);

    if (yaw === undefined) return;

    try {
        const now = boat.getRotation().y;
        let delta = yaw - now;

        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;

        if (Math.abs(delta) < CONFIG.faceDeadZoneDeg) return;
    } catch (_) { /* 读不到朝向就照转 */ }

    try {
        boat.teleport(boat.location, {
            rotation: { x: 0, y: yaw },
            keepVelocity: true,
        });
    } catch (_) { }
}

function approachStep(cur, target, maxDelta) {
    const diff = target - cur;

    if (diff > maxDelta) return cur + maxDelta;
    if (diff < -maxDelta) return cur - maxDelta;

    return target;
}

/*
 * 划船跟随：给船加冲量，方向指向主人。
 * 船的阻尼比马大、转向也慢，所以冲量放大 1.6 倍、加速度上限放宽到 0.03、死区 3 格（水里
 * 贴着主人容易被两股水流推开）。y 分量恒为 0 —— 船自己会浮，推 y 只会让她上下颠。
 */
function driveBoat(unit, boat, owner, nowTick) {
    const dx = owner.location.x - unit.location.x;
    const dz = owner.location.z - unit.location.z;
    const dist = Math.hypot(dx, dz);

    if (dist <= CONFIG.stopDistance) {
        Drive.delete(unit.id);
        return;
    }

    const inv = 1 / (dist || 1);
    const fade = Math.min(1, (dist - CONFIG.stopDistance) / CONFIG.startDistance);
    const speed = CONFIG.speed * (0.4 + 0.6 * fade);

    let drive = Drive.get(unit.id);

    if (!drive) {
        drive = { x: 0, z: 0 };
        Drive.set(unit.id, drive);
    }

    drive.x = approachStep(drive.x, dx * inv * speed, CONFIG.maxAccel);
    drive.z = approachStep(drive.z, dz * inv * speed, CONFIG.maxAccel);

    try {
        boat.applyImpulse({
            x: drive.x * CONFIG.impulseScale,
            y: 0,
            z: drive.z * CONFIG.impulseScale,
        });
    } catch (_) { }

    const lastFace = LastFace.get(unit.id) ?? -99999;

    if (nowTick - lastFace >= CONFIG.faceIntervalTicks) {
        LastFace.set(unit.id, nowTick);
        faceBoat(boat, owner.location.x, owner.location.z);
    }
}

/** 找最近一条有空位的船。 */
function findBoat(unit) {
    let list;

    try {
        list = unit.dimension.getEntities({
            location: unit.location,
            maxDistance: CONFIG.boardRange,
        });
    } catch (_) {
        return undefined;
    }

    const ul = unit.location;
    let best;
    let bestSq = Infinity;

    for (const e of list) {
        if (vehicleKind(e) !== "boat") continue;

        try {
            const rideable = e.getComponent("minecraft:rideable");

            if (!rideable) continue;

            const riders = rideable.getRiders?.() ?? [];
            // 船两个座位；只要还有空位就够（她只占一个）
            if (riders.length >= 2) continue;
        } catch (_) {
            continue;
        }

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
 * 上船。
 * 只在她没坐在任何载具上、且主人正坐在船上时才尝试 —— 主人在岸上时她跑去爬船，看起来像
 * 「看见船就上」，不是跟随。用 `/ride` 而不是 SAPI：SAPI 没有 addRider，基岩这边让实体上船
 * 的唯一稳定入口就是这条命令。
 */
function tryBoard(unit, owner, nowTick) {
    const last = BoardAt.get(unit.id) ?? -99999;

    if (nowTick - last < CONFIG.boardRetryTicks) return;

    const ownerMount = ridingOn(owner);

    if (!ownerMount || !ownerMount.isValid) return;
    if (vehicleKind(ownerMount) !== "boat") return;

    const boat = findBoat(unit);

    if (!boat) return;

    BoardAt.set(unit.id, nowTick);

    try {
        unit.runCommand(
            `ride @s start_riding @e[type=${boat.typeId},c=1,r=6]`
        );
        log(`[VehicleFollow] ${unit.typeId} → 上 ${boat.typeId}`);
    } catch (_) { /* 没位置 / 距离 / 已被占 → 下一轮 */ }
}

// ============================================================
// 主循环
// ============================================================

function release(id) {
    Drive.delete(id);
    LastFace.delete(id);
    BoardAt.delete(id);
}

function tick() {
    const nowTick = system.currentTick;

    refreshMaids(nowTick);

    for (const [id, unit] of getMaids()) {
        try {
            if (!unit?.isValid) {
                release(id);
                continue;
            }

            // ① 门控：跟随才跑（UI 的 mode=0，或指令物品）。随机 / 巡逻都不管。
            if (!isFollowing(unit)) {
                release(id);
                continue;
            }

            // 玩家骑着她的时候，方向盘归玩家
            if (isPlayerMounted(unit)) {
                Drive.delete(id);
                continue;
            }

            const mount = ridingOn(unit);

            if (!mount || !mount.isValid) {
                // ② 没坐在载具上 → 只负责「上船」，其余交给 follow_recall 召回
                Drive.delete(id);
                BoardAt.delete(id);

                const owner = resolveOwner(unit);

                if (!owner || !owner.isValid) continue;
                if (owner.dimension.id !== unit.dimension.id) continue;

                tryBoard(unit, owner, nowTick);
                continue;
            }

            // ③ 坐在船上 → 划船跟随 + 脱困
            if (vehicleKind(mount) !== "boat") {
                Drive.delete(id);   // 生物载具交给 mount_follow
                continue;
            }

            const owner = resolveOwner(unit);

            if (!owner || !owner.isValid) {
                Drive.delete(id);
                continue;
            }

            if (owner.dimension.id !== unit.dimension.id) {
                Drive.delete(id);
                continue;
            }

            // 停着不动的船本来就不该动，别把「没挪窝」当成卡住 —— 只有确实在赶路
            // （超过死区）时才谈救援；远距离传送的阈值远大于死区，不受影响。
            const bx = owner.location.x - unit.location.x;
            const bz = owner.location.z - unit.location.z;
            const boardDist = Math.hypot(bx, bz);

            if (boardDist > CONFIG.startDistance && checkVehicleRescue(mount, owner, nowTick)) {
                Drive.delete(id);
                continue;
            }

            driveBoat(unit, mount, owner, nowTick);
        } catch (_) {
            // 单个单位异常不拖垮整轮
        }
    }
}

export function initVehicleFollow() {
    // 船的冲量必须每 tick 累加；跟随模式的女仆通常 1-3 只，空转成本可忽略
    system.runInterval(tick, 1);

    // 启动横幅默认打开；其余船跟随日志仍归 CONFIG.debug
    console.warn("[VehicleFollow] 船跟随 / 载具脱困已加载");
}
