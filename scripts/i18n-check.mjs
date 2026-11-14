// v49.8（D182）：i18n 完整性检查——扫描源码 t()/tMain() 字面量键 × en/ja 词典比对缺漏。
// C-5 扩展：识别导入别名 / useT() 别名；扫描 electron/**/*.js 的 tMain 字面量；
// 单引号与无插值模板字面量同样计键；硬编码中文 JSX 文本按 scripts/i18n-baseline.json 棘轮（只许变小）。
// 用法：node scripts/i18n-check.mjs [--report] [--root <dir>]
// 退出码：缺漏 > 0 或硬编码计数超过基线 → 1（tests/i18n.test.cjs 消费同一实现作闸门）。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "release", ".git", "vendor"]);
const BASE_TRANSLATORS = ["t", "T", "tMain"];
const JSX_STRING_ATTRS = new Set(["title", "placeholder", "aria-label"]);
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
const LITERAL_PATTERN =
  '(?:"((?:[^"\\\\]|\\\\.)*)"' +
  "|'((?:[^'\\\\]|\\\\.)*)'" +
  '|`((?:\\\\.|[^`$\\\\]|\\$(?!\\{))*)`)';

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 词典以 TS 源形式维护——这里用轻量解析取键（与 esbuild bundle 路径互补：本脚本零构建、IDE/CI 直跑） */
function parseDictKeys(file) {
  const text = fs.readFileSync(file, "utf8");
  const keys = new Set();
  // 顶层条目形如：  "键": "值",  或  "键": { one, other },
  const re = /^\s{2}"((?:[^"\\]|\\.)+)":\s*(?:"|\{)/gm;
  let m;
  while ((m = re.exec(text))) keys.add(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  return keys;
}

/** 去掉注释但保留字符串/模板内容与换行（行号不变）；避免注释里的 t("…") 被计入 */
function stripComments(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      out += "  ";
      i += 2;
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      out += "  ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < text.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function decodeLiteral(s) {
  // 与 parseDictKeys 同口径：只还原引号/反斜杠；`\n` 等转义保留为源码原文，
  // 这样双引号字符串与词典键的写法差异不会造成假缺键。
  return s.replace(/\\(['"`\\])/g, "$1");
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function walkFiles(dir, accept, visit) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walkFiles(full, accept, visit);
    else if (accept(name)) visit(full);
  }
}

/** 收集本文件的翻译函数名：t/T/tMain + `import { t as tr }` + `const tr = useT()` 等 */
function collectTranslatorNames(src) {
  const names = new Set(BASE_TRANSLATORS);
  const hooks = new Set(["useT"]);
  const importRe = /\bimport\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  let m;
  while ((m = importRe.exec(src))) {
    for (const spec of m[1].split(",")) {
      const s = spec.trim().match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!s) continue;
      const original = s[1];
      const local = s[2] || s[1];
      if (BASE_TRANSLATORS.includes(original)) names.add(local);
      if (original === "useT") hooks.add(local);
    }
  }
  for (const hook of hooks) {
    const re = new RegExp(
      "\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" + escapeRe(hook) + "\\s*(?:<[^>]*>)?\\s*\\(",
      "g"
    );
    while ((m = re.exec(src))) names.add(m[1]);
  }
  const aliasRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(t|T|tMain)\s*(?:;|,|\n|$)/g;
  while ((m = aliasRe.exec(src))) names.add(m[1]);
  return names;
}

function collectLiteralCalls(text, names) {
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const re = new RegExp("\\b(?:" + alt + ")\\s*\\(\\s*" + LITERAL_PATTERN, "g");
  const starts = lineStarts(text);
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    const key = decodeLiteral(m[1] ?? m[2] ?? m[3] ?? "");
    found.push({ key, line: lineOf(starts, m.index) });
  }
  return found;
}

function addKey(keys, key, where) {
  if (!keys.has(key)) keys.set(key, []);
  const list = keys.get(key);
  if (list.length < 3 && !list.includes(where)) list.push(where);
}

/** 扫描 src/**\/*.ts(x) 的 t/T/tMain 与别名调用 */
export function extractKeys(srcRoot = path.join(ROOT, "src"), displayRoot = ROOT) {
  const keys = new Map();
  walkFiles(
    srcRoot,
    (n) => /\.(ts|tsx)$/.test(n),
    (file) => {
      const rel = path.relative(displayRoot, file).replace(/\\/g, "/");
      const text = stripComments(fs.readFileSync(file, "utf8"));
      for (const { key, line } of collectLiteralCalls(text, collectTranslatorNames(text))) {
        addKey(keys, key, `${rel}:${line}`);
      }
    }
  );
  return keys;
}

/** 扫描 electron/**\/*.js 的 tMain("…") 字面量键 */
export function extractMainKeys(electronRoot = path.join(ROOT, "electron"), displayRoot = ROOT) {
  const keys = new Map();
  walkFiles(
    electronRoot,
    (n) => n.endsWith(".js"),
    (file) => {
      const rel = path.relative(displayRoot, file).replace(/\\/g, "/");
      const text = stripComments(fs.readFileSync(file, "utf8"));
      for (const { key, line } of collectLiteralCalls(text, new Set(["tMain"]))) {
        addKey(keys, key, `${rel}:${line}`);
      }
    }
  );
  return keys;
}

function hasCjk(s) {
  return CJK_RE.test(s);
}

/**
 * C-5-c：硬编码中文 JSX 文本棘轮。
 * 计分单位＝一个 JSX 文本节点 / 一个 title|placeholder|aria-label 属性；
 * `{T("…")}` / `{t("…")}` 包住的表达式不算。注释与普通字符串字面量不算。
 */
export function countHardcodedCjkJsx(srcRoot = path.join(ROOT, "src"), displayRoot = ROOT) {
  const items = [];
  walkFiles(
    srcRoot,
    (n) => n.endsWith(".tsx"),
    (file) => {
      const rel = path.relative(displayRoot, file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf8");
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const translators = collectTranslatorNames(stripComments(text));
      const isTranslatorCall = (node) =>
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) && translators.has(node.expression.text);
      const expressionHasUnwrappedCjk = (node) => {
        if (isTranslatorCall(node)) return false;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return hasCjk(node.text);
        if (ts.isTemplateExpression(node)) {
          if (hasCjk(node.head.text)) return true;
          return node.templateSpans.some((span) => hasCjk(span.literal.text));
        }
        let found = false;
        ts.forEachChild(node, (child) => {
          if (!found && expressionHasUnwrappedCjk(child)) found = true;
        });
        return found;
      };
      const add = (node, kind) => {
        const pos = node.getStart(sf);
        const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
        items.push({ file: rel, line, kind });
      };
      const visit = (node) => {
        if (ts.isJsxText(node)) {
          if (hasCjk(node.text)) add(node, "jsx-text");
        } else if (ts.isJsxAttribute(node)) {
          const name = node.name.getText(sf);
          if (JSX_STRING_ATTRS.has(name) && node.initializer) {
            const init = node.initializer;
            const bad = ts.isStringLiteral(init)
              ? hasCjk(init.text)
              : ts.isJsxExpression(init) && init.expression
                ? expressionHasUnwrappedCjk(init.expression)
                : false;
            if (bad) add(node, `attr:${name}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  );
  return { count: items.length, items };
}

export function loadHardcodedBaseline(root = ROOT) {
  const file = path.join(root, "scripts", "i18n-baseline.json");
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isFinite(v?.hardcodedCjkJsx) ? v.hardcodedCjkJsx : 0;
  } catch {
    return 0;
  }
}

export function check(opts = {}) {
  const root = path.resolve(opts.root || ROOT);
  const used = extractKeys(path.join(root, "src"), root);
  for (const [key, where] of extractMainKeys(path.join(root, "electron"), root)) {
    for (const loc of where) addKey(used, key, loc);
  }
  const en = parseDictKeys(path.join(root, "src", "i18n", "locales", "en.ts"));
  const ja = parseDictKeys(path.join(root, "src", "i18n", "locales", "ja.ts"));
  const missingEn = [];
  const missingJa = [];
  for (const [k, where] of used) {
    if (!en.has(k)) missingEn.push(`${k}  ←  ${where.join(", ")}`);
    if (!ja.has(k)) missingJa.push(`${k}  ←  ${where.join(", ")}`);
  }
  const orphansEn = [...en].filter((k) => !used.has(k));
  const orphansJa = [...ja].filter((k) => !used.has(k));
  const hardcoded = countHardcodedCjkJsx(path.join(root, "src"), root);
  const baseline = loadHardcodedBaseline(root);
  return {
    root,
    total: used.size,
    missingEn,
    missingJa,
    orphansEn,
    orphansJa,
    hardcodedCjkJsx: hardcoded.count,
    hardcodedBaseline: baseline,
    hardcodedOver: Math.max(0, hardcoded.count - baseline),
    hardcodedItems: hardcoded.items
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(name + "="));
  return prefixed ? prefixed.slice(name.length + 1) : null;
}

/** CLI 主体（导出以便测试进程内调用；返回退出码） */
export function runCli(argv = process.argv.slice(2), log = console.log) {
  const root = argValue(argv, "--root");
  const r = check({ root: root || ROOT });
  log(`[i18n-check] t()/tMain() 字面量键 ${r.total} 个`);
  for (const x of r.missingEn) log(`  [en 缺] ${x}`);
  for (const x of r.missingJa) log(`  [ja 缺] ${x}`);
  log(
    `[i18n-check] 硬编码中文 JSX ${r.hardcodedCjkJsx} 处（基线 ${r.hardcodedBaseline}）`
  );
  if (r.hardcodedOver > 0) {
    for (const x of r.hardcodedItems) log(`  [硬编码中文] ${x.file}:${x.line} (${x.kind})`);
  } else if (r.hardcodedCjkJsx < r.hardcodedBaseline) {
    log(`  [提示] 低于基线 ${r.hardcodedBaseline - r.hardcodedCjkJsx} 处，可下调 scripts/i18n-baseline.json`);
  }
  if (argv.includes("--report")) {
    for (const x of r.orphansEn) log(`  [孤儿 en] ${x}`);
    for (const x of r.orphansJa) log(`  [孤儿 ja] ${x}`);
    if (r.hardcodedOver === 0) {
      for (const x of r.hardcodedItems) log(`  [硬编码中文] ${x.file}:${x.line} (${x.kind})`);
    }
  }
  if (r.missingEn.length || r.missingJa.length || r.hardcodedOver > 0) return 1;
  log("[i18n-check] OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
