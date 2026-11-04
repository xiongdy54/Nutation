// 截图生成脚本：7 种结构全景版式高清图独立捕获（纯图特写，无软件外框）
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const { tmpUserDataDir, freshDir } = require(path.join(ROOT, "tests", "flows", "lib", "harness.cjs"));
const guienv = require(path.join(ROOT, "tests", "flows", "lib", "guienv.cjs"));

const DATA_SPECS = [
  {
    key: "atlas-tree",
    bookTitle: "大纲版式 · 心智系统的多级架构",
    rootTitle: "心智系统的多级架构",
    pattern: "tree",
    rootType: "分类",
    build: (ord) => {
      const nodes = [
        { title: "感觉记忆（微秒级瞬时编码）", type: "分类" },
        { title: "工作记忆（有限容量中枢缓冲）", type: "分类" },
        { title: "长期记忆（双轨语义网络储存）", type: "分类" },
        { title: "元认知监控（认知资源动态调度）", type: "分类" },
        { title: "神经可塑性（突触效能长时程增强）", type: "分类" },
      ].map((k) => ({
        nodeId: `n_tree_${ord++}`,
        parentId: "root",
        ord: ord++,
        title: k.title,
        type: k.type,
        state: "floor",
        source: "ai",
      }));
      return { nodes, edges: [] };
    },
  },
  {
    key: "atlas-grid",
    bookTitle: "并列版式 · 工作记忆核心子系统",
    rootTitle: "工作记忆六大核心子系统",
    pattern: "grid",
    rootType: "分类",
    build: (ord) => {
      const nodes = [
        { title: "语音回路（音韵存储与默读复述）", type: "分类" },
        { title: "视空画板（心理旋转与空间表征）", type: "分类" },
        { title: "情景缓冲（多模态表征整合中枢）", type: "分类" },
        { title: "中央执行（注意定向与任务切换）", type: "分类" },
        { title: "抑制控制（干扰过滤与冲动防御）", type: "分类" },
        { title: "负荷监测（瞬时容量过载预警）", type: "分类" },
      ].map((k) => ({
        nodeId: `n_grid_${ord++}`,
        parentId: "root",
        ord: ord++,
        title: k.title,
        type: k.type,
        state: "floor",
        source: "ai",
      }));
      return { nodes, edges: [] };
    },
  },
  {
    key: "atlas-argument",
    bookTitle: "论证版式 · 生成性提取核心假说",
    rootTitle: "核心论题：生成性提取是长久记忆的最优机制",
    pattern: "argument",
    rootType: "论点",
    build: (ord) => {
      const nodes = [
        { nodeId: "arg_r1", parentId: "root", ord: ord++, title: "理由一：突触长时程增强（LTP）强化物理痕迹", type: "理由", state: "open", source: "ai" },
        { nodeId: "arg_r2", parentId: "root", ord: ord++, title: "理由二：生成性编码促进既有认知图式深层重构", type: "理由", state: "open", source: "ai" },
        { nodeId: "arg_e1", parentId: "root", ord: ord++, title: "证据 A：双盲受控主动提取效应对比实验", type: "证据", state: "floor", source: "ai" },
        { nodeId: "arg_e2", parentId: "root", ord: ord++, title: "证据 B：fMRI 前额叶神经网络深层活化成像", type: "证据", state: "floor", source: "ai" },
        { nodeId: "arg_ex1", parentId: "root", ord: ord++, title: "例证：工程专业高难度概念迁移教学实测", type: "例证", state: "floor", source: "ai" },
        { nodeId: "arg_c1", parentId: "root", ord: ord++, title: "反方主张：被动复读可显著降低瞬时疲劳与认知负荷", type: "反方观点", state: "open", source: "ai" },
        { nodeId: "arg_reb", parentId: "root", ord: ord++, title: "反驳理由：顺畅感造成的认知错觉严重掩盖知识断层", type: "反驳", state: "floor", source: "ai" },
      ];
      const edges = [
        { fromId: "arg_e1", toId: "arg_r1", code: "支" },
        { fromId: "arg_e2", toId: "arg_r1", code: "支" },
        { fromId: "arg_e2", toId: "arg_r2", code: "支" },
        { fromId: "arg_ex1", toId: "arg_r2", code: "例" },
        { fromId: "arg_reb", toId: "arg_c1", code: "驳" },
      ];
      return { nodes, edges };
    },
  },
  {
    key: "atlas-timeline",
    bookTitle: "时间线版式 · 记忆科学发展里程碑",
    rootTitle: "记忆科学与认知演进关键里程碑",
    pattern: "timeline",
    rootType: "叙事",
    build: (ord) => {
      const list = [
        { title: "艾宾浩斯遗忘曲线模型确立", time: "1885年", type: "叙事" },
        { title: "格式塔知觉组织完形法则诞生", time: "1912年", type: "叙事" },
        { title: "达特茅斯会议开启认知革命", time: "1956年", type: "叙事" },
        { title: "阿特金森-谢弗林三级记忆加工模型", time: "1968年", type: "叙事" },
        { title: "巴德利工作记忆多成分模型确立", time: "1974年", type: "叙事" },
        { title: "贝叶斯大脑与预测加工理论兴起", time: "2010年", type: "叙事" },
      ];
      const nodes = list.map((item) => ({
        nodeId: `n_tl_${ord++}`,
        parentId: "root",
        ord: ord++,
        title: item.title,
        time: item.time,
        type: item.type,
        state: "floor",
        source: "ai",
      }));
      return { nodes, edges: [] };
    },
  },
  {
    key: "atlas-chain",
    bookTitle: "步骤版式 · 概念同化与记忆流程",
    rootTitle: "渐进阅读与知识同化七步闭环流程",
    pattern: "chain",
    rootType: "步骤",
    build: (ord) => {
      const list = [
        "第一步：材料速读与建立宏观认知图式",
        "第二步：捕获认知障碍并执行精确摘录",
        "第三步：简明工程降噪与单意图还原",
        "第四步：原子化卡片重构与规则校验",
        "第五步：基于 FSRS 算法进行主动提取",
        "第六步：穿梭回原文验证深层理解语境",
        "第七步：达成知识网络结构化自动化迁移",
      ];
      const nodes = list.map((title) => ({
        nodeId: `n_ch_${ord++}`,
        parentId: "root",
        ord: ord++,
        title,
        type: "步骤",
        state: "floor",
        source: "ai",
      }));
      return { nodes, edges: [] };
    },
  },
  {
    key: "atlas-layered",
    bookTitle: "因果版式 · 认知阻滞与遗忘传导",
    rootTitle: "认知过载与遗忘传导机制",
    pattern: "layered",
    rootType: "因果",
    build: (ord) => {
      const nodes = [
        { nodeId: "ly_1", parentId: "root", ord: ord++, title: "高频外部干扰引发注意涣散", type: "因果", state: "floor", source: "ai" },
        { nodeId: "ly_2", parentId: "root", ord: ord++, title: "突触强化刺激不足", type: "因果", state: "floor", source: "ai" },
        { nodeId: "ly_3", parentId: "root", ord: ord++, title: "工作记忆通道瞬时过载", type: "因果", state: "floor", source: "ai" },
        { nodeId: "ly_4", parentId: "root", ord: ord++, title: "语义网络关联链接阻断", type: "因果", state: "floor", source: "ai" },
        { nodeId: "ly_5", parentId: "root", ord: ord++, title: "深层主动提取线索丢失", type: "因果", state: "floor", source: "ai" },
        { nodeId: "ly_6", parentId: "root", ord: ord++, title: "长时记忆表征不可逆衰退", type: "因果", state: "floor", source: "ai" },
      ];
      const edges = [
        { fromId: "ly_1", toId: "ly_3", code: "因" },
        { fromId: "ly_2", toId: "ly_4", code: "因" },
        { fromId: "ly_3", toId: "ly_4", code: "因" },
        { fromId: "ly_4", toId: "ly_5", code: "因" },
        { fromId: "ly_5", toId: "ly_6", code: "因" },
      ];
      return { nodes, edges };
    },
  },
  {
    key: "atlas-compare",
    bookTitle: "对照版式 · 学习范式多维横向对比",
    rootTitle: "学习范式多维横向对比",
    pattern: "compare",
    rootType: "对比",
    build: (ord) => {
      const nodes = [
        { nodeId: "cmp_m1", parentId: "root", ord: ord++, title: "机械死记模式", type: "对比", state: "open", source: "ai" },
        { nodeId: "cmp_m2", parentId: "root", ord: ord++, title: "渐进建构模式", type: "对比", state: "open", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m1", ord: ord++, title: "核心机制：被动刺激强化与条件反射", type: "其他", state: "floor", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m2", ord: ord++, title: "核心机制：先行图式同化与预测编码", type: "其他", state: "floor", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m1", ord: ord++, title: "认知负荷：极高瞬时消耗且浅层加工", type: "其他", state: "floor", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m2", ord: ord++, title: "认知负荷：渐进多轮解耦与负荷降噪", type: "其他", state: "floor", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m1", ord: ord++, title: "记忆持久：脱离上下文极速遗忘", type: "其他", state: "floor", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m2", ord: ord++, title: "记忆持久：FSRS 临界调度长效固化", type: "其他", state: "floor", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m1", ord: ord++, title: "迁移效能：孤立刻板难以跨情境应用", type: "其他", state: "floor", source: "ai" },
        { nodeId: `cmp_c_${ord++}`, parentId: "cmp_m2", ord: ord++, title: "迁移效能：概念模型深层泛化与创新", type: "其他", state: "floor", source: "ai" },
      ];
      return { nodes, edges: [] };
    },
  },
];

async function measureDiagramBounds(evaluate) {
  const r = await evaluate(`return (() => {
    const stage = document.querySelector(".atlas-stage");
    const els = [
      ...document.querySelectorAll(".atlas-glyphs .ag"),
      ...document.querySelectorAll(".atlas-zones rect"),
      ...document.querySelectorAll(".atlas-decos rect, .atlas-decos circle, .atlas-decos text"),
      ...document.querySelectorAll(".atlas-decos-under rect"),
      ...document.querySelectorAll(".atlas-ribbons path"),
      ...document.querySelectorAll(".atlas-edges path")
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.top < 48) continue;
      if (r.left < minX) minX = r.left;
      if (r.right > maxX) maxX = r.right;
      if (r.top < minY) minY = r.top;
      if (r.bottom > maxY) maxY = r.bottom;
    }
    const sr = stage ? stage.getBoundingClientRect() : null;
    return {
      stage: sr ? { left: sr.left, top: sr.top, width: sr.width, height: sr.height } : null,
      content: { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
    };
  })()`);
  return r.value;
}

async function centerDiagramInViewport(evaluate, send, sleep) {
  // 先缩放到 100% 并居中焦点
  await evaluate(`return (() => {
    const btn = document.querySelector(".atlas-zoom button:nth-child(2)");
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(700);

  // 如果图形超出舞台边界，微调平移让整个结构图完全位于视口中央
  for (let iter = 0; iter < 4; iter++) {
    const b = await measureDiagramBounds(evaluate);
    if (!b || !b.stage || !b.content || !isFinite(b.content.cx)) break;

    const targetX = b.stage.left + b.stage.width / 2;
    const targetY = b.stage.top + b.stage.height / 2 + 10;
    const dx = Math.round(targetX - b.content.cx);
    const dy = Math.round(targetY - b.content.cy);

    if (Math.abs(dx) <= 15 && Math.abs(dy) <= 15) break;

    const startX = dx < 0 ? 1400 : 700;
    const startY = dy < 0 ? 800 : 350;
    const endX = Math.round(startX + dx);
    const endY = Math.round(startY + dy);

    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: startX,
      y: startY,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });

    const steps = 12;
    for (let s = 1; s <= steps; s++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(startX + (dx * s) / steps),
        y: Math.round(startY + (dy * s) / steps),
        buttons: 1,
      });
      await sleep(15);
    }

    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: endX,
      y: endY,
      button: "left",
      buttons: 0,
    });

    await sleep(350);
  }
}

async function main() {
  const label = "atlas-shots";
  const userDir = freshDir(tmpUserDataDir(label));
  fs.mkdirSync(userDir, { recursive: true });

  console.log("1. 正在初始化测试数据库并注入 7 本专属版式书籍与导图...");
  const db = require(path.join(ROOT, "electron", "db.js"));
  await db.initDb({ dataDir: userDir });

  let globalOrd = 1;
  const bookItems = [];

  for (const spec of DATA_SPECS) {
    const bookMd = `# ${spec.bookTitle}\n\n本书作为展示 Nutation 结构全景专属版式的范例文档。`;
    const item = db.createFromPaste(spec.bookTitle, bookMd);
    const docId = item.documentId;

    const mapRes = db.createMaterialMapV2({
      documentId: docId,
      title: spec.rootTitle,
      meta: { title: spec.rootTitle },
      skeleton: [],
    });
    const mapId = mapRes.mapId;

    const rootNode = {
      nodeId: "root",
      parentId: null,
      ord: 0,
      title: spec.rootTitle,
      type: spec.rootType,
      pattern: spec.pattern,
      state: "open",
      source: "ai",
      blockStart: 1,
      blockEnd: 1,
    };

    const { nodes, edges } = spec.build(globalOrd);
    globalOrd += nodes.length + 10;

    db.commitMaterialMapJob({
      mapId,
      upserts: [rootNode, ...nodes],
      edges,
      activate: true,
    });

    db.setMaterialMapView(mapId, {
      patterns: { "@root": spec.pattern, root: spec.pattern },
      collapsed: [],
    });

    bookItems.push({ ...spec, itemId: item.id, docId, mapId });
  }

  db.closeDb();
  console.log("   7 本书籍与对应导图数据注入完成！");

  // 启动 Electron
  console.log("2. 正在启动 Electron 真实应用...");
  delete process.env.ELECTRON_RUN_AS_NODE;
  const handle = await guienv.launch({ label, port: 9845, fresh: false });
  if (handle.skip || handle.timeout) {
    console.error("启动失败：", handle.reason);
    return;
  }

  const { send, evaluate } = handle;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 视口拓宽到 2200x1200，保证 100% 原始比例下最宽的图也完全舒展容纳，DPR=2 输出超高解析度
  await send("Emulation.setDeviceMetricsOverride", {
    width: 2200,
    height: 1200,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const outDir = path.join(ROOT, "docs", "assets", "readme");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("3. 等待应用主界面就绪...");
  await sleep(3500);

  for (let idx = 0; idx < bookItems.length; idx++) {
    const item = bookItems[idx];
    console.log(`\n[${idx + 1}/7] 正在处理：${item.bookTitle} (${item.key})...`);

    // 在书架上点击对应书籍卡片
    console.log(`   · 点击打开书籍...`);
    await evaluate(`return (() => {
      const cards = [...document.querySelectorAll(".book-card")];
      const target = cards.find(c => {
        const titleAttr = c.getAttribute("title") || "";
        return titleAttr.includes(${JSON.stringify(item.bookTitle)}) || titleAttr.includes(${JSON.stringify(item.bookTitle.slice(0, 4))});
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    })()`);

    await sleep(2200);

    // 点击「结构全景」按钮
    console.log(`   · 展开结构全景...`);
    await evaluate(`return (() => {
      const btn = document.querySelector("[data-reader-atlas-toggle]");
      if (btn && btn.getAttribute("aria-pressed") !== "true") {
        btn.click();
        return true;
      }
      return false;
    })()`);

    await sleep(2000);

    // 居中结构图
    console.log(`   · 校准图表居中与 100% 尺度...`);
    await centerDiagramInViewport(evaluate, send, sleep);
    await sleep(600);

    // 获取精确几何边界（去掉外层软件界面，仅裁切结构图自身卡片与元素）
    const bounds = await measureDiagramBounds(evaluate);
    if (!bounds || !bounds.content || !isFinite(bounds.content.minX)) {
      console.error(`   ✕ 获取边界失败: ${item.key}`);
      continue;
    }

    const c = bounds.content;
    const pad = 24; // 结构图卡片外侧留白 24px，完整包含圆角与阴影
    const clip = {
      x: Math.max(0, Math.floor(c.minX - pad)),
      y: Math.max(0, Math.floor(c.minY - pad)),
      width: Math.ceil(c.width + pad * 2),
      height: Math.ceil(c.height + pad * 2),
      scale: 1,
    };
    console.log(`   · 裁切结构图特写范围: ${clip.width}x${clip.height} (无软件界面)...`);

    // 纯图特写高清截屏（零界面元素，仅结构图）
    const shotResult = await send("Page.captureScreenshot", {
      format: "png",
      clip,
      captureBeyondViewport: false,
    });

    const filePath = path.join(outDir, `${item.key}.png`);
    fs.writeFileSync(filePath, Buffer.from(shotResult.result.data, "base64"));
    console.log(`   ✓ 成功保存纯图特写: ${filePath}`);

    // 先退出全景，再返回书架
    console.log(`   · 退出全景并返回书架...`);
    await evaluate(`return (() => {
      const atlasBtn = document.querySelector("[data-reader-atlas-toggle]");
      if (atlasBtn && atlasBtn.getAttribute("aria-pressed") === "true") {
        atlasBtn.click();
      }
      return true;
    })()`);
    await sleep(600);

    await evaluate(`return (() => {
      const navShelf = [...document.querySelectorAll(".nav-item")].find(x => x.textContent.trim() === "书架");
      if (navShelf) navShelf.click();
      return !!navShelf;
    })()`);

    await sleep(1500);
  }

  console.log("\n4. 正在安全关闭应用进程...");
  await guienv.shutdown(handle);
  console.log("全部 7 张结构全景纯图高清截图生成完毕！");
}

main().catch((err) => {
  console.error("执行出错：", err);
  process.exit(1);
});
