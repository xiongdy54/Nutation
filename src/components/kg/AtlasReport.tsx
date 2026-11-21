// v49.146 / D315（T8）：全谱节点「报错」——类型 + 可选说明，只发白名单字段（electron/atlasReport.js）。
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/ime";
import { kgApi } from "../../lib/kg";
import "./kg.css";

const KINDS: [string, string][] = [
  ["name", "名称错"],
  ["gloss", "说明错"],
  ["parent", "上级错"],
  ["relation", "关系错"],
  ["duplicate", "重复"],
  ["other", "其他"],
];

export default function AtlasReport({ atlasId }: { atlasId: string }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("name");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await kgApi()?.atlasReport({ atlasId, kind, note: note.trim() });
      if (r?.ok) {
        setMsg(r.channel === "post" ? T("已提交，谢谢。") : T("已在浏览器中打开预填的反馈页。"));
        setNote("");
        setOpen(false);
      } else {
        setMsg(T("提交失败：{msg}", { msg: r?.error || "?" }));
      }
    } catch (e) {
      setMsg(T("提交失败：{msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kg-report-wrap" data-testid="kg-atlas-report">
      {!open ? (
        <button className="kg-textbtn" onClick={() => setOpen(true)}>{T("报错")}</button>
      ) : (
        <div className="kg-report">
          <select value={kind} aria-label={T("错误类型")} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{T(label)}</option>)}
          </select>
          <input
            type="text"
            value={note}
            maxLength={500}
            placeholder={T("补充说明（可选）")}
            aria-label={T("补充说明（可选）")}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229) && !isImeComposing(e)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="kg-actions">
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void submit()}>{T("提交")}</button>
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => setOpen(false)}>{T("取消")}</button>
          </div>
          <span className="form-hint">{T("只发送节点编号、错误类型与说明，不含你的卡片或材料。")}</span>
        </div>
      )}
      {msg && <div className="form-hint">{msg}</div>}
    </div>
  );
}
