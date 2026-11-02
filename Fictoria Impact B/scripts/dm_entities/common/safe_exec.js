// ============================================================
// safe_exec.js — 高频路径的分级异常兜底
//
// ── 为什么需要 ────────────────────────────────────────────
// 全工程 321 个 catch 里有 187 个是空实现（catch (_) {}），
// 占 58%。这些空 catch 本身不算错 —— 高频路径确实不能让
// 单次异常打断整个 tick 循环。
//
// 问题是：没有任何一条路径告诉你「这里出过事」。
// 之前几个卡了很久的问题（枪械空转 / 格挡扣次数 /
// 光源滞留）全都符合这个特征：异常被吞，行为静默变化。
//
// ── 方案 ─────────────────────────────────────────────────
//   safeRun(tag, fn)   —— 兜住异常，按 tag 去重后告警一次
//   warnOnce(tag, msg) —— 手工上报，同样去重
//
// 去重的意义：高频路径每 tick 都会失败，
// 但要的只是「这里炸了」这一条信息，而不是 20 条/秒刷屏。
//
// ── 使用约束 ─────────────────────────────────────────────
// 只用在「每 tick 一次」级别的位置。
// 不要放进「每实体」的循环体内部 —— 那是纯函数调用开销，
// 循环内的异常应该由外层统一捕获。
// ============================================================

// 已上报过的 tag
const Reported = new Set();

// 上限，防止极端情况下无限增长
const MAX_REPORTED = 200;

// 是否启用告警
//
// 设为 false 则完全静默，等价于改造前的空 catch。
// 排查线上问题时打开。
const SAFE_EXEC_ALERT = true;

// ============================================================
// 一次性告警
// ============================================================
export function warnOnce(tag, message) {
    if (!SAFE_EXEC_ALERT) return;

    if (Reported.has(tag)) return;

    if (Reported.size >= MAX_REPORTED) return;

    Reported.add(tag);

    try {
        console.warn(`[DM-Safe] ${tag} | ${message}`);
    } catch (_) { }
}

// ============================================================
// 兜底执行
//
// 正常返回 fn() 的返回值；异常时返回 fallback（默认 undefined）。
//
// options.silent = true 时不告警，纯静默兜底。
// ============================================================
export function safeRun(tag, fn, fallback, options) {
    try {
        return fn();
    } catch (e) {
        if (!options || options.silent !== true) {
            const msg = e && e.message ? e.message : String(e);
            const name = e && e.name ? e.name : "Error";
            warnOnce(tag, `${name}: ${msg}`);
        }

        return fallback;
    }
}

// ============================================================
// 静默兜底（保持原有空 catch 语义，但可被集中开关观察）
//
// 用于那些「确实不需要知道」的位置，
// 需要时把 silent 去掉就能看到。
// ============================================================
export function safeSilent(tag, fn, fallback) {
    return safeRun(tag, fn, fallback, { silent: true });
}

// ============================================================
// 诊断
// ============================================================
export function listReportedTags() {
    return Array.from(Reported);
}

export function clearReportedTags() {
    Reported.clear();

    return true;
}
