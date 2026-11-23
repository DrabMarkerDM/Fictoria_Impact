/*
 * 骑乘熔断：玩家骑着她的时候，方向盘归玩家。
 * 走位引擎每 tick 用 applyImpulse 推实体，玩家骑乘时实体同时受玩家输入与引擎冲量两股驱动，
 * 表现为坐骑抽搐、玩家想往左却被拽着后撤。骑上去那一刻起她就只是坐骑，不再是自主作战单位。
 * 不每 tick 扫玩家：上下马的变化频率是人手级的，20Hz 轮询 99.9% 都在确认「没变化」。改成事件
 * 驱动 —— 上下马时把集合标脏，下一次被问到时重算，稳态只剩一次 Set.has。
 * 兜底：① 事件不存在 / 订阅抛错 → `eventsReady = false`，退回每 tick 惰性全量（功能不减）；
 * ② 事件漏发（区块边界、/tp 强制下车、重进时已在坐骑上）→ 每 REFRESH_MAX_AGE tick 强制对账；
 * ③ 事件回调不读字段，只当「有人上下马了」的脏标记，这样不必赌 EntityMountAfterEvent 的字段名
 * （mountEntity / mountedEntity 都出现过）。
 */
import { system, world } from "@minecraft/server";

// 兜底对账周期（tick）。100t = 5s，漏一次事件最多滞后这么久。
const REFRESH_MAX_AGE = 100;

let dirty = true;

let lastRefreshTick = -1;

let eventsReady = false;

const mountedByPlayer = new Set();

function markDirty() {
    dirty = true;
}

function refresh(nowTick) {
    dirty = false;
    lastRefreshTick = nowTick;
    mountedByPlayer.clear();

    let players;

    try {
        players = world.getAllPlayers();
    } catch (e) {
        return;
    }

    for (const player of players) {
        try {
            const mount = player.getComponent("minecraft:riding")?.entityRidingOn;

            if (mount && mount.isValid) {
                mountedByPlayer.add(mount.id);
            }
        } catch (e) {
            // 玩家正在穿越传送门 / 载具刚被移除，读不到就跳过
        }
    }
}

/*
 * 订阅上下马事件，成对成功才进入事件驱动模式。
 * 事件名按版本从新到旧试 —— 早期叫 entityRide / entityGetOff，后来改成 entityMount /
 * entityDismount，全失败也只是退回轮询，不会更差。
 * 必须成对：只有 mount 没有 dismount 的话，下马时集合不更新，她会一直站着不动直到 5 秒对账 ——
 * 这个延迟能感觉到。宁可退回轮询，也不要「半只耳朵」。
 */
function initEvents() {
    let mountReady = false;
    let dismountReady = false;

    for (const name of ["entityMount", "entityRide"]) {
        try {
            const signal = world.afterEvents?.[name];

            if (signal && typeof signal.subscribe === "function") {
                signal.subscribe(markDirty);
                mountReady = true;
            }
        } catch (e) {
            // 该版本没有这个信号，继续试下一个
        }
    }

    for (const name of ["entityDismount", "entityGetOff"]) {
        try {
            const signal = world.afterEvents?.[name];

            if (signal && typeof signal.subscribe === "function") {
                signal.subscribe(markDirty);
                dismountReady = true;
            }
        } catch (e) {
            // 同上
        }
    }

    eventsReady = mountReady && dismountReady;

    // 玩家进出世界也可能带着坐骑状态进/退场，这两个信号一定有
    for (const name of ["playerJoin", "playerLeave"]) {
        try {
            const signal = world.afterEvents?.[name];

            if (signal && typeof signal.subscribe === "function") {
                signal.subscribe(markDirty);
            }
        } catch (e) {
            // 忽略
        }
    }
}

initEvents();

/*
 * 是否有玩家正骑在这个实体身上。只问「被玩家骑」—— 她骑别人的情况由各引擎自己的
 * `maid:ride_player` 处理。
 * @param {*} entity｜@returns {boolean}
 */
export function isPlayerMounted(entity) {
    if (!entity || !entity.isValid) {
        return false;
    }

    const nowTick = system.currentTick;

    if (!eventsReady) {
        // 没有上下马事件可用 → 只能每 tick 惰性全量（= 第一版行为）
        if (lastRefreshTick !== nowTick) {
            refresh(nowTick);
        }
    } else if (dirty || nowTick < lastRefreshTick || nowTick - lastRefreshTick >= REFRESH_MAX_AGE) {
        refresh(nowTick);
    }

    return mountedByPlayer.has(entity.id);
}
