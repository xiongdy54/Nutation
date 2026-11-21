"use strict";
// D315 全谱节点快照（表 atlas_node_snapshots，迁移 v11，LOCAL）。
// 已挂到知识点 / 导图的全谱节点，把名称四语、说明、种类、上级链、主题、学科存进用户库：
// 没有完整库（只有核心库或什么都没有）、断网时照常显示。快照只是缓存，可由全谱重建，不是事实源。
const atlas = () => require("./atlas");
const H = () => require("./db")._mapLinkDb();

const toInt = (v) => {
  const s = String(v == null ? "" : v);
  const n = Number(s[0] === "Q" ? s.slice(1) : s);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const uniq = (ids) => [...new Set((Array.isArray(ids) ? ids : [ids]).map(toInt).filter(Boolean))];
const ph = (a) => a.map(() => "?").join(",");

function builtAt() {
  try {
    return atlas().status().builtAt || null;
  } catch {
    return null;
  }
}

function write(rows, at) {
  if (!rows.length) return;
  const { run, withTransaction } = H();
  const now = Date.now();
  withTransaction(() => {
    for (const [id, detail] of rows) {
      run(
        "INSERT INTO atlas_node_snapshots (atlas_id, json, atlas_built_at, updated_at) VALUES (?,?,?,?) ON CONFLICT(atlas_id) DO UPDATE SET json = excluded.json, atlas_built_at = excluded.atlas_built_at, updated_at = excluded.updated_at",
        [id, JSON.stringify(detail), at, now]
      );
    }
  });
}

/** 同步：对「现在能从已打开的全谱库查到」的编号写 / 刷新快照（版本相同的跳过）。返回写入条数。 */
function ensure(atlasIds) {
  const ids = uniq(atlasIds);
  if (!ids.length) return 0;
  try {
    const at = builtAt();
    const have = new Map(H().queryAll(`SELECT atlas_id, atlas_built_at AS b FROM atlas_node_snapshots WHERE atlas_id IN (${ph(ids)})`, ids).map((r) => [r.atlas_id, r.b]));
    const rows = [];
    for (const i of ids) {
      if (have.has(i) && have.get(i) === at) continue;
      const d = atlas().nodeLocal("Q" + i);
      if (d) rows.push([i, d]);
    }
    write(rows, at);
    return rows.length;
  } catch {
    return 0; // 库未就绪等：快照是缓存，静默
  }
}

/** ensure + 在线分片（仍没有快照也查不到的编号）。同步部分立即执行，在线部分异步补。 */
async function ensureAsync(atlasIds) {
  const ids = uniq(atlasIds);
  const n = ensure(ids);
  let extra = 0;
  try {
    const have = new Set(H().queryAll(`SELECT atlas_id FROM atlas_node_snapshots WHERE atlas_id IN (${ph(ids)})`, ids).map((r) => r.atlas_id));
    const rows = [];
    for (const i of ids) {
      if (have.has(i)) continue;
      const d = await atlas().nodeAsync("Q" + i);
      if (d) rows.push([i, d]);
    }
    write(rows, builtAt());
    extra = rows.length;
  } catch {
    /* 静默 */
  }
  return n + extra;
}

/** 快照 → 节点对象（getNodes 回落用，与 rowToNode 同形）。 */
function get(atlasIds) {
  const ids = uniq(atlasIds);
  if (!ids.length) return [];
  const rows = H().queryAll(`SELECT atlas_id, json FROM atlas_node_snapshots WHERE atlas_id IN (${ph(ids)})`, ids);
  const out = [];
  for (const r of rows) {
    try {
      const d = JSON.parse(r.json);
      out.push({ id: d.id, kind: d.kind, kindLabel: d.kindLabel, zh: d.zh, zht: d.zht, en: d.en, ja: d.ja, machine: d.machine, gloss: d.gloss, glossEn: d.glossEn, years: d.years, rank: d.rank, parentId: d.parentId ?? null, topicId: d.topicId, fieldId: d.fieldId });
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/** 快照 → 节点详情（含主题链 / 学科）。 */
function getDetail(atlasId) {
  const i = toInt(atlasId);
  if (!i) return null;
  const r = H().queryAll("SELECT json FROM atlas_node_snapshots WHERE atlas_id = ?", [i])[0];
  if (!r) return null;
  try {
    const d = JSON.parse(r.json);
    return { ...d, chain: d.chain || [], field: d.field || null };
  } catch {
    return null;
  }
}

/** 所有「已挂」的全谱编号：知识点 atlas_id / atlas_parent、也涉及、导图挂靠（未删）。 */
function linkedIds() {
  const q = H().queryAll;
  const out = new Set();
  for (const r of q("SELECT atlas_id AS a, atlas_parent AS p FROM knowledge_points WHERE atlas_id IS NOT NULL OR atlas_parent IS NOT NULL")) {
    if (r.a) out.add(r.a);
    if (r.p) out.add(r.p);
  }
  for (const r of q("SELECT ref_value AS v FROM knowledge_external_refs WHERE ref_kind = 'atlas-also' AND is_deleted = 0")) {
    const n = toInt(r.v);
    if (n) out.add(n);
  }
  for (const r of q("SELECT DISTINCT atlas_id AS a FROM material_map_node_refs WHERE is_deleted = 0")) out.add(r.a);
  return [...out];
}

/**
 * 启动补快照：已挂但缺快照、或快照来自旧版全谱（built_at 不同）的编号。
 * 全谱随新版本更新（如补译中文名）后，已挂节点的快照随之刷新——知识点只存编号，名称本来就按编号现查。
 * 返回 { linked, missing, written }。
 */
async function ensureMissing() {
  try {
    const all = linkedIds();
    const at = builtAt();
    const have = new Map(H().queryAll("SELECT atlas_id, atlas_built_at AS b FROM atlas_node_snapshots").map((r) => [r.atlas_id, r.b]));
    const missing = all.filter((i) => !have.has(i) || (at != null && have.get(i) !== at));
    const written = missing.length ? await ensureAsync(missing) : 0;
    return { linked: all.length, missing: missing.length, written };
  } catch {
    return { linked: 0, missing: 0, written: 0 };
  }
}

module.exports = { ensure, ensureAsync, ensureMissing, get, getDetail, linkedIds };
