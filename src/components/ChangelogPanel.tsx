// v49.173 / D343：更新日志面板（设计 docs/design/CHANGELOG-VIEWER.md §4 ②）。
// 复用 .modal-panel 模态骨架（D120 两步出场、useDialogA11y 的 Esc / 焦点锁 / 焦点归还、遮罩点击关闭）；
// 叠在设置模态之上时 Esc 只关本面板（dialogA11y 栈顶规则）。
// 版式：每个版本＝等宽版本号（当前版本加「当前」标签）+ 右侧等宽日期 + 可选一句话摘要 +
// 「新增 / 改进 / 修复」三组（左列组名、右列条目）；版本之间 hairline 分隔；全部展开不折叠。
import { useDialogA11y } from "../lib/dialogA11y";
import { useDismiss } from "../lib/useDismiss";
import { useOverlayBackdrop } from "../lib/overlayDismiss";
import { getLocale, useT } from "../lib/i18n";
import { KIND_LABEL, groupItems, pickText, type ChangelogEntry } from "../lib/changelog";
import { IconClose } from "./icons";

interface Props {
  entries: ChangelogEntry[];
  currentVersion: string;
  onClose: () => void;
}

export default function ChangelogPanel({ entries, currentVersion, onClose }: Props) {
  const T = useT();
  const { show, requestClose } = useDismiss(onClose);
  const panelRef = useDialogA11y<HTMLDivElement>(requestClose);
  const backdrop = useOverlayBackdrop(panelRef, requestClose);
  const locale = getLocale();
  // 正文：en / ja 取对应译文；zh-CN / zh-TW 取 zh 并经 T()（zh-TW 运行时转繁体，zh-CN 恒等）
  const text = (l: Parameters<typeof pickText>[0]) => {
    const s = pickText(l, locale);
    return locale === "zh-TW" ? T(s) : s;
  };

  return (
    <div className="modal-backdrop" data-show={show ? "in" : "out"} {...backdrop}>
      <div
        className="modal-panel changelog-panel"
        data-show={show ? "in" : "out"}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={T("更新日志")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header changelog-head">
          <h2>{T("更新日志")}</h2>
          <button className="icon-btn modal-close" title={T("关闭")} aria-label={T("关闭")} onClick={requestClose}>
            <IconClose size={18} />
          </button>
        </div>
        <div className="modal-scroll changelog-body">
          {entries.length === 0 && <p className="form-hint">{T("暂无更新记录。")}</p>}
          {entries.map((e) => {
            const isCurrent = e.version === currentVersion;
            return (
              <section key={e.version} className={`changelog-rel${isCurrent ? " is-current" : ""}`}>
                <div className="changelog-rel-head">
                  <span className="changelog-ver">{e.version}</span>
                  {isCurrent && <span className="changelog-cur">{T("当前")}</span>}
                  <span className="changelog-date">{e.date}</span>
                </div>
                {e.summary && <p className="changelog-sum">{text(e.summary)}</p>}
                {groupItems(e).map((g) => (
                  <div key={g.kind} className="changelog-grp">
                    <span className="changelog-kind">{T(KIND_LABEL[g.kind])}</span>
                    <ul>
                      {g.texts.map((l, i) => (
                        <li key={i}>{text(l)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
