"use strict";
// v49.170 / D340 原文术语的惰性抽取队列（docs/design/KG-SG-IMPL-PLAN.md §3.5，仿 mapLinkAuto）：
//   串行单飞、temperature 0.2（在 sourceTerms.js 的 chat 里）、失败退避 10 min、onAiSettingsChanged 清退避重扫。
// 入队信号：kg:unitRead（读过的单元）/ 导图生成·深挖完成（按该文档已读单元）/ full 模式文档会话就绪（全部单元）/ kg:sourceTermsForce（忽略低密度）。
// 前置：模式≠off；AI 可用；会话就绪（引擎 unitBlocks）；coverage.text_hash 与现值相同则跳过。
//   模式 off / 无 AI → 丢弃（不写 coverage）；会话未就绪 → 留在队列，等下一次信号；失败 → 退避，条目留在队列。
// 依赖全部注入（node 可测）：
//   { chatStream, getAIConfig, getPromptTemplate, atlas:{search,candidates}, getDb(), getEngine(), readMode(), broadcast({documentId}), now? }
const crypto = require("crypto");
const ST = require("./sourceTerms");

/** M1：条目特有失败累计到此数 → 写 coverage failed 并丢弃该条目 */
const ITEM_FAIL_MAX = 2;
/** 全局性错误（网络 / 无 Key / 401·403 / 429 / 5xx）→ 整队退避；其余（unparsable / 内容审核 4xx / 校验耗尽）为条目特有 */
function isGlobalError(e) {
  const m = String((e && e.message) || e || "");
  if (/unparsable/i.test(m)) return false;
  if (/\b(401|403|429)\b|\b5\d\d\b|rate.?limit|unauthori[sz]ed|forbidden|api.?key|no key|network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|timeout|timed out|abort|offline|overload/i.test(m)) return true;
  if (/\b4\d\d\b|content.?(filter|policy)|moderation|safety|sensitive|审核/i.test(m)) return false;
  return true; // 无法判断 → 保守按全局处理（退避，不烧额度）
}

const BACKOFF_MS = 10 * 60 * 1000;
/** 低密度阈值：论证 / 证明类叶子覆盖块字数 / 单元总字数 < 此值 → low_density */
const LOW_DENSITY_RATIO = 0.25;
const ARGUMENT_TYPES = new Set([
  "论点", "理由", "证据", "反方观点", "反驳", "让步", "结论",
  "命题", "前提", "定义", "引理", "推导", "分情形",
  "因果", "分类", "对比"
]);
const MODES = ["off", "reading", "full"];

function normMode(v) {
  return MODES.includes(v) ? v : "reading";
}

/** 覆盖第 b 块的最深节点（同深取后者，与 sourceTerms.validateTerms 同口径） */
function deepestAt(nodes, b) {
  let best = null;
  for (const n of nodes || []) {
    if (!n || n.blockStart == null || n.blockEnd == null) continue;
    if (b < n.blockStart || b > n.blockEnd) continue;
    if (!best || (n.depth ?? 0) >= (best.depth ?? 0)) best = n;
  }
  return best;
}

/**
 * 论证 / 证明类叶子覆盖块的字数占比。单元没有导图节点 → null（不判低密度，仅靠预算）。
 * 「叶子覆盖块」＝该块被最深覆盖节点覆盖，且该节点类型 ∈ ARGUMENT_TYPES。
 */
function argumentDensity(blocks, nodes) {
  const real = (nodes || []).filter((n) => n && n.blockStart != null && n.blockEnd != null);
  if (!real.length) return null;
  let total = 0;
  let arg = 0;
  for (const b of blocks || []) {
    const len = [...String(b.text ?? "")].length;
    total += len;
    const n = deepestAt(real, b.no);
    if (n && ARGUMENT_TYPES.has(n.type)) arg += len;
  }
  return total > 0 ? arg / total : null;
}
function isLowDensity(blocks, nodes) {
  const r = argumentDensity(blocks, nodes);
  return r != null && r < LOW_DENSITY_RATIO;
}

const keyOf = (documentId, unitAnchor) => `${documentId}\u0000${unitAnchor}`;

function createSourceTermsAuto(d) {
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  let queue = []; // {documentId, unitAnchor, force}
  let running = null;
  let failUntil = 0;
  const matchCache = new Map();
  const fullDocs = new Set();
  const itemFails = new Map(); // keyOf → 条目特有失败次数（内存）

  const mode = () => {
    try {
      return normMode(d.readMode());
    } catch {
      return "reading";
    }
  };
  const db = () => d.getDb();
  const changed = (documentId) => {
    try {
      if (d.broadcast) d.broadcast({ documentId });
    } catch { /* ignore */ }
  };

  // ───────── 阅读信号落库（kg:unitRead 的处理体；幂等）─────────
  function recordUnitRead({ documentId, unitAnchor, dwellMs }) {
    const doc = String(documentId == null ? "" : documentId).trim();
    const anchor = String(unitAnchor == null ? "" : unitAnchor).trim();
    if (!doc || !anchor) return { ok: false, recorded: false };
    const dwell = Number.isFinite(Number(dwellMs)) ? Math.max(0, Math.round(Number(dwellMs))) : 0;
    const H = db();
    let recorded = false;
    H.withTransaction(() => {
      const ex = H.queryAll("SELECT id FROM unit_reads WHERE document_id = ? AND unit_anchor = ?", [doc, anchor])[0];
      if (ex) return;
      H.run("INSERT OR IGNORE INTO unit_reads (id, document_id, unit_anchor, dwell_ms, created_at) VALUES (?, ?, ?, ?, ?)", [
        crypto.randomUUID(), doc, anchor, dwell, now()
      ]);
      recorded = true;
    });
    return { ok: true, recorded };
  }
  function readUnitsOf(documentId) {
    try {
      return db()
        .queryAll("SELECT unit_anchor AS a FROM unit_reads WHERE document_id = ? ORDER BY created_at", [String(documentId)])
        .map((r) => r.a);
    } catch {
      return [];
    }
  }
  function allReadUnits() {
    try {
      return db().queryAll("SELECT document_id AS d, unit_anchor AS a FROM unit_reads ORDER BY created_at");
    } catch {
      return [];
    }
  }

  // ───────── 处理一个单元 ─────────
  const sttDeps = () => ({
    chatStream: d.chatStream,
    getAIConfig: d.getAIConfig,
    getPromptTemplate: d.getPromptTemplate,
    atlas: d.atlas
  });

  /** 返回 "done" | "drop" | "defer" | "fail" */
  async function processItem(it) {
    if (mode() === "off") return "drop";
    const eng = d.getEngine();
    let ub = null;
    try {
      ub = eng && eng.unitBlocks ? eng.unitBlocks({ documentId: it.documentId, unitAnchor: it.unitAnchor }) : null;
    } catch {
      ub = null;
    }
    if (!ub || !ub.ready) return "defer";
    if (!(await ST.aiAvailable(sttDeps()))) return "drop";
    const blocks = ub.blocks || [];
    if (!blocks.length) return "drop"; // 空单元：没有可抽的原文（不写 coverage）
    const H = db();
    const textHash = ST.textHashOf(blocks, ub.nodes);
    const cov = ST.coverageOf(H, it.documentId, it.unitAnchor);
    if (cov && cov.textHash === textHash && !(it.force && (cov.status === "low_density" || cov.status === "failed"))) return "drop";
    const blockHashes = new Map(blocks.map((b) => [b.no, ST.blockHash(b.text)]));
    if (!it.force && isLowDensity(blocks, ub.nodes)) {
      ST.commitUnit({ db: H, documentId: it.documentId, unitAnchor: it.unitAnchor, rows: [], textHash, blockHashes, status: "low_density", attempts: 0, now: now() });
      changed(it.documentId);
      return "done";
    }
    if (now() < failUntil) return "fail";
    try {
      const known = ST.termsForDocument(H, it.documentId).filter((t) => t.role !== "work").map((t) => t.surface);
      const ex = await ST.extractUnit({
        deps: sttDeps(), title: ub.title, structPath: ub.structPath, unitAnchor: it.unitAnchor, documentId: it.documentId,
        blocks, nodes: ub.nodes, knownSurfaces: known
      });
      if (ex.skipped) return "drop";
      const rows = await ST.matchTerms({ deps: sttDeps(), db: H, documentId: it.documentId, title: ub.title, terms: ex.terms, cache: matchCache });
      ST.commitUnit({ db: H, documentId: it.documentId, unitAnchor: it.unitAnchor, rows, textHash, blockHashes, status: "done", attempts: ex.attempts, now: now() });
      changed(it.documentId);
      itemFails.delete(keyOf(it.documentId, it.unitAnchor));
      return "done";
    } catch (e) {
      if (isGlobalError(e)) {
        failUntil = now() + BACKOFF_MS;
        try {
          console.warn("[sourceTerms] 抽取失败（全局），10 分钟后重试：", e && e.message);
        } catch { /* ignore */ }
        return "fail";
      }
      // 条目特有错误：累计 2 次 → 写 failed 并丢弃；未满则放队尾稍后再试，不阻塞其它单元
      const k = keyOf(it.documentId, it.unitAnchor);
      const n = (itemFails.get(k) || 0) + 1;
      try {
        console.warn(`[sourceTerms] 单元抽取失败（第 ${n} 次）：`, e && e.message);
      } catch { /* ignore */ }
      if (n >= ITEM_FAIL_MAX) {
        itemFails.delete(k);
        try {
          ST.commitUnit({ db: H, documentId: it.documentId, unitAnchor: it.unitAnchor, rows: [], textHash, blockHashes, status: "failed", attempts: n, now: now() });
        } catch { /* ignore */ }
        return "drop";
      }
      itemFails.set(k, n);
      return "retry";
    }
  }

  async function drain() {
    const work = queue;
    queue = [];
    const keep = [];
    const retry = []; // 条目特有失败（未满次数）：排到本轮其余条目之后
    let stopped = false;
    for (let i = 0; i < work.length; i++) {
      const it = work[i];
      if (stopped) {
        keep.push(it);
        continue;
      }
      let r = "drop";
      try {
        r = await processItem(it);
      } catch (e) {
        r = "fail";
        try {
          console.warn("[sourceTerms] 队列条目中断：", e && e.message);
        } catch { /* ignore */ }
      }
      if (r === "defer") keep.push(it);
      else if (r === "retry") retry.push(it);
      else if (r === "fail") {
        keep.push(it);
        stopped = true; // 退避：本轮不再处理，后续条目原样保留
      }
    }
    // 排队期间新入队的条目排在保留项之后；同键去重（force 取并集）
    const merged = [];
    const seen = new Map();
    for (const it of [...keep, ...retry, ...queue]) {
      const k = keyOf(it.documentId, it.unitAnchor);
      if (seen.has(k)) {
        if (it.force) seen.get(k).force = true;
        continue;
      }
      const c = { ...it };
      seen.set(k, c);
      merged.push(c);
    }
    queue = merged;
  }

  let dirty = false; // 单飞期间有新信号：本轮结束后再跑一轮
  function kick() {
    if (running) {
      dirty = true;
    } else if (queue.length) {
      running = drain()
        .catch(() => {})
        .finally(() => {
          running = null;
          if (dirty) {
            dirty = false;
            void kick();
          }
        });
    }
    return running || Promise.resolve();
  }

  function enqueue(items) {
    if (mode() === "off") return Promise.resolve();
    for (const it of items) {
      const k = keyOf(it.documentId, it.unitAnchor);
      const ex = queue.find((q) => keyOf(q.documentId, q.unitAnchor) === k);
      if (ex) {
        if (it.force) ex.force = true;
      } else queue.push({ documentId: String(it.documentId), unitAnchor: String(it.unitAnchor), force: !!it.force });
    }
    return kick();
  }

  return {
    /** kg:unitRead：落 unit_reads（幂等）并把该单元入队 */
    unitRead(p) {
      const r = recordUnitRead(p || {});
      if (r.ok) void enqueue([{ documentId: p.documentId, unitAnchor: p.unitAnchor }]);
      return r;
    },
    /** kg:sourceTermsForce：忽略低密度入队 */
    force(documentId, unitAnchor) {
      const doc = String(documentId == null ? "" : documentId).trim();
      const anchor = String(unitAnchor == null ? "" : unitAnchor).trim();
      if (!doc || !anchor) return { ok: false };
      void enqueue([{ documentId: doc, unitAnchor: anchor, force: true }]);
      return { ok: true };
    },
    /** 导图生成 / 深挖完成：把该文档已读单元入队 */
    notifyDocument(documentId) {
      return enqueue(readUnitsOf(documentId).map((a) => ({ documentId, unitAnchor: a })));
    },
    /** full 模式：文档会话就绪（原文送完）→ 全部单元入队（每文档只入一次，直到设置变更） */
    onDocumentReady(documentId) {
      if (mode() !== "full") return Promise.resolve();
      const doc = String(documentId);
      if (fullDocs.has(doc)) return Promise.resolve();
      let su = null;
      try {
        const eng = d.getEngine();
        su = eng && eng.sessionUnits ? eng.sessionUnits({ documentId: doc }) : null;
      } catch {
        su = null;
      }
      if (!su || !su.ready || !su.complete) return Promise.resolve();
      fullDocs.add(doc);
      return enqueue(su.units.map((a) => ({ documentId: doc, unitAnchor: a })));
    },
    /** AI 设置变更：清退避 / 对照缓存，把全部已读单元重新入队 */
    onAiSettingsChanged() {
      failUntil = 0;
      matchCache.clear();
      fullDocs.clear();
      return enqueue(allReadUnits().map((r) => ({ documentId: r.d, unitAnchor: r.a })));
    },
    /** S8：启动补扫——已读（unit_reads）但没有 coverage 的单元入队（遵守 mode；无 AI / 会话未就绪由 processItem 处理） */
    sweep() {
      if (mode() === "off") return Promise.resolve();
      let list = [];
      try {
        list = db().queryAll(
          `SELECT r.document_id AS d, r.unit_anchor AS a FROM unit_reads r
             LEFT JOIN source_term_coverage c ON c.document_id = r.document_id AND c.unit_anchor = r.unit_anchor
            WHERE c.document_id IS NULL ORDER BY r.created_at`
        );
      } catch {
        list = [];
      }
      return enqueue(list.map((r) => ({ documentId: r.d, unitAnchor: r.a })));
    },
    /** 重试：当前排队的全部条目再跑一遍（会话就绪信号 / 测试用） */
    poke: () => kick(),
    idle: async () => {
      while (running) await running;
    },
    _state: () => ({ queue: queue.map((q) => ({ ...q })), failUntil })
  };
}

module.exports = {
  createSourceTermsAuto,
  BACKOFF_MS,
  LOW_DENSITY_RATIO,
  ARGUMENT_TYPES,
  argumentDensity,
  isLowDensity,
  normMode
};
