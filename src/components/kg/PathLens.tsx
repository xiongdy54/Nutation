// v49.172 / D342：关联路径直接画在关系图上（取代 v49.170 / D340 的覆盖式透镜与文字路径列表）。
// 路径节点与连线由 KnowledgeGraphView 叠加到关系图；这里只剩两样东西：
//  - PathBar：画布顶部一条细栏——正在找 / 关联路径：X / 暂时没找到；AI 推测（虚线）时给「对 / 不对」。
//  - PathBlock：详情卡里的「连到我学过的」开关与「固定为目标」。
// 系统能判断的不留给用户：不再展示「新领域」「从这里入手」「继续搜索」「可靠度」等说明性文字。
import { useT } from "../../lib/i18n";
import type { PathAiChain, PathCorridor } from "../../lib/kg";

export interface LensState {
  target: string;
  label: string;
  data: PathCorridor | null;
  maxExpand: number;
  error?: string;
  /** 「远」档时系统自动请 AI 找一次：busy＝正在找；note＝结果说明（没找到 / 未配置） */
  ai?: { busy: boolean; note?: string | null };
}

/** 画布顶部的关联路径细栏 */
export function PathBar({ state, onClose, onDecide }: {
  state: LensState;
  onClose: () => void;
  /** AI 推测的一条链：对 / 不对 */
  onDecide: (chain: PathAiChain, verdict: "accept" | "reject") => void;
}) {
  const T = useT();
  const d = state.data;
  const chain = d?.aiChains?.[0] ?? null;
  const shown = d && (d.status === "near" || d.status === "reachable");
  const waiting = (!d && !state.error) || !!state.ai?.busy;
  let text: string;
  if (state.error) text = state.error;
  else if (!d) text = T("正在寻找「{name}」与你学过的知识之间的连线…", { name: state.label });
  else if (d.status === "unavailable") text = T("需要全谱才能寻找关联路径");
  else if (shown) text = T("关联路径：{name}", { name: state.label });
  else if (state.ai?.busy) text = T("图谱里没有现成的连线，AI 正在找…");
  else if (chain) text = T("关联路径：{name}", { name: state.label });
  else text = state.ai?.note || T("「{name}」与你学过的知识之间暂时没有可靠的连线", { name: state.label });
  return (
    <div className={`kg-pathbar${waiting ? " is-wait" : ""}`} data-testid="kg-pathbar" role="status" aria-live="polite">
      <span className="kg-pathbar-text">{text}</span>
      {chain && !state.ai?.busy && (
        <span className="kg-pathbar-ai" title={chain.hops.map((h) => h.basis).filter(Boolean).join("\n")}>
          <span className="kg-pathbar-cap">{T("虚线是 AI 的推测")}</span>
          <button className="kg-chip" onClick={() => onDecide(chain, "accept")}>{T("对")}</button>
          <button className="kg-chip" onClick={() => onDecide(chain, "reject")}>{T("不对")}</button>
        </span>
      )}
      <button className="kg-pathbar-x" onClick={onClose} aria-label={T("关闭关联路径")} title={T("关闭关联路径")}>
        ×
      </button>
    </div>
  );
}

/** 详情卡里的一段：「连到我学过的」（再点一次收起）+「固定为目标」 */
export function PathBlock({ target, label, lens, onOpen, onClose, pinned, onPin }: {
  target: string;
  label: string;
  lens: LensState | null;
  onOpen: (target: string, label: string) => void;
  onClose: () => void;
  pinned: boolean;
  onPin: (on: boolean) => void;
}) {
  const T = useT();
  const on = !!lens && lens.target === target;
  return (
    <div className="kg-path" data-testid="kg-path">
      <div className="kg-path-acts">
        <button className={`btn btn-outline btn-sm${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => (on ? onClose() : onOpen(target, label))}>
          {T("连到我学过的")}
        </button>
        <button className={`kg-chip${pinned ? " is-on" : ""}`} onClick={() => onPin(!pinned)} aria-pressed={pinned}>
          {pinned ? T("已固定为目标") : T("固定为目标")}
        </button>
      </div>
    </div>
  );
}
