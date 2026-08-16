# dsh-tb —— 修复版 dsh-taskboard

上游：[cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard) v0.3.3（Apache-2.0）

## 问题

Web GUI 侧边栏「任务看板」入口点击没有任何反应（看板视图不显示）。

**根因**：本机 DeepSeek Harness Web shell（0.1.0-rc.6）的 DOM 结构中，中心会话列**没有 `data-pane` 属性**，而是 `centerCol` class。上游 `board-mount.tsx` 只按 `[data-pane="conversation"]` 查找中心列，找不到 → 看板 React 树永不挂载。

对比同环境已验证可用的 `dsh-web-terminal`，其中心列选择器带兜底：

```js
// dsh-web-terminal（可用版本）
'[data-pane="conversation"], [class*="centerCol"]'
// dsh-taskboard 上游（坏）
'[data-pane="conversation"]'
```

## 补丁内容

| 文件 | 修改 |
|---|---|
| `src/client/board-mount.tsx` | `CONVERSATION_COLUMN_SELECTOR` 增加 `[class*="centerCol"]` 兜底 |
| `src/client/styles.ts` | 看板激活时隐藏会话内容的 CSS 规则，补充 `[class*="centerCol"]` 选择器分支 |

`src/client/sidebar-entry.ts` 的侧边栏选择器 `[data-pane="sidebar"], [class*="sidebarCol"]` 本机可用（`sidebarCol` 存在），未改动。

## 构建

```sh
npm install          # 若 esbuild postinstall 被拦：node node_modules/esbuild/install.js
npm run build        # 产物输出到 lib/
```

## 部署（web profile）

```sh
cp -r lib /home/archie/.dsh/profiles/web/node_modules/dsh-taskboard/
# package.json 中 dependencies["dsh-taskboard"]="0.3.3"、bundles 含 "dsh-taskboard"（已登记）
# 重启 dsh web 生效
```

## 验证

- 构建后 `lib/client.js` 中应包含 `[class*="centerCol"]`。
- 重启后浏览器刷新：侧边栏「任务看板」入口点击应弹出看板视图；`window.__atbDebug`（`attempts/found/placed`）可用于排查入口未显示的问题。
