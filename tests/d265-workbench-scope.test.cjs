// @runtime: system-node
// 运行：node tests/d265-workbench-scope.test.cjs
// D265（v49.99）制卡台作用域收敛的静态契约：
//   ① 侧栏制卡台只出现在阅读上下文（reader / extractSession）；其余页面不挂 FreeWorkbenchHost、无顶栏入口、Ctrl+K 不响应；
//   ② 侧栏「图片挖空」走宿主内部截图源（captureRegion，不隐藏窗口）；仅独立制卡台窗口回落整屏 captureScreen；
//   ③ 阅读器工具栏截图钮及其动作组退役，功能由侧栏「图片挖空」继承。
// 行为与几何由 GUI 套件（d144 / d139）覆盖；本套件只锁源码契约，防止入口或截图源被改回去。
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

const src = (rel) => fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

const app = src("App.tsx");
const reader = src("components/Reader.tsx");
const extract = src("components/ExtractReviewView.tsx");
const free = src("components/FreeWorkbenchHost.tsx");
const hook = src("lib/useSelectionActions.ts");
const theme = src("theme.css");
const mainJs = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");

check("非阅读页不再挂 FreeWorkbenchHost（App 无 import / 渲染；独立窗口仍用）", () => {
  assert.ok(!/FreeWorkbenchHost/.test(app), "App.tsx 不应再引用 FreeWorkbenchHost");
  assert.ok(/import FreeWorkbenchHost/.test(src("workbench.tsx")), "独立制卡台窗口应继续使用 FreeWorkbenchHost");
});

check("顶栏「制卡台」入口受阅读上下文（reader / extractSession）门控", () => {
  assert.ok(
    /\{\(view\.name === "reader" \|\| view\.name === "extractSession"\) && \(/.test(app),
    "workbench-entry 应只在 reader / extractSession 渲染"
  );
  assert.ok(/data-testid="workbench-entry"/.test(app), "阅读器顶栏入口应保留");
});

check("Ctrl+K 只在阅读上下文响应（其余页面不 preventDefault）", () => {
  assert.ok(
    /const name = viewRef\.current\.name;[\s\S]{0,120}name !== "reader" && name !== "extractSession"/.test(app),
    "Ctrl+K 监听应对非阅读上下文直接返回"
  );
});

check("阅读器工具栏截图钮与动作组退役", () => {
  assert.ok(!/data-sel-act="capture"/.test(reader), "Reader 不应再有截图动作钮");
  assert.ok(!/handleCaptureReader/.test(reader), "Reader 不应再有 handleCaptureReader");
  assert.ok(!/selActionsGroup/.test(reader), "Reader 不应再有工具栏动作组");
  const readerCode = reader.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/reader-md-actions/.test(readerCode), "Reader 不应再渲染 markdown 动作组容器");
});

check("阅读器提供内部截图源（captureRegion，不隐藏窗口）并保留图片锚点", () => {
  assert.ok(/captureWorkbenchImage/.test(reader), "Reader 适配器应注入 captureWorkbenchImage");
  assert.ok(/captureRegion/.test(reader), "内部截图应走 assetsAPI.captureRegion");
  assert.ok(!/captureScreen/.test(reader), "阅读器侧栏不应再走整屏截图");
});

check("摘录复习页提供卡面内部截图源（captureRegion）", () => {
  assert.ok(/captureWorkbenchImage/.test(extract), "ExtractReviewView 适配器应注入 captureWorkbenchImage");
  assert.ok(/\.extract-face/.test(extract), "截图目标应是当前卡面 .extract-face");
  assert.ok(/captureRegion/.test(extract), "内部截图应走 assetsAPI.captureRegion");
  assert.ok(!/captureScreen/.test(extract), "摘录页侧栏不应再走整屏截图");
});

check("独立制卡台窗口不提供内部截图源（回落整屏 captureScreen）", () => {
  assert.ok(!/captureWorkbenchImage/.test(free), "FreeWorkbenchHost 不应注入 captureWorkbenchImage");
});

check("useSelectionActions：内部截图源优先、captureScreen 仅作回落", () => {
  assert.ok(/captureWorkbenchImage\?:/.test(hook), "适配器字段应存在");
  assert.ok(
    /const internal = A\(\)\.captureWorkbenchImage;[\s\S]{0,160}if \(internal\)[\s\S]{0,320}window\.assetsAPI\?\.captureScreen/.test(hook),
    "startWorkbenchCapture 应先派发宿主内部截图，再回落 captureScreen"
  );
  assert.ok(
    /（独立制卡台窗口|独立窗口）/.test(hook) && /captureScreen/.test(hook),
    "回落路径应注明仅服务独立制卡台窗口"
  );
});

check("工具栏容器样式随退役删除（theme.css 无 .reader-md-actions 规则）", () => {
  const clean = theme.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.reader-md-actions\s*\{/.test(clean), "theme.css 不应再有 .reader-md-actions 规则");
  assert.ok(!/\.reader-engine-divider\s*\{/.test(clean), "theme.css 不应再有 .reader-engine-divider 规则");
});

check("两条 IPC 契约保留：窗口内截图 + 独立窗口整屏截图", () => {
  assert.ok(/reader-capture:region/.test(mainJs), "reader-capture:region 应保留（侧栏图片挖空消费）");
  assert.ok(/screen-capture:start/.test(mainJs), "screen-capture:start 应保留（独立窗口消费）");
});

console.log(`\nD265 workbench scope: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
