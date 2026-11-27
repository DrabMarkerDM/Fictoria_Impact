/**
 * i18n.js — 玩家看得见的字一律返回 RawMessage，由客户端按 RP texts/*.lang 里的语言渲染。
 * 只管聊天栏 / actionbar / 表单 / 物品名；日志与报错（console、logErr、throw）保持中文。
 * key 必须同时登记 zh_CN.lang 与 en_US/en_GB.lang —— 缺 key 会把 key 名直接打印到屏幕上。
 *
 * 硬约束：SAPI 的 with 只接受 string[]（或 {rawtext:[...]}），不是任意数组。
 * 往 with 里塞 t(...) 会在运行时抛 "Native variant type conversion failed"，
 * 表单里更会直接打不开面板。所以带状态词的句子一律拆成「一个状态一条 key」，不要嵌套。
 */
export function t(key, ...args) {
    if (args.length === 0) return { translate: key };

    return { translate: key, with: args.map((v) => (v === null || typeof v === "object" ? "" : String(v))) };
}
