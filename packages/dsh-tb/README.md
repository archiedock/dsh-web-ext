[![npm version](https://img.shields.io/npm/v/dsh-taskboard.svg)](https://www.npmjs.com/package/dsh-taskboard)
[![License](https://img.shields.io/npm/l/dsh-taskboard.svg)](https://github.com/cloader/dsh-taskboard/blob/main/LICENSE)

# dsh-taskboard

DeepSeek Harness 的**任务看板插件**：人建卡、agent 认领执行、人验收。任务挂项目（workspace）、可指定模型与 preset、支持手动与定时执行，全流程双向协作。

- **闭环协作**：人建卡 → agent 认领执行 → 结构化报告 → 人验收（✓ 完成 / ✗ 退回附原因）
- **10 个 `taskboard_*` agent 工具** + 代码级协议闸：agent 永远移不到 done、任务被持有时不可抢、跨项目不可认领
- **执行**：手动或 cron 定时（host 侧调度，浏览器关了照跑）；每次执行在任务项目内开全新会话，可指定模型与 preset
- **Git Worktree 隔离**：每次执行独立 worktree + 任务分支，验收时一键合并；非 git 项目自动降级
- **验收效率**：DoD 验收清单（agent 勾选附证据）、结构化执行报告（摘要/改动文件/自验/产物/风险）、看板内 diff 查看器
- **实时看板**：SSE 实时刷新、五列流转、筛选排序持久化、JSON 导入导出、任务模板

**零配置**：安装即用——无需 Token、无需 API Key、无需额外服务或数据库。

## 界面

<p align="center"><img src="https://raw.githubusercontent.com/cloader/dsh-taskboard/main/img/board.png" alt="任务看板" width="880"></p>

<p align="center"><img src="https://raw.githubusercontent.com/cloader/dsh-taskboard/main/img/modal.png" alt="新建任务" width="440"></p>

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [Agent 工具参考](#agent-工具参考)
- [功能特性](#功能特性)
- [安全](#安全)
- [配置与数据](#配置与数据)
- [常见问题](#常见问题)
- [开发](#开发)
- [升级日志](#升级日志)

## 环境要求

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | ≥ 0.1.1 | 需要 `dsh plugin` 子命令与 web profile |
| Node.js | ≥ 20 | 仅 GitHub 源安装构建时需要 |
| git | 可选 | Worktree 隔离需要；缺失时自动降级原目录执行 |

## 安装

```bash
# 一键安装（npm，预构建、免构建授权 —— 推荐）
dsh plugin --profile web add dsh-taskboard

# 或从 GitHub 源安装
dsh plugin --profile web add github:cloader/dsh-taskboard
```

安装后**重启 `dsh web` 并刷新页面**：侧边栏出现「任务看板」入口即成功。无需任何后续配置。

<details>
<summary>GitHub 源安装卡在 prepare / allowBuilds？</summary>

git 源插件安装时经 prepare 脚本构建，pnpm 会先阻止——按报错提示把精确 key 加进 profile 目录 `pnpm-workspace.yaml` 的 `allowBuilds` 后重跑即可。npm 源是预构建产物，无此步骤。
</details>

<details>
<summary>开发模式安装（改代码即生效）</summary>

```bash
git clone https://github.com/cloader/dsh-taskboard.git
cd dsh-taskboard
npm install && npm run build
dsh plugin --profile web add "link:/path/to/dsh-taskboard"
```

link 安装后，仓库里 `npm run build` 重建、刷新页面即生效；改完宿主侧代码需重启 `dsh web`。
</details>

卸载：`dsh plugin --profile web remove dsh-taskboard`（台账数据保留在 DSH 主目录，见[配置与数据](#配置与数据)）。

> 官方 `@deepseek-ai/dsh-*` 包只写进 profile 的 `bundles` 列表，不要 `plugin add` 进 dependencies（避免 SDK 双实例遮蔽）。

## 快速开始

**第 1 步 · 建卡**：看板右上「+ 新建任务」——选项目、紧急度、执行方式（认领/定时+cron）、模型与 preset、Git 隔离开关、验收清单；可勾「⚡ 立即执行」。

**第 2 步 · agent 执行**：三种触发方式任选——

1. GUI「立即执行」/「↻ 续跑」（详情页或表单）
2. cron 定时（host 侧调度，无需开浏览器）
3. 任意会话里让 agent 用 `taskboard_*` 工具认领：`按看板上的任务 t-xxxxx 执行`

**第 3 步 · 人验收**：待验收列「✓ 完成」一键验收；「✗ 退回」退回待办并附原因（agent 下轮开工前会读）。

一次完整的 agent 工作流（协议由插件在执行开场自动下达）：

```text
你：执行看板任务 t-ab12cd
agent：
  taskboard_list                # 查板：项目内 todo 任务
  taskboard_get t-ab12cd        # 读需求、评论、验收清单
  taskboard_move → in_progress  # 认领（代码闸：被持有/跨项目会被拒绝）
  ……编码 / 测试……
  taskboard_checklist check     # 逐项勾验收清单，附证据 note
  taskboard_execution_report    # 结构化报告：摘要/改动文件/自验/产物/风险
  taskboard_comment_add         # 交接说明
  taskboard_move → in_review    # 移待验收
你：看板待验收列 ✓ 完成   # done 永远只属于人——agent 调用会被代码闸拒绝
```

## Agent 工具参考

任何会话可用；项目边界：只有属于任务所在项目的会话才能认领或执行。

| 工具 | 作用 |
| --- | --- |
| `taskboard_list` | 查板（按项目/状态/紧急度过滤，紧凑摘要） |
| `taskboard_get` | 读单卡全文：描述、prompt、评论流、清单、执行记录 |
| `taskboard_comments` | 列出任务评论（视为最新需求，先读后动） |
| `taskboard_create` | 建卡（workspaceId、紧急度、清单、preset、隔离、定时） |
| `taskboard_update` | 改标题/描述/prompt/紧急度/清单（model/execution 只读） |
| `taskboard_move` | 移卡：todo→in_progress→in_review（**到不了 done**） |
| `taskboard_comment_add` | 追加评论（交接、风险、进展） |
| `taskboard_delete` | 软删除（可 purge；执行中不可删） |
| `taskboard_checklist` | 验收清单 add / check（附证据）/ uncheck |
| `taskboard_execution_report` | 提交结构化执行报告，自动挂到当前执行 |

## 功能特性

**看板协作**
- 五列看板（待规划 / 待办 / 进行中 / 待验收 / 已完成）+ 受阻标记，SSE 实时刷新
- 任务挂项目：认领校验会话归属，跨项目不可抢
- 紧急度三色（紧急/一般/不急）筛选与色条；搜索（标题/ID）与列内排序，筛选排序持久化
- 列头状态色圆点：待规划灰 / 待办蓝 / 进行中橙 / 待验收紫 / 已完成绿 / 已删除红
- 新建/编辑弹窗：项目、模型、紧急度、执行方式、cron 实时校验与下次运行预览、执行隔离开关、验收清单编辑
- 详情面板：状态流转（done 仅限人工；清单未全勾时完成需二次确认并显示未勾数）、agent/用户评论流、执行记录（倒序，最新在最上；会话 ID 点击跳转打开该执行会话；已删除/已归档分开提示）、停止执行、Worktree 隔离块（分支 / 提交 / 改动统计 / 合并与清理）、执行报告块、验收清单块
- 待验收列卡片快捷操作：「✓ 完成」一键验收、「✗ 退回」退回待办并可附退回原因（agent 开工前会读）
- **验收清单 DoD（0.4.0）**：建卡时定验收条件（≤30 项）；agent 用 `taskboard_checklist` 增补/勾选（附证据 note）；用户在详情页直接勾选；待验收时未完成项红色高亮 + 卡片「☑ n/m」角标（未全勾显红）；清单编辑在表单中整组管理（勾选状态与证据保留）
- **结构化执行报告（0.4.0）**：agent 收尾用 `taskboard_execution_report` 提交（摘要 / 改动文件 / 自验 / 产物 / 剩余风险），自动挂到当前执行记录；待验收详情页分栏渲染；开场框架行明示提交时序（报告 → 评论 → 移待验收）
- **JSON 导入（0.4.0）**：顶栏「⬆ 导入」选择备份文件 → 干跑预览（新增 / 覆盖 / 无效分类明细）→ 合并（按 id upsert）或整册替换（自动先备份当前台账 + 二次确认）；⬇ JSON 导出的文件即同格式可直接恢复
- **任务模板（0.4.0）**：「+ 新建任务 ▼」下拉（空白 / 内置 Bug 修复·发布检查·例行巡检 / 管理模板）一键预填表单（标题/描述/Prompt/紧急度/定时/隔离/preset/清单）；任务详情「⌗ 存为模板」沉淀常用配置；模板存 DSH 主目录 side file，改名/删除在管理弹窗
- **Diff 查看器（0.4.0）**：隔离块提交行、未提交修改文件行点击即在看板内展开 diff（提交 `git show` / 文件 `git diff`，128KB·2000 行封顶标注截断）；worktree 已删时回落主仓（仅限提交与带基线的范围 diff）

**Agent 工具（taskboard_\*）**
- 10 个工具：查板 / 建卡 / 改卡 / 移卡 / 评论 / 软删除 / 验收清单 / 执行报告，任何会话可用
- 代码级协议闸：agent 永远移不到 done（清单全勾也不行）；任务被持有时不可抢占；model/execution 对 agent 只读

**执行**
- 手动执行或 cron 定时：每次执行在任务项目内新建全新会话（干净上下文、可指定模型、可指定 preset）；开场两条消息同一回合送达——插件上下文行携带任务框架与交接协议（含失败回退路径），卡片内容（提示词或标题+描述）以正常用户消息呈现
- **任务级 preset（0.3.3）**：新建/编辑表单「执行模式（preset）」下拉——执行会话按该 preset 组合（工具集与人设由此而来，对齐 GUI 新会话的组合方式）；默认预选部署默认 preset，也可选「跟随部署默认」；preset 损坏时执行直接失败并把原因写进执行记录（不产出半组合会话）；随时可改，下轮执行生效
- **Git Worktree 隔离执行（0.3.0）**：任务级开关（默认开、记住上次选择），每次执行在 `<项目>/.dsh-worktrees/<任务ID>` 独立 worktree 上进行，分支 `task/<标题>+<任务ID>`（首次创建后定死，改名不改）；执行会话归属项目根目录（分组、工具与文件沙箱完整可用——DSH 要求会话 cwd 即工作区根，0.3.2 修正），worktree 路径与边界纪律在开场指令中明确下达；结算自动采集提交列表 / 未提交修改警告 / 改动统计；非 git 项目或 git 不可用时自动降级原目录执行（执行记录注明降级原因，台账与执行主流程永不因 git 失败而失败）；验收时详情页一键 `--no-ff` 合并到主工作区（主区脏或冲突原样报告，不自动解决）、删除 worktree（有未提交修改时拒绝）、可选删分支；支持「↻ 续跑」在现有 worktree/分支上继续执行（保留上次改动与提交）
  > Worktree 隔离是协作约定而非沙箱：执行会话拥有完整工具权限，隔离依赖分支约定，不适用于运行不可信代码的场景。
- host 侧调度：关掉浏览器照常触发；错过窗口跳过不补跑
- 乐观并发（ifVersion）+ 完整归因（谁改的、哪个会话执行的）
- ⚙ 健康诊断：台账基本项 + 遗留 worktree（台账无主但目录存在）一键清理

## 安全

- **验收权只属于人**：agent 把任务移到 done 的调用被代码级协议闸直接拒绝（不是提示词约定）；任务被持有时不可抢占，跨项目不可认领。
- **Worktree 隔离是协作约定而非沙箱**：执行会话拥有完整工具权限，隔离依赖分支约定，不适用于运行不可信代码的场景。
- **数据本地**：台账、模板全部存本机 DSH 主目录；不外发任何数据，无需 Token / API Key。

## 配置与数据

开箱即用，全部配置项如下（均为可选）：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_TASKBOARD_MAX_CONCURRENT` | `3` | 全局同时执行的会话数上限 |
| `DSH_HOME` | `~/.dsh` | DSH 主目录（跟随部署，插件数据随之） |
| `ATB_TRACE` | 未设置 | `=1` 时 host 打印工具调用跟踪（调试用） |

数据文件（均在 DSH 主目录，卸载插件不删除）：

| 文件 | 内容 |
| --- | --- |
| `dsh-taskboard.json` | 任务台账（全部任务/执行/评论） |
| `dsh-taskboard-templates.json` | 任务模板 |
| `dsh-taskboard.json.backup-<时间戳>` | 整册导入替换前的自动备份 |
| `<项目>/.dsh-worktrees/<任务ID>/` | 任务执行 worktree |

随时可顶栏「⬇ JSON」全量备份、「⬇ CSV」导出任务清单（带 BOM，Excel 直接打开）。

## 常见问题

**侧边栏没有「任务看板」入口？**
刷新页面；仍没有则确认插件已装进当前 profile 并重启 `dsh web`（宿主半区在进程启动时加载）。0.4.2 起旧 `data-pane` shell 与新哈希类名 shell（DSH Desktop）都支持。

**任务数据存在哪？怎么备份？**
见[配置与数据](#配置与数据)。GUI「⬇ JSON」随时全量导出；「⬆ 导入」可恢复。

**浏览器关了，定时任务还跑吗？**
跑。调度在 host 进程侧，与浏览器无关；错过的时间窗口跳过不补跑。

**项目不是 git 仓库，能用吗？**
能。Worktree 隔离自动降级为原目录执行，执行记录注明降级原因；其余功能不受影响。

**多个项目怎么协作？**
任务挂项目（= DSH workspace）。认领校验会话归属：只有任务所在项目内的会话能认领/执行，跨项目不可抢。

**agent 会把任务直接标成「已完成」吗？**
不会。这是代码级协议闸（不是提示词约定）：`taskboard_move` 到 done 的调用被直接拒绝，验收永远由人在看板完成。

**GitHub 源安装报 prepare 被阻止？**
pnpm 的构建授权——按报错把 key 加进 profile 的 `pnpm-workspace.yaml` `allowBuilds` 后重跑；或改用 npm 源（预构建，无此步骤）。

## 开发

```bash
git clone https://github.com/cloader/dsh-taskboard.git
cd dsh-taskboard
npm install && npm run build    # host ESM + client CJS 双构建
npm test                        # vitest 全量
node tests/manual-git-e2e.mjs   # 真 git 端到端手测（worktree 全链路 + 续跑 + diff 查看器）
node scripts/screenshot.mjs     # 重新生成 img/ 截图（需本机 Edge）
```

## 升级日志

### 0.4.4

- **本地叠加需求 + 基线同步上游 0.4.3**：表单新增选填「准入 ID」与「方案链接或路径」，执行时随任务**前置**发给执行会话（用户消息气泡元数据块）；`taskboard_create` / `taskboard_update` 支持这两个字段（空串/null 清除）；复制任务携带；详情页 chip 展示（URL 可点击）；移动端看板内「☰ 侧边栏 / ✕ 返回」按钮与 DSH Desktop centerCol 兼容一并保留
- 基线由 0.3.3 → 0.4.3：并入上游 0.4.0 验收效率包（DoD 清单 / 结构化报告 / JSON 导入 / 任务模板 / diff 查看器）与 0.4.1–0.4.3 修复，与本叠加无冲突（全为并列新增，keep-both 合并）

### 0.4.3

- **修复折叠侧边栏时入口不收成纯图标（用户反馈）**：收起侧边栏后，shell 把侧栏收成 36×36 图标轨道（layout frame 出现 `data-sidebar-collapsed` 属性、侧栏根节点切换 CSS-Module `*_collapsed` 哈希类），而看板入口仍保持全宽——图标、「任务看板」文字、右侧计数角标挤在窄轨里。修复：折叠信号下入口镜像原生轨道几何（36×36、居中、与原生 newSession 折叠态同款间距），隐藏文字与角标，图标 14→16px 保证可读；双信号选择器（`[data-sidebar-collapsed]` 与 `[class*="_collapsed"]`）沿用 0.4.2 双选择器原则，新旧 shell 通吃；展开态完全不受影响，`aria-label` 保留无障碍提示
- 回归测试：断言两组折叠选择器与 36px 轨道几何都注入样式表、shell 真实产生的 `hHd-Xa_collapsed` 类名命中选择器模式（150 项）
- README 按 dsh.market 五维评分体系重构：新增目录 / 环境要求 / 快速开始（含完整 agent 工作流示例）/ Agent 工具参考表 / 安全 / 配置与数据 / 常见问题；仓库元数据补 homepage 与 topics

### 0.4.2

- **修复 DSH Desktop 上看板不出现（用户反馈：入口能点、后端正常，但中间看板无变化）**：当前 DSH Desktop 的 Web shell（`dsh-client-ui-layout`）已完全移除 `data-pane` 属性，中间列改用 CSS Module 哈希类名（`pI_x6G_centerCol`）——而看板挂载选择器写死 `[data-pane="conversation"]`，`querySelector` 永远落空，看板容器从未创建（侧栏入口正常，是因为它一直有 `[class*="sidebarCol"]` 兜底）。修复：挂载选择器与隐藏规则双兼容 `'[data-pane="conversation"], [class*="centerCol"]'`（新旧 shell 通吃，与侧栏入口同款兜底策略）；`.dsh-atb-view` 以 `height:100%` 撑满列容器，不依赖列内部结构
- 回归测试：构造无 `data-pane`、哈希类名 `centerCol` 的 Desktop shell DOM——看板容器正确创建于列内、隐藏规则双选择器齐备

### 0.4.1

- **修复侧栏入口点击竞态（用户反馈）**：部分 shell 的 DOM 里，任务看板侧栏入口被插在 class 含 `newSession` 的容器内部——点击入口时，看板的全局捕获监听器（「点侧栏会话/新会话让位」语义）先 `closeBoard`，入口自身的 `toggleBoard` 再翻回来，表现为**看板一开就闪关、或入口按钮关不掉**。修复：捕获监听器先按 `closest('[data-dsh-atb-entry]')` 整体豁免入口子树（比给选择器加 `:not()` 更稳——`:not()` 只排除元素自身匹配，挡不住入口嵌在带类祖先容器内的形态）；真会话行/新会话按钮的让位语义不变。顺带加固 `newSessionButton()` 锚点扫描排除自身入口，杜绝自愈重插时锚点自引用
- 回归测试：构造「入口位于 newSession 容器内」的竞态形态 DOM——点击入口开/关 toggle 正常；点真新会话按钮仍让位

### 0.4.0

**验收效率包——把「人验收」环节在看板内闭环：**

- **验收清单 DoD**：任务模型新增 `checklist`（≤30 项 × 200 字，勾选人/时间/证据 note 全程留痕）。建卡表单整组编辑（编辑保留勾选状态与证据）；agent 侧新工具 `taskboard_checklist`（add 增补 / check 勾选附证据 / uncheck 重开，代码闸：勾选永远不等于完成）；执行开场框架行注入清单并下达「完成一项勾一项」纪律；待验收卡片与详情未完成项红色高亮，「✓ 完成」在有未勾项时二次确认并显示数量
- **结构化执行报告**：执行记录新增 `report { summary, changedFiles, checks, artifacts, risk }`；agent 收尾用新工具 `taskboard_execution_report` 提交——按「调用会话 + 运行中执行」定位挂载（agent 无需知道执行 id，重复提交覆盖）；待验收详情页分栏渲染（摘要 / 改动文件 / 自验 / 产物 / 风险）；开场交接协议更新为「报告 → 评论 → 移待验收」三步
- **JSON 导入**：`validateLedgerImport` 纯函数逐卡校验分类（新增 / 覆盖 / 无效+原因，文件内重复 id 拒绝；schemaVersion 不符明确报错；导入时残留 `running` 执行标记为失败——其结算守望已随源主机消亡）；`POST /import/preview` 干跑 + `POST /import` 提交（merge 按 id upsert；replace 整册替换前自动写 `ledger.backup-<ts>.json`）；GUI「⬆ 导入」弹窗全流程可视化，整册替换双重确认
- **任务模板**：host 侧 `templates.json` side file（首启播种内置 Bug 修复 / 发布检查 / 例行巡检）；「+ 新建任务 ▼」下拉选模板预填全部配置（含清单与 preset）；任务详情「⌗ 存为模板」；管理弹窗改名 / 删除 / 直接使用
- **Diff 查看器**：git face 新增 `showCommit` / `showPathDiff`（fail-soft，128KB / 2000 行封顶标注截断）；详情页隔离块的提交行与未提交修改文件行点击即懒加载展开 diff；worktree 已删时自动回落主仓
- 测试 116 → 145；`taskboard_get` 详情渲染清单与报告标记；复制任务携带清单

### 0.3.4

- **表单新增选填「准入 ID」与「方案链接或路径」**：新建/编辑任务可录入准入编号与参考方案的 URL 或本地路径（均选填，留空即清除）；详情页以 chip 展示（URL 可点击跳转）
- **执行时随任务发给 agent**：参考方案（链接或路径）与准入 ID 以元数据块**前置**在执行提示词之前，作为该任务的输入/依据交给执行会话（在用户消息气泡里，非插件上下文行）；`taskboard_create` / `taskboard_update` 同步支持这两个字段（空串/null 清除）；复制任务携带；测试 116 → 120 项
### 0.3.3

- **修复执行会话拿不到工具（非标准模式）**：0.3.0 起部署引入 preset 体系后，工具不再是全局注册，而是各 preset 组合在会话创建时挂载（GUI 建会话走 apiproxy 的 composeAgent → presets.mount）。我们的执行服务此前直接 agents.create，不挂任何组合 → 会话无工具。现对齐该链路：执行会话按 preset 组合创建，`agentPreset` 记入会话头
- **任务级 preset 字段**：创建任务时可选「执行模式（preset）」，默认预选部署默认 preset（本部署即标准模式）——即按你的决定「默认标准模式」；可切任意 preset（如梁神模式）或选「跟随部署默认」（不落字段，随部署默认变）；编辑随时可改（每轮执行现组合，无锁定）；复制任务携带；`taskboard_create` 增 `presetId` 参数；详情页显示 preset chip
- **坏 preset 防护**：preset 解析失败（不存在/损坏）→ 执行直接失败、原因写入执行记录、任务退回待办——不产出半组合会话（与 apiproxy 回滚语义一致）
- preset 目录用来自 `agentPreset.list` 连接 RPC（无 roster 或离线时下拉隐藏，行为回落到裸组合）；测试 111 → 116 项

### 0.3.2

- **修复 worktree 执行会话脱离项目组、工具不可用**：0.3.0–0.3.1 把执行会话 cwd 指向 worktree 子目录，而 DSH 的会话模型要求 cwd === 工作区根目录（全等）——子目录导致会话无法挂入项目组（显示「未分组」），且文件沙箱边界与相对路径解析全部失效（agent 无法创建文件）。现改回：会话 cwd = 项目根（分组、工具、沙箱完整可用），worktree 绝对路径与边界纪律（命令 workdir 指向 worktree、文件读写用绝对路径、禁改主工作区其它文件、提交到任务分支）在开场框架行中明确下达。git 隔离与证据采集不受影响

### 0.3.1

- **↻ 续跑**：详情页新增「续跑」——保留现有 worktree 与分支原状（上次的提交和未提交修改都在），在其上继续执行；基线取 worktree 当前 HEAD，证据只统计本轮新增提交。默认「立即执行」仍为全新基线（重置分支到主区 HEAD）
- **同仓库 git 操作互斥**：同一仓库的建/删 worktree、合并、删分支在进程内串行执行，消除并发隔离执行之间的 index.lock 竞争
- **失败/取消也留证据**：turn 出错或用户停止时，已产生的提交与未提交修改照样采集进执行记录（原先只在成功结算时采集）——中断的半成品可凭记录判断是否续跑
- **执行记录证据封顶**：提交最多保留 50 条、未提交修改最多 100 行（均记录总数），超大改动不再撑爆每次全量重写的台账
- **合并空跑检测**：分支没有领先主工作区的新提交时直接提示「无需合并」，不再产生假的「已合并」系统评论
- **物理清除连带清理**：purge 任务前先检查 worktree——有未提交修改拒绝并列出文件；通过后连带删除 worktree 与任务分支
- **降级语义细化**：降级原因区分「git 不可用（未安装/不在 PATH）」与「当前项目不是 git 仓库」；降级运行的开场提示明确警告会话正在主项目目录工作（先 git status、改动集中、结束说明改动文件）
- **全新检出提示**：全新 worktree 的开场提示告知不含 node_modules/构建产物，构建测试前可能需重装依赖
- **诊断面板增强**：新增 gitignore 建议列表（git 项目未忽略 `.dsh-worktrees/` 一目了然，仍不自动修改）；「悬挂执行中」更名为「执行中」
- README 注明 Worktree 隔离是协作约定而非沙箱；测试 97 → 111 项

### 0.3.0

- **Git Worktree 隔离执行（旗舰）**：并发执行互不污染代码，验收即审分支
  - 任务级隔离开关：新建表单「执行隔离」（默认 Worktree、记住上次选择；非 git 项目自动禁用并提示）；`taskboard_create` 增 `isolation` 参数；复制任务携带；首次执行前可改、开始后锁定
  - 执行链路：每次全新 worktree（`git worktree add --force` 到固定路径 `.dsh-worktrees/<任务ID>`，固定分支 `task/<标题>+<任务ID>`，标题清洗+截断、空标题回退纯 ID、改名不改分支）；执行会话 cwd 指向 worktree；开场框架行引导 agent 把改动提交到该分支
  - 结算采集：提交列表（hash+主题）、未提交修改警告、改动统计与文件数——「执行记录 ↔ commits 关联」并入本轮
  - 验收操作（详情页）：⇥ 合并（`--no-ff`，主区脏/冲突原样报告且自动 `merge --abort` 复原）、🗑 删除 worktree（有未提交修改拒绝，可选连分支删除）、保留分支退回继续修改
  - 安全规则：显式关闭 = 全程零 git 调用；非 git 项目 / git 不可用 / 超时全部自动降级原目录（isolationNote 注明原因，fail-soft：台账与执行永不因 git 失败而失败）；合并的干净检查豁免插件自有的 `.dsh-worktrees/` 目录；所有 git 操作带超时（查询 2s / 结构操作 15s）
  - host 新模块 `src/host/git.ts`：窄接口 GitFace（detect/prepare/collect/merge/remove/deleteBranch），exec 层可注入（测试零真 git）；workspaces 路由下发 git 检测结果（60s 缓存）；启动时对未忽略 `.dsh-worktrees/` 的项目提示 gitignore 建议（不自动改）
- **⚙ 健康诊断**：台账基本项（修订号/任务数/悬挂执行中）+ 遗留 worktree 列表（台账无主但目录存在）一键清理（未注册目录 fs 兜底，有未提交修改仍拒绝）
- `taskboard_get` 详情输出隔离与分支信息；测试 67 → 97 项

### 0.2.2

- **待验收快捷操作**：待验收列卡片上直接「✓ 完成 / ✗ 退回」，退回可附原因（可留空），退回与评语一次原子提交（移卡失败不会产生孤儿评论）
- 非法状态流转的 HTTP 状态码由 500 修正为 400

### 0.2.1

- 调整任务发起时的提示词

### 0.2.0

- **看板效率**：顶栏新增搜索（标题/ID，大小写不敏感）、列内排序（默认/最近更新/紧急度/创建时间）；筛选与排序按 localStorage 持久化（搜索不持久）
- **侧边栏状态条**：「任务看板」入口同行右侧显示 `待办|进行中|待验收` 计数（如 `0|1|2`），三个数字分别着蓝/橙/紫状态色，悬停提示含义与实时数字，数字变化时上下滚动动画（增长上滚、减少下滚，尊重 prefers-reduced-motion）
- **执行结算闭环**：执行会话结束但未按协议交接（没评论/没移待验收）时，系统自动补评论并移入待验收——任务不再静默挂在进行中；执行失败也留系统评论
- **认领租约**：认领超 30 分钟未动的任务，卡片与详情显示「⏱ 认领超时」；详情页新增「🔓 释放认领」一键退回待办
- **执行记录保留上限**：每任务保留最近 20 条执行记录（详情页显示「+N 已清理」），定时任务的台账不再无限膨胀
- **全局并发上限**：同时执行的会话数默认上限 3（`DSH_TASKBOARD_MAX_CONCURRENT` 可调）；调度器满载时保留到期窗口不烧掉，下个 tick 重试
- **执行 Prompt 模板变量**：`{{lastExecution}}`（上次执行结果）、`{{lastComments}}`（最近 3 条评论）——巡检类定时任务能看到上次跑出了什么
- **复制任务**：详情页「⧉ 复制」一键克隆全部配置为新卡
- **导出**：顶栏「⬇ JSON」全量台账备份、「⬇ CSV」任务清单（带 BOM，Excel 直接打开）
- **状态色点**：五列列头与「其它任务」三列的分类文字前显示状态色圆点（待规划灰/待办蓝/进行中橙/待验收紫/已完成绿/已删除红），与详情页状态 pill 同色系
- **执行会话跳转**：详情页执行记录（倒序，最新在最上）点击会话短 ID 直接打开该执行会话，看板自动收起；已删除与已归档分开提示并带短 ID；运行时服务惰性解析、会话列表镜像滞后时自动刷新重查一次；短 ID 剥离 `taskboard-` 中缀，各记录可区分

### 0.1.3

- **执行竞态与持锁修复**：
  - 「立即执行」原子闸：in-progress 检查移入串行写队列，重复点击 / 调度重叠最多开一个执行会话
  - 认领改为显式 `claimedBy/claimedAt` 字段（原先从 updatedBy 推断，用户编辑会误清持锁）；执行期间任务由执行会话持有，其他会话不可移动；旧台账加载时自动迁移
  - 执行失败自动回退 todo（原先永久卡在 in_progress）；host 重启后残留的 running 执行标记为 failed 并归还任务；成功结算后释放持锁
- **执行可取消**：详情页「■ 停止执行」——停止执行会话、执行记录标记 cancelled、任务回到待办
- **模型校验**：建卡/改卡的固定模型做结构校验 + provider 路由存在性校验（host llm 运行时不可达时只做前者）
- **台账安全**：`store.snapshot()/get()` 返回冻结副本，外部修改直接抛错，杜绝绕过版本号的原地改数据
- **调度器**：tick 前先加载台账（修复 host 重启后首个 tick 读到空表导致定时任务不触发）；启动补偿定时器随 dispose 清理
- **其它**：执行记录会话 ID 点击复制；详情页显示持锁会话；删除死代码（`store.flush` / routes `taskPath`）

### 0.1.2

- **看板拖拽**：所有列的卡片可互相拖动（按状态机校验合法流转，非法拖放弹窗提示）；正在执行的任务拖动会被拦截，提示「该任务正在由【任务名】会话执行，不能拖动」
- **执行会话体验**：执行会话标题固定为任务名（经 `sessionTitle.rename` 写入，不会被自动重命名覆盖）；首条消息以正常用户消息呈现（不再是插件上下文行）
- **交互优化**：
  - 新建/编辑弹框新增「⚡ 立即执行」按钮（保存后直接发起执行）
  - 详情页「立即执行」移至「编辑」按钮旁
  - 「+ 新建任务」移至看板标题统计旁
  - 状态流转按钮文案统一为「移至→{状态}」
- **弹窗**：原生 `alert()` 全部替换为主题化模态弹窗（Esc/遮罩可关）

### 0.1.1

- 初始 npm 发布：看板协作、8 个 agent 工具、手动/cron 执行、SSE 实时视图

License: Apache-2.0
