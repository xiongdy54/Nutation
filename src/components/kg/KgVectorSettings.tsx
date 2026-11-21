// v49.140 / D307：设置 →「语义匹配」（知识图谱去重的可选向量档；设计稿 §0.4 / §7.3 第四轮修订）。
// 默认「不使用」——功能完整可用；本地两档需用户主动下载（模型 + 约 11 MB 推理引擎，下载后离线运行，可随时删除）；
// 「使用 AI 服务的向量接口」不下载，但需联网、会把知识点名称发给所选服务商。
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import "./kg.css";

type Mode = "none" | "small" | "large" | "api";
interface VecStatus {
  mode: Mode;
  tiers: Record<"small" | "large", { label: string; installed: boolean; downloadBytes: number }>;
  api: { preset: string; presetName: string; model: string; usable: boolean };
  downloading: { tier: string; received: number; total: number } | null;
  lastError: string | null;
}
type VecApi = {
  vectorStatus(): Promise<VecStatus>;
  vectorSetMode(mode: Mode, opts?: { apiModel?: string }): Promise<VecStatus>;
  vectorDownload(tier: "small" | "large"): Promise<VecStatus>;
  vectorCancel(): Promise<unknown>;
  vectorRemove(tier: "small" | "large"): Promise<VecStatus>;
  onVectorProgress(cb: (p: { tier: string; received: number; total: number }) => void): () => void;
};
const api = () => ((window as unknown as { kgAPI?: VecApi }).kgAPI) ?? null;
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

export default function KgVectorSettings() {
  const T = useT();
  const [st, setSt] = useState<VecStatus | null>(null);
  const [prog, setProg] = useState<{ tier: string; received: number; total: number } | null>(null);
  const [apiModel, setApiModel] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    void api()?.vectorStatus().then((s) => { setSt(s); setApiModel(s.api.model); setProg(s.downloading); });
    const off = api()?.onVectorProgress((p) => setProg(p));
    return () => off?.();
  }, []);
  if (!st) return null;

  const run = async (fn: () => Promise<VecStatus | unknown>) => {
    setErr("");
    try {
      const r = await fn();
      if (r && typeof r === "object" && "mode" in (r as VecStatus)) setSt(r as VecStatus);
      else setSt(await api()!.vectorStatus());
    } catch (e) {
      setErr(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setSt(await api()!.vectorStatus());
    }
  };
  const download = (tier: "small" | "large") =>
    run(async () => {
      const r = await api()!.vectorDownload(tier);
      setProg(null);
      return api()!.vectorSetMode(tier).catch(() => r);
    });

  const Row = ({ mode, title, desc, children }: { mode: Mode; title: string; desc: string; children?: React.ReactNode }) => {
    const disabled = (mode === "small" || mode === "large") ? !st.tiers[mode].installed : mode === "api" ? !st.api.preset || !apiModel.trim() : false;
    return (
      <div className={`kgv-row${st.mode === mode ? " is-on" : ""}`} data-kgv={mode}>
        <label className="kgv-pick">
          <input type="radio" name="kgv-mode" checked={st.mode === mode} disabled={disabled} onChange={() => void run(() => api()!.vectorSetMode(mode, mode === "api" ? { apiModel } : undefined))} />
          <span className="kgv-title">{title}</span>
        </label>
        <p className="form-hint">{desc}</p>
        {children}
      </div>
    );
  };
  const local = (tier: "small" | "large") => {
    const t = st.tiers[tier];
    const busy = prog && prog.tier === tier;
    if (busy) {
      return (
        <div className="kgv-dl">
          <progress max={prog.total} value={prog.received} />
          <span className="mono tnum">{mb(prog.received)} / {mb(prog.total)}</span>
          <button className="btn btn-outline btn-sm" onClick={() => void run(() => api()!.vectorCancel())}>{T("取消")}</button>
        </div>
      );
    }
    return t.installed ? (
      <div className="kgv-dl">
        <span className="form-hint">{T("已下载")}</span>
        <button className="btn btn-outline btn-sm" onClick={() => void run(() => api()!.vectorRemove(tier))}>{T("删除")}</button>
      </div>
    ) : (
      <div className="kgv-dl">
        <button className="btn btn-secondary btn-sm" disabled={Boolean(prog)} onClick={() => void download(tier)}>
          {T("下载（{size}）", { size: mb(t.downloadBytes) })}
        </button>
      </div>
    );
  };

  return (
    <section className="settings-section card-fill" id="sec-kgvector">
      <h3 tabIndex={-1}>{T("语义匹配")}</h3>
      <p className="form-hint">{T("用于发现「换了说法的同一个知识点」，让知识图谱少出重复。不开启也能正常使用：软件会按名称精确匹配，并把与材料最相近的已有知识点名称交给 AI 判断。")}</p>
      <Row mode="none" title={T("不使用（默认）")} desc={T("零下载，完全离线。")} />
      <Row mode="small" title={T("小模型 · {name}", { name: st.tiers.small.label })} desc={T("下载后在本机离线运行。体积小、速度快，适合大多数人。")}>
        {local("small")}
      </Row>
      <Row mode="large" title={T("高质量 · {name}", { name: st.tiers.large.label })} desc={T("下载后在本机离线运行。识别换了说法的重复更准，体积较大。")}>
        {local("large")}
      </Row>
      <Row mode="api" title={T("使用 AI 服务的向量接口")} desc={T("不下载。需要联网，知识点名称会发送给当前 AI 服务（{name}）。", { name: st.api.presetName || T("未配置") })}>
        <div className="kgv-dl">
          <input
            className="kgv-model"
            value={apiModel}
            placeholder={T("向量模型名，如 BAAI/bge-m3")}
            aria-label={T("向量模型名")}
            onChange={(e) => setApiModel(e.target.value)}
            onBlur={() => { if (st.mode === "api") void run(() => api()!.vectorSetMode("api", { apiModel })); }}
          />
        </div>
      </Row>
      {(err || st.lastError) && <p className="form-hint kgv-err">{err || T("最近一次语义匹配失败，已自动改用名称匹配：{msg}", { msg: st.lastError ?? "" })}</p>}
    </section>
  );
}
