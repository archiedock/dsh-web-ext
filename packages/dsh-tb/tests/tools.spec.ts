/**
 * Tool-layer tests: outputs must be lossless JSON (no undefined-valued own
 * properties) — the agent loop's output validation rejects undefined values
 * even though JSON.stringify would silently drop them (a real E2E bug:
 * `value is not lossless JSON` on taskboard_move/list).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerTaskboardTools, type WorkspaceFace } from '../src/host/tools.ts'
import { TaskStore } from '../src/host/store.ts'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-tools-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const workspaces: WorkspaceFace = {
  resolveByPath: async path => (path === '/proj/a' ? { id: 'ws-a' } : undefined),
  get: id => (id === 'ws-a' ? { id: 'ws-a', path: '/proj/a', title: 'A' } : undefined),
  list: () => [{ id: 'ws-a', path: '/proj/a', title: 'A' }],
}

/** Reject undefined-valued own properties anywhere in a tool output. */
function assertLossless(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertLossless(item, `${path}[${i}]`))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) throw new Error(`undefined value at ${path}.${key}`)
    assertLossless(child, `${path}.${key}`)
  }
}

/** Build the tool set and a fake agent exec context. */
async function setup(deps: { modelProviders?: () => string[] | undefined } = {}) {
  const store = new TaskStore({ file: join(dir, `led-${Math.random().toString(36).slice(2)}.json`) })
  const registered: Array<Record<string, unknown>> = []
  const disposers = registerTaskboardTools(
    { tools: { register: tool => { registered.push(tool); return () => {} } } },
    { store, workspaces, now: () => 7_000, ...deps },
  )
  const tool = (name: string): {
    execute(args: unknown, exec: unknown): Promise<unknown>
    output: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
  } =>
    registered.find(t => t.name === name) as never
  const exec = { agent: { id: 'session-1', session: { header: { cwd: '/proj/a' } } } }
  return { store, disposers, tool, exec }
}

describe('taskboard tool outputs', () => {
  it('renders carry the model-facing facts (id + version) — not one-line summaries', async () => {
    // Regression: the registry feeds output.render() to the MODEL (result.content);
    // a terse render starves the agent (it had to guess versions from error text).
    const { disposers, tool, exec } = await setup()
    const created = await tool('taskboard_create').execute(
      { title: 'Render contract', workspaceId: 'ws-a', urgency: 'urgent', description: 'd1', prompt: 'p1' }, exec,
    )
    const id = (created as { task: { id: string } }).task.id

    // get: full detail — id, version, prompt, comment stream all present.
    const got = await tool('taskboard_get').execute({ id }, exec)
    const gotText = tool('taskboard_get').output.render({ id }, got)[0]!.text
    expect(gotText).toContain(id)
    expect(gotText).toMatch(/v\d+/)
    expect(gotText).toContain('p1')
    expect(gotText).toContain('执行 Prompt')

    // list: per-task lines with id + version.
    const listed = await tool('taskboard_list').execute({}, exec)
    const listText = tool('taskboard_list').output.render({}, listed)[0]!.text
    expect(listText).toContain(id)
    expect(listText).toMatch(/v\d+/)

    // claim first (in-project session), then the real-world chain:
    // comment bumps the version AND echoes it → move chains without re-read.
    await tool('taskboard_move').execute({ id, status: 'in_progress', ifVersion: 1 }, exec)
    const commented = await tool('taskboard_comment_add').execute({ id, body: '交接评论' }, exec)
    const commentText = tool('taskboard_comment_add').output.render({}, commented)[0]!.text
    expect(commentText).toContain('v3') // create v1 → claim v2 → comment v3, echoed
    expect(commentText).toContain(id)

    const moved = await tool('taskboard_move').execute({ id, status: 'in_review', ifVersion: 3 }, exec)
    const movedText = tool('taskboard_move').output.render({}, moved)[0]!.text
    expect(movedText).toContain(id)
    expect(movedText).toContain('v4')
    for (const dispose of disposers) dispose()
  })

  it('every tool returns lossless JSON (no undefined-valued fields)', async () => {
    const { disposers, tool, exec } = await setup()

    const created = await tool('taskboard_create').execute(
      { title: 'Lossless', workspaceId: 'ws-a', urgency: 'normal', description: 'd' }, exec,
    )
    assertLossless(created)
    const id = (created as { task: { id: string } }).task.id

    // list over a task with NO executions/comments (summarize's sparse fields).
    assertLossless(await tool('taskboard_list').execute({}, exec))
    assertLossless(await tool('taskboard_list').execute({ status: 'todo' }, exec))
    assertLossless(await tool('taskboard_get').execute({ id }, exec))
    assertLossless(await tool('taskboard_comments').execute({ id }, exec))

    // comment + move: outputs after sparse-field mutations.
    assertLossless(await tool('taskboard_comment_add').execute({ id, body: 'b' }, exec))
    const read = await tool('taskboard_get').execute({ id }, exec)
    const version = (read as { task: { version: number } }).task.version
    assertLossless(await tool('taskboard_update').execute({ id, ifVersion: version, blocked: true }, exec))
    const reread = await tool('taskboard_get').execute({ id }, exec)
    const version2 = (reread as { task: { version: number } }).task.version
    assertLossless(await tool('taskboard_move').execute({ id, status: 'in_progress', ifVersion: version2 }, exec))
    assertLossless(await tool('taskboard_delete').execute({ id, ifVersion: version2 + 1 }, exec))

    for (const dispose of disposers) dispose()
  })

  it('rejects a cross-project claim with workspace_mismatch', async () => {
    const { disposers, tool, exec } = await setup()
    const created = await tool('taskboard_create').execute(
      { title: 'Claim guard', workspaceId: 'ws-a', urgency: 'normal' }, exec,
    )
    const id = (created as { task: { id: string } }).task.id
    const outsider = { agent: { id: 'session-2', session: { header: { cwd: 'C:/elsewhere' } } } }
    await expect(tool('taskboard_move').execute({ id, status: 'in_progress', ifVersion: 1 }, outsider))
      .rejects.toThrow(/workspace_mismatch/)
    for (const dispose of disposers) dispose()
  })

  it('rejects the done move for agents and in-project claims succeed', async () => {
    const { disposers, tool, exec } = await setup()
    const created = await tool('taskboard_create').execute(
      { title: 'Done gate', workspaceId: 'ws-a', urgency: 'normal' }, exec,
    )
    const id = (created as { task: { id: string } }).task.id
    await expect(tool('taskboard_move').execute({ id, status: 'done', ifVersion: 1 }, exec))
      .rejects.toThrow(/forbidden/)
    const moved = await tool('taskboard_move').execute({ id, status: 'in_progress', ifVersion: 1 }, exec)
    expect((moved as { task: { status: string } }).task.status).toBe('in_progress')
    for (const dispose of disposers) dispose()
  })

  it('tracks the claim explicitly: claim records the holder; handoff releases it', async () => {
    const { disposers, tool, exec } = await setup()
    const created = await tool('taskboard_create').execute(
      { title: 'Claim life', workspaceId: 'ws-a', urgency: 'normal' }, exec,
    )
    const id = (created as { task: { id: string } }).task.id
    await tool('taskboard_move').execute({ id, status: 'in_progress', ifVersion: 1 }, exec)
    let got = await tool('taskboard_get').execute({ id }, exec) as { task: { claimedBy?: string; version: number } }
    expect(got.task.claimedBy).toBe('session-1')

    // The holding session itself may hand off — and the move releases the hold.
    const moved = await tool('taskboard_move').execute({ id, status: 'in_review', ifVersion: got.task.version }, exec)
    expect((moved as { task: { status: string } }).task.status).toBe('in_review')
    got = await tool('taskboard_get').execute({ id }, exec) as { task: { claimedBy?: string; version: number } }
    expect(got.task.claimedBy).toBeUndefined()
    for (const dispose of disposers) dispose()
  })

  it('validates pinned models structurally and against registered providers', async () => {
    const { disposers, tool, exec } = await setup({ modelProviders: () => ['deepseek', 'openai'] })
    // malformed: missing model id
    await expect(tool('taskboard_create').execute(
      { title: 'M1', workspaceId: 'ws-a', urgency: 'normal', model: { provider: 'deepseek' } }, exec,
    )).rejects.toThrow('invalid_input')
    // well-formed but the provider has no registered route
    await expect(tool('taskboard_create').execute(
      { title: 'M2', workspaceId: 'ws-a', urgency: 'normal', model: { provider: 'ghost', model: 'x' } }, exec,
    )).rejects.toThrow('no registered route')
    // registered provider passes and is trimmed
    const ok = await tool('taskboard_create').execute(
      { title: 'M3', workspaceId: 'ws-a', urgency: 'normal', model: { provider: ' deepseek ', model: ' reasoner ' } }, exec,
    ) as { task: { model?: { provider: string; model: string } } }
    expect(ok.task.model).toEqual({ provider: 'deepseek', model: 'reasoner' })
    for (const dispose of disposers) dispose()
  })
})
