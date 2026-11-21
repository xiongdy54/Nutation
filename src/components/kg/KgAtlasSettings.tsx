// v49.146 / D315：设置 →「知识全谱」（来源状态、完整全谱下载、在线分片开关与地址、隐私说明）。
// 数据真源在主进程 electron/atlas.js / atlasOnline.js / atlasDownload.js；这里只是读写 app.atlasOnlineEnabled / atlasOnlineUrl。
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { settingsStore } from "../../lib/settings";
import { isImeComposing } from "../../lib/ime";
import "./kg.css";

interface AtlasSt {
  available: boolean;
  source: "full" | "core" | "none";
  nodes: number | null;
  builtAt: number | null;
  online: { enabled: boolean; url: string };
  download: { urlConfigured: boolean; downloading: { received: number; total: number } | null; partBytes: number };
}
type Api = {
  atlasStatus(): Promise<AtlasSt>;
  atlasDownloadStart(): Promise<unknown>;
  atlasDownloadCancel(): Promise<unknown>;
  onAtlasDownloadProgress(cb: (p: { received: number; total: number }) => void): () => void;
};
const api = () => ((window as unknown as { kgAPI?: Api }).kgAPI) ?? null;
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
// 与 electron/atlasOnline.js 的 DEFAULT_ONLINE_URLS 一致：设置未写过地址时主进程用它；这里只用于回显
const DEFAULT_ONLINE_URL = "https://nutation-atlas.pages.dev";

export default function KgAtlasSettings() {
  const T = useT();
  const [st, setSt] = useState<AtlasSt | null>(null);
  const [prog, setProg] = useState<{ received: number; total: number } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [share, setShare] = useState(false);
  const [url, setUrl] = useState("");
  const [fullUrl, setFullUrl] = useState("");
  const [fullSha, setFullSha] = useState("");
  const [err, setErr] = useState("");

  const refresh = async () => {
    const s = await api()?.atlasStatus();
    if (s) {
      setSt(s);
      setProg(s.download?.downloading ?? null);
    }
  };
  useEffect(() => {
    void refresh();
    void settingsStore.get<boolean>("app", "atlasOnlineEnabled", true).then(setEnabled);
    void settingsStore.get<boolean>("app", "atlasShareConfirmations", false).then(setShare);
    void settingsStore.get<string>("app", "atlasOnlineUrl", DEFAULT_ONLINE_URL).then(setUrl);
    void settingsStore.get<string>("app", "atlasFullUrl", "").then(setFullUrl);
    void settingsStore.get<string>("app", "atlasFullSha256", "").then(setFullSha);
    const off = api()?.onAtlasDownloadProgress((p) => setProg(p));
    return () => off?.();
  }, []);
  if (!st) return null;

  const sourceLabel = st.source === "full" ? T("完整全谱") : st.source === "core" ? T("随包核心") : T("未安装");
  const download = async () => {
    setErr("");
    setProg({ received: 0, total: 0 });
    try {
      await api()!.atlasDownloadStart();
    } catch (e) {
      const m = String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      if (!/已取消/.test(m)) setErr(m);
    }
    setProg(null);
    await refresh();
  };
  const saveUrl = () => void settingsStore.set("app", "atlasOnlineUrl", url.trim());
  const saveFullUrl = () => void settingsStore.set("app", "atlasFullUrl", fullUrl.trim()).then(refresh);
  const saveFullSha = () => void settingsStore.set("app", "atlasFullSha256", fullSha.trim()).then(refresh);

  return (
    <section className="settings-section card-fill" id="sec-kgatlas">
      <h3 tabIndex={-1}>{T("知识全谱")}</h3>
      <p className="form-hint kga-status" data-kga-source={st.source}>
        {T("来源：{source}", { source: sourceLabel })}
        {st.nodes ? ` · ${T("节点数 {n}", { n: st.nodes.toLocaleString() })}` : ""}
        {st.builtAt ? ` · ${T("构建于 {date}", { date: new Date(st.builtAt).toLocaleDateString() })}` : ""}
      </p>
      <div className="kgv-dl kga-row">
        {prog ? (
          <>
            <progress max={prog.total || undefined} value={prog.total ? prog.received : undefined} />
            <span className="mono tnum">{mb(prog.received)}{prog.total ? ` / ${mb(prog.total)}` : ""}</span>
            <button className="btn btn-outline btn-sm" onClick={() => void api()!.atlasDownloadCancel()}>{T("取消")}</button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary btn-sm" disabled={!st.download?.urlConfigured || st.source === "full"} onClick={() => void download()}>
              {T("下载完整全谱（约 2.4 GB）")}
            </button>
            {!st.download?.urlConfigured && <span className="form-hint">{T("下载地址尚未配置，暂不能下载。")}</span>}
          </>
        )}
      </div>
      <label className="kgv-pick kga-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            void settingsStore.set("app", "atlasOnlineEnabled", e.target.checked).then(refresh);
          }}
        />
        <span className="kgv-title">{T("在线查全谱")}</span>
      </label>
      <div className="kgv-dl kga-row">
        <input
          className="kgv-model kga-url"
          value={url}
          placeholder="https://"
          aria-label={T("分片地址")}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={saveUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(isImeComposing(e))) (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <p className="form-hint">{T("可填多个地址，按顺序尝试；留空则不联网。")}</p>
      <p className="form-hint">{T("在线查询只发送分片编号与名称哈希前缀，不发送你的卡片、材料或搜索词原文。")}</p>
      <p className="form-hint" data-kga-core-note>{T("本地只有核心词条时，名称查找会自动转到在线全谱；没有在线或完整全谱时，搜不到不代表全谱里没有。")}</p>
      <label className="kgv-pick kga-row">
        <input
          type="checkbox"
          checked={share}
          data-kga-share
          onChange={(e) => {
            setShare(e.target.checked);
            void settingsStore.set("app", "atlasShareConfirmations", e.target.checked);
          }}
        />
        <span className="kgv-title">{T("匿名分享我确认的知识点关系")}</span>
      </label>
      <p className="form-hint">{T("只发送两个全谱编号和关系类型，不含任何文字；用于改进全谱。打开后，已确认过的关系也会各发送一次。需要先填写上报地址。")}</p>
      <div className="kgv-dl kga-row">
        <input
          className="kgv-model kga-url"
          value={fullUrl}
          placeholder="https://"
          aria-label={T("完整全谱下载地址")}
          data-kga-full-url
          onChange={(e) => setFullUrl(e.target.value)}
          onBlur={saveFullUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(isImeComposing(e))) (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="kgv-dl kga-row">
        <input
          className="kgv-model kga-url"
          value={fullSha}
          placeholder="sha256"
          aria-label={T("完整全谱 SHA-256（可选）")}
          onChange={(e) => setFullSha(e.target.value)}
          onBlur={saveFullSha}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(isImeComposing(e))) (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      {err && <p className="form-hint kgv-err">{err}</p>}
    </section>
  );
}
