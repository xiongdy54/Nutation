// v49.143 / D310 图谱页：关系图（设计 docs/design/KG-FORCE-GRAPH.md；样张 design-samples/kg-force/）。
// 宿主只做三件事：取快照与事件流、把交互意图翻成真实动作、把关系图画到画布上。
// 图谱界面不出现待办计数与红点（§1.1）；所有数字都来自快照（可下降）。
import "./kg.css";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/ime";
import { beatAtFrac, buildSchedule, posOf, stateAt } from "../../lib/kgReplay";
import { changingBeatsOf, eventNodeIds, FACETS, foldAt, kgApi, skippedDays, type GraphBundle, type GraphNode, type GraphSnapshot, type KpAppearanceMaterial, type KpAppearances, type KpMapAppearance } from "../../lib/kg";

type JumpToDoc = (docId: string, anchor: NonNullable<KpAppearanceMaterial["anchor"]>, kpId: string) => void;
import { ForceSim, seedPosition, type SimLink, type SimNode } from "../../lib/kgForce";
import { drawGraph, nodeRadius, readPalette, type DrawEdge, type DrawNode, type ResolvedPalette } from "./graphRenderer";
import { aiConfigUsable, aiGateway } from "../../lib/ai";
import { atlasApi, atlasGloss, atlasLabel, CONTEXT_EDGE_CAP, edgeText, rankContext, relationText, type AtlasNeighbor, type AtlasNode, type AtlasNodeDetail, type Roadmap } from "../../lib/atlas";
import type { GraphEdge } from "../../lib/kg";
import EditableField from "../editor/EditableField";
import MarkdownEditor from "../editor/MarkdownEditor";
import { knowledgeApi, relationLabel, KP_RELATION_TYPES, type KnowledgePoint, type KnowledgeRelationType } from "../../lib/knowledge";
import AttachExistingCards from "./AttachExistingCards";
import AtlasMissHint from "./AtlasMissHint";
import MapAppearRows from "./MapAppearRows";
import AtlasReport from "./AtlasReport";
import { IconKgDots, IconKgHelp, IconKgPause, IconKgPlay, IconKgSearch, PlotSvg } from "../icons";
import { EdgePanel, LinkCard, LinkSearch, type KgToast } from "./EdgePanel";
// 解散预览按需加载（首屏包体预算 d237）
const ReattachPreview = lazy(() => import("./ReattachPreview"));
import type { ReattachResult } from "../../lib/atlas";

type OpenMap = (documentId: string, mapId: string, nodeId: string) => void;

type Filter = "all" | "islands" | "due" | "fading";
const DAY = 86400000;
const STATE_LABEL: Record<GraphNode["state"], string> = {
  ghost: "虚影",
  outline: "轮廓",
  lit: "点亮",
  solid: "稳固",
  firm: "牢固",
  fading: "褪色",
  archived: "归档"
};
const FACET_LABEL: Record<string, string> = { definition: "是什么", why: "为什么", example: "举例 / 应用", contrast: "区分", relation: "关系" };

function motionOn(): boolean {
  if (typeof document === "undefined") return false;
  if (document.body.classList.contains("motion-off")) return false;
  return !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** 图谱页叠加的边（全谱情境层 / 主题归属 / 学习路线）：不进快照事实 */
type ViewEdge = GraphEdge & { label?: string; faint?: boolean; w?: number };
const NO_FACETS: GraphNode["facets"] = { definition: "none", why: "none", example: "none", contrast: "none", relation: "none" };
/** 合成节点：全谱虚影（ghost）或主题集群中心（hub） */
function synthNode(id: string, label: string, anchor: string | null, kind: GraphNode["kind"] = "concept"): GraphNode {
  return { id, label, definition: "", defVersion: 0, kind, state: kind === "hub" ? "outline" : "ghost", retention: 0, stability: 0, depth: 0, facets: NO_FACETS, confidence: "low", due: false, dailyCost: 0, litAt: null, anchorId: anchor, themeId: null, atlasId: null, cardCount: 0, extractCount: 0 };
}
const GROUP_OF: Record<AtlasNeighbor["type"], GraphEdge["group"]> = { b: "hierarchy", p: "prerequisite", c: "contrast", a: "analogy", e: "support", u: "support", r: "support" };

interface Anim {
  vis: Map<string, number>;
  born: Map<string, number>;
  pulse: Map<string, number>;
  edgeShown: Map<string, number>;
  home: Map<string, [number, number]>;
  last: Map<string, [number, number]>;
}

export default function KnowledgeGraphView({ onReview, initialFocusId, autoReplayToday, onJumpToDoc, onOpenMap }: { onReview: (kpIds: string[], title: string) => void; initialFocusId?: string | null; autoReplayToday?: boolean; onJumpToDoc?: JumpToDoc; onOpenMap?: OpenMap }) {
  const T = useT();
  const [bundle, setBundle] = useState<GraphBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [showGhosts, setShowGhosts] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(initialFocusId ?? null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [beat, setBeat] = useState<number | null>(null); // null＝现在
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skipNote, setSkipNote] = useState<string | null>(null);
  const [replayNote, setReplayNote] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const simRef = useRef(new ForceSim());
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const goalRef = useRef({ x: 0, y: 0, k: 1 });
  const animRef = useRef<Anim>({ vis: new Map(), born: new Map(), pulse: new Map(), edgeShown: new Map(), home: new Map(), last: new Map() });
  const palRef = useRef<ResolvedPalette | null>(null);
  const playRef = useRef<{ clock: number } | null>(null);
  const placedRef = useRef(false);
  const motion = motionOn();
  // v49.148 / D317 连线三层：点开连线、悬停连线、拖线连线、提示条
  const [edgeSel, setEdgeSel] = useState<{ a: string; b: string } | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [linkCard, setLinkCard] = useState<{ from: string; to: string; x: number; y: number } | null>(null);
  const [linkSearch, setLinkSearch] = useState<{ from: string; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<KgToast | null>(null);
  const handleRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const handleOnRef = useRef(false);
  const linkDragRef = useRef<{ from: string; sx: number; sy: number; target: string | null } | null>(null);
  const linkRef = useRef<{ x1: number; y1: number; x2: number; y2: number; snapped: boolean } | null>(null);
  useEffect(() => {
    if (focusId) setEdgeSel(null);
  }, [focusId]);
  // GUI 端到端用例的只读探针：节点的屏幕坐标（挂在画布元素上，不进全局；只读不写）
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    (cv as unknown as { kgProbe?: { pos(id: string): [number, number] | null } }).kgProbe = {
      pos: (id: string) => {
        const sn = simRef.current.get(id);
        const v = viewRef.current;
        const r = cv.getBoundingClientRect();
        return sn ? [r.left + sn.x * v.k + v.x, r.top + sn.y * v.k + v.y] : null;
      }
    };
  }, [bundle]);
  useEffect(() => {
    if (!toast || toast.reportAtlasId) return;
    const h = window.setTimeout(() => setToast(null), 10000);
    return () => window.clearTimeout(h);
  }, [toast]);
  // v49.141 / D308：整理已有卡片 / 已有知识
  const [attachOpen, setAttachOpen] = useState(false);
  const [unattached, setUnattached] = useState<number | null>(null);
  const [addingKnown, setAddingKnown] = useState(false);
  const refreshUnattached = useCallback(() => {
    const a = (window as unknown as { kgAPI?: { unattachedCards(limit?: number): Promise<unknown[]> } }).kgAPI;
    void a?.unattachedCards(2000).then((x) => setUnattached(x.length)).catch(() => setUnattached(null));
  }, []);
  useEffect(() => refreshUnattached(), [refreshUnattached]);
  // v49.140 / D307：手动合并过重复知识点、且语义匹配仍为「不使用」时，一行可关的轻提示
  const [vecHint, setVecHint] = useState(false);
  const [vecHintDismissed, setVecHintDismissed] = useState(() => localStorage.getItem("kg.vectorHintDismissed") === "1");
  useEffect(() => {
    const a = (window as unknown as { kgAPI?: { vectorStatus(): Promise<{ mode: string; manualMerges: number }> } }).kgAPI;
    void a?.vectorStatus().then((v) => setVecHint(v.mode === "none" && v.manualMerges > 0)).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const api = kgApi();
    if (!api) {
      setError(T("图谱接口不可用"));
      return;
    }
    try {
      setBundle(await api.graph({}));
    } catch (e) {
      setError(String((e as Error)?.message || e));
    }
  }, [T]);
  useEffect(() => {
    void load();
  }, [load]);

  const beats = useMemo(() => (bundle ? changingBeatsOf(bundle) : []), [bundle]);
  const now = bundle?.snapshot.at ?? Date.now();
  const sched = useMemo(() => buildSchedule(beats, now), [beats, now]);
  const [barHov, setBarHov] = useState(false);
  const [barFoc, setBarFoc] = useState(false);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const tlRef = useRef<HTMLDivElement | null>(null);
  const hovTimer = useRef(0);
  const hovOn = useCallback(() => {
    window.clearTimeout(hovTimer.current);
    setBarHov(true);
  }, []);
  // 离开后略延迟收起：指针从播放钮移向时间轴的途中不会让轴消失
  const hovOff = useCallback(() => {
    window.clearTimeout(hovTimer.current);
    hovTimer.current = window.setTimeout(() => setBarHov(false), 280);
  }, []);
  useEffect(() => () => window.clearTimeout(hovTimer.current), []);
  const paintDot = useCallback((pos: number) => {
    const tl = tlRef.current;
    if (!tl) return;
    if (knobRef.current) knobRef.current.style.transform = `translateX(${pos * tl.clientWidth}px)`;
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${pos})`;
  }, []);
  const playT = beat == null ? null : beats[beat]?.end ?? null;
  const snap: GraphSnapshot | null = useMemo(() => (bundle ? (playT == null ? bundle.snapshot : foldAt(bundle, playT)) : null), [bundle, playT]);

  const baseVisible = useMemo(() => {
    if (!snap) return [] as GraphNode[];
    if (playT != null) return snap.nodes.filter((n) => n.state !== "ghost");
    const confirmedDeg = new Map<string, number>();
    for (const e of snap.edges)
      if (e.status === "confirmed") {
        confirmedDeg.set(e.from, (confirmedDeg.get(e.from) || 0) + 1);
        confirmedDeg.set(e.to, (confirmedDeg.get(e.to) || 0) + 1);
      }
    return snap.nodes.filter((n) => {
      if (n.state === "ghost" && !showGhosts) return false;
      if (filter === "islands") return n.litAt != null && !confirmedDeg.get(n.id);
      if (filter === "due") return n.due;
      if (filter === "fading") return n.state === "fading";
      return true;
    });
  }, [snap, filter, showGhosts, playT]);
  const baseById = useMemo(() => new Map(baseVisible.map((n) => [n.id, n])), [baseVisible]);

  // ---------------- v49.143 / D311 全谱：情境层 / 主题集群 / 学习路线（只在「现在」叠加，回放时不叠） ----------------
  const [atlasOn, setAtlasOn] = useState(false);
  useEffect(() => {
    void atlasApi()?.atlasStatus().then((x) => setAtlasOn(!!x?.available)).catch(() => undefined);
  }, []);
  const atlasFocus = focusId?.startsWith("atlas:") ? focusId.slice(6) : focusId?.startsWith("hub:atlas:") ? focusId.slice(10) : null;
  const focusAtlasId = atlasFocus ?? (focusId && snap ? snap.nodes.find((n) => n.id === focusId)?.atlasId ?? null : null);
  const [ctx, setCtx] = useState<{ atlasId: string; rows: AtlasNeighbor[]; node: AtlasNodeDetail | null; complete: boolean; truncated: boolean } | null>(null);
  useEffect(() => {
    const api = atlasApi();
    if (!atlasOn || !api || !focusAtlasId || playT != null) {
      setCtx(null);
      return;
    }
    let alive = true;
    void Promise.all([api.atlasNeighbors(focusAtlasId, { layer: "all", withMeta: true }), api.atlasNode(focusAtlasId)])
      .then(([nb, node]) => alive && setCtx({ atlasId: focusAtlasId, rows: nb.rows || [], node, complete: nb.complete !== false, truncated: nb.truncated === true }))
      .catch(() => alive && setCtx(null));
    return () => {
      alive = false;
    };
  }, [atlasOn, focusAtlasId, playT]);
  // v49.154 / D323 / A3：聚焦节点的关系不完整，或世界层本身不完整 → 节点详情里一行提示
  const atlasRelationsIncomplete = !!(
    (ctx && ctx.atlasId === focusAtlasId && (!ctx.complete || ctx.truncated)) ||
    bundle?.world?.complete === false
  );
  const [route, setRoute] = useState<{ target: string; data: Roadmap | null } | null>(null);
  useEffect(() => {
    if (!route || route.data) return;
    let alive = true;
    const target = route.target;
    void atlasApi()?.atlasRoadmap([target]).then((d) => alive && setRoute((r) => (r && r.target === target ? { ...r, data: d } : r))).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [route]);

  const overlay = useMemo(() => {
    const nodes: GraphNode[] = [];
    const edges: ViewEdge[] = [];
    if (!snap || playT != null) return { nodes, edges };
    const byAtlas = new Map(baseVisible.filter((n) => n.atlasId).map((n) => [n.atlasId as string, n.id]));
    const have = new Set(baseVisible.map((n) => n.id));
    const add = (n: GraphNode) => {
      if (have.has(n.id)) return;
      have.add(n.id);
      nodes.push(n);
    };
    const gid = (q: string) => byAtlas.get(q) ?? "atlas:" + q;
    // 主题集群：同一全谱主题下 ≥2 个节点时，连到主题（主题本身是用户知识点就连到它，否则合成空心中心）
    for (const th of snap.themes) {
      if (!th.id.startsWith("atlas:")) continue;
      const members = th.nodeIds.filter((id) => baseById.has(id));
      if (members.length < 2) continue;
      const hub = byAtlas.get(th.id.slice(6)) ?? "hub:" + th.id;
      if (hub.startsWith("hub:")) add(synthNode(hub, th.label, null, "hub"));
      for (const m of members) if (m !== hub) edges.push({ id: `hubE:${m}>${hub}`, from: m, to: hub, type: "part_of", group: "hierarchy", status: "confirmed", strength: 0.2, faint: true, w: 0.25 });
    }
    // 聚焦：情境层（用户节点只叠情境边；全谱节点叠全部关系）——图上至多 CONTEXT_EDGE_CAP 条，其余进详情列表
    if (ctx && ctx.atlasId === focusAtlasId && focusId) {
      const center = atlasFocus ? gid(ctx.atlasId) : focusId;
      if (atlasFocus && !have.has(center)) add(synthNode(center, ctx.node ? atlasLabel(ctx.node) : ctx.atlasId, null, focusId.startsWith("hub:") ? "hub" : "concept"));
      const rows = rankContext(ctx.rows.filter((r) => atlasFocus || r.layer === "context")).slice(0, CONTEXT_EDGE_CAP);
      for (const r of rows) {
        const other = gid(r.node.id);
        if (other === center) continue;
        add(synthNode(other, atlasLabel(r.node), center));
        const [from, to] = r.out ? [center, other] : [other, center];
        const text = edgeText(r);
        edges.push({ id: `ctx:${from}>${to}:${r.type}:${r.pred ?? ""}`, from, to, type: r.type, group: GROUP_OF[r.type], status: "confirmed", strength: 0.15, label: text ? T(text) : undefined, w: 0.3 });
      }
    }
    // 学习路线：缺口节点沿前置边排开
    if (route?.data) {
      const ids = new Map<string, string>();
      const targetId = gid(route.target);
      for (const g of route.data.gap) {
        const id = g.kp && baseById.has(g.kp.id) ? g.kp.id : gid(g.id);
        ids.set(g.id, id);
        add(synthNode(id, atlasLabel(g), have.has(targetId) ? targetId : null));
      }
      for (const g of route.data.gap)
        for (const pq of g.prereqs) {
          const a = ids.get(pq);
          const b = ids.get(g.id);
          if (a && b) edges.push({ id: `route:${a}>${b}`, from: a, to: b, type: "prerequisite", group: "prerequisite", status: "suggested", strength: 0.5, w: 0.6 });
        }
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, playT, baseVisible, baseById, ctx, focusAtlasId, focusId, atlasFocus, route]);

  const visible = useMemo(() => (overlay.nodes.length ? [...baseVisible, ...overlay.nodes] : baseVisible), [baseVisible, overlay]);
  const visById = useMemo(() => new Map(visible.map((n) => [n.id, n])), [visible]);
  const visEdges = useMemo((): ViewEdge[] => {
    const base: ViewEdge[] = snap ? snap.edges.filter((e) => visById.has(e.from) && visById.has(e.to) && (playT == null || e.status === "confirmed")) : [];
    return overlay.edges.length ? [...base, ...overlay.edges.filter((e) => visById.has(e.from) && visById.has(e.to))] : base;
  }, [snap, visById, playT, overlay]);

  const activeId = hoverId ?? focusId;
  const neighborSet = useMemo(() => {
    if (!activeId) return null;
    const s = new Set<string>([activeId]);
    for (const e of visEdges) {
      if (e.from === activeId) s.add(e.to);
      if (e.to === activeId) s.add(e.from);
    }
    return s;
  }, [activeId, visEdges]);

  // ---------------- 视图 ----------------
  const fit = useCallback((instant: boolean, ids?: string[]) => {
    const wrap = wrapRef.current;
    const sim = simRef.current;
    if (!wrap) return;
    const w = wrap.clientWidth || 800;
    const h = wrap.clientHeight || 600;
    const home = animRef.current.home;
    const pts = (ids ?? sim.nodes.map((n) => n.id)).map((id) => home.get(id) ?? (sim.get(id) ? [sim.get(id)!.x, sim.get(id)!.y] : null)).filter(Boolean) as [number, number][];
    if (!pts.length) {
      goalRef.current = { k: 1, x: w / 2, y: h / 2 };
    } else {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const k = clamp(Math.min((w - 120) / (x1 - x0 + 1), (h - 170) / (y1 - y0 + 1)), 0.2, 2.4);
      goalRef.current = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 + 6 - ((y0 + y1) / 2) * k };
    }
    if (instant || !motion) viewRef.current = { ...goalRef.current };
  }, [motion]);

  // ---------------- 力模拟：可见集合变化 → 增删节点（新节点从锚点长出） ----------------
  useEffect(() => {
    if (!snap) return;
    const sim = simRef.current;
    const A = animRef.current;
    const t0 = performance.now();
    const prev = new Map(sim.nodes.map((n) => [n.id, n]));
    const themeIdx = new Map(snap.themes.map((th, i) => [th.id, i]));
    const R = 60 + Math.sqrt(Math.max(1, visible.length)) * 38;
    const first = !placedRef.current;
    const next: SimNode[] = visible.map((n) => {
      const old = prev.get(n.id);
      const simR = n.state === "ghost" || n.kind === "hub" ? Math.max(nodeRadius(n), 14) : nodeRadius(n);
      if (old) {
        old.r = simR;
        return old;
      }
      let x: number, y: number;
      let vx = 0, vy = 0;
      const anchor = n.anchorId ? prev.get(n.anchorId) : undefined;
      const home = A.home.get(n.id);
      if (!first && anchor) {
        const ah = A.home.get(anchor.id);
        let dx = home && ah ? home[0] - ah[0] : 1;
        let dy = home && ah ? home[1] - ah[1] : 0;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        x = anchor.x + dx * 6;
        y = anchor.y + dy * 6;
        vx = dx * 3.2;
        vy = dy * 3.2;
      } else {
        const p = A.last.get(n.id) ?? home ?? seedPosition(n.id, n.themeId ? themeIdx.get(n.themeId) ?? 0 : 0, snap.themes.length, R);
        x = p[0];
        y = p[1];
      }
      if (!first) A.born.set(n.id, t0);
      return { id: n.id, x, y, vx, vy, fx: null, fy: null, r: simR };
    });
    const keep = new Set(next.map((n) => n.id));
    for (const n of sim.nodes) if (!keep.has(n.id)) A.last.set(n.id, [n.x, n.y]);
    const links: SimLink[] = visEdges.map((e) => ({ s: e.from, t: e.to, w: e.w ?? (e.status === "suggested" ? 0.5 : 1) }));
    const prevEdges = new Set(sim.links.map((l) => `${l.s}>${l.t}`));
    for (const e of visEdges) if (!prevEdges.has(`${e.from}>${e.to}`) && !first) A.edgeShown.set(e.id, t0);
    sim.setGraph(next, links);
    if (first) {
      // 首次：同步预演出「家」位置 → 视野适配 → 从中心舒展开
      placedRef.current = true;
      sim.alpha = 1;
      sim.settle(320);
      for (const n of sim.nodes) A.home.set(n.id, [n.x, n.y]);
      fit(true);
      const fp = initialFocusId ? sim.get(initialFocusId) : null;
      if (fp) {
        const wrap = wrapRef.current;
        const k2 = Math.max(goalRef.current.k, 1.2);
        goalRef.current = { k: k2, x: (wrap?.clientWidth || 800) / 2 - fp.x * k2, y: (wrap?.clientHeight || 600) / 2 - fp.y * k2 };
        viewRef.current = { ...goalRef.current };
      }
      if (motion) {
        for (const n of sim.nodes) {
          n.x *= 0.25;
          n.y *= 0.25;
        }
        sim.alpha = 0.7;
      }
    } else {
      sim.reheat(playRef.current ? 0.3 : 0.4);
      if (!motion) sim.settle(300);
    }
    kick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, visEdges]);

  // ---------------- 主循环：只在有东西在动时跑帧 ----------------
  const rafRef = useRef(0);
  const lastTs = useRef(0);
  const selEdgeId = useMemo(() => {
    if (!edgeSel || !snap) return null;
    const k = [edgeSel.a, edgeSel.b].sort().join("|");
    return snap.edges.find((e) => [e.from, e.to].sort().join("|") === k)?.id ?? null;
  }, [edgeSel, snap]);
  const edgeHl = hoverEdge ?? selEdgeId;
  const stateRef = useRef({ visible, visEdges, activeId, neighborSet, beats, beat, speed, playT, visById, sched, edgeHl, hoverId });
  stateRef.current = { visible, visEdges, activeId, neighborSet, beats, beat, speed, playT, visById, sched, edgeHl, hoverId };

  const frame = useCallback(
    (ts: number) => {
      rafRef.current = 0;
      const cv = canvasRef.current;
      const wrap = wrapRef.current;
      if (!cv || !wrap) return;
      const S = stateRef.current;
      const A = animRef.current;
      const sim = simRef.current;
      const dt = lastTs.current ? Math.min(64, ts - lastTs.current) : 16;
      lastTs.current = ts;
      let busy = false;
      // 回放推进
      const pl = playRef.current;
      if (pl && S.beat != null) {
        busy = true;
        pl.clock += dt * S.speed;
        const st = stateAt(S.sched, pl.clock);
        if (st.done) {
          playRef.current = null;
          paintDot(1);
          setPlaying(false);
          setBeat(null);
        } else {
          paintDot(st.pos);
          if (st.beat !== S.beat) setBeat(st.beat);
        }
      }
      if (sim.running()) {
        sim.tick();
        busy = true;
      }
      const v = viewRef.current;
      const g = goalRef.current;
      const z = motion ? 1 - Math.exp(-dt / 70) : 1;
      for (const key of ["x", "y", "k"] as const) {
        const d = g[key] - v[key];
        if (Math.abs(d) > (key === "k" ? 1e-4 : 0.05)) {
          v[key] += d * z;
          busy = true;
        } else v[key] = g[key];
      }
      const fz = motion ? 1 - Math.exp(-dt / 60) : 1;
      for (const n of S.visible) {
        const tgt = !S.neighborSet || S.neighborSet.has(n.id) ? 1 : 0.13;
        const cur = A.vis.get(n.id) ?? 1;
        if (Math.abs(tgt - cur) > 0.005) {
          A.vis.set(n.id, cur + (tgt - cur) * fz);
          busy = true;
        } else A.vis.set(n.id, tgt);
      }
      // 尺寸
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${h}px`;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      if (!palRef.current) palRef.current = readPalette(wrap);
      const prog = (m: Map<string, number>, id: string, ms: number) => {
        const t = m.get(id);
        if (t == null || !motion) return 1;
        const p = clamp((ts - t) / ms, 0, 1);
        if (p < 1) busy = true;
        return p;
      };
      const dn = new Map<string, DrawNode>();
      for (const n of S.visible) {
        const sn = sim.get(n.id);
        if (!sn) continue;
        const pt = A.pulse.get(n.id);
        let pulse = 1;
        if (motion && pt != null && ts - pt < 650) {
          pulse = 1 + 0.55 * Math.pow(1 - (ts - pt) / 650, 2);
          busy = true;
        }
        dn.set(n.id, { n, x: sn.x, y: sn.y, vis: A.vis.get(n.id) ?? 1, born: prog(A.born, n.id, 520), pulse });
      }
      const de: DrawEdge[] = [];
      for (const e of S.visEdges) {
        const a = dn.get(e.from);
        const b = dn.get(e.to);
        if (a && b) de.push({ e, a, b, shown: prog(A.edgeShown, e.id, 450), label: e.label, faint: e.faint });
      }
      // v49.148 / D317：悬停节点外缘的连线把手（远离画面中心的一侧，不挡标签）
      let handle: { x: number; y: number; on: boolean } | null = null;
      const hn = S.hoverId && S.playT == null && !linkDragRef.current && !dragRef.current ? dn.get(S.hoverId) : undefined;
      if (hn && isLinkable(hn.n)) {
        const cx = (w / 2 - v.x) / v.k;
        const cy = (h / 2 - v.y) / v.k;
        let dx = hn.x - cx;
        let dy = hn.y - cy;
        const l = Math.hypot(dx, dy);
        if (l < 1e-3) {
          dx = 1;
          dy = 0;
        } else {
          dx /= l;
          dy /= l;
        }
        const rr = nodeRadius(hn.n) + 6 / v.k;
        handle = { x: hn.x + dx * rr, y: hn.y + dy * rr, on: handleOnRef.current };
        handleRef.current = { id: hn.n.id, x: handle.x, y: handle.y };
      } else if (!linkDragRef.current) {
        handleRef.current = null;
      }
      drawGraph(ctx, { w, h, dpr, view: v, pal: palRef.current, nodes: [...dn.values()], edges: de, activeId: S.activeId, neighbors: S.neighborSet, showDue: S.playT == null, edgeId: S.edgeHl, handle, link: linkRef.current });
      if (busy) rafRef.current = requestAnimationFrame(frame);
      else lastTs.current = 0;
    },
    [motion, paintDot]
  );
  const kick = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(frame);
  }, [frame]);
  useEffect(() => {
    kick();
  }, [kick, activeId, visible, beat, edgeHl]);
  useEffect(() => {
    const onResize = () => kick();
    window.addEventListener("resize", onResize);
    // 皮肤 / 明暗切换后重读调色板
    const mo = new MutationObserver(() => {
      palRef.current = null;
      kick();
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    return () => {
      window.removeEventListener("resize", onResize);
      mo.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [kick]);

  // ---------------- 交互：拖拽（弹性）/ 平移 / 缩放 / 悬停 / 聚焦 ----------------
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const hitTest = useCallback((cx: number, cy: number): string | null => {
    const v = viewRef.current;
    const wx = (cx - v.x) / v.k;
    const wy = (cy - v.y) / v.k;
    let best: string | null = null;
    let bd = Infinity;
    for (const n of simRef.current.nodes) {
      const r = n.r + 5 / v.k;
      const d2 = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (d2 <= r * r && d2 < bd) {
        bd = d2;
        best = n.id;
      }
    }
    return best;
  }, []);
  const dragRef = useRef<{ id: string | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  // v49.148 / D317：能连线的节点＝用户自己的、未归档的知识点（全谱虚影 / 主题中心不行）
  const isLinkable = (n: GraphNode | undefined | null): n is GraphNode =>
    !!n && n.kind !== "hub" && !n.id.startsWith("atlas:") && !n.id.startsWith("hub:") && n.state !== "ghost" && n.state !== "archived";
  const nodeById = (id: string | null) => (id && snap ? snap.nodes.find((n) => n.id === id) ?? null : null);
  /** 连线命中：点到线段的距离 ≤ 5 px（屏幕）；只认快照里的边（全谱情境 / 主题 / 路线叠加边不可点） */
  const hitEdge = (cx: number, cy: number): GraphEdge | null => {
    const v = viewRef.current;
    const wx = (cx - v.x) / v.k;
    const wy = (cy - v.y) / v.k;
    const tol = 5 / v.k;
    let best: GraphEdge | null = null;
    let bd = Infinity;
    for (const e of stateRef.current.visEdges) {
      if (/^(hubE|ctx|route):/.test(e.id)) continue;
      const a = simRef.current.get(e.from);
      const b = simRef.current.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = clamp(((wx - a.x) * dx + (wy - a.y) * dy) / l2, 0, 1);
      const d = Math.hypot(a.x + t * dx - wx, a.y + t * dy - wy);
      if (d <= tol && d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  };
  const openEdge = (a: string, b: string) => {
    setFocusId(null);
    setLinkCard(null);
    setLinkSearch(null);
    setEdgeSel({ a, b });
  };
  /** 弹出连线卡片：默认放在两端连线的中点（屏幕坐标），夹在画布内 */
  const openLinkCard = (from: string, to: string, px?: number, py?: number) => {
    const wrap = wrapRef.current;
    const v = viewRef.current;
    const A = simRef.current.get(from);
    const B = simRef.current.get(to);
    const W = wrap?.clientWidth || 800;
    const H = wrap?.clientHeight || 600;
    const CARD_H = 200;
    let x = px ?? (A && B ? ((A.x + B.x) / 2) * v.k + v.x : W / 2);
    let y: number;
    if (py != null) y = py + 12;
    else if (A && B) {
      // 卡片放在两端的下方（放不下就放上方），不挡住要连的两个节点
      const lo = Math.max(A.y, B.y) * v.k + v.y;
      const hi = Math.min(A.y, B.y) * v.k + v.y;
      y = lo + 28 + CARD_H < H - 60 ? lo + 28 : hi - 28 - CARD_H;
    } else y = H / 2;
    x = clamp(x - 150, 12, Math.max(12, W - 320));
    y = clamp(y, 52, Math.max(52, H - CARD_H - 60));
    setFocusId(null);
    setEdgeSel(null);
    setLinkSearch(null);
    setLinkCard({ from, to, x, y });
  };
  const cancelLink = () => {
    linkDragRef.current = null;
    linkRef.current = null;
    simRef.current.reheat(0.05);
    kick();
  };
  /** 拖线中：吸附半径＝节点半径 + 12 px（屏幕） */
  const snapTarget = (wx: number, wy: number, from: string): string | null => {
    const v = viewRef.current;
    let best: string | null = null;
    let bd = Infinity;
    for (const n of simRef.current.nodes) {
      if (n.id === from || !isLinkable(nodeById(n.id))) continue;
      const r = n.r + 12 / v.k;
      const d2 = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (d2 <= r * r && d2 < bd) {
        bd = d2;
        best = n.id;
      }
    }
    return best;
  };
  const startLink = (from: string, x: number, y: number) => {
    // 拖线期间冻结力模拟：目标节点不漂移
    const sim = simRef.current;
    sim.alpha = 0;
    sim.alphaTarget = 0;
    linkDragRef.current = { from, sx: x, sy: y, target: null };
    const sn = sim.get(from);
    if (sn) linkRef.current = { x1: sn.x, y1: sn.y, x2: sn.x, y2: sn.y, snapped: false };
    handleOnRef.current = false;
    setLinkCard(null);
    setLinkSearch(null);
    kick();
  };
  const onPointerDown = (e: React.PointerEvent) => {
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* 合成事件无指针可捕获 */
    }
    const [x, y] = local(e);
    const editable = playT == null;
    if (hoverEdge) setHoverEdge(null);
    // v49.148 / D317：从连线把手拖（左键）或 Alt + 拖节点＝拉线
    if (editable && e.button === 0 && handleOnRef.current && handleRef.current) {
      startLink(handleRef.current.id, x, y);
      return;
    }
    const hit = hitTest(x, y);
    if (editable && e.button === 0 && e.altKey && hit && isLinkable(nodeById(hit))) {
      startLink(hit, x, y);
      return;
    }
    dragRef.current = { id: hit, sx: x, sy: y, vx: goalRef.current.x, vy: goalRef.current.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const [x, y] = local(e);
    const ld = linkDragRef.current;
    if (ld) {
      const v = viewRef.current;
      // 指针靠近画布边缘 40 px 内：画布自动平移
      const wrap = wrapRef.current;
      const W = wrap?.clientWidth || 800;
      const H = wrap?.clientHeight || 600;
      const px = x < 40 ? 40 - x : x > W - 40 ? W - 40 - x : 0;
      const py = y < 40 ? 40 - y : y > H - 40 ? H - 40 - y : 0;
      if (px || py) {
        goalRef.current.x += px * 0.25;
        goalRef.current.y += py * 0.25;
        viewRef.current = { ...goalRef.current, k: v.k };
      }
      const vv = viewRef.current;
      const wx = (x - vv.x) / vv.k;
      const wy = (y - vv.y) / vv.k;
      const target = snapTarget(wx, wy, ld.from);
      ld.target = target;
      const a = simRef.current.get(ld.from);
      const t = target ? simRef.current.get(target) : null;
      if (a) linkRef.current = { x1: a.x, y1: a.y, x2: t ? t.x : wx, y2: t ? t.y : wy, snapped: !!t };
      if (target !== hoverId) setHoverId(target);
      kick();
      return;
    }
    const dr = dragRef.current;
    if (dr) {
      if (!dr.moved && Math.hypot(x - dr.sx, y - dr.sy) > 3) dr.moved = true;
      if (!dr.moved) return;
      if (!dr.id) {
        goalRef.current.x = viewRef.current.x = dr.vx + x - dr.sx;
        goalRef.current.y = viewRef.current.y = dr.vy + y - dr.sy;
        kick();
        return;
      }
      const v = viewRef.current;
      const sn = simRef.current.get(dr.id);
      if (sn) {
        sn.fx = (x - v.x) / v.k;
        sn.fy = (y - v.y) / v.k;
      }
      const sim = simRef.current;
      sim.alphaTarget = 0.25;
      sim.reheat(0.25);
      if (hoverId !== dr.id) setHoverId(dr.id);
      kick();
      return;
    }
    // 悬停：指针在连线把手上时保持悬停那个节点（把手在圆外）
    const hd = handleRef.current;
    if (hd && playT == null) {
      const v = viewRef.current;
      const on = Math.hypot((x - v.x) / v.k - hd.x, (y - v.y) / v.k - hd.y) <= 6 / v.k;
      if (on !== handleOnRef.current) {
        handleOnRef.current = on;
        kick();
      }
      if (on) {
        if (hoverEdge) setHoverEdge(null);
        return;
      }
    } else handleOnRef.current = false;
    const id = hitTest(x, y);
    if (id !== hoverId) setHoverId(id);
    const he = !id && playT == null ? hitEdge(x, y) : null;
    const heId = he ? he.id : null;
    if (heId !== hoverEdge) setHoverEdge(heId);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const ld = linkDragRef.current;
    if (ld) {
      const [x, y] = local(e);
      const target = ld.target;
      linkDragRef.current = null;
      linkRef.current = null;
      simRef.current.reheat(0.05);
      kick();
      if (target) {
        const k = [ld.from, target].sort().join("|");
        const existing = snap?.edges.some((ed) => [ed.from, ed.to].sort().join("|") === k);
        if (existing) openEdge(ld.from, target);
        else openLinkCard(ld.from, target);
      } else if (Math.hypot(x - ld.sx, y - ld.sy) > 12) {
        const wrap = wrapRef.current;
        setLinkSearch({ from: ld.from, x: clamp(x, 12, Math.max(12, (wrap?.clientWidth || 800) - 260)), y: clamp(y, 52, Math.max(52, (wrap?.clientHeight || 600) - 260)) });
      }
      return;
    }
    const dr = dragRef.current;
    dragRef.current = null;
    if (!dr) return;
    const sim = simRef.current;
    if (dr.id) {
      const sn = sim.get(dr.id);
      if (sn) {
        sn.fx = null;
        sn.fy = null;
      }
      sim.alphaTarget = 0;
      if (!dr.moved) setFocusId((f) => (f === dr.id ? null : dr.id));
      else if (!motion) sim.settle(300);
    } else if (!dr.moved) {
      // v49.148 / D317：点到连线＝打开关系面板
      const he = playT == null ? hitEdge(dr.sx, dr.sy) : null;
      if (he) openEdge(he.from, he.to);
      else {
        setFocusId(null);
        setEdgeSel(null);
      }
      setMenuOpen(false);
      setLegendOpen(false);
    }
    const [x, y] = local(e);
    setHoverId(hitTest(x, y));
    kick();
  };
  const onWheel = (e: React.WheelEvent) => {
    const [mx, my] = local(e);
    const g = goalRef.current;
    const k2 = clamp(g.k * Math.exp(-e.deltaY * 0.0018), 0.12, 6);
    g.x = mx - ((mx - g.x) * k2) / g.k;
    g.y = my - ((my - g.y) * k2) / g.k;
    g.k = k2;
    if (!motion) viewRef.current = { ...g };
    kick();
  };
  const centerOn = (id: string) => {
    const sn = simRef.current.get(id);
    const wrap = wrapRef.current;
    if (!sn || !wrap) {
      setFocusId(id);
      return;
    }
    const k = Math.max(goalRef.current.k, 1.4);
    goalRef.current = { k, x: wrap.clientWidth / 2 - 150 - sn.x * k, y: wrap.clientHeight / 2 - sn.y * k };
    if (!motion) viewRef.current = { ...goalRef.current };
    setFocusId(id);
    kick();
  };

  // ---------------- 回放（节拍，§4） ----------------
  const prevBeat = useRef<number | null>(null);
  useEffect(() => {
    const p = prevBeat.current;
    prevBeat.current = beat;
    if (beat == null) return;
    const b = beats[beat];
    if (!b) return;
    const t0 = performance.now();
    for (const ev of b.events) if (ev.kind !== "lit") for (const id of eventNodeIds(ev)) animRef.current.pulse.set(id, t0);
    if (playRef.current && p != null) {
      const days = skippedDays(beats[p], b);
      if (days >= 2) {
        setSkipNote(T("跳过 {n} 天", { n: days }));
        const h = window.setTimeout(() => setSkipNote(null), 700 / speed);
        return () => window.clearTimeout(h);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat]);

  const startPlay = (from: number, note?: string) => {
    if (!bundle || !beats.length) return;
    if (!motion) {
      // 动效关闭：静态前后对比 + 一行摘要（§9.4）
      const a = foldAt(bundle, beats[from].start - 1).summary;
      const b = bundle.snapshot.summary;
      setReplayNote(T("从 {a} 到现在：点亮 {l1} → {l2}，褪色 {f1} → {f2}", { a: new Date(beats[from].start).toLocaleDateString(), l1: a.lit, l2: b.lit, f1: a.fading, f2: b.fading }));
      return;
    }
    setFocusId(null);
    setHoverId(null);
    setMenuOpen(false);
    animRef.current.last.clear();
    simRef.current.setGraph([], []);
    playRef.current = { clock: sched.holdStart[from] ?? 0 };
    setReplayNote(note ?? null);
    setBeat(from);
    setPlaying(true);
    fit(false, [...animRef.current.home.keys()]);
    kick();
  };
  const stopPlay = () => {
    playRef.current = null;
    setPlaying(false);
  };
  const playAll = () => startPlay(beat == null || beat >= beats.length - 1 ? 0 : beat);
  const playToday = () => {
    if (!bundle) return;
    const i = beats.findIndex((b) => b.end >= bundle.today.from);
    const td = bundle.today;
    startPlay(i < 0 ? Math.max(0, beats.length - 1) : i, T("今天：新点亮 {lit}，回亮 {re}，侧面 {fa}，新连接 {ed}", { lit: td.lit, re: td.refreshed, fa: td.facets, ed: td.edges }));
  };
  const scrubTo = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const f = clamp((clientX - r.left) / r.width, 0, 1);
    const b = beatAtFrac(sched, beats, f);
    stopPlay();
    setBeat(b);
  };
  // 非播放时圆点停在当前拍（播放中由帧循环逐帧驱动）
  useEffect(() => {
    if (playing) return;
    paintDot(beat == null ? 1 : posOf(sched, beats[beat]?.start ?? sched.t1));
    const onResize = () => paintDot(beat == null ? 1 : posOf(sched, beats[beat]?.start ?? sched.t1));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [beat, playing, sched, beats, paintDot, bundle]);

  // 复习会话收尾「播放今日生长」进入：布局就绪后自动播放一次（§9.3）
  const autoPlayed = useRef(false);
  useEffect(() => {
    if (!autoReplayToday || autoPlayed.current || !bundle || !placedRef.current) return;
    autoPlayed.current = true;
    playToday();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReplayToday, bundle, visible]);

  // 本周变化（首要数字可以下降）
  const weekDelta = useMemo(() => {
    if (!bundle || !bundle.history) return null;
    return bundle.snapshot.summary.lit - foldAt(bundle, now - 7 * DAY).summary.lit;
  }, [bundle, now]);

  const focusNode = useMemo(() => (focusId && snap ? snap.nodes.find((n) => n.id === focusId) ?? null : null), [focusId, snap]);

  /** 聚焦一个全谱节点：用户已有对应知识点就聚焦它；否则以虚影出现在视野中央 */
  const focusAtlas = (q: string) => {
    const mine = baseVisible.find((n) => n.atlasId === q);
    if (mine) {
      centerOn(mine.id);
      return;
    }
    const sn = simRef.current.get("atlas:" + q);
    if (sn) {
      centerOn("atlas:" + q);
      return;
    }
    const wrap = wrapRef.current;
    const v = viewRef.current;
    if (wrap) animRef.current.last.set("atlas:" + q, [(wrap.clientWidth / 2 - 150 - v.x) / v.k, (wrap.clientHeight / 2 - v.y) / v.k]);
    setFocusId("atlas:" + q);
  };
  const [findHits, setFindHits] = useState<{ mine: GraphNode[]; atlas: AtlasNode[] }>({ mine: [], atlas: [] });
  const [findAtlasDone, setFindAtlasDone] = useState(false);
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!searchOpen || !q || !bundle) {
      setFindHits({ mine: [], atlas: [] });
      return;
    }
    const ns = bundle.snapshot.nodes;
    const lab = (n: GraphNode) => n.label.toLowerCase();
    const mine = [...ns.filter((n) => lab(n) === q), ...ns.filter((n) => lab(n) !== q && lab(n).startsWith(q)), ...ns.filter((n) => !lab(n).startsWith(q) && lab(n).includes(q))].slice(0, 5);
    setFindHits({ mine, atlas: [] });
    setFindAtlasDone(false);
    if (!atlasOn) return;
    let alive = true;
    const h = window.setTimeout(() => {
      void atlasApi()?.atlasSearch(query.trim(), { limit: 8 }).then((r) => {
        if (!alive) return;
        const mineAtlas = new Set(mine.map((n) => n.atlasId).filter(Boolean));
        setFindHits({ mine, atlas: (r || []).filter((x) => !mineAtlas.has(x.id)).slice(0, 6) });
        setFindAtlasDone(true);
      }).catch(() => undefined);
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [query, searchOpen, bundle, atlasOn]);
  const pickMine = (id: string) => {
    if (beat != null) {
      stopPlay();
      setBeat(null);
    }
    if (filter !== "all" && !visById.has(id)) setFilter("all");
    setFindHits({ mine: [], atlas: [] });
    setSearchOpen(false);
    window.setTimeout(() => centerOn(id), 0);
  };
  const pickAtlas = (q: string) => {
    if (beat != null) {
      stopPlay();
      setBeat(null);
    }
    setFindHits({ mine: [], atlas: [] });
    setSearchOpen(false);
    window.setTimeout(() => focusAtlas(q), 0);
  };
  const [mapOpen, setMapOpen] = useState(false);
  const [unmapped, setUnmapped] = useState(0);
  useEffect(() => {
    if (!atlasOn) return;
    void atlasApi()?.unmappedKps().then((x) => setUnmapped(x.length)).catch(() => undefined);
  }, [atlasOn, bundle]);

  const doSearch = () => {
    const q = query.trim().toLowerCase();
    if (!q || !bundle) return;
    const ns = bundle.snapshot.nodes;
    const lab = (n: GraphNode) => n.label.toLowerCase();
    // 完全相同 > 前缀 > 包含（「强化」不该先跳到「负强化」）；自己的图谱里没有就去全谱
    const hit = ns.find((n) => lab(n) === q) ?? ns.find((n) => lab(n).startsWith(q)) ?? ns.find((n) => lab(n).includes(q));
    if (hit) pickMine(hit.id);
    else if (findHits.atlas[0]) pickAtlas(findHits.atlas[0].id);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const typing = !!tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === "Escape" && linkDragRef.current) {
        cancelLink();
      } else if (e.key === "Escape" && !typing) {
        setFocusId(null);
        setEdgeSel(null);
        setMenuOpen(false);
        setLegendOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <div className="kg-page kg-empty">{error}</div>;
  if (!bundle || !snap) return <div className="kg-page kg-empty">{T("正在生成知识图谱…")}</div>;

  const s = bundle.snapshot.summary;
  const shown = playT == null ? s : snap.summary;
  const empty = bundle.snapshot.nodes.length === 0;
  const showVecHint = vecHint && !vecHintDismissed;
  const barOpen = playing || barHov || barFoc;
  const tickMax = beats.reduce((m, b) => Math.max(m, b.events.length), 1);

  return (
    <div className="kg-page" data-testid="kg-page">
      {attachOpen && (
        <AttachExistingCards
          onClose={() => {
            setAttachOpen(false);
            refreshUnattached();
            void load();
          }}
          onChanged={() => {
            refreshUnattached();
            void load();
          }}
        />
      )}
      <div className="kg-body" hidden={attachOpen}>
        <div className="kg-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={`kg-canvas${hoverId || hoverEdge ? " is-point" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => {
              if (!dragRef.current && !linkDragRef.current) {
                setHoverId(null);
                setHoverEdge(null);
              }
            }}
            onWheel={onWheel}
            aria-label={T("知识图谱")}
            role="img"
          />
          {empty && (
            <div className="kg-hint">
              {T("这里会长出你真正掌握的知识。复习一张归属于某个知识点的卡，隔天再答对，它就会点亮。")}
              {unattached ? (
                <>
                  <br />
                  {T("你已有的卡还没挂到知识点上——在右上角「⋯」里选「整理已有卡片」。")}
                </>
              ) : null}
            </div>
          )}

          <div className="kg-top">
            <div className="kg-stats" data-testid="kg-lit">
              <b>{shown.lit}</b>
              {T("个知识点点亮")}
              {weekDelta != null && playT == null && (
                <>
                  <span className="kg-sep">·</span>
                  {T("本周 {d}", { d: weekDelta >= 0 ? `+${weekDelta}` : String(weekDelta) })}
                </>
              )}
              <span className="kg-sep">·</span>
              {T("褪色 {n}", { n: snap.summary.fading })}
            </div>
            <div className="kg-tools">
              <input
                ref={searchRef}
                className={`kg-find${searchOpen ? " is-open" : ""}`}
                value={query}
                placeholder={T("查找知识点")}
                aria-label={T("查找知识点")}
                tabIndex={searchOpen ? 0 : -1}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isImeComposing(e)) doSearch();
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              {searchOpen && (findHits.mine.length > 0 || findHits.atlas.length > 0 || (findAtlasDone && !!query.trim())) && (
                <div className="kg-pop kg-findlist is-open" role="listbox" aria-label={T("查找知识点")}>
                  {findHits.mine.map((n) => (
                    <button key={n.id} className="kg-item" role="option" onMouseDown={(e) => e.preventDefault()} onClick={() => pickMine(n.id)}>
                      {n.label}
                      <small>{T(STATE_LABEL[n.state])}</small>
                    </button>
                  ))}
                  {findHits.atlas.length > 0 && <div className="kg-cap">{T("全谱")}</div>}
                  {findHits.atlas.map((n) => (
                    <button key={n.id} className="kg-item" role="option" data-testid="kg-find-atlas" onMouseDown={(e) => e.preventDefault()} onClick={() => pickAtlas(n.id)}>
                      {atlasLabel(n)}
                      <small>{atlasGloss(n) || T(n.kindLabel)}</small>
                    </button>
                  ))}
                  <AtlasMissHint show={findAtlasDone && findHits.atlas.length === 0} className="kg-cap" />
                </div>
              )}
              <button
                className={`kg-icon${searchOpen ? " is-on" : ""}`}
                title={T("查找（Ctrl+F）")}
                aria-label={T("查找知识点")}
                onClick={() => {
                  setSearchOpen((o) => !o);
                  window.setTimeout(() => searchRef.current?.focus(), 0);
                }}
              >
                <IconKgSearch />
              </button>
              <button className={`kg-icon${menuOpen ? " is-on" : ""}`} title={T("更多")} aria-label={T("更多")} data-testid="kg-menu-btn" onClick={() => { setMenuOpen((o) => !o); setLegendOpen(false); }}>
                <IconKgDots className="kg-dots" />
              </button>
            </div>
          </div>

          <div className={`kg-pop kg-menu${menuOpen ? " is-open" : ""}`} data-testid="kg-menu" aria-hidden={!menuOpen}>
            <div className="kg-cap">{T("筛选")}</div>
            <div className="kg-seg" role="group" aria-label={T("筛选")}>
              {(["all", "islands", "due", "fading"] as Filter[]).map((f) => (
                <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
                  {T({ all: "全部", islands: "待挂靠", due: "到期", fading: "褪色" }[f])}
                </button>
              ))}
            </div>
            <button className="kg-item" onClick={() => setShowGhosts((v) => !v)} role="switch" aria-checked={showGhosts}>
              {T("显示虚影")} <span className={`kg-switch${showGhosts ? " is-on" : ""}`} />
            </button>
            <div className="kg-cap">{T("回放速度")}</div>
            <div className="kg-seg" role="group" aria-label={T("回放速度")}>
              {[1, 2, 4].map((x) => (
                <button key={x} className={speed === x ? "active" : ""} onClick={() => setSpeed(x)}>{x}×</button>
              ))}
            </div>
            <button className="kg-item" disabled={empty} onClick={playToday}>{T("今日回放")}</button>
            <hr />
            <button className="kg-item" onClick={() => { setAddingKnown(true); setMenuOpen(false); }} title={T("用软件之前就会的知识：写下名称和一句定义，生成一张定义卡，复习后点亮")}>
              {T("＋ 已有知识")}
            </button>
            <button className="kg-item" data-testid="kg-unattached" onClick={() => { setAttachOpen(true); setMenuOpen(false); }}>
              {T("整理已有卡片")}
              {unattached ? <small>{T("{n} 张未挂靠", { n: unattached })}</small> : null}
            </button>
            {atlasOn && (
              <button className="kg-item" data-testid="kg-map-atlas" onClick={() => { setMapOpen(true); setMenuOpen(false); }}>
                {T("整理知识点到全谱")}
                {unmapped ? <small>{T("{n} 个未挂靠", { n: unmapped })}</small> : null}
              </button>
            )}
            <hr />
            <div className="kg-note" title={T("维持当前图谱，每天大约需要的复习次数")}>{T("每日维护约 {n} 次", { n: s.dailyCost.toFixed(1) })}</div>
          </div>

          {addingKnown && (
            <div className="kg-pop kg-addpop is-open">
              <AddKnown onClose={() => setAddingKnown(false)} onDone={() => { setAddingKnown(false); void load(); }} />
            </div>
          )}

          {focusNode && (
            <NodeDetail
              key={focusNode.id}
              node={focusNode}
              snap={snap}
              readOnly={playT != null}
              onClose={() => setFocusId(null)}
              onJump={centerOn}
              onReview={(ids) => onReview(ids, focusNode.label)}
              onChanged={() => void load()}
              onJumpToDoc={onJumpToDoc}
              onOpenMap={onOpenMap}
              atlas={atlasOn ? { ctx: ctx && ctx.atlasId === focusNode.atlasId ? ctx : null, relationsIncomplete: atlasRelationsIncomplete, route, setRoute, onPick: focusAtlas } : null}
              maybe={bundle.maybe?.[focusNode.id] ?? []}
              onOpenEdge={(other) => openEdge(focusNode.id, other)}
              onLinkTo={(other) => openLinkCard(focusNode.id, other)}
            />
          )}
          {!focusNode && edgeSel && (
            <EdgePanel
              key={[edgeSel.a, edgeSel.b].sort().join("|")}
              a={edgeSel.a}
              b={edgeSel.b}
              nodes={snap.nodes}
              onClose={() => setEdgeSel(null)}
              onJump={(id) => {
                setEdgeSel(null);
                centerOn(id);
              }}
              onChanged={() => void load()}
              onToast={setToast}
              onJumpToDoc={onJumpToDoc}
              onOpenMap={onOpenMap}
            />
          )}
          {linkCard && (
            <LinkCard
              key={linkCard.from + ">" + linkCard.to}
              from={linkCard.from}
              to={linkCard.to}
              x={linkCard.x}
              y={linkCard.y}
              nodes={snap.nodes}
              onCancel={() => setLinkCard(null)}
              onDone={(r, text) => {
                setLinkCard(null);
                setToast({ text: text ? T("已连线") : T("已连线（还没写说明，复习时会问你）"), undo: r.created || r.eventId ? () => kgApi()!.undoConnect(r.undo).then(() => load()) : undefined });
                void load();
              }}
            />
          )}
          {linkSearch && (
            <LinkSearch
              from={linkSearch.from}
              x={linkSearch.x}
              y={linkSearch.y}
              nodes={snap.nodes}
              onCancel={() => setLinkSearch(null)}
              onPick={(id) => {
                const ls = linkSearch;
                setLinkSearch(null);
                openLinkCard(ls.from, id, ls.x, ls.y);
              }}
            />
          )}
          {toast && (
            <div className="kg-toast kg-edge-toast is-on" data-testid="kg-edge-toast">
              <span>{toast.text}</span>
              {toast.undo && (
                <button
                  className="kg-textbtn"
                  onClick={() => {
                    const u = toast.undo!;
                    setToast(null);
                    void u().then(() => load());
                  }}
                >
                  {T("撤销")}
                </button>
              )}
              {toast.reportAtlasId && <AtlasReport atlasId={toast.reportAtlasId} />}
              <button className="kg-textbtn" aria-label={T("关闭")} onClick={() => setToast(null)}>✕</button>
            </div>
          )}
          {!focusNode && atlasFocus && ctx && ctx.atlasId === atlasFocus && ctx.node && (
            <AtlasCard key={atlasFocus} ctx={ctx} route={route} setRoute={setRoute} onPick={focusAtlas} onClose={() => setFocusId(null)} onOpenKp={(id) => centerOn(id)} onOpenMap={onOpenMap} />
          )}
          {mapOpen && (
            <AtlasMapPanel
              onClose={() => setMapOpen(false)}
              onChanged={() => {
                void load();
                void atlasApi()?.unmappedKps().then((x) => setUnmapped(x.length)).catch(() => undefined);
              }}
            />
          )}

          {showVecHint && (
            <div className="kg-toast is-on" data-testid="kg-vhint">
              <span>{T("合并过重复的知识点？可以在 设置 → 语义匹配 里开启，让软件更早发现换了说法的重复。")}</span>
              <button className="kg-textbtn" onClick={() => { localStorage.setItem("kg.vectorHintDismissed", "1"); setVecHintDismissed(true); }}>{T("知道了")}</button>
            </div>
          )}
          {replayNote && !showVecHint && !toast && <div className="kg-toast is-on">{replayNote}</div>}

          <div className="kg-bottom">
            <button
              className="kg-play"
              onClick={playing ? stopPlay : playAll}
              onPointerEnter={hovOn}
              onPointerLeave={hovOff}
              onFocus={(e) => setBarFoc(e.currentTarget.matches(":focus-visible"))}
              onBlur={() => setBarFoc(false)}
              disabled={empty}
              data-testid="kg-play"
              title={playing ? T("暂停") : T("生长回放")} aria-label={playing ? T("暂停") : T("生长回放")}>
              {playing ? (
                <IconKgPause />
              ) : (
                <IconKgPlay />
              )}
            </button>
            <div
              className={`kg-replaybar${barOpen ? " is-open" : ""}`}
              data-testid="kg-replaybar"
              onPointerEnter={hovOn}
              onPointerLeave={hovOff}
              onFocus={(e) => setBarFoc(e.target.matches(":focus-visible"))}
              onBlur={() => setBarFoc(false)}
            >
            <div
              className="kg-tl"
              ref={tlRef}
              role="slider"
              aria-label={T("时间轴")}
              aria-valuemin={0}
              aria-valuemax={beats.length}
              aria-valuenow={beat ?? beats.length}
              tabIndex={barOpen ? 0 : -1}
              onPointerDown={(e) => {
                try {
                  (e.currentTarget as Element).setPointerCapture(e.pointerId);
                } catch {
                  /* 合成事件 */
                }
                scrubTo(e.clientX, e.currentTarget);
              }}
              onPointerMove={(e) => {
                if (e.buttons & 1) scrubTo(e.clientX, e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setBeat((b) => Math.max(0, (b ?? beats.length) - 1));
                if (e.key === "ArrowRight") setBeat((b) => (b == null || b + 1 >= beats.length ? null : b + 1));
              }}
            >
              <PlotSvg className="kg-ticks" viewBox="0 0 1000 12" preserveAspectRatio="none">
                {beats.map((b, i) => (
                  <line key={i} x1={posOf(sched, b.start) * 1000} x2={posOf(sched, b.start) * 1000} y1={12} y2={12 - clamp(3 + (b.events.length / tickMax) * 9, 3, 12)} className={beat != null && i <= beat ? "is-past" : ""} />
                ))}
              </PlotSvg>
              <div className="kg-rail" />
              <div className="kg-fill" ref={fillRef} />
              <div className="kg-knob" ref={knobRef} data-testid="kg-knob" />
            </div>
            <div className="kg-when">
              <span className={`kg-skip${skipNote ? " is-on" : ""}`}>{skipNote}</span>
              {playT == null ? T("现在") : new Date(beats[beat!].start).toLocaleDateString()}
            </div>
            </div>
            <button className={`kg-icon${legendOpen ? " is-on" : ""}`} title={T("图例")} aria-label={T("图例")} onClick={() => { setLegendOpen((o) => !o); setMenuOpen(false); }}>
              <IconKgHelp />
            </button>
          </div>
          <Legend open={legendOpen} />
        </div>
      </div>
    </div>
  );
}

function Legend({ open }: { open: boolean }) {
  const T = useT();
  const rows: [ReactElement, string, string][] = [
    [<><circle cx="-6" r="3" className="lg-fill lg-half" /><circle cx="5" r="3" className="lg-fill" /></>, "墨色深浅", "保持度"],
    [<circle r="3.2" className="lg-ink" fill="none" />, "空心", "尚未点亮"],
    [<circle r="3.4" className="lg-fade" />, "浅灰", "褪色"],
    [<circle r="3" className="lg-fade-line lg-dash" fill="none" />, "虚线圈", "归档"],
    [<circle r="3.2" className="lg-due-fill" />, "强调色", "今天到期"],
    [<path d="M-10 0H10" className="lg-edge" />, "实线", "你确认的关系"],
    [<path d="M-10 0H10" className="lg-edge lg-faint" />, "淡色细线", "推断的关系（点开看证据）"],
    [<><circle cx="-6" r="2" className="lg-fill" /><circle cx="5" r="4" className="lg-fill" /></>, "大小", "卡片数与稳定性"]
  ];
  return (
    <div className={`kg-pop kg-legend${open ? " is-open" : ""}`} aria-hidden={!open}>
      {rows.map(([g, a, b]) => (
        <div className="kg-lrow" key={a}>
          <PlotSvg viewBox="-11 -8 22 16">{g}</PlotSvg>
          <b>{T(a)}</b>
          {T(b)}
        </div>
      ))}
    </div>
  );
}

function NodeDetail({
  node,
  snap,
  readOnly,
  onClose,
  onJump,
  onReview,
  onChanged,
  onJumpToDoc,
  onOpenMap,
  atlas,
  maybe,
  onOpenEdge,
  onLinkTo
}: {
  node: GraphNode;
  snap: GraphSnapshot;
  readOnly: boolean;
  onClose: () => void;
  onJump: (id: string) => void;
  onReview: (ids: string[]) => void;
  onChanged: () => void;
  onJumpToDoc?: JumpToDoc;
  onOpenMap?: OpenMap;
  atlas?: AtlasProps | null;
  maybe?: string[];
  onOpenEdge?: (otherId: string) => void;
  onLinkTo?: (otherId: string) => void;
}) {
  const T = useT();
  const [appear, setAppear] = useState<KpAppearances | null>(null);
  const [versions, setVersions] = useState<{ seq: number; body: string; reason: string; author: string; createdAt: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const api = kgApi();
  const loadAppear = useCallback(() => {
    return api?.appearances(node.id).then((a) => setAppear(a)).catch(() => setAppear(null));
  }, [api, node.id]);
  useEffect(() => {
    let alive = true;
    void api?.appearances(node.id).then((a) => { if (alive) setAppear(a); }).catch(() => { if (alive) setAppear(null); });
    return () => { alive = false; };
  }, [api, node.id, node.cardCount]);
  const removeAi = async (atlasIds: string[], mapId: string, nodeId: string) => {
    for (const a of atlasIds) await api?.mapLinkSetUserRef(mapId, nodeId, a, false);
    await loadAppear();
  };
  useEffect(() => {
    void api?.defVersions(node.id).then((v) => setVersions(v || [])).catch(() => setVersions([]));
  }, [api, node.id, node.defVersion]);
  const neighbors = snap.edges
    .filter((e) => e.from === node.id || e.to === node.id)
    .map((e) => ({ e, other: snap.nodes.find((n) => n.id === (e.from === node.id ? e.to : e.from)) }))
    .filter((x) => x.other);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const REASON: Record<string, string> = { ai_draft: "AI 草稿", manual_edit: "手动修改", review_edit: "复习时修改", restate: "重述采纳", merge: "合并", revert: "回退", legacy: "原有定义" };
  const editMd = (p: { value: string; onDone: (next: string | null) => void }) => (
    <MarkdownEditor value={p.value} variant="compact" toolbar commitOnUnmount onCommit={p.onDone} />
  );
  return (
    <aside className="kg-detail" data-testid="kg-detail">
      <div className="kg-detail-head">
        <h3>{node.label}</h3>
        <button className="icon-btn" onClick={onClose} aria-label={T("关闭")}>✕</button>
      </div>
      <div className="kg-detail-meta">
        <span>{T(STATE_LABEL[node.state])}</span>
        <span>{T("保持度 {n}%", { n: Math.round(node.retention * 100) })}</span>
        <span>{T("深度 {n}/5", { n: node.depth })}</span>
        <span>{T("{n} 张卡", { n: node.cardCount })}</span>
        {node.litAt != null && <span>{T("点亮于 {d}", { d: new Date(node.litAt).toLocaleDateString() })}</span>}
      </div>
      <div className="kg-facets">
        {FACETS.map((f) => (
          <span key={f} className={`kg-facet is-${node.facets[f]}`}>{T(FACET_LABEL[f])}</span>
        ))}
      </div>
      <section className="kg-def">
        <div className="kg-sec-title">{T("定义")}{node.defVersion > 0 && <span className="kg-ver"> v{node.defVersion}</span>}</div>
        {readOnly ? (
          <div className="kg-def-text">{node.definition || T("（还没有定义）")}</div>
        ) : (
          <EditableField
            value={node.definition}
            onCommit={(t) => void act(() => api!.reviseDefinition(node.id, { body: t, reason: "manual_edit" }))}
            renderEditor={editMd}
          />
        )}
      </section>
      {versions.length > 1 && (
        <section>
          <div className="kg-sec-title">{T("定义演变")}</div>
          <ol className="kg-versions">
            {[...versions].reverse().map((v) => (
              <li key={v.seq}>
                <span className="kg-ver">v{v.seq}</span> <span className="kg-ver-why">{T(REASON[v.reason] || v.reason)} · {new Date(v.createdAt).toLocaleDateString()}</span>
                <div className="kg-ver-body">{v.body}</div>
                {!readOnly && v.seq !== versions[versions.length - 1].seq && (
                  <button className="bar-btn ghost btn-sm" disabled={busy} onClick={() => void act(() => api!.revertDefinition(node.id, v.seq))}>
                    {T("回退到此版")}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {appear && (
        <section data-testid="kg-appear-section">
          <div className="kg-sec-title">{T("出现在")}</div>
          {appear.materials.length === 0 ? (
            <div className="kp-muted">{T("还没有来自材料的卡片")}</div>
          ) : (
            <ul className="kg-neigh">
              {appear.materials.map((m) => (
                <li key={m.documentId ?? "t:" + m.title}>
                  {m.documentId && m.anchor && onJumpToDoc ? (
                    <button className="kg-link" title={T("跳转原文")} onClick={() => onJumpToDoc(m.documentId!, m.anchor!, node.id)}>{m.title}</button>
                  ) : (
                    <span>{m.title}</span>
                  )}
                  <span className="kg-edge-type">{T("{n} 张卡片", { n: m.cardCount })}</span>
                </li>
              ))}
            </ul>
          )}
          <MapAppearRows maps={appear.maps} onOpenMap={onOpenMap} onRemove={readOnly ? undefined : (ids, m, n) => void removeAi(ids, m, n)} />
        </section>
      )}
      {neighbors.length > 0 && (
        <section>
          <div className="kg-sec-title">{T("相邻知识点")}</div>
          <ul className="kg-neigh">
            {neighbors.map(({ e, other }) => (
              <li key={e.id}>
                <button className="kg-link" onClick={() => onJump(other!.id)}>{other!.label}</button>
                <span className="kg-edge-type">{T(e.status === "suggested" ? "推断" : e.unexplained ? "已确认 · 未说明" : "已确认")} · {T(relationLabel(e.type))}</span>
                {onOpenEdge && !readOnly && other!.kind !== "hub" && other!.state !== "ghost" && !other!.id.startsWith("atlas:") && (
                  <button className="kg-textbtn kg-edge-open" onClick={() => onOpenEdge(other!.id)}>{T("查看关系")}</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!readOnly && maybe && maybe.length > 0 && (
        <section data-testid="kg-maybe">
          <div className="kg-sec-title">{T("可能相关")}</div>
          <div className="kp-muted">{T("只在一份材料的导图里出现在一起，证据还不够画线")}</div>
          <ul className="kg-neigh kg-maybe">
            {maybe
              .map((id) => snap.nodes.find((n) => n.id === id))
              .filter((n): n is GraphNode => !!n)
              .slice(0, 12)
              .map((n) => (
                <li key={n.id}>
                  <button className="kg-link" onClick={() => onJump(n.id)}>{n.label}</button>
                  {onOpenEdge && <button className="kg-textbtn kg-edge-open" onClick={() => onOpenEdge(n.id)}>{T("查看关系")}</button>}
                </li>
              ))}
          </ul>
        </section>
      )}
      {atlas && !readOnly && (
        node.atlasId ? (
          <section data-testid="kg-atlas-section">
            <div className="kg-sec-head">
              <div className="kg-sec-title">{T("全谱")}</div>
              <button className="kg-textbtn kg-sec-act" onClick={() => void atlasApi()?.linkAtlas(node.id, null).then(onChanged)}>{T("解除对应")}</button>
            </div>
            {atlas.ctx?.node && (
              <div className="kg-atlas-id">
                <span>{atlasLabel(atlas.ctx.node)}</span>
                <small>{[atlasGloss(atlas.ctx.node), atlas.ctx.node.chain.map((c) => c.label).reverse().join(" › ")].filter(Boolean).join(" · ")}</small>
              </div>
            )}
            <RouteBlock target={node.atlasId} route={atlas.route} setRoute={atlas.setRoute} onPick={atlas.onPick} />
            {atlas.ctx && <AtlasRelations rows={atlas.ctx.rows} onPick={atlas.onPick} />}
            {atlas.relationsIncomplete && (
              <div className="kp-muted" data-testid="kg-atlas-incomplete">{T("部分关系需要联网获取；下载完整全谱可离线查看全部")}</div>
            )}
            <AtlasAlso kpId={node.id} label={node.label} also={node.atlasAlso || []} onChanged={onChanged} onPick={atlas.onPick} />
          </section>
        ) : (
          <AtlasPlace kpId={node.id} label={node.label} parent={node.atlasParent || null} also={node.atlasAlso || []} split={node.atlasSplit || []} onChanged={onChanged} onPick={atlas.onPick} />
        )
      )}
      {!readOnly && <NodeManage node={node} snap={snap} onChanged={onChanged} onJump={onJump} onLinkTo={onLinkTo} />}
      {!readOnly && (
        <div className="kg-actions">
          <button className="bar-btn primary" disabled={node.cardCount === 0 || node.state === "archived"} onClick={() => onReview([node.id])}>
            {T("复习这个知识点")}
          </button>
          {node.state === "archived" ? (
            <button className="bar-btn ghost" disabled={busy} onClick={() => void act(() => api!.restore(node.id))}>{T("恢复维护")}</button>
          ) : (
            <button className="bar-btn ghost" disabled={busy} title={T("停止复习它的卡，节点变为化石态；可随时恢复")} onClick={() => void act(() => api!.archive(node.id))}>
              {T("归档")}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

/** v49.141 / D308：已有知识（设计稿 §4.5）——名称 + 一句定义 → 新知识点 + 一张定义卡；不设快捷点亮 */
function AddKnown({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const T = useT();
  const [label, setLabel] = useState("");
  const [def, setDef] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => {
    setErr("");
    try {
      await (window as unknown as { kgAPI: { addKnown(p: { label: string; definition: string }): Promise<unknown> } }).kgAPI.addKnown({ label, definition: def });
      onDone();
    } catch (e) {
      setErr(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  return (
    <div className="kg-addknown" data-testid="kg-addknown">
      <input className="kg-search" value={label} placeholder={T("知识点名称")} aria-label={T("知识点名称")} onChange={(e) => setLabel(e.target.value)} />
      <div className="kg-addknown-def">
        <MarkdownEditor value={def} variant="compact" commitOnUnmount onCommit={(v) => setDef(v ?? def)} />
      </div>
      <button className="btn btn-primary btn-sm" disabled={!label.trim()} onClick={() => void submit()}>{T("生成定义卡")}</button>
      <button className="btn btn-outline btn-sm" onClick={onClose}>{T("取消")}</button>
      <span className="kp-muted">{T("写一句定义；复习这张卡、隔天答对后节点点亮。")}</span>
      {err && <span className="kgv-err">{err}</span>}
    </div>
  );
}

/** v49.141 / D308：节点管理（原卡片页「知识点」页签的改名 / 别名 / 合并 / 解除合并 / 关系，收进一个折叠区） */
function NodeManage({ node, snap, onChanged, onJump, onLinkTo }: { node: GraphNode; snap: GraphSnapshot; onChanged: () => void; onJump: (id: string) => void; onLinkTo?: (otherId: string) => void }) {
  const T = useT();
  const [kp, setKp] = useState<KnowledgePoint | null>(null);
  const [merged, setMerged] = useState<KnowledgePoint[]>([]);
  const [alias, setAlias] = useState("");
  const [pick, setPick] = useState<null | "merge" | "relation">(null);
  const [q, setQ] = useState("");
  const [relType, setRelType] = useState<KnowledgeRelationType>("related_to");
  const [err, setErr] = useState("");
  const [dissolve, setDissolve] = useState(false);
  const reload = useCallback(async () => {
    setKp(await knowledgeApi.getPoint(node.id));
    const m = await knowledgeApi.listPoints({ status: "merged", limit: 1000 });
    setMerged((m.points || []).filter((p) => p.mergedInto === node.id));
  }, [node.id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      await reload();
      onChanged();
    } catch (e) {
      setErr(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  const candidates = snap.nodes.filter((n) => n.id !== node.id && n.state !== "archived" && (!q.trim() || n.label.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 8);
  const relEdges = snap.edges.filter((e) => e.status === "confirmed" && (e.from === node.id || e.to === node.id));
  if (!kp) return null;
  return (
    <details className="kg-manage" data-testid="kg-manage">
      <summary>{T("管理")}</summary>
      <div className="kg-manage-row">
        <span className="kg-sec-title">{T("名称")}</span>
        <EditableField value={kp.canonicalLabel} required onCommit={(v) => void act(() => knowledgeApi.updatePoint(node.id, { canonicalLabel: v }))} renderEditor={(p) => (
          <input className="kg-search" defaultValue={p.value} autoFocus aria-label={T("知识点名称")} onBlur={(e) => p.onDone(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !isImeComposing(e)) p.onDone((e.target as HTMLInputElement).value); if (e.key === "Escape") p.onDone(null); }} />
        )} />
      </div>
      <div className="kg-manage-row">
        <span className="kg-sec-title">{T("别名")}</span>
        <div className="kg-facets">
          {(kp.aliases || []).map((a) => (
            <span key={a} className="kg-facet">
              {a} <button className="ai-kp-clear" aria-label={T("删除别名")} onClick={() => void act(() => knowledgeApi.updatePoint(node.id, { aliases: (kp.aliases || []).filter((x) => x !== a) }))}>✕</button>
            </span>
          ))}
          <input
            className="kg-search kg-alias-in"
            value={alias}
            placeholder={T("添加别名…")}
            aria-label={T("添加别名…")}
            onChange={(e) => setAlias(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e) && alias.trim()) {
                const next = [...new Set([...(kp.aliases || []), alias.trim()])];
                setAlias("");
                void act(() => knowledgeApi.updatePoint(node.id, { aliases: next }));
              }
            }}
          />
        </div>
      </div>
      {relEdges.length > 0 && (
        <div className="kg-manage-row">
          <span className="kg-sec-title">{T("关系")}</span>
          <ul className="kg-neigh">
            {relEdges.map((e) => {
              const other = snap.nodes.find((n) => n.id === (e.from === node.id ? e.to : e.from));
              return (
                <li key={e.id}>
                  <button className="kg-link" onClick={() => other && onJump(other.id)}>{other?.label}</button>
                  <span className="kg-edge-type">{T(relationLabel(e.type))}</span>
                  <button className="ai-kp-clear" aria-label={T("删除")} title={T("删除")} onClick={() => void act(() => knowledgeApi.deleteRelation(e.id))}>✕</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {merged.length > 0 && (
        <div className="kg-manage-row">
          <span className="kg-sec-title">{T("已并入的知识点")}</span>
          <ul className="kg-neigh">
            {merged.map((m) => (
              <li key={m.id}>
                {m.canonicalLabel} <button className="kg-link" onClick={() => void act(() => knowledgeApi.unmergePoint(m.id))}>{T("解除合并")}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="kg-actions">
        <button className="btn btn-outline btn-sm" onClick={() => { setPick(pick === "relation" ? null : "relation"); setQ(""); }}>{T("添加关系")}</button>
        <button className="btn btn-outline btn-sm" onClick={() => { setPick(pick === "merge" ? null : "merge"); setQ(""); }}>{T("合并到…")}</button>
        <button className="btn btn-outline btn-sm" data-testid="kg-manage-dissolve" onClick={() => setDissolve(true)}>{T("解散并重挂卡片…")}</button>
      </div>
      {dissolve && (
        <Suspense fallback={null}>
        <ReattachPreview
          kpIds={[node.id]}
          onCancel={() => setDissolve(false)}
          onDone={(r) => {
            setDissolve(false);
            setErr(r.moved > 0 ? T("已移动 {n} 张卡片", { n: r.moved }) : "");
            onChanged();
          }}
          renderSearch={(label, onPick) => <MapSearch label={label} modes={["same"]} onPick={(id, _m, n) => onPick(id, n)} />}
        />
        </Suspense>
      )}
      {pick && (
        <div className="kp-picker">
          {pick === "relation" && !onLinkTo && (
            <select className="kg-speed" value={relType} aria-label={T("关系类型")} onChange={(e) => setRelType(e.target.value as KnowledgeRelationType)}>
              {KP_RELATION_TYPES.filter((t) => t !== "analogous_to").map((t) => <option key={t} value={t}>{T(relationLabel(t))}</option>)}
            </select>
          )}
          <input value={q} autoFocus placeholder={T("搜索知识点")} aria-label={T("搜索知识点")} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {candidates.map((c) => (
              <li key={c.id}>
                <button
                  className="kg-link"
                  onClick={() => {
                    if (pick === "merge") {
                      if (!window.confirm(T("把「{a}」并入「{b}」？卡片与别名归到「{b}」，可随时解除合并。", { a: node.label, b: c.label }))) return;
                      void act(() => knowledgeApi.mergePoints(node.id, c.id)).then(() => onJump(c.id));
                    } else if (onLinkTo) {
                      // v49.148 / D317 §6.4：键盘入口——选好知识点后弹出同一张连线卡片（一句话说明 + 类型）
                      onLinkTo(c.id);
                    } else {
                      void act(() => knowledgeApi.createRelation({ fromKnowledgePointId: node.id, toKnowledgePointId: c.id, relationType: relType }));
                    }
                    setPick(null);
                  }}
                >
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {err && <p className="kgv-err">{err}</p>}
    </details>
  );
}

// ---------------- v49.143 / D311 全谱面板 ----------------

interface AtlasProps {
  ctx: { atlasId: string; rows: AtlasNeighbor[]; node: AtlasNodeDetail | null; complete: boolean; truncated: boolean } | null;
  /** v49.154 / D323 / A3：关系不完整（聚焦节点被截断 / 降级，或世界层不完整） */
  relationsIncomplete?: boolean;
  route: { target: string; data: Roadmap | null } | null;
  setRoute: (r: { target: string; data: Roadmap | null } | null) => void;
  onPick: (atlasId: string) => void;
}

/** 关系按名称分组（以本节点为视角），每组先列 6 个，其余可展开 */
function AtlasRelations({ rows, onPick }: { rows: AtlasNeighbor[]; onPick: (atlasId: string) => void }) {
  const T = useT();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = new Map<string, AtlasNeighbor[]>();
  for (const r of rankContext(rows)) {
    const k = relationText(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  if (!groups.size) return null;
  return (
    <div className="kg-rels" data-testid="kg-atlas-rels">
      {[...groups.entries()].map(([k, list]) => {
        const all = open.has(k);
        return (
          <div key={k} className="kg-rel-group">
            <span className="kg-rel-name">{T(k)}</span>
            <span className="kg-rel-list">
              {(all ? list : list.slice(0, 6)).map((r) => (
                <button key={r.node.id + k} className={`kg-link${r.kp ? " is-mine" : ""}`} title={atlasGloss(r.node)} onClick={() => onPick(r.node.id)}>
                  {atlasLabel(r.node)}
                </button>
              ))}
              {list.length > 6 && !all && (
                <button className="kg-textbtn" onClick={() => setOpen(new Set([...open, k]))}>{T("还有 {n} 个", { n: list.length - 6 })}</button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** 学习路线：设为目标 → 缺口（前置闭包 − 已掌握）沿前置边画到图上 */
function RouteBlock({ target, route, setRoute, onPick }: { target: string; route: AtlasProps["route"]; setRoute: AtlasProps["setRoute"]; onPick: (atlasId: string) => void }) {
  const T = useT();
  const active = route?.target === target;
  const gap = active && route?.data ? route.data.gap.filter((g) => !g.target) : [];
  const ready = gap.filter((g) => g.ready).slice(0, 5);
  return (
    <div className="kg-route" data-testid="kg-route">
      <button className="btn btn-outline btn-sm" onClick={() => setRoute(active ? null : { target, data: null })}>
        {active ? T("清除路线") : T("设为学习目标")}
      </button>
      {active && route?.data && (
        <span className="kg-route-sum">
          {gap.length === 0
            ? T("前置知识都已掌握")
            : T("还差 {n} 个知识点（已掌握 {m}）", { n: gap.length, m: route.data.mastered })}
        </span>
      )}
      {active && ready.length > 0 && (
        <span className="kg-route-ready">
          {T("可以先学：")}
          {ready.map((g) => (
            <button key={g.id} className="kg-link" onClick={() => onPick(g.id)}>{atlasLabel(g)}</button>
          ))}
        </span>
      )}
    </div>
  );
}

/** 全谱节点卡（用户还没有对应知识点的节点；自由探索） */
function AtlasCard({ ctx, route, setRoute, onPick, onClose, onOpenKp, onOpenMap }: { ctx: NonNullable<AtlasProps["ctx"]>; route: AtlasProps["route"]; setRoute: AtlasProps["setRoute"]; onPick: (atlasId: string) => void; onClose: () => void; onOpenKp: (kpId: string) => void; onOpenMap?: OpenMap }) {
  const T = useT();
  const n = ctx.node!;
  const [maps, setMaps] = useState<KpMapAppearance[]>([]);
  const loadMaps = useCallback(() => {
    return kgApi()?.atlasAppearances(n.id).then((r) => setMaps(r?.maps || [])).catch(() => setMaps([]));
  }, [n.id]);
  useEffect(() => { void loadMaps(); }, [loadMaps]);
  const removeAi = async (atlasIds: string[], mapId: string, nodeId: string) => {
    for (const a of atlasIds) await kgApi()?.mapLinkSetUserRef(mapId, nodeId, a, false);
    await loadMaps();
  };
  const years = n.years ? n.years.map((y) => (y == null ? "" : y < 0 ? T("前 {n}", { n: -y }) : String(y))).join("–") : "";
  return (
    <aside className="kg-detail" data-testid="kg-atlas-card">
      <div className="kg-detail-head">
        <h3>{atlasLabel(n)}</h3>
        <button className="icon-btn" onClick={onClose} aria-label={T("关闭")}>✕</button>
      </div>
      <div className="kg-detail-meta">
        <span>{T(n.kindLabel)}</span>
        {years && <span>{years}</span>}
        <span>{n.kp ? T("你已有这个知识点") : T("还没学过")}</span>
      </div>
      {atlasGloss(n) && <div className="kg-def-text">{atlasGloss(n)}</div>}
      {n.chain.length > 0 && <div className="kg-chain">{n.chain.map((c) => c.label).reverse().join(" › ")}</div>}
      <RouteBlock target={n.id} route={route} setRoute={setRoute} onPick={onPick} />
      {n.kp && (
        <div className="kg-actions">
          <button className="btn btn-outline btn-sm" onClick={() => onOpenKp(n.kp!.id)}>{T("打开我的知识点")}</button>
        </div>
      )}
      <AtlasRelations rows={ctx.rows} onPick={onPick} />
      {maps.length > 0 && (
        <section data-testid="kg-atlas-appear">
          <div className="kg-sec-title">{T("出现在")}</div>
          <MapAppearRows maps={maps} onOpenMap={onOpenMap} onRemove={(ids, m, nd) => void removeAi(ids, m, nd)} />
        </section>
      )}
      <AtlasReport atlasId={n.id} />
    </aside>
  );
}

/** 未挂全谱的知识点：搜全谱挂上 */
/** 全谱节点 id → 节点（按需取，模块级缓存） */
const atlasNodeCache = new Map<string, AtlasNode>();
function useAtlasNodes(ids: string[]): Map<string, AtlasNode> {
  const key = ids.join(",");
  const [, bump] = useState(0);
  useEffect(() => {
    const miss = ids.filter((id) => !atlasNodeCache.has(id));
    if (!miss.length) return;
    let alive = true;
    void Promise.all(miss.map((id) => atlasApi()?.atlasNode(id).catch(() => null))).then((rs) => {
      rs.forEach((n, i) => n && atlasNodeCache.set(miss[i], n));
      if (alive) bump((x) => x + 1);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return atlasNodeCache;
}

/**
 * v49.145 / D313：一个知识点在全谱里只有一个位置（对应条目或私有上级），另可记任意多个「也涉及」。
 * 节点详情与整理面板「已设私有」列表共用：显示上级、也涉及（可撤销），就地搜索添加。
 */
function AtlasAlso({ kpId, label, parent, also, onChanged, onPick }: { kpId: string; label: string; parent?: string | null; also: string[]; onChanged: () => void; onPick?: (atlasId: string) => void }) {
  const T = useT();
  const [list, setList] = useState(also);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setList(also), [also]);
  const nodes = useAtlasNodes([...(parent ? [parent] : []), ...list]);
  const name = (id: string) => (nodes.get(id) ? atlasLabel(nodes.get(id)!) : id);
  const set = async (id: string, on: boolean) => {
    setErr("");
    try {
      setList(await atlasApi()!.setAtlasAlso(kpId, id, on));
      onChanged();
    } catch (e) {
      setErr(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  return (
    <div className="kg-also" data-testid="kg-atlas-also">
      <dl className="kg-atlas-dl">
        {parent && (
          <>
            <dt>{T("上级")}</dt>
            <dd>{onPick ? <button className="kg-link" onClick={() => onPick(parent)}>{name(parent)}</button> : <span>{name(parent)}</span>}</dd>
          </>
        )}
        <dt>{T("也涉及")}</dt>
        <dd className="kg-atlas-tags">
          {list.map((id) => (
            <span key={id} className="kg-also-chip">
              {onPick ? <button className="kg-link" onClick={() => onPick(id)}>{name(id)}</button> : <span>{name(id)}</span>}
              <button className="kg-also-x" aria-label={T("不再关联「{name}」", { name: name(id) })} title={T("不再关联「{name}」", { name: name(id) })} onClick={() => void set(id, false)}>×</button>
            </span>
          ))}
          <button className="kg-textbtn kg-atlas-add" onClick={() => setAdding((v) => !v)}>{adding ? T("收起") : T("＋ 添加")}</button>
        </dd>
      </dl>
      {adding && <MapSearch label={label} modes={["also"]} also={list} onPick={(id) => void set(id, !list.includes(id))} />}
      {err && <p className="kgv-err">{err}</p>}
    </div>
  );
}

/** v49.146：节点详情「全谱」段（未对应条目时）——状态一行、上级 / 也涉及两列表、搜索结果与整理面板同一套「是它 / 上级 / 也涉及」 */
function AtlasPlace({ kpId, label, parent, also, split = [], onChanged, onPick }: { kpId: string; label: string; parent: string | null; also: string[]; split?: string[]; onChanged: () => void; onPick?: (atlasId: string) => void }) {
  const T = useT();
  const [searching, setSearching] = useState(!parent);
  const [err, setErr] = useState("");
  useEffect(() => setSearching(!parent), [parent, kpId]);
  const place = async (atlasId: string | null, par: string | null) => {
    setErr("");
    try {
      await atlasApi()!.linkAtlas(kpId, atlasId, par);
      onChanged();
    } catch (e) {
      setErr(String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };
  return (
    <section data-testid="kg-atlas-link">
      <div className="kg-sec-head">
        <div className="kg-sec-title">{T("全谱")}</div>
        {parent ? (
          <span className="kg-sec-acts">
            <button className="kg-textbtn kg-sec-act" onClick={() => setSearching((v) => !v)}>{searching ? T("收起") : T("更改")}</button>
            <button className="kg-textbtn kg-sec-act" onClick={() => void place(null, null)}>{T("撤销私有")}</button>
          </span>
        ) : null}
      </div>
      <p className="kg-atlas-state">{parent ? (split.includes(parent) ? T("译名分化：和全谱条目是同一个外语词，但在这里是另一个含义") : T("私有知识点（比全谱更细）")) : T("还没挂到全谱：找到同一条目选「是它」，更细的论点选「上级」。")}</p>
      {(parent || also.length > 0) && <AtlasAlso kpId={kpId} label={label} parent={parent} also={also} onChanged={onChanged} onPick={onPick} />}
      {searching && <MapSearch label={label} modes={["same", "parent"]} onPick={(id, mode) => void (mode === "same" ? place(id, null) : place(null, id))} />}
      {err && <p className="kgv-err">{err}</p>}
    </section>
  );
}

/**
 * 整理知识点到全谱（迁移 §10；v49.144 / D312 改版）。用户的说法常是意译（幸存者崇拜 / 幸存者偏差）、复合（锈带红脖）
 * 或比全谱更细的论点（优绩主义的单一尺度）——名称精确匹配找不到不代表全谱缺失。每一行都可以操作：
 *   ① 候选（名称匹配 / AI 给的标准名在本地全谱查到的）→ 挂上；② 可能的上级（名称里含的全谱词 / AI 给的上位名）→ 设为私有知识点挂在它下面；
 *   ③ 就地搜索。AI 只给名称不给编号（kg-atlas-map），编号一律由本地全谱解析。
 */
interface MapRow {
  id: string;
  label: string;
  description: string;
  atlasId: string | null;
  atlasParent: string | null;
  also: string[];
  hits: AtlasNode[];
  parents: AtlasNode[];
  ai?: "pending" | "done" | "failed";
  /** 本次打开面板时动过（挂上 / 设私有 / 撤销）：留在列表原位，可改可撤 */
  touched?: boolean;
  /** 本次选中的全谱节点（显示名用） */
  placed?: AtlasNode | null;
}
/** 同一行里名字相同的候选（多义词：幸存者＝概念 / 电视节目 / 电影…）附一句说明区分 */
function ChipLabel({ h, list }: { h: AtlasNode; list: AtlasNode[] }) {
  const T = useT();
  const name = atlasLabel(h);
  const dup = list.filter((x) => atlasLabel(x) === name).length > 1;
  if (!dup) return <>{name}</>;
  const g = atlasGloss(h) || (h.kindLabel ? T(h.kindLabel) : "") || h.id;
  return (
    <>
      {name}
      <small> · {g.length > 14 ? g.slice(0, 14) + "…" : g}</small>
    </>
  );
}
function AtlasMapPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const T = useT();
  const [rows, setRows] = useState<MapRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [aiOk, setAiOk] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ done: number; total: number; startedAt: number } | null>(null);
  const [openSearch, setOpenSearch] = useState<string | null>(null);
  const [showPrivate, setShowPrivate] = useState(false);
  // v49.147 / D316：改名 / 并入 / 解散重挂后的提示条（解散后带「撤销」）与解散预览
  const [notice, setNotice] = useState<{ text: string; undoToken?: string } | null>(null);
  const [reattach, setReattach] = useState<string[] | null>(null);
  useEffect(() => {
    void aiGateway.getConfig().then((c) => setAiOk(aiConfigUsable(c))).catch(() => setAiOk(false));
  }, []);
  const reload = useCallback(async () => {
    const api = atlasApi();
    if (!api) return;
    const kps = await api.unmappedKps();
    const out: MapRow[] = [];
    for (const k of kps.slice(0, 300)) {
      const hits = await api.atlasSearch(k.label.replace(/[《》]/g, ""), { limit: 4 }).catch(() => [] as AtlasNode[]);
      // 名称里出现的全谱词作「可能的上级」（本地字典召回，不花 AI 额度）。同名多义条目（幸存者＝概念 / 电影 / 电视节目…）
      // 只留排名最高的一个，免得几个同名条目占满名额；其余可在「搜索…」里找
      const rawParents = hits.length ? [] : ((await (window as unknown as { kgAPI: { atlasCandidates(t: string, o?: { limit?: number }): Promise<AtlasNode[]> } }).kgAPI.atlasCandidates(k.label, { limit: 10 }).catch(() => [])) as AtlasNode[]);
      const parents = rawParents.filter((h, i) => rawParents.findIndex((x) => atlasLabel(x) === atlasLabel(h)) === i).slice(0, 4);
      out.push({ id: k.id, label: k.label, description: k.description, atlasId: null, atlasParent: k.atlasParent, also: k.also || [], hits, parents });
    }
    setRows(out);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  /** 挂上 / 设私有 / 撤销（都传 null）：就地更新这一行，不整表重载——行留在原位，可以接着选也涉及、改选或撤销 */
  const link = async (kpId: string, atlasId: string | null, parent: string | null, node: AtlasNode | null) => {
    try {
      const res = await atlasApi()!.linkAtlas(kpId, atlasId, parent);
      const pos = [atlasId, parent].filter(Boolean);
      if (res?.mergedInto) {
        // D316：该条目已有知识点 → 当前知识点并入它，行消失
        setRows((rs) => (rs || []).filter((x) => x.id !== kpId));
        setNotice({ text: T("已并入「{name}」，可在管理里解除合并", { name: res.mergedInto.label }) });
      } else {
        setRows((rs) => (rs || []).map((x) => (x.id === kpId ? { ...x, label: res?.renamed ? res.renamed.to : x.label, atlasId, atlasParent: parent, placed: node, touched: true, also: x.also.filter((q) => !pos.includes(q)) } : x)));
        if (res?.renamed) setNotice({ text: T("已改名为「{to}」，原名「{from}」保留为别名", { to: res.renamed.to, from: res.renamed.from }) });
      }
      onChanged();
      return true;
    } catch (e) {
      setMsg(errText(e));
      return false;
    }
  };
  // v49.145 / D313：也涉及——就地切换
  const toggleAlso = async (kpId: string, atlasId: string, on: boolean) => {
    try {
      const also = await atlasApi()!.setAtlasAlso(kpId, atlasId, on);
      setRows((rs) => (rs || []).map((x) => (x.id === kpId ? { ...x, also } : x)));
      onChanged();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const isPlaced = (r: MapRow) => !!(r.atlasId || r.atlasParent);
  const shown = (rows || []).filter((r) => r.touched || !isPlaced(r));
  const open = (rows || []).filter((r) => !isPlaced(r));
  const privates = (rows || []).filter((r) => r.atlasParent && !r.touched);
  const uniq = open.filter((r) => r.ai !== "pending" && r.hits.filter((h) => h.exact).length === 1);
  const unfound = open.filter((r) => r.hits.length === 0 && r.ai !== "done" && r.ai !== "pending");
  const waiting = (rows || []).filter((r) => r.ai === "pending").length;
  // 批量解散：无唯一匹配（没有候选、候选对不上、AI 也没找到）的行
  const dissolvable = open.filter((r) => r.ai !== "pending" && r.hits.filter((h) => h.exact).length !== 1);
  const onDissolved = (r: ReattachResult) => {
    const gone = new Set(r.archivedIds);
    setRows((rs) => (rs || []).filter((x) => !gone.has(x.id)));
    setReattach(null);
    setNotice({ text: T("已移动 {n} 张卡片", { n: r.moved }), undoToken: r.moved > 0 ? r.undoToken : undefined });
    onChanged();
  };
  const undoDissolve = async (token: string) => {
    try {
      await atlasApi()!.reattachUndo(token);
      setNotice({ text: T("已撤销，卡片回到原知识点") });
      await reload();
      onChanged();
    } catch (e) {
      setMsg(errText(e));
    }
  };

  // AI 匹配：每批 5 个、同时 4 批（原先每批 20 个串行，首批要几分钟、进度一直停在 0）；每批回来就更新这几行与进度。
  // AI 给标准名 → 本地全谱查找（精确优先）。排队中的行标「AI 查找中」并锁住，免得先选后被覆盖
  const AI_BATCH = 5;
  const AI_PARALLEL = 4;
  const runAi = async () => {
    const tpl = await window.promptsAPI?.get("kg-atlas-map");
    if (!tpl) {
      setMsg(T("提示词模板缺失，请重启应用完成播种。"));
      return;
    }
    const api = atlasApi()!;
    const queue = unfound.slice();
    const qIds = new Set(queue.map((r) => r.id));
    setRows((rs) => (rs || []).map((x) => (qIds.has(x.id) ? { ...x, ai: "pending" } : x)));
    setAiProgress({ done: 0, total: queue.length, startedAt: Date.now() });
    setMsg("");
    const resolveNames = async (names: unknown): Promise<AtlasNode[]> => {
      const out: AtlasNode[] = [];
      for (const nm of (Array.isArray(names) ? names : []).slice(0, 4)) {
        if (typeof nm !== "string" || !nm.trim()) continue;
        const r = await api.atlasSearch(nm.trim(), { limit: 3 }).catch(() => [] as AtlasNode[]);
        const pick = r.filter((x) => x.exact).slice(0, 2);
        for (const x of pick.length ? pick : r.slice(0, 1)) if (!out.some((o) => o.id === x.id)) out.push(x);
      }
      return out;
    };
    const runBatch = async (batch: MapRow[]) => {
      let items: { id: string; same?: string[]; parent?: string[]; split?: string[] }[] = [];
      try {
        const user = batch.map((r) => JSON.stringify({ id: r.id, 名称: r.label, 定义: r.description ? r.description.slice(0, 200) : undefined })).join("\n");
        const raw = await aiGateway.chat([{ role: "system", content: tpl.content }, { role: "user", content: `【知识点】\n${user}` }], undefined, 0.2, undefined, undefined, "kp_extract");
        const t = String(raw || "");
        const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
        items = Array.isArray(j.items) ? j.items : [];
      } catch (e) {
        setMsg(errText(e));
      }
      const byId = new Map(items.map((x) => [String(x.id), x]));
      const updates = new Map<string, Partial<MapRow>>();
      for (const r of batch) {
        const it = byId.get(r.id);
        if (!it) {
          updates.set(r.id, { ai: "failed" });
          continue;
        }
        const same = await resolveNames(it.same);
        const parents = await resolveNames([...(it.parent || []), ...(it.split || [])]);
        updates.set(r.id, { ai: "done", hits: same, parents: parents.length ? parents : r.parents });
      }
      setRows((rs) => (rs || []).map((x) => (updates.has(x.id) ? { ...x, ...updates.get(x.id) } : x)));
      setAiProgress((p) => (p ? { ...p, done: Math.min(p.total, p.done + batch.length) } : p));
    };
    const batches: MapRow[][] = [];
    for (let i = 0; i < queue.length; i += AI_BATCH) batches.push(queue.slice(i, i + AI_BATCH));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) await runBatch(batches[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(AI_PARALLEL, batches.length) }, worker));
    setAiProgress(null);
  };
  // 进度条之外每秒刷新「已用时」，看得出仍在进行
  const [, tick] = useState(0);
  useEffect(() => {
    if (!aiProgress) return;
    const h = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(h);
  }, [aiProgress]);

  return (
    <div className="kg-pop kg-mappop is-open" data-testid="kg-map-panel">
      <div className="kg-detail-head">
        <h3>{T("整理知识点到全谱")}</h3>
        <button className="icon-btn" onClick={onClose} aria-label={T("关闭")}>✕</button>
      </div>
      <p className="kg-note">{T("给每个知识点选一个角色：「是它」＝全谱里的同一条目；「上级」＝比全谱更细，设为私有挂在它下面；「也涉及」可多选。")}</p>
      {rows == null ? (
        <p className="kg-note">{T("正在查找…")}</p>
      ) : shown.length === 0 ? (
        <p className="kg-note">{T("所有知识点都已挂上全谱。")}</p>
      ) : (
        <div className="kg-map-bar">
          {uniq.length > 0 && (
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                for (const r of uniq) {
                  const h = r.hits.find((x) => x.exact)!;
                  await link(r.id, h.id, null, h);
                }
                setBusy(false);
              }}
            >
              {T("挂上 {n} 个唯一匹配", { n: uniq.length })}
            </button>
          )}
          {dissolvable.length > 0 && !reattach && (
            <button className="btn btn-outline btn-sm" data-testid="kg-map-dissolve-all" disabled={busy || !!aiProgress} title={T("把这些知识点名下的卡片重新挂到全谱条目，确认前可逐张修改")} onClick={() => setReattach(dissolvable.map((r) => r.id))}>
              {T("解散找不到条目的 {n} 个…", { n: dissolvable.length })}
            </button>
          )}
          {(unfound.length > 0 || aiProgress) && (
            <button className="btn btn-outline btn-sm" data-testid="kg-map-ai" disabled={!aiOk || !!aiProgress} title={aiOk ? undefined : T("需要先在设置里配置 AI 服务")} onClick={() => void runAi()}>
              {aiProgress ? T("AI 匹配中 {a}/{b}", { a: aiProgress.done, b: aiProgress.total }) : T("用 AI 匹配找不到的 {n} 个", { n: unfound.length })}
            </button>
          )}
        </div>
      )}
      {aiProgress && waiting > 0 && (
        <p className="kg-map-ainote" data-testid="kg-map-ainote" role="status">
          {T("AI 正在查找：已完成 {a}/{b}，已用 {s} 秒。标着「AI 查找中」的行暂时不能选，每批结果回来就会更新。", { a: aiProgress.done, b: aiProgress.total, s: Math.round((Date.now() - aiProgress.startedAt) / 1000) })}
        </p>
      )}
      {notice && (
        <p className="kg-map-notice" data-testid="kg-map-notice" role="status">
          {notice.text}
          {notice.undoToken && <button className="kg-textbtn" data-testid="kg-reattach-undo" onClick={() => void undoDissolve(notice.undoToken!)}>{T("撤销")}</button>}
        </p>
      )}
      {reattach && (
        <Suspense fallback={null}>
        <ReattachPreview
          kpIds={reattach}
          onCancel={() => setReattach(null)}
          onDone={onDissolved}
          renderSearch={(label, onPick) => <MapSearch label={label} modes={["same"]} onPick={(id, _m, node) => onPick(id, node)} />}
        />
        </Suspense>
      )}
      {rows && shown.length > 0 && (
        <ul className="kg-maplist">
          {shown.map((r) => {
            const locked = r.ai === "pending";
            const undo = () => void link(r.id, null, null, null);
            // 每个候选只出现一次，用「是它 / 上级 / 也涉及」三个角色切换（原先三组按钮里同一条目重复出现）。
            // 候选＝名称 / AI 找到的条目 + 可能的上级 + 已记的也涉及（任一来源的条目都可以选作也涉及）
            const cands: { id: string; node: AtlasNode | null }[] = [];
            for (const h of [...r.hits, ...r.parents]) if (!cands.some((c) => c.id === h.id)) cands.push({ id: h.id, node: h });
            for (const q of r.also) if (!cands.some((c) => c.id === q)) cands.push({ id: q, node: null });
            const status = locked
              ? T("AI 查找中…")
              : r.atlasId
                ? T("对应「{name}」", { name: r.placed ? atlasLabel(r.placed) : r.atlasId })
                : r.atlasParent
                  ? T("私有，挂在「{name}」下", { name: r.placed ? atlasLabel(r.placed) : r.atlasParent })
                  : null;
            return (
              <li key={r.id} data-testid="kg-map-row" className={locked ? "is-waiting" : isPlaced(r) ? "is-placed" : undefined}>
                <div className="kg-map-head">
                  <b className="kg-map-name">{r.label}</b>
                  {status && (
                    <span className="kg-map-status" data-testid={locked ? "kg-map-wait" : "kg-map-done"}>
                      {status}
                      {isPlaced(r) && !locked && <button className="kg-textbtn" data-testid="kg-map-undo" onClick={undo}>{T("撤销")}</button>}
                    </span>
                  )}
                </div>
                {cands.length > 0 ? (
                  <ul className="kg-map-cands">
                    {cands.map(({ id, node }) => {
                      const isSame = r.atlasId === id;
                      const isParent = r.atlasParent === id;
                      const isAlso = r.also.includes(id);
                      const gloss = node ? atlasGloss(node) : "";
                      const aka = !node ? null : r.hits.some((x) => x.id === id) ? akaOf(node, r.label) : (node as AtlasNode & { matched?: string | null }).matched ? akaOf({ ...node, exact: true }, String((node as AtlasNode & { matched?: string | null }).matched)) : null;
                      return (
                        <li key={id} className={isSame || isParent || isAlso ? "is-picked" : undefined}>
                          <span className="kg-map-cand" title={gloss || undefined}>
                            <span className="kg-map-cand-name">{node ? atlasLabel(node) : <AtlasName id={id} />}</span>
                            {aka && <span className="kg-map-cand-aka">{T("又名「{name}」", { name: aka })}</span>}
                            {gloss && <span className="kg-map-cand-gloss">{gloss}</span>}
                          </span>
                          <span className="kg-map-roles" role="group" aria-label={T("作为")}>
                            <button className={isSame ? "is-on" : undefined} data-testid="kg-map-same" aria-pressed={isSame} disabled={locked} title={T("这个知识点就是全谱里的它")} onClick={() => (isSame ? undo() : void link(r.id, id, null, node))}>{T("是它")}</button>
                            <button className={isParent ? "is-on" : undefined} data-testid="kg-map-parent" aria-pressed={isParent} disabled={locked} title={T("设为私有知识点，挂在「{name}」下", { name: node ? atlasLabel(node) : id })} onClick={() => (isParent ? undo() : void link(r.id, null, id, node))}>{T("上级")}</button>
                            <button className={isAlso ? "is-on" : undefined} data-testid="kg-map-also" aria-pressed={isAlso} disabled={locked || isSame || isParent} title={T("同时涉及它（不是上级）")} onClick={() => void toggleAlso(r.id, id, !isAlso)}>{T("也涉及")}</button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  !locked && <p className="kg-map-empty">{r.ai === "done" ? T("AI 也没找到对应条目") : r.ai === "failed" ? T("AI 这一批没有返回结果") : T("名称没有直接对上")}</p>
                )}
                {!locked && (
                  <div className="kg-map-foot">
                    <button className="kg-textbtn" onClick={() => setOpenSearch(openSearch === r.id ? null : r.id)}>{openSearch === r.id ? T("收起") : T("在全谱里搜索…")}</button>
                    {!isPlaced(r) && <button className="kg-textbtn" data-testid="kg-map-dissolve" title={T("把名下的卡片重新挂到全谱条目，确认前可逐张修改")} onClick={() => setReattach([r.id])}>{T("解散…")}</button>}
                  </div>
                )}
                {!locked && openSearch === r.id && (
                  <MapSearch
                    label={r.label}
                    also={r.also}
                    onPick={async (id, mode, node) => {
                      if (mode === "also") return void toggleAlso(r.id, id, !r.also.includes(id));
                      if (await link(r.id, mode === "parent" ? null : id, mode === "parent" ? id : null, node || null)) setOpenSearch(null);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {privates.length > 0 && (
        <div className="kg-map-private">
          <button className="kg-textbtn" onClick={() => setShowPrivate((v) => !v)}>{T("已设为私有知识点 {n} 个", { n: privates.length })}</button>
          {showPrivate && (
            <ul className="kg-maplist">
              {privates.map((r) => (
                <li key={r.id}>
                  <b>{r.label}</b>
                  <span className="kg-map-acts">
                    <AtlasAlso kpId={r.id} label={r.label} parent={r.atlasParent} also={r.also} onChanged={onChanged} />
                    <button className="kg-textbtn" onClick={() => void link(r.id, null, null, null)}>{T("撤销私有")}</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {msg && <p className="kgv-err">{msg}</p>}
    </div>
  );
}


/** 全谱是按维基百科条目名显示的；按别名命中时（搜「优绩主义」命中「精英政治」）注明，免得看起来像没找到 */
const akaKey = (x: string) => x.normalize("NFKC").toLowerCase().replace(/[\s　·・\-_'"()（）《》〈〉,，.。:：;；!！?？/]+/g, "");
function akaOf(h: AtlasNode, query: string): string | null {
  const q = query.replace(/[《》]/g, "").trim();
  if (!h.exact || !q) return null;
  const names = [h.zh, h.zht, h.en, h.ja].filter(Boolean).map((x) => akaKey(String(x)));
  return names.includes(akaKey(q)) ? null : q;
}

/** 整理面板里的就地搜索：选中的节点可以「就是它」挂上，或「作为上级」设为私有 */
type MapPick = "same" | "parent" | "also";
function AtlasName({ id, known }: { id: string; known?: AtlasNode }) {
  const n = useAtlasNodes(known ? [] : [id]).get(id) || known;
  return <>{n ? atlasLabel(n) : id}</>;
}
function MapSearch({ label, onPick, modes = ["same", "parent", "also"], also = [] }: { label: string; onPick: (atlasId: string, mode: MapPick, node?: AtlasNode) => void; modes?: MapPick[]; also?: string[] }) {
  const T = useT();
  const [q, setQ] = useState(label.replace(/[《》]/g, ""));
  const [hits, setHits] = useState<AtlasNode[]>([]);
  // idle：还没搜；busy：搜索中；done：已返回（hits 为空即「没找到」）；error：出错
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const seq = useRef(0);
  const [asked, setAsked] = useState("");
  const run = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setAsked(t);
    const my = ++seq.current;
    setState("busy");
    try {
      const r = (await atlasApi()?.atlasSearch(t, { limit: 8 })) || [];
      if (my !== seq.current) return;
      setHits(r);
      setState("done");
    } catch {
      if (my !== seq.current) return;
      setHits([]);
      setState("error");
    }
  }, []);
  // 打开即按知识点名称搜一次，之后由用户点「搜索」或按回车
  useEffect(() => {
    void run(label.replace(/[《》]/g, ""));
  }, [label, run]);
  return (
    <span className="kg-map-search" data-testid="kg-map-search">
      <form
        className="kg-map-search-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(q);
        }}
      >
        <input
          className="kg-search"
          value={q}
          autoFocus
          aria-label={T("搜索全谱")}
          placeholder={T("换个说法搜索全谱")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            void run(q);
          }}
        />
        <button type="submit" className="btn btn-outline btn-sm" disabled={!q.trim() || state === "busy"}>{T("搜索")}</button>
      </form>
      {state === "busy" && <span className="kg-map-cap">{T("正在查找…")}</span>}
      {state === "error" && <span className="kg-map-cap">{T("搜索失败，请重试")}</span>}
      {state === "done" && hits.length === 0 && <span className="kg-map-cap">{T("全谱里没有找到，换个说法试试")}</span>}
      <AtlasMissHint show={state === "done" && hits.length === 0} />
      {hits.length > 0 && state !== "busy" && (
        <ul className="kg-map-cands">
          {hits.map((h) => {
            const isAlso = also.includes(h.id);
            const gloss = atlasGloss(h) || T(h.kindLabel);
            return (
              <li key={h.id} className={isAlso ? "is-picked" : undefined}>
                <span className="kg-map-cand" title={gloss || undefined}>
                  <span className="kg-map-cand-name">{atlasLabel(h)}</span>
                  {akaOf(h, asked) && <span className="kg-map-cand-aka">{T("又名「{name}」", { name: akaOf(h, asked)! })}</span>}
                  {gloss && <span className="kg-map-cand-gloss">{gloss}</span>}
                </span>
                <span className="kg-map-roles" role="group" aria-label={T("作为")}>
                  {modes.includes("same") && <button title={T("这个知识点就是全谱里的它")} onClick={() => onPick(h.id, "same", h)}>{T("是它")}</button>}
                  {modes.includes("parent") && <button title={T("设为私有知识点，挂在「{name}」下", { name: atlasLabel(h) })} onClick={() => onPick(h.id, "parent", h)}>{T("上级")}</button>}
                  {modes.includes("also") && (
                    <button className={isAlso ? "is-on" : undefined} data-testid="kg-search-also" aria-pressed={isAlso} title={isAlso ? T("点一下取消") : T("同时涉及它（不是上级）")} onClick={() => onPick(h.id, "also", h)}>{T("也涉及")}</button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </span>
  );
}
