// D299：白名单组件视图。只依赖 KaTeX（已有依赖）与原生 SVG，不引入图表库。
// 视觉语言＝瑞士风（docs/swiss-international-style.md）：发丝线分隔、直角（圆角走 --radius 交给皮肤）、
// 等宽小标签、强调色只用于数据与当前态；颜色 / 间距 / 字号 / 动效一律取主题 Token（样式在 genui.css）。
// 新增组件：spec.ts 加类型+校验+blockToMarkdown → clipboard.ts 加 blockToHtml → 这里加视图 → GenUIBlock 分支 →
// prompt.ts 加示例与适用场景 → decisions/specs.ts 加选项与本地规则（见设计稿 §4）。
import { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import DOMPurify from "dompurify";
import { useT } from "../../lib/i18n";
import {
  QUIZ_LETTERS,
  fmtSci,
  type AnalogyBlock,
  type BreakdownBlock,
  type ChartBlock,
  type CompareBlock,
  type ExamplesBlock,
  type FormulaBlock,
  type GlossaryBlock,
  type HtmlBlock,
  type PronounceBlock,
  type QuizBlock,
  type ScaleBlock,
  type StepsBlock,
  type TimelineBlock,
  type TreeBlock,
  type TreeNode
} from "../../lib/genui/spec";
import { speakForeign } from "../../lib/genui/speak";
import { IconVolume } from "../icons";

const KATEX_PURIFY = { USE_PROFILES: { html: true, svg: true, mathMl: true } };

function Tex({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(() => {
    try {
      // KaTeX（trust:false）已转义输入；插入页面前再过 DOMPurify 作纵深防御（f16 注入点纪律；保留 KaTeX 的 MathML / SVG）
      const raw = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false });
      return DOMPurify.isSupported ? DOMPurify.sanitize(raw, KATEX_PURIFY) : null;
    } catch {
      return null;
    }
  }, [tex, display]);
  if (html === null) return <code>{tex}</code>;
  return <span className={display ? "nui-tex-display" : "nui-tex-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function FormulaView({ block }: { block: FormulaBlock }) {
  return (
    <div className="nui-formula-body">
      <Tex tex={block.latex} display />
      {block.vars && (
        <dl className="nui-vars">
          {block.vars.map((v, i) => (
            <div key={i} className="nui-var">
              <dt>
                <Tex tex={v.symbol} display={false} />
              </dt>
              <dd>{v.meaning}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function CompareView({ block }: { block: CompareBlock }) {
  return (
    <div className="nui-scroll">
      <table className="nui-table">
        <thead>
          <tr>
            <th scope="col" className="nui-table-corner" />
            {block.entities.map((e, i) => (
              <th key={i} scope="col">
                <span className={`nui-swatch nui-c${i % 6}`} aria-hidden="true" />
                {e}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i}>
              <th scope="row">{r.dimension}</th>
              {r.values.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const W = 560;
const H = 220;
const PAD = { l: 44, r: 8, t: 12, b: 30 };

/** 「好看的」刻度步长：1 / 2 / 2.5 / 5 × 10^k，目标约 4 格 */
function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** 轴域与刻度：含 0、两端取步长整数倍（负值同样对齐，不会出现 -2 与 0 挤在一起） */
export function chartScale(values: number[]): { lo: number; hi: number; ticks: number[] } {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep(max - min || Math.abs(max) || 1);
  const hi = Math.ceil(max / step) * step || step;
  const lo = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t / step) * step);
  return { lo, hi, ticks };
}

/** 轴标签按字符（含中日文）截断，避免半个字 */
const clip = (s: string, n: number) => {
  const cs = [...s];
  return cs.length > n ? cs.slice(0, n - 1).join("") + "…" : s;
};

export function ChartView({ block }: { block: ChartBlock }) {
  const T = useT();
  const all = block.series.flatMap((s) => s.values);
  const { lo, hi, ticks } = chartScale(all);
  const span = hi - lo || 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ih - ((v - lo) / span) * ih;
  const n = block.labels.length;
  const band = iw / n;
  const fmt = (v: number) => (Math.abs(v) >= 10000 ? v.toExponential(1) : String(Math.round(v * 100) / 100));
  const labelMax = n > 12 ? 3 : n > 6 ? 5 : 8;
  const tip = (s: { name: string }, i: number, v: number) => `${s.name ? s.name + " · " : ""}${block.labels[i]}：${v}${block.unit ?? ""}`;
  return (
    <div className="nui-chart-wrap">
      <svg className="nui-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={block.title ?? T("图表")}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className={t === 0 ? "nui-baseline" : "nui-grid"} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="nui-axis">
              {fmt(t)}
            </text>
          </g>
        ))}
        {block.kind === "bar"
          ? block.series.map((s, si) => {
              const bw = (band * 0.64) / block.series.length;
              return s.values.map((v, i) => {
                const x = PAD.l + i * band + band * 0.18 + si * bw;
                return (
                  <rect key={`${si}-${i}`} x={x} y={y(Math.max(0, v))} width={Math.max(1, bw - 2)} height={Math.max(1, Math.abs(y(v) - y(0)))} className={`nui-fill nui-c${si}`}>
                    <title>{tip(s, i, v)}</title>
                  </rect>
                );
              });
            })
          : block.series.map((s, si) => (
              <g key={si}>
                <polyline fill="none" className={`nui-stroke nui-c${si}`} points={s.values.map((v, i) => `${PAD.l + i * band + band / 2},${y(v)}`).join(" ")} />
                {s.values.map((v, i) => (
                  <rect key={i} x={PAD.l + i * band + band / 2 - 3} y={y(v) - 3} width={6} height={6} className={`nui-fill nui-c${si}`}>
                    <title>{tip(s, i, v)}</title>
                  </rect>
                ))}
              </g>
            ))}
        {block.labels.map((l, i) => (
          <text key={i} x={PAD.l + i * band + band / 2} y={H - PAD.b + 18} textAnchor="middle" className="nui-axis">
            {clip(l, labelMax)}
          </text>
        ))}
      </svg>
      {(block.series.length > 1 || block.unit || block.note) && (
        <div className="nui-legend">
          {block.series.length > 1 &&
            block.series.map((s, i) => (
              <span key={i} className="nui-legend-item">
                <span className={`nui-swatch nui-c${i}`} aria-hidden="true" />
                {s.name}
              </span>
            ))}
          {block.unit && <span className="nui-legend-unit mono">{block.unit}</span>}
          {block.note && <span className="nui-legend-note">{block.note}</span>}
        </div>
      )}
    </div>
  );
}

const two = (i: number) => String(i + 1).padStart(2, "0");

export function StepsView({ block }: { block: StepsBlock }) {
  return (
    <ol className="nui-steps">
      {block.steps.map((s, i) => (
        <li key={i}>
          <span className="nui-step-no mono">{two(i)}</span>
          <div className="nui-step-text">
            <div className="nui-step-title">{s.title}</div>
            {s.detail && <div className="nui-step-detail">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function TimelineView({ block }: { block: TimelineBlock }) {
  return (
    <ol className="nui-timeline">
      {block.events.map((e, i) => (
        <li key={i}>
          <span className="nui-time mono">{e.time}</span>
          <span className="nui-tick" aria-hidden="true" />
          <div className="nui-step-text">
            <div className="nui-step-title">{e.title}</div>
            {e.detail && <div className="nui-step-detail">{e.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <li className={`nui-tree-node nui-tree-d${depth}`}>
      <div className="nui-tree-label">
        <span className="nui-tree-text">{node.label}</span>
        {node.note && <span className="nui-tree-note">{node.note}</span>}
      </div>
      {node.children?.length ? (
        <ul className="nui-tree-children">
          {node.children.map((c, i) => (
            <TreeItem key={i} node={c} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TreeView({ block }: { block: TreeBlock }) {
  return (
    <ul className="nui-tree">
      <TreeItem node={block.root} depth={0} />
    </ul>
  );
}

/** 误解自测：点选即判，标出对错并展开解析；不持久化（只是理解检查，不是复习事件） */
export function QuizView({ block }: { block: QuizBlock }) {
  const T = useT();
  const [picked, setPicked] = useState<number | null>(null);
  const done = picked !== null;
  const right = picked === block.answer;
  return (
    <div className="nui-quiz-body">
      <p className="nui-quiz-q">{block.question}</p>
      <div className="nui-quiz-opts" role="group" aria-label={block.question}>
        {block.options.map((o, i) => {
          const state = !done ? "" : i === block.answer ? " is-correct" : i === picked ? " is-wrong" : " is-muted";
          return (
            <button key={i} type="button" className={`nui-quiz-opt${state}`} disabled={done} aria-pressed={picked === i} onClick={() => setPicked(i)}>
              <span className="nui-quiz-letter mono">{QUIZ_LETTERS[i]}</span>
              <span className="nui-quiz-text">{o}</span>
            </button>
          );
        })}
      </div>
      {done && (
        <div className={`nui-quiz-result${right ? " is-correct" : " is-wrong"}`} role="status">
          <div className="nui-quiz-verdict">
            <span>{right ? T("答对了") : T("不对——正确答案已标出")}</span>
            <button type="button" className="nui-tool" onClick={() => setPicked(null)}>
              {T("重做")}
            </button>
          </div>
          {block.explain && <p className="nui-quiz-explain">{block.explain}</p>}
        </div>
      )}
    </div>
  );
}

// ---------- 第三轮组件（D299 实机反馈）：发音 / 术语 / 类比 / 量级 / 例子 / 句子拆解 ----------

/** 发音：点击朗读（系统 TTS）；音标始终显示（D300：不显示汉字谐音）。本机没有该语言语音时提示「近似」 */
export function PronounceView({ block }: { block: PronounceBlock }) {
  const T = useT();
  const [approx, setApprox] = useState<Record<number, boolean>>({});
  return (
    <ul className="nui-pron">
      {block.items.map((it, i) => (
        <li key={i} className="nui-pron-item">
          <button
            type="button"
            className="nui-pron-btn"
            title={T("朗读")}
            aria-label={`${T("朗读")} ${it.text}`}
            onClick={() => {
              const r = speakForeign(it.text, it.lang);
              setApprox((m) => ({ ...m, [i]: r === "approx" }));
            }}
          >
            <IconVolume size={16} />
          </button>
          <div className="nui-pron-main">
            <div className="nui-pron-head">
              <span className="nui-pron-word" lang={it.lang}>
                {it.text}
              </span>
              {it.ipa && <span className="nui-pron-ipa">/{it.ipa}/</span>}
            </div>
            {it.meaning && <div className="nui-step-detail">{it.meaning}</div>}
            {approx[i] && <div className="nui-note">{T("本机没有这种语言的语音，读音为近似，请以音标为准")}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function GlossaryView({ block }: { block: GlossaryBlock }) {
  return (
    <dl className="nui-gloss">
      {block.terms.map((t, i) => (
        <div key={i} className="nui-gloss-row">
          <dt>
            {t.term}
            {t.alias && <span className="nui-gloss-alias">{t.alias}</span>}
          </dt>
          <dd>{t.def}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AnalogyView({ block }: { block: AnalogyBlock }) {
  const T = useT();
  return (
    <div>
      <div className="nui-ana" role="table">
        <div className="nui-ana-row nui-ana-head" role="row">
          <span role="columnheader">{block.source}</span>
          <span className="nui-ana-arrow" aria-hidden="true" />
          <span role="columnheader">{block.target}</span>
        </div>
        {block.pairs.map((p, i) => (
          <div key={i} className="nui-ana-row" role="row">
            <span role="cell">{p.from}</span>
            <span className="nui-ana-arrow" aria-hidden="true">
              →
            </span>
            <span role="cell">{p.to}</span>
          </div>
        ))}
      </div>
      {block.limit && (
        <p className="nui-ana-limit">
          <span className="nui-chip nui-chip-warn">{T("类比到此为止")}</span>
          {block.limit}
        </p>
      )}
    </div>
  );
}

/** 量级：同一单位的对数标尺——每行一个参照物，刻度点的位置＝数量级 */
export function ScaleView({ block }: { block: ScaleBlock }) {
  const logs = block.items.map((i) => Math.log10(i.value));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo || 1;
  return (
    <ul className="nui-scale">
      {block.items.map((it, i) => (
        <li key={i} className="nui-scale-row">
          <span className="nui-scale-label">{it.label}</span>
          <span className="nui-scale-track" aria-hidden="true">
            <span className="nui-scale-fill" style={{ width: `${((logs[i] - lo) / span) * 100}%` }} />
          </span>
          <span className="nui-scale-value">
            {fmtSci(it.value)}
            {block.unit ? ` ${block.unit}` : ""}
          </span>
          {it.note && <span className="nui-scale-note">{it.note}</span>}
        </li>
      ))}
    </ul>
  );
}

export function ExamplesView({ block }: { block: ExamplesBlock }) {
  const T = useT();
  return (
    <ul className="nui-ex">
      {block.items.map((it, i) => (
        <li key={i} className="nui-ex-item">
          <span className={`nui-chip ${it.kind === "counter" ? "nui-chip-warn" : "nui-chip-ok"}`}>{it.kind === "counter" ? T("反例") : T("例子")}</span>
          <div className="nui-step-text">
            <div>{it.text}</div>
            {it.why && <div className="nui-step-detail">{it.why}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BreakdownView({ block }: { block: BreakdownBlock }) {
  return (
    <div>
      <blockquote className="nui-bd-sentence">{block.sentence}</blockquote>
      <ul className="nui-bd">
        {block.parts.map((p, i) => (
          <li key={i} className="nui-bd-part">
            <span className="nui-chip">{p.role}</span>
            <div className="nui-step-text">
              <div>{p.text}</div>
              {p.note && <div className="nui-step-detail">{p.note}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 沙箱（GUIDE §7.5）：独立沙箱页 public/nui-sandbox.html（自带 CSP：零网络、只放行内联脚本/样式；不经宿主 cspPlugin）。
// iframe 无 allow-same-origin（拿不到宿主 DOM、Node、存储、IPC 桥）；内容在 load 后经 postMessage 一次性下发。
// 不用 srcdoc / blob:——二者继承宿主 CSP（script-src 'self'，无 unsafe-inline），打包版脚本不会执行。
// 点击「运行」才加载（同站 iframe 可能与主渲染进程同进程，死循环会卡 UI）。
const sandboxUrl = () => new URL("nui-sandbox.html", document.baseURI).href;

/** 把宿主当前主题（皮肤 / 明暗）的几枚 Token 解析成具体值注入沙箱——iframe 无同源，读不到父页面变量 */
function sandboxThemeCss(): string {
  if (typeof document === "undefined") return "";
  const cs = getComputedStyle(document.body);
  const v = (name: string) => cs.getPropertyValue(name).trim().replace(/[<>{};]/g, "");
  const pairs: [string, string][] = [
    ["--fg", v("--text-primary")],
    ["--fg-2", v("--text-secondary")],
    ["--bg", v("--surface-card")],
    ["--line", v("--border-subtle")],
    ["--accent", v("--accent")],
    ["--font", v("--font-sans")]
  ];
  const decl = pairs.filter(([, val]) => val).map(([k, val]) => `${k}:${val}`).join(";");
  return `:root{${decl};color-scheme:${cs.colorScheme || "normal"}}html,body{margin:0;background:transparent;color:var(--fg);font:14px/1.6 var(--font,system-ui,sans-serif)}body{padding:8px}a{color:var(--accent)}`;
}

export function HtmlSandboxView({ block }: { block: HtmlBlock }) {
  const T = useT();
  const [run, setRun] = useState(false);
  const [height, setHeight] = useState(block.height ?? 320);
  const ref = useRef<HTMLIFrameElement>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (!run) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const h = Number((e.data as { nuiHeight?: unknown })?.nuiHeight);
      if (Number.isFinite(h)) setHeight(Math.min(900, Math.max(120, h)));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [run]);
  if (!run) {
    return (
      <div className="nui-html-gate">
        <span className="nui-note">{T("AI 生成的交互组件（沙箱隔离、无网络）")}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRun(true)}>
          {T("运行")}
        </button>
      </div>
    );
  }
  const send = () => {
    if (sent.current) return; // 沙箱页写入新文档后 iframe 会再触发 load，只下发一次
    sent.current = true;
    ref.current?.contentWindow?.postMessage({ nuiRender: { html: block.html, css: sandboxThemeCss() } }, "*");
  };
  return <iframe ref={ref} className="nui-iframe" sandbox="allow-scripts" src={sandboxUrl()} onLoad={send} style={{ height }} title={block.title ?? "nui-html"} />;
}
