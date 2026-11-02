// D259 端到端：复习卡揭示——3D 翻卡退役后，卡面不得残留任何 3D 零件（perspective / rotateY /
// backface-visibility），揭示＝换面瞬时 + 答案区 .review-back-a 自下 4px 升起淡入 120ms（--dur / --ease）。
// 断言口径同 D240：不看源码写了什么，只看真实应用里的计算样式与 getAnimations。
// @runtime: node  @tier: 2  @gui: true  @id: D259REVEAL  @timeout: 300
// 运行：npm run build 之后 `node tests/d259-reveal.gui.mjs`（CDP 驱动 dist 上的真实应用，自启自关；
// Linux 无显示环境用 `xvfb-run -a node tests/d259-reveal.gui.mjs`）
// 隔离：M7_TEST_USERDATA 指向 tests/tmp-d259-userdata（先清空，全新库），绝不触碰真实库（§7.3）。
// 夹具复用 D240 的播种脚本（三张新卡 + 一条到期摘录），本用例只取「卡一」做揭示采样。
import { spawn, execSync } from "node:child_process";
import killProc from "./lib/killProc.cjs";
import fs, { openSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = "9277";
const USER_DATA = path.join(ROOT, "tests", "tmp-d259-userdata");
const SANDBOX = process.platform === "linux" ? ["--no-sandbox"] : [];

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

const nav = (cdp, label) => cdp.eval(`(() => { const b = [...document.querySelectorAll(".nav-item")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); b?.click(); return !!b; })()`);
const CARD = ".review-flip";
/** 卡面快照：face＝卡面在场；text＝卡面文字（认是哪一张）；anim＝卡面计算 animationName */
const sample = async (cdp, sel) => JSON.parse(String(await cdp.eval(`(() => {
  const wrap = document.querySelector(".review-wrap");
  const face = wrap ? wrap.querySelector(${JSON.stringify(sel)}) : null;
  return JSON.stringify({
    face: !!face,
    anim: face ? getComputedStyle(face).animationName : null,
    text: face ? (face.textContent || "").replace(/\\s+/g, " ").slice(0, 60) : ""
  });
})()`)) || "{}");
async function waitText(cdp, sel, needle, ms = 6000) {
  const t0 = Date.now();
  let s = await sample(cdp, sel);
  while (!(s.face && s.text.includes(needle)) && Date.now() - t0 < ms) { await wait(30); s = await sample(cdp, sel); }
  return s;
}
const leave = async (cdp, label) => { await nav(cdp, label); await wait(900); };

try {
  killProc(electron);
  await wait(800);
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  const seeded = execSync(`npx electron ${SANDBOX.join(" ")} tests/d240-review-entry.gui.seed.cjs`, {
    cwd: ROOT, shell: true, encoding: "utf8",
    env: { ...process.env, M7_TEST_USERDATA: USER_DATA }
  });
  const idsLine = String(seeded).split("\n").find((l) => l.startsWith("SEEDED "));
  check("播种成功（三张新卡 + 一条到期摘录）", !!idsLine, String(seeded).slice(-160));

  const out = openSync(path.join(ROOT, "tests", "d240-review-entry.gui.log"), "w");
  electron = spawn("npx", ["electron", ...SANDBOX, ".", "--remote-debugging-port=" + PORT], {
    cwd: ROOT, shell: true, stdio: ["ignore", out, out], detached: process.platform !== "win32",
    env: { ...process.env, M7_TEST_USERDATA: USER_DATA }
  });
  const cdp = await connect();
  await wait(2500);
  check("应用启动", (await cdp.eval(`!!document.querySelector("#root")`)) === true, "未挂载");
  // 前置：分开处理（默认）——复习页只推闪卡，取队首卡一
  await cdp.eval(`(async () => { const cur = (await window.settingsAPI.get("app", "extracts")) || {}; await window.settingsAPI.set("app", "extracts", { ...cur, mergeIntoReview: false }); return true; })()`);
  await leave(cdp, "书架");
  await cdp.eval(`(() => { const b = [...document.querySelectorAll(".nav-item")].find((x) => x.textContent.trim() === "复习"); b?.click(); return !!b; })()`);
  const s0 = await waitText(cdp, CARD, "D240 卡一");
  check("⑧ 复习页停在卡一", s0.face && s0.text.includes("D240 卡一"), JSON.stringify(s0));

  /** 揭示采样：3D 零件是否彻底消失 + 答案区升起动画是否在播 */
  const probeReveal = `(() => {
    const flip = document.querySelector(".review-flip");
    const front = flip && flip.querySelector(".review-face:not(.review-back)");
    const back = flip && flip.querySelector(".review-back");
    const backA = flip && flip.querySelector(".review-back-a");
    const sess = document.querySelector(".review-session");
    if (!flip || !front || !back || !backA || !sess) return JSON.stringify({ missing: true });
    return JSON.stringify({
      perspective: getComputedStyle(sess).perspective,
      flipTransform: getComputedStyle(flip).transform,
      frontVis: getComputedStyle(front).visibility,
      backVis: getComputedStyle(back).visibility,
      backAAnim: getComputedStyle(backA).animationName,
      backAOpacity: getComputedStyle(backA).opacity,
      backATransform: getComputedStyle(backA).transform
    });
  })()`;
  const sampleReveal = async () => JSON.parse(String(await cdp.eval(probeReveal)) || "{}");

  const before = await sampleReveal();
  check("⑧ 揭示前：卡面在场", !before.missing, JSON.stringify(before));
  check("⑧ 揭示前：.review-session 无 perspective（3D 透视退役）", before.perspective === "none", JSON.stringify(before));
  check("⑧ 揭示前：.review-flip 无 transform（无 rotateY）", before.flipTransform === "none", JSON.stringify(before));
  check("⑧ 揭示前：正面可见 / 背面隐藏（visibility，非 display）", before.frontVis === "visible" && before.backVis === "hidden", JSON.stringify(before));

  await cdp.eval(`(() => { document.querySelector('[data-review-bar] [data-reveal]')?.click(); return true; })()`);
  await wait(40);
  const during = await sampleReveal();
  check("⑧ 揭示瞬间：答案区在播 reveal-rise（120ms）", during.backAAnim === "reveal-rise", JSON.stringify(during));
  check("⑧ 揭示瞬间：正面已隐藏、背面可见（换面瞬时）", during.frontVis === "hidden" && during.backVis === "visible", JSON.stringify(during));

  await wait(360);
  const after = await sampleReveal();
  const identity = after.backATransform === "none" || after.backATransform === "matrix(1, 0, 0, 1, 0, 0)";
  check("⑧ 揭示落定：答案区停在终态（opacity 1 / 位移归零）", after.backAOpacity === "1" && identity, JSON.stringify(after));
  check("⑧ 揭示后：.review-flip 计算 transform 仍为 none（无 3D 翻转）", after.flipTransform === "none", JSON.stringify(after));

  console.log(`\n==== d259-reveal.gui：${pass} 通过 / ${fail} 失败 ====`);
  try { cdp.ws.close(); } catch { /* 已断开 */ }
  killProc(electron);
  process.exit(fail > 0 ? 1 : 0);
} catch (e) {
  console.error("FATAL:", e?.message || e);
  killProc(electron);
  process.exit(1);
}
