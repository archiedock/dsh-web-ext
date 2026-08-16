# dsh-web-terminal —— 本地修复

上游：[giiiiiithub/terminal](https://github.com/giiiiiithub/terminal)（dsh-web-terminal，npm `dsh-web-terminal`）

本包只包含本地补丁（diff），不含上游完整源码。补丁文件：

- `patches/dsh-terminal-fixes.diff` —— 对已安装包 `node_modules/dsh-web-terminal/lib/` 的完整 diff

## 补丁内容

| 文件 | 问题 | 修复 |
|---|---|---|
| `lib/index.js` | 终端 WebSocket 只允许 loopback 来源，tailnet 地址被拒（`isLoopbackRequest` 返回 false，终端无法连接） | 白名单加入用户 tailscale 对端地址 `100.67.107.110` 与主机名 `archie-pc.tailaeca49.ts.net` |
| `lib/client.js` | xterm 在零尺寸容器（`display:none` / 移动端滑入）中创建渲染器失败 → 面板空白，后续 Viewport 刷新崩溃 | 新增 `openWhenSized()`：延迟 `open+fit` 直到容器有真实尺寸；修复方案与社区 dsh-better-sidebar 修复一致 |
| `lib/client.js` | 移动端：终端面板激活时隐藏会话列的规则（含 `centerCol` 兜底）会把移动端会话 header 里的侧边栏呼出按钮一并隐藏（FAB 又仅在无 active phase 时显示），手机端在终端内失去呼出侧边栏的入口 | 终端面板 toolbar 增加移动端专属按钮（≤1023px 显示）：「☰ 侧边栏」触发 `[data-mobile-nav="toggle"]` 呼出移动端 drawer、「✕ 返回」通过 `window.__dshTermController.close()` 关闭面板回到会话（`mountPanel` 暴露 controller 到 window） |

## 应用方式

```sh
# 在 dsh 安装目录（node_modules 上一级）执行
patch -p1 < patches/dsh-terminal-fixes.diff
# 然后重启 dsh web
```

或手动拷贝修改后的 `lib/index.js` / `lib/client.js` 覆盖安装目录同名文件。
