// 结构全景 · 焦点节点卡（D254 v2；docs/design/STRUCTURE-ATLAS-D254.md §6）。
// 浮在焦点字形下方 8px；动作行 + 讲解 + 详情；复用随文结构的 .flow-actions / .flow-explain / .flow-dots / .flow-status。
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { GraphState, PatternKey, V2Node } from "../../../lib/mindmap/v2/types";
import { PATTERN_KEYS, ROOT_ID } from "../../../lib/mindmap/v2/types";
import { PATTERN_LABEL } from "../../../lib/flow/layout";
import { REL_STYLE } from "../../../lib/mindmap/v2/route";
import { edgesOf } from "../../../lib/mindmap/v2/graph";
import { mindmapV2Api, type GraphNodeText } from "../../../lib/mindmapV2";
import { useT } from "../../../lib/i18n";
import { FLOW } from "../../../lib/flow/layout";
import { atlasApi, atlasGloss, atlasLabel, type AtlasNode } from "../../../lib/atlas";
import { isImeComposing } from "../../../lib/ime";
import AtlasMissHint from "../../kg/AtlasMissHint";

const STATE_LABEL: Record<string, string> = {
  more: "可深挖",
  open: "已展开",
  floor: "已触底",
  stub: "其余部分（可深挖）",
  streaming: "正在生成",
};

export interface AtlasCardProps {
  graph: GraphState;
  mapId: string | null;
  node: V2Node;
  isRoot: boolean;
  preview: boolean;
  explainText: string | null;
  explainBusy: boolean;
  explainOpen: boolean;
  onToggleExplain: () => void;
  detailOpen: boolean;
  onToggleDetail: () => void;
  learnStatus: { cardCount: number; kpExists: boolean } | null;
  canMakeCards: boolean;
  expanded: boolean;
  delay: number;
  onJump: () => void;
  onDeepen: (force?: boolean) => void;
  onMakeCards: () => void;
  onToggleFold: () => void;
  onFocusNode: (id: string) => void;
  onSetPattern: (id: string, key: PatternKey | null) => void;
  /** v49.146（T4）：本节点的全谱挂靠；点击 → 打开图谱 */
  links?: { atlasId: string; label: string | null; source: string }[];
  onOpenGraph?: (atlasId: string) => void;
  /** D314 修订：手动改挂靠——on=true 加（来源记为用户）；on=false 移除 */
  onSetLink?: (atlasId: string, on: boolean) => void;
  /** v49.170 / D340：原文术语投影——本节点原文「讲了 / 用到」的术语（每条都有逐字引句） */
  terms?: NodeTerms | null;
  onRejectTerm?: (termId: string) => void;
  /** 低密度单元：仍要分析这段的术语 */
  onForceTerms?: () => void;
  /** 根节点：作品 / 作者在全谱里的对应（文学材料的知识对象是作品本身） */
  documentId?: string;
}

export interface SourceTerm {
  termId: string;
  surface: string;
  atlasId: string | null;
  label: string;
  role: string;
  quote: string;
  linkState: string;
}
export interface NodeTerms {
  nodeId: string;
  unitAnchor?: string | null;
  lowDensity?: boolean;
  taught: SourceTerm[];
  used: SourceTerm[];
}

export default function AtlasCard(p: AtlasCardProps) {
  const T = useT();
  const { node } = p;
  const streaming = node.state === "streaming";
  const canDeepen = !p.preview && (node.state === "more" || node.state === "stub");
  const canJump = node.blockStart != null;
  const canExplain = node.blockStart != null && !streaming;
  const acts: ReactNode[] = [];
  const sep = (k: string) => <span key={k} aria-hidden="true">·</span>;
  if (canJump) acts.push(<button key="jump" type="button" data-atlas-act="jump" onClick={p.onJump}>{T("跳到原文")}</button>);
  if (canExplain) acts.push(<button key="explain" type="button" data-atlas-act="explain" onClick={p.onToggleExplain}>{p.explainOpen ? T("收起讲解") : T("讲解")}</button>);
  if (canDeepen) acts.push(<button key="deepen" type="button" data-atlas-act="deepen" onClick={() => p.onDeepen(false)}>{T("深挖")}</button>);
  if (p.canMakeCards && !streaming) acts.push(<button key="cards" type="button" data-atlas-act="cards" onClick={p.onMakeCards}>{T("制卡")}</button>);
  acts.push(<button key="detail" type="button" data-atlas-act="detail" onClick={p.onToggleDetail}>{p.detailOpen ? T("收起详情") : T("详情")}</button>);

  return (
    <div className="atlas-card" data-atlas-card={node.id} style={{ "--flow-delay": `${p.delay}ms` } as unknown as CSSProperties}>
      <div className="flow-actions">
        {acts.map((a, i) => (
          <span key={i} className="atlas-card-act">{i ? sep(`s${i}`) : null}{a}</span>
        ))}
        {p.preview && (node.state === "more" || node.state === "stub") ? <span className="atlas-card-hint">{T("生成导图后可以继续深挖")}</span> : null}
      </div>
      {p.isRoot && p.documentId && !p.preview ? <WorkAnchor documentId={p.documentId} onOpenGraph={p.onOpenGraph} /> : null}
      <AtlasTerms terms={p.terms} onOpenGraph={p.onOpenGraph} onReject={p.preview ? undefined : p.onRejectTerm} onForce={p.preview ? undefined : p.onForceTerms} />
      {(p.links && p.links.length > 0 && p.onOpenGraph) || (p.onSetLink && !p.preview) ? (
        <div className="atlas-card-links" data-atlas-links={p.links?.length ?? 0}>
          {p.links && p.links.length > 0 ? <span className="atlas-terms-k">{T("我挂的")}</span> : null}
          {(p.links || []).map((l) => (
            <span key={l.atlasId}>
              {p.onOpenGraph ? (
                <button type="button" title={T("在知识图谱中查看")} onClick={() => p.onOpenGraph!(l.atlasId)}>{l.label || l.atlasId}</button>
              ) : (
                <span>{l.label || l.atlasId}</span>
              )}
              {p.onSetLink ? (
                <button type="button" className="atlas-link-x" aria-label={T("移除")} title={T("移除这条挂靠")} onClick={() => p.onSetLink!(l.atlasId, false)}>×</button>
              ) : null}
            </span>
          ))}
          {p.onSetLink && !p.preview ? <AddLink onPick={(id) => p.onSetLink!(id, true)} /> : null}
        </div>
      ) : null}
      {p.explainOpen ? (
        <div className="flow-explain" style={{ maxHeight: FLOW.EXPLAIN_MAX_H }}>
          {p.explainBusy && !p.explainText ? <span className="flow-dots" aria-label={T("正在生成…")}><i /><i /><i /></span> : null}
          {p.explainText ? <span>{p.explainText}</span> : p.explainBusy ? null : <span className="flow-explain-empty">{T("还没有讲解")}</span>}
        </div>
      ) : null}
      {p.detailOpen ? (
        <AtlasDetail
          graph={p.graph}
          mapId={p.mapId}
          node={node}
          isRoot={p.isRoot}
          learnStatus={p.learnStatus}
          onFocusNode={p.onFocusNode}
          onSetPattern={p.onSetPattern}
          onDeepen={p.onDeepen}
        />
      ) : null}
    </div>
  );
}

const ROLE_TEXT: Record<string, string> = { defines: "定义", explains: "解释", argues: "论证", instance: "实例", uses: "依据" };

/** v49.170 / D340：「讲了 / 用到」两行。已对上全谱＝实下划线（点开看图谱）；待确认＝点状下划线；只在本书里＝不带下划线。
 *  悬停 / 聚焦显示逐字引句；× 只在悬停或聚焦时出现（.reveal-on-hover，触控可经聚焦触达）。 */
function AtlasTerms({ terms, onOpenGraph, onReject, onForce }: { terms?: NodeTerms | null; onOpenGraph?: (atlasId: string) => void; onReject?: (termId: string) => void; onForce?: () => void }) {
  const T = useT();
  if (!terms) return null;
  const rows: [string, "taught" | "used", SourceTerm[]][] = [
    ["讲了", "taught", terms.taught],
    ["用到", "used", terms.used]
  ];
  const any = terms.taught.length + terms.used.length > 0;
  if (!any && !(terms.lowDensity && onForce)) return null;
  return (
    <div className="atlas-terms" data-atlas-terms={terms.taught.length}>
      {rows.map(([k, role, list]) =>
        list.length ? (
          <div key={role} className="atlas-terms-row" data-role={role}>
            <span className="atlas-terms-k">{T(k)}</span>
            <span className="atlas-terms-v">
              {list.map((t) => {
                const state = t.atlasId ? (t.linkState === "linked" || t.linkState === "user" ? "linked" : "pending") : "local";
                const tip = `${T(ROLE_TEXT[t.role] ?? t.role)}｜「${t.quote}」${state === "pending" ? T("（全谱对照待确认）") : ""}`;
                return (
                  <span key={t.termId} className={`atlas-term is-${state}`}>
                    {t.atlasId && onOpenGraph ? (
                      <button type="button" className="atlas-term-name" title={tip} onClick={() => onOpenGraph(t.atlasId!)}>{t.label || t.surface}</button>
                    ) : (
                      <span className="atlas-term-name" title={tip} tabIndex={0}>{t.label || t.surface}</span>
                    )}
                    {onReject ? (
                      <button type="button" className="atlas-term-x reveal-on-hover" aria-label={T("这不是本段讲的术语")} title={T("这不是本段讲的术语")} onClick={() => onReject(t.termId)}>×</button>
                    ) : null}
                  </span>
                );
              })}
            </span>
          </div>
        ) : null
      )}
      {terms.lowDensity && onForce ? (
        <div className="atlas-terms-row">
          <span className="atlas-terms-k" />
          <button type="button" className="atlas-terms-force" onClick={onForce}>{T("仍要分析这段的术语")}</button>
        </div>
      ) : null}
    </div>
  );
}

type WorkCand = { id: string; label: string; gloss: string; kind: "work" | "person" };
type WorkProposal = { works: WorkCand[]; persons: WorkCand[]; confirmed: { surface: string; atlasId: string | null; linkState: string }[] };
type WorkApi = {
  workAnchor?(documentId: string): Promise<WorkProposal | null>;
  workAnchorConfirm?(documentId: string, atlasId: string | null, surface: string): Promise<unknown>;
};

/** v49.170 / D340：作品级挂靠——书名 / 作者在全谱里精确命中时问一次「是它吗」；确认后读完一章就是「读过这部作品」的证据 */
function WorkAnchor({ documentId, onOpenGraph }: { documentId: string; onOpenGraph?: (atlasId: string) => void }) {
  const T = useT();
  const [prop, setProp] = useState<WorkProposal | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const api = (window as unknown as { kgAPI?: WorkApi }).kgAPI;
    void api?.workAnchor?.(documentId).then((r) => alive && setProp(r ?? null)).catch(() => alive && setProp(null));
    return () => {
      alive = false;
    };
  }, [documentId, tick]);
  if (!prop) return null;
  const decided = new Set(prop.confirmed.map((c) => c.surface));
  const confirmed = prop.confirmed.filter((c) => c.atlasId && c.linkState === "user");
  const groups: [string, WorkCand[]][] = [
    ["作品", prop.works.filter((w) => !decided.has(w.label))],
    ["作者", prop.persons.filter((w) => !decided.has(w.label))]
  ];
  const confirm = async (atlasId: string | null, surface: string) => {
    await (window as unknown as { kgAPI?: WorkApi }).kgAPI?.workAnchorConfirm?.(documentId, atlasId, surface).catch(() => null);
    setTick((n) => n + 1);
  };
  const pending = groups.filter(([, l]) => l.length > 0);
  if (!confirmed.length && !pending.length) return null;
  return (
    <div className="atlas-terms atlas-work" data-atlas-work>
      {confirmed.map((c) => (
        <div key={c.atlasId!} className="atlas-terms-row">
          <span className="atlas-terms-k">{T("全谱")}</span>
          <span className="atlas-terms-v">
            <span className="atlas-term is-linked">
              {onOpenGraph ? <button type="button" className="atlas-term-name" onClick={() => onOpenGraph(c.atlasId!)}>{c.surface}</button> : <span className="atlas-term-name">{c.surface}</span>}
            </span>
          </span>
        </div>
      ))}
      {pending.map(([k, list]) => (
        <div key={k} className="atlas-terms-row">
          <span className="atlas-terms-k">{T(k)}</span>
          <span className="atlas-terms-v atlas-work-ask">
            {list.map((w) => (
              <button key={w.id} type="button" className="atlas-work-pick" title={w.gloss || undefined} onClick={() => void confirm(w.id, w.label)}>
                {T("是《{name}》", { name: w.label })}
              </button>
            ))}
            <button type="button" className="atlas-terms-force" onClick={() => void Promise.all(list.map((w) => confirm(null, w.label)))}>{T("都不是")}</button>
          </span>
        </div>
      ))}
    </div>
  );
}

function AtlasDetail(p: {
  graph: GraphState;
  mapId: string | null;
  node: V2Node;
  isRoot: boolean;
  learnStatus: { cardCount: number; kpExists: boolean } | null;
  onFocusNode: (id: string) => void;
  onSetPattern: (id: string, key: PatternKey | null) => void;
  onDeepen: (force?: boolean) => void;
}) {
  const T = useT();
  const { graph, node } = p;
  const [text, setText] = useState<GraphNodeText | null>(null);
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    if (!p.mapId) {
      setText(null);
      return;
    }
    let alive = true;
    setText(null);
    mindmapV2Api
      .nodeText(p.mapId, node.id)
      .then((r) => alive && setText(r))
      .catch(() => alive && setText(null));
    return () => {
      alive = false;
    };
  }, [p.mapId, node.id, node.blockStart, node.blockEnd]);

  const gid = p.isRoot ? ROOT_ID : node.id;
  const kids = graph.children[gid] ?? [];
  const rels = p.isRoot ? [] : edgesOf(graph, node.id);
  const manual = graph.view.patterns[gid] ?? null;
  const titleOf = (id: string) => graph.nodes[id]?.title ?? id;

  return (
    <div className="atlas-detail">
      <p className="atlas-detail-meta">
        {T(String(node.type))}
        {node.timeText ? ` · ${node.timeText}` : ""} · {T(STATE_LABEL[node.state] ?? node.state)}
        {node.source === "v1ext" ? ` · ${T("旧版")}` : ""}
      </p>
      {p.learnStatus ? (
        <p className="atlas-detail-meta">
          {T("已有 {n} 张卡", { n: p.learnStatus.cardCount })}
          {p.learnStatus.kpExists ? ` · ${T("知识点已存在")}` : ""}
        </p>
      ) : null}
      {rels.length > 0 ? (
        <ul className="atlas-rel-list">
          {rels.map((e) => {
            const out = e.from === node.id;
            const other = out ? e.to : e.from;
            const name = T(REL_STYLE[e.code]?.name ?? e.code);
            return (
              <li key={`${e.from}|${e.to}|${e.code}`}>
                <button type="button" onClick={() => p.onFocusNode(other)}>
                  {out ? T("本节点 {rel} → {title}", { rel: name, title: titleOf(other) }) : T("{title} {rel} → 本节点", { rel: name, title: titleOf(other) })}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {kids.length > 1 ? (
        <label className="atlas-detail-row">
          <span>{T("排列方式")}</span>
          <select className="atlas-select" value={manual ?? ""} onChange={(e) => p.onSetPattern(gid, (e.target.value || null) as PatternKey | null)}>
            <option value="">{T("自动")}</option>
            {PATTERN_KEYS.map((k) => (
              <option key={k} value={k}>{T(PATTERN_LABEL[k])}</option>
            ))}
          </select>
        </label>
      ) : null}
      {text?.text ? (
        <button type="button" className="atlas-link-btn" onClick={() => setShowText((v) => !v)}>
          {showText ? T("收起原文") : T("查看对应原文（{n} 字）", { n: text.text.length })}
        </button>
      ) : null}
      {showText && text?.text ? <blockquote className="atlas-source">{text.text.length > 4000 ? text.text.slice(0, 4000) + "…" : text.text}</blockquote> : null}
      {node.state === "floor" && !p.isRoot && node.blockStart != null ? (
        <button type="button" className="atlas-link-btn" onClick={() => p.onDeepen(true)}>{T("仍要尝试深挖")}</button>
      ) : null}
    </div>
  );
}

/** D314 修订：手动给节点添加全谱挂靠——小搜索框（经 atlas:search，本地没有时同时查在线）→ 点结果即挂 */
function AddLink({ onPick }: { onPick: (atlasId: string) => void }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AtlasNode[]>([]);
  const [done, setDone] = useState(false);
  const seq = useRef(0);
  const reset = () => {
    setOpen(false);
    setQ("");
    setHits([]);
    setDone(false);
  };
  const run = async () => {
    const t = q.trim();
    if (!t) return;
    const my = ++seq.current;
    setDone(false);
    const r = (await atlasApi()?.atlasSearch(t, { limit: 8 }).catch(() => [] as AtlasNode[])) || [];
    if (my !== seq.current) return;
    setHits(r);
    setDone(true);
  };
  if (!open) return <button type="button" data-atlas-act="add-link" onClick={() => setOpen(true)}>{T("添加")}</button>;
  return (
    <span className="atlas-add-link" data-atlas-add-link>
      <input
        autoFocus
        className="atlas-add-link-input"
        value={q}
        aria-label={T("搜索全谱")}
        placeholder={T("搜索全谱")}
        onChange={(e) => { setQ(e.target.value); setDone(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isImeComposing(e)) void run();
        }}
      />
      <button type="button" onClick={reset}>{T("取消")}</button>
      {hits.length > 0 ? (
        <span className="atlas-add-link-hits">
          {hits.map((h) => (
            <button key={h.id} type="button" data-atlas-add-hit={h.id} title={atlasGloss(h) || T(h.kindLabel)} onClick={() => { onPick(h.id); reset(); }}>
              {atlasLabel(h)}
            </button>
          ))}
        </span>
      ) : null}
      <AtlasMissHint show={done && hits.length === 0} className="atlas-card-hint" />
    </span>
  );
}
