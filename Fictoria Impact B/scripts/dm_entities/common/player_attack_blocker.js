// player_attack_blocker.js
import { world, system } from "@minecraft/server";
import {
    registerBeforeHurtHandler,
    registerAfterHurtHandler,
    registerEntityRemoveHandler,
    HURT_PRIORITY,
    AFTER_HURT_PRIORITY,
    REMOVE_PRIORITY
} from "./event_bus.js";

// 配置

// ⚠ 这两张表是旧 F 包的完整配置（马/驴/骡/骷髅马/僵尸马/狼/猫/鹦鹉）。
//   当前**受保护范围**由下面的 RAW_MOUNT_TYPES 决定 —— 只保六种坐骑，
//   狼 / 猫 / 鹦鹉 / 猪 / 羊驼 / 炽足兽 一律不保护（玩家打它们，女仆跟着打）。
//   表保留在这里，是为了配置表完整、可查、可一键放开；不要因为"没用"删掉。
// 原版友善 / 驯服生物
// 仅对 DM 实体攻击生效保护，玩家可以正常打
const RAW_VANILLA_FRIENDLY_TYPES = [
    "minecraft:horse ",
    "minecraft:donkey ",
    "minecraft:mule ",
    "minecraft:skeleton_horse ",
    "minecraft:zombie_horse ",
    "minecraft:wolf ",
    "minecraft:cat ",
    "minecraft:parrot "
];

const RAW_VANILLA_FAMILIES = ["horse", "wolf", "cat"];

// 自定义友军与 DM 实体
// 对玩家和 DM 统一生效保护
const RAW_CUSTOM_ALLIED_TYPES = [
    // DM 实体 player:dm0 ~ player:dm63
    "player:dm0 ",  "player:dm1 ",  "player:dm2 ",  "player:dm3 ",
    "player:dm4 ",  "player:dm5 ",  "player:dm6 ",  "player:dm7 ",
    "player:dm8 ",  "player:dm9 ",  "player:dm10 ",  "player:dm11 ",
    "player:dm12 ",  "player:dm13 ",  "player:dm14 ",  "player:dm15 ",
    "player:dm16 ",  "player:dm17 ",  "player:dm18 ",  "player:dm19 ",
    "player:dm20 ",  "player:dm21 ",  "player:dm22 ",  "player:dm23 ",
    "player:dm24 ",  "player:dm25 ",  "player:dm26 ",  "player:dm27 ",
    "player:dm28 ",  "player:dm29 ",  "player:dm30 ",  "player:dm31 ",
    "player:dm32 ",  "player:dm33 ",  "player:dm34 ",  "player:dm34_1 ",
    "player:dm35 ",  "player:dm36 ",  "player:dm37 ",  "player:dm38 ",
    "player:dm39 ",  "player:dm40 ",  "player:dm41 ",  "player:dm42 ",
    "player:dm42_1 ",
    "player:dm43 ",  "player:dm44 ",  "player:dm45 ",  "player:dm46 ",
    "player:dm47 ",  "player:dm48 ",  "player:dm49 ",  "player:dm50 ",
    "player:dm51 ",  "player:dm52 ",  "player:dm53 ",  "player:dm54 ",
    "player:dm55 ",  "player:dm56 ",  "player:dm57 ",  "player:dm58 ",
    "player:dm59 ",  "player:dm60 ",  "player:dm61 ",  "player:dm62 ",
    "player:dm63 ",
    // 特殊命名
    "player:kirito",
    "player:asuna",
    "player:steve",
    // 非 player 命名空间的友军
    "mob:protecter",
    "mob:robot",
    "mob:doctor",
    "mob:mon3tr"
];

// 需要保护的可骑乘生物。只认这六种，猪/羊驼/炽足兽一律不管。
// typeId 精确匹配（family 各家写得乱七八糟，靠不住）；horse 家族兜底魔改马。
const RAW_MOUNT_TYPES = [
    "minecraft:horse",
    "minecraft:donkey",
    "minecraft:mule",
    "minecraft:skeleton_horse",
    "minecraft:zombie_horse",
    "minecraft:camel"
];
const RAW_MOUNT_FAMILIES = ["horse"];

// 友方家族只认 dm。用 ["dm", "mob"] 太宽泛，玩家和友方几乎打不动任何实体。
const RAW_DM_FAMILIES = ["dm"];

// 优化：
// 1. 所有配置字符串统一 trim，防止尾随空格导致判断失效。
// 2. 数组 includes 改成 Set.has，减少每次 entityHurt 的线性查找。
function trimArrayToSet(arr) {
    const set = new Set();
    for (const value of arr) {
        if (typeof value === "string") {
            set.add(value.trim());
        } else {
            set.add(value);
        }
    }
    return set;
}

const CUSTOM_ALLIED_TYPES = trimArrayToSet(RAW_CUSTOM_ALLIED_TYPES);
const VANILLA_FRIENDLY_TYPES = trimArrayToSet(RAW_VANILLA_FRIENDLY_TYPES);
const VANILLA_FAMILY_SET = trimArrayToSet(RAW_VANILLA_FAMILIES);
const MOUNT_TYPES = trimArrayToSet(RAW_MOUNT_TYPES);
const MOUNT_FAMILY_SET = trimArrayToSet(RAW_MOUNT_FAMILIES);
const CRACK_FAMILY_SET = new Set(["dm_crack_effect"]);
const DM_FAMILY_SET = trimArrayToSet(RAW_DM_FAMILIES);

// family 缓存

// 原版每次受击都会读取：
// entity.getComponent("minecraft:type_family")

// 这里按 typeId 缓存 family 集合，减少高频 entityHurt 下的组件读取。
const EMPTY_FAMILY_SET = new Set();
const FAMILY_CACHE = new Map();

function getEntityFamilySet(entity) {
    try {
        if (!entity || !entity.isValid) return EMPTY_FAMILY_SET;
        const cacheKey = entity.typeId;
        if (cacheKey && FAMILY_CACHE.has(cacheKey)) {
            return FAMILY_CACHE.get(cacheKey);
        }
        const comp = entity.getComponent("minecraft:type_family");
        if (!comp) {
            if (cacheKey) FAMILY_CACHE.set(cacheKey, EMPTY_FAMILY_SET);
            return EMPTY_FAMILY_SET;
        }
        let names = [];
        if (typeof comp.getFamilyNames === "function") {
            names = comp.getFamilyNames();
        } else if (typeof comp.getTypeFamilies === "function") {
            names = comp.getTypeFamilies();
        } else if (Array.isArray(comp.families)) {
            names = comp.families;
        }
        const familySet = new Set(names);
        if (cacheKey) {
            FAMILY_CACHE.set(cacheKey, familySet);
        }
        return familySet;
    } catch (e) {
        return EMPTY_FAMILY_SET;
    }
}

function hasAnyFamily(entity, targetFamilySet) {
    try {
        if (!entity || !entity.isValid) return false;
        if (!targetFamilySet || targetFamilySet.size === 0) return false;
        const entityFamilySet = getEntityFamilySet(entity);
        if (!entityFamilySet || entityFamilySet.size === 0) return false;
        for (const family of targetFamilySet) {
            if (entityFamilySet.has(family)) {
                return true;
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

// 是否为原版友善生物（马 / 驴 / 骡 / 狼 / 猫 / 鹦鹉，或 horse・wolf・cat 家族）。
// 当前不接入免伤判定（见文件头 RAW_VANILLA_* 的说明）；坐骑保护走 isProtectedMount。
function isVanillaFriendly(entity) {
    if (!entity || !entity.isValid) return false;
    if (hasAnyFamily(entity, VANILLA_FAMILY_SET)) return true;
    return VANILLA_FRIENDLY_TYPES.has(entity.typeId);
}

// 判断实体是否为 DM 友方：只看 "dm" family。
// 不能再看 "mob" family —— 原版被动生物也在里面，会把中立 mob 误判成友军。
function isDM(entity) {
    if (!entity || !entity.isValid) return false;
    if (hasAnyFamily(entity, DM_FAMILY_SET)) return true;
    if (entity.typeId?.startsWith("player:")) {
        return entity.typeId !== "minecraft:player";
    }
    return false;
}

// 对玩家免伤的受害者：dm 家族 + CUSTOM_ALLIED_TYPES 白名单。
// 不再因为受害者带 mob 家族就保护它。
function isProtectedFromPlayer(entity) {
    if (!entity || !entity.isValid) return false;
    if (hasAnyFamily(entity, DM_FAMILY_SET)) return true;
    if (CUSTOM_ALLIED_TYPES.has(entity.typeId)) return true;
    return false;
}

// 集体反击名单（永久不信任）

// 原版友善生物（马/狼/猫）攻击了任何DM友军后，
// 该生物被永久标记为不可信，所有DM友军对其伤害不再拦截。
const DistrustedEntities = new Set();

// ── 标签口径 ───────────────────────────────────────────────────────────
// 内存 Set 换世界就没了，但"这只马能不能打"要跨存档保持，所以账本写在实体标签上：
//   dm_distrust —— 它先动过手（咬过 DM 或玩家），可以被反击。
//   dm_mount    —— 受保护的可骑乘生物（马/驴/骡/骷髅马/僵尸马/骆驼），
//                  `owner_hurt_target` 过滤器带 `has_tag != dm_mount`。
//   dm_wary     —— 旧版本留下的同一语义标签，保留兜底，新实体不再单独打。
const DISTRUST_TAG = "dm_distrust";
const MOUNT_TAG = "dm_mount";
const WARY_TAG = "dm_wary";

function tagOf(entity, tag) {
    try {
        return !!(entity && entity.isValid && entity.hasTag(tag));
    } catch (_) {
        return false;
    }
}

// 🔴 beforeEvents.entityHurt 是**受限执行上下文**：Entity::addTag / removeTag /
// clearVelocity 一律抛 "cannot be used in restricted execution"（日志里能看到）。
// 所以实体写操作全部延后一 tick，用 id 重新取实体再做。
function deferEntity(fn, key) {
    try {
        system.run(() => {
            try {
                fn();
            } catch (e) {
                logErr(key, e);
            }
        });
    } catch (e) {
        logErr(key, e);
    }
}

// 给受保护的坐骑打标（dm_mount + 兼容旧存档的 dm_wary）
function applyMountTag(id, key) {
    deferEntity(() => {
        const v = world.getEntity(id);
        if (!v || !v.isValid) return;
        if (!v.hasTag(MOUNT_TAG)) v.addTag(MOUNT_TAG);
        if (!v.hasTag(WARY_TAG)) v.addTag(WARY_TAG);
    }, key);
}

/** 拉黑：内存账本 + 实体标签，并撤掉 dm_wary（能被打了就别再挡）。 */
function markDistrusted(entity) {
    if (!entity || !entity.isValid) return;
    try {
        DistrustedEntities.add(entity.id);
    } catch (_) {}
    const id = entity.id;
    deferEntity(() => {
        const e = world.getEntity(id);
        if (!e || !e.isValid) return;
        if (!e.hasTag(DISTRUST_TAG)) e.addTag(DISTRUST_TAG);
        e.removeTag(WARY_TAG);
    }, "distrust_tag");
}

// 实体移除时清理
registerEntityRemoveHandler("friendly_fire_distrust", (event) => {
    try {
        const id = event.removedEntity?.id;
        if (id) DistrustedEntities.delete(id);
    } catch (_) {}
}, REMOVE_PRIORITY.FRIENDLY_FIRE_CACHE);

// 判断实体是否已被标记为不可信
function isDistrusted(entity) {
    if (!entity || !entity.isValid) return false;
    if (DistrustedEntities.has(entity.id)) return true;
    // 换世界后内存表是空的，标签还在 —— 以标签为准
    return tagOf(entity, DISTRUST_TAG);
}

// 需要保护的可骑乘生物：马 / 驴 / 骡 / 骷髅马 / 僵尸马 / 骆驼。
// typeId 优先，horse 家族兜底（魔改马只要挂了 horse 家族也认）。
function isProtectedMount(entity) {
    if (!entity || !entity.isValid) return false;
    if (entity.typeId && MOUNT_TYPES.has(entity.typeId)) return true;
    return hasAnyFamily(entity, MOUNT_FAMILY_SET);
}

// 对 DM 实体免伤的受害者。
// 与 JSON 的 dm_mount 闸对称：这六种坐骑不许她伤，除它先动过手（dm_distrust）。
function isProtectedFromDM(entity) {
    if (!entity || !entity.isValid) return false;

    // 不可信生物不受保护（集体反击）
    if (isDistrusted(entity)) return false;

    // 采集裂痕是引擎的目标锚点，本身免疫伤害；放行免得 ranged_attack 卡在"打不掉"
    if (hasAnyFamily(entity, CRACK_FAMILY_SET)) return false;

    if (entity.typeId === "minecraft:player") return true;
    if (isProtectedMount(entity)) return true;
    if (isDM(entity)) return true;
    if (CUSTOM_ALLIED_TYPES.has(entity.typeId)) return true;

    return false;
}

function isRealPlayer(entity) {
    return entity && entity.isValid && entity.typeId === "minecraft:player";
}

// 全局拦截

// 限流日志：贴标签 / 松口这类"出一次错就变成她没反应"的地方不许静默。
const ErrCount = new Map();
function logErr(key, e, max = 3) {
    const n = (ErrCount.get(key) || 0) + 1;
    if (n > max) return;
    ErrCount.set(key, n);
    console.warn(`[DM-Engine] 友伤标记异常 ${key}: ${e}`);
}

/*
 * 给被误伤的坐骑打 `dm_mount`。
 * 写标签，不碰索敌：JSON 里 `owner_hurt_target` 的过滤器是
 * `any_of[ has_tag != dm_mount , has_tag = dm_distrust ]`，打上之后任何一只女仆的
 * 「主人的打谁我打谁」都不会再把它选成目标；它真先动手了则照打。
 */
function markWary(victim) {
    if (!victim || !victim.isValid) return false;
    // 只保护这六种坐骑，其余生物不管
    if (!isProtectedMount(victim)) return false;
    // 它先动过手（咬过 DM 或玩家）→ 该打，别保护
    if (isDistrusted(victim)) return false;
    applyMountTag(victim.id, "wary_addTag");
    return true;
}

/** 她已经咬着这只友善目标了 → 直接松口。
 *  JSON 过滤器管的是"别选它"，管不了"已经选上了"的那只。 */
function releaseStuckTargets(victim, player) {
    if (!player || !player.isValid) return;
    let list;
    try {
        list = victim.dimension.getEntities({
            location: victim.location,
            maxDistance: 48,
            families: ["dm"]
        });
    } catch (e) {
        logErr("wary_scan", e);
        return;
    }
    if (!list) return;
    for (const maid of list) {
        if (!maid || !maid.isValid) continue;
        try {
            if (maid.getDynamicProperty("ownerId") !== player.id) continue;
            const t = maid.target;
            if (!t || t.id !== victim.id) continue;
            maid.target = undefined;
            console.warn(`[DM-Engine] ${maid.typeId} 松口放弃友善目标 ${victim.typeId}`);
        } catch (e) {
            logErr("wary_release", e);
        }
    }
}

// beforeEvents.entityHurt 上下文中直接修改实体可能受限。
// 因此 event.cancel / event.damage 仍然立即处理，
// 但 clearVelocity / extinguishFire 延后到 system.run。
export function handleFriendlyFireBlock(event) {
    try {
        const victim = event.hurtEntity;
        if (!victim || !victim.isValid) return;
        const attacker = event.damageSource?.damagingEntity;
        if (!attacker || !attacker.isValid) return;

        // 场景 A：真实玩家攻击

        // 仅阻断对 DM 实体和自定义 mob:xxx 友军的伤害。
        // 玩家可以正常打普通怪物、动物、马 / 狼等原版生物。
        if (isRealPlayer(attacker)) {
            if (isProtectedFromPlayer(victim)) {
                event.cancel = true;
                event.damage = 0;
                const victimId = victim.id;
                system.run(() => {
                    try {
                        const v = world.getEntity(victimId);
                        if (!v || !v.isValid) return;
                        try {
                            v.clearVelocity();
                        } catch (_) {}
                        try {
                            v.extinguishFire(true);
                        } catch (_) {}
                    } catch (_) {}
                });
                return;
            }

            // 🔴 关键时序：**伤害结算之前**就打上 `dm_wary`
            //
            // `beforeEvents.entityHurt` 跑在伤害结算前，而引擎的
            // `minecraft:behavior.owner_hurt_target`（主人的打谁我打谁）是在伤害**结算后**
            // 才去读「主人刚打了谁」并锁目标。所以在这里打标签，她从一开始就不会把
            // 这匹马选成目标 —— 不需要在事后再去刷新索敌。
            //
            // 放在放行分支（玩家打普通动物/马，本来就不该拦）里，而不是拦截分支：
            // DM 家族/自定义友军根本不该被玩家打，打了也轮不到 `owner_hurt_target`
            // 出问题（她们是友军不是敌人）。
            markWary(victim);
            return;
        }

        // 远程：玩家用弓 / 弩 / 三叉戟打，`damagingEntity` 是箭矢/弹射物本身，
        // 玩家挂在 `minecraft:projectile.owner` 上，走不到上面那条分支。
        // 同样必须在这里（结算前）打标 —— 交给 afterHurt 兜底就太晚了。
        try {
            const proj = event.damageSource?.damagingProjectile;
            if (proj) {
                const owner = proj.getComponent("minecraft:projectile")?.owner;
                if (isRealPlayer(owner)) markWary(victim);
            }
        } catch (_) {}

        // 场景 A.5：这六种坐骑主动攻击 DM / 玩家 → 解禁

        // 只有坐骑走这条路：它先动手，就允许被打回来。
        // 其余生物不在此列 —— 玩家打它们、女仆跟着打是允许的。
        if (isProtectedMount(attacker) && (isDM(victim) || isRealPlayer(victim))) {
            markDistrusted(attacker);
            return;
        }

                // 场景 B：DM 攻击。阻断对玩家 / 其他 DM / 自定义友军 / 原版马狼猫的伤害。
                // 普通怪物和动物不会被误判成友方；不可信生物不受保护。
        if (isDM(attacker)) {
            if (isProtectedFromDM(victim)) {
                event.cancel = true;
                event.damage = 0;
                const victimId = victim.id;
                system.run(() => {
                    try {
                        const v = world.getEntity(victimId);
                        if (!v || !v.isValid) return;
                        try {
                            v.extinguishFire(true);
                        } catch (_) {}
                    } catch (_) {}
                });
            }
            return;
        }
    } catch (e) {
        console.error(`[DM-Engine] 友伤拦截异常: ${e}`);
    }
}

// 挂到统一受击总线（逻辑本体未改动，仅把订阅方式改成注册）
registerBeforeHurtHandler(
    "friendly_fire_block",
    handleFriendlyFireBlock,
    HURT_PRIORITY.FRIENDLY_FIRE
);

// ── 误伤友军：打标签 + 松口 ─────────────────────────────────────────────
//
// 成因链：
//   ① 玩家打马 → 场景 A 放行（玩家本来就该能打自己的马）
//   ② `minecraft:behavior.owner_hurt_target`（主人的打谁我打谁）把马设成她的目标
//   ③ 她打马 → 场景 B 把伤害抹成 0 → 马不还手，永远进不了 DistrustedEntities
//   ④ 目标没有自然消失的出口 → 她咬一辈子
//
// 两道闸：
//   · JSON `owner_hurt_target` 过滤器（dm_wary 标签 + horse/wolf/cat/player 家族）→ 压根别选它；
//   · afterHurt 里的 releaseStuckTargets → 已经选上的那只直接松口。
//
// 马真的先动过手（咬过 DM 友军 / 玩家）→ 场景 A.5 打 `dm_distrust` 并撤 `dm_wary`，照样能还手。

/** 受击后兜底：友军被玩家 / DM 误伤 → 打 `dm_wary`，并让已经咬着它的女仆松口 */
function handleFriendlyWary(event) {
    try {
        const victim = event.hurtEntity;
        const src = event.damageSource;
        if (!victim || !victim.isValid) return;

        const attacker = src && src.damagingEntity;
        // 弹射物命中后往往**当场销毁**，`afterHurt` 里再 getComponent 会抛
        // InvalidEntityError（日志里的 `wary_mark`）。先验 isValid，再兜一层 try：
        // 读不到主人就当"来源不明"，不参与免伤判定，不影响其它分支。
        let projOwner;
        try {
            const proj = src && src.damagingProjectile;
            if (proj && proj.isValid) {
                projOwner = proj.getComponent("minecraft:projectile")?.owner;
            }
        } catch (_) {
            projOwner = undefined;
        }

        const byPlayer = isRealPlayer(attacker) || isRealPlayer(projOwner);
        const byDM = isDM(attacker) || isDM(projOwner);
        if (!byPlayer && !byDM) return;

        if (!markWary(victim)) return;

        const player = isRealPlayer(attacker) ? attacker : projOwner;
        if (isRealPlayer(player)) {
            // 松口必须排在打标之后（同一个 system.run 队列内按注册顺序执行）
            const vid = victim.id;
            const pid = player.id;
            deferEntity(() => {
                const v = world.getEntity(vid);
                const p = world.getEntity(pid);
                if (v && p) releaseStuckTargets(v, p);
            }, "wary_release");
        }
    } catch (e) {
        logErr("wary_mark", e);
    }
}

registerAfterHurtHandler(
    "friendly_wary_mark",
    handleFriendlyWary,
    AFTER_HURT_PRIORITY.FRIENDLY_WARY_MARK
);

// 子弹回调出口
export function shouldBlockProjectileFriendlyFire(target, attacker) {
    if (!target || !target.isValid || !attacker || !attacker.isValid) return false;
    if (isRealPlayer(attacker)) {
        return isProtectedFromPlayer(target);
    }
    if (isDM(attacker)) {
        return isProtectedFromDM(target);
    }
    return false;
}

// ── 坐骑预标 ────────────────────────────────────────────────────────────
// owner_hurt_target 只认 tag，等玩家动手再打已经晚一步（而且 beforeHurt 里打不了），
// 所以生成时直接打；另加低频巡检补存档里已有的坐骑（tag 会持久化，扫过一次就够）。
function tagMount(entity, key) {
    if (!entity || !entity.isValid) return;
    if (!MOUNT_TYPES.has(entity.typeId)) return;
    try {
        if (!entity.hasTag(MOUNT_TAG)) entity.addTag(MOUNT_TAG);
    } catch (e) {
        logErr(key, e);
    }
}

try {
    world.afterEvents.entitySpawn.subscribe((ev) => {
        tagMount(ev.entity, "mount_spawn");
    });
} catch (e) {
    logErr("mount_spawn_sub", e);
}

system.runInterval(() => {
    try {
        for (const p of world.getAllPlayers()) {
            for (const t of MOUNT_TYPES) {
                const list = p.dimension.getEntities({
                    type: t,
                    location: p.location,
                    maxDistance: 48
                });
                for (const e of list) {
                    tagMount(e, "mount_scan");
                }
            }
        }
    } catch (e) {
        logErr("mount_scan", e);
    }
}, 200);

console.warn("[DM-Engine] 友伤分流拦截已载入 ✅");