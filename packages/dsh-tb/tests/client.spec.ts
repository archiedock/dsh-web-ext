// @vitest-environment jsdom
/**
 * Client-half smoke: apply() against a fake client context with stubbed
 * fetch (route responses) — proves the whole client half (styles, sidebar
 * entry, board mount, controller, SSE wiring) starts and renders into a
 * jsdom document without throwing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Stub a route payload. */
function routeResponse(path: string): unknown {
  if (path === '/dsh-taskboard/state') {
    return { ok: true, value: { schemaVersion: 1, revision: 3, tasks: [] } }
  }
  if (path === '/dsh-taskboard/workspaces') {
    return { ok: true, value: [{ id: 'ws-a', path: '/proj/a', title: 'A', sessionCount: 0 }] }
  }
  throw new Error(`unexpected fetch ${path}`)
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const path = String(input)
  return new Response(JSON.stringify(routeResponse(path)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
})

class EventSourceMock {
  static instances: EventSourceMock[] = []
  onerror: (() => void) | null = null
  constructor(public url: string) { EventSourceMock.instances.push(this) }
  addEventListener(): void { /* frames not exercised here */ }
  close(): void { /* no-op */ }
}

describe('client half', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    for (const d of disposers.splice(0)) d()
    vi.unstubAllGlobals()
  })

  it('apply() mounts styles, waits for panes, and survives without panes', async () => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', EventSourceMock as unknown as typeof EventSource)
    const { apply } = await import('../src/client/index.ts')

    // REAL cordis effect semantics: callback runs immediately, its return
    // value is the disposer (this fake caught nothing when the plugin passed
    // a single-layer arrow that cordis executed as immediate teardown).
    const disposers: unknown[] = []
    const ctx = { get: () => undefined, effect: (fn: () => unknown) => { disposers.push(fn()) } }
    expect(() => apply(ctx as never)).not.toThrow()

    // Styles injected exactly once.
    expect(document.getElementById('dsh-taskboard-styles')).not.toBeNull()

    // No panes exist: mounts wait via observers without throwing. Give the
    // controller's initial refresh a tick.
    await new Promise(r => setTimeout(r, 10))
    expect(fetchMock).toHaveBeenCalled()

    // Nothing was torn down by the effect itself (the bug this guards: an
    // immediate teardown would have closed the SSE stream already).
    expect(EventSourceMock.instances.length).toBe(1)
    expect(EventSourceMock.instances[0]!.url).toBe('/dsh-taskboard/events')
    expect(disposers.every(d => typeof d === 'function')).toBe(true)

    // Explicit dispose through the captured disposers.
    for (const fn of disposers) (fn as () => void)()
  })

  it('sidebar entry places itself once a sidebar pane exists', async () => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', EventSourceMock as unknown as typeof EventSource)
    const { createClient } = await import('../src/client/api.ts')
    const { BoardController } = await import('../src/client/controller.ts')
    const { mountSidebarEntry } = await import('../src/client/sidebar-entry.ts')

    // Build the REAL shell shape (reverse-engineered from the live GUI):
    // sidebarCol pane > wrapper > root > [logoRow(brand aria button)] +
    // direct-child newSession BUTTON (the family plugins' fallback target).
    const column = document.createElement('div')
    column.className = 'pI_x6G_sidebarCol'
    column.dataset.pane = 'sidebar'
    const root = document.createElement('div')
    root.className = 'hHd-Xa_root'
    const row = document.createElement('div')
    row.className = 'hHd-Xa_logoRow'
    const brand = document.createElement('button')
    brand.className = 'hHd-Xa_brand hHd-Xa_wide'
    brand.setAttribute('aria-label', '新建会话')
    brand.innerHTML = '<svg></svg>'
    row.append(brand)
    const newSession = document.createElement('button')
    newSession.textContent = '新会话'
    root.append(row, newSession)
    const wrapper = document.createElement('div')
    wrapper.append(root)
    column.append(wrapper)
    document.body.append(column)

    const controller = new BoardController(createClient())
    const dispose = mountSidebarEntry(controller)
    disposers.push(dispose)

    await new Promise(r => setTimeout(r, 20))
    const entry = document.querySelector('[data-dsh-atb-entry]')
    expect(entry).not.toBeNull()
    // Entry is a direct child of the root, right after the newSession button
    // (the direct-child fallback anchor — same landing spot as the family
    // plugins: after the button block, before the workspace browser).
    expect(entry!.parentElement).toBe(root)
    expect(entry!.previousElementSibling).toBe(newSession)

    controller.toggleBoard()
    expect((entry as HTMLElement).dataset.active).toBe('true')
  })

  it('sidebar entry shows todo|in_progress|in_review counts with tooltip', async () => {
    localStorage.clear()
    const { BoardController } = await import('../src/client/controller.ts')
    const { mountSidebarEntry } = await import('../src/client/sidebar-entry.ts')

    const mkTask = (id: string, status: string) => ({
      id, title: id, description: '', prompt: '', workspaceId: 'ws-a',
      urgency: 'normal' as const, status: status as never, blocked: false,
      execution: { mode: 'claim' as const }, version: 1, createdAt: 0, updatedAt: 0,
      createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
      comments: [], executions: [],
    })
    const tasks = [
      mkTask('t-1', 'todo'), mkTask('t-2', 'todo'),
      mkTask('t-3', 'in_progress'),
      mkTask('t-4', 'in_review'), mkTask('t-5', 'in_review'), mkTask('t-6', 'in_review'),
      mkTask('t-7', 'done'),            // not counted
      mkTask('t-8', 'backlog'),         // not counted
    ]
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
      workspaces: async () => [],
      stream: () => () => {},
    }
    const controller = new BoardController(client as never)
    const dispose = mountSidebarEntry(controller)
    disposers.push(dispose)
    controller.start()
    // Initial mount renders 0|0|0; the refresh then rolls each slot to the
    // live counts. jsdom never fires transitionend, so the animation settles
    // through the 400ms fallback — wait past it before asserting final text.
    await new Promise(r => setTimeout(r, 460))

    const stats = document.querySelector<HTMLElement>('.dsh-atb-entry-stats')
    expect(stats).not.toBeNull()
    // Slots + separators render as "todo|in_progress|in_review".
    expect(stats!.textContent).toBe('2|1|3')
    // Each slot carries its status so the stylesheet colors the digits.
    const rolls = stats!.querySelectorAll<HTMLElement>('.dsh-atb-roll')
    expect(rolls.length).toBe(3)
    expect(rolls[0]!.dataset.stat).toBe('todo')
    expect(rolls[1]!.dataset.stat).toBe('in_progress')
    expect(rolls[2]!.dataset.stat).toBe('in_review')
    // The tooltip explains the meaning and carries the live numbers.
    expect(stats!.title).toContain('待办 2')
    expect(stats!.title).toContain('进行中 1')
    expect(stats!.title).toContain('待验收 3')
    controller.dispose()
    localStorage.clear()
  })

  it('board columns wear status dots before their labels', async () => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', EventSourceMock as unknown as typeof EventSource)
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskBoard } = await import('../src/client/board/TaskBoard.tsx')
    const { MAIN_STATUSES } = await import('../src/shared/protocol.ts')

    // One live task per lifecycle status; trashed takes precedence in the
    // secondary tab, so the trashed task's old status stays 'canceled'.
    const mkTask = (id: string, status: string, trashed = false) => ({
      id, title: id, description: '', prompt: '', workspaceId: 'ws-a',
      urgency: 'normal' as const, status: status as never, blocked: false,
      execution: { mode: 'claim' as const }, version: 1, createdAt: 0, updatedAt: 0,
      createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
      comments: [], executions: [],
      ...(trashed ? { trashedAt: 1 } : {}),
    })
    const tasks = [
      mkTask('t-1', 'backlog'), mkTask('t-2', 'todo'), mkTask('t-3', 'in_progress'),
      mkTask('t-4', 'in_review'), mkTask('t-5', 'done'),
      mkTask('t-6', 'canceled'), mkTask('t-7', 'archived'),
      mkTask('t-8', 'canceled', true),
    ]
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
      workspaces: async () => [],
      stream: () => () => {},
    }
    const controller = new BoardController(client as never)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskBoard, { controller }))
    controller.start()
    // Let the refresh land and React commit outside act().
    await new Promise(r => setTimeout(r, 20))

    // Main view: one column head per main status, each starting with its
    // status dot placed before the label text.
    const heads = () => Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-colhead'))
    expect(heads().length).toBe(MAIN_STATUSES.length)
    for (const head of heads()) {
      const dot = head.querySelector<HTMLElement>('.dsh-atb-dot')
      expect(dot).not.toBeNull()
      expect(head.firstChild).toBe(dot)
    }
    const dotStatuses = heads().map(h => h.querySelector<HTMLElement>('.dsh-atb-dot')!.dataset.status)
    expect(dotStatuses).toEqual([...MAIN_STATUSES])

    // Secondary tab: canceled / archived / trashed groups wear their dots too.
    controller.toggleSecondary()
    await new Promise(r => setTimeout(r, 20))
    for (const key of ['canceled', 'archived', 'trashed']) {
      const dot = host.querySelector<HTMLElement>(`.dsh-atb-colhead .dsh-atb-dot[data-status="${key}"]`)
      expect(dot, `secondary dot for ${key}`).not.toBeNull()
    }

    root.unmount()
    host.remove()
    controller.dispose()
  })

  it('in_review cards carry quick ✓/✗ actions; other columns do not', async () => {
    localStorage.clear()
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskBoard } = await import('../src/client/board/TaskBoard.tsx')

    const mkTask = (id: string, status: string) => ({
      id, title: id, description: '', prompt: '', workspaceId: 'ws-a',
      urgency: 'normal' as const, status: status as never, blocked: false,
      execution: { mode: 'claim' as const }, version: 1, createdAt: 0, updatedAt: 0,
      createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
      comments: [], executions: [],
    })
    const tasks = [mkTask('t-todo', 'todo'), mkTask('t-rev', 'in_review'), mkTask('t-done', 'done')]

    const calls: Array<{ op: string; id: string; body: unknown }> = []
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
      workspaces: async () => [],
      stream: () => () => {},
      move: async (id: string, body: unknown) => { calls.push({ op: 'move', id, body }); return { id } },
      reject: async (id: string, body: unknown) => { calls.push({ op: 'reject', id, body }); return { id } },
    }
    const controller = new BoardController(client as never)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskBoard, { controller }))
    controller.start()
    await new Promise(r => setTimeout(r, 20))

    // Quick actions exist ONLY on the in_review card.
    const acts = () => Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-quickbtn'))
    expect(acts().length).toBe(2)
    const card = (id: string) => Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-card'))
      .find(el => el.querySelector('.dsh-atb-card-title')!.textContent === id)!
    expect(card('t-todo').querySelector('.dsh-atb-quick')).toBeNull()
    expect(card('t-done').querySelector('.dsh-atb-quick')).toBeNull()
    const quick = card('t-rev').querySelector('.dsh-atb-quick')!
    expect(quick.querySelector<HTMLElement>('[data-act="done"]')).not.toBeNull()
    expect(quick.querySelector<HTMLElement>('[data-act="reject"]')).not.toBeNull()

    // ✓ completes: one move call, ifVersion from the snapshot, target done.
    const doneBtn = quick.querySelector<HTMLButtonElement>('[data-act="done"]')!
    doneBtn.click()
    await new Promise(r => setTimeout(r, 10))
    expect(calls).toEqual([{ op: 'move', id: 't-rev', body: { ifVersion: 1, status: 'done' } }])
    // The click must NOT also open the detail pane (stopPropagation on the row).
    expect(controller.getSnapshot().selectedId).toBeUndefined()

    // ✗ opens the inline note form; submit with text → reject carries the note.
    const rejectBtn = card('t-rev').querySelector<HTMLButtonElement>('[data-act="reject"]')!
    rejectBtn.click()
    await new Promise(r => setTimeout(r, 10))
    const input = card('t-rev').querySelector<HTMLInputElement>('.dsh-atb-quick-note')!
    expect(input).not.toBeNull()
    // jsdom + React 18 onChange: use the native setter then dispatch.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '按钮颜色不对')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 10))
    const confirmBtn = card('t-rev').querySelector<HTMLButtonElement>('[data-act="reject-confirm"]')!
    confirmBtn.click()
    await new Promise(r => setTimeout(r, 10))
    expect(calls[1]).toEqual({ op: 'reject', id: 't-rev', body: { ifVersion: 1, body: '按钮颜色不对' } })

    root.unmount()
    host.remove()
    controller.dispose()
    localStorage.clear()
  })

  it('controller.reject: empty note sends no body; failure surfaces the error', async () => {
    localStorage.clear()
    const { BoardController } = await import('../src/client/controller.ts')

    const tasks = [{
      id: 't-1', title: 'T', description: '', prompt: '', workspaceId: 'ws-a',
      urgency: 'normal' as const, status: 'in_review' as const, blocked: false,
      execution: { mode: 'claim' as const }, version: 4, createdAt: 0, updatedAt: 0,
      createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
      comments: [], executions: [],
    }]
    const bodies: unknown[] = []
    let failNext = false
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
      workspaces: async () => [],
      stream: () => () => {},
      reject: async (_id: string, body: unknown) => {
        if (failNext) throw new Error('taskboard: version_conflict: stale version 4 (current 5)')
        bodies.push(body)
        return { id: 't-1' }
      },
    }
    const controller = new BoardController(client as never)
    controller.start()
    await new Promise(r => setTimeout(r, 10))

    // Whitespace-only note → plain reject, no body field.
    expect(await controller.reject('t-1', 4, '   ')).toBe(true)
    expect(bodies).toEqual([{ ifVersion: 4 }])

    // Failure: reports false, error surface explains, nothing else thrown.
    failNext = true
    expect(await controller.reject('t-1', 4, 'x')).toBe(false)
    expect(controller.getSnapshot().error).toContain('version_conflict')

    controller.dispose()
    localStorage.clear()
  })

  it('isolation toggle: defaults on, remembers the choice, disables on non-git projects', async () => {
    localStorage.clear()
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController, loadDefaultIsolation } = await import('../src/client/controller.ts')
    const { TaskFormModal } = await import('../src/client/board/TaskFormModal.tsx')

    const creates: unknown[] = []
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks: [] }),
      // ws-git reports gitAvailable; ws-plain does not.
      workspaces: async () => [
        { id: 'ws-git', path: '/p/g', title: 'G', sessionCount: 0, gitAvailable: true },
        { id: 'ws-plain', path: '/p/n', title: 'N', sessionCount: 0, gitAvailable: false },
      ],
      stream: () => () => {},
      create: async (body: unknown) => { creates.push(body); return { id: 't-new' } },
    }
    const controller = new BoardController(client as never)
    controller.start()
    await new Promise(r => setTimeout(r, 10))

    // Create mode: default = worktree (on), remembered from localStorage.
    localStorage.setItem('dsh-taskboard-isolation-v1', 'none')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskFormModal, { controller }))
    await new Promise(r => setTimeout(r, 10))

    const opts = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-mode-opt'))
    expect(opts().length).toBeGreaterThanOrEqual(2)
    // The isolation pair is the second mode-picker in the modal.
    const isoPicker = Array.from(host.querySelectorAll<HTMLElement>('.dsh-atb-mode-picker'))[1]!
    const isoOpts = () => Array.from(isoPicker.querySelectorAll<HTMLButtonElement>('.dsh-atb-mode-opt'))
    expect(isoOpts()[0]!.dataset.on).toBe('false') // remembered 'none'
    expect(isoOpts()[1]!.dataset.on).toBe('true')

    // Switch to worktree, submit on the git workspace → isolation sent + persisted.
    isoOpts()[0]!.click()
    await new Promise(r => setTimeout(r, 10))
    const title = host.querySelector<HTMLInputElement>('input[maxlength="200"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(title, 'Iso task')
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 10))
    ;(Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-modal-footbtns .dsh-atb-btn')).find(b => b.textContent === '创建任务'))!.click()
    await new Promise(r => setTimeout(r, 10))
    expect(creates[0]).toMatchObject({ title: 'Iso task', isolation: 'worktree' })
    expect(loadDefaultIsolation()).toBe('worktree')

    // Non-git workspace: both options disabled, hint shown, isolation omitted.
    const wsSelect = host.querySelector<HTMLSelectElement>('select')!
    wsSelect.value = 'ws-plain'
    wsSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 10))
    expect(isoOpts().every(o => o.disabled)).toBe(true)
    expect(host.querySelector('.dsh-atb-isolation-note')?.textContent).toContain('非 git 仓库')
    ;(Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-modal-footbtns .dsh-atb-btn')).find(b => b.textContent === '创建任务'))!.click()
    await new Promise(r => setTimeout(r, 10))
    expect(creates[1]).toMatchObject({ workspaceId: 'ws-plain' })
    expect((creates[1] as Record<string, unknown>).isolation).toBeUndefined()

    root.unmount()
    host.remove()
    controller.dispose()
    localStorage.clear()
  })

  it('detail renders the isolation block; merge/remove call the controller', async () => {
    localStorage.clear()
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskDetail } = await import('../src/client/board/TaskDetail.tsx')

    const task = {
      id: 't-iso', title: 'Isolated work', description: '', prompt: '', workspaceId: 'ws-a',
      urgency: 'normal' as const, status: 'in_review' as const, blocked: false,
      execution: { mode: 'claim' as const }, version: 3, createdAt: 0, updatedAt: 0,
      createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
      branch: 'task/Isolated-work+t-iso',
      comments: [], executions: [{
        id: 'e-1', trigger: 'manual' as const, startedAt: 0, endedAt: 10, outcome: 'succeeded' as const,
        isolation: 'worktree' as const, branch: 'task/Isolated-work+t-iso',
        worktreePath: '/proj/a/.dsh-worktrees/t-iso', baseCommit: 'aaaa0000', headCommit: 'bbbb1111',
        commits: [{ hash: 'bbbb1111', subject: 'feat: the change' }],
        dirtyFiles: [' M src/a.ts'], diffStat: '1 file changed', changedFiles: 1,
      }],
    }
    const calls: Array<{ op: string; id: string; deleteBranch?: boolean }> = []
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks: [task] }),
      workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
      stream: () => () => {},
      mergeBranch: async (id: string) => { calls.push({ op: 'merge', id }); return { ok: true } },
      worktreeRemove: async (id: string, body: { deleteBranch?: boolean }) => { calls.push({ op: 'remove', id, deleteBranch: body.deleteBranch }); return { ok: true } },
    }
    const controller = new BoardController(client as never)
    controller.start()
    await new Promise(r => setTimeout(r, 10))

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskDetail, { task: task as never, controller, now: 1_000 }))
    await new Promise(r => setTimeout(r, 10))

    // The isolation block shows branch, commits, stats, and the dirty warning.
    const block = host.querySelector<HTMLElement>('.dsh-atb-fieldcard[data-kind="isolation"]')!
    expect(block).not.toBeNull()
    expect(block.textContent).toContain('task/Isolated-work+t-iso')
    expect(block.textContent).toContain('feat: the change')
    expect(block.textContent).toContain('1 处未提交修改')

    // ⇥ 合并: confirm flow reaches controller.mergeBranch.
    const mergeBtn = Array.from(block.querySelectorAll<HTMLButtonElement>('.dsh-atb-btn')).find(b => b.textContent!.includes('合并到主工作区'))!
    mergeBtn.click()
    await new Promise(r => setTimeout(r, 10))
    const confirmBtn = Array.from(block.querySelectorAll<HTMLButtonElement>('.dsh-atb-btn')).find(b => b.textContent === '确认合并')!
    confirmBtn.click()
    await new Promise(r => setTimeout(r, 10))
    expect(calls).toEqual([{ op: 'merge', id: 't-iso' }])

    // 🗑 删 worktree + 分支: confirm reaches controller.removeWorktree(true).
    const removeBtn = Array.from(block.querySelectorAll<HTMLButtonElement>('.dsh-atb-btn')).find(b => b.textContent!.includes('worktree + 分支'))!
    removeBtn.click()
    await new Promise(r => setTimeout(r, 10))
    const confirmRemove = Array.from(block.querySelectorAll<HTMLButtonElement>('.dsh-atb-btn')).find(b => b.textContent === '确认删除')!
    confirmRemove.click()
    await new Promise(r => setTimeout(r, 10))
    expect(calls[1]).toEqual({ op: 'remove', id: 't-iso', deleteBranch: true })

    root.unmount()
    host.remove()
    controller.dispose()
    localStorage.clear()
  })

  it('detail: 续跑 button only with a pinned branch; noop merge surfaces an info alert', async () => {
    localStorage.clear()
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskDetail } = await import('../src/client/board/TaskDetail.tsx')

    const mkTask = (branch?: string) => ({
      id: 't-r', title: 'R', description: '', prompt: '', workspaceId: 'ws-a',
      urgency: 'normal' as const, status: 'todo' as const, blocked: false,
      execution: { mode: 'claim' as const }, version: 1, createdAt: 0, updatedAt: 0,
      ...(branch !== undefined ? { branch } : {}),
      createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
      comments: [], executions: [],
    })

    const runCalls: Array<[string, boolean]> = []
    let noopNext = false
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks: [mkTask('task/R+t-r')] }),
      workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
      stream: () => () => {},
      run: async (id: string, body?: { reuse?: boolean }) => { runCalls.push([id, body?.reuse === true]); return { executionId: 'e', sessionId: 's' } },
      mergeBranch: async (id: string) => (noopNext
        ? { merged: false, noop: true, branch: 'task/R+t-r' }
        : { merged: true, branch: 'task/R+t-r' }),
    }
    const controller = new BoardController(client as never)
    controller.start()
    await new Promise(r => setTimeout(r, 10))

    // With a pinned branch: both 续跑 and 立即执行 appear; clicks carry reuse flag.
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskDetail, { task: mkTask('task/R+t-r') as never, controller, now: 1_000 }))
    await new Promise(r => setTimeout(r, 10))
    const btns = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-detail-topbtns .dsh-atb-detail-run'))
    const resume = btns().find(b => b.textContent!.includes('续跑'))!
    const fresh = btns().find(b => b.textContent!.includes('立即执行'))!
    resume.click()
    fresh.click()
    await new Promise(r => setTimeout(r, 10))
    expect(runCalls).toEqual([['t-r', true], ['t-r', false]])

    // Noop merge: an info alert renders (task needs an isolated execution so
    // the isolation block with the merge button shows).
    noopNext = true
    root.unmount()
    const root2 = createRoot(host)
    const task2 = { ...mkTask('task/R+t-r'), status: 'in_review', executions: [{
      id: 'e-1', trigger: 'manual' as const, startedAt: 0, endedAt: 1, outcome: 'succeeded' as const,
      isolation: 'worktree' as const, branch: 'task/R+t-r', worktreePath: '/p/a/.dsh-worktrees/t-r',
      baseCommit: 'a0', headCommit: 'b1', commits: [{ hash: 'b1', subject: 'x' }], commitsTotal: 1,
      dirtyFiles: [], dirtyFilesTotal: 0, changedFiles: 1,
    }] }
    root2.render(React.createElement(TaskDetail, { task: task2 as never, controller, now: 1_000 }))
    await new Promise(r => setTimeout(r, 10))
    const mergeBtn2 = Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-iso-actions .dsh-atb-btn')).find(b => b.textContent!.includes('合并到主工作区'))!
    mergeBtn2.click()
    await new Promise(r => setTimeout(r, 10))
    const confirmBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-btn')).find(b => b.textContent === '确认合并')!
    confirmBtn.click()
    await new Promise(r => setTimeout(r, 10))
    expect(host.textContent).toContain('没有领先主工作区的新提交')

    root2.unmount()
    host.remove()
    controller.dispose()
    localStorage.clear()
  })

  it('preset dropdown: pre-selects the deployment default on create, submits the choice', async () => {
    localStorage.clear()
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { BoardController } = await import('../src/client/controller.ts')
    const { TaskFormModal } = await import('../src/client/board/TaskFormModal.tsx')

    const creates: unknown[] = []
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks: [] }),
      workspaces: async () => [{ id: 'ws-a', path: '/p/a', title: 'A', sessionCount: 0 }],
      stream: () => () => {},
      create: async (body: unknown) => { creates.push(body); return { id: 't-new' } },
    }
    const controller = new BoardController(client as never)
    // presetCatalog face: 标准 is the deployment default, 梁神 also available.
    ;(controller as unknown as { presetCatalog?: () => Promise<unknown> }).presetCatalog = async () => ({
      presets: [{ id: 'standard', name: '标准模式' }, { id: 'liangshen', name: '梁神模式' }],
      defaultId: 'standard',
    })
    controller.start()
    await new Promise(r => setTimeout(r, 10))

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    root.render(React.createElement(TaskFormModal, { controller }))
    await new Promise(r => setTimeout(r, 30))

    // The preset select exists and pre-selects the deployment default.
    const presetSelect = Array.from(host.querySelectorAll<HTMLSelectElement>('select'))
      .find(s => Array.from(s.options).some(o => o.value === 'standard'))!
    expect(presetSelect).toBeTruthy()
    expect(presetSelect.value).toBe('standard')

    // Fill the title, submit → the default preset id rides along.
    const title = host.querySelector<HTMLInputElement>('input[maxlength="200"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(title, 'Preset task')
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 10))
    ;(Array.from(host.querySelectorAll<HTMLButtonElement>('.dsh-atb-modal-footbtns .dsh-atb-btn')).find(b => b.textContent === '创建任务'))!.click()
    await new Promise(r => setTimeout(r, 10))
    expect(creates[0]).toMatchObject({ title: 'Preset task', presetId: 'standard' })

    root.unmount()
    host.remove()
    controller.dispose()
    localStorage.clear()
  })

  it('session jump opens live sessions and guards deleted/archived ones', async () => {    const { BoardController } = await import('../src/client/controller.ts')
    const { createSessionJumper } = await import('../src/client/session-jump.ts')

    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks: [] }),
      workspaces: async () => [],
      stream: () => () => {},
    }
    const controller = new BoardController(client as never)
    controller.openBoard()

    // Fake runtime services: list mirror + archive set + staging open.
    let byId: Record<string, unknown> = { 's-live': {}, 's-arch': {} }
    let lagging = false // when true, refresh() reveals the late-listed session
    const opened: string[] = []
    let refreshed = 0
    const sessions = {
      open: (id: string) => { opened.push(id) },
      refresh: async () => {
        refreshed++
        if (lagging) byId = { ...byId, 's-late': {} }
      },
      list: { getSnapshot: () => ({ byId }) },
    }
    const workspaces = { list: { getSnapshot: () => ({ archivedSessionIds: ['s-arch'] }) } }

    // LAZY resolution: services absent at first (jump degrades), then present.
    let provided = false
    controller.installSessionJumper(createSessionJumper({
      getSessions: () => (provided ? sessions : undefined) as never,
      getWorkspaces: () => (provided ? workspaces : undefined) as never,
    }))
    expect(await controller.openSession('s-live')).toBe('unavailable')
    expect(controller.getSnapshot().boardOpen).toBe(true)
    provided = true

    // Listed + not archived: opens, and the board closes over the session.
    expect(await controller.openSession('s-live')).toBe('opened')
    expect(opened).toEqual(['s-live'])
    expect(controller.getSnapshot().boardOpen).toBe(false)

    // Archived: a definitive verdict — no refresh, never opened.
    controller.openBoard()
    expect(await controller.openSession('s-arch')).toBe('archived')
    expect(refreshed).toBe(0)
    expect(opened).toEqual(['s-live'])
    expect(controller.getSnapshot().boardOpen).toBe(true)

    // Deleted (absent from the list): one refresh re-check, still missing.
    expect(await controller.openSession('s-gone')).toBe('missing')
    expect(refreshed).toBe(1)
    expect(opened).toEqual(['s-live'])

    // Lagging mirror: the refresh reveals the session and the jump opens it.
    lagging = true
    expect(await controller.openSession('s-late')).toBe('opened')
    expect(refreshed).toBe(2)
    expect(opened).toEqual(['s-live', 's-late'])

    controller.dispose()
  })

  it('controller: search filter, urgency sort, and persisted view state', async () => {
    localStorage.clear()
    const { BoardController } = await import('../src/client/controller.ts')
    const { filterTasks } = await import('../src/client/board/TaskBoard.tsx')

    const mkTask = (id: string, title: string, urgency: 'urgent' | 'normal' | 'relaxed', updatedAt: number) => ({
      id, title, description: '', prompt: '', workspaceId: 'ws-a', urgency,
      status: 'todo' as const, blocked: false, execution: { mode: 'claim' as const },
      version: 1, createdAt: updatedAt - 10, updatedAt,
      createdBy: { kind: 'user' as const }, updatedBy: { kind: 'user' as const },
      comments: [], executions: [],
    })
    const tasks = [
      mkTask('t-slow', '巡检服务器', 'relaxed', 100),
      mkTask('t-fix', '修复登录 BUG', 'urgent', 50),
      mkTask('t-doc', '补文档', 'normal', 200),
    ]
    const client = {
      state: async () => ({ schemaVersion: 1, revision: 1, tasks }),
      workspaces: async () => [],
      stream: () => () => {},
    }
    const controller = new BoardController(client as never)
    controller.start()
    await new Promise(r => setTimeout(r, 10))

    // Search by title and by id (case-insensitive).
    let state = controller.getSnapshot()
    expect(filterTasks(state, tasks).map(t => t.id)).toEqual(['t-slow', 't-fix', 't-doc'])
    controller.setSearch('BUG')
    state = controller.getSnapshot()
    expect(filterTasks(state, tasks).map(t => t.id)).toEqual(['t-fix'])
    controller.setSearch('T-DOC')
    state = controller.getSnapshot()
    expect(filterTasks(state, tasks).map(t => t.id)).toEqual(['t-doc'])
    controller.setSearch('')

    // Sort by urgency (urgent → normal → relaxed), tie-break by updated desc.
    controller.setSortBy('urgency')
    state = controller.getSnapshot()
    expect(filterTasks(state, tasks).map(t => t.id)).toEqual(['t-fix', 't-doc', 't-slow'])
    // Sort by recent update.
    controller.setSortBy('updated')
    state = controller.getSnapshot()
    expect(filterTasks(state, tasks).map(t => t.id)).toEqual(['t-doc', 't-slow', 't-fix'])

    // Filters + sort persist to localStorage and hydrate a fresh controller.
    controller.setWorkspaceFilter('ws-a')
    const persisted = JSON.parse(localStorage.getItem('dsh-taskboard-view-v1')!) as { workspaceId?: string; sortBy?: string }
    expect(persisted.workspaceId).toBe('ws-a')
    expect(persisted.sortBy).toBe('updated')
    const second = new BoardController(client as never)
    expect(second.getSnapshot().sortBy).toBe('updated')
    expect(second.getSnapshot().filters.workspaceId).toBe('ws-a')
    // Search is transient — never persisted.
    expect(persisted).not.toHaveProperty('search')
    controller.dispose()
    second.dispose()
    localStorage.clear()
  })
})
