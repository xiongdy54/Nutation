// D315 修订「核心库不是全谱」：全谱搜索没有结果时的提示——本地只有核心词条时，未找到不代表全谱里没有。
// 只在 show（＝搜索已返回且为空）时渲染；状态来自 atlas:status（complete / onlineReady）。
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { atlasApi } from "../../lib/atlas";

export default function AtlasMissHint({ show, className = "kg-map-cap" }: { show: boolean; className?: string }) {
  const T = useT();
  const [st, setSt] = useState<{ complete?: boolean; onlineReady?: boolean } | null>(null);
  useEffect(() => {
    if (!show) return;
    let alive = true;
    void atlasApi()?.atlasStatus().then((s) => alive && setSt(s)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [show]);
  if (!show || !st || st.complete) return null;
  return (
    <span className={className} data-testid="atlas-miss-hint">
      {st.onlineReady ? T("本地是核心词条，已同时查找在线全谱") : T("本地只有核心词条，未找到不代表全谱里没有——开启在线查找或下载完整全谱")}
    </span>
  );
}
