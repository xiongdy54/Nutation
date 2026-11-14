#!/usr/bin/env node
// 一致性机器闸门（C-35b，报告 C-35 修复步骤 2）。纯 Node、无依赖、亚秒级。
// 失败时退出码 1，并逐条打印「文件:行 规则 修法」。
//
// 9 条规则（报告 C-35 规则表 + 审计 F-11）：
//   1. src CSS 无未定义 Token（同 F09 E1 + setProperty 豁免；CSS 注释先剥离——注释里的
//      示例代码不算引用，报告快照后新出现的注释假阳性不据此放宽基线）。
//   2. 业务代码不写颜色字面量（#hex / rgb(a)( / hsl(a)(，跳过注释行）；
//      COLOR_ALLOW 豁免写在脚本顶部；其余文件按「文件 → 次数」棘轮。
//   3. !important 与内联 <svg> 只许变少（棘轮）。计数前剥注释——注释里提到 !important / <svg>
//      是文档措辞不是声明（CSS 走 stripCssComments；TS/TSX 走 stripJsComments 单遍扫描）。
//   4. 动效时长不写死在 JS/TS（C-32 已完成 → 目标 0）。
//   5. 编辑器白名单（docs/EDIT-CONTRACT.md：textarea 白名单 / contentEditable=0 /
//      ReactMarkdown 仅 ReadMarkdown.tsx；C-34 已完成 → 硬检查）。
//   6. 含 key === "Enter" 的文件必须同时含 isImeComposing（C-27 已完成 → 目标 0）。
//      已知例外（EDIT-CONTRACT.md 登记）：src/lib/dialogA11y.ts 的 document 级 Esc
//      处理器无 IME 守卫——该文件不含 Enter 分支，本规则天然不涉及；不得据弹窗层路径
//      报组件级违规。
//   7. :hover 里把 opacity 设为 1 的规则，目标类必须是 .reveal-on-hover（C-36 引入）；
//      报告意图＝「悬停才显示的操作必须有触控替代」（C-35 规则表第 7 行）。REVEAL_ALLOW
//      豁免写在脚本顶部（每条附证据）；其余新增一律改用 .reveal-on-hover 工具类
//      （src/theme.css「悬停显形工具类」节，约定 docs/UI-CONVENTIONS.md）。
//   8. 子进程调用 skin-audit 与 i18n-check，任一退出码非 0 即失败。
//   9. CSS 颜色字面量（F-11 闸门）：src/**/*.css 中，除「只定义自定义属性的 Token 块」、
//      `var(--x, fallback)` 回落位置、以及行内 consistency-allow: mask 注释豁免外，
//      #hex / rgb(a)() / hsl(a)() 一律计数；总数按棘轮只许变小（基线 0）。
//      传 `--css-color-check <file>` 可对单个文件独立扫描（供 tests/css-hygiene.test.cjs 使用）。
//
// 基线 scripts/consistency-baseline.json 只允许变小：
//   当前值 < 基线 → 提示 `node scripts/consistency-check.mjs --update-baseline` 收紧；
//   当前值 > 基线 → 失败（不提供任何「放宽」参数）。
"use strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts", "consistency-baseline.json");
const UPDATE = process.argv.includes("--update-baseline");
// 被 tests/css-hygiene.test.cjs 动态 import 时只取函数，不执行闸门主体 / 不退出进程
const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

// —— 规则 2 豁免：本来就「应该」含颜色值的文件（报告 C-35 证据 3）——
const COLOR_ALLOW = [
  /^src\/skins\/[^/]+\/manifest\.ts$/,
  /^src\/lib\/accentVar\.ts$/,
  /^src\/lib\/reader\/foliate\/appearance\.ts$/,
  // 结构流宿主：用 .flow-probe 把阅读主题 Token 解析成实色交给 SVG；这里的字面量只是
  // 「Token 未装载 / jsdom 无法求值 var()」时的回落色板（不是业务配色，皮肤可覆盖 Token 后即被解析值替换）
  /^src\/components\/reader\/flow\/StructureFlowHost\.tsx$/,
];
const isColorAllowed = (rel) => COLOR_ALLOW.some((re) => re.test(rel));

// —— 规则 7 豁免（C-36）：目标类含这些片段的 :hover{opacity:1} 规则不算「悬停才显示的
//     操作缺触控替代」。每条附证据（选择器 + 非悬停基础态 + 豁免理由）；新增悬停显形
//     一律用 .reveal-on-hover 工具类，不得扩本表——扩表须在 docs/UI-CONVENTIONS.md 登记。
// 豁免按「逗号拆分后的每个独立选择器」精确匹配，全部命中才放行——防止选择器列表里
// 夹带一个合规片段就把整条规则洗白（如 `.x:hover .y, .x:hover .evil { opacity: 1 }`）。
const REVEAL_ALLOW = [
  {
    // 报告 C-36 证据段原文判定「没有问题」：删除确认态有 .zitem.confirming .annot-acts
    // { opacity: 1 } 常显兜底（theme.css :3353）；控件本身不在本项收编范围（U-23 触屏走查范围外）。
    sel: ".annot-side .zitem:hover .annot-acts",
  },
  {
    // 同一条规则的 :focus-within 兄弟选择器：键盘可达的常显替代，与 :hover 同源豁免。
    sel: ".annot-side .zitem:focus-within .annot-acts",
  },
  {
    // 非操作控件：基础态 opacity:0 + pointer-events:none 的装饰性 chevron 提示（本体不可点）；
    // 操作本体＝翻页热区常在常可点。报告证据清单只列可操作控件。
    sel: ".reader-tap-zone:hover .reader-tap-hint",
  },
  {
    // 已有触控替代：基础态 opacity:0 与显形规则整体包在 @media (hover: hover) 内，
    // 无 hover 能力（触屏）时数据点常显（theme.css 该块注释自证）；图表 hover-dim
    // 强调效果，非可操作控件。
    sel: ".chart-svg:hover .chart-dot",
  },
  {
    // D266 选区浮条图标版自绘 tooltip——非操作控件：按钮本体常显、常可点，不依赖 hover
    // 才出现；tooltip 只是图标名称 / 快捷键的补充说明，名称同时由 aria-label 提供给读屏。
    // 只放行 tooltip 气泡本体（`::after` 必须出现在豁免选择器里）：按钮本体的
    // `:hover { opacity: 1 }` 不含 `::after`，不会被误放行。不做 [data-tip] 子串豁免。
    // :focus-visible 兄弟选择器同理——键盘聚焦时的等价气泡。
    sel: ".sel-btn.ic[data-tip]:hover::after",
  },
  {
    sel: ".sel-btn.ic[data-tip]:focus-visible::after",
  },
  {
    sel: ".form-seg[data-tip]:hover::after",
  },
  {
    sel: ".form-seg[data-tip]:focus-visible::after",
  },
];
const normalizeSelector = (s) => s.trim().replace(/\s+/g, " ");
const isRevealAllowed = (selector) =>
  selector
    .split(",")
    .map(normalizeSelector)
    .filter(Boolean)
    .every((part) => REVEAL_ALLOW.some((e) => part === e.sel));

// —— 规则 5 白名单：docs/EDIT-CONTRACT.md「保留的裸 <textarea> 白名单」（C-34d 登记，
//     含批注两处补登）——清单之外出现新 <textarea> 即违规。
const TEXTAREA_WHITELIST = [
  "src/components/SelectionPanels.tsx",
  "src/components/SelectionMenu.tsx",
  "src/components/learner/SelfExplainDialog.tsx",
  "src/components/editor/OcclusionEditor.tsx",
  "src/components/AIPanel.tsx",
  "src/components/AnswerJudgeModal.tsx",
  "src/components/editor/CardFields.tsx",
  "src/components/AnnotationEditor.tsx",
  "src/components/reader/AnnotationPanel.tsx",
];
const REACTMARKDOWN_ALLOW = "src/components/editor/ReadMarkdown.tsx";

// —— 规则 4 范围（报告 C-35 规则表第 4 条）——
const DURATION_SCOPES = ["src/lib/mindmap/", "src/components/reader/mindmap/", "src/components/reader/MindmapLens.tsx"];
const isDurationScope = (rel) => DURATION_SCOPES.some((s) => rel.startsWith(s) || rel === s);

function walk(dir, filter, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (["node_modules", "dist", "build", ".git", "vendor", "foliate"].includes(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, filter, acc);
    else if (filter(name)) acc.push(full);
  }
  return acc;
}
const relOf = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const lineAt = (text, idx) => text.slice(0, idx).split("\n").length;
const stripCssComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "");
/** 跳过注释行：整行以 // 、/* 或块注释续行 * 开头 */
const isCommentLine = (line) => {
  const s = line.trimStart();
  return s.startsWith("//") || s.startsWith("/*") || s.startsWith("*");
};

// —— 规则 9 辅助（F-11）：CSS 颜色字面量 ——
/** 把注释替换成等长空白（保留换行），使索引/行号与原文一致 */
function blankCssComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const CSS_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;

/** `var(--x, fallback)` 的回落段（相对 value 的区间；嵌套 var() 一并覆盖） */
function varFallbackRanges(value) {
  const ranges = [];
  const re = /\bvar\(/g;
  let m;
  while ((m = re.exec(value))) {
    const open = m.index + 3;
    let depth = 0;
    let comma = -1;
    for (let i = open; i < value.length; i++) {
      const c = value[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          if (comma >= 0) ranges.push([comma + 1, i]);
          break;
        }
      } else if (c === "," && depth === 1 && comma < 0) comma = i;
    }
  }
  return ranges;
}

/** 解析 CSS 规则块与声明（注释须先 blankCssComments；prelude 用于识别 Token 块） */
function parseCssDecls(text) {
  const blocks = [];
  const stack = [];
  let segStart = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") {
      const block = { prelude: text.slice(segStart, i).trim(), decls: [] };
      blocks.push(block);
      stack.push(block);
      segStart = i + 1;
      continue;
    }
    if (c === "}" || c === ";") {
      if (stack.length) {
        const raw = text.slice(segStart, i);
        const lead = raw.search(/\S/);
        if (lead >= 0) {
          const decl = raw.slice(lead);
          const colon = decl.indexOf(":");
          if (colon > 0) {
            const prop = decl.slice(0, colon).trim();
            if (/^(--[\w-]+|[a-zA-Z-]+)$/.test(prop)) {
              stack[stack.length - 1].decls.push({
                prop,
                value: decl.slice(colon + 1),
                valueStart: segStart + lead + colon + 1,
              });
            }
          }
        }
      }
      if (c === "}") stack.pop();
      segStart = i + 1;
      continue;
    }
  }
  return blocks;
}

/** 收集非豁免的 CSS 颜色字面量：跳过只有自定义属性的 Token 块、var() 回落、allow 行 */
function collectCssColorLiterals(text) {
  const bare = blankCssComments(text);
  const lines = text.split("\n");
  const hits = [];
  for (const block of parseCssDecls(bare)) {
    if (block.decls.length && block.decls.every((d) => d.prop.startsWith("--"))) continue;
    for (const d of block.decls) {
      const ranges = varFallbackRanges(d.value);
      CSS_COLOR_RE.lastIndex = 0;
      let m;
      while ((m = CSS_COLOR_RE.exec(d.value))) {
        if (ranges.some(([a, z]) => m.index >= a && m.index < z)) continue;
        const ln = lineAt(bare, d.valueStart + m.index);
        if ((lines[ln - 1] || "").includes("consistency-allow")) continue;
        hits.push({ line: ln, value: m[0], selector: block.prelude });
      }
    }
  }
  return hits;
}

// 单文件扫描模式（供 tests/css-hygiene.test.cjs 注入样例）：退出码＝是否仍有违规
const CSS_COLOR_CHECK = (() => {
  const i = process.argv.indexOf("--css-color-check");
  return i >= 0 ? process.argv[i + 1] : null;
})();
if (CSS_COLOR_CHECK) {
  const file = path.resolve(CSS_COLOR_CHECK);
  const hits = collectCssColorLiterals(fs.readFileSync(file, "utf8"));
  for (const h of hits) console.log(`${file}:${h.line} ${h.value}`);
  console.log(`[consistency] CSS 颜色字面量 ${hits.length} 处`);
  process.exit(hits.length ? 1 : 0);
}
/** 剥 JS/TS 注释（规则 3 专用，逐行扫描）。
 *  为什么不能直接套 stripCssComments：本仓有 9 处 `//` 注释里含块注释开符（skins 目录通配、
 *  `ui/` 事件名通配、foliate 豁免目录通配），块注释正则会把它们当开注释符、一路吞掉后面的
 *  **真实代码**，从而漏计真违规。为什么不用全文件单遍扫描：正则字面量里的引号
 *  （如 `.replace(/"/g, …)`、字符类白名单正则）会让引号状态失步并级联吞掉后续整段代码。
 *  折中＝块注释与模板字面量状态跨行传递，单/双引号状态**每行重置**——失步最多毁一行。
 *  字面量内容原样保留（模板里的真实 `<svg>` 照计），块注释换成一个空格、行注释保留换行，
 *  行号不变。棘轮口径：宁可多计（当场报错）不可少计（静默放行）。 */
function stripJsComments(t) {
  let inBlock = false;
  let inTemplate = false;
  const out = [];
  for (const line of t.split("\n")) {
    let s = "";
    let i = 0;
    let quote = inTemplate ? "`" : null;
    while (i < line.length) {
      const c = line[i];
      const d = line[i + 1];
      if (inBlock) {
        if (c === "*" && d === "/") { inBlock = false; i += 2; s += " "; } else i++;
        continue;
      }
      if (quote) {
        if (c === "\\") { s += line.slice(i, i + 2); i += 2; continue; }
        s += c;
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === "/" && d === "/") break;
      if (c === "/" && d === "*") { inBlock = true; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; s += c; i++; continue; }
      s += c;
      i++;
    }
    inTemplate = quote === "`";
    out.push(s);
  }
  return out.join("\n");
}

const tsFiles = walk(path.join(ROOT, "src"), (n) => /\.(ts|tsx)$/.test(n)).sort();
const cssFiles = walk(path.join(ROOT, "src"), (n) => n.endsWith(".css")).sort();
const tsx = tsFiles.map((p) => ({ p: relOf(p), t: fs.readFileSync(p, "utf8") }));
const css = cssFiles.map((p) => ({ p: relOf(p), t: fs.readFileSync(p, "utf8") }));

/** @type {{loc:string, rule:string, fix:string}[]} */
const violations = [];
const fail = (loc, rule, fix) => violations.push({ loc, rule, fix });

// ---------- 规则 1：无未定义 Token（同 F09 E1 + setProperty 豁免，注释已剥离） ----------
{
  const allCss = css.map((c) => stripCssComments(c.t)).join("\n");
  const defined = new Set([...allCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const setProp = new Set([...tsx.map((f) => f.t).join("\n").matchAll(/setProperty\(\s*[`'"](--[\w-]+)/g)].map((m) => m[1]));
  for (const c of css) {
    const text = stripCssComments(c.t);
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      const [, name, sep] = m;
      if (defined.has(name) || sep === "," || setProp.has(name)) continue;
      fail(`${c.p}:${lineAt(c.t, m.index)}`, "规则1 未定义Token", `var(${name}) 无定义且无回落——改用既有 Token 或补定义（TS setProperty 注入的 Token 已豁免）`);
    }
  }
}

// ---------- 规则 2：业务代码不写颜色字面量（按文件棘轮） ----------
const colorPerFile = {};
{
  const hexRe = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|\brgba?\(|\bhsla?\(/g;
  for (const f of tsx) {
    if (isColorAllowed(f.p)) continue;
    const lines = f.t.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      hexRe.lastIndex = 0;
      let m;
      while ((m = hexRe.exec(lines[i]))) hits.push(i + 1);
    }
    if (hits.length) colorPerFile[f.p] = hits;
  }
}
const colorCounts = Object.fromEntries(Object.entries(colorPerFile).map(([k, v]) => [k, v.length]));

// ---------- 规则 9：CSS 颜色字面量（F-11；Token 块 / var() 回落 / allow 豁免后计数） ----------
const cssColorHits = [];
for (const c of css) {
  for (const h of collectCssColorLiterals(c.t)) cssColorHits.push({ ...h, file: c.p });
}
const cssColorLiteralCount = cssColorHits.length;

// ---------- 规则 3：!important 与内联 <svg> 只许变少（计数前剥注释，注释里的提及不算声明） ----------
const importantCount = (css.map((c) => stripCssComments(c.t)).join("\n").match(/!important/g) || []).length;
const inlineSvgCount = (tsx.map((f) => stripJsComments(f.t)).join("\n").match(/<svg[\s>]/g) || []).length;

// ---------- 规则 4：动效时长不写死（C-32 后目标 0） ----------
{
  const durRe = /\b\w*(DUR|DURATION|ANIM)\w*\b\s*[:=]\s*-?\d|\bduration\s*:\s*-?\d/g;
  for (const f of tsx) {
    if (!isDurationScope(f.p)) continue;
    const lines = f.t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      durRe.lastIndex = 0;
      if (durRe.test(lines[i])) fail(`${f.p}:${i + 1}`, "规则4 动效时长写死", "改用动效 Token（theme.css :root 的 --mm-move/--mm-enter/--mm-exit，经 animate.readMotion() 读取）");
    }
  }
}

// ---------- 规则 5：编辑器白名单（C-34 后硬检查） ----------
{
  for (const f of tsx) {
    const lines = f.t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue; // 注释里的示例/措辞不算（commands.ts 头注提到 contentEditable 属文档措辞）
      if (lines[i].includes("<textarea") && !TEXTAREA_WHITELIST.includes(f.p)) {
        fail(`${f.p}:${i + 1}`, "规则5 textarea白名单", "卡片/摘录内容编辑用 MdField/ClozeField（CardFields.tsx）；确需裸 textarea 须先在 docs/EDIT-CONTRACT.md 白名单登记");
      }
      if (/contentEditable/.test(lines[i])) {
        fail(`${f.p}:${i + 1}`, "规则5 contentEditable", "contentEditable 裸壳已退役（C-34）——用 EditableField（读态渲染 + 点击进入编辑）");
      }
      if (lines[i].includes("<ReactMarkdown") && f.p !== REACTMARKDOWN_ALLOW) {
        fail(`${f.p}:${i + 1}`, "规则5 ReactMarkdown", "markdown 读态渲染统一走 src/components/editor/ReadMarkdown.tsx（sanitize + GFM）");
      }
    }
  }
}

// ---------- 规则 6：Enter 分支必须带 IME 守卫（C-27 后目标 0） ----------
{
  for (const f of tsx) {
    if (!/key\s*===\s*["']Enter["']/.test(f.t)) continue;
    if (!f.t.includes("isImeComposing")) {
      fail(f.p, "规则6 IME守卫", "onKeyDown 首行加 if (isImeComposing(e)) return;（src/lib/ime.ts，C-27 同款）");
    }
  }
}

// ---------- 规则 7：:hover 设 opacity:1 必须是 .reveal-on-hover（C-36 收编完成 → 目标 0） ----------
// 口径（C-36 收敛，登记于进度账 §3.42 偏离）：悬停显形一律走 .reveal-on-hover 工具类
// （触屏 (hover:none)/(pointer:coarse) 常显＝触控替代）；REVEAL_ALLOW 按独立选择器精确匹配
// （四类存量：annot-acts / reader-tap-hint / chart-dot / D266 tooltip，共 8 条选择器）
// 逐条证据见脚本顶部。工具类规则本体（选择器含 reveal-on-hover）天然放行。
let hoverOpacityCount = 0;
{
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const c of css) {
    const text = stripCssComments(c.t);
    let m;
    while ((m = blockRe.exec(text))) {
      const selector = m[1];
      const body = m[2];
      if (!/:hover/.test(selector)) continue;
      if (!/opacity\s*:\s*1(?![\d.])/i.test(body)) continue;
      if (selector.includes("reveal-on-hover")) continue;
      if (isRevealAllowed(selector)) continue;
      hoverOpacityCount++;
    }
  }
}

// ---------- 规则 8：皮肤审计 + i18n（子进程） ----------
const subAudits = [];
{
  for (const script of ["scripts/skin-audit.mjs", "scripts/i18n-check.mjs"]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, script)], { encoding: "utf8" });
    subAudits.push({ script, ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() });
    if (r.status !== 0) {
      fail(script, "规则8 子审计", `${script} 退出码 ${r.status}——先单独运行该脚本看逐条输出（存量红按归属处理，不在本闸门内代修）`);
    }
  }
}

// ---------- 基线对比（棘轮：只许变小） ----------
let baseline = {};
if (fs.existsSync(BASELINE_FILE)) {
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")); } catch { baseline = {}; }
}
const ratchetKeys = [];
/** 记录一条棘轮键：name → 当前值。返回违规与否 */
function ratchet(name, current, hint) {
  ratchetKeys.push([name, current]);
  const base = baseline[name];
  if (base === undefined || typeof base !== "number") {
    if (!UPDATE) fail(`scripts/consistency-baseline.json:${name}`, "规则基线缺失", `用 node scripts/consistency-check.mjs --update-baseline 建立基线（当前 ${current}）`);
    return;
  }
  if (current > base) {
    fail(`scripts/consistency-baseline.json:${name}`, "规则棘轮回退", `${name} 当前 ${current} > 基线 ${base}——${hint}`);
  }
}
ratchet("importantCount", importantCount, "回收新增的 !important（每处都要写受控例外）");
ratchet("inlineSvgCount", inlineSvgCount, "内联 <svg> 改走 src/components/icons.tsx 图标函数");
ratchet("hoverOpacityCount", hoverOpacityCount, "新增 hover 显形改用 .reveal-on-hover（C-36 工具类）；REVEAL_ALLOW 之外零存量（基线 0）");

for (const [file, count] of Object.entries(colorCounts)) {
  const base = baseline.colorLiterals?.[file];
  if (base === undefined || typeof base !== "number") {
    for (const line of colorPerFile[file]) {
      fail(`${file}:${line}`, "规则2 颜色字面量(新文件)", `该文件有 ${count} 处颜色字面量且无基线——改用设计 Token，或（仅限豁免口径）加入 COLOR_ALLOW`);
    }
  } else if (count > base) {
    for (const line of colorPerFile[file]) {
      fail(`${file}:${line}`, "规则2 颜色字面量", "改用设计 Token（--surface-*/--text-*/--border-* 族）；确属皮肤清单/强调色计算/EPUB 注入的合法色值须加入 COLOR_ALLOW");
    }
  }
}
for (const [file, base] of Object.entries(baseline.colorLiterals || {})) {
  if (!(file in colorCounts) && base > 0) {
    // 文件消失 → 违规自然消失；--update-baseline 时把该文件移出基线（只许变小）
  }
}

// 规则 9：CSS 颜色字面量（单一总数棘轮，只许变小）
{
  const base = baseline.cssColorLiterals;
  if (base === undefined || typeof base !== "number") {
    if (!UPDATE) {
      if (cssColorHits.length) {
        for (const h of cssColorHits) {
          fail(`${h.file}:${h.line}`, "规则9 CSS颜色字面量(新基线)", `改用设计 Token（或 var() 回落）；功能性色彩按行加 /* consistency-allow: mask */；当前 ${h.value}`);
        }
      } else {
        fail("scripts/consistency-baseline.json:cssColorLiterals", "规则基线缺失", "用 node scripts/consistency-check.mjs --update-baseline 建立基线（当前 0）");
      }
    }
  } else if (cssColorLiteralCount > base) {
    for (const h of cssColorHits) {
      fail(`${h.file}:${h.line}`, "规则9 CSS颜色字面量", `改用设计 Token（或 var() 回落）；当前总数 ${cssColorLiteralCount} > 基线 ${base}（${h.value}）`);
    }
  }
}

// ---------- 收紧提示 ----------
const tighten = [];
if (importantCount < (baseline.importantCount ?? Infinity)) tighten.push(`importantCount ${baseline.importantCount} → ${importantCount}`);
if (inlineSvgCount < (baseline.inlineSvgCount ?? Infinity)) tighten.push(`inlineSvgCount ${baseline.inlineSvgCount} → ${inlineSvgCount}`);
if (hoverOpacityCount < (baseline.hoverOpacityCount ?? Infinity)) tighten.push(`hoverOpacityCount ${baseline.hoverOpacityCount} → ${hoverOpacityCount}`);
if (cssColorLiteralCount < (baseline.cssColorLiterals ?? Infinity)) tighten.push(`cssColorLiterals ${baseline.cssColorLiterals} → ${cssColorLiteralCount}`);
for (const [file, base] of Object.entries(baseline.colorLiterals || {})) {
  const cur = colorCounts[file] ?? 0;
  if (cur < base) tighten.push(`colorLiterals[${file}] ${base} → ${cur}`);
}

// ---------- --update-baseline ----------
if (UPDATE) {
  const next = {
    ...baseline,
    importantCount,
    inlineSvgCount,
    hoverOpacityCount,
    cssColorLiterals: cssColorLiteralCount,
    colorLiterals: colorCounts,
  };
  // 只许变小：与现有基线逐键比较，任何变大都拒绝
  let relax = false;
  const relaxKeys = [];
  const cmp = (name, cur) => {
    if (typeof baseline[name] === "number" && cur > baseline[name]) { relax = true; relaxKeys.push(`${name} ${baseline[name]} → ${cur}`); }
  };
  cmp("importantCount", importantCount);
  cmp("inlineSvgCount", inlineSvgCount);
  cmp("hoverOpacityCount", hoverOpacityCount);
  cmp("cssColorLiterals", cssColorLiteralCount);
  // 基线已存在时，新出现的非零颜色文件不得写入基线（那是放宽——去修代码或走 COLOR_ALLOW）
  if (baseline.colorLiterals) {
    for (const [file, cur] of Object.entries(colorCounts)) {
      if (typeof baseline.colorLiterals[file] !== "number") { relax = true; relaxKeys.push(`colorLiterals[${file}] （新增）→ ${cur}`); }
      else cmp(`colorLiterals[${file}]`, cur);
    }
  }
  if (relax) {
    console.error("[consistency] 拒绝更新基线——检测到放宽（基线只允许变小）：");
    for (const k of relaxKeys) console.error(`  - ${k}`);
    process.exit(1);
  }
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 2) + "\n");
  console.log(`[consistency] 基线已写入 ${path.relative(ROOT, BASELINE_FILE)}`);
  for (const t of tighten) console.log(`[consistency] 收紧：${t}`);
  if (!tighten.length) console.log("[consistency] 基线与当前值一致，无变化。");
  process.exit(0);
}

// ---------- 输出 ----------
if (IS_MAIN) {
  console.log(`[consistency] 规则1 未定义Token = ${violations.filter((v) => v.rule.startsWith("规则1")).length}`);
  console.log(`[consistency] 规则2 颜色字面量文件数 = ${Object.keys(colorCounts).length}（豁免口径外）`);
  console.log(`[consistency] 规则3 !important = ${importantCount} / 内联<svg> = ${inlineSvgCount}`);
  console.log(`[consistency] 规则4 动效时长写死 = ${violations.filter((v) => v.rule.startsWith("规则4")).length}`);
  console.log(`[consistency] 规则5 编辑器白名单违规 = ${violations.filter((v) => v.rule.startsWith("规则5")).length}`);
  console.log(`[consistency] 规则6 IME守卫缺失 = ${violations.filter((v) => v.rule.startsWith("规则6")).length}`);
  console.log(`[consistency] 规则7 hover-opacity = ${hoverOpacityCount}（须为 0：显形走 .reveal-on-hover 或 REVEAL_ALLOW 豁免）`);
  console.log(`[consistency] 规则8 子审计 skin-audit=${subAudits[0].ok ? "OK" : "FAIL"} / i18n-check=${subAudits[1].ok ? "OK" : "FAIL"}`);
  console.log(`[consistency] 规则9 CSS颜色字面量 = ${cssColorLiteralCount}（Token 块 / var() 回落 / consistency-allow 豁免后）`);

  if (violations.length) {
    console.error(`\n[consistency] ${violations.length} 处违规：`);
    for (const v of violations) console.error(`  ${v.loc} ${v.rule} —— ${v.fix}`);
    process.exit(1);
  }
  if (tighten.length) {
    console.log("\n[consistency] 棘轮可收紧（只许变小）：node scripts/consistency-check.mjs --update-baseline");
    for (const t of tighten) console.log(`  - ${t}`);
  }
  console.log("[consistency] OK");
  process.exit(0);
}

export { collectCssColorLiterals };
