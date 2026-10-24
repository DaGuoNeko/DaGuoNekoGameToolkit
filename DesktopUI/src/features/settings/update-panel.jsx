import React, { useEffect, useState } from "react";
import { Button, Section } from "../../app/ui.jsx";

const call = (method, args = {}) => window.toolkit.call(method, args);
const notesStyle = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 280,
  overflow: "auto",
  font: "inherit",
};
const dateText = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
};

export function UpdatePanel({ version, report }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    let active = true;
    const off = window.toolkit.onUpdate((value) => {
      if (active) setState(value);
    });
    call("update.state")
      .then((value) => {
        if (active) setState(value);
      })
      .catch(report);
    return () => {
      active = false;
      off();
    };
  }, []);
  const run = async (method, args) => {
    try {
      setState(await call(method, args));
    } catch (error) {
      report(error);
    }
  };
  const phase = state?.phase || "idle";
  const busy = ["checking", "downloading", "preparing", "installing"].includes(
    phase,
  );
  return (
    <Section
      title="工具箱更新"
      description={`当前版本 ${version || "读取中…"}。私有仓库成员首次授权后自动检查更新。`}
    >
      <div className="toolbar">
        <Button
          disabled={busy || !state?.authenticated || phase === "downloaded"}
          onClick={() => run("update.check")}
        >
          {phase === "checking" ? "检查中…" : "检查更新"}
        </Button>
        {!state?.authenticated ? (
          <>
            <Button
              disabled={busy || !!state?.authAction}
              onClick={() => run("update.auth.begin")}
            >
              {state?.authAction ? "等待 GitHub 授权…" : "授权 GitHub"}
            </Button>
            {state?.authAction && (
              <Button onClick={() => run("update.auth.logout")}>
                取消授权
              </Button>
            )}
          </>
        ) : (
          <Button disabled={busy} onClick={() => run("update.auth.logout")}>
            退出 GitHub 授权
          </Button>
        )}
      </div>
      {state?.userCode && (
        <p className="muted break-all">
          请在已打开的 GitHub 页面输入验证码：<strong>{state.userCode}</strong>
        </p>
      )}
      {state?.authenticated && (
        <p className="muted">
          GitHub 账号：{state.account || "已授权"} · 启动时及运行期间每 6
          小时自动检查。
        </p>
      )}
      {state?.checkedAt && (
        <p className="muted">
          上次检查：{new Date(state.checkedAt).toLocaleString("zh-CN")}
        </p>
      )}
      {phase === "no-release" && (
        <p className="muted">仓库已连接，尚未发布正式版本。</p>
      )}
      {phase === "up-to-date" && (
        <p className="muted">当前已是最新正式版本。</p>
      )}
      {phase === "available" && (
        <>
          <p>
            发现新版本 <strong>{state.latestVersion}</strong> ·{" "}
            {state.releaseName}
          </p>
          <div className="toolbar">
            <Button
              disabled={!state.canDownload || !state.canInstall}
              onClick={() => run("update.download")}
            >
              下载更新
            </Button>
            {state.releaseUrl && (
              <Button onClick={() => call("update.open-release").catch(report)}>
                查看 GitHub 更新条目
              </Button>
            )}
          </div>
          {!state.canInstall && (
            <p className="muted">
              源码运行时请通过 Git 拉取更新；安装版支持下载和重启安装。
            </p>
          )}
        </>
      )}
      {phase === "downloading" && (
        <div role="status">
          <p>正在下载更新：{state.progress || 0}%</p>
          <progress
            aria-label="更新下载进度"
            value={state.progress || 0}
            max="100"
          />
        </div>
      )}
      {phase === "downloaded" && (
        <Button onClick={() => run("update.install")}>重启并安装更新</Button>
      )}
      {phase === "installing" && (
        <p role="status">正在退出并安装更新，请稍候…</p>
      )}
      {phase === "preparing" && (
        <p role="status">正在校验并准备安装，准备就绪后才会退出当前程序…</p>
      )}
      {state?.error && (
        <p role="alert" className="error-text">
          {state.error}
        </p>
      )}
      {state?.installation?.ok === false && (
        <p role="alert" className="error-text">
          上次安装未完成：{state.installation.error}。旧程序备份：
          {state.installation.backup || "原目录未替换"}
        </p>
      )}
      {!!state?.history?.length && (
        <div aria-label="GitHub 更新历史">
          <h3>更新历史</h3>
          <div style={{ maxHeight: 420, overflow: "auto" }}>
            {state.history.map((release, index) => (
              <details
                key={release.tag}
                open={index === 0 ? true : undefined}
                style={{ marginBlock: 12 }}
              >
                <summary
                  style={{ cursor: "pointer", overflowWrap: "anywhere" }}
                >
                  {release.name} · {release.tag}
                  {release.prerelease ? " · 预发布" : ""} ·{" "}
                  {dateText(release.publishedAt)}
                </summary>
                <pre style={notesStyle}>
                  {release.notes || "该版本没有填写更新说明。"}
                </pre>
                {release.url && (
                  <Button
                    onClick={() =>
                      call("update.open-release", { tag: release.tag }).catch(
                        report,
                      )
                    }
                  >
                    在 GitHub 查看 {release.tag}
                  </Button>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
      {state?.historyError && (
        <p role="alert" className="error-text">
          {state.historyError}
        </p>
      )}
      {state?.historyHasMore && (
        <Button
          disabled={busy || state.historyLoading}
          onClick={() => run("update.history")}
        >
          {state.historyLoading ? "加载中…" : "加载更早版本"}
        </Button>
      )}
    </Section>
  );
}
