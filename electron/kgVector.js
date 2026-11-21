"use strict";
// v49.140 / D307 知识图谱「语义匹配」（可选向量召回；设计稿 §0.4 / §7.3 第四轮修订）。
// 四档（设置 app.kgVector.mode）：
//   none  —— 默认。不用向量：规范化键精确命中 + 与材料字面最相近的已有名称注入（R22）+ AI 裁决。
//   small —— 下载 multilingual-e5-small（int8，约 118 MB）+ WASM 推理引擎（约 11 MB），本地离线运行。
//   large —— 下载 Qwen3-Embedding-0.6B（int8，约 614 MB）+ 同一引擎，本地离线运行。
//   api   —— 用已配置 AI 服务的 /embeddings 接口（不下载；需联网，知识点名称会发给服务商）。
// 纪律：向量只做召回，从不判定「同一个」；任何失败一律静默退回 none 档口径（不阻断制卡）。
// 联网面（GUIDE §4.22 / D307 登记）：只有用户在设置里主动点「下载」或选 api 档才会联网；下载校验 SHA-256。
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { readSettings, writeSettings } = require("./settingsStore");
const learnerDb = require("./learnerDb");

let dbModule = null;
const db = () => dbModule || (dbModule = require("./db"));

const ORT_VERSION = "1.22.0";
const RUNTIME = {
  id: `ort-web-${ORT_VERSION}`,
  files: [
    {
      name: "ort-wasm-simd-threaded.mjs",
      bytes: 20856,
      sha256: "30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8",
      urls: [
        `https://registry.npmmirror.com/onnxruntime-web/${ORT_VERSION}/files/dist/ort-wasm-simd-threaded.mjs`,
        `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.mjs`
      ]
    },
    {
      name: "ort-wasm-simd-threaded.wasm",
      bytes: 11210254,
      sha256: "71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4",
      urls: [
        `https://registry.npmmirror.com/onnxruntime-web/${ORT_VERSION}/files/dist/ort-wasm-simd-threaded.wasm`,
        `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.wasm`
      ]
    }
  ]
};
const ms = (repo, f) => `https://modelscope.cn/models/${repo}/resolve/master/${f}`;
const hf = (repo, f) => `https://huggingface.co/${repo}/resolve/main/${f}`;
const TIERS = {
  small: {
    id: "multilingual-e5-small-int8",
    label: "multilingual-e5-small",
    pooling: "mean",
    query: (t) => `query: ${t}`,
    doc: (t) => `passage: ${t}`,
    files: [
      { name: "model.onnx", bytes: 118308185, sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193", urls: [ms("Xenova/multilingual-e5-small", "onnx/model_quantized.onnx"), hf("Xenova/multilingual-e5-small", "onnx/model_quantized.onnx")] },
      { name: "tokenizer.json", bytes: 17082730, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39", urls: [ms("Xenova/multilingual-e5-small", "tokenizer.json"), hf("Xenova/multilingual-e5-small", "tokenizer.json")] }
    ]
  },
  large: {
    id: "qwen3-embedding-0.6b-int8",
    label: "Qwen3-Embedding-0.6B",
    pooling: "last",
    query: (t) => `Instruct: Given a passage of study material, retrieve the names of knowledge points it covers\nQuery:${t}`,
    doc: (t) => t,
    files: [
      { name: "model.onnx", bytes: 613527631, sha256: "87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f", urls: [ms("onnx-community/Qwen3-Embedding-0.6B-ONNX", "onnx/model_quantized.onnx"), hf("onnx-community/Qwen3-Embedding-0.6B-ONNX", "onnx/model_quantized.onnx")] },
      { name: "tokenizer.json", bytes: 11423705, sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a", urls: [ms("onnx-community/Qwen3-Embedding-0.6B-ONNX", "tokenizer.json"), hf("onnx-community/Qwen3-Embedding-0.6B-ONNX", "tokenizer.json")] }
    ]
  }
};
// api 档按 AI 预设给缺省向量模型（用户可在设置里改）
const API_DEFAULT_MODEL = { siliconflow: "BAAI/bge-m3", openai: "text-embedding-3-small", local: "bge-m3" };
const MODES = ["none", "small", "large", "api"];

let DATA_DIR = null;
function configure({ dataDir }) {
  DATA_DIR = dataDir;
}
function modelsDir() {
  if (!DATA_DIR) DATA_DIR = require("electron").app.getPath("userData");
  return path.join(DATA_DIR, "models");
}
const dirOf = (id) => path.join(modelsDir(), id);

function settings() {
  const s = readSettings().app?.kgVector || {};
  return { mode: MODES.includes(s.mode) ? s.mode : "none", apiModel: typeof s.apiModel === "string" ? s.apiModel.trim() : "" };
}

function filesPresent(id, files) {
  return files.every((f) => {
    try {
      return fs.statSync(path.join(dirOf(id), f.name)).size === f.bytes;
    } catch {
      return false;
    }
  });
}
function installed(tier) {
  const t = TIERS[tier];
  return Boolean(t) && filesPresent(t.id, t.files) && filesPresent(RUNTIME.id, RUNTIME.files);
}

let downloading = null; // { tier, received, total, abort }
let lastError = null; // 最近一次推理 / 接口失败（设置页显示；失败时召回已静默退回字面档）

async function status() {
  const s = settings();
  let ai = null;
  try {
    ai = await require("./ai").getAIConfig();
  } catch {
    ai = null;
  }
  const preset = ai ? ai.preset : "";
  const apiModel = s.apiModel || API_DEFAULT_MODEL[preset] || "";
  const size = (t) => t.files.reduce((n, f) => n + f.bytes, 0) + (filesPresent(RUNTIME.id, RUNTIME.files) ? 0 : RUNTIME.files.reduce((n, f) => n + f.bytes, 0));
  return {
    mode: s.mode,
    tiers: Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [k, { label: t.label, installed: installed(k), downloadBytes: size(t) }])),
    api: { preset, presetName: ai?.presetName || preset, model: apiModel, usable: Boolean(ai && (ai.hasKey || preset === "local") && apiModel) },
    downloading: downloading ? { tier: downloading.tier, received: downloading.received, total: downloading.total } : null,
    lastError,
    // 用户手动合并过重复知识点的次数（图谱页「可以开启语义匹配」轻提示的唯一触发信号）
    manualMerges: db().listKgEvents({}).filter((e) => e.kind === "merged" && e.payload && e.payload.manual).length
  };
}

function setMode(mode, opts) {
  if (!MODES.includes(mode)) throw new Error("未知语义匹配档：" + mode);
  if ((mode === "small" || mode === "large") && !installed(mode)) throw new Error("该档模型尚未下载");
  if (mode === "api" && !(opts && String(opts.apiModel || "").trim()) && !settings().apiModel) throw new Error("请先填写向量模型名");
  const all = readSettings();
  all.app = all.app || {};
  const prev = all.app.kgVector || {};
  all.app.kgVector = { ...prev, mode };
  if (opts && typeof opts.apiModel === "string") all.app.kgVector.apiModel = opts.apiModel.trim().slice(0, 200);
  writeSettings(all);
  engine = null;
  return status();
}

// ---------- 下载（断点续传 + SHA-256 校验；多源依次尝试） ----------

async function fetchToFile(urls, dest, expected, onChunk, signal) {
  const { pickFetch } = require("./aiTransport");
  const fetchFn = pickFetch();
  const part = dest + ".part";
  let lastErr = null;
  for (const url of urls) {
    try {
      let start = 0;
      try {
        start = fs.statSync(part).size;
      } catch {
        start = 0;
      }
      if (start > expected.bytes) {
        fs.rmSync(part, { force: true });
        start = 0;
      }
      if (start < expected.bytes) {
        const res = await fetchFn(url, { headers: start ? { Range: `bytes=${start}-` } : {}, redirect: "follow", signal });
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
        if (start && res.status !== 206) {
          start = 0; // 源不支持续传：重下
          fs.rmSync(part, { force: true });
        }
        const out = fs.createWriteStream(part, { flags: start ? "a" : "w" });
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", r));
            onChunk(value.byteLength);
          }
        } finally {
          await new Promise((r) => out.end(r));
        }
      }
      const h = crypto.createHash("sha256");
      await new Promise((resolve, reject) => fs.createReadStream(part).on("data", (d) => h.update(d)).on("end", resolve).on("error", reject));
      const got = h.digest("hex");
      if (got !== expected.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error("校验失败（文件不完整或被篡改）");
      }
      fs.renameSync(part, dest);
      return;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("下载失败");
}

async function download(tier, onProgress) {
  const t = TIERS[tier];
  if (!t) throw new Error("未知档：" + tier);
  if (downloading) throw new Error("已有下载在进行");
  const jobs = [...RUNTIME.files.map((f) => ({ f, id: RUNTIME.id })), ...t.files.map((f) => ({ f, id: t.id }))].filter(
    ({ f, id }) => !filesPresent(id, [f])
  );
  const ctrl = new AbortController();
  downloading = { tier, received: 0, total: jobs.reduce((n, j) => n + j.f.bytes, 0), abort: () => ctrl.abort() };
  // 续传：已下的部分计入进度
  for (const { f, id } of jobs) {
    try {
      downloading.received += fs.statSync(path.join(dirOf(id), f.name + ".part")).size;
    } catch {
      /* 无半截文件 */
    }
  }
  try {
    for (const { f, id } of jobs) {
      fs.mkdirSync(dirOf(id), { recursive: true });
      await fetchToFile(f.urls, path.join(dirOf(id), f.name), f, (n) => {
        downloading.received += n;
        if (onProgress) onProgress({ tier, received: downloading.received, total: downloading.total });
      }, ctrl.signal);
    }
  } finally {
    downloading = null;
  }
  return status();
}

function cancelDownload() {
  if (downloading) downloading.abort();
  return true;
}

function remove(tier) {
  const t = TIERS[tier];
  if (!t) throw new Error("未知档：" + tier);
  if (settings().mode === tier) setMode("none");
  fs.rmSync(dirOf(t.id), { recursive: true, force: true });
  // 两个本地档都没了：引擎也删
  if (!Object.keys(TIERS).some((k) => k !== tier && filesPresent(TIERS[k].id, TIERS[k].files))) fs.rmSync(dirOf(RUNTIME.id), { recursive: true, force: true });
  return status();
}

// ---------- 推理 ----------

let engine = null; // { key, embed(texts, kind) }

async function localEngine(tier) {
  const t = TIERS[tier];
  const ort = require("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(dirOf(RUNTIME.id)).href + "/";
  const tk = await import("@huggingface/tokenizers");
  const Tokenizer = tk.Tokenizer || (tk.default && tk.default.Tokenizer);
  const tok = new Tokenizer(JSON.parse(fs.readFileSync(path.join(dirOf(t.id), "tokenizer.json"), "utf8")), {});
  const sess = await ort.InferenceSession.create(fs.readFileSync(path.join(dirOf(t.id), "model.onnx")));
  const one = async (text) => {
    let ids = Array.from(tok.encode(text).ids || []).slice(0, 256);
    if (t.pooling === "last") {
      const eos = tok.token_to_id ? tok.token_to_id("<|endoftext|>") : null;
      if (eos != null && ids[ids.length - 1] !== eos) ids = [...ids.slice(0, 255), eos];
    }
    const n = ids.length;
    const feeds = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, n]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from(new Array(n).fill(1n)), [1, n])
    };
    if (sess.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(n), [1, n]);
    if (sess.inputNames.includes("position_ids")) feeds.position_ids = new ort.Tensor("int64", BigInt64Array.from(ids.map((_, i) => BigInt(i))), [1, n]);
    // 解码器式导出（Qwen3）带 KV 缓存输入：一次性前向，喂空缓存（batch=1、past_sequence_length=0）
    for (const name of sess.inputNames) {
      if (!name.startsWith("past_key_values")) continue;
      const meta = (sess.inputMetadata || []).find((m) => m.name === name);
      const shape = (meta && meta.shape ? meta.shape : [1, 8, 0, 128]).map((d, i) => (typeof d === "number" ? d : i === 0 ? 1 : 0));
      feeds[name] = new ort.Tensor("float32", new Float32Array(0), shape);
    }
    const out = await sess.run(feeds);
    const h = out[sess.outputNames.includes("last_hidden_state") ? "last_hidden_state" : sess.outputNames[0]];
    const dim = h.dims[h.dims.length - 1];
    const v = new Float32Array(dim);
    if (t.pooling === "last") for (let j = 0; j < dim; j++) v[j] = h.data[(n - 1) * dim + j];
    else for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) v[j] += h.data[i * dim + j] / n;
    return normalize(v);
  };
  return {
    key: t.id,
    async embed(texts, kind) {
      const out = [];
      for (const x of texts) out.push(await one(kind === "query" ? t.query(x) : t.doc(x)));
      return out;
    }
  };
}

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}

async function apiEngine() {
  const st = await status();
  if (!st.api.usable) throw new Error("AI 服务未配置向量模型");
  const cfg = await require("./ai").getAIConfig();
  const { pickFetch } = require("./aiTransport");
  const url = cfg.baseUrl.replace(/\/$/, "") + "/embeddings";
  return {
    key: `api:${cfg.preset}:${st.api.model}`,
    async embed(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += 32) {
        const res = await pickFetch()(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify({ model: st.api.model, input: texts.slice(i, i + 32) })
        });
        if (!res.ok) throw new Error(`向量接口 HTTP ${res.status}`);
        const j = await res.json();
        for (const d of (j.data || []).sort((a, b) => a.index - b.index)) out.push(normalize(Float32Array.from(d.embedding)));
      }
      return out;
    }
  };
}

async function getEngine() {
  const s = settings();
  if (s.mode === "none") return null;
  const want = s.mode === "api" ? `api:${s.apiModel}` : s.mode;
  if (engine && engine.want === want) return engine;
  const e = s.mode === "api" ? await apiEngine() : installed(s.mode) ? await localEngine(s.mode) : null;
  if (!e) return null;
  engine = { ...e, want };
  return engine;
}

// ---------- 知识点向量缓存（learner.db kg_vectors；可删可重建） ----------

function kpText(r) {
  const aliases = (() => {
    try {
      return JSON.parse(r.alias_json || "[]");
    } catch {
      return [];
    }
  })();
  return [r.canonical_label, ...aliases].filter(Boolean).join(" / ") + (r.description ? `：${String(r.description).slice(0, 300)}` : "");
}

async function kpVectors(eng) {
  await learnerDb.open();
  const rows = db().kgActiveKpRows();
  const cached = new Map(
    (await learnerDb.all("SELECT kp_id, text_fp, vec FROM kg_vectors WHERE model_key = ?", [eng.key])).map((r) => [r.kp_id, r])
  );
  const out = new Map();
  const missing = [];
  for (const r of rows) {
    const text = kpText(r);
    const fp = crypto.createHash("sha1").update(text).digest("hex");
    const c = cached.get(r.id);
    if (c && c.text_fp === fp) out.set(r.id, new Float32Array(new Uint8Array(c.vec).buffer));
    else missing.push({ id: r.id, text, fp });
  }
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    const vecs = await eng.embed(batch.map((m) => m.text), "doc");
    await learnerDb.replaceBatch(
      null,
      "INSERT OR REPLACE INTO kg_vectors (kp_id, model_key, text_fp, vec) VALUES (?, ?, ?, ?)",
      batch.map((m, k) => [m.id, eng.key, m.fp, Buffer.from(vecs[k].buffer)])
    );
    batch.forEach((m, k) => out.set(m.id, vecs[k]));
  }
  if (missing.length) await learnerDb.save();
  return out;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** 余弦相似度 → 相对分（z 分数映射到 0..1；不同模型余弦分布不同，只看相对高低） */
function relScores(q, vecs) {
  const ids = [...vecs.keys()];
  const sims = ids.map((id) => dot(q, vecs.get(id)));
  const mean = sims.reduce((s, x) => s + x, 0) / (sims.length || 1);
  const sd = Math.sqrt(sims.reduce((s, x) => s + (x - mean) ** 2, 0) / (sims.length || 1)) || 1;
  return new Map(ids.map((id, i) => [id, Math.max(0, Math.min(1, ((sims[i] - mean) / sd - 1) / 2.5))]));
}

/** 【用户已有知识点】注入：none 档＝字面相近；向量档＝字面与语义取大者。失败静默退回字面档 */
async function relevantKpLabels(limit, text) {
  const d = db();
  if (!text) return d.recentKpLabels(limit);
  try {
    const eng = await getEngine();
    if (!eng) return d.recentKpLabels(limit, text);
    const vecs = await kpVectors(eng);
    if (vecs.size < 2) return d.recentKpLabels(limit, text);
    const [q] = await eng.embed([String(text).slice(0, 1500)], "query");
    lastError = null;
    return d.recentKpLabels(limit, text, relScores(q, vecs));
  } catch (e) {
    lastError = String((e && e.message) || e).slice(0, 300);
    return d.recentKpLabels(limit, text);
  }
}

/**
 * 归属裁决（G4）+ 语义提示：精确命中照旧；未命中的「新」名称，若向量档开启，给出最相近的已有知识点作为提示
 * （suggest，只提示不自动挂靠——向量不判定「同一个」）。
 */
async function resolveAttribution(items) {
  const d = db();
  const base = d.resolveKpAttribution(items);
  const need = base.filter((r) => !r.kpId && r.label);
  if (!need.length) return base;
  try {
    const eng = await getEngine();
    if (!eng) return base;
    const vecs = await kpVectors(eng);
    if (vecs.size < 3) return base;
    const labels = d.kgActiveKpRows();
    const labelOf = new Map(labels.map((r) => [r.id, r.canonical_label]));
    const qs = await eng.embed(need.map((r) => r.label), "doc");
    need.forEach((r, i) => {
      const sc = relScores(qs[i], vecs);
      let best = null;
      for (const [id, s] of sc) if (!best || s > best.s) best = { id, s };
      if (best && best.s >= 0.32) r.suggest = { kpId: best.id, label: labelOf.get(best.id) };
    });
  } catch (e) {
    lastError = String((e && e.message) || e).slice(0, 300); // 语义提示是增强：失败即不提示
  }
  return base;
}

module.exports = { configure, status, setMode, download, cancelDownload, remove, relevantKpLabels, resolveAttribution, TIERS, RUNTIME, _relScores: relScores };
