/**
 * Host git face (0.3.0): the ONLY place dsh-taskboard shells out to git.
 * 0.3.1: per-repo serialization of structural operations, binary probing,
 * no-op merge detection, worktree REUSE mode, and evidence size caps.
 *
 * Design invariants (plan §3.4/§3.5):
 * - NARROW interface: detect / binaryAvailable / prepareWorktree / collect /
 *   merge / isAncestor / removeWorktree / deleteBranch — nothing else leaks
 *   into the plugin.
 * - FAIL-SOFT: every call has a timeout and resolves to a benign result
 *   (false / undefined / empty facts) on ANY git failure — a missing git,
 *   a locked worktree, or a damaged repo degrades execution to the original
 *   directory and NEVER fails the ledger or the run pipeline. Only the
 *   explicit user actions (merge / remove / deleteBranch) throw, with a
 *   readable message the GUI surfaces as-is.
 * - SERIALIZED structural ops: concurrent isolated executions on the SAME
 *   repository would race on git's index/worktree locks, so every structural
 *   operation (prepareWorktree / merge / removeWorktree / deleteBranch) runs
 *   inside a per-root in-process mutex. Read-only collects stay concurrent.
 * - INJECTABLE runner: the exec layer is a single function so unit tests
 *   script every path without a real git.
 *
 * @module dsh-taskboard/host/git
 */
import type { CommitInfo } from '../shared/protocol.ts'

/** Timeout for quick read-only queries (rev-parse / status / log / diff). */
const QUICK_TIMEOUT_MS = 2_000

/** Timeout for structural operations (worktree add/remove, merge, branch). */
const HEAVY_TIMEOUT_MS = 15_000

/** Directory under a workspace where task worktrees live. */
export const WORKTREE_DIR = '.dsh-worktrees'

/** Evidence caps: commits kept per execution record (newest first). */
export const MAX_COMMIT_EVIDENCE = 50

/** Evidence caps: uncommitted-change lines kept per execution record. */
export const MAX_DIRTY_EVIDENCE = 100

/** Result of one underlying exec: `ok` is exit-0, output never null. */
export interface ExecResult { ok: boolean; stdout: string; stderr: string }

/** The injectable exec layer: run `git <args>` under a cwd with a timeout. */
export type ExecFn = (args: string[], options: { cwd?: string; timeout?: number }) => Promise<ExecResult>

/** Facts needed to open an isolated execution. */
export interface WorktreeInfo {
  /** Absolute worktree path (the session's cwd). */
  path: string
  /** The task branch checked out there. */
  branch: string
  /** Baseline for evidence collection: main HEAD (fresh) or worktree HEAD (reuse). */
  baseCommit: string
  /** True when an existing live worktree was kept as-is (续跑). */
  reused?: boolean
}

/** Settlement facts collected from a worktree (partial on best-effort basis). */
export interface SettlementFacts {
  headCommit?: string
  commits: CommitInfo[]
  /** Total commits before capping (equals commits.length when under the cap). */
  commitsTotal: number
  dirtyFiles: string[]
  /** Total uncommitted lines before capping. */
  dirtyFilesTotal: number
  diffStat?: string
  changedFiles: number
}

/** The narrow git face the rest of the plugin depends on. */
export interface GitFace {
  /** Whether `root` sits inside a usable git work tree (fail-soft → false). */
  detect(root: string): Promise<boolean>
  /** Whether a usable git binary answers at all (distinguishes 未装 git vs 非 git 仓库). */
  binaryAvailable(): Promise<boolean>
  /**
   * Ensure a worktree at `path` on `branch`. Default mode `'fresh'` resets to
   * the main worktree's current HEAD (每次全新); mode `'reuse'` keeps a live
   * worktree exactly as-is (续跑 — agent's commits and uncommitted changes
   * survive) and falls back to a fresh creation when none is alive. Resolves
   * undefined on any failure — callers degrade to the original directory.
   */
  prepareWorktree(root: string, path: string, branch: string, mode?: 'fresh' | 'reuse'): Promise<WorktreeInfo | undefined>
  /** Collect settlement facts (never throws; missing pieces stay unset). */
  collect(worktreePath: string, baseCommit: string): Promise<SettlementFacts>
  /** Merge `branch` into the main worktree (`--no-ff`); THROWS with a readable reason. */
  merge(root: string, branch: string): Promise<void>
  /** Whether `branch` is already an ancestor of HEAD (a merge would be a no-op). */
  isAncestor(root: string, branch: string): Promise<boolean>
  /** Remove a worktree; THROWS when it still has uncommitted changes. */
  removeWorktree(root: string, worktreePath: string): Promise<void>
  /** Delete a branch; THROWS (e.g. still checked out in a worktree). */
  deleteBranch(root: string, branch: string): Promise<void>
}

/**
 * Build the task branch name `task/<标题>+<taskId>` (plan §9 拍板).
 *
 * Title sanitizing: whitespace runs collapse to `-`; git-illegal characters
 * (`~ ^ : ? * [ \ / @ { }` and friends) are stripped; `..` collapses; the
 * segment is trimmed of leading/trailing `.-` and truncated to ~20 code
 * points; an empty result falls back to the bare `task/<taskId>`.
 * @param title - the task title (already normalized 1..200 chars).
 * @param taskId - the task id (stable suffix).
 * @returns the branch name.
 */
export function sanitizeBranchName(title: string, taskId: string): string {
  const segment = title.trim()
    .replace(/\s+/g, '-')
    .replace(/[/\\~^:?*[\]@{}"'<>|#%&;$!`'=,;()]+/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
  const head = Array.from(segment).slice(0, 20).join('').replace(/^[-.]+|[-.]+$/g, '')
  return head.length === 0 ? `task/${taskId}` : `task/${head}+${taskId}`
}

/** The canonical worktree path of a task inside its workspace (forward slashes). */
export function worktreePathOf(workspacePath: string, taskId: string): string {
  const root = workspacePath.replace(/[\\/]+$/, '').replaceAll('\\', '/')
  return `${root}/${WORKTREE_DIR}/${taskId}`
}

/** Real exec layer over child_process.execFile (windowsHide, timeout, maxBuffer). */
const realExec: ExecFn = (args, options) => new Promise(resolve => {
  void (async () => {
    const { execFile } = await import('node:child_process')
    execFile('git', args, {
      cwd: options.cwd,
      timeout: options.timeout ?? QUICK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })().catch(() => resolve({ ok: false, stdout: '', stderr: 'exec unavailable' }))
})

/**
 * Build a {@link GitFace} over an injectable exec layer.
 * @param exec - the exec function (real `git` when omitted).
 */
export function createGitFace(exec: ExecFn = realExec): GitFace {
  const quick = (args: string[], cwd?: string): Promise<ExecResult> => exec(args, { cwd, timeout: QUICK_TIMEOUT_MS })
  const heavy = (args: string[], cwd?: string): Promise<ExecResult> => exec(args, { cwd, timeout: HEAVY_TIMEOUT_MS })

  // Per-root mutex (0.3.1): structural git ops on the SAME repository run one
  // at a time — concurrent isolated executions must not race on git's locks.
  const locks = new Map<string, Promise<unknown>>()
  const withRootLock = <T>(root: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(root) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    locks.set(root, next.catch(() => { /* the chain never blocks later ops */ }))
    return next
  }

  return {
    async detect(root) {
      const r = await quick(['rev-parse', '--is-inside-work-tree'], root)
      return r.ok && r.stdout.trim() === 'true'
    },

    async binaryAvailable() {
      const r = await quick(['--version'])
      return r.ok && r.stdout.startsWith('git version')
    },

    prepareWorktree: (root, path, branch, mode = 'fresh') => withRootLock(root, async () => {
      // 续跑: a live worktree at the path is kept EXACTLY as-is — the agent's
      // commits and uncommitted changes survive; the baseline becomes the
      // worktree's own HEAD so evidence covers only the new run.
      if (mode === 'reuse') {
        const wtHead = await quick(['rev-parse', 'HEAD'], path)
        if (wtHead.ok && wtHead.stdout.trim().length > 0) {
          return { path, branch, baseCommit: wtHead.stdout.trim(), reused: true }
        }
        // No live worktree → fall through to a fresh preparation.
      }

      // Baseline: the main worktree's current HEAD (also validates the repo).
      const head = await quick(['rev-parse', 'HEAD'], root)
      if (!head.ok) return undefined
      const baseCommit = head.stdout.trim()

      const exists = await quick(['show-ref', '--verify', `refs/heads/${branch}`], root)
      if (exists.ok) {
        // Reuse the fixed branch name, but guarantee a FRESH baseline: drop
        // any stale worktree at the path, move the branch to the current
        // HEAD, then check the branch out again (每次全新，复用仅作选项保留).
        await heavy(['worktree', 'remove', '--force', path], root)
        await heavy(['worktree', 'prune'], root)
        const moved = await heavy(['branch', '-f', branch, 'HEAD'], root)
        if (!moved.ok) return undefined
        const added = await heavy(['worktree', 'add', path, branch], root)
        if (!added.ok) return undefined
      } else {
        const added = await heavy(['worktree', 'add', '-b', branch, path], root)
        if (!added.ok) return undefined
      }
      return { path, branch, baseCommit }
    }),

    async collect(worktreePath, baseCommit) {
      const facts: SettlementFacts = { commits: [], commitsTotal: 0, dirtyFiles: [], dirtyFilesTotal: 0, changedFiles: 0 }
      const range = `${baseCommit}..HEAD`

      const head = await quick(['rev-parse', 'HEAD'], worktreePath)
      if (head.ok) facts.headCommit = head.stdout.trim()

      const log = await quick(['log', '--pretty=format:%h %s', range], worktreePath)
      if (log.ok) {
        const commits = log.stdout.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .map(line => {
            const space = line.indexOf(' ')
            return space === -1
              ? { hash: line, subject: '' }
              : { hash: line.slice(0, space), subject: line.slice(space + 1) }
          })
        // Evidence caps (0.3.1): the ledger is rewritten whole on every
        // mutation — cap what a huge branch/status dump can add to it.
        facts.commitsTotal = commits.length
        facts.commits = commits.slice(0, MAX_COMMIT_EVIDENCE)
      }

      const status = await quick(['status', '--porcelain'], worktreePath)
      if (status.ok) {
        const dirty = status.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        facts.dirtyFilesTotal = dirty.length
        facts.dirtyFiles = dirty.slice(0, MAX_DIRTY_EVIDENCE)
      }

      const shortstat = await quick(['diff', '--shortstat', range], worktreePath)
      if (shortstat.ok && shortstat.stdout.trim().length > 0) facts.diffStat = shortstat.stdout.trim()

      const names = await quick(['diff', '--name-only', range], worktreePath)
      if (names.ok) facts.changedFiles = names.stdout.split('\n').filter(l => l.trim().length > 0).length

      return facts
    },

    merge: (root, branch) => withRootLock(root, async () => {
      // Main-clean check. The plugin's own worktree directory
      // (<root>/.dsh-worktrees) shows up as untracked noise and is EXEMPT —
      // otherwise merging would be impossible without gitignoring it first.
      const status = await quick(['status', '--porcelain'], root)
      if (status.ok) {
        const dirtyLines = status.stdout.split('\n')
          .map(l => l.trim())
          .filter(l => {
            if (l.length === 0) return false
            const path = l.slice(3)
            return path !== WORKTREE_DIR && !path.startsWith(`${WORKTREE_DIR}/`)
          })
        if (dirtyLines.length > 0) {
          throw new Error(`主工作区有 ${dirtyLines.length} 处未提交修改，请先提交或暂存后再合并`)
        }
      }
      const merged = await heavy(['merge', '--no-ff', '--no-edit', branch], root)
      if (!merged.ok) {
        // Roll the half-finished merge back so the main worktree stays usable;
        // report the ORIGINAL failure verbatim (不自动解决冲突).
        await heavy(['merge', '--abort'], root)
        throw new Error(`合并失败：${merged.stderr.trim().slice(0, 300)}`)
      }
    }),

    async isAncestor(root, branch) {
      // exit 0 = branch is an ancestor of (or equal to) HEAD → merge no-op.
      const r = await quick(['merge-base', '--is-ancestor', branch, 'HEAD'], root)
      return r.ok
    },

    removeWorktree: (root, worktreePath) => withRootLock(root, async () => {
      const status = await quick(['status', '--porcelain'], worktreePath)
      if (status.ok && status.stdout.trim().length > 0) {
        const lines = status.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        throw new Error(`worktree 有 ${lines.length} 处未提交修改，拒绝删除：\n${lines.slice(0, 10).join('\n')}`)
      }
      const removed = await heavy(['worktree', 'remove', worktreePath], root)
      if (!removed.ok) throw new Error(`删除 worktree 失败：${(removed.stderr.trim() || removed.stdout.trim()).slice(0, 300)}`)
    }),

    deleteBranch: (root, branch) => withRootLock(root, async () => {
      const deleted = await heavy(['branch', '-D', branch], root)
      if (!deleted.ok) throw new Error(`删除分支失败：${deleted.stderr.trim().slice(0, 300)}`)
    }),
  }
}
