// v49.170 / D340：关联路径「走廊」的版式（设计 KG-SOURCE-GROUNDED-DESIGN §8.8，实施 KG-SG-IMPL-PLAN §5.3）。
// 纯函数，零 DOM：已学终点在左、目标在右，中间节点按「离目标几步」分列；列内按邻居重心排序以减少交叉。
// 边画成水平切线的三次贝塞尔（共用路段只画一次——走廊本身就是并集）。
import type { PathCorridor, PathEdge, PathNode } from "./kg";

export type LensRole = "target" | "learned" | "mid";
export interface LensNode extends PathNode {
  role: LensRole;
  col: number;
  x: number;
  y: number;
  /** 关键桥梁（经过路径数最多的前 3 个中间节点） */
  key: boolean;
}
export interface LensEdge extends PathEdge {
  id: string;
  /** 靠已学一侧 / 靠目标一侧的端点（与数据方向无关，只用于版式与高亮） */
  left: string;
  right: string;
  d: string;
  mx: number;
  my: number;
  /** 从左数第几段（入场描线的先后） */
  step: number;
}
export interface LensLayout {
  nodes: LensNode[];
  edges: LensEdge[];
  cols: number;
  width: number;
  height: number;
}

export interface LensBox {
  width: number;
  height: number;
  /** 左右留白（标签要放得下） */
  padX?: number;
  padTop?: number;
  padBottom?: number;
  /** 同列相邻节点的最小间距 */
  rowGap?: number;
}

export function layoutCorridor(c: PathCorridor, box: LensBox): LensLayout | null {
  const target = c.target?.atlasId;
  const raw = c.nodes || [];
  if (!target || raw.length === 0) return null;
  const padX = box.padX ?? 96;
  const padTop = box.padTop ?? 72;
  const padBottom = box.padBottom ?? 56;
  const rowGap = box.rowGap ?? 56;
  const byId = new Map(raw.map((n) => [n.atlasId, n]));
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  const edgesIn = (c.edges || []).filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  for (const e of edgesIn) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  // 离目标的步数（无向 BFS）；已学节点统一放到最左列
  const hop = new Map<string, number>([[target, 0]]);
  const q = [target];
  while (q.length) {
    const v = q.shift()!;
    for (const w of adj.get(v) || []) {
      if (hop.has(w)) continue;
      hop.set(w, hop.get(v)! + 1);
      if (!byId.get(w)?.learned) q.push(w); // 路径止于已学节点，不穿过它继续排列
    }
  }
  let maxMid = 0;
  for (const n of raw) if (!n.learned && n.atlasId !== target && hop.has(n.atlasId)) maxMid = Math.max(maxMid, hop.get(n.atlasId)!);
  const learnedCol = Math.max(1, maxMid + 1);
  const cols = learnedCol + 1;
  const colOf = (n: PathNode): number => (n.atlasId === target ? 0 : n.learned ? learnedCol : hop.get(n.atlasId) ?? Math.max(1, learnedCol - 1));

  // 关键桥梁
  const keyIds = new Set(
    raw
      .filter((n) => !n.learned && n.atlasId !== target && n.pathCount > 1)
      .sort((a, b) => b.pathCount - a.pathCount || a.atlasId.localeCompare(b.atlasId))
      .slice(0, 3)
      .map((n) => n.atlasId)
  );

  // 列 → 节点，初始按经过路径数降序
  const colsArr: string[][] = Array.from({ length: cols }, () => []);
  for (const n of raw) colsArr[colOf(n)].push(n.atlasId);
  for (const list of colsArr) list.sort((a, b) => (byId.get(b)!.pathCount - byId.get(a)!.pathCount) || a.localeCompare(b));
  // 重心排序：从目标向左扫一遍，再从左向右扫一遍
  const order = new Map<string, number>();
  const setOrder = () => colsArr.forEach((list) => list.forEach((id, i) => order.set(id, i / Math.max(1, list.length - 1 || 1))));
  setOrder();
  const sweep = (from: number, to: number, stepDir: number) => {
    for (let ci = from; ci !== to; ci += stepDir) {
      const list = colsArr[ci];
      const bary = new Map<string, number>();
      for (const id of list) {
        const ns = [...(adj.get(id) || [])].filter((w) => colOf(byId.get(w)!) === ci - stepDir);
        bary.set(id, ns.length ? ns.reduce((s, w) => s + (order.get(w) ?? 0.5), 0) / ns.length : order.get(id) ?? 0.5);
      }
      list.sort((a, b) => bary.get(a)! - bary.get(b)! || a.localeCompare(b));
      list.forEach((id, i) => order.set(id, i / Math.max(1, list.length - 1 || 1)));
    }
  };
  sweep(1, cols, 1);
  sweep(cols - 2, -1, -1);

  // 坐标：x 从左（已学）到右（目标）；y 在可用高度内居中排布
  const tallest = Math.max(...colsArr.map((l) => l.length));
  const innerH = Math.max(box.height - padTop - padBottom, rowGap * (tallest - 1));
  const height = innerH + padTop + padBottom;
  const width = Math.max(box.width, padX * 2 + (cols - 1) * 150);
  const xOf = (col: number) => (cols === 1 ? width / 2 : padX + ((cols - 1 - col) / (cols - 1)) * (width - padX * 2));
  const nodes: LensNode[] = [];
  const pos = new Map<string, { x: number; y: number; col: number }>();
  colsArr.forEach((list, col) => {
    const gap = list.length > 1 ? Math.min(rowGap * 1.6, innerH / (list.length - 1)) : 0;
    const top = padTop + (innerH - gap * (list.length - 1)) / 2;
    list.forEach((id, i) => {
      const n = byId.get(id)!;
      const p = { x: xOf(col), y: top + gap * i, col };
      pos.set(id, p);
      nodes.push({ ...n, role: id === target ? "target" : n.learned ? "learned" : "mid", col, x: p.x, y: p.y, key: keyIds.has(id) });
    });
  });

  const seen = new Set<string>();
  const edges: LensEdge[] = [];
  for (const e of edgesIn) {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const [left, right, L, R] = a.col >= b.col ? [e.from, e.to, a, b] : [e.to, e.from, b, a];
    const id = `${left}>${right}`;
    if (seen.has(id)) continue; // 同一对只画一条（数据层已取最具体的一条）
    seen.add(id);
    let d: string;
    let mx: number;
    let my: number;
    if (L.col === R.col) {
      // 同列：向外鼓的弧
      const bulge = 36 + Math.abs(R.y - L.y) * 0.25;
      d = `M${L.x},${L.y} C${L.x - bulge},${L.y} ${R.x - bulge},${R.y} ${R.x},${R.y}`;
      mx = L.x - bulge * 0.75;
      my = (L.y + R.y) / 2;
    } else {
      const k = (R.x - L.x) * 0.5;
      d = `M${L.x},${L.y} C${L.x + k},${L.y} ${R.x - k},${R.y} ${R.x},${R.y}`;
      mx = (L.x + R.x) / 2;
      my = (L.y + R.y) / 2;
    }
    edges.push({ ...e, id, left, right, d, mx, my, step: cols - 1 - L.col });
  }
  return { nodes, edges, cols, width, height };
}

/** 悬停某节点时要高亮的边：经过它的全部合格路径（向左走到已学、向右走到目标，只沿列单调方向） */
export function edgesThrough(layout: LensLayout, id: string): Set<string> {
  const col = new Map(layout.nodes.map((n) => [n.atlasId, n.col]));
  const out = new Set<string>();
  const walk = (start: string, towardTarget: boolean) => {
    const stack = [start];
    const seen = new Set([start]);
    while (stack.length) {
      const v = stack.pop()!;
      for (const e of layout.edges) {
        const [from, to] = towardTarget ? [e.left, e.right] : [e.right, e.left];
        if (from !== v) continue;
        const cf = col.get(from)!;
        const ct = col.get(to)!;
        if (towardTarget ? ct > cf : ct < cf) continue;
        out.add(e.id);
        if (!seen.has(to)) {
          seen.add(to);
          stack.push(to);
        }
      }
    }
  };
  walk(id, true);
  walk(id, false);
  return out;
}

/** 可靠度三档（KG-SG-IMPL-PLAN §5.3） */
export function reliabilityBand(r: number | null | undefined): "high" | "mid" | "low" | null {
  if (r == null || !Number.isFinite(r)) return null;
  return r >= 0.8 ? "high" : r >= 0.65 ? "mid" : "low";
}

/** 按终点列出最多 n 条完整文字路径（沿走廊从终点一路走到目标，每步取经过路径数最多的下一跳） */
export function samplePaths(layout: LensLayout, from: string, n = 3): string[][] {
  const col = new Map(layout.nodes.map((x) => [x.atlasId, x]));
  const next = (v: string) =>
    layout.edges
      .filter((e) => e.left === v && (col.get(e.right)?.col ?? 0) < (col.get(v)?.col ?? 0))
      .map((e) => e.right)
      .sort((a, b) => (col.get(b)?.pathCount ?? 0) - (col.get(a)?.pathCount ?? 0) || a.localeCompare(b));
  const res: string[][] = [];
  const dfs = (path: string[]) => {
    if (res.length >= n) return;
    const v = path[path.length - 1];
    if (col.get(v)?.role === "target") {
      res.push(path);
      return;
    }
    for (const w of next(v)) {
      if (path.includes(w)) continue;
      dfs([...path, w]);
      if (res.length >= n) return;
    }
  };
  dfs([from]);
  return res;
}

// ---------- v49.172 / D342：图上的关联路径——从走廊里挑出画在关系图上的几条最短路径 ----------
export interface PickedPaths {
  /** 每条路径：已学终点 → … → 目标（全谱 id） */
  paths: string[][];
  nodes: PathNode[];
  edges: PathEdge[];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * 关系图上不能铺满整条走廊（25 个节点会淹没用户自己的图谱）：
 * 先给每个已学终点各取一条最优路径（跳数少 > 可靠度高），再按同样顺序补满；节点总数不超过 maxNodes。
 */
export function pickPaths(c: PathCorridor, opts: { maxPaths?: number; maxNodes?: number } = {}): PickedPaths {
  const maxPaths = opts.maxPaths ?? 6;
  const maxNodes = opts.maxNodes ?? 14;
  const target = c.target?.atlasId;
  const byId = new Map((c.nodes || []).map((n) => [n.atlasId, n]));
  const empty: PickedPaths = { paths: [], nodes: [], edges: [] };
  if (!target || !byId.has(target)) return empty;
  const adj = new Map<string, string[]>();
  const edgeOf = new Map<string, PathEdge>();
  for (const e of c.edges || []) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    const k = pairKey(e.from, e.to);
    const cur = edgeOf.get(k);
    if (cur && cur.p >= e.p) continue;
    edgeOf.set(k, e);
  }
  for (const e of edgeOf.values()) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  for (const l of adj.values()) l.sort();
  // 从目标出发深搜到已学节点（不穿过已学节点）；深度不超过最优跳数 + 2，总条数有上限
  const best = c.best?.hops ?? 0;
  const maxDepth = Math.max(1, best + 2);
  const found: { path: string[]; hops: number; rel: number }[] = [];
  const LIMIT = 400;
  const dfs = (path: string[], rel: number) => {
    if (found.length >= LIMIT) return;
    const v = path[path.length - 1];
    if (path.length > 1 && byId.get(v)?.learned) {
      found.push({ path: [...path].reverse(), hops: path.length - 1, rel });
      return;
    }
    if (path.length - 1 >= maxDepth) return;
    for (const w of adj.get(v) || []) {
      if (path.includes(w)) continue;
      const e = edgeOf.get(pairKey(v, w))!;
      dfs([...path, w], rel * (e.p || 0));
      if (found.length >= LIMIT) return;
    }
  };
  if (byId.get(target)?.learned) return { paths: [[target]], nodes: [byId.get(target)!], edges: [] };
  dfs([target], 1);
  found.sort((a, b) => a.hops - b.hops || b.rel - a.rel || a.path.join().localeCompare(b.path.join()));
  const picked: string[][] = [];
  const nodeSet = new Set<string>();
  const take = (p: string[]) => {
    const add = p.filter((x) => !nodeSet.has(x)).length;
    if (picked.length && nodeSet.size + add > maxNodes) return false;
    picked.push(p);
    for (const x of p) nodeSet.add(x);
    return true;
  };
  const seenEnd = new Set<string>();
  for (const f of found) {
    if (picked.length >= maxPaths) break;
    if (seenEnd.has(f.path[0])) continue;
    seenEnd.add(f.path[0]);
    take(f.path);
  }
  for (const f of found) {
    if (picked.length >= maxPaths) break;
    if (picked.includes(f.path)) continue;
    take(f.path);
  }
  const edgeSet = new Map<string, PathEdge>();
  for (const p of picked) for (let i = 1; i < p.length; i++) {
    const k = pairKey(p[i - 1], p[i]);
    edgeSet.set(k, edgeOf.get(k)!);
  }
  return { paths: picked, nodes: [...nodeSet].map((id) => byId.get(id)!), edges: [...edgeSet.values()] };
}

const PRED_TYPE_TEXT: Record<string, string> = { b: "属于", e: "例子", c: "区分", u: "应用", p: "前置", a: "类比" };
/** 线上的小字：谓词（未翻译的中文键，渲染层再过 T） */
export function pathPredText(e: { type: string; pred: string | null; source?: string }): string {
  if (e.pred) return e.pred;
  return PRED_TYPE_TEXT[e.type] || (e.source === "material" ? "论证" : "关联");
}

// ---------- v49.172 / D342：图上路径的固定版式（「泳道」）——不交给力模拟，免得最短的那条把其余路径挤成一团 ----------
export type Pt = [number, number];
/**
 * 每条路径一条泳道：从已学终点（位置不动）弯向目标。目标与终点的距离按**最长**路径的跳数定（每跳 spacing），
 * 方向保持目标原来相对终点的方向（targetAt），
 * 不按最短路径——直连的一跳不会再把多跳路径压扁。同一终点的多条路径按跳数从中间向两侧排开（最短的走中线），
 * 中间节点沿泳道等距，横向偏移按 sin 弯出，两端收拢到终点与目标。共享的中间节点只放一次（先到先得）。
 * @returns 目标与中间节点的位置（不含终点）
 */
export function laneLayout(args: { paths: string[][]; fixed: Map<string, Pt>; center: Pt; spacing?: number; laneGap?: number; targetAt?: Pt | null }): Map<string, Pt> {
  const spacing = args.spacing ?? 100;
  const laneGap = args.laneGap ?? 58;
  const out = new Map<string, Pt>();
  const paths = args.paths.filter((p) => p.length >= 2 && args.fixed.has(p[0]));
  if (!paths.length) return out;
  const target = paths[0][paths[0].length - 1];
  const ends = [...new Set(paths.map((p) => p[0]))];
  const E: Pt = [0, 0];
  for (const e of ends) {
    const q = args.fixed.get(e)!;
    E[0] += q[0] / ends.length;
    E[1] += q[1] / ends.length;
  }
  // 方向：目标已经在图上时保持它相对终点的原方向（打开路径不应让它跳到另一侧）；否则朝远离图谱中心的一侧
  const ref = args.targetAt;
  let dx = ref ? ref[0] - E[0] : E[0] - args.center[0];
  let dy = ref ? ref[1] - E[1] : E[1] - args.center[1];
  let l = Math.hypot(dx, dy);
  if (l < 1e-6) {
    dx = 1;
    dy = 0;
    l = 1;
  }
  const maxHops = Math.max(...paths.map((p) => p.length - 1));
  const D = spacing * Math.max(1.5, maxHops);
  // 目标已在图上、距离也合适（最长路径所需的 0.8–1.6 倍）→ 原地不动；否则沿原方向移到所需距离
  const keep = !!ref && l >= D * 0.8 && l <= D * 1.6;
  const T: Pt = keep ? [ref![0], ref![1]] : [E[0] + (dx / l) * D, E[1] + (dy / l) * D];
  out.set(target, T);
  for (const e of ends) {
    const group = paths.filter((p) => p[0] === e).sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));
    const P = args.fixed.get(e)!;
    const ux = T[0] - P[0];
    const uy = T[1] - P[1];
    const ul = Math.hypot(ux, uy) || 1;
    const nx = -uy / ul;
    const ny = ux / ul;
    group.forEach((p, j) => {
      // 0, +1, −1, +2, −2 …：最短的走中线
      const slot = j === 0 ? 0 : (j % 2 === 1 ? 1 : -1) * Math.ceil(j / 2);
      const k = p.length - 1;
      for (let i = 1; i < k; i++) {
        const id = p[i];
        if (out.has(id) || args.fixed.has(id)) continue;
        const t = i / k;
        const off = slot * laneGap * Math.sin(Math.PI * t) * 1.25;
        out.set(id, [P[0] + ux * t + nx * off, P[1] + uy * t + ny * off]);
      }
    });
  }
  return out;
}
