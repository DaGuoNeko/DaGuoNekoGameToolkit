import React, { useEffect, useState } from "react";
import { Button, Section } from "../../app/ui.jsx";
import "./update-panel.css";

const call = (method, args = {}) => window.toolkit.call(method, args);
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
      <div className="update-panel">
        <div className="toolbar update-actions">
          <Button
            primary={state?.authenticated}
            disabled={busy || !state?.authenticated || phase === "downloaded"}
            onClick={() => run("update.check")}
          >
            {phase === "checking" ? "检查中…" : "检查更新"}
          </Button>
          {!state?.authenticated ? (
            <>
              <Button
                primary
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
          <div className="update-auth-code">
            <span>请在已打开的 GitHub 页面输入验证码</span>
            <strong>{state.userCode}</strong>
          </div>
        )}
        {(state?.authenticated || state?.checkedAt) && (
          <div className="update-meta">
            {state?.authenticated && (
              <div className="update-meta-item">
                <span className="update-meta-label">GitHub 账号</span>
                <strong className="update-meta-value">
                  {state.account || "已授权"}
                </strong>
              </div>
            )}
            {state?.checkedAt && (
              <div className="update-meta-item">
                <span className="update-meta-label">上次检查</span>
                <strong className="update-meta-value">
                  {new Date(state.checkedAt).toLocaleString("zh-CN")}
                </strong>
              </div>
            )}
          </div>
        )}
        {state?.authenticated && (
          <p className="update-meta-note">
            启动时及运行期间每 6 小时自动检查。
          </p>
        )}
        {phase === "no-release" && (
          <p className="update-status" role="status">
            <span className="update-status-dot" />
            仓库已连接，尚未发布正式版本。
          </p>
        )}
        {phase === "up-to-date" && (
          <p className="update-status update-status-success" role="status">
            <span className="update-status-dot" />
            当前已是最新正式版本。
          </p>
        )}
        {phase === "available" && (
          <div className="update-available">
            <div className="update-available-heading">
              <div>
                <span className="update-kicker">发现新版本</span>
                <strong className="update-version">{state.latestVersion}</strong>
                <p className="update-release-name">{state.releaseName}</p>
              </div>
              <span className="update-badge">可更新</span>
            </div>
            <div className="toolbar">
              <Button
                primary
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
              <p className="muted update-hint">
                源码运行时请通过 Git 拉取更新；安装版支持下载和重启安装。
              </p>
            )}
          </div>
        )}
        {phase === "downloading" && (
          <div className="update-progress" role="status">
            <div className="update-progress-label">
              <span>正在下载更新</span>
              <strong>{state.progress || 0}%</strong>
            </div>
            <progress
              aria-label="更新下载进度"
              value={state.progress || 0}
              max="100"
            />
          </div>
        )}
        {phase === "downloaded" && (
          <div className="update-available update-ready">
            <div>
              <span className="update-kicker">更新已准备就绪</span>
              <p>重启应用后完成安装。</p>
            </div>
            <Button primary onClick={() => run("update.install")}>
              重启并安装更新
            </Button>
          </div>
        )}
        {phase === "installing" && (
          <p className="update-status" role="status">
            <span className="update-status-dot" />
            正在退出并安装更新，请稍候…
          </p>
        )}
        {phase === "preparing" && (
          <p className="update-status" role="status">
            <span className="update-status-dot" />
            正在校验并准备安装，准备就绪后才会退出当前程序…
          </p>
        )}
        {state?.error && (
          <p role="alert" className="update-alert">
            {state.error}
          </p>
        )}
        {state?.installation?.ok === false && (
          <p role="alert" className="update-alert">
            上次安装未完成：{state.installation.error}。旧程序备份：
            {state.installation.backup || "原目录未替换"}
          </p>
        )}
        {!!state?.history?.length && (
          <div className="update-history" aria-label="GitHub 更新历史">
            <div className="update-history-heading">
              <div>
                <h3>更新历史</h3>
                <p>查看已发布版本的变更内容</p>
              </div>
              <span className="update-history-count">{state.history.length}</span>
            </div>
            <div className="update-history-list">
              {state.history.map((release, index) => (
                <details
                  key={release.tag}
                  className="update-release"
                  open={index === 0 ? true : undefined}
                >
                  <summary>
                    <span className="update-release-summary">
                      <span className="update-release-main">
                        <strong>{release.name}</strong>
                        <span className="update-release-tag">{release.tag}</span>
                        {release.prerelease && (
                          <span className="update-release-prerelease">预发布</span>
                        )}
                      </span>
                      <span className="update-release-date">
                        {dateText(release.publishedAt)}
                      </span>
                    </span>
                  </summary>
                  <pre className="update-release-notes">
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
          <p role="alert" className="update-alert">
            {state.historyError}
          </p>
        )}
        {state?.historyHasMore && (
          <div className="update-load-more">
            <Button
              disabled={busy || state.historyLoading}
              onClick={() => run("update.history")}
            >
              {state.historyLoading ? "加载中…" : "加载更早版本"}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
