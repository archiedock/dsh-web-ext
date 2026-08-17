# dsh-web-ext

本机（DeepSeek Harness Web GUI）自维护的统一插件工程：收纳**修改过的开源 DSH 插件**与**自研的新增插件**，统一版本管理、补丁记录与安装方式。

## 目录结构

```
dsh-web-ext/
├── packages/
│   ├── dsh-tb/                # 修复版 dsh-taskboard（cloader/dsh-taskboard v0.3.3 + 本地补丁）
│   ├── dsh-web-terminal/      # dsh-web-terminal 本地修复（补丁 diff + 说明）
│   └── dsh-mobile-nav/        # 依赖包说明（@dsh-external/dsh-mobile-nav，未修改，仅记录来源与协作关系）
└── scripts/                   # 安装/打补丁脚本（规划中）
```

## 包含的插件

| 包 | 上游 | 版本 | 本地修改 |
|---|---|---|---|
| `dsh-tb` | [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard) | 0.3.3 | 看板视图挂载兼容本机 shell（无 `data-pane` 属性，中心列为 `centerCol` class）+ 移动端 ☰/✕ 按钮（layout 服务），详见 [packages/dsh-tb/PATCH.md](packages/dsh-tb/PATCH.md) |
| `dsh-web-terminal` | [giiiiiithub/terminal](https://github.com/giiiiiithub/terminal) | 0.1.0 | ① tailnet 访问白名单 ② xterm 零尺寸延迟打开 ③ 移动端 ☰/✕ 按钮（layout 服务）④ 面板 z-index 60→30，详见 [packages/dsh-web-terminal/PATCH.md](packages/dsh-web-terminal/PATCH.md) |

## 依赖包（未修改，原样使用）

| 包 | 来源 | 版本 | 说明 |
|---|---|---|---|
| `dsh-mobile-nav` | [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（`github:` 源） | 0.2.0 | 移动端布局壳；`dsh-tb` / `dsh-web-terminal` 的 ☰ 按钮依赖其 `layout` 服务与 `data-sidebar-collapsed` 机制，详见 [packages/dsh-mobile-nav/README.md](packages/dsh-mobile-nav/README.md) |

## 安装方式

每个包都是标准 DSH bundle（`dsh.bundle` 声明 + `cordis.patch.yml`），构建后产物 `lib/` 直接拷贝到目标 profile：

```sh
# 以 dsh-tb 为例（web profile）
cp -r packages/dsh-tb/lib /path/to/~/.dsh/profiles/web/node_modules/dsh-taskboard/
```

并在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中登记（见各包 README）。

> 注意：本机 pnpm store 位于 `/root`（不可读），`dsh plugin add` 走 pnpm 会失败，故统一采用「下载 tarball → 拷贝产物 → 登记 bundle」的手动安装方式。
