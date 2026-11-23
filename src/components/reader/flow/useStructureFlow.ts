// 结构流 · 数据 hook（STRUCTURE-FLOW-PLAN §6.1 / §6.2 / §12.4.3）。
// 阅读透镜 v2 的取图 / 定位 / 送原文 / 增量 / 取锚 / 六个动作移植到此；定位改为「多点取样 + 注意力判定 + 邻组预览」。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ReaderLocation,
  ReaderReadingProbe,
  ReaderStructureTarget,
  ReaderTocItem,
  RelocateInfo,
  SectionUnitInfo,
} from "../../../lib/reader/kernel";
import type { GraphLocate, MindmapDelta, NodeAnchor } from "../../../lib/mindmapV2";
import { mindmapV2Api } from "../../../lib/mindmapV2";
import type { GraphState } from "../../../lib/mindmap/v2/types";
import { ROOT_ID } from "../../../lib/mindmap/v2/types";
import { applyDelta, childrenOf, createGraph } from "../../../lib/mindmap/v2/graph";
import { ensureFed, resetFeed, subscribeFeed, type FeedKernel, type FeedState } from "../../../lib/mindmapFeed";
import { eventBus } from "../../../lib/eventbus";
import { useT } from "../../../lib/i18n";
import { ATTN, decideAttention, type AttnResult, type AttnSample, type AttnState } from "../../../lib/flow/layout";

/** 结构流只用到内核的这几件事（阅读窗口直传真实内核，结构上是它的超集） */
export interface FlowKernel {
  getTOC(): ReaderTocItem[];
  getSectionAnchors?(): SectionUnitInfo[];
  getSectionText?(startAnchor: string, endAnchor?: string): Promise<string>;
  getReadingProbe?(): { unitAnchor: string; text: string } | null;
  getReadingProbes?(fracs: number[]): ReaderReadingProbe[];
  getCurrentLocation(): ReaderLocation | null;
  goTo(target: ReaderLocation | { href: string } | { search: string }): Promise<boolean>;
  goToText?(t: { unitAnchor: string; head: string; tail?: string }): Promise<boolean>;
  setStructureTargets?(targets: ReaderStructureTarget[]): void;
  /** §13.3：正文逐帧滚动通知（滚动模式下驱动取样节流与彩带同步） */
  onContentScroll?(cb: () => void): () => void;
  on(event: "relocate", handler: (info: RelocateInfo) => void): () => void;
}

export interface StructureFlowData {
  graph: GraphState | null;
  feed: FeedState;
  busy: string | null;
  /** 诊断 P1-a/b：生成中的提示文字目标（节点标题；""＝尚未定位到节点）；null＝没有在生成 */
  generating: string | null;
  hasKey: boolean;
  /** 注意力判定：当前组 + 阅读节点（§12.4） */
  groupId: string | null;
  readingId: string | null;
  readingBlock: number | null;
  peek: { groupId: string; side: "above" | "below" } | null;
  switchInfo: { dir: "down" | "up"; seq: number } | null;
  sel: string | null;
  setSel: (id: string | null) => void;
  hoverId: string | null;
  setHoverId: (id: string | null) => void;
  expandedId: string | null;
  toggleExpand: (id: string) => void;
  /** 邻组预览被点：立即把该组设为当前组（唯一不需要驻留的切组途径，§12.4.4） */
  focusGroup: (groupId: string, nodeId: string | null) => void;
  backLoc: ReaderLocation | null;
  explainFor: string | null;
  explainText: string;
  explainBusy: boolean;
  status: string;
  showStatus: (text: string, ms?: number) => void;
  anchorTick: number;
  requestAnchors: (ids: string[]) => void;
  jumpTo: (id: string) => Promise<void>;
  goBack: () => Promise<void>;
  generateHere: () => Promise<void>;
  deepen: (id: string) => Promise<void>;
  explain: (id: string) => Promise<void>;
  closeExplain: () => void;
}

/** 文档切换 / 关闭时清空目标：避免内核保留上一次的 Range */
const EMPTY_TARGETS: ReaderStructureTarget[] = [];
/** §5.1 TURN_RESAMPLE_MS（hook 不在 layout 的常量域里，单独引用一次避免循环依赖） */
const FLOW_TURN_RESAMPLE = 220;

export function useStructureFlow(kernel: FlowKernel | null, documentId: string | null, title: string, active: boolean, opts: { paged: boolean }): StructureFlowData {
  const T = useT();
  const paged = opts.paged;
  const [feed, setFeed] = useState<FeedState>({ done: 0, total: 0, complete: false, unsupported: false });
  const [graph, setGraph] = useState<GraphState | null>(null);
  const graphRef = useRef<GraphState | null>(null);
  graphRef.current = graph;
  const [busy, setBusy] = useState<string | null>(null);
  /** 「为本节生成 / 深挖」的目标节点（生成中提示用） */
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [hasKey, setHasKey] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [backLoc, setBackLoc] = useState<ReaderLocation | null>(null);
  const [explainLocal, setExplainLocal] = useState<Record<string, string>>({});
  const [explainBusyId, setExplainBusyId] = useState<string | null>(null);
  const [explainFor, setExplainFor] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [anchorEpoch, setAnchorEpoch] = useState(0);
  const [attnTick, setAttnTick] = useState(0);
  const [switchInfo, setSwitchInfo] = useState<{ dir: "down" | "up"; seq: number } | null>(null);
  const docRef = useRef(documentId);
  docRef.current = documentId;
  const anchorCache = useRef<Map<string, NodeAnchor[] | null>>(new Map());
  const explainJobRef = useRef<string | null>(null);
  const statusTimer = useRef<number | null>(null);

  const attnRef = useRef<AttnState>({ groupId: null, readingId: null, candGroup: null, candSince: 0, candNode: null, nodeSince: 0 });
  const peekRef = useRef<AttnResult["peek"]>(null);
  const blockRef = useRef<number | null>(null);
  const mapIdRef = useRef<string | null>(null);
  /** 「为本节生成」进行中的文档（覆盖整段 await，防同一文档重复点击并发建图；换文档不受旧文档拦截） */
  const genRunRef = useRef<string | null>(null);
  const feedRef = useRef(feed);
  feedRef.current = feed;

  // ---------- 图 ----------
  const loadGraph = useCallback(async () => {
    if (!documentId) return;
    try {
      const r = await mindmapV2Api.load({ documentId });
      if (docRef.current !== documentId) return;
      if (!r.meta || !r.meta.mapId) {
        setGraph(null);
        mapIdRef.current = null;
        return;
      }
      mapIdRef.current = String(r.meta.mapId);
      setGraph(createGraph({ meta: r.meta, nodes: r.nodes, edges: r.edges, view: null }, String(r.meta.mapId)));
    } catch {
      /* 读图失败：保持空态 */
    }
  }, [documentId]);

  // ---------- 定位（多点取样 → 注意力判定） ----------
  const sampleTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);
  const throttleTimer = useRef<number | null>(null);
  const recheckTimer = useRef<number | null>(null);
  const lastScrollAt = useRef(0);
  const lastSampleAt = useRef(0);
  const sampleSeq = useRef(0);
  /** §13.1.2：注意力样本落在某成员的子节点里 → 自动展开该成员 */
  const deepRef = useRef<string | null>(null);
  const manualExpRef = useRef(false);
  const retriedRef = useRef(false);
  const scheduleRef = useRef<(ms?: number, idle?: boolean) => void>(() => {});
  const sampleNow = useCallback(
    async (idle: boolean) => {
      if (!kernel || !documentId || !active) return;
      const my = ++sampleSeq.current;
      // §13.1.2：滚动中不把「非 idle」当结论——160ms 内没有任何滚动才算停下
      const effectiveIdle = idle || performance.now() - lastScrollAt.current >= 160;
      const probes = kernel.getReadingProbes?.(ATTN.FRACS) ?? [];
      let raw: ReaderReadingProbe[] = probes.filter((p) => p.text);
      if (!raw.length) {
        // 引擎未实现多点探针 / 翻页模式下全部落空 → 退回单探针（当作 38% 的唯一样本）
        const p = kernel.getReadingProbe?.();
        if (p) raw = [{ frac: 0.38, unitAnchor: p.unitAnchor, text: p.text }];
      }
      if (!raw.length) return;
      const jobs = new Map<string, Promise<GraphLocate | null>>();
      const results = await Promise.all(
        raw.map(async (p) => {
          const key = `${p.unitAnchor}|${p.text}`;
          let job = jobs.get(key);
          if (!job) {
            job = mindmapV2Api.locate({ documentId, unitAnchor: p.unitAnchor, text: p.text }).catch(() => null);
            jobs.set(key, job);
          }
          return { p, r: await job };
        }),
      );
      if (my !== sampleSeq.current) return; // 过期结果直接丢弃
      if (docRef.current !== documentId || !active) return;
      const anyReady = results.some((x) => x.r && x.r.ready);
      if (!anyReady && feedRef.current.complete && !retriedRef.current) {
        // 原文已送完却定位不到：主进程会话被挤出 → 重送一次
        retriedRef.current = true;
        resetFeed(kernel as unknown as FeedKernel, documentId);
        void ensureFed(kernel as unknown as FeedKernel, documentId, title).then(() => scheduleRef.current(0));
        return;
      }
      // 记下每个节点的块号（时间线阅读游标 / 邻组 stub 方向用）
      const blocks = new Map<string, number>();
      for (const { r } of results) if (r?.ready && r.nodeId && r.block != null) blocks.set(r.nodeId, r.block);
      const samples: AttnSample[] = results.map(({ p, r }) => ({
        frac: p.frac,
        nodeId: r?.ready ? (r.nodeId ?? null) : null,
        chain: r?.ready ? (r.chain ?? []).filter((id) => id !== ROOT_ID) : [],
      }));
      const prev = attnRef.current;
      const next = decideAttention(samples, prev, performance.now(), { paged, idle: effectiveIdle });
      attnRef.current = {
        groupId: next.groupId,
        readingId: next.readingId,
        candGroup: next.candGroup,
        candSince: next.candSince,
        candNode: next.candNode,
        nodeSince: next.nodeSince,
      };
      const groupChanged = next.groupId !== prev.groupId;
      const readingChanged = next.readingId !== prev.readingId;
      // 当前组下的阅读块：取离注意力线最近的样本
      let rb: number | null = null;
      if (next.groupId) {
        const gid = next.groupId;
        const groupOf = (c: string[]) => (c.length >= 2 ? c[c.length - 2] : ROOT_ID);
        const upperOf = (c: string[]) => (c.length >= 3 ? c[c.length - 3] : c.length === 2 ? ROOT_ID : null);
        const inG = samples
          .filter((s) => s.nodeId && (groupOf(s.chain) === gid || upperOf(s.chain) === gid))
          .sort((a, b) => Math.abs(a.frac - 0.38) - Math.abs(b.frac - 0.38));
        const hit = inG.length ? blocks.get(inG[0].nodeId as string) : undefined;
        rb = hit ?? null;
      }
      // §13.1.2：更深一层的样本 → 自动展开该成员（manual 展开优先）
      if ((next.deepMember ?? null) !== deepRef.current) {
        deepRef.current = next.deepMember;
        setAttnTick((n) => n + 1);
      }
      const peek = next.peek;
      const prevPeek = peekRef.current;
      if ((prevPeek?.groupId ?? null) !== (peek?.groupId ?? null) || (prevPeek?.side ?? null) !== (peek?.side ?? null)) {
        peekRef.current = peek;
        setAttnTick((n) => n + 1);
      }
      if (groupChanged || readingChanged || attnRef.current.candGroup !== prev.candGroup) setAttnTick((n) => n + 1);
      if (rb !== blockRef.current) {
        blockRef.current = rb;
        setAttnTick((n) => n + 1);
      }
      if (next.switched) setSwitchInfo({ dir: next.switched, seq: Date.now() + Math.random() });
      // §13.1.2：候选组在等驻留 → 到点再取一次样（滚动已停才算数）
      if (recheckTimer.current != null) {
        window.clearTimeout(recheckTimer.current);
        recheckTimer.current = null;
      }
      if (next.recheckMs != null) {
        recheckTimer.current = window.setTimeout(() => {
          recheckTimer.current = null;
          void sampleNow(performance.now() - lastScrollAt.current >= 160);
        }, Math.max(next.recheckMs, 160) + 20);
      }
      const mapId = results.find((x) => x.r?.ready && x.r.mapId)?.r?.mapId ?? null;
      if (mapId && mapId !== mapIdRef.current) void loadGraph();
    },
    [kernel, documentId, title, loadGraph, active, paged],
  );
  const scheduleSample = useCallback(
    (ms = 160) => {
      if (sampleTimer.current != null) window.clearTimeout(sampleTimer.current);
      sampleTimer.current = window.setTimeout(() => {
        sampleTimer.current = null;
        void sampleNow(false);
      }, ms);
    },
    [sampleNow],
  );
  scheduleRef.current = scheduleSample;

  /** §15.3：换章＝章节键变化。立刻丢掉旧预览 / 选中 / 展开并马上重采；主体保留到新组算出为止 */
  const chapterRef = useRef<string | null>(null);
  const noteChapter = useCallback(
    (info?: RelocateInfo): boolean => {
      const k = info?.chapterHref != null ? `h:${info.chapterHref}` : info?.chapterIndex != null ? `c:${info.chapterIndex}` : null;
      if (k == null) return false;
      const prev = chapterRef.current;
      chapterRef.current = k;
      if (prev == null || prev === k) return false;
      peekRef.current = null;
      attnRef.current = { ...attnRef.current, candGroup: null, candNode: null };
      manualExpRef.current = false;
      setSel(null);
      setExpandedId(null);
      setAttnTick((n) => n + 1);
      return true;
    },
    [],
  );

  // 文档切换：清状态
  useEffect(() => {
    attnRef.current = { groupId: null, readingId: null, candGroup: null, candSince: 0, candNode: null, nodeSince: 0 };
    peekRef.current = null;
    blockRef.current = null;
    mapIdRef.current = null;
    setFeed({ done: 0, total: 0, complete: false, unsupported: false });
    setGraph(null);
    setBusy(null);
    setBusyNodeId(null);
    setStatus("");
    setSel(null);
    setHoverId(null);
    setExpandedId(null);
    setBackLoc(null);
    setExplainLocal({});
    setExplainFor(null);
    setExplainBusyId(null);
    setSwitchInfo(null);
    anchorCache.current.clear();
    retriedRef.current = false;
    deepRef.current = null;
    chapterRef.current = null;
    manualExpRef.current = false;
    sampleSeq.current++;
    for (const t of [sampleTimer.current, idleTimer.current, throttleTimer.current, recheckTimer.current]) if (t != null) window.clearTimeout(t);
    sampleTimer.current = idleTimer.current = throttleTimer.current = recheckTimer.current = null;
    lastScrollAt.current = 0;
    lastSampleAt.current = 0;
    setAttnTick((n) => n + 1);
  }, [documentId, kernel]);

  // 送原文（打开过结构图才送）
  useEffect(() => {
    if (!active || !kernel || !documentId) return;
    const off = subscribeFeed(kernel as Parameters<typeof subscribeFeed>[0], documentId, (st) => {
      setFeed(st);
      if (st.complete) scheduleSample(0);
    });
    void ensureFed(kernel as Parameters<typeof ensureFed>[0], documentId, title);
    void loadGraph();
    window.aiAPI
      ?.getConfig()
      .then((cfg) => setHasKey(Boolean(cfg?.hasKey) || cfg?.preset === "local"))
      .catch(() => setHasKey(false));
    return off;
  }, [active, kernel, documentId, title, loadGraph, scheduleSample]);

  // 阅读位置变化 → 重新取样（§13.1.2：正文逐帧滚动驱动；relocate 只做离散事件的补采）
  useEffect(() => {
    if (!active || !kernel) return;
    if (paged) {
      const off = kernel.on("relocate", (info) => { if (!noteChapter(info)) scheduleSample(FLOW_TURN_RESAMPLE); });
      scheduleSample(0);
      return () => {
        off();
        if (sampleTimer.current != null) window.clearTimeout(sampleTimer.current);
      };
    }
    if (typeof kernel.onContentScroll === "function") {
      // 节流（不是防抖）：已经挂着的计时器不清掉
      const onScrollTick = () => {
        const now = performance.now();
        lastScrollAt.current = now;
        const gap = now - lastSampleAt.current;
        if (gap >= 250) {
          lastSampleAt.current = now;
          void sampleNow(false);
        } else if (throttleTimer.current == null) {
          throttleTimer.current = window.setTimeout(() => {
            throttleTimer.current = null;
            lastSampleAt.current = performance.now();
            void sampleNow(false);
          }, 250 - gap);
        }
        if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
        idleTimer.current = window.setTimeout(() => {
          idleTimer.current = null;
          void sampleNow(true);
        }, 160);
      };
      const offScroll = kernel.onContentScroll(onScrollTick);
      const offRelocate = kernel.on("relocate", (info) => { noteChapter(info); scheduleSample(0); });
      scheduleSample(0);
      return () => {
        offScroll();
        offRelocate();
        if (sampleTimer.current != null) window.clearTimeout(sampleTimer.current);
        if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
        if (throttleTimer.current != null) window.clearTimeout(throttleTimer.current);
        if (recheckTimer.current != null) window.clearTimeout(recheckTimer.current);
      };
    }
    // 引擎没有逐帧滚动通知（PDF 等）：沿用 relocate 防抖 + 停下补采
    const off = kernel.on("relocate", (info) => {
      scheduleSample(noteChapter(info) ? 0 : 250);
      if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        idleTimer.current = null;
        void sampleNow(true);
      }, 160);
    });
    scheduleSample(0);
    return () => {
      off();
      if (sampleTimer.current != null) window.clearTimeout(sampleTimer.current);
      if (idleTimer.current != null) window.clearTimeout(idleTimer.current);
      if (recheckTimer.current != null) window.clearTimeout(recheckTimer.current);
    };
  }, [active, kernel, paged, scheduleSample, sampleNow]);

  // 增量
  useEffect(() => {
    if (!active) return;
    return eventBus.on("mindmap/delta", (raw) => {
      const d = raw as MindmapDelta;
      if (!d || !d.mapId) return;
      const g = graphRef.current;
      if (!g || d.mapId !== g.mapId) {
        if (d.documentId != null && String(d.documentId) === String(docRef.current) && d.kind === "skeleton") void loadGraph();
        return;
      }
      setGraph((cur) => (cur && cur.mapId === d.mapId ? applyDelta(cur, d as Parameters<typeof applyDelta>[1]) : cur));
      if (d.nodes && d.nodes.length) {
        anchorCache.current.clear();
        setAnchorEpoch((n) => n + 1);
        scheduleSample(300);
      }
      if (d.jobDone && d.jobId) {
        if (d.jobId === busyRef.current) {
          setBusy(null);
          setBusyNodeId(null);
          if (!d.jobDone.ok && !(d.jobDone as { aborted?: boolean }).aborted) showStatusSoon(T("没能生成：{msg}", { msg: d.jobDone.error || "" }), 0);
          scheduleSample(0);
        }
        if (d.jobId === explainJobRef.current) {
          explainJobRef.current = null;
          setExplainBusyId(null);
        }
      }
    });
  }, [active, loadGraph, scheduleSample, T]);

  // 其它地方（图谱页签）生成了新版本 / 切换了版本 → 重载
  useEffect(() => {
    if (!active) return;
    return eventBus.on("mindmap/changed", (raw) => {
      const p = raw as { documentId?: string; stage?: string };
      if (p && p.documentId != null && String(p.documentId) === String(docRef.current) && p.stage && p.stage !== "running") {
        anchorCache.current.clear();
        setAnchorEpoch((n) => n + 1);
        void loadGraph();
        scheduleSample(200);
      }
    });
  }, [active, loadGraph, scheduleSample]);

  // §14.2：手动优先（同组内永久）——只有换组才复位；readingId 变化不再把手动展开/收起冲掉
  const groupId = attnRef.current.groupId;
  const readingId = attnRef.current.readingId;
  useEffect(() => {
    manualExpRef.current = false;
  }, [groupId]);
  useEffect(() => {
    if (!graph || !groupId) {
      if (expandedId != null) setExpandedId(null);
      return;
    }
    if (manualExpRef.current) return;
    const want = deepRef.current && graph.nodes[deepRef.current] ? deepRef.current : null;
    if (want !== expandedId) setExpandedId(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, groupId, readingId, attnTick, expandedId]);

  const toggleExpand = useCallback(
    (id: string) => {
      manualExpRef.current = true;
      const collapsing = expandedId === id;
      setExpandedId(collapsing ? null : id);
      // §14.2-3：收起即离开——动作行跟着收起，不再留在原地
      if (collapsing) setSel(null);
      else setSel(id);
      setExplainFor(null);
    },
    [expandedId],
  );
  const focusGroup = useCallback((groupId: string, nodeId: string | null) => {
    manualExpRef.current = false;
    attnRef.current = { ...attnRef.current, groupId, readingId: nodeId, candGroup: null, candNode: null };
    // §14.2-1：切组后旧预览一律作废，否则主组与预览会是同一组（同 id 互相吞）
    peekRef.current = null;
    setSel(nodeId);
    setAttnTick((n) => n + 1);
  }, []);

  // ---------- 锚 ----------
  const wantRef = useRef<string[]>([]);
  const applyTargets = useCallback(() => {
    if (!active || !kernel?.setStructureTargets) return;
    const mapId = graphRef.current?.mapId;
    if (!mapId) {
      kernel.setStructureTargets(EMPTY_TARGETS);
      return;
    }
    const targets: ReaderStructureTarget[] = [];
    for (const id of wantRef.current) {
      const list = anchorCache.current.get(`${mapId}|${id}`);
      if (!list) continue;
      list.forEach((a, i) => targets.push({ key: `n:${id}:${i}`, nodeId: id, unitAnchor: a.unitAnchor, head: a.head, tail: a.tail }));
    }
    kernel.setStructureTargets(targets);
  }, [active, kernel]);
  const requestAnchors = useCallback(
    (ids: string[]) => {
      wantRef.current = [...new Set(ids)];
      const mapId = graphRef.current?.mapId;
      if (!mapId) return;
      const missing = wantRef.current.filter((id) => !anchorCache.current.has(`${mapId}|${id}`));
      if (missing.length) {
        mindmapV2Api
          .nodeAnchors(mapId, missing)
          .then((r) => {
            for (const id of missing) anchorCache.current.set(`${mapId}|${id}`, r.anchors?.[id] ?? null);
            setAnchorEpoch((n) => n + 1);
          })
          .catch(() => {
            /* 强调是锦上添花 */
          });
      }
      applyTargets();
    },
    [applyTargets],
  );
  useEffect(() => {
    applyTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorEpoch, graph?.mapId, active]);
  useEffect(() => {
    if (!active) kernel?.setStructureTargets?.(EMPTY_TARGETS);
  }, [active, kernel]);
  useEffect(() => () => kernel?.setStructureTargets?.(EMPTY_TARGETS), [kernel]);

  /** ms<=0：常驻到下一次操作（失败信息不能一闪而过，诊断 P1-e） */
  function showStatusSoon(text: string, ms = 4000) {
    setStatus(text);
    if (statusTimer.current != null) window.clearTimeout(statusTimer.current);
    statusTimer.current = null;
    if (ms <= 0) return;
    statusTimer.current = window.setTimeout(() => {
      statusTimer.current = null;
      setStatus("");
    }, ms);
  }
  const showStatus = useCallback((text: string, ms = 4000) => showStatusSoon(text, ms), []);

  // ---------- 动作（阅读透镜 v2 同口径） ----------
  const jumpTo = async (id: string) => {
    const g = graphRef.current;
    if (!kernel || !g?.mapId) return;
    const here = kernel.getCurrentLocation();
    try {
      // D338：先按段落探针精确定位（单元＝整篇的格式里，只跳单元会落到文档顶部 / 原地不动）
      let ok = false;
      if (kernel.goToText) {
        const a = (await mindmapV2Api.nodeAnchors(g.mapId, [id]).catch(() => null))?.anchors?.[id]?.[0];
        if (a?.head) {
          if (here) setBackLoc((prev) => prev ?? here);
          ok = await kernel.goToText({ unitAnchor: a.unitAnchor, head: a.head, tail: a.tail }).catch(() => false);
        }
      }
      const t = ok ? null : await mindmapV2Api.nodeText(g.mapId, id);
      if (!ok && !t?.unitAnchor) {
        showStatus(T("原文还在读取，稍后再试。"));
        return;
      }
      if (t?.unitAnchor) {
        if (here) setBackLoc((prev) => prev ?? here);
        // 段落定位失败：单元 + 文本搜索兜底（搜索命中优先，不再被「单元跳转成功」短路）
        const probe = (t.text || "").replace(/\s+/g, " ").trim().slice(0, 20);
        const found = probe.length >= 6 ? await kernel.goTo({ search: probe }).catch(() => false) : false;
        if (!found) await kernel.goTo({ href: t.unitAnchor });
      }
      setSel(null);
      setExplainFor(null);
      showStatus(T("已跳到原文。"), 2600);
    } catch {
      /* 跳转是尽力而为 */
    }
  };
  const goBack = async () => {
    if (!kernel || !backLoc) return;
    const target = backLoc;
    setBackLoc(null);
    setSel(null);
    setExplainFor(null);
    try {
      await kernel.goTo(target);
      showStatus(T("已回到刚才读的位置。"), 2600);
    } catch {
      /* 忽略 */
    }
  };
  const SKIP: Record<string, string> = {
    floor: "这一处已经是最细的结构了。",
    cached: "这一处已经展开过了。",
    busy: "正在生成中。",
    no_text: "原文还在读取，稍后再试。",
  };
  /** 「本节」＝包含当前阅读位置、层级最深的目录节点（主进程 locate 的 scopeNodeId，不依赖导图是否已建）。
   *  不能用注意力分组：分组是阅读节点的父节点，新建骨架上会落到整本书 / 整章，生成错地方或被判「已展开」。
   *  ready=false：主进程没有这份原文的会话（或尚未送到该单元）——与「已就绪但不在任何目录节点下」区分开。 */
  const locateScope = async (doc: string, mapId: string): Promise<{ ready: boolean; scope: { id: string; floor: boolean } | null }> => {
    if (!kernel) return { ready: true, scope: null };
    const probes = (kernel.getReadingProbes?.(ATTN.FRACS) ?? []).filter((x) => x.text);
    probes.sort((x, y) => Math.abs(x.frac - 0.38) - Math.abs(y.frac - 0.38));
    const one = probes[0] ?? kernel.getReadingProbe?.() ?? null;
    if (!one) return { ready: true, scope: null };
    const r = await mindmapV2Api.locate({ documentId: doc, unitAnchor: one.unitAnchor, text: one.text, mapId }).catch(() => null);
    if (!r?.ready) return { ready: false, scope: null };
    return { ready: true, scope: r.scopeNodeId ? { id: String(r.scopeNodeId), floor: !!r.scopeFloor } : null };
  };
  const generateHere = async () => {
    if (!kernel || !documentId || genRunRef.current === documentId) return;
    const doc = documentId;
    genRunRef.current = doc;
    const stale = () => docRef.current !== doc;
    if (statusTimer.current != null) window.clearTimeout(statusTimer.current);
    setStatus("");
    setBusy("pending");
    setBusyNodeId(null);
    try {
      // 主进程最多保留 MAX_SESSIONS 份原文会话；本文档的会话被挤出后，前端送原文状态仍是「已送完」，
      // 于是 ensureMap 报「原文尚未送完」、locate 返回未就绪。遇到这两种情况：重送一次原文，再从头试一次。
      let mapId = "";
      let created = false;
      let scope: { id: string; floor: boolean } | null = null;
      for (let attempt = 0; ; attempt++) {
        const st = await ensureFed(kernel as Parameters<typeof ensureFed>[0], doc, title);
        if (stale()) return;
        if (!st.complete) {
          setBusy(null);
          showStatus(T("原文还在读取，稍后再试。"));
          return;
        }
        try {
          ({ mapId, created } = await mindmapV2Api.ensureMap(doc, title));
        } catch (err) {
          if (stale()) return;
          if (attempt > 0) throw err;
          resetFeed(kernel as unknown as FeedKernel, doc);
          continue;
        }
        if (stale()) return;
        if (created || mapId !== graphRef.current?.mapId) await loadGraph();
        if (stale()) return;
        const loc = await locateScope(doc, mapId);
        if (stale()) return;
        // 刚新建导图＝主进程会话一定在（graphEnsureMap 建图前校验过），此时 ready=false 是探针对不上，重送也无济于事
        if (!loc.ready && attempt === 0 && !created) {
          resetFeed(kernel as unknown as FeedKernel, doc);
          continue;
        }
        scope = loc.scope;
        break;
      }
      if (!scope) {
        // 骨架（若刚建）已显示；定位不到所在目录节点（如停在封面 / 目录页）→ 明确告知，不静默
        setBusy(null);
        showStatus(T("没定位到正在读的这一节，翻到正文里再试。"), 5000);
        scheduleSample(0);
        return;
      }
      const r = await mindmapV2Api.expand({ mapId, nodeId: scope.id, trigger: "click" });
      if (stale()) return;
      if (r.skipped) {
        setBusy(null);
        setBusyNodeId(null);
        // 本节原文太短（作用域被判 floor）时主进程按「已展开」跳过——如实说「已是最细」
        const why = r.skipped === "cached" && scope.floor ? "floor" : r.skipped;
        showStatus(T(SKIP[why] || why));
      } else {
        setBusy(r.jobId || null);
        setBusyNodeId(r.jobId ? scope.id : null);
      }
      scheduleSample(0);
    } catch (err) {
      if (stale()) return;
      setBusy(null);
      setBusyNodeId(null);
      showStatus(T("没能生成：{msg}", { msg: err instanceof Error ? err.message : String(err) }), 0);
    } finally {
      if (genRunRef.current === doc) genRunRef.current = null;
    }
  };
  const deepen = async (id: string) => {
    const g = graphRef.current;
    if (!g?.mapId) return;
    try {
      const r = await mindmapV2Api.expand({ mapId: g.mapId, nodeId: id, trigger: "click" });
      if (r.skipped) showStatus(T(SKIP[r.skipped] || r.skipped));
      else {
        setBusy(r.jobId || null);
        setBusyNodeId(r.jobId ? id : null);
        setStatus("");
      }
    } catch (err) {
      showStatus(T("没能生成：{msg}", { msg: err instanceof Error ? err.message : String(err) }), 0);
    }
  };
  const explain = async (id: string) => {
    setExplainFor(id);
    const g = graphRef.current;
    if (!g?.mapId) return;
    const cached = graphRef.current?.explain[id] || graphRef.current?.nodes[id]?.explain || explainLocal[id];
    if (cached) return;
    setExplainBusyId(id);
    try {
      const r = await mindmapV2Api.explain(g.mapId, id);
      if (r.cached) {
        if (r.explain) setExplainLocal((m) => ({ ...m, [id]: r.explain as string }));
        setExplainBusyId(null);
        return;
      }
      if (r.jobId) {
        explainJobRef.current = r.jobId;
        setExplainBusyId(id);
      } else setExplainBusyId(null);
    } catch (err) {
      setExplainBusyId(null);
      showStatus(T("没能生成：{msg}", { msg: err instanceof Error ? err.message : String(err) }), 6000);
    }
  };
  const closeExplain = useCallback(() => setExplainFor(null), []);

  const explainText = explainFor ? graph?.explain[explainFor] || graph?.nodes[explainFor]?.explain || explainLocal[explainFor] || "" : "";
  const explainBusy = !!(explainFor && explainBusyId === explainFor);
  // 生成中提示：自己发起的任务优先；否则任一节点处于 streaming（别处发起 / 多分片 outline 仍在跑）
  let generating: string | null = null;
  if (busy) generating = busy !== "pending" && busyNodeId && graph?.nodes[busyNodeId] ? String(graph.nodes[busyNodeId].title ?? "") : "";
  else if (graph) {
    for (const id in graph.nodes) {
      if (graph.nodes[id]?.state === "streaming") {
        generating = String(graph.nodes[id].title ?? "");
        break;
      }
    }
  }

  return {
    graph,
    feed,
    busy,
    generating,
    hasKey,
    groupId,
    readingId,
    readingBlock: blockRef.current,
    peek: peekRef.current,
    switchInfo,
    sel,
    setSel,
    hoverId,
    setHoverId,
    expandedId,
    toggleExpand,
    focusGroup,
    backLoc,
    explainFor,
    explainText,
    explainBusy,
    status,
    showStatus,
    anchorTick: anchorEpoch,
    requestAnchors,
    jumpTo,
    goBack,
    generateHere,
    deepen,
    explain,
    closeExplain,
  };
}
