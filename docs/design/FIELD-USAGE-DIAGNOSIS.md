# 手动制卡「更多」展开区六字段用途链诊断（只读）

- 日期：2026-10-14
- 性质：只读诊断（未改任何代码 / 文档）
- 诊断对象：制卡台「手动制卡」→「更多」展开区六个字段：**领域、标签、前缀、助记、知识点、标注日期**
- 问题来源：用户三问（新模型是否还需要 / 是否有实际用途 / 各环节作用）
- 上游文档：`docs/design/LEARNER-MODEL-REDESIGN-D124.md`（新模型设计稿，下称 D124 稿）

---

## 0. 名词澄清（先回答截图与提问的一个出入）

用户提问写「注记」，截图与代码中的字段文案为「助记」（[ManualCardEditor.tsx:669](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L669) `<span className="wb-k">助记</span>`，对应 `cards.mnemonic`）。全仓 `src/` 检索「注记」仅命中代码注释，无任何 UI 字段叫「注记」。**两者是同一物（mnemonic/助记），「注记」为笔误。** 下文统一称「助记」。

另需澄清字段来源：这六个字段并非为旧「学习者知识模型」专门设计，而是 v25 批次 M5「与 AI 制卡同构的元数据字段」（[ManualCardEditor.tsx:349](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L349) 注释、GUIDE §9.2 M5 行、[useSelectionActions.ts:353](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/useSelectionActions.ts#L353)）——目的是让手动卡与 AI 卡共用同一套 schema 与下游（AI 制卡提示词同样产出这些字段，见 §2 各字段「写入」行）。旧学习者模型（BEMM 五维 Beta）所需的 `knowledge_evidence` / `learner_knowledge_states` 等表**从未建表**（D124 稿 §1.1）。

---

## 1. 逐字段用途链

六个字段全部落在 `cards` 表（[db.js:162-189](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L162-L189)），统一经 `insertCard`（[db.js:1516-1536](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L1516-L1536)）/ `updateCard`（[db.js:1588-1605](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L1588-L1605)）落库；手动表单提交链：`ManualCardEditor.save()`（[ManualCardEditor.tsx:509-535](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L509-L535)）→ 宿主 `handleManualCard`/`createSingleCard`（[useSelectionActions.ts:395-431](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/useSelectionActions.ts#L395-L431)）→ IPC `createManualCard`。以下按字段分述。

### 1.1 领域（`cards.domain`，JSON 数组，UDC 码，≤2 个首个为主）

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| schema | [db.js:378-383](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L378-L383)（ALTER TABLE 加列，注释「统计管线 v1」） | TEXT，JSON 数组字符串如 `["51","32"]` |
| 写入（手动） | [ManualCardEditor.tsx:350, 653-655](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L653-L655)（UdcPicker）；dock 沿用上一张卡领域（D123 修订 4，:131、:522） | 受控清单选择 |
| 写入（AI） | [prompts.js:99-100](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/prompts.js#L99-L100)（R17 领域标注）、出层契约 :152-153 | AI 每卡必输出 |
| 写入（查词制卡） | [useSelectionActions.ts:1576](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/useSelectionActions.ts#L1576)（默认 `["8"]` 语言·文学） | 词汇卡自动归属 |
| 消费① 统计看板 | [db.js:4466-4480](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L4466-L4480)（domainMain/domainDetail）、[db.js:4588-4619](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L4588-L4619)（domainRank 复习领域月度排名，含 review_logs join）→ [widgets.tsx:70, 75, 249](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/dashboard/widgets.tsx#L70)（数据页图表） | `domain[0]` 为主领域口径 |
| 消费② **D124 新模型（已实施）** | [learnerRefresh.js:882-890, 1675-1683](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/learnerRefresh.js#L1675-L1683)（cardUdcCounts → `proposeTracks` 提议轨道）、[:902, :1543](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/learnerRefresh.js#L1729) + [`dominantUdcOf` :1729-1750](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/learnerRefresh.js#L1729-L1750)（材料主领域）→ `lmRecommend.resolveMembership`（:921）轨道自动归属 | **新模型核心信号**，见 §2 对照 |
| 消费③ AI 用户记忆（M14-UM2） | [db.js:1106-1125](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L1106-L1125)（`listCardDomainsForDocument`：本书已有卡的 UDC 分布，Stage A 宽召回材料信号）→ [memoryRetrieve.js:12-42](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/memoryRetrieve.js#L12-L42)（UDC 前缀 → 生活领域映射，选词时检索用户记忆条目） | 查词/阅读时召回个人记忆 |
| 消费④ 成长反馈（M8-B GF） | [growth.js:353-370](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/growth.js#L353-L370)（材料再逢命中：书与 UDC 主领域码两实体分组算覆盖率首达）、:499 | 复习页微反馈 |
| 消费⑤ 卡片浏览器 | [db.js:1979](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L1979)（查询行数据）、[CardBrowser.tsx:1811](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/CardBrowser.tsx#L1811)（卡详情「领域」行显示） | 浏览与查询匹配 |
| 消费⑥ 卡面同域排序 | [cards.ts:1233](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cards.ts#L1233)（相似卡列表中同主领域排前） | 六步向导等场景 |
| 消费⑦ KP 归一/洞察种子 | [db.js:5743-5744](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L5743-L5744)（K2-A 簇采样 samples.domain）、[db.js:6551-6554](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L6551-L6554)（洞察相关卡） | AI 归一/洞察的输入上下文 |
| 消费⑧ 辨析 | [disambiguateCore.mjs:93](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/disambiguateCore.mjs#L93)（主领域参与辨析判定） | 辨析弹窗 |
| 消费⑨ material-difficulty scope | [kpScopes.js:133-135](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/kpScopes.js#L133-L135)（出层校验 KP 候选 domain） | **渲染层零消费**（src/ 检索 material-difficulty 等 4 scope 名 0 命中，与 D124 稿 §1.1 普查一致） |

状态：**①被 UI 写入且被下游真实消费**（消费者最多的一个字段）。

### 1.2 标签（`cards.tags_json`，JSON 数组，D101 标签系统）

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| schema | [db.js:178](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L178)（原生列；D94 采纳标签系统激活） | 用户自由组织词汇，`::` 层级 |
| 写入（手动表单） | [ManualCardEditor.tsx:361-366, 657-662](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L657-L662)（TagInput + 词表建议；D107 开关关闭时整行不渲染、恒空提交） | 批注标签经 `initialTags` 继承预填可删 |
| 写入（复习页） | [ReviewView.tsx:988-1005](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ReviewView.tsx#L988-L1005)（答案揭示后「＋标签」快捷打标） | 正面永不显示（防泄题，R6 同源） |
| 写入（浏览器批量） | `cards:setTags` IPC → [db.js:3743-3764](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L3743-L3764)（主进程只存储，规则单一源在渲染层 tags.ts） | 批量打标/去标 |
| 消费① 查询语法 `tag:` | [cardQuery.ts:315-316](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cardQuery.ts#L315-L316)（解析）、[:449, :482](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cardQuery.ts#L449)（行匹配）、[:530-531](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cardQuery.ts#L530-L531)（tagFilterMatches，层级前缀 + `-tag:` 排除） | 卡片浏览器筛选（D101 查询语法 v2） |
| 消费② 今日队列 scope | [sessionQueue.ts:75](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/sessionQueue.ts#L75)（标签条件，多值 OR；D105「用当前查询创建」提取 `tag:` 条件进 scope） | 复习队列按标签组卷 |
| 消费③ 词表派生 | [db.js:3772-3794](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L3772-L3794)（`listTags`：cards ∪ extracts 现算词表）→ 手动表单/复习页 TagInput 建议下拉 | 输入建议 |
| 消费④ 复习页回显 | [ReviewView.tsx:983-987](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ReviewView.tsx#L983-L987)（答案揭示后 chips 只读展示） | 复习时可见 |
| 消费⑤ CardLint L17 | [cards.ts:959-963](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cards.ts#L959-L963)（数量/长度/深度超限提示，lint 结果落 `card_issues`，卡详情经 [db.js:2535](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L2535) 读出） | 制卡质量提示 |
| 消费⑥ 浏览器行过滤 | [db.js:4173](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L4173)（tags 多值 OR 匹配） | 与①同链 |
| D124 新模型 | **零消费**（见 §2） | — |

状态：**①被写入且被真实消费**——它是 D94 采纳的「第四组织轴」（书/知识点/来源之外的用户自组织维度），消费链完整独立于学习者模型。

### 1.3 前缀（`cards.context_prefix`）

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| schema | [db.js:171](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L171) | 短领域前缀如「统计:」 |
| 写入（手动） | [ManualCardEditor.tsx:355, 663-666](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L663-L666)；dock 自动填＝首个领域名（[:449-453](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L449-L453)，D123 修订 4） | 只能写领域/学科名（规则 16） |
| 写入（AI） | [prompts.js:59-64](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/prompts.js#L59-L64)（R6 前缀铁律：禁泄题）、出层契约 :152 | AI 每卡必输出 |
| 消费① **复习卡面显示** | CardFace 组件（[CardBrowser.tsx:2296, 2302, 2330, 2338](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/CardBrowser.tsx#L2296)）——正/背面题面前缀；复习页复用同组件（[ReviewView.tsx:965](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ReviewView.tsx#L965)） | 脱离原文也能知道卡片问的是哪个领域（R6 设计目的） |
| 消费② CardLint | L5 缺前缀（[cards.ts:905-906](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cards.ts#L905-L906)）、L13 前缀泄题（[:931-934](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cards.ts#L931-L934)）、L18 观点归属（[disambiguateText.ts:34-39](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/disambiguateText.ts#L34-L39) `needsAttribution`） | 制卡质量闸 |
| 消费③ 辨析编辑 | [CardPane.tsx:40-41](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/disambiguate/CardPane.tsx#L40-L41)（三可编辑字段之一）、[disambiguateUi.ts:71-72](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/disambiguateUi.ts#L71-L72)、[DisambiguateModal.tsx:329](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/DisambiguateModal.tsx#L329)（检索相似卡时拼 `prefix + front`） | 辨析/修卡 |
| 消费④ 旧卡回填 domain（一次性迁移） | [db.js:384-390](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L384-L390)（`domainFromPrefix`：老卡按前缀关键词映射 UDC，只回填一次） | 历史迁移，非运行时消费 |
| 消费⑤ K2-A 归一采样 | [db.js:5725, 5744](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L5725)（簇采样 samples.contextPrefix 进 AI 归一输入） | 知识点归一上下文 |
| 消费⑥ 知识点页相关卡 | [KnowledgeManager.tsx:743](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/KnowledgeManager.tsx#L743) | 显示 |
| 消费⑦ AI 草稿回显 | [AIPanel.tsx:785](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/AIPanel.tsx#L785) | 制卡确认时可见 |
| D124 新模型 | **零直接消费**（见 §2） | — |

状态：**①被写入且被真实消费**（复习显示 + lint + 辨析）。

### 1.4 助记（`cards.mnemonic`）

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| schema | [db.js:173](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L173) | — |
| 写入（手动） | [ManualCardEditor.tsx:356, 667-670](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L667-L670)（placeholder「例：中位数的『中』＝正中间」；不自动填——规则 7 克制，D123 §87） | — |
| 写入（六步向导） | [CardBrowser.tsx:2403, 2442-2506](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/CardBrowser.tsx#L2442-L2506)（Step 6 补助记，编辑后重置为新卡） | 复习中补救 |
| 写入（AI） | [prompts.js:80-81, 212-217](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/prompts.js#L212-L217)（R12 助记克制；card-mnemonic scope 产「助记双卡」，`cardType="mnemonic"`——**注意：那是卡型，卡面内容即助记，普通卡的 mnemonic 字段独立存在**） | — |
| 更新 | [db.js:2314-2321](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L2314-L2321)（COALESCE 可部分更新） | — |
| 消费① **复习页背面辅助字段区** | [ReviewView.tsx:1011](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ReviewView.tsx#L1011) → [CardFaceExtras.tsx:23](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/CardFaceExtras.tsx#L23)（答案揭示后显示「助记」块，`app.cardFaceExtras` 三开关控制，D104） | **主要消费场景：复习翻面后的记忆提示** |
| 消费② 设置开关 | [SettingsPanel.tsx:875-876](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/SettingsPanel.tsx#L875-L876)（「显示助记」） | 用户可关 |
| 消费③ 浏览器详情 | [CardBrowser.tsx:1832](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/CardBrowser.tsx#L1832)（同一组件） | — |
| D124 新模型 | **零消费**（见 §2；设计稿 §6.6 出现的 "mnemonic" 是 `card_type` 卡型取值，不是本字段） | — |

状态：**①被写入且被消费**，但消费形态以「复习时显示」为主——这本身就是该字段的设计用途（助记就是给未来复习的自己看的提示），不属于「只回显无用途」。

### 1.5 知识点（`cards.knowledge_point_id`）

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| schema | [db.js:179](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L179) | 手动=自由文本（如「kp-中位数」）；AI=批内簇 ID（kp1/kp2…） |
| 写入（手动） | [ManualCardEditor.tsx:357, 671-674](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L671-L674)（placeholder「例：kp-中位数」；不自动填——错误归组会污染簇，D123 §87） | 同组卡片共享同一 ID |
| 写入（AI） | [cards.ts:1401](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cards.ts#L1401)（草稿→卡）；[prompts.js:241](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/prompts.js#L241)（词汇卡可填词族/词根分组） | — |
| 消费① **K2-A 知识点归一**（D38） | [db.js:5725-5744](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L5725-L5744)（未归一簇采样进 AI 归一输入）、[db.js:6207-6228](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L6207-L6228)（KnowledgeLint K1：簇值 ∈ canonical_label/alias/正式 id 同口径）；GUIDE §4「AI 抽取归一硬性规范」 | 制卡顺带静默归一 + 知识点页手动批量 |
| 消费② **D124 新模型（已实施）** | `resolveCardKpMap()`（D124 稿 §6.5 指定写于 db.js）被 [learnerRefresh.js:494, 696, 1550, 2032](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/learnerRefresh.js#L494) 四处调用——KP 五级掌握等级（§6.6）、单元↔KP 链接（§6.5）、轨道归属（§6.9）、推荐快照（§9.2）的卡→KP 映射真源 | **新模型最核心的卡侧输入之一** |
| 消费③ 知识点页 | [KnowledgeManager.tsx:77](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/KnowledgeManager.tsx#L77)（簇键）、[:646-650](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/KnowledgeManager.tsx#L646-L650)（lint 跳转）、[:743](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/KnowledgeManager.tsx#L743)（KP 相关卡显示） | KP 管理与详情 |
| 消费④ 材料导图节点学习状态 | [db.js:7082-7098](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L7082-L7098)（`listMindmapLearningStatus`：节点 kpExists——只读，不影响地图结构，M15/D41） | 导图节点「已建知识点」标记 |
| 消费⑤ 成长反馈 KP 组 | [db.js:4866, 4895](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L4866)（`loadGrowthCardsWithLogs`：sibling_key OR knowledge_point_id 分组） | 成长微反馈按 KP 组 |
| 消费⑥ 洞察种子 | [db.js:6542-6554](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L6542-L6554)（insight 相关卡 legacy 命中）→ [insight.ts:33](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/insight.ts#L33) | 洞察面板 |
| 消费⑦ 浏览器条件构建器 | [CardBrowser.tsx:577](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/CardBrowser.tsx#L577)（知识点多选筛选，D105） | 浏览筛选 |
| 消费⑧ 递进补卡 | [useSelectionActions.ts:968](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/useSelectionActions.ts#L968)（知识点「后续可补」注记 → 询问 AI / 直接制卡，v16） | 补卡入口 |

状态：**①被写入且被大量真实消费**（消费者数量与领域并列第一梯队）。

### 1.6 标注日期（`cards.date_stamp`）

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| schema | [db.js:176](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L176) | YYYY-MM-DD（当日） |
| 写入（手动） | [ManualCardEditor.tsx:358, 675-678](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L675-L678)（checkbox）；dock 自动勾选＝正反面命中「统计/版本/价格/政策/截至/目前/当前/最新」正则（[:444-448](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ManualCardEditor.tsx#L444-L448)，与 L12 同一正则） | 规则 19：易变内容标记时效 |
| 写入（AI） | [prompts.js:78-79](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/prompts.js#L78-L79)（R11：时效内容必须带 dateStamp）、出层契约 :158/336/403/417 | — |
| 消费① **复习页 meta 行显示** | [ReviewView.tsx:976-978](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/components/ReviewView.tsx#L976-L978)（复习卡面信息行显示日期） | **主要消费场景：复习时提醒「此答案有时效」** |
| 消费② CardLint L12 | [cards.ts:917-918](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/src/lib/cards.ts#L917-L918)（易变内容无 dateStamp 提示；正则 :858 与自动勾选同源） | 制卡质量闸 |
| 消费③ 卡对象返回 | [db.js:1468](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L1468)（getCard 行映射）；浏览器查询 SELECT（[db.js:1979](file:///c:/Users/xiongdy/Documents/OpenCode/Incremental%20reading%20Dev/electron/db.js#L1979)）**不含** date_stamp，浏览器无筛选用途 | 仅复习显示链 |
| D124 新模型 | **零消费**（见 §2） | — |

状态：**①被写入且被消费**，但消费面最窄（复习显示 + lint 提示），且无筛选/统计/导出用途。六字段中最接近「②只回显」的一个——但「复习时显示」即其设计用途本身（提醒答案时效），不能据此判无用。

---

## 2. 新模型对照（D124 稿逐节核对）

D124 稿（`docs/design/LEARNER-MODEL-REDESIGN-D124.md`）的数据需求中，与六字段直接相关者：

**领域 —— 保留，且是新模型的活跃信号（代码实证）**

- §6.9「材料属于哪个轨道（`resolveMembership`）」原文（:667）：
  > 其他 mode：`dominantUdc(m) ∈ t.udc_codes`，其中 `dominantUdc(m)` = 来自 m 的卡片 **`cards.domain`（JSON 数组，取第一个元素）出现最多的 UDC 叶子**，要求该叶子 ≥ 3 张卡；不足 3 张卡时改用 lexical 信号……
- §6.9「系统提议轨道（`proposeTracks`）」（:676）：「每个 UDC 叶子，若卡片数 ≥ 5 或自动归属材料 ≥ 2 → 提议……」——卡片计数同样来自 `cards.domain`。
- **已实现**：`learnerRefresh.js` 的 `dominantUdcOf()`（:1729-1750）与 `cardUdcCounts`（:882-890、:1675-1683）真实读取 `card.domain`，喂给 `proposeTracks` / `resolveMembership`（:907、:921）。

**知识点 —— 保留，且是新模型的核心输入（代码实证）**

- §6.5「卡片 → KP（`resolveCardKpMap()`）」原文（:537）：
  > 对所有 `is_deleted=0 AND (status IS NULL OR status='active')` 且 **`knowledge_point_id` 非空**的卡：……返回 `Map<cardId, kpId>`。
- §6.6「KP 掌握等级」：等级判定的 `cards` 输入（R/S/lapses 等）按 KP 分组，分组即依赖卡→KP 映射。
- **已实现**：`resolveCardKpMap` 被 `learnerRefresh.js` 四处调用（:494、:696、:1550、:2032），分别服务词项索引、单元↔KP 链接、KP 等级、推荐快照。

**标签 / 前缀 / 助记 / 标注日期 —— 新模型零需求（双重证据）**

- **文档证据**：D124 稿全文（1463 行）检索 `tags|标签|前缀|助记|dateStamp|date_stamp|标注日期|mnemonic|context_prefix`，命中 14 行全部为无关内容（HTML 标签清洗规则 :383、语言代码 tag :421、UI 中文标签 :604/:1221、`cardType` 卡型取值 `mnemonic` :582、UI 标签控件类名 :1213）。**无一处指这四个字段。**
- **代码证据**：新模型全部实现文件（`electron/lmLex.js / lmLevels.js / lmParams.js / lmRecommend.js / lmStrings.js / lmText.js / learnerDb.js / learnerRefresh.js`）检索 `tags_json|contextPrefix|context_prefix|mnemonic|date_stamp|dateStamp`——**0 命中**。
- 结论：新模型对这四个字段**不保留、不取代、也不读**——它们与新模型完全正交。新模型没有宣布废弃它们，只是设计上不需要它们（掌握度信号来自 FSRS 复习数据 + 阅读事件 + 查词埋点，不来自卡片元数据四件套）。

**另注**：D124 稿 §1.3「保留的部分（不要动）」包括 KnowledgeLint、洞察（M8-B）、用户记忆（M14）——而这三者恰好都消费六字段中的领域/前缀/知识点（见 §1.1/§1.3/§1.5 消费行）。即：**即便只看新模型的「保留清单」，这些字段仍被保留模块依赖。**

---

## 3. 三问直答

**Q1：新模型中是否还需要这些数据？**

需要两个：**领域**（轨道自动归属与提议的核心信号，D124 §6.9，已在 `learnerRefresh.js` 实施消费）与**知识点**（KP 掌握等级、单元关联、推荐快照的卡→KP 映射真源，D124 §6.5/§6.6，已实施消费）。新模型**不需要**另外四个：标签、前缀、助记、标注日期——设计稿全文零提及、实现代码零读取。但这只说明「新模型不读」，不等于「软件里没用了」（见 Q2）。

**Q2：这些数据在软件中是否还真正产生实际用途？**

六个字段**全部有真实下游消费，无一纯遗留**（各字段消费点位见 §1 表格）。其中：
- 领域：消费最广——统计看板（domainMain/domainRank）、成长反馈（材料再逢）、AI 用户记忆（UDC→生活领域）、卡片浏览器、新模型轨道归属。
- 知识点：消费第二广——K2-A 归一、知识点页、材料导图节点状态、成长反馈、洞察、浏览器筛选、新模型 KP 等级。
- 标签：独立组织轴（D94/D101）——`tag:` 筛选、复习队列 scope、词表建议、复习页打标/回显。
- 前缀：复习卡面题面前缀显示（R6 防泄题设计的一环）+ CardLint L5/L13/L18 + 辨析编辑。
- 助记：复习页/卡详情背面辅助字段区显示（D104 三开关可关）——显示即用途。
- 标注日期：复习页 meta 行显示 + CardLint L12——六者中消费面最窄，仅有「复习时提醒时效」这一个用途。

**Q3：在软件当前实际功能中，这些数据在什么环节各起什么作用？**

按环节归纳：
- **制卡时**：六字段全部由手动表单/AI 提示词写入（AI 制卡提示词同样强依赖 domain R17 / 前缀 R6 / dateStamp R11 / 助记 R12——手动表单与 AI 同构即为此）；CardLint（L5/L12/L13/L17/L18）在保存链上检查前缀/日期/标签质量。
- **复习时**：前缀显示在题面（告知领域且防泄题）；助记、标签、标注日期显示在答案揭示后（助记=记忆提示、标签=组织提示、日期=时效提醒）；复习领域月度排名统计用 domain。
- **浏览/检索时**：卡片浏览器详情显示领域，`tag:` 查询筛标签，条件构建器多选知识点。
- **统计时**：数据页领域分布（domainMain/domainDetail/domainRank）全部来自 domain[0]。
- **AI 场景**：AI 用户记忆按书的 domain 分布召回个人记忆；K2-A 归一把 knowledge_point_id 簇值归一到正式 KP；AI 制卡提示词要求输出同构字段。
- **图谱/导图**：知识点页相关卡、材料导图节点 kpExists 标记，均依赖 knowledge_point_id。
- **新模型（下一步推荐）**：domain 决定材料归入哪个学习轨道；knowledge_point_id 决定 KP 掌握等级与巩固推荐。

---

## 4. 证据强度与搜索记录

- 代码实证（行号均在 §1 表格）：schema、写入、全部消费点位；新模型管线的零读取（搜索范围 `electron/{lm*,learner*}.js`，模式 `tags_json|contextPrefix|context_prefix|mnemonic|date_stamp|dateStamp`，0 命中；D124 稿全文同模式 14 命中均无关）。
- 文档佐证：D124 稿 §1.1/§1.3/§2.3/§6.5/§6.6/§6.9/§15 原文（§2 已引用）；GUIDE §4.20（D124 路由摘要）、§4「AI 抽取归一硬性规范」、§8.1 D94/D101（标签系统）、D123（制卡台）；CARD-WORKBENCH-D123.md §33/§87（手动表单 dock 化与自动填写规则）。
- 无重大推断项。唯一接近推断的表述：「标注日期消费面最窄」为事实归纳（消费点位计数），非推测。
- 未发现任何「UI 写入但全仓无读取方」的字段；四个 material-difficulty/knowledge-probe/frontier-explain/structure-analogy AI scope 在渲染层零消费（src/ 检索 4 个 scope 名 0 命中，与 D124 稿 §1.1 普查一致）——这是**scope 层面**的遗留，不属于本诊断的六字段。

## 5. 范围外声明

本报告不做去留拍板、不做删除/迁移方案、不评估 UI 改动。若后续要讨论精简，需注意：六字段与 AI 制卡链同构（改手动表单字段集会牵动 AI 提示词契约与 CardLint 规则集），且领域/知识点已被新模型实施代码依赖。
