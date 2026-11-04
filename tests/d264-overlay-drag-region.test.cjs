// @runtime: system-node
// 运行：node tests/d264-overlay-drag-region.test.cjs
// D264 窗口拖拽区回归：无边框窗口的 -webkit-app-region: drag 是窗口级几何命中，忽略 z-index /
// 堆叠顺序——覆盖顶栏的全屏浮层若不声明 no-drag，浮层顶部控件（图片挖空工具条）会被拖拽带吞掉
// 点击，只剩露出带外的一小截可点（2026-11-04 用户实测）。程序化 .click() 不经过 OS 命中，
// GUI 套件抓不到这类缺陷，故在此锁住 CSS 契约。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name} | ${e?.message || e}`);
  }
}

const css = fs.readFileSync(path.join(__dirname, "..", "src", "theme.css"), "utf8");

/** 抽平坦规则块（theme.css 只有 @layer / @media / @keyframes 嵌套，选择器块本身均为平坦）；注释先剔除 */
function rules(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    out.push({ selectors, body: m[2] });
  }
  return out;
}
const all = rules(css);
const rulesFor = (selector) => all.filter((r) => r.selectors.includes(selector));

check("窗口拖拽源仍在（主窗口 .topbar / 独立制卡台 .wbw-bar）", () => {
  for (const sel of [".topbar", ".wbw-bar"]) {
    const matched = rulesFor(sel);
    assert.ok(matched.length, `${sel} 规则缺失`);
    assert.ok(matched.some((r) => /-webkit-app-region:\s*drag/.test(r.body)), `${sel} 应保持 drag`);
  }
});

check("覆盖顶栏的全屏浮层整层退出窗口拖拽区（no-drag）", () => {
  for (const sel of [".modal-backdrop", ".image-focus-layer", ".image-lightbox-backdrop", ".occlusion-editor-layer"]) {
    const matched = rulesFor(sel);
    assert.ok(matched.length, `${sel} 规则缺失`);
    assert.ok(matched.some((r) => /-webkit-app-region:\s*no-drag/.test(r.body)), `${sel} 缺 -webkit-app-region: no-drag`);
    assert.ok(matched.some((r) => /(^|[;{\s])app-region:\s*no-drag/.test(r.body)), `${sel} 缺 app-region: no-drag`);
  }
});

console.log(`\nD264 overlay drag region: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
