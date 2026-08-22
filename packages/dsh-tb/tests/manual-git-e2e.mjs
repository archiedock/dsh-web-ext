/**
 * Manual E2E for the REAL git face (plan §3.7 真机手测): drives real `git`
 * through createGitFace on a scratch repository — detect / prepareWorktree
 * (new + existing branch) / commit in the worktree / collect / merge into
 * main / dirty-refusals / removeWorktree / deleteBranch / non-git detect.
 *
 * Run: node tests/manual-git-e2e.mjs   (not part of vitest; no assertions lib)
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createGitFace, sanitizeBranchName, worktreePathOf } from '../lib/host/git.js'

const root = await mkdtemp(join(tmpdir(), 'tb-git-e2e-'))
const plain = await mkdtemp(join(tmpdir(), 'tb-git-plain-'))
try {
  const git = createGitFace()

  // --- non-git directory: detect false -------------------------------------
  assert.equal(await git.detect(plain), false)

  // --- scratch repo ---------------------------------------------------------
  await writeFile(join(root, 'base.txt'), 'base\n')
  await run('init', '-b', 'main')
  await run('add', '.')
  await run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base')
  assert.equal(await git.detect(root), true)

  // --- prepare a fresh worktree (new branch) --------------------------------
  const branch = sanitizeBranchName('修复 登录页: 布局?', 't-e2e')
  console.log('branch =', branch)
  assert.equal(branch, 'task/修复-登录页-布局+t-e2e')
  const wt = worktreePathOf(root, 't-e2e')
  const info = await git.prepareWorktree(root, wt, branch)
  assert.ok(info !== undefined)
  assert.equal(info.branch, branch)
  assert.equal(info.path, wt)
  assert.match(info.baseCommit, /^[0-9a-f]{40}$/)

  // --- "agent work": commit inside the worktree -----------------------------
  await writeFile(join(wt, 'fix.txt'), 'fixed\n')
  await runIn(wt, 'add', '.')
  await runIn(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'fix: the login layout')

  // --- collect: one commit, no dirty files ----------------------------------
  const facts = await git.collect(wt, info.baseCommit)
  assert.equal(facts.commits.length, 1)
  assert.equal(facts.commits[0].subject, 'fix: the login layout')
  assert.equal(facts.dirtyFiles.length, 0)
  assert.equal(facts.changedFiles, 1)
  console.log('collect =', JSON.stringify(facts))

  // --- dirty refusal: removeWorktree refuses uncommitted changes ------------
  await writeFile(join(wt, 'uncommitted.txt'), 'dirty\n')
  await assert.rejects(() => git.removeWorktree(root, wt), /未提交修改/)
  await rm(join(wt, 'uncommitted.txt'))

  // --- merge dirty-main refusal ---------------------------------------------
  await writeFile(join(root, 'main-dirty.txt'), 'dirty\n')
  await assert.rejects(() => git.merge(root, branch), /未提交修改/)
  await rm(join(root, 'main-dirty.txt'))

  // --- merge (clean main) ----------------------------------------------------
  await git.merge(root, branch)
  const mergedLog = await run('log', '--oneline')
  assert.match(mergedLog, /Merge branch/)

  // --- prepareWorktree AGAIN (existing branch): fresh baseline --------------
  const info2 = await git.prepareWorktree(root, wt, branch)
  assert.ok(info2 !== undefined)
  const facts2 = await git.collect(wt, info2.baseCommit)
  assert.equal(facts2.commits.length, 0, 'branch reset → no commits over the new baseline')
  assert.equal(facts2.dirtyFiles.length, 0)

  // --- 续跑 (reuse mode, 0.3.1): commits + dirty state survive ---------------
  await writeFile(join(wt, 'kept.txt'), 'kept\n')
  await runIn(wt, 'add', '.')
  await runIn(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'reuse: committed work')
  await writeFile(join(wt, 'wip.txt'), 'wip\n')
  const info3 = await git.prepareWorktree(root, wt, branch, 'reuse')
  assert.ok(info3 !== undefined)
  assert.equal(info3.reused, true)
  const facts3 = await git.collect(wt, info3.baseCommit)
  assert.equal(facts3.commits.length, 0, 'reuse baseline = worktree HEAD → no commits yet')
  assert.equal(facts3.dirtyFiles.length, 1, 'uncommitted wip.txt survived the reuse')
  assert.ok((await runIn(wt, 'log', '--oneline')).includes('reuse: committed work'), 'committed work survived')
  await rm(join(wt, 'wip.txt'))

  // --- isAncestor: no-op merge after merging the branch ----------------------
  assert.equal(await git.isAncestor(root, branch), false, 'branch ahead of HEAD → not ancestor')
  await git.merge(root, branch)
  assert.equal(await git.isAncestor(root, branch), true, 'after merge → ancestor (no-op)')

  // --- diff viewer (0.4.0): commit view, path views, caps, fallback ----------
  // A MERGE commit's `git show` carries no patch — pick a regular commit.
  const fixHash = (await run('log', '--format=%H', '--grep=fix: the login layout')).trim().split('\n')[0]
  assert.ok(fixHash !== undefined && fixHash.length > 0, 'fixture commit found')
  const commitView = await git.showCommit(wt, fixHash)
  assert.ok(commitView !== undefined, 'commit view resolves in the worktree')
  assert.ok(commitView.text.includes('diff --git'), 'commit view carries a patch')
  assert.equal(commitView.truncated, false)
  assert.equal(await git.showCommit(wt, 'nothash!'), undefined, 'non-hash ids are refused')

  // Working-tree view: uncommitted change in a live worktree.
  await writeFile(join(wt, 'dirty-view.txt'), 'dirty\n')
  const wtView = await git.showPathDiff(wt, 'dirty-view.txt')
  assert.ok(wtView !== undefined && wtView.text.includes('+dirty'), 'working-tree diff shows the uncommitted line')
  // A clean path reports the explicit no-difference marker.
  assert.equal((await git.showPathDiff(wt, 'base.txt')).text, '（该文件无差异）')
  // Range view from the main repo (the worktree-removed fallback path).
  const rangeView = await git.showPathDiff(root, 'fix.txt', info.baseCommit)
  assert.ok(rangeView !== undefined && rangeView.text.length > 0, 'range diff resolves in the main repo')
  // Caps: a huge generated diff is truncated, not unbounded.
  await writeFile(join(wt, 'huge.txt'), 'line\n'.repeat(20_000))
  const hugeView = await git.showPathDiff(wt, 'huge.txt')
  assert.equal(hugeView.truncated, true, 'oversized diff is truncated')
  assert.ok(hugeView.text.split('\n').length <= 2000, 'line cap respected')
  await rm(join(wt, 'dirty-view.txt'))
  await rm(join(wt, 'huge.txt'))

  // --- binaryAvailable --------------------------------------------------------
  assert.equal(await git.binaryAvailable(), true)

  // --- remove worktree (clean now) + delete branch ---------------------------
  await git.removeWorktree(root, wt)
  await git.deleteBranch(root, branch)

  console.log('MANUAL GIT E2E OK')

  async function run(...args) {
    const { execFile } = await import('node:child_process')
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`${args.join(' ')}: ${stderr}`))
        else resolve(stdout)
      })
    })
  }
  async function runIn(cwd, ...args) {
    const { execFile } = await import('node:child_process')
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`${args.join(' ')}: ${stderr}`))
        else resolve(stdout)
      })
    })
  }
} catch (error) {
  console.error('MANUAL GIT E2E FAILED:', error)
  process.exitCode = 1
} finally {
  // Worktrees may remain registered on failure; prune the scratch repo first.
  try {
    const { execFile } = await import('node:child_process')
    await new Promise(resolve => execFile('git', ['-C', root, 'worktree', 'remove', '--force', join(root, '.dsh-worktrees', 't-e2e')], () => resolve()))
    await new Promise(resolve => execFile('git', ['-C', root, 'worktree', 'prune'], () => resolve()))
  } catch { /* best effort */ }
  await rm(root, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
}
