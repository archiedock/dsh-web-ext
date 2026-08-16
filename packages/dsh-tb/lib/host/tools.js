import { asIsolation, asStatus, asUrgency, canTransition, effectivePrompt, isClaim, isClaimedBy, newCommentId, newTaskId, normalizeBody, normalizeExecution, normalizeModel, normalizePrompt, normalizeTitle, summarize, syncClaim } from "../shared/protocol.js";
import { defineTool } from "./sdk.js";
//#region src/host/tools.ts
/** Render side: one compact task line (id/status/version are load-bearing). */
function taskLine(t) {
	const parts = [`- ${t.id} [${t.status}] v${t.version} · ${t.urgency} · 项目 ${t.workspaceId}`, `「${t.title}」`];
	if (t.blocked) parts.push("·受阻");
	if (t.executionMode === "scheduled") parts.push("·定时");
	if (t.commentCount !== void 0 && t.commentCount > 0) parts.push(`·评论${t.commentCount}`);
	if (t.lastExecutionOutcome !== void 0) parts.push(`·上次执行${t.lastExecutionOutcome}`);
	if (t.trashed === true) parts.push("·已删");
	return parts.join(" ");
}
/** Render side: the full task detail block (everything an executor needs). */
function taskDetail(t) {
	const lines = [
		`任务 ${t.id} 「${t.title}」`,
		`状态: ${t.status} (v${t.version}) · 紧急度: ${t.urgency} · 项目: ${t.workspaceId}${t.blocked ? " · 受阻" : ""}`,
		`执行方式: ${t.execution.mode}${t.execution.cron !== void 0 ? ` cron=${t.execution.cron}` : ""}`,
		`隔离: ${t.isolation === "none" ? "关闭（原目录执行）" : "Git Worktree"}${t.branch !== void 0 ? `（分支 ${t.branch}）` : ""}`
	];
	const holder = isClaimedBy(t);
	if (holder !== void 0) lines.push(`认领: agent ${String(holder).slice(0, 24)}（持有期间其他会话不可移动）`);
	if (t.execution.nextRunAt !== void 0) lines.push(`下次触发: ${new Date(t.execution.nextRunAt).toISOString()}`);
	if (t.model !== void 0) lines.push(`固定模型: ${t.model.provider}/${t.model.model}`);
	if (t.presetId !== void 0) lines.push(`执行模式: ${t.presetId}（未指定时为部署默认 preset）`);
	lines.push(`描述: ${t.description.length > 0 ? t.description : "（无）"}`);
	lines.push(`执行 Prompt: ${t.effectivePrompt ?? effectivePrompt(t)}`);
	if (t.comments.length > 0) {
		lines.push(`评论 (${t.comments.length}):`);
		for (const c of t.comments) {
			const who = c.threadId !== void 0 ? `agent ${String(c.threadId).slice(0, 24)}` : "user";
			lines.push(`  - [${who} ${new Date(c.createdAt).toISOString()}] ${c.body}`);
		}
	} else lines.push("评论: 无");
	if (t.executions.length > 0) {
		lines.push(`执行记录 (${t.executions.length}):`);
		for (const e of t.executions) {
			const at = e.startedAt !== void 0 ? new Date(e.startedAt).toISOString() : "?";
			const err = e.error !== void 0 ? ` 错误: ${e.error}` : "";
			lines.push(`  - [${e.trigger} ${at}] ${e.outcome}${err}`);
		}
	} else lines.push("执行记录: 无");
	const updatedBy = t.updatedBy.kind === "agent" ? `agent ${String(t.updatedBy.sessionId).slice(0, 24)}` : "user";
	lines.push(`更新: ${new Date(t.updatedAt).toISOString()} 由 ${updatedBy}`);
	return lines.join("\n");
}
/** Stable error codes surfaced at the head of tool error messages. */
const ERR = {
	notFound: "not_found",
	versionConflict: "version_conflict",
	workspaceMismatch: "workspace_mismatch",
	invalidTransition: "invalid_transition",
	forbidden: "forbidden",
	requiresAgent: "unauthorized_actor",
	invalidInput: "invalid_input"
};
/** Tool failure: an Error whose message starts with a stable code. */
var ToolError = class extends Error {
	code;
	constructor(code, detail) {
		super(`Error: ${code}: ${detail}`);
		this.code = code;
	}
};
/** Adapt the real registry to the narrow face. */
function workspaceFace(registry) {
	return {
		resolveByPath: async (path) => {
			const ws = await registry.resolveByPath(path);
			return ws === void 0 ? void 0 : { id: ws.id };
		},
		get: (id) => {
			const ws = registry.get(id);
			return ws === void 0 ? void 0 : {
				id: ws.id,
				path: ws.path,
				title: ws.title
			};
		},
		list: () => registry.list().map((ws) => ({
			id: ws.id,
			path: ws.path,
			title: ws.title
		}))
	};
}
/** Validate a pinned model: structural check always, provider route when known. */
function checkModel(deps, raw) {
	const model = normalizeModel(raw);
	const providers = deps.modelProviders?.();
	if (providers !== void 0 && !providers.includes(model.provider)) throw new ToolError(ERR.invalidInput, `model provider "${model.provider}" has no registered route (available: ${providers.join(", ")})`);
	return model;
}
/** Resolve the calling agent's actor and session id. */
function caller(exec) {
	if (!exec.agent) throw new ToolError(ERR.requiresAgent, "taskboard tools require a calling agent session");
	const sessionId = exec.agent.id;
	return {
		actor: {
			kind: "agent",
			sessionId
		},
		sessionId
	};
}
/** The calling session's workspace id (undefined when unaffiliated). */
async function callerWorkspace(deps, exec) {
	const cwd = exec.agent?.session.header.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) return void 0;
	return (await deps.workspaces.resolveByPath(cwd))?.id;
}
/** Guard: version match. */
function versionGuard(task, ifVersion) {
	if (ifVersion === void 0) throw new ToolError(ERR.versionConflict, "this write requires ifVersion; read the task first");
	if (ifVersion !== task.version) throw new ToolError(ERR.versionConflict, `stale version ${ifVersion} (current ${task.version}); re-read the task and retry once`);
}
/** Re-throw with a stable code; non-ToolErrors become invalid_input. */
function fail(error) {
	if (error instanceof ToolError) throw error;
	const message = error instanceof Error ? error.message : String(error);
	throw new ToolError(ERR.invalidInput, message);
}
/** Loose json output schema shared by every taskboard tool. */
const JSON_OUT = { type: "json" };
/** Deep-JSON a value for a json-rooted tool output (spread results lose implicit index signatures). */
function json(value) {
	return JSON.parse(JSON.stringify(value));
}
/**
* Register all eight tools.
* @param ctx - a context exposing `tools.register`.
* @param deps - store + workspaces + clock.
* @returns dispose functions, one per tool.
*/
function registerTaskboardTools(ctx, deps) {
	const disposers = [];
	const { store, workspaces } = deps;
	const register = (tool) => {
		if (process.env.ATB_TRACE === "1" && typeof tool.execute === "function") {
			const orig = tool.execute;
			tool.execute = async (args, exec) => {
				console.error(`[atb ▶] ${tool.name}`, JSON.stringify(args).slice(0, 300));
				try {
					const result = await orig(args, exec);
					console.error(`[atb ✓] ${tool.name}`, JSON.stringify(result).slice(0, 300));
					return result;
				} catch (error) {
					console.error(`[atb ✗] ${tool.name}`, String(error).slice(0, 400));
					throw error;
				}
			};
		}
		return ctx.tools.register(tool);
	};
	disposers.push(register(defineTool({
		name: "taskboard_list",
		description: "List task-board tasks. Filter by project (workspaceId), status, or urgency. Returns compact summaries (id, title, status, urgency, version, claim owner). Check this before starting work to find claimable todo tasks in your project.",
		parameters: {
			workspaceId: {
				type: "string",
				description: "Filter by project (DSH workspace id)."
			},
			status: {
				type: "string",
				description: "Filter by exact status (backlog/todo/in_progress/in_review/done/canceled/archived)."
			},
			urgency: {
				type: "string",
				description: "Filter by urgency (urgent/normal/relaxed)."
			},
			includeTrashed: {
				type: "boolean",
				description: "Include soft-deleted tasks (default false)."
			}
		},
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				const v = value;
				const tasks = v.tasks ?? [];
				const head = `任务 ${tasks.length} 条（台账 rev ${v.revision ?? "?"}）`;
				if (tasks.length === 0) return [{
					type: "text",
					text: `${head}：无匹配任务。`
				}];
				return [{
					type: "text",
					text: [head, ...tasks.map((t) => taskLine(t))].join("\n")
				}];
			}
		},
		async execute(args) {
			try {
				const a = args;
				const tasks = store.snapshot().tasks.filter((t) => (a.workspaceId === void 0 || t.workspaceId === a.workspaceId) && (a.status === void 0 || t.status === a.status) && (a.urgency === void 0 || t.urgency === a.urgency) && (a.includeTrashed === true || t.trashedAt === void 0));
				return json({
					revision: store.snapshot().revision,
					tasks: tasks.map(summarize)
				});
			} catch (error) {
				fail(error);
			}
		}
	})));
	disposers.push(register(defineTool({
		name: "taskboard_get",
		description: "Read one task in full: description, prompt, project, urgency, status, comments, executions, version. Read this (and the comments) BEFORE claiming or starting work on a task.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Task id from the board."
		} },
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: v.task === void 0 ? "任务不存在。" : taskDetail(v.task)
				}];
			}
		},
		async execute(args) {
			try {
				const { id } = args;
				const task = store.get(id);
				if (task === void 0 || task.trashedAt !== void 0) throw new ToolError(ERR.notFound, `no task ${id}`);
				return json({ task: {
					...task,
					effectivePrompt: effectivePrompt(task)
				} });
			} catch (error) {
				fail(error);
			}
		}
	})));
	disposers.push(register(defineTool({
		name: "taskboard_create",
		description: "Create a task on the board. Required: title, workspaceId (project), urgency (urgent/normal/relaxed). Optional: description, prompt (sent to a fresh session on execution), status (default todo), execution mode (claim|scheduled + cron), model {provider, model} to pin executions to a model. Do not track trivial requests as tasks.",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "Short imperative line (1..200 chars)."
			},
			workspaceId: {
				type: "string",
				required: true,
				description: "Project (DSH workspace id) this task belongs to."
			},
			urgency: {
				type: "string",
				required: true,
				description: "urgent (red) | normal (purple) | relaxed (blue)."
			},
			description: {
				type: "string",
				description: "What the task involves (plain text)."
			},
			prompt: {
				type: "string",
				description: "Prompt sent to a fresh session when executed; default = title+description."
			},
			status: {
				type: "string",
				description: "Initial status; default todo. backlog = not approved for execution."
			},
			execution: {
				type: "object",
				additionalProperties: false,
				description: "Execution config: { mode: \"claim\" } (default) or { mode: \"scheduled\", cron: \"m h dom mon dow\" }.",
				properties: {
					mode: {
						type: "string",
						description: "claim | scheduled."
					},
					cron: {
						type: "string",
						description: "Five-field cron expression (scheduled only)."
					}
				}
			},
			model: {
				type: "object",
				additionalProperties: false,
				description: "Pin executions to one configured model: { provider, model }. Omit to use the default model.",
				properties: {
					provider: {
						type: "string",
						description: "Provider route id."
					},
					model: {
						type: "string",
						description: "Provider-owned model id."
					}
				}
			},
			isolation: {
				type: "string",
				description: "Code isolation for executions: \"worktree\" (default — each run gets a fresh git worktree on branch task/<标题>+<taskId>) or \"none\" (run in the project directory, zero git interaction)."
			},
			presetId: {
				type: "string",
				description: "Agent preset the execution session is composed from (its tool set / persona); default = the deployment default preset. Optional."
			}
		},
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				const t = value.task;
				return [{
					type: "text",
					text: t === void 0 ? "创建失败。" : `已创建任务 ${t.id} [${t.status}] v${t.version}。写入前先 taskboard_get 读取。`
				}];
			}
		},
		async execute(args, exec) {
			try {
				const { actor } = caller(exec);
				const title = normalizeTitle(args.title);
				if (workspaces.get(args.workspaceId) === void 0) throw new ToolError(ERR.notFound, `unknown workspaceId ${args.workspaceId}`);
				const urgency = asUrgency(args.urgency);
				const status = args.status === void 0 ? "todo" : asStatus(args.status);
				if (status === "done" || status === "archived") throw new ToolError(ERR.invalidTransition, "a new task cannot start as done/archived");
				const execution = normalizeExecution(args.execution ?? {}, deps.now());
				const model = args.model !== void 0 ? checkModel(deps, args.model) : void 0;
				const isolation = args.isolation === void 0 ? void 0 : asIsolation(args.isolation);
				const presetId = args.presetId?.trim() || void 0;
				const now = deps.now();
				const task = {
					id: newTaskId(),
					title,
					description: (args.description ?? "").trim(),
					prompt: normalizePrompt(args.prompt),
					workspaceId: args.workspaceId,
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
					createdBy: actor,
					updatedBy: actor,
					comments: [],
					executions: []
				};
				await store.mutate("task-created", (ledger) => {
					ledger.tasks.push(task);
					return [task];
				});
				return json({ task: summarize(task) });
			} catch (error) {
				fail(error);
			}
		}
	})));
	disposers.push(register(defineTool({
		name: "taskboard_update",
		description: "Update a task's title/description/prompt/urgency/blocked. Requires ifVersion (read first). The model and execution config are read-only through this tool (they belong to the task owner/user).",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Task id."
			},
			ifVersion: {
				type: "number",
				required: true,
				description: "The task version you read; the write fails on mismatch."
			},
			title: {
				type: "string",
				description: "New title."
			},
			description: {
				type: "string",
				description: "New description."
			},
			prompt: {
				type: "string",
				description: "New execution prompt."
			},
			urgency: {
				type: "string",
				description: "urgent | normal | relaxed."
			},
			blocked: {
				type: "boolean",
				description: "Blocked marker (work cannot continue right now)."
			}
		},
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				const t = value.task;
				return [{
					type: "text",
					text: t === void 0 ? "更新失败。" : `已更新任务 ${t.id}，当前 v${t.version} [${t.status}]。`
				}];
			}
		},
		async execute(args, exec) {
			try {
				const { actor } = caller(exec);
				const task = store.get(args.id);
				if (task === void 0 || task.trashedAt !== void 0) throw new ToolError(ERR.notFound, `no task ${args.id}`);
				versionGuard(task, args.ifVersion);
				if (task.status === "archived") throw new ToolError(ERR.invalidTransition, "archived tasks are immutable");
				const next = structuredClone(task);
				if (args.title !== void 0) next.title = normalizeTitle(args.title);
				if (args.description !== void 0) next.description = args.description.trim();
				if (args.prompt !== void 0) next.prompt = normalizePrompt(args.prompt);
				if (args.urgency !== void 0) next.urgency = asUrgency(args.urgency);
				if (args.blocked !== void 0) next.blocked = args.blocked;
				next.version = task.version + 1;
				next.updatedAt = deps.now();
				next.updatedBy = actor;
				await store.mutate("task-updated", (ledger) => {
					const i = ledger.tasks.findIndex((t) => t.id === args.id);
					ledger.tasks[i] = next;
					return [next];
				});
				return json({ task: summarize(next) });
			} catch (error) {
				fail(error);
			}
		}
	})));
	disposers.push(register(defineTool({
		name: "taskboard_move",
		description: "Move a task between statuses (requires ifVersion). Claim = todo→in_progress (only a session inside the task's project may claim; never take over a task held by another session). After implementing and self-verifying: comment, then in_progress→in_review. You can NEVER move a task to done — that requires explicit user confirmation.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Task id."
			},
			status: {
				type: "string",
				required: true,
				description: "Target status."
			},
			ifVersion: {
				type: "number",
				required: true,
				description: "Task version you read; fails on mismatch."
			}
		},
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				const t = value.task;
				return [{
					type: "text",
					text: t === void 0 ? "移动失败。" : `任务 ${t.id} 已移到 ${t.status}，当前 v${t.version}。`
				}];
			}
		},
		async execute(args, exec) {
			try {
				const { actor } = caller(exec);
				const to = asStatus(args.status);
				const task = store.get(args.id);
				if (task === void 0 || task.trashedAt !== void 0) throw new ToolError(ERR.notFound, `no task ${args.id}`);
				versionGuard(task, args.ifVersion);
				if (to === "done") throw new ToolError(ERR.forbidden, "moving a task to done requires explicit user confirmation (GUI); agents cannot do it");
				if (!canTransition(task.status, to)) throw new ToolError(ERR.invalidTransition, `illegal transition ${task.status} → ${to}`);
				if (task.status === "in_progress" && task.claimedBy !== void 0 && task.claimedBy !== actor.sessionId) throw new ToolError(ERR.forbidden, `task is held by session ${task.claimedBy}; never take over another session's claim`);
				if (isClaim(task.status, to)) {
					if (await callerWorkspace(deps, exec) !== task.workspaceId) throw new ToolError(ERR.workspaceMismatch, "only a session inside this task's project may claim it");
				}
				const next = structuredClone(task);
				next.status = to;
				next.version = task.version + 1;
				next.updatedAt = deps.now();
				next.updatedBy = actor;
				if (isClaim(task.status, to)) next.blocked = false;
				syncClaim(next, to, deps.now(), isClaim(task.status, to) ? actor.sessionId : void 0);
				await store.mutate("task-moved", (ledger) => {
					const i = ledger.tasks.findIndex((t) => t.id === args.id);
					ledger.tasks[i] = next;
					return [next];
				});
				return json({ task: summarize(next) });
			} catch (error) {
				fail(error);
			}
		}
	})));
	disposers.push(register(defineTool({
		name: "taskboard_comment_add",
		description: "Append a progress/report comment to a task. When handing off to review, the comment should cover: what changed, how it was verified, outcome, and remaining risks.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Task id."
			},
			body: {
				type: "string",
				required: true,
				description: "Comment text (1..4000 chars)."
			}
		},
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				const v = value;
				const c = v.comment;
				const t = v.task;
				if (c === void 0 || t === void 0) return [{
					type: "text",
					text: "评论失败。"
				}];
				return [{
					type: "text",
					text: `评论 ${c.id} 已添加；任务 ${t.id} 当前 v${t.version} [${t.status}]（后续写操作用此版本号）.`
				}];
			}
		},
		async execute(args, exec) {
			try {
				const { sessionId } = caller(exec);
				const task = store.get(args.id);
				if (task === void 0 || task.trashedAt !== void 0) throw new ToolError(ERR.notFound, `no task ${args.id}`);
				const comment = {
					id: newCommentId(),
					body: normalizeBody(args.body),
					version: 1,
					createdAt: deps.now(),
					threadId: sessionId
				};
				const next = structuredClone(task);
				next.comments.push(comment);
				next.version = task.version + 1;
				next.updatedAt = deps.now();
				await store.mutate("comment-added", (ledger) => {
					const i = ledger.tasks.findIndex((t) => t.id === args.id);
					ledger.tasks[i] = next;
					return [next];
				});
				return json({
					comment,
					task: {
						id: next.id,
						version: next.version,
						status: next.status
					}
				});
			} catch (error) {
				fail(error);
			}
		}
	})));
	disposers.push(register(defineTool({
		name: "taskboard_comments",
		description: "List a task's comments, oldest first. Read them before deciding to start work.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Task id."
		} },
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				const list = value.comments;
				if (list === void 0 || list.length === 0) return [{
					type: "text",
					text: "无评论。"
				}];
				const lines = list.map((c) => {
					return `- [${c.threadId !== void 0 ? `agent ${String(c.threadId).slice(0, 24)}` : "user"} ${new Date(c.createdAt).toISOString()}] ${c.body}`;
				});
				return [{
					type: "text",
					text: `评论 ${list.length} 条：\n${lines.join("\n")}`
				}];
			}
		},
		async execute(args) {
			try {
				const task = store.get(args.id);
				if (task === void 0 || task.trashedAt !== void 0) throw new ToolError(ERR.notFound, `no task ${args.id}`);
				return json({ comments: task.comments });
			} catch (error) {
				fail(error);
			}
		}
	})));
	disposers.push(register(defineTool({
		name: "taskboard_delete",
		description: "Soft-delete a task (marks it trashed; the user confirms the purge in the GUI). Requires ifVersion. Prefer canceled/archived over delete unless the task was a mistake.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Task id."
			},
			ifVersion: {
				type: "number",
				required: true,
				description: "Task version you read."
			}
		},
		output: {
			schema: JSON_OUT,
			render: (_args, value) => {
				return [{
					type: "text",
					text: value.trashed === true ? "任务已标记删除（等待用户在 GUI 清除）。" : "删除失败。"
				}];
			}
		},
		async execute(args, exec) {
			try {
				caller(exec);
				const task = store.get(args.id);
				if (task === void 0) throw new ToolError(ERR.notFound, `no task ${args.id}`);
				versionGuard(task, args.ifVersion);
				const next = structuredClone(task);
				next.trashedAt = deps.now();
				next.version = task.version + 1;
				await store.mutate("task-deleted", (ledger) => {
					const i = ledger.tasks.findIndex((t) => t.id === args.id);
					ledger.tasks[i] = next;
					return [next];
				});
				return { trashed: true };
			} catch (error) {
				fail(error);
			}
		}
	})));
	return disposers;
}
//#endregion
export { ERR, registerTaskboardTools, workspaceFace };

//# sourceMappingURL=tools.js.map