// MindmapTab——材料结构全景（D254 v2；docs/design/STRUCTURE-ATLAS-D254.md §8）。
// 数据逻辑保留（读图 / 增量合入 / 缓冲 / run 跟踪 / 挂载送原文 / 预估 / 续跑 / 生成 / 深挖全部 /
// 讲解 / 版本 / 学习状态 / 自动讲解 / mindmap.viewed 埋点）；渲染改为 portal 出工具栏 + 二维结构画布。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import type { ReaderLocation } from "../../lib/reader/kernel";
import type { MaterialMapMeta } from "../../lib/mindmap";
import { mindmapApi } from "../../lib/mindmap";
import {
  buildStructureCardPackageV2,
  findRootId,
  liftDelta,
  liftLoad,
  mindmapV2Api,
  peekLoad,
  tocPreviewNodes,
  type GraphEstimate,
} from "../../lib/mindmapV2";
import type { GraphState, PatternKey, RelCode, V2Meta, V2Node } from "../../lib/mindmap/v2/types";
import { ROOT_ID } from "../../lib/mindmap/v2/types";
import { applyDelta, createGraph, emptyGraph, setManualPattern, setView } from "../../lib/mindmap/v2/graph";
import { createLayoutCache, layoutGraph } from "../../lib/mindmap/v2/layout";
import { REL_STYLE, routeRelations } from "../../lib/mindmap/v2/route";
import { buildCanvasSvg, type SvgLabels } from "../../lib/mindmap/v2/svg";
import { expandAllForExport, inlineSvgVars, pngScale, toMarkdown, toOpml, toOutline, toXmindEntries } from "../../lib/mindmap/v2/exportDoc";
import { HOW_NAMES, PATTERN_NAMES, type PatternHow } from "../../lib/mindmap/v2/pattern";
import AtlasStage, { type AtlasEntry } from "./atlas/AtlasStage";
import AtlasCard, { type NodeTerms } from "./atlas/AtlasCard";
import AtlasToolbar, { type AtlasExportFormat, type AtlasRunInfo } from "./atlas/AtlasToolbar";
import { useThrottled } from "./atlas/useThrottled";
import { ATLAS_T, atlasChain, defaultExpanded, expandFor, normalizeSnapshot, type FlowSnapshot } from "../../lib/flow/atlasLayout";
import { eventBus } from "../../lib/eventbus";
import { settingsStore } from "../../lib/settings";
import { useT } from "../../lib/i18n";
import { ensureFed, flattenToc, resetFeed, subscribeFeed, type TocItem } from "../../lib/mindmapFeed";
import { track } from "../../lib/behavior/track";

export interface MindmapTabProps {
  kernel: import("../../lib/reader/kernel").ReaderKernel;
  documentId: string;
  title: string;
  /** Reader 的 .reader-atlas-layer（画布铺满正文视口） */
  stageHost: HTMLDivElement | null;
  /** Reader 的 .atlas-toolbar-host（工具带换入位置） */
  toolbarHost: HTMLDivElement | null;
  open: boolean;
  entry: AtlasEntry | null;
  onExit: () => void;
  onExited: () => void;
  onJumpToText: (back: ReaderLocation | null) => void;
  onMakeCardsFromNode?: (payload: { nodeId: string; label: string; section: string; focus: string; unitAnchors: string[] }) => void;
  initialMapId?: string | null;
  /** v49.146（T4）：点击挂靠标记 → 打开图谱（有对应知识点就聚焦它，否则打开该全谱节点卡） */
  onOpenGraph?: (focusKpId?: string | null, focusAtlasId?: string | null) => void;
  initialResumeRunId?: string | null;
}

const V2_GENERATOR = "m15v2-engine-1";
const BUFFER_MAX = 600;
const FINAL_STAGES = new Set(["completed", "partial", "cancelled", "failed"]);
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

type RunInfo = AtlasRunInfo;

/** 整轮生成被撤销的原因 → 给用户的一句话（D328；引擎 finalizeGen 的 reason / detail） */
function rollbackReason(T: ReturnType<typeof useT>, reason: string | null, detail: string | null): string {
  switch (reason) {
    case "ai_error":
      return T("原因：每一段的 AI 调用都失败了（{msg}）。请检查 AI 设置里的服务地址、密钥和模型名。", { msg: detail || T("未知错误") });
    case "commit":
      return T("原因：结果写入本地数据库失败，请重试；仍失败请导出应用日志反馈。");
    case "unparsable":
      return detail === "out_of_scope"
        ? T("原因：模型给出的段落编号不在原文范围内，结果全部被丢弃。建议换用更强的模型。")
        : T("原因：模型的回答不符合导图要求的格式，结果全部被丢弃。建议换用更强的模型，或恢复默认的导图提示词。");
    case "reasoning_truncated":
      return T("原因：模型把输出额度都用在了思考上，没来得及写出结构。建议换用非推理模型，或在 AI 设置里调低推理强度。");
    case "truncated":
      return T("原因：模型回答被截断，没有写出完整的结构行。请重试或换用其他模型。");
    case "no_output":
      return T("原因：模型没有返回任何内容。请检查 AI 设置里的模型是否可用。");
    default:
      return "";
  }
}

/** 会话级展开集记忆（不落库；同一次会话内退出再进沿用） */
const memo = new Map<string, { expanded: Set<string>; focus: string }>();

export default function MindmapTab(props: MindmapTabProps) {
  const T = useT();
  const { kernel, documentId, title, stageHost, toolbarHost, onJumpToText, onMakeCardsFromNode, initialMapId, initialResumeRunId } = props;

  // 首帧必须有图：命中的 load 缓存同步落成初始图
  const bootRef = useRef<{ graph: GraphState; mapId: string | null; rootId: string | null; rootNode: V2Node | null; meta: (V2Meta & { isActive?: boolean; schemaVersion?: number }) | null; loading: boolean } | null>(null);
  if (!bootRef.current) {
    const cached = peekLoad(initialMapId ?? { documentId });
    const lifted = cached ? liftLoad(cached) : null;
    bootRef.current = lifted
      ? {
          graph: createGraph(lifted.load, String(lifted.load.meta.mapId)),
          mapId: String(lifted.load.meta.mapId),
          rootId: lifted.rootId,
          rootNode: lifted.rootNode,
          meta: cached!.meta as V2Meta & { isActive?: boolean; schemaVersion?: number },
          loading: false,
        }
      : { graph: emptyGraph(null), mapId: null, rootId: null, rootNode: null, meta: null, loading: true };
  }
  const boot = bootRef.current;

  const [graph, setGraphState] = useState<GraphState>(boot.graph);
  const graphRef = useRef(graph);
  const setGraph = useCallback((next: GraphState | ((g: GraphState) => GraphState)) => {
    const v = typeof next === "function" ? (next as (g: GraphState) => GraphState)(graphRef.current) : next;
    graphRef.current = v;
    setGraphState(v);
  }, []);
  const [meta, setMeta] = useState<(V2Meta & { isActive?: boolean; schemaVersion?: number }) | null>(boot.meta);
  const mapIdRef = useRef<string | null>(boot.mapId);
  const rootRef = useRef<{ id: string | null; node: V2Node | null }>({ id: boot.rootId, node: boot.rootNode });
  const bufferRef = useRef<Map<string, import("../../lib/mindmapV2").MindmapDelta[]>>(new Map());
  const [loading, setLoading] = useState(boot.loading);
  const [preview, setPreview] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [feed, setFeed] = useState<{ done: number; total: number; error?: string }>({ done: 0, total: 0 });
  const feedDone = feed.total > 0 && feed.done >= feed.total;
  const [estimate, setEstimate] = useState<GraphEstimate | null>(null);
  const [force, setForce] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunInfo>>({});
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [notice, setNotice] = useState("");
  const [hasKey, setHasKey] = useState(true);
  const [explainAuto, setExplainAuto] = useState(false);
  const [versions, setVersions] = useState<MaterialMapMeta[]>([]);
  const [learnStatus, setLearnStatus] = useState<{ cardCount: number; kpExists: boolean } | null>(null);
  const [explainBusy, setExplainBusy] = useState<Record<string, string>>({});
  const explainWaiters = useRef<Map<string, (ok: boolean) => void>>(new Map());
  const tocRef = useRef<TocItem[]>([]);
  const feedOffRef = useRef<(() => void) | null>(null);

  // 全景状态
  const [focusId, setFocusId] = useState<string>(ROOT_ID);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([ROOT_ID]));
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(() => new Set());
  const [explainFor, setExplainFor] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(true);
  const dismissCard = useCallback(() => {
    setCardOpen(false);
    setDetailOpen(false);
    setExplainFor(null);
  }, []);
  const [relAll, setRelAll] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [centerSeq, setCenterSeq] = useState(0);
  const [phase, setPhase] = useState<"entering" | "open" | "exiting">("entering");
  const [snap, setSnap] = useState<FlowSnapshot | null>(null);
  const userNavRef = useRef(false);
  const throttledGraph = useThrottled(graph, ATLAS_T.LAYOUT_THROTTLE);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;

  // D248（T9）：全景打开（只记打开，不记内容）
  useEffect(() => {
    track("mindmap.viewed", { entityType: "document", entityId: documentId, origin: "reader_internal" });
  }, [documentId]);

  const mapId = preview ? null : graph.mapId;
  // v49.146（T4）：本图的全谱挂靠（每张图只读一次；节点 id → 挂靠列表）
  const [refsByNode, setRefsByNode] = useState<Record<string, { atlasId: string; label: string | null; source: string }[]>>({});
  const [refsTick, setRefsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const kg = (window as unknown as { kgAPI?: { mapLinkRefsForMap(id: string): Promise<{ nodeId: string; atlasId: string; label: string | null; source: string }[]> } }).kgAPI;
    if (!mapId || !kg) { setRefsByNode({}); return; }
    void kg.mapLinkRefsForMap(mapId).then((rows) => {
      if (!alive) return;
      const m: Record<string, { atlasId: string; label: string | null; source: string }[]> = {};
      for (const r of rows || []) (m[r.nodeId] ||= []).push({ atlasId: r.atlasId, label: r.label, source: r.source });
      setRefsByNode(m);
    }).catch(() => { if (alive) setRefsByNode({}); });
    return () => { alive = false; };
  }, [mapId, refsTick]);
  // D314 修订：挂靠由主进程在后台自动完成；每批写入后推送 mapLink:changed，这里重读本图挂靠
  useEffect(() => {
    const kg = (window as unknown as { kgAPI?: { onMapLinkChanged?(cb: (p: { mapId: string }) => void): () => void } }).kgAPI;
    if (!mapId || !kg?.onMapLinkChanged) return;
    return kg.onMapLinkChanged((p) => { if (p && p.mapId === mapId) setRefsTick((n) => n + 1); });
  }, [mapId]);
  const setLink = useCallback(async (nodeId: string, atlasId: string, on: boolean) => {
    const kg = (window as unknown as { kgAPI?: { mapLinkSetUserRef(m: string, n: string, a: string, on: boolean): Promise<boolean> } }).kgAPI;
    if (!mapId || !kg) return;
    await kg.mapLinkSetUserRef(mapId, nodeId, atlasId, on).catch(() => false);
    setRefsTick((n) => n + 1);
  }, [mapId]);
  // v49.170 / D340：原文术语投影（讲了 / 用到）；sourceTerms:changed 推送后重读
  type TermsReply = { documentId: string; nodes: NodeTerms[] };
  type TermsApi = {
    sourceTermsForMap?(id: string): Promise<TermsReply>;
    onSourceTermsChanged?(cb: (p: { documentId: string }) => void): () => void;
    sourceTermReject?(termId: string): Promise<unknown>;
    sourceTermsForce?(documentId: string, unitAnchor: string): Promise<unknown>;
  };
  const termsApi = () => (window as unknown as { kgAPI?: TermsApi }).kgAPI;
  const [termsByNode, setTermsByNode] = useState<Record<string, NodeTerms>>({});
  const [termsTick, setTermsTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const kg = termsApi();
    if (!mapId || !kg?.sourceTermsForMap) { setTermsByNode({}); return; }
    void kg.sourceTermsForMap(mapId).then((r) => {
      if (!alive) return;
      const m: Record<string, NodeTerms> = {};
      for (const n of r?.nodes || []) m[n.nodeId] = n;
      setTermsByNode(m);
    }).catch(() => { if (alive) setTermsByNode({}); });
    return () => { alive = false; };
  }, [mapId, termsTick]);
  useEffect(() => {
    const kg = termsApi();
    if (!mapId || !kg?.onSourceTermsChanged) return;
    return kg.onSourceTermsChanged((p) => { if (p && p.documentId === documentId) setTermsTick((n) => n + 1); });
  }, [mapId, documentId]);
  const rejectTerm = useCallback(async (termId: string) => {
    await termsApi()?.sourceTermReject?.(termId).catch(() => null);
    setTermsTick((n) => n + 1);
  }, []);
  // 锚环计数（D339 位置不变）：只数「讲了」+ 用户手动挂的；顺带提到的从来不记
  const linkCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(refsByNode)) out[k] = (out[k] || 0) + v.length;
    for (const [k, v] of Object.entries(termsByNode)) out[k] = (out[k] || 0) + v.taught.length;
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }, [refsByNode, termsByNode]);
  const openGraphFor = useCallback((atlasId: string) => {
    const kg = (window as unknown as { kgAPI?: { atlasNode(id: string): Promise<{ kp?: { id: string } | null } | null> } }).kgAPI;
    void (kg ? kg.atlasNode(atlasId).catch(() => null) : Promise.resolve(null)).then((n) => {
      props.onOpenGraph?.(n?.kp?.id ?? null, atlasId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onOpenGraph]);
  const isV1 = !!meta && meta.schemaVersion !== 2;
  const genRun = Object.values(runs).find((r) => r.kind === "generate" && !FINAL_STAGES.has(r.stage)) || null;
  const allRun = Object.values(runs).find((r) => r.kind === "expandAll" && !FINAL_STAGES.has(r.stage)) || null;

  const refreshVersions = useCallback(async () => {
    try {
      setVersions((await mindmapApi.list(documentId)) || []);
    } catch {
      /* 版本区读失败不影响画布 */
    }
  }, [documentId]);

  // ---------- 读图 ----------
  const showPreview = useCallback(() => {
    mapIdRef.current = null;
    rootRef.current = { id: null, node: null };
    setMeta(null);
    setPreview(true);
    const g = createGraph({ meta: { title, mapId: undefined }, nodes: tocPreviewNodes(tocRef.current), edges: [], view: null }, undefined);
    setGraph({ ...g, mapId: null });
  }, [setGraph, title]);

  const flushBuffer = useCallback((id: string) => {
    const list = bufferRef.current.get(id);
    if (!list || !list.length) return;
    bufferRef.current.delete(id);
    for (const d of list) applyIncomingRef.current(d);
  }, []);

  const loadMap = useCallback(
    async (arg: string | { documentId: string }) => {
      const r = await mindmapV2Api.load(arg);
      const lifted = liftLoad(r);
      if (!lifted) {
        showPreview();
        return null;
      }
      const id = String(lifted.load.meta.mapId);
      mapIdRef.current = id;
      rootRef.current = { id: lifted.rootId, node: lifted.rootNode };
      setPreview(false);
      setMeta(r.meta as V2Meta & { isActive?: boolean; schemaVersion?: number });
      // 大图（>200 节点）且用户从未存过视图：默认收起第 2 层以下的 AI 分支（只是初始显示，不写库）
      let g0 = createGraph(lifted.load, id);
      if (!lifted.load.view && lifted.load.nodes.length > 200) g0 = setView(g0, { patterns: {}, collapsed: defaultCollapsed(lifted.load.nodes) });
      setGraph(g0);
      // 入口已指定焦点时不要被读图回来的复位覆盖（D254 §8.3：快照 / 指定节点优先）
      if (entrySeqRef.current < 0) {
        setFocusId(ROOT_ID);
        setExpanded(new Set([ROOT_ID]));
      }
      setShowAll(new Set());
      setDetailOpen(false);
      setExplainFor(null);
      setCardOpen(true);
      flushBuffer(id);
      mindmapV2Api.metrics(id)
        .then((m) => {
          if (m && mapIdRef.current === id) setGraph((g) => (g.mapId === id && !g.metrics ? { ...g, metrics: m } : g));
        })
        .catch(() => {});
      return id;
    },
    [flushBuffer, setGraph, showPreview],
  );

  // ---------- 增量合入 ----------
  const applyIncoming = (d: import("../../lib/mindmapV2").MindmapDelta) => {
    if (!d || !d.mapId) return;
    if (d.mapId !== mapIdRef.current) {
      if (d.documentId && String(d.documentId) !== String(documentId)) return;
      const list = bufferRef.current.get(d.mapId) || [];
      list.push(d);
      if (list.length > BUFFER_MAX) list.shift();
      bufferRef.current.set(d.mapId, list);
      return;
    }
    if (d.kind === "skeleton" && d.nodes && d.nodes.length) {
      const rid = findRootId(d.nodes);
      if (rid) {
        const rn = d.nodes.find((n) => n.id === rid) || null;
        rootRef.current = { id: rid, node: rn };
      }
    }
    if (d.kind === "explain" && d.jobDone && d.jobId) {
      const jid = d.jobId;
      setExplainBusy((prev) => {
        const next = { ...prev };
        for (const [k, v] of Object.entries(next)) if (v === jid) delete next[k];
        return next;
      });
      const w = explainWaiters.current.get(jid);
      if (w) {
        explainWaiters.current.delete(jid);
        w(!!d.jobDone.ok);
      }
    }
    if (d.kind === "run" && d.runDone) {
      if (d.runDone.kept) {
        // D329：重新生成有失败段 → 新版本只保留、不顶替原导图
        const why = rollbackReason(T, d.runDone.reason ?? null, d.runDone.detail ?? null);
        const head = T("这次生成有 {n}/{total} 段没有成功，新版本没有替换原导图，已保留在「版本」里，可再次生成续上。", { n: d.runDone.failedJobs ?? 0, total: d.runDone.totalJobs ?? 0 });
        setNotice(why ? `${head} ${why}` : head);
        void loadMap({ documentId });
      } else if (d.runDone.deleted) {
        // D328：说清为什么撤销
        const why = rollbackReason(T, d.runDone.reason ?? null, d.runDone.detail ?? null);
        setNotice(why ? `${T("这次生成没有产出可用结构，新版本已撤销；原有导图不受影响。")} ${why}` : T("这次生成没有产出可用结构，新版本已撤销；原有导图不受影响。"));
        void loadMap({ documentId });
      }
      void refreshVersions();
    }
    if (d.jobDone && !d.jobDone.ok && !d.jobDone.aborted && d.kind !== "run" && d.jobDone.error) {
      setNotice(T("有一个任务未完成：{msg}", { msg: d.jobDone.error }));
    }
    setGraph((g) => (g.mapId === d.mapId ? applyDelta(g, liftDelta(d, rootRef.current.id) as Parameters<typeof applyDelta>[1]) : g));
  };
  const applyIncomingRef = useRef(applyIncoming);
  applyIncomingRef.current = applyIncoming;

  useEffect(() => eventBus.on("mindmap/delta", (p) => applyIncomingRef.current(p as import("../../lib/mindmapV2").MindmapDelta)), []);

  // 指示器口径（仅整图生成 / 深挖全部两类 run）
  useEffect(
    () =>
      eventBus.on("mindmap/changed", (raw) => {
        const p = raw as { runId?: string; documentId?: string; stage?: string; done?: number; total?: number; label?: string; mapId?: string | null; code?: string };
        if (!p || !p.runId) return;
        if (p.documentId != null && String(p.documentId) !== String(documentId)) return;
        const known = runsRef.current[p.runId];
        const kind: RunInfo["kind"] = known ? known.kind : /^深挖/.test(p.label || "") ? "expandAll" : "generate";
        const info: RunInfo = {
          runId: p.runId,
          kind,
          mapId: p.mapId ?? known?.mapId ?? null,
          stage: p.stage || "running",
          done: typeof p.done === "number" ? p.done : known?.done ?? 0,
          total: typeof p.total === "number" ? p.total : known?.total ?? 0,
          label: p.label || known?.label || "",
        };
        setRuns((prev) => ({ ...prev, [info.runId]: info }));
        // 续跑 / 指示器打开：run 属于别的版本 → 切过去看它生长
        if (info.mapId && kind === "generate" && !FINAL_STAGES.has(info.stage) && info.mapId !== mapIdRef.current && !known) void loadMap(info.mapId);
        if (FINAL_STAGES.has(info.stage)) {
          void refreshVersions();
          if (info.stage === "failed" && kind === "generate" && !(raw as { kept?: boolean; code?: string }).kept && (raw as { code?: string }).code !== "no_commit") setNotice(T("生成未完成（{code}）。已生成的部分保留，可再次生成续上（已完成部分走缓存）。", { code: p.code || "failed" }));
          else if (info.stage === "partial") setNotice(T("部分段落未完成，可再次生成或对单个节点深挖补上。"));
          else if (info.stage === "completed" && kind === "generate") setNotice("");
          if (info.mapId && info.mapId === mapIdRef.current) {
            mindmapV2Api.load(info.mapId).then((r) => r.meta && setMeta(r.meta as V2Meta)).catch(() => {});
          }
        }
      }),
    [documentId, loadMap, refreshVersions, T],
  );

  // ---------- 挂载：读图 → 后台送原文 ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const cfg = await window.aiAPI?.getConfig();
        if (alive) setHasKey(Boolean(cfg?.hasKey) || cfg?.preset === "local");
      } catch {
        if (alive) setHasKey(false);
      }
      settingsStore.get<unknown>("app", "mindmapExplainAuto", false).then((v) => alive && setExplainAuto(v === true));
      tocRef.current = flattenToc(kernel.getTOC());
      await refreshVersions();
      if (!alive) return;
      const got = initialMapId ? await loadMap(initialMapId) : null;
      if (!alive) return;
      if (!got) await loadMap({ documentId });
      if (!alive) return;
      setLoading(false);

      // 原文送入走进程内单例（与阅读透镜共用；已送完的文档再开全景不重送）
      const offFeed = subscribeFeed(kernel, documentId, (st) => {
        if (!alive) return;
        if (st.unsupported) setUnsupported(true);
        setFeed({ done: st.done, total: st.total, error: st.error });
      });
      feedOffRef.current = offFeed;
      let st = await ensureFed(kernel, documentId, title);
      if (!alive) return;
      if (st.unsupported || st.error) return;
      try {
        let est = await mindmapV2Api.estimate(documentId);
        if (!est.textReady) {
          // 主进程会话已被 LRU 挤出（同时开过 3 份以上文档）：重送一遍
          resetFeed(kernel, documentId);
          st = await ensureFed(kernel, documentId, title);
          if (!alive || !st.complete) return;
          est = await mindmapV2Api.estimate(documentId);
        }
        if (alive) setEstimate(est);
      } catch {
        /* 预估失败不阻塞 */
      }
      if (initialResumeRunId) {
        try {
          await mindmapV2Api.resume(initialResumeRunId);
          setRuns((prev) => ({
            ...prev,
            [initialResumeRunId]: prev[initialResumeRunId] || { runId: initialResumeRunId, kind: "generate", mapId: null, stage: "running", done: 0, total: 0, label: "" },
          }));
        } catch (err) {
          setNotice(T("继续生成失败：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
        }
      }
    })();
    return () => {
      alive = false;
      feedOffRef.current?.();
      feedOffRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel, documentId, initialMapId]);

  // ---------- 全景：进入 / 退出 ----------
  useEffect(() => {
    if (props.open) {
      setPhase("entering");
      const t = window.setTimeout(() => setPhase("open"), 1200);
      return () => window.clearTimeout(t);
    }
    setPhase("exiting");
    return undefined;
  }, [props.open]);

  // 退出时写会话级展开集记忆
  useEffect(() => {
    if (props.open) return;
    const id = graphRef.current.mapId;
    if (id) memo.set(id, { expanded: new Set(expandedRef.current), focus: focusIdRef.current });
  }, [props.open]);

  const entrySeqRef = useRef(-1);
  useEffect(() => {
    const entry = props.entry;
    if (!entry || loading) return;
    if (entrySeqRef.current === entry.seq) return;
    const g0 = graphRef.current;
    const rootReal = rootRef.current.id;
    const s = entry.snapshot ? normalizeSnapshot(entry.snapshot, rootReal) : null;
    const toAtlasId = (id: string) => (id === rootReal ? ROOT_ID : id);
    const want = entry.nodeId ? toAtlasId(entry.nodeId) : s?.readingId ?? null;
    if (want && want !== ROOT_ID && !g0.nodes[want]) return; // 等图 / 增量到达
    entrySeqRef.current = entry.seq;
    userNavRef.current = false;
    setSnap(s);
    if (s?.readingId) setReadingId(s.readingId);
    const apply = (id: string) => {
      setFocusId(id);
      setExpanded(defaultExpanded(g0, id));
      setCardOpen(true);
    };
    if (want && (want === ROOT_ID || g0.nodes[want])) apply(want);
    else {
      const m = g0.mapId ? memo.get(g0.mapId) : null;
      if (m && (m.focus === ROOT_ID || g0.nodes[m.focus])) {
        setFocusId(m.focus);
        setExpanded(m.expanded);
      } else apply(ROOT_ID);
    }
    // 无快照：现场定位阅读节点；LOCATE_TIMEOUT 内拿到且用户未导航 → 导航过去
    if (!entry.snapshot) {
      const probe = kernel.getReadingProbe?.();
      if (probe) {
        void Promise.race([mindmapV2Api.locate({ documentId, unitAnchor: probe.unitAnchor, text: probe.text }), sleep(ATLAS_T.LOCATE_TIMEOUT).then(() => null)])
          .then((r) => {
            const id = r && r.nodeId ? toAtlasId(r.nodeId) : null;
            if (!id) return;
            setReadingId(id);
            if (!userNavRef.current && graphRef.current.nodes[id]) navigateRef.current(id);
            userNavRef.current = false;
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entry, loading, Object.keys(graph.nodes).length, documentId]);

  // ---------- 导航 / 折叠 ----------
  const navigate = useCallback((id: string) => {
    userNavRef.current = true;
    setExpanded((prev) => expandFor(graphRef.current, prev, id));
    setFocusId(id);
    setCardOpen(true);
    setDetailOpen(false);
    setExplainFor((cur) => (cur === id ? cur : null));
  }, []);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const toggle = useCallback((id: string) => {
    const was = expandedRef.current.has(id);
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      s.add(ROOT_ID);
      return s;
    });
    // 收起的节点若是焦点的祖先：焦点改为被收起的那个节点
    if (was && id !== focusIdRef.current && atlasChain(graphRef.current, focusIdRef.current).includes(id)) setFocusId(id);
  }, []);

  // 节点卡：点画布空白 / 工具栏 / 阅读界面其他任意位置即失焦关闭（D254 实机修订）
  useEffect(() => {
    if (!props.open || !cardOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".atlas-card, .ag")) return;
      dismissCard();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [props.open, cardOpen, dismissCard]);

  // 选中节点（画布 id → 真实节点）
  const selected: { node: V2Node; isRoot: boolean } | null = useMemo(() => {
    if (focusId === ROOT_ID) return rootRef.current.node ? { node: rootRef.current.node, isRoot: true } : null;
    const n = graph.nodes[focusId];
    return n ? { node: n, isRoot: false } : null;
  }, [focusId, graph]);
  const selectedRealId = selected ? selected.node.id : null;
  const explainText = selected ? graph.explain[selected.node.id] ?? selected.node.explain ?? null : null;

  // 学习状态（只读映射：已有 N 卡 / 知识点已存在）
  useEffect(() => {
    if (!selectedRealId || !mapId) {
      setLearnStatus(null);
      return;
    }
    let alive = true;
    const key = `v2:${mapId}:${selectedRealId}`;
    mindmapApi
      .learningStatus(documentId, [key])
      .then((r: Record<string, { cardCount: number; kpExists: boolean }>) => alive && setLearnStatus(r[key] || { cardCount: 0, kpExists: false }))
      .catch(() => alive && setLearnStatus(null));
    return () => {
      alive = false;
    };
  }, [selectedRealId, mapId, documentId]);

  // 自动讲解
  useEffect(() => {
    if (!explainAuto || !selected || !mapId || preview || explainText || explainBusy[selected.node.id]) return;
    if (selected.node.blockStart == null || selected.node.state === "streaming") return;
    void requestExplain(selected.node.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explainAuto, selectedRealId, mapId]);

  // ---------- 操作 ----------
  const realId = (id: string | null): string | null => (id === ROOT_ID ? rootRef.current.id : id);

  const handleGenerate = async () => {
    setNotice("");
    try {
      const r = await mindmapV2Api.generate({ documentId, title, force: force || undefined });
      setRuns((prev) => ({ ...prev, [r.runId]: prev[r.runId] || { runId: r.runId, kind: "generate", mapId: r.mapId, stage: "running", done: 0, total: 0, label: "" } }));
      if (r.mapId !== mapIdRef.current) {
        mapIdRef.current = r.mapId;
        rootRef.current = { id: null, node: null };
        setPreview(false);
        setMeta({ title, mapId: r.mapId, schemaVersion: 2, isActive: false });
        setGraph({ ...emptyGraph(r.mapId), meta: { title, mapId: r.mapId } });
        setFocusId(ROOT_ID);
        setExpanded(new Set([ROOT_ID]));
        setShowAll(new Set());
        setDetailOpen(false);
        flushBuffer(r.mapId);
      }
    } catch (err) {
      setNotice(T("生成调用失败：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  const SKIP_NOTE: Record<string, string> = {
    floor: "这个节点已触底，没有更深的结构（可在详情里「仍要尝试深挖」）。",
    cached: "这个节点已经展开过了。",
    busy: "这个节点正在深挖中。",
    quota: "今天的悬停预取次数已用完。",
    disabled: "预取未开启。",
    no_text: "原文还在读取，稍后再试。",
  };
  const handleDeepen = async (canvasId: string, forceIt = false) => {
    const id = realId(canvasId);
    if (!id || !mapId) {
      if (preview) setNotice(T("先生成导图，再深挖单个节点。"));
      return;
    }
    // 聚焦时尚无子节点的节点不在展开集里：深挖长出的子结构要立即可见
    setExpanded((prev) => {
      if (prev.has(canvasId)) return prev;
      const s = new Set(prev);
      s.add(canvasId);
      s.add(ROOT_ID);
      return s;
    });
    try {
      const r = await mindmapV2Api.expand({ mapId, nodeId: id, trigger: "click", force: forceIt || undefined });
      if (r.skipped) setNotice(T(SKIP_NOTE[r.skipped] || r.skipped));
      else if (r.waiting) setNotice(T("正在等待这一段原文读取完成，读完会自动开始深挖。"));
      else setNotice("");
    } catch (err) {
      setNotice(T("深挖失败：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  };
  const handleExpandAll = async () => {
    if (!mapId) return;
    try {
      const r = await mindmapV2Api.expandAll(mapId);
      setRuns((prev) => ({ ...prev, [r.runId]: prev[r.runId] || { runId: r.runId, kind: "expandAll", mapId, stage: "running", done: 0, total: r.queued, label: "" } }));
      if (!r.queued) setNotice(T("图上没有可深挖的节点了。"));
    } catch (err) {
      setNotice(T("深挖全部失败：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  };
  const handleCancel = async () => {
    for (const r of Object.values(runsRef.current)) if (!FINAL_STAGES.has(r.stage)) await mindmapV2Api.cancel({ runId: r.runId });
    setNotice(T("已请求停止；已完成的部分会保留。"));
  };

  const requestExplain = useCallback(
    async (nodeId: string): Promise<boolean> => {
      const id = mapIdRef.current;
      if (!id) return false;
      try {
        const r = await mindmapV2Api.explain(id, nodeId);
        if (r.cached) return true;
        if (!r.jobId) return false;
        const jid = r.jobId;
        setExplainBusy((prev) => ({ ...prev, [nodeId]: jid }));
        return await new Promise<boolean>((resolve) => {
          explainWaiters.current.set(jid, resolve);
          window.setTimeout(() => {
            if (explainWaiters.current.get(jid) === resolve) {
              explainWaiters.current.delete(jid);
              resolve(false);
            }
          }, 90_000);
        });
      } catch (err) {
        setNotice(T("讲解失败：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
        return false;
      }
    },
    [T],
  );

  const persistView = (g: GraphState) => {
    if (!preview && g.mapId) void mindmapV2Api.setView(g.mapId, g.view).catch(() => {});
  };
  const setPattern = (gid: string, key: PatternKey | null) => {
    const g = setManualPattern(graphRef.current, gid, key);
    setGraph(g);
    persistView(g);
  };

  // ---------- 跳正文 / 制卡 ----------
  const jumpToText = async (node: V2Node) => {
    const back = kernel.getCurrentLocation();
    // D338：先按段落探针精确定位；失败再走单元 + 文本搜索
    if (kernel.goToText && mapIdRef.current) {
      const a = (await mindmapV2Api.nodeAnchors(mapIdRef.current, [node.id]).catch(() => null))?.anchors?.[node.id]?.[0];
      if (a?.head && (await kernel.goToText({ unitAnchor: a.unitAnchor, head: a.head, tail: a.tail }).catch(() => false))) {
        onJumpToText(back);
        return;
      }
    }
    const text = await mindmapV2Api.nodeText(mapIdRef.current!, node.id).catch(() => null);
    if (text?.unitAnchor) await kernel.goTo({ href: text.unitAnchor });
    const probe = (text?.text || "").replace(/\s+/g, " ").trim().slice(0, 20);
    if (probe.length >= 6) {
      try {
        await kernel.goTo({ search: probe });
      } catch {
        /* best-effort：高亮失败≠导航失败 */
      }
    }
    onJumpToText(back);
  };

  const makeCardsFor = async (node: V2Node) => {
    if (!onMakeCardsFromNode || !mapId) return;
    // 「作者动作」来自 explain：缺则先讲解（约 1 次调用），失败也照常制卡
    if (!(graphRef.current.explain[node.id] || node.explain) && node.blockStart != null) await requestExplain(node.id);
    const text = await mindmapV2Api.nodeText(mapId, node.id).catch(() => null);
    const g = graphRef.current;
    const n = g.nodes[node.id] || node;
    const pkg = buildStructureCardPackageV2(n, g, { mapId, nodeText: text?.text ?? null, unitAnchors: text?.unitAnchor ? [text.unitAnchor] : [] });
    onMakeCardsFromNode({ nodeId: pkg.mindmapNodeId, label: n.title, section: pkg.text, focus: T("结构卡：{title}", { title: n.title }), unitAnchors: pkg.unitAnchors });
  };

  // ---------- 导出（旧版卡片样式的直线整图；D338 起全部展开） ----------
  const frameLabel = useMemo(() => (p: PatternKey, how: PatternHow) => `${T(PATTERN_NAMES[p])} · ${T(HOW_NAMES[how])}`, [T]);
  const labels = useMemo<Partial<SvgLabels>>(
    () => ({
      deepen: T("深挖此节点"),
      floor: T("已触底：没有更深的结构"),
      streaming: T("正在生成"),
      unfold: (n: number) => T("展开 {n} 个子节点", { n }),
      collapse: (n: number) => T("收起 {n} 个子节点", { n }),
      more: (n: number) => T("另有 {n} 项", { n }),
      cross: (n: number) => T("{n} 条跨组关系，悬停或选中查看", { n }),
      stub: T("其余部分，可深挖"),
      summary: (p: string, n: number) => T("{p} · {n} 个子结构", { p, n }),
      patternName: (k: PatternKey) => T(PATTERN_NAMES[k] ?? k),
    }),
    [T],
  );
  const relName = useCallback((c: RelCode) => T(REL_STYLE[c]?.name ?? c), [T]);
  // D338：导出＝整图全部展开的快照；图片（SVG 自包含 / PNG 2×）+ 可编辑大纲（XMind / OPML / Markdown）
  const download = (blob: Blob, ext: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title || T("材料知识导图")}.${ext}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const exportImageSvg = (): string => {
    const ge = expandAllForExport(graphRef.current);
    const rootTitle = meta?.title || title;
    const d = layoutGraph(ge, { cache: createLayoutCache(), locks: {}, lodExpanded: new Set(), frameLabel, rootTitle, noLod: true });
    const routed = routeRelations(ge, d, { relAll: true, geometry: "all", relName });
    const raw = buildCanvasSvg(d, routed, {}, { static: true, graph: ge, rootTitle, labels, idPrefix: "mm2x-" });
    return inlineSvgVars(DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true, svgFilters: true } }));
  };
  const rasterize = (svg: string): Promise<{ blob: Blob | null; scale: number }> =>
    new Promise((resolve) => {
      const m = /^<svg\s[^>]*?\swidth="([\d.]+)"[^>]*?\sheight="([\d.]+)"/.exec(svg);
      const w = m ? Number(m[1]) : 0, h = m ? Number(m[2]) : 0;
      const k = pngScale(w, h);
      if (!k) return resolve({ blob: null, scale: 0 });
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.round(w * k));
          cv.height = Math.max(1, Math.round(h * k));
          const ctx = cv.getContext("2d");
          if (!ctx) throw new Error("no 2d context");
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          cv.toBlob((b) => resolve({ blob: b, scale: k }), "image/png");
        } catch {
          resolve({ blob: null, scale: k });
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ blob: null, scale: k });
      };
      img.src = url;
    });
  const exportAs = async (fmt: AtlasExportFormat) => {
    const g0 = graphRef.current;
    if (!Object.keys(g0.nodes).length) return;
    try {
      if (fmt === "svg") return download(new Blob([exportImageSvg()], { type: "image/svg+xml" }), "svg");
      if (fmt === "png") {
        const r = await rasterize(exportImageSvg());
        if (!r.blob) return setNotice(T("导出图片失败，请改用 SVG 或 XMind。"));
        download(r.blob, "png");
        if (r.scale < 1) setNotice(T("导图很大，PNG 已按比例缩小；要看清细节请导出 SVG 或 XMind。"));
        return;
      }
      const outline = toOutline(g0, meta?.title || title);
      if (fmt === "md") return download(new Blob([toMarkdown(outline)], { type: "text/markdown;charset=utf-8" }), "md");
      if (fmt === "opml") return download(new Blob([toOpml(outline)], { type: "text/x-opml;charset=utf-8" }), "opml");
      if (fmt === "xmind") {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        for (const [name, body] of Object.entries(toXmindEntries(outline))) zip.file(name, body);
        download(await zip.generateAsync({ type: "blob", mimeType: "application/vnd.xmind.workbook" }), "xmind");
      }
    } catch (err) {
      setNotice(T("导出失败：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  // ---------- 状态文案 ----------
  const feedLine = feed.error
    ? T("读取原文出错：{msg}", { msg: feed.error })
    : feed.total && !feedDone
      ? T("正在读取原文 {i}/{n}", { i: feed.done, n: feed.total })
      : "";
  const moreCount = useMemo(() => Object.values(graph.nodes).filter((n) => n.state === "more" || n.state === "stub").length, [graph]);
  const rootTitle = meta?.title || title;
  const cardDelay = props.entry?.snapshot ? ATLAS_T.CARD_DELAY_HANDOFF : ATLAS_T.CARD_DELAY_BUTTON;

  const card = focusId === ROOT_ID || !selected || !cardOpen ? null : (
    <AtlasCard
      key={focusId}
      graph={graph}
      mapId={mapId}
      node={selected.node}
      isRoot={selected.isRoot}
      preview={preview}
      explainText={explainText}
      explainBusy={!!explainBusy[selected.node.id]}
      explainOpen={explainFor === focusId}
      onToggleExplain={() => {
        const opening = explainFor !== focusId;
        setExplainFor(opening ? focusId : null);
        if (opening && selected && !explainText && !explainBusy[selected.node.id] && selected.node.blockStart != null && selected.node.state !== "streaming") {
          void requestExplain(selected.node.id);
        }
      }}
      detailOpen={detailOpen}
      onToggleDetail={() => setDetailOpen((v) => !v)}
      learnStatus={learnStatus}
      canMakeCards={!!onMakeCardsFromNode}
      expanded={expanded.has(focusId)}
      delay={cardDelay}
      onJump={() => void jumpToText(selected.node)}
      onDeepen={(f) => void handleDeepen(focusId, f)}
      onMakeCards={() => void makeCardsFor(selected.node)}
      onToggleFold={() => toggle(focusId)}
      onFocusNode={navigate}
      onSetPattern={setPattern}
      links={refsByNode[selected.node.id]}
      terms={termsByNode[selected.node.id] ?? null}
      documentId={documentId}
      onRejectTerm={mapId ? (id) => void rejectTerm(id) : undefined}
      onForceTerms={(() => {
        const t = termsByNode[selected.node.id];
        const api = termsApi();
        return t?.lowDensity && t.unitAnchor && api?.sourceTermsForce ? () => void api.sourceTermsForce!(documentId, t.unitAnchor!) : undefined;
      })()}
      onSetLink={mapId ? (aid, on) => void setLink(selected.node.id, aid, on) : undefined}
      onOpenGraph={props.onOpenGraph ? openGraphFor : undefined}
    />
  );

  return (
    <>
      {toolbarHost
        ? createPortal(
            <AtlasToolbar
              graph={graph}
              rootTitle={rootTitle}
              preview={preview}
              isV1={isV1}
              focus={focusId}
              onFocus={navigate}
              expanded={expanded}
              onExpandedChange={setExpanded}
              relAll={relAll}
              onRelAll={setRelAll}
              zoom={zoom}
              onZoom={setZoom}
              onCenter={() => setCenterSeq((n) => n + 1)}
              unsupported={unsupported}
              feedLine={feedLine}
              feedDone={feedDone}
              genRun={genRun}
              allRun={allRun}
              notice={notice}
              onClearNotice={() => setNotice("")}
              hasKey={hasKey}
              estimate={estimate}
              force={force}
              onForce={setForce}
              mapId={mapId}
              moreCount={moreCount}
              onGenerate={() => void handleGenerate()}
              onCancel={() => void handleCancel()}
              onExpandAll={() => void handleExpandAll()}
              versions={versions}
              currentMapId={mapId}
              onPickVersion={async (id) => {
                await mindmapApi.setActive(id);
                await loadMap(id);
                await refreshVersions();
              }}
              onDeleteVersion={async (id) => {
                await mindmapApi.remove(id);
                await refreshVersions();
                if (id === mapIdRef.current) await loadMap({ documentId });
              }}
              onExport={(f) => void exportAs(f)}
              canExport={Object.keys(graph.nodes).length > 0}
            />,
            toolbarHost,
          )
        : null}
      {stageHost
        ? createPortal(
            <AtlasStage
              graph={throttledGraph}
              rootTitle={rootTitle}
              preview={preview}
              loading={loading}
              unsupported={unsupported}
              focus={focusId}
              expanded={expanded}
              showAll={showAll}
              onFocus={navigate}
              onToggle={toggle}
              onShowAll={(pid) => setShowAll((s) => new Set(s).add(pid))}
              readingId={readingId}
              phase={phase}
              entry={props.entry}
              snapshot={snap}
              relAll={relAll}
              zoom={zoom}
              onZoom={setZoom}
              centerSeq={centerSeq}
              card={card}
              onJump={(id) => {
                const n = graphRef.current.nodes[id];
                if (n) void jumpToText(n);
              }}
              onExit={props.onExit}
              onExited={props.onExited}
              onGenerate={() => void handleGenerate()}
              onDeepen={(id) => void handleDeepen(id)}
              onCardOpen={() => setCardOpen(true)}
              linkCounts={linkCounts}
            />,
            stageHost,
          )
        : null}
    </>
  );
}

/** 大图初始收起：有 AI 父节点（AI 第 2 层及以下）且自身有子节点的 AI 节点 */
function defaultCollapsed(nodes: readonly V2Node[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasKids = new Set(nodes.map((n) => n.parentId).filter((x): x is string => !!x));
  return nodes
    .filter((n) => n.source === "ai" && hasKids.has(n.id) && n.parentId != null && byId.get(n.parentId)?.source === "ai")
    .map((n) => n.id)
    .sort();
}
