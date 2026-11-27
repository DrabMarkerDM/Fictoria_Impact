/*
 * 欢迎来到-幻域Phantoria（item:field_manual）。手持右键打开表单：首页列出章节，点进去看正文，
 * 正文页可以返回首页。表单只能放文字和按钮，没有图片、没有富文本，排版靠换行和分隔符。
 * 打开失败最常见的两种：userBusy（玩家手还在用东西）和 show 到一半玩家死了 —— 前者重试几次
 * 就过，后者直接放弃。
 */
import { system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { t } from "../core/i18n.js";

const MANUAL_ID = "item:field_manual";

/*
 * 章节按钮图标，按 CHAPTERS 的顺序一一对应。写资源包内纹理路径、不带 .png 后缀；原版物品/
 * 方块的贴图直接用原版路径。少写一项不会报错，会退回第一章的图标。
 */
const CHAPTER_ICONS = [
    "textures/items/maid_command", // 第一章：Maid Command 物品图标
    "textures/items/dm34_gentle_maid", // 第二章：Gentle Cross
    "textures/items/dm34_war_maid", // 第三章：War Cross
    "textures/items/saddle", // 第四章：原版鞍
    "textures/items/fictoria_ball_filled_green", // 第五章：装着女仆的满幻域球
    "textures/blocks/crafting_table_front", // 第六章：原版工作台
];

/** 同一玩家两次打开的最小间隔（tick），挡住 hand 物品被重复触发的连击 */
const OPEN_COOLDOWN = 10;

/** 表单被 userBusy 拒绝时的重试节奏 */
const RETRY_TIMES = 6;
const RETRY_DELAY = 10;

// 章节内容一律走语言键（RP texts/*.lang 的 fictoria.manual.*）。
// 正文带 § 颜色码与 \n 换行：.lang 支持 \n 转义（本机多个已装资源包在用），
// 所以整章可以是一条键；不要在 JS 里拼字符串 —— RawMessage 一旦拼字符串就毁了。
const CHAPTERS = [
    { titleKey: "fictoria.manual.ch1.title", bodyKey: "fictoria.manual.ch1.body" },
    { titleKey: "fictoria.manual.ch2.title", bodyKey: "fictoria.manual.ch2.body" },
    { titleKey: "fictoria.manual.ch3.title", bodyKey: "fictoria.manual.ch3.body" },
    { titleKey: "fictoria.manual.ch4.title", bodyKey: "fictoria.manual.ch4.body" },
    { titleKey: "fictoria.manual.ch5.title", bodyKey: "fictoria.manual.ch5.body" },
    { titleKey: "fictoria.manual.ch6.title", bodyKey: "fictoria.manual.ch6.body" },
];

/** 上次打开表单的 tick，按玩家 id 记 */
const lastOpenAt = new Map();

function showWithRetry(player, build) {
    let tries = 0;

    const attempt = () => {
        const form = build();

        form.show(player).then((res) => {
            if (!res.canceled) {
                if (typeof res.selection === "number") {
                    openChapter(player, res.selection);
                }

                return;
            }

            // 手还举着东西 / 正在用物品：等一下再来
            if (res.cancelationReason === "userBusy" && tries < RETRY_TIMES) {
                tries++;
                system.runTimeout(attempt, RETRY_DELAY);
            }
        }).catch((e) => {
            console.warn(`[FieldManual] 表单打开失败: ${e}`);
        });
    };

    attempt();
}

function openIndex(player) {
    const form = new ActionFormData()
        .title(t("fictoria.manual.title"))
        .body(t("fictoria.manual.index_body"));

    for (let i = 0; i < CHAPTERS.length; i++) {
        form.button(t(CHAPTERS[i].titleKey), CHAPTER_ICONS[i] || CHAPTER_ICONS[0]);
    }

    form.button(t("fictoria.manual.close"));

    showWithRetry(player, () => form);
}

function openChapter(player, index) {
    const ch = CHAPTERS[index];

    if (ch === undefined) return;

    const form = new ActionFormData()
        .title(t(ch.titleKey))
        .body(t(ch.bodyKey))
        .button(t("fictoria.manual.back"))
        .button(t("fictoria.manual.close"));

    form.show(player).then((res) => {
        if (res.canceled) {
            if (res.cancelationReason === "userBusy") {
                system.runTimeout(() => openChapter(player, index), RETRY_DELAY);
            }

            return;
        }

        if (res.selection === 0) openIndex(player);
    }).catch((e) => {
        console.warn(`[FieldManual] 章节打开失败: ${e}`);
    });
}

function openManual(player) {
    const now = system.currentTick;
    const prev = lastOpenAt.get(player.id);

    if (prev !== undefined && now >= prev && now - prev < OPEN_COOLDOWN) return;

    if (lastOpenAt.size > 64) lastOpenAt.clear();

    lastOpenAt.set(player.id, now);

    // 等一 tick 再弹：右键那一下玩家往往还在"使用物品"状态，立刻 show 会被 userBusy 挡
    system.runTimeout(() => openIndex(player), 1);
}

export function initFieldManual() {
    world.afterEvents.itemUse.subscribe((ev) => {
        if (ev.itemStack === undefined || ev.itemStack.typeId !== MANUAL_ID) return;

        openManual(ev.source);
    });

    // 对着方块右键时部分版本只触发这一条，itemUse 不响
    world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
        if (ev.itemStack === undefined || ev.itemStack.typeId !== MANUAL_ID) return;

        openManual(ev.player);
    });
}
