// v49.173 / D343：更新日志正文（设计 docs/design/CHANGELOG-VIEWER.md §2）。
// 纯数据，随前端打包，零网络。**新版本放最前**。
//
// 编写规则（发版流程的一步）：
//  - 条目在开发仓按**即将发布的版本号**编写，随运行代码同步到发布仓；版本号本身仍只在发布仓 bump。
//  - 发布当天把 date 改成实际发布日期；GitHub 发布说明从这里复制，保证只有一份事实。
//  - 每条写给用户看：说「现在能做什么 / 哪里变好了」，不写实现细节与内部编号。
//  - zh 必填；en 可省（缺译回落 zh）；ja 不维护（缺省即回落 zh）；繁体由界面语言运行时自动转换，不必手写。
import type { ChangelogEntry } from "./index";

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.0.14",
    date: "2026-11-28",
    summary: {
      zh: "知识图谱全新设计：知识点以原文为依据，关联路径直接画在图上。材料导图和结构全景更整洁，含较多摘录的 PDF 滚动更顺，更新后也能看到这份日志。",
      en: "A redesigned knowledge graph: concepts are grounded in your source text, and connection paths are drawn right on the graph. Cleaner material maps and overview, smoother scrolling in PDFs with many excerpts, and this changelog appears after each update."
    },
    items: [
      {
        kind: "new",
        text: {
          zh: "知识图谱全新设计：读到一段并停留一会儿后，系统会提取其中原文讲到或用到的术语，每条附原文引文，能追溯到材料里的出处。顺带提到的不记（由「原文术语分析」设置控制）",
          en: "A redesigned knowledge graph: after you linger on a passage, the concepts the text explains or uses are extracted, each with a quoted passage you can trace back to the source. Passing mentions are not recorded (controlled by the “Source term analysis” setting)"
        }
      },
      {
        kind: "new",
        text: {
          zh: "知识图谱的节点详情里有「原文里」一栏，列出这个概念在原文中被讲到或用到的句子。句子前的方块，实心表示你读过这段，空心表示还没读到；点击句子可跳到导图上的对应位置。只有有记录的概念才显示这一栏",
          en: "The node details in the knowledge graph have an “In the source text” section listing the sentences where the concept is explained or used. A square beside each sentence is filled if you've read that passage and hollow if not; click a sentence to jump to its spot on the mind map. The section appears only for concepts with recorded passages"
        }
      },
      {
        kind: "new",
        text: {
          zh: "论证类连线可以查看依据：详情里显示两端的原文句子和它们之间的关系",
          en: "Argument connections show their evidence: the details panel displays the source sentences on both ends and how they relate"
        }
      },
      {
        kind: "new",
        text: {
          zh: "「连到我学过的」：在图上直接画出一个概念与你已学知识之间的路径，路径可以经过你自己的图谱和材料；你学过、但全谱里没有对应条目的知识点，也能作为起点。图谱里找不到可靠路径时，若已配置 AI，会自动请 AI 找一次，结果以虚线显示，由你点「对」或「不对」确认",
          en: "“Connect to what I've learned” draws the path from a concept to what you have already learned, right on the graph. Paths can pass through your own graph and materials, and a learned concept with no full-spectrum entry can also serve as a starting point. If no reliable path exists and AI is configured, it tries once automatically; its suggestion appears as a dashed line for you to confirm with “Correct” or “Incorrect”"
        }
      },
      {
        kind: "new",
        text: {
          zh: "设置里新增「原文术语分析」：「关」只显示你自己制卡的知识点；「阅读时」（默认）读到哪里分析到哪里；「整本预处理」打开一本书就分析全书（跳过叙事、背景等段落），AI 用量较大",
          en: "New “Source term analysis” setting in Settings: “Off” shows only the concepts you made cards for; “While reading” (default) analyzes as you go; “Whole book up front” analyzes the whole book on open (skipping narrative and background passages), using more AI"
        }
      },
      {
        kind: "new",
        text: {
          zh: "更新日志：更新后右下角会提示一次，也可以在「设置 · 关于」里随时查看",
          en: "Changelog: after an update a one-time note appears at the bottom right; you can also open it anytime from Settings · About"
        }
      },
      {
        kind: "new",
        text: {
          zh: "设置里新增「无障碍支持」开关，默认关闭，以保证阅读滚动流畅。关闭时屏幕阅读器等辅助工具读不到界面；开启后需重启才生效",
          en: "New “Accessibility support” switch in Settings, off by default to keep reading smooth. While it is off, screen readers and other assistive tools cannot read the interface. Turning it on takes effect after a restart"
        }
      },
      {
        kind: "improved",
        text: {
          zh: "结构全景：节点卡片宽度随内容变化（最宽 360），整张卡可滚动；单击节点即选中并展开它的子节点，再单击已选中的父节点可收起或重新展开，单击已选中的叶节点则居中；展开的步骤不再压到相邻步骤。卡片上的「展开结构 / 收起结构」按钮已移除",
          en: "Overview: node cards grow with their content (up to 360 wide) and scroll as a whole. Click a node to select it and expand its children; click a selected parent again to collapse or expand it; click a selected leaf to center it. Expanded steps no longer overlap their neighbors. The “Show structure” / “Hide structure” button on cards has been removed"
        }
      },
      {
        kind: "improved",
        text: {
          zh: "材料导图：同一层有 3 个以上只有编号、没有标题文字的章节（如格言体书里的「一、二、三……」）时，不再各占一个空节点，内容并入上一级。对新生成的导图生效",
          en: "Material mind map: when a level has three or more sections that consist only of numbering with no title text (such as “I, II, III…” in aphorism-style books), they no longer each take an empty node; their content moves up one level. Applies to newly generated maps"
        }
      },
      {
        kind: "improved",
        text: {
          zh: "关联路径搜索更快，较远的知识之间也更容易找到路径；节点移动的过渡更平滑",
          en: "Connection paths search faster, and paths between distant concepts are easier to find. Node movement on the graph is smoother"
        }
      },
      {
        kind: "improved",
        text: {
          zh: "含较多摘录标记的 PDF 阅读滚动更流畅",
          en: "Smoother scrolling in PDFs with many excerpt markers"
        }
      },
      {
        kind: "improved",
        text: {
          zh: "右下角的后台进度提示换成统一样式，多条同时出现时自动排列",
          en: "Background progress notes at the bottom right share one unified style and stack neatly when several appear"
        }
      }
    ]
  }
];
