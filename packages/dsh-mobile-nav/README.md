# dsh-mobile-nav —— 依赖包说明（未修改）

> 本目录**不包含代码**，只记录该依赖包的来源、版本与协作关系。它由 dsh-web-ext 中的插件**依赖但未修改**，按上游原样安装使用。

## 包信息

| 项 | 值 |
|---|---|
| 包名 | `@dsh-external/dsh-mobile-nav` |
| 上游 | [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（GitHub 源安装） |
| 版本 | 0.2.0 |
| 本机安装方式 | `~/.dsh/profiles/web/package.json`：`"@dsh-external/dsh-mobile-nav": "github:mexiaosqwq/dsh-web-mobile"` |
| 状态 | **未修改**（原样使用上游） |

## 职责

DeepSeek Harness Web GUI 的移动端布局适配壳，负责：

- 移动端 overlay 侧边栏 drawer（呼出/收起、backdrop、FAB 悬浮按钮）
- 会话 header 内的侧边栏呼出按钮（`data-mobile-nav="toggle"`，经 slots 注入）
- 窄屏（≤1023px）下的布局重构：AppFrame 上 `data-mobile-nav="frame"` 标记 + `data-sidebar-collapsed` 状态属性
- 系统状态栏 / 刘海适配、主题色同步、缩放守卫

## 与本工程其他包的协作（重要）

dsh-web-ext 中的两个插件**依赖 mobile-nav 的机制**实现移动端侧边栏呼出：

| 机制 | 用途 |
|---|---|
| `ctx.layout.toggleSidebar()`（官方 layout 服务） | `dsh-tb` 与 `dsh-web-terminal` 面板内的「☰ 侧边栏」按钮调用它——与 mobile-nav 原生按钮**完全同源**（其 onClick 即 `ctx.layout.toggleSidebar()`）。两插件在 client 侧 `inject: ['layout']` 后经 `window.__dshAtbLayoutToggle` / `window.__dshTermLayoutToggle` 暴露 |
| `data-mobile-nav="frame"` + `data-sidebar-collapsed` | drawer 展开/收起的 DOM 事实来源（无 `data-sidebar-collapsed` = 展开）。layout 的 React 渲染管理该属性，插件侧不要直接改它（会与 React 渲染竞态） |
| 移动端会话 header 的 toggle 按钮 | 面板激活时 header 被面板的隐藏规则 `display:none`，按钮不可用/不可靠——所以面板内自备 ☰ 按钮，不依赖 header |

### z-index 约定

- mobile-nav 的 drawer：`z-index: 40`
- `dsh-web-terminal` 面板 `[data-dsh-terminal-view]`：**`z-index: 30`**（必须低于 40，否则盖住 drawer）
- `dsh-tb` 看板视图 `.dsh-atb-view`：无 z-index（auto），天然在 drawer 之下

## 升级注意事项

- mobile-nav 升级后需回归验证手机端：面板内「☰ 侧边栏」能否呼出（依赖 `layout` 服务行为与 `data-sidebar-collapsed` 机制）、「✕ 返回」是否正常。
- 若上游改变了 `data-mobile-nav` / `data-sidebar-collapsed` 机制或 slots 注入方式，`dsh-tb` / `dsh-web-terminal` 的移动端按钮需要同步适配。
- 若未来需要修改 mobile-nav 本身：按 `dsh-web-terminal` 的方式，在 `node_modules` 中修改后将完整 diff 存为 `patches/` 下的补丁文件，并在本 README 的状态栏注明。
