// v49.139 / D306 区分卡提议（知识图谱设计稿 §7.4；用户 2026-11-17：「在合适的时机出这个区分卡，不要过多地干扰基础学习流程」）。
// 时机：只在复习会话收尾页出现（绝不在答题中途）；每学习日至多一次、每次只一对；
// 只在有混淆信号时出现（主进程 kgService.contrastCandidate：近 14 天任一端答错，或易混关系刚建立）；
// 「不用」＝这一对永不再提；生成后草稿逐张确认（ContrastDraftList，接受即确认归属，facet=contrast）。
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { aiConfigUsable, aiGateway } from "../../lib/ai";
import { cardGenerator, type CardDraft } from "../../lib/cards";
import ContrastDraftList from "../ContrastDraftList";

interface Candidate {
  pair: string;
  a: { id: string; label: string; definition: string };
  b: { id: string; label: string; definition: string };
}
type KgContrastApi = {
  contrastCandidate(): Promise<Candidate | null>;
  markContrastHandled(pair: string, action: "generated" | "dismissed"): Promise<unknown>;
};
const api = () => ((window as unknown as { kgAPI?: KgContrastApi }).kgAPI) ?? null;
const OFFER_DAY_KEY = "kg.contrastOfferDay";
const todayKey = () => new Date().toLocaleDateString("sv-SE");

export default function KgContrastOffer() {
  const T = useT();
  const [cand, setCand] = useState<Candidate | null>(null);
  const [stage, setStage] = useState<"offer" | "running" | "drafts" | "error" | "gone">("offer");
  const [drafts, setDrafts] = useState<CardDraft[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (localStorage.getItem(OFFER_DAY_KEY) === todayKey()) return; // 每学习日至多一次
        if (!aiConfigUsable(await aiGateway.getConfig())) return; // 没配 AI：不提（无法生成就不打扰）
        const c = await api()?.contrastCandidate();
        if (!alive || !c) return;
        localStorage.setItem(OFFER_DAY_KEY, todayKey());
        setCand(c);
      } catch {
        /* 提议是增强信息：取不到就不显示 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!cand || stage === "gone") return null;

  const generate = async () => {
    setStage("running");
    try {
      const text = `「${cand.a.label}」：${cand.a.definition || "（暂无定义）"}\n「${cand.b.label}」：${cand.b.definition || "（暂无定义）"}`;
      const { result } = await cardGenerator.generateCards(text, { title: T("知识图谱 · 易混辨析") }, "card-contrast");
      const list = (result.cards || []).map((d) => ({
        ...d,
        facet: "contrast" as const,
        kpAttribution: d.kpAttribution ?? { key: "kgA", label: cand.a.label, definition: null, kind: null, kpId: cand.a.id, kpLabel: cand.a.label }
      }));
      await api()?.markContrastHandled(cand.pair, "generated");
      setDrafts(list);
      setStage("drafts");
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setStage("error");
    }
  };
  const dismiss = async () => {
    await api()?.markContrastHandled(cand.pair, "dismissed").catch(() => undefined);
    setStage("gone");
  };

  return (
    <div className="growth-session kg-contrast" data-kg-contrast>
      <p className="growth-session-title">{T("易混辨析")}</p>
      {stage === "offer" && (
        <p>
          {T("「{a}」和「{b}」最近容易混，要生成一张区分卡吗？", { a: cand.a.label, b: cand.b.label })}{" "}
          <button className="btn btn-secondary btn-sm" onClick={() => void generate()}>{T("生成区分卡")}</button>{" "}
          <button className="btn btn-outline btn-sm" onClick={() => void dismiss()}>{T("不用")}</button>
        </p>
      )}
      {stage === "running" && <p className="kp-muted">{T("正在生成…")}</p>}
      {stage === "error" && <p className="kp-muted">{T("生成失败：{msg}", { msg: err })}</p>}
      {stage === "drafts" && <ContrastDraftList drafts={drafts} />}
    </div>
  );
}
