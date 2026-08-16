/**
 * Host-side cron scheduler: one tick per minute over the ledger's scheduled
 * tasks. A due task (nextRunAt reached, not running, not trashed) first has
 * its next run advanced to the next cron match — then it executes through
 * the same path as the manual button. Missed windows (host was down, tab
 * closed — irrelevant here, this is the host process) simply advance: a
 * nextRunAt more than one window in the past is skipped, not caught up.
 *
 * @module dsh-taskboard/host/scheduler
 */
import { nextCronTime, parseCron, type TaskLedger } from '../shared/protocol.ts'
import { DEFAULT_MAX_CONCURRENT, type ExecutionService } from './execution.ts'
import type { TaskStore } from './store.ts'

/** Tick cadence. */
const TICK_MS = 60_000

/** A due window older than this is skipped (missed while the host was down). */
const SKIP_AFTER_MS = 5 * 60_000

/** Everything the scheduler needs. */
export interface SchedulerDeps {
  store: TaskStore
  execution: Pick<ExecutionService, 'run' | 'inFlight'>
  now: () => number
  /** Max concurrently running executions (default 3; must match the execution service). */
  maxConcurrent?: number
  /** Timer face (injectable for tests). */
  timers?: {
    setInterval(fn: () => void, ms: number): unknown
    clearInterval(handle: unknown): void
  }
}

/**
 * The cron scheduler.
 */
export class SchedulerService {
  private handle: unknown
  private catchup: ReturnType<typeof setTimeout> | undefined

  /** @param deps - store + execution + clock. */
  constructor(private readonly deps: SchedulerDeps) {}

  /** Start ticking. */
  start(): void {
    const timers = this.deps.timers ?? {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    }
    this.handle = timers.setInterval(() => { void this.tick() }, TICK_MS)
    // Catch up promptly on host restart: run one tick soon after start. The
    // handle is cleared on dispose so a torn-down scheduler never fires.
    this.catchup = setTimeout(() => { void this.tick() }, 3_000)
  }

  /** Stop ticking. */
  dispose(): void {
    if (this.catchup !== undefined) {
      clearTimeout(this.catchup)
      this.catchup = undefined
    }
    if (this.handle === undefined) return
    const timers = this.deps.timers ?? { clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) }
    timers.clearInterval(this.handle)
    this.handle = undefined
  }

  /** One scheduler pass (exported for tests). */
  async tick(): Promise<void> {
    // Load once before reading: snapshot() does not trigger a load, and the
    // scheduler may be the first consumer after a host restart (otherwise it
    // would tick over an empty ledger until something else loads it).
    await this.deps.store.load()
    const now = this.deps.now()
    const ledger: TaskLedger = this.deps.store.snapshot()
    const atCapacity = this.deps.execution.inFlight() >= (this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    for (const task of ledger.tasks) {
      if (task.execution.mode !== 'scheduled' || task.execution.cron === undefined) continue
      if (task.execution.nextRunAt === undefined) continue
      if (task.status === 'in_progress' || task.trashedAt !== undefined) continue
      if (task.execution.nextRunAt > now) continue
      // At the concurrency cap: leave nextRunAt in the past and retry next
      // tick — advancing here would silently burn this window.
      if (atCapacity) continue
      const missed = now - task.execution.nextRunAt > SKIP_AFTER_MS

      // Advance the schedule FIRST (idempotent under re-ticks), then run
      // unless the window was missed entirely.
      await this.advance(task.id, now)
      if (missed) continue
      const lastTriggeredAt = task.execution.nextRunAt
      await this.markTriggered(task.id, lastTriggeredAt)
      await this.deps.execution.run(task.id, 'scheduled').catch(error => {
        console.error('[dsh-taskboard] scheduled run failed:', error)
      })
    }
  }

  /** Recompute and persist the next run for one scheduled task. */
  private async advance(taskId: string, now: number): Promise<void> {
    await this.deps.store.mutate('task-updated', (ledger) => {
      const task = ledger.tasks.find(t => t.id === taskId)
      if (task === undefined || task.execution.cron === undefined) return undefined
      const match = parseCron(task.execution.cron)
      const next = match === null ? undefined : nextCronTime(match, now) ?? undefined
      if (next === undefined) return undefined
      task.execution.nextRunAt = next
      return [task]
    })
  }

  /** Record the trigger instant on the task. */
  private async markTriggered(taskId: string, at: number | undefined): Promise<void> {
    if (at === undefined) return
    await this.deps.store.mutate('task-updated', (ledger) => {
      const task = ledger.tasks.find(t => t.id === taskId)
      if (task === undefined) return undefined
      task.execution.lastTriggeredAt = at
      return [task]
    })
  }
}
