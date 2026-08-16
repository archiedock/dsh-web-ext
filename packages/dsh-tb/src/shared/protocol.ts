/**
 * Task domain model, state machine, urgency classes, and cron math — the
 * framework-free core shared verbatim by the host half (tools, store, routes,
 * scheduler) and, from P2 on, the browser half (board view).
 *
 * Everything here is a pure function over plain data: no imports beyond the
 * standard library, no I/O, no globals. Tests drive it directly.
 *
 * @module dsh-taskboard/shared/protocol
 */

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * Task lifecycle states. Main board columns render `backlog → todo →
 * in_progress → in_review → done`; `canceled` and `archived` are secondary
 * states collected under an "other tasks" tab. `blocked` is NOT a status —
 * it is a horizontal marker any non-terminal state may carry.
 */
export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'canceled'
  | 'archived'

/** Statuses shown as the five main board columns, in order. */
export const MAIN_STATUSES: readonly TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
]

/** Statuses collected under the secondary tab. */
export const SECONDARY_STATUSES: readonly TaskStatus[] = ['canceled', 'archived']

/** Every valid status, main first. */
export const ALL_STATUSES: readonly TaskStatus[] = [...MAIN_STATUSES, ...SECONDARY_STATUSES]

/**
 * Legal forward/sideways transitions. Anything not listed is rejected with
 * `invalid_transition`. `archived` is terminal.
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  backlog: ['todo', 'canceled'],
  todo: ['in_progress', 'backlog', 'canceled'],
  in_progress: ['in_review', 'todo', 'canceled'],
  in_review: ['in_progress', 'todo', 'done', 'canceled'],
  done: ['archived'],
  canceled: ['archived', 'todo'],
  archived: [],
}

/**
 * Whether a status move is legal per the state machine.
 * @param from - current status.
 * @param to - requested status.
 * @returns true when the transition is allowed.
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * The claim move: the one transition that transfers ownership of a task to
 * the calling session. Guarded by the project (workspace) boundary in the
 * tool layer.
 */
export function isClaim(from: TaskStatus, to: TaskStatus): boolean {
  return from === 'todo' && to === 'in_progress'
}

/** Statuses a `done` move may depart from (user confirmation only). */
export function canCompleteFrom(from: TaskStatus): boolean {
  return from === 'in_review'
}

// ---------------------------------------------------------------------------
// Urgency
// ---------------------------------------------------------------------------

/** Urgency classes with fixed UI colors. */
export type Urgency = 'urgent' | 'normal' | 'relaxed'

/** All valid urgency values. */
export const URGENCIES: readonly Urgency[] = ['urgent', 'normal', 'relaxed']

/** CSS color token per urgency: red / purple / blue. */
export const URGENCY_COLOR: Readonly<Record<Urgency, string>> = {
  urgent: '#e5484d',
  normal: '#8e4ec6',
  relaxed: '#3e63dd',
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Per-task code isolation mode (0.3.0).
 * - `worktree`: each execution runs in a fresh `git worktree` on a dedicated
 *   task branch (`task/<标题>+<taskId>`) under `<workspace>/.dsh-worktrees/`.
 * - `none`: run in the workspace directory as before, zero git interaction.
 * Omitted = the default `worktree`; non-git projects auto-degrade at run
 * time (the execution record carries an `isolationNote` explaining why).
 */
export type IsolationMode = 'worktree' | 'none'

/** Validate an isolation value. */
export function asIsolation(raw: string): IsolationMode {
  if (raw !== 'worktree' && raw !== 'none') {
    throw new Error("isolation must be 'worktree' or 'none'")
  }
  return raw
}

/** Resolve a task's effective isolation (omitted → the worktree default). */
export function effectiveIsolation(task: Pick<TaskRecord, 'isolation'>): IsolationMode {
  return task.isolation === undefined ? 'worktree' : task.isolation
}

/** How a task may run. */
export type ExecutionMode = 'claim' | 'scheduled'

/**
 * Per-task execution configuration. `claim` tasks wait for an in-project
 * session to claim them; `scheduled` tasks run on the host cron scheduler.
 */
export interface ExecutionConfig {
  mode: ExecutionMode
  /** Five-field cron expression (minute hour day month weekday); required for `scheduled`. */
  cron?: string
  /** Next due time (epoch ms); maintained by the host scheduler. */
  nextRunAt?: number
  /** Last time the scheduler triggered this task (epoch ms). */
  lastTriggeredAt?: number
}

/**
 * Parse a five-field cron expression. Supported field syntax: star, star/step
 * (`* / n` without spaces), a single number, an `a-b` range, and comma lists
 * of those. Day-of-week accepts both 0 and 7 as Sunday (normalized to 0).
 *
 * @param expr - the expression to parse.
 * @returns the match sets per field, or null when invalid.
 */
export function parseCron(expr: string): CronMatch | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const ranges: ReadonlyArray<readonly [number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ]
  const sets: Array<Set<number>> = []
  for (let i = 0; i < 5; i++) {
    const [min, max] = ranges[i]!
    const set = new Set<number>()
    if (!parseCronField(fields[i]!, min, max, set)) return null
    sets.push(set)
  }
  const weekdays = new Set<number>()
  for (const day of sets[4]!) weekdays.add(day === 7 ? 0 : day)
  return { minutes: sets[0]!, hours: sets[1]!, days: sets[2]!, months: sets[3]!, weekdays }
}

/** Parsed cron field match sets. */
export type CronMatch = {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  weekdays: ReadonlySet<number>
}

/** Parse one cron field into a match set; false on any syntax error. */
function parseCronField(field: string, min: number, max: number, out: Set<number>): boolean {
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10)
    if (!Number.isInteger(step) || step < 1) return false
    let lo: number
    let hi: number
    if (range === undefined || range === '') return false
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = Number.parseInt(a ?? '', 10)
      hi = Number.parseInt(b ?? '', 10)
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false
    } else {
      lo = Number.parseInt(range, 10)
      if (!Number.isInteger(lo)) return false
      hi = stepRaw === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi) return false
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0
}

/**
 * The next time at or after `from` matching the cron sets (local time),
 * or null when no match exists within four years (e.g. Feb 30).
 * @param match - parsed cron sets.
 * @param from - epoch ms start point (inclusive match candidate).
 * @returns the next match's epoch ms, or null.
 */
export function nextCronTime(match: CronMatch, from: number): number | null {
  // Walk minute by minute from the next whole minute, capped at ~4 years.
  const start = new Date(from)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  const cap = from + 4 * 366 * 24 * 60 * 60 * 1000
  let t = start.getTime()
  while (t <= cap) {
    const d = new Date(t)
    if (
      match.months.has(d.getMonth() + 1)
      && match.days.has(d.getDate())
      && match.weekdays.has(d.getDay())
      && match.hours.has(d.getHours())
      && match.minutes.has(d.getMinutes())
    ) {
      return t
    }
    t += 60_000
  }
  return null
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Who performed a write. */
export type Actor =
  | { kind: 'user' }
  | { kind: 'agent'; sessionId: string }

/** A progress/report comment on a task. */
export type CommentRecord = {
  id: string
  /** Comment body (plain text; UI renders as pre-wrapped). */
  body: string
  /** Optimistic-concurrency version of this comment. */
  version: number
  createdAt: number
  /** The session that wrote this comment; absent for user-written ones. */
  threadId?: string
}

/** One commit produced by an isolated execution (hash + subject). */
export type CommitInfo = { hash: string; subject: string }

/** One execution attempt of a task. */
export type ExecutionRecord = {
  id: string
  /** The session this execution ran in; set once the session is really started. */
  sessionId?: string
  /** Trigger: manual button or the host scheduler. */
  trigger: 'manual' | 'scheduled'
  startedAt?: number
  endedAt?: number
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled'
  error?: string
  /** Code isolation actually used (`none` also covers degraded worktree runs). */
  isolation?: IsolationMode
  /** Why worktree isolation degraded to running in the original directory. */
  isolationNote?: string
  /** The task branch this execution worked on (worktree runs only). */
  branch?: string
  /** Absolute path of the dedicated worktree (worktree runs only). */
  worktreePath?: string
  /** HEAD of the task branch before the execution started. */
  baseCommit?: string
  /** HEAD at settlement. */
  headCommit?: string
  /** Commits between baseCommit and headCommit (hash + subject; capped at 50, newest first). */
  commits?: CommitInfo[]
  /** Total commits before the evidence cap (equals commits.length when under it). */
  commitsTotal?: number
  /** Uncommitted changes present at settlement (`git status --porcelain` lines; capped at 100). */
  dirtyFiles?: string[]
  /** Total uncommitted lines before the evidence cap. */
  dirtyFilesTotal?: number
  /** Aggregate diff stat between baseCommit and headCommit. */
  diffStat?: string
  /** How many files differ between baseCommit and headCommit. */
  changedFiles?: number
}

/** The per-model override a task may carry; absent = session default model. */
export type TaskModel = {
  provider: string
  model: string
}

/** One task on the board. */
export type TaskRecord = {
  id: string
  title: string
  description: string
  /** The prompt sent to a fresh session on execution; falls back to title+description. */
  prompt: string
  /** Owning project: a DSH workspace id. */
  workspaceId: string
  urgency: Urgency
  status: TaskStatus
  /** Horizontal marker: work cannot continue right now (any non-terminal status). */
  blocked: boolean
  execution: ExecutionConfig
  model?: TaskModel
  /** Code isolation for executions (omitted = the worktree default; see {@link IsolationMode}). */
  isolation?: IsolationMode
  /**
   * The agent preset execution sessions are composed from (omitted = the
   * deployment default preset). Recorded on the session header and mounted
   * via the presets service at creation — this is what hands the session its
   * tool set. Editable any time (each run composes fresh).
   */
  presetId?: string
  /**
   * The task branch fixed at the FIRST worktree creation (`task/<标题>+<taskId>`).
   * Renaming the task afterwards never changes it (history preservation).
   */
  branch?: string
  /**
   * The session currently holding the in-progress claim (explicit claim or a
   * live execution). Present only while `status === 'in_progress'`: any move
   * out of in_progress releases it. `updatedBy` is audit-only — user edits no
   * longer erase the holder.
   */
  claimedBy?: string
  /** When the current holder claimed the task (epoch ms). */
  claimedAt?: number
  version: number
  createdAt: number
  updatedAt: number
  createdBy: Actor
  updatedBy: Actor
  comments: CommentRecord[]
  executions: ExecutionRecord[]
  /** How many older execution records were pruned by the retention cap. */
  executionsPruned?: number
  /** Soft-delete marker set by agent `taskboard_delete`; user confirms the purge. */
  trashedAt?: number
}

/** Retention cap: how many execution records each task keeps (oldest pruned). */
export const MAX_EXECUTIONS = 20

/**
 * Enforce the execution-record retention cap on one task (in place): keep the
 * newest {@link MAX_EXECUTIONS} records, count the dropped ones in
 * `executionsPruned`. Running records are always the newest, never dropped.
 * @param task - the task to prune.
 */
export function pruneExecutions(task: TaskRecord): void {
  if (task.executions.length <= MAX_EXECUTIONS) return
  const dropped = task.executions.length - MAX_EXECUTIONS
  task.executions = task.executions.slice(-MAX_EXECUTIONS)
  task.executionsPruned = (task.executionsPruned ?? 0) + dropped
}

/** The whole durable ledger. */
export type TaskLedger = {
  schemaVersion: number
  /** Global monotonic revision; every mutation bumps it. */
  revision: number
  tasks: TaskRecord[]
}

/** Current ledger format version. */
export const LEDGER_SCHEMA_VERSION = 1

/** An empty ledger. */
export function emptyLedger(): TaskLedger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, revision: 0, tasks: [] }
}

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

/** Random base36 suffix. */
function suffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** Mint a task id. */
export function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${suffix()}`
}

/** Mint a comment id. */
export function newCommentId(): string {
  return `c-${Date.now().toString(36)}-${suffix()}`
}

/** Mint an execution id. */
export function newExecutionId(): string {
  return `e-${Date.now().toString(36)}-${suffix()}`
}

// ---------------------------------------------------------------------------
// validation helpers (input shaping for tools and routes)
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a title: trimmed, 1..200 chars.
 * @param raw - the raw input.
 * @returns the normalized title.
 * @throws when empty or too long.
 */
export function normalizeTitle(raw: string): string {
  const t = raw.trim()
  if (t.length === 0 || t.length > 200) {
    throw new Error('title must be 1..200 characters')
  }
  return t
}

/**
 * Validate a task prompt: trimmed, at most 8000 chars; empty becomes ''.
 * @param raw - the raw input.
 */
export function normalizePrompt(raw: string | undefined): string {
  const t = (raw ?? '').trim()
  if (t.length > 8000) throw new Error('prompt must be at most 8000 characters')
  return t
}

/**
 * Validate and normalize a comment body: trimmed, 1..4000 chars.
 * @param raw - the raw input.
 */
export function normalizeBody(raw: string): string {
  const t = raw.trim()
  if (t.length === 0 || t.length > 4000) {
    throw new Error('comment body must be 1..4000 characters')
  }
  return t
}

/**
 * Validate an urgency value.
 * @param raw - the raw input.
 */
export function asUrgency(raw: string): Urgency {
  if (!URGENCIES.includes(raw as Urgency)) {
    throw new Error(`urgency must be one of: ${URGENCIES.join(', ')}`)
  }
  return raw as Urgency
}

/**
 * Validate a status value.
 * @param raw - the raw input.
 */
export function asStatus(raw: string): TaskStatus {
  if (!ALL_STATUSES.includes(raw as TaskStatus)) {
    throw new Error(`status must be one of: ${ALL_STATUSES.join(', ')}`)
  }
  return raw as TaskStatus
}

/**
 * Validate an execution config request from raw tool/route input.
 * `scheduled` requires a valid cron; computes the first `nextRunAt` from
 * `now`.
 * @param raw - raw execution input ({@link ExecutionConfig} fields, untyped).
 * @param now - current epoch ms.
 * @returns the normalized config.
 */
export function normalizeExecution(
  raw: { mode?: string; cron?: string },
  now: number,
): ExecutionConfig {
  const mode = raw.mode ?? 'claim'
  if (mode !== 'claim' && mode !== 'scheduled') {
    throw new Error("execution.mode must be 'claim' or 'scheduled'")
  }
  if (mode === 'claim') return { mode }
  const cron = (raw.cron ?? '').trim()
  const match = parseCron(cron)
  if (match === null) throw new Error('execution.cron is not a valid 5-field cron expression')
  const next = nextCronTime(match, now)
  if (next === null) throw new Error('execution.cron never matches within 4 years')
  return { mode, cron, nextRunAt: next }
}

/**
 * The effective prompt of a task: explicit prompt, or title+description.
 * @param task - the task.
 */
export function effectivePrompt(task: TaskRecord): string {
  if (task.prompt.length > 0) return task.prompt
  const head = task.title
  return task.description.length > 0 ? `${head}\n\n${task.description}` : head
}

/**
 * Whether the task is currently claimed by a session (running state).
 * @param task - the task.
 */
export function isClaimedBy(task: TaskRecord): string | undefined {
  return task.status === 'in_progress' && task.claimedBy !== undefined ? task.claimedBy : undefined
}

/**
 * Maintain the explicit claim fields around a status change: entering
 * in_progress under a session records the holder (an execution-start or an
 * agent claim); every move out of in_progress releases the claim (handoff,
 * give-back, cancel). A user-driven move into in_progress records no holder —
 * no session works on it yet.
 * @param task - the task being written (mutated in place).
 * @param to - the target status.
 * @param now - current epoch ms.
 * @param holder - the session id claiming the task, when applicable.
 */
export function syncClaim(task: TaskRecord, to: TaskStatus, now: number, holder?: string): void {
  if (to !== 'in_progress') {
    delete task.claimedBy
    delete task.claimedAt
  } else if (holder !== undefined) {
    task.claimedBy = holder
    task.claimedAt = now
  }
}

/**
 * Validate and normalize a pinned model: `{ provider, model }`, both
 * non-empty trimmed strings.
 * @param raw - the raw input.
 * @returns the normalized model.
 * @throws when the shape or the fields are invalid.
 */
export function normalizeModel(raw: unknown): TaskModel {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('model must be { provider: string, model: string }')
  }
  const { provider, model } = raw as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new Error('model must be { provider: string, model: string }')
  }
  const p = provider.trim()
  const m = model.trim()
  if (p.length === 0 || m.length === 0) {
    throw new Error('model.provider and model.model must be non-empty strings')
  }
  return { provider: p, model: m }
}

/**
 * Compact list-projection of a task (token-friendly for `taskboard_list`).
 * @param task - the task.
 */
export type TaskSummary = {
  id: string
  title: string
  workspaceId: string
  urgency: Urgency
  status: TaskStatus
  blocked: boolean
  executionMode: ExecutionMode
  nextRunAt?: number
  model?: TaskModel
  version: number
  claimOwner?: string
  commentCount: number
  lastExecutionOutcome?: ExecutionRecord['outcome']
  trashed: boolean
}

/**
 * Build the compact summary of a task.
 * @param task - the task.
 */
export function summarize(task: TaskRecord): TaskSummary {
  const last = task.executions.length > 0 ? task.executions[task.executions.length - 1] : undefined
  return {
    id: task.id,
    title: task.title,
    workspaceId: task.workspaceId,
    urgency: task.urgency,
    status: task.status,
    blocked: task.blocked,
    executionMode: task.execution.mode,
    nextRunAt: task.execution.nextRunAt,
    model: task.model,
    version: task.version,
    claimOwner: isClaimedBy(task),
    commentCount: task.comments.length,
    lastExecutionOutcome: last?.outcome,
    trashed: task.trashedAt !== undefined,
  }
}
