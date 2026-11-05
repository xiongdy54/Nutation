// v48.100（D144 #9）制卡台 IA 重设计行为冒烟：唤坞默认 IA / 双页签草稿保活 / 跨页签幽灵双向 /
// 解释板块发送自动展开（AI 未配置降级链）/ 解释内容区选区三按钮选单 + 把手与坞收展状态保留。
// v48.101（D146）S3 按新契约改写：幽灵点击接受退役（Alt+Enter 唯一路径 + pointer-events:none +
// 点击穿透断言）+ 拒绝闩（目标框主动输入后同源不再提供，源变化后重新提供）。
// @runtime: node  @tier: 2  @gui: true  @id: D144  @timeout: 300
// 运行：npm run build 之后 `node tests/d144.gui.mjs`（CDP 驱动 dist 真实应用，自启自关）
// 隔离：M7_TEST_USERDATA 指向 tests/tmp-d144-userdata（先清空，全新库），绝不触碰真实库（§7.3）。
// D265（v49.99）：侧栏制卡台只在阅读上下文出现——先建一本粘贴书并打开阅读器，坞入口＝顶栏「制卡台」
// 按钮（workbench-entry）；书架/复习等非阅读页不再挂 FreeWorkbenchHost。
// 零网络：AI 未配置路径为确定性降级——发送后 catch 落「AI 服务尚未配置」错误面板（.ai-error），
// 该错误文本同时充当场景 5 选区三钮的选区素材（解释板块内容区内可选中文字）。
// 两窗口同步替代口径（交接包许可）：独立制卡台窗口（workbench.tsx）与主窗口共用同一
// SelectionPanels/CardDock 组件树——本套件在主窗口以 DOM testid 同构断言覆盖共享组件行为，
// 不另开第二窗口 CDP；窗口专属表现（引用后聚焦/光标落文末的窗口实例）不在本套件范围。
// 纪律：选择器全部取自方案 §10 DOM 契约（data-testid / aria / data-* 属性），禁断言类名与内联样式；
// 动效只断言终态（D120——不探测过渡中间帧）。
import { spawn } from "node:child_process";
import killProc from "./lib/killProc.cjs";
import fs, { openSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = "9250";
const USER_DATA = path.join(ROOT, "tests", "tmp-d144-userdata");
const BOOK = "FSRSTEST D144 验证书";
const BOOK_MD = "D144 制卡台回归夹具。";

let pass = 0, fail = 0;
function check(name, cond, actual) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} | 实际: ${String(actual).slice(0, 400)}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;

async function connect() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
        let id = 0;
        const pending = new Map();
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        });
        const send = (method, params = {}) => new Promise((res) => {
          const mid = ++id; pending.set(mid, res);
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
        const evalJS = async (expr) => {
          const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) return "EXC: " + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 300);
          return r.result?.result?.value;
        };
        return { ws, send, eval: evalJS };
      }
    } catch { /* 端口未就绪 */ }
    await wait(1000);
  }
  throw new Error("CDP 连接失败");
}

const parseState = (s) => { try { return JSON.parse(s); } catch { return {}; } };
// MarkdownEditor onChange 序列化值带尾随换行（PM textContent 无）——镜像/幽灵文本断言统一去尾随空白比对
const trimEnd = (s) => String(s ?? "").replace(/\s+$/, "");

// 手动首框＝紧凑档 Markdown 编辑器（ProseMirror contenteditable）：聚焦 + selectAll + insertText（d91-d92 同法）
const setPM = (sel, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return "no-el";
  el.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, ${JSON.stringify(value)});
  return "inserted";
})()`;
const clearPM = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return "no-el";
  el.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  return "cleared";
})()`;

// 受控 textarea（React 受控值——自由材料框 / composer 输入条）：原生 value setter + input 事件
const setTA = (sel, v) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return "no-el";
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "set";
})()`;

async function waitTrue(cdp, expr, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await cdp.eval(expr)) === true) return true;
    await wait(250);
  }
  return false;
}

// 解释内容区真实拖选（无人值守窗口里程序化选区可能因绘制器未聚焦而 toString() 为空；
// 与 SelectionMenu 的 GUI 套件同法走 CDP 鼠标事件，选中即会触发 document mouseup）
const explainSelGeo = `(() => {
  window.getSelection()?.removeAllRanges();
  const el = document.querySelector('[data-testid="wb-explain-body"] .ai-error, [data-testid="wb-explain-body"] .ai-answer');
  if (!el) return "";
  el.scrollIntoView({ block: "center" });
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.textContent || "").trim().length > 3) { node = walker.currentNode; break; }
  }
  if (!node) return "";
  const r = document.createRange();
  r.setStart(node, 0);
  r.setEnd(node, Math.min(node.textContent.length, 24));
  const rects = r.getClientRects();
  const first = rects[0], last = rects[rects.length - 1];
  if (!first || !last) return "";
  return JSON.stringify({ x1: first.left + 2, y1: first.top + first.height / 2, x2: last.right - 2, y2: last.top + last.height / 2, text: r.toString().slice(0, 16) });
})()`;

async function selectExplainText(cdp) {
  const geo = parseState(await cdp.eval(explainSelGeo));
  if (typeof geo.x1 !== "number") return "NO TEXT";
  const from = { x: geo.x1, y: geo.y1 };
  const to = { x: geo.x2, y: geo.y2 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await wait(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + ((to.x - from.x) * i) / 6,
      y: from.y + ((to.y - from.y) * i) / 6,
      button: "left",
      buttons: 1
    });
    await wait(30);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await wait(300);
  return "selected:" + (geo.text || "");
}

const FRONT_PM = '[data-card-dock] [data-testid="wb-manual-body"] .ProseMirror';

try {
  killProc(electron);
  await wait(800);
  fs.rmSync(USER_DATA, { recursive: true, force: true });

  const out = openSync(path.join(ROOT, "tests", "d144.gui.log"), "w");
  electron = spawn("npx", ["electron", ".", "--remote-debugging-port=" + PORT], {
    cwd: ROOT, shell: true, stdio: ["ignore", out, out], detached: process.platform !== "win32",
    env: { ...process.env, M7_TEST_USERDATA: USER_DATA }
  });
  const cdp = await connect();
  await wait(2500);
  check("应用启动（根节点挂载）", (await cdp.eval(`!!document.querySelector("#root")`)) === true, "未挂载");
  await cdp.eval("window.focus()"); // 无人值守运行时确保文档获得焦点（选区/剪贴板类断言需要）

  // ---------- S0 建书并打开阅读器（D265：侧栏制卡台只在阅读上下文出现） ----------
  console.log("== S0 建书并打开阅读器 ==");
  await cdp.eval(`(async () => JSON.stringify(await window.libraryAPI.createFromPaste(${JSON.stringify(BOOK)}, ${JSON.stringify(BOOK_MD)})))()`);
  await cdp.eval("window.location.reload()");
  await wait(3000);
  // D265：书架等非阅读页不渲染顶栏入口，Ctrl+K 不拦截（旧行为会 preventDefault 并请求开坞）
  const shelfGate = parseState(await cdp.eval(`JSON.stringify({
    entry: !!document.querySelector('[data-testid="workbench-entry"]'),
    dock: !!document.querySelector('[data-card-dock]'),
    prevented: (() => {
      const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    })()
  })`));
  check("书架页无制卡台入口，Ctrl+K 不拦截（D265）", shelfGate.entry === false && shelfGate.dock === false && shelfGate.prevented === false, JSON.stringify(shelfGate));
  const opened = await cdp.eval(`(() => {
    const t = [...document.querySelectorAll(".book-card")].find((x) => (x.getAttribute("title") || "").includes("D144") || (x.textContent || "").includes("D144"));
    if (!t) return "BOOK NOT FOUND";
    t.click();
    return "clicked";
  })()`);
  check("测试书打开（book-card 点击）", opened === "clicked", opened);
  // 书卡点击是异步取文档 + 建读书载荷；偶发落在书架挂载/过渡的首帧会被吞——按可见结果重试，不假定一次必成
  let readerReady = false;
  for (let i = 0; i < 8 && !readerReady; i++) {
    readerReady = await waitTrue(cdp, `!!document.querySelector('.reader-engine-layout, .reader-scroll')`, 2000);
    if (!readerReady) await cdp.eval(`document.querySelector('.book-card[title*="D144"]')?.click()`);
  }
  const s0diag = parseState(await cdp.eval(`JSON.stringify({
    reader: !!document.querySelector('.reader-engine-layout, .reader-scroll'),
    cards: document.querySelectorAll('.book-card').length,
    body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)
  })`));
  check("阅读器就绪（书卡点击后进入 reader 视图）", readerReady === true, JSON.stringify(s0diag));
  // 无人值守窗口可能不产帧：changeView 的原生 View Transition 会停在 data-vt=1（遮罩挡命中），
  // 先强制一帧让 finished 结算，再继续交互（真实聚焦窗口不需要这一步）。
  if ((await cdp.eval(`document.documentElement.dataset.vt || ""`)) === "1") {
    await cdp.send("Page.captureScreenshot", { format: "png" });
    await waitTrue(cdp, `!document.documentElement.dataset.vt`, 5000);
  }
  check("视图过渡已结算（无 data-vt 遮罩）", (await cdp.eval(`!document.documentElement.dataset.vt`)) === true, "data-vt 未清除");
  check("阅读器顶栏「制卡台」入口在场", (await waitTrue(cdp, `!!document.querySelector('[data-testid="workbench-entry"]')`, 15000)) === true, "入口未出现 | " + JSON.stringify(s0diag));

  // ---------- S1 唤坞与默认 IA（§2.1 / §4.1 默认态：手动制卡页签 + 解释板块收起） ----------
  console.log("== S1 唤坞与默认 IA ==");
  check("唤坞前坞未挂载（dockEverOpened 门控）", (await cdp.eval(`!!document.querySelector('[data-card-dock]')`)) === false, "不应在场");
  await cdp.eval(`document.querySelector('[data-testid="workbench-entry"]').click()`);
  await wait(800);
  const s1 = parseState(await cdp.eval(`JSON.stringify({
    dock: !!document.querySelector('[data-card-dock]'),
    collapsed: document.querySelector('[data-card-dock]')?.getAttribute('data-dock-collapsed'),
    wbOpen: document.documentElement.dataset.wbOpen === '1',
    tabManual: document.querySelector('[data-testid="wb-tab-manual"]')?.getAttribute('aria-selected'),
    tabAi: document.querySelector('[data-testid="wb-tab-aicards"]')?.getAttribute('aria-selected'),
    tablist: !!document.querySelector('[data-testid="wb-cards-tabs"][role="tablist"]'),
    bodyManual: !!document.querySelector('[data-testid="wb-manual-body"] .ProseMirror'),
    aiBodyHidden: (document.querySelector('[data-wb-tabbody="aicards"]')?.style.display || '') === 'none',
    types: document.querySelectorAll('[data-testid="manual-types"] [role="tab"]').length,
    emptyCards: !!document.querySelector('[data-dock-empty="cards"]'),
    freeMounted: !!document.querySelector('[data-testid="wb-free-source"] textarea'),
    explain: !!document.querySelector('[data-testid="wb-explain"]'),
    explainBody: !!document.querySelector('[data-testid="wb-explain-body"]'),
    handleAbsent: !document.querySelector('[data-testid="wb-explain-toggle"]'),
    modeBtns: document.querySelectorAll('[data-testid="wb-mode-bar"] [data-mode]').length,
    composer: !!document.querySelector('[data-testid="wb-composer"] textarea')
  })`));
  check("唤坞：制卡台挂载且展开（无收起标记）+ 正文让位", s1.dock && s1.collapsed === null && s1.wbOpen, JSON.stringify(s1));
  check("默认手动制卡页签（显式点击 > 内容派生）", s1.tabManual === "true" && s1.tabAi === "false", JSON.stringify({ m: s1.tabManual, a: s1.tabAi }));
  check("页签条 role=tablist + 手动表单挂点常驻", s1.tablist && s1.bodyManual, JSON.stringify(s1));
  check("AI 制卡页签体保活（display:none 挂载）+ 自由材料框 + 制卡空态", s1.aiBodyHidden && s1.freeMounted && s1.emptyCards, JSON.stringify(s1));
  check("题型页签 4 枚（问答/翻转/填空/图片挖空）", s1.types === 4, s1.types);
  check("解释板块恒在坞底：内容槽 + 按钮行 4 钮 + 输入条；无内容默认收起把手不在场", s1.explain && s1.explainBody && s1.modeBtns === 4 && s1.composer && s1.handleAbsent, JSON.stringify(s1));

  // ---------- S2 双向草稿与页签保活（§4.1 内容无损：两页签体常驻挂载） ----------
  console.log("== S2 双向草稿与页签保活 ==");
  await cdp.eval(setPM(FRONT_PM, "D144 草稿基线"));
  await wait(400);
  const front0 = await cdp.eval(`document.querySelector(${JSON.stringify(FRONT_PM)})?.textContent || ''`);
  check("手动首框可输入（ProseMirror insertText）", front0 === "D144 草稿基线", front0);
  await cdp.eval(`document.querySelector('[data-testid="wb-tab-aicards"]').click()`);
  await wait(300);
  const s2a = parseState(await cdp.eval(`JSON.stringify({
    tabAi: document.querySelector('[data-testid="wb-tab-aicards"]')?.getAttribute('aria-selected'),
    pmMounted: !!document.querySelector(${JSON.stringify(FRONT_PM)}),
    manualHidden: (document.querySelector('[data-wb-tabbody="manual"]')?.style.display || '') === 'none'
  })`));
  check("切 AI 制卡页签：手动表单体保活（display:none 不卸载）", s2a.tabAi === "true" && s2a.pmMounted && s2a.manualHidden, JSON.stringify(s2a));
  const freeSet = await cdp.eval(setTA('[data-testid="wb-free-source"] textarea', "D144 自由材料"));
  const freeVal = await cdp.eval(`document.querySelector('[data-testid="wb-free-source"] textarea')?.value || ''`);
  check("自由材料框受控输入（原生 setter + input 事件）", freeSet === "set" && freeVal === "D144 自由材料", freeVal);
  await cdp.eval(`document.querySelector('[data-testid="wb-tab-manual"]').click()`);
  await wait(300);
  const frontBack = await cdp.eval(`document.querySelector(${JSON.stringify(FRONT_PM)})?.textContent || ''`);
  check("切回手动：草稿无损", frontBack === "D144 草稿基线", frontBack);
  await cdp.eval(`document.querySelector('[data-testid="wb-tab-aicards"]').click()`);
  await wait(300);
  const freeBack = await cdp.eval(`document.querySelector('[data-testid="wb-free-source"] textarea')?.value || ''`);
  check("AI 侧自由材料跨页签保留", freeBack === "D144 自由材料", freeBack);

  // ---------- S3 跨页签幽灵草稿退役（v49.95 / D261：输入面不再有来源文字提示与 Alt+Enter 填入） ----------
  console.log("== S3 跨页签幽灵草稿退役 ==");
  await cdp.eval(setTA('[data-testid="wb-free-source"] textarea', ""));
  // 须先切回手动页签再写 PM：AI 页签下手动表单体 display:none，ProseMirror 无法聚焦
  await cdp.eval(`document.querySelector('[data-testid="wb-tab-manual"]').click()`);
  await wait(300);
  await cdp.eval(clearPM(FRONT_PM));
  await cdp.eval(setPM(FRONT_PM, "D144 幽灵源文"));
  await wait(400);
  await cdp.eval(`document.querySelector('[data-testid="wb-tab-aicards"]').click()`);
  await wait(300);
  const ghostA = parseState(await cdp.eval(`JSON.stringify({
    ghost: !!document.querySelector('[data-testid="wb-free-source"] .wb-ghost'),
    chip: !!document.querySelector('[data-testid="wb-free-source"] .wb-ghost-chip')
  })`));
  check("手动首框有字 + AI 侧空 → 自由材料框无幽灵层、无「Alt+Enter 填入」提示", !ghostA.ghost && !ghostA.chip, JSON.stringify(ghostA));
  await cdp.eval(`(() => {
    const ta = document.querySelector('[data-testid="wb-free-source"] textarea');
    if (!ta) return "no-el";
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
    return "sent";
  })()`);
  await wait(300);
  const s3b = parseState(await cdp.eval(`JSON.stringify({
    free: document.querySelector('[data-testid="wb-free-source"] textarea')?.value || ''
  })`));
  check("Alt+Enter 不再填入自由材料框（接受路径随幽灵机制退役）", s3b.free === "", JSON.stringify(s3b));
  // 反向：AI 侧有真实内容 + 手动首框空 → 手动首框也不出现提示
  await cdp.eval(setTA('[data-testid="wb-free-source"] textarea', "D144 自由源文"));
  await wait(200);
  await cdp.eval(`document.querySelector('[data-testid="wb-tab-manual"]').click()`);
  await wait(300);
  await cdp.eval(clearPM(FRONT_PM));
  await wait(400);
  const ghostB = parseState(await cdp.eval(`JSON.stringify({
    ghost: !!document.querySelector('[data-testid="wb-manual-body"] .wb-field .wb-ghost'),
    chip: !!document.querySelector('[data-testid="wb-manual-body"] .wb-field .wb-ghost-chip')
  })`));
  check("AI 侧有字 + 手动首框空 → 手动首框无幽灵层、无「Alt+Enter 填入」提示", !ghostB.ghost && !ghostB.chip, JSON.stringify(ghostB));
  await cdp.eval(`(() => {
    const f = document.querySelector('[data-testid="wb-manual-body"] .wb-field');
    if (!f) return "no-el";
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
    return "sent";
  })()`);
  await wait(300);
  const s3d = parseState(await cdp.eval(`JSON.stringify({
    front: document.querySelector(${JSON.stringify(FRONT_PM)})?.textContent || ''
  })`));
  check("Alt+Enter（手动侧）不再写入首框", s3d.front === "", JSON.stringify(s3d));
  // S3 结束后恢复手动首框草稿，供 S5「复制」断言「既有输入保留 + 永不覆盖」的追加语义
  await cdp.eval(setPM(FRONT_PM, "D144 幽灵源文"));
  await wait(400);

  // ---------- S4 解释板块发送与自动展开（§4.3：按钮行双职 + composer 受控；AI 未配置降级链） ----------
  console.log("== S4 解释板块发送与自动展开 ==");
  const compSet = await cdp.eval(setTA('[data-testid="wb-composer"] textarea', "D144 解释请求"));
  const compVal = await cdp.eval(`document.querySelector('[data-testid="wb-composer"] textarea')?.value || ''`);
  check("composer 输入条受控输入", compSet === "set" && compVal === "D144 解释请求", compVal);
  await cdp.eval(`document.querySelector('[data-testid="wb-mode-bar"] [data-mode="ste"]').click()`);
  const errIn = await waitTrue(cdp, `!!document.querySelector('[data-testid="wb-explain-body"] .ai-error')`, 15000);
  const errText = await cdp.eval(`document.querySelector('[data-testid="wb-explain-body"] .ai-error')?.textContent || ''`);
  check("按所选方式发送：AI 未配置确定性降级（错误面板落解释内容区，零网络）", errIn && String(errText).includes("尚未配置"), errText);
  const s4 = parseState(await cdp.eval(`JSON.stringify({
    open: document.querySelector('[data-testid="wb-explain-toggle"]')?.getAttribute('aria-expanded'),
    stePressed: document.querySelector('[data-testid="wb-mode-bar"] [data-mode="ste"]')?.getAttribute('aria-pressed'),
    composerCleared: (document.querySelector('[data-testid="wb-composer"] textarea')?.value || '') === ''
  })`));
  check("composer 发送 → 解释板块自动展开（§4.3 发送路由）", s4.open === "true", JSON.stringify(s4));
  check("方式按钮行迁移当前方式（aria-pressed）+ 发送后输入条清空", s4.stePressed === "true" && s4.composerCleared, JSON.stringify(s4));

  // ---------- S5 解释内容区选区三按钮选单（§4.4）+ 把手/坞收展状态保留 ----------
  console.log("== S5 选区三按钮选单 + 收展状态保留 ==");
  const sel1 = await selectExplainText(cdp);
  check("解释内容区拖选成功（触发素材＝降级错误文本）", String(sel1).startsWith("selected:"), sel1);
  await wait(200);
  // 选区可能被相邻渲染挤断（毫秒级竞态，与被测行为无关）——首次未触发则重选一次再判
  let s5a = parseState(await cdp.eval(`JSON.stringify({
    trio: !!document.querySelector('.dock-trio'),
    acts: ["aiCards", "copy", "quote"].filter((a) => !!document.querySelector('[data-trio-act="' + a + '"]')).length,
    place: document.querySelector('.dock-trio')?.getAttribute('data-place') || ''
  })`));
  if (!s5a.trio) {
    await selectExplainText(cdp);
    await wait(300);
    s5a = parseState(await cdp.eval(`JSON.stringify({
      trio: !!document.querySelector('.dock-trio'),
      acts: ["aiCards", "copy", "quote"].filter((a) => !!document.querySelector('[data-trio-act="' + a + '"]')).length,
      place: document.querySelector('.dock-trio')?.getAttribute('data-place') || ''
    })`));
  }
  check("选区上方出现三按钮选单且含 AI 制卡/复制/引用 三钮（§4.4）", s5a.trio && s5a.acts === 3, JSON.stringify(s5a));
  check("选单定位锚合法（prefer above / 放不下翻 below）", s5a.place === "above" || s5a.place === "below", s5a.place);
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await wait(250);
  const s5b = parseState(await cdp.eval(`JSON.stringify({
    trioGone: !document.querySelector('.dock-trio'),
    dockStillOpen: document.querySelector('[data-card-dock]')?.getAttribute('data-dock-collapsed') === null
  })`));
  check("Esc 关闭选单＝单层语义：坞不被连锁收起", s5b.trioGone && s5b.dockStillOpen, JSON.stringify(s5b));
  await selectExplainText(cdp);
  await wait(200);
  const trioBack = await cdp.eval(`!!document.querySelector('.dock-trio')`);
  check("选单可重复触发", trioBack === true, trioBack);
  await cdp.eval(`document.querySelector('[data-trio-act="quote"]').click()`);
  await wait(300);
  const s5d = parseState(await cdp.eval(`JSON.stringify({
    trioGone: !document.querySelector('.dock-trio'),
    composer: (document.querySelector('[data-testid="wb-composer"] textarea')?.value || '').slice(0, 40),
    open: document.querySelector('[data-testid="wb-explain-toggle"]')?.getAttribute('aria-expanded')
  })`));
  check("引用：输入条头部插入「> 引用块」且既有草稿保留其后", s5d.trioGone && s5d.composer.startsWith("> ") && s5d.composer.includes("尚未配置"), JSON.stringify(s5d));
  check("引用不自动开合解释板块（§4.4-c 板块保持原态）", s5d.open === "true", s5d.open);
  await selectExplainText(cdp);
  await wait(200);
  await cdp.eval(`document.querySelector('[data-trio-act="copy"]').click()`);
  await wait(300);
  const s5e = parseState(await cdp.eval(`JSON.stringify({
    trioGone: !document.querySelector('.dock-trio'),
    tabManual: document.querySelector('[data-testid="wb-tab-manual"]')?.getAttribute('aria-selected'),
    front: document.querySelector(${JSON.stringify(FRONT_PM)})?.textContent || ''
  })`));
  check("复制：追加写入手动首框（既有输入保留 + 永不覆盖）", s5e.trioGone && s5e.front.includes("D144 幽灵源文") && s5e.front.includes("尚未配置"), JSON.stringify(s5e));
  check("复制落点＝坞展开 + 切「手动制卡」页签", s5e.tabManual === "true", s5e.tabManual);
  await cdp.eval(`document.querySelector('[data-testid="wb-explain-toggle"]').click()`);
  await wait(400);
  const s5f = parseState(await cdp.eval(`JSON.stringify({
    open: document.querySelector('[data-testid="wb-explain-toggle"]')?.getAttribute('aria-expanded'),
    composerKept: (document.querySelector('[data-testid="wb-composer"] textarea')?.value || '').startsWith('> '),
    bodyKept: !!document.querySelector('[data-testid="wb-explain-body"] .ai-error')
  })`));
  check("把手收起：composer 引用草稿与内容区保留（状态不丢）", s5f.open === "false" && s5f.composerKept && s5f.bodyKept, JSON.stringify(s5f));
  await cdp.eval(`document.querySelector('[data-testid="wb-explain-toggle"]').click()`);
  await wait(400);
  const s5g = parseState(await cdp.eval(`JSON.stringify({
    open: document.querySelector('[data-testid="wb-explain-toggle"]')?.getAttribute('aria-expanded'),
    bodyKept: !!document.querySelector('[data-testid="wb-explain-body"] .ai-error')
  })`));
  check("把手再展开：内容保留", s5g.open === "true" && s5g.bodyKept, JSON.stringify(s5g));
  await cdp.eval(`(() => { const d = document.querySelector('[data-card-dock]'); d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc'; })()`);
  await wait(400);
  const s5h = parseState(await cdp.eval(`JSON.stringify({
    collapsed: document.querySelector('[data-card-dock]')?.getAttribute('data-dock-collapsed') === '1',
    frontKept: (document.querySelector(${JSON.stringify(FRONT_PM)})?.textContent || '').includes('D144 幽灵源文')
  })`));
  check("坞 Esc 收起（不卸载）：表单草稿保留", s5h.collapsed && s5h.frontKept, JSON.stringify(s5h));
  await cdp.eval(`document.querySelector('[data-testid="workbench-entry"]').click()`);
  await wait(500);
  const s5i = parseState(await cdp.eval(`JSON.stringify({
    open: document.querySelector('[data-card-dock]')?.getAttribute('data-dock-collapsed') === null,
    tabManual: document.querySelector('[data-testid="wb-tab-manual"]')?.getAttribute('aria-selected'),
    frontKept: (document.querySelector(${JSON.stringify(FRONT_PM)})?.textContent || '').includes('D144 幽灵源文')
  })`));
  check("再展开：回默认手动页签且草稿无损（收起 ≠ 关闭）", s5i.open && s5i.tabManual === "true" && s5i.frontKept, JSON.stringify(s5i));

  // ---------- S6 侧栏「图片挖空」＝应用内截图（D265；不隐藏窗口） ----------
  console.log("== S6 侧栏图片挖空（内部截图） ==");
  await cdp.eval(`window.focus()`);
  // 无人值守窗口可能被判定为遮挡而不产帧；先强制一次 CDP 截图唤醒合成器，再看 capturePage 是否可返回
  await cdp.send("Page.captureScreenshot", { format: "png" });
  await wait(300);
  const clickedOccl = await cdp.eval(`(() => {
    const tab = [...document.querySelectorAll('[data-testid="manual-types"] [role="tab"]')].find((b) => b.textContent.trim() === "图片挖空");
    if (!tab) return "NO TAB";
    tab.click();
    return "clicked";
  })()`);
  check("手动题型页签点「图片挖空」（不切表单，直接启动截图）", clickedOccl === "clicked", clickedOccl);
  // 无人值守窗口下 Electron capturePage 可能返回空（本机实测 captureRegion=null）：内部链路的确定性判据＝
  // 数秒内要么出现带 data:image 的编辑器，要么落「截图失败」toast；若误走整屏 captureScreen（隐藏窗口 +
  // 框选），两者都不会发生，等待超时即为失败。真实像素冒烟由人工在可见窗口补验（设计稿 §5.5）。
  const occlOrFail = await waitTrue(cdp, `!!document.querySelector('[data-testid="occlusion-editor"]') || (document.querySelector('.wb-toast')?.textContent || '').includes('截图失败')`, 20000);
  const s6 = parseState(await cdp.eval(`JSON.stringify({
    editor: !!document.querySelector('[data-testid="occlusion-editor"]'),
    img: document.querySelector('[data-testid="occlusion-editor"] img')?.getAttribute('src')?.slice(0, 22) || '',
    toast: document.querySelector('.wb-toast')?.textContent || '',
    dockStillOpen: document.querySelector('[data-card-dock]')?.getAttribute('data-dock-collapsed') === null
  })`));
  check(
    "侧栏「图片挖空」走内部 captureRegion 链（编辑器/失败 toast 秒级出现，不等整屏框选；侧栏仍在）",
    occlOrFail === true && (s6.editor ? s6.img.startsWith("data:image/") : String(s6.toast).includes("截图失败")) && s6.dockStillOpen,
    JSON.stringify(s6)
  );

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
} catch (err) {
  fail++;
  console.log("  ✗ 测试执行异常: " + (err && err.stack || err));
} finally {
  killProc(electron);
  process.exitCode = fail === 0 ? 0 : 1;
}
