// v49.8（D182）：zh-TW 领域词覆盖表（简化字级，应用于 opencc cn→twp 转换**之前**，最长优先）。
// 只覆盖 opencc 词库缺项、或本项目需要特定译法的词；其余交给 opencc 常规转换
//（软件→軟體、设置→設定、文件→檔案、界面→介面、队列→佇列、标签→標籤 等由 twp 词库承担）。
// 值侧允许直接写繁体（该片段原样通过 opencc——已是繁体不再变化）。
// F-9：三套表格合并为 electron/zhTwOverrides.json——主进程与渲染层共读同一份事实。
// 放在 electron/ 下是因为 electron-builder 只打包 dist/、electron/、vendor/；
// 渲染层经 Vite / tsc 的 resolveJsonModule 直接 import 该 JSON。
// 注：源代码→原始碼 为 D223 台湾惯用取词，值随表迁入 JSON。
import sharedOverrides from "../../electron/zhTwOverrides.json";

export const zhTwOverrides: Record<string, string> = sharedOverrides;
