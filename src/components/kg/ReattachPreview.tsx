// v49.147 / D316：解散知识点并给名下卡片重挂——预览表（确认前不落库）。设计 docs/design/KG-KP-ATLAS-REALIGN.md §2–§3。
// 左：卡片题面摘要；右：建议知识点（下拉：该卡的候选 / 搜索选中的全谱条目 / 留在原知识点）。按原知识点分组，可整组保留。
// 候选与撤销数据都在主进程，这里只回传「令牌 + 每张卡的选择」。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { atlasApi, atlasLabel, type AtlasNode, type ReattachPlan, type ReattachResult } from "../../lib/atlas";

type Pick = { atlasId: string; label: string };

export default function ReattachPreview({
  kpIds,
  onCancel,
  onDone,
  renderSearch
}: {
  kpIds: string[];
  onCancel: () => void;
  onDone: (r: ReattachResult) => void;
  /** 就地搜索全谱（复用整理面板的 MapSearch，只开「是它」） */
  renderSearch: (label: string, onPick: (atlasId: string, node?: AtlasNode) => void) => ReactNode;
}) {
  const T = useT();
  const [plan, setPlan] = useState<ReattachPlan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 每张卡的选择：keep ＝ 留在原知识点；key:N ＝ 候选；atlas:Qn ＝ 搜索选的条目
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, Pick>>({});
  const [searching, setSearching] = useState<string | null>(null);
  const idsKey = kpIds.join("|");
  useEffect(() => {
    let alive = true;
    const api = atlasApi();
    const off = api?.onReattachProgress?.((p) => alive && setProgress(p));
    void api
      ?.reattachPlan(kpIds)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        const init: Record<string, string> = {};
        for (const g of p.groups) for (const c of g.cards) init[c.cardId] = c.suggestion ? "key:" + c.suggestion : "keep";
        setChoice(init);
      })
      .catch((e) => alive && setErr(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
    return () => {
      alive = false;
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);
  const moving = useMemo(() => Object.values(choice).filter((v) => v !== "keep").length, [choice]);
  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    setErr("");
    try {
      const decisions = Object.entries(choice).map(([cardId, v]) => ({
        cardId,
        choice: v === "keep" ? null : v.startsWith("key:") ? { key: v.slice(4) } : { atlasId: v.slice(6) }
      }));
      const r = await atlasApi()!.reattachApply(plan.token, decisions);
      onDone(r);
    } catch (e) {
      setErr(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setBusy(false);
    }
  };
  return (
    <section className="kg-reattach" data-testid="kg-reattach">
      <h4 className="kg-reattach-title">{T("解散并重挂卡片")}</h4>
      {!plan && !err && (
        <p className="kg-note" role="status">
          {progress && progress.total > 0 ? T("AI 正在为卡片挑知识点：{a}/{b}", { a: progress.done, b: progress.total }) : T("正在查找…")}
        </p>
      )}
      {plan && (
        <>
          <p className="kg-note">
            {plan.ai === "none"
              ? T("没有配置 AI：下拉里列出了本地找到的候选，请自己选。")
              : plan.ai === "failed"
                ? T("AI 这次没有完整返回，没有建议的卡请自己选。")
                : T("下面是 AI 的建议，可以逐张改；确认之前不会改动任何东西。")}
            {plan.truncated > 0 && " " + T("卡片太多，只列出前 {n} 张；另外 {m} 张仍留在原知识点。", { n: plan.groups.reduce((s, g) => s + g.cards.length, 0), m: plan.truncated })}
          </p>
          {plan.groups.length === 0 && <p className="kg-map-empty">{T("这个知识点下没有卡片。")}</p>}
          {plan.groups.map((g) => (
            <div key={g.kpId} className="kg-reattach-group" data-testid="kg-reattach-group">
              <div className="kg-map-head">
                <b className="kg-map-name">{T("「{name}」下的 {n} 张卡片", { name: g.label, n: g.cards.length })}</b>
                <button className="kg-textbtn" data-testid="kg-reattach-keepall" onClick={() => setChoice((c) => ({ ...c, ...Object.fromEntries(g.cards.map((x) => [x.cardId, "keep"])) }))}>
                  {T("整组保留原知识点")}
                </button>
              </div>
              <ul className="kg-reattach-cards">
                {g.cards.map((c) => {
                  const v = choice[c.cardId] || "keep";
                  const p = picked[c.cardId];
                  return (
                    <li key={c.cardId} data-testid="kg-reattach-card">
                      <span className="kg-reattach-q" title={c.back ? `${c.front}\n${c.back}` : c.front}>{c.front || T("（空白题面）")}</span>
                      <span className="kg-reattach-pick">
                        <select className="kg-speed" aria-label={T("这张卡归到")} value={v} onChange={(e) => setChoice((x) => ({ ...x, [c.cardId]: e.target.value }))}>
                          <option value="keep">{T("留在原知识点")}</option>
                          {c.cands.map((x) => (
                            <option key={x.key} value={"key:" + x.key}>
                              {x.label} · {x.kind === "kp" ? T("已有知识点") : T("全谱条目")}
                            </option>
                          ))}
                          {p && <option value={"atlas:" + p.atlasId}>{p.label} · {T("全谱条目")}</option>}
                        </select>
                        <button className="kg-textbtn" onClick={() => setSearching(searching === c.cardId ? null : c.cardId)}>{T("搜索…")}</button>
                      </span>
                      {searching === c.cardId && (
                        <div className="kg-reattach-search">
                          {renderSearch(c.front.slice(0, 20), (id, node) => {
                            setPicked((x) => ({ ...x, [c.cardId]: { atlasId: id, label: node ? atlasLabel(node) : id } }));
                            setChoice((x) => ({ ...x, [c.cardId]: "atlas:" + id }));
                            setSearching(null);
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
      {err && <p className="kgv-err">{err}</p>}
      <div className="kg-actions">
        <button className="btn btn-primary btn-sm" data-testid="kg-reattach-confirm" disabled={!plan || busy || moving === 0} onClick={() => void confirm()}>
          {T("确认移动 {n} 张卡片", { n: moving })}
        </button>
        <button className="btn btn-outline btn-sm" data-testid="kg-reattach-cancel" disabled={busy} onClick={onCancel}>{T("取消")}</button>
      </div>
    </section>
  );
}
