// v49.139 / D306：「数据」页的知识图谱数字（用户 2026-11-17：「仪表盘数字可以放到数据页签当中去」）。
// 只陈述快照事实：当前点亮数（可下降）、本周变化、褪色、每日维护成本，与近 8 周点亮数小折线（来自回放折叠，不另算事实）。
import "../kg/kg.css";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { foldAt, kgApi, type GraphBundle } from "../../lib/kg";

const WEEK = 7 * 86400000;

export default function KgStatsWidget() {
  const T = useT();
  const [b, setB] = useState<GraphBundle | null>(null);
  useEffect(() => {
    let alive = true;
    void kgApi()?.graph({}).then((x) => { if (alive) setB(x); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  if (!b) return <div className="kg-dash" data-widget-body />;
  const s = b.snapshot.summary;
  const now = b.snapshot.at;
  const series = Array.from({ length: 9 }, (_, i) => (i === 8 ? s.lit : foldAt(b, now - (8 - i) * WEEK).summary.lit));
  const delta = s.lit - series[7];
  const max = Math.max(1, ...series);
  return (
    <div className="kg-dash" data-widget-body data-testid="kg-dash">
      <div className="kg-dash-main">
        <b className="tnum">{s.lit}</b>
        <span>{T("个知识点点亮")}</span>
      </div>
      <div className="kg-dash-meta mono tnum">
        <span>{T("本周 {d}", { d: delta >= 0 ? `+${delta}` : String(delta) })}</span>
        <span>{T("褪色 {n}", { n: s.fading })}</span>
        <span>{T("每日维护约 {n} 次", { n: s.dailyCost.toFixed(1) })}</span>
      </div>
      <div className="kg-dash-spark" role="img" aria-label={T("近 8 周点亮数")}>
        {series.map((v, i) => (
          <i key={i} style={{ height: `${Math.max(2, Math.round((v / max) * 100))}%` }} />
        ))}
      </div>
    </div>
  );
}
