// v49.141 / D308「整理已有卡片」（docs/design/KG-KNOWLEDGE-TAB-SIMPLIFY-D308.md §3）。
// 取代旧「扫描归一建议 / AI 整理 / 归一提案 / 全部接受」四件套：AI 逐张给出知识点与侧面 → 按知识点分组 →
// 用户逐组「确认」（此刻才建知识点、写正式 id）。未确认的分组只存本机草稿，不产生任何数据库待办。
import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/ime";
import { aiConfigUsable, aiGateway } from "../../lib/ai";
import type { Facet } from "../../lib/kg";
import "./kg.css";

interface UCard { id: string; cardType: string; front: string; back: string; legacy: string | null }
interface GCard { cardId: string; front: string; facet: Facet | null }
interface Group { key: string; label: string; kpId: string | null; kpLabel: string | null; suggest?: { kpId: string; label: string } | null; definition: string | null; kind: string | null; cards: GCard[] }
interface Draft { groups: Group[]; skipped: string[] }

type AttachApi = {
  unattachedCards(limit?: number): Promise<UCard[]>;
  attachCards(p: { label: string; kpId: string | null; definition: string | null; kind: string | null; cards: { cardId: string; facet: Facet | null }[] }): Promise<{ kpId: string; attached: number }>;
  recentLabels(limit?: number, text?: string): Promise<string[]>;
  resolveAttribution(items: { key: string; label: string }[]): Promise<{ key: string; label: string; kpId: string | null; kpLabel: string | null; suggest?: { kpId: string; label: string } | null }[]>;
};
const api = () => ((window as unknown as { kgAPI?: AttachApi }).kgAPI) ?? null;
const DRAFT_KEY = "kg.attachDraft";
const BATCH = 25;
const FACETS: { v: Facet; label: string }[] = [
  { v: "definition", label: "是什么" },
  { v: "why", label: "为什么" },
  { v: "example", label: "举例 / 应用" },
  { v: "contrast", label: "区分" },
  { v: "relation", label: "关系" }
];
const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (d && Array.isArray(d.groups)) return { groups: d.groups, skipped: Array.isArray(d.skipped) ? d.skipped : [] };
  } catch {
    /* 坏草稿：重来 */
  }
  return { groups: [], skipped: [] };
}
function parseOut(raw: string): { cardId: string; label: string | null; definition: string | null; kind: string | null; facet: string | null }[] {
  const t = String(raw || "");
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("AI 未返回有效 JSON");
  const j = JSON.parse(t.slice(s, e + 1));
  return Array.isArray(j.cards) ? j.cards : [];
}
const facetOf = (v: unknown): Facet | null => (FACETS.some((f) => f.v === v) ? (v as Facet) : null);

export default function AttachExistingCards({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const T = useT();
  const [cards, setCards] = useState<UCard[] | null>(null);
  const [draft, setDraft] = useState<Draft>(() => loadDraft());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [aiOk, setAiOk] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const save = (d: Draft) => {
    setDraft(d);
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  };
  const reload = async () => {
    const list = (await api()?.unattachedCards(2000)) || [];
    setCards(list);
    // 草稿里已不再「未挂靠」的卡（别处挂了 / 删了）从分组里剔除
    const alive = new Set(list.map((c) => c.id));
    const d = loadDraft();
    save({ groups: d.groups.map((g) => ({ ...g, cards: g.cards.filter((c) => alive.has(c.cardId)) })).filter((g) => g.cards.length), skipped: d.skipped.filter((id) => alive.has(id)) });
  };
  useEffect(() => {
    void reload();
    void aiGateway.getConfig().then((c) => setAiOk(aiConfigUsable(c))).catch(() => setAiOk(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handled = useMemo(() => new Set([...draft.skipped, ...draft.groups.flatMap((g) => g.cards.map((c) => c.cardId))]), [draft]);
  const todo = useMemo(() => (cards || []).filter((c) => !handled.has(c.id)), [cards, handled]);

  const run = async () => {
    const tpl = await window.promptsAPI?.get("kg-attach");
    if (!tpl) {
      setErr(T("提示词模板缺失，请重启应用完成播种。"));
      return;
    }
    setErr("");
    let d = loadDraft();
    const queue = todo.slice();
    setProgress({ done: 0, total: queue.length });
    try {
      for (let i = 0; i < queue.length; i += BATCH) {
        const batch = queue.slice(i, i + BATCH);
        const text = batch.map((c) => `${c.front} ${c.back}`).join("\n");
        const labels = (await api()!.recentLabels(40, text)) || [];
        const user = [
          labels.length ? `【已有知识点】\n${labels.join("、")}` : "",
          `【卡片】\n${batch.map((c) => JSON.stringify({ cardId: c.id, 题: c.front, 答: c.back, 旧标注: c.legacy })).join("\n")}`
        ].filter(Boolean).join("\n\n");
        const raw = await aiGateway.chat([{ role: "system", content: tpl.content }, { role: "user", content: user }], undefined, 0.2, undefined, undefined, "kp_extract");
        const out = parseOut(raw);
        const byCard = new Map(out.map((o) => [String(o.cardId), o]));
        const named = batch.filter((c) => byCard.get(c.id)?.label);
        const uniq = [...new Set(named.map((c) => String(byCard.get(c.id)!.label).trim()))];
        const resolved = uniq.length ? await api()!.resolveAttribution(uniq.map((l) => ({ key: l, label: l }))) : [];
        const resOf = new Map(resolved.map((r) => [r.key, r]));
        const defOf = new Map<string, { definition: string | null; kind: string | null }>();
        for (const o of out) if (o.label && !defOf.has(String(o.label).trim())) defOf.set(String(o.label).trim(), { definition: o.definition || null, kind: o.kind || null });
        const groups = d.groups.slice();
        for (const c of batch) {
          const o = byCard.get(c.id);
          const label = o?.label ? String(o.label).trim() : "";
          if (!label) {
            d = { ...d, skipped: [...d.skipped, c.id] };
            continue;
          }
          const r = resOf.get(label);
          const key = r?.kpId ? `kp:${r.kpId}` : `new:${normKey(label)}`;
          let g = groups.find((x) => x.key === key);
          if (!g) {
            g = { key, label, kpId: r?.kpId ?? null, kpLabel: r?.kpLabel ?? null, suggest: r?.suggest ?? null, definition: defOf.get(label)?.definition ?? null, kind: defOf.get(label)?.kind ?? null, cards: [] };
            groups.push(g);
          }
          g.cards.push({ cardId: c.id, front: c.front, facet: facetOf(o?.facet) });
        }
        d = { ...d, groups };
        save(d);
        setProgress({ done: Math.min(queue.length, i + BATCH), total: queue.length });
      }
    } catch (e) {
      setErr(T("整理中断（已完成的部分已保存）：{msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setProgress(null);
    }
  };

  const patchGroup = (key: string, patch: Partial<Group>) => save({ ...draft, groups: draft.groups.map((g) => (g.key === key ? { ...g, ...patch } : g)) });
  const confirm = async (g: Group) => {
    setBusy(true);
    try {
      await api()!.attachCards({ label: g.label, kpId: g.kpId, definition: g.kpId ? null : g.definition, kind: g.kind, cards: g.cards.map((c) => ({ cardId: c.cardId, facet: c.facet })) });
      const d = loadDraft();
      save({ ...d, groups: d.groups.filter((x) => x.key !== g.key) });
      onChanged();
      await reload();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const confirmAll = async () => {
    for (const g of draft.groups) await confirm(g);
  };
  const skipGroup = (g: Group) => save({ groups: draft.groups.filter((x) => x.key !== g.key), skipped: [...draft.skipped, ...g.cards.map((c) => c.cardId)] });
  const rename = async (g: Group, label: string) => {
    const l = label.trim();
    if (!l || l === (g.kpLabel ?? g.label)) return;
    const r = (await api()!.resolveAttribution([{ key: l, label: l }]))[0];
    patchGroup(g.key, { label: l, kpId: r?.kpId ?? null, kpLabel: r?.kpLabel ?? null, suggest: r?.suggest ?? null });
  };

  return (
    <div className="kg-attach" data-testid="kg-attach">
      <div className="kg-attach-head">
        <h3>{T("整理已有卡片")}</h3>
        <button className="icon-btn" onClick={onClose} aria-label={T("关闭")}>✕</button>
      </div>
      <p className="form-hint">{T("AI 会读每张卡，判断它考的是哪个知识点、哪一面，并按知识点分组。你逐组确认后，卡片才挂到知识点上；有复习记录的卡会按真实的复习历史点亮。")}</p>
      {cards == null ? (
        <p className="kp-muted">{T("正在读取…")}</p>
      ) : (
        <div className="kg-attach-bar">
          <span className="mono tnum">{T("未挂靠 {n} 张 · 待整理 {m} 张 · 待确认 {g} 组", { n: cards.length, m: todo.length, g: draft.groups.length })}</span>
          {progress ? (
            <span className="kp-muted">{T("整理中 {d}/{t}…", { d: progress.done, t: progress.total })}</span>
          ) : (
            <button className="btn btn-secondary btn-sm" disabled={!aiOk || todo.length === 0} onClick={() => void run()}>
              {T("开始整理（{n} 张）", { n: todo.length })}
            </button>
          )}
          {draft.groups.length > 1 && (
            <button className="btn btn-outline btn-sm" disabled={busy || Boolean(progress)} onClick={() => void confirmAll()}>{T("全部确认")}</button>
          )}
        </div>
      )}
      {aiOk === false && <p className="form-hint">{T("整理需要 AI（设置 → AI 服务）。也可以在复习时，翻面后给单张卡挂靠知识点。")}</p>}
      {err && <p className="form-hint kgv-err">{err}</p>}
      <div className="kg-attach-groups">
        {draft.groups.map((g) => (
          <section key={g.key} className="kg-attach-group" data-testid="kg-attach-group">
            <div className="kg-attach-ghead">
              <GroupName value={g.kpLabel ?? g.label} onCommit={(v) => void rename(g, v)} />
              <span className={`kg-attach-state${g.kpId ? "" : " is-new"}`}>{g.kpId ? T("已有") : T("新")}</span>
              {!g.kpId && g.suggest && (
                <button className="ai-kp-suggest" onClick={() => patchGroup(g.key, { kpId: g.suggest!.kpId, kpLabel: g.suggest!.label, suggest: null })}>
                  {T("可能是：{x}？", { x: g.suggest.label })}
                </button>
              )}
              <span className="kp-muted">{T("{n} 张卡", { n: g.cards.length })}</span>
              <span className="kg-attach-acts">
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void confirm(g)}>{T("确认")}</button>
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => skipGroup(g)}>{T("不挂靠")}</button>
              </span>
            </div>
            {!g.kpId && g.definition && <p className="kg-attach-def">{g.definition}</p>}
            <ul className="kg-attach-cards">
              {g.cards.map((c) => (
                <li key={c.cardId}>
                  <span className="kg-attach-front">{c.front}</span>
                  <select
                    className="ai-kp-facet"
                    value={c.facet ?? ""}
                    aria-label={T("这张卡考的是")}
                    onChange={(e) => patchGroup(g.key, { cards: g.cards.map((x) => (x.cardId === c.cardId ? { ...x, facet: (e.target.value || null) as Facet | null } : x)) })}
                  >
                    <option value="">{T("不标注")}</option>
                    {FACETS.map((f) => <option key={f.v} value={f.v}>{T(f.label)}</option>)}
                  </select>
                  <button
                    className="ai-kp-clear"
                    title={T("移出这一组（这张卡不挂靠）")}
                    aria-label={T("移出这一组（这张卡不挂靠）")}
                    onClick={() => save({ groups: draft.groups.map((x) => (x.key === g.key ? { ...x, cards: x.cards.filter((y) => y.cardId !== c.cardId) } : x)).filter((x) => x.cards.length), skipped: [...draft.skipped, c.cardId] })}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {draft.skipped.length > 0 && (
        <p className="form-hint">
          {T("{n} 张卡没有挂靠（不考可命名的知识点，或你选了不挂靠）。", { n: draft.skipped.length })}{" "}
          <button className="kg-link" onClick={() => save({ ...draft, skipped: [] })}>{T("重新纳入整理")}</button>
        </p>
      )}
    </div>
  );
}

function GroupName({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const T = useT();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="kg-attach-name"
      value={v}
      aria-label={T("知识点名称")}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !isImeComposing(e)) onCommit(v);
      }}
    />
  );
}
