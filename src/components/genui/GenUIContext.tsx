// D299：组件动作与展示面上下文。
// - 动作（makeCards / insertToCard）由宿主 SelectionPanels 提供（同一时刻可能挂多个宿主：阅读器 / 摘录复习 / 制卡台，
//   context 天然就近绑定，不用 EventBus）。
// - 展示面（surface）：只有 AI 面板里的回答是 "panel"（完整工具条）；其余一切展示面（卡面、复习、卡片浏览、日记、
//   制卡面板预览）缺省为紧凑渲染——只出视图、不出工具条（任务卡 T-G4）。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { groundingText } from "../../lib/genui/spec";

export interface GenUIActions {
  /** 以组件内容为材料走 AI 制卡（产出可勾选确认的制卡建议） */
  makeCards?: (markdown: string) => void;
  /** 打开手动制卡面板并预填引用 */
  insertToCard?: (markdown: string) => void;
  /** "panel"＝AI 面板（完整工具条）；缺省＝紧凑（卡面等） */
  surface?: "panel";
  /** D300：落地校验的出处文本（选区 / 追问 / 回答正文，已剥组件代码块）。提供时发音 / 术语组件只展示出现在其中的词条 */
  ground?: string;
}

export const GenUIActionsContext = createContext<GenUIActions>({});
export const useGenUIActions = () => useContext(GenUIActionsContext);

/** AI 面板内的回答区包这一层：继承宿主动作，并声明为完整工具条展示面 */
export function GenUIPanelSurface({ children, ground }: { children: ReactNode; ground: (string | null | undefined)[] }) {
  const parent = useGenUIActions();
  const key = ground.map((p) => p ?? "").join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key 即 ground 的内容指纹
  const text = useMemo(() => groundingText(...ground), [key]);
  return <GenUIActionsContext.Provider value={{ ...parent, surface: "panel", ground: text }}>{children}</GenUIActionsContext.Provider>;
}
