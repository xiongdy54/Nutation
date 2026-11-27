"use strict";
// v49.170 / D340 / I6：原文术语 → 导图节点的归属（KG-SG-IMPL-PLAN §4.1，纯函数，不碰数据库）。
// 节点归属：术语的全局块号 block_no 落在节点 [blockStart, blockEnd] 内；取最深覆盖节点（同深取 node_id 字典序小者）。
//   一份文档可能有多张活动导图：每张图各算一个归属。过期行（block_hash 与会话当前块不符）主进程判不了，
//   这里一律按有效处理（重新抽取时抽取者已软删）。

const TEACH_ROLES = ["defines", "explains", "argues"];
const USE_ROLES = ["uses", "instance"];
const isTeach = (role) => TEACH_ROLES.includes(role);

/** 每个节点的深度（根＝0；父缺失按根；环按截断） */
function withDepths(nodes) {
  const byKey = new Map();
  for (const n of nodes || []) byKey.set(`${n.mapId}\u0000${n.nodeId}`, n);
  const memo = new Map();
  const depthOf = (n) => {
    const key = `${n.mapId}\u0000${n.nodeId}`;
    if (memo.has(key)) return memo.get(key);
    let d = 0;
    const seen = new Set([key]);
    let cur = n;
    while (cur.parentId != null) {
      const pk = `${cur.mapId}\u0000${cur.parentId}`;
      const p = byKey.get(pk);
      if (!p || seen.has(pk)) break;
      seen.add(pk);
      d++;
      cur = p;
    }
    memo.set(key, d);
    return d;
  };
  return (nodes || []).map((n) => ({ ...n, depth: depthOf(n) }));
}

/** 按文档分组的节点索引：Map<documentId, Map<mapId, node[]>>（只含有块区间的节点） */
function buildIndex(nodes) {
  const idx = new Map();
  for (const n of withDepths(nodes)) {
    if (n.blockStart == null || n.blockEnd == null) continue;
    const doc = String(n.documentId);
    if (!idx.has(doc)) idx.set(doc, new Map());
    const maps = idx.get(doc);
    const mapId = String(n.mapId);
    if (!maps.has(mapId)) maps.set(mapId, []);
    maps.get(mapId).push(n);
  }
  return idx;
}

/** 一个块在一张图里的最深覆盖节点（没有则 null） */
function deepestIn(list, blockNo) {
  let best = null;
  for (const n of list) {
    if (blockNo < n.blockStart || blockNo > n.blockEnd) continue;
    if (!best || n.depth > best.depth || (n.depth === best.depth && String(n.nodeId) < String(best.nodeId))) best = n;
  }
  return best;
}

/** 术语（documentId + blockNo）在各张活动图里的归属节点列表 */
function ownersOf(index, documentId, blockNo) {
  const maps = index.get(String(documentId));
  if (!maps) return [];
  const out = [];
  for (const list of maps.values()) {
    const n = deepestIn(list, blockNo);
    if (n) out.push(n);
  }
  return out;
}

module.exports = { TEACH_ROLES, USE_ROLES, isTeach, withDepths, buildIndex, deepestIn, ownersOf };
