// D299：向解释请求追加「可视化组件」说明（追加在 user 消息末尾，不改动用户可编辑的系统模板）。
// 第三轮（实机反馈：真实阅读里触发率太低）：
//   - 始终附组件目录——每类一行「触发条件 + 字段骨架」，模型逐条对照、命中就用（至多 3 个）；
//   - 本地规则选中的组件给完整示例并标为优先；
//   - 简明解读（STE）同样追加；D301 起写进 JSON 的 components（带位置），冲突组件（类比 / 例子 / html）禁用；
//   - D301：组件插在所说明的内容之后，不再一律放在末尾。
// flow 不是 nui 组件：它让模型输出既有的 ```mermaid 流程图（ReadMarkdown 早已渲染），归入同一份目录统一调度。
import type { UIKind } from "./spec";

/** 可注入的呈现方式：nui 组件 + mermaid 流程图 */
export type PresentationKind = UIKind | "flow";

/** 判断层给解释请求的呈现计划：本地选中的组件（给完整示例）+ 是否附目录 */
export interface PresentationPlan {
  kinds: PresentationKind[];
  catalog: boolean;
}

// D300：示范一律用〈占位〉而非真实词条。根因（实机）：示范曾写真实内容（发音示范 Ångström、术语示范「边际效用」等），
// 且目录每次解释都附带——弱模型把示范词条原样抄进与之毫无关系的回答。占位只示范「字段与版式」，内容必须来自本次材料；
// 渲染侧另有确定性兜底（spec.ts groundBlock）：含〈占位〉的组件不展示，发音 / 术语词条须出现在本次材料里。
const EXAMPLES: Record<PresentationKind, string> = {
  formula: '{"type":"formula","title":"〈公式名称〉","latex":"〈LaTeX 公式〉","vars":[{"symbol":"〈符号〉","meaning":"〈含义〉"}]}',
  compare: '{"type":"compare","title":"〈对象甲〉与〈对象乙〉","entities":["〈对象甲〉","〈对象乙〉"],"rows":[{"dimension":"〈维度〉","values":["〈甲的情况〉","〈乙的情况〉"]}]}',
  chart: '{"type":"chart","kind":"bar","title":"〈图表标题〉","unit":"〈单位〉","labels":["〈类别1〉","〈类别2〉"],"series":[{"name":"〈系列名〉","values":[1,2]}],"note":"〈数据出处，如：原文第2段〉"}',
  steps: '{"type":"steps","title":"〈流程名称〉","steps":[{"title":"〈第一步要点〉","detail":"〈一句补充〉"},{"title":"〈第二步要点〉"}]}',
  timeline: '{"type":"timeline","title":"〈主题〉","events":[{"time":"〈时间〉","title":"〈事件〉","detail":"〈一句补充〉"},{"time":"〈时间〉","title":"〈事件〉"}]}',
  tree: '{"type":"tree","title":"〈体系名称〉","root":{"label":"〈总类〉","children":[{"label":"〈子类〉","note":"〈一句说明〉","children":[{"label":"〈细项〉"}]},{"label":"〈子类〉"}]}}',
  quiz: '{"type":"quiz","title":"易混点自测","question":"〈题干〉","options":["〈常见误解〉","〈正确说法〉"],"answer":1,"explain":"〈为什么前者错、后者对〉"}',
  pronounce: '{"type":"pronounce","items":[{"text":"〈材料里出现的外语词〉","lang":"〈BCP-47 语言码〉","ipa":"〈国际音标〉","meaning":"〈一句释义〉"}]}',
  glossary: '{"type":"glossary","terms":[{"term":"〈材料里出现的术语〉","def":"〈一句白话释义〉","alias":"〈外文名，可省〉"}]}',
  analogy: '{"type":"analogy","source":"〈熟悉的事物〉","target":"〈要理解的概念〉","pairs":[{"from":"〈熟悉事物的部分〉","to":"〈概念的对应部分〉"}],"limit":"〈类比不成立之处〉"}',
  scale: '{"type":"scale","title":"〈尺度主题〉","unit":"〈统一单位〉","items":[{"label":"〈参照物〉","value":1},{"label":"〈参照物〉","value":1000,"note":"〈一句说明〉"}]}',
  examples: '{"type":"examples","items":[{"kind":"example","text":"〈一个具体例子〉","why":"〈它为什么符合〉"},{"kind":"counter","text":"〈一个容易误认的反例〉","why":"〈它为什么不算〉"}]}',
  breakdown: '{"type":"breakdown","sentence":"〈原句照抄〉","parts":[{"role":"主干","text":"〈谁做了什么〉"},{"role":"条件","text":"〈在什么条件下〉","note":"〈一句白话〉"}]}',
  html: '{"type":"html","title":"〈演示标题〉","height":320,"html":"<div>…</div><script>…</script>"}',
  flow: "flowchart LR\n  A[〈原因〉] --> B[〈机制〉]\n  B --> C[〈结果〉]"
};

/** 触发条件（目录与优先段共用）——写成「看到什么就用」，而不是「什么材料适合」 */
const WHEN: Record<PresentationKind, string> = {
  pronounce: "所给材料或你的解释里**确实出现了**外语词、外国人名、以人名命名的单位 / 定理或生僻字时，给出读法（text 照抄原词；lang 用 BCP-47 语言码，ipa 不带斜线；不要写汉字谐音）；没有这类词就不要用",
  glossary: "材料里出现 2 个以上读者可能不懂的专业术语时，列术语表（term 照抄材料或解释里的原词，每条释义一句白话，≤30 字）",
  analogy: "用熟悉的事物类比陌生概念时（含「通俗解释」类追问），把类比两边逐项对应，并写明类比不成立之处",
  scale: "涉及数量级、尺度或「大 / 小到什么程度」时（如 10⁻⁸ cm、光年、纳秒），放 2–8 个参照物到同一单位的对数标尺上（value 为同一单位下的正数）",
  examples: "需要举例时，给 1–2 个具体例子，必要时配 1 个反例说明边界",
  breakdown: "原文有难读的长句时，把这一句拆成主干与修饰成分（role 如 主干 / 条件 / 原因 / 结果 / 让步 / 修饰，每个成分配一句白话）",
  formula: "涉及公式 / 方程 / 定理时，把核心公式放进组件（LaTeX，不要外包 $ 符号），并给出变量释义",
  compare: "在比较两个及以上对象时，把对比整理成表（每行一个维度，单元格≤20字）",
  chart: "材料里有 3 个以上可比较的**具体数字**时用图表；数字必须来自材料，否则在 note 写明「示意」",
  steps: "有先后次序的流程 / 操作时，用步骤组件（每步标题≤20字）",
  timeline: "涉及按时间发展的事件（≥3 个时间点）时，用时间线",
  tree: "在讲分类、组成或层级体系时，用层级组件（至多 3 层，每层≤8 项，标签≤12字）",
  quiz: "涉及常见误解或易混概念时，在讲解之后附一道单选自测（2–5 个选项，answer 为正确选项下标，从 0 起）",
  flow: "在讲因果链、机制或状态转换时，画一张 mermaid 流程图（节点≤12，节点文字≤10字）",
  html: "只有静态组件都表达不了的交互演示才用 html；必须自包含、不引用任何外部资源"
};

/** 目录顺序：学术阅读里最常命中的在前（发音 / 术语 / 例子 / 类比 / 量级），html 不进目录（只作兜底，不主动引导） */
const CATALOG_ORDER: PresentationKind[] = ["pronounce", "glossary", "examples", "analogy", "scale", "breakdown", "compare", "formula", "steps", "flow", "tree", "timeline", "chart", "quiz"];

const FENCE: Record<PresentationKind, string> = { ...Object.fromEntries(Object.keys(EXAMPLES).map((k) => [k, "nui"])), flow: "mermaid" } as Record<PresentationKind, string>;

// 系统模板（reader-explain，用户可编辑）末句是「不要输出 JSON」——组件恰是围栏里的 JSON，必须明确豁免，
// 否则模型多半服从系统提示而不出组件。注意：此行不得含围栏字样（单测按围栏计数）。
const FENCE_NOTE = "说明：组件代码块是本软件的渲染协议（会被直接渲染成表格、图表、发音按钮等可视化），不属于「不要输出 JSON」的限制范围；组件之外的正文仍不要输出 JSON。";

export interface AppendixOptions {
  /** 附完整目录（每类都给可照抄的代码块示范） */
  catalog?: boolean;
  /** 简明解读：组件写进 JSON components（D301），冲突组件禁用 */
  ste?: boolean;
  /** D334：额外排除的组件（简明解读 v7 的术语只走 glossary 字段，不再给术语表组件说明） */
  exclude?: PresentationKind[];
}

/** 一类组件的说明：何时用 + 完整代码块示范（第四轮：不再给一行骨架——弱模型会模仿骨架的版式把组件写成标题和列表） */
function entry(k: PresentationKind, n: number): string {
  return `${n}. ${WHEN[k]}：\n\`\`\`${FENCE[k]}\n${EXAMPLES[k]}\n\`\`\``;
}

/** D301：简明解读（ASD-STE100 式）下与硬约束冲突的组件——类比（比喻）、例子与反例（原文没有的信息）；D334 加句子拆解（照抄原句）。
 *  其余组件保留；判断层、追加段、渲染（steJson）三处共用此表，确保冲突组件在简明解读里不出现。 */
export const STE_BLOCKED_KINDS: ReadonlySet<PresentationKind> = new Set<PresentationKind>(["analogy", "examples", "html", "breakdown"]);

export function presentationAppendix(kinds: PresentationKind[], opts: AppendixOptions | boolean = false): string {
  const o: AppendixOptions = typeof opts === "boolean" ? { catalog: opts } : opts;
  const allowed = (k: PresentationKind) => k in EXAMPLES && !(o.ste && STE_BLOCKED_KINDS.has(k)) && !(o.exclude ?? []).includes(k);
  const uniq = [...new Set(kinds)].filter(allowed);
  if (uniq.length === 0 && !o.catalog) return "";
  const list = o.catalog ? [...uniq, ...CATALOG_ORDER.filter((k) => !uniq.includes(k) && allowed(k))] : uniq;
  const out: string[] = o.ste
    ? [
        "",
        "【可视化组件（可选）】",
        "如果下面某种组件对理解**确实有帮助**，把它写进 JSON 的 components 数组，至多 2 个；没有合适的就输出空数组。组件内的文字同样遵守上面的短句规则，只用原文里有的信息。",
        "写法：{\"after\": N, \"block\": 〈示范代码块里的那个 JSON 对象〉}；流程图写 {\"after\": N, \"mermaid\": \"〈mermaid 源码〉\"}。N 是组件要紧跟其后的原句编号——组件会显示在第 N 句的解释后面，所以 N 选组件所说明的那一句。",
        "- 示范里〈…〉是占位，只示范字段：必须换成本次材料里的真实内容，绝不能把示范原样输出；材料里没有的就不要输出该组件。",
        "- 不要用类比、比喻或举例类组件。",
        uniq.length && o.catalog ? "可用组件（前 " + uniq.length + " 种最可能适合这段材料）：" : "可用组件："
      ]
    : [
        "",
        "【可视化组件（可选）】",
        "如果下面某种组件对理解**确实有帮助**，就用它，至多 2 个；没有合适的就不加。",
        "位置：把组件**插在正文中它所说明的那段内容之后**（紧跟相关段落），不要一律堆在回答末尾；正文仍要完整（第一句直答，再讲机制与联系），组件只是配图，不能代替正文。",
        "格式要求（必须严格遵守，否则界面无法显示）：",
        "- 每个组件单独一个代码块：第一行只写 ```nui，中间是一个 JSON 对象（照抄示范的字段名，只替换内容），最后一行只写 ```。流程图例外，用 ```mermaid。代码块前后各空一行。",
        "- 不要把组件名（pronounce、glossary、analogy、scale 等）写成标题、列表或正文；不要把 JSON 拆成列表项；不要用 ```json。",
        "- 示范里〈…〉是占位，只示范字段与版式：必须换成本次材料里的真实内容，绝不能把示范原样输出；组件里的词条、对象、数字都必须来自上面的材料或你的解释，材料里没有的就不要输出该组件。",
        "- 组件里的内容不要在正文里再整段重复；数字必须来自材料或常识，不确定就不要编。",
        `- ${FENCE_NOTE}`,
        uniq.length && o.catalog ? "可用组件（前 " + uniq.length + " 种最可能适合这段材料）：" : "可用组件："
      ];
  list.forEach((k, i) => out.push(entry(k, i + 1)));
  return out.join("\n");
}
