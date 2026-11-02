// D260 单元测试：渲染层错误「按消息折叠 + 每分钟保底闸」与轮转硬上限兜底（纯 node，目录/时钟均注入）
// 运行：node tests/applog-dedupe.test.cjs
// 背景（2026-11-02 实机事故）：主窗口某 ResizeObserver 自激循环，8~50 条/秒同一条错误，
// 每条都经 IPC 追加写主日志 → 4 小时 31MB、轮转停摆、主进程被占死（托盘/快捷键失联）。
// 本节锁住两条防线：①同一条错误一个窗口只落一行；②任何来源每分钟最多 RATE_LIMIT_PER_MIN 条。
// @runtime: system-node  @id: D260LOG
const fs = require("fs");
const os = require("os");
const path = require("path");
const appLog = require("../electron/appLog");

let pass = 0;
let fail = 0;
function check(name, cond, actual) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} | 实际: ${String(actual).slice(0, 300)}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "applog-d260-"));
const readLog = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, appLog.LOG_FILE_NAME), "utf-8");
  } catch {
    return "";
  }
};
const rendererLines = (dir) => readLog(dir).split("\n").filter((l) => l.includes("[renderer]"));
const err = (message) => ({ kind: "error", message, source: "file:///app/dist/index.html", line: 0, col: 0 });

// 可拔插时钟：折叠按注入时间推进，测试不依赖真实等待
let clock = 1_000_000;
const now = () => clock;
const boot = (dir, extra = {}) => {
  appLog.init({ dir, version: "0.0.1", platform: "win32/x64", packaged: false, now, ...extra });
};

console.log("== 1) 同一条错误在窗口内只落一行，其余计入折叠数 ==");
{
  const dir = path.join(tmp, "s1");
  boot(dir, { repeatWindowMs: 30_000 });
  for (let i = 0; i < 5; i++) {
    appLog.logRendererError(err("ResizeObserver loop completed with undelivered notifications."));
    clock += 120;
  }
  const lines = rendererLines(dir);
  check("5 次相同错误 → 只写 1 行", lines.length === 1, JSON.stringify(lines));
  check("首行不含折叠标记", !lines[0].includes("已折叠"), lines[0]);
  check("消息原文与位置保留（诊断不丢）", lines[0].includes("ResizeObserver loop") && lines[0].includes("index.html:0:0"), lines[0]);
}

console.log("== 2) 窗口翻页：新行带上「上一窗口另有 N 次已折叠」 ==");
{
  const dir = path.join(tmp, "s2");
  clock = 1_000_000;
  boot(dir, { repeatWindowMs: 30_000 });
  for (let i = 0; i < 5; i++) {
    appLog.logRendererError(err("boom"));
    clock += 100;
  }
  clock += 30_000; // 越过折叠窗口
  appLog.logRendererError(err("boom"));
  const lines = rendererLines(dir);
  check("两个窗口 → 2 行", lines.length === 2, JSON.stringify(lines));
  check("第 2 行合并折叠计数（另有 4 次）", lines[1].includes("另有 4 次相同错误已折叠"), lines[1]);
}

console.log("== 3) 不同错误各自成行（折叠按 kind+位置+消息 精确匹配）==");
{
  const dir = path.join(tmp, "s3");
  clock = 1_000_000;
  boot(dir, { repeatWindowMs: 30_000 });
  appLog.logRendererError(err("A"));
  appLog.logRendererError(err("B"));
  appLog.logRendererError({ ...err("A"), source: "file:///app/dist/workbench.html" });
  const lines = rendererLines(dir);
  check("3 条互不相同的错误 → 3 行", lines.length === 3, JSON.stringify(lines));
}

console.log("== 4) 每分钟保底闸：不同消息也不能无限刷 ==");
{
  const dir = path.join(tmp, "s4");
  clock = 1_000_000;
  boot(dir, { repeatWindowMs: 30_000 });
  for (let i = 0; i < 200; i++) appLog.logRendererError(err(`err-${i}`));
  const lines = rendererLines(dir);
  check("1 分钟内 200 条不同错误 → 封顶 120 条", lines.length === 120, lines.length);
  check("被丢弃的是靠后的消息", !lines.some((l) => l.includes("err-150")), lines.slice(-1)[0]);
  clock += 61_000; // 下一分钟恢复
  appLog.logRendererError(err("after-window"));
  check("跨分钟后恢复写入", rendererLines(dir).length === 121, rendererLines(dir).length);
}

console.log("== 5) 轮转仍正常（小阈值触发 .1） ==");
{
  const dir = path.join(tmp, "s5");
  clock = 1_000_000;
  boot(dir, { maxBytes: 400, keepFiles: 2, repeatWindowMs: 30_000 });
  for (let i = 0; i < 20; i++) appLog.log("INFO", "test", `line-${i}-${"x".repeat(40)}`);
  check("生成 main.log.1", fs.existsSync(path.join(dir, "main.log.1")), dir);
  check("当前文件被压回阈值内", fs.statSync(path.join(dir, "main.log")).size < 4000, fs.statSync(path.join(dir, "main.log")).size);
}

console.log("== 6) 折叠表有界（大量不同消息不撑爆内存/不抛错） ==");
{
  const dir = path.join(tmp, "s6");
  clock = 1_000_000;
  boot(dir, { repeatWindowMs: 30_000 });
  let threw = null;
  try {
    for (let i = 0; i < 300; i++) {
      appLog.logRendererError(err(`m-${i}`));
      clock += 100;
    }
  } catch (e) {
    threw = e;
  }
  check("300 种消息无异常", threw === null, threw && threw.message);
  check("折叠表上限生效（写入条数 ≤ 保底闸）", rendererLines(dir).length <= 120, rendererLines(dir).length);
}

console.log(`\n==== applog-dedupe：${pass} 通过 / ${fail} 失败 ====`);
process.exit(fail > 0 ? 1 : 0);
