// D299：```nui 围栏的渲染入口——解析 → 白名单组件 → 统一工具条（复制 / 复制 Markdown / 插入制卡面板 / 就此制卡）。
// 解析失败（含流式生成中途 JSON 未闭合）→ 显示源码 + 提示，绝不抛错打断整段回答渲染。
// 展示面：AI 面板（surface="panel"）出完整工具条；卡面等其余展示面紧凑渲染、无工具条（T-G4）。
import { useMemo, useRef, useState, type ReactNode } from "react";
import katex from "katex";
import { useT } from "../../lib/i18n";
import { blockToMarkdown, groundBlock, parseUIBlock, type UIBlock, type UIKind } from "../../lib/genui/spec";
import { copyBlock, copyText } from "../../lib/genui/clipboard";
import { useGenUIActions } from "./GenUIContext";
import {
  AnalogyView,
  BreakdownView,
  ChartView,
  CompareView,
  ExamplesView,
  FormulaView,
  GlossaryView,
  HtmlSandboxView,
  PronounceView,
  QuizView,
  ScaleView,
  StepsView,
  TimelineView,
  TreeView
} from "./views";
import "./genui.css";

/** 组件类型的展示名（头行小标签；中文为键，四语经 T） */
const KIND_LABEL: Record<UIKind, string> = {
  formula: "公式",
  compare: "对比",
  chart: "图表",
  steps: "步骤",
  timeline: "时间线",
  tree: "层级",
  quiz: "自测",
  pronounce: "发音",
  glossary: "术语",
  analogy: "类比",
  scale: "量级",
  examples: "例子",
  breakdown: "句子拆解",
  html: "交互演示"
};

function renderFormulaHtml(b: UIBlock): string | undefined {
  if (b.type !== "formula") return undefined;
  try {
    return katex.renderToString(b.latex, { displayMode: true, throwOnError: false, output: "html" });
  } catch {
    return undefined;
  }
}

function BlockView({ block }: { block: UIBlock }): ReactNode {
  switch (block.type) {
    case "formula":
      return <FormulaView block={block} />;
    case "compare":
      return <CompareView block={block} />;
    case "chart":
      return <ChartView block={block} />;
    case "steps":
      return <StepsView block={block} />;
    case "timeline":
      return <TimelineView block={block} />;
    case "tree":
      return <TreeView block={block} />;
    case "quiz":
      return <QuizView block={block} />;
    case "pronounce":
      return <PronounceView block={block} />;
    case "glossary":
      return <GlossaryView block={block} />;
    case "analogy":
      return <AnalogyView block={block} />;
    case "scale":
      return <ScaleView block={block} />;
    case "examples":
      return <ExamplesView block={block} />;
    case "breakdown":
      return <BreakdownView block={block} />;
    case "html":
      return <HtmlSandboxView block={block} />;
  }
}

export default function GenUIBlock({ source }: { source: string }) {
  const T = useT();
  const actions = useGenUIActions();
  const parsed = useMemo(() => parseUIBlock(source), [source]);
  const [copied, setCopied] = useState<"" | "rich" | "md">("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const full = actions.surface === "panel";

  if (!parsed.ok) {
    return (
      <div className="nui nui-invalid" data-nui-error={parsed.error}>
        <div className="nui-note">{T("组件数据不完整（可能仍在生成），已显示源码")}</div>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }
  // D300：发音 / 术语词条须出现在本次材料里（防弱模型照抄提示词示范）；一条不剩则整块不展示
  const block = groundBlock(parsed.block, actions.ground);
  if (!block) return null;
  const md = blockToMarkdown(block);
  const flash = (k: "rich" | "md") => {
    setCopied(k);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(""), 1400);
  };

  return (
    <figure className={`nui nui--${block.type}${full ? "" : " nui-compact"}`} data-nui-type={block.type}>
      {(full || block.title) && (
        <figcaption className="nui-head">
          {full && <span className="nui-kind mono">{T(KIND_LABEL[block.type])}</span>}
          {block.title && <span className="nui-title">{block.title}</span>}
        </figcaption>
      )}
      <div className="nui-body">
        <BlockView block={block} />
      </div>
      {full && (
        <div className="nui-toolbar" role="toolbar" aria-label={T(KIND_LABEL[block.type])}>
          <button type="button" className="nui-tool" onClick={() => void copyBlock(block, renderFormulaHtml(block)).then((ok) => ok && flash("rich"))}>
            {copied === "rich" ? T("已复制") : T("复制")}
          </button>
          <button type="button" className="nui-tool" onClick={() => void copyText(md).then((ok) => ok && flash("md"))}>
            {copied === "md" ? T("已复制") : T("复制 Markdown")}
          </button>
          <span className="nui-toolbar-gap" />
          {actions.insertToCard && (
            <button type="button" className="nui-tool" onClick={() => actions.insertToCard?.(md)}>
              {T("插入制卡面板")}
            </button>
          )}
          {actions.makeCards && (
            <button type="button" className="nui-tool nui-tool-primary" onClick={() => actions.makeCards?.(md)}>
              {T("就此制卡")}
            </button>
          )}
        </div>
      )}
    </figure>
  );
}
