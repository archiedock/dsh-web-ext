//#region src/host/git.ts
/** Timeout for quick read-only queries (rev-parse / status / log / diff). */
const QUICK_TIMEOUT_MS = 2e3;
/** Timeout for structural operations (worktree add/remove, merge, branch). */
const HEAVY_TIMEOUT_MS = 15e3;
/** Directory under a workspace where task worktrees live. */
const WORKTREE_DIR = ".dsh-worktrees";
/** Diff viewer caps (0.4.0): raw text kept per view. */
const MAX_DIFF_BYTES = 128 * 1024;
/** Diff viewer caps: lines kept per view. */
const MAX_DIFF_LINES = 2e3;
/** Cap one diff payload by bytes and lines (in order, marking truncation). */
function capDiff(out) {
	let text = out;
	let truncated = false;
	if (text.length > 131072) {
		text = text.slice(0, MAX_DIFF_BYTES);
		truncated = true;
	}
	const lines = text.split("\n");
	if (lines.length > 2e3) {
		text = lines.slice(0, MAX_DIFF_LINES).join("\n");
		truncated = true;
	}
	return {
		text,
		truncated
	};
}
/** A plausible git object hash (defense against option injection). */
function isHash(hash) {
	return /^[0-9a-f]{4,64}$/i.test(hash);
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
function sanitizeBranchName(title, taskId) {
	const segment = title.trim().replace(/\s+/g, "-").replace(/[/\\~^:?*[\]@{}"'<>|#%&;$!`'=,;()]+/g, "").replace(/\.\.+/g, ".").replace(/^[-.\s]+|[-.\s]+$/g, "");
	const head = Array.from(segment).slice(0, 20).join("").replace(/^[-.]+|[-.]+$/g, "");
	return head.length === 0 ? `task/${taskId}` : `task/${head}+${taskId}`;
}
/** The canonical worktree path of a task inside its workspace (forward slashes). */
function worktreePathOf(workspacePath, taskId) {
	return `${workspacePath.replace(/[\\/]+$/, "").replaceAll("\\", "/")}/${WORKTREE_DIR}/${taskId}`;
}
/** Real exec layer over child_process.execFile (windowsHide, timeout, maxBuffer). */
const realExec = (args, options) => new Promise((resolve) => {
	(async () => {
		const { execFile } = await import("node:child_process");
		execFile("git", args, {
			cwd: options.cwd,
			timeout: options.timeout ?? QUICK_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
			encoding: "utf8"
		}, (error, stdout, stderr) => {
			resolve({
				ok: error === null,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? "")
			});
		});
	})().catch(() => resolve({
		ok: false,
		stdout: "",
		stderr: "exec unavailable"
	}));
});
/**
* Build a {@link GitFace} over an injectable exec layer.
* @param exec - the exec function (real `git` when omitted).
*/
function createGitFace(exec = realExec) {
	const quick = (args, cwd) => exec(args, {
		cwd,
		timeout: QUICK_TIMEOUT_MS
	});
	const heavy = (args, cwd) => exec(args, {
		cwd,
		timeout: HEAVY_TIMEOUT_MS
	});
	const locks = /* @__PURE__ */ new Map();
	const withRootLock = (root, fn) => {
		const next = (locks.get(root) ?? Promise.resolve()).then(fn, fn);
		locks.set(root, next.catch(() => {}));
		return next;
	};
	return {
		async detect(root) {
			const r = await quick(["rev-parse", "--is-inside-work-tree"], root);
			return r.ok && r.stdout.trim() === "true";
		},
		async binaryAvailable() {
			const r = await quick(["--version"]);
			return r.ok && r.stdout.startsWith("git version");
		},
		prepareWorktree: (root, path, branch, mode = "fresh") => withRootLock(root, async () => {
			if (mode === "reuse") {
				const wtHead = await quick(["rev-parse", "HEAD"], path);
				if (wtHead.ok && wtHead.stdout.trim().length > 0) return {
					path,
					branch,
					baseCommit: wtHead.stdout.trim(),
					reused: true
				};
			}
			const head = await quick(["rev-parse", "HEAD"], root);
			if (!head.ok) return void 0;
			const baseCommit = head.stdout.trim();
			if ((await quick([
				"show-ref",
				"--verify",
				`refs/heads/${branch}`
			], root)).ok) {
				await heavy([
					"worktree",
					"remove",
					"--force",
					path
				], root);
				await heavy(["worktree", "prune"], root);
				if (!(await heavy([
					"branch",
					"-f",
					branch,
					"HEAD"
				], root)).ok) return void 0;
				if (!(await heavy([
					"worktree",
					"add",
					path,
					branch
				], root)).ok) return void 0;
			} else if (!(await heavy([
				"worktree",
				"add",
				"-b",
				branch,
				path
			], root)).ok) return void 0;
			return {
				path,
				branch,
				baseCommit
			};
		}),
		async collect(worktreePath, baseCommit) {
			const facts = {
				commits: [],
				commitsTotal: 0,
				dirtyFiles: [],
				dirtyFilesTotal: 0,
				changedFiles: 0
			};
			const range = `${baseCommit}..HEAD`;
			const head = await quick(["rev-parse", "HEAD"], worktreePath);
			if (head.ok) facts.headCommit = head.stdout.trim();
			const log = await quick([
				"log",
				"--pretty=format:%h %s",
				range
			], worktreePath);
			if (log.ok) {
				const commits = log.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).map((line) => {
					const space = line.indexOf(" ");
					return space === -1 ? {
						hash: line,
						subject: ""
					} : {
						hash: line.slice(0, space),
						subject: line.slice(space + 1)
					};
				});
				facts.commitsTotal = commits.length;
				facts.commits = commits.slice(0, 50);
			}
			const status = await quick(["status", "--porcelain"], worktreePath);
			if (status.ok) {
				const dirty = status.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
				facts.dirtyFilesTotal = dirty.length;
				facts.dirtyFiles = dirty.slice(0, 100);
			}
			const shortstat = await quick([
				"diff",
				"--shortstat",
				range
			], worktreePath);
			if (shortstat.ok && shortstat.stdout.trim().length > 0) facts.diffStat = shortstat.stdout.trim();
			const names = await quick([
				"diff",
				"--name-only",
				range
			], worktreePath);
			if (names.ok) facts.changedFiles = names.stdout.split("\n").filter((l) => l.trim().length > 0).length;
			return facts;
		},
		merge: (root, branch) => withRootLock(root, async () => {
			const status = await quick(["status", "--porcelain"], root);
			if (status.ok) {
				const dirtyLines = status.stdout.split("\n").map((l) => l.trim()).filter((l) => {
					if (l.length === 0) return false;
					const path = l.slice(3);
					return path !== ".dsh-worktrees" && !path.startsWith(`.dsh-worktrees/`);
				});
				if (dirtyLines.length > 0) throw new Error(`主工作区有 ${dirtyLines.length} 处未提交修改，请先提交或暂存后再合并`);
			}
			const merged = await heavy([
				"merge",
				"--no-ff",
				"--no-edit",
				branch
			], root);
			if (!merged.ok) {
				await heavy(["merge", "--abort"], root);
				throw new Error(`合并失败：${merged.stderr.trim().slice(0, 300)}`);
			}
		}),
		async isAncestor(root, branch) {
			return (await quick([
				"merge-base",
				"--is-ancestor",
				branch,
				"HEAD"
			], root)).ok;
		},
		removeWorktree: (root, worktreePath) => withRootLock(root, async () => {
			const status = await quick(["status", "--porcelain"], worktreePath);
			if (status.ok && status.stdout.trim().length > 0) {
				const lines = status.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
				throw new Error(`worktree 有 ${lines.length} 处未提交修改，拒绝删除：\n${lines.slice(0, 10).join("\n")}`);
			}
			const removed = await heavy([
				"worktree",
				"remove",
				worktreePath
			], root);
			if (!removed.ok) throw new Error(`删除 worktree 失败：${(removed.stderr.trim() || removed.stdout.trim()).slice(0, 300)}`);
		}),
		deleteBranch: (root, branch) => withRootLock(root, async () => {
			const deleted = await heavy([
				"branch",
				"-D",
				branch
			], root);
			if (!deleted.ok) throw new Error(`删除分支失败：${deleted.stderr.trim().slice(0, 300)}`);
		}),
		async showCommit(cwd, hash) {
			if (!isHash(hash)) return void 0;
			const r = await quick([
				"show",
				"--no-color",
				"--format=medium",
				hash
			], cwd);
			if (!r.ok || r.stdout.trim().length === 0) return void 0;
			return capDiff(r.stdout);
		},
		async showPathDiff(cwd, path, baseCommit) {
			const target = path.trim();
			if (target.length === 0) return void 0;
			if (baseCommit !== void 0 && isHash(baseCommit)) {
				const r = await quick([
					"diff",
					"--no-color",
					`${baseCommit}..HEAD`,
					"--",
					target
				], cwd);
				if (!r.ok) return void 0;
				if (r.stdout.trim().length === 0) return {
					text: "（该文件无差异）",
					truncated: false
				};
				return capDiff(r.stdout);
			}
			const r = await quick([
				"diff",
				"--no-color",
				"HEAD",
				"--",
				target
			], cwd);
			if (r.ok && r.stdout.trim().length > 0) return capDiff(r.stdout);
			const st = await quick([
				"status",
				"--porcelain",
				"--",
				target
			], cwd);
			if (r.ok && st.ok && st.stdout.trim().startsWith("??")) {
				const ni = await exec([
					"diff",
					"--no-color",
					"--no-index",
					"--",
					"/dev/null",
					target
				], {
					cwd,
					timeout: QUICK_TIMEOUT_MS
				});
				if (ni.stdout.includes("diff --git")) return capDiff(ni.stdout);
				return {
					text: `（未跟踪新文件：${target}）`,
					truncated: false
				};
			}
			if (!r.ok) return void 0;
			return {
				text: "（该文件无差异）",
				truncated: false
			};
		}
	};
}
//#endregion
export { MAX_DIFF_BYTES, MAX_DIFF_LINES, WORKTREE_DIR, createGitFace, sanitizeBranchName, worktreePathOf };

//# sourceMappingURL=git.js.map