// D299（生成式 UI · 判断层）：「判断接口先行，判断模型后置」。
// 所有「选哪条路」的判断统一走 decide(spec, input)；问题形状对齐 Jev / Gemini Decision 1 的
// 四类封闭问题（noul / choice / score / box），将来接判断模型或 Nutation 托管用量时调用方零改动。
// 兼容约束（两家 API 的交集，写 spec 时必须遵守，tests/d299-genui 会校验）：
//   - 问题 key：^[A-Za-z0-9_-]{1,64}$；choice 选项 key：ASCII、无首尾空格、≤128 字符
//   - choice 选项 2–255 个，且必含 "other" 兜底（不要用 none_of_the_above——Gemini 按字母序重排选项）
//   - score 档位 2–10 个（由低到高、线性）
//   - instructions 写完整问题（模型看不到 key），只用纯文本
// 纯函数模块：禁 window/IPC 依赖（可被 esbuild 打进 node 单测）。

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true_description: string; false_description: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  /** 预留：图片定位（图片遮挡自动框选）。当前无后端实现，supports() 一律 false */
  | { type: "box"; instructions: string };

export type BoxValue = { top: number; bottom: number; left: number; right: number };

export interface DecisionAnswer {
  /** noul → P(yes) 0–1；choice → 选项 key；score → 期望档位（可为小数）；box → 四边比例 */
  value: number | string | BoxValue;
  /** 0–1：top 答案正确的估计概率 */
  confidence: number;
  /** 只有真正的判断模型（jev / gemini-decision / nutation-cloud）才是 true；本地规则与 LLM 自报一律 false */
  calibrated: boolean;
}

export type DecisionAnswers = Record<string, DecisionAnswer>;

/** 判断输入：共享上下文（每次请求只计一次费）。text 为主材料；fields 为结构化附加字段（序列化为 JSON 文本） */
export interface DecisionInput {
  text: string;
  fields?: Record<string, string | number | boolean | null>;
}

export type BackendId = "local" | "llm" | "jev" | "gemini-decision" | "nutation-cloud";

/** 判断结果的去向：自动执行 / 请用户确认 / 走兜底（与置信度阈值对应） */
export type DecisionAction = "auto" | "confirm" | "fallback";

export interface DecisionSpec {
  /** 稳定 id，如 "material-type"；日志与将来服务端按 id+version 识别 */
  id: string;
  /** 问题或判断标准改动即 +1（与 prompts 版本留痕同规） */
  version: number;
  questions: Record<string, DecisionQuestion>;
  /** 用于 action 判定的主问题 key（缺省取第一个问题） */
  primary?: string;
  /** 置信度阈值：≥auto 自动执行；≥confirm 请用户确认；更低走兜底。按 calibrated 分两套（LLM 自报置信度偏高） */
  thresholds: {
    calibrated: { auto: number; confirm: number };
    uncalibrated: { auto: number; confirm: number };
  };
  /** 本地实现（必需）：确定性、零网络；任何后端失败都回落这里 */
  local: (input: DecisionInput) => DecisionAnswers;
  /** 可选：LLM 后端的专用提示词与解析（迁移既有调优过的分类提示词时用，保证行为逐字不变） */
  llm?: {
    system: string;
    user: (input: DecisionInput) => string;
    parse: (raw: string) => DecisionAnswers | null;
    temperature?: number;
    timeoutMs?: number;
    /** aiGateway 功能标签（ai.invoked 统计口径）；缺省 "judge" */
    feature?: "card_gen" | "explain" | "judge";
  };
  /** 可选：是否值得走远端后端（例如本地已高置信时直接短路，省一次调用） */
  shouldEscalate?: (local: DecisionAnswers, input: DecisionInput) => boolean;
  /** 允许的后端（按优先序）；缺省 ["llm","local"] */
  backends?: BackendId[];
}

export interface DecisionResult {
  specId: string;
  specVersion: number;
  backend: BackendId;
  answers: DecisionAnswers;
  action: DecisionAction;
  /** 远端失败而回落本地时为 true */
  fellBack: boolean;
  ms: number;
}

export interface DecisionBackend {
  id: BackendId;
  supports(spec: DecisionSpec): boolean;
  /** 当前是否可用（例如 LLM 未配置 Key → false）；不可用时 gateway 直接跳过 */
  available(): Promise<boolean>;
  decide(spec: DecisionSpec, input: DecisionInput, signal: { onCancelRegister?: (c: () => void) => void }): Promise<DecisionAnswers>;
}

export const QUESTION_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** spec 静态校验（单测与开发期断言用）：返回问题清单，空数组＝合规 */
export function lintSpec(spec: DecisionSpec): string[] {
  const issues: string[] = [];
  const keys = Object.keys(spec.questions);
  if (keys.length === 0) issues.push("至少一个问题");
  if (spec.primary && !keys.includes(spec.primary)) issues.push(`primary「${spec.primary}」不在 questions 中`);
  for (const k of keys) {
    const q = spec.questions[k];
    if (!QUESTION_KEY_RE.test(k)) issues.push(`问题 key 非法：${k}`);
    if (!q.instructions.trim()) issues.push(`${k}: instructions 为空`);
    if (q.type === "choice") {
      const opts = Object.keys(q.criteria);
      if (opts.length < 2 || opts.length > 255) issues.push(`${k}: choice 选项数须 2–255`);
      if (!opts.includes("other")) issues.push(`${k}: choice 须含 other 兜底`);
      for (const o of opts) {
        if (!/^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/.test(o)) issues.push(`${k}: 选项 key 非法：${o}`);
        if (/none_of_the_above/i.test(o)) issues.push(`${k}: 不要用 none_of_the_above（会被字母序重排）`);
      }
    }
    if (q.type === "score" && (q.criteria.length < 2 || q.criteria.length > 10)) issues.push(`${k}: score 档位须 2–10`);
  }
  const t = spec.thresholds;
  for (const [name, th] of Object.entries(t)) {
    if (!(th.auto >= th.confirm && th.confirm >= 0 && th.auto <= 1)) issues.push(`thresholds.${name} 须 0 ≤ confirm ≤ auto ≤ 1`);
  }
  return issues;
}

/** 由主问题答案 + 阈值得出 action（纯函数） */
export function actionOf(spec: DecisionSpec, answers: DecisionAnswers): DecisionAction {
  const key = spec.primary ?? Object.keys(spec.questions)[0];
  const a = answers[key];
  if (!a) return "fallback";
  const th = a.calibrated ? spec.thresholds.calibrated : spec.thresholds.uncalibrated;
  if (a.confidence >= th.auto) return "auto";
  if (a.confidence >= th.confirm) return "confirm";
  return "fallback";
}

/** noul 答案转布尔（P(yes) ≥ 0.5） */
export function yes(a: DecisionAnswer | undefined): boolean {
  return !!a && typeof a.value === "number" && a.value >= 0.5;
}

/** 构造答案的便捷函数（本地实现用） */
export const ans = {
  noul(p: number, calibrated = false): DecisionAnswer {
    const v = Math.min(0.99, Math.max(0.01, p));
    return { value: v, confidence: Math.max(v, 1 - v), calibrated };
  },
  choice(key: string, confidence: number, calibrated = false): DecisionAnswer {
    return { value: key, confidence: Math.min(1, Math.max(0, confidence)), calibrated };
  },
  score(level: number, confidence: number, calibrated = false): DecisionAnswer {
    return { value: level, confidence: Math.min(1, Math.max(0, confidence)), calibrated };
  }
};
