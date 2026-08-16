/**
 * 0.3.0 tests: the host git face — branch-name sanitizing (pure) and every
 * GitFace method over a scripted fake exec layer (detect / prepareWorktree
 * fresh-vs-existing / collect parsing / merge refusals / remove refusals).
 * No real git is invoked anywhere.
 */
import { describe, expect, it } from 'vitest'
import { createGitFace, sanitizeBranchName, worktreePathOf, type ExecFn, type ExecResult } from '../src/host/git.ts'

describe('sanitizeBranchName', () => {
  it('builds task/<标题>+<taskId> with whitespace collapsed to dashes', () => {
    expect(sanitizeBranchName('修复登录页 布局', 't-1')).toBe('task/修复登录页-布局+t-1')
  })

  it('strips git-illegal characters and collapses ..', () => {
    expect(sanitizeBranchName('fix: a ~bad~ name?', 't-2')).toBe('task/fix-a-bad-name+t-2')
    expect(sanitizeBranchName('a..b', 't-3')).toBe('task/a.b+t-3')
    // Slashes are stripped entirely (no extra ref path segments).
    expect(sanitizeBranchName('path/to/thing', 't-4')).toBe('task/pathtothing+t-4')
  })

  it('truncates the title segment to ~20 code points (CJK safe)', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'
    const branch = sanitizeBranchName(long, 't-5')
    expect(branch).toBe(`task/一二三四五六七八九十一二三四五六七八九十+t-5`)
    expect([...branch].length).toBeLessThan(40)
  })

  it('falls back to the bare task id when the segment empties', () => {
    expect(sanitizeBranchName('???', 't-6')).toBe('task/t-6')
    expect(sanitizeBranchName('   ', 't-7')).toBe('task/t-7')
    expect(sanitizeBranchName('---', 't-8')).toBe('task/t-8')
  })

  it('trims leading/trailing dashes and dots', () => {
    expect(sanitizeBranchName('-.标题.-', 't-9')).toBe('task/标题+t-9')
  })

  it('worktreePathOf joins the canonical directory (forward slashes)', () => {
    expect(worktreePathOf('/proj/a', 't-1')).toBe('/proj/a/.dsh-worktrees/t-1')
    expect(worktreePathOf('D:/x/y/', 't-2')).toBe('D:/x/y/.dsh-worktrees/t-2')
    expect(worktreePathOf('D:\\x\\y\\', 't-3')).toBe('D:/x/y/.dsh-worktrees/t-3')
  })
})

/** Scripted exec: handlers keyed by argument/cwd predicate, in order. */
function scripted(handlers: Array<{ match: (args: string[], options: { cwd?: string }) => boolean; result: ExecResult | Error }>): ExecFn & { calls: string[][] } {
  const calls: string[][] = []
  let cursor = 0
  const fn: ExecFn = async (args, options) => {
    calls.push(args)
    for (let i = cursor; i < handlers.length; i++) {
      if (handlers[i]!.match(args, options)) {
        cursor = i + 1
        const result = handlers[i]!.result
        if (result instanceof Error) throw result
        return result
      }
    }
    return { ok: false, stdout: '', stderr: `unexpected args: ${args.join(' ')}` }
  }
  return Object.assign(fn, { calls })
}

const ok = (stdout = ''): ExecResult => ({ ok: true, stdout, stderr: '' })
const bad = (stderr = 'boom'): ExecResult => ({ ok: false, stdout: '', stderr })

describe('createGitFace (scripted exec)', () => {
  it('detect: true on is-inside-work-tree, false on failure or non-true output', async () => {
    const git = createGitFace(scripted([{ match: a => a.includes('rev-parse'), result: ok('true\n') }]))
    expect(await git.detect('/r')).toBe(true)

    const git2 = createGitFace(scripted([{ match: a => a.includes('rev-parse'), result: bad('not a git repository') }]))
    expect(await git2.detect('/r')).toBe(false)

    const git3 = createGitFace(scripted([{ match: a => a.includes('rev-parse'), result: ok('false\n') }]))
    expect(await git3.detect('/r')).toBe(false)
  })

  it('prepareWorktree (new branch): rev-parse HEAD then worktree add -b', async () => {
    const exec = scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('abc123\n') },
      { match: a => a[0] === 'show-ref', result: bad('refs/heads/task/x: not found') },
      { match: a => a[0] === 'worktree' && a[1] === 'add', result: ok('') },
    ])
    const info = await createGitFace(exec).prepareWorktree('/r', '/r/.dsh-worktrees/t-1', 'task/x+t-1')
    expect(info).toEqual({ path: '/r/.dsh-worktrees/t-1', branch: 'task/x+t-1', baseCommit: 'abc123' })
    expect(exec.calls.some(a => a.includes('-b'))).toBe(true)
  })

  it('prepareWorktree (existing branch): removes the stale worktree, resets the branch, re-adds', async () => {
    const exec = scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('deadbeef\n') },
      { match: a => a[0] === 'show-ref', result: ok('') },
      { match: a => a[0] === 'worktree' && a[1] === 'remove', result: ok('') },
      { match: a => a[0] === 'worktree' && a[1] === 'prune', result: ok('') },
      { match: a => a[0] === 'branch' && a[1] === '-f', result: ok('') },
      { match: a => a[0] === 'worktree' && a[1] === 'add', result: ok('') },
    ])
    const info = await createGitFace(exec).prepareWorktree('/r', '/r/.dsh-worktrees/t-1', 'task/x+t-1')
    expect(info?.baseCommit).toBe('deadbeef')
    expect(exec.calls.some(a => a[0] === 'branch' && a[1] === '-f' && a[2] === 'task/x+t-1')).toBe(true)
  })

  it('prepareWorktree degrades to undefined when HEAD or worktree add fails', async () => {
    const noRepo = createGitFace(scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD', result: bad('not a git repository') },
    ]))
    expect(await noRepo.prepareWorktree('/r', '/p', 'task/x')).toBeUndefined()

    const addFails = createGitFace(scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('abc\n') },
      { match: a => a[0] === 'show-ref', result: bad('') },
      { match: a => a[0] === 'worktree' && a[1] === 'add', result: bad('already exists') },
    ]))
    expect(await addFails.prepareWorktree('/r', '/p', 'task/x')).toBeUndefined()
  })

  it('collect parses head commit, commits, dirty files, shortstat, and changed count', async () => {
    const exec = scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('fff000\n') },
      { match: a => a[0] === 'log', result: ok('abc1234 feat: do the thing\ndef5678 fix: also this') },
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok(' M src/a.ts\n?? tmp.txt\n') },
      { match: a => a[0] === 'diff' && a[1] === '--shortstat', result: ok(' 2 files changed, 10 insertions(+), 1 deletion(-)\n') },
      { match: a => a[0] === 'diff' && a[1] === '--name-only', result: ok('src/a.ts\nsrc/b.ts\n') },
    ])
    const facts = await createGitFace(exec).collect('/wt', 'abc000')
    expect(facts).toEqual({
      headCommit: 'fff000',
      commits: [
        { hash: 'abc1234', subject: 'feat: do the thing' },
        { hash: 'def5678', subject: 'fix: also this' },
      ],
      commitsTotal: 2,
      dirtyFiles: ['M src/a.ts', '?? tmp.txt'],
      dirtyFilesTotal: 2,
      diffStat: '2 files changed, 10 insertions(+), 1 deletion(-)',
      changedFiles: 2,
    })
  })

  it('collect stays partial when individual queries fail', async () => {
    const exec = scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD', result: bad('dangling') },
      { match: a => a[0] === 'log', result: ok('') },
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok('') },
      { match: a => a[0] === 'diff', result: bad('') },
    ])
    const facts = await createGitFace(exec).collect('/wt', 'abc000')
    expect(facts.headCommit).toBeUndefined()
    expect(facts.commits).toEqual([])
    expect(facts.changedFiles).toBe(0)
  })

  it('merge refuses a dirty main worktree with the change count', async () => {
    const exec = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok(' M a\n M b\n') },
    ])
    await expect(createGitFace(exec).merge('/r', 'task/x')).rejects.toThrow('主工作区有 2 处未提交修改')
  })

  it('merge exempts the plugin-owned .dsh-worktrees directory from the clean check', async () => {
    const exec = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok('?? .dsh-worktrees/\n?? .dsh-worktrees/t-1/\n M real.ts\n') },
      { match: a => a[0] === 'merge', result: ok('') },
    ])
    await expect(createGitFace(exec).merge('/r', 'task/x')).rejects.toThrow('主工作区有 1 处未提交修改')
    const execClean = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok('?? .dsh-worktrees/\n') },
      { match: a => a[0] === 'merge', result: ok('') },
    ])
    await expect(createGitFace(execClean).merge('/r', 'task/x')).resolves.toBeUndefined()
  })

  it('merge reports conflicts verbatim and aborts the half-finished merge', async () => {
    const exec = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok('') },
      { match: a => a[0] === 'merge' && a[1] === '--no-ff', result: bad('CONFLICT (content): Merge conflict in src/a.ts\n') },
      { match: a => a[0] === 'merge' && a[1] === '--abort', result: ok('') },
    ])
    await expect(createGitFace(exec).merge('/r', 'task/x')).rejects.toThrow('CONFLICT')
    expect(exec.calls.some(a => a[0] === 'merge' && a[1] === '--abort')).toBe(true)
  })

  it('merge succeeds on a clean main worktree with --no-ff --no-edit', async () => {
    const exec = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok('') },
      { match: a => a[0] === 'merge', result: ok('') },
    ])
    await expect(createGitFace(exec).merge('/r', 'task/x')).resolves.toBeUndefined()
    expect(exec.calls.some(a => a[0] === 'merge' && a[1] === '--no-ff' && a.includes('--no-edit'))).toBe(true)
  })

  it('removeWorktree refuses uncommitted changes, listing the files', async () => {
    const exec = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok(' M src/x.ts\n') },
    ])
    await expect(createGitFace(exec).removeWorktree('/r', '/wt')).rejects.toThrow('worktree 有 1 处未提交修改')
    expect(exec.calls.some(a => a[0] === 'worktree' && a[1] === 'remove')).toBe(false)
  })

  it('removeWorktree removes a clean worktree and surfaces git failures', async () => {
    const okExec = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok('') },
      { match: a => a[0] === 'worktree' && a[1] === 'remove', result: ok('') },
    ])
    await expect(createGitFace(okExec).removeWorktree('/r', '/wt')).resolves.toBeUndefined()

    const failExec = scripted([
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok('') },
      { match: a => a[0] === 'worktree' && a[1] === 'remove', result: bad('fatal: not a working tree') },
    ])
    await expect(createGitFace(failExec).removeWorktree('/r', '/wt')).rejects.toThrow('not a working tree')
  })

  it('deleteBranch succeeds or reports the git error', async () => {
    const okExec = scripted([{ match: a => a[0] === 'branch' && a[1] === '-D', result: ok('Deleted branch task/x.') }])
    await expect(createGitFace(okExec).deleteBranch('/r', 'task/x')).resolves.toBeUndefined()
    const failExec = scripted([{ match: a => a[0] === 'branch' && a[1] === '-D', result: bad("error: Cannot delete branch 'task/x' checked out at '/wt'") }])
    await expect(createGitFace(failExec).deleteBranch('/r', 'task/x')).rejects.toThrow('checked out')
  })

  // ------------------------------------------------------------- 0.3.1 additions

  it('binaryAvailable: true on git --version, false on spawn failure or odd output', async () => {
    const good = createGitFace(scripted([{ match: a => a[0] === '--version', result: ok('git version 2.55.0.windows.2\n') }]))
    expect(await good.binaryAvailable()).toBe(true)

    const spawnFail = createGitFace(scripted([{ match: a => a[0] === '--version', result: bad('spawn git ENOENT') }]))
    expect(await spawnFail.binaryAvailable()).toBe(false)
  })

  it('isAncestor: true when merge-base exits 0, false otherwise (fail-soft)', async () => {
    const yes = createGitFace(scripted([{ match: a => a[0] === 'merge-base', result: ok('') }]))
    expect(await yes.isAncestor('/r', 'task/x')).toBe(true)

    const no = createGitFace(scripted([{ match: a => a[0] === 'merge-base', result: bad('not a valid object name') }]))
    expect(await no.isAncestor('/r', 'task/x')).toBe(false)
  })

  it('prepareWorktree reuse: a live worktree is kept as-is with its own HEAD as baseline', async () => {
    const exec = scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD' && a.length === 2, result: ok('wt777\n') },
    ])
    const info = await createGitFace(exec).prepareWorktree('/r', '/wt', 'task/x', 'reuse')
    expect(info).toEqual({ path: '/wt', branch: 'task/x', baseCommit: 'wt777', reused: true })
    // No structural command was issued — the worktree was left untouched.
    expect(exec.calls.some(a => a[0] === 'worktree' || a[0] === 'branch')).toBe(false)
  })

  it('prepareWorktree reuse falls back to a fresh preparation when no worktree is alive', async () => {
    const exec = scripted([
      // The reuse probe at the worktree path finds no live worktree...
      { match: (a, o) => a[0] === 'rev-parse' && a[1] === 'HEAD' && o.cwd === '/wt', result: bad('not a git repository') },
      // ...so the fresh path takes over: main HEAD, no such branch, create.
      { match: (a, o) => a[0] === 'rev-parse' && a[1] === 'HEAD' && o.cwd === '/r', result: ok('root999\n') },
      { match: a => a[0] === 'show-ref', result: bad('') },
      { match: a => a[0] === 'worktree' && a[1] === 'add', result: ok('') },
    ])
    const info = await createGitFace(exec).prepareWorktree('/r', '/wt', 'task/x', 'reuse')
    expect(info).toEqual({ path: '/wt', branch: 'task/x', baseCommit: 'root999' })
    expect(info?.reused).toBeUndefined()
  })

  it('collect caps evidence: 50 commits / 100 dirty lines kept, totals preserved', async () => {
    const commitLines = Array.from({ length: 60 }, (_, i) => `hash${i} subject ${i}`).join('\n')
    const dirtyLines = Array.from({ length: 120 }, (_, i) => ` M file${i}.ts`).join('\n')
    const exec = scripted([
      { match: a => a[0] === 'rev-parse' && a[1] === 'HEAD', result: ok('head\n') },
      { match: a => a[0] === 'log', result: ok(commitLines) },
      { match: a => a[0] === 'status' && a[1] === '--porcelain', result: ok(dirtyLines) },
      { match: a => a[0] === 'diff' && a[1] === '--shortstat', result: ok('60 files changed\n') },
      { match: a => a[0] === 'diff' && a[1] === '--name-only', result: ok(Array.from({ length: 60 }, (_, i) => `f${i}`).join('\n')) },
    ])
    const facts = await createGitFace(exec).collect('/wt', 'base')
    expect(facts.commitsTotal).toBe(60)
    expect(facts.commits).toHaveLength(50)
    expect(facts.commits[0]).toEqual({ hash: 'hash0', subject: 'subject 0' })
    expect(facts.dirtyFilesTotal).toBe(120)
    expect(facts.dirtyFiles).toHaveLength(100)
    expect(facts.changedFiles).toBe(60)
  })

  it('structural operations on the same root serialize (no overlap)', async () => {
    // Timing exec: records start/end per call; first call artificially slow.
    const timeline: Array<{ op: string; start: number; end: number }> = []
    let delayNext = true
    const exec: ExecFn = async (args) => {
      const start = Date.now()
      if (delayNext) {
        delayNext = false
        await new Promise(r => setTimeout(r, 40))
      }
      timeline.push({ op: args.join(' '), start, end: Date.now() })
      return ok('')
    }
    const git = createGitFace(exec)
    // Two merges + a branch delete on the SAME root fired concurrently.
    await Promise.all([
      git.merge('/r', 'task/a'),
      git.merge('/r', 'task/b'),
      git.deleteBranch('/r', 'task/a'),
    ])
    const structural = timeline.filter(t => t.op.startsWith('merge') || t.op.startsWith('branch'))
    expect(structural.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < structural.length; i++) {
      expect(structural[i]!.start).toBeGreaterThanOrEqual(structural[i - 1]!.end)
    }
  })
})
