// v49.170 / D340：「出现在」——这个知识点在你书架里被「讲」和被「用到」的原文（KG-SOURCE-GROUNDED-DESIGN §3.1 / §6）。
// 每条一句逐字引句；左侧 6px 方块：实心＝这段你读过（unit_reads），空心＝还没读到。点击打开导图上那句所在的节点。
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { kgApi, type TermAppearance, type TermAppearances } from "../../lib/kg";
import { elideParts } from "./MapAppearRows";
import "./kg.css";

const SHOW = 4;

export default function TermAppearRows({ atlasId, onOpenMap }: { atlasId: string; onOpenMap?: (documentId: string, mapId: string, nodeId: string) => void }) {
  const T = useT();
  const [data, setData] = useState<TermAppearances | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    const api = kgApi();
    if (!api?.termAppearances) return;
    const load = () => void api.termAppearances(atlasId).then((r) => alive && setData(r)).catch(() => alive && setData(null));
    load();
    const off = api.onSourceTermsChanged?.(() => load());
    return () => {
      alive = false;
      off?.();
    };
  }, [atlasId]);
  if (!data || data.taught.length + data.used.length === 0) return null;
  const group = (key: "taught" | "used", title: string, list: TermAppearance[]) => {
    if (!list.length) return null;
    const all = open[key] || list.length <= SHOW + 1;
    return (
      <div className="kg-tapp-group" data-role={key}>
        <div className="kg-tapp-k">{T(title)}<span>{list.length}</span></div>
        <ul className="kg-tapp-list">
          {(all ? list : list.slice(0, SHOW)).map((a, i) => {
            const go = a.mapId && a.nodeId && onOpenMap ? () => onOpenMap(a.documentId, a.mapId!, a.nodeId!) : undefined;
            const where = elideParts([a.title, ...a.nodePath].filter(Boolean)).join(" › ");
            return (
              <li key={`${a.documentId}:${a.blockNo}:${i}`} className={a.read ? "is-read" : ""}>
                <i className="kg-tapp-mark" title={a.read ? T("这段你读过") : T("还没读到这段")} aria-label={a.read ? T("这段你读过") : T("还没读到这段")} />
                <div className="kg-tapp-body">
                  {go ? <button className="kg-tapp-q" onClick={go}>「{a.quote}」</button> : <span className="kg-tapp-q">「{a.quote}」</span>}
                  <small>{where}</small>
                </div>
              </li>
            );
          })}
        </ul>
        {!all && (
          <button className="kg-textbtn kg-tapp-more" onClick={() => setOpen((o) => ({ ...o, [key]: true }))}>
            {T("另 {n} 处", { n: list.length - SHOW })}
          </button>
        )}
      </div>
    );
  };
  return (
    <section className="kg-tapp" data-testid="kg-term-appear">
      <div className="kg-sec-title">{T("原文里")}</div>
      {group("taught", "讲它的段落", data.taught)}
      {group("used", "把它当作前提的段落", data.used)}
    </section>
  );
}
