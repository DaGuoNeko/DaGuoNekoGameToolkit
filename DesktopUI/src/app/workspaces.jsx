import React, { useEffect, useRef, useState } from "react";
import "./workspaces.css";

export const workspaces = [
  { id: "launch", label: "存档", icon: "archive", group: "资源", pages: [["launch", "存档库"]] },
  { id: "mods", label: "模组与资源", icon: "cube", group: "资源", pages: [["mods", "模组与内容"], ["ui-editor", "UI 编辑器"]] },
  { id: "config", label: "启动配置", icon: "launch-profile", group: "资源", pages: [["config", "启动配置"]] },
  { id: "logs", label: "运行与调试", icon: "bug", group: "运行", pages: [["runtime", "控制台"], ["logs", "运行日志"], ["debug", "代码与函数"], ["ui-debug", "UI 调试器"], ["tracy", "性能"]] },
  { id: "rooms", label: "远程联机", icon: "gamepad", group: "运行", pages: [["rooms", "联机房间"]] },
  { id: "netease-config", label: "网易全局配置", icon: "folder", group: "工具箱", pages: [["netease-config", "网易全局配置"]] },
  { id: "quick-launch", label: "快捷程序", icon: "tools", group: "工具箱", pages: [["quick-launch", "快捷程序"]] },
  { id: "activity", label: "任务与记录", icon: "activity", group: "工具箱", pages: [["activity", "任务与记录"]] },
  { id: "settings", label: "设置", icon: "gear", group: "工具箱", pages: [["settings", "工具箱设置"], ["game-options", "游戏启动设置"], ["about", "关于"]] },
];
export const workspaceFor = page => workspaces.find(workspace => workspace.pages.some(([id]) => id === page));

// 只保存当前窗口的浏览状态，不把临时来源、查询和草稿写入用户配置。
const retained = new Map();
function remember(key, value) {
  retained.delete(key); retained.set(key, value);
  while (retained.size > 32) retained.delete(retained.keys().next().value);
}
export function useWorkspaceState(key, initial) {
  const [value, setValue] = useState(() => retained.has(key) ? retained.get(key) : typeof initial === "function" ? initial() : initial);
  const latest = useRef(value); latest.current = value;
  useEffect(() => () => remember(key, latest.current), [key]);
  return [value, next => {
    const updated = typeof next === "function" ? next(latest.current) : next;
    latest.current = updated; remember(key, updated); setValue(updated);
  }];
}

export function WorkspaceTabs({ tabs, value, onChange, label = "工作区工具" }) {
  return <nav className="workspace-tabs" aria-label={label}>{tabs.map(([id, name]) =>
    <button key={id} aria-current={id === value ? "page" : undefined} className={id === value ? "active" : ""} onClick={() => onChange(id)}>{name}</button>)}</nav>;
}
