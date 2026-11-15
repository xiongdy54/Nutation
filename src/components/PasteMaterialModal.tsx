// v49.3（D177）：粘贴材料全窗口编辑器——「添加材料」选单的「粘贴材料」项与全局快捷键
// Ctrl+Alt+N 的共同出口。原 AddBookModal（书名/语言/正文 + 导入文件四合一）拆分后，正文
// 编辑面从 8 行小窗升级为近满窗（variant="full" 无框文档面），书名/语言保留在头行。
// 保存语义与 D160 期逐字相同：受控镜像 onChange 保 canSave 门控、commitOnUnmount=false
// 防关窗误报提交、Esc＝编辑器提交后经 onEscape 走 useDismiss 两步走出场。
//
// v49.125（D291，设计 docs/design/PASTE-DESTINATION-D291.md §3）：底行加**目的地分段控件**
// （P1 定稿：存为摘录＝默认 / 存为书），说明文字走悬停 + 键盘聚焦 tooltip、不占独立行；
// 主按钮与标题框 placeholder 随目的地切换；摘录模式隐藏语言选框（D4：extracts 无语言列）。
// 目的地只存组件内 state——**每次开窗默认摘录、零新设置键**（不读写 settings）。
import { useId, useRef, useState } from "react";
import { BOOK_LANGUAGES } from "../lib/library";
import { useDialogA11y } from "../lib/dialogA11y";
import { useDismiss } from "../lib/useDismiss";
import { useOverlayBackdrop } from "../lib/overlayDismiss";
import { IconAlert, IconClose } from "./icons";
import MarkdownEditor, { type MarkdownEditorApi } from "./editor/MarkdownEditor";
import { useT } from "../lib/i18n";

/** 保存目的地（D291 §3.2）：extract＝存为摘录（默认）/ book＝存为书（既有行为，逐字不变） */
export type PasteDestination = "extract" | "book";

interface Props {
  /** lang 在 extract 目的地恒为空串（摘录无语言列，查词走句子语境启发） */
  onSave: (title: string, markdown: string, lang: string, destination: PasteDestination) => Promise<void>;
  onClose: () => void;
}

export default function PasteMaterialModal({ onSave, onClose }: Props) {
  const T = useT();
  // D120 §8.1：出场两步走——Esc / 遮罩 / 关闭·取消按钮 / 保存成功自动关，全部收口到 requestClose
  const { show, requestClose } = useDismiss(onClose);
  const panelRef = useDialogA11y<HTMLDivElement>(requestClose);
  const backdrop = useOverlayBackdrop(panelRef, requestClose);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  // 编辑器实例就绪后把光标落到文档末尾（空文档＝开头）：开窗即贴，Ctrl+V 直接可粘
  const mdRef = useRef<MarkdownEditorApi | null>(null);
  // v38（D35）：粘贴书的语言（留空=未知，查词时靠句子语境启发）
  const [lang, setLang] = useState("");
  // v49.125（D291）：目的地——每次开窗默认摘录（组件卸载即重置，不持久化）
  const [destination, setDestination] = useState<PasteDestination>("extract");
  const [saving, setSaving] = useState(false);
  /** 保存失败的原因（onSave reject 时留窗报错，不关窗） */
  const [saveError, setSaveError] = useState<string | null>(null);
  // tooltip 的 aria-describedby 需要唯一 id（样张用递增计数器；React 里 useId 保证唯一且 SSR 安全）
  const tipBase = useId();

  const canSave = markdown.trim().length > 0 && !saving;
  const isExtract = destination === "extract";
  const titleHint = isExtract ? T("标题（留空不加标题）") : T("书名（留空取正文第一行）");

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      // 摘录模式不写语言（extracts 无语言列，D4）——传空串保持契约显式
      await onSave(title, markdown, isExtract ? "" : lang, destination);
      // D120 §8.1：保存成功 → 走 requestClose 两步走出场；失败 catch 留窗报错，不关
      requestClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const destOptions: { value: PasteDestination; label: string; tip: string }[] = [
    { value: "extract", label: T("存为摘录"), tip: T("进入复习推送，正文可随时修改") },
    { value: "book", label: T("存为书"), tip: T("只读源材料，不参与复习推送；慢慢读、从中摘录") },
  ];

  return (
    <div className="modal-backdrop" data-show={show ? "in" : "out"} {...backdrop}>
      <div className="modal-panel paste-modal" data-show={show ? "in" : "out"} ref={panelRef} role="dialog" aria-modal="true" aria-label={T("粘贴材料")} onClick={(e) => e.stopPropagation()}>
        {/* D177-b（用户反馈）：说明文字退役——书名/语言提示收进 placeholder / aria-label / title，
            头行单行「标题 + 书名框 + 语言选框 + 关闭」垂直居中对齐 */}
        <div className="paste-head">
          <h2>{T("粘贴材料")}</h2>
          <input
            className="paste-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={titleHint}
            aria-label={titleHint}
          />
          {/* D4（D291 §12）：摘录模式隐藏语言选框——extracts 无语言列，零 schema 约束下无处可存 */}
          {!isExtract && (
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              aria-label={T("语言（查词按它路由词典；留空自动识别）")}
              title={T("语言（查词按它路由词典；留空自动识别）")}
            >
              {BOOK_LANGUAGES.map((l) => (
                <option key={l.value || "unknown"} value={l.value}>{T(l.label)}</option>
              ))}
            </select>
          )}
          <button className="icon-btn modal-close" title={T("关闭")} aria-label={T("关闭")} onClick={requestClose}>
            <IconClose size={18} />
          </button>
        </div>
        <div className="paste-editor">
          <MarkdownEditor
            ref={mdRef}
            value={markdown}
            onChange={setMarkdown}
            onCommit={(t) => {
              if (t !== null) setMarkdown(t);
            }}
            onEscape={() => requestClose()}
            variant="full"
            commitOnUnmount={false}
            placeholder={T("在这里粘贴你的阅读材料…")}
            ariaLabel={T("正文（粘贴文本，支持 Markdown）")}
            onReady={() => mdRef.current?.focusEnd()}
          />
        </div>
        <div className="paste-foot">
          {saveError && (
            <p className="notice-bar card-marked-error" role="alert">
              <IconAlert />
              <span>{saveError}</span>
            </p>
          )}
          <span className="paste-foot-hint">{T("支持 Markdown")}</span>
          <span className="form-actions-spacer" />
          <button className="btn btn-secondary" onClick={requestClose}>{T("取消")}</button>
          {/* D291 §3.2（P1 定稿）：目的地分段控件——夹在取消与主保存钮之间、与保存相邻。
              说明文字＝悬停 + 键盘聚焦 tooltip（不占独立行），aria-describedby 同时提供给读屏。 */}
          <div className="dest-seg" role="group" aria-label={T("存放位置")}>
            {destOptions.map((opt) => {
              const tipId = `${tipBase}-${opt.value}`;
              const on = destination === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`dest-opt${on ? " on" : ""}`}
                  aria-pressed={on}
                  aria-describedby={tipId}
                  onClick={() => setDestination(opt.value)}
                >
                  <span className="dest-name">{opt.label}</span>
                  <span className="dest-tip" role="tooltip" id={tipId}>{opt.tip}</span>
                </button>
              );
            })}
          </div>
          <button className="btn btn-primary" disabled={!canSave} onClick={handleSave}>
            {saving ? T("保存中…") : isExtract ? T("保存为摘录") : T("保存到书架")}
          </button>
        </div>
      </div>
    </div>
  );
}
