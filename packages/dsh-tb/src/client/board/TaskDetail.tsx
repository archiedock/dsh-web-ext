/**
 * The task detail pane — visually polished: urgency accent header with
 * status pill and meta chips, card-wrapped description/prompt, chat-style
 * comment bubbles distinguishing user vs agent authors, a timeline of
 * executions with outcome pills, grouped actions (run / transitions /
 * danger zone), and the user comment composer.
 *
 * @module dsh-taskboard/client/board/TaskDetail
 */
import { useState, type ReactNode } from 'react'
import type { BoardController } from '../controller.ts'
import type { ExecutionRecord, TaskRecord } from '../../shared/protocol.ts'
import { canTransition } from '../../shared/protocol.ts'
import { useAlert } from './AlertModal.tsx'
import { fmtTime, isStaleClaim } from './TaskBoard.tsx'

/** Statuses a user may move this task to, per the state machine. */
function moveTargets(task: TaskRecord): TaskRecord['status'][] {
  const all: TaskRecord['status'][] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived']
  return all.filter(to => canTransition(task.status, to))
}

const MOVE_LABEL: Record<string, string> = {
  backlog: '待规划', todo: '待办', in_progress: '进行中', in_review: '待验收',
  done: '完成', canceled: '取消', archived: '归档',
}
const STATUS_LABEL: Record<string, string> = { ...MOVE_LABEL }
const URGENCY_LABEL: Record<string, string> = { urgent: '紧急', normal: '一般', relaxed: '不急' }
const OUTCOME_LABEL: Record<string, string> = { running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }

/** Compact session-id display (execution sessions carry the taskboard infix). */
function shortId(id: string | undefined): string {
  if (id === undefined) return ''
  return id.replace(/^session-(taskboard-)?/, '').slice(0, 8)
}

/** Execution duration between start and end. */
function duration(startedAt: number | undefined, endedAt: number | undefined): string {
  if (startedAt === undefined || endedAt === undefined) return ''
  const s = Math.max(0, Math.round((endedAt - startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

/** Small labelled meta chip. */
function Chip({ icon, children, tone }: { icon?: string; children: ReactNode; tone?: string }) {
  return <span className="dsh-atb-chip2" data-tone={tone}>{icon !== undefined && <span className="dsh-atb-chip2-icon">{icon}</span>}{children}</span>
}

/** The most recent execution carrying isolation facts, newest first. */
function latestIsolated(task: TaskRecord): ExecutionRecord | undefined {
  return [...task.executions].reverse().find(e => e.isolation !== undefined || e.worktreePath !== undefined || e.isolationNote !== undefined)
}

/** Short commit hash for display. */
function shortHash(hash: string | undefined): string {
  return hash === undefined ? '' : hash.slice(0, 8)
}

/**
 * The 0.3.0 isolation block: branch / baseline→head commits / change stats /
 * uncommitted-changes warning, plus the user-only git actions (merge /
 * remove worktree — plan §3.3).
 */
function IsolationBlock({ task, controller }: { task: TaskRecord; controller: BoardController }) {
  const { alert: showAlert, el: alertEl } = useAlert()
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<'wt' | 'wtb' | null>(null)
  const [busy, setBusy] = useState(false)
  const execution = latestIsolated(task)
  const running = task.executions.some(e => e.outcome === 'running')
  if (execution === undefined) return null

  const doMerge = (): void => {
    setBusy(true)
    void controller.mergeBranch(task.id).then(result => {
      setBusy(false)
      setConfirmMerge(false)
      if (!result.ok) showAlert(`合并失败：${result.error}`)
      else if (result.noop === true) showAlert('该分支没有领先主工作区的新提交，无需合并（可退回续跑或直接清理）')
    })
  }

  const doRemove = (deleteBranch: boolean): void => {
    setBusy(true)
    void controller.removeWorktree(task.id, deleteBranch).then(result => {
      setBusy(false)
      setConfirmRemove(null)
      if (!result.ok) showAlert(`删除失败：${result.error}`)
      else if (result.branchError !== undefined) showAlert(`worktree 已删除，但分支删除失败：${result.branchError}`)
    })
  }

  // Degraded / off isolation: one quiet line explaining why.
  if (execution.isolation !== 'worktree' || execution.worktreePath === undefined) {
    return (
      <div className="dsh-atb-fieldcard" data-kind="isolation">
        <div className="dsh-atb-fieldcard-label">执行隔离</div>
        <div className="dsh-atb-iso-none">📁 原目录执行{execution.isolationNote !== undefined ? ` · ${execution.isolationNote}` : ''}</div>
        {alertEl}
      </div>
    )
  }

  const commits = execution.commits ?? []
  const commitTotal = execution.commitsTotal ?? commits.length
  const dirty = execution.dirtyFiles ?? []
  const dirtyTotal = execution.dirtyFilesTotal ?? dirty.length

  return (
    <div className="dsh-atb-fieldcard" data-kind="isolation">
      <div className="dsh-atb-fieldcard-label">执行隔离 · Worktree</div>
      <div className="dsh-atb-iso-facts">
        <span className="dsh-atb-iso-fact" title={execution.worktreePath}>🌿 分支 <b>{execution.branch ?? task.branch}</b></span>
        <span className="dsh-atb-iso-fact">基线 {shortHash(execution.baseCommit)} → {shortHash(execution.headCommit)}</span>
        {execution.changedFiles !== undefined && execution.changedFiles > 0 && (
          <span className="dsh-atb-iso-fact">改动 {execution.changedFiles} 个文件</span>
        )}
        {execution.diffStat !== undefined && <span className="dsh-atb-iso-fact" title={execution.diffStat}>{execution.diffStat}</span>}
      </div>

      {commits.length > 0
        ? (
            <div className="dsh-atb-iso-commits">
              {commits.slice(0, 10).map(c => (
                <div key={c.hash} className="dsh-atb-iso-commit">
                  <code>{shortHash(c.hash)}</code>
                  <span>{c.subject}</span>
                </div>
              ))}
              {commitTotal > 10 && <div className="dsh-atb-iso-more">… 共 {commitTotal} 个提交</div>}
            </div>
          )
        : <div className="dsh-atb-iso-nocommit">该次执行没有产生提交（改动可能未提交，见下方警告）</div>}

      {dirtyTotal > 0 && (
        <div className="dsh-atb-iso-dirty" title={dirty.join('\n')}>
          ⚠ 有 {dirtyTotal} 处未提交修改（合并前请让 agent 提交，或手动处理）
        </div>
      )}

      <div className="dsh-atb-iso-actions">
        {running
          ? <span className="dsh-atb-iso-hint">执行中 — 结束后可合并或清理</span>
          : confirmMerge
            ? (
                <span className="dsh-atb-confirm">
                  <span className="dsh-atb-confirm-label">将分支以 --no-ff 合并到主工作区？</span>
                  <button type="button" className="dsh-atb-btn" data-primary="true" disabled={busy} onClick={doMerge}>确认合并</button>
                  <button type="button" className="dsh-atb-btn" onClick={() => setConfirmMerge(false)}>取消</button>
                </span>
              )
            : (
                <button
                  type="button"
                  className="dsh-atb-btn"
                  disabled={busy}
                  title="在主工作区 git merge --no-ff 该任务分支（要求主区干净；冲突会原样报告）"
                  onClick={() => setConfirmMerge(true)}
                >
                  ⇥ 合并到主工作区
                </button>
              )}
        {!running && (confirmRemove === null
          ? (
              <>
                <button
                  type="button"
                  className="dsh-atb-btn"
                  data-danger="true"
                  disabled={busy}
                  title="git worktree remove（有未提交修改时拒绝）"
                  onClick={() => setConfirmRemove('wt')}
                >
                  🗑 删除 worktree
                </button>
                {task.branch !== undefined && (
                  <button
                    type="button"
                    className="dsh-atb-btn"
                    data-danger="true"
                    disabled={busy}
                    title="删除 worktree 并删除任务分支（有未提交修改时拒绝）"
                    onClick={() => setConfirmRemove('wtb')}
                  >
                    🗑 删 worktree + 分支
                  </button>
                )}
              </>
            )
          : (
              <span className="dsh-atb-confirm">
                <span className="dsh-atb-confirm-label">{confirmRemove === 'wtb' ? '删除 worktree 并删除分支？' : '删除 worktree 目录？'}</span>
                <button type="button" className="dsh-atb-btn" data-danger="true" disabled={busy} onClick={() => doRemove(confirmRemove === 'wtb')}>确认删除</button>
                <button type="button" className="dsh-atb-btn" onClick={() => setConfirmRemove(null)}>取消</button>
              </span>
            ))}
        {!running && confirmRemove === null && !confirmMerge && <span className="dsh-atb-iso-hint">分支与 worktree 保留中 — 可退回继续修改</span>}
      </div>
      {alertEl}
    </div>
  )
}

/**
 * The detail view.
 * @param task - the task record.
 * @param controller - the controller.
 * @param now - current epoch ms (stale-claim highlight).
 */
export function TaskDetail({ task, controller, now }: { task: TaskRecord; controller: BoardController; now?: number }) {
  const [comment, setComment] = useState('')
  const [confirmDone, setConfirmDone] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const { alert: showAlert, el: alertEl } = useAlert()
  const ws = controller.getSnapshot().workspaces.find(w => w.id === task.workspaceId)
  const canRun = task.status !== 'in_progress' && task.status !== 'done' && task.status !== 'archived'
  const runningExecution = task.executions.find(e => e.outcome === 'running')
  const holder = task.status === 'in_progress' ? task.claimedBy : undefined
  const stale = now !== undefined && isStaleClaim(task, now)

  /** Jump to an execution's session; prompt precisely when it cannot open. */
  const jumpToSession = (sessionId: string): void => {
    void controller.openSession(sessionId).then(result => {
      if (result === 'missing') showAlert(`该会话已被删除（${shortId(sessionId)}），无法打开`)
      else if (result === 'archived') showAlert(`该会话已归档（${shortId(sessionId)}），已从会话列表隐藏`)
      else if (result === 'unavailable') showAlert(`会话导航不可用，会话 ID：${sessionId}`)
    })
  }

  return (
    <div className="dsh-atb-detail" data-urgency={task.urgency}>
      <div className="dsh-atb-detail-head">
        <div className="dsh-atb-detail-titlewrap">
          <div className="dsh-atb-detail-titlebar">
            <h3>{task.title}</h3>
            <span className="dsh-atb-statuspill" data-status={task.status}>{STATUS_LABEL[task.status] ?? task.status}</span>
          </div>
          <div className="dsh-atb-detail-chips">
            <Chip tone={task.urgency}>● {URGENCY_LABEL[task.urgency] ?? task.urgency}</Chip>
            <Chip icon="📁">{ws?.title ?? shortId(task.workspaceId)}</Chip>
            {task.model !== undefined && <Chip icon="✦">{task.model.model}</Chip>}
            {task.presetId !== undefined && <Chip icon="🎛" >{task.presetId}</Chip>}
            {task.execution.mode === 'scheduled' && (
              <Chip icon="⏰">{task.execution.cron} · 下次 {fmtTime(task.execution.nextRunAt)}</Chip>
            )}
            {task.blocked && <Chip icon="⛔" tone="urgent">受阻</Chip>}
            {task.branch !== undefined && (
              <Chip icon="🌿" tone={undefined}>Worktree · {task.branch.length > 28 ? `${task.branch.slice(0, 28)}…` : task.branch}</Chip>
            )}
            {(task.isolation === undefined || task.isolation === 'worktree') && task.branch === undefined && <Chip icon="🌿">Worktree 隔离</Chip>}
            {holder !== undefined && (
              <Chip icon={stale ? '⏱' : '🔑'} tone={stale ? 'urgent' : undefined}>
                {stale ? '认领超时 · ' : '由 '}{shortId(holder)} 持有
              </Chip>
            )}
            {task.trashedAt !== undefined && <Chip icon="🗑" tone="urgent">已删除待清除</Chip>}
            <Chip>v{task.version}</Chip>
          </div>
          <div className="dsh-atb-detail-sub">
            更新 {fmtTime(task.updatedAt)} · 最近操作 {task.updatedBy.kind === 'agent' ? `🤖 ${shortId(task.updatedBy.sessionId)}` : '👤 用户'}
          </div>
        </div>
        <div className="dsh-atb-detail-topbtns">
          <button type="button" className="dsh-atb-detail-edit" onClick={() => controller.openEditor(task.id)}>✎ 编辑</button>
          <button
            type="button"
            className="dsh-atb-detail-edit"
            title="复制此任务的全部配置为一张新卡（待办列）"
            onClick={() => void controller.duplicate(task)}
          >
            ⧉ 复制
          </button>
          {canRun && task.branch !== undefined && (
            <button
              type="button"
              className="dsh-atb-detail-run"
              title="续跑：保留现有 worktree 与分支（上次的改动和提交都在原处），在其上继续执行；默认「立即执行」会重置为全新基线"
              onClick={() => void controller.run(task.id, true)}
            >
              ↻ 续跑
            </button>
          )}
          {canRun && (
            <button
              type="button"
              className="dsh-atb-detail-run"
              title={task.model !== undefined ? `新会话执行（${task.model.model}）` : '新会话执行（默认模型）'}
              onClick={() => void controller.run(task.id)}
            >
              ▶ 立即执行
            </button>
          )}
          {runningExecution !== undefined && (confirmCancel
            ? (
              <span className="dsh-atb-confirm">
                <span className="dsh-atb-confirm-label">停止该执行会话？</span>
                <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => { void controller.cancel(task.id); setConfirmCancel(false) }}>停止</button>
                <button type="button" className="dsh-atb-btn" onClick={() => setConfirmCancel(false)}>取消</button>
              </span>
            )
            : (
              <button
                type="button"
                className="dsh-atb-detail-run"
                data-danger="true"
                title={`停止执行会话 ${runningExecution.sessionId ?? ''}（任务回到待办）`}
                onClick={() => setConfirmCancel(true)}
              >
                ■ 停止执行
              </button>
            ))}
          <button type="button" className="dsh-atb-detail-close" aria-label="关闭" onClick={() => controller.select(undefined)}>✕</button>
        </div>
      </div>

      {task.description.length > 0 && (
        <div className="dsh-atb-fieldcard">
          <div className="dsh-atb-fieldcard-label">描述</div>
          <div className="dsh-atb-desc">{task.description}</div>
        </div>
      )}

      {task.prompt.length > 0 && (
        <div className="dsh-atb-fieldcard" data-kind="prompt">
          <div className="dsh-atb-fieldcard-label">执行 Prompt</div>
          <div className="dsh-atb-promptbox">{task.prompt}</div>
        </div>
      )}

      <IsolationBlock task={task} controller={controller} />

      <div className="dsh-atb-detail-actions">
        <div className="dsh-atb-movebtns">
          {moveTargets(task).map(to => to === 'done'
            ? (confirmDone
                ? (
                    <span key={to} className="dsh-atb-confirm">
                      <span className="dsh-atb-confirm-label">确认完成？</span>
                      <button type="button" className="dsh-atb-btn" data-primary="true" onClick={() => { void controller.move(task.id, task.version, 'done'); setConfirmDone(false) }}>确认</button>
                      <button type="button" className="dsh-atb-btn" onClick={() => setConfirmDone(false)}>取消</button>
                    </span>
                  )
                : <button key={to} type="button" className="dsh-atb-movebtn" data-to={to} onClick={() => setConfirmDone(true)}>移至→{MOVE_LABEL[to]}</button>)
            : (
                <button key={to} type="button" className="dsh-atb-movebtn" data-to={to} onClick={() => void controller.move(task.id, task.version, to)}>
                  移至→{MOVE_LABEL[to]}
                </button>
              ))}
          <button type="button" className="dsh-atb-movebtn" data-to="blocked" onClick={() => void controller.toggleBlocked(task)}>
            {task.blocked ? '✓ 解除受阻' : '⛔ 标记受阻'}
          </button>
          {holder !== undefined && (
            <button
              type="button"
              className="dsh-atb-movebtn"
              data-to="release"
              title={`释放 ${holder} 的认领：任务回到待办（持有会话可能仍在工作，确认它已停止后再释放）`}
              onClick={() => void controller.move(task.id, task.version, 'todo')}
            >
              🔓 释放认领
            </button>
          )}
        </div>
      </div>

      <div className="dsh-atb-section">
        <h4>评论{task.comments.length > 0 && <span className="dsh-atb-count2">{task.comments.length}</span>}</h4>
        {task.comments.length === 0
          ? <div className="dsh-atb-empty2">暂无评论 — agent 交接时会在这里汇报改动与验证结果</div>
          : (
              <div className="dsh-atb-commentlist">
                {task.comments.map(c => (
                  <div key={c.id} className="dsh-atb-bubble" data-from={c.threadId !== undefined ? 'agent' : 'user'}>
                    <div className="dsh-atb-bubble-avatar">{c.threadId !== undefined ? '🤖' : '👤'}</div>
                    <div className="dsh-atb-bubble-main">
                      <div className="dsh-atb-bubble-meta">
                        <b>{c.threadId !== undefined ? `agent ${shortId(c.threadId)}` : '用户'}</b>
                        <span>{fmtTime(c.createdAt)}</span>
                      </div>
                      <div className="dsh-atb-bubble-body">{c.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
        <div className="dsh-atb-composer">
          <textarea
            className="dsh-atb-composer-input"
            value={comment}
            placeholder="以用户身份留言（agent 开工前会读）…"
            onChange={e => setComment(e.target.value)}
            onKeyDown={e => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && comment.trim().length > 0) {
                void controller.comment(task.id, comment)
                setComment('')
              }
            }}
          />
          <button
            type="button"
            className="dsh-atb-composer-send"
            disabled={comment.trim().length === 0}
            onClick={() => { void controller.comment(task.id, comment); setComment('') }}
          >
            发表
          </button>
        </div>
      </div>

      {task.executions.length > 0 && (
        <div className="dsh-atb-section">
          <h4>执行记录<span className="dsh-atb-count2">{task.executions.length}</span>
            {task.executionsPruned !== undefined && task.executionsPruned > 0 && (
              <span className="dsh-atb-count2" title={`更早的 ${task.executionsPruned} 条执行记录已按保留上限清理`}>+{task.executionsPruned} 已清理</span>
            )}
          </h4>
          <div className="dsh-atb-execlist">
            {[...task.executions].reverse().map(e => (
              <div key={e.id} className="dsh-atb-exec-row">
                <span className="dsh-atb-exec-dot" data-outcome={e.outcome} />
                <span className="dsh-atb-exec-trigger">{e.trigger === 'manual' ? '手动' : '定时'}</span>
                <span className="dsh-atb-exec-outcome" data-outcome={e.outcome}>{OUTCOME_LABEL[e.outcome] ?? e.outcome}</span>
                <span className="dsh-atb-exec-time">{fmtTime(e.startedAt)}{e.endedAt !== undefined && ` · ${duration(e.startedAt, e.endedAt)}`}</span>
                {e.sessionId !== undefined && (
                  <button
                    type="button"
                    className="dsh-atb-exec-session"
                    title={`点击打开该执行会话：${e.sessionId}`}
                    onClick={() => jumpToSession(e.sessionId!)}
                  >
                    🤖 {shortId(e.sessionId)} ↗
                  </button>
                )}
                {e.error !== undefined && <span className="dsh-atb-exec-error" title={e.error}>{e.error.slice(0, 80)}{e.error.length > 80 ? '…' : ''}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="dsh-atb-dangerzone">
        {task.trashedAt === undefined
          ? <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => void controller.remove(task.id, task.version, false)}>🗑 删除（标记待清除）</button>
          : (confirmPurge
              ? (
                  <span className="dsh-atb-confirm">
                    <span className="dsh-atb-confirm-label">物理清除不可恢复</span>
                    <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => { void controller.remove(task.id, task.version, true); setConfirmPurge(false) }}>确认清除</button>
                    <button type="button" className="dsh-atb-btn" onClick={() => setConfirmPurge(false)}>取消</button>
                  </span>
                )
              : <button type="button" className="dsh-atb-btn" data-danger="true" onClick={() => setConfirmPurge(true)}>🔥 物理清除（需确认）</button>)}
      </div>

      {alertEl}
    </div>
  )
}
