// 材料导图 v2 · 原文送入（graphFeed）的进程内单例（2026-10-18 阅读透镜引入）。
// 图谱页签与阅读透镜都要把正文按文档顺序逐单元送进主进程常驻会话；两处各送一遍会交错乱序（主进程要求严格顺序，
// 乱序抛 out_of_order）。这里按「内核实例 + documentId」只跑一条送入流程，双方订阅同一份进度。
// 主进程会话有 LRU（3 份文档）：被挤出后 graphLocate 返回 ready:false，调用方 reset() 后重新 ensure 即可。
import type { ReaderTocItem, SectionUnitInfo } from "./reader/kernel";
import { mindmapV2Api } from "./mindmapV2";
import { fragmentPlan } from "./reader/fragmentSplit";
import { stripRunningLines } from "./pdfRunning";

export interface TocItem {
  anchor: string;
  label: string;
  children?: TocItem[];
}

/**
 * 原文送入只需要内核的取文能力（v49.24 / D197）：阅读窗口直传真实内核。
 */
export interface FeedKernel {
  getTOC(): ReaderTocItem[];
  getSectionAnchors?(): SectionUnitInfo[];
  getSectionText?(startAnchor: string, endAnchor?: string): Promise<string>;
  getSectionTextParts?(anchor: string, fragments: string[]): Promise<string[]>;
}

function flatAnchors(items: TocItem[], out: string[] = []): string[] {
  for (const t of items) {
    out.push(t.anchor);
    if (t.children) flatAnchors(t.children, out);
  }
  return out;
}

export interface FeedState {
  done: number;
  total: number;
  /** 全部送完 */
  complete: boolean;
  /** 不支持取文（无章节单元）的材料 */
  unsupported: boolean;
  error?: string;
  /** 已送入原文的总字数（诊断 P3-e：送完仍为 0 ＝ 无文字层，如扫描版 PDF） */
  chars?: number;
}

type Listener = (s: FeedState) => void;

interface Entry {
  state: FeedState;
  listeners: Set<Listener>;
  promise: Promise<FeedState> | null;
  toc: TocItem[];
}

const byKernel = new WeakMap<FeedKernel, Map<string, Entry>>();

export function flattenToc(items: { label: string; href: string; subitems?: { label: string; href: string; subitems?: unknown[] }[] }[]): TocItem[] {
  const walk = (list: { label: string; href: string; subitems?: unknown[] }[]): TocItem[] =>
    (list || [])
      .filter((t) => t.href)
      .map((t) => ({
        anchor: t.href,
        label: String(t.label || "").replace(/\s*·第 \d+ 页$/, ""),
        children: t.subitems ? walk(t.subitems as { label: string; href: string; subitems?: unknown[] }[]) : undefined,
      }));
  return walk(items || []);
}

function entryOf(kernel: FeedKernel, documentId: string): Entry {
  let m = byKernel.get(kernel);
  if (!m) byKernel.set(kernel, (m = new Map()));
  let e = m.get(documentId);
  if (!e) {
    e = { state: { done: 0, total: 0, complete: false, unsupported: false }, listeners: new Set(), promise: null, toc: [] };
    m.set(documentId, e);
  }
  return e;
}

function emit(e: Entry, s: FeedState) {
  e.state = s;
  for (const l of [...e.listeners]) {
    try {
      l(s);
    } catch {
      /* 订阅方异常不影响送入 */
    }
  }
}

/** 当前进度（未开始＝0/0） */
export function feedState(kernel: FeedKernel, documentId: string): FeedState {
  return entryOf(kernel, documentId).state;
}

/** 目录（ensureFed 首次运行后可用；页签本地画骨架预览用） */
export function feedToc(kernel: FeedKernel): TocItem[] {
  return flattenToc(kernel.getTOC());
}

export function subscribeFeed(kernel: FeedKernel, documentId: string, fn: Listener): () => void {
  const e = entryOf(kernel, documentId);
  e.listeners.add(fn);
  fn(e.state);
  return () => e.listeners.delete(fn);
}

/** 确保该文档原文已按顺序送入主进程（已在送 / 已送完则复用同一个 Promise） */
export function ensureFed(kernel: FeedKernel, documentId: string, title: string): Promise<FeedState> {
  const e = entryOf(kernel, documentId);
  if (e.promise) return e.promise;
  e.promise = (async () => {
    const anchors = kernel.getSectionAnchors?.() || [];
    if (!anchors.length || !kernel.getSectionText) {
      const s = { done: 0, total: 0, complete: false, unsupported: true };
      emit(e, s);
      return s;
    }
    e.toc = flattenToc(kernel.getTOC());
    // 诊断 P3-f：同一文件有多个目录项（#fragment）→ 该文件细分成 [A, A#f1, A#f2…] 多个单元，每章拿到自己的原文
    const plan = kernel.getSectionTextParts ? fragmentPlan(flatAnchors(e.toc)) : new Map<string, string[]>();
    const units: { anchor: string; file: string; part: number; frags: string[] | null }[] = [];
    for (const a of anchors) {
      const base = a.anchor.split("#")[0];
      const frags = plan.get(base) ?? null;
      units.push({ anchor: a.anchor, file: a.anchor, part: 0, frags });
      if (frags) frags.forEach((f, k) => units.push({ anchor: `${base}#${f}`, file: a.anchor, part: k + 1, frags }));
    }
    const unitAnchors = units.map((u) => u.anchor);
    const total = units.length;
    emit(e, { done: 0, total, complete: false, unsupported: false });
    let partsOf: { file: string; parts: string[] } | null = null;
    let chars = 0;
    // PDF 逐页单元：缓存原始页文本（按单元下标），供剔除页眉/页脚时比对相邻页。
    const rawPdfPages = new Map<number, string>();
    const rawPdfPage = async (k: number): Promise<string> => {
      const hit = rawPdfPages.get(k);
      if (hit !== undefined) return hit;
      let t = "";
      try {
        t = (await kernel.getSectionText?.(units[k].anchor)) ?? "";
      } catch {
        t = "";
      }
      rawPdfPages.set(k, t);
      return t;
    };
    for (let i = 0; i < total; i++) {
      const u = units[i];
      let text = "";
      try {
        if (u.anchor.startsWith("pdfpage:")) {
          const arr: (string | undefined)[] = new Array(total);
          for (let k = Math.max(0, i - 2); k <= Math.min(total - 1, i + 2); k++) arr[k] = await rawPdfPage(k);
          text = stripRunningLines(arr, i);
          rawPdfPages.delete(i - 2); // 之后只会再看 i-1 起的页
        } else if (u.frags && kernel.getSectionTextParts) {
          if (!partsOf || partsOf.file !== u.file) partsOf = { file: u.file, parts: await kernel.getSectionTextParts(u.file, u.frags) };
          text = partsOf.parts[u.part] ?? "";
        } else text = await kernel.getSectionText(u.anchor);
      } catch {
        text = "";
      }
      try {
        await mindmapV2Api.feed({ documentId, title, tocItems: e.toc, unitAnchors, index: i, text, last: i === total - 1 });
      } catch (err) {
        const s = { done: i, total, complete: false, unsupported: false, error: err instanceof Error ? err.message : String(err) };
        emit(e, s);
        e.promise = null; // 允许重试
        return s;
      }
      chars += text.trim().length;
      emit(e, { done: i + 1, total, complete: i === total - 1, unsupported: false, chars });
    }
    return e.state;
  })();
  return e.promise;
}

/** 主进程会话被 LRU 挤出后：清掉本地「已送完」记录，下次 ensureFed 从第 0 个单元重送 */
export function resetFeed(kernel: FeedKernel, documentId: string): void {
  const e = entryOf(kernel, documentId);
  if (e.promise && !e.state.complete && !e.state.error) return; // 正在送：不打断
  e.promise = null;
  emit(e, { done: 0, total: 0, complete: false, unsupported: false });
}
