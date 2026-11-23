// D301：「简明解读」v5 的完整范例（每种输出语言一份，按输出语言只注入一份）。
// 范例本身必须通过 steLint（tests/d301-ste-json.test.cjs 锁定）——示例与规则零冲突。
// 同一段英文原句，覆盖：施动者未说明、情态保留（thought to / remain unclear / may）、术语就地定义、术语节。
import type { SteOutLang } from "./steJson";

export const STE_EXAMPLE_SOURCE = [
  "[1] Microglia are thought to prune synapses during development, although the signals that guide this process remain unclear.",
  "[2] This pruning may explain some differences in adult brain wiring."
].join("\n");

const EXAMPLES: Record<SteOutLang, object> = {
  "zh-Hans": {
    matLang: "en",
    ambiguities: [{ key: "hidden-agent", label: "施动者隐藏", quote: "are thought to", note: "原文没有说明是谁这样认为。" }],
    explanations: [
      ["小胶质细胞是脑内负责清理的一类细胞。", "突触是神经细胞之间的连接点。", "有人认为小胶质细胞在发育期修剪突触，来源未说明是谁。", "引导这个修剪过程的信号目前仍不清楚。"],
      ["这种修剪可能解释成年人大脑连接的部分差异。"]
    ],
    readings: [],
    terms: [{ term: "突触修剪", def: "大脑在发育期去掉多余的神经连接。" }],
    components: []
  },
  "zh-Hant": {
    matLang: "en",
    ambiguities: [{ key: "hidden-agent", label: "施動者隱藏", quote: "are thought to", note: "原文沒有說明是誰這樣認為。" }],
    explanations: [
      ["小膠質細胞是腦內負責清理的一類細胞。", "突觸是神經細胞之間的連接點。", "有人認為小膠質細胞在發育期修剪突觸，來源未說明是誰。", "引導這個修剪過程的信號目前仍不清楚。"],
      ["這種修剪可能解釋成年人大腦連接的部分差異。"]
    ],
    readings: [],
    terms: [{ term: "突觸修剪", def: "大腦在發育期去掉多餘的神經連接。" }],
    components: []
  },
  en: {
    matLang: "en",
    ambiguities: [{ key: "hidden-agent", label: "Hidden agent", quote: "are thought to", note: "The text does not say who thinks this." }],
    explanations: [
      ["Microglia are cells that clean up waste in the brain.", "A synapse is a connection point between two nerve cells.", "An unnamed source thinks that microglia remove synapses during development.", "Nobody knows yet which signals guide this process."],
      ["This pruning may explain some differences in adult brain wiring."]
    ],
    readings: [],
    terms: [{ term: "synaptic pruning", def: "The brain removes extra nerve connections." }],
    components: []
  },
  ja: {
    matLang: "en",
    ambiguities: [{ key: "hidden-agent", label: "動作主の省略", quote: "are thought to", note: "誰がそう考えているのか、原文は示していません。" }],
    explanations: [
      ["ミクログリアは、脳の中で不要なものを片付ける細胞です。", "シナプスは、神経細胞どうしをつなぐ部分です。", "ミクログリアは発達期にシナプスを刈り込むと考えられています。", "誰がそう考えているのか、原文は示していません。", "この刈り込みを導く信号は、まだ分かっていません。"],
      ["刈り込みは大人の脳の配線の違いの一部を説明するかもしれません。"]
    ],
    readings: [],
    terms: [{ term: "シナプスの刈り込み", def: "発達期に余分なつながりを取り除くことです。" }],
    components: []
  }
};

export function steExampleJson(lang: SteOutLang): string {
  return JSON.stringify(EXAMPLES[lang], null, 1);
}

export function steExampleBlock(lang: SteOutLang): string {
  return `原句：\n${STE_EXAMPLE_SOURCE}\n\n输出：\n${steExampleJson(lang)}`;
}

// ---------- D334：v7 范例（逐句 STE 改写 + glossary + 英文 STE 层） ----------
// 每种输出语言两份：same＝材料语言与输出语言相同（中文材料 → 中文改写，现场多为这种情况）；cross＝不同。
// 按材料语言只注入一份。范例必须通过 v7 steLint（tests/d334-ste-lint.test.cjs 锁定）。

const SRC_EN = [
  "Microglia are thought to prune synapses during development, although the signals that guide this process remain unclear.",
  "This pruning may explain some differences in adult brain wiring."
];
const SRC_ZH_HANS = ["所谓机会成本，是指为了得到某种东西而必须放弃的其他选择中价值最高的那一个。", "经济学家通常认为，人们在做决定时会自觉或不自觉地比较这种成本。"];
const SRC_ZH_HANT = ["所謂機會成本，是指為了得到某種東西而必須放棄的其他選擇中價值最高的那一個。", "經濟學家通常認為，人們在做決定時會自覺或不自覺地比較這種成本。"];
const SRC_JA = ["機会費用とは、ある選択をしたときに諦めた他の選択肢のうち、最も価値の高いものを指す。", "経済学者は一般に、人々が意思決定の際にこの費用を意識的または無意識的に比較していると考えている。"];

const EN_MICROGLIA = [
  ["An unnamed source thinks that microglia remove synapses during development.", "Nobody knows yet which signals control this process."],
  ["This removal may explain some differences in how adult brains connect."]
];
const EN_COST = [
  ["Opportunity cost is a type of cost.", "When you choose one thing, you give up other choices.", "The most valuable choice that you give up is the opportunity cost."],
  ["Economists usually think that people compare opportunity costs when they make decisions.", "Sometimes people know that they compare, and sometimes they do not know."]
];

export interface SteExampleV7 {
  source: string[];
  doc: object;
}

export const STE_EXAMPLES_V7: Record<SteOutLang, { same: SteExampleV7; cross: SteExampleV7 }> = {
  "zh-Hans": {
    same: {
      source: SRC_ZH_HANS,
      doc: {
        matLang: "zh-Hans",
        ambiguities: [],
        rewrites: [
          ["机会成本是一种代价。", "你选择一个东西时，要放弃其他选择。", "你放弃的选择里，价值最高的那一个就是机会成本。"],
          ["经济学家通常认为，人们做决定时会比较机会成本。", "这种比较有时是自觉的，有时是不自觉的。"]
        ],
        notes: [],
        readings: [],
        glossary: [{ term: "机会成本", def: "选一样东西时放弃的最高价值。", alias: "opportunity cost" }],
        en: EN_COST,
        components: []
      }
    },
    cross: {
      source: SRC_EN,
      doc: {
        matLang: "en",
        ambiguities: [{ key: "hidden-agent", label: "施动者隐藏", quote: "are thought to", note: "原文没有说明是谁这样认为。" }],
        rewrites: [["有人认为小胶质细胞在发育期修剪突触，来源未说明是谁。", "引导这个修剪过程的信号目前仍不清楚。"], ["这种修剪可能解释成年人大脑连接的部分差异。"]],
        notes: [],
        readings: [],
        glossary: [
          { term: "小胶质细胞", def: "脑内负责清理的一类细胞。", alias: "microglia" },
          { term: "突触", def: "神经细胞之间的连接点。", alias: "synapse" }
        ],
        en: EN_MICROGLIA,
        components: []
      }
    }
  },
  "zh-Hant": {
    same: {
      source: SRC_ZH_HANT,
      doc: {
        matLang: "zh-Hant",
        ambiguities: [],
        rewrites: [
          ["機會成本是一種代價。", "你選擇一樣東西時，要放棄其他選擇。", "你放棄的選擇裡，價值最高的那一樣就是機會成本。"],
          ["經濟學家通常認為，人們做決定時會比較機會成本。", "這種比較有時是自覺的，有時是不自覺的。"]
        ],
        notes: [],
        readings: [],
        glossary: [{ term: "機會成本", def: "選一樣東西時放棄的最高價值。", alias: "opportunity cost" }],
        en: EN_COST,
        components: []
      }
    },
    cross: {
      source: SRC_EN,
      doc: {
        matLang: "en",
        ambiguities: [{ key: "hidden-agent", label: "施動者隱藏", quote: "are thought to", note: "原文沒有說明是誰這樣認為。" }],
        rewrites: [["有人認為小膠質細胞在發育期修剪突觸，來源未說明是誰。", "引導這種修剪的信號目前仍不清楚。"], ["這種修剪可能解釋成年人大腦連接的部分差異。"]],
        notes: [],
        readings: [],
        glossary: [
          { term: "小膠質細胞", def: "腦內負責清理的一類細胞。", alias: "microglia" },
          { term: "突觸", def: "神經細胞之間的連接點。", alias: "synapse" }
        ],
        en: EN_MICROGLIA,
        components: []
      }
    }
  },
  en: {
    same: {
      source: SRC_EN,
      doc: {
        matLang: "en",
        ambiguities: [{ key: "hidden-agent", label: "Hidden agent", quote: "are thought to", note: "The text does not say who thinks this." }],
        rewrites: EN_MICROGLIA,
        notes: [],
        readings: [],
        glossary: [
          { term: "microglia", def: "Cells that clean up waste in the brain." },
          { term: "synapse", def: "A connection point between two nerve cells." }
        ],
        en: [],
        components: []
      }
    },
    cross: {
      source: SRC_ZH_HANS,
      doc: {
        matLang: "zh-Hans",
        ambiguities: [],
        rewrites: EN_COST,
        notes: [],
        readings: [],
        glossary: [{ term: "opportunity cost", def: "The highest value that you give up when you choose.", alias: "机会成本" }],
        en: [],
        components: []
      }
    }
  },
  ja: {
    same: {
      source: SRC_JA,
      doc: {
        matLang: "ja",
        ambiguities: [],
        rewrites: [
          ["機会費用は、費用の一つです。", "何かを選ぶとき、人は他の選択肢を諦めます。", "諦めた選択肢の中で最も価値の高いものが機会費用です。"],
          ["経済学者は一般に、次のように考えています。", "人は何かを決めるとき、機会費用を比べます。", "この比較は、意識的な場合も無意識の場合もあります。"]
        ],
        notes: [],
        readings: [],
        glossary: [{ term: "機会費用", def: "選ばなかった選択肢のうち最も高い価値です。", alias: "opportunity cost" }],
        en: [
          ["Opportunity cost is a type of cost.", "When a person chooses one thing, the person gives up other choices.", "The most valuable choice that the person gives up is the opportunity cost."],
          ["Economists usually have this opinion.", "When people make a decision, they compare opportunity costs.", "People can make this comparison with or without awareness."]
        ],
        components: []
      }
    },
    cross: {
      source: SRC_EN,
      doc: {
        matLang: "en",
        ambiguities: [{ key: "hidden-agent", label: "動作主の省略", quote: "are thought to", note: "そう考える人を、原文は示していません。" }],
        rewrites: [
          ["ミクログリアは発達期にシナプスを刈り込むと考えられています。", "誰がそう考えているのか、原文は示していません。", "この刈り込みを導く信号は、まだ分かっていません。"],
          ["刈り込みは大人の脳の配線の違いの一部を説明するかもしれません。"]
        ],
        notes: [],
        readings: [],
        glossary: [
          { term: "ミクログリア", def: "脳の中で不要なものを片付ける細胞です。", alias: "microglia" },
          { term: "シナプス", def: "神経細胞どうしをつなぐ部分です。", alias: "synapse" }
        ],
        en: EN_MICROGLIA,
        components: []
      }
    }
  }
};

type Family = "zh" | "ja" | "en";
const familyOfOut = (l: SteOutLang): Family => (l === "en" ? "en" : l === "ja" ? "ja" : "zh");

/** 材料语言族：优先用标注的 matLang；未标注时按文字判断（有假名＝日文，有汉字＝中文，否则英文） */
export function materialFamily(matLang: string, source: string): Family {
  const m = String(matLang || "").toLowerCase();
  if (m.startsWith("zh")) return "zh";
  if (m.startsWith("ja")) return "ja";
  if (m.startsWith("en")) return "en";
  const s = String(source ?? "");
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return "ja";
  if (/\p{Script=Han}/u.test(s)) return "zh";
  return "en";
}

export function steExampleV7(lang: SteOutLang, matLang: string, source: string): SteExampleV7 {
  const set = STE_EXAMPLES_V7[lang];
  return materialFamily(matLang, source) === familyOfOut(lang) ? set.same : set.cross;
}

export function steExampleBlockV7(lang: SteOutLang, matLang: string, source: string): string {
  const ex = steExampleV7(lang, matLang, source);
  return `原句：\n${ex.source.map((s, i) => `[${i + 1}] ${s}`).join("\n")}\n\n输出：\n${JSON.stringify(ex.doc, null, 1)}`;
}
