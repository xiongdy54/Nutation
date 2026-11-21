/**
 * v49.149 / D318 知识点＝义项（设计 docs/design/KG-CONCEPT-SENSES.md §2.2 / §3.3）。
 * 纯函数：制卡草稿的本地裁决（何时静默接受、何时出辨析卡）、粒度提示、全谱候选行与【你过去的辨析】块的格式化。
 * 不读库、不联网、不调模型——测试经 esbuild 打包直接调用。
 */

/** 与全谱的四型对照 */
export type SenseRel = "same" | "narrower" | "split" | "related";
export const SENSE_RELS: SenseRel[] = ["same", "narrower", "split", "related"];

/**
 * 材料术语作为全谱条目名称的命中方式：label＝条目标签；syn / trans / narrow / broad / rel / split / noise＝已分类别名；
 * alias＝未分类别名（旧全谱的别名一律是这一类）。
 */
export type MatchType = "label" | "syn" | "trans" | "narrow" | "broad" | "rel" | "split" | "noise" | "alias";
const MATCH_TYPES: MatchType[] = ["label", "syn", "trans", "narrow", "broad", "rel", "split", "noise", "alias"];
/** 判为「等同」时可以静默接受的命中方式 */
const SAFE_SAME: MatchType[] = ["label", "syn", "trans"];

export type DiscernReason = "unsure" | "split" | "alias-type" | "no-quote" | "fallback-alias";

export function normRel(v: unknown): SenseRel | null {
  return SENSE_RELS.includes(v as SenseRel) ? (v as SenseRel) : null;
}
export function normMatchType(v: unknown): MatchType | null {
  return MATCH_TYPES.includes(v as MatchType) ? (v as MatchType) : null;
}

/** 与 electron/atlas.js norm() 同口径（NFKC + 小写 + 去空白与常见标点），用于比较名称 */
const NAME_NORM_RE = /[\s　·・\-_'"()（）[\]【】《》〈〉,，.。:：;；!！?？/]+/g;
export function normName(s: unknown): string {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(NAME_NORM_RE, "");
}

/** 引句核验：去空白与引号后，引句（≥4 字符）必须是材料的子串 */
const QUOTE_NORM_RE = /[\s　"'“”‘’「」『』]+/g;
export function quoteInSource(quote: unknown, source: unknown): boolean {
  const q = String(quote ?? "").normalize("NFKC").replace(QUOTE_NORM_RE, "");
  if ([...q].length < 4) return false;
  const s = String(source ?? "").normalize("NFKC").replace(QUOTE_NORM_RE, "");
  return s.includes(q);
}

export interface SenseVerdictInput {
  /** AI 给出的对照类型（已归一）；AI 没给编号、靠名称回退找到的候选为 null */
  rel: SenseRel | null;
  unsure: boolean;
  /** 引句是否命中材料 */
  quoteOk: boolean;
  /** 是否有对照的全谱候选 */
  hasCandidate: boolean;
  /** 候选来自名称精确搜索回退（D315），而非 AI 抄回的编号 */
  viaFallback?: boolean;
  /** 材料术语是否就是候选的标签（任一语言，规范化后相等） */
  termIsLabel: boolean;
  /** 材料术语作为候选名称的命中方式；术语不是候选的任何已知名称（AI 按含义选的）时为 null */
  termMatchType: MatchType | null;
}

export interface SenseVerdict {
  /** auto＝静默接受；discern＝草稿里出辨析卡 */
  mode: "auto" | "discern";
  /** 接受卡片时实际采用的对照（用户不点选时的默认值）；null＝不对照全谱 */
  rel: SenseRel | null;
  /** AI 原判断（回流统计用） */
  aiRel: SenseRel | null;
  reasons: DiscernReason[];
}

/**
 * 本地裁决（设计 §3.3）。原则：召回宁多勿漏，判定宁慢勿错，不确定就弃权；错误合并比多建一个代价大，
 * 所以出辨析卡时的默认值偏向「不合并」——AI 判 same 或未知 → 降为 narrower。
 */
export function senseVerdict(x: SenseVerdictInput): SenseVerdict {
  if (!x.hasCandidate) return { mode: "auto", rel: null, aiRel: null, reasons: [] };
  const reasons: DiscernReason[] = [];
  let rel = x.rel;
  if (x.viaFallback && rel == null) {
    // 名称回退：命中标签或同义别名才视同等同；其余（含未分类别名）要用户辨析
    if (x.termIsLabel || (x.termMatchType && SAFE_SAME.includes(x.termMatchType))) rel = "same";
    else reasons.push("fallback-alias");
  }
  if (x.unsure) reasons.push("unsure");
  if (rel === "split") reasons.push("split");
  if (rel === "same" && !x.termIsLabel && x.termMatchType != null && !SAFE_SAME.includes(x.termMatchType)) reasons.push("alias-type");
  if ((rel === "same" || rel === "narrower" || rel === "split") && !x.quoteOk && !(x.viaFallback && x.rel == null)) reasons.push("no-quote");
  if (!reasons.length) return { mode: "auto", rel, aiRel: x.rel, reasons };
  const fallbackRel: SenseRel = rel === "narrower" || rel === "split" || rel === "related" ? rel : "narrower";
  return { mode: "discern", rel: fallbackRel, aiRel: x.rel, reasons };
}

/** 粒度提示（设计 §2.2）：sentence＝像一句话；too-long＝过长；no-definition＝没有定义。只提示，不阻断。 */
export type KpLint = "sentence" | "too-long" | "no-definition";
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿]/;
export function kpLabelLint(label: unknown, definition: unknown): KpLint[] {
  const s = String(label ?? "").trim();
  const out: KpLint[] = [];
  if (!s) return out;
  const commaLong = /[,，、]/.test(s) && [...s].length > 8;
  if (/[。！？；!?;]/.test(s) || commaLong) out.push("sentence");
  const cjk = [...s].filter((ch) => CJK_RE.test(ch)).length;
  const words = s.replace(/[぀-ヿ㐀-鿿豈-﫿]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  if (cjk > 16 || (cjk === 0 && words > 6)) out.push("too-long");
  if (!String(definition ?? "").trim()) out.push("no-definition");
  return out;
}

/** 全谱候选（制卡请求装配与归属解析共用的最小形状） */
export interface SenseCandidate {
  id: string;
  zh: string | null;
  en: string | null;
  ja: string | null;
  zht?: string | null;
  gloss?: string | null;
  glossEn?: string | null;
  def?: string | null;
  defEn?: string | null;
  kindLabel?: string;
  /** 材料里命中的规范化名称 */
  matched?: string | null;
  matchedType?: MatchType | null;
  /** 命中的是译名分化别名时，该义项的一句说明 */
  matchedGloss?: string | null;
  /** 该节点在材料里的全部命中名称（标签与别名可能同时出现） */
  matches?: { norm: string; type: MatchType | null; gloss: string | null }[];
}

export function candidateLabels(c: SenseCandidate): string[] {
  return [c.zh, c.zht, c.en, c.ja].filter((x): x is string => typeof x === "string" && !!x.trim());
}

/** 材料术语相对候选的命中方式（供 senseVerdict）：是标签 → label；等于本次命中的名称 → 该命中方式；否则 null */
export function termMatchOf(term: string, c: SenseCandidate): { termIsLabel: boolean; termMatchType: MatchType | null } {
  const k = normName(term);
  if (!k) return { termIsLabel: false, termMatchType: null };
  if (candidateLabels(c).some((l) => normName(l) === k)) return { termIsLabel: true, termMatchType: "label" };
  const hit = (c.matches || []).find((m) => m && normName(m.norm) === k);
  if (hit) return { termIsLabel: hit.type === "label", termMatchType: normMatchType(hit.type) ?? "alias" };
  if (c.matched && normName(c.matched) === k) return { termIsLabel: false, termMatchType: normMatchType(c.matchedType) ?? "alias" };
  return { termIsLabel: false, termMatchType: null };
}

const MATCH_TEXT: Record<MatchType, string> = {
  label: "名称",
  syn: "又名·同义",
  trans: "又名·译名或写法",
  narrow: "又名·更窄的概念",
  broad: "又名·更宽的概念",
  rel: "又名·相关概念",
  split: "又名·译名分化",
  noise: "又名·存疑",
  alias: "又名（未分类，含义可能不同）"
};

/** 【全谱候选知识点】一行：编号｜名称｜类别，说明｜定义｜命中方式（R22 v11） */
export function formatCandidateLine(c: SenseCandidate): string {
  const name = c.zh || c.en || c.ja || c.id;
  const parts = [c.id, name, [c.kindLabel, c.gloss || c.glossEn].filter(Boolean).join("，")];
  const def = c.def || c.defEn;
  parts.push(def ? `定义：${def}` : "");
  // 命中方式：列出材料里所有「不是标签」的命中名称（标签命中不必说明）
  const ms = (c.matches && c.matches.length ? c.matches : c.matched ? [{ norm: c.matched, type: c.matchedType ?? null, gloss: c.matchedGloss ?? null }] : [])
    .map((m) => ({ ...m, type: normMatchType(m.type) ?? (candidateLabels(c).some((l) => normName(l) === normName(m.norm)) ? "label" : "alias") }))
    .filter((m) => m.type !== "label");
  parts.push(ms.map((m) => `材料里的「${m.norm}」是它的${MATCH_TEXT[m.type as MatchType]}${m.type === "split" && m.gloss ? `（该义项：${m.gloss}）` : ""}`).join("；"));
  while (parts.length && !parts[parts.length - 1]) parts.pop();
  return parts.join("｜");
}

export interface SenseExample {
  term: string;
  atlasLabel: string;
  aiRel: SenseRel | null;
  userRel: SenseRel | "none";
}
const REL_TEXT: Record<SenseRel | "none", string> = {
  same: "同一个",
  narrower: "它下面的一个概念",
  split: "同一外语词的另一义（译名分化）",
  related: "相关但不同",
  none: "不相干"
};
/** 【你过去的辨析】块（≤6 条）；没有则空串 */
export function formatSenseExamples(list: SenseExample[]): string {
  const rows = (Array.isArray(list) ? list : []).filter((x) => x && x.term && x.atlasLabel).slice(0, 6);
  if (!rows.length) return "";
  const lines = rows.map((x) => `「${x.term}」vs 全谱「${x.atlasLabel}」→ ${REL_TEXT[x.userRel] || x.userRel}${x.aiRel && x.aiRel !== x.userRel ? `（AI 曾判为${REL_TEXT[x.aiRel]}）` : ""}`);
  return `【你过去的辨析（用户亲自确认的判断，同类情况照此口径）】\n${lines.join("\n")}`;
}
