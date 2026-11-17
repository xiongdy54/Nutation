// v49.135（D302）：AI 解释 / 制卡的语境包——纯函数、零依赖（node 单测经 cards bundle 直跑）。
// 设计 docs/design/EXPLAIN-GROUNDING-D302.md：模型要读懂「这段话在这份材料里的意思」，
// 至少需要来源（书名 · 作者 · 章节路径）与选区前后文。

export interface SelectionSurrounding {
  before: string;
  after: string;
}

/** AI 解释的语境（cardGenerator.explain 第 2 参；字符串形式＝旧语义「书名 · 章节」来源行） */
export interface ExplainContext {
  title?: string;
  author?: string;
  section?: string;
  sectionPath?: string[];
  surrounding?: SelectionSurrounding | null;
}

/** 选文超过该长度时，前后文中用占位代替选文全文（避免长选区在请求里出现两遍） */
export const EXPLAIN_INLINE_SELECTION_MAX = 300;

/** 来源行：《书名》 · 作者：… · 章节：A › B（制卡与解释共用；无书名时为空串） */
export function formatSourceLine(ctx: { title?: string; author?: string; section?: string; sectionPath?: string[] }): string {
  const title = String(ctx.title ?? "").trim();
  if (!title) return "";
  const sectionLabel = ctx.sectionPath?.length ? ctx.sectionPath.join(" › ") : String(ctx.section ?? "").trim();
  return `【来源】《${title}》${ctx.author ? " · 作者：" + ctx.author : ""}${sectionLabel ? " · 章节：" + sectionLabel : ""}`;
}

/**
 * 解释用前后文块：前文⟦选文⟧后文。选文过长时用 ⟦选文（见上）⟧ 占位。
 * 前后文都为空 → 空串（不带，不猜）。
 */
export function formatExplainSurrounding(selection: string, sur: SelectionSurrounding | null | undefined): string {
  if (!sur) return "";
  // 只去掉外侧空白：紧贴选文一侧的空格保留（英文词间空格不能被吞成 cat⟦sat⟧on）
  const before = String(sur.before ?? "").trimStart();
  const after = String(sur.after ?? "").trimEnd();
  if (!before.trim() && !after.trim()) return "";
  const sel = String(selection ?? "").trim();
  const mark = sel.length > 0 && sel.length <= EXPLAIN_INLINE_SELECTION_MAX ? `⟦${sel}⟧` : "⟦选文（见上）⟧";
  // 各宿主取前后文时已归一空白（选文两侧的空格被吞掉）：两侧都是拉丁字母 / 数字时补回一个空格
  const latin = /[A-Za-z0-9]/;
  const gapL = before && !/\s$/.test(before) && latin.test(before.slice(-1)) && latin.test(sel.charAt(0)) ? " " : "";
  const gapR = after && !/^\s/.test(after) && latin.test(after.charAt(0)) && latin.test(sel.slice(-1)) ? " " : "";
  return `【前后文（只用于读懂选文：谁在说、指什么、引自哪里、起什么作用；不要逐句解释前后文）】\n${before}${gapL}${mark}${gapR}${after}`;
}

/** 把 explain 的 context 参数（string | ExplainContext）装配成用户消息中的语境段落 */
export function explainContextBlocks(selection: string, context: string | ExplainContext | null | undefined): string[] {
  if (!context) return [];
  if (typeof context === "string") return context.trim() ? [`【上下文】${context.trim()}`] : [];
  return [formatSourceLine(context), formatExplainSurrounding(selection, context.surrounding)].filter(Boolean);
}
