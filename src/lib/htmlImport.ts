// M6-3（v30）：HTML 文件导入转换（渲染层）
// 管线：DOMParser 解析 → @mozilla/readability 提取正文 → DOMPurify 清洗 → turndown（ATX + GFM 表格）→ markdown
// 回退链：Readability 返回 null（非文章页/结构异常）时整页 body 走同一 DOMPurify+turndown 管线，保证任意 HTML 可导入。
// 渲染层执行的理由：DOMParser/DOMPurify 是浏览器原生能力；主进程等价需 jsdom（不为单一功能引入运行时重依赖，
// jsdom 仅作测试 devDependency，见 tests/m6-3.test.cjs）。
// 规格：AI_DEVELOPMENT_GUIDE.md §9.1 M6-3。
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import DOMPurify from "dompurify";

// turndown（与 main-process importers.js 同配置：ATX 标题供合成管线章节切分）
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

// word 导入的表格 GFM 规则同源实现（HTML 表格在文章里常见：词表/对照表）
function tableToGfm(tableNode: Element): string {
  const rows = Array.from(tableNode.querySelectorAll("tr"));
  if (!rows.length) return "";
  const grid = rows.map((r) =>
    Array.from(r.querySelectorAll("th,td")).map((c) => {
      const t = String(c.textContent || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
      return t || " ";
    })
  );
  const cols = Math.max(...grid.map((r) => r.length));
  const pad = (row: string[]) => {
    const a = row.slice();
    while (a.length < cols) a.push(" ");
    return a;
  };
  const lines: string[] = [];
  lines.push("| " + pad(grid[0]).join(" | ") + " |");
  lines.push("|" + new Array(cols).fill(" --- ").join("|") + "|");
  for (let i = 1; i < grid.length; i++) lines.push("| " + pad(grid[i]).join(" | ") + " |");
  return lines.join("\n");
}

turndown.addRule("gfmTable", {
  filter: (node) => node.nodeName === "TABLE",
  replacement: (_content, node) => "\n\n" + tableToGfm(node as unknown as Element) + "\n\n"
});

/** 清洗配置：与 EPUB 导入同策略——剥脚本/样式/图片等非正文元素，禁 style/class/id 属性 */
const SANITIZE_CONFIG = {
  FORBID_TAGS: ["style", "script", "img", "link", "meta", "noscript", "iframe", "video", "audio", "form"],
  FORBID_ATTR: ["style", "class", "id", "onerror", "onload"]
};

// ---------- 敌意结构护栏（F40 C-03 / C-05）----------
// Readability / DOMPurify / turndown 都按 DOM 递归；5 万层嵌套会栈溢出或把导入拖到十几秒。
// 超深/超多标签的输入直接降级为纯文本（保留可读正文），不进入递归管线。
const MAX_HTML_DEPTH = 128;
const MAX_HTML_TAGS = 200000;
const MAX_HTML_CHARS = 8 * 1024 * 1024;
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

/** 迭代扫描标签深度与数量：不建 DOM、不递归，超限立即返回。 */
function htmlExceedsBudget(src: string): boolean {
  if (src.length > MAX_HTML_CHARS) return true;
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
      if (stack.length > MAX_HTML_DEPTH) return true;
    }
    if (++tags > MAX_HTML_TAGS) return true;
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

/** 有界实体解码：未知实体原样保留，不吞正文。 */
function decodeEntities(text: string): string {
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

function htmlToPlainText(html: string): string {
  const stripped = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

/**
 * 把病理级单字符长串收敛到短串。
 * 只在「可读字符（字母/数字/CJK）占比 < 5%」时启用——正常文章/代码即使偶有长分隔线也不改写；
 * 触发场景是 4 万个解不开的 `&` 或 5 万个 `×` 这类把正文挤没的解码产物。
 */
function collapseSymbolRuns(markdown: string): string {
  if (!markdown) return markdown;
  const readable = (markdown.match(/[\p{L}\p{N}]/gu) || []).length;
  if (readable >= markdown.length * 0.05) return markdown;
  return markdown.replace(/([^\s\p{L}\p{N}])\1{999,}/gu, (_m, ch: string) => ch.repeat(8));
}

export interface HtmlImportResult {
  title: string;
  markdown: string;
  /** 提取方式（诊断留痕）：readability=正文提取成功；fallback=整页回退 */
  via: "readability" | "fallback";
}

/** 由 html 文本提取书名：Readability 标题 → <title> → 首个一级标题 → 空 */
function deriveTitle(doc: Document, readTitle: string | null | undefined, markdown: string): string {
  const t = (readTitle || doc.title || "").trim();
  if (t) return t;
  const h1 = doc.querySelector("h1");
  if (h1?.textContent?.trim()) return h1.textContent.trim();
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m ? m[1].trim() : "";
}

/**
 * HTML 文件字节 → 文本（与主进程 decodeTextBytes 同策略：BOM → 严格 UTF-8 → GBK 回退）。
 * 渲染层 TextDecoder 走 Chromium full-ICU，GBK 可用；主进程那份走 Node 的 ICU。
 * 注意：HTML 常声明 charset（gb2312/gbk），严格 UTF-8 失败即 GBK 能覆盖绝大多数中文网页存档。
 */
export function decodeHtmlBytes(buf: Uint8Array): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      return new TextDecoder("utf-8").decode(buf);
    }
  }
}

/**
 * HTML 文件 → { title, markdown }（M6-3 主入口）。
 * 注意：调用方须在 DOM 可用的环境（渲染层）执行；纯函数化到「文本进、markdown 出」便于上下文理解。
 */
export function htmlToMarkdown(html: string): HtmlImportResult {
  const src = String(html || "");
  if (!src.trim()) return { title: "", markdown: "", via: "fallback" };

  // C-03：深嵌套/超大结构不进递归管线，直接降级为纯文本
  if (htmlExceedsBudget(src)) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(src);
    const plain = htmlToPlainText(src);
    return {
      title: decodeEntities((titleMatch?.[1] || "").replace(/\s+/g, " ").trim()),
      markdown: collapseSymbolRuns(plain),
      via: "fallback"
    };
  }

  const doc = new DOMParser().parseFromString(src, "text/html");

  // 回退链第 1 步：Readability 正文提取（article 结构）
  let markdown = "";
  let via: HtmlImportResult["via"] = "fallback";
  let readTitle: string | null = null;
  try {
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    if (article && (article.content || "").trim()) {
      const cleanHtml = DOMPurify.sanitize(article.content || "", SANITIZE_CONFIG);
      markdown = turndown.turndown(cleanHtml).trim();
      readTitle = article.title || null;
      via = "readability";
    }
  } catch {
    /* 落到整页回退 */
  }

  // 回退链第 2 步：整页 body（非文章页：列表页/说明页等）
  if (!markdown) {
    const cleanHtml = DOMPurify.sanitize(doc.body?.innerHTML ?? "", SANITIZE_CONFIG);
    markdown = turndown.turndown(cleanHtml).trim();
    via = "fallback";
  }

  // 尾部空行收敛 + 连续空白压缩（与合成管线输入整洁度要求一致）
  markdown = collapseSymbolRuns(markdown.replace(/\n{3,}/g, "\n\n").trim());
  return { title: deriveTitle(doc, readTitle, markdown), markdown, via };
}
