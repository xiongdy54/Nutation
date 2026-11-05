# D265 · 制卡台作用域收敛与「图片挖空」截图归属（v49.99）

> 决策号 **D265**；GUIDE §8.1 / §9.2 登记。
> 用户指令日期：2026-11-04。范围：`src/App.tsx`、`src/components/Reader.tsx`、`src/components/ExtractReviewView.tsx`、
> `src/lib/useSelectionActions.ts`、`src/components/FreeWorkbenchHost.tsx`（注释）、`src/theme.css`、
> `electron/screenCapture.js` / `electron/main.js`（仅注释）与相关测试。
> **零 schema / 零 IPC 契约 / 零设置键 / 零新依赖 / 零新文案。**

## 0. 用户原话（逐字）

> 现在软件当中的制卡台（也就是 Ctrl + K 唤出的软件内部制卡台），我觉得它的设计有点问题。
>
> 1. 侧边栏与唤出逻辑：
> 现在不需要在阅读界面以外的地方出现侧边栏制卡台了，因为那样会让界面布局看起来很奇怪。因为已经有在任何地方使用 Ctrl + Alt + K 快捷键唤出独立的制卡台窗口的功能了，已经可以实现在任何地方制卡了。
> 2. 图片挖空与截图逻辑：
> 在阅读界面唤出的侧边栏制卡台中，手动制卡有一个“图片挖空”按钮。选择之后不应该隐藏软件窗口去截取屏幕，而是应该实现原本工具栏上的截图功能，不隐藏软件窗口，直接截取软件内部正在阅读的内容作为图片。
> 与此同时，原本工具栏上的截图按钮可以退役了，因为它的功能已经由侧边栏制卡台里的“图片挖空”按钮继承。
> 而通过全局快捷键唤出的独立制卡台窗口，里面的“图片挖空”按钮才应该是隐藏软件界面去截取屏幕内容。

## 1. 现状（v49.98）

| 面 | 现状 | 问题 |
| --- | --- | --- |
| 非阅读页（书架 / 复习 / 卡片 / 下一步 / 数据） | `App.tsx` 挂 `FreeWorkbenchHost`，顶栏 `workbench-entry` + `Ctrl+K` 可唤出右侧制卡台 | 侧栏参与页面布局（让位 / 外延），非阅读页出现「为阅读服务的面板」，布局突兀；独立窗口 `Ctrl+Alt+K` 已覆盖「任何地方制卡」 |
| 阅读器 | 顶栏 `workbench-entry` + `Ctrl+K` 唤出右侧制卡台；工具栏 `data-sel-act="capture"`「截图」用 `assetsAPI.captureRegion` 截阅读区 | 工具栏截图入口与侧栏「图片挖空」重复 |
| 侧栏「图片挖空」 | `SelectionPanels` → `useSelectionActions.startWorkbenchCapture()` → `assetsAPI.captureScreen`（隐藏所有可见窗口 + `desktopCapturer` 整屏框选） | 在阅读界面也隐藏窗口、截桌面，而不是截正在阅读的内容 |
| 独立制卡台窗口 | 与侧栏共用 `startWorkbenchCapture()` → 整屏截图 | 正常；独立窗口没有阅读内容，只能截屏 |
| 摘录复习页 | 有阅读上下文的自带宿主，侧栏制卡台随选区动作出现；「图片挖空」同样走整屏截图 | 属于侧边栏内唤出的面板，不应隐藏窗口 |

## 2. 决策

1. **侧边栏制卡台只保留在有阅读上下文的界面**：阅读器 `reader` 与摘录复习页 `extractSession`。
   - 其余页面不再挂 `FreeWorkbenchHost`；顶栏「制卡台」按钮与 `Ctrl+K` 在这些页面不渲染 / 不响应。
   - 任何页面（含非阅读页）仍可用 `Ctrl+Alt+K` 呼出独立制卡台窗口完成制卡——这是非阅读页的唯一内部制卡入口。
   - `ExtractReviewView` 的上下文坞保留：它的选区动作（制卡 / AI 制卡 / AI 解释）依赖当前摘录的 `contextRef`，属于「阅读上下文」的一部分。
2. **「图片挖空」按宿主分派截图源**：
   - 阅读器侧栏：调用原工具栏截图同一条 `assetsAPI.captureRegion` 链路，截取阅读区当前可见内容（`scrollRef` / `__overrideCaptureRegion`），**不隐藏窗口**；截前清选区、等两帧重绘，浮条与选区高亮不入镜；图片锚点仍记当前 locator / chapterIndex，卡片可跳回原文。
   - 摘录复习页侧栏：同样走 `captureRegion`，截取当前卡面 `.extract-face`，不隐藏窗口。
   - 独立制卡台窗口：保留 `assetsAPI.captureScreen`（隐藏可见窗口 + 整屏框选），因为窗口内没有阅读内容可截。
3. **工具栏截图按钮退役**：阅读器 `.reader-sel-actions` 动作组（v48.97/D141 后仅剩「截图」一枚）与其容器、markdown 分支 `.reader-md-actions` 一并删除；功能由侧栏制卡台的「图片挖空」继承。

## 3. 实现契约

### 3.1 选择动作适配器

`SelectionActionsAdapter` 新增可选字段：

```ts
/** 本宿主提供的「图片挖空」内部截图源；不提供＝回落到整屏截图（独立制卡台窗口） */
captureWorkbenchImage?: () => Promise<{ dataUrl: string; alt: string } | null>;
```

`useSelectionActions.startWorkbenchCapture()` 顺序：

1. 已有挖空编辑器 / 图片挖空弹窗在场 → toast 提示并返回（守卫从 Reader 移入 hook，所有宿主一致）。
2. 有 `captureWorkbenchImage` → 用它；否则 `window.assetsAPI.captureScreen()`。
3. 成功 → `clearKernelSelection?.()`、`occlusionSourceRef.current = "engine"`、
   `setOcclEditor({ image, origin: null, workbench: true })`（编辑器仍由 `SelectionPanels` 渲染）。

截图失败 / 取消：toast 或静默，不创建编辑器；不改变任何卡片数据。

### 3.2 宿主接线

| 宿主 | `captureWorkbenchImage` |
| --- | --- |
| `Reader` | 提取原 `handleCaptureReader` 的截图部分：`box = __overrideCaptureRegion ?? scrollRef.current.getBoundingClientRect()`；`setSelection(null)` + `engineSelRef.current = null`；两帧 rAF；`assetsAPI.captureRegion(box)`；成功后写 `imageAnchorRef`；返回 `{ dataUrl, alt: T("页面截图") }` |
| `ExtractReviewView` | 目标元素 `.extract-face`（缺省回落 `pageRef.current`）；清 `window.getSelection()` / 多段高亮 / `faceSel`；两帧 rAF；`assetsAPI.captureRegion` |
| `FreeWorkbenchHost`（仅独立窗口） | 不提供 → 回落整屏截图 |

### 3.3 App 入口

- 删除 `FreeWorkbenchHost` 的 import 与 `app-main` 内渲染。
- `workbench-entry` 按钮只在 `view.name === "reader" || view.name === "extractSession"` 时渲染。
- `Ctrl+K` 监听在非上述视图直接返回（不 `preventDefault`）；`Ctrl+Alt+K` 全局键不变。

### 3.4 退役清理

- `Reader.tsx`：删除 `selActionsGroup`、`handleCaptureReader`、两处渲染点、mousedown 豁免里的 `.reader-sel-actions`。
- `theme.css`：删除 `.reader-md-actions`；`.reader-sel-actions` 相关注释同步更新。
- 保留 `reader-capture:region` 与 `screen-capture:start` 两条 IPC 原样（前者改由侧栏「图片挖空」消费，后者只服务独立窗口）。

## 4. 不做

- 不改 `Ctrl+Alt+K` / 独立窗口 / 托盘 / 全局快捷键注册。
- 不改 `assetsAPI` / IPC 契约 / 卡片 `occlusion_json` / 资产归属规则。
- 不删除 `ExtractReviewView` 的上下文制卡坞；不新增跨窗口注入通道。
- 不改阅读器选区浮条与选区动作语义。

## 5. 验收（可机械检查）

1. 静态契约 `tests/d265-workbench-scope.test.cjs`：
   - `App.tsx` 无 `FreeWorkbenchHost` 的 import / 渲染；`workbench-entry` 受阅读上下文条件约束；`Ctrl+K` 门控存在。
   - `Reader.tsx` 无 `data-sel-act="capture"` / `handleCaptureReader` / `selActionsGroup`；含 `captureWorkbenchImage` 与 `captureRegion`。
   - `useSelectionActions.ts` 含 `captureWorkbenchImage` 分派与 `captureScreen` 回落。
   - `FreeWorkbenchHost.tsx` 不提供 `captureWorkbenchImage`（独立窗口走整屏）。
2. `node scripts/run-tests.mjs d265` 退出 0。
3. `npx tsc --noEmit` 0 错；`npm run build` 通过；`node scripts/i18n-check.mjs` 退出 0。
4. 受影响 GUI 套件按新契约更新：`tests/d144.gui.mjs`（改为打开一本书后唤坞）、`tests/d139-sidebar-band.gui.mjs`（动作组退役后的几何基准）、`tests/annotations.gui.mjs` / `tests/m1.gui.mjs`（工具栏六动作旧断言移除）。
5. 人工冒烟：阅读器侧栏「图片挖空」→ 不隐藏窗口、截到当前阅读区 → 进编辑器；独立窗口同操作 → 隐藏窗口整屏框选；非阅读页无顶栏制卡台按钮、`Ctrl+K` 无反应、`Ctrl+Alt+K` 正常。

## 6. 验证结果（2026-11-05）

| 检查 | 结果 |
| --- | --- |
| `node tests/d265-workbench-scope.test.cjs` | 10 / 10 通过 |
| `node scripts/run-tests.mjs d265` | 1 通过 / 0 失败 |
| `npx tsc --noEmit` | 0 错 |
| `npm run build` | 通过 |
| `node scripts/i18n-check.mjs` | 退出 0 |
| `node tests/d144.gui.mjs` | 41 / 41 通过；书架页无入口且 Ctrl+K 不拦截；新增 S6 在阅读器侧栏点「图片挖空」→ 编辑器收到 `data:image/png` 截图，侧栏不收起、无整屏框选 |
| `node tests/d139-sidebar-band.gui.mjs` | 21 / 21 通过（几何基准改用恒在的翻页钮） |
| `node tests/annotations.gui.mjs` | D265 相关两项断言（阅读器选区五项动作、⑪e 工具栏动作组退役）通过；套件仍有 20 项 D122/D254 遗留断言失败（段控已迁选区浮条、图谱页签已移出侧栏），非本决策引入 |

测试环境说明：无人值守窗口可能被 Chromium 判定为遮挡而不产帧——原生 View Transition 会停在 `data-vt=1`（遮罩挡命中），`webContents.capturePage` 也会等待帧。GUI 套件在打开阅读器后先强制一帧（`Page.captureScreenshot`）让过渡结算，再执行真实拖选/截图；真实聚焦窗口不需要该步骤。`m1.gui.mjs` 为「应用需预先以 9224 端口启动」的旧手动脚本，本次仅按新契约更新其选区动作断言，未在套件化运行中执行。
