// safe_exec.js — 高频路径的分级异常兜底。

// 工程里大量空 catch，异常被吞后行为静默变化（枪械空转 / 格挡扣次数 / 光源滞留都是这样）。
//   safeRun(tag, fn)   兜住异常，按 tag 去重后只报一次
//   warnOnce(tag, msg) 手工上报，同样去重
// 只用在「每 tick 一次」级别的位置，不要放进每实体的循环体。
const Reported = new Set();

// 上限，防止极端情况下无限增长
const MAX_REPORTED = 200;

// 是否启用告警。false = 完全静默（等价于空 catch）。
const SAFE_EXEC_ALERT = true;

// 一次性告警
export function warnOnce(tag, message) {
    if (!SAFE_EXEC_ALERT) return;

    if (Reported.has(tag)) return;

    if (Reported.size >= MAX_REPORTED) return;

    Reported.add(tag);

    try {
        console.warn(`[DM-Safe] ${tag} | ${message}`);
    } catch (_) { }
}

// 兜底执行：正常返回 fn()，异常返回 fallback。options.silent 时不告警。
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

// 静默兜底（保持空 catch 语义，但可被集中开关观察）。
export function safeSilent(tag, fn, fallback) {
    return safeRun(tag, fn, fallback, { silent: true });
}

// 诊断
export function listReportedTags() {
    return Array.from(Reported);
}

export function clearReportedTags() {
    Reported.clear();

    return true;
}
