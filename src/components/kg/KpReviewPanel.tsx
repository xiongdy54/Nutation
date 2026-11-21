// v49.137 / D304 复习页知识点面板（双链形态，设计稿 §11，任务 G6 / G7）。
// 时机约束（硬性，§11.1）：翻面前只显示名称且不可展开；答案含名称或别名时连名称也隐藏；翻面后显示一行定义，
// 点击或快捷键 K 展开完整面板。面板里露出的任何内容都是被动重现，不写复习记录（§11.5 / 不变量 7）。
// 默认只占一行；所有展开都由用户触发（§11.7）。
import "./kg.css";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/ime";
import { kgApi, type KpPanelData } from "../../lib/kg";
import { knowledgeApi } from "../../lib/knowledge";
import { learnerApi } from "../../lib/learner";
import { eventBus } from "../../lib/eventbus";
import EditableField from "../editor/EditableField";
import MarkdownEditor from "../editor/MarkdownEditor";
import { ExplainInput } from "./EdgePanel";

const RESTATE_GAP_MS = 90 * 86400000;
const FACET_LABEL: Record<string, string> = { definition: "是什么", why: "为什么", example: "举例 / 应用", contrast: "区分", relation: "关系" };
// 每次学习会话最多一个主动提问（§1.1）：会话＝本次复习页挂载期
let askedThisSession = false;
export function resetKpPanelSession() {
  askedThisSession = false;
}

/** 定义正文里的其他知识点名称识别为链接（本地词面匹配，不改存储，§6.5） */
function linkify(text: string, terms: KpPanelData["linkTerms"], onPeek: (t: { label: string; definition: string } | null) => void): ReactNode {
  if (!text || !terms.length) return text;
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const out: ReactNode[] = [];
  let i = 0;
  let buf = "";
  const lower = text.toLowerCase();
  while (i < text.length) {
    const hit = sorted.find((t) => lower.startsWith(t.term.toLowerCase(), i));
    if (hit) {
      if (buf) out.push(buf);
      buf = "";
      const seg = text.slice(i, i + hit.term.length);
      out.push(
        <span
          key={i}
          className="kp-link"
          tabIndex={0}
          onMouseEnter={() => onPeek(hit)}
          onMouseLeave={() => onPeek(null)}
          onFocus={() => onPeek(hit)}
          onBlur={() => onPeek(null)}
        >
          {seg}
        </span>
      );
      i += hit.term.length;
    } else {
      buf += text[i];
      i += 1;
    }
  }
  if (buf) out.push(buf);
  return <Fragment>{out}</Fragment>;
}

export default function KpReviewPanel({ cardId, showBack, onLocate }: { cardId: string; showBack: boolean; onLocate?: (kpId: string) => void }) {
  const T = useT();
  const [data, setData] = useState<KpPanelData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState<{ label: string; definition: string } | null>(null);
  const [menu, setMenu] = useState<null | "move" | "merge" | "contrast">(null);
  const [pickQuery, setPickQuery] = useState("");
  const [picks, setPicks] = useState<{ id: string; label: string }[]>([]);
  const [restate, setRestate] = useState<null | { stage: "write" | "compare"; text: string }>(null);
  const [note, setNote] = useState<string | null>(null);
  // v49.148 / D317 §5 复习页关系提问：offer → write → done（与重述共用每会话一次的主动提问）
  const [rel, setRel] = useState<null | { stage: "write" | "done"; rating: "clear" | "partial" | "stuck"; confirmed?: boolean }>(null);
  const [relBusy, setRelBusy] = useState(false);
  const api = kgApi();

  const reload = () => {
    if (!api) return;
    void api.cardPanel(cardId).then((d) => { setData(d); setLoaded(true); }).catch(() => { setData(null); setLoaded(true); });
  };
  useEffect(() => {
    setData(null);
    setLoaded(false);
    setOpen(false);
    setMenu(null);
    setRestate(null);
    setRel(null);
    setNote(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  // 重述的触发（§11.4）：节点不低于 L3、距上次重述 ≥ 90 天、本会话尚未提问
  const restateDue = useMemo(() => {
    if (!data || !data.node || askedThisSession) return false;
    if (!["solid", "firm"].includes(data.node.state) || !data.kp.definition) return false;
    const last = data.versions.filter((v) => v.reason === "restate").reduce((m, v) => Math.max(m, v.createdAt), 0);
    return Date.now() - last >= RESTATE_GAP_MS;
  }, [data]);

  // 快捷键 K：翻面后展开 / 收起（输入法组字与输入框内不触发）
  useEffect(() => {
    if (!showBack || !data) return;
    const onKey = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.closest("input, textarea, [contenteditable='true']"))) return;
      if ((e.key === "k" || e.key === "K") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showBack, data]);

  useEffect(() => {
    if (!menu) return;
    let alive = true;
    void knowledgeApi.listPoints({ query: pickQuery, status: "active", limit: 12 }).then((r) => {
      if (alive) setPicks((r.points || []).filter((p) => p.id !== data?.kp.id).map((p) => ({ id: p.id, label: p.canonicalLabel })));
    });
    return () => {
      alive = false;
    };
  }, [menu, pickQuery, data]);

  // v49.141 / D308：这张卡还没挂到知识点——翻面后给一枚「＋ 知识点」（无 AI 也能挂；翻面前不出现，不打扰答题）
  if (!data) return loaded && showBack ? <AttachChip cardId={cardId} onDone={reload} /> : null;
  const kp = data.kp;

  // —— 翻面前：只显示名称（或连名称也隐藏），不可展开 ——
  if (!showBack) {
    return (
      <div className="kp-panel is-front" data-testid="kp-panel">
        <span className="kp-chip">{data.hideNameBeforeFlip ? T("知识点（翻面后显示）") : kp.label}</span>
      </div>
    );
  }

  const ver = data.versions.length ? data.versions[data.versions.length - 1].seq : 0;
  const firstLine = (kp.definition || "").split(/\n/)[0];

  const doPick = async (target: { id: string; label: string }) => {
    try {
      if (menu === "move") {
        await api!.moveCard(cardId, target.id);
        setNote(T("已把这张卡移到「{x}」", { x: target.label }));
      } else if (menu === "merge") {
        await knowledgeApi.mergePoints(kp.id, target.id);
        setNote(T("已把「{a}」并入「{b}」，可在知识点管理里撤销", { a: kp.label, b: target.label }));
      } else if (menu === "contrast") {
        await knowledgeApi.createRelation({ fromKnowledgePointId: kp.id, toKnowledgePointId: target.id, relationType: "contrasts_with" });
        setNote(T("已标记与「{x}」易混", { x: target.label }));
      }
      setMenu(null);
      reload();
    } catch (e) {
      setNote(String((e as Error)?.message || e));
    }
  };

  const saveRestate = async (mode: "adopt" | "keep" | "both", selfRating: "clear" | "partial") => {
    if (!restate) return;
    askedThisSession = true;
    const text = restate.text.trim();
    if (mode === "adopt" && text) await api!.reviseDefinition(kp.id, { body: text, reason: "restate" });
    if (mode === "both" && text) await api!.reviseDefinition(kp.id, { body: `${kp.definition}\n\n${text}`, reason: "restate" });
    // 重述＝D124 自我解释事件，按现有口径成为深度证据（§11.4）
    await learnerApi.logEvent({ kind: "self_explain", kpId: kp.id, payload: { text: text.slice(0, 4000), relatedKpId: null, selfRating, source: "kg_restate" } });
    eventBus.emit("learner/changed");
    setRestate(null);
    reload();
  };

  // v49.148 / D317 §5：重述到期时重述优先；本会话已经问过就不再问
  const ask = !restateDue && !restate && (!askedThisSession || rel) ? data.relationAsk ?? null : null;
  const saveRel = async (text: string) => {
    if (!ask || !rel || !text.trim() || relBusy) return;
    setRelBusy(true);
    try {
      askedThisSession = true;
      const other = ask.other.id;
      let confirmed = false;
      if (ask.status === "suggested") {
        // 推断线：回答即确认（类型沿用推断类型）
        await api!.connectPair({ fromId: ask.from === kp.id ? kp.id : other, toId: ask.from === kp.id ? other : kp.id, type: ask.type, explanation: text, selfRating: rel.rating, source: "kg_relation_ask" });
        confirmed = true;
      } else {
        await api!.explainPair({ kpId: kp.id, relatedKpId: other, text, selfRating: rel.rating, source: "kg_relation_ask" });
      }
      await api!.relationAsked(kp.id, other, "answered");
      eventBus.emit("learner/changed");
      setRel({ stage: "done", rating: rel.rating, confirmed });
    } catch (e) {
      setNote(String((e as Error)?.message || e));
    } finally {
      setRelBusy(false);
    }
  };
  const skipRel = () => {
    if (!ask) return;
    askedThisSession = true;
    void api!.relationAsked(kp.id, ask.other.id, "skipped");
    setRel(null);
    reload();
  };
  const unrelated = async () => {
    if (!ask) return;
    askedThisSession = true;
    try {
      await api!.dismissPair(kp.id, ask.other.id);
      await api!.relationAsked(kp.id, ask.other.id, "unrelated");
      setNote(T("已解除与「{x}」的连线", { x: ask.other.label }));
      setRel(null);
      reload();
    } catch (e) {
      setNote(String((e as Error)?.message || e));
    }
  };

  const editMd = (p: { value: string; onDone: (next: string | null) => void }) => (
    <MarkdownEditor value={p.value} variant="compact" toolbar commitOnUnmount onCommit={p.onDone} />
  );

  return (
    <div className={`kp-panel is-back${open ? " is-open" : ""}`} data-testid="kp-panel">
      <button className="kp-line" onClick={() => setOpen((v) => !v)} title={T("展开知识点（快捷键 K）")} aria-expanded={open}>
        <span className="kp-chip">{kp.label}</span>
        {ver > 0 && <span className="kp-ver">v{ver}</span>}
        <span className="kp-def-line">{restate?.stage === "write" ? "……" : firstLine || T("（还没有定义）")}</span>
      </button>
      {open && (
        <div className="kp-body">
          {restate?.stage !== "write" && (
          <div className="kp-def">
            <EditableField
              value={kp.definition}
              display={<div className="kp-def-text">{linkify(kp.definition, data.linkTerms, setPeek) || T("（还没有定义）")}</div>}
              onCommit={(t) => void api!.reviseDefinition(kp.id, { body: t, reason: "review_edit" }).then(reload)}
              renderEditor={editMd}
            />
            {peek && (
              <div className="kp-peek" role="tooltip">
                <b>{peek.label}</b> {peek.definition || T("（还没有定义）")}
              </div>
            )}
          </div>
          )}
          {data.versions.length > 1 && restate?.stage !== "write" && (
            <details className="kp-history">
              <summary>{T("定义历史（{n} 版）", { n: data.versions.length })}</summary>
              <ol>
                {[...data.versions].reverse().map((v) => (
                  <li key={v.seq}>
                    <span className="kp-ver">v{v.seq}</span> {v.body}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {data.siblings.length > 0 && (
            <div className="kp-siblings">
              <div className="kp-sec">{T("这个知识点的其他卡")}</div>
              <ul>
                {data.siblings.slice(0, 8).map((s) => (
                  <li key={s.id}>
                    {s.facet && <span className="kp-facet">{T(FACET_LABEL[s.facet])}</span>} {s.front}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.neighbors.length > 0 && (
            <div className="kp-neighbors">
              <div className="kp-sec">{T("相邻知识点")}</div>
              <ul>
                {data.neighbors.slice(0, 8).map((n) => (
                  <li key={n.id + n.type}>
                    <span className="kp-link" tabIndex={0} onMouseEnter={() => setPeek(n)} onMouseLeave={() => setPeek(null)}>
                      {n.label}
                    </span>
                    {n.status === "suggested" && <span className="kp-muted"> · {T("推断")}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {restateDue && !restate && (
            <div className="kp-restate-offer">
              <span>{T("要不要先遮住定义，用自己的话说一遍？")}</span>
              <button className="bar-btn ghost btn-sm" onClick={() => setRestate({ stage: "write", text: "" })}>{T("重述")}</button>
              <button className="bar-btn ghost btn-sm" onClick={() => { askedThisSession = true; setRestate(null); setOpen(true); }}>{T("跳过")}</button>
            </div>
          )}
          {ask && (
            <div className="kp-relask" data-testid="kp-relask">
              {!rel && (
                <div className="kp-restate-offer">
                  <span>{T("「{a}」和「{b}」有什么关系？", { a: kp.label, b: ask.other.label })}</span>
                  <button className="bar-btn ghost btn-sm" onClick={() => setRel({ stage: "write", rating: "clear" })}>{T("回答")}</button>
                  <button className="bar-btn ghost btn-sm" onClick={skipRel}>{T("跳过")}</button>
                </div>
              )}
              {rel?.stage === "write" && (
                <>
                  <div className="kp-sec">{T("用自己的话说说「{a}」和「{b}」的关系", { a: kp.label, b: ask.other.label })}</div>
                  <ExplainInput placeholder={T("它们的关系是……")} autoFocus submitLabel={T("保存")} busy={relBusy} onSubmit={(t) => void saveRel(t)} onCancel={() => setRel(null)} />
                  <div className="kp-restate-acts" role="radiogroup" aria-label={T("自评")}>
                    {(["clear", "partial", "stuck"] as const).map((r) => (
                      <button key={r} role="radio" aria-checked={rel.rating === r} className={`kg-chip${rel.rating === r ? " is-on" : ""}`} onClick={() => setRel((x) => (x ? { ...x, rating: r } : x))}>
                        {T(r === "clear" ? "说得清楚" : r === "partial" ? "还有点模糊" : "卡住了")}
                      </button>
                    ))}
                  </div>
                  <details className="kp-history">
                    <summary>{T("看「{x}」的定义", { x: ask.other.label })}</summary>
                    <div className="kp-def-text">{ask.other.definition || T("（还没有定义）")}</div>
                  </details>
                  <button className="kg-textbtn kp-unrelated" onClick={() => void unrelated()}>{T("其实无关")}</button>
                </>
              )}
              {rel?.stage === "done" && (
                <div className="kp-restate-offer">
                  <span className="kp-note">{rel.confirmed ? T("已记下，这条关系已确认") : T("已记下")}</span>
                  {rel.confirmed && <button className="kg-textbtn" onClick={() => void unrelated()}>{T("其实无关")}</button>}
                </div>
              )}
            </div>
          )}
          {restate && (
            <div className="kp-restate" data-testid="kp-restate">
              {restate.stage === "write" ? (
                <>
                  <div className="kp-sec">{T("用自己的话写一句「{x}」是什么", { x: kp.label })}</div>
                  <MarkdownEditor value={restate.text} variant="compact" onCommit={(v) => setRestate((r) => (r ? { ...r, text: v ?? r.text } : r))} commitOnUnmount />
                  <button className="bar-btn btn-sm" onClick={() => setRestate((r) => (r ? { ...r, stage: "compare" } : r))}>{T("揭开对照")}</button>
                </>
              ) : (
                <>
                  <div className="kp-compare">
                    <div><div className="kp-sec">{T("你的说法")}</div>{restate.text || "—"}</div>
                    <div><div className="kp-sec">{T("现有定义")}</div>{kp.definition}</div>
                  </div>
                  <div className="kp-restate-acts">
                    {(["clear", "partial"] as const).map((r) => (
                      <Fragment key={r}>
                        <span className="kp-muted">{r === "clear" ? T("说得清楚：") : T("还有点模糊：")}</span>
                        <button className="bar-btn btn-sm" disabled={!restate.text.trim()} onClick={() => void saveRestate("adopt", r)}>{T("采纳为新版本")}</button>
                        <button className="bar-btn ghost btn-sm" onClick={() => void saveRestate("keep", r)}>{T("保留原定义")}</button>
                        <button className="bar-btn ghost btn-sm" disabled={!restate.text.trim()} onClick={() => void saveRestate("both", r)}>{T("合并两者")}</button>
                      </Fragment>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="kp-facet-pick" role="group" aria-label={T("这张卡考的是")}>
            <span className="kp-sec">{T("这张卡考的是")}</span>
            {(["definition", "why", "example", "contrast", "relation"] as const).map((f) => (
              <button
                key={f}
                className={`kp-facet-btn${data.facet === f ? " active" : ""}`}
                aria-pressed={data.facet === f}
                onClick={() => void api!.setFacet(cardId, data.facet === f ? null : f).then(reload)}
              >
                {T(FACET_LABEL[f])}
              </button>
            ))}
          </div>
          <div className="kp-more">
            <button className="bar-btn ghost btn-sm" onClick={() => setMenu(menu === "move" ? null : "move")}>{T("移到别的知识点")}</button>
            <button className="bar-btn ghost btn-sm" onClick={() => setMenu(menu === "merge" ? null : "merge")}>{T("与某个知识点合并")}</button>
            <button className="bar-btn ghost btn-sm" onClick={() => setMenu(menu === "contrast" ? null : "contrast")}>{T("标记易混")}</button>
            {onLocate && <button className="bar-btn ghost btn-sm" onClick={() => onLocate(kp.id)}>{T("在图谱中定位")}</button>}
          </div>
          {menu && (
            <div className="kp-picker">
              <input
                value={pickQuery}
                autoFocus
                placeholder={T("搜索知识点")}
                aria-label={T("搜索知识点")}
                onChange={(e) => setPickQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isImeComposing(e) && picks[0]) void doPick(picks[0]);
                }}
              />
              <ul>
                {picks.map((p) => (
                  <li key={p.id}>
                    <button className="kp-link" onClick={() => void doPick(p)}>{p.label}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {note && <div className="kp-note">{note}</div>}
        </div>
      )}
    </div>
  );
}

function AttachChip({ cardId, onDone }: { cardId: string; onDone: () => void }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void knowledgeApi.listPoints({ query: q, status: "active", limit: 8 }).then((r) => {
      if (alive) setPicks((r.points || []).map((p) => ({ id: p.id, label: p.canonicalLabel })));
    });
    return () => {
      alive = false;
    };
  }, [open, q]);
  const attach = async (label: string, kpId: string | null) => {
    const a = (window as unknown as { kgAPI: { attachCards(p: { label: string; kpId: string | null; definition: null; kind: null; cards: { cardId: string; facet: null }[] }): Promise<unknown> } }).kgAPI;
    await a.attachCards({ label, kpId, definition: null, kind: null, cards: [{ cardId, facet: null }] });
    setOpen(false);
    onDone();
  };
  const exact = picks.some((p) => p.label.trim().toLowerCase() === q.trim().toLowerCase());
  return (
    <div className="kp-panel is-back" data-testid="kp-attach">
      {!open ? (
        <button className="kp-facet-btn" onClick={() => setOpen(true)} title={T("把这张卡挂到一个知识点上，它就会出现在知识图谱里")}>{T("＋ 知识点")}</button>
      ) : (
        <div className="kp-picker">
          <input
            value={q}
            autoFocus
            placeholder={T("搜索或输入新知识点名称")}
            aria-label={T("搜索或输入新知识点名称")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) {
                if (picks[0] && exact) void attach(picks[0].label, picks[0].id);
                else if (q.trim()) void attach(q.trim(), null);
              }
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <ul>
            {picks.map((p) => (
              <li key={p.id}><button className="kp-link" onClick={() => void attach(p.label, p.id)}>{p.label}</button></li>
            ))}
            {q.trim() && !exact && (
              <li><button className="kp-link" onClick={() => void attach(q.trim(), null)}>{T("新建「{x}」", { x: q.trim() })}</button></li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
