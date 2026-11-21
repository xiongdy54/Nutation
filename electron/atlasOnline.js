"use strict";
// D315 在线分片客户端（格式见 scripts/atlas/shard_format.md）。
// 纯静态文件：<url>/manifest.json、node/<n>.json.gz、edge/<n>.json.gz、name/<sha1前缀>.json.gz。
// 隐私：请求路径只含分片号 / 名称哈希前缀，绝不含搜索词明文；设置 atlasOnlineUrl 为空 ＝ 永不发请求。
// 失败一律静默（返回空）；超时 4 s；gzip 原样缓存到 <userData>/atlas-cache/<version>/…；manifest 每次运行最多取一次。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const gunzipAsync = require("util").promisify(zlib.gunzip);

// 格式 2（size-packed）：manifest.format===2，node/edge 文件按 nodeStarts/edgeStarts 二分查找；格式 1：按 manifest.shard 整除。
// 地址：设置 atlasOnlineUrl 可含多个（换行 / 逗号 / 空白分隔），按序尝试，本次运行记住第一个取到 manifest 的；未设置（undefined）用 DEFAULT_ONLINE_URLS，显式空串＝不联网。
const TIMEOUT_MS = 4000;
const DEFAULT_ONLINE_URLS = ["https://nutation-atlas.pages.dev"];
let override = null; // 测试用：{ url, enabled, dir, now, defaults }
let state = { key: null, per: new Map(), active: null, failedAll: false }; // per: url -> { manifest, failDelay, nextTry }
let diskManifest = null; // v49.154 / D323：同步读缓存用的 manifest 记忆 { root, m }（取到 manifest 时写入 <root>/<version>/manifest.json）
const BACKOFF_MIN_MS = 60 * 1000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;
const now = () => (override && typeof override.now === "function" ? override.now() : Date.now());

function _setConfig(o) {
  override = o || null;
  state = { key: null, per: new Map(), active: null, failedAll: false };
  diskManifest = null;
  parsed.clear();
  parsedBytes = 0;
  edgeMemo.clear();
  memoEdges = 0;
  prefetchBackoff = { failDelay: 0, nextTry: 0 };
}

// ---- 解析后的分片对象 LRU（键＝缓存目录 + 版本 + 文件名；预算按解压后 JSON 字节）+ 逐节点边记忆 ----
// 缓存分片内容不可变（同版本同文件名＝同内容；换服务器而分片边界不同时 getManifest 会清掉该版本目录与记忆），
// 所以记忆只按键里的版本区分。返回的对象是共享的，调用方不得修改。
// 预算：解压后 JSON 字节 16 MB；解析成 JS 对象后堆占用约 2–5 倍，即约 32–80 MB。最大的枢纽边分片（「美国」约 13.5 MB）单独放得下。
const PARSED_BUDGET = 16 * 1024 * 1024;
const parsed = new Map(); // key -> { obj, bytes }
let parsedBytes = 0;
function lruGet(key) {
  const e = parsed.get(key);
  if (!e) return undefined;
  parsed.delete(key);
  parsed.set(key, e);
  return e.obj;
}
function lruPut(key, obj, bytes) {
  const old = parsed.get(key);
  if (old) {
    parsed.delete(key);
    parsedBytes -= old.bytes;
  }
  if (bytes > PARSED_BUDGET) return;
  parsed.set(key, { obj, bytes });
  parsedBytes += bytes;
  for (const [k, e] of parsed) {
    if (parsedBytes <= PARSED_BUDGET) break;
    parsed.delete(k);
    parsedBytes -= e.bytes;
  }
}
// 图谱重建反复问同一批节点（A2 预取后可达数百个分片文件，超出文件 LRU）：小条目逐节点记住，枢纽大条目不记（靠文件 LRU）。
// 记忆里的数组引用着已解析分片的子数组（文件被 LRU 逐出后仍占内存），所以按累计边数封顶（20 万条边，约 20–40 MB 堆），先进先出。
const EDGE_MEMO_EDGES_MAX = 200000;
const EDGE_MEMO_ITEM_MAX = 2000;
const edgeMemo = new Map(); // `${root}|${version}|${id}` -> {o, i}
let memoEdges = 0;
/** 写入逐节点边记忆；枢纽（> EDGE_MEMO_ITEM_MAX 条边）或已在记忆里时不写。返回是否真的写入。 */
function memoEdge(key, e) {
  const n = e.o.length + e.i.length;
  if (n > EDGE_MEMO_ITEM_MAX || edgeMemo.has(key)) return false;
  edgeMemo.set(key, e);
  memoEdges += n;
  for (const [k, v] of edgeMemo) {
    if (memoEdges <= EDGE_MEMO_EDGES_MAX) break;
    edgeMemo.delete(k);
    memoEdges -= v.o.length + v.i.length;
  }
  return true;
}
/** 分片边界签名：同一版本号下边界不同＝缓存文件不可复用 */
const manifestSig = (m) => JSON.stringify([Number(m.format) || 1, m.shard || null, m.nodeStarts || null, m.edgeStarts || null]);
const lruKey = (root, m, rel) => `${root}|${m.version}|${rel}`;

/** 原子写：临时文件 + 改名（中途崩溃不会留下半截分片 / manifest） */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function parseUrls(raw) {
  const list = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[\s,]+/);
  const out = [];
  for (const s of list) {
    const u = String(s || "").trim().replace(/\/+$/, "");
    if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}

function config() {
  let raw;
  let enabled;
  if (override) {
    raw = override.url !== undefined ? override.url : override.defaults || DEFAULT_ONLINE_URLS;
    enabled = override.enabled !== false;
  } else {
    let app = {};
    try {
      app = require("./settingsStore").readSettings().app || {};
    } catch {
      /* ignore */
    }
    // 未设置 → 默认地址（NUT_ATLAS_NO_NET=1 时测试 / 开发环境不用默认地址）；显式空串 → 不联网
    raw = typeof app.atlasOnlineUrl === "string" ? app.atlasOnlineUrl : process.env.NUT_ATLAS_NO_NET ? "" : DEFAULT_ONLINE_URLS;
    enabled = app.atlasOnlineEnabled !== false;
  }
  const urls = parseUrls(raw);
  return { enabled: enabled && urls.length > 0, url: urls[0] || "", urls };
}

function cacheRoot() {
  if (override && override.dir) return override.dir;
  try {
    return path.join(require("electron").app.getPath("userData"), "atlas-cache");
  } catch {
    return null;
  }
}

async function httpGet(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (res.status === 404) return { status: 404 };
    if (!res.ok) return null;
    return { status: 200, buf: Buffer.from(await res.arrayBuffer()) };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** 取 manifest（每次运行最多一次）；版本变化时清掉旧版本缓存目录 */
async function getManifest(cfg) {
  const key = cfg.urls.join("\n");
  if (state.key !== key) state = { key, per: new Map(), active: null, failedAll: false };
  const act = state.active && state.per.get(state.active);
  if (act && act.manifest) return { url: state.active, m: act.manifest };
  // 按序尝试各地址；每个地址单独退避（60 s 起，翻倍，最长 10 min），不再整个会话禁用
  for (const url of cfg.urls) {
    let s = state.per.get(url);
    if (!s) state.per.set(url, (s = { manifest: null, failDelay: 0, nextTry: 0 }));
    if (s.nextTry && now() < s.nextTry) continue;
    const fail = () => {
      s.failDelay = s.failDelay ? Math.min(s.failDelay * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
      s.nextTry = now() + s.failDelay;
    };
    const r = await httpGet(url + "/manifest.json");
    if (!r || r.status !== 200) {
      fail();
      continue;
    }
    try {
      const m = JSON.parse(r.buf.toString("utf8"));
      if (!m || typeof m !== "object" || m.version == null) throw new Error("bad manifest");
      m.version = String(m.version).replace(/[^0-9A-Za-z._-]/g, "_");
      s.manifest = m;
      s.failDelay = 0;
      s.nextTry = 0;
      state.active = url;
      state.failedAll = false;
      const root = cacheRoot();
      if (root && fs.existsSync(root)) {
        for (const d of fs.readdirSync(root)) if (d !== m.version) fs.rmSync(path.join(root, d), { recursive: true, force: true });
        // 同版本号但分片边界不同（换了服务器 / 重新导出）：已缓存的文件按旧边界切分，整目录作废，内存记忆一并清掉
        try {
          const old = JSON.parse(fs.readFileSync(path.join(root, m.version, "manifest.json"), "utf8"));
          if (manifestSig(old) !== manifestSig(m)) {
            fs.rmSync(path.join(root, m.version), { recursive: true, force: true });
            parsed.clear();
            parsedBytes = 0;
            edgeMemo.clear();
            memoEdges = 0;
          }
        } catch {
          /* 没有旧 manifest：照常 */
        }
      }
      // D323：manifest 落盘到版本目录，供同步读缓存分片（断网 / 本次运行尚未联网时也能定位分片文件）
      if (root) {
        try {
          writeAtomic(path.join(root, m.version, "manifest.json"), JSON.stringify(m));
        } catch {
          /* 写失败只影响同步读缓存 */
        }
        diskManifest = { root, m };
      }
      return { url, m };
    } catch {
      fail();
    }
  }
  state.failedAll = true;
  return null;
}

/** 取一个分片（rel 形如 node/12.json.gz）；返回解析后的对象，404 / 失败＝{}。有缓存先读缓存（404 也缓存为空文件）。 */
async function shard(base, m, rel) {
  return (await shardOrNull(base, m, rel)) || {};
}
/** 同 shard，但区分「取不到」（网络失败 / 内容损坏 → null）与「确实没有」（404 → {}）。D323 据此判断关系是否完整。 */
async function shardOrNull(base, m, rel) {
  const root = cacheRoot();
  const file = root ? path.join(root, m.version, ...rel.split("/")) : null;
  const key = root ? lruKey(root, m, rel) : null;
  if (key) {
    const hit = lruGet(key);
    if (hit !== undefined) return hit;
  }
  // 解压在线程池里做（异步），主进程只做 JSON 解析
  const decode = async (buf) => {
    if (!buf.length) return { obj: {}, bytes: 0 };
    const raw = await gunzipAsync(buf);
    return { obj: JSON.parse(raw.toString("utf8")), bytes: raw.length };
  };
  try {
    if (file && fs.existsSync(file)) {
      const { obj, bytes } = await decode(await fs.promises.readFile(file));
      if (key) lruPut(key, obj, bytes);
      return obj;
    }
  } catch {
    /* 缓存损坏：当作未命中重取 */
  }
  const r = await httpGet(`${base}/${rel}`);
  if (!r) return null;
  let obj = {};
  let rawBytes = 0;
  let bytes = Buffer.alloc(0);
  if (r.status === 200) {
    try {
      ({ obj, bytes: rawBytes } = await decode(r.buf));
      bytes = r.buf;
    } catch {
      return null;
    }
  }
  if (file) {
    try {
      writeAtomic(file, bytes);
    } catch {
      /* 缓存写失败不影响结果 */
    }
  }
  if (key) lruPut(key, obj, rawBytes);
  return obj;
}

const toInt = (id) => {
  const s = String(id == null ? "" : id);
  const n = Number(s[0] === "Q" ? s.slice(1) : s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** 文件序号：格式 2 在 starts（升序，文件 i 覆盖 [starts[i], starts[i+1])）里二分；格式 1 按 shard 整除。无对应文件＝-1 */
function fileIndex(m, kind, id) {
  if (Number(m.format) === 2) {
    const st = kind === "node" ? m.nodeStarts : m.edgeStarts;
    if (!Array.isArray(st) || !st.length || id < st[0]) return -1;
    let lo = 0;
    let hi = st.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid] <= id) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  return Math.floor(id / (Number(m.shard) || 2048));
}

async function ready() {
  const cfg = config();
  if (!cfg.enabled) return null;
  const r = await getManifest(cfg);
  return r ? { url: r.url, m: r.m } : null;
}

const FETCH_CONCURRENCY = 6;
/** 最多 n 个并发地对 items 逐个执行 fn */
async function pool(items, n, fn) {
  let k = 0;
  const worker = async () => {
    while (k < items.length) await fn(items[k++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * 节点行（NODE_COLS 形状；redirect 已解析）。只返回取得到的；顺序同 ids。
 * opts.maxIds / opts.maxFiles：按 ids 的先后顺序取，超过编号数或分片文件数上限的编号跳过（数组带 skipped＝跳过数）。
 * 分片文件并发取（最多 6 个同时），同一次调用里同一文件只取一次。
 */
async function fetchNodes(ids, opts = {}) {
  const ints = [...new Set((ids || []).map(toInt).filter(Boolean))];
  const out = Object.assign([], { skipped: 0 });
  if (!ints.length) return out;
  const c = await ready();
  if (!c) return out;
  const maxIds = Number(opts.maxIds) > 0 ? Number(opts.maxIds) : Infinity;
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : Infinity;
  const files = new Set();
  const take = [];
  for (const i of ints) {
    const f = fileIndex(c.m, "node", i);
    if (f < 0) continue;
    if (take.length >= maxIds || (!files.has(f) && files.size >= maxFiles)) {
      out.skipped++;
      continue;
    }
    files.add(f);
    take.push(i);
  }
  const memo = new Map();
  const load = (f) => {
    const rel = `node/${f}.json.gz`;
    if (!memo.has(rel)) memo.set(rel, shard(c.url, c.m, rel));
    return memo.get(rel);
  };
  await pool([...files], FETCH_CONCURRENCY, load);
  const get = async (i) => {
    const f = fileIndex(c.m, "node", i);
    return f < 0 ? null : (await load(f))[String(i)] || null;
  };
  const rows = await Promise.all(
    take.map(async (i) => {
      const r = await get(i);
      return r && r.redirect ? (await get(r.redirect)) || r : r;
    })
  );
  for (const r of rows) if (r) out.push(r);
  return out;
}

/** 规范化名称的精确查找 → [[nodeId, w], ...]。请求只含 sha1 前缀。 */
async function lookupName(norm) {
  if (!norm) return [];
  const c = await ready();
  if (!c) return [];
  const p = Number(c.m.namePrefix) || 3;
  const h = crypto.createHash("sha1").update(norm, "utf8").digest("hex").slice(0, p);
  const s = await shard(c.url, c.m, `name/${h}.json.gz`);
  return Array.isArray(s[norm]) ? s[norm] : [];
}

/**
 * 一个节点的边：{ o:[[dst,type,pred,conf,source]], i:[[src,...]], complete }。
 * complete＝true：取到了该节点所在的边分片（缓存或在线；分片里没有该编号＝确实无边）；
 * complete＝false：未联网 / 联网关闭 / 取分片失败——o、i 为空只表示「不知道」（D323）。
 */
async function fetchEdges(id) {
  const n = toInt(id);
  if (!n) return { o: [], i: [], complete: false };
  const c = await ready();
  if (!c) return { o: [], i: [], complete: false };
  const f = fileIndex(c.m, "edge", n);
  if (f < 0) return { o: [], i: [], complete: true };
  const s = await shardOrNull(c.url, c.m, `edge/${f}.json.gz`);
  if (!s) return { o: [], i: [], complete: false };
  const e = s[String(n)] || {};
  return { o: e.o || [], i: e.i || [], complete: true };
}

// ---- v49.154 / D323：同步读本地分片缓存（零网络；kgService 的图谱构建是同步的） ----

/** 当前可用于读缓存的 manifest：本次运行已取到的 > 缓存目录里落盘的（取最新）。没有＝null */
function manifestSync() {
  const root = cacheRoot();
  if (!root) return null;
  // 本次运行取到的 manifest 只在仍是当前设置的地址列表时可用（换了地址就退回磁盘上与缓存文件配套的那份）
  const act = state.active && state.key === config().urls.join("\n") && state.per.get(state.active);
  if (act && act.manifest) return act.manifest;
  if (diskManifest && diskManifest.root === root) return diskManifest.m;
  let best = null;
  try {
    if (!fs.existsSync(root)) return null;
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, "manifest.json");
      try {
        const st = fs.statSync(f);
        const m = JSON.parse(fs.readFileSync(f, "utf8"));
        if (!m || String(m.version) !== d) continue;
        if (!best || st.mtimeMs > best.t) best = { t: st.mtimeMs, m };
      } catch {
        /* 无 manifest / 损坏：跳过 */
      }
    }
  } catch {
    return null;
  }
  if (!best) return null;
  diskManifest = { root, m: best.m };
  return best.m;
}

/** 同步读一个已缓存的分片文件（经 LRU）：undefined＝未缓存或损坏；{}＝缓存的 404 */
function readCachedSync(root, m, rel) {
  const key = lruKey(root, m, rel);
  const hit = lruGet(key);
  if (hit !== undefined) return hit;
  const file = path.join(root, m.version, ...rel.split("/"));
  try {
    if (!fs.existsSync(file)) return undefined;
    const buf = fs.readFileSync(file);
    if (!buf.length) {
      lruPut(key, {}, 0);
      return {};
    }
    const raw = zlib.gunzipSync(buf);
    const obj = JSON.parse(raw.toString("utf8"));
    lruPut(key, obj, raw.length);
    return obj;
  } catch {
    return undefined;
  }
}

/**
 * 一批节点的边（只读本地缓存，零网络）：Map<整数编号, {o, i} | null>。
 * null＝该节点所在的边分片没有缓存（不知道）；{o:[], i:[]}＝缓存里确认无边。同一分片文件只解压一次。
 * opts.maxFiles（A2）：最多从磁盘同步解压这么多个分片文件（文件 LRU / 逐节点记忆命中不计）；超出的节点仍为 null，
 *   调用方当作「不知道」处理（图谱重建在主进程同步跑，不能一次解压几百个分片）。
 */
function edgesCachedSync(ids, opts = {}) {
  const ints = [...new Set((ids || []).map(toInt).filter(Boolean))];
  const out = new Map(ints.map((i) => [i, null]));
  const root = cacheRoot();
  const m = root ? manifestSync() : null;
  if (!m) return out;
  const byFile = new Map();
  for (const i of ints) {
    const mk = `${root}|${m.version}|${i}`;
    const hit = edgeMemo.get(mk);
    if (hit) {
      out.set(i, hit);
      continue;
    }
    const f = fileIndex(m, "edge", i);
    if (f < 0) {
      out.set(i, { o: [], i: [] });
      continue;
    }
    (byFile.get(f) || byFile.set(f, []).get(f)).push(i);
  }
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : Infinity;
  let reads = 0;
  for (const [f, list] of byFile) {
    const rel = `edge/${f}.json.gz`;
    let s = lruGet(lruKey(root, m, rel));
    if (s === undefined) {
      if (reads >= maxFiles) continue;
      reads++;
      s = readCachedSync(root, m, rel);
    }
    if (s === undefined) continue;
    for (const i of list) {
      const e = s[String(i)] || {};
      const v = { o: e.o || [], i: e.i || [] };
      out.set(i, v);
      memoEdge(`${root}|${m.version}|${i}`, v);
    }
  }
  return out;
}

/**
 * 一批节点行（只读本地缓存的节点分片，零网络；redirect 已解析）。只返回取得到的。
 * opts.maxFiles：最多从磁盘解压这么多个分片文件（LRU 命中不计）；超出的编号跳过，数组带 skipped＝跳过数。
 */
function nodesCachedSync(ids, opts = {}) {
  const ints = [...new Set((ids || []).map(toInt).filter(Boolean))];
  const out = Object.assign([], { skipped: 0 });
  const root = cacheRoot();
  const m = ints.length && root ? manifestSync() : null;
  if (!m) return out;
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : Infinity;
  let reads = 0;
  const memo = new Map();
  const SKIP = {};
  const get = (i) => {
    const f = fileIndex(m, "node", i);
    if (f < 0) return null;
    const rel = `node/${f}.json.gz`;
    if (!memo.has(rel)) {
      const hit = lruGet(lruKey(root, m, rel));
      if (hit !== undefined) memo.set(rel, hit);
      else if (reads >= maxFiles) return SKIP;
      else {
        reads++;
        memo.set(rel, readCachedSync(root, m, rel) || {});
      }
    }
    return memo.get(rel)[String(i)] || null;
  };
  for (const i of ints) {
    let r = get(i);
    if (r === SKIP) {
      out.skipped++;
      continue;
    }
    if (r && r.redirect) {
      const t = get(r.redirect);
      if (t && t !== SKIP) r = t;
    }
    if (r) out.push(r);
  }
  return out;
}

// ---- v49.154 / D323 / A2：后台预取用户挂靠节点的边分片（docs/design/KG-ATLAS-DELIVERY-ENRICH.md §3） ----
// 按分片文件去重；最多 PREFETCH_CONCURRENCY 个并发、每取完一个文件让出一次事件循环；单次最多 PREFETCH_MAX_FILES 个文件。
// 联网关闭 / 退避中：不发请求，只把磁盘上已缓存的分片读进逐节点记忆。任何一个分片取失败：本轮停止联网，
// 按 atlasOnline 的退避口径（60 s 起翻倍，最长 10 min）推迟下一次联网预取，失败不抛出。
// 取到的分片只落盘 + 写逐节点记忆（不进文件 LRU）：解压在线程池，主进程只做逐文件的 JSON 解析，
// 这样随后的图谱重建（同步）命中记忆，不必在主进程上同步解压几百个分片。
const PREFETCH_CONCURRENCY = 3;
const PREFETCH_MAX_FILES = 1000;
let prefetchBackoff = { failDelay: 0, nextTry: 0 };
const yieldTurn = () => new Promise((r) => setImmediate(r));

/**
 * 预取一批节点的边分片：Promise<{ files, fetched, warmed, failed, offline }>（不抛出）。
 * files＝本轮涉及的分片文件数（已在记忆里的节点不计）；fetched＝联网取到并落盘的文件数；
 * warmed＝写进逐节点记忆的节点数；failed＝联网失败的文件数；offline＝本轮没有联网（关闭 / 退避 / 取不到 manifest）。
 */
async function prefetchEdges(ids, opts = {}) {
  const res = { files: 0, fetched: 0, warmed: 0, failed: 0, offline: true };
  try {
    const ints = [...new Set((ids || []).map(toInt).filter(Boolean))];
    const root = cacheRoot();
    if (!ints.length || !root) return res;
    const cfg = config();
    let c = null;
    if (cfg.enabled && !(prefetchBackoff.nextTry && now() < prefetchBackoff.nextTry)) c = await ready();
    res.offline = !c;
    const m = c ? c.m : manifestSync();
    if (!m) return res;
    const byFile = new Map();
    for (const i of ints) {
      if (edgeMemo.has(`${root}|${m.version}|${i}`)) continue;
      const f = fileIndex(m, "edge", i);
      if (f < 0) continue;
      (byFile.get(f) || byFile.set(f, []).get(f)).push(i);
    }
    const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : PREFETCH_MAX_FILES;
    const files = [...byFile.keys()].slice(0, maxFiles);
    res.files = files.length;
    let stop = false;
    await pool(files, PREFETCH_CONCURRENCY, async (f) => {
      const rel = `edge/${f}.json.gz`;
      const file = path.join(root, m.version, ...rel.split("/"));
      let buf = null;
      try {
        if (fs.existsSync(file)) buf = await fs.promises.readFile(file);
      } catch {
        buf = null;
      }
      if (!buf && c && !stop) {
        const r = await httpGet(`${c.url}/${rel}`);
        let ok = !!r;
        if (r && r.status === 200) {
          try {
            await gunzipAsync(r.buf); // 校验：损坏内容不落盘
            buf = r.buf;
          } catch {
            ok = false;
          }
        } else if (r) buf = Buffer.alloc(0); // 404＝该文件确实不存在，缓存为空文件
        if (!ok) {
          res.failed++;
          stop = true;
          return;
        }
        try {
          writeAtomic(file, buf);
          res.fetched++;
        } catch {
          /* 缓存写失败：本轮仍可写记忆 */
        }
      }
      if (!buf) return;
      try {
        const obj = buf.length ? JSON.parse((await gunzipAsync(buf)).toString("utf8")) : {};
        for (const i of byFile.get(f)) {
          const e = obj[String(i)] || {};
          // 只有真的写进逐节点记忆才算 warmed（枢纽 >2000 条边不写，避免每轮预取都误触发图谱缓存失效）
          if (memoEdge(`${root}|${m.version}|${i}`, { o: e.o || [], i: e.i || [] })) res.warmed++;
        }
      } catch {
        /* 缓存损坏：留给同步读 / 下次在线取 */
      }
      await yieldTurn();
    });
    if (c) {
      if (res.failed) {
        prefetchBackoff.failDelay = prefetchBackoff.failDelay ? Math.min(prefetchBackoff.failDelay * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
        prefetchBackoff.nextTry = now() + prefetchBackoff.failDelay;
      } else prefetchBackoff = { failDelay: 0, nextTry: 0 };
    }
  } catch {
    /* 预取失败不影响任何功能 */
  }
  return res;
}

/** 在线查找当前可用？已启用 + 有地址 + 最近一轮取 manifest 没有全部失败（尚未尝试也算可用） */
function ready_() {
  const cfg = config();
  return !!(cfg.enabled && cfg.url) && !(state.key === cfg.urls.join("\n") && state.failedAll);
}

module.exports = { config, ready_, fetchNodes, lookupName, fetchEdges, prefetchEdges, edgesCachedSync, nodesCachedSync, manifestSync, _setConfig, _memoSize: () => edgeMemo.size, DEFAULT_ONLINE_URLS };
