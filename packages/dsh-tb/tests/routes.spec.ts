/**
 * HTTP-level tests for the /dsh-taskboard routes: a real node:http server
 * wired to the real handler, driven with fetch — envelope shape, optimistic
 * versions, the user-only done move, purge semantics, and the SSE change
 * stream.
 */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerTaskboardRoutes } from '../src/host/routes.ts'
import { TaskStore } from '../src/host/store.ts'
import type { GitFace } from '../src/host/git.ts'
import type { WorkspaceFace } from '../src/host/tools.ts'

let server: Server
let base: string
let disposeRoutes: () => void
let store: InstanceType<typeof TaskStore>
let cancelCalls: string[]
let runCalls: Array<{ id: string; runOptions?: { reuseWorktree?: boolean } }>
let dir: string

// Mutable workspace list + mutable git behavior (0.3.0 tests swap these).
const wsList: Array<{ id: string; path: string; title: string }> = [
  { id: 'ws-a', path: '/proj/a', title: 'A' },
  { id: 'ws-b', path: '/proj/b', title: 'B' },
]
const workspaces: WorkspaceFace = {
  resolveByPath: async path => (path === '/proj/a' ? { id: 'ws-a' } : path === '/proj/b' ? { id: 'ws-b' } : undefined),
  get: id => wsList.find(w => w.id === id),
  list: () => wsList.slice(),
}

/** Swappable git behavior for the routes under test. */
const gitBehavior = {
  mergeError: undefined as string | undefined,
  removeError: undefined as undefined | ((path: string) => string | undefined),
  branchDeleteError: undefined as string | undefined,
  /** When true, isAncestor reports "branch already merged" (no-op merge). */
  noop: false,
  detect: async (_root: string) => false,
  merged: [] as Array<{ root: string; branch: string }>,
  removed: [] as string[],
  deletedBranches: [] as string[],
}
const gitFace: GitFace = {
  detect: root => gitBehavior.detect(root),
  binaryAvailable: async () => true,
  prepareWorktree: async () => undefined,
  collect: async () => ({ commits: [], commitsTotal: 0, dirtyFiles: [], dirtyFilesTotal: 0, changedFiles: 0 }),
  isAncestor: async () => gitBehavior.noop === true,
  merge: async (root, branch) => {
    gitBehavior.merged.push({ root, branch })
    if (gitBehavior.mergeError !== undefined) throw new Error(gitBehavior.mergeError)
  },
  removeWorktree: async (_root, path) => {
    gitBehavior.removed.push(path)
    const error = gitBehavior.removeError?.(path)
    if (error !== undefined) throw new Error(error)
  },
  deleteBranch: async (_root, branch) => {
    gitBehavior.deletedBranches.push(branch)
    if (gitBehavior.branchDeleteError !== undefined) throw new Error(gitBehavior.branchDeleteError)
  },
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tb-routes-'))
  server = createServer()
  store = new TaskStore({ file: join(dir, 'ledger.json') })
  cancelCalls = []
  runCalls = []
  const routes: Array<{ kind: string; path: string; handler: (req: never, res: never) => void }> = []
  const ctxFace = {
    webServer: {
      register: (route: { kind: string; path: string; handler: (req: never, res: never) => void }) => {
        routes.push(route)
        return () => {}
      },
    },
  }
  disposeRoutes = registerTaskboardRoutes(ctxFace as never, {
    store,
    workspaces,
    now: () => 5_000,
    run: async (id, runOptions) => { runCalls.push({ id, runOptions }); return { ok: true, executionId: 'e-x', sessionId: 's-x' } },
    cancel: async id => { cancelCalls.push(id); return { ok: true, executionId: 'e-x' } },
    modelProviders: () => ['prov-a'],
    git: gitFace,
  })
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    // Mirror the real webserver's longest-prefix-wins: exact routes shadow prefixes.
    const hit = routes.find(r => r.kind === 'exact' && url.pathname === r.path)
      ?? routes.find(r => r.kind === 'prefix' && url.pathname.startsWith(r.path))
    if (hit !== undefined) hit.handler(req as never, res as never)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  disposeRoutes()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

/** POST helper. */
async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

describe('taskboard routes', () => {
  it('serves an empty state baseline', async () => {
    const res = await fetch(`${base}/dsh-taskboard/state`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.value.tasks).toEqual([])
  })

  it('lists workspaces for the picker (with git availability)', async () => {
    const res = await fetch(`${base}/dsh-taskboard/workspaces`)
    const body = await res.json()
    expect(body.value).toEqual([
      { id: 'ws-a', path: '/proj/a', title: 'A', sessionCount: 0, gitAvailable: false },
      { id: 'ws-b', path: '/proj/b', title: 'B', sessionCount: 0, gitAvailable: false },
    ])
  })

  it('creates a task and rejects bad payloads', async () => {
    const ok = await post('/dsh-taskboard/tasks', { title: 'Route task', workspaceId: 'ws-a', urgency: 'urgent' })
    expect(ok.status).toBe(201)
    expect(ok.json.value.status).toBe('todo')
    expect(ok.json.value.urgency).toBe('urgent')
    const bad = await post('/dsh-taskboard/tasks', { title: '', workspaceId: 'ws-a', urgency: 'urgent' })
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('invalid_input')
    const unknownWs = await post('/dsh-taskboard/tasks', { title: 'x', workspaceId: 'nope', urgency: 'normal' })
    expect(unknownWs.status).toBe(404)
  })

  it('moves through the lifecycle; the USER may complete (done)', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Lifecycle', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    const claim = await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 1, status: 'in_progress' })
    expect(claim.json.value.status).toBe('in_progress')
    const review = await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 2, status: 'in_review' })
    expect(review.json.value.status).toBe('in_review')
    const done = await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 3, status: 'done' })
    expect(done.json.value.status).toBe('done')
  })

  it('rejects stale versions with 409', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Stale', workspaceId: 'ws-a', urgency: 'relaxed' })
    const id = created.json.value.id as string
    const stale = await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 99, status: 'in_progress' })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('version_conflict')
  })

  it('quick-reject: in_review → todo with optional note, atomically', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'QuickReject', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 1, status: 'in_progress' })
    await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 2, status: 'in_review' })

    // With a note: one call moves back AND appends the user comment.
    const withNote = await post(`/dsh-taskboard/tasks/${id}/reject`, { ifVersion: 3, body: '  样式不对，改下按钮颜色  ' })
    expect(withNote.status).toBe(200)
    expect(withNote.json.value.status).toBe('todo')
    const full1 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full1.value.version).toBe(4)
    expect(full1.value.comments.length).toBe(1)
    expect(full1.value.comments[0].body).toBe('样式不对，改下按钮颜色')

    // Without a note: plain move, no comment.
    const bare = await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 4, status: 'in_progress' })
    expect(bare.json.value.status).toBe('in_progress')
    await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 5, status: 'in_review' })
    const noNote = await post(`/dsh-taskboard/tasks/${id}/reject`, { ifVersion: 6, body: '   ' })
    expect(noNote.status).toBe(200)
    expect(noNote.json.value.status).toBe('todo')
    const full2 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full2.value.comments.length).toBe(1) // whitespace-only note → skipped

    // Stale version: the move fails and NO orphan comment appears.
    await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 7, status: 'in_progress' })
    await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 8, status: 'in_review' })
    const stale = await post(`/dsh-taskboard/tasks/${id}/reject`, { ifVersion: 99, body: 'should not land' })
    expect(stale.status).toBe(409)
    const full3 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full3.value.status).toBe('in_review')
    expect(full3.value.comments.length).toBe(1)

    // Illegal source (done → todo is not in the state machine): 400.
    await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: 9, status: 'done' })
    const illegal = await post(`/dsh-taskboard/tasks/${id}/reject`, { ifVersion: 10 })
    expect(illegal.status).toBe(400)
    expect(illegal.json.error.code).toBe('invalid_transition')
  })

  it('comments then soft-deletes then purges', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'CDP', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    const comment = await post(`/dsh-taskboard/tasks/${id}/comment`, { body: 'user note' })
    expect(comment.status).toBe(201)
    const soft = await post(`/dsh-taskboard/tasks/${id}/delete`, { ifVersion: 2 })
    expect(soft.json.value.trashed).toBe(true)
    const state = await (await fetch(`${base}/dsh-taskboard/state`)).json()
    const trashed = state.value.tasks.find((t: { id: string }) => t.id === id)
    expect(trashed.trashedAt).toBeGreaterThan(0)
    const purge = await post(`/dsh-taskboard/tasks/${id}/delete`, { purge: true })
    expect(purge.json.value.purged).toBe(true)
    const after = await (await fetch(`${base}/dsh-taskboard/state`)).json()
    expect(after.value.tasks.find((t: { id: string }) => t.id === id)).toBeUndefined()
  })

  it('updates fields including project rebind; unknown workspace 404', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Editable', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    const upd = await post(`/dsh-taskboard/tasks/${id}/update`, { ifVersion: 1, title: 'Edited', urgency: 'urgent', workspaceId: 'ws-b' })
    expect(upd.status).toBe(200)
    expect(upd.json.value.version).toBe(2)
    const full = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full.value.title).toBe('Edited')
    expect(full.value.urgency).toBe('urgent')
    expect(full.value.workspaceId).toBe('ws-b')
    const bad = await post(`/dsh-taskboard/tasks/${id}/update`, { ifVersion: 2, workspaceId: 'nope' })
    expect(bad.status).toBe(404)
  })

  it('keeps an agent claim alive across user edits; a user move releases it', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Held', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    // An agent claims it (tool semantics): explicit claimedBy fields.
    await store.mutate('task-moved', ledger => {
      const target = ledger.tasks.find(t => t.id === id)!
      target.status = 'in_progress'
      target.claimedBy = 'session-holder'
      target.claimedAt = 5_000
      target.version += 1
      target.updatedBy = { kind: 'agent', sessionId: 'session-holder' }
      return [target]
    })
    // The user edits the task in the GUI — the claim must survive (updatedBy
    // is audit-only; the pre-claim-field inference lost the holder here).
    const full1 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    const upd = await post(`/dsh-taskboard/tasks/${id}/update`, { ifVersion: full1.value.version, title: 'Held (edited)' })
    expect(upd.status).toBe(200)
    const full2 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full2.value.title).toBe('Held (edited)')
    expect(full2.value.claimedBy).toBe('session-holder')
    // A user move out of in_progress releases the hold.
    const back = await post(`/dsh-taskboard/tasks/${id}/move`, { ifVersion: full2.value.version, status: 'todo' })
    expect(back.json.value.status).toBe('todo')
    const full3 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full3.value.claimedBy).toBeUndefined()
  })

  it('rejects unknown model providers and malformed models with 400', async () => {
    const ghost = await post('/dsh-taskboard/tasks', { title: 'Model ghost', workspaceId: 'ws-a', urgency: 'normal', model: { provider: 'ghost', model: 'x' } })
    expect(ghost.status).toBe(400)
    expect(ghost.json.error.message).toContain('no registered route')
    const malformed = await post('/dsh-taskboard/tasks', { title: 'Model bad', workspaceId: 'ws-a', urgency: 'normal', model: { provider: 5 } })
    expect(malformed.status).toBe(400)
    const ok = await post('/dsh-taskboard/tasks', { title: 'Model ok', workspaceId: 'ws-a', urgency: 'normal', model: { provider: 'prov-a', model: 'm-1' } })
    expect(ok.status).toBe(201)
    // update path validates too
    const updBad = await post(`/dsh-taskboard/tasks/${ok.json.value.id}/update`, { ifVersion: 1, model: { provider: 'ghost', model: 'x' } })
    expect(updBad.status).toBe(400)
  })

  it('cancels a running execution via the cancel action', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Cancel me', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    const res = await post(`/dsh-taskboard/tasks/${id}/cancel`, {})
    expect(res.status).toBe(202)
    expect(res.json.value.cancelled).toBe(true)
    expect(cancelCalls).toContain(id)
  })

  it('streams SSE change events', async () => {
    const controller = new AbortController()
    const res = await fetch(`${base}/dsh-taskboard/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const createP = post('/dsh-taskboard/tasks', { title: 'SSE task', workspaceId: 'ws-a', urgency: 'urgent' })
    // read frames until a change event arrives
    let sawChange = false
    while (!sawChange) {
      const { value } = await reader.read()
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes('event: change')) sawChange = true
    }
    expect(sawChange).toBe(true)
    expect(buffer).toContain('SSE task')
    const created = await createP
    expect(created.status).toBe(201)
    controller.abort()
  })

  // ------------------------------------------------------------- 0.3.0 worktree
  it('create accepts isolation; update locks it once executions exist', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Iso task', workspaceId: 'ws-a', urgency: 'normal', isolation: 'none' })
    expect(created.status).toBe(201)
    expect(created.json.value.id).toBeTruthy()
    const id = created.json.value.id as string
    const full = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full.value.isolation).toBe('none')

    const badIso = await post('/dsh-taskboard/tasks', { title: 'Iso bad', workspaceId: 'ws-a', urgency: 'normal', isolation: 'docker' })
    expect(badIso.status).toBe(400)

    // Before any execution: switching is allowed.
    const switchOk = await post(`/dsh-taskboard/tasks/${id}/update`, { ifVersion: full.value.version, isolation: 'worktree' })
    expect(switchOk.status).toBe(200)
    const full2 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    expect(full2.value.isolation).toBe('worktree')

    // After an execution record exists: locked.
    await store.mutate('execution-recorded', ledger => {
      const target = ledger.tasks.find(t => t.id === id)!
      target.executions.push({ id: 'e-1', trigger: 'manual', startedAt: 5_000, outcome: 'succeeded', endedAt: 5_100 })
      target.version += 1
      return [target]
    })
    const full3 = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    const locked = await post(`/dsh-taskboard/tasks/${id}/update`, { ifVersion: full3.value.version, isolation: 'none' })
    expect(locked.status).toBe(400)
    expect(locked.json.error.message).toContain('已锁定')
  })

  it('presetId: create stores it (trimmed), update swaps it any time, null clears it', async () => {
    // Create with a preset; empty string = omitted.
    const a = await post('/dsh-taskboard/tasks', { title: 'Preset A', workspaceId: 'ws-a', urgency: 'normal', presetId: '  liangshen  ' })
    expect(a.status).toBe(201)
    const idA = a.json.value.id as string
    const fullA = await (await fetch(`${base}/dsh-taskboard/tasks/${idA}`)).json()
    expect(fullA.value.presetId).toBe('liangshen')

    const b = await post('/dsh-taskboard/tasks', { title: 'Preset B', workspaceId: 'ws-a', urgency: 'normal', presetId: '' })
    const idB = b.json.value.id as string
    const fullB = await (await fetch(`${base}/dsh-taskboard/tasks/${idB}`)).json()
    expect(fullB.value.presetId).toBeUndefined()

    // Update swaps the preset even AFTER executions exist (each run composes fresh).
    await store.mutate('execution-recorded', ledger => {
      const target = ledger.tasks.find(t => t.id === idA)!
      target.executions.push({ id: 'e-9', trigger: 'manual', startedAt: 5_000, outcome: 'succeeded', endedAt: 5_100 })
      target.version += 1
      return [target]
    })
    const fullA2 = await (await fetch(`${base}/dsh-taskboard/tasks/${idA}`)).json()
    const swapped = await post(`/dsh-taskboard/tasks/${idA}/update`, { ifVersion: fullA2.value.version, presetId: 'standard' })
    expect(swapped.status).toBe(200)
    const fullA3 = await (await fetch(`${base}/dsh-taskboard/tasks/${idA}`)).json()
    expect(fullA3.value.presetId).toBe('standard')

    // null clears it back to "follow the deployment default".
    const cleared = await post(`/dsh-taskboard/tasks/${idA}/update`, { ifVersion: fullA3.value.version, presetId: null })
    expect(cleared.status).toBe(200)
    const fullA4 = await (await fetch(`${base}/dsh-taskboard/tasks/${idA}`)).json()
    expect(fullA4.value.presetId).toBeUndefined()
  })

  it('merge: needs a branch; merges --no-ff and leaves a system comment; git failures map to 400', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Merge me', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string

    // No branch yet → 400.
    const noBranch = await post(`/dsh-taskboard/tasks/${id}/merge`, {})
    expect(noBranch.status).toBe(400)
    expect(noBranch.json.error.message).toContain('worktree 分支')

    // Give the task a pinned branch (as a successful isolated run would).
    await store.mutate('task-updated', ledger => {
      const target = ledger.tasks.find(t => t.id === id)!
      target.branch = 'task/Merge-me+t-x'
      target.version += 1
      return [target]
    })

    gitBehavior.mergeError = '主工作区有 3 处未提交修改，请先提交或暂存后再合并'
    const dirty = await post(`/dsh-taskboard/tasks/${id}/merge`, {})
    expect(dirty.status).toBe(400)
    expect(dirty.json.error.message).toContain('未提交修改')

    gitBehavior.mergeError = undefined
    gitBehavior.merged = []
    const okMerge = await post(`/dsh-taskboard/tasks/${id}/merge`, {})
    expect(okMerge.status).toBe(200)
    expect(okMerge.json.value).toEqual({ merged: true, branch: 'task/Merge-me+t-x' })
    expect(gitBehavior.merged).toEqual([{ root: '/proj/a', branch: 'task/Merge-me+t-x' }])

    // A system comment landed on the task.
    const full = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
    const mergeComment = (full.value.comments as Array<{ body: string }>).find(c => c.body.includes('已合并到主工作区'))
    expect(mergeComment).toBeTruthy()
  })

  it('worktree-remove: refuses dirty worktrees with 400; deleteBranch failures surface as branchError', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Clean me', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    await store.mutate('task-updated', ledger => {
      const target = ledger.tasks.find(t => t.id === id)!
      target.branch = 'task/Clean-me+t-y'
      return [target]
    })

    gitBehavior.removeError = () => 'worktree 有 2 处未提交修改，拒绝删除：\n M a\n M b'
    const dirty = await post(`/dsh-taskboard/tasks/${id}/worktree-remove`, {})
    expect(dirty.status).toBe(400)
    expect(dirty.json.error.message).toContain('未提交修改')

    gitBehavior.removeError = undefined
    gitBehavior.removed = []
    gitBehavior.branchDeleteError = "error: Cannot delete branch 'task/Clean-me+t-y' checked out at '/x'"
    const res = await post(`/dsh-taskboard/tasks/${id}/worktree-remove`, { deleteBranch: true })
    expect(res.status).toBe(200)
    expect(res.json.value.removed).toBe(true)
    expect(res.json.value.branchDeleted).toBe(false)
    expect(res.json.value.branchError).toContain('checked out')
    expect(gitBehavior.removed).toEqual([`/proj/a/.dsh-worktrees/${id}`])

    gitBehavior.branchDeleteError = undefined
    const res2 = await post(`/dsh-taskboard/tasks/${id}/worktree-remove`, { deleteBranch: true })
    expect(res2.json.value.branchDeleted).toBe(true)
  })

  it('diagnostics lists orphan worktrees and cleanup removes them (fs fallback)', async () => {
    // A real directory on disk owned by NO ledger task = orphan.
    const ghostPath = join(dir, '.dsh-worktrees', 't-ghost')
    await mkdir(ghostPath, { recursive: true })
    wsList.push({ id: 'ws-tmp', path: dir, title: 'TMP' })
    try {
      let diag = await (await fetch(`${base}/dsh-taskboard/diagnostics`)).json()
      const orphan = diag.value.orphanWorktrees.find((o: { taskId: string }) => o.taskId === 't-ghost')
      expect(orphan).toEqual({ workspaceId: 'ws-tmp', workspacePath: dir, taskId: 't-ghost', path: ghostPath.replaceAll('\\', '/') })

      // Cleanup with git reporting "not a working tree" → fs fallback.
      gitBehavior.removeError = () => 'fatal: not a working tree: ' + ghostPath
      const clean = await post('/dsh-taskboard/worktree-cleanup', { workspaceId: 'ws-tmp', taskId: 't-ghost' })
      expect(clean.status).toBe(200)
      expect(clean.json.value.cleaned).toBe(true)

      diag = await (await fetch(`${base}/dsh-taskboard/diagnostics`)).json()
      expect(diag.value.orphanWorktrees.find((o: { taskId: string }) => o.taskId === 't-ghost')).toBeUndefined()

      // Cleanup refuses a task that still exists in the ledger.
      const created = await post('/dsh-taskboard/tasks', { title: 'Live', workspaceId: 'ws-a', urgency: 'normal' })
      const liveId = created.json.value.id as string
      const refuse = await post('/dsh-taskboard/worktree-cleanup', { workspaceId: 'ws-tmp', taskId: liveId })
      expect(refuse.status).toBe(400)
      expect(refuse.json.error.message).toContain('详情页')

      // gitignore suggestions: a git-enabled dir without .gitignore is
      // suggested; once the entry exists it disappears from the list.
      const gitDir = join(dir, 'gi-probe')
      await mkdir(gitDir, { recursive: true })
      wsList.push({ id: 'ws-gi', path: gitDir, title: 'GI' })
      const prevDetect = gitBehavior.detect
      gitBehavior.detect = async (root: string) => root.replaceAll('\\', '/') === gitDir.replaceAll('\\', '/')
      try {
        let diag2 = await (await fetch(`${base}/dsh-taskboard/diagnostics`)).json()
        expect(diag2.value.gitIgnoreSuggestions).toEqual([{ workspaceId: 'ws-gi', workspacePath: gitDir }])

        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(gitDir, '.gitignore'), 'node_modules\n.dsh-worktrees/\n', 'utf8')
        diag2 = await (await fetch(`${base}/dsh-taskboard/diagnostics`)).json()
        expect(diag2.value.gitIgnoreSuggestions.find((s: { workspaceId: string }) => s.workspaceId === 'ws-gi')).toBeUndefined()
      } finally {
        gitBehavior.detect = prevDetect
        wsList.splice(wsList.findIndex(w => w.id === 'ws-gi'), 1)
      }
    } finally {
      wsList.splice(wsList.findIndex(w => w.id === 'ws-tmp'), 1)
      gitBehavior.removeError = undefined
    }
  })

  it('run action passes reuse through to the execution service (续跑)', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Reuse me', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string

    const plain = await post(`/dsh-taskboard/tasks/${id}/run`, {})
    expect(plain.status).toBe(202)
    expect(runCalls.at(-1)).toEqual({ id, runOptions: undefined })

    const reuse = await post(`/dsh-taskboard/tasks/${id}/run`, { reuse: true })
    expect(reuse.status).toBe(202)
    expect(runCalls.at(-1)).toEqual({ id, runOptions: { reuseWorktree: true } })
  })

  it('merge: a branch with no new commits is a no-op (no merge, no comment)', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Noop merge', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    await store.mutate('task-updated', ledger => {
      const target = ledger.tasks.find(t => t.id === id)!
      target.branch = 'task/Noop-merge+t-n'
      return [target]
    })

    gitBehavior.noop = true
    try {
      const res = await post(`/dsh-taskboard/tasks/${id}/merge`, {})
      expect(res.status).toBe(200)
      expect(res.json.value).toEqual({ merged: false, noop: true, branch: 'task/Noop-merge+t-n' })
      // No git merge ran and no 已合并 comment landed.
      expect(gitBehavior.merged.filter(m => m.branch === 'task/Noop-merge+t-n')).toEqual([])
      const full = await (await fetch(`${base}/dsh-taskboard/tasks/${id}`)).json()
      expect((full.value.comments as Array<{ body: string }>).some(c => c.body.includes('已合并'))).toBe(false)
    } finally {
      gitBehavior.noop = false
    }
  })

  it('purge refuses uncommitted worktree changes, then cleans worktree + branch on success', async () => {
    const created = await post('/dsh-taskboard/tasks', { title: 'Purge me', workspaceId: 'ws-a', urgency: 'normal' })
    const id = created.json.value.id as string
    await store.mutate('task-updated', ledger => {
      const target = ledger.tasks.find(t => t.id === id)!
      target.branch = 'task/Purge-me+t-p'
      return [target]
    })
    // Soft-delete first (purge requires trashed).
    await post(`/dsh-taskboard/tasks/${id}/delete`, { ifVersion: 1 })

    // Dirty worktree → purge refused with the file list; ledger entry stays.
    gitBehavior.removeError = path => path.endsWith(id) ? 'worktree 有 1 处未提交修改，拒绝删除：\n M keep.ts' : undefined
    const dirty = await post(`/dsh-taskboard/tasks/${id}/delete`, { purge: true })
    expect(dirty.status).toBe(400)
    expect(dirty.json.error.message).toContain('未提交修改')
    expect(store.get(id)).toBeDefined()

    // Clean → worktree removed, branch deleted, ledger entry gone.
    gitBehavior.removeError = undefined
    gitBehavior.removed = []
    gitBehavior.deletedBranches = []
    const ok = await post(`/dsh-taskboard/tasks/${id}/delete`, { purge: true })
    expect(ok.status).toBe(200)
    expect(ok.json.value.purged).toBe(true)
    expect(gitBehavior.removed).toEqual([`/proj/a/.dsh-worktrees/${id}`])
    expect(gitBehavior.deletedBranches).toEqual(['task/Purge-me+t-p'])
    expect(store.get(id)).toBeUndefined()
  })
})
