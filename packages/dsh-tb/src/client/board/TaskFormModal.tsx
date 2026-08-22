/**
 * The task form modal — create and edit in one polished dialog: header with
 * icon / subtitle / close, a sectioned field grid (title, project, model,
 * urgency tri-picker with hints, description, prompt, execution-mode
 * segmented picker, cron with presets and a live next-run preview), and a
 * footer bar carrying the validation hint and the actions. Esc closes;
 * the title input is focused on open.
 *
 * @module dsh-taskboard/client/board/TaskFormModal
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BoardController } from '../controller.ts'
import { loadDefaultIsolation, saveDefaultIsolation } from '../controller.ts'
import type { TaskTemplateSpec } from '../../shared/api.ts'
import type { ChecklistItem, IsolationMode, Urgency } from '../../shared/protocol.ts'
import { MAX_CHECKLIST_ITEMS, nextCronTime, parseCron } from '../../shared/protocol.ts'
import { fmtTime } from './TaskBoard.tsx'

/** One row of the configured model catalog (from llm.models). */
export interface CatalogModel { provider: string; model: string; name?: string }

/** Urgency segmented options with a one-line hint each. */
const URGENCY_OPTIONS: ReadonlyArray<{ value: Urgency; label: string; hint: string }> = [
  { value: 'urgent', label: '紧急', hint: '优先处理' },
  { value: 'normal', label: '一般', hint: '正常排期' },
  { value: 'relaxed', label: '不急', hint: '有空再做' },
]

/** Cron presets offered in the scheduled mode. */
const CRON_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: '每天 09:00', cron: '0 9 * * *' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '每 10 分钟', cron: '*/10 * * * *' },
  { label: '每周一 09:00', cron: '0 9 * * 1' },
]

/** Field shell: label + control, optionally spanning the full grid row. */
function Field({ label, required = false, full = false, children }: {
  label: string
  required?: boolean
  full?: boolean
  children: ReactNode
}) {
  return (
    <label className="dsh-atb-field" data-span={full ? 'full' : undefined}>
      <span className="dsh-atb-field-label">
        {label}
        {required && <em className="dsh-atb-req">*</em>}
      </span>
      {children}
    </label>
  )
}

/** One editable checklist row (create: fresh unchecked; edit: preserved ids/flags). */
interface CheckRow {
  id?: string
  text: string
  checked: boolean
  checkedBy?: string
  checkedAt?: number
  note?: string
}

/**
 * The checklist (DoD) editor: toggle + text + remove per row, add button,
 * cap-enforced. Edit mode preserves checked state and notes (the GUI
 * replaces the whole list on save).
 */
function ChecklistEditor({ rows, onChange, editing }: { rows: CheckRow[]; onChange: (rows: CheckRow[]) => void; editing: boolean }) {
  const setRow = (index: number, patch: Partial<CheckRow>): void => {
    const next = rows.map((row, i) => i === index ? { ...row, ...patch } : row)
    onChange(next)
  }
  const checked = rows.filter(r => r.checked).length
  return (
    <div className="dsh-atb-cke">
      {rows.map((row, index) => (
        <div key={row.id ?? `new-${index}`} className="dsh-atb-cke-row">
          {editing && (
            <input
              type="checkbox"
              className="dsh-atb-cke-box"
              checked={row.checked}
              title={`勾选状态随保存保留（当前勾选人：${row.checkedBy ?? '未勾选'}）`}
              onChange={e => setRow(index, { checked: e.target.checked })}
            />
          )}
          <input
            className="dsh-atb-cke-text"
            value={row.text}
            maxLength={200}
            placeholder={`验收项 ${index + 1}（完成标准）`}
            spellCheck={false}
            onChange={e => setRow(index, { text: e.target.value })}
          />
          <button type="button" className="dsh-atb-cke-del" title="删除该验收项" onClick={() => onChange(rows.filter((_, i) => i !== index))}>✕</button>
        </div>
      ))}
      {rows.length < MAX_CHECKLIST_ITEMS && (
        <button type="button" className="dsh-atb-cke-add" onClick={() => onChange([...rows, { text: '', checked: false }])}>＋ 添加验收项</button>
      )}
      {rows.length > 0 && (
        <span className="dsh-atb-cke-hint">{editing ? `已勾选 ${checked}/${rows.length}（保存将整体覆盖清单，勾选状态保留）` : `共 ${rows.length} 项，执行会话按清单干活并逐项勾选，未完成项验收时高亮`}</span>
      )}
    </div>
  )
}

/**
 * The form modal. Without `task` it composes a new task (optionally
 * prefilled from a chosen template); with `task` it edits that record
 * (project, urgency, execution, model included — the GUI is the owner
 * surface).
 * @param controller - the controller.
 * @param task - the task being edited (create mode when absent).
 */
export function TaskFormModal({ controller, task }: { controller: BoardController; task?: TaskRecordLike }) {
  const state = controller.getSnapshot()
  const prefill: TaskTemplateSpec | undefined = state.templatePrefill
  const editing = task !== undefined
  const [title, setTitle] = useState(task?.title ?? prefill?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? prefill?.description ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? prefill?.prompt ?? '')
  const [admissionId, setAdmissionId] = useState(task?.admissionId ?? '')
  const [solutionRef, setSolutionRef] = useState(task?.solutionRef ?? '')

  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? '')
  const [urgency, setUrgency] = useState<Urgency>(task?.urgency ?? (prefill?.urgency === 'urgent' || prefill?.urgency === 'relaxed' ? prefill.urgency : 'normal'))
  const [mode, setMode] = useState<'claim' | 'scheduled'>(task?.execution.mode === 'scheduled' || prefill?.execution?.mode === 'scheduled' ? 'scheduled' : 'claim')
  const [cron, setCron] = useState(task?.execution.cron ?? prefill?.execution?.cron ?? '0 9 * * *')
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [model, setModel] = useState(task?.model !== undefined || prefill?.model !== undefined ? JSON.stringify(task?.model ?? prefill?.model) : '')
  // Preset roster (0.3.3): create mode PRE-SELECTS the deployment default
  // (标准模式 in this deployment); '' = 跟随部署默认 (submit omits the field).
  const initialPreset = task?.presetId ?? prefill?.presetId ?? ''
  const [presetId, setPresetId] = useState(initialPreset)
  const [presets, setPresets] = useState<Array<{ id: string; name?: string }>>([])
  const [presetDefault, setPresetDefault] = useState<string | undefined>(undefined)
  // Isolation toggle: create mode starts from the remembered choice (default
  // on) or the template's choice; edit mode starts from the task and locks
  // once execution began.
  const [isolation, setIsolation] = useState<IsolationMode>(task?.isolation ?? (prefill?.isolation === 'none' ? 'none' : prefill?.isolation === 'worktree' ? 'worktree' : loadDefaultIsolation()))
  // Checklist (0.4.0): create = template texts / blank rows; edit = live items.
  const [checkRows, setCheckRows] = useState<CheckRow[]>(
    task?.checklist !== undefined && task.checklist.length > 0
      ? task.checklist.map(i => ({ ...i }))
      : (prefill?.checklist ?? []).map(text => ({ text, checked: false })),
  )
  const titleRef = useRef<HTMLInputElement>(null)

  // Focus the title and close on Esc while the dialog is open.
  useEffect(() => {
    titleRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') controller.closeForm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [controller])

  // Model catalog: the plugin face provides it when the runtime is up.
  useEffect(() => {
    const face = (controller as unknown as { modelCatalog?: () => Promise<CatalogModel[]> }).modelCatalog
    if (face === undefined) return
    void face().then(setCatalog).catch(() => setCatalog([]))
  }, [controller])

  // Preset roster: same lazy face; pre-select the deployment default in
  // create mode (unless a template pinned one) so executions run with a
  // real tool set out of the box.
  useEffect(() => {
    const face = (controller as unknown as { presetCatalog?: () => Promise<{ presets: Array<{ id: string; name?: string }>; defaultId?: string }> }).presetCatalog
    if (face === undefined) return
    void face().then(roster => {
      setPresets(roster.presets)
      setPresetDefault(roster.defaultId)
      if (task?.presetId === undefined && initialPreset === '' && roster.defaultId !== undefined) setPresetId(roster.defaultId)
    }).catch(() => setPresets([]))
  }, [controller, task?.presetId, initialPreset])

  // Live cron validation + next-run preview (same math as the host).
  const cronMatch = mode === 'scheduled' ? parseCron(cron.trim()) : null
  const nextRun = cronMatch !== null ? nextCronTime(cronMatch, Date.now()) : null
  const cronBad = mode === 'scheduled' && (cronMatch === null || nextRun === null)
  const valid = title.trim().length > 0 && workspaceId !== '' && !cronBad

  // A task already in progress cannot be run again (host rejects it).
  const runBlocked = editing && task.status === 'in_progress'

  // Isolation editability: locked once the task has execution history (the
  // branch and its baseline depend on the choice — plan §3.1).
  const isolationLocked = editing && ((task.executions?.length ?? 0) > 0 || task.status === 'in_progress')
  const gitOk = controller.gitAvailable(workspaceId)
  // Non-git project: the worktree option is disabled; submitting keeps the
  // default (runtime auto-degrades with a note) instead of persisting 'none'.
  const isolationDisabled = isolationLocked || !gitOk

  /** Isolation payload for submit: undefined keeps the default (degrades naturally). */
  const isolationPayload = (): string | undefined => {
    if (!gitOk) return undefined
    if (!editing) saveDefaultIsolation(isolation)
    return isolation
  }

  /** Preset payload: '' = follow the deployment default (submit omits). */
  const presetPayload = (): string | undefined => (presetId.trim().length > 0 ? presetId.trim() : undefined)

  /** Checklist rows with non-empty text (blank rows are dropped on submit). */
  const filledRows = (): CheckRow[] => checkRows.map(r => ({ ...r, text: r.text.trim() })).filter(r => r.text.length > 0)

  const submit = (): void => {
    if (!valid) return
    const picked = model !== '' ? (JSON.parse(model) as { provider: string; model: string }) : undefined
    const isolationOut = isolationPayload()
    const presetOut = presetPayload()
    const rows = filledRows()
    if (editing) {
      void controller.update(task.id, task.version, {
        title,
        description,
        prompt,
        urgency,
        workspaceId,
        execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
        // '' in edit mode clears the pinned model back to the default.
        model: picked ?? null,
        ...(isolationOut !== undefined && !isolationLocked ? { isolation: isolationOut } : {}),
        presetId: presetOut ?? null,
        // 选填字段：留空即清除。
        admissionId: admissionId.trim().length > 0 ? admissionId.trim() : null,
        solutionRef: solutionRef.trim().length > 0 ? solutionRef.trim() : null,
        // [] clears the checklist (host deletes the field on empty).
        checklist: rows.length > 0 ? rows : null,

      })
    } else {
      void controller.create({
        title,
        workspaceId,
        urgency,
        description: description.length > 0 ? description : undefined,
        prompt: prompt.length > 0 ? prompt : undefined,
        execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
        model: picked,
        ...(isolationOut !== undefined ? { isolation: isolationOut } : {}),
        ...(presetOut !== undefined ? { presetId: presetOut } : {}),
        ...(admissionId.trim().length > 0 ? { admissionId: admissionId.trim() } : {}),
        ...(solutionRef.trim().length > 0 ? { solutionRef: solutionRef.trim() } : {}),
        ...(rows.length > 0 ? { checklist: rows.map(r => r.text) } : {}),

      })
    }
  }

  /** Save the form, then immediately trigger a manual run of the task. */
  const submitAndRun = (): void => {
    if (!valid || runBlocked) return
    const picked = model !== '' ? (JSON.parse(model) as { provider: string; model: string }) : undefined
    const isolationOut = isolationPayload()
    const presetOut = presetPayload()
    const rows = filledRows()
    if (editing) {
      void (async () => {
        const saved = await controller.update(task.id, task.version, {
          title,
          description,
          prompt,
          urgency,
          workspaceId,
          execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
          model: picked ?? null,
          ...(isolationOut !== undefined && !isolationLocked ? { isolation: isolationOut } : {}),
          presetId: presetOut ?? null,
          admissionId: admissionId.trim().length > 0 ? admissionId.trim() : null,
          solutionRef: solutionRef.trim().length > 0 ? solutionRef.trim() : null,
          checklist: rows.length > 0 ? rows : null,

        })
        if (saved) await controller.run(task.id)
      })()
    } else {
      void (async () => {
        const id = await controller.create({
          title,
          workspaceId,
          urgency,
          description: description.length > 0 ? description : undefined,
          prompt: prompt.length > 0 ? prompt : undefined,
          execution: mode === 'scheduled' ? { mode, cron: cron.trim() } : { mode },
          model: picked,
          ...(isolationOut !== undefined ? { isolation: isolationOut } : {}),
          ...(presetOut !== undefined ? { presetId: presetOut } : {}),
          ...(admissionId.trim().length > 0 ? { admissionId: admissionId.trim() } : {}),
          ...(solutionRef.trim().length > 0 ? { solutionRef: solutionRef.trim() } : {}),
          ...(rows.length > 0 ? { checklist: rows.map(r => r.text) } : {}),

        })
        if (id !== undefined) await controller.run(id)
      })()
    }
  }

  const hint = !valid
    ? (title.trim().length === 0 ? '请填写标题' : workspaceId === '' ? '请选择项目' : 'Cron 表达式无效（分 时 日 月 周）')
    : mode === 'scheduled' && nextRun !== null
      ? `下次运行 ${fmtTime(nextRun)}`
      : editing
        ? `保存后版本 v${task.version} → v${task.version + 1}`
        : '创建后项目内会话可认领执行'

  return (
    <div className="dsh-atb-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) controller.closeForm() }}>
      <div className="dsh-atb-modal" data-mode={editing ? 'edit' : 'create'} role="dialog" aria-modal="true" aria-label={editing ? '编辑任务' : '新建任务'}>
        <div className="dsh-atb-modal-head">
          <span className="dsh-atb-modal-headicon">{editing ? '✎' : '✚'}</span>
          <div className="dsh-atb-modal-headtext">
            <h3>{editing ? '编辑任务' : '新建任务'}</h3>
            <p>{editing ? '调整任务内容与执行配置' : '推入看板，项目内会话可认领执行'}</p>
          </div>
          <button type="button" className="dsh-atb-modal-close" aria-label="关闭" onClick={() => controller.closeForm()}>✕</button>
        </div>

        <div className="dsh-atb-modal-body">
          <Field label="标题" required full>
            <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)} placeholder="一句话说清要做什么" maxLength={200} />
          </Field>

          <Field label="项目" required>
            <select value={workspaceId} onChange={e => setWorkspaceId(e.target.value)}>
              {state.workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.title || ws.path}</option>)}
            </select>
          </Field>

          <Field label="模型（默认 = 会话默认模型）">
            <select value={model} onChange={e => setModel(e.target.value)}>
              <option value="">默认模型</option>
              {catalog.map(m => (
                <option key={`${m.provider}/${m.model}`} value={JSON.stringify({ provider: m.provider, model: m.model })}>
                  {m.name ?? m.model}（{m.provider}）
                </option>
              ))}
            </select>
          </Field>

          {presets.length > 0 && (
            <Field label="执行模式（preset）">
              <select value={presetId} onChange={e => setPresetId(e.target.value)} title="执行会话按该 preset 组合（决定工具集与人设）；默认 = 部署默认 preset">
                <option value="">跟随部署默认{presetDefault !== undefined ? `（当前：${presets.find(p => p.id === presetDefault)?.name ?? presetDefault}）` : ''}</option>
                {presets.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name ?? p.id}{p.id === presetDefault ? '（部署默认）' : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="紧急度" full>
            <div className="dsh-atb-urgency-picker">
              {URGENCY_OPTIONS.map(o => (
                <button
                  key={o.value}
                  type="button"
                  className="dsh-atb-urgency-opt"
                  data-urgency={o.value}
                  data-on={urgency === o.value}
                  onClick={() => setUrgency(o.value)}
                >
                  <span className="dsh-atb-urgency-name"><span className="dsh-atb-dot" data-urgency={o.value} />{o.label}</span>
                  <span className="dsh-atb-urgency-hint">{o.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label={editing ? '描述' : '描述（可选）'} full>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="需求细节、验收标准…" />
          </Field>

          <Field label={editing ? '准入 ID' : '准入 ID（可选）'} full>
            <input value={admissionId} onChange={e => setAdmissionId(e.target.value)} placeholder="任务通过准入/工单审核时的编号（选填）" maxLength={200} />
          </Field>

          <Field label={editing ? '方案链接或路径' : '方案链接或路径（可选）'} full>
            <input value={solutionRef} onChange={e => setSolutionRef(e.target.value)} placeholder="参考方案的 URL 或本地文件路径，执行时发给 agent（选填）" maxLength={2000} />
          </Field>

          <Field label={editing ? '执行 Prompt' : '执行 Prompt（可选，默认 = 标题+描述）'} full>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={'发给执行会话的完整指令。支持模板变量：{{lastExecution}}（上次执行结果）、{{lastComments}}（最近 3 条评论）'} />
          </Field>

          <Field label="执行方式" full>
            <div className="dsh-atb-mode-picker">
              <button type="button" className="dsh-atb-mode-opt" data-on={mode === 'claim'} onClick={() => setMode('claim')}>
                <span className="dsh-atb-mode-name">🤝 认领制</span>
                <span className="dsh-atb-mode-hint">项目内会话认领</span>
              </button>
              <button type="button" className="dsh-atb-mode-opt" data-on={mode === 'scheduled'} onClick={() => setMode('scheduled')}>
                <span className="dsh-atb-mode-name">⏰ 定时执行</span>
                <span className="dsh-atb-mode-hint">到点自动开跑</span>
              </button>
            </div>
          </Field>

          {mode === 'scheduled' && (
            <Field label="Cron 表达式" required full>
              <input
                className={cronBad ? 'dsh-atb-input-bad' : undefined}
                value={cron}
                onChange={e => setCron(e.target.value)}
                placeholder="分 时 日 月 周"
                spellCheck={false}
              />
              <span className="dsh-atb-cron-presets">
                {CRON_PRESETS.map(p => (
                  <button
                    key={p.cron}
                    type="button"
                    className="dsh-atb-cron-preset"
                    data-on={cron.trim() === p.cron}
                    onClick={() => setCron(p.cron)}
                  >
                    {p.label}
                  </button>
                ))}
                {!cronBad && nextRun !== null && <span className="dsh-atb-cron-next">下次 {fmtTime(nextRun)}</span>}
              </span>
            </Field>
          )}

          <Field label="执行隔离" full>
            <div className="dsh-atb-mode-picker" data-disabled={isolationDisabled ? 'true' : undefined}>
              <button
                type="button"
                className="dsh-atb-mode-opt"
                data-on={isolation === 'worktree'}
                disabled={isolationDisabled}
                title={isolationLocked ? '任务已有执行记录，隔离方式已锁定' : !gitOk ? '当前项目非 git 仓库' : '每次执行在独立 worktree 分支上进行'}
                onClick={() => setIsolation('worktree')}
              >
                <span className="dsh-atb-mode-name">🌿 Worktree 隔离</span>
                <span className="dsh-atb-mode-hint">
                  {isolationLocked ? '已锁定（执行开始后不可更改）' : !gitOk ? '当前项目非 git 仓库' : '独立分支 task/标题+ID，互不污染'}
                </span>
              </button>
              <button
                type="button"
                className="dsh-atb-mode-opt"
                data-on={isolation === 'none'}
                disabled={isolationDisabled}
                title={isolationLocked ? '任务已有执行记录，隔离方式已锁定' : '直接在项目目录执行（不使用 git）'}
                onClick={() => setIsolation('none')}
              >
                <span className="dsh-atb-mode-name">📁 原目录执行</span>
                <span className="dsh-atb-mode-hint">{isolationLocked ? '已锁定（执行开始后不可更改）' : !gitOk ? '当前项目非 git 仓库，将在原目录执行' : '不使用 git，直接在项目目录工作'}</span>
              </button>
            </div>
            {!gitOk && !isolationLocked && (
              <span className="dsh-atb-isolation-note">当前项目非 git 仓库，将在原目录执行（任务仍按默认配置创建，运行时自动降级）</span>
            )}
          </Field>

          <Field label={editing ? '验收清单（DoD）' : '验收清单（DoD，可选）'} full>
            <ChecklistEditor rows={checkRows} onChange={setCheckRows} editing={editing} />
          </Field>
        </div>

        <div className="dsh-atb-modal-foot">
          <span className="dsh-atb-modal-hint" data-tone={valid ? undefined : 'bad'}>{hint}</span>
          <span className="dsh-atb-modal-footbtns">
            <button type="button" className="dsh-atb-btn" onClick={() => controller.closeForm()}>取消</button>
            <button
              type="button"
              className="dsh-atb-btn"
              disabled={!valid || runBlocked}
              title={runBlocked ? '任务正在执行中，不能重复发起' : '保存后立即发起执行（新会话）'}
              onClick={submitAndRun}
            >
              ⚡ 立即执行
            </button>
            <button type="button" className="dsh-atb-btn" data-primary="true" disabled={!valid} onClick={submit}>
              {editing ? '保存修改' : '创建任务'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

/** The record shape this form edits (narrow structural type to avoid a value import). */
interface TaskRecordLike {
  id: string
  version: number
  status?: string
  title: string
  description: string
  prompt: string
  workspaceId: string
  urgency: Urgency
  execution: { mode: 'claim' | 'scheduled'; cron?: string }
  model?: { provider: string; model: string }
  isolation?: IsolationMode
  presetId?: string
  admissionId?: string
  solutionRef?: string
  checklist?: ChecklistItem[]

  executions?: unknown[]
}
