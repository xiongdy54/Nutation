// EpubProvider — 按 AI_DEVELOPMENT_GUIDE.md §1/§附录B 锁定方案实现
// 解析: @likecoin/epub-ts；HTML→Markdown: turndown + DOMPurify（复用全局 Markdown 管线）
import ePub from "@likecoin/epub-ts";
import type { Book } from "@likecoin/epub-ts";
import TurndownService from "turndown";
import DOMPurify from "dompurify";

export interface EpubImportResult {
  title: string;
  markdown: string;
  toc: { title: string; href: string }[];
  coverDataUrl: string;
  epubData: Uint8Array;
  sourceName: string;
  /** D121 §1.1：OPF dc:creator（多值以「、」连接）；取不到为 undefined */
  author?: string;
}

/** D121 §1.1：作者元数据归一——string / {name: string | 语言表} / 以上的数组 → 「、」连接的字符串；空→undefined */
export function normalizeAuthor(v: unknown): string | undefined {
  const one = (x: unknown): string[] => {
    if (x == null) return [];
    if (typeof x === "string") return [x.trim()].filter(Boolean);
    if (Array.isArray(x)) return x.flatMap(one);
    if (typeof x === "object") {
      const name = (x as { name?: unknown }).name;
      if (typeof name === "string") return [name.trim()].filter(Boolean);
      if (name && typeof name === "object") {
        const vals = Object.values(name as Record<string, unknown>).filter((s): s is string => typeof s === "string" && !!s.trim());
        return vals.length ? [vals[0].trim()] : [];
      }
    }
    return [];
  };
  const out = [...new Set(one(v))].join("、").trim();
  return out || undefined;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

// ---------- 导入侧资源上限（F40 C-02 / C-20 / C-22）----------
// 解压炸弹的防御必须在**解压之前**：只读 ZIP 中央目录里声明的体积，不碰条目内容。
// 绝对值上限是主闸（与压缩比无关，重复度高的合法书也能过）；压缩比只作为超大条目的补充信号。
const MAX_EPUB_UNZIPPED_TOTAL_BYTES = 160 * 1024 * 1024;
const MAX_EPUB_UNZIPPED_ENTRY_BYTES = 96 * 1024 * 1024;
const MAX_EPUB_RATIO_GUARD_BYTES = 32 * 1024 * 1024;
const MIN_EPUB_RATIO_GUARD_BYTES = 64 * 1024;
const MAX_EPUB_COMPRESSION_RATIO = 400;
// turndown 的 join() 对「父节点子元素数」是二次方复杂度；逐块转写把单次规模压到常数级。
const MAX_TURNDOWN_BLOCK_CHILDREN = 500;
// 与 htmlImport 同口径的嵌套深度护栏（EPUB 章节同样是不可信 HTML）。
const MAX_EPUB_HTML_DEPTH = 128;
const MAX_EPUB_HTML_TAGS = 200000;
// 浏览器会隐式闭合这些元素：网页里大量不带 </p></li> 的写法不能被误判成「深度嵌套」。
const HTML_IMPLIED_END: Record<string, string[]> = {
  p: ["p"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"]
};

interface ZipCentralEntry {
  name: string;
  uncompressed: number;
  compressed: number;
}

/** 读 ZIP 中央目录（只读字节，不解压）。结构不可识别时返回 null，交给解析器自行报错。 */
function readZipCentralDirectory(bytes: Uint8Array): ZipCentralEntry[] | null {
  const len = bytes.length;
  if (len < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const stop = Math.max(0, len - 22 - 65535);
  for (let i = len - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > len) return null;
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (!count || cdOffset + 46 > len || cdOffset + cdSize > len) return null;
  const entries: ZipCentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= len; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) return null;
    const compressed = view.getUint32(p + 20, true);
    const uncompressed = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > len) return null;
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(p + 46, nameEnd)),
      uncompressed,
      compressed
    });
    p = nameEnd + extraLen + commentLen;
  }
  return entries;
}

function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

/** C-02：解压前按中央目录声明的体积拒绝炸弹；超限抛可读错误，不做部分解压。 */
function assertEpubArchiveWithinLimits(bytes: Uint8Array): void {
  const entries = readZipCentralDirectory(bytes);
  if (!entries) return; // 中央目录都没有：让解析器给出它自己的结构错误
  let total = 0;
  for (const e of entries) {
    if (!e.name || e.name.endsWith("/")) continue;
    if (e.uncompressed === 0xffffffff) {
      throw new Error("这本 EPUB 含 ZIP64 超大条目，暂不支持导入（条目声明体积超出常规 ZIP 范围）");
    }
    total += e.uncompressed;
    if (e.uncompressed > MAX_EPUB_UNZIPPED_ENTRY_BYTES) {
      throw new Error(
        `这本 EPUB 的单个条目「${e.name}」解压后约 ${formatMB(e.uncompressed)}，超过 ` +
          `${formatMB(MAX_EPUB_UNZIPPED_ENTRY_BYTES)} 的安全上限，已拒绝导入以免内存耗尽`
      );
    }
    if (
      e.uncompressed >= MAX_EPUB_RATIO_GUARD_BYTES &&
      e.compressed >= MIN_EPUB_RATIO_GUARD_BYTES &&
      e.compressed > 0 &&
      e.uncompressed / e.compressed > MAX_EPUB_COMPRESSION_RATIO
    ) {
      throw new Error(
        `这本 EPUB 的条目「${e.name}」压缩比异常（${Math.round(e.uncompressed / e.compressed)}:1，` +
          `解压后 ${formatMB(e.uncompressed)}），已拒绝导入以免内存耗尽`
      );
    }
  }
  if (total > MAX_EPUB_UNZIPPED_TOTAL_BYTES) {
    throw new Error(
      `这本 EPUB 解压后总大小约 ${formatMB(total)}，超过 ${formatMB(MAX_EPUB_UNZIPPED_TOTAL_BYTES)} 的` +
        `安全上限，已拒绝导入以免内存耗尽`
    );
  }
}

/** 章节 HTML 的嵌套深度/标签数预检：超限时降级为纯文本，绝不让递归序列化器爆栈。 */
function htmlExceedsBudget(html: string): boolean {
  const src = String(html || "");
  if (src.length > 8 * 1024 * 1024) return true;
  const stripped = src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const re = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/g;
  const stack: string[] = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  let tags = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const selfClosing = /\/\s*$/.test(m[3] || "");
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === name) {
          stack.length = i;
          break;
        }
      }
    } else if (!selfClosing && !voidTags.has(name)) {
      const implied = HTML_IMPLIED_END[name];
      if (implied) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (implied.includes(stack[i])) {
            stack.length = i;
            break;
          }
        }
      }
      stack.push(name);
      if (stack.length > MAX_EPUB_HTML_DEPTH) return true;
    }
    if (++tags > MAX_EPUB_HTML_TAGS) return true;
  }
  return false;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", times: "×", divide: "÷", copy: "©",
  reg: "®", trade: "™", deg: "°", plusmn: "±", sup2: "²", sup3: "³", frac12: "½", frac14: "¼",
  frac34: "¾", laquo: "«", raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§",
  para: "¶", bull: "•", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔"
};

/** 有界实体解码：只认已知命名实体与数字引用，未知原样保留（不吞正文）。 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{0,31});?/g, (m, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = HTML_ENTITIES[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** 结构过深时的降级路径：标签剥离 + 有界实体解码，保留可读正文。 */
function htmlToPlainText(html: string): string {
  const stripped = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeHtmlEntities(stripped).replace(/\s+/g, " ").trim();
}

/** 逐块 turndown：把单个父节点的子元素数压到常数级，避免 turndown.join() 的二次方开销。 */
function turndownInBlocks(root: DocumentFragment | Element): string {
  const doc = root.ownerDocument ?? document;
  const kids = Array.from(root.childNodes);
  const convert = (nodes: Node[]): string => {
    const box = doc.createElement("div");
    for (const n of nodes) box.appendChild(n.cloneNode(true));
    return turndown.turndown(box).trim();
  };
  if (kids.length <= MAX_TURNDOWN_BLOCK_CHILDREN) return convert(kids);
  const parts: string[] = [];
  for (let i = 0; i < kids.length; i += MAX_TURNDOWN_BLOCK_CHILDREN) {
    const part = convert(kids.slice(i, i + MAX_TURNDOWN_BLOCK_CHILDREN));
    if (part) parts.push(part);
  }
  return parts.join("\n\n");
}

function stripTags(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return (div.textContent || "").replace(/\s+/g, " ").trim();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function extractCover(book: Book): Promise<string> {
  interface ManifestItem { id?: string; href?: string; properties?: string[] }
  const pkg = (
    book as unknown as {
      packaging?: { coverPath?: string; manifest?: Record<string, ManifestItem> };
    }
  ).packaging;

  const candidates: string[] = [];
  try {
    if (pkg?.coverPath) candidates.push(pkg.coverPath);
  } catch { /* ignore */ }
  try {
    for (const item of Object.values(pkg?.manifest ?? {})) {
      if ((item.properties ?? []).includes("cover-image")) candidates.push(item.href || "");
      if (item.id === "cover") candidates.push(item.href || "");
      if (/cover\.(jpe?g|png|gif|webp|svg)$/i.test(item.href || "")) candidates.push(item.href || "");
    }
  } catch { /* ignore */ }

  for (const p of [...new Set(candidates.filter(Boolean))]) {
    try {
      const resolved = book.resolve(p);
      const blob = await book.archive?.getBlob(resolved);
      if (blob && blob.size > 0) return await blobToDataUrl(blob);
    } catch { /* try next candidate */ }
  }
  return "";
}

export async function importEpubFile(): Promise<EpubImportResult | null> {
  if (!window.libraryAPI) throw new Error("API 不可用");
  const picked = await window.libraryAPI.pickEpub();
  if (!picked) return null;
  return parseEpubBytes(picked.name, picked.data as Uint8Array);
}

/** M6-3（v30，D27）：由字节解析 EPUB（统一导入入口的 epub 分支；原 importEpubFile 保留兼容） */
export async function parseEpubBytes(name: string, rawBytes: Uint8Array): Promise<EpubImportResult> {
  const picked = { name: name || "book.epub", data: rawBytes };
  const raw = picked.data as Uint8Array;
  // C-02：解压炸弹在解压前拒绝（只读中央目录声明的体积）
  assertEpubArchiveWithinLimits(raw);
  const arrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength
  ) as ArrayBuffer;

  const book: Book = ePub(arrayBuffer);
  // C-22：book.ready 也把 navigation 等支路并在一起；不 await 它时仍要接住拒绝，
  // 否则库内部失败会让进程留下 unhandledRejection。
  void book.ready.catch(() => undefined);
  // C-22：@likecoin/epub-ts 的 loadNavigation 没有 catch——nav 文件缺失时
  // `loading.navigation` 永不 settle（book.ready 悬挂）且留下无人接手的 rejection。
  // 在 unpack 执行前把该方法包一层：目录不可用只丢目录，不阻塞正文。
  const bookPatchable = book as unknown as { loadNavigation?: (pkg: unknown) => Promise<unknown> };
  if (typeof bookPatchable.loadNavigation === "function") {
    const original = bookPatchable.loadNavigation.bind(book);
    // 用 then 包一层：即使原方法同步抛错，也统一收口为 resolve(undefined)。
    bookPatchable.loadNavigation = (pkg: unknown) =>
      Promise.resolve().then(() => original(pkg)).catch(() => undefined);
  }
  try {
    // 不 await book.ready（它把 navigation 也并进去了）；正文所需的元数据各自独立 settle。
    await Promise.all([book.loaded.manifest, book.loaded.spine, book.loaded.metadata]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`这本 EPUB 的结构无法解析：${msg}`);
  }

  const meta = book.packaging?.metadata;
  const coverDataUrl = await extractCover(book);

  // 目录加载仍可能有未 settle 的挂起（库内已 catch 拒绝），给一个上限，不拖住导入。
  let navTimer: ReturnType<typeof setTimeout> | undefined;
  const nav = await Promise.race([
    book.loaded.navigation.catch(() => undefined),
    new Promise<undefined>((resolve) => {
      navTimer = setTimeout(() => resolve(undefined), 3000);
    })
  ]);
  if (navTimer) clearTimeout(navTimer);
  const toc = (nav?.toc ?? []).map((t) => ({
    title: stripTags(t.label || ""),
    href: t.href || ""
  }));

  const spineItems = book.spine?.spineItems ?? [];
  let markdown = "";
  const failures: string[] = [];
  for (let i = 0; i < spineItems.length; i++) {
    const section = spineItems[i];
    try {
      // C-20：直接取章节 XHTML 文本，不建整章 DOM（section.load 会在 jsdom 里驻留一份完整文档）；
      // C-04：逐章容错，单章坏（目录谎报/条目缺失）只跳过该章，不连坐同包正常章。
      const sectionHtml = await book.load(section.href || section.url || "", "string");
      if (typeof sectionHtml !== "string") throw new Error("章节内容不可读");
      const base = (section.href || "").split("/").pop();
      const tocItem = toc.find((t) => t.href.split("/").pop() === base);
      const chapterTitle = tocItem?.title || `第 ${i + 1} 章`;
      let chapterMd: string;
      if (htmlExceedsBudget(sectionHtml)) {
        chapterMd = htmlToPlainText(sectionHtml);
      } else {
        const cleanDom = DOMPurify.sanitize(sectionHtml, {
          FORBID_TAGS: ["style", "script", "img", "link", "meta"],
          FORBID_ATTR: ["style", "class", "id"],
          RETURN_DOM: true
        });
        chapterMd = turndownInBlocks(cleanDom as unknown as DocumentFragment);
      }
      markdown += `\n\n# ${chapterTitle}\n\n${chapterMd}`;
    } catch (e) {
      failures.push(`第 ${i + 1} 章：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!markdown.trim()) {
    throw new Error(
      failures.length
        ? `未能从这本书中提取到文本内容（${failures.length} 章读取失败，首条：${failures[0]}）`
        : "未能从这本书中提取到文本内容"
    );
  }

  return {
    title: (meta?.title || picked.name.replace(/\.epub$/i, "")).trim(),
    markdown: markdown.trim(),
    toc,
    coverDataUrl,
    epubData: raw,
    sourceName: picked.name,
    author: normalizeAuthor((meta as { creator?: unknown; author?: unknown } | undefined)?.creator ?? (meta as { author?: unknown } | undefined)?.author)
  };
}

// ---------- 合成 EPUB（v20「一切皆书」）：粘贴书/摘录的 markdown 确定性转为 EPUB 字节，走统一阅读内核 ----------
// 确定性纪律：同 generatorVersion + 同输入必然产出字节级同构的章节结构——已存 CFI 永不因重新生成而错位。
// generatorVersion 变更 = 结构性变更（换解析器/章节化规则），旧锚点走「可降级恢复链」。
import MarkdownIt from "markdown-it";
import katex from "katex";
import JSZip from "jszip";
// KaTeX CSS 文本（Vite ?raw）：内嵌进合成书首页，公式排版无外部依赖
import katexCssText from "katex/dist/katex.min.css?raw";

/** djb2 确定性哈希（dc:identifier 生成禁用时间戳——合成书必须字节级可复现） */
function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// syn-3（§9.4「粘贴书合成 EPUB 的空首章」结构性清理）：splitMarkdownChapters 不再为「一级标题开头」
// 的输入压入空壳首章——结构性变更，`# ` 开头的粘贴书旧 CFI/chapterIndex 语义偏移（新章索引 = 旧索引 − 1），
// 按 §7.1.11 走可降级恢复链（§6.2：CFI→章节+文本→全文搜索→人工提示）；无 `# ` 开头的输入与 syn-2
// 结构逐字节同构，零影响。运行时无版本消费点：粘贴/导入书每次打开由 buildSyntheticEpub 现场重建
// （App.tsx loadReaderBook），版本号是 §7.1.11 的结构变更登记与测试契约，不构成门控。
export const SYNTH_GENERATOR_VERSION = "syn-3";

const synthMd: MarkdownIt = new MarkdownIt({ html: false, linkify: false, typographer: false });

// KaTeX 产物预算（F40 C-03 / C-21）：每个公式都会展开成一份自包含 HTML，
// 合法但密集的公式同样能把产物撑到 12 倍。超预算的公式保留 TeX 原文（纯文本），不抛异常。
const MAX_KATEX_FORMULAS = 800;
const MAX_KATEX_TEX_CHARS = 4000;
const MAX_KATEX_BRACE_DEPTH = 64;

/** 花括号最大嵌套深度（KaTeX 递归解析；1 万层会 RangeError）。 */
function maxBraceDepth(tex: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex.charCodeAt(i);
    if (c === 0x7b) {
      depth += 1;
      if (depth > max) max = depth;
    } else if (c === 0x7d && depth > 0) {
      depth -= 1;
    }
  }
  return max;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** markdown → 正文 HTML（KaTeX 服务端渲染为自包含 HTML+CSS，无脚本；占位符法避免被 markdown 转义） */
export function renderMarkdownToBodyHtml(markdown: string): string {
  const mathSlots: string[] = [];
  let renderedCount = 0;
  const stash = (tex: string, display: boolean, raw: string) => {
    let rendered: string | null = null;
    if (
      renderedCount < MAX_KATEX_FORMULAS &&
      tex.length <= MAX_KATEX_TEX_CHARS &&
      maxBraceDepth(tex) <= MAX_KATEX_BRACE_DEPTH
    ) {
      try {
        rendered = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" });
        renderedCount += 1;
      } catch {
        rendered = null; // 超深/超长公式：降级为原文，不得让整本书打不开
      }
    }
    const idx = mathSlots.push(rendered ?? escapeHtmlText(raw)) - 1;
    return `@@KATEX${idx}@@`;
  };
  // $$…$$（display，含多行）先行；再行内 $…$
  const withSlots = markdown
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => stash(String(tex).trim(), true, m))
    // A-6（审计）：原写法会把 `costs $5 and the box $10` 整段当行内公式，两个 $ 号被吞、正文被改写
    // （违反 §9.1 M6-1「正文不做任何改写」）。加边界守卫：开 $ 后不得紧跟数字或空白，闭 $ 前不得是空白。
    // 于是货币写法与裸 $ 不再被吞，`$x$` 这类真行内公式照旧。
    .replace(/\$(?![0-9\s])([^$\n]*?[^\s$])\$/g, (m, tex) => stash(String(tex).trim(), false, m));
  return synthMd.render(withSlots).replace(/@@KATEX(\d+)@@/g, (_m, i) => mathSlots[Number(i)] ?? "");
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SyntheticChapter {
  title: string;
  bodyHtml: string;
}

/** 按一级标题章节化（无一级标题 = 单章）；确定性：纯字符串运算 */
export function splitMarkdownChapters(markdown: string, fallbackTitle?: string): SyntheticChapter[] {
  const lines = String(markdown || "").split("\n");
  const chapters: SyntheticChapter[] = [];
  let cur: SyntheticChapter = { title: "", bodyHtml: "" };
  let buf: string[] = [];
  const flush = () => {
    cur.bodyHtml = renderMarkdownToBodyHtml(buf.join("\n"));
    chapters.push(cur);
  };
  for (const line of lines) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) {
      // syn-3（§9.4「粘贴书合成 EPUB 的空首章」）：markdown 以一级标题开头时，首个标题行触发的
      // flush 会压入一个 title/body 双空的空壳首章（目录多一项、阅读器首屏空白）。丢弃判定从严，
      // 三条同时成立才丢（缺一不可）：
      // ① chapters.length === 0 —— 只可能是首个标题触发的 flush，后续标题不受影响；
      // ② cur.title === "" —— 隐式首章尚未遇到任何「# 」行；标题行之后的章恒有标题，
      //    「# 前言」后紧跟下一标题的合法空首章有标题、不命中，绝不误删；
      // ③ buf 无任何非空行 —— 标题前只要有一行实际内容就保留为隐式前言章；纯空白行不算内容。
      // 该结构变更随 SYNTH_GENERATOR_VERSION 升 syn-3 登记（§7.1.11：旧锚点走可降级恢复链）。
      const isLeadingEmptyShell =
        chapters.length === 0 && cur.title === "" && !buf.some((l) => l.trim());
      if (!isLeadingEmptyShell) flush();
      cur = { title: m[1].trim(), bodyHtml: "" };
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  // v48.5（用户实测：导图出现「正文」伪节点）：无 # 标题的书整本成单章，标题用材料名——
  // 粘贴/导入书每次打开都由 buildSyntheticEpub 现场重建，存量书自动生效；真实「正文」标题（# 行）不受影响
  if (chapters.length === 1 && !chapters[0].title) chapters[0].title = (fallbackTitle || "").trim() || "正文";
  return chapters;
}

const xhtmlDoc = (title: string, bodyHtml: string, lang: string, extraStyle?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}">
<head><title>${escapeXml(title)}</title>
<meta charset="utf-8"/>
${extraStyle ? `<style>${extraStyle}</style>` : ""}
</head>
<body>
${bodyHtml}
</body></html>`;

/**
 * 生成合成 EPUB 字节 + 目录（供粘贴书/摘录进入统一阅读内核）。
 * KaTeX CSS 以 author style 内嵌首页（katex.min.css 体积可控且随书分发）。
 */
/** 合成书内嵌图片：filename 为 markdown 引用的相对名（img-0.png），bytes 为原始字节 */
export interface SynthImage {
  filename: string;
  bytes: Uint8Array;
  mediaType: string;
}

/** 章节 HTML 内 <img src> 重写：markdown 引用名 → EPUB 内部路径 images/<filename>（仅命中提供的文件名，其余原样） */
export function rewriteImgSrcs(bodyHtml: string, filenames: Set<string>): string {
  if (!filenames.size) return bodyHtml;
  return bodyHtml.replace(/(<img\b[^>]*?\ssrc=)("([^"]*)"|'([^']*)')/g, (m, head, _q, dq, sq) => {
    let src = (dq !== undefined ? dq : sq).trim();
    if (src.startsWith("./")) src = src.slice(2);
    if (!filenames.has(src)) return m;
    return `${head}"images/${src}"`;
  });
}

const imageExtMime: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp"
};

export function mediaTypeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return imageExtMime[ext] || "application/octet-stream";
}

/** 图片字节哈希后缀（仅有图时非空 → 无图 identifier 与 syn-1 恒等，CFI 稳定性不受影响） */
function imageHashSuffix(images: SynthImage[]): string {
  if (!images.length) return "";
  const parts = images.map((im) => {
    let h = 5381;
    for (let i = 0; i < im.bytes.length; i++) h = ((h << 5) + h + im.bytes[i]) >>> 0;
    return `${im.filename}:${h.toString(36)}`;
  });
  return "|imgs:" + parts.join(",");
}

export async function buildSyntheticEpub(
  title: string,
  markdown: string,
  opts?: { lang?: string; embedKatexCss?: boolean; images?: SynthImage[] }
): Promise<{ bytes: Uint8Array; toc: { label: string; href: string }[] }> {
  const lang = opts?.lang || "zh";
  const images = (opts?.images ?? []).filter((im) => im && im.filename && im.bytes && im.bytes.length > 0);
  const chapters = splitMarkdownChapters(markdown, title);
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );
  // 图片资源：文件名去重集合驱动 src 重写与 manifest 条目
  const imageNameSet = new Set(images.map((im) => im.filename));
  const manifestItems: string[] = [];
  const spineRefs: string[] = [];
  chapters.forEach((c, i) => {
    manifestItems.push(`    <item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spineRefs.push(`    <itemref idref="c${i}"/>`);
  });
  images.forEach((im, i) => {
    manifestItems.push(`    <item id="img${i}" href="images/${escapeXml(im.filename)}" media-type="${im.mediaType || mediaTypeForFilename(im.filename)}"/>`);
  });
  manifestItems.push('    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:synthetic-${stableHash(title + "\u0000" + markdown + imageHashSuffix(images))}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">2026-09-10T00:00:00Z</meta>
  </metadata>
  <manifest>
${manifestItems.join("\n")}
  </manifest>
  <spine>
${spineRefs.join("\n")}
  </spine>
</package>`
  );
  const tocLis = chapters
    .map((c, i) => `      <li><a href="c${i}.xhtml">${escapeXml(c.title || `第 ${i + 1} 章`)}</a></li>`)
    .join("\n");
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head><body>
<nav epub:type="toc" id="toc"><ol>
${tocLis}
</ol></nav>
</body></html>`
  );
  const katexCss = opts?.embedKatexCss === false ? "" : katexCssText;
  chapters.forEach((c, i) => {
    const bodyHtml = imageNameSet.size ? rewriteImgSrcs(c.bodyHtml, imageNameSet) : c.bodyHtml;
    // A-5（审计）：KaTeX 样式必须逐章注入——每章是独立 xhtml，只注首页则其余章拿不到样式，
    // 公式渲染成堆叠裸字形（历史上第 0 章恒是空壳章掩盖了这一点；syn-3 起空壳章已删、
    // §9.4「粘贴书空首章」清理完毕，逐章注入保持不变）。
    zip.file(`OEBPS/c${i}.xhtml`, xhtmlDoc(c.title || `第 ${i + 1} 章`, bodyHtml, lang, katexCss));
  });
  // 图片字节落包（OEBPS/images/，与 manifest href 对应）
  images.forEach((im) => {
    zip.file(`OEBPS/images/${im.filename}`, im.bytes);
  });
  const bytes = await zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip" });
  const toc = chapters.map((c, i) => ({ label: c.title || `第 ${i + 1} 章`, href: `c${i}.xhtml` }));
  return { bytes, toc };
}
