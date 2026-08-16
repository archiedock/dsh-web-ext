// Smoke: load the built host half in Node and run apply() against a fake
// cordis-like context — proves the full wiring (prompt section → nested
// dynamic injects [workspaceRegistry → agents → webServer] → tool register →
// routes → execution service → scheduler) executes against the REAL built
// artifacts. DSH_HOME is pointed at a temp dir so the smoke never touches the
// user's real ledger.
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = join(tmpdir(), 'taskboard-smoke')

const plugin = await import('../lib/index.js')
console.log('plugin name:', plugin.name)
console.log('plugin inject:', plugin.inject)

const sectionCalls = []
const registeredTools = []
const registeredRoutes = []
const eventSubscriptions = []
const disposers = []

/** Per-level service faces, keyed by the injected names. */
function servicesFor(names) {
  if (names.includes('workspaceRegistry')) {
    return {
      workspaceRegistry: {
        resolveByPath: async () => undefined,
        get: () => undefined,
        list: () => [],
      },
      tools: { register: tool => { registeredTools.push(tool.name); return () => {} } },
    }
  }
  if (names.includes('agents')) {
    return { agents: { create: async () => { throw new Error('smoke never executes tasks') } } }
  }
  if (names.includes('webServer')) {
    return { webServer: { register: route => { registeredRoutes.push(`${route.kind} ${route.path}`); return () => {} } } }
  }
  return {}
}

/** A cordis-ish fake context level with inject/on/get plumbing. */
function makeCtx(services) {
  return {
    ...services,
    effect: () => {},
    get: () => undefined,
    on: (name) => { eventSubscriptions.push(name); return () => {} },
    inject: (names, cb) => {
      console.log('dynamic inject requested:', names)
      const dispose = cb(makeCtx(servicesFor(names)))
      console.log('dynamic inject callback returned:', typeof dispose)
      disposers.push(() => dispose?.())
    },
  }
}

plugin.apply(makeCtx({
  systemPrompt: { section: spec => { sectionCalls.push(spec); return () => {} } },
}))

console.log('sections registered:', sectionCalls.map(s => `${s.name}@${s.order} (${s.text.length} chars)`))
console.log('tools registered:', registeredTools.join(', '))
console.log('routes registered:', registeredRoutes.join(' | '))
console.log('event subscriptions:', eventSubscriptions.join(', '))
if (sectionCalls.length !== 1) throw new Error('expected exactly one section')
if (registeredTools.length !== 8) throw new Error(`expected 8 tools, got ${registeredTools.length}`)
if (!registeredRoutes.some(r => r.includes('/dsh-taskboard'))) throw new Error('expected taskboard routes')
if (!eventSubscriptions.includes('session/event')) throw new Error('expected session/event subscription')

// Tear the whole plugin tree down (scheduler interval + catch-up included).
for (const dispose of disposers.reverse()) dispose()
try { rmSync(join(tmpdir(), 'taskboard-smoke'), { recursive: true, force: true }) } catch { }
console.log('SMOKE OK')
process.exit(0)
