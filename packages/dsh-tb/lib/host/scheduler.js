import { nextCronTime, parseCron } from "../shared/protocol.js";
import "./execution.js";
//#region src/host/scheduler.ts
/**
* Host-side cron scheduler: one tick per minute over the ledger's scheduled
* tasks. A due task (nextRunAt reached, not running, not trashed) first has
* its next run advanced to the next cron match — then it executes through
* the same path as the manual button. Missed windows (host was down, tab
* closed — irrelevant here, this is the host process) simply advance: a
* nextRunAt more than one window in the past is skipped, not caught up.
*
* @module dsh-taskboard/host/scheduler
*/
/** Tick cadence. */
const TICK_MS = 6e4;
/** A due window older than this is skipped (missed while the host was down). */
const SKIP_AFTER_MS = 5 * 6e4;
/**
* The cron scheduler.
*/
var SchedulerService = class {
	deps;
	handle;
	catchup;
	/** @param deps - store + execution + clock. */
	constructor(deps) {
		this.deps = deps;
	}
	/** Start ticking. */
	start() {
		const timers = this.deps.timers ?? {
			setInterval: (fn, ms) => setInterval(fn, ms),
			clearInterval: (handle) => clearInterval(handle)
		};
		this.handle = timers.setInterval(() => {
			this.tick();
		}, TICK_MS);
		this.catchup = setTimeout(() => {
			this.tick();
		}, 3e3);
	}
	/** Stop ticking. */
	dispose() {
		if (this.catchup !== void 0) {
			clearTimeout(this.catchup);
			this.catchup = void 0;
		}
		if (this.handle === void 0) return;
		(this.deps.timers ?? { clearInterval: (h) => clearInterval(h) }).clearInterval(this.handle);
		this.handle = void 0;
	}
	/** One scheduler pass (exported for tests). */
	async tick() {
		await this.deps.store.load();
		const now = this.deps.now();
		const ledger = this.deps.store.snapshot();
		const atCapacity = this.deps.execution.inFlight() >= (this.deps.maxConcurrent ?? 3);
		for (const task of ledger.tasks) {
			if (task.execution.mode !== "scheduled" || task.execution.cron === void 0) continue;
			if (task.execution.nextRunAt === void 0) continue;
			if (task.status === "in_progress" || task.trashedAt !== void 0) continue;
			if (task.execution.nextRunAt > now) continue;
			if (atCapacity) continue;
			const missed = now - task.execution.nextRunAt > SKIP_AFTER_MS;
			await this.advance(task.id, now);
			if (missed) continue;
			const lastTriggeredAt = task.execution.nextRunAt;
			await this.markTriggered(task.id, lastTriggeredAt);
			await this.deps.execution.run(task.id, "scheduled").catch((error) => {
				console.error("[dsh-taskboard] scheduled run failed:", error);
			});
		}
	}
	/** Recompute and persist the next run for one scheduled task. */
	async advance(taskId, now) {
		await this.deps.store.mutate("task-updated", (ledger) => {
			const task = ledger.tasks.find((t) => t.id === taskId);
			if (task === void 0 || task.execution.cron === void 0) return void 0;
			const match = parseCron(task.execution.cron);
			const next = match === null ? void 0 : nextCronTime(match, now) ?? void 0;
			if (next === void 0) return void 0;
			task.execution.nextRunAt = next;
			return [task];
		});
	}
	/** Record the trigger instant on the task. */
	async markTriggered(taskId, at) {
		if (at === void 0) return;
		await this.deps.store.mutate("task-updated", (ledger) => {
			const task = ledger.tasks.find((t) => t.id === taskId);
			if (task === void 0) return void 0;
			task.execution.lastTriggeredAt = at;
			return [task];
		});
	}
};
//#endregion
export { SchedulerService };

//# sourceMappingURL=scheduler.js.map