// v49.148 / D317 知识图谱连线分三层（设计 docs/design/KG-EDGE-LAYERS.md §4 / §6）：
//   EdgePanel  —— 点开一条线：两端、三层证据（带出处）、确认 / 改类型 / 解除
//   LinkCard   —— 图上拖线松手后：一句话说明 + 类型，Enter 完成
//   LinkSearch —— 拖线松在空白处：搜索知识点再连
//   ExplainInput —— 一句话输入（统一编辑组件 MarkdownEditor；Enter / Ctrl+Enter 提交前先判断输入法组字）
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/ime";
import { kgApi, type ConnectResult, type DismissUndo, type EdgeAnchor, type EdgeEvidence, type GraphNode } from "../../lib/kg";
import { relationLabel } from "../../lib/knowledge";
import MarkdownEditor, { type MarkdownEditorApi } from "../editor/MarkdownEditor";

/** 图上可选的关系类型（结构类比需要结构说明，不在这里建） */
export const PAIR_TYPES = ["related_to", "prerequisite", "part_of", "contrasts_with", "example_of", "application_of", "generalization_of", "specialization_of"] as const;
const CARD_TYPES = ["related_to", "prerequisite", "part_of", "contrasts_with", "example_of", "application_of"] as const;
const UNDIRECTED = new Set(["related_to", "contrasts_with"]);

export interface KgToast {
  text: string;
  undo?: () => Promise<unknown>;
  /** 只有全谱证据的线被解除时：附「报告全谱错误」 */
  reportAtlasId?: string | null;
}

type JumpToDoc = (docId: string, anchor: NonNullable<EdgeAnchor>, kpId: string) => void;
type OpenMap = (documentId: string, mapId: string, nodeId: string) => void;

const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** 一句话输入：Enter（submitOnEnter）或 Ctrl/Cmd+Enter 提交；Esc 放弃（一次性输入面） */
export function ExplainInput({ placeholder, onSubmit, onCancel, submitOnEnter, autoFocus, submitLabel, busy }: { placeholder: string; onSubmit: (text: string) => void; onCancel?: () => void; submitOnEnter?: boolean; autoFocus?: boolean; submitLabel?: string; busy?: boolean }) {
  const T = useT();
  const apiRef = useRef<MarkdownEditorApi | null>(null);
  const want = useRef(false);
  const latest = useRef("");
  const submit = () => {
    want.current = true;
    apiRef.current?.commit();
    // commit 无变更时回调 null：同步兜底
    if (want.current) {
      want.current = false;
      onSubmit(latest.current.trim());
    }
  };
  return (
    <div className="kg-explain">
      <MarkdownEditor
        ref={apiRef}
        value=""
        variant="compact"
        toolbar={false}
        minRows={2}
        placeholder={placeholder}
        ariaLabel={placeholder}
        commitOnUnmount={false}
        onChange={(t) => {
          latest.current = t;
        }}
        onCommit={(t) => {
          // 失焦也会提交（编辑契约）：先记下文本，点「完成」时 commit 已是空操作，走下面的同步兜底
          if (t != null) latest.current = t;
          if (!want.current) return;
          want.current = false;
          onSubmit(latest.current.trim());
        }}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (submitOnEnter && !e.shiftKey))) {
            e.preventDefault();
            submit();
          }
        }}
        onEscape={() => onCancel?.()}
        onReady={() => {
          if (autoFocus) apiRef.current?.focusEnd();
        }}
      />
      {submitLabel && (
        <div className="kg-explain-acts">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={submit}>{submitLabel}</button>
          {onCancel && <button className="btn btn-outline btn-sm" onClick={onCancel}>{T("取消")}</button>}
        </div>
      )}
    </div>
  );
}

function TypeSelect({ value, onChange, disabled }: { value: string; onChange: (t: string) => void; disabled?: boolean }) {
  const T = useT();
  return (
    <select className="kg-speed" value={value} disabled={disabled} aria-label={T("关系类型")} onChange={(e) => onChange(e.target.value)}>
      {PAIR_TYPES.map((t) => (
        <option key={t} value={t}>{T(relationLabel(t))}</option>
      ))}
    </select>
  );
}

const fmtDate = (t: number) => (t ? new Date(t).toLocaleDateString() : "");

/** 点开一条线：关系面板 */
export function EdgePanel({ a, b, nodes, onClose, onJump, onChanged, onToast, onJumpToDoc, onOpenMap }: {
  a: string;
  b: string;
  nodes: GraphNode[];
  onClose: () => void;
  onJump: (id: string) => void;
  onChanged: () => void;
  onToast: (t: KgToast) => void;
  onJumpToDoc?: JumpToDoc;
  onOpenMap?: OpenMap;
}) {
  const T = useT();
  const api = kgApi();
  const [ev, setEv] = useState<EdgeEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [selType, setSelType] = useState<string>("related_to");
  const load = useCallback(async () => {
    try {
      const r = (await api?.edgeEvidence(a, b)) ?? null;
      setEv(r);
      const t = r?.confirmed[0]?.type || r?.inferred?.type || "related_to";
      setSelType((PAIR_TYPES as readonly string[]).includes(t) ? t : "related_to");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api, a, b]);
  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  const label = useCallback((id: string) => (ev && (ev.a.id === id ? ev.a.label : ev.b.id === id ? ev.b.label : "")) || nodes.find((n) => n.id === id)?.label || "", [ev, nodes]);
  const atlasOf = useCallback((id: string) => nodes.find((n) => n.id === id)?.atlasId ?? null, [nodes]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!api) return null;
  const conf = ev?.confirmed[0] ?? null;
  const dir = conf ? { from: conf.from, to: conf.to } : ev?.inferred ? { from: ev.inferred.from, to: ev.inferred.to } : { from: a, to: b };
  const curType = conf?.type || ev?.inferred?.type || selType;
  const explained = !!ev?.mine.some((m) => m.kind === "explain");

  const confirm = (type: string, explanation?: string) =>
    run(async () => {
      const r: ConnectResult = await api.connectPair({ fromId: dir.from, toId: dir.to, type, explanation, source: "kg_edge_panel" });
      onToast({ text: T("已确认这条关系"), undo: r.created ? () => api.undoConnect(r.undo) : undefined });
      onChanged();
      await load();
    });
  const dismiss = () =>
    run(async () => {
      const r: { undo: DismissUndo; worldOnly: boolean } = await api.dismissPair(a, b);
      onToast({ text: T("已解除这条线；出现新的证据时它会以淡色重新出现"), undo: () => api.undoDismiss(r.undo), reportAtlasId: r.worldOnly ? atlasOf(a) || atlasOf(b) : null });
      onChanged();
      onClose();
    });
  const explain = (text: string) => {
    if (!text) return;
    if (!conf) return void confirm(selType, text);
    void run(async () => {
      await api.explainPair({ kpId: dir.from, relatedKpId: dir.to, text, source: "kg_edge_panel" });
      onChanged();
      await load();
    });
  };

  const NodeLink = ({ id }: { id: string }) => (
    <button className="kg-link" onClick={() => onJump(id)}>{label(id)}</button>
  );
  const Fresh = ({ on }: { on: boolean }) => (on ? <span className="kg-new">{T("新")}</span> : null);
  const sec = (title: string, body: ReactNode, empty: string, testid: string) => (
    <section data-testid={testid}>
      <div className="kg-sec-title">{T(title)}</div>
      {body ?? <div className="kp-muted">{T(empty)}</div>}
    </section>
  );

  return (
    <aside className="kg-detail" data-testid="kg-edge-panel">
      <div className="kg-detail-head">
        <h3 className="kg-edge-head">
          <NodeLink id={dir.from} />
          <span className="kg-edge-arrow">{UNDIRECTED.has(curType) ? "—" : "→"}</span>
          <NodeLink id={dir.to} />
        </h3>
        <button className="icon-btn" onClick={onClose} aria-label={T("关闭")}>✕</button>
      </div>
      {loading || !ev ? (
        <div className="kp-muted">{loading ? T("正在读取证据…") : err || T("这两个知识点之间还没有证据")}</div>
      ) : (
        <>
          <div className="kg-detail-meta" data-testid="kg-edge-state">
            <span>{T(relationLabel(curType))}</span>
            <span>{ev.state === "confirmed" ? T("已确认") : T("推断")}</span>
            {ev.state === "confirmed" && !explained && <span className="kg-unexplained">{T("未说明")}</span>}
          </div>
          {ev.dismissal && (
            <div className="kg-resurfaced" data-testid="kg-edge-resurfaced">
              {T("你在 {d} 解除过这条线（共 {n} 次）。之后出现了新的证据，标「新」的就是。", { d: fmtDate(ev.dismissal.at), n: ev.dismissal.count })}
            </div>
          )}
          {sec(
            "你的话",
            ev.mine.length ? (
              <ul className="kg-evid">
                {ev.mine.map((m, i) => (
                  <li key={i}>
                    <Fresh on={m.isNew} />
                    {m.kind === "explain" && (
                      <>
                        <div className="kg-evid-text">{m.text}</div>
                        <small>{fmtDate(m.ts)}{m.rating ? ` · ${T(m.rating === "clear" ? "清楚" : m.rating === "partial" ? "部分" : "卡住")}` : ""}</small>
                      </>
                    )}
                    {m.kind === "annotation" && (
                      <>
                        <div className="kg-evid-text">{T("你在批注里写过：")}{m.text}</div>
                        {m.anchor && onJumpToDoc ? (
                          <button className="kg-link" onClick={() => onJumpToDoc(m.documentId, m.anchor!, a)}>{m.title || T("跳转原文")}</button>
                        ) : (
                          <small>{m.title}</small>
                        )}
                      </>
                    )}
                    {m.kind === "def" && (
                      <>
                        <div className="kg-evid-text">{T("你写的定义（{x}）：", { x: label(m.kpId) })}{m.text}</div>
                        <small>{fmtDate(m.ts)}</small>
                      </>
                    )}
                    {m.kind === "card" && <div className="kg-evid-text">{T("你写的卡片里提到")}</div>}
                  </li>
                ))}
              </ul>
            ) : null,
            "你还没有写过它们的关系",
            "kg-edge-mine"
          )}
          {!explained && (
            <ExplainInput placeholder={T("用一句话说说它们的关系")} submitLabel={conf ? T("保存说明") : T("保存并确认")} busy={busy} onSubmit={explain} />
          )}
          {sec(
            "读过的材料",
            ev.material.length || ev.ai.length || ev.text?.length || ev.cardText?.length ? (
              <ul className="kg-evid">
                {ev.material.map((m, i) => (
                  <li key={"m" + i}>
                    <Fresh on={m.isNew} />
                    {m.kind === "extract" ? (
                      <>
                        <div className="kg-evid-text">{T("你的摘录：")}{m.snippet}</div>
                        {m.anchor && onJumpToDoc ? <button className="kg-link" onClick={() => onJumpToDoc(m.documentId, m.anchor!, a)}>{m.title || T("跳转原文")}</button> : <small>{m.title}</small>}
                      </>
                    ) : (
                      <>
                        <div className="kg-evid-text">{T("导图：")}{m.path.filter(Boolean).join(" › ")}</div>
                        {onOpenMap ? <button className="kg-link" onClick={() => onOpenMap(m.documentId, m.mapId, m.nodeId)}>{m.title || T("打开导图")}</button> : <small>{m.title}</small>}
                      </>
                    )}
                  </li>
                ))}
                {ev.ai.map((j, i) => (
                  <li key={"ai" + i}>
                    <Fresh on={j.isNew} />
                    <div className="kg-evid-text">{T("AI 认为是「{t}」，依据：", { t: T(relationLabel(j.type)) })}『{j.quote}』</div>
                    <small>{T("AI 推断，需要你确认")}</small>
                  </li>
                ))}
                {(ev.text ?? []).map((m, i) => (
                  <li key={"t" + i}>
                    <Fresh on={m.isNew} />
                    <div className="kg-evid-text">{T("摘录原文同时提到两者：")}{m.snippet}</div>
                    {m.anchor && m.documentId && onJumpToDoc ? (
                      <button className="kg-link" onClick={() => onJumpToDoc(m.documentId!, m.anchor!, a)}>{m.title || T("跳转原文")}</button>
                    ) : (
                      <small>{m.title}</small>
                    )}
                  </li>
                ))}
                {(ev.cardText ?? []).map((m, i) => (
                  <li key={"c" + i}>
                    <Fresh on={m.isNew} />
                    <div className="kg-evid-text">{T("AI 写的卡片里提到")}</div>
                  </li>
                ))}
              </ul>
            ) : null,
            "读过的材料里还没有把它们放在一起",
            "kg-edge-material"
          )}
          {sec(
            "知识全谱",
            ev.world.length ? (
              <ul className="kg-evid">
                {ev.world.map((w, i) => (
                  <li key={i}>
                    <div className="kg-evid-text">
                      {w.pred
                        ? T("全谱：{a} 与 {b}——{p}", { a: label(w.from), b: label(w.to), p: w.pred })
                        : `${label(w.from)} · ${T(relationLabel(w.type))} · ${label(w.to)}`}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null,
            "全谱里没有直接关系",
            "kg-edge-world"
          )}
          <div className="kg-actions" data-testid="kg-edge-actions">
            {conf ? (
              <>
                <TypeSelect value={conf.type} disabled={busy} onChange={(t) => void run(async () => { await api.updateRelation(conf.id, { type: t }); onChanged(); await load(); })} />
                {!UNDIRECTED.has(conf.type) && (
                  <button className="btn btn-outline btn-sm" disabled={busy} title={T("反转方向")} aria-label={T("反转方向")} onClick={() => void run(async () => { await api.updateRelation(conf.id, { reverse: true }); onChanged(); await load(); })}>⇄</button>
                )}
              </>
            ) : (
              <>
                <TypeSelect value={selType} disabled={busy} onChange={setSelType} />
                <button className="btn btn-primary btn-sm" disabled={busy} data-testid="kg-edge-confirm" onClick={() => void confirm(selType)}>{T("确认")}</button>
              </>
            )}
            <button className="btn btn-outline btn-sm" disabled={busy} data-testid="kg-edge-dismiss" onClick={() => void dismiss()}>{T("解除")}</button>
          </div>
          {err && <p className="kgv-err">{err}</p>}
        </>
      )}
    </aside>
  );
}

/** 拖线松手后的连线卡片 */
export function LinkCard({ from, to, x, y, nodes, onDone, onCancel }: { from: string; to: string; x: number; y: number; nodes: GraphNode[]; onDone: (r: ConnectResult, text: string) => void; onCancel: () => void }) {
  const T = useT();
  const api = kgApi();
  const [type, setType] = useState<string>("related_to");
  const [dir, setDir] = useState<[string, string]>([from, to]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const name = (id: string) => nodes.find((n) => n.id === id)?.label ?? "";
  const submit = async (text: string) => {
    if (!api || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.connectPair({ fromId: dir[0], toId: dir[1], type, explanation: text || undefined, source: "kg_drag_link" });
      onDone(r, text);
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <div className="kg-pop is-open kg-linkcard" style={{ left: x, top: y }} data-testid="kg-linkcard" onPointerDown={(e) => e.stopPropagation()}>
      <div className="kg-linkcard-head">
        <b>{name(dir[0])}</b>
        <span className="kg-edge-arrow">{UNDIRECTED.has(type) ? "—" : "→"}</span>
        <b>{name(dir[1])}</b>
        {!UNDIRECTED.has(type) && (
          <button className="kg-textbtn" title={T("反转方向")} aria-label={T("反转方向")} onClick={() => setDir(([p, q]) => [q, p])}>⇄</button>
        )}
      </div>
      <ExplainInput placeholder={T("它们的关系是……（可以不写，按 Enter 完成）")} submitOnEnter autoFocus onSubmit={(t) => void submit(t)} onCancel={onCancel} submitLabel={T("完成")} busy={busy} />
      <div className="kg-chips" role="radiogroup" aria-label={T("关系类型")}>
        {CARD_TYPES.map((t) => (
          <button key={t} role="radio" aria-checked={type === t} className={`kg-chip${type === t ? " is-on" : ""}`} onClick={() => setType(t)}>{T(relationLabel(t))}</button>
        ))}
      </div>
      {err && <p className="kgv-err">{err}</p>}
    </div>
  );
}

/** 拖线松在空白处：搜索要连的知识点 */
export function LinkSearch({ from, x, y, nodes, onPick, onCancel }: { from: string; x: number; y: number; nodes: GraphNode[]; onPick: (id: string) => void; onCancel: () => void }) {
  const T = useT();
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  // v49.150 / D319：点击弹窗外任意位置即关闭（此前只有 Esc）。用 pointerdown 而非 click：
  // 画布的 onPointerDown 在按下瞬间就清选中 / 挪视图，等 click 时目标已变；框内按下不关闭。
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) cancelRef.current();
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, []);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const ok = nodes.filter((n) => n.id !== from && n.kind !== "hub" && n.state !== "ghost" && n.state !== "archived" && !n.id.startsWith("atlas:"));
    return (s ? ok.filter((n) => n.label.toLowerCase().includes(s)) : ok).slice(0, 8);
  }, [q, nodes, from]);
  return (
    <div ref={boxRef} className="kg-pop is-open kg-linkcard kp-picker kg-linksearch" style={{ left: x, top: y }} data-testid="kg-linksearch" onPointerDown={(e) => e.stopPropagation()}>
      <input
        value={q}
        autoFocus
        placeholder={T("连到哪个知识点？")}
        aria-label={T("连到哪个知识点？")}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === "Enter" && list[0]) onPick(list[0].id);
          if (e.key === "Escape") onCancel();
        }}
      />
      <ul>
        {list.map((n) => (
          <li key={n.id}>
            <button className="kg-link" onClick={() => onPick(n.id)}>{n.label}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
