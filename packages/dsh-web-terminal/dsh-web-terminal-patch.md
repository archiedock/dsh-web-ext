# dsh-web-terminal tailnet 访问补丁记录

- 插件：`dsh-web-terminal@0.1.0`（npm）
- 安装位置：`/root/.dsh/profiles/web/node_modules/dsh-web-terminal/`
- 文件：`lib/index.js`，函数 `isLoopbackRequest`
- 日期：2026-08-16

## 问题

插件的信任围栏 `isLoopbackRequest` 只放行 loopback（socket 地址 + Host 头均须为
127.0.0.1/localhost）。手机经 tailscale（`archie-pc.tailaeca49.ts.net` /
`100.67.107.110`）访问时，`/api/dsh-terminal/info` 与 WebSocket 均返回
`403 forbidden: loopback-only`，终端面板黑屏无响应。

## 改动

1. 允许的 socket 远端地址增加 `100.67.107.110`（tailscale 对端 IP）
2. 允许的 Host 主机名增加 `archie-pc.tailaeca49.ts.net` 与 `100.67.107.110`

```diff
-  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
+  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1" && address !== "100.67.107.110") return false;
...
-  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
+  const TRUSTED_HOSTS = ["127.0.0.1", "localhost", "[::1]", "archie-pc.tailaeca49.ts.net", "100.67.107.110"];
+  if (!TRUSTED_HOSTS.includes(hostUrl.hostname)) return false;
```

## 注意

- 补丁位于 node_modules，插件升级会被覆盖，升级后需重新应用。
- 安全影响：放宽后，能连到 3081 且 Host 匹配上述域名的请求可取得宿主 shell，
  仅限可信 tailnet 场景使用。

---

## 追加：dsh-mobile-nav 移动端适配补丁

- 文件：`/root/.dsh/profiles/web/node_modules/@dsh-external/dsh-mobile-nav/lib/client.js`
- 日期：2026-08-16

移动端（<1024px）侧边栏 rail 变成 overlay 抽屉，终端入口按钮在抽屉内可点，
但 mobile-nav 的抽屉点击处理不认 `data-dsh-terminal-entry`，点击后抽屉不关，
终端面板被抽屉盖住。

### 改动 1：点终端入口时关闭抽屉

```diff
- const navigates = target.closest('button[data-dsh-taskboard-entry], button[data-dsh-ssh-entry], [class*="newSession"], ...');
+ const navigates = target.closest('button[data-dsh-taskboard-entry], button[data-dsh-ssh-entry], button[data-dsh-terminal-entry], [class*="newSession"], ...');
```

### 改动 2：终端接管时隐藏 FAB / backdrop

```diff
  html[data-dsh-taskboard-active] [data-mobile-nav="fab"],
  html[data-dsh-ssh-active] [data-mobile-nav="fab"],
+ html[data-dsh-terminal-active] [data-mobile-nav="fab"],
  html[data-dsh-taskboard-active] [data-mobile-nav="backdrop"],
  html[data-dsh-ssh-active] [data-mobile-nav="backdrop"],
+ html[data-dsh-terminal-active] [data-mobile-nav="backdrop"] {
    display: none !important;
  }
```

客户端补丁按请求实时下发（rev=sha1 前缀），刷新页面即生效，无需重启服务。

---

## 追加：xterm 零尺寸容器 open 崩溃修复（白屏）

- 文件：`/root/.dsh/profiles/web/node_modules/dsh-web-terminal/lib/client.js`
- 日期：2026-08-16
- 参考：[omdsh-dev/DSH-better-sidebar #25/#27/#42](https://github.com/omdsh-dev/DSH-better-sidebar/issues/42)

面板在启动时自动建 tab 并在 `display:none`（面板隐藏）状态下同步执行
`term.open(container)`——xterm 在零尺寸容器 open 时渲染器创建失败，下一次
Viewport refresh 读 `undefined.dimensions` 崩溃 → 终端区域空白（手机上
白屏）。修复：把 open+fit 推迟到容器有实际尺寸后（`openWhenSized`，
rAF 轮询 `clientWidth/Height > 0`，open 恰好一次），socket 照常先连，
xterm WriteBuffer 缓冲 open 前的输出，open 后补发真实 cols/rows。

```diff
  fit = new o();
  term.loadAddon(fit);
- term.open(container);
- requestAnimationFrame(() => { try { fit?.fit(); } catch {} });
  connection = api.openTerminal(term.cols, term.rows);
  ...
+ // 推迟 open 到容器有尺寸后
+ const cancelOpen = openWhenSized(container, () => {
+   try {
+     term.open(container);
+     fit.fit();
+     connection?.resize(term.cols, term.rows);
+   } catch (error) {
+     onStatus({ kind: "error", detail: ... });
+   }
+ });
...
  return () => {
+   cancelOpen();
```

新增 helper：

```js
function openWhenSized(host, open) {
  let frame = null;
  const step = () => {
    frame = null;
    if (!host.isConnected) return;
    if (host.clientWidth > 0 && host.clientHeight > 0) { open(); return; }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => { if (frame !== null) { cancelAnimationFrame(frame); frame = null; } };
}
```

---

## 追加：会话列挂载选择器修复（白屏的真正根因）

- 文件：`/root/.dsh/profiles/web/node_modules/dsh-web-terminal/lib/client.js`
- 日期：2026-08-16

当前 dsh web（0.1.0-rc.6）布局用类名标识列（`pI_x6G_centerCol` /
`pI_x6G_sidebarCol`），**页面里没有 `data-pane` 属性**。插件挂载查询
`[data-pane="conversation"]` 永远匹配不到 → 面板容器不挂载（`viewExists:
false`）；但接管 CSS 的 `[class*='centerCol'] > :not([data-dsh-terminal-view])`
照样隐藏了会话内容 → 打开后白屏。

```diff
- var CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"]';
+ var CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]';
```

并给 centerCol 加定位上下文（absolute inset-0 面板按它定位）：

```diff
- [data-pane='conversation'] { position: relative; }
+ [data-pane='conversation'],
+ [class*='centerCol'] { position: relative; }
```

## 验证

Playwright 移动视口（390×844, iPhone UA）实测：

- 抽屉打开 → 「终端」入口可见可点，点击后抽屉关闭、面板全屏接管
- xterm 渲染（暗色 358×688）、状态栏「已连接 /bin/bash」
- 输入 `echo IO_CHECK_OK` → 回显 + 输出 + 提示符，输入输出闭环
- 无 console/page 错误

验证脚本：`/home/archie/project/dsh-plugins/verify-mobile.mjs`
