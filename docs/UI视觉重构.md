# UI 视觉重构

本页保留既有视觉系统及历史验收。当前导航和业务工作区结构以[工作区与存档数据方案](工作区与存档数据方案.md)与[使用指南](使用指南.md)为准；下方旧页面分组不再作为最新入口说明。

## 工作区交互修正

业务划分和入口关系另见[前端业务与用户路径](前端业务与用户路径.md)：包含参考源码中的业务关联、适用取舍、模块职责和完整用户路径。视觉修正只是其中一部分。

本轮按以下参考核对导航和控件层级，仅借鉴组织方式，不复制主题、源码或引入参考项目的运行依赖：

| 参考 | 阅读范围 | 本工具箱采用的方式 |
|---|---|---|
| [Elysia-Api](https://github.com/PinkElysiaDev/Elysia-Api) | 本地源码快照 `9b72829` 的 Sidebar、AppLayout、PageHeader | 标题与操作分区，退出入口具有清晰的导航归属 |
| [GsCore](https://github.com/Genshin-bots/gsuid_core) | WebConsole 的 AppLayout 发布资源与控制台文档，仓库快照 `950b0c1` | 侧栏、标题栏快捷控件、内容容器各自承担稳定职责 |
| [Koishi WebUI](https://github.com/koishijs/webui) | 快照 `1dc5c0e` 的布局 content/card 组件 | 固定的卡片主体和操作区域，内容滚动不改变导航结构 |
| ChatLuna | 本机授权源码 `1569176` 的 agent-shell/agent-sidebar | 导航数组同时决定显示次序和激活位置，保留草稿与减弱动效支持 |
| ChatLuna V2 | 本机授权源码 `a720c48` 的 shell/sidebar/status | 分组导航、轻量图标控件、状态信息与可点击操作明确分开 |

具体落地：转场直接使用 `workspaces` 中的可见顺序，保留已有 View Transition 的快速切换及减弱动效机制；标题栏状态取消嵌套胶囊，快捷图标设为 `no-drag`，空白区域仍可拖窗；存档卡片主操作与管理工具固定展示，不用 details 展开两三个按钮；存档工作区左上方独立设置“退出存档/退出查看”，滚动时置顶，不与启动、导入等业务动作混排。

交互验收使用 `tests/navigation-polish-ui.cjs`：真实转场的顺序/逆序及二级页恢复、原生鼠标点击标题栏、卡片操作可见且高度不变、顶部退出的键盘操作、深浅主题和窄窗口。隐藏窗口只调整可见性判定以覆盖动画分支，不替换路由实现；标题栏另校验原生拖拽属性，避免 DOM 点击通过却在发行窗口无法点击。

本轮修正已通过开发构建和最终发行 EXE 的交互专项，覆盖 1240×820 浅色与 900×650 深色截图；工作区浏览、导入回归及相关边界测试通过。本地当前版本 ZIP 已重新生成并校验。此次没有运行真实游戏，也没有重新执行与 UI 无关的完整服务套件；前述全套服务测试限制仍保留。

## 目标

本轮重构针对工具箱界面信息密度过高、页面层级不清和各业务页视觉不一致的问题。视觉方向采用面向业务应用的克制工作台：暖灰中性色、低饱和状态色、细边框、小圆角、明确的主要动作，以及按需展开的说明内容。

重构范围只涉及 renderer 的 React/CSS 层。Electron 主进程、preload 白名单、IPC 方法、共享数据模型、存档格式、配置格式、日志归档和游戏运行流程保持原契约。

## 内置方式

Taste-Skill 是开发代理的设计审计技能，不是应用运行时依赖。开发时可按需加载：

```text
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"
npx skills add https://github.com/Leonxlnx/taste-skill-classics --skill "minimalist-ui"
```

项目不把技能文件复制进 `DesktopUI`，也不将其加入 `package.json`。设计规则落在本项目的 `DesktopUI/src/app/visual-refresh.css`、公共 UI 组件和本文件中，避免运行时依赖和构建体积变化。

## 本轮采用的主流做法

本轮检索了 Microsoft Windows、VS Code、Adobe Spectrum 和 Material 3 的公开设计文档。它们的共同方向适合本工具箱：用中性背景层建立层次，用语义颜色表达状态，用稳定的工作区和状态栏承载工具信息，并把键盘、对比度、缩放和高对比度视为视觉设计的一部分。

- [Microsoft Windows design principles](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/design-principles)：强调清晰、可访问、响应式和一致的 Windows 应用体验，并将色彩、布局、导航、动效和可用性一起设计。
- [Microsoft Windows color guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/color)：强调不同主题和强调色下的对比度，并提醒不要只用红绿颜色区分状态。
- [VS Code accessibility](https://code.visualstudio.com/docs/editor/accessibility)：覆盖键盘导航、屏幕阅读器、缩放、高对比度、颜色对比度和状态栏可访问性，适合作为开发工具工作台的验收参考。
- [VS Code UX guidelines](https://code.visualstudio.com/api/ux-guidelines/overview)：将状态栏、侧栏、命令和上下文操作分层，避免把所有操作堆到同一工具栏。
- [Adobe Spectrum color system](https://spectrum.adobe.com/page/color-system/)：强调颜色的语义、层次和主题一致性，不让颜色成为唯一的信息通道。
- [Material 3 color](https://m3.material.io/styles/color/overview)：采用角色化色彩和表面层级，让主色、容器、背景和状态色有稳定职责。

对本项目的取舍是：保留深色开发工具氛围，但把背景和卡片改成更清晰的表面层；就绪使用绿色、进行中使用主题色或琥珀色、错误使用暗红色；状态点旁边始终保留文字；卡片和日志工作区使用边界与间距建立层次，减少强阴影和悬浮位移。这样更接近 VS Code/Windows 工具类产品的工作台美学，而不是营销网站的装饰风格。

## 视觉系统

公共 token 位于 `DesktopUI/src/app/visual-refresh.css`：

- 浅色使用暖灰背景、米白表面、炭黑正文和低对比度边框。
- 深色使用近黑背景、深灰表面和暖白正文。
- 主要动作使用主题色相生成的低饱和色；成功、警告、错误分别使用绿色、琥珀色和暗红色。工具箱就绪和游戏会话运行都使用绿色状态点，不使用灰色表示可用状态。
- 普通内容页使用 6/10/14px 圆角层级；阴影只用于浮层和少量主要卡片。
- `prefers-reduced-motion` 关闭平移、转场和其他非必要动效。

公共组件仍由 `DesktopUI/src/app/ui.jsx` 提供。`Button` 新增的 `compact` 只改变显示方式，保留原有文字和 ARIA 名称；`HelpDisclosure` 将长说明收进原生 `details`，不会隐藏错误、状态或危险操作。

## 页面结构

### 应用外壳

侧栏按四组组织：

- 工作台：存档、联机房间、启动配置、模组库。
- 观察：运行日志。
- 开发：游戏调试、UI 调试器、UI 编辑器、Tracy 性能。
- 系统：游戏设置、设置、关于。

顶栏显示当前页面和会话状态。侧栏折叠后保留图标和 `title`，不会改变导航 ID 或页面路由。

### 存档

存档页以卡片网格展示地图状态、启动配置、世界类型和更新时间。启动存档是主操作；存档设置、删除、目录和地图预览使用图标化次要操作。地图预览沿用已有只读 IPC 和来源校验。

### 联机房间

创建、加入和运行中的房间仍使用同一套状态机。网络、游戏和玩家回执显示为状态点和短标签；EasyTier、邀请码保存、资源包下载和重连规则放入可展开说明。邀请文本和玩家名仍由原表单处理，不进入视觉层缓存或日志。

### 启动配置与模组库

配置卡片突出编辑和启动，路径只显示最后两级目录，完整路径保留在 `title`。模组卡片增加图标和可用性状态，失效目录使用警告色，打开目录、编辑和移除变成紧凑图标按钮。

### 运行日志

日志页面保持 IDE 式布局：工具栏、会话卡片、实时控制台和设置抽屉。日志页使用专用紧凑间距，确保搜索、刷新、归档、跟随和控制台高度不被普通页面的留白规则挤压。日志文本、筛选、历史分页和删除确认不变。

### 游戏调试、UI 调试器、UI 编辑器和 Tracy

这些页面保留工作台结构和官方工具区域。调试标签增加图标；UI 调试器继续使用树/属性两栏；UI 编辑器继续使用控件树/画布/属性三栏，文件、保存、撤销、重做和预览动作只做视觉分组；Tracy 不重绘官方窗口，只调整外层工具栏和帮助说明。

### 设置

设置页增加左侧分类索引，右侧仍按原顺序渲染设置组件。索引只滚动到现有 DOM 节点，不创建第二套状态，也不改变设置保存 IPC。复杂说明使用折叠区域，更新、自动化和窗口尺寸组件保持原实现。

## 业务安全边界

重构后必须保持以下约束：

1. `window.toolkit.call(method, args)` 的方法名、参数和返回值不变。
2. session ID、generation、房间代次、存档 ID 和 profile ID 继续由原父组件传递。
3. 配置草稿、游戏设置草稿、UI 编辑器草稿和日志分页游标继续由原状态管理。
4. 启动、停止、重载、热更新、联机加入和危险删除仍必须经过原确认和失败处理。
5. 图标按钮保留可访问名称；状态不只依赖颜色，日志和错误继续使用可读文本。
6. 不在 renderer 视觉组件内新增 IPC 订阅或数据源，避免出现第二套会话状态。

## 验收

开发目录下执行：

```powershell
cd DesktopUI
npm.cmd run build
npm.cmd test
npm.cmd run test:ui
```

本轮验证结果：

- 构建通过。
- 服务和共享逻辑测试：391/391 通过。
- Electron UI 测试：更新、Tracy、自动化、UI 编辑器、游戏设置、配置/存档、日志、归档搜索、导入、地形和地图预览通过。
- 联机房间专项 UI 测试通过。
- 截图检查覆盖 1240×820 浅/深主题、日志设置抽屉、UI 编辑器、UI 调试器、设置分类、存档卡片、启动配置和地图预览；地图预览专项也覆盖 900×650。
- `prefers-reduced-motion: reduce` 已在 UI 测试中使用，并保留键盘、ARIA 和现有语义选择器。
- 2026-11-03 补充：就绪状态点改为绿色，游戏会话运行中使用主题色点；深色主题成功色提高亮度，避免把可用状态画成灰色。

发行 EXE 需要在生成新包后重新执行 distribution UI 验收；当前工作区没有提供新的发行 EXE，因此本轮不把发行包验收写成已通过。
