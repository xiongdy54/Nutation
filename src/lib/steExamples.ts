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
