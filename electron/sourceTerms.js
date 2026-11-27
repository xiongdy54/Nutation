"use strict";
// v49.170 / D340 以原文为锚的知识层（docs/design/KG-SG-IMPL-PLAN.md §3.1–§3.4）：
//   抽取者（提示词 / 解析 / 本地校验 / 预算 / 最多 2 次重交）、对照者（kg-term-match + senseVerdict 本地裁决）、
//   落账者（确定性单事务写 source_terms / source_term_coverage）、作品级挂靠。
// 纯函数 + 依赖注入：不在模块顶层 require ai.js / atlas.js / db.js；db 句柄（db._sourceTermsDb()）由调用方传入。
//   deps = { chatStream, getAIConfig, getPromptTemplate, atlas:{search, candidates}, now? }
const crypto = require("crypto");
const K = require("./kgSenseCore");

const EXTRACTOR_VERSION = 1;
const MAX_REASKS = 2;
const TOTAL_CAP = 12;
const ROLES = ["defines", "explains", "argues", "uses", "instance"];
const TEACH_ROLES = ["defines", "explains", "argues"];
/** 角色强度（截断时先保留强的） */
const ROLE_STRENGTH = { defines: 0, argues: 1, explains: 2, instance: 3, uses: 4 };
/** 覆盖该块的最深节点是这些类型时，只允许 defines */
const NARRATIVE_TYPES = ["叙事", "案例", "背景", "引言"];
const KNOWN_MAX = 80;
const MATCH_TEMPERATURE = 0.2;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
/** 规范化空白：NFKC 后去掉全部空白（块内换行 / 全角空格都不影响子串判断） */
const wsNorm = (s) => String(s ?? "").normalize("NFKC").replace(/[\s　]+/g, "");
const lowerNorm = (s) => wsNorm(s).toLowerCase();

/** 块文本哈希：空白折叠后的 sha256 前 16 hex */
function blockHash(text) {
  return sha256(String(text ?? "").replace(/\s+/g, " ").trim()).slice(0, 16);
}
/** 带号原文（与 mindmapBlocks.renderNumbered 同形：块内换行压成空格） */
function numberedText(blocks) {
  return (blocks || []).map((b) => `[${b.no}] ${String(b.text ?? "").replace(/\s*\n\s*/g, " ")}`).join("\n");
}
/** 导图节点结构摘要（S1）：无节点 → "nomap"；有节点 → 类型 + 块区间的排序串（导图出现 / 结构变化 → coverage 过期） */
function nodeDigestOf(nodes) {
  const real = (nodes || []).filter((n) => n && n.blockStart != null && n.blockEnd != null);
  if (!real.length) return "nomap";
  return "map:" + real.map((n) => `${n.type || ""}@${n.blockStart}-${n.blockEnd}`).sort().join("|");
}
/** coverage.text_hash ＝ sha256(带号原文 + "\u0000" + EXTRACTOR_VERSION + "\u0000" + 节点结构摘要) */
function textHashOf(blocks, nodes) {
  return sha256(numberedText(blocks) + "\u0000" + EXTRACTOR_VERSION + "\u0000" + nodeDigestOf(nodes));
}
function charCountOf(blocks) {
  return (blocks || []).reduce((n, b) => n + [...String(b.text ?? "")].length, 0);
}
/** 讲类 / uses 各自的条数上限：max(1, ceil(字数/1000×2)) */
// 主控实测（2026-11-24）：下限 1 会饿死短而密的单元（3 块哲学导论只能留 1 条讲类），下限取 3。
function budgetCap(charCount) {
  return Math.max(3, Math.ceil((Number(charCount) || 0) / 1000 * 2));
}

// ───────────────────────── 抽取者：提示词 / 解析 ─────────────────────────

function buildExtractorUser({ title, structPath, nodes, knownSurfaces, blocks }) {
  const nodeLines = (nodes || [])
    .filter((n) => n && n.blockStart != null && n.blockEnd != null)
    .map((n) => `[${n.type || "其他"}] @${n.blockStart}-${n.blockEnd}`);
  const known = [...new Set((knownSurfaces || []).map((x) => String(x || "").trim()).filter(Boolean))].slice(0, KNOWN_MAX);
  return [
    `【材料】${String(title || "").trim()}`,
    `【单元】${String(structPath || "").trim()}`,
    `【结构提示】${nodeLines.length ? "\n" + nodeLines.join("\n") : "（无）"}`,
    `【已有术语】${known.length ? known.join("，") : "（无）"}`,
    "【原文】",
    numberedText(blocks),
    "【/原文】"
  ].join("\n");
}

/** 取回复里最后一个以 startRe 起头的配平顶层 JSON 对象；找不到或解析失败返回 null */
function parseLastJson(raw, startRe) {
  const s = String(raw || "");
  const re = new RegExp(startRe.source, "g");
  let at = -1;
  let m;
  while ((m = re.exec(s))) at = m.index;
  if (at < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(at, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
/** 返回 {terms:[…]} 或 null（无法解析 / 没有 terms 数组） */
function parseTermsReply(text) {
  const o = parseLastJson(text, /\{\s*"terms"/);
  return o && Array.isArray(o.terms) ? o : null;
}

// ───────────────────────── 抽取者：校验 / 预算 ─────────────────────────

function deepestNodeAt(nodes, b) {
  let best = null;
  for (const n of nodes || []) {
    if (!n || n.blockStart == null || n.blockEnd == null) continue;
    if (b < n.blockStart || b > n.blockEnd) continue;
    if (!best || (n.depth ?? 0) >= (best.depth ?? 0)) best = n;
  }
  return best;
}

/**
 * 逐条校验（IMPL-PLAN §3.1）。ctx = { blocks: Map<no,{text}>, nodes:[{type,blockStart,blockEnd,depth}] }
 * 返回与 items 等长的数组：{ok:true, term:{b,q,s,r,surfaceNorm}} | {ok:false, reason}
 */
function validateTerms(items, ctx) {
  const blocks = ctx && ctx.blocks instanceof Map ? ctx.blocks : new Map();
  const nodes = (ctx && ctx.nodes) || [];
  const normCache = new Map();
  const blockNorm = (no) => {
    if (!normCache.has(no)) normCache.set(no, wsNorm(blocks.get(no)?.text));
    return normCache.get(no);
  };
  return (items || []).map((it) => {
    if (!it || typeof it !== "object") return { ok: false, reason: "不是对象，需要 {b,q,s,r}" };
    const b = Number(it.b);
    const q = String(it.q ?? "").trim();
    const s = String(it.s ?? "").trim();
    const r = String(it.r ?? "").trim();
    if (!Number.isInteger(b) || !blocks.has(b)) return { ok: false, reason: `块号 ${it.b} 不在本单元的块内` };
    const qn = wsNorm(q);
    if ([...qn].length < 4) return { ok: false, reason: "引句太短（至少 4 字）" };
    if ([...qn].length > 120) return { ok: false, reason: "引句太长（最多 120 字）" };
    if (!blockNorm(b).includes(qn)) return { ok: false, reason: `引句不是第 ${b} 块原文的逐字子串` };
    const sn = wsNorm(s);
    if ([...sn].length < 1 || [...sn].length > 40) return { ok: false, reason: "术语写法长度须在 1–40 字" };
    if (!lowerNorm(q).includes(lowerNorm(s))) return { ok: false, reason: "引句里没有出现术语写法" };
    if (!ROLES.includes(r)) return { ok: false, reason: `角色 ${it.r} 不在 ${ROLES.join("|")} 内` };
    const deepest = deepestNodeAt(nodes, b);
    if (deepest && NARRATIVE_TYPES.includes(deepest.type) && r !== "defines") {
      return { ok: false, reason: `第 ${b} 块属于「${deepest.type}」段落，只允许 defines` };
    }
    return { ok: true, term: { b, q, s, r, surfaceNorm: K.normName(s) } };
  });
}

/** 预算截断：讲类 ≤cap、uses ≤cap、总数 ≤12；超出按角色强度、再按出现顺序保留；返回仍按出现顺序 */
function applyBudget(items, charCount) {
  const cap = budgetCap(charCount);
  const list = (items || []).map((t, i) => ({ t, i }));
  const order = [...list].sort((a, b) => (ROLE_STRENGTH[a.t.r] ?? 9) - (ROLE_STRENGTH[b.t.r] ?? 9) || a.i - b.i);
  let teach = 0;
  let uses = 0;
  let total = 0;
  const keep = new Set();
  for (const { t, i } of order) {
    if (total >= TOTAL_CAP) break;
    if (TEACH_ROLES.includes(t.r)) {
      if (teach >= cap) continue;
      teach++;
    } else if (t.r === "uses") {
      if (uses >= cap) continue;
      uses++;
    }
    keep.add(i);
    total++;
  }
  return list.filter((x) => keep.has(x.i)).map((x) => x.t);
}

// ───────────────────────── AI 通道 ─────────────────────────

async function chat(deps, messages) {
  return await new Promise((resolve, reject) => {
    let acc = "";
    let settled = false;
    Promise.resolve(
      deps.chatStream({ messages, temperature: MATCH_TEMPERATURE }, (m) => {
        if (settled) return;
        if (m && m.error) {
          settled = true;
          reject(new Error(String(m.error)));
        } else if (m && m.done) {
          settled = true;
          resolve(acc);
        } else if (m && m.delta) acc += m.delta;
      })
    ).catch((e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

/** AI 可用 ＝ cfg.hasKey || cfg.preset === "local" */
async function aiAvailable(deps) {
  let cfg = null;
  try {
    cfg = await deps.getAIConfig();
  } catch {
    cfg = null;
  }
  return !!(cfg && (cfg.hasKey || cfg.preset === "local"));
}

function templateOf(deps, scope) {
  const t = deps.getPromptTemplate(scope);
  const c = t && t.content ? String(t.content) : "";
  if (!c) throw new Error(`prompt template missing: ${scope}`);
  return c;
}

/**
 * 抽取一个单元：调 AI → 解析 → 本地校验 → 不合格的整理成「第 i 条：原因」作为 user 消息重交（最多再问 2 次）→ 预算截断。
 * 无 AI 返回 {skipped:"no-ai"}（不抽取，调用方不得写 coverage）；AI 报错抛出；三次都无法解析抛 Error("unparsable")。
 * 返回 { terms:[{b,q,s,r,surfaceNorm}], attempts, rejected:[{item,reason}] }
 */
async function extractUnit({ deps, title, structPath, unitAnchor, documentId, blocks, nodes, knownSurfaces }) {
  void unitAnchor;
  void documentId;
  if (!(await aiAvailable(deps))) return { terms: [], attempts: 0, rejected: [], skipped: "no-ai" };
  const chars = charCountOf(blocks);
  const system = templateOf(deps, "kg-source-terms").split("{BUDGET}").join(String(budgetCap(chars)));
  const user = buildExtractorUser({ title, structPath, nodes, knownSurfaces, blocks });
  const ctx = { blocks: new Map((blocks || []).map((b) => [b.no, b])), nodes: nodes || [] };
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  const accepted = new Map(); // (b|surfaceNorm|r) → term，跨轮并集去重
  let rejected = [];
  let attempts = 0;
  let parsedEver = false;
  for (let round = 0; round <= MAX_REASKS; round++) {
    attempts++;
    const reply = await chat(deps, messages);
    const parsed = parseTermsReply(reply);
    let feedback = [];
    if (!parsed) {
      rejected = [];
      feedback = ["第 1 条：回复里没有可解析的 JSON，请最后一行严格输出 {\"terms\":[…]}"];
    } else {
      parsedEver = true;
      const verdicts = validateTerms(parsed.terms, ctx);
      rejected = [];
      verdicts.forEach((v, i) => {
        if (v.ok) accepted.set(`${v.term.b}|${v.term.surfaceNorm}|${v.term.r}`, v.term);
        else {
          rejected.push({ item: parsed.terms[i], reason: v.reason });
          feedback.push(`第 ${i + 1} 条：${v.reason}`);
        }
      });
    }
    if (!feedback.length || round === MAX_REASKS) break;
    messages.push({ role: "assistant", content: reply });
    messages.push({ role: "user", content: `以下条目本地校验不合格，请改正或删去后重新给出完整的 JSON：\n${feedback.join("\n")}` });
  }
  if (!parsedEver) throw new Error("unparsable");
  return { terms: applyBudget([...accepted.values()], chars), attempts, rejected };
}

// ───────────────────────── 对照者 ─────────────────────────

function atlasInt(v) {
  if (v == null || v === "") return null;
  const s = String(v);
  const n = Number(s[0] === "Q" || s[0] === "q" ? s.slice(1) : s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const cacheKey = (documentId, surfaceNorm) => `${documentId}|${surfaceNorm}`;

function buildMatchUser({ title, surface, quote, candidates }) {
  return [
    `【材料】${String(title || "").trim()}`,
    `【术语】${surface}`,
    `【引句】${quote}`,
    "【全谱候选知识点】",
    ...candidates.map((c) => K.formatCandidateLine(c))
  ].join("\n");
}

async function gatherCandidates(atlas, surface, quote) {
  const out = [];
  const seen = new Set();
  const add = (list) => {
    for (const c of list || []) {
      const n = atlasInt(c && c.id);
      if (n == null || seen.has(n)) continue;
      seen.add(n);
      out.push(c);
    }
  };
  try {
    add(await atlas.search(surface, { limit: 5 }));
  } catch { /* 全谱不可用＝没有候选 */ }
  try {
    add(await atlas.candidates(quote, { limit: 8 }));
  } catch { /* 同上 */ }
  return out.slice(0, 8);
}

function existingMatch(db, documentId, surfaceNorm) {
  if (!db) return null;
  const rows = db.queryAll(
    `SELECT atlas_id, atlas_rel, link_state FROM source_terms
      WHERE document_id = ? AND surface_norm = ? AND role != 'work' AND is_deleted = 0 AND link_state != 'rejected'
      ORDER BY CASE link_state WHEN 'user' THEN 0 WHEN 'linked' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1`,
    [documentId, surfaceNorm]
  );
  const r = rows[0];
  if (!r) return null;
  if (r.link_state === "unlinked" && r.atlas_id == null) return null; // 没有任何对照结果：不当缓存
  return { atlasId: r.atlas_id, atlasRel: r.atlas_rel, linkState: r.link_state === "user" ? "linked" : r.link_state };
}

/**
 * 术语对照全谱。cache 是 Map（调用方可跨调用持有）；先读缓存，再读库里同文档已有行，最后才找候选 / 调 AI。
 * 返回行：{blockNo, quote, surface, surfaceNorm, role, atlasId(int|null), atlasRel, linkState, confidence}
 */
async function matchTerms({ deps, db, documentId, title, terms, cache }) {
  const memo = cache instanceof Map ? cache : new Map();
  const rows = [];
  let aiOk = null;
  let system = null;
  for (const t of terms || []) {
    const surfaceNorm = t.surfaceNorm || K.normName(t.s);
    const key = cacheKey(documentId, surfaceNorm);
    let res = memo.get(key) || null;
    if (!res) {
      res = existingMatch(db, documentId, surfaceNorm);
      if (res) memo.set(key, res);
    }
    if (!res) {
      const cands = await gatherCandidates(deps.atlas, t.s, t.q);
      if (!cands.length) {
        res = { atlasId: null, atlasRel: null, linkState: "unlinked" };
        memo.set(key, res);
      } else {
        if (aiOk == null) aiOk = await aiAvailable(deps);
        if (!aiOk) {
          res = { atlasId: null, atlasRel: null, linkState: "unlinked" }; // 无 AI：不缓存，AI 恢复后可重判
        } else {
          if (system == null) system = templateOf(deps, "kg-term-match");
          const reply = await chat(deps, [
            { role: "system", content: system },
            { role: "user", content: buildMatchUser({ title, surface: t.s, quote: t.q, candidates: cands }) }
          ]);
          res = judgeMatch(parseLastJson(reply, /\{\s*"(?:atlasId|rel)"/), cands, t);
          memo.set(key, res);
        }
      }
    }
    rows.push({
      blockNo: t.b,
      quote: t.q,
      surface: t.s,
      surfaceNorm,
      role: t.r,
      atlasId: res.atlasId,
      atlasRel: res.atlasRel,
      linkState: res.linkState,
      confidence: null
    });
  }
  return rows;
}

/** 解析 AI 回复 + 越界作废 + 本地裁决（kgSenseCore.senseVerdict） */
function judgeMatch(obj, cands, term) {
  const none = { atlasId: null, atlasRel: null, linkState: "unlinked" };
  if (!obj) return none;
  const picked = atlasInt(obj.atlasId);
  const cand = picked == null ? null : cands.find((c) => atlasInt(c.id) === picked);
  if (!cand) return none; // null / 越界编号：作废
  const rel = K.normRel(obj.rel);
  if (rel == null) return { atlasId: picked, atlasRel: null, linkState: "unlinked" };
  const { termIsLabel, termMatchType } = K.termMatchOf(term.s, cand);
  const v = K.senseVerdict({ rel, unsure: obj.unsure === true, quoteOk: true, hasCandidate: true, termIsLabel, termMatchType });
  if (v.mode === "auto") return { atlasId: picked, atlasRel: v.rel, linkState: "linked" };
  return { atlasId: picked, atlasRel: v.aiRel ?? v.rel, linkState: "unlinked" }; // 待确认：保留建议
}

// ───────────────────────── 落账者 ─────────────────────────

/**
 * 单事务落账（IMPL-PLAN §3.4）。status: done | low_density 才写；failed 什么都不写（整单元成功才落账）。
 * blockHashes：Map 或对象，块号 → 当前块哈希。返回 {written, inserted, updated, staleDeleted, termCount}
 */
function commitUnit({ db, documentId, unitAnchor, rows, textHash, blockHashes, status, attempts, now }) {
  if (status !== "done" && status !== "low_density" && status !== "failed") return { written: false, inserted: 0, updated: 0, staleDeleted: 0, termCount: 0 };
  const ts = Number.isFinite(now) ? now : Date.now();
  if (status === "failed") {
    // M1：条目特有的失败（2 次）只记 coverage（保留已有术语行不动），之后由 force / 原文变化重试
    db.run(
      `INSERT OR REPLACE INTO source_term_coverage
         (document_id, unit_anchor, text_hash, extractor_version, status, term_count, attempts, done_at)
       VALUES (?, ?, ?, ?, 'failed', 0, ?, ?)`,
      [documentId, unitAnchor, textHash, EXTRACTOR_VERSION, Number(attempts) || 0, ts]
    );
    return { written: true, inserted: 0, updated: 0, staleDeleted: 0, termCount: 0 };
  }
  const hashOf = (no) => (blockHashes instanceof Map ? blockHashes.get(no) : blockHashes && blockHashes[no]) || "";
  const out = { written: true, inserted: 0, updated: 0, staleDeleted: 0, termCount: 0 };
  db.withTransaction(() => {
    for (const r of rows || []) {
      const hash = hashOf(r.blockNo);
      const ex = db.queryAll(
        "SELECT id, is_deleted, block_hash, link_state FROM source_terms WHERE document_id = ? AND block_no = ? AND surface_norm = ? AND role = ?",
        [documentId, r.blockNo, r.surfaceNorm, r.role]
      )[0];
      if (!ex) {
        db.run(
          `INSERT OR IGNORE INTO source_terms
             (id, user_id, document_id, unit_anchor, block_no, block_hash, quote, surface, surface_norm, role,
              atlas_id, atlas_rel, link_state, confidence, extractor_version, created_at, updated_at, sync_version, is_deleted)
           VALUES (?, 'local-user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
          [
            crypto.randomUUID(), documentId, unitAnchor, r.blockNo, hash, r.quote, r.surface, r.surfaceNorm, r.role,
            r.atlasId ?? null, r.atlasRel ?? null, r.linkState || "unlinked", r.confidence ?? null, EXTRACTOR_VERSION, ts, ts
          ]
        );
        out.inserted++;
      } else if (ex.is_deleted === 0 && ex.block_hash !== hash) {
        // 同一事实、原文已变：原地重新锚定（保留对照与用户状态），不当作过期
        db.run(
          "UPDATE source_terms SET block_hash = ?, quote = ?, unit_anchor = ?, extractor_version = ?, updated_at = ?, sync_version = sync_version + 1 WHERE id = ?",
          [hash, r.quote, unitAnchor, EXTRACTOR_VERSION, ts, ex.id]
        );
        out.updated++;
      } else if (ex.is_deleted === 1 && ex.link_state === "stale") {
        // S5：仅「原文变化而软删」的行复活；用户拒绝（保留原 link_state）不复活
        db.run(
          `UPDATE source_terms SET is_deleted = 0, block_hash = ?, quote = ?, unit_anchor = ?, surface = ?, atlas_id = ?, atlas_rel = ?,
                  link_state = ?, confidence = ?, extractor_version = ?, updated_at = ?, sync_version = sync_version + 1 WHERE id = ?`,
          [hash, r.quote, unitAnchor, r.surface, r.atlasId ?? null, r.atlasRel ?? null, r.linkState || "unlinked", r.confidence ?? null, EXTRACTOR_VERSION, ts, ex.id]
        );
        out.updated++;
      } // 其它已删行（含用户拒绝）不复活；同哈希活行不动
    }
    const live = db.queryAll(
      "SELECT id, block_no, block_hash FROM source_terms WHERE document_id = ? AND unit_anchor = ? AND role != 'work' AND is_deleted = 0",
      [documentId, unitAnchor]
    );
    let kept = 0;
    for (const l of live) {
      if (l.block_hash !== hashOf(l.block_no)) {
        db.run("UPDATE source_terms SET is_deleted = 1, link_state = 'stale', updated_at = ?, sync_version = sync_version + 1 WHERE id = ?", [ts, l.id]);
        out.staleDeleted++;
      } else kept++;
    }
    out.termCount = kept;
    db.run(
      `INSERT OR REPLACE INTO source_term_coverage
         (document_id, unit_anchor, text_hash, extractor_version, status, term_count, attempts, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [documentId, unitAnchor, textHash, EXTRACTOR_VERSION, status, kept, Number(attempts) || 0, ts]
    );
  });
  return out;
}

// ───────────────────────── 作品级挂靠 ─────────────────────────

/** 作品 / 作者候选：只取名称 exact 命中，各至多 3 个；无 AI 也可用 */
async function proposeWorkAnchors({ atlas, title, author }) {
  const pick = async (q, kind) => {
    const name = String(q || "").trim();
    if (!name) return [];
    let list = [];
    try {
      list = (await atlas.search(name, { kinds: [kind], limit: 20 })) || [];
    } catch {
      list = [];
    }
    return list
      .filter((n) => n && n.exact && atlasInt(n.id) != null)
      .slice(0, 3)
      .map((n) => ({ atlasId: atlasInt(n.id), id: n.id, label: n.zh || n.en || n.ja || String(n.id), gloss: n.gloss || n.glossEn || "", kind }));
  };
  return { works: await pick(title, "work"), persons: await pick(author, "person") };
}

/** 确认作品 / 作者挂靠（用户明确动作，可覆盖同键旧行）：atlasId 为 null ＝ 确认「没有对应条目」（记 rejected，不再提示） */
function confirmWorkAnchor({ db, documentId, atlasId, surface, now }) {
  const ts = Number.isFinite(now) ? now : Date.now();
  const name = String(surface || "").trim();
  const sn = K.normName(name);
  if (!name || !sn) throw new Error("confirmWorkAnchor: surface required");
  const id = atlasId == null ? null : atlasInt(atlasId);
  if (atlasId != null && id == null) throw new Error("confirmWorkAnchor: bad atlasId");
  const state = id == null ? "rejected" : "user";
  const rel = id == null ? null : "same";
  db.withTransaction(() => {
    const ex = db.queryAll(
      "SELECT id FROM source_terms WHERE document_id = ? AND block_no = -1 AND surface_norm = ? AND role = 'work'",
      [documentId, sn]
    )[0];
    if (ex) {
      db.run(
        "UPDATE source_terms SET surface = ?, atlas_id = ?, atlas_rel = ?, link_state = ?, is_deleted = 0, updated_at = ?, sync_version = sync_version + 1 WHERE id = ?",
        [name, id, rel, state, ts, ex.id]
      );
    } else {
      db.run(
        `INSERT INTO source_terms
           (id, user_id, document_id, unit_anchor, block_no, block_hash, quote, surface, surface_norm, role,
            atlas_id, atlas_rel, link_state, confidence, extractor_version, created_at, updated_at, sync_version, is_deleted)
         VALUES (?, 'local-user', ?, '', -1, '', '', ?, ?, 'work', ?, ?, ?, NULL, ?, ?, ?, 0, 0)`,
        [crypto.randomUUID(), documentId, name, sn, id, rel, state, EXTRACTOR_VERSION, ts, ts]
      );
    }
  });
  return { atlasId: id, linkState: state };
}

// ───────────────────────── 读取 ─────────────────────────

/** 一份文档的活术语（不含软删与 rejected），按块号排序；含作品级挂靠行（blockNo = -1） */
function termsForDocument(db, documentId) {
  return db
    .queryAll(
      `SELECT id, document_id, unit_anchor, block_no, block_hash, quote, surface, surface_norm, role, atlas_id, atlas_rel,
              link_state, confidence, extractor_version, created_at, updated_at
         FROM source_terms WHERE document_id = ? AND is_deleted = 0 AND link_state != 'rejected'
        ORDER BY block_no ASC, created_at ASC`,
      [documentId]
    )
    .map((r) => ({
      id: r.id,
      documentId: r.document_id,
      unitAnchor: r.unit_anchor,
      blockNo: r.block_no,
      blockHash: r.block_hash,
      quote: r.quote,
      surface: r.surface,
      surfaceNorm: r.surface_norm,
      role: r.role,
      atlasId: r.atlas_id,
      atlasRel: r.atlas_rel,
      linkState: r.link_state,
      confidence: r.confidence,
      extractorVersion: r.extractor_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
}

/** 单元覆盖记录；没有返回 null */
function coverageOf(db, documentId, unitAnchor) {
  const r = db.queryAll(
    "SELECT document_id, unit_anchor, text_hash, extractor_version, status, term_count, attempts, done_at FROM source_term_coverage WHERE document_id = ? AND unit_anchor = ?",
    [documentId, unitAnchor]
  )[0];
  return r
    ? {
        documentId: r.document_id,
        unitAnchor: r.unit_anchor,
        textHash: r.text_hash,
        extractorVersion: r.extractor_version,
        status: r.status,
        termCount: r.term_count,
        attempts: r.attempts,
        doneAt: r.done_at
      }
    : null;
}

module.exports = {
  EXTRACTOR_VERSION,
  ROLES,
  NARRATIVE_TYPES,
  blockHash,
  numberedText,
  textHashOf,
  nodeDigestOf,
  charCountOf,
  budgetCap,
  aiAvailable,
  buildExtractorUser,
  parseTermsReply,
  validateTerms,
  applyBudget,
  extractUnit,
  matchTerms,
  commitUnit,
  proposeWorkAnchors,
  confirmWorkAnchor,
  termsForDocument,
  coverageOf
};
