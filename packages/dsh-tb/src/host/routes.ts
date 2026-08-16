/**
 * /dsh-taskboard routes on the shared DSH webserver: a JSON API for the
 * GUI's human operations (create/update/move/comment/delete — actor `user`,
 * the done move IS allowed here) plus an SSE stream mirroring every
 * committed ledger mutation.
 *
 * All domain validation goes through the shared protocol pure functions; the
 * route layer only maps transport to envelope.
 *
 * @module dsh-taskboard/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  asIsolation,
  asStatus,
  asUrgency,
  canTransition,
  newCommentId,
  newTaskId,
  normalizeBody,
  normalizeExecution,
  normalizeModel,
  normalizePrompt,
  normalizeTitle,
  summarize,
  syncClaim,
  type TaskModel,
  type TaskRecord,
} from '../shared/protocol.ts'
import { WORKTREE_DIR, worktreePathOf, type GitFace } from './git.ts'
import { ROUTE_PREFIX, SSE_PATH, type ApiFail, type ApiResult } from '../shared/api.ts'
import type { TaskStore } from './store.ts'
import type { WorkspaceFace } from './tools.ts'

/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 20_000

/** How long a workspace git-detection result stays cached (fail-soft). */
const GIT_DETECT_TTL_MS = 60_000

/** The workspaces face routes need (same narrow shape as tools). */
export type RoutesWorkspaceFace = WorkspaceFace

/** Options. */
export interface TaskboardRoutesOptions {
  store: TaskStore
  workspaces: RoutesWorkspaceFace
  now: () => number
  /** Manual-run hook (the execution service); absent → 501. Options carry `reuseWorktree` (续跑). */
  run?: (taskId: string, options?: { reuseWorktree?: boolean }) => Promise<{ ok: true; executionId: string; sessionId: string } | { ok: false; error: string }>
  /** Cancel hook (the execution service); absent → 501. */
  cancel?: (taskId: string) => Promise<{ ok: true; executionId: string } | { ok: false; error: string }>
  /**
   * Registered model provider routes (from the host llm runtime), for
   * advisory validation of pinned models; undefined = runtime unavailable.
   */
  modelProviders?: () => string[] | undefined
  /** Git face for worktree actions + workspace git detection; absent → 501 on git actions. */
  git?: GitFace
}

/** Validate a pinned model: structural check always, provider route when known. */
function checkModel(raw: unknown, modelProviders?: () => string[] | undefined): TaskModel {
  const model = normalizeModel(raw)
  const providers = modelProviders?.()
  if (providers !== undefined && !providers.includes(model.provider)) {
    throw new Error(`Error: invalid_input: model provider "${model.provider}" has no registered route (available: ${providers.join(', ')})`)
  }
  return model
}

/** JSON-envelope writer. */
function json(res: ServerResponse, payload: ApiResult<unknown>, status = 200): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Domain failure → envelope + HTTP status. */
function fail(code: ApiFail['error']['code'], message: string): { res: ApiFail; status: number } {
  const status = code === 'invalid_input' || code === 'invalid_transition' ? 400
    : code === 'not_found' ? 404
      : code === 'version_conflict' ? 409
        : code === 'forbidden' ? 403
          : 500
  return { res: { ok: false, error: { code, message } }, status }
}

/** Read one JSON body (null on parse failure). */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** String field accessor (null when absent/not a string). */
function str(body: Record<string, unknown>, key: string): string | null {
  const v = body[key]
  return typeof v === 'string' ? v : null
}

/** Number field accessor (undefined when absent; null when present but not a number). */
function num(body: Record<string, unknown>, key: string): number | undefined | null {
  const v = body[key]
  if (v === undefined) return undefined
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Normalize an agent preset id: trimmed, non-empty; empty string → undefined. */
function normalizePresetId(raw: string | null): string | undefined {
  const t = (raw ?? '').trim()
  return t.length === 0 ? undefined : t
}

/** Map a thrown domain error to the envelope. */
function toFail(error: unknown): { res: ApiFail; status: number } {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.startsWith('Error: ') ? message.slice(7).split(':')[0] : undefined
  const known: ApiFail['error']['code'][] = ['invalid_input', 'not_found', 'version_conflict', 'invalid_transition', 'forbidden', 'internal']
  if (code !== undefined && (known as string[]).includes(code)) {
    return fail(code as ApiFail['error']['code'], message.slice(7 + code.length + 2))
  }
  if (code === 'workspace_mismatch') return fail('forbidden', message.slice(7 + code.length + 2))
  return fail('invalid_input', message)
}

/**
 * Register the taskboard routes.
 * @param ctx - context carrying the webServer service.
 * @param options - store + workspaces + clock.
 * @returns the disposer.
 */
export function registerTaskboardRoutes(ctx: Context, options: TaskboardRoutesOptions): () => void {
  const { store, workspaces } = options
  const subscribers = new Set<ServerResponse>()
  let heartbeat: NodeJS.Timeout | undefined

  const broadcast = (change: { revision: number; kind: string; tasks: readonly TaskRecord[] }): void => {
    const frame = `event: change\ndata: ${JSON.stringify({ revision: change.revision, kind: change.kind, tasks: change.tasks.map(summarize) })}\n\n`
    for (const res of subscribers) res.write(frame)
  }
  store.subscribe(broadcast)

  // Workspace git detection, TTL-cached and fail-soft (false on any error):
  // feeds the create-form isolation toggle and the diagnostics panel.
  const gitCache = new Map<string, { value: boolean; at: number }>()
  const gitHinted = new Set<string>()

  /** Whether <root>/.gitignore (missing file counts as missing) ignores our worktree dir. */
  const gitignoreMissing = async (path: string): Promise<boolean> => {
    try {
      const { readFile } = await import('node:fs/promises')
      const ignore = await readFile(join(path, '.gitignore'), 'utf8')
      return !ignore.split('\n').some(l => {
        const t = l.trim().replace(/\/+$/, '')
        return t === WORKTREE_DIR || t === `/${WORKTREE_DIR}`
      })
    } catch {
      return true // no .gitignore at all (or unreadable) → suggest creating one
    }
  }

  const gitAvailable = async (path: string): Promise<boolean> => {
    if (options.git === undefined) return false
    const hit = gitCache.get(path)
    if (hit !== undefined && options.now() - hit.at < GIT_DETECT_TTL_MS) return hit.value
    let value = false
    try {
      value = await options.git.detect(path)
    } catch { /* fail-soft → false */ }
    gitCache.set(path, { value, at: options.now() })
    // gitignore 建议 (plan §3.2): suggest (never write) ignoring our
    // worktree directory, once per workspace per host run.
    if (value && !gitHinted.has(path)) {
      gitHinted.add(path)
      if (await gitignoreMissing(path)) {
        console.info(`[dsh-taskboard] 建议在 ${path}/.gitignore 加入一行 ${WORKTREE_DIR}/ 以隐藏任务 worktree 目录（不会自动修改）`)
      }
    }
    return value
  }

  /** List orphan worktree dirs: entries under <ws>/.dsh-worktrees owned by no ledger task. */
  const listOrphanWorktrees = async (): Promise<Array<{ workspaceId: string; workspacePath: string; taskId: string; path: string }>> => {
    const orphans: Array<{ workspaceId: string; workspacePath: string; taskId: string; path: string }> = []
    const known = new Set(store.snapshot().tasks.map(t => t.id))
    for (const ws of workspaces.list()) {
      let entries: string[] = []
      try {
        const dirents = await readdir(join(ws.path, WORKTREE_DIR), { withFileTypes: true })
        entries = dirents.filter(e => e.isDirectory()).map(e => e.name)
      } catch { /* no worktrees dir → nothing to do */ }
      for (const taskId of entries) {
        if (!known.has(taskId)) orphans.push({ workspaceId: ws.id, workspacePath: ws.path, taskId, path: worktreePathOf(ws.path, taskId) })
      }
    }
    return orphans
  }

  /** Git-enabled workspaces whose .gitignore does not cover the worktree dir. */
  const listGitignoreSuggestions = async (): Promise<Array<{ workspaceId: string; workspacePath: string }>> => {
    const suggestions: Array<{ workspaceId: string; workspacePath: string }> = []
    for (const ws of workspaces.list()) {
      if (!(await gitAvailable(ws.path))) continue
      if (await gitignoreMissing(ws.path)) suggestions.push({ workspaceId: ws.id, workspacePath: ws.path })
    }
    return suggestions
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const pathname = url.pathname

      // ---------------------------------------------------------------- GET
      if (req.method === 'GET') {
        if (pathname === `${ROUTE_PREFIX}/state`) {
          await store.load()
          json(res, { ok: true, value: store.snapshot() })
          return
        }
        if (pathname === `${ROUTE_PREFIX}/workspaces`) {
          const list = workspaces.list()
          const flags = await Promise.all(list.map(ws => gitAvailable(ws.path)))
          json(res, {
            ok: true,
            value: list.map((ws, i) => ({ ...ws, sessionCount: 0, gitAvailable: flags[i] })),
          })
          return
        }
        if (pathname === `${ROUTE_PREFIX}/diagnostics`) {
          const ledger = store.snapshot()
          let staleRunning = 0
          for (const t of ledger.tasks) {
            for (const e of t.executions) if (e.outcome === 'running') staleRunning += 1
          }
          json(res, {
            ok: true,
            value: {
              revision: ledger.revision,
              tasks: ledger.tasks.length,
              staleRunning,
              orphanWorktrees: await listOrphanWorktrees(),
              gitIgnoreSuggestions: await listGitignoreSuggestions(),
            },
          })
          return
        }
        const taskMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)$`))
        if (taskMatch !== null) {
          const task = store.get(taskMatch[1]!)
          if (task === undefined) { const f = fail('not_found', 'no such task'); json(res, f.res, f.status); return }
          json(res, { ok: true, value: task })
          return
        }
        res.writeHead(404)
        res.end()
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      // CSRF fence: cross-site simple requests cannot set application/json.
      const contentType = req.headers['content-type'] ?? ''
      if (!contentType.toLowerCase().startsWith('application/json')) {
        const f = fail('invalid_input', 'content-type must be application/json')
        json(res, f.res, 415)
        return
      }
      const body = await readBody(req)
      if (body === null) {
        const f = fail('invalid_input', 'body is not a JSON object')
        json(res, f.res, 400)
        return
      }

      // ------------------------------------------------- POST /tasks (create)
      if (pathname === `${ROUTE_PREFIX}/tasks`) {
        try {
          const title = normalizeTitle(str(body, 'title') ?? '')
          const workspaceId = str(body, 'workspaceId') ?? ''
          if (workspaces.get(workspaceId) === undefined) throw new Error('Error: not_found: unknown workspace')
          const urgency = asUrgency(str(body, 'urgency') ?? '')
          const status = str(body, 'status') === null ? 'todo' as const : asStatus(str(body, 'status')!)
          const execution = normalizeExecution((body.execution as { mode?: string; cron?: string } | undefined) ?? {}, options.now())
          const model = body.model === undefined ? undefined : checkModel(body.model, options.modelProviders)
          const isolationRaw = str(body, 'isolation')
          const isolation = isolationRaw === null ? undefined : asIsolation(isolationRaw)
          const presetId = normalizePresetId(str(body, 'presetId'))
          const now = options.now()
          const task: TaskRecord = {
            id: newTaskId(),
            title,
            description: (str(body, 'description') ?? '').trim(),
            prompt: normalizePrompt(str(body, 'prompt') ?? undefined),
            workspaceId,
            urgency,
            status,
            blocked: false,
            execution,
            model,
            ...(isolation !== undefined ? { isolation } : {}),
            ...(presetId !== undefined ? { presetId } : {}),
            version: 1,
            createdAt: now,
            updatedAt: now,
            createdBy: { kind: 'user' },
            updatedBy: { kind: 'user' },
            comments: [],
            executions: [],
          }
          await store.mutate('task-created', ledger => {
            ledger.tasks.push(task)
            return [task]
          })
          json(res, { ok: true, value: summarize(task) }, 201)
        } catch (error) {
          const f = toFail(error)
          json(res, f.res, f.status)
        }
        return
      }

      // ------------------------------------------- POST /tasks/:id/{action}
      // (\w+ after the id would not match hyphenated actions like
      // worktree-remove, hence the explicit class.)
      const actionMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)/([\\w-]+)$`))
      if (actionMatch !== null) {
        const id = actionMatch[1]!
        const action = actionMatch[2]!
        try {
          const task = store.get(id)
          if (task === undefined) throw new Error('Error: not_found: no such task')
          if (action === 'update') {
            const ifVersion = num(body, 'ifVersion')
            if (ifVersion === undefined || ifVersion === null) throw new Error('Error: version_conflict: ifVersion required')
            if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`)
            const next = structuredClone(task)
            const title = str(body, 'title')
            if (title !== null) next.title = normalizeTitle(title)
            const description = str(body, 'description')
            if (description !== null) next.description = description.trim()
            const prompt = str(body, 'prompt')
            if (prompt !== null) next.prompt = normalizePrompt(prompt)
            const urgency = str(body, 'urgency')
            if (urgency !== null) next.urgency = asUrgency(urgency)
            // GUI-only rebind to another project; validated against the workspace registry.
            const workspaceId = str(body, 'workspaceId')
            if (workspaceId !== null) {
              if (workspaces.get(workspaceId) === undefined) throw new Error('Error: not_found: unknown workspace')
              next.workspaceId = workspaceId
            }
            if (typeof body.blocked === 'boolean') next.blocked = body.blocked
            // The GUI (task owner surface) may edit model/execution; null clears the model.
            if (body.execution !== undefined) next.execution = normalizeExecution(body.execution as { mode?: string; cron?: string }, options.now())
            if (body.model === null) next.model = undefined
            else if (body.model !== undefined) next.model = checkModel(body.model, options.modelProviders)
            // Isolation may change only before the first execution (分支与基线
            // 取决于该选择 — plan §3.1: 执行开始后锁定).
            const isolationRaw = str(body, 'isolation')
            if (isolationRaw !== null) {
              if (task.executions.length > 0 || task.status === 'in_progress') {
                throw new Error('Error: invalid_input: isolation 已锁定（任务已有执行记录），不可修改')
              }
              next.isolation = asIsolation(isolationRaw)
            }
            // Preset may change any time: each run composes fresh.
            if (body.presetId === null) delete next.presetId
            else if (body.presetId !== undefined) next.presetId = normalizePresetId(str(body, 'presetId'))!
            next.version = task.version + 1
            next.updatedAt = options.now()
            next.updatedBy = { kind: 'user' }
            await store.mutate('task-updated', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: summarize(next) })
            return
          }
          if (action === 'move') {
            const ifVersion = num(body, 'ifVersion')
            const status = str(body, 'status') ?? ''
            if (ifVersion === undefined || ifVersion === null) throw new Error('Error: version_conflict: ifVersion required')
            if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`)
            const to = asStatus(status)
            if (!canTransition(task.status, to)) throw new Error(`Error: invalid_transition: illegal transition ${task.status} → ${to}`)
            const next = structuredClone(task)
            next.status = to
            next.version = task.version + 1
            next.updatedAt = options.now()
            next.updatedBy = { kind: 'user' }
            if (task.status === 'todo' && to === 'in_progress') next.blocked = false
            // A user move records no holder; leaving in_progress releases any hold.
            syncClaim(next, to, options.now())
            await store.mutate('task-moved', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: summarize(next) })
            return
          }
          if (action === 'reject') {
            // Card quick-reject: back to todo + optional user comment in one
            // atomic mutation (a failed move never strands an orphan comment).
            const ifVersion = num(body, 'ifVersion')
            if (ifVersion === undefined || ifVersion === null) throw new Error('Error: version_conflict: ifVersion required')
            if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`)
            if (!canTransition(task.status, 'todo')) throw new Error(`Error: invalid_transition: illegal transition ${task.status} → todo`)
            const next = structuredClone(task)
            next.status = 'todo'
            next.version = task.version + 1
            next.updatedAt = options.now()
            next.updatedBy = { kind: 'user' }
            syncClaim(next, 'todo', options.now())
            const commentText = str(body, 'body') ?? ''
            if (commentText.trim().length > 0) {
              next.comments.push({ id: newCommentId(), body: normalizeBody(commentText), version: 1, createdAt: options.now() })
            }
            await store.mutate('task-moved', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: summarize(next) })
            return
          }
          if (action === 'comment') {
            const bodyText = str(body, 'body') ?? ''
            const comment = { id: newCommentId(), body: normalizeBody(bodyText), version: 1, createdAt: options.now() }
            const next = structuredClone(task)
            next.comments.push(comment)
            next.version = task.version + 1
            next.updatedAt = options.now()
            await store.mutate('comment-added', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: comment }, 201)
            return
          }
          if (action === 'delete') {
            const purge = body.purge === true
            if (purge) {
              if (task.trashedAt === undefined) throw new Error('Error: invalid_input: purge requires a trashed task (soft-delete first)')
              // Worktree safety before purge (plan §3.3, 0.3.1): refuse while
              // uncommitted work remains; otherwise clean the worktree and
              // the task branch along with the ledger entry.
              if (options.git !== undefined) {
                const ws = workspaces.get(task.workspaceId)
                if (ws !== undefined) {
                  const path = worktreePathOf(ws.path, id)
                  try {
                    await options.git.removeWorktree(ws.path, path)
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    if (message.includes('未提交修改')) {
                      throw new Error(`Error: invalid_input: ${message}；请先处理这些改动（提交、续跑或手动保存）再物理清除任务`)
                    }
                    if (/not a working tree|not a working-tree/i.test(message)) {
                      // An unregistered leftover dir: plain fs removal.
                      await rm(path, { recursive: true, force: true })
                    } else {
                      throw new Error(`Error: invalid_input: ${message}`)
                    }
                  }
                  if (task.branch !== undefined) {
                    try {
                      await options.git.deleteBranch(ws.path, task.branch)
                    } catch { /* best effort: the branch may outlive the task */ }
                  }
                }
              }
              await store.mutate('task-deleted', ledger => {
                ledger.tasks = ledger.tasks.filter(t => t.id !== id)
                return []
              })
              json(res, { ok: true, value: { purged: true } })
              return
            }
            const ifVersion = num(body, 'ifVersion')
            if (ifVersion === undefined || ifVersion === null) throw new Error('Error: version_conflict: ifVersion required')
            if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`)
            const next = structuredClone(task)
            next.trashedAt = options.now()
            next.version = task.version + 1
            await store.mutate('task-deleted', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: { trashed: true } })
            return
          }
          if (action === 'run') {
            if (options.run === undefined) {
              const f = fail('invalid_input', 'execution service unavailable')
              json(res, f.res, 501)
              return
            }
            // `reuse: true` = 续跑: keep a live worktree/branch as-is instead
            // of resetting to a fresh baseline (0.3.1).
            const runOptions = body.reuse === true ? { reuseWorktree: true } : undefined
            const result = await options.run(id, runOptions)
            if (result.ok) json(res, { ok: true, value: result }, 202)
            else {
              const f = fail('invalid_input', result.error)
              json(res, f.res, f.status)
            }
            return
          }
          if (action === 'cancel') {
            if (options.cancel === undefined) {
              const f = fail('invalid_input', 'execution service unavailable')
              json(res, f.res, 501)
              return
            }
            const result = await options.cancel(id)
            if (result.ok) json(res, { ok: true, value: { cancelled: true, executionId: result.executionId } }, 202)
            else {
              const f = fail('invalid_input', result.error)
              json(res, f.res, f.status)
            }
            return
          }
          if (action === 'merge') {
            // ⇥ 合并 (detail page, user-only): merge the task branch into the
            // main worktree with --no-ff; conflicts are reported verbatim.
            if (options.git === undefined) {
              const f = fail('invalid_input', 'git integration unavailable')
              json(res, f.res, 501)
              return
            }
            if (task.branch === undefined) throw new Error('Error: invalid_input: 该任务还没有 worktree 分支（未隔离执行过）')
            if (task.status === 'in_progress') throw new Error('Error: invalid_input: 任务执行中，不能合并')
            if (task.executions.some(e => e.outcome === 'running')) throw new Error('Error: invalid_input: 任务执行中，不能合并')
            const ws = workspaces.get(task.workspaceId)
            if (ws === undefined) throw new Error('Error: not_found: unknown workspace')
            // No-op detection (0.3.1): a branch with no commits over HEAD
            // merges as "already up to date" — report that instead of landing
            // a bogus 已合并 comment.
            let noop = false
            try {
              noop = await options.git.isAncestor(ws.path, task.branch)
            } catch { /* fail-soft: proceed to the real merge */ }
            if (noop) {
              json(res, { ok: true, value: { merged: false, noop: true, branch: task.branch } })
              return
            }
            try {
              await options.git.merge(ws.path, task.branch)
            } catch (error) {
              throw new Error(`Error: invalid_input: ${error instanceof Error ? error.message : String(error)}`)
            }
            const mergedComment = { id: newCommentId(), body: normalizeBody(`[系统] 分支 ${task.branch} 已合并到主工作区（--no-ff）。`), version: 1, createdAt: options.now() }
            const next = structuredClone(task)
            next.comments.push(mergedComment)
            next.version = task.version + 1
            next.updatedAt = options.now()
            await store.mutate('comment-added', ledger => {
              const i = ledger.tasks.findIndex(t => t.id === id)
              ledger.tasks[i] = next
              return [next]
            })
            json(res, { ok: true, value: { merged: true, branch: task.branch } })
            return
          }
          if (action === 'worktree-remove') {
            // 🗑 删除 worktree (detail page): refuses uncommitted changes;
            // optionally deletes the task branch after the worktree is gone.
            if (options.git === undefined) {
              const f = fail('invalid_input', 'git integration unavailable')
              json(res, f.res, 501)
              return
            }
            if (task.executions.some(e => e.outcome === 'running')) throw new Error('Error: invalid_input: 任务执行中，不能删除 worktree')
            const ws = workspaces.get(task.workspaceId)
            if (ws === undefined) throw new Error('Error: not_found: unknown workspace')
            const path = worktreePathOf(ws.path, id)
            try {
              await options.git.removeWorktree(ws.path, path)
            } catch (error) {
              throw new Error(`Error: invalid_input: ${error instanceof Error ? error.message : String(error)}`)
            }
            let branchDeleted = false
            let branchError: string | undefined
            if (body.deleteBranch === true && task.branch !== undefined) {
              try {
                await options.git.deleteBranch(ws.path, task.branch)
                branchDeleted = true
              } catch (error) {
                branchError = error instanceof Error ? error.message : String(error)
              }
            }
            json(res, { ok: true, value: { removed: true, branchDeleted, ...(branchError !== undefined ? { branchError } : {}) } })
            return
          }
          const f = fail('not_found', `unknown action ${action}`)
          json(res, f.res, f.status)
        } catch (error) {
          const f = toFail(error)
          json(res, f.res, f.status)
        }
        return
      }

      // -------------------------------------- POST /worktree-cleanup (⚙ 诊断)
      if (pathname === `${ROUTE_PREFIX}/worktree-cleanup`) {
        try {
          if (options.git === undefined) {
            const f = fail('invalid_input', 'git integration unavailable')
            json(res, f.res, 501)
            return
          }
          const workspaceId = str(body, 'workspaceId') ?? ''
          const taskId = str(body, 'taskId') ?? ''
          const ws = workspaces.get(workspaceId)
          if (ws === undefined) throw new Error('Error: not_found: unknown workspace')
          // Only dirs owned by NO ledger task may be cleaned here; live tasks
          // remove their worktree from the detail page.
          if (store.get(taskId) !== undefined) throw new Error('Error: invalid_input: 任务仍在看板中，请从任务详情页删除其 worktree')
          const path = worktreePathOf(ws.path, taskId)
          try {
            await options.git.removeWorktree(ws.path, path)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            // An unregistered leftover (git no longer knows this worktree):
            // fall back to direct fs removal — the dir lives inside the
            // plugin's own .dsh-worktrees scope.
            if (/not a working tree|not a working-tree/i.test(message)) {
              await rm(path, { recursive: true, force: true })
            } else {
              throw new Error(`Error: invalid_input: ${message}`)
            }
          }
          json(res, { ok: true, value: { cleaned: true, path } })
        } catch (error) {
          const f = toFail(error)
          json(res, f.res, f.status)
        }
        return
      }

      res.writeHead(404)
      res.end()
    } catch (error) {
      const f = fail('internal', error instanceof Error ? error.message : String(error))
      json(res, f.res, f.status)
    }
  }

  const sse = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    // Baseline frame: the client reconciles by revision and refetches state on gaps.
    res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.snapshot().revision })}\n\n`)
    subscribers.add(res)
    if (heartbeat === undefined) {
      heartbeat = setInterval(() => {
        for (const current of subscribers) current.write(': ping\n\n')
      }, HEARTBEAT_MS)
    }
    req.on('close', () => {
      subscribers.delete(res)
      if (subscribers.size === 0 && heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
    })
  }

  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    ctx.webServer.register({ kind: 'exact', path: SSE_PATH, handler: sse }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
    if (heartbeat !== undefined) clearInterval(heartbeat)
    for (const res of subscribers) res.end()
    subscribers.clear()
  }
}
