import React, { useEffect, useState } from "react";
import { Button, Section } from "../../app/ui.jsx";
export function AutomationSettings({ settings, save, report }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    window.toolkit.call("automation.status").then(setStatus).catch(report);
  useEffect(() => {
    refresh();
  }, [settings.AutomationEnabled]);
  const toggle = async () => {
    setBusy(true);
    try {
      await save({ AutomationEnabled: !settings.AutomationEnabled });
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="AI 多客户端 MCP"
      description="让 AI 启动客户端并自动加入指定主房间、查看各自日志，或按会话执行代码、热更新和调用 MCDK。连接只在本机开放，与原 MCDK MCP 可同时使用。"
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button disabled={busy} onClick={toggle}>
          {settings.AutomationEnabled ? "关闭 AI MCP" : "开启 AI MCP"}
        </Button>
        <Button onClick={refresh}>刷新 MCP 状态</Button>
        <Button
          onClick={() =>
            window.toolkit.call("automation.copy-config").catch(report)
          }
        >
          复制通用 MCP 配置
        </Button>
      </div>
      <p className="muted">
        {status?.enabled
          ? `已开启 · 本机端口 ${status.port} · ${status.clients.length} 个客户端`
          : "已关闭"}
      </p>
      <p className="muted break-all">
        stdio 服务：{status?.serverFile || "读取中…"}
      </p>
      <p className="muted">
        需要 Node.js 22 或更新版本。AI
        调试客户端仍先进入主菜单，手动联机后调试能力才会就绪；普通空白客户端保持无模组。关闭
        MCP 不会关闭游戏。
      </p>
    </Section>
  );
}
