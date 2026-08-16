import { asIsolation, asStatus, asUrgency, canTransition, newCommentId, newTaskId, normalizeBody, normalizeExecution, normalizeModel, normalizePrompt, normalizeTitle, summarize, syncClaim } from "../shared/protocol.js";
import { WORKTREE_DIR, worktreePathOf } from "./git.js";
import { ROUTE_PREFIX, SSE_PATH } from "../shared/api.js";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
//#region src/host/routes.ts
/** Heartbeat cadence for the SSE stream. */
const HEARTBEAT_MS = 2e4;
/** How long a workspace git-detection result stays cached (fail-soft). */
const GIT_DETECT_TTL_MS = 6e4;
/** Validate a pinned model: structural check always, provider route when known. */
function checkModel(raw, modelProviders) {
	const model = normalizeModel(raw);
	const providers = modelProviders?.();
	if (providers !== void 0 && !providers.includes(model.provider)) throw new Error(`Error: invalid_input: model provider "${model.provider}" has no registered route (available: ${providers.join(", ")})`);
	return model;
}
/** JSON-envelope writer. */
function json(res, payload, status = 200) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}
/** Domain failure → envelope + HTTP status. */
function fail(code, message) {
	return {
		res: {
			ok: false,
			error: {
				code,
				message
			}
		},
		status: code === "invalid_input" || code === "invalid_transition" ? 400 : code === "not_found" ? 404 : code === "version_conflict" ? 409 : code === "forbidden" ? 403 : 500
	};
}
/** Read one JSON body (null on parse failure). */
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}
/** String field accessor (null when absent/not a string). */
function str(body, key) {
	const v = body[key];
	return typeof v === "string" ? v : null;
}
/** Number field accessor (undefined when absent; null when present but not a number). */
function num(body, key) {
	const v = body[key];
	if (v === void 0) return void 0;
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** Normalize an agent preset id: trimmed, non-empty; empty string → undefined. */
function normalizePresetId(raw) {
	const t = (raw ?? "").trim();
	return t.length === 0 ? void 0 : t;
}
/** Map a thrown domain error to the envelope. */
function toFail(error) {
	const message = error instanceof Error ? error.message : String(error);
	const code = message.startsWith("Error: ") ? message.slice(7).split(":")[0] : void 0;
	if (code !== void 0 && [
		"invalid_input",
		"not_found",
		"version_conflict",
		"invalid_transition",
		"forbidden",
		"internal"
	].includes(code)) return fail(code, message.slice(7 + code.length + 2));
	if (code === "workspace_mismatch") return fail("forbidden", message.slice(7 + code.length + 2));
	return fail("invalid_input", message);
}
/**
* Register the taskboard routes.
* @param ctx - context carrying the webServer service.
* @param options - store + workspaces + clock.
* @returns the disposer.
*/
function registerTaskboardRoutes(ctx, options) {
	const { store, workspaces } = options;
	const subscribers = /* @__PURE__ */ new Set();
	let heartbeat;
	const broadcast = (change) => {
		const frame = `event: change\ndata: ${JSON.stringify({
			revision: change.revision,
			kind: change.kind,
			tasks: change.tasks.map(summarize)
		})}\n\n`;
		for (const res of subscribers) res.write(frame);
	};
	store.subscribe(broadcast);
	const gitCache = /* @__PURE__ */ new Map();
	const gitHinted = /* @__PURE__ */ new Set();
	/** Whether <root>/.gitignore (missing file counts as missing) ignores our worktree dir. */
	const gitignoreMissing = async (path) => {
		try {
			const { readFile } = await import("node:fs/promises");
			return !(await readFile(join(path, ".gitignore"), "utf8")).split("\n").some((l) => {
				const t = l.trim().replace(/\/+$/, "");
				return t === ".dsh-worktrees" || t === `/.dsh-worktrees`;
			});
		} catch {
			return true;
		}
	};
	const gitAvailable = async (path) => {
		if (options.git === void 0) return false;
		const hit = gitCache.get(path);
		if (hit !== void 0 && options.now() - hit.at < GIT_DETECT_TTL_MS) return hit.value;
		let value = false;
		try {
			value = await options.git.detect(path);
		} catch {}
		gitCache.set(path, {
			value,
			at: options.now()
		});
		if (value && !gitHinted.has(path)) {
			gitHinted.add(path);
			if (await gitignoreMissing(path)) console.info(`[dsh-taskboard] 建议在 ${path}/.gitignore 加入一行 ${WORKTREE_DIR}/ 以隐藏任务 worktree 目录（不会自动修改）`);
		}
		return value;
	};
	/** List orphan worktree dirs: entries under <ws>/.dsh-worktrees owned by no ledger task. */
	const listOrphanWorktrees = async () => {
		const orphans = [];
		const known = new Set(store.snapshot().tasks.map((t) => t.id));
		for (const ws of workspaces.list()) {
			let entries = [];
			try {
				entries = (await readdir(join(ws.path, WORKTREE_DIR), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
			} catch {}
			for (const taskId of entries) if (!known.has(taskId)) orphans.push({
				workspaceId: ws.id,
				workspacePath: ws.path,
				taskId,
				path: worktreePathOf(ws.path, taskId)
			});
		}
		return orphans;
	};
	/** Git-enabled workspaces whose .gitignore does not cover the worktree dir. */
	const listGitignoreSuggestions = async () => {
		const suggestions = [];
		for (const ws of workspaces.list()) {
			if (!await gitAvailable(ws.path)) continue;
			if (await gitignoreMissing(ws.path)) suggestions.push({
				workspaceId: ws.id,
				workspacePath: ws.path
			});
		}
		return suggestions;
	};
	const handler = async (req, res) => {
		try {
			const pathname = new URL(req.url ?? "/", "http://x").pathname;
			if (req.method === "GET") {
				if (pathname === `/dsh-taskboard/state`) {
					await store.load();
					json(res, {
						ok: true,
						value: store.snapshot()
					});
					return;
				}
				if (pathname === `/dsh-taskboard/workspaces`) {
					const list = workspaces.list();
					const flags = await Promise.all(list.map((ws) => gitAvailable(ws.path)));
					json(res, {
						ok: true,
						value: list.map((ws, i) => ({
							...ws,
							sessionCount: 0,
							gitAvailable: flags[i]
						}))
					});
					return;
				}
				if (pathname === `/dsh-taskboard/diagnostics`) {
					const ledger = store.snapshot();
					let staleRunning = 0;
					for (const t of ledger.tasks) for (const e of t.executions) if (e.outcome === "running") staleRunning += 1;
					json(res, {
						ok: true,
						value: {
							revision: ledger.revision,
							tasks: ledger.tasks.length,
							staleRunning,
							orphanWorktrees: await listOrphanWorktrees(),
							gitIgnoreSuggestions: await listGitignoreSuggestions()
						}
					});
					return;
				}
				const taskMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)$`));
				if (taskMatch !== null) {
					const task = store.get(taskMatch[1]);
					if (task === void 0) {
						const f = fail("not_found", "no such task");
						json(res, f.res, f.status);
						return;
					}
					json(res, {
						ok: true,
						value: task
					});
					return;
				}
				res.writeHead(404);
				res.end();
				return;
			}
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
				json(res, fail("invalid_input", "content-type must be application/json").res, 415);
				return;
			}
			const body = await readBody(req);
			if (body === null) {
				json(res, fail("invalid_input", "body is not a JSON object").res, 400);
				return;
			}
			if (pathname === `/dsh-taskboard/tasks`) {
				try {
					const title = normalizeTitle(str(body, "title") ?? "");
					const workspaceId = str(body, "workspaceId") ?? "";
					if (workspaces.get(workspaceId) === void 0) throw new Error("Error: not_found: unknown workspace");
					const urgency = asUrgency(str(body, "urgency") ?? "");
					const status = str(body, "status") === null ? "todo" : asStatus(str(body, "status"));
					const execution = normalizeExecution(body.execution ?? {}, options.now());
					const model = body.model === void 0 ? void 0 : checkModel(body.model, options.modelProviders);
					const isolationRaw = str(body, "isolation");
					const isolation = isolationRaw === null ? void 0 : asIsolation(isolationRaw);
					const presetId = normalizePresetId(str(body, "presetId"));
					const now = options.now();
					const task = {
						id: newTaskId(),
						title,
						description: (str(body, "description") ?? "").trim(),
						prompt: normalizePrompt(str(body, "prompt") ?? void 0),
						workspaceId,
						urgency,
						status,
						blocked: false,
						execution,
						model,
						...isolation !== void 0 ? { isolation } : {},
						...presetId !== void 0 ? { presetId } : {},
						version: 1,
						createdAt: now,
						updatedAt: now,
						createdBy: { kind: "user" },
						updatedBy: { kind: "user" },
						comments: [],
						executions: []
					};
					await store.mutate("task-created", (ledger) => {
						ledger.tasks.push(task);
						return [task];
					});
					json(res, {
						ok: true,
						value: summarize(task)
					}, 201);
				} catch (error) {
					const f = toFail(error);
					json(res, f.res, f.status);
				}
				return;
			}
			const actionMatch = pathname.match(new RegExp(`^${ROUTE_PREFIX}/tasks/([^/]+)/([\\w-]+)$`));
			if (actionMatch !== null) {
				const id = actionMatch[1];
				const action = actionMatch[2];
				try {
					const task = store.get(id);
					if (task === void 0) throw new Error("Error: not_found: no such task");
					if (action === "update") {
						const ifVersion = num(body, "ifVersion");
						if (ifVersion === void 0 || ifVersion === null) throw new Error("Error: version_conflict: ifVersion required");
						if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`);
						const next = structuredClone(task);
						const title = str(body, "title");
						if (title !== null) next.title = normalizeTitle(title);
						const description = str(body, "description");
						if (description !== null) next.description = description.trim();
						const prompt = str(body, "prompt");
						if (prompt !== null) next.prompt = normalizePrompt(prompt);
						const urgency = str(body, "urgency");
						if (urgency !== null) next.urgency = asUrgency(urgency);
						const workspaceId = str(body, "workspaceId");
						if (workspaceId !== null) {
							if (workspaces.get(workspaceId) === void 0) throw new Error("Error: not_found: unknown workspace");
							next.workspaceId = workspaceId;
						}
						if (typeof body.blocked === "boolean") next.blocked = body.blocked;
						if (body.execution !== void 0) next.execution = normalizeExecution(body.execution, options.now());
						if (body.model === null) next.model = void 0;
						else if (body.model !== void 0) next.model = checkModel(body.model, options.modelProviders);
						const isolationRaw = str(body, "isolation");
						if (isolationRaw !== null) {
							if (task.executions.length > 0 || task.status === "in_progress") throw new Error("Error: invalid_input: isolation 已锁定（任务已有执行记录），不可修改");
							next.isolation = asIsolation(isolationRaw);
						}
						if (body.presetId === null) delete next.presetId;
						else if (body.presetId !== void 0) next.presetId = normalizePresetId(str(body, "presetId"));
						next.version = task.version + 1;
						next.updatedAt = options.now();
						next.updatedBy = { kind: "user" };
						await store.mutate("task-updated", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: summarize(next)
						});
						return;
					}
					if (action === "move") {
						const ifVersion = num(body, "ifVersion");
						const status = str(body, "status") ?? "";
						if (ifVersion === void 0 || ifVersion === null) throw new Error("Error: version_conflict: ifVersion required");
						if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`);
						const to = asStatus(status);
						if (!canTransition(task.status, to)) throw new Error(`Error: invalid_transition: illegal transition ${task.status} → ${to}`);
						const next = structuredClone(task);
						next.status = to;
						next.version = task.version + 1;
						next.updatedAt = options.now();
						next.updatedBy = { kind: "user" };
						if (task.status === "todo" && to === "in_progress") next.blocked = false;
						syncClaim(next, to, options.now());
						await store.mutate("task-moved", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: summarize(next)
						});
						return;
					}
					if (action === "reject") {
						const ifVersion = num(body, "ifVersion");
						if (ifVersion === void 0 || ifVersion === null) throw new Error("Error: version_conflict: ifVersion required");
						if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`);
						if (!canTransition(task.status, "todo")) throw new Error(`Error: invalid_transition: illegal transition ${task.status} → todo`);
						const next = structuredClone(task);
						next.status = "todo";
						next.version = task.version + 1;
						next.updatedAt = options.now();
						next.updatedBy = { kind: "user" };
						syncClaim(next, "todo", options.now());
						const commentText = str(body, "body") ?? "";
						if (commentText.trim().length > 0) next.comments.push({
							id: newCommentId(),
							body: normalizeBody(commentText),
							version: 1,
							createdAt: options.now()
						});
						await store.mutate("task-moved", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: summarize(next)
						});
						return;
					}
					if (action === "comment") {
						const bodyText = str(body, "body") ?? "";
						const comment = {
							id: newCommentId(),
							body: normalizeBody(bodyText),
							version: 1,
							createdAt: options.now()
						};
						const next = structuredClone(task);
						next.comments.push(comment);
						next.version = task.version + 1;
						next.updatedAt = options.now();
						await store.mutate("comment-added", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: comment
						}, 201);
						return;
					}
					if (action === "delete") {
						if (body.purge === true) {
							if (task.trashedAt === void 0) throw new Error("Error: invalid_input: purge requires a trashed task (soft-delete first)");
							if (options.git !== void 0) {
								const ws = workspaces.get(task.workspaceId);
								if (ws !== void 0) {
									const path = worktreePathOf(ws.path, id);
									try {
										await options.git.removeWorktree(ws.path, path);
									} catch (error) {
										const message = error instanceof Error ? error.message : String(error);
										if (message.includes("未提交修改")) throw new Error(`Error: invalid_input: ${message}；请先处理这些改动（提交、续跑或手动保存）再物理清除任务`);
										if (/not a working tree|not a working-tree/i.test(message)) await rm(path, {
											recursive: true,
											force: true
										});
										else throw new Error(`Error: invalid_input: ${message}`);
									}
									if (task.branch !== void 0) try {
										await options.git.deleteBranch(ws.path, task.branch);
									} catch {}
								}
							}
							await store.mutate("task-deleted", (ledger) => {
								ledger.tasks = ledger.tasks.filter((t) => t.id !== id);
								return [];
							});
							json(res, {
								ok: true,
								value: { purged: true }
							});
							return;
						}
						const ifVersion = num(body, "ifVersion");
						if (ifVersion === void 0 || ifVersion === null) throw new Error("Error: version_conflict: ifVersion required");
						if (ifVersion !== task.version) throw new Error(`Error: version_conflict: stale version ${ifVersion} (current ${task.version})`);
						const next = structuredClone(task);
						next.trashedAt = options.now();
						next.version = task.version + 1;
						await store.mutate("task-deleted", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: { trashed: true }
						});
						return;
					}
					if (action === "run") {
						if (options.run === void 0) {
							json(res, fail("invalid_input", "execution service unavailable").res, 501);
							return;
						}
						const runOptions = body.reuse === true ? { reuseWorktree: true } : void 0;
						const result = await options.run(id, runOptions);
						if (result.ok) json(res, {
							ok: true,
							value: result
						}, 202);
						else {
							const f = fail("invalid_input", result.error);
							json(res, f.res, f.status);
						}
						return;
					}
					if (action === "cancel") {
						if (options.cancel === void 0) {
							json(res, fail("invalid_input", "execution service unavailable").res, 501);
							return;
						}
						const result = await options.cancel(id);
						if (result.ok) json(res, {
							ok: true,
							value: {
								cancelled: true,
								executionId: result.executionId
							}
						}, 202);
						else {
							const f = fail("invalid_input", result.error);
							json(res, f.res, f.status);
						}
						return;
					}
					if (action === "merge") {
						if (options.git === void 0) {
							json(res, fail("invalid_input", "git integration unavailable").res, 501);
							return;
						}
						if (task.branch === void 0) throw new Error("Error: invalid_input: 该任务还没有 worktree 分支（未隔离执行过）");
						if (task.status === "in_progress") throw new Error("Error: invalid_input: 任务执行中，不能合并");
						if (task.executions.some((e) => e.outcome === "running")) throw new Error("Error: invalid_input: 任务执行中，不能合并");
						const ws = workspaces.get(task.workspaceId);
						if (ws === void 0) throw new Error("Error: not_found: unknown workspace");
						let noop = false;
						try {
							noop = await options.git.isAncestor(ws.path, task.branch);
						} catch {}
						if (noop) {
							json(res, {
								ok: true,
								value: {
									merged: false,
									noop: true,
									branch: task.branch
								}
							});
							return;
						}
						try {
							await options.git.merge(ws.path, task.branch);
						} catch (error) {
							throw new Error(`Error: invalid_input: ${error instanceof Error ? error.message : String(error)}`);
						}
						const mergedComment = {
							id: newCommentId(),
							body: normalizeBody(`[系统] 分支 ${task.branch} 已合并到主工作区（--no-ff）。`),
							version: 1,
							createdAt: options.now()
						};
						const next = structuredClone(task);
						next.comments.push(mergedComment);
						next.version = task.version + 1;
						next.updatedAt = options.now();
						await store.mutate("comment-added", (ledger) => {
							const i = ledger.tasks.findIndex((t) => t.id === id);
							ledger.tasks[i] = next;
							return [next];
						});
						json(res, {
							ok: true,
							value: {
								merged: true,
								branch: task.branch
							}
						});
						return;
					}
					if (action === "worktree-remove") {
						if (options.git === void 0) {
							json(res, fail("invalid_input", "git integration unavailable").res, 501);
							return;
						}
						if (task.executions.some((e) => e.outcome === "running")) throw new Error("Error: invalid_input: 任务执行中，不能删除 worktree");
						const ws = workspaces.get(task.workspaceId);
						if (ws === void 0) throw new Error("Error: not_found: unknown workspace");
						const path = worktreePathOf(ws.path, id);
						try {
							await options.git.removeWorktree(ws.path, path);
						} catch (error) {
							throw new Error(`Error: invalid_input: ${error instanceof Error ? error.message : String(error)}`);
						}
						let branchDeleted = false;
						let branchError;
						if (body.deleteBranch === true && task.branch !== void 0) try {
							await options.git.deleteBranch(ws.path, task.branch);
							branchDeleted = true;
						} catch (error) {
							branchError = error instanceof Error ? error.message : String(error);
						}
						json(res, {
							ok: true,
							value: {
								removed: true,
								branchDeleted,
								...branchError !== void 0 ? { branchError } : {}
							}
						});
						return;
					}
					const f = fail("not_found", `unknown action ${action}`);
					json(res, f.res, f.status);
				} catch (error) {
					const f = toFail(error);
					json(res, f.res, f.status);
				}
				return;
			}
			if (pathname === `/dsh-taskboard/worktree-cleanup`) {
				try {
					if (options.git === void 0) {
						json(res, fail("invalid_input", "git integration unavailable").res, 501);
						return;
					}
					const workspaceId = str(body, "workspaceId") ?? "";
					const taskId = str(body, "taskId") ?? "";
					const ws = workspaces.get(workspaceId);
					if (ws === void 0) throw new Error("Error: not_found: unknown workspace");
					if (store.get(taskId) !== void 0) throw new Error("Error: invalid_input: 任务仍在看板中，请从任务详情页删除其 worktree");
					const path = worktreePathOf(ws.path, taskId);
					try {
						await options.git.removeWorktree(ws.path, path);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (/not a working tree|not a working-tree/i.test(message)) await rm(path, {
							recursive: true,
							force: true
						});
						else throw new Error(`Error: invalid_input: ${message}`);
					}
					json(res, {
						ok: true,
						value: {
							cleaned: true,
							path
						}
					});
				} catch (error) {
					const f = toFail(error);
					json(res, f.res, f.status);
				}
				return;
			}
			res.writeHead(404);
			res.end();
		} catch (error) {
			const f = fail("internal", error instanceof Error ? error.message : String(error));
			json(res, f.res, f.status);
		}
	};
	const sse = (req, res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		res.write("retry: 2000\n\n");
		res.write(`event: hello\ndata: ${JSON.stringify({ revision: store.snapshot().revision })}\n\n`);
		subscribers.add(res);
		if (heartbeat === void 0) heartbeat = setInterval(() => {
			for (const current of subscribers) current.write(": ping\n\n");
		}, HEARTBEAT_MS);
		req.on("close", () => {
			subscribers.delete(res);
			if (subscribers.size === 0 && heartbeat !== void 0) {
				clearInterval(heartbeat);
				heartbeat = void 0;
			}
		});
	};
	const disposers = [ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler
	}), ctx.webServer.register({
		kind: "exact",
		path: SSE_PATH,
		handler: sse
	})];
	return () => {
		for (const dispose of disposers) dispose();
		if (heartbeat !== void 0) clearInterval(heartbeat);
		for (const res of subscribers) res.end();
		subscribers.clear();
	};
}
//#endregion
export { registerTaskboardRoutes };

//# sourceMappingURL=routes.js.map