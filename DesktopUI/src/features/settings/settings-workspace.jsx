import React from "react";
import { Icon } from "../../app/ui.jsx";

const groups = [
  ["game", "游戏与启动", "gamepad"],
  ["window", "游戏窗口", "monitor"],
  ["automation", "自动化", "terminal"],
  ["update", "工具箱更新", "refresh"],
  ["appearance", "外观", "sun"],
  ["shortcuts", "快捷键", "settings"],
  ["launcher", "启动器", "launch-profile"],
];

export function SettingsWorkspace({ children }) {
  return (
    <div className="settings-workspace">
      <nav className="settings-index" aria-label="设置分类">
        {groups.map(([id, label, icon]) => (
          <a key={id} href={"#settings-" + id} onClick={(event) => {
            event.preventDefault();
            const group = document.getElementById("settings-" + id);
            group?.scrollIntoView({ block: "start" });
            group?.focus({ preventScroll: true });
          }}><Icon name={icon} size={16} />{label}</a>
        ))}
      </nav>
      <div className="settings-content">{children}</div>
    </div>
  );
}

export function SettingsGroup({ id, children }) {
  return <div id={"settings-" + id} className="settings-group" tabIndex={-1}>{children}</div>;
}
