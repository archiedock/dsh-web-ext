/**
 * One board card: urgency edge, title, project/urgency/model/schedule/
 * blocked/trashed badges, comment count, and the last execution outcome.
 * Click opens the detail pane; cards in the backlog/todo columns are
 * draggable between those two columns (HTML5 drag & drop). Cards sitting
 * in the in_review column also carry quick-review actions (✓ complete /
 * ✗ send back with an optional note).
 *
 * The root is a div[role=button] (not a <button>) so the quick actions can
 * be real nested buttons — valid HTML and native keyboard activation.
 *
 * @module dsh-taskboard/client/board/TaskCard
 */
import { useState } from 'react'
import type { BoardController } from '../controller.ts'
import type { TaskRecord } from '../../shared/protocol.ts'
import { fmtTime, isStaleClaim } from './TaskBoard.tsx'

const URGENCY_LABEL: Record<TaskRecord['urgency'], string> = { urgent: '紧急', normal: '一般', relaxed: '不急' }
const OUTCOME_LABEL: Record<string, string> = { running: '执行中', succeeded: '成功', failed: '失败', cancelled: '已取消' }

/** dataTransfer type carrying the dragged task id. */
export const DRAG_TYPE = 'application/x-dsh-atb-task'

/**
 * The card view.
 * @param task - the task record.
 * @param controller - the controller.
 * @param draggable - enable dragging.
 * @param now - current epoch ms (stale-claim highlight).
 * @param onAlert - show an alert message (replaces native alert).
 */
export function TaskCard({ task, controller, draggable = false, now, onAlert }: { task: TaskRecord; controller: BoardController; draggable?: boolean; now?: number; onAlert?: (msg: string) => void }) {
  const [rejectOpen, setRejectOpen] = useState(false)
  const [note, setNote] = useState('')
  const last = task.executions.length > 0 ? task.executions[task.executions.length - 1] : undefined
  const running = task.executions.find(ex => ex.outcome === 'running')
  const stale = now !== undefined && isStaleClaim(task, now)
  const reviewing = task.status === 'in_review' && task.trashedAt === undefined

  /** Submit the quick-reject: one atomic route (move + optional note). */
  const submitReject = (): void => {
    void controller.reject(task.id, task.version, note).then(ok => {
      if (ok) { setRejectOpen(false); setNote('') }
      // On failure the error surface explains; the form stays open for retry.
    })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="dsh-atb-card"
      data-urgency={task.urgency}
      draggable={draggable && !rejectOpen}
      onDragStart={(e) => {
        // Block drag if a session is still executing this task
        if (running !== undefined) {
          e.preventDefault()
          const msg = `该任务正在由【${task.title}】会话执行，不能拖动`
          if (onAlert !== undefined) onAlert(msg)
          else alert(msg)
          return
        }
        e.dataTransfer.setData(DRAG_TYPE, task.id)
        e.dataTransfer.effectAllowed = 'move'
        e.currentTarget.dataset.dragging = 'true'
      }}
      onDragEnd={(e) => { delete e.currentTarget.dataset.dragging }}
      onClick={() => controller.select(task.id)}
      onKeyDown={(e) => {
        // Only the card itself (not the nested quick-action controls).
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          controller.select(task.id)
        }
      }}
    >
      <div className="dsh-atb-card-title">{task.title}</div>
      <div className="dsh-atb-card-meta">
        <span className="dsh-atb-badge">{URGENCY_LABEL[task.urgency]}</span>
        {task.blocked && <span className="dsh-atb-badge" data-kind="blocked">受阻</span>}
        {stale && <span className="dsh-atb-badge" data-kind="stale">⏱ 认领超时</span>}
        {task.execution.mode === 'scheduled' && (
          <span className="dsh-atb-badge" data-kind="scheduled">⏰ {fmtTime(task.execution.nextRunAt)}</span>
        )}
        {task.model !== undefined && <span className="dsh-atb-badge">{task.model.model}</span>}
        {task.checklist !== undefined && task.checklist.length > 0 && (
          <span
            className="dsh-atb-badge"
            data-kind={task.status === 'in_review' && task.checklist.some(i => !i.checked) ? 'blocked' : 'checklist'}
            title={task.status === 'in_review' && task.checklist.some(i => !i.checked) ? '待验收：清单未全部勾选' : '验收清单进度'}
          >
            ☑ {task.checklist.filter(i => i.checked).length}/{task.checklist.length}
          </span>
        )}
        {task.status === 'done' && <span className="dsh-atb-badge" data-kind="done">完成</span>}
        {last !== undefined && (
          <span className="dsh-atb-badge" data-kind={last.outcome === 'running' ? 'running' : last.outcome}>
            {OUTCOME_LABEL[last.outcome] ?? last.outcome}
          </span>
        )}
        {task.comments.length > 0 && <span>💬 {task.comments.length}</span>}
        {task.trashedAt !== undefined && <span className="dsh-atb-badge" data-kind="trashed">待清除</span>}
        <span style={{ marginLeft: 'auto' }}>{fmtTime(task.updatedAt)}</span>
      </div>
      {reviewing && (rejectOpen
        ? (
            <div className="dsh-atb-quick-reject" onClick={e => e.stopPropagation()}>
              <input
                className="dsh-atb-input dsh-atb-quick-note"
                value={note}
                placeholder="退回原因（可选，agent 开工前会读）…"
                autoFocus
                spellCheck={false}
                onChange={e => setNote(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitReject()
                  else if (e.key === 'Escape') { setRejectOpen(false); setNote('') }
                }}
              />
              <button type="button" className="dsh-atb-quickbtn" data-act="reject-confirm" onClick={submitReject}>退回待办</button>
              <button type="button" className="dsh-atb-quickbtn" data-act="reject-cancel" onClick={() => { setRejectOpen(false); setNote('') }}>取消</button>
            </div>
          )
        : (
            <div className="dsh-atb-quick" onClick={e => e.stopPropagation()}>
              <button
                type="button"
                className="dsh-atb-quickbtn"
                data-act="done"
                title="验收完成：移至已完成"
                onClick={() => void controller.move(task.id, task.version, 'done')}
              >
                ✓ 完成
              </button>
              <button
                type="button"
                className="dsh-atb-quickbtn"
                data-act="reject"
                title="退回待办，可附退回原因"
                onClick={() => setRejectOpen(true)}
              >
                ✗ 退回
              </button>
            </div>
          ))}
    </div>
  )
}
