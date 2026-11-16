// D299：内置判断规格（与材料路由无关的部分；material-type 规格在 cards.ts 就近定义，避免循环依赖）。
import type { DecisionAnswers, DecisionInput, DecisionSpec } from "./types";
import { ans } from "./types";
import type { PresentationKind } from "../genui/prompt";
import { STE_BLOCKED_KINDS } from "../genui/prompt";

// ---------- card-intent：自由追问里用户是否要求「顺便制卡」 ----------
// 本地：强正例 / 「问制卡本身」的反例 / 弱信号三档；只有弱信号才升级到 LLM（多数消息零额外调用）。
const INTENT_STRONG =
  /(顺便|顺手|帮我|给我|请|直接|也|一并|再|并)?\s*(制作|制|做|出|生成)\s*(几|一些|一|两|三|个|张)*\s*(张)?\s*(卡|卡片|闪卡|记忆卡)|做成(记忆)?卡片?|加入复习|帮我记住|以后(再)?考(考)?我|\bmake (me )?(a |some |an? few )?(flash ?)?cards?\b|\bturn (this|it) into (flash ?)?cards?\b|\bremember this\b|\bquiz me (on this )?later\b|\badd (this|it) to (my )?review/i;
const INTENT_META = /(制卡|做卡|卡片(制作)?)\s*(的)?\s*(规则|原则|方法|技巧|是什么|怎么做|怎么样|有什么|标准)|(怎么|如何|怎样)\s*(制卡|做卡|做卡片|制作卡片)|什么是\s*(制卡|闪卡)|\bhow (do|should) (i|you) (make|write) (good )?(flash ?)?cards?\b/i;
const INTENT_WEAK = /(记住|背下来|背诵|复习|考我|卡)/;

export function localCardIntent(q: string): number {
  const s = String(q ?? "");
  if (INTENT_META.test(s)) return 0.08;
  if (INTENT_STRONG.test(s)) return 0.92;
  if (INTENT_WEAK.test(s)) return 0.5;
  return 0.03;
}

export const CARD_INTENT_SPEC: DecisionSpec = {
  id: "card-intent",
  version: 1,
  primary: "wants_cards",
  questions: {
    wants_cards: {
      type: "noul",
      instructions: "用户这条消息是否在要求把当前讲解的内容制作成记忆卡片（闪卡）？",
      criteria: {
        true_description: "用户明确或隐含地要求制卡、记住、加入复习、以后考他。",
        false_description: "用户只是在提问、追问，或在询问制卡方法本身。"
      }
    }
  },
  thresholds: { calibrated: { auto: 0.85, confirm: 0.6 }, uncalibrated: { auto: 0.9, confirm: 0.7 } },
  local: (input: DecisionInput): DecisionAnswers => ({ wants_cards: ans.noul(localCardIntent(input.text)) }),
  shouldEscalate: (local) => {
    const p = local.wants_cards?.value;
    return typeof p === "number" && p > 0.2 && p < 0.8;
  },
  backends: ["llm", "local"]
};

// ---------- presentation：解释回答最适合的呈现组件 ----------
// 当前只走本地（解释是流式首屏，不为选组件多等一次请求）；将来判断模型 150–250ms 时可放开 backends。
// 版本：v1 = 第一期六类；v2（D299 第二期）= 增 flow / tree / quiz。
const RE_COMPARE = /(区别|不同|异同|对比|比较|相比|差异|差别|vs\.?|versus|哪个(更|好)|优缺点|优劣|和.{1,12}有什么(不同|区别)|\bcompare\b|\bdifferences? between\b|\bpros and cons\b)/i;
const RE_FORMULA = /(\$[^$]+\$|\\(frac|sum|int|sqrt|lim|alpha|beta|theta|cdot)|公式|方程|推导|定理|证明|求导|积分|[a-zA-Z]\s*=\s*[a-zA-Z0-9(])/;
const RE_STEPS = /(步骤|流程|怎么做|如何(做|操作|实现|配置|安装)|操作方法|过程是|先.{1,20}然后|首先.{1,40}(其次|然后|最后)|step(s)? |\bhow (do|can|to) (i |you |we )?(set ?up|install|configure|make|build|create|do)\b)/i;
const RE_CAUSAL = /(导致|因此|从而|进而|引起|引发|造成|→|->|机制|原理是|为什么会)/;
const RE_TREE = /(分类|分为|分成|包括哪些|有哪(几|些)(类|种|部分)|哪几类|层级|体系|组成(部分)?|由哪些|种类|架构|taxonomy|categor)/i;
const RE_QUIZ = /(误解|误区|易混|容易(搞)?混|混淆|区分不清|常见错误|自测|考考我|测一测|quiz)/i;
const RE_YEAR = /(1[0-9]{3}|20[0-9]{2})\s*年|公元(前)?\s*\d+|\d+\s*世纪/g;
/** 裸四位年份（英文材料无「年」字）；只在问题明确要时间线时计数，避免把编号 / 数值误当年份 */
const RE_BARE_YEAR = /\b(1[0-9]{3}|20[0-9]{2})\b/g;
const RE_TIMELINE = /(历史|演变|发展历程|时间线|沿革|年表|timeline)/i;
// 原文侧（无追问时）：对照连接词（「，而」排除 而且/而已/而后/而今/而言/而是 与指代性承接 而这/那/此/其/它）、次序标记、因果连接、≥3 项顿号枚举
const RE_CONTRAST = /([，,；;]\s*而(?![且已后今言是这那此其它])|相比之下|相较于|相比于|不同于|与之相反|反之|\bwhereas\b|\bunlike\b|\bin contrast\b)/i;
const RE_SEQ_MARK = /(首先|其次|然后|接着|随后|最后|第[一二三四五六七八九十]步|阶段|\bfirst(ly)?\b|\bthen\b|\bfinally\b)/gi;
const RE_CAUSAL_MARK = /(导致|因此|从而|进而|引起|引发|造成|使得|由于|所以|以致|→|\bbecause\b|\btherefore\b|\bleads? to\b|\bresult(s|ed)? in\b)/gi;
const RE_ENUM = /(包括|包含|分为|分成|可分为|主要有|有以下|由)[^。；\n]{0,80}、[^。；\n]{0,80}、/;
// 第三轮：尺度（科学计数法 / 尺度单位）、类比（原文在打比方 / 追问要通俗讲）、举例（追问）、外语词（中文材料里的拉丁 / 带变音符 / 假名 / 希腊 / 西里尔词）
const RE_SCALE = /(\d\s*[×x✕]\s*10\s*[-−–^]?\s*\d|10\s*\^\s*[-−–]?\d|10[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+|数量级|放大.{0,6}倍|光年|纳米|微米|皮米|飞秒|纳秒|\bnm\b|μm|Å|orders? of magnitude)/i;
const RE_ANALOGY = /(好比|就像|就好像|如同|犹如|比作|可以想象|想象(一下|成)|如果把.{1,24}(放大|比作|看作|想象)|\bis like\b|\bimagine\b|\banalog)/i;
const RE_ANALOGY_Q = /(通俗|大白话|打个比方|类比|比喻|\bELI5\b|\banalogy\b|in simple terms)/i;
const RE_EXAMPLE_Q = /(举(个|几个|一个)?例|例子|实例|反例|\bexamples?\b)/i;
const RE_FOREIGN_WORD = /[A-Za-z]*[À-ÖØ-öø-ÿĀ-ž][A-Za-zÀ-ž]*|[A-Za-z]*[a-z][A-Za-z]{3,}|[\u0370-\u03ff]{3,}|[\u0400-\u04ff]{3,}|[\u3040-\u30ff]{2,}/;
const RE_CJK = /[\u4e00-\u9fff]/g;
/** 中文为主的材料里夹着外语词（纯外语材料不算——那是整段翻译问题，不是「这个词怎么读」） */
export function hasForeignWord(text: string): boolean {
  const t = String(text ?? "");
  if (!t) return false;
  const cjk = (t.match(RE_CJK) ?? []).length;
  return cjk / t.length >= 0.3 && RE_FOREIGN_WORD.test(t);
}
const RE_LONG_SENTENCE = /[^。！？!?；;\n]{60,}/;
const RE_NUMBERS = /\d+(\.\d+)?\s*(%|％|亿|万|千|美元|元|kg|km|ms|s\b|倍)/g;

export const PRESENTATION_OPTIONS: Record<string, string> = {
  prose: "纯文字解释即可",
  formula: "核心是公式、方程或定理",
  compare: "在比较两个及以上对象",
  chart: "有可比较的具体数字，适合图表",
  steps: "有先后次序的流程或操作",
  flow: "因果链、机制或状态转换，适合画流程图",
  timeline: "按时间发展的多个事件",
  tree: "分类、组成或层级体系",
  quiz: "常见误解或易混概念，适合附一道自测题",
  analogy: "在用熟悉的事物类比陌生概念",
  scale: "涉及数量级或尺度大小",
  examples: "需要举例或反例",
  glossary: "有多个读者可能不懂的术语",
  pronounce: "出现外语词或不知道怎么读的词",
  breakdown: "有难读的长句",
  other: "以上都不合适"
};

/** 本地呈现判断（纯函数、零网络）。优先序：自测 > 对比/图表 > 公式 > 时间线 > 层级 > 流程图 > 步骤 > 纯文字 */
export function localPresentation(text: string, question: string): { kind: string; conf: number } {
  const q = String(question ?? "");
  const t = String(text ?? "");
  const all = `${q}\n${t}`;
  const numbers = (all.match(RE_NUMBERS) ?? []).length;
  // ① 问题侧信号优先（追问的意图最明确）
  if (RE_QUIZ.test(q)) return { kind: "quiz", conf: 0.7 };
  if (RE_COMPARE.test(q) || (!q && RE_COMPARE.test(t)) || RE_CONTRAST.test(t)) return numbers >= 3 ? { kind: "chart", conf: 0.7 } : { kind: "compare", conf: 0.75 };
  if (RE_FORMULA.test(all)) return { kind: "formula", conf: 0.75 };
  const years = (all.match(RE_YEAR) ?? []).length;
  const bareYears = RE_TIMELINE.test(q) ? (all.match(RE_BARE_YEAR) ?? []).length : 0;
  if (years >= 3 || (RE_TIMELINE.test(q) && Math.max(years, bareYears) >= 2)) return { kind: "timeline", conf: 0.7 };
  if (RE_TREE.test(q)) return { kind: "tree", conf: 0.65 };
  if (RE_CAUSAL.test(all) && (RE_STEPS.test(all) || /为什么|机制|原理|过程/.test(q))) return { kind: "flow", conf: 0.6 };
  if (RE_STEPS.test(all)) return { kind: "steps", conf: 0.65 };
  if (RE_EXAMPLE_Q.test(q)) return { kind: "examples", conf: 0.7 };
  if (RE_ANALOGY_Q.test(q)) return { kind: "analogy", conf: 0.65 };
  // ② 原文侧信号（「选中 → AI 解释」没有追问，只能看原文；D299 实机反馈补）
  //    次序：次序标记 > 因果连接 > 成组数字 > 并列枚举——「分为两个阶段：首先…然后…」是流程而非分类
  if ((t.match(RE_SEQ_MARK) ?? []).length >= 2) return { kind: "steps", conf: 0.6 };
  if ((t.match(RE_CAUSAL_MARK) ?? []).length >= 2) return { kind: "flow", conf: 0.6 };
  if (RE_SCALE.test(t)) return { kind: "scale", conf: 0.6 };
  if (numbers >= 3) return { kind: "chart", conf: 0.55 };
  if (RE_ANALOGY.test(t)) return { kind: "analogy", conf: 0.6 };
  if (RE_ENUM.test(t) || (!q && RE_TREE.test(t))) return { kind: "tree", conf: 0.6 };
  return { kind: "prose", conf: 0.6 };
}

export const PRESENTATION_SPEC: DecisionSpec = {
  id: "presentation",
  version: 3,
  primary: "presentation",
  questions: {
    presentation: {
      type: "choice",
      instructions: "针对材料与用户的问题，解释回答最适合用哪种呈现方式？",
      criteria: PRESENTATION_OPTIONS
    }
  },
  thresholds: { calibrated: { auto: 0.6, confirm: 0.4 }, uncalibrated: { auto: 0.6, confirm: 0.4 } },
  local: (input) => {
    const r = localPresentation(input.text, String(input.fields?.question ?? ""));
    return { presentation: ans.choice(r.kind, r.conf) };
  },
  backends: ["local"]
};

const INJECTABLE = new Set<PresentationKind>(["formula", "compare", "chart", "steps", "timeline", "tree", "quiz", "flow", "analogy", "scale", "examples", "glossary", "pronounce", "breakdown"]);

/** 判断结果 → 给完整示例的「优先组件」（至多 3 个）：主判断 + 附加信号（公式 / 外语词；简明解读遇长句加句子拆解）。
 *  其余组件由目录交模型按触发条件自选，这里不必穷举。 */
export function presentationKinds(answers: DecisionAnswers, text: string, question: string, ste = false): PresentationKind[] {
  const k = String(answers.presentation?.value ?? "prose") as PresentationKind;
  const out: PresentationKind[] = [];
  // D301：简明解读不选与 STE 冲突的组件（类比 / 例子）
  if (INJECTABLE.has(k) && !(ste && STE_BLOCKED_KINDS.has(k))) out.push(k);
  if (ste && RE_LONG_SENTENCE.test(text) && !out.includes("breakdown")) out.push("breakdown");
  if (k !== "formula" && RE_FORMULA.test(`${question}\n${text}`)) out.push("formula");
  if (hasForeignWord(text) && !out.includes("pronounce")) out.push("pronounce");
  return out.slice(0, 3);
}
