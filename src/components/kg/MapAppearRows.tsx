// v49.146 / D314（T4）：「出现在」导图行——「<材料> › <路径…> › <节点>」，每条可移除，未制卡标记。
import { useT } from "../../lib/i18n";
import type { KpMapAppearance } from "../../lib/kg";
import "./kg.css";

/** 路径过长时中间省略：保留首（材料）与末两级 */
export function elideParts(parts: string[], keep = 4): string[] {
  if (parts.length <= keep) return parts;
  return [parts[0], "…", ...parts.slice(parts.length - (keep - 2))];
}

export default function MapAppearRows({
  maps,
  onOpenMap,
  onRemove,
}: {
  maps: KpMapAppearance[];
  onOpenMap?: (documentId: string, mapId: string, nodeId: string) => void;
  onRemove?: (atlasIds: string[], mapId: string, nodeId: string) => void;
}) {
  const T = useT();
  if (!maps.length) return null;
  return (
    <ul className="kg-neigh" data-testid="kg-appear-maps">
      {maps.map((m) =>
        m.nodes.map((n) => {
          const full = [m.title, ...n.path, n.title].join(" › ");
          const label = elideParts([m.title, ...n.path, n.title]).join(" › ");
          return (
            <li key={m.mapId + n.nodeId} className="kg-maprow" data-map-row={n.nodeId}>
              {onOpenMap ? (
                <button className="kg-link" title={full} onClick={() => onOpenMap(m.documentId, m.mapId, n.nodeId)}>{label}</button>
              ) : (
                <span title={full}>{label}</span>
              )}
              {onRemove && (
                <button className="kg-textbtn" aria-label={T("移除")} title={T("移除这条挂靠")} onClick={() => onRemove(n.atlasIds, m.mapId, n.nodeId)}>×</button>
              )}
              {m.unCarded && <span className="kg-edge-type">{T("讲过，还没制卡")}</span>}
            </li>
          );
        })
      )}
    </ul>
  );
}
