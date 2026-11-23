/*
 * torch_light.js — 通用动态光源：背包有火把就点亮，拿走就熄。
 * 名单来自 maid_registry 的 FEATURE_TYPES.light（manager 每 5t 登记），不自己扫、不订阅 spawn。
 * 每 10t 读背包 → 有火把加 is_lighting、每 2t 跑 dynamic_light（内部先清 5×5×5 再放一个）
 * → 没了摘 tag 并补一次清理；实体移除时按最后位置补 fill。
 * 容器：dm3 / dm12 为 horse 型，0 号是马鞍槽，扫全格无副作用。
 */

import { system, world } from "@minecraft/server";
import { warnOnce } from "../dm_entities/common/core/safe_exec.js";
import { FEATURE_TYPES, forEachUnitOfTypes } from "../dm_entities/common/core/maid_registry.js";

/** 动态光源实体类型，与 manager 的 FEATURE_TYPES.light 是同一个 Set */
const LIGHT_TYPES = FEATURE_TYPES.light;

const TORCH_ID = "minecraft:torch";
const LIGHT_TAG = "is_lighting";

/** 火把轮询间隔（tick）。容器无变化事件，轮询是唯一手段 */
const TORCH_POLL_TICKS = 10;
/** 光源刷新间隔（tick），与 dm34 一致 */
const PULSE_TICKS = 2;

/** 正亮着的：entityId → Entity */
const Lit = new Map();
/** 背包扫描结论缓存：entityId → { empty, size, slot } */
const ScanCache = new Map();
/** 最后位置：entityId → { dim, x, y, z, lit }，实体移除后补清理用 */
const LastPos = new Map();

let glogOn = false;
function glog(msg) {
    if (!glogOn) return;
    try {
        console.warn(`[torch_light] ${msg}`);
    } catch (_) {
        /* 忽略 */
    }
}

function logErr(key, e) {
    warnOnce(`torch_light.${key}`, `${e?.name ?? "Error"}: ${e?.message ?? e}`);
}

function containerOf(entity) {
    try {
        return entity.getComponent("minecraft:inventory")?.container ?? undefined;
    } catch (e) {
        logErr("container", e);
        return undefined;
    }
}

/*
 * 背包任意一格有火把。用 emptySlotsCount 做缓存：没变且上次无火把 → 直接返回；
 * 上次有火把 → 只验那个槽位（拿走火把再塞木棍时净空槽数不变）；验失败退回全扫。
 * 读不到 emptySlotsCount 时不写缓存（-1 === -1 会永远命中）。
 */
function hasTorchInBag(entity) {
    const bag = containerOf(entity);
    if (!bag) return false;

    let size = 0;
    let empty = -1;
    try {
        size = bag.size || 0;
        empty = bag.emptySlotsCount;
    } catch (e) {
        logErr("bag.size", e);
        return false;
    }

    let id;
    try {
        id = entity.id;
    } catch (e) {
        return false;
    }

    const rec = ScanCache.get(id);
    if (rec && empty >= 0 && rec.empty === empty && rec.size === size) {
        if (rec.slot < 0) return false;
        let it;
        try {
            it = bag.getItem(rec.slot);
        } catch (e) {
            it = undefined;
        }
        if (it && it.typeId === TORCH_ID) return true;
        // 那一格换了东西（或火把被挪走）→ 下面全扫
    }

    let slot = -1;
    for (let i = 0; i < size; i++) {
        let it;
        try {
            it = bag.getItem(i);
        } catch (e) {
            it = undefined;
        }
        if (it && it.typeId === TORCH_ID) {
            slot = i;
            break;
        }
    }
    if (empty >= 0) ScanCache.set(id, { empty, size, slot });
    return slot >= 0;
}

/** 清周围 5×5×5 的临时光源（范围与 dynamic_light 一致） */
function clearLightAround(entity) {
    try {
        entity.runCommand("fill ~-2 ~-1 ~-2 ~2 ~3 ~2 air replace block:dm_light_1");
    } catch (e) {
        /* 实体已消失 / 区块卸载 */
    }
}

const DIRT_PATH_IDS = ["minecraft:dirt_path", "minecraft:grass_path"];

/* 脚下是否土径。不在 mcfunction 里判：未知方块 id 会让整个函数加载失败，
 * 连清理命令都不执行且无日志；写在脚本里判错只是判不中。 */
function standOnDirtPath(entity) {
    let loc;
    try {
        loc = entity.location;
    } catch (e) {
        return false;
    }

    try {
        const b = entity.dimension.getBlock({
            x: Math.floor(loc.x),
            y: Math.floor(loc.y),
            z: Math.floor(loc.z),
        });
        if (b && b.typeId) return DIRT_PATH_IDS.includes(String(b.typeId));
    } catch (e) {
        /* 区块没加载 → 走下面的兜底 */
    }

    // 兜底：15/16 高的方块会让 floor(y) 落到本体格，小数部分是 0.9375；站普通方块时是整数 → 0
    return loc.y - Math.floor(loc.y) > 0.5;
}

/** 脚边放光源（dynamic_light 内部先清后放），并记位置供移除后清理 */
function pulseLight(entity) {
    let fn = "dynamic_light";
    try {
        if (standOnDirtPath(entity)) fn = "dynamic_light_high";
    } catch (e) {
        /* 忽略 */
    }
    try {
        entity.runCommand(`function ${fn}`);
    } catch (e) {
        /* 实体已消失 / 区块卸载 */
    }
    rememberPos(entity, true);
}

function rememberPos(entity, lit) {
    try {
        const loc = entity.location;
        LastPos.set(entity.id, {
            dim: entity.dimension.id,
            x: Math.floor(loc.x),
            y: Math.floor(loc.y),
            z: Math.floor(loc.z),
            lit,
        });
    } catch (e) {
        /* 实体已失效 */
    }
}

/** 实体已移除，用最后位置补一次 fill 清理 */
function clearAtLastPos(id) {
    const p = LastPos.get(id);
    LastPos.delete(id);
    if (!p || !p.lit) return;

    try {
        const dim = world.getDimension(p.dim);
        dim.runCommand(
            `fill ${p.x - 2} ${p.y - 1} ${p.z - 2} ${p.x + 2} ${p.y + 3} ${p.z + 2} ` +
            `air replace block:dm_light_1`
        );
    } catch (e) {
        /* 维度已卸载 */
    }
}

/** 每轮的判定与开关动作 */
function refresh(entity) {
    const has = hasTorchInBag(entity);

    let tagged;
    try {
        tagged = entity.hasTag(LIGHT_TAG);
    } catch (e) {
        return;
    }

    let id;
    try {
        id = entity.id;
    } catch (e) {
        return;
    }

    if (has === tagged) {
        // 状态没变，只维持缓存（实体可能被 tp 或重载，引用要换新）
        if (has) Lit.set(id, entity);
        else Lit.delete(id);
        return;
    }

    try {
        if (has) {
            entity.addTag(LIGHT_TAG);
            Lit.set(id, entity);
            // 立刻给一次光，不等 2t 后的循环
            pulseLight(entity);
        } else {
            entity.removeTag(LIGHT_TAG);
            Lit.delete(id);
            clearLightAround(entity);
            rememberPos(entity, false);
        }
    } catch (e) {
        return;     // 实体刚消失 / 维度卸载
    }

    // 带 id：同屏多只时只看 typeId 分不清是谁在开关
    glog(`火把${has ? "入手" : "离手"} → 灯光${has ? "开" : "关"}（${entity.typeId} #${id}）`);
}

export function initTorchLight(options) {
    if (options && typeof options.debug === "boolean") glogOn = options.debug;

    // 实体移除：清最后那束光 + 两个缓存。名单与登记归 manager，这里不订阅 spawn / load。
    try {
        world.afterEvents.entityRemove.subscribe((ev) => {
            const id = ev.removedEntityId !== undefined ? ev.removedEntityId : (ev.entity && ev.entity.id);
            if (id === undefined) return;
            try {
                clearAtLastPos(id);
            } catch (err) {
                logErr("remove.clear", err);
            }
            Lit.delete(id);
            ScanCache.delete(id);
        });
    } catch (e) {
        logErr("subscribe.remove", e);
    }

    // 火把轮询 10t：玩家在背包 UI 内取放、原版拾取都不发事件。
    // 名单来自 manager 登记表（每 5t 全量重建，引用是新鲜的）。
    system.runInterval(() => {
        forEachUnitOfTypes(LIGHT_TYPES, (e) => {
            try {
                refresh(e);
            } catch (err) {
                logErr("refresh", err);
            }
        });
    }, TORCH_POLL_TICKS);

    // 光源跟随：只跑正亮着的，每 2t 一次；无人拿火把时整轮只是一次 size 判断
    system.runInterval(() => {
        if (Lit.size === 0) return;

        for (const [id, e] of Lit) {
            let alive = false;
            try {
                alive = !!e.isValid;
            } catch (err) {
                alive = false;
            }
            if (!alive) {
                Lit.delete(id);
                ScanCache.delete(id);
                continue;
            }
            try {
                pulseLight(e);
            } catch (err) {
                logErr("pulse", err);
            }
        }
    }, PULSE_TICKS);

    // 启动横幅默认打开；轮询明细仍归 glogOn
    console.warn(`[torch_light] 已启动：火把轮询 ${TORCH_POLL_TICKS}t、光源刷新 ${PULSE_TICKS}t、名单 = manager 登记表`);
}
