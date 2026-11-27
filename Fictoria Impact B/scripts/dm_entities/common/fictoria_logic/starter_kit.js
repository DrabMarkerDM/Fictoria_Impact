/*
 * 新手套装：玩家第一次进入世界时，发一颗装好普通女仆的绿色幻域球 + 一本手册。
 * 只发一次：用玩家动态属性打标记，死亡重生、换维度、退出重进都不会重复发；已经玩过一段时间的
 * 存档（属性不存在）进来会补发一次。
 */
import { ItemStack, system, world } from "@minecraft/server";
import { createMaidBall } from "./fictoria_ball.js";
import { t } from "../core/i18n.js";

const DP_GIVEN = "dm:starter_kit";

/** 首发干员：普通女仆 */
const STARTER_MAID = "player:dm34";

const MANUAL_ID = "item:field_manual";

/*
 * 跟班指令器。
 * 球里放出来的女仆同样会触发 on_tame 里的 give，但 releaseMaid 有一步「清掉地上/背包里多出来的
 * Maid Command」，两者正好抵消 —— 所以这里补一个，保证新人放完球手上确实有一把。
 */
const COMMAND_ID = "item:maid_command";

/** 造球失败时的兜底：给一颗空球，至少不至于空手 */
const FALLBACK_BALL_ID = "items:fictoria_ball_filled_green";

/** 放进背包；背包满了掉在脚下（不吞物品） */
function deliver(player, stack) {
    try {
        const container = player.getComponent("minecraft:inventory")?.container;

        if (container !== undefined) {
            const rest = container.addItem(stack);

            if (rest === undefined) return;

            player.dimension.spawnItem(rest, player.location);
            return;
        }
    } catch (e) {
        console.warn(`[StarterKit] 放进背包失败: ${e}`);
    }

    try {
        player.dimension.spawnItem(stack, player.location);
    } catch (e) {
        console.warn(`[StarterKit] 掉落到地面也失败: ${e}`);
    }
}

function grant(player) {
    let ball;

    try {
        // 主人名刻意留空：球上的主人名只在放置时用来回填，留空则由实际放置者补。
        ball = createMaidBall(STARTER_MAID);
    } catch (e) {
        console.warn(`[StarterKit] 造球失败: ${e}`);
    }

    if (ball === undefined) {
        try {
            ball = new ItemStack(FALLBACK_BALL_ID, 1);
        } catch (e) {
            console.warn(`[StarterKit] 连兜底球都造不出来: ${e}`);
        }
    }

    if (ball !== undefined) deliver(player, ball);

    try {
        deliver(player, new ItemStack(MANUAL_ID, 1));
    } catch (e) {
        console.warn(`[StarterKit] 手册发放失败: ${e}`);
    }

    try {
        deliver(player, new ItemStack(COMMAND_ID, 1));
    } catch (e) {
        console.warn(`[StarterKit] Maid Command 发放失败: ${e}`);
    }

    try {
        player.onScreenDisplay.setActionBar(
            t("fictoria.kit.received")
        );
    } catch (_) {}
}

export function initStarterKit() {
    world.afterEvents.playerSpawn.subscribe((ev) => {
        const player = ev.player;

        let given = false;

        try {
            given = player.getDynamicProperty(DP_GIVEN) === true;
        } catch (_) {}

        if (given) return;

        // 先落标记再发：即使发放中途抛错也不会每局重发，避免刷物品
        try {
            player.setDynamicProperty(DP_GIVEN, true);
        } catch (e) {
            console.warn(`[StarterKit] 写标记失败（可能重复发放）: ${e}`);
        }

        // 出生这一刻背包组件偶有未就绪，等 1 秒再发
        system.runTimeout(() => grant(player), 20);
    });

    // 调试入口：/scriptevent dm:starter 立即补发；/scriptevent dm:starter reset 清掉标记
    system.afterEvents.scriptEventReceive.subscribe((ev) => {
        if (ev.id !== "dm:starter") return;

        const player = ev.sourceEntity;

        if (player === undefined || player.typeId !== "minecraft:player") return;

        if ((ev.message ?? "").trim() === "reset") {
            try {
                player.setDynamicProperty(DP_GIVEN, false);
                player.sendMessage(t("fictoria.kit.reset"));
            } catch (e) {
                console.warn(`[StarterKit] 重置失败: ${e}`);
            }

            return;
        }

        grant(player);
    });
}
