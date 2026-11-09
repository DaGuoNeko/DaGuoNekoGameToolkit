const destinations = {
  "存档": ["存档"], "启动配置": ["启动配置"], "模组库": ["模组与资源", "模组与内容"], "模组与内容": ["模组与资源", "模组与内容"],
  "运行日志": ["运行与调试", "运行日志"], "游戏调试": ["运行与调试", "代码与函数"], "UI 调试器": ["运行与调试", "UI 调试器"],
  "Tracy 性能": ["运行与调试", "性能", "Tracy"], "性能": ["运行与调试", "性能"], "控制台": ["运行与调试", "控制台"],
  "UI 编辑器": ["模组与资源", "UI 编辑器"], "联机房间": ["远程联机"], "项目日志": ["任务与记录"],
  "游戏设置": ["设置", "游戏启动设置"], "设置": ["设置", "工具箱设置"], "关于": ["设置", "关于"],
};
async function navigate(page, name) {
  const [root, tab, tool] = destinations[name] || [name];
  await page.locator(".sidebar").getByRole("button", { name: root, exact: true }).click();
  if (tab) await page.getByRole("navigation", { name: "工作区工具", exact: true }).getByRole("button", { name: tab, exact: true }).click();
  if (tool) await page.getByRole("tab", { name: tool, exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.pageAnimating);
  return root;
}
module.exports = { navigate, destinations };
