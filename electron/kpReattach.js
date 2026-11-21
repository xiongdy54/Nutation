"use strict";
// v49.147 / D316：解散知识点并给名下卡片重挂（主进程；设计 docs/design/KG-KP-ATLAS-REALIGN.md §2–§3）。
// plan：取卡片 → 本地召回候选（全谱条目 / 用户已有知识点）→ AI 封闭选择（只认候选编号 + 精确唯一的 more 条目名）→ 预览表。确认前不落库。
// apply：令牌 + 用户逐卡决定 → db.kpReattachApply（单事务）。undo：撤销令牌 → db.kpReattachUndo。
// 候选表与撤销数据都留在主进程，渲染层只拿令牌（同 mapLink 的封闭选择写法）。
// 依赖全部注入（node 可测）：{ chatStream, getAIConfig, getPromptTemplate, db?, atlas? }
const crypto = require("crypto");

const BATCH = 10; // 每批 ≤10 张卡
const PARALLEL = 2; // 同时 ≤2 批
const MAX_CANDS = 12;
const MAX_CARDS = 400; // 单次预览上限（超出的卡留在原知识点，界面提示）

const atlasInt = (v) => {
  const s = String(v == null ? "" : v);
  const n = Number(s[0] === "Q" || s[0] === "q" ? s.slice(1) : s);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const labelOf = (n) => String(n.zh || n.zht || n.en || n.ja || n.id || "").trim();

function createKpReattach(d) {
  const D = () => d.db || require("./db");
  const A = () => d.atlas || require("./atlas");
  const plans = new Map(); // token → {kpIds, cards: Map<cardId, {fromKpId, cands: Map<key, target>}>}
  const undos = new Map(); // undoToken → undo 数据
  const put = (m, v) => {
    const t = crypto.randomUUID();
    m.set(t, v);
    if (m.size > 50) m.delete(m.keys().next().value);
    return t;
  };

  async function chat(system, user) {
    return await new Promise((resolve, reject) => {
      let acc = "";
      let settled = false;
      Promise.resolve(
        d.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2 }, (m) => {
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

  async function aiTemplate() {
    let cfg = null;
    try {
      cfg = await d.getAIConfig();
    } catch {
      cfg = null;
    }
    if (!(cfg && (cfg.hasKey || cfg.preset === "local"))) return null;
    try {
      const t = d.getPromptTemplate("kg-card-reattach");
      return t && t.content ? String(t.content) : null;
    } catch {
      return null;
    }
  }

  /** 单个条目名 → 全谱节点：只认 exact 且恰好一个（重定向落同一节点算一个）；否则 null（编号来自全谱，不来自 AI） */
  async function resolveName(name) {
    let r = [];
    try {
      r = (await A().searchAsync(name, { limit: 10 })) || [];
    } catch {
      return null;
    }
    const ex = r.filter((x) => x.exact && atlasInt(x.id));
    const ids = [...new Set(ex.map((x) => atlasInt(x.id)))];
    return ids.length === 1 ? ex.find((x) => atlasInt(x.id) === ids[0]) : null;
  }

  function buildCands(card, dissolved) {
    const text = `${card.front} ${card.back}`;
    const out = []; // {kind, label, gloss, target}
    const seenKp = new Set();
    const seenAtlas = new Set();
    let found = [];
    try {
      found = A().candidates(text, { limit: MAX_CANDS }) || [];
    } catch {
      found = [];
    }
    for (const n of found) {
      const aid = atlasInt(n.id);
      if (!aid || seenAtlas.has(aid)) continue;
      seenAtlas.add(aid);
      const kp = D().kpActiveByAtlas(aid);
      if (kp) {
        if (dissolved.has(kp.id) || seenKp.has(kp.id)) continue;
        seenKp.add(kp.id);
        out.push({ kind: "kp", label: kp.label, gloss: n.gloss || "", atlasId: aid, target: { kind: "kp", kpId: kp.id } });
      } else {
        out.push({ kind: "atlas", label: labelOf(n), gloss: n.gloss || "", atlasId: aid, target: { kind: "atlas", atlasId: aid, label: labelOf(n) } });
      }
    }
    let similar = [];
    try {
      similar = D().kgSimilarKps(text, 5, [...dissolved]);
    } catch {
      similar = [];
    }
    for (const s of similar) {
      if (seenKp.has(s.id)) continue;
      seenKp.add(s.id);
      out.push({ kind: "kp", label: s.label, gloss: "", atlasId: atlasInt(s.atlasId), target: { kind: "kp", kpId: s.id } });
    }
    return out.slice(0, MAX_CANDS + 5);
  }

  function parseItems(raw) {
    const t = String(raw || "");
    const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    return Array.isArray(j && j.items) ? j.items : [];
  }

  /**
   * 生成预览。onProgress({done,total})。返回
   * { token, ai: "none"|"done"|"failed", truncated, groups:[{kpId,label,cards:[{cardId,front,back,cands:[{key,kind,label,gloss}],suggestion:key|null}]}] }
   * 没配 AI / AI 失败：照样返回每张卡的候选，suggestion 为 null（用户手选）。
   */
  async function plan(kpIds, opts) {
    const onProgress = (opts && opts.onProgress) || (() => {});
    const raw = D().kpReattachCards(kpIds);
    const dissolved = new Set(raw.map((g) => g.kpId));
    let budget = MAX_CARDS;
    let truncated = 0;
    const st = { kpIds: [...dissolved], cards: new Map() };
    const flat = []; // 渲染用卡对象
    const groups = raw.map((g) => {
      const keep = g.cards.slice(0, Math.max(0, budget));
      budget -= keep.length;
      truncated += g.cards.length - keep.length;
      return {
        kpId: g.kpId,
        label: g.label,
        cards: keep.map((c) => {
          const cs = buildCands(c, dissolved);
          const cm = new Map();
          const cands = cs.map((x, i) => {
            const key = String(i + 1);
            cm.set(key, x.target);
            return { key, kind: x.kind, label: x.label, gloss: x.gloss };
          });
          st.cards.set(c.cardId, { fromKpId: g.kpId, cands: cm });
          const card = { cardId: c.cardId, front: c.front, back: c.back, cands, suggestion: null, _src: cs };
          flat.push(card);
          return card;
        })
      };
    });
    let ai = "none";
    const system = flat.length ? await aiTemplate() : null;
    if (system) {
      ai = "done";
      const batches = [];
      for (let i = 0; i < flat.length; i += BATCH) batches.push(flat.slice(i, i + BATCH));
      let done = 0;
      onProgress({ done, total: flat.length });
      const runBatch = async (batch) => {
        const lines = [];
        batch.forEach((c, i) => {
          lines.push(`k=${i + 1} 题面：${c.front || "（空）"}｜答案：${c.back || "（空）"}`);
          if (!c.cands.length) lines.push("  （无候选）");
          c.cands.forEach((x) => lines.push(`  ${x.key}. [${x.kind === "kp" ? "已有" : "全谱"}] ${x.label}${x.gloss ? ` — ${String(x.gloss).slice(0, 20)}` : ""}`));
        });
        try {
          const reply = await chat(system, `【闪卡】\n${lines.join("\n")}`);
          for (const it of parseItems(reply)) {
            const c = batch[Number(it && it.k) - 1];
            if (!c) continue;
            const pick = Number(it.pick);
            if (Number.isInteger(pick) && pick >= 1 && pick <= c.cands.length) {
              c.suggestion = c.cands[pick - 1].key;
              continue;
            }
            const name = typeof it.more === "string" ? it.more.trim() : "";
            if (!name || name.length > 120) continue;
            const hit = await resolveName(name);
            if (!hit) continue;
            const aid = atlasInt(hit.id);
            const same = c._src.findIndex((x) => x.atlasId === aid);
            if (same >= 0) {
              c.suggestion = c.cands[same].key;
              continue;
            }
            // 候选外的条目：并入这张卡的候选表（目标仍由 db 事务再校验）
            const kp = D().kpActiveByAtlas(aid);
            if (kp && dissolved.has(kp.id)) continue;
            const key = String(c.cands.length + 1);
            const target = kp ? { kind: "kp", kpId: kp.id } : { kind: "atlas", atlasId: aid, label: labelOf(hit) };
            st.cards.get(c.cardId).cands.set(key, target);
            c.cands.push({ key, kind: kp ? "kp" : "atlas", label: kp ? kp.label : labelOf(hit), gloss: hit.gloss || "" });
            c.suggestion = key;
          }
        } catch (e) {
          ai = "failed";
          try {
            console.warn("[kpReattach] AI 批次失败：", e && e.message);
          } catch { /* ignore */ }
        }
        done += batch.length;
        onProgress({ done, total: flat.length });
      };
      let next = 0;
      const worker = async () => {
        while (next < batches.length) await runBatch(batches[next++]);
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
    }
    for (const c of flat) delete c._src;
    return { token: put(plans, st), ai, truncated, groups };
  }

  /**
   * 确认。decisions：[{cardId, choice}]；choice＝null（留在原知识点）| {key}（本卡候选）| {atlasId}（就地搜索选的全谱条目）。
   * 没写进 decisions 的卡一律留下。返回 {moved, created, archived, undoToken}。
   */
  async function apply(token, decisions) {
    const st = plans.get(String(token));
    if (!st) throw new Error("kpReattach: unknown or expired plan");
    const moves = [];
    for (const dec of Array.isArray(decisions) ? decisions : []) {
      const card = st.cards.get(String(dec && dec.cardId));
      if (!card) throw new Error("kpReattach: card not in plan");
      const ch = dec.choice;
      if (!ch) continue;
      let target = null;
      if (ch.key != null) {
        target = card.cands.get(String(ch.key));
        if (!target) throw new Error("kpReattach: choice outside candidates");
      } else if (ch.atlasId != null) {
        const aid = atlasInt(ch.atlasId);
        const node = aid ? (await A().getNodesAsync(["Q" + aid]))[0] : null;
        if (!node) throw new Error("kpReattach: atlas node not found");
        target = { kind: "atlas", atlasId: aid, label: labelOf(node) };
      } else continue;
      moves.push({ cardId: String(dec.cardId), fromKpId: card.fromKpId, target });
    }
    const r = D().kpReattachApply({ kpIds: st.kpIds, moves });
    plans.delete(String(token));
    const atlasIds = [];
    for (const m of moves) if (m.target.kind === "atlas") atlasIds.push("Q" + m.target.atlasId);
    return { moved: r.moved, created: r.created.length, archived: r.archived.length, archivedIds: r.archived.slice(), undoToken: put(undos, r.undo), atlasIds: [...new Set(atlasIds)] };
  }

  function undo(undoToken) {
    const u = undos.get(String(undoToken));
    if (!u) throw new Error("kpReattach: unknown or expired undo");
    const r = D().kpReattachUndo(u);
    undos.delete(String(undoToken));
    return r;
  }

  return { plan, apply, undo };
}

module.exports = { createKpReattach, BATCH, PARALLEL };
