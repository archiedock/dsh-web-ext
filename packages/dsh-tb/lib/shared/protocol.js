//#region src/shared/protocol.ts
/** Statuses shown as the five main board columns, in order. */
const MAIN_STATUSES = [
	"backlog",
	"todo",
	"in_progress",
	"in_review",
	"done"
];
/** Statuses collected under the secondary tab. */
const SECONDARY_STATUSES = ["canceled", "archived"];
/** Every valid status, main first. */
const ALL_STATUSES = [...MAIN_STATUSES, ...SECONDARY_STATUSES];
/**
* Legal forward/sideways transitions. Anything not listed is rejected with
* `invalid_transition`. `archived` is terminal.
*/
const TRANSITIONS = {
	backlog: ["todo", "canceled"],
	todo: [
		"in_progress",
		"backlog",
		"canceled"
	],
	in_progress: [
		"in_review",
		"todo",
		"canceled"
	],
	in_review: [
		"in_progress",
		"todo",
		"done",
		"canceled"
	],
	done: ["archived"],
	canceled: ["archived", "todo"],
	archived: []
};
/**
* Whether a status move is legal per the state machine.
* @param from - current status.
* @param to - requested status.
* @returns true when the transition is allowed.
*/
function canTransition(from, to) {
	return TRANSITIONS[from].includes(to);
}
/**
* The claim move: the one transition that transfers ownership of a task to
* the calling session. Guarded by the project (workspace) boundary in the
* tool layer.
*/
function isClaim(from, to) {
	return from === "todo" && to === "in_progress";
}
/** All valid urgency values. */
const URGENCIES = [
	"urgent",
	"normal",
	"relaxed"
];
/** Validate an isolation value. */
function asIsolation(raw) {
	if (raw !== "worktree" && raw !== "none") throw new Error("isolation must be 'worktree' or 'none'");
	return raw;
}
/** Resolve a task's effective isolation (omitted → the worktree default). */
function effectiveIsolation(task) {
	return task.isolation === void 0 ? "worktree" : task.isolation;
}
/**
* Parse a five-field cron expression. Supported field syntax: star, star/step
* (`* / n` without spaces), a single number, an `a-b` range, and comma lists
* of those. Day-of-week accepts both 0 and 7 as Sunday (normalized to 0).
*
* @param expr - the expression to parse.
* @returns the match sets per field, or null when invalid.
*/
function parseCron(expr) {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const ranges = [
		[0, 59],
		[0, 23],
		[1, 31],
		[1, 12],
		[0, 7]
	];
	const sets = [];
	for (let i = 0; i < 5; i++) {
		const [min, max] = ranges[i];
		const set = /* @__PURE__ */ new Set();
		if (!parseCronField(fields[i], min, max, set)) return null;
		sets.push(set);
	}
	const weekdays = /* @__PURE__ */ new Set();
	for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day);
	return {
		minutes: sets[0],
		hours: sets[1],
		days: sets[2],
		months: sets[3],
		weekdays
	};
}
/** Parse one cron field into a match set; false on any syntax error. */
function parseCronField(field, min, max, out) {
	for (const part of field.split(",")) {
		const [range, stepRaw] = part.split("/");
		const step = stepRaw === void 0 ? 1 : Number.parseInt(stepRaw, 10);
		if (!Number.isInteger(step) || step < 1) return false;
		let lo;
		let hi;
		if (range === void 0 || range === "") return false;
		if (range === "*") {
			lo = min;
			hi = max;
		} else if (range.includes("-")) {
			const [a, b] = range.split("-");
			lo = Number.parseInt(a ?? "", 10);
			hi = Number.parseInt(b ?? "", 10);
			if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
		} else {
			lo = Number.parseInt(range, 10);
			if (!Number.isInteger(lo)) return false;
			hi = stepRaw === void 0 ? lo : max;
		}
		if (lo < min || hi > max || lo > hi) return false;
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	return out.size > 0;
}
/**
* The next time at or after `from` matching the cron sets (local time),
* or null when no match exists within four years (e.g. Feb 30).
* @param match - parsed cron sets.
* @param from - epoch ms start point (inclusive match candidate).
* @returns the next match's epoch ms, or null.
*/
function nextCronTime(match, from) {
	const start = new Date(from);
	start.setSeconds(0, 0);
	start.setMinutes(start.getMinutes() + 1);
	const cap = from + 4 * 366 * 24 * 60 * 60 * 1e3;
	let t = start.getTime();
	while (t <= cap) {
		const d = new Date(t);
		if (match.months.has(d.getMonth() + 1) && match.days.has(d.getDate()) && match.weekdays.has(d.getDay()) && match.hours.has(d.getHours()) && match.minutes.has(d.getMinutes())) return t;
		t += 6e4;
	}
	return null;
}
/**
* Enforce the execution-record retention cap on one task (in place): keep the
* newest {@link MAX_EXECUTIONS} records, count the dropped ones in
* `executionsPruned`. Running records are always the newest, never dropped.
* @param task - the task to prune.
*/
function pruneExecutions(task) {
	if (task.executions.length <= 20) return;
	const dropped = task.executions.length - 20;
	task.executions = task.executions.slice(-20);
	task.executionsPruned = (task.executionsPruned ?? 0) + dropped;
}
/** An empty ledger. */
function emptyLedger() {
	return {
		schemaVersion: 1,
		revision: 0,
		tasks: []
	};
}
/** Random base36 suffix. */
function suffix() {
	return Math.random().toString(36).slice(2, 8);
}
/** Mint a task id. */
function newTaskId() {
	return `t-${Date.now().toString(36)}-${suffix()}`;
}
/** Mint a comment id. */
function newCommentId() {
	return `c-${Date.now().toString(36)}-${suffix()}`;
}
/** Mint an execution id. */
function newExecutionId() {
	return `e-${Date.now().toString(36)}-${suffix()}`;
}
/**
* Validate and normalize a title: trimmed, 1..200 chars.
* @param raw - the raw input.
* @returns the normalized title.
* @throws when empty or too long.
*/
function normalizeTitle(raw) {
	const t = raw.trim();
	if (t.length === 0 || t.length > 200) throw new Error("title must be 1..200 characters");
	return t;
}
/**
* Validate a task prompt: trimmed, at most 8000 chars; empty becomes ''.
* @param raw - the raw input.
*/
function normalizePrompt(raw) {
	const t = (raw ?? "").trim();
	if (t.length > 8e3) throw new Error("prompt must be at most 8000 characters");
	return t;
}
/**
* Validate and normalize a comment body: trimmed, 1..4000 chars.
* @param raw - the raw input.
*/
function normalizeBody(raw) {
	const t = raw.trim();
	if (t.length === 0 || t.length > 4e3) throw new Error("comment body must be 1..4000 characters");
	return t;
}
/**
* Validate an urgency value.
* @param raw - the raw input.
*/
function asUrgency(raw) {
	if (!URGENCIES.includes(raw)) throw new Error(`urgency must be one of: ${URGENCIES.join(", ")}`);
	return raw;
}
/**
* Validate a status value.
* @param raw - the raw input.
*/
function asStatus(raw) {
	if (!ALL_STATUSES.includes(raw)) throw new Error(`status must be one of: ${ALL_STATUSES.join(", ")}`);
	return raw;
}
/**
* Validate an execution config request from raw tool/route input.
* `scheduled` requires a valid cron; computes the first `nextRunAt` from
* `now`.
* @param raw - raw execution input ({@link ExecutionConfig} fields, untyped).
* @param now - current epoch ms.
* @returns the normalized config.
*/
function normalizeExecution(raw, now) {
	const mode = raw.mode ?? "claim";
	if (mode !== "claim" && mode !== "scheduled") throw new Error("execution.mode must be 'claim' or 'scheduled'");
	if (mode === "claim") return { mode };
	const cron = (raw.cron ?? "").trim();
	const match = parseCron(cron);
	if (match === null) throw new Error("execution.cron is not a valid 5-field cron expression");
	const next = nextCronTime(match, now);
	if (next === null) throw new Error("execution.cron never matches within 4 years");
	return {
		mode,
		cron,
		nextRunAt: next
	};
}
/**
* The effective prompt of a task: explicit prompt, or title+description.
* @param task - the task.
*/
function effectivePrompt(task) {
	if (task.prompt.length > 0) return task.prompt;
	const head = task.title;
	return task.description.length > 0 ? `${head}\n\n${task.description}` : head;
}
/**
* Whether the task is currently claimed by a session (running state).
* @param task - the task.
*/
function isClaimedBy(task) {
	return task.status === "in_progress" && task.claimedBy !== void 0 ? task.claimedBy : void 0;
}
/**
* Maintain the explicit claim fields around a status change: entering
* in_progress under a session records the holder (an execution-start or an
* agent claim); every move out of in_progress releases the claim (handoff,
* give-back, cancel). A user-driven move into in_progress records no holder —
* no session works on it yet.
* @param task - the task being written (mutated in place).
* @param to - the target status.
* @param now - current epoch ms.
* @param holder - the session id claiming the task, when applicable.
*/
function syncClaim(task, to, now, holder) {
	if (to !== "in_progress") {
		delete task.claimedBy;
		delete task.claimedAt;
	} else if (holder !== void 0) {
		task.claimedBy = holder;
		task.claimedAt = now;
	}
}
/**
* Validate and normalize a pinned model: `{ provider, model }`, both
* non-empty trimmed strings.
* @param raw - the raw input.
* @returns the normalized model.
* @throws when the shape or the fields are invalid.
*/
function normalizeModel(raw) {
	if (typeof raw !== "object" || raw === null) throw new Error("model must be { provider: string, model: string }");
	const { provider, model } = raw;
	if (typeof provider !== "string" || typeof model !== "string") throw new Error("model must be { provider: string, model: string }");
	const p = provider.trim();
	const m = model.trim();
	if (p.length === 0 || m.length === 0) throw new Error("model.provider and model.model must be non-empty strings");
	return {
		provider: p,
		model: m
	};
}
/**
* Build the compact summary of a task.
* @param task - the task.
*/
function summarize(task) {
	const last = task.executions.length > 0 ? task.executions[task.executions.length - 1] : void 0;
	return {
		id: task.id,
		title: task.title,
		workspaceId: task.workspaceId,
		urgency: task.urgency,
		status: task.status,
		blocked: task.blocked,
		executionMode: task.execution.mode,
		nextRunAt: task.execution.nextRunAt,
		model: task.model,
		version: task.version,
		claimOwner: isClaimedBy(task),
		commentCount: task.comments.length,
		lastExecutionOutcome: last?.outcome,
		trashed: task.trashedAt !== void 0
	};
}
//#endregion
export { ALL_STATUSES, MAIN_STATUSES, SECONDARY_STATUSES, URGENCIES, asIsolation, asStatus, asUrgency, canTransition, effectiveIsolation, effectivePrompt, emptyLedger, isClaim, isClaimedBy, newCommentId, newExecutionId, newTaskId, nextCronTime, normalizeBody, normalizeExecution, normalizeModel, normalizePrompt, normalizeTitle, parseCron, pruneExecutions, summarize, syncClaim };

//# sourceMappingURL=protocol.js.map