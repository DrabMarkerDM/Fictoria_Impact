/*
 * 欢迎来到-幻域Phantoria（item:field_manual）。手持右键打开表单：首页列出章节，点进去看正文，
 * 正文页可以返回首页。表单只能放文字和按钮，没有图片、没有富文本，排版靠换行和分隔符。
 * 打开失败最常见的两种：userBusy（玩家手还在用东西）和 show 到一半玩家死了 —— 前者重试几次
 * 就过，后者直接放弃。
 */
import { system, world } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";

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

const CHAPTERS = [
    {
        title: "第一章  从第一个生命开始",
        body:
`
§e如何获取？§r
· 创造模式：
· 物品栏「装备 → 战术物品组」里有满的幻域球和各种模块；刷怪蛋在「物品」页。
· 手持满的幻域球右键方块 → 她直接出现。
· 生存模式：
· 合成「心/Card_1」驯服：工作台里 3 颗绿宝石斜着摆，手持右键完成驯服。
· 合成「幻域球（空）」可像宝可梦一样收回放置女仆：8 颗绿宝石围一圈，中间放一张卡牌。

作为新人，你在第一次进入这个世界时，会自动赠予你一颗装好女仆的幻域球和新手指南。`
    },
    {
        title: "第二章  普通-女仆",
        body:
`刚驯服时她是普通女仆，有多种功能。

§e战斗§r
· 手持任意剑、长矛、弓、弩右键女仆——她换上对应武器进入战斗。换装备时，她原来那把会掉在脚边，记得捡。
· 长矛按近战戳刺使用，不能投掷。

§e烹饪§r
· 手持生食右键 → 进入烹饪模式，可连续烹饪，
玩家潜行右键 → 取走做好的食物。
· 注：在女仆闲置的空手状态下，背包中如有生食，也会自动进行烹饪哦。

§e喂面包§r
· 手持面包右键 → 她吃下。任何状态都能喂，坐着、战斗中、采集时都吃。
· 吃下后 10 秒内获得：力量 II、生命提升 VI、伤害吸收 VI，并立刻回复一次生命。
· 打架前喂一个，等于多一层护盾 + 多一截血条，很划算。

§e农耕§r
· 手持铁锄右键 → 进入农耕模式，她自己找附近的耕地干活，
能种植和回收原版作物，包括南瓜、西瓜这类整块作物也能收。
· 女仆具备使用骨粉的能力，且每隔一段时间，会自己制作骨粉。
· 女仆踩在漏斗上时，背包物品会自动输入漏斗。

§e采集§r
· 手持镐右键 → 挖矿；手持斧右键 → 砍树。她会自己找附近的矿石/原木走过去开挖。
· 挖出来的东西自动进她背包（背包满了掉在脚下）。
· 要取货：直接右键（不用潜行）就能打开她的背包。
· 要收工：潜行 + 右键 → 她停下、退出采集状态，工具还给你。
· 砍树会把整棵连着的树干一起推倒（最多 96 格）。
· 注：她走的路上如果有岩浆或深坑，会自己绕；实在到不了会站着等，不会破坏方块开路。

§e穿甲/持盾§r
· 空手、待命状态下，手持护甲/盾牌右键 → 她穿上（注：空手状态无法装备盾牌）
· 如何卸甲：玩家潜行 + 手持 Maid Command 右键 → 把甲和盾取下来交给你。

§e打开背包§r
· 空手、待命状态下，玩家潜行+右键打开女仆背包
· 女仆手持物品时，直接右键即可打开背包 `
    },
    {
        title: "第三章  军械-女仆",
        body:
`§e晋升§r
· 空手、待命状态下，手持「War Cross」右键 → 晋升军械女仆。

§e换武器§r
手持模块右键即可换装：
· 模块-M4A1：切换为M4A1步枪作战，为高频连发
· 模块-GLOCK：切换为格洛克手枪作战，可发现隐藏的敌人
· 模块-MOSSBERG：切换为莫斯伯格霰弹枪作战，可近距离群体攻击
· 模块-AWP：切换为AWP狙击枪作战，可攻击超远距离的敌人
· 模块-SWORD：切换为幻域光束剑作战，可近距离群体攻击
换下来的旧武器会掉在脚边。

§e限制§r
· 军械形态无法穿甲，也无法装备原版武器、生食和锄头——只认枪械模块。
想让她穿甲、做饭、种地，得先退回普通形态。

§e降级§r
· 空手、手持「Gentle Cross」右键 → 变回普通女仆。
身上和背包里的装备会掉在脚下，注意捡。`
    },
    {
        title: "第四章  拓展功能",
        body:
`§eMaid Command§r
· 驯服时会给你一个。拿在手上，或者放进女仆的背包，她就会跟着你走。

§e照明§r
· 往她背包任意格放火把，女仆会发光！

§e鞍§r
· 把鞍放进女仆的马鞍位 → 玩家可以骑乘女仆。
· 手持鞍右键女仆 → 抱起或放下她。

§e骑乘载具§r
· 指挥菜单里打开「骑乘」开关后，她会自己骑上 16 格内的马、驴、猪、羊驼，
  跟随模式下会驱使它跟着你走。
· 坐骑被地形卡住（约 1.5 秒没挪窝）且前方有高低坎时，会把坐骑传送到你身边，
  她跟着一起过来；离你超过 40 格也会直接传送一次。
· 你坐在船上时她会自己上船；跟随模式下她会划船跟着你 ——
  各种木船、竹筏、带箱子的船都支持。
· 跟随模式下她本人离你超过 38 格会被传送回来。坐在载具上时这一条不触发，
  改成传送载具，免得把她从坐骑上拽下来。

§e战术指挥§r
· 潜行 + 左键女仆 → 弹出指挥菜单：跟随 / 随机移动 / 巡逻守家
· 跟随模式：如同原版的猫狗一样跟随玩家，超出距离时传送到玩家身边。
· 随机移动模式：女仆不受任何限制的，自由漫步。
· 巡逻守家模式：启用后，女仆以当前所在格为中心，在半径36格以内巡逻，超出巡逻范围自动传送到中心格。`
    },
    {
        title: "第五章  幻域球",
        body:
`幻域球是女仆的移动住所。

§e收回§r
· 手持空的绿球右键女仆 → 收进球里。
背包 36 格、身上的装备、名字和血量状态一起存。

§e放出§r
· 手持满球右键方块 → 她出现在方块表面。
放下后有 5 秒冷却，球会显示为 CD 状态。

注：穿戴盔甲或盾牌的女仆，被幻域球重新放置后，盔甲或盾牌会收进背包。

§e主人保险§r
· 球上记着主人。不是主人的人拿到球，放不出来。
新造出来的球主人记录是空的——谁放出来，谁就成为她的主人。`
},
    {
        title: "第六章  合成表",
        body:
`女仆有诸多相关物品，可不要搞混了哦！

§e心/card_1§r
绿宝石 ×3

§e幻域球（空）§r
绿宝石 ×8 + 卡牌 ×1（≈ 绿宝石 ×11）

§e女仆刷怪蛋§r
金锭 ×4 + 红石 ×1 + 绿宝石 ×1

§eWar Cross§r
钻石 1 + 金锭 4 + 绿宝石 2

§eGentle Cross§r
红石 1 + 木棍 4 + 金粒 2

§e模块-M4A1§r
红石块 1 + 烈焰棒 1 + 紫水晶 2 + 黑曜石 2

§e模块-GLOCK§r
木棍 1 + 红石 1 + 石头 1 + 铁锭 1

§e模块-MOSSBERG§r
红石块 1 + 烈焰棒 1 + TNT 2 + 黑曜石 3

§e模块-AWP§r
烈焰棒 1、紫水晶 2、黑曜石 1、望远镜 1、铁块 1 + 红石块 1

§e模块-SWORD§r
钻石剑 ×1`
    },
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
        .title("§0§l新手指南")
        .body(
            "选一章来读。\n" +
            "§7右击拿在手上的这本指南可以随时翻回来。§r"
        );

    for (let i = 0; i < CHAPTERS.length; i++) {
        form.button(CHAPTERS[i].title, CHAPTER_ICONS[i] || CHAPTER_ICONS[0]);
    }

    form.button("§8关闭");

    showWithRetry(player, () => form);
}

function openChapter(player, index) {
    const ch = CHAPTERS[index];

    if (ch === undefined) return;

    const form = new ActionFormData()
        .title(`§l${ch.title}`)
        .body(ch.body)
        .button("§e返回目录")
        .button("§8关闭");

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
