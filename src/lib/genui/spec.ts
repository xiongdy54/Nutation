// D299（生成式 UI · 组件契约）：AI 在 Markdown 回答里输出 ```nui 围栏（内容＝一个 JSON 对象），
// 展示侧 ReadMarkdown 把它渲染为白名单组件；解析/校验失败 → 原样显示源码（流式生成中途同理）。
// 设计取舍：围栏协议复用既有 Markdown 流式管线（mermaid 同款），零新 IPC、零新传输；
// 组件 props 刻意扁平、字段少——弱模型也能稳定产出。
// 纯函数模块：禁 window/IPC/React 依赖（node 单测直跑）。

export const NUI_FENCE_LANG = "nui";

export interface FormulaBlock {
  type: "formula";
  title?: string;
  latex: string;
  /** 变量释义（悬停/列表展示）；最多 12 项 */
  vars?: { symbol: string; meaning: string }[];
}
export interface CompareBlock {
  type: "compare";
  title?: string;
  /** 被比较对象，2–6 个 */
  entities: string[];
  /** 每行一个比较维度；values 与 entities 等长 */
  rows: { dimension: string; values: string[] }[];
}
export interface ChartBlock {
  type: "chart";
  kind: "bar" | "line";
  title?: string;
  unit?: string;
  /** 横轴标签，1–24 个 */
  labels: string[];
  /** 1–4 个系列；values 与 labels 等长 */
  series: { name: string; values: number[] }[];
  /** 数据来源说明（必须来自材料或明确标注「示意」） */
  note?: string;
}
export interface StepsBlock {
  type: "steps";
  title?: string;
  steps: { title: string; detail?: string }[];
}
export interface TimelineBlock {
  type: "timeline";
  title?: string;
  events: { time: string; title: string; detail?: string }[];
}
export interface HtmlBlock {
  type: "html";
  title?: string;
  /** 完整 HTML 片段；在无同源、无网络的沙箱 iframe 内渲染 */
  html: string;
  height?: number;
}

export interface TreeNode {
  label: string;
  note?: string;
  children?: TreeNode[];
}
export interface TreeBlock {
  type: "tree";
  title?: string;
  /** 层级结构：根 + 至多 2 层子级（共 3 层），每层 ≤8 个 */
  root: TreeNode;
}
export interface QuizBlock {
  type: "quiz";
  title?: string;
  question: string;
  /** 2–5 个选项 */
  options: string[];
  /** 正确选项下标（0 起） */
  answer: number;
  explain?: string;
}

export interface PronounceItem {
  text: string;
  /** BCP-47 语言码（sv / de / fr / ja …）；缺省由朗读侧按文字猜 */
  lang?: string;
  /** 国际音标（不含两侧斜线） */
  ipa?: string;
  meaning?: string;
}
export interface PronounceBlock {
  type: "pronounce";
  title?: string;
  items: PronounceItem[];
}
export interface GlossaryBlock {
  type: "glossary";
  title?: string;
  terms: { term: string; def: string; alias?: string }[];
}
export interface AnalogyBlock {
  type: "analogy";
  title?: string;
  /** 熟悉的事物 */
  source: string;
  /** 要理解的概念 */
  target: string;
  pairs: { from: string; to: string }[];
  /** 类比不成立之处 */
  limit?: string;
}
export interface ScaleBlock {
  type: "scale";
  title?: string;
  unit?: string;
  /** 同一单位下的正数，按数量级排在对数标尺上；2–8 项 */
  items: { label: string; value: number; note?: string }[];
}
export interface ExamplesBlock {
  type: "examples";
  title?: string;
  items: { kind: "example" | "counter"; text: string; why?: string }[];
}
export interface BreakdownBlock {
  type: "breakdown";
  title?: string;
  sentence: string;
  /** 句子成分：role 如 主干 / 条件 / 原因 / 修饰 */
  parts: { text: string; role: string; note?: string }[];
}

export type UIBlock =
  | FormulaBlock
  | CompareBlock
  | ChartBlock
  | StepsBlock
  | TimelineBlock
  | TreeBlock
  | QuizBlock
  | PronounceBlock
  | GlossaryBlock
  | AnalogyBlock
  | ScaleBlock
  | ExamplesBlock
  | BreakdownBlock
  | HtmlBlock;
export type UIKind = UIBlock["type"];
export const UI_KINDS: readonly UIKind[] = ["formula", "compare", "chart", "steps", "timeline", "tree", "quiz", "pronounce", "glossary", "analogy", "scale", "examples", "breakdown", "html"];

export type ParseResult = { ok: true; block: UIBlock } | { ok: false; error: string };

const str = (v: unknown, max = 2000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const optStr = (v: unknown, max = 200): string | undefined => str(v, max) ?? undefined;
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[,，%\s]/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};

export const QUIZ_LETTERS = "ABCDE";

function list<T>(v: unknown, f: (x: Record<string, unknown>, raw: unknown) => T | null, max: number): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const e of v) {
    const r = f(e && typeof e === "object" ? (e as Record<string, unknown>) : {}, e);
    if (r !== null) out.push(r);
  }
  return out.slice(0, max);
}

const SUP: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
/** 数值的紧凑写法：常规范围直接写，极大 / 极小用科学计数法（1×10⁻⁸ → 10⁻⁸） */
export function fmtSci(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 0.001 && a < 100000) return String(Number(v.toPrecision(4)));
  const e = Math.floor(Math.log10(a));
  const m = Number((v / Math.pow(10, e)).toPrecision(3));
  const sup = [...String(e)].map((c) => SUP[c] ?? c).join("");
  return `${m === 1 ? "" : `${m}×`}10${sup}`;
}

const TREE_DEPTH = 3;
const TREE_FANOUT = 8;
function parseTreeNode(v: unknown, depth: number): TreeNode | null {
  if (typeof v === "string") return str(v, 120) ? { label: v.trim().slice(0, 120) } : null;
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const label = str(x.label ?? x.name ?? x.title, 120);
  if (!label) return null;
  const kids =
    depth < TREE_DEPTH - 1 && Array.isArray(x.children)
      ? x.children.map((c) => parseTreeNode(c, depth + 1)).filter((c): c is TreeNode => !!c).slice(0, TREE_FANOUT)
      : [];
  return { label, note: optStr(x.note, 200), children: kids.length ? kids : undefined };
}

/** 解析 + 校验 + 轻度纠偏（字符串数字转数字、截断超长）。失败给出可读原因 */
export function parseUIBlock(source: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(String(source ?? "").trim());
  } catch {
    return { ok: false, error: "JSON 不完整或格式错误" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "需要一个 JSON 对象" };
  const o = raw as Record<string, unknown>;
  const title = optStr(o.title);
  switch (o.type) {
    case "formula": {
      const latex = str(o.latex, 4000);
      if (!latex) return { ok: false, error: "formula 缺少 latex" };
      const vars = Array.isArray(o.vars)
        ? o.vars
            .map((v) => {
              const x = v as Record<string, unknown>;
              const symbol = str(x?.symbol, 60);
              const meaning = str(x?.meaning, 200);
              return symbol && meaning ? { symbol, meaning } : null;
            })
            .filter((v): v is { symbol: string; meaning: string } => !!v)
            .slice(0, 12)
        : undefined;
      return { ok: true, block: { type: "formula", title, latex: latex.replace(/^\$+|\$+$/g, "").trim(), vars: vars?.length ? vars : undefined } };
    }
    case "compare": {
      const entities = Array.isArray(o.entities) ? o.entities.map((e) => str(e, 80)).filter((e): e is string => !!e) : [];
      if (entities.length < 2 || entities.length > 6) return { ok: false, error: "compare.entities 须 2–6 项" };
      const rows = Array.isArray(o.rows)
        ? o.rows
            .map((r) => {
              const x = r as Record<string, unknown>;
              const dimension = str(x?.dimension, 80);
              const values = Array.isArray(x?.values) ? x.values.map((v) => (typeof v === "number" ? String(v) : str(v, 400) ?? "—")) : [];
              if (!dimension || values.length === 0) return null;
              const fixed = entities.map((_, i) => values[i] ?? "—");
              return { dimension, values: fixed };
            })
            .filter((r): r is { dimension: string; values: string[] } => !!r)
            .slice(0, 20)
        : [];
      if (rows.length === 0) return { ok: false, error: "compare.rows 为空" };
      return { ok: true, block: { type: "compare", title, entities, rows } };
    }
    case "chart": {
      const kind = o.kind === "line" ? "line" : "bar";
      const labels = Array.isArray(o.labels) ? o.labels.map((l) => (typeof l === "number" ? String(l) : str(l, 40))).filter((l): l is string => !!l) : [];
      if (labels.length < 1 || labels.length > 24) return { ok: false, error: "chart.labels 须 1–24 项" };
      const series = Array.isArray(o.series)
        ? o.series
            .map((s) => {
              const x = s as Record<string, unknown>;
              const name = str(x?.name, 60) ?? "";
              const values = Array.isArray(x?.values) ? x.values.map(num) : [];
              if (values.length !== labels.length || values.some((v) => v === null)) return null;
              return { name, values: values as number[] };
            })
            .filter((s): s is { name: string; values: number[] } => !!s)
            .slice(0, 4)
        : [];
      if (series.length === 0) return { ok: false, error: "chart.series 无有效系列（values 须为数字且与 labels 等长）" };
      return { ok: true, block: { type: "chart", kind, title, unit: optStr(o.unit, 20), labels, series, note: optStr(o.note, 200) } };
    }
    case "steps": {
      const steps = Array.isArray(o.steps)
        ? o.steps
            .map((s) => {
              if (typeof s === "string") return str(s, 200) ? { title: s.trim().slice(0, 200) } : null;
              const x = s as Record<string, unknown>;
              const t = str(x?.title, 200);
              return t ? { title: t, detail: optStr(x?.detail, 600) } : null;
            })
            .filter((s): s is { title: string; detail?: string } => !!s)
            .slice(0, 16)
        : [];
      if (steps.length < 2) return { ok: false, error: "steps 至少 2 步" };
      return { ok: true, block: { type: "steps", title, steps } };
    }
    case "timeline": {
      const events = Array.isArray(o.events)
        ? o.events
            .map((e): { time: string; title: string; detail?: string } | null => {
              const x = e as Record<string, unknown>;
              const time = typeof x?.time === "number" ? String(x.time) : str(x?.time, 40);
              const t = str(x?.title, 200);
              return time && t ? { time, title: t, detail: optStr(x?.detail, 600) } : null;
            })
            .filter((e): e is { time: string; title: string; detail?: string } => !!e)
            .slice(0, 24)
        : [];
      if (events.length < 2) return { ok: false, error: "timeline 至少 2 个事件" };
      return { ok: true, block: { type: "timeline", title, events } };
    }
    case "tree": {
      const root = parseTreeNode(o.root, 0);
      if (!root || !root.children?.length) return { ok: false, error: "tree.root 须有子节点" };
      return { ok: true, block: { type: "tree", title, root } };
    }
    case "quiz": {
      const question = str(o.question, 400);
      const options = Array.isArray(o.options)
        ? o.options.map((x) => (typeof x === "number" ? String(x) : str(x, 200))).filter((x): x is string => !!x).slice(0, 5)
        : [];
      const answer = num(o.answer);
      if (!question) return { ok: false, error: "quiz 缺少 question" };
      if (options.length < 2) return { ok: false, error: "quiz.options 须 2–5 项" };
      if (answer === null || !Number.isInteger(answer) || answer < 0 || answer >= options.length)
        return { ok: false, error: "quiz.answer 须为有效选项下标" };
      return { ok: true, block: { type: "quiz", title, question, options, answer, explain: optStr(o.explain, 600) } };
    }
    case "pronounce": {
      const items = list<PronounceItem>(
        o.items,
        (x, raw) => {
          const text = typeof raw === "string" ? str(raw, 80) : str(x.text ?? x.word ?? x.term, 80);
          if (!text) return null;
          const lang = (str(x.lang, 12) ?? "").replace(/[^A-Za-z-]/g, "");
          const ipa = (str(x.ipa, 80) ?? "").replace(/^[/[]+|[/\]]+$/g, "").trim();
          // D300：不再收「近似读音 / 谐音」（reading）——用汉字拟音不专业，读音以音标 + 朗读为准；旧数据里的该字段静默忽略
          return { text, lang: lang || undefined, ipa: ipa || undefined, meaning: optStr(x.meaning, 120) };
        },
        8
      );
      if (!items.length) return { ok: false, error: "pronounce.items 为空" };
      return { ok: true, block: { type: "pronounce", title, items } };
    }
    case "glossary": {
      const terms = list(
        o.terms ?? o.items,
        (x) => {
          const term = str(x.term ?? x.name, 80);
          const def = str(x.def ?? x.definition ?? x.meaning, 300);
          return term && def ? { term, def, alias: optStr(x.alias, 80) } : null;
        },
        8
      );
      if (!terms.length) return { ok: false, error: "glossary.terms 为空" };
      return { ok: true, block: { type: "glossary", title, terms } };
    }
    case "analogy": {
      const source = str(o.source, 60);
      const target = str(o.target, 60);
      const pairs = list(
        o.pairs,
        (x) => {
          const from = str(x.from, 120);
          const to = str(x.to, 120);
          return from && to ? { from, to } : null;
        },
        6
      );
      if (!source || !target) return { ok: false, error: "analogy 缺少 source / target" };
      if (!pairs.length) return { ok: false, error: "analogy.pairs 为空" };
      return { ok: true, block: { type: "analogy", title, source, target, pairs, limit: optStr(o.limit, 300) } };
    }
    case "scale": {
      const items = list(
        o.items,
        (x) => {
          const label = str(x.label, 60);
          const value = num(x.value);
          return label && value !== null && value > 0 ? { label, value, note: optStr(x.note, 120) } : null;
        },
        8
      ).sort((a, b) => a.value - b.value);
      if (items.length < 2) return { ok: false, error: "scale.items 须 ≥2 项且 value 为正数" };
      return { ok: true, block: { type: "scale", title, unit: optStr(o.unit, 20), items } };
    }
    case "examples": {
      const items = list<ExamplesBlock["items"][number]>(
        o.items,
        (x, raw) => {
          const text = typeof raw === "string" ? str(raw, 400) : str(x.text, 400);
          if (!text) return null;
          return { kind: /counter|反/i.test(String(x.kind ?? "")) ? "counter" : "example", text, why: optStr(x.why, 200) };
        },
        6
      );
      if (!items.length) return { ok: false, error: "examples.items 为空" };
      return { ok: true, block: { type: "examples", title, items } };
    }
    case "breakdown": {
      const sentence = str(o.sentence, 600);
      const parts = list(
        o.parts,
        (x) => {
          const text = str(x.text, 300);
          const role = str(x.role, 16);
          return text && role ? { text, role, note: optStr(x.note, 200) } : null;
        },
        10
      );
      if (!sentence) return { ok: false, error: "breakdown 缺少 sentence" };
      if (parts.length < 2) return { ok: false, error: "breakdown.parts 须 ≥2 项" };
      return { ok: true, block: { type: "breakdown", title, sentence, parts } };
    }
    case "html": {
      const html = str(o.html, 30000);
      if (!html) return { ok: false, error: "html 为空" };
      const h = num(o.height);
      return { ok: true, block: { type: "html", title, html, height: h ? Math.min(900, Math.max(120, h)) : undefined } };
    }
    default:
      return { ok: false, error: `未知组件类型：${String(o.type)}` };
  }
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");

/** 组件 → Markdown（复制纯文本 / 插入制卡面板 / 就此制卡的材料）。Milkdown 与 Anki 均可直接接收 */
export function blockToMarkdown(b: UIBlock): string {
  const head = b.title ? `**${b.title}**\n\n` : "";
  switch (b.type) {
    case "formula": {
      const vars = b.vars?.length ? "\n\n" + b.vars.map((v) => `- $${v.symbol}$：${v.meaning}`).join("\n") : "";
      return `${head}$$\n${b.latex}\n$$${vars}`;
    }
    case "compare": {
      const h = `| 维度 | ${b.entities.map(cell).join(" | ")} |`;
      const sep = `| --- | ${b.entities.map(() => "---").join(" | ")} |`;
      const rows = b.rows.map((r) => `| ${cell(r.dimension)} | ${r.values.map(cell).join(" | ")} |`);
      return `${head}${[h, sep, ...rows].join("\n")}`;
    }
    case "chart": {
      const unit = b.unit ? `（${b.unit}）` : "";
      const h = `| 项目 | ${b.series.map((s) => cell(s.name || "数值") + unit).join(" | ")} |`;
      const sep = `| --- | ${b.series.map(() => "---").join(" | ")} |`;
      const rows = b.labels.map((l, i) => `| ${cell(l)} | ${b.series.map((s) => String(s.values[i])).join(" | ")} |`);
      const note = b.note ? `\n\n${b.note}` : "";
      return `${head}${[h, sep, ...rows].join("\n")}${note}`;
    }
    case "steps":
      return `${head}${b.steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? `：${s.detail}` : ""}`).join("\n")}`;
    case "timeline":
      return `${head}${b.events.map((e) => `- **${e.time}** ${e.title}${e.detail ? `：${e.detail}` : ""}`).join("\n")}`;
    case "tree": {
      const walk = (n: TreeNode, d: number): string[] => [
        `${"  ".repeat(d)}- ${d === 0 ? `**${n.label}**` : n.label}${n.note ? `：${n.note}` : ""}`,
        ...(n.children ?? []).flatMap((c) => walk(c, d + 1))
      ];
      return `${head}${walk(b.root, 0).join("\n")}`;
    }
    case "quiz": {
      const opts = b.options.map((o, i) => `- ${QUIZ_LETTERS[i]}. ${o}${i === b.answer ? " ✓" : ""}`).join("\n");
      return `${head}${b.question}\n\n${opts}${b.explain ? `\n\n解析：${b.explain}` : ""}`;
    }
    case "pronounce":
      return `${head}${b.items.map((i) => `- **${i.text}**${i.ipa ? ` /${i.ipa}/` : ""}${i.meaning ? `：${i.meaning}` : ""}`).join("\n")}`;
    case "glossary":
      return `${head}${b.terms.map((t) => `- **${t.term}**${t.alias ? `（${t.alias}）` : ""}：${t.def}`).join("\n")}`;
    case "analogy": {
      const rows = b.pairs.map((p) => `| ${cell(p.from)} | ${cell(p.to)} |`);
      return `${head}${[`| ${cell(b.source)} | ${cell(b.target)} |`, "| --- | --- |", ...rows].join("\n")}${b.limit ? `\n\n不适用之处：${b.limit}` : ""}`;
    }
    case "scale":
      return `${head}${b.items.map((i) => `- ${i.label}：${fmtSci(i.value)}${b.unit ? ` ${b.unit}` : ""}${i.note ? `（${i.note}）` : ""}`).join("\n")}`;
    case "examples":
      return `${head}${b.items.map((i) => `- ${i.kind === "counter" ? "反例" : "例"}：${i.text}${i.why ? `（${i.why}）` : ""}`).join("\n")}`;
    case "breakdown":
      return `${head}> ${b.sentence.replace(/\n+/g, " ")}\n\n${b.parts.map((p) => `- **${p.role}**：${p.text}${p.note ? ` —— ${p.note}` : ""}`).join("\n")}`;
    case "html":
      return `${head}\`\`\`html\n${b.html}\n\`\`\``;
  }
}

/** 渲染容错（D299 第四轮，实机 DeepSeek-V4.1-Flash）：弱模型常把组件写进 ```json / ```js / 无语言代码块，
 *  或单独一行写出组件 JSON。只要内容能通过 parseUIBlock，就改正为 ```nui；其余原样不动（含 ```nui / mermaid / 普通代码）。
 *  逐行扫描配对围栏（正则跨围栏匹配会把「上一个代码块的结尾」误当开头）。 */
export function normalizeComponentFences(markdown: string): string {
  const lines = String(markdown ?? "").split("\n");
  const out: string[] = [];
  const FIXABLE = new Set(["", "json", "json5", "js", "javascript"]);
  const asBlock = (body: string): string | null => {
    const t = body.trim();
    if (!t.startsWith("{") || !t.endsWith("}") || !/"type"\s*:/.test(t)) return null;
    return parseUIBlock(t).ok ? t : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^(\s*)```\s*([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (open) {
      const end = lines.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
      if (end < 0) {
        out.push(...lines.slice(i)); // 未闭合（流式中途）：原样
        break;
      }
      const lang = open[2].toLowerCase();
      const body = lines.slice(i + 1, end).join("\n");
      const fixed = FIXABLE.has(lang) ? asBlock(body) : null;
      if (fixed) out.push(`${open[1]}\`\`\`nui`, fixed, `${open[1]}\`\`\``);
      else out.push(...lines.slice(i, end + 1));
      i = end;
      continue;
    }
    const bare = asBlock(line);
    if (bare) out.push("```nui", bare, "```");
    else out.push(line);
  }
  return out.join("\n");
}

// ---------- D300：组件内容落地校验 ----------
// 根因：提示词里的组件目录给的是「完整可照抄的示范」，弱模型会把示范里的词条原样抄进回答（实机：选中一段与单位毫无关系的
// 叔本华译文，回答里却出现示范用的 Ångström 发音卡）。提示词侧已改为占位示范，这里再做确定性兜底：
// 「这个词怎么读 / 这个术语是什么」类组件，词条必须真的出现在本次材料（选区 / 追问 / 回答正文）里，否则不展示。
// 组件自身的文字不算出处（先剥掉回答里的组件代码块，组件不能自证）。

/** 匹配用归一：兼容分解 → 去变音符 → 小写 → 折叠空白（Ångström ≈ Angstrom，全角 ≈ 半角） */
function foldForMatch(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** 拼出落地校验用的出处文本：各段原文，回答里的组件代码块（含流式中途未闭合的）一律剥掉 */
export function groundingText(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => normalizeComponentFences(String(p ?? "")).replace(/```nui[^\n]*\n[\s\S]*?(```|$)/g, " "))
    .join("\n");
}

/** 落地校验：发音 / 术语组件只保留出现在出处文本里的词条；一条不剩返回 null（整个组件不展示）。
 *  未提供出处（卡面、复习等已由用户确认入库的展示面）时原样返回。 */
export function groundBlock(block: UIBlock, ground?: string): UIBlock | null {
  if (ground === undefined) return block;
  // 照抄了提示词示范的占位（〈…〉）——整块不展示
  if (/〈[^〉\n]{1,40}〉/.test(JSON.stringify(block))) return null;
  const g = foldForMatch(ground);
  const has = (w?: string) => {
    const f = foldForMatch(w ?? "");
    return f.length > 0 && g.includes(f);
  };
  if (block.type === "pronounce") {
    const items = block.items.filter((i) => has(i.text));
    return items.length ? { ...block, items } : null;
  }
  if (block.type === "glossary") {
    const terms = block.terms.filter((t) => has(t.term) || has(t.alias));
    return terms.length ? { ...block, terms } : null;
  }
  return block;
}

/** 把整段回答里的 nui 围栏替换为 Markdown 等价物（制卡材料、线程归档、导出用——避免把 JSON 喂给制卡模型） */
export function flattenNuiFences(markdown: string): string {
  return normalizeComponentFences(String(markdown ?? "")).replace(/```nui[^\n]*\n([\s\S]*?)```/g, (whole, body: string) => {
    const r = parseUIBlock(body);
    return r.ok ? blockToMarkdown(r.block) : whole;
  });
}
