// perf_probe.js — 本地性能探针。

// 补官方 /script profiler 之外的事：游戏内实时、零落盘、可长期挂着。
// 能测：tick 漂移（真实 mspt/tps）、分段平均耗时、调用计数、native 单次成本。
// 不能测：单次调用的绝对耗时（Date.now 分辨率 1ms）。
// 成本：关闭时为零；开启时每 tick 一次自增 + 每 20 tick 一次取时钟。

import {
    system,
    world,
    CommandPermissionLevel,
    CustomCommandStatus
} from "@minecraft/server";

// 常量

// 采样窗口（tick）。20 tick = 1 秒
const SAMPLE_WINDOW_TICKS = 20;

// 一个 tick 的时间预算
const TICK_BUDGET_MS = 50;

// 单个窗口的 mspt 超过这个值，记一次「跟不上」
const SPIKE_MS = 55;

// dw/dt 超过这个值判定为暂停 / 切后台，丢弃该窗口

// 打开菜单、切出游戏时 system.currentTick 会停，
// 但 wall clock 照走，不丢弃会得到一个巨大的假值。
const SUSPEND_RATIO = 500;

// 分段账本上限，防泄漏
const MAX_SECTIONS = 64;

// 单次微基准的时间预算。每个 case 跑这么久，然后 yield 一 tick，
// 避免长时间占用主线程触发 watchdog。
const BENCH_BUDGET_MS = 60;

// 微基准预热时长
const BENCH_WARMUP_MS = 5;

// 状态

let active = false;
let intervalHandle = null;

// 窗口计时
let windowTicks = 0;
let windowStartWall = 0;

// 上一个采样点的 tick
let lastTickRef = 0;

// 最近一个窗口的结果
let mspt = 0;
let tps = 20;
let worstMspt = 0;
let windowCount = 0;
let spikeCount = 0;

// 分段账本：tag -> { totalMs, count, maxMs }
const Sections = new Map();

// 通用计数器：tag -> number
const Counters = new Map();

// 防 JIT 消除的落点
const Sink = { v: 0 };

// 微基准用的 dynamic property 键

// 必须是业务代码完全不认识的独立名字。
// 借用 dm:cmd_vel_* 会让「改造前通道」被测试自己写脏，
// 测出来的数就不能代表真实业务成本了。
const BENCH_DP_KEY = "perf:bench_dp";

// 微基准挂靠的实体（由 buildBenchCases 写入，跑完清理键）
let benchDpEntity = null;

// 采样

function sample() {
    if (++windowTicks < SAMPLE_WINDOW_TICKS) return;

    windowTicks = 0;

    let tickNow;
    try {
        tickNow = system.currentTick;
    } catch (_) {
        return;
    }

    const wallNow = Date.now();

    const dTick = tickNow - lastTickRef;
    const dWall = wallNow - windowStartWall;

    if (dTick <= 0) return;

    const ratio = dWall / dTick;

    // 暂停 / 切后台：丢弃这个窗口，重新对齐
    if (ratio > SUSPEND_RATIO) {
        lastTickRef = tickNow;
        windowStartWall = wallNow;
        return;
    }

    lastTickRef = tickNow;
    windowStartWall = wallNow;

    mspt = ratio;
    tps = 1000 / ratio;
    windowCount++;

    if (ratio > worstMspt) worstMspt = ratio;
    if (ratio > SPIKE_MS) spikeCount++;
}

// 对外 API

export const PerfProbe = {

    // --------------------------------------------------------
    // 总开关状态（由 initPerfProbe 写入 main.js 的常量）

    // master = false 时：
    //   · 不注册 scriptevent，命令完全无响应
    //   · active 永远 false，所有埋点零开销
    // --------------------------------------------------------
    master: false,

    // --------------------------------------------------------
    // 是否在采样
    // --------------------------------------------------------
    get enabled() {
        return active;
    },

    // --------------------------------------------------------
    // 开始 / 停止
    // --------------------------------------------------------
    start() {
        // 总开关没开，任何途径都不能启动
        if (!this.master) return;

        if (active) return;

        active = true;
        windowTicks = 0;
        windowStartWall = Date.now();

        try {
            lastTickRef = system.currentTick;
        } catch (_) {
            lastTickRef = 0;
        }

        intervalHandle = system.runInterval(() => {
            try {
                sample();
            } catch (_) { }
        }, 1);
    },

    stop() {
        active = false;

        if (intervalHandle !== null) {
            try {
                system.clearRun(intervalHandle);
            } catch (_) { }
            intervalHandle = null;
        }
    },

    // --------------------------------------------------------
    // 清空账本
    // --------------------------------------------------------
    reset() {
        Sections.clear();
        Counters.clear();
        windowCount = 0;
        spikeCount = 0;
        worstMspt = 0;
        mspt = 0;
        tps = 20;

        // 采样窗口必须跟着一起重置。

        // 只清账本不清窗口的话，start() 在 active 时直接 return，
        // windowStartWall 仍是旧的 —— 下一个窗口会把 reset 之前
        // 那段时长算进 dWall，得到一个偏高的假 mspt。
        // 跑完 bench 再 /perf:on 就会踩这个坑。
        windowTicks = 0;
        windowStartWall = Date.now();

        try {
            lastTickRef = system.currentTick;
        } catch (_) {
            lastTickRef = 0;
        }
    },

        // 埋点成对使用：
        //   const t = PerfProbe.now();  doSomething();  PerfProbe.lap("engine.update", t);
        // 关闭时 now() 返回 0、lap() 直接 return，只付两次函数调用。
    now() {
        return active ? Date.now() : 0;
    },

    lap(tag, startWall) {
        if (!active || startWall === 0) return;

        const dt = Date.now() - startWall;

        let s = Sections.get(tag);

        if (!s) {
            if (Sections.size >= MAX_SECTIONS) return;
            s = { totalMs: 0, count: 0, maxMs: 0 };
            Sections.set(tag, s);
        }

        s.totalMs += dt;
        s.count++;

        if (dt > s.maxMs) s.maxMs = dt;
    },

    // --------------------------------------------------------
    // 计数：调用次数是确定性指标，比耗时更硬

    //   PerfProbe.count("getEntities");
    // --------------------------------------------------------
    count(tag, n) {
        if (!active) return;

        const add = (n === undefined) ? 1 : n;

        Counters.set(tag, (Counters.get(tag) || 0) + add);
    },

    // --------------------------------------------------------
    // 报告
    // --------------------------------------------------------
    report() {
        const out = [];

        out.push("§b===== PerfProbe =====");

        if (!active && windowCount === 0) {
            out.push("§7未采样。用 §f/perf:on §7开始。");
            return out;
        }

        out.push(
            `§7窗口 §f${windowCount}§7×§f${SAMPLE_WINDOW_TICKS}§7tick  ` +
            `§7mspt §f${mspt.toFixed(2)}§7/§f${TICK_BUDGET_MS}  ` +
            `§7tps §f${tps.toFixed(2)}`
        );

        const spikeColor = spikeCount > 0 ? "§c" : "§a";

        out.push(
            `§7最差窗口 §f${worstMspt.toFixed(2)}ms  ` +
            `§7丢帧 ${spikeColor}${spikeCount}`
        );

        if (Sections.size > 0) {
            out.push("§7--- 分段（平均值，样本越多越准）---");

            // 采样覆盖的总 tick 数，用来算「每 tick 摊多少」
            const totalTicks = windowCount * SAMPLE_WINDOW_TICKS;

            const rows = Array.from(Sections.entries())
                .sort((a, b) => b[1].totalMs - a[1].totalMs);

            for (const [tag, s] of rows) {
                if (s.count === 0) continue;

                const avg = s.totalMs / s.count;

                // 每 tick 摊多少：这一段占了多少 tick 预算。
                // 比「单次平均」有用得多 —— 单次 0.05ms 的分段，
                // 一 tick 跑 30 次就是 1.5ms，占比 3%。
                const perTick = totalTicks > 0
                    ? s.totalMs / totalTicks
                    : 0;

                out.push(
                    `§7${tag}  §favg ${avg.toFixed(3)}ms  ` +
                    `§7max ${s.maxMs}ms  ` +
                    `§7n ${s.count}  ` +
                    `§e/tick ${perTick.toFixed(3)}ms`
                );
            }
        }

        if (Counters.size > 0) {
            out.push("§7--- 计数 ---");

            const rows = Array.from(Counters.entries())
                .sort((a, b) => b[1] - a[1]);

            for (const [tag, n] of rows) {
                out.push(`§7${tag}  §f${n}`);
            }
        }

        return out;
    }
};

// 聊天栏简报（一行）：mspt / tps / 丢帧 + 最贵的两段。
// 完整明细走 /perf:off 或 /scriptevent perf:report。

// 简报里最多显示几段
const BRIEF_TOP_SECTIONS = 2;

function briefLine() {
    const totalTicks = windowCount * SAMPLE_WINDOW_TICKS;

    const parts = [
        `§bmspt §f${mspt.toFixed(1)}`,
        `§btps §f${tps.toFixed(1)}`
    ];

    if (spikeCount > 0) {
        parts.push(`§c丢帧 §f${spikeCount}`);
    }

    if (totalTicks > 0 && Sections.size > 0) {
        const rows = [];

        for (const [tag, s] of Sections) {
            if (s.count === 0) continue;

            const perTick = s.totalMs / totalTicks;
            if (perTick <= 0) continue;

            rows.push([tag, perTick]);
        }

        rows.sort((a, b) => b[1] - a[1]);

        const n = Math.min(rows.length, BRIEF_TOP_SECTIONS);

        for (let i = 0; i < n; i++) {
            parts.push(`§7${rows[i][0]} §e${rows[i][1].toFixed(3)}ms/t`);
        }
    }

    return parts.join(" §8| ");
}

// 微基准：目的不是绝对耗时，而是换算系数（一次 hasTag 值多少钱）。
// 每个 case 单独占一个 tick，最多跑 BENCH_BUDGET_MS 毫秒。

// 模块常量 filter —— 和调用点用的一模一样
const FILTER_DM = { families: ["dm"] };

function benchOne(label, fn) {
    // 预热：把 JIT 和内联缓存先烧热，这段不计入
    const warmEnd = Date.now() + BENCH_WARMUP_MS;

    while (Date.now() < warmEnd) {
        for (let i = 0; i < 50; i++) {
            if (fn(i)) Sink.v++;
        }
    }

    const t0 = Date.now();
    let n = 0;
    let t = t0;

    do {
        // 内层固定 200 次，粒度足够；每次进入 do 检查一次时钟
        for (let i = 0; i < 200; i++) {
            if (fn(i)) Sink.v++;
            n++;
        }
        t = Date.now();
    } while (t - t0 < BENCH_BUDGET_MS);

    const ms = t - t0;

    return {
        label,
        n,
        ms,
        us: (ms * 1000) / n
    };
}

function buildBenchCases() {
    const cases = [];

    let player = null;

    try {
        const ps = world.getAllPlayers();
        if (ps.length > 0) player = ps[0];
    } catch (_) { }

    // 1. 探针自身成本基线
    cases.push({
        label: "Date.now()",
        fn: () => Date.now() > 0
    });

    // 2. native 属性读
    cases.push({
        label: "system.currentTick",
        fn: () => system.currentTick > 0
    });

    // 3. 官方文档点名的坏例子：每次重新取 dimension
    cases.push({
        label: "world.getDimension",
        fn: () => world.getDimension("overworld") !== undefined
    });

    // 4. 纯 JS 基线：Map 查询
    const m = new Map();
    for (let i = 0; i < 256; i++) m.set(i, { x: i });

    cases.push({
        label: "Map.get",
        fn: (i) => m.get(i & 255) !== undefined
    });

    if (!player) return cases;

    // 5. 玩家列表（很贵，证明别在热路径里调）
    cases.push({
        label: "world.getAllPlayers",
        fn: () => world.getAllPlayers().length > 0
    });

    // 6. 对象构造型属性读
    cases.push({
        label: "player.location",
        fn: () => player.location.x > -1e9
    });

    // 7. 有效性检查（会抛错的属性）
    cases.push({
        label: "entity.isValid",
        fn: () => player.isValid
    });

    // 8. tag 查询。文档说哈希查找，成本与名字长度无关
    cases.push({
        label: "entity.hasTag",
        fn: () => player.hasTag("dm_has_target")
    });

    // 9. matches + 模块常量 filter
    cases.push({
        label: "matches(常量 filter)",
        fn: () => player.matches(FILTER_DM)
    });

    // 10. matches + 字面量 filter（每次新建对象 + 数组）
    cases.push({
        label: "matches(字面量 filter)",
        fn: () => player.matches({ families: ["dm"] })
    });

        // 11/12. dynamic property 读写 —— 走位指令改造前的通道。
        // 先写初值：读不存在的键可能走短路径，测出来的不是业务真实路径。
    try {
        player.setDynamicProperty(BENCH_DP_KEY, 0);
    } catch (_) { }

    benchDpEntity = player;

    cases.push({
        label: "getDynamicProperty",
        fn: () => player.getDynamicProperty(BENCH_DP_KEY) !== undefined
    });

    // 写：值交替 0/1。

    // 反复写同一个值可能被引擎的脏检查吃掉，而业务里
    // 速度每 tick 都在变，必须让值真的发生变化。

    // 必须 return true：benchOne 用 `if (fn(i)) Sink.v++` 防 JIT 消除，
    // setDynamicProperty 本身返回 undefined，直接返回会被优化掉。
    cases.push({
        label: "setDynamicProperty",
        fn: (i) => {
            player.setDynamicProperty(BENCH_DP_KEY, i & 1);
            return true;
        }
    });

    return cases;
}

/*
 * 跑一遍微基准。每个 case 占一个 tick，跑完回调。
 * @param {(lines: string[]) => void} done
 */
export function runBenchmark(done) {
    const cases = buildBenchCases();
    const results = [];
    let idx = 0;

    function step() {
        if (idx >= cases.length) {
            dropBenchDp();
            done(formatBenchResults(results));
            return;
        }

        const c = cases[idx++];

        try {
            results.push(benchOne(c.label, c.fn));
        } catch (e) {
            results.push({ label: c.label, n: 0, ms: 0, us: 0, error: String(e) });
        }

        system.runTimeout(step, 1);
    }

    step();
}

// 清掉微基准写进实体的键

// setDynamicProperty(key, undefined) 等价于删除。
// 不清的话玩家实体上会永久挂一个 perf:bench_dp，
// 之后每次存档都多带一个无意义的键。
function dropBenchDp() {
    const e = benchDpEntity;

    benchDpEntity = null;

    if (!e) return;

    try {
        e.setDynamicProperty(BENCH_DP_KEY, undefined);
    } catch (_) { }
}

function formatBenchResults(results) {
    const out = ["§b===== 微基准（单次调用成本）====="];

    // 以 Date.now() 为 1 倍基线，给出相对倍数
    const base = results.find((r) => r.label === "Date.now()");
    const baseUs = base && base.us > 0 ? base.us : 1;

    for (const r of results) {
        if (r.error) {
            out.push(`§c${r.label} 失败: ${r.error}`);
            continue;
        }

        const ratio = r.us / baseUs;

        out.push(
            `§7${r.label}  §f${r.us.toFixed(3)}μs  ` +
            `§7×${ratio.toFixed(1)}  ` +
            `§7n=${r.n}`
        );
    }

    // 单独标出常量 / 字面量的差距，这是可以直接抄的结论
    const lit = results.find((r) => r.label === "matches(字面量 filter)");
    const cst = results.find((r) => r.label === "matches(常量 filter)");

    if (lit && cst && cst.us > 0) {
        const save = lit.us - cst.us;
        const pct = (save / lit.us) * 100;

        out.push(
            `§e字面量 filter 比常量贵 §f${save.toFixed(3)}μs` +
            `§e（§f${pct.toFixed(0)}%§e）`
        );
    }

    // --------------------------------------------------------
    // 走位指令通道：动态属性 vs 内存表

    // 这是 move_command_store 改造的收益口径。
    // 旧路径：每单位每 tick 3 次 getDynamicProperty（x/y/z）。
    // 新路径：1 次 Map.get + 3 次普通字段读。
    // --------------------------------------------------------
    const dpRead = results.find((r) => r.label === "getDynamicProperty");
    const dpWrite = results.find((r) => r.label === "setDynamicProperty");
    const mapGet = results.find((r) => r.label === "Map.get");

    if (dpRead && mapGet && mapGet.us > 0) {
        out.push(
            `§e1 次动态属性读 = §f${(dpRead.us / mapGet.us).toFixed(1)}` +
            `§e 次 Map.get`
        );

        // 净节省：3 次 DP 读 换成 1 次 Map.get

        // 100 单位 × 20tps = 2000 次/秒，
        // μs → ms 要再除 1000，合起来就是 ×2。
        const saved = dpRead.us * 3 - mapGet.us;

        if (saved > 0) {
            out.push(
                `§e每单位每 tick 省 §f${saved.toFixed(3)}μs` +
                `§e → 100 单位满负荷 §f${(saved * 2).toFixed(2)}ms/s`
            );
        }
    }

    if (dpWrite && mapGet && mapGet.us > 0) {
        out.push(
            `§71 次动态属性写 = §f` +
            `${(dpWrite.us / mapGet.us).toFixed(1)}§7 次 Map.get`
        );
    }

    out.push("§7换算：省掉 N 次调用 = N × 上表 μs");

    return out;
}

// 控制通道：
//   /perf:on   标定单次成本 → 开始采样      /perf:off  停止并出报告
//   /perf:bench 只标定，不打断采样
//   /scriptevent perf:on|off|report|reset|bench|hud（功能更全，共享同一账本）
// 自定义命令只在 startup 注册，改完总开关必须退出世界重进。

let hudEnabled = false;
let hudHandle = null;

function reply(ev, text) {
    try {
        const src = ev.sourceEntity;

        if (src && src.typeId === "minecraft:player") {
            src.sendMessage(text);
            return;
        }
    } catch (_) { }

    try {
        world.sendMessage(text);
    } catch (_) { }
}

function updateHud() {
    if (!active) return;

    try {
        const text =
            `§bmspt §f${mspt.toFixed(1)} ` +
            `§btps §f${tps.toFixed(1)} ` +
            `§c丢帧 §f${spikeCount}`;

        for (const p of world.getAllPlayers()) {
            try {
                p.onScreenDisplay.setActionBar(text);
            } catch (_) { }
        }
    } catch (_) { }
}

/** 挂载探针。masterEnabled = false 时直接返回：不注册命令、不挂 interval，埋点零开销。
 *  @param {boolean} masterEnabled main.js 的总开关 */
export function initPerfProbe(masterEnabled) {
    PerfProbe.master = (masterEnabled === true);

    if (!PerfProbe.master) return;

    try {
        system.afterEvents.scriptEventReceive.subscribe(
            (ev) => {
                try {
                    handleCommand(ev);
                } catch (_) { }
            },
            { namespaces: ["perf"] }
        );
    } catch (_) { }

    // 总开关打开 = 立刻开始采样，不用再打命令
    PerfProbe.start();
}

function handleCommand(ev) {
    const id = ev.id;

    if (!id || id.indexOf("perf:") !== 0) return;

    const sub = id.slice(5);

    if (sub === "on") {
        PerfProbe.start();
        reply(ev, "§aPerfProbe 已开启。§7/scriptevent perf:report 看数据");
        return;
    }

    if (sub === "off") {
        PerfProbe.stop();
        reply(ev, PerfProbe.report().join("\n"));
        return;
    }

    if (sub === "report") {
        reply(ev, PerfProbe.report().join("\n"));
        return;
    }

    if (sub === "reset") {
        PerfProbe.reset();
        reply(ev, "§7账本已清空");
        return;
    }

    if (sub === "bench") {
        reply(ev, "§7微基准运行中，约 1 秒…");

        runBenchmark((lines) => {
            reply(ev, lines.join("\n"));
        });
        return;
    }

    if (sub === "hud") {
        hudEnabled = !hudEnabled;

        if (hudEnabled) {
            if (hudHandle === null) {
                hudHandle = system.runInterval(() => {
                    try {
                        updateHud();
                    } catch (_) { }
                }, 20);
            }
            reply(ev, "§aHUD 已开启");
        } else {
            if (hudHandle !== null) {
                try {
                    system.clearRun(hudHandle);
                } catch (_) { }
                hudHandle = null;
            }
            reply(ev, "§7HUD 已关闭");
        }
    }
}

// 自定义命令 /perf:on、/perf:off（customCommandRegistry，2.1.0 起是稳定 API）。
// 三条约束：只能在 system.beforeEvents.startup 注册且全进程一次（订阅写在模块顶层）；
// 命令名必须带命名空间；restricted-execution 下 registerCommand 会抛错。

// 简报周期（tick）。100 tick = 5 秒
const CHAT_BRIEF_TICKS = 100;

let chatBriefHandle = null;

// 简报发件人。命令方块触发时为 null → 广播
let chatBriefPlayer = null;

// /perf:on 正在跑微基准

// bench 要等约 1 秒才回调，这期间再打一次 /perf:on
// 会起第二串 bench，两边抢 tick 而且账本会被清两次。
let onPending = false;

// on 的代次

// 场景：/perf:on 之后 1 秒内又打了 /perf:off。
// off 只能停掉当前采样，拦不住已经在排队的那串 bench ——
// 回调跑完还会把采样重新拉起来，玩家以为停了其实在跑。
// 所以 off 把代次加一，让那一串的回调直接作废。
let onGen = 0;

function sendLines(origin, lines) {
    let target = null;

    try {
        const src = origin ? origin.sourceEntity : null;

        if (src && src.typeId === "minecraft:player") {
            target = src;
        }
    } catch (_) { }

    for (const line of lines) {
        try {
            if (target) {
                target.sendMessage(line);
            } else {
                world.sendMessage(line);
            }
        } catch (_) { }
    }
}

// 取命令执行者。命令方块 / 控制台触发时返回 null（后续广播）
function pickTarget(origin) {
    try {
        const src = origin ? origin.sourceEntity : null;

        if (src && src.typeId === "minecraft:player") {
            return src;
        }
    } catch (_) { }

    return null;
}

// 单行发送：收件人失效就退回广播

// 异步回调用这个而不是 sendLines —— 那边要 origin，
// 而 origin 在命令返回后就不保证可用了。
function tell(target, text) {
    try {
        if (target && target.isValid) {
            target.sendMessage(text);
            return;
        }
    } catch (_) { }

    try {
        world.sendMessage(text);
    } catch (_) { }
}

function sendChatBrief() {
    if (!active) return;

    const line = briefLine();

    if (!line) return;

    const p = chatBriefPlayer;

    if (p) {
        try {
            if (p.isValid) {
                p.sendMessage(line);
            }
        } catch (_) {
            // 玩家下线后访问 isValid 会抛，停掉即可
            chatBriefPlayer = null;
        }

        return;
    }

    // 没有收件人（命令方块 / 服务器控制台）→ 广播
    try {
        world.sendMessage(line);
    } catch (_) { }
}

function startChatBrief() {
    if (chatBriefHandle !== null) return;

    chatBriefHandle = system.runInterval(() => {
        try {
            sendChatBrief();
        } catch (_) { }
    }, CHAT_BRIEF_TICKS);
}

function stopChatBrief() {
    if (chatBriefHandle === null) return;

    try {
        system.clearRun(chatBriefHandle);
    } catch (_) { }

    chatBriefHandle = null;
}

system.beforeEvents.startup.subscribe((init) => {
    try {
        // 总开关关闭 → 一个命令都不注册
        if (!PerfProbe.master) return;

        const registry = init.customCommandRegistry;

        // 引擎版本过低时这个属性不存在，静默跳过
        if (!registry) return;

        registry.registerCommand(
            {
                name: "perf:on",
                description: "先标定单次调用成本，再开始采样（聊天栏每 5 秒一行简报）",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                cheatsRequired: true
            },
            (origin) => {
                // 收件人必须在命令返回前抓住：
                // origin 之后失效，而 bench 回调要等约 1 秒
                const target = pickTarget(origin);

                chatBriefPlayer = target;

                if (onPending) {
                    return {
                        status: CustomCommandStatus.Success,
                        message: "§7微基准还在跑，等 1 秒再来"
                    };
                }

                onPending = true;

                // 代次：/perf:off 会把它加一，让这串 bench
                // 跑完后直接作废，不会在玩家喊停之后又偷偷开始采样
                const gen = ++onGen;

                // 先停采样。

                // bench 的 13 个 case 各占一个 tick，如果让它
                // 和采样并行，这 1 秒里的窗口会全部变成坏样本。
                PerfProbe.stop();
                stopChatBrief();

                // bench 结束才算「开始采样」——顺序反过来
                // 就等于把 bench 自己测进了账本。
                try {
                    runBenchmark((lines) => {
                        onPending = false;

                        // 已被 /perf:off 取消
                        if (gen !== onGen) return;

                        for (const line of lines) {
                            tell(target, line);
                        }

                        PerfProbe.reset();
                        PerfProbe.start();
                        startChatBrief();

                        tell(target, "§a采样已开始 §7— 跑够了就 /perf:off");
                    });
                } catch (e) {
                    // 标定失败不该拦住采样本身
                    onPending = false;

                    if (gen === onGen) {
                        PerfProbe.reset();
                        PerfProbe.start();
                        startChatBrief();

                        tell(target, "§c微基准失败: " + e + " §7（采样已直接开始）");
                    }
                }

                return {
                    status: CustomCommandStatus.Success,
                    message: "§7标定中… 约 1 秒后开始采样"
                };
            }
        );

        registry.registerCommand(
            {
                name: "perf:off",
                description: "停止采样，并在聊天栏输出完整报告",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                cheatsRequired: true
            },
            (origin) => {
                // 作废还在排队的那串 bench：
                // 否则它 1 秒后跑完会把采样重新拉起来
                onGen++;
                onPending = false;

                stopChatBrief();

                // 先取报告再 stop：report() 依赖 active 判断是否空账本
                const lines = PerfProbe.report();

                PerfProbe.stop();
                chatBriefPlayer = null;

                sendLines(origin, lines);

                return {
                    status: CustomCommandStatus.Success,
                    message: "§7采样已停止，报告见上"
                };
            }
        );

        // --------------------------------------------------------
        // /perf:bench —— 微基准

        // 与采样互不干扰：bench 不写账本，只占 tick。
        // 顺序建议先 bench 再 /perf:on —— reset() 会把
        // bench 期间产生的采样窗口一并清掉。
        // --------------------------------------------------------
        registry.registerCommand(
            {
                name: "perf:bench",
                description: "跑微基准，标定单次调用成本（约 1 秒）",
                permissionLevel: CommandPermissionLevel.GameDirectors,
                cheatsRequired: true
            },
            (origin) => {
                // 命令返回后 origin 就失效了，先把收件人抓在手里
                const target = pickTarget(origin);

                runBenchmark((lines) => {
                    for (const line of lines) {
                        tell(target, line);
                    }
                });

                return {
                    status: CustomCommandStatus.Success,
                    message: "§7微基准运行中… 约 1 秒"
                };
            }
        );
    } catch (e) {
        console.warn("[PerfProbe] 自定义命令注册失败: " + e);
    }
});
