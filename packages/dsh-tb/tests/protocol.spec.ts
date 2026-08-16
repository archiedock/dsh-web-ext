/**
 * P1 core tests: state machine, cron math, normalization, protocol-text
 * discipline sentences, ledger store, and the tool-level code gates
 * (done-gate, claim boundary, version conflict, model/execution read-only).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ALL_STATUSES,
  MAIN_STATUSES,
  canTransition,
  emptyLedger,
  isClaim,
  nextCronTime,
  normalizeExecution,
  parseCron,
  summarize,
  type TaskRecord,
} from '../src/shared/protocol.ts'
import { TASKBOARD_PROTOCOL } from '../src/host/protocol-text.ts'
import { PLUGIN_VERSION } from '../src/shared/version.ts'
import { TaskStore } from '../src/host/store.ts'
import { ERR, registerTaskboardTools, type ToolDeps, type WorkspaceFace } from '../src/host/tools.ts'

// ---------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------

describe('state machine', () => {
  it('allows the happy path backlog → done', () => {
    expect(canTransition('backlog', 'todo')).toBe(true)
    expect(canTransition('todo', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'in_review')).toBe(true)
    expect(canTransition('in_review', 'done')).toBe(true)
  })

  it('rejects skipping the review gate', () => {
    expect(canTransition('in_progress', 'done')).toBe(false)
    expect(canTransition('todo', 'done')).toBe(false)
    expect(canTransition('backlog', 'in_progress')).toBe(false)
  })

  it('cancels from any live state and archives terminal ones', () => {
    for (const from of ['backlog', 'todo', 'in_progress', 'in_review'] as const) {
      expect(canTransition(from, 'canceled')).toBe(true)
    }
    expect(canTransition('done', 'archived')).toBe(true)
    expect(canTransition('canceled', 'archived')).toBe(true)
    expect(canTransition('archived', 'todo')).toBe(false)
  })

  it('flags exactly todo→in_progress as the claim move', () => {
    expect(isClaim('todo', 'in_progress')).toBe(true)
    expect(isClaim('backlog', 'in_progress')).toBe(false)
    expect(isClaim('in_progress', 'in_review')).toBe(false)
  })

  it('covers every status in the column vocabulary', () => {
    expect(MAIN_STATUSES).toHaveLength(5)
    expect(ALL_STATUSES).toHaveLength(7)
  })
})

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

describe('cron', () => {
  it('parses *, */n, ranges, and lists', () => {
    expect(parseCron('* * * * *')).not.toBeNull()
    expect(parseCron('*/10 * * * *')).not.toBeNull()
    expect(parseCron('0 9-17 * * 1-5')).not.toBeNull()
    expect(parseCron('0 9 1,15 * *')).not.toBeNull()
    expect(parseCron('0 9 * * 7')).not.toBeNull() // 7 = Sunday, normalized
    expect(parseCron('61 * * * *')).toBeNull()
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('a * * * *')).toBeNull()
  })

  it('computes the next match for everyday schedules', () => {
    // 2026-08-14 10:30 local (arbitrary anchor; assertions in local time)
    const from = new Date(2026, 7, 14, 10, 30, 0).getTime()
    const hourly = nextCronTime(parseCron('0 * * * *')!, from)
    expect(new Date(hourly!).getMinutes()).toBe(0)
    expect(new Date(hourly!).getHours()).toBe(11)
    const daily9 = nextCronTime(parseCron('0 9 * * *')!, from)
    expect(new Date(daily9!).getDate()).toBe(15)
    expect(new Date(daily9!).getHours()).toBe(9)
    const every10 = nextCronTime(parseCron('*/10 * * * *')!, from)
    expect(new Date(every10!).getMinutes()).toBe(40)
  })

  it('normalizes execution configs', () => {
    expect(normalizeExecution({}, 0)).toEqual({ mode: 'claim' })
    expect(normalizeExecution({ mode: 'claim' }, 0)).toEqual({ mode: 'claim' })
    const scheduled = normalizeExecution({ mode: 'scheduled', cron: '*/10 * * * *' }, 0)
    expect(scheduled.mode).toBe('scheduled')
    expect(scheduled.nextRunAt).toBeGreaterThan(0)
    expect(() => normalizeExecution({ mode: 'scheduled' }, 0)).toThrow()
    expect(() => normalizeExecution({ mode: 'bogus' }, 0)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// version constant (UI badge drift guard)
// ---------------------------------------------------------------------------

describe('plugin version', () => {
  it('PLUGIN_VERSION equals package.json version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(PLUGIN_VERSION).toBe(pkg.version)
  })
})

// ---------------------------------------------------------------------------
// protocol text regression (dashi-style: lock the discipline sentences)
// ---------------------------------------------------------------------------

describe('protocol text', () => {
  it('locks the claim/retry/review/done-gate discipline', () => {
    expect(TASKBOARD_PROTOCOL).toMatch(/开工先查板/)
    expect(TASKBOARD_PROTOCOL).toMatch(/先读后动/)
    expect(TASKBOARD_PROTOCOL).toMatch(/先认领再干活/)
    expect(TASKBOARD_PROTOCOL).toMatch(/绝不循环重试或接管他人任务/)
    expect(TASKBOARD_PROTOCOL).toMatch(/版本冲突只重试一次/)
    expect(TASKBOARD_PROTOCOL).toMatch(/验收交接/)
    expect(TASKBOARD_PROTOCOL).toMatch(/你永远不能把任务移到 done/)
    expect(TASKBOARD_PROTOCOL).toMatch(/backlog=未授权/)
    expect(TASKBOARD_PROTOCOL).toMatch(/模型与定时只读/)
    expect(TASKBOARD_PROTOCOL).toMatch(/项目边界/)
  })
})

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

describe('TaskStore', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'taskboard-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('persists atomically and bumps the revision per mutation', async () => {
    const file = join(dir, 'ledger.json')
    const store = new TaskStore({ file })
    const events: number[] = []
    store.subscribe(c => events.push(c.revision))
    const task = makeTask('t-1')
    await store.mutate('task-created', ledger => {
      ledger.tasks.push(task)
      return [task]
    })
    await store.mutate('task-updated', ledger => {
      ledger.tasks[0]!.title = 'changed'
      return [ledger.tasks[0]!]
    })
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    expect(onDisk.revision).toBe(2)
    expect(onDisk.tasks[0].title).toBe('changed')
    expect(events).toEqual([1, 2])
    // reload from disk in a fresh store
    const second = new TaskStore({ file })
    await second.load()
    expect(second.get('t-1')?.title).toBe('changed')
    expect(second.snapshot().revision).toBe(2)
  })

  it('quarantines a corrupt ledger instead of throwing', async () => {
    const file = join(dir, 'corrupt.json')
    await writeFile(file, '{not json', 'utf8')
    const store = new TaskStore({ file })
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.snapshot()).toEqual(emptyLedger())
  })

  it('hands out frozen clones — mutations cannot bypass the revision', async () => {
    const file = join(dir, 'frozen.json')
    const store = new TaskStore({ file })
    await store.mutate('task-created', ledger => {
      ledger.tasks.push(makeTask('t-f'))
      return [ledger.tasks[0]!]
    })
    const snap = store.snapshot()
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.tasks[0])).toBe(true)
    expect(Object.isFrozen(store.get('t-f'))).toBe(true)
    // The sanctioned mutate path still works (it clones internally).
    await store.mutate('task-updated', ledger => {
      ledger.tasks[0]!.title = 'ok'
      return [ledger.tasks[0]!]
    })
    expect(store.get('t-f')!.title).toBe('ok')
  })

  it('prunes execution records to the retention cap on every mutation', async () => {
    const file = join(dir, 'prune.json')
    const store = new TaskStore({ file })
    await store.mutate('task-created', ledger => {
      const big = makeTask('t-big', {
        executions: Array.from({ length: 25 }, (_, i) => ({
          id: `e-${i}`,
          trigger: 'scheduled' as const,
          startedAt: i,
          endedAt: i + 1,
          outcome: 'succeeded' as const,
        })),
      })
      ledger.tasks.push(big)
      return [big]
    })
    const task = store.get('t-big')!
    expect(task.executions).toHaveLength(20)
    expect(task.executionsPruned).toBe(5)
    // The NEWEST records survive.
    expect(task.executions[0]!.id).toBe('e-5')
    expect(task.executions[19]!.id).toBe('e-24')
  })

  it('migrates legacy agent-held in_progress tasks to explicit claim fields', async () => {
    const file = join(dir, 'legacy.json')
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      revision: 5,
      tasks: [{
        id: 't-old',
        title: 'Legacy',
        description: '',
        prompt: '',
        workspaceId: 'ws-a',
        urgency: 'normal',
        status: 'in_progress',
        blocked: false,
        execution: { mode: 'claim' },
        version: 3,
        createdAt: 0,
        updatedAt: 42,
        createdBy: { kind: 'user' },
        updatedBy: { kind: 'agent', sessionId: 'sess-legacy' },
        comments: [],
        executions: [],
      }],
    }), 'utf8')
    const store = new TaskStore({ file })
    await store.load()
    const task = store.get('t-old')!
    expect(task.claimedBy).toBe('sess-legacy')
    expect(task.claimedAt).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// tools (code-level gates)
// ---------------------------------------------------------------------------

/** A task fixture. */
function makeTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    prompt: '',
    workspaceId: 'ws-a',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
    ...overrides,
  }
}

/** Fake workspace face: ws-a owns /proj/a, ws-b owns /proj/b. */
function fakeWorkspaces(): WorkspaceFace {
  const byPath = new Map([['/proj/a', 'ws-a'], ['/proj/b', 'ws-b']])
  const byId = new Map([['ws-a', { id: 'ws-a', path: '/proj/a', title: 'A' }], ['ws-b', { id: 'ws-b', path: '/proj/b', title: 'B' }]])
  return {
    resolveByPath: async path => ({ id: byPath.get(path)! }),
    get: id => byId.get(id),
    list: () => [...byId.values()],
  }
}

/** Build a registered tool set over a temp store; returns name → tool. */
async function toolSet(cwd: string): Promise<Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>> {
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-tools-'))
  const store = new TaskStore({ file: join(dir, 'ledger.json') })
  await store.mutate('task-created', ledger => {
    ledger.tasks.push(makeTask('t-1'), makeTask('t-2', { workspaceId: 'ws-b' }))
    return ledger.tasks
  })
  const deps: ToolDeps = { store, workspaces: fakeWorkspaces(), now: () => 1_000 }
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
  const ctx = {
    tools: {
      register(tool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  }
  registerTaskboardTools(ctx as never, deps)
  ;(tools as { __dir?: string }).__dir = dir
  return tools
}

/** The exec face for a calling agent session in cwd. */
const agentExec = (cwd: string) => ({ agent: { id: 'sess-1', session: { header: { cwd } } } })

describe('taskboard tools', () => {
  it('list returns compact summaries with filters', async () => {
    const tools = await toolSet('/proj/a')
    const result = await tools.get('taskboard_list')!.execute({ workspaceId: 'ws-a' }, agentExec('/proj/a'))
    const list = result as { tasks: ReturnType<typeof summarize>[] }
    expect(list.tasks).toHaveLength(1)
    expect(list.tasks[0]!.id).toBe('t-1')
  })

  it('rejects tool calls without an owning agent session', async () => {
    const tools = await toolSet('/proj/a')
    await expect(tools.get('taskboard_create')!.execute(
      { title: 'x', workspaceId: 'ws-a', urgency: 'normal' }, {},
    )).rejects.toThrow(ERR.requiresAgent)
  })

  it('create validates workspace/urgency/status', async () => {
    const tools = await toolSet('/proj/a')
    const exec = agentExec('/proj/a')
    await expect(tools.get('taskboard_create')!.execute(
      { title: 'x', workspaceId: 'nope', urgency: 'normal' }, exec,
    )).rejects.toThrow(ERR.notFound)
    await expect(tools.get('taskboard_create')!.execute(
      { title: 'x', workspaceId: 'ws-a', urgency: 'hot' }, exec,
    )).rejects.toThrow('invalid_input')
    const ok = await tools.get('taskboard_create')!.execute(
      { title: '  New task  ', workspaceId: 'ws-a', urgency: 'urgent' }, exec,
    ) as { task: { title: string; status: string } }
    expect(ok.task.title).toBe('New task')
    expect(ok.task.status).toBe('todo')
  })

  it('blocks the agent done-gate in code', async () => {
    const tools = await toolSet('/proj/a')
    // put t-1 into in_review first
    const move = tools.get('taskboard_move')!
    await move.execute({ id: 't-1', status: 'in_progress', ifVersion: 1 }, agentExec('/proj/a'))
    const after = await tools.get('taskboard_get')!.execute({ id: 't-1' }, agentExec('/proj/a')) as { task: { version: number } }
    await move.execute({ id: 't-1', status: 'in_review', ifVersion: after.task.version }, agentExec('/proj/a'))
    const review = await tools.get('taskboard_get')!.execute({ id: 't-1' }, agentExec('/proj/a')) as { task: { version: number } }
    await expect(move.execute({ id: 't-1', status: 'done', ifVersion: review.task.version }, agentExec('/proj/a')))
      .rejects.toThrow(ERR.forbidden)
  })

  it('enforces the claim project boundary', async () => {
    const tools = await toolSet('/proj/a')
    // t-2 belongs to ws-b; a session in /proj/a must NOT claim it
    await expect(tools.get('taskboard_move')!.execute(
      { id: 't-2', status: 'in_progress', ifVersion: 1 }, agentExec('/proj/a'),
    )).rejects.toThrow(ERR.workspaceMismatch)
    // the same task claims fine from inside its own project
    await expect(tools.get('taskboard_move')!.execute(
      { id: 't-2', status: 'in_progress', ifVersion: 1 }, agentExec('/proj/b'),
    )).resolves.toBeTruthy()
  })

  it('refuses taking over another session\'s claim', async () => {
    const tools = await toolSet('/proj/a')
    const move = tools.get('taskboard_move')!
    await move.execute({ id: 't-1', status: 'in_progress', ifVersion: 1 }, agentExec('/proj/a'))
    // t-1 now held by sess-1; a different session in the same project is rejected
    const other = { agent: { id: 'sess-2', session: { header: { cwd: '/proj/a' } } } }
    const current = await tools.get('taskboard_get')!.execute({ id: 't-1' }, agentExec('/proj/a')) as { task: { version: number } }
    await expect(move.execute({ id: 't-1', status: 'in_review', ifVersion: current.task.version }, other))
      .rejects.toThrow(ERR.forbidden)
  })

  it('rejects stale ifVersion writes (missing/stale alike)', async () => {
    const tools = await toolSet('/proj/a')
    // Missing ifVersion is caught by the parameter schema first (required).
    await expect(tools.get('taskboard_move')!.execute(
      { id: 't-1', status: 'in_progress' }, agentExec('/proj/a'),
    )).rejects.toThrow('invalid arguments')
    await expect(tools.get('taskboard_move')!.execute(
      { id: 't-1', status: 'in_progress', ifVersion: 99 }, agentExec('/proj/a'),
    )).rejects.toThrow(ERR.versionConflict)
  })

  it('rejects illegal transitions', async () => {
    const tools = await toolSet('/proj/a')
    await expect(tools.get('taskboard_move')!.execute(
      { id: 't-1', status: 'in_review', ifVersion: 1 }, agentExec('/proj/a'),
    )).rejects.toThrow(ERR.invalidTransition)
  })

  it('comment add/list round-trips with thread attribution', async () => {
    const tools = await toolSet('/proj/a')
    const added = await tools.get('taskboard_comment_add')!.execute(
      { id: 't-1', body: ' implemented; verified by tests ' }, agentExec('/proj/a'),
    ) as { comment: { body: string; threadId: string } }
    expect(added.comment.body).toBe('implemented; verified by tests')
    expect(added.comment.threadId).toBe('sess-1')
    const list = await tools.get('taskboard_comments')!.execute({ id: 't-1' }, agentExec('/proj/a')) as { comments: unknown[] }
    expect(list.comments).toHaveLength(1)
  })

  it('delete soft-marks and hides the task', async () => {
    const tools = await toolSet('/proj/a')
    await tools.get('taskboard_delete')!.execute({ id: 't-1', ifVersion: 1 }, agentExec('/proj/a'))
    await expect(tools.get('taskboard_get')!.execute({ id: 't-1' }, agentExec('/proj/a')))
      .rejects.toThrow(ERR.notFound)
    const list = await tools.get('taskboard_list')!.execute({}, agentExec('/proj/a')) as { tasks: unknown[] }
    expect(list.tasks).toHaveLength(1) // only t-2 remains visible
  })
})
