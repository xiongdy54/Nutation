// v49.143 / D310 关系图渲染（设计 docs/design/KG-FORCE-GRAPH.md §2）。取代星图 / 纸面点阵 / 雨林三个渲染器。
// 语义通道（KNOWLEDGE-GRAPH-DESIGN §8.5；v49.144 / D312 简化——图上每个节点只有一个圆）：
//   保持度＝墨色深浅（连续）· 轮廓 / 点亮 / 褪色 / 归档＝空心 / 实心 / 浅灰 / 虚线圆 · 到期＝圆本身用强调色。
//   v49.148 / D317：实线只来自用户（已确认）；推断边（全谱 / 材料 / AI / 你写过但没确认）＝淡色细线；学习路线仍是虚线。
//   深度（五个理解侧面）不再画外圈细弧，只在点开后的详情里显示（用户 2026-11-19：图上只要中间那个圆）。
// 颜色只取主题 Token（--kg-*）；字面量只出现在 kg.css 的 Token 块里。
import type { GraphEdge, GraphNode } from "../../lib/kg";

export interface KgPalette {
  canvas: string;
  node: string;
  edge: string;
  due: string;
  fade: string;
  label: string;
  focus: string;
  font: string;
}
type RGB = [number, number, number];

const TOKENS: Record<Exclude<keyof KgPalette, "font">, string> = {
  canvas: "--kg-canvas",
  node: "--kg-node",
  edge: "--kg-edge",
  due: "--kg-due",
  fade: "--kg-fade",
  label: "--kg-label",
  focus: "--kg-focus"
};

const probe = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
function rgba(c: string): [number, number, number, number] {
  if (!probe) return [128, 128, 128, 1];
  probe.fillStyle = "#000";
  probe.fillStyle = c;
  const s = String(probe.fillStyle);
  if (s.startsWith("#") && s.length === 7) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
  const m = (s.match(/[\d.]+/g) || []).map(Number);
  return [m[0] ?? 128, m[1] ?? 128, m[2] ?? 128, m[3] ?? 1];
}
const css = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export interface ResolvedPalette {
  canvas: RGB;
  node: RGB;
  edge: RGB;
  due: RGB;
  fade: RGB;
  label: RGB;
  focus: RGB;
  font: string;
}

/** 读 Token 并把半透明色预先压平到画布色上（深色皮肤的 Token 常带 alpha） */
export function readPalette(el: Element): ResolvedPalette {
  const cs = getComputedStyle(el);
  const raw = (k: string) => rgba(cs.getPropertyValue(k).trim() || cs.getPropertyValue("--ink").trim());
  const c = raw(TOKENS.canvas);
  const canvas: RGB = [c[0], c[1], c[2]];
  const flat = (k: string): RGB => {
    const v = raw(k);
    return mixRgb(canvas, [v[0], v[1], v[2]], v[3]);
  };
  return {
    canvas,
    node: flat(TOKENS.node),
    edge: flat(TOKENS.edge),
    due: flat(TOKENS.due),
    fade: flat(TOKENS.fade),
    label: flat(TOKENS.label),
    focus: flat(TOKENS.focus),
    font: cs.fontFamily || "sans-serif"
  };
}

/** 节点半径（世界坐标）：卡片数与稳定性 */
export function nodeRadius(n: GraphNode): number {
  if (n.kind === "hub") return 6;
  if (n.state === "archived") return 3;
  if (n.state === "ghost") return 3;
  return Math.max(2.6, Math.min(8.5, 2.6 + Math.sqrt(Math.max(0, n.cardCount)) * 1.05 + Math.log2(1 + Math.max(0, n.stability)) * 0.35));
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeOutBack = (t: number) => 1 + 2.6 * Math.pow(t - 1, 3) + 1.6 * Math.pow(t - 1, 2);

export interface DrawNode {
  n: GraphNode;
  x: number;
  y: number;
  /** 悬停 / 聚焦时的淡化系数（0.13–1，由宿主平滑插值） */
  vis: number;
  /** 出生动画进度 0–1 */
  born: number;
  /** 当拍脉冲 1–1.55 */
  pulse: number;
}
export interface DrawEdge {
  e: GraphEdge;
  a: DrawNode;
  b: DrawNode;
  /** 出现动画进度 0–1 */
  shown: number;
  /** v49.143 / D311：线中间的小字（情境层谓词） */
  label?: string;
  /** 淡线（主题归属） */
  faint?: boolean;
  /** v49.172 / D342：关联路径（on＝实线强调；ai＝AI 推测、待确认的虚线） */
  path?: "on" | "ai";
}
export interface DrawState {
  w: number;
  h: number;
  dpr: number;
  view: { x: number; y: number; k: number };
  pal: ResolvedPalette;
  nodes: DrawNode[];
  edges: DrawEdge[];
  activeId: string | null;
  neighbors: Set<string> | null;
  /** 回放中不画到期（到期是「现在」的属性） */
  showDue: boolean;
  /** v49.148 / D317：悬停或选中的连线（加亮） */
  edgeId?: string | null;
  /** v49.148 / D317：悬停节点外缘的连线把手（世界坐标） */
  handle?: { x: number; y: number; on: boolean } | null;
  /** v49.148 / D317：拖线中的预览线（世界坐标）；snapped＝已吸附到目标节点 */
  link?: { x1: number; y1: number; x2: number; y2: number; snapped: boolean } | null;
}

export function drawGraph(ctx: CanvasRenderingContext2D, s: DrawState): void {
  const { pal, view, dpr } = s;
  const k = view.k;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = css(pal.canvas);
  ctx.fillRect(0, 0, s.w, s.h);
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);

  // —— 边 ——
  for (const de of s.edges) {
    const { a, b, e } = de;
    const sel = s.edgeId != null && e.id === s.edgeId;
    if (de.path) {
      // 关联路径：强调色，入场时从一端描到另一端（shown 0→1）
      const al = 0.9 * Math.min(a.born, b.born) * Math.min(1, Math.max(a.vis, b.vis));
      if (al < 0.01) continue;
      const t = de.shown;
      ctx.globalAlpha = al;
      ctx.strokeStyle = css(pal.focus);
      ctx.lineWidth = 1.3 / k;
      ctx.setLineDash(de.path === "ai" ? [4 / k, 3 / k] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      ctx.stroke();
      continue;
    }
    const hl = sel || (s.activeId != null && (e.from === s.activeId || e.to === s.activeId));
    // v49.148 / D317：推断边淡色细线（聚焦时也比实线淡一档）；实线只来自用户
    const inferred = e.status === "suggested" && !de.faint;
    const al = (sel ? 1 : hl ? (inferred ? 0.55 : 0.95) : (de.faint ? 0.16 : inferred ? 0.17 : 0.4) * Math.min(a.vis, b.vis)) * de.shown * Math.min(a.born, b.born);
    if (al < 0.01) continue;
    ctx.globalAlpha = al;
    ctx.strokeStyle = css(hl ? pal.focus : pal.edge);
    ctx.lineWidth = (sel ? 1.6 : hl ? (inferred ? 0.85 : 1.15) : inferred ? 0.55 : 0.7) / k;
    ctx.setLineDash(e.id.startsWith("route:") ? [3 / k, 3 / k] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (hl && e.group === "prerequisite") {
      // 前置：聚焦时目标端一枚小三角（from 是前置，to 是后学）
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const r = nodeRadius(b.n) + 3;
      const tx = b.x - Math.cos(ang) * r;
      const ty = b.y - Math.sin(ang) * r;
      const sz = 3.4 / Math.sqrt(k);
      ctx.setLineDash([]);
      ctx.fillStyle = css(pal.focus);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - Math.cos(ang - 0.45) * sz, ty - Math.sin(ang - 0.45) * sz);
      ctx.lineTo(tx - Math.cos(ang + 0.45) * sz, ty - Math.sin(ang + 0.45) * sz);
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
  // v49.148 / D317：拖线预览（吸附后实线，未吸附时细虚线）
  if (s.link) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = css(pal.focus);
    ctx.lineWidth = 1.2 / k;
    ctx.setLineDash(s.link.snapped ? [] : [4 / k, 3 / k]);
    ctx.beginPath();
    ctx.moveTo(s.link.x1, s.link.y1);
    ctx.lineTo(s.link.x2, s.link.y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // 线中间的小字（只在线本身可见时画；底色压住线，读得清）
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${9.5 / k}px ${pal.font}`;
  for (const de of s.edges) {
    if (!de.label) continue;
    const al = de.shown * Math.min(de.a.born, de.b.born) * Math.min(1, Math.max(de.a.vis, de.b.vis));
    if (al < 0.05) continue;
    const mx = (de.a.x + de.b.x) / 2;
    const my = (de.a.y + de.b.y) / 2;
    const w = ctx.measureText(de.label).width + 6 / k;
    ctx.globalAlpha = al * 0.9;
    ctx.fillStyle = css(pal.canvas);
    ctx.fillRect(mx - w / 2, my - 7 / k, w, 14 / k);
    ctx.globalAlpha = al;
    ctx.fillStyle = css(pal.label);
    ctx.fillText(de.label, mx, my);
  }

  // —— 节点：淡的先画 ——
  const order = s.nodes.slice().sort((p, q) => p.vis - q.vis);
  for (const d of order) {
    const n = d.n;
    const r = nodeRadius(n) * easeOutBack(d.born) * d.pulse;
    if (r <= 0) continue;
    ctx.globalAlpha = d.vis * (n.state === "archived" ? 0.55 : 1);
    ctx.lineWidth = 1.1 / k;
    if (n.kind === "hub") {
      // 主题集群中心：空心细圈（不是知识点，不画侧面 / 到期）
      ctx.fillStyle = css(pal.canvas);
      ctx.strokeStyle = css(pal.edge);
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      continue;
    }
    if (n.state === "outline" || n.state === "ghost") {
      // v49.172 / D342：被点亮的虚影（关联路径 / 聚焦邻居）画得更清楚——仍是虚线空心圆，但不再半透明、略大一圈
      const lit = n.state === "ghost" && !!s.neighbors && s.neighbors.has(n.id);
      ctx.fillStyle = css(pal.canvas);
      ctx.strokeStyle = css(n.state === "ghost" ? (lit ? pal.focus : pal.edge) : pal.node);
      if (n.state === "ghost") {
        ctx.globalAlpha *= lit ? 0.95 : 0.5;
        ctx.setLineDash([1.6 / k, 1.6 / k]);
      }
      ctx.beginPath();
      ctx.arc(d.x, d.y, (lit ? Math.max(r, 4.6) : r) * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (n.state === "archived") {
      ctx.strokeStyle = css(pal.fade);
      ctx.setLineDash([2 / k, 1.6 / k]);
      ctx.beginPath();
      ctx.arc(d.x, d.y, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const ret = 0.3 + 0.7 * Math.max(0, Math.min(1, n.retention));
      const ink = s.showDue && n.due ? pal.due : pal.node; // 到期：圆本身换成强调色（不再加外圈）
      ctx.fillStyle = n.state === "fading" ? css(mixRgb(pal.canvas, pal.fade, 0.55)) : css(mixRgb(pal.canvas, ink, ret));
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // —— 标签：随缩放渐显，大节点先出；悬停 / 聚焦与其邻居总显示 ——
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const d of order) {
    const n = d.n;
    const r = nodeRadius(n);
    const z0 = n.kind === "hub" ? 0.3 : 1.15 - ((r - 2.6) / 6) * 0.55;
    const isAct = n.id === s.activeId;
    const isNb = !!s.neighbors && s.neighbors.has(n.id);
    let la = Math.max(smooth(z0, z0 + 0.3, k), isNb ? 1 : 0) * d.vis * d.born;
    if ((n.state === "ghost" && !isNb) || n.state === "archived") la *= 0.6;
    if (la < 0.02) continue;
    ctx.globalAlpha = la;
    ctx.fillStyle = css(isAct ? pal.node : pal.label);
    ctx.font = `${isAct || n.kind === "hub" ? 600 : 400} ${(isAct ? 12.5 : n.kind === "hub" ? 11.5 : 11) / k}px ${pal.font}`;
    ctx.fillText(n.label, d.x, d.y + r * d.pulse + 5 / k);
  }
  // v49.148 / D317：连线把手（悬停节点外缘的小圆点；指针在把手上时实心）
  if (s.handle) {
    const hr = 3.2 / k;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.1 / k;
    ctx.strokeStyle = css(pal.focus);
    ctx.fillStyle = css(s.handle.on ? pal.focus : pal.canvas);
    ctx.beginPath();
    ctx.arc(s.handle.x, s.handle.y, hr, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
