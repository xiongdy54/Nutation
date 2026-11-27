// v49.173 / D343：更新日志宿主（设计 docs/design/CHANGELOG-VIEWER.md §3）——启动判定 + 提示 + 面板状态。
// App 只调用 useChangelog()：notice 放进右下角通知栈，panel 放在设置模态之后（叠在其上）。
import { useCallback, useEffect, useState } from "react";
import { settingsStore } from "../lib/settings";
import { libraryApi } from "../lib/library";
import { CHANGELOG } from "../lib/changelog/entries";
import { SEEN_KEY, decideNotice, findEntry, onOpenChangelog } from "../lib/changelog";
import ChangelogNotice from "./ChangelogNotice";
import ChangelogPanel from "./ChangelogPanel";

/** 启动后多久再判定 / 出现（首屏先稳定；JS 计时器，非动画参数） */
const NOTICE_DELAY_MS = 1500;

/** 取版本失败时的重试（JS 计时器，非动画参数） */
const VERSION_RETRY_MS = 500;
const VERSION_RETRIES = 20;

// 版本号复用 update:status 快照（D180，不新增 IPC）。该通道由主进程 updater.init 注册，晚于主窗口加载——
// 启动早期调用会报「No handler registered」，所以重试到拿到为止（约 10s 封顶）；结果全模块共享。
let versionPromise: Promise<string> | null = null;

function currentVersion(): Promise<string> {
  if (!versionPromise) {
    versionPromise = (async () => {
      const api = (window as unknown as { updateAPI?: { status: () => Promise<{ currentVersion: string }> } }).updateAPI;
      if (!api) return "";
      for (let i = 0; i < VERSION_RETRIES; i++) {
        try {
          const v = (await api.status()).currentVersion;
          if (v) return v;
        } catch {
          /* 通道尚未注册：稍后再试 */
        }
        await new Promise((r) => window.setTimeout(r, VERSION_RETRY_MS));
      }
      return "";
    })();
  }
  return versionPromise;
}

// 判定只跑一次、结果由所有挂载共享：App 在启动早期可能重挂（语言 / 皮肤装载），
// 若判定绑在某一次挂载上，那次挂载卸载时已写入「已读」却丢了提示，下一次挂载又判为已读——提示永远不出现。
let decision: Promise<boolean> | null = null;

function decideOnce(): Promise<boolean> {
  if (!decision) {
    decision = new Promise<boolean>((resolve) => {
      window.setTimeout(async () => {
        try {
          const v = await currentVersion();
          const hasEntry = !!findEntry(CHANGELOG, v);
          if (!v || !hasEntry) return resolve(false); // 开发版等：无条目，什么都不做（也不读书架）
          const seen = await settingsStore.get<unknown>("app", SEEN_KEY, "");
          const libraryEmpty = seen ? true : (await libraryApi.list()).length === 0;
          const d = decideNotice({ currentVersion: v, seenVersion: seen, hasEntry, libraryEmpty });
          if (d === "none") return resolve(false);
          // 每个版本最多一次：出现即记已读（用户是否点开都不再提示）
          await settingsStore.set("app", SEEN_KEY, v);
          resolve(d === "show");
        } catch {
          resolve(false); // 判定失败静默：不提示，下次启动再判
        }
      }, NOTICE_DELAY_MS);
    });
  }
  return decision;
}

export function useChangelog() {
  const [version, setVersion] = useState("");
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  // 版本号：面板「当前」标签也要用，独立于提示判定取一次
  useEffect(() => {
    let alive = true;
    void currentVersion().then((v) => alive && setVersion(v));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => onOpenChangelog(() => setPanelOpen(true)), []);

  useEffect(() => {
    let alive = true;
    void decideOnce().then((show) => {
      if (show && alive) setNoticeOpen(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closeNotice = useCallback(() => setNoticeOpen(false), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);

  return {
    notice:
      noticeOpen && version ? (
        <ChangelogNotice key="changelog" version={version} onOpen={openPanel} onDone={closeNotice} />
      ) : null,
    panel: panelOpen ? <ChangelogPanel entries={CHANGELOG} currentVersion={version} onClose={closePanel} /> : null
  };
}
