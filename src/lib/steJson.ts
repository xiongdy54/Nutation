// D301：「简明解读」v5 结构化输出——程序切句、JSON 解析（含流式中途的残缺 JSON）、确定性渲染、规范校验（steLint）、修复指令。
// 模型只输出 JSON；版式（节标题 / 机器标记 / 组件位置）一律由本模块生成，模型无法写错。
// 校验结果驱动 cards.ts 的定向修复回合（违规即带清单重写，质量优先，回合数有上限）。
import { parseUIBlock } from "./genui/spec";
import { STE_BLOCKED_KINDS, type PresentationKind } from "./genui/prompt";

export type SteOutLang = "zh-Hans" | "zh-Hant" | "en" | "ja";

export interface SteComponent {
  after: number;
  block?: Record<string, unknown>;
  mermaid?: string;
}
export interface SteAmbiguity {
  key: string;
  label: string;
  quote: string;
  note: string;
}
export interface SteDoc {
  matLang: string;
  ambiguities: SteAmbiguity[];
  explanations: string[][];
  readings: string[];
  terms: Array<{ term: string; def: string }>;
  components: SteComponent[];
  /** 追问直答：只有 answer（短句数组） */
  answer?: string[];
}

export interface SteViolation {
  path: string;
  rule: string;
  severity: "error" | "warn";
  msg: string;
}

export const STE_AMBIGUITY_KEYS = ["polysemy", "pronoun-ref", "long-nesting", "hidden-agent", "negation-stack", "undefined-term", "register-mix", "quantity-vague", "idiom-figurative", "missing-condition"];
export const STE_CAPS = { ambiguities: 2, readings: 2, terms: 3, components: 2, answer: 5 };

// ---------- 语言与句长 ----------

export function steOutLangOf(lang: string): SteOutLang {
  const l = String(lang || "").toLowerCase();
  if (l.startsWith("en")) return "en";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("zh") && /hant|tw|hk|mo/.test(l)) return "zh-Hant";
  return "zh-Hans";
}

const isCjkOut = (l: SteOutLang) => l !== "en";

/** 句长上限（与 electron/ste-profiles/*.json 的 maxChars / maxWords 一致，d91 测试锁定）。中日按字（不计标点与空白），英文按词 */
export const STE_LIMITS: Record<SteOutLang, { line: number; term: number; note: number; unit: "chars" | "words" }> = {
  "zh-Hans": { line: 30, term: 20, note: 30, unit: "chars" },
  "zh-Hant": { line: 30, term: 20, note: 30, unit: "chars" },
  ja: { line: 30, term: 20, note: 30, unit: "chars" },
  en: { line: 18, term: 12, note: 18, unit: "words" }
};

export function steLimitText(lang: SteOutLang): string {
  const L = STE_LIMITS[lang];
  return L.unit === "words" ? `每句 ≤ ${L.line} 个英文单词` : `每句 ≤ ${L.line} 字（不计标点与空格）`;
}

export function measure(s: string, lang: SteOutLang): number {
  const t = String(s ?? "");
  if (STE_LIMITS[lang].unit === "words") return (t.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;
  return t.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

// ---------- 程序切句 ----------

const ABBR = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|al|Dr|Mr|Mrs|Ms|Prof|Fig|Figs|No|Vol|pp|St|Jr|Sr|[A-Z])$/;

/** 按句末标点切句（中日：。！？；英文：.!? 后接空白且非缩写）。分号不切。纯标点碎片并入前句 */
export function splitSentences(text: string): string[] {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!src) return [];
  const out: string[] = [];
  let buf = "";
  const push = () => {
    const s = buf.trim();
    buf = "";
    if (!s) return;
    if (out.length && !/[\p{L}\p{N}]/u.test(s)) out[out.length - 1] += s;
    else out.push(s);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\n") {
      if (src[i + 1] === "\n" || /[。！？.!?」』”"）)]$/.test(buf.trim())) push();
      else buf += " ";
      continue;
    }
    buf += c;
    if (/[。！？]/.test(c)) {
      while (i + 1 < src.length && /[」』”"）)！？]/.test(src[i + 1])) buf += src[++i];
      push();
    } else if (/[.!?]/.test(c)) {
      while (i + 1 < src.length && /[”"’')\]]/.test(src[i + 1])) buf += src[++i];
      const next = src[i + 1];
      if (next === undefined) push();
      else if (/\s/.test(next)) {
        const head = buf.slice(0, -1);
        if (c === "." && ABBR.test(head)) continue;
        const after = src.slice(i + 1).trimStart()[0] || "";
        if (c === "." && /[a-z]/.test(after)) continue;
        push();
      }
    }
  }
  push();
  return out;
}

// ---------- JSON 解析（含残缺 JSON） ----------

function closers(s: string): { close: string; inString: boolean; cuts: number[] } {
  const stack: string[] = [];
  const cuts: number[] = [];
  let inString = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); cuts.push(i + 1); }
    else if (c === "}" || c === "]") { stack.pop(); cuts.push(i + 1); }
    else if (c === ",") cuts.push(i);
  }
  return { close: stack.reverse().join(""), inString, cuts };
}

/** 流式中途的残缺 JSON → 尽量补全后解析；失败返回 null */
export function parsePartialJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let s = text.slice(start);
  const first = closers(s);
  const tries: string[] = [];
  if (first.inString) {
    const t = s + '"';
    tries.push(t + closers(t).close);
  }
  tries.push(s + first.close);
  for (const cut of first.cuts.slice().reverse().slice(0, 40)) {
    const t = s.slice(0, cut);
    tries.push(t + closers(t).close);
  }
  for (const t of tries) {
    try {
      return JSON.parse(t);
    } catch {
      /* 下一个截断点 */
    }
  }
  return null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);

/** 宽松归一：模型偶尔把一组写成字符串、把 explanations 写成对象数组 */
export function normalizeSteDoc(raw: unknown): SteDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const groups = Array.isArray(o.explanations) ? o.explanations : [];
  const doc: SteDoc = {
    matLang: str(o.matLang) || "unknown",
    ambiguities: (Array.isArray(o.ambiguities) ? o.ambiguities : [])
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a) => ({ key: str(a.key), label: str(a.label), quote: str(a.quote), note: str(a.note) })),
    explanations: groups.map((g) => (g && typeof g === "object" && !Array.isArray(g) ? strArr((g as Record<string, unknown>).lines) : strArr(g))),
    readings: strArr(o.readings),
    terms: (Array.isArray(o.terms) ? o.terms : [])
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({ term: str(t.term), def: str(t.def) }))
      .filter((t) => t.term),
    components: (Array.isArray(o.components) ? o.components : [])
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        after: Number(c.after),
        block: c.block && typeof c.block === "object" && !Array.isArray(c.block) ? (c.block as Record<string, unknown>) : undefined,
        mermaid: typeof c.mermaid === "string" ? c.mermaid : undefined
      }))
  };
  if (o.answer !== undefined) doc.answer = strArr(o.answer);
  return doc;
}

/** 完整输出 → SteDoc。剥 ```json 围栏，取首个 { 到末个 }；解析失败再按残缺 JSON 补全 */
export function parseSteJson(raw: string): { doc: SteDoc | null; strict: boolean } {
  const s = String(raw ?? "").replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return { doc: normalizeSteDoc(JSON.parse(s.slice(a, b + 1))), strict: true };
    } catch {
      /* 落到补全 */
    }
  }
  return { doc: normalizeSteDoc(parsePartialJson(s)), strict: false };
}

// ---------- 渲染 ----------

const HEADINGS: Record<SteOutLang, [string, string, string, string]> = {
  "zh-Hans": ["歧义点", "解释", "多重解读", "术语"],
  "zh-Hant": ["歧義點", "解釋", "多重解讀", "術語"],
  en: ["Ambiguity points", "Explanation", "Multiple readings", "Terms"],
  ja: ["曖昧な点", "説明", "複数の読み方", "用語"]
};

function endPunct(line: string, lang: SteOutLang): string {
  const t = line.trim();
  if (!t || /[。！？.!?」』”"）)]$/.test(t)) return t;
  return t + (lang === "en" ? "." : "。");
}

function componentFence(c: SteComponent): string | null {
  if (c.mermaid && c.mermaid.trim()) return "```mermaid\n" + c.mermaid.trim() + "\n```";
  if (!c.block) return null;
  const type = String(c.block.type ?? "") as PresentationKind;
  if (STE_BLOCKED_KINDS.has(type)) return null;
  return "```nui\n" + JSON.stringify(c.block) + "\n```";
}

/** SteDoc → Markdown（机器标记 + 本地化节标题 + 逐段解释，组件插在所说明的那句之后）。不出现「第 N 句」编号 */
export function renderSteMarkdown(doc: SteDoc, outLang: string, opts: { partial?: boolean } = {}): string {
  const lang = steOutLangOf(outLang);
  const H = HEADINGS[lang];
  const q = (s: string) => (lang === "en" ? `“${s}”` : `「${s}」`);
  const colon = lang === "en" ? ": " : "：";
  if (doc.answer) return doc.answer.map((l) => endPunct(l, lang)).join(lang === "en" ? " " : "");
  const amb = doc.ambiguities.slice(0, STE_CAPS.ambiguities).filter((a) => a.note || a.quote);
  const readings = doc.readings.slice(0, STE_CAPS.readings);
  const out: string[] = [`<!--ste:matLang=${doc.matLang || "unknown"}-->`, `<!--ste:points=${amb.length}-->`];
  if (readings.length) out.push(`<!--ste:readings=${readings.length}-->`);
  out.push("");
  if (amb.length) {
    out.push(`## ${H[0]}`);
    for (const a of amb) out.push(`- ${a.label ? `**${a.label}** ` : ""}${a.quote ? q(a.quote) : ""}${colon}${a.note}`);
    out.push("");
  }
  out.push(`## ${H[1]}`);
  const groups = doc.explanations;
  const comps = opts.partial ? [] : doc.components.slice(0, STE_CAPS.components);
  const n = groups.length;
  groups.forEach((g, i) => {
    const para = g.map((l) => endPunct(l, lang)).filter(Boolean).join(lang === "en" ? " " : "");
    if (para) out.push(para, "");
    for (const c of comps) {
      const at = Number.isInteger(c.after) && c.after >= 1 && c.after <= n ? c.after : n;
      if (at === i + 1) {
        const f = componentFence(c);
        if (f) out.push(f, "");
      }
    }
  });
  if (readings.length) {
    out.push(`## ${H[2]}`, ...readings.map((r) => `- ${endPunct(r, lang)}`), "");
  }
  const terms = doc.terms.slice(0, STE_CAPS.terms);
  if (terms.length) {
    out.push(`## ${H[3]}`, ...terms.map((t) => `- **${t.term}**${colon}${endPunct(t.def, lang)}`), "");
  }
  return out.join("\n").trim();
}

/** 流式中途：残缺 JSON 能解析就渲染已到的部分；还没有可显示内容时返回空串 */
export function renderStePartial(acc: string, outLang: string): string {
  const doc = normalizeSteDoc(parsePartialJson(String(acc ?? "").replace(/```(?:json)?/gi, "")));
  if (!doc) return "";
  return renderSteMarkdown(doc, outLang, { partial: true });
}

// ---------- 校验 ----------

const HEDGE_ANY = /可能|或许|或許|也许|也許|提示|认为|認為|尚不清楚|仍不清楚|仍需|有待|似乎|推测|推測|据称|據稱|未必|不确定|不確定|\bmay\b|\bmight\b|\bcould\b|suggest|possibl|perhaps|likely|unclear|not yet|thought to|believed|\bseems?\b|uncertain|かもしれ|可能性|示唆|考えられ|不明|と思われ|らしい|ようだ|おそらく/i;
const HEDGE_OUT: Record<SteOutLang, RegExp> = {
  "zh-Hans": /可能|或许|也许|提示|认为|不清楚|仍需|有待|似乎|推测|据称|未必|不确定|尚未|还没有/,
  "zh-Hant": /可能|或許|也許|提示|認為|不清楚|仍需|有待|似乎|推測|據稱|未必|不確定|尚未|還沒有/,
  en: /\bmay\b|\bmight\b|\bcould\b|suggest|possibl|perhaps|likely|unclear|not yet|not known|think|believe|\bappears?\b|\bseems?\b|uncertain|do not know/i,
  ja: /かもしれ|可能性|示唆|考え|不明|分かって|わかって|と思われ|らしい|ようだ|おそらく|まだ/
};
const META_OPENER = /^(本句|这句话|這句話|这句|這句|该句|該句|原句|原文这句|この文|この一文|本文は|The sentence|This sentence|The original sentence|In this sentence)/i;
const NUMBER_LABEL = /第\s*\d+\s*[句文]|Sentence\s+\d+\s*[:：]/i;
const VAGUE: Record<SteOutLang, RegExp> = {
  "zh-Hans": /若干|适当|一定程度|某种程度/,
  "zh-Hant": /若干|適當|一定程度|某種程度/,
  en: /\bseveral\b|\bvarious\b|\ba number of\b|\bappropriate\b|to some extent/i,
  ja: /若干|適当|ある程度/
};
const VAGUE_SRC = /若干|适当|適當|一定程度|某种程度|某種程度|\bseveral\b|\bvarious\b|\ba number of\b|\bappropriate\b|to some extent|ある程度|適当/i;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HAN = /\p{Script=Han}/gu;
const TRAD_ONLY = /[這們說為與個來對時國學會從還關點應發現當經過説]/;
const SIMP_ONLY = /[这们说为与个来对时国学会从还关点应发现当经过]/;

const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);

function lineChecks(path: string, line: string, lang: SteOutLang, max: number, out: SteViolation[]): void {
  const len = measure(line, lang);
  const unit = STE_LIMITS[lang].unit === "words" ? "词" : "字";
  if (len > max) out.push({ path, rule: "length", severity: "error", msg: `句长 ${len} ${unit}，超过 ${max} ${unit}上限：「${clip(line)}」——拆成两句以上短句，每句只讲一个意思` });
  if (META_OPENER.test(line)) out.push({ path, rule: "meta", severity: "error", msg: `以元话语开头：「${clip(line)}」——直接说内容（谁做什么），不要描述「这句话」` });
  if (NUMBER_LABEL.test(line)) out.push({ path, rule: "numbering", severity: "error", msg: `出现句序编号：「${clip(line)}」——删掉编号，只写解释内容` });
  const kana = (line.match(KANA) || []).length;
  const han = (line.match(HAN) || []).length;
  const latin = (line.match(/[A-Za-z]/g) || []).length;
  const letters = kana + han + latin;
  if (lang === "en" && letters > 0 && (kana + han) / letters > 0.3) out.push({ path, rule: "language", severity: "error", msg: `不是英文：「${clip(line)}」——全部用英文书写` });
  if ((lang === "zh-Hans" || lang === "zh-Hant") && kana > 0) out.push({ path, rule: "language", severity: "error", msg: `混入日文假名：「${clip(line)}」——译成中文标准说法` });
  if ((lang === "zh-Hans" || lang === "zh-Hant") && letters > 0 && latin / letters > 0.5) out.push({ path, rule: "language", severity: "error", msg: `主要是外文：「${clip(line)}」——用中文书写，外文术语只保留原词并解释` });
  if (lang === "zh-Hans" && TRAD_ONLY.test(line)) out.push({ path, rule: "script", severity: "error", msg: `出现繁体字：「${clip(line)}」——全部用简体中文` });
  if (lang === "zh-Hant" && SIMP_ONLY.test(line)) out.push({ path, rule: "script", severity: "error", msg: `出现简体字：「${clip(line)}」——全部用繁體中文` });
  if (lang === "ja" && latin / Math.max(1, letters) > 0.5) out.push({ path, rule: "language", severity: "error", msg: `主要是外文：「${clip(line)}」——用日文书写` });
  if (VAGUE[lang].test(line)) out.push({ path, rule: "vague", severity: "warn", msg: `含糊量词：「${clip(line)}」——写明确的数量，原文没有数量就删掉含糊词` });
  if (lang === "en" && /\b(is|are|was|were|be|been|being)\s+(\w+ed|known|shown|seen|given|made|done|taken|thought|found|built|written|held|driven|caused)\b/i.test(line))
    out.push({ path, rule: "passive", severity: "warn", msg: `被动语态：「${clip(line)}」——改成主动语态（写明谁做什么；不知道是谁就写 The text does not say who）` });
  if ((lang === "zh-Hans" || lang === "zh-Hant") && /被/.test(line) && !/未说明|未說明/.test(line))
    out.push({ path, rule: "passive", severity: "warn", msg: `被动句：「${clip(line)}」——改成「谁做什么」；施动者不明时在同一句写「来源未说明」` });
}

export interface SteLintContext {
  outLang: string;
  /** 程序切出的原句（与 explanations 一一对应）；追问直答时可为空 */
  sentences: string[];
  source: string;
  followUp?: boolean;
}

/** 规范校验：error＝必须修复；warn＝修复回合顺带处理（≥2 条也触发修复） */
export function steLint(doc: SteDoc | null, ctx: SteLintContext): SteViolation[] {
  const lang = steOutLangOf(ctx.outLang);
  const L = STE_LIMITS[lang];
  const out: SteViolation[] = [];
  if (!doc) return [{ path: "$", rule: "json", severity: "error", msg: "输出不是可解析的 JSON 对象——只输出一个 JSON 对象，不要输出其他文字" }];
  if (ctx.followUp) {
    const ans = doc.answer ?? [];
    if (!ans.length) out.push({ path: "answer", rule: "shape", severity: "error", msg: "追问直答必须输出 {\"answer\": [短句, …]}" });
    if (ans.length > STE_CAPS.answer) out.push({ path: "answer", rule: "cap", severity: "error", msg: `回答 ${ans.length} 句，超过 ${STE_CAPS.answer} 句上限——合并或删去次要信息` });
    ans.forEach((l, i) => lineChecks(`answer[${i + 1}]`, l, lang, L.line, out));
    return out;
  }
  const n = ctx.sentences.length;
  if (doc.explanations.length !== n)
    out.push({ path: "explanations", rule: "count", severity: "error", msg: `explanations 有 ${doc.explanations.length} 组，原句有 ${n} 句——必须每个原句一组、顺序一致，不合并、不遗漏` });
  const seen = new Set<string>();
  doc.explanations.forEach((g, i) => {
    if (!g.length) out.push({ path: `explanations[${i + 1}]`, rule: "empty", severity: "error", msg: `原句 [${i + 1}] 没有解释——至少写一句` });
    g.forEach((l, j) => {
      const path = `explanations[${i + 1}][${j + 1}]`;
      lineChecks(path, l, lang, L.line, out);
      const key = l.replace(/[\s\p{P}]/gu, "").toLowerCase();
      if (key.length >= 6 && seen.has(key)) out.push({ path, rule: "repeat", severity: "warn", msg: `与前面的句子重复：「${clip(l)}」——删掉重复句` });
      seen.add(key);
    });
  });
  // 情态保留：原文有不确定性，解释里必须有对应的情态词
  const allText = doc.explanations.flat().join(" ");
  if (HEDGE_ANY.test(ctx.source) && allText && !HEDGE_OUT[lang].test(allText))
    out.push({ path: "explanations", rule: "modality", severity: "error", msg: "原文含「可能 / 认为 / 尚不清楚」类不确定语气，解释里却全是确定语气——在对应短句里保留原文的情态" });
  if (VAGUE_SRC.test(ctx.source)) {
    for (let k = out.length - 1; k >= 0; k--) if (out[k].rule === "vague") out.splice(k, 1); // 原文本身含糊：照实保留不算违规
  }
  if (lang === "ja" && allText.replace(/\s/g, "").length > 20) {
    const kana = (allText.match(KANA) || []).length;
    const han = (allText.match(HAN) || []).length;
    if (kana / Math.max(1, kana + han) < 0.15) out.push({ path: "explanations", rule: "language", severity: "error", msg: "解释读起来像中文而不是日文——用自然的日文（含假名）书写" });
  }
  if (doc.ambiguities.length > STE_CAPS.ambiguities) out.push({ path: "ambiguities", rule: "cap", severity: "error", msg: `歧义点 ${doc.ambiguities.length} 条，至多 ${STE_CAPS.ambiguities} 条——只留最影响理解的语言表达障碍` });
  doc.ambiguities.forEach((a, i) => {
    const path = `ambiguities[${i + 1}]`;
    if (!STE_AMBIGUITY_KEYS.includes(a.key)) out.push({ path, rule: "key", severity: "error", msg: `类别 key「${a.key}」不在封闭集内——只能从 ${STE_AMBIGUITY_KEYS.join(" / ")} 中选` });
    lineChecks(path, a.note, lang, L.note, out);
  });
  if (doc.readings.length > STE_CAPS.readings) out.push({ path: "readings", rule: "cap", severity: "error", msg: `多重解读 ${doc.readings.length} 条，至多 ${STE_CAPS.readings} 条` });
  doc.readings.forEach((r, i) => lineChecks(`readings[${i + 1}]`, r, lang, L.line * 2, out));
  if (doc.terms.length > STE_CAPS.terms) out.push({ path: "terms", rule: "cap", severity: "error", msg: `术语 ${doc.terms.length} 条，至多 ${STE_CAPS.terms} 条——只留读者无法从上下文理解的专业术语` });
  doc.terms.forEach((t, i) => lineChecks(`terms[${i + 1}].def`, t.def, lang, L.term, out));
  if (doc.components.length > STE_CAPS.components) out.push({ path: "components", rule: "cap", severity: "error", msg: `组件 ${doc.components.length} 个，至多 ${STE_CAPS.components} 个` });
  doc.components.forEach((c, i) => {
    const path = `components[${i + 1}]`;
    if (!Number.isInteger(c.after) || c.after < 1 || c.after > n) out.push({ path, rule: "after", severity: "error", msg: `after=${c.after} 不是有效的原句编号（1–${n}）` });
    if (c.mermaid) return;
    if (!c.block) {
      out.push({ path, rule: "component", severity: "error", msg: "组件缺少 block（或 mermaid）" });
      return;
    }
    const type = String(c.block.type ?? "") as PresentationKind;
    if (STE_BLOCKED_KINDS.has(type)) out.push({ path, rule: "component", severity: "error", msg: `简明解读不能用「${type}」组件（类比 / 举例会引入比喻或原文没有的信息）——删除它` });
    else {
      const r = parseUIBlock(JSON.stringify(c.block));
      if (!r.ok) out.push({ path, rule: "component", severity: "error", msg: `组件格式错误（${r.error}）——照示范字段改正，或删除该组件` });
      else if (/〈|〉/.test(JSON.stringify(c.block))) out.push({ path, rule: "component", severity: "error", msg: "组件里还留着〈占位〉——换成材料里的真实内容，或删除该组件" });
    }
  });
  return out;
}

/** 是否需要修复：有 error，或 warn ≥ 2 */
export function steNeedsRepair(v: SteViolation[]): boolean {
  return v.some((x) => x.severity === "error") || v.filter((x) => x.severity === "warn").length >= 2;
}

/** 质量分（越小越好）：选取多轮中最好的一份 */
export function steScore(v: SteViolation[]): number {
  return v.reduce((s, x) => s + (x.severity === "error" ? 10 : 1), 0);
}

/** 修复回合的用户消息：只列违规项，要求保留其余内容、输出完整 JSON */
export function steRepairPrompt(v: SteViolation[], followUp = false): string {
  const lines = v.slice(0, 30).map((x) => `- ${x.path}：${x.msg}`);
  return [
    "【规范校验未通过】你上一条输出有下列问题（路径中的编号从 1 开始）：",
    ...lines,
    "",
    "请只修改有问题的部分，其余内容逐字保留；仍然遵守系统提示里的全部规则。",
    followUp ? "重新输出完整的 JSON 对象 {\"answer\": [...]}，不要输出任何其他文字。" : "重新输出完整的 JSON 对象（全部字段），不要输出任何其他文字。"
  ].join("\n");
}

// ---------- 弱模型提示（D301：不单独指定模型，只提示） ----------

/** 模型名里的参数量（取最大值，兼容 MoE 写法如 30B-A3B）≤ 14B 视为弱模型；读不出参数量不提示 */
export function steWeakModel(model: string): boolean {
  const sizes = [...String(model ?? "").matchAll(/(?:^|[^\d.])(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)].map((m) => Number(m[1]));
  return sizes.length > 0 && Math.max(...sizes) <= 14;
}
