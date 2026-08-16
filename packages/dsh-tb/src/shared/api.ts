/**
 * Wire contract for the /taskboard host routes: the JSON envelope,
 * request/response shapes, and SSE event payloads shared by the host routes
 * and the browser client.
 *
 * @module dsh-taskboard/shared/api
 */
import type { TaskLedger, TaskRecord, TaskSummary } from './protocol.ts'

export type { TaskRecord }

/** Route prefix on the shared DSH webserver (same origin as the GUI). */
export const ROUTE_PREFIX = '/dsh-taskboard'

/** SSE stream path (exact route; longest-prefix wins keep it disjoint). */
export const SSE_PATH = '/dsh-taskboard/events'

/** Stable error codes (mirror the tool-level codes plus HTTP mapping). */
export type ApiErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'version_conflict'
  | 'invalid_transition'
  | 'forbidden'
  | 'internal'

/** Success envelope. */
export type ApiOk<T> = { ok: true; value: T }

/** Failure envelope. */
export type ApiFail = { ok: false; error: { code: ApiErrorCode; message: string } }

/** The envelope either way. */
export type ApiResult<T> = ApiOk<T> | ApiFail

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

/** Full-state response (the reconnect baseline after an SSE gap). */
export type StateResponse = TaskLedger

/** Workspace listing for the UI pickers. */
export type WorkspaceView = { id: string; path: string; title: string; sessionCount: number; gitAvailable?: boolean }

/** Create-task request body (actor is always the GUI user). */
export type CreateTaskBody = {
  title: string
  workspaceId: string
  urgency: string
  description?: string
  prompt?: string
  execution?: { mode?: string; cron?: string }
  model?: { provider: string; model: string }
  /** Code isolation for executions ('worktree' | 'none'); omitted = default. */
  isolation?: string
  /** Agent preset for execution sessions; omitted = deployment default. */
  presetId?: string
}

/** Update-task request body (ifVersion mandatory). */
export type UpdateTaskBody = {
  ifVersion: number
  title?: string
  description?: string
  prompt?: string
  urgency?: string
  blocked?: boolean
  /** Rebind the task to another project (GUI owner surface only). */
  workspaceId?: string
  execution?: { mode?: string; cron?: string }
  model?: { provider: string; model: string } | null
  /** Change isolation; locked once the task has execution history. */
  isolation?: string
  /** Change the execution preset (takes effect on the next run). */
  presetId?: string | null
}

/** Move-task request body (ifVersion mandatory; the user MAY move to done). */
export type MoveTaskBody = { ifVersion: number; status: string }

/**
 * Quick-reject request body (card ✗ button): move back to todo plus an
 * optional user comment, committed as ONE ledger mutation so a failed move
 * can never strand an orphan comment.
 */
export type RejectTaskBody = { ifVersion: number; body?: string }

/** Comment request body. */
export type CommentBody = { body: string }

/** Delete request body (purge=true physically removes a trashed task). */
export type DeleteTaskBody = { ifVersion?: number; purge?: boolean }

/** Run request body; `reuse: true` = 续跑 (keep a live worktree as-is). */
export type RunTaskBody = { reuse?: boolean }

/** Merge outcome: `noop: true` = the branch had no commits over HEAD (nothing merged). */
export type MergeBranchResponse = { merged: boolean; noop?: boolean; branch: string }

/** Remove a task's worktree; optionally delete its branch too. */
export type WorktreeRemoveBody = { deleteBranch?: boolean }

/** One orphan worktree directory (exists on disk, owned by no live task). */
export type OrphanWorktree = { workspaceId: string; workspacePath: string; taskId: string; path: string }

/** A git-enabled workspace whose .gitignore does not cover the worktree dir. */
export type GitignoreSuggestion = { workspaceId: string; workspacePath: string }

/** Health-diagnostics response (⚙ panel). */
export type DiagnosticsResponse = {
  revision: number
  tasks: number
  /** Executions currently marked `running`. */
  staleRunning: number
  /** Worktree directories whose task no longer exists in the ledger. */
  orphanWorktrees: OrphanWorktree[]
  /** Git workspaces whose .gitignore does not ignore the worktree dir. */
  gitIgnoreSuggestions: GitignoreSuggestion[]
}

/** One task (full record) response. */
export type TaskResponse = TaskRecord

/** Summary response used by list-ish endpoints. */
export type SummaryResponse = { tasks: TaskSummary[] }

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** Change frame pushed on every committed ledger mutation. */
export type ChangeEvent = {
  revision: number
  kind: 'task-created' | 'task-updated' | 'task-moved' | 'task-deleted' | 'comment-added' | 'execution-recorded'
  tasks: TaskSummary[]
}
