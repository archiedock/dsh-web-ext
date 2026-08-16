window.__ModuleLoader__.load({
	id: "dsh-taskboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react_dom_client = require("react-dom/client");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region src/client/api.ts
		/** Unwrap the envelope or throw a readable error. */
		async function unwrap(pending) {
			const res = await pending;
			const body = await res.json().catch(() => null);
			if (body === null) throw new Error(`taskboard: HTTP ${res.status}`);
			if (!body.ok) throw new Error(`taskboard: ${body.error.code}: ${body.error.message}`);
			return body.value;
		}
		async function post(path, body) {
			return unwrap(await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			}));
		}
		/** Build the client over fetch + EventSource. */
		function createClient() {
			return {
				state: () => unwrap(fetch("/dsh-taskboard/state")),
				workspaces: () => unwrap(fetch("/dsh-taskboard/workspaces")),
				create: (body) => post("/dsh-taskboard/tasks", body),
				get: (id) => unwrap(fetch(`/dsh-taskboard/tasks/${encodeURIComponent(id)}`)),
				update: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/update`, body),
				move: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/move`, body),
				reject: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/reject`, body),
				comment: (id, bodyText) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/comment`, { body: bodyText }),
				remove: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/delete`, body),
				run: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/run`, body ?? {}),
				cancel: (id) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/cancel`, {}),
				mergeBranch: (id) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/merge`, {}),
				worktreeRemove: (id, body) => post(`/dsh-taskboard/tasks/${encodeURIComponent(id)}/worktree-remove`, body),
				diagnostics: () => unwrap(fetch("/dsh-taskboard/diagnostics")),
				worktreeCleanup: (workspaceId, taskId) => post("/dsh-taskboard/worktree-cleanup", {
					workspaceId,
					taskId
				}),
				stream(onChange, onGap) {
					const es = new EventSource("/dsh-taskboard/events");
					let revision;
					const hello = (event) => {
						const payload = JSON.parse(event.data);
						if (revision !== void 0 && payload.revision !== revision) onGap();
						revision = payload.revision;
					};
					const change = (event) => {
						const payload = JSON.parse(event.data);
						if (revision !== void 0 && payload.revision !== revision + 1) onGap();
						revision = payload.revision;
						onChange(payload);
					};
					es.addEventListener("hello", hello);
					es.addEventListener("change", change);
					es.onerror = () => {};
					return () => {
						es.close();
					};
				}
			};
		}

		//#endregion
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
		/** Current ledger format version. */
		const LEDGER_SCHEMA_VERSION = 1;
		/** An empty ledger. */
		function emptyLedger() {
			return {
				schemaVersion: 1,
				revision: 0,
				tasks: []
			};
		}

		//#endregion
		//#region src/client/controller.ts
		/** localStorage key for persisted view state (filters + sort). */
		const VIEW_KEY = "dsh-taskboard-view-v1";
		/** localStorage key for the remembered isolation toggle choice (0.3.0). */
		const ISOLATION_KEY = "dsh-taskboard-isolation-v1";
		/** Load the remembered default isolation (worktree unless explicitly turned off). */
		function loadDefaultIsolation() {
			try {
				return localStorage.getItem(ISOLATION_KEY) === "none" ? "none" : "worktree";
			} catch {
				return "worktree";
			}
		}
		/** Remember the isolation toggle choice across forms (best effort). */
		function saveDefaultIsolation(mode) {
			try {
				localStorage.setItem(ISOLATION_KEY, mode);
			} catch {}
		}
		/** Load the persisted view state (never throws; fresh on any parse error). */
		function loadView() {
			try {
				const raw = localStorage.getItem(VIEW_KEY);
				if (raw === null) return {
					urgencies: [],
					sortBy: "default"
				};
				const parsed = JSON.parse(raw);
				const sortBy = parsed.sortBy === "updated" || parsed.sortBy === "urgency" || parsed.sortBy === "created" ? parsed.sortBy : "default";
				return {
					workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : void 0,
					urgencies: Array.isArray(parsed.urgencies) ? parsed.urgencies.filter((u) => u === "urgent" || u === "normal" || u === "relaxed") : [],
					sortBy
				};
			} catch {
				return {
					urgencies: [],
					sortBy: "default"
				};
			}
		}
		/** Instantiate the default state (view state hydrated from localStorage). */
		function initialState() {
			const view = loadView();
			return {
				boardOpen: false,
				ledger: emptyLedger(),
				workspaces: [],
				filters: {
					workspaceId: view.workspaceId,
					urgencies: view.urgencies
				},
				search: "",
				sortBy: view.sortBy,
				composerOpen: false,
				secondaryOpen: false,
				diagOpen: false
			};
		}
		/**
		* The board controller.
		*/
		var BoardController = class {
			client;
			state = initialState();
			subscribers = /* @__PURE__ */ new Set();
			disposed = false;
			disposeStream;
			refreshInFlight;
			sessionJumper;
			/** @param client - the route client. */
			constructor(client) {
				this.client = client;
			}
			/** Current snapshot (render input). */
			getSnapshot() {
				return this.state;
			}
			/** Subscribe; returns unsubscribe. */
			subscribe(fn) {
				this.subscribers.add(fn);
				return () => this.subscribers.delete(fn);
			}
			emit() {
				if (this.disposed) return;
				for (const fn of this.subscribers) fn();
			}
			setState(patch) {
				this.state = {
					...this.state,
					...patch
				};
				this.emit();
			}
			/** Start subscriptions; call once after construction. */
			start() {
				this.refresh();
				this.disposeStream = this.client.stream((change) => {
					this.setState({ ledger: {
						...this.state.ledger,
						revision: change.revision
					} });
					this.refresh();
				}, () => {
					this.refresh();
				});
			}
			/** Full refetch (state + workspaces + open detail). */
			async refresh() {
				if (this.refreshInFlight !== void 0) return this.refreshInFlight;
				this.refreshInFlight = (async () => {
					try {
						const [ledger, workspaces] = await Promise.all([this.client.state(), this.client.workspaces()]);
						let selected;
						if (this.state.selectedId !== void 0) selected = ledger.tasks.find((t) => t.id === this.state.selectedId);
						this.setState({
							ledger,
							workspaces,
							error: void 0,
							selectedId: selected === void 0 ? void 0 : this.state.selectedId
						});
					} catch (error) {
						this.setState({ error: error instanceof Error ? error.message : String(error) });
					} finally {
						this.refreshInFlight = void 0;
					}
				})();
				return this.refreshInFlight;
			}
			/** Stop everything. */
			dispose() {
				this.disposed = true;
				this.disposeStream?.();
				this.subscribers.clear();
			}
			/** Open the board (sidebar entry). */
			openBoard() {
				this.setState({ boardOpen: true });
			}
			/** Close the board. */
			closeBoard() {
				this.setState({ boardOpen: false });
			}
			/** Toggle the board. */
			toggleBoard() {
				this.setState({ boardOpen: !this.state.boardOpen });
			}
			/** Set the project filter (persisted). */
			setWorkspaceFilter(workspaceId) {
				this.setState({ filters: {
					...this.state.filters,
					workspaceId
				} });
				this.persistView();
			}
			/** Toggle one urgency chip (persisted). */
			toggleUrgency(urgency) {
				const set = new Set(this.state.filters.urgencies);
				if (set.has(urgency)) set.delete(urgency);
				else set.add(urgency);
				this.setState({ filters: {
					...this.state.filters,
					urgencies: [...set]
				} });
				this.persistView();
			}
			/** Set the free-text search (transient — not persisted). */
			setSearch(search) {
				this.setState({ search });
			}
			/** Set the column sort order (persisted). */
			setSortBy(sortBy) {
				this.setState({ sortBy });
				this.persistView();
			}
			/** Write the current view state to localStorage (best effort). */
			persistView() {
				try {
					localStorage.setItem(VIEW_KEY, JSON.stringify({
						workspaceId: this.state.filters.workspaceId,
						urgencies: this.state.filters.urgencies,
						sortBy: this.state.sortBy
					}));
				} catch {}
			}
			/** Select a task (open detail). */
			select(id) {
				this.setState({ selectedId: id });
			}
			/** Show/hide the task form (create mode when opening). */
			setComposer(open) {
				this.setState({
					composerOpen: open,
					editingId: void 0
				});
			}
			/** Open the form modal editing an existing task. */
			openEditor(id) {
				this.setState({
					composerOpen: true,
					editingId: id
				});
			}
			/** Close the form modal whatever its mode. */
			closeForm() {
				this.setState({
					composerOpen: false,
					editingId: void 0
				});
			}
			/** Toggle the secondary tab. */
			toggleSecondary() {
				this.setState({ secondaryOpen: !this.state.secondaryOpen });
			}
			/** Whether a workspace passed git detection (form toggle enablement). */
			gitAvailable(workspaceId) {
				if (workspaceId === void 0) return true;
				return this.state.workspaces.find((w) => w.id === workspaceId)?.gitAvailable === true;
			}
			/**
			* Install the session-jump bridge (built from the runtime sessions service
			* by the client entry). Without it openSession reports 'unavailable'.
			* @param jumper - the jump function from createSessionJumper.
			*/
			installSessionJumper(jumper) {
				this.sessionJumper = jumper;
			}
			/**
			* Jump to an execution's session (open it in the GUI). On success the board
			* closes so the conversation shows; a deleted-or-archived session reports
			* 'missing' for the caller to prompt about.
			* @param sessionId - the execution's session id.
			* @returns the jump outcome.
			*/
			async openSession(sessionId) {
				if (this.sessionJumper === void 0) return "unavailable";
				let result;
				try {
					result = await this.sessionJumper(sessionId);
				} catch {
					return "unavailable";
				}
				if (result === "opened") this.closeBoard();
				return result;
			}
			/** Create a task (composer submit); returns the new task id, undefined on failure. */
			async create(body) {
				try {
					const summary = await this.client.create(body);
					this.setState({
						composerOpen: false,
						error: void 0
					});
					await this.refresh();
					return summary.id;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return;
				}
			}
			/** Edit task fields (form modal submit; the GUI is the owner surface). */
			async update(id, ifVersion, body) {
				try {
					await this.client.update(id, {
						ifVersion,
						...body
					});
					this.setState({
						composerOpen: false,
						editingId: void 0,
						error: void 0
					});
					await this.refresh();
					return true;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}
			/** Move a task (user surface: done allowed). */
			async move(id, ifVersion, status) {
				try {
					await this.client.move(id, {
						ifVersion,
						status
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/**
			* Quick-reject (card ✗ button): move back to todo with an optional user
			* comment, committed atomically host-side. Returns whether the task moved.
			* @param id - task id.
			* @param ifVersion - optimistic version (captured at click time).
			* @param comment - optional comment text; blank = move only.
			*/
			async reject(id, ifVersion, comment) {
				const body = comment !== void 0 && comment.trim().length > 0 ? comment.trim() : void 0;
				try {
					await this.client.reject(id, body === void 0 ? { ifVersion } : {
						ifVersion,
						body
					});
					await this.refresh();
					return true;
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
					return false;
				}
			}
			/** Toggle the blocked marker. */
			async toggleBlocked(task) {
				try {
					await this.client.update(task.id, {
						ifVersion: task.version,
						blocked: !task.blocked
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Append a user comment. */
			async comment(id, body) {
				try {
					await this.client.comment(id, body);
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Trigger a manual run (fresh in-project session, pinned model); `reuse` = 续跑. */
			async run(id, reuse = false) {
				try {
					await this.client.run(id, reuse ? { reuse: true } : {});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Cancel the running execution (stops the agent session; task returns to todo). */
			async cancel(id) {
				try {
					await this.client.cancel(id);
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/**
			* ⇥ 合并 (detail page): merge the task branch into the main worktree.
			* @returns the outcome; `noop` means the branch had no new commits (nothing merged).
			*/
			async mergeBranch(id) {
				try {
					const value = await this.client.mergeBranch(id);
					await this.refresh();
					return value.noop === true ? {
						ok: true,
						noop: true
					} : { ok: true };
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
			/**
			* 🗑 删除 worktree (detail page), optionally deleting the task branch too.
			* @returns the outcome; failures carry the git message for an alert.
			*/
			async removeWorktree(id, deleteBranch) {
				try {
					const value = await this.client.worktreeRemove(id, { deleteBranch });
					await this.refresh();
					return value.branchError !== void 0 ? {
						ok: true,
						branchError: value.branchError
					} : { ok: true };
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
			/** Open the ⚙ diagnostics panel and fetch a fresh snapshot. */
			openDiagnostics() {
				this.setState({ diagOpen: true });
				this.client.diagnostics().then((diagnostics) => this.setState({ diagnostics })).catch((error) => this.setState({ error: error instanceof Error ? error.message : String(error) }));
			}
			/** Close the ⚙ diagnostics panel. */
			closeDiagnostics() {
				this.setState({ diagOpen: false });
			}
			/** Clean one orphan worktree (⚙ panel); refreshes the diagnostics payload. */
			async cleanupOrphan(workspaceId, taskId) {
				try {
					await this.client.worktreeCleanup(workspaceId, taskId);
					const diagnostics = await this.client.diagnostics();
					this.setState({
						diagnostics,
						error: void 0
					});
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Soft-delete (agent parity) then optional purge. */
			async remove(id, ifVersion, purge) {
				try {
					await this.client.remove(id, purge ? { purge: true } : { ifVersion });
					if (purge) this.setState({ selectedId: void 0 });
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Duplicate a task into a fresh todo card (same project/urgency/prompt/execution/model/isolation). */
			async duplicate(task) {
				try {
					await this.client.create({
						title: `${task.title}（副本）`,
						workspaceId: task.workspaceId,
						urgency: task.urgency,
						description: task.description.length > 0 ? task.description : void 0,
						prompt: task.prompt.length > 0 ? task.prompt : void 0,
						execution: task.execution.mode === "scheduled" && task.execution.cron !== void 0 ? {
							mode: "scheduled",
							cron: task.execution.cron
						} : { mode: "claim" },
						model: task.model,
						isolation: task.isolation,
						...task.presetId !== void 0 ? { presetId: task.presetId } : {}
					});
					await this.refresh();
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
			/** Download the whole ledger as a JSON backup file. */
			exportJson() {
				const stamp = /* @__PURE__ */ new Date();
				const pad = (n) => String(n).padStart(2, "0");
				const name = `dsh-taskboard-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`;
				const body = JSON.stringify(this.state.ledger, null, 2);
				this.download(name, body, "application/json");
			}
			/** Download the task list as a CSV (BOM-prefixed for Excel + Chinese text). */
			exportCsv() {
				const esc = (v) => {
					const s = String(v ?? "");
					return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
				};
				const header = [
					"id",
					"title",
					"status",
					"urgency",
					"blocked",
					"project",
					"claimedBy",
					"mode",
					"cron",
					"nextRunAt",
					"model",
					"createdAt",
					"updatedAt",
					"comments",
					"executions"
				];
				const rows = this.state.ledger.tasks.map((t) => [
					t.id,
					t.title,
					t.status,
					t.urgency,
					t.blocked ? "yes" : "no",
					t.workspaceId,
					t.claimedBy ?? "",
					t.execution.mode,
					t.execution.cron ?? "",
					t.execution.nextRunAt !== void 0 ? new Date(t.execution.nextRunAt).toISOString() : "",
					t.model !== void 0 ? `${t.model.provider}/${t.model.model}` : "",
					new Date(t.createdAt).toISOString(),
					new Date(t.updatedAt).toISOString(),
					t.comments.length,
					t.executions.length
				].map(esc).join(","));
				const stamp = /* @__PURE__ */ new Date();
				const pad = (n) => String(n).padStart(2, "0");
				const name = `dsh-taskboard-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.csv`;
				this.download(name, `\uFEFF${[header.join(","), ...rows].join("\r\n")}`, "text/csv");
			}
			/** Trigger a browser download (no-op when the DOM is unavailable). */
			download(filename, body, type) {
				try {
					const blob = new Blob([body], { type });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = filename;
					a.click();
					setTimeout(() => URL.revokeObjectURL(url), 5e3);
				} catch (error) {
					this.setState({ error: error instanceof Error ? error.message : String(error) });
				}
			}
		};

		//#endregion
		//#region src/client/styles.ts
		/**
		* Board styles, injected as one global stylesheet with dsh-atb- prefixed
		* classes. Colors ride the shell's --dsw-* design tokens where available so
		* the board follows the active theme/skin; urgency accents are the fixed
		* red/purple/blue of the protocol.
		*
		* @module dsh-taskboard/client/styles
		*/
		/** The stylesheet text. */
		const STYLES = `
		.dsh-atb-entry {
		  display: flex; align-items: center; gap: 8px; position: relative;
		  width: calc(100% - 8px); margin: 2px 4px; padding: 6px 10px;
		  border: none; border-radius: 8px; background: transparent;
		  color: var(--dsw-text-secondary, inherit); font: inherit; font-size: 13px;
		  cursor: pointer; text-align: left;
		}
		.dsh-atb-entry:hover { background: var(--dsw-hover, rgba(128,128,128,.12)); color: var(--dsw-text-primary, inherit); }
		.dsh-atb-entry[data-active="true"] { background: var(--dsw-active, rgba(128,128,128,.18)); color: var(--dsw-text-primary, inherit); font-weight: 500; }
		.dsh-atb-entry svg { flex: none; }
		/* Status strip on the entry row's right: todo|in_progress|in_review counts. */
		.dsh-atb-entry-stats {
		  margin-left: auto; display: inline-flex; align-items: center; gap: 3px;
		  font-size: 11px; line-height: 1; color: var(--dsw-text-secondary, gray);
		  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: help;
		}
		.dsh-atb-entry-sep { opacity: .5; }
		/* Each rolling count wears its status color (todo blue | in_progress orange |
		   in_review purple); the separators stay in the strip's neutral gray. */
		.dsh-atb-roll[data-stat="todo"] { color: #3e63dd; }
		.dsh-atb-roll[data-stat="in_progress"] { color: #d9822b; }
		.dsh-atb-roll[data-stat="in_review"] { color: #8e4ec6; }
		/* One rolling number: fixed one-line window, overflow hidden. */
		.dsh-atb-roll {
		  position: relative; display: inline-block; overflow: hidden;
		  height: 12px; min-width: 1ch; text-align: center; vertical-align: middle;
		}
		.dsh-atb-rn { display: block; height: 12px; line-height: 12px; text-align: center; }
		/* The incoming value sits just outside the window (below for up-scroll). */
		.dsh-atb-rn-next { position: absolute; left: 0; right: 0; top: 100%; }
		.dsh-atb-roll[data-dir="down"] .dsh-atb-rn-next { top: auto; bottom: 100%; }
		.dsh-atb-roll .dsh-atb-rn { transition: transform .3s cubic-bezier(.25, .1, .25, 1); }
		.dsh-atb-roll[data-anim="1"][data-dir="up"] .dsh-atb-rn { transform: translateY(-100%); }
		.dsh-atb-roll[data-anim="1"][data-dir="down"] .dsh-atb-rn { transform: translateY(100%); }
		@media (prefers-reduced-motion: reduce) {
		  .dsh-atb-roll .dsh-atb-rn { transition: none; }
		}
		.dsh-atb-search { width: 130px; }
		.dsh-atb-badge[data-kind="stale"] { background: rgba(217,130,43,.15); color: #d9822b; }
		/* Mobile-only controls: the shell's own sidebar-toggle lives in the session
		   header, which the board-active rule hides on narrow screens (dsh-mobile-nav
		   uses the same 1023px breakpoint). Show in-board fallbacks there. */
		.dsh-atb-mobile-only { display: none; }
		@media (max-width: 1023px) {
		  .dsh-atb-mobile-nav { display: inline-flex; gap: 6px; }
		}

		html[data-dsh-atb-active] [data-pane="conversation"] > *:not([data-dsh-atb-view]),
		html[data-dsh-atb-active] [class*="centerCol"] > *:not([data-dsh-atb-view]) { display: none !important; }
		.dsh-atb-view { display: none; }
		html[data-dsh-atb-active] .dsh-atb-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

		.dsh-atb-board { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 12px 16px; gap: 10px; box-sizing: border-box; }
		.dsh-atb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.dsh-atb-title { font-size: 15px; font-weight: 600; margin: 0; }
		.dsh-atb-count { font-size: 12px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-ver {
		  font-size: 11px; color: var(--dsw-text-secondary, gray);
		  font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer;
		  text-decoration: none;
		  padding: 1px 9px; border-radius: 999px;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.1));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.22));
		  transition: border-color .12s ease, color .12s ease;
		}
		.dsh-atb-ver:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.6)); color: inherit; }
		.dsh-atb-spacer { flex: 1; }
		.dsh-atb-select, .dsh-atb-input {
		  font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 7px;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.35));
		  background: var(--dsw-bg, transparent); color: inherit;
		}
		.dsh-atb-chip {
		  display: inline-flex; align-items: center; gap: 5px;
		  font-size: 12px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.35));
		  background: transparent; color: var(--dsw-text-secondary, inherit);
		}
		.dsh-atb-chip[data-on="true"] { color: #fff; border-color: transparent; }
		.dsh-atb-chip[data-urgency="urgent"][data-on="true"] { background: #e5484d; }
		.dsh-atb-chip[data-urgency="normal"][data-on="true"] { background: #8e4ec6; }
		.dsh-atb-chip[data-urgency="relaxed"][data-on="true"] { background: #3e63dd; }
		.dsh-atb-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
		.dsh-atb-dot[data-urgency="urgent"] { background: #e5484d; }
		.dsh-atb-dot[data-urgency="normal"] { background: #8e4ec6; }
		.dsh-atb-dot[data-urgency="relaxed"] { background: #3e63dd; }
		/* Status dots (column heads): one fixed color per lifecycle status, matching
		   the detail pane's status pills. Canceled/archived share the resting gray;
		   trashed (pending purge) keeps the red of the 待清除 badge. */
		.dsh-atb-dot[data-status="backlog"] { background: #8a8f98; }
		.dsh-atb-dot[data-status="todo"] { background: #3e63dd; }
		.dsh-atb-dot[data-status="in_progress"] { background: #d9822b; }
		.dsh-atb-dot[data-status="in_review"] { background: #8e4ec6; }
		.dsh-atb-dot[data-status="done"] { background: #2ea043; }
		.dsh-atb-dot[data-status="canceled"], .dsh-atb-dot[data-status="archived"] { background: #8a8f98; }
		.dsh-atb-dot[data-status="trashed"] { background: #e5484d; }

		.dsh-atb-btn {
		  font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 7px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.35));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.08)); color: inherit;
		}
		.dsh-atb-btn:hover { background: var(--dsw-hover, rgba(128,128,128,.18)); }
		.dsh-atb-btn:disabled { opacity: .45; cursor: default; }
		.dsh-atb-btn[data-primary="true"] { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
		.dsh-atb-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary, #e5484d); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 45%, transparent); }

		.dsh-atb-columns { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 10px; flex: 1; min-height: 0; overflow-x: auto; }

		.dsh-atb-detailpanel {
		  display: flex; flex-direction: column;
		  flex: none; max-height: 55%; min-height: 180px; overflow: hidden;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.25)); border-radius: 12px;
		  background: var(--dsw-bg-panel, var(--dsw-bg-elevated, rgba(128,128,128,.05)));
		  padding: 10px 12px; box-shadow: 0 -4px 18px rgba(0,0,0,.12);
		}
		.dsh-atb-detailpanel .dsh-atb-detail { flex: 1; min-height: 0; }
		.dsh-atb-column { display: flex; flex-direction: column; min-width: 200px; min-height: 0; border-radius: 10px; background: var(--dsw-bg-inset, rgba(128,128,128,.07)); padding: 8px; gap: 8px; }
		.dsh-atb-colhead { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; padding: 2px 4px; }
		.dsh-atb-colcount { font-size: 11px; font-weight: 400; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-cards { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; flex: 1; padding: 2px; }

		.dsh-atb-card {
		  position: relative; border-radius: 9px; padding: 8px 10px 8px 13px; cursor: pointer;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.1));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.25));
		  font-size: 13px; text-align: left; color: inherit; width: 100%; box-sizing: border-box;
		}
		.dsh-atb-card:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.55)); }
		.dsh-atb-card[draggable="true"] { cursor: grab; }
		.dsh-atb-card[data-dragging] { opacity: .45; }
		.dsh-atb-column[data-dragover] { outline: 2px dashed var(--dsw-border-strong, rgba(128,128,128,.55)); outline-offset: -2px; background: var(--dsw-bg-hover, rgba(128,128,128,.12)); }
		.dsh-atb-card::before {
		  content: ""; position: absolute; left: 4px; top: 6px; bottom: 6px; width: 3.5px; border-radius: 3px;
		}
		.dsh-atb-card[data-urgency="urgent"]::before { background: #e5484d; }
		.dsh-atb-card[data-urgency="normal"]::before { background: #8e4ec6; }
		.dsh-atb-card[data-urgency="relaxed"]::before { background: #3e63dd; }
		.dsh-atb-card-title { font-weight: 550; line-height: 1.35; word-break: break-word; }
		.dsh-atb-card-meta { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11px; color: var(--dsw-text-secondary, gray); flex-wrap: wrap; }
		.dsh-atb-badge { font-size: 10.5px; padding: 1px 6px; border-radius: 5px; background: rgba(128,128,128,.18); }
		.dsh-atb-badge[data-kind="blocked"] { background: rgba(229,72,77,.18); color: #e5484d; }
		.dsh-atb-badge[data-kind="scheduled"] { background: rgba(62,99,221,.16); color: #3e63dd; }
		.dsh-atb-badge[data-kind="trashed"] { background: rgba(229,72,77,.14); color: #e5484d; text-decoration: line-through; }
		.dsh-atb-badge[data-kind="done"] { background: rgba(46,160,67,.16); color: #2ea043; }
		.dsh-atb-badge[data-kind="running"] { background: rgba(229,152,42,.16); color: #e69842; }

		/* ---------- card quick review (in_review column) ---------- */
		.dsh-atb-quick { display: flex; gap: 6px; margin-top: 7px; }
		.dsh-atb-quickbtn {
		  flex: 1; font-size: 11.5px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.3));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.12)); color: inherit;
		}
		.dsh-atb-quickbtn:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.6)); }
		.dsh-atb-quickbtn[data-act="done"] { background: rgba(46,160,67,.14); color: #2ea043; border-color: rgba(46,160,67,.4); }
		.dsh-atb-quickbtn[data-act="done"]:hover { background: rgba(46,160,67,.22); }
		.dsh-atb-quickbtn[data-act="reject"] { background: rgba(229,152,42,.12); color: #d9822b; border-color: rgba(229,152,42,.4); }
		.dsh-atb-quickbtn[data-act="reject"]:hover { background: rgba(229,152,42,.2); }
		.dsh-atb-quick-reject { display: flex; gap: 6px; margin-top: 7px; align-items: stretch; }
		.dsh-atb-quick-note { flex: 1; min-width: 0; font-size: 11.5px; padding: 3px 8px; }

		.dsh-atb-error { font-size: 12px; color: #e5484d; padding: 4px 8px; border-radius: 6px; background: rgba(229,72,77,.1); }
		.dsh-atb-empty { font-size: 12px; color: var(--dsw-text-secondary, gray); padding: 10px 4px; }

		/* ---------- detail pane (polished) ---------- */
		.dsh-atb-detail {
		  display: flex; flex-direction: column; gap: 12px; overflow-y: auto; min-height: 0; flex: 1;
		  padding: 2px; position: relative;
		}
		.dsh-atb-detail::before {
		  content: ""; position: sticky; top: 0; height: 3px; border-radius: 3px; flex: none;
		}
		.dsh-atb-detail[data-urgency="urgent"]::before { background: linear-gradient(90deg, #e5484d, rgba(229,72,77,.15)); }
		.dsh-atb-detail[data-urgency="normal"]::before { background: linear-gradient(90deg, #8e4ec6, rgba(142,78,198,.15)); }
		.dsh-atb-detail[data-urgency="relaxed"]::before { background: linear-gradient(90deg, #3e63dd, rgba(62,99,221,.15)); }

		.dsh-atb-detail-head { display: flex; align-items: flex-start; gap: 10px; }
		.dsh-atb-detail-titlewrap { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
		.dsh-atb-detail-titlebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.dsh-atb-detail-titlebar h3 { margin: 0; font-size: 15.5px; line-height: 1.35; word-break: break-word; }
		.dsh-atb-detail-close {
		  flex: none; width: 26px; height: 26px; border-radius: 7px; border: none; cursor: pointer;
		  background: transparent; color: var(--dsw-text-secondary, gray); font-size: 13px; line-height: 1;
		}
		.dsh-atb-detail-close:hover { background: var(--dsw-hover, rgba(128,128,128,.18)); color: inherit; }
		.dsh-atb-detail-topbtns { display: flex; align-items: center; gap: 6px; flex: none; }
		.dsh-atb-detail-edit {
		  font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.32));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.07)); color: var(--dsw-text-secondary, inherit);
		}
		.dsh-atb-detail-edit:hover { border-color: var(--dsw-alias-brand-primary, #1f2328); color: var(--dsw-alias-label-primary, inherit); }

		.dsh-atb-statuspill {
		  flex: none; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; letter-spacing: .02em;
		}
		.dsh-atb-statuspill[data-status="backlog"] { background: rgba(128,128,128,.18); color: var(--dsw-text-secondary, #888); }
		.dsh-atb-statuspill[data-status="todo"] { background: rgba(62,99,221,.15); color: #3e63dd; }
		.dsh-atb-statuspill[data-status="in_progress"] { background: rgba(230,152,66,.16); color: #d9822b; }
		.dsh-atb-statuspill[data-status="in_review"] { background: rgba(142,78,198,.16); color: #8e4ec6; }
		.dsh-atb-statuspill[data-status="done"] { background: rgba(46,160,67,.16); color: #2ea043; }
		.dsh-atb-statuspill[data-status="canceled"], .dsh-atb-statuspill[data-status="archived"] { background: rgba(128,128,128,.14); color: var(--dsw-text-secondary, #888); }

		.dsh-atb-detail-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
		.dsh-atb-chip2 {
		  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1;
		  padding: 3px 8px; border-radius: 6px;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.09)); color: var(--dsw-text-secondary, #999);
		}
		.dsh-atb-chip2-icon { font-size: 10.5px; opacity: .85; }
		.dsh-atb-chip2[data-tone="urgent"] { background: rgba(229,72,77,.15); color: #e5484d; }
		.dsh-atb-chip2[data-tone="normal"] { background: rgba(142,78,198,.14); color: #a06ce0; }
		.dsh-atb-chip2[data-tone="relaxed"] { background: rgba(62,99,221,.13); color: #6d92e8; }
		.dsh-atb-detail-sub { font-size: 11.5px; color: var(--dsw-text-secondary, gray); }

		.dsh-atb-fieldcard {
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.22)); border-radius: 10px;
		  padding: 9px 11px; display: flex; flex-direction: column; gap: 5px;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.06));
		}
		.dsh-atb-fieldcard-label {
		  font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
		  color: var(--dsw-text-secondary, gray);
		}
		.dsh-atb-fieldcard[data-kind="prompt"] .dsh-atb-fieldcard-label { color: #8e63c8; }
		.dsh-atb-promptbox {
		  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		  font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.08)); border-radius: 7px; padding: 8px 10px;
		  border: 1px dashed var(--dsw-border, rgba(128,128,128,.25));
		}
		.dsh-atb-desc { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.55; }

		.dsh-atb-detail-actions { display: flex; flex-direction: column; gap: 8px; }
		.dsh-atb-detail-run {
		  font: inherit; font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 7px; cursor: pointer;
		  border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); color: var(--dsw-alias-label-primary-foreground, #fff);
		  transition: filter .12s ease;
		}
		.dsh-atb-detail-run:hover { filter: brightness(1.1); }
		.dsh-atb-detail-run[data-danger="true"] { background: rgba(229,72,77,.92); }
		.dsh-atb-movebtns { display: flex; gap: 6px; flex-wrap: wrap; }
		.dsh-atb-movebtn {
		  font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 999px; cursor: pointer;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.32));
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.07)); color: var(--dsw-text-secondary, inherit);
		  transition: border-color .12s ease, color .12s ease;
		}
		.dsh-atb-movebtn:hover { border-color: var(--dsw-border-strong, rgba(128,128,128,.6)); color: inherit; }
		.dsh-atb-movebtn[data-to="done"] { border-color: rgba(46,160,67,.55); color: #2ea043; }
		.dsh-atb-movebtn[data-to="done"]:hover { background: rgba(46,160,67,.12); }
		.dsh-atb-movebtn[data-to="canceled"], .dsh-atb-movebtn[data-to="archived"] { opacity: .75; }
		.dsh-atb-movebtn[data-to="blocked"] { border-color: rgba(229,72,77,.45); }
		.dsh-atb-movebtn[data-to="blocked"]:hover { background: rgba(229,72,77,.1); }
		.dsh-atb-confirm { display: inline-flex; align-items: center; gap: 6px; }
		.dsh-atb-confirm-label { font-size: 11.5px; color: var(--dsw-text-secondary, gray); }

		.dsh-atb-section { font-size: 13px; display: flex; flex-direction: column; gap: 7px; }
		.dsh-atb-section h4 {
		  margin: 0; font-size: 11px; color: var(--dsw-text-secondary, gray);
		  text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; gap: 6px;
		}
		.dsh-atb-count2 {
		  font-size: 10px; font-weight: 600; padding: 0 6px; border-radius: 999px; line-height: 16px;
		  background: var(--dsw-bg-inset, rgba(128,128,128,.14)); color: var(--dsw-text-secondary, gray);
		}
		.dsh-atb-empty2 { font-size: 12px; color: var(--dsw-text-secondary, gray); padding: 8px 0; }

		.dsh-atb-commentlist { display: flex; flex-direction: column; gap: 8px; }
		.dsh-atb-bubble { display: flex; gap: 8px; }
		.dsh-atb-bubble-avatar {
		  flex: none; width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
		  font-size: 13px; background: var(--dsw-bg-inset, rgba(128,128,128,.12));
		}
		.dsh-atb-bubble[data-from="agent"] .dsh-atb-bubble-avatar { background: rgba(142,78,198,.15); }
		.dsh-atb-bubble-main {
		  flex: 1; min-width: 0; border-radius: 10px; padding: 6px 10px;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.08));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.18));
		}
		.dsh-atb-bubble[data-from="agent"] .dsh-atb-bubble-main { border-color: rgba(142,78,198,.3); background: rgba(142,78,198,.07); }
		.dsh-atb-bubble-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
		.dsh-atb-bubble-meta b { font-size: 11.5px; font-weight: 600; color: var(--dsw-text-primary, inherit); }
		.dsh-atb-bubble[data-from="agent"] .dsh-atb-bubble-meta b { color: #a06ce0; }
		.dsh-atb-bubble-meta span { font-size: 10.5px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-bubble-body { font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }

		.dsh-atb-composer { display: flex; gap: 7px; align-items: flex-end; margin-top: 2px; }
		.dsh-atb-composer-input {
		  flex: 1; font: inherit; font-size: 12.5px; line-height: 1.5; padding: 7px 10px; border-radius: 9px;
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.32));
		  background: var(--dsw-bg, transparent); color: inherit; resize: vertical; min-height: 38px;
		}
		.dsh-atb-composer-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #1f2328); }
		.dsh-atb-composer-send {
		  flex: none; font: inherit; font-size: 12.5px; padding: 7px 14px; border-radius: 9px; cursor: pointer;
		  border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #1f2328)); color: var(--dsw-alias-label-primary-foreground, #fff);
		}
		.dsh-atb-composer-send:disabled { opacity: .4; cursor: default; }

		.dsh-atb-execlist { display: flex; flex-direction: column; gap: 5px; }
		.dsh-atb-exec-row {
		  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px;
		  padding: 5px 9px; border-radius: 8px;
		  background: var(--dsw-bg-elevated, rgba(128,128,128,.07));
		  border: 1px solid var(--dsw-border, rgba(128,128,128,.16));
		}
		.dsh-atb-exec-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: rgba(128,128,128,.5); }
		.dsh-atb-exec-dot[data-outcome="succeeded"] { background: #2ea043; box-shadow: 0 0 0 3px rgba(46,160,67,.15); }
		.dsh-atb-exec-dot[data-outcome="failed"] { background: #e5484d; box-shadow: 0 0 0 3px rgba(229,72,77,.15); }
		.dsh-atb-exec-dot[data-outcome="running"] { background: #d9822b; box-shadow: 0 0 0 3px rgba(217,130,43,.18); animation: dsh-atb-pulse 1.6s ease-in-out infinite; }
		@keyframes dsh-atb-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
		.dsh-atb-exec-trigger { font-size: 11px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-exec-outcome { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 5px; }
		.dsh-atb-exec-outcome[data-outcome="succeeded"] { background: rgba(46,160,67,.15); color: #2ea043; }
		.dsh-atb-exec-outcome[data-outcome="failed"] { background: rgba(229,72,77,.14); color: #e5484d; }
		.dsh-atb-exec-outcome[data-outcome="running"] { background: rgba(217,130,43,.15); color: #d9822b; }
		.dsh-atb-exec-outcome[data-outcome="cancelled"] { background: rgba(128,128,128,.15); color: var(--dsw-text-secondary, gray); }
		.dsh-atb-exec-time { font-size: 11px; color: var(--dsw-text-secondary, gray); }
		.dsh-atb-exec-session {
		  font: inherit; font-size: 11px; color: var(--dsw-text-secondary, gray);
		  background: none; border: none; padding: 0; cursor: pointer;
		}
		.dsh-atb-exec-session:hover { color: var(--dsw-alias-brand-primary, inherit); text-decoration: underline dotted; }
		.dsh-atb-exec-error { flex-basis: 100%; font-size: 11px; color: #e5484d; word-break: break-all; }

		.dsh-atb-dangerzone {
		  display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 8px;
		  border-top: 1px dashed var(--dsw-border, rgba(128,128,128,.25));
		}

		/* ---------- task form modal (create + edit, polished) ---------- */
		.dsh-atb-modal-backdrop {
		  position: fixed; inset: 0; z-index: 80;
		  background: var(--dsw-alias-bg-mask-drop, rgba(28,30,36,.4)); backdrop-filter: var(--dsw-mask-blur, blur(2px));
		  display: flex; align-items: center; justify-content: center;
		  animation: dsh-atb-fade .14s ease;
		}
		@keyframes dsh-atb-fade { from { opacity: 0; } }
		.dsh-atb-modal {
		  width: min(560px, calc(100vw - 48px)); max-height: calc(100vh - 80px);
		  display: flex; flex-direction: column; overflow: hidden; border-radius: 14px;
		  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, inherit);
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
		  animation: dsh-atb-pop .16s ease;
		}
		@keyframes dsh-atb-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }
		.dsh-atb-modal-head {
		  display: flex; align-items: center; gap: 10px;
		  padding: 13px 16px 11px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
		}
		.dsh-atb-modal-headicon {
		  flex: none; width: 30px; height: 30px; border-radius: 9px;
		  display: flex; align-items: center; justify-content: center;
		  font-size: 14px; background: var(--dsw-alias-brand-primary, #1f2328); color: var(--dsw-alias-label-primary-foreground, #fff);
		}
		.dsh-atb-modal-headtext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
		.dsh-atb-modal-headtext h3 { margin: 0; font-size: 15px; line-height: 1.3; }
		.dsh-atb-modal-headtext p { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary, gray); }
		.dsh-atb-modal-close {
		  flex: none; width: 26px; height: 26px; border-radius: 7px; border: none; cursor: pointer;
		  background: transparent; color: var(--dsw-alias-label-tertiary, gray); font-size: 13px; line-height: 1;
		}
		.dsh-atb-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); color: var(--dsw-alias-label-primary, inherit); }

		.dsh-atb-modal-body {
		  padding: 13px 16px; overflow-y: auto;
		  display: grid; grid-template-columns: 1fr 1fr; gap: 11px 10px;
		}
		.dsh-atb-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
		.dsh-atb-field[data-span="full"] { grid-column: 1 / -1; }
		.dsh-atb-field-label {
		  display: flex; align-items: center; gap: 3px;
		  font-size: 11px; font-weight: 600; letter-spacing: .03em;
		  color: var(--dsw-alias-label-secondary, gray);
		}
		.dsh-atb-req { color: var(--dsw-alias-state-error-primary, #e5484d); font-style: normal; }
		.dsh-atb-modal-body input, .dsh-atb-modal-body textarea, .dsh-atb-modal-body select {
		  font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px;
		  width: 100%; box-sizing: border-box;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: var(--dsw-specific-input-major, transparent); color: var(--dsw-alias-label-primary, inherit);
		  transition: border-color .12s ease, box-shadow .12s ease;
		}
		.dsh-atb-modal-body textarea { min-height: 64px; resize: vertical; }
		.dsh-atb-modal-body input:focus, .dsh-atb-modal-body textarea:focus, .dsh-atb-modal-body select:focus {
		  outline: none; border-color: var(--dsw-alias-brand-primary, #1f2328);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #1f2328) 18%, transparent);
		}
		.dsh-atb-modal-body .dsh-atb-input-bad { border-color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-modal-body .dsh-atb-input-bad:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 20%, transparent); }

		.dsh-atb-urgency-picker { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
		.dsh-atb-urgency-opt {
		  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
		  padding: 8px 10px; border-radius: 9px; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: transparent; color: inherit;
		  transition: border-color .12s ease, background .12s ease;
		}
		.dsh-atb-urgency-name { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; }
		.dsh-atb-urgency-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-urgency-opt:hover { border-color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }
		.dsh-atb-urgency-opt[data-on="true"][data-urgency="urgent"] { border-color: rgba(229,72,77,.65); background: rgba(229,72,77,.1); }
		.dsh-atb-urgency-opt[data-on="true"][data-urgency="normal"] { border-color: rgba(142,78,198,.65); background: rgba(142,78,198,.1); }
		.dsh-atb-urgency-opt[data-on="true"][data-urgency="relaxed"] { border-color: rgba(62,99,221,.65); background: rgba(62,99,221,.1); }

		.dsh-atb-mode-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
		.dsh-atb-mode-opt {
		  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
		  padding: 8px 10px; border-radius: 9px; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: transparent; color: inherit;
		  transition: border-color .12s ease, background .12s ease;
		}
		.dsh-atb-mode-name { font-size: 12.5px; font-weight: 600; }
		.dsh-atb-mode-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-mode-opt:hover { border-color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }
		.dsh-atb-mode-opt[data-on="true"] { border-color: var(--dsw-alias-brand-primary, #1f2328); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #1f2328) 8%, transparent); }

		.dsh-atb-cron-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
		.dsh-atb-cron-preset {
		  font: inherit; font-size: 11px; padding: 2px 9px; border-radius: 999px; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
		  background: transparent; color: var(--dsw-alias-label-secondary, inherit);
		}
		.dsh-atb-cron-preset:hover { border-color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); color: inherit; }
		.dsh-atb-cron-preset[data-on="true"] { border-color: transparent; background: var(--dsw-alias-brand-primary, #1f2328); color: var(--dsw-alias-label-primary-foreground, #fff); }
		.dsh-atb-cron-next { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }

		.dsh-atb-modal-foot {
		  display: flex; align-items: center; gap: 10px;
		  padding: 11px 16px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18));
		  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04));
		}
		.dsh-atb-modal-hint { flex: 1; min-width: 0; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-modal-hint[data-tone="bad"] { color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-modal-footbtns { display: flex; gap: 8px; }

		.dsh-atb-secondary { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
		.dsh-atb-link { color: var(--dsw-alias-state-business-primary, #3e63dd); cursor: pointer; text-decoration: none; }
		.dsh-atb-link:hover { text-decoration: underline; }

		/* ---------- alert modal ---------- */
		.dsh-atb-alert-backdrop {
		  position: fixed; inset: 0; z-index: 90;
		  background: var(--dsw-alias-bg-mask-drop, rgba(28,30,36,.4)); backdrop-filter: var(--dsw-mask-blur, blur(2px));
		  display: flex; align-items: center; justify-content: center;
		  animation: dsh-atb-fade .12s ease;
		}
		.dsh-atb-alert {
		  min-width: 280px; max-width: 380px; padding: 20px 24px; border-radius: 14px;
		  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, inherit);
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
		  display: flex; flex-direction: column; align-items: center; gap: 14px;
		  animation: dsh-atb-pop .14s ease;
		}
		.dsh-atb-alert-icon { font-size: 28px; line-height: 1; }
		.dsh-atb-alert-msg {
		  font-size: 13.5px; line-height: 1.55; text-align: center;
		  word-break: break-word; white-space: pre-wrap;
		  color: var(--dsw-alias-label-primary, inherit);
		}
		.dsh-atb-alert .dsh-atb-btn { padding: 6px 28px; font-size: 13px; }

		/* ---------- 0.3.0 isolation ---------- */
		.dsh-atb-isolation-note { display: block; margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-mode-picker[data-disabled="true"] .dsh-atb-mode-opt { cursor: not-allowed; opacity: .55; }
		.dsh-atb-iso-none { font-size: 12.5px; color: var(--dsw-alias-label-secondary, inherit); }
		.dsh-atb-iso-facts { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-bottom: 8px; }
		.dsh-atb-iso-fact { font-size: 11.5px; color: var(--dsw-alias-label-secondary, inherit); }
		.dsh-atb-iso-fact b { font-weight: 600; color: var(--dsw-alias-state-business-primary, #3e63dd); }
		.dsh-atb-iso-commits { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
		.dsh-atb-iso-commit { display: flex; gap: 8px; font-size: 11.5px; align-items: baseline; }
		.dsh-atb-iso-commit code {
		  font-family: ui-monospace, Consolas, monospace; font-size: 10.5px;
		  color: var(--dsh-alias-state-business-primary, #3e63dd); flex-shrink: 0;
		}
		.dsh-atb-iso-commit span { word-break: break-all; color: var(--dsw-alias-label-secondary, inherit); }
		.dsh-atb-iso-more { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-iso-nocommit { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, gray); margin-bottom: 8px; }
		.dsh-atb-iso-dirty {
		  font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #e5484d);
		  background: rgba(229,72,77,.09); border: 1px solid rgba(229,72,77,.35);
		  border-radius: 8px; padding: 6px 10px; margin-bottom: 8px;
		}
		.dsh-atb-iso-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		.dsh-atb-iso-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, gray); }

		/* ---------- 0.3.0 diagnostics ---------- */
		.dsh-atb-diag { max-width: 520px; width: min(520px, 92vw); }
		.dsh-atb-diag-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
		.dsh-atb-diag-item {
		  display: flex; flex-direction: column; align-items: center; gap: 2px;
		  padding: 10px 6px; border-radius: 10px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04));
		}
		.dsh-atb-diag-item b { font-size: 18px; font-weight: 700; }
		.dsh-atb-diag-item span { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, gray); }
		.dsh-atb-diag-item[data-bad="true"] b { color: var(--dsw-alias-state-error-primary, #e5484d); }
		.dsh-atb-diag-sec h4 { margin: 0 0 8px; font-size: 12.5px; }
		.dsh-atb-diag-orphans { display: flex; flex-direction: column; gap: 6px; }
		.dsh-atb-diag-orphan {
		  display: flex; align-items: center; gap: 10px; justify-content: space-between;
		  padding: 7px 10px; border-radius: 8px;
		  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25));
		}
		.dsh-atb-diag-orphan-path { font-size: 11.5px; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
		`;
		let injected = false;
		/** Inject the stylesheet once (idempotent). */
		function injectStyles() {
			if (injected || typeof document === "undefined") return;
			const style = document.createElement("style");
			style.id = "dsh-taskboard-styles";
			style.textContent = STYLES;
			document.head.append(style);
			injected = true;
		}

		//#endregion
		//#region src/client/sidebar-entry.ts
		/** Inline icon (16px nav-icon look). */
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"2\" y=\"2.5\" width=\"12\" height=\"11\" rx=\"1.5\"/><path d=\"M2 6.5h12M6.5 6.5v7\"/></svg>";
		/**
		* Find the sidebar shell root element, or undefined while not yet mounted.
		* (Same as the working family plugins: sidebarCol pane → logoRow owner.)
		*/
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		/**
		* The New Session button: nested in the logo row on current shells, a direct
		* child BUTTON on the real shell (the family plugins' fallback), with
		* aria-label/text fallbacks for other shells.
		*/
		function newSessionButton(root) {
			const nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (const child of root.children) if (child instanceof HTMLButtonElement) return child;
			const byAria = root.querySelector("button[aria-label=\"新建会话\"], button[aria-label=\"New Session\"], button[aria-label*=\"新会话\"], button[aria-label*=\"new session\" i]");
			if (byAria !== null) return byAria;
			return Array.from(root.querySelectorAll("button")).find((button) => /新会话|新建会话|new session/i.test(button.textContent ?? ""));
		}
		/** Build the entry row (a detached button; insert once the shell is up). */
		function createEntry(controller) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.dataset.dshAtbEntry = "";
			entry.className = "dsh-atb-entry";
			entry.setAttribute("aria-label", "Agent 任务看板");
			entry.innerHTML = `<span class="dsh-atb-entry-icon">${ICON}</span><span class="dsh-atb-entry-label">任务看板</span><span class="dsh-atb-entry-stats"></span>`;
			entry.addEventListener("click", () => {
				controller.toggleBoard();
			});
			return entry;
		}
		/**
		* Live status counts shown at the right of the entry row:
		* `[todo, in_progress, in_review]` (trashed tasks excluded).
		*/
		function entryStats(controller) {
			let todo = 0;
			let inProgress = 0;
			let inReview = 0;
			for (const task of controller.getSnapshot().ledger.tasks) {
				if (task.trashedAt !== void 0) continue;
				if (task.status === "todo") todo++;
				else if (task.status === "in_progress") inProgress++;
				else if (task.status === "in_review") inReview++;
			}
			return [
				todo,
				inProgress,
				inReview
			];
		}
		/**
		* Set one rolling-number slot. Unchanged values no-op; changes animate the
		* old value out and the new value in with a vertical scroll (up when the
		* count grows, down when it shrinks). Plain DOM, no React.
		*/
		function setRollValue(slot, value) {
			const text = String(value);
			if (slot.dataset.value === text) return;
			const previous = slot.dataset.value;
			slot.dataset.value = text;
			slot.style.minWidth = `${text.length}ch`;
			if (previous === void 0) {
				slot.textContent = text;
				return;
			}
			if (slot.dataset.busy === "1") {
				slot.dataset.busy = "";
				slot.dataset.anim = "";
			}
			const oldEl = document.createElement("span");
			oldEl.className = "dsh-atb-rn";
			oldEl.textContent = previous;
			const newEl = document.createElement("span");
			newEl.className = "dsh-atb-rn dsh-atb-rn-next";
			newEl.textContent = text;
			slot.replaceChildren(oldEl, newEl);
			slot.dataset.dir = value > Number(previous) ? "up" : "down";
			slot.dataset.busy = "1";
			requestAnimationFrame(() => {
				slot.dataset.anim = "1";
			});
			const finish = () => {
				if (slot.dataset.busy !== "1") return;
				slot.dataset.busy = "";
				slot.dataset.anim = "";
				slot.textContent = slot.dataset.value ?? "";
			};
			slot.addEventListener("transitionend", finish, { once: true });
			setTimeout(finish, 400);
		}
		/**
		* Wire the stats strip into the entry: builds the three slots and keeps them
		* (plus the tooltip) in sync with every controller emit.
		* @returns the update function (also called once immediately).
		*/
		function wireStats(entry, controller) {
			const stats = entry.querySelector(".dsh-atb-entry-stats");
			if (stats === null) return () => {};
			const statKeys = [
				"todo",
				"in_progress",
				"in_review"
			];
			const slots = [];
			for (let i = 0; i < 3; i++) {
				if (i > 0) {
					const sep = document.createElement("span");
					sep.className = "dsh-atb-entry-sep";
					sep.textContent = "|";
					stats.append(sep);
				}
				const slot = document.createElement("span");
				slot.className = "dsh-atb-roll";
				slot.dataset.stat = statKeys[i];
				stats.append(slot);
				slots.push(slot);
			}
			const update = () => {
				const [todo, inProgress, inReview] = entryStats(controller);
				setRollValue(slots[0], todo);
				setRollValue(slots[1], inProgress);
				setRollValue(slots[2], inReview);
				stats.title = `待办 ${todo} ｜ 进行中 ${inProgress} ｜ 待验收 ${inReview}（待办|进行中|待验收）`;
			};
			return update;
		}
		/** Re-insert the entry after the New Session row (before the browser region). */
		function placeEntry(root, entry) {
			const button = newSessionButton(root);
			if (button === void 0) return false;
			if (entry.parentElement !== root) {
				const row = button.closest("[class*=\"logoRow\"]");
				const base = row !== null && row.parentElement === root ? row : button;
				const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches("[data-dsh-atb-entry], [data-dsh-taskboard-entry], [data-dsh-ssh-entry]"));
				const anchor = family.length > 0 ? family[0] ?? null : base.nextElementSibling ?? null;
				root.insertBefore(entry, anchor);
			}
			return true;
		}
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @param controller - the board controller the entry toggles.
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry(controller) {
			const entry = createEntry(controller);
			const debug = {
				attempts: 0,
				found: false,
				placed: false
			};
			window.__atbDebug = debug;
			let root;
			let placed = false;
			const tryPlace = () => {
				debug.attempts++;
				if (root !== void 0 && !root.isConnected) {
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				debug.found = newSessionButton(root) !== void 0;
				placed = placeEntry(root, entry);
				debug.placed = placed;
				if (placed) rootObserver.observe(root, {
					childList: true,
					subtree: true
				});
			};
			const waitObserver = new MutationObserver(() => {
				tryPlace();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			const rootObserver = new MutationObserver(() => {
				if (root === void 0 || !root.isConnected) {
					placed = false;
					tryPlace();
					return;
				}
				if (!root.contains(entry)) placed = placeEntry(root, entry);
			});
			const retry = setInterval(() => {
				tryPlace();
			}, 2e3);
			const syncStats = wireStats(entry, controller);
			const syncActive = () => {
				if (controller.getSnapshot().boardOpen) entry.dataset.active = "true";
				else delete entry.dataset.active;
				syncStats();
			};
			const unsubscribe = controller.subscribe(syncActive);
			syncActive();
			tryPlace();
			return () => {
				clearInterval(retry);
				waitObserver.disconnect();
				rootObserver.disconnect();
				unsubscribe();
				entry.remove();
			};
		}

		//#endregion
		//#region src/shared/version.ts
		/**
		* The plugin package version shown in the board UI. Kept in sync with
		* package.json by a regression test (tests lock drift).
		*
		* @module dsh-taskboard/shared/version
		*/
		/** The package version (must equal package.json "version"). */
		const PLUGIN_VERSION = "0.3.3";

		//#endregion
		//#region src/client/board/TaskCard.tsx
		/**
		* One board card: urgency edge, title, project/urgency/model/schedule/
		* blocked/trashed badges, comment count, and the last execution outcome.
		* Click opens the detail pane; cards in the backlog/todo columns are
		* draggable between those two columns (HTML5 drag & drop). Cards sitting
		* in the in_review column also carry quick-review actions (✓ complete /
		* ✗ send back with an optional note).
		*
		* The root is a div[role=button] (not a <button>) so the quick actions can
		* be real nested buttons — valid HTML and native keyboard activation.
		*
		* @module dsh-taskboard/client/board/TaskCard
		*/
		const URGENCY_LABEL$1 = {
			urgent: "紧急",
			normal: "一般",
			relaxed: "不急"
		};
		const OUTCOME_LABEL$1 = {
			running: "执行中",
			succeeded: "成功",
			failed: "失败",
			cancelled: "已取消"
		};
		/** dataTransfer type carrying the dragged task id. */
		const DRAG_TYPE = "application/x-dsh-atb-task";
		/**
		* The card view.
		* @param task - the task record.
		* @param controller - the controller.
		* @param draggable - enable dragging.
		* @param now - current epoch ms (stale-claim highlight).
		* @param onAlert - show an alert message (replaces native alert).
		*/
		function TaskCard({ task, controller, draggable = false, now, onAlert }) {
			const [rejectOpen, setRejectOpen] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)("");
			const last = task.executions.length > 0 ? task.executions[task.executions.length - 1] : void 0;
			const running = task.executions.find((ex) => ex.outcome === "running");
			const stale = now !== void 0 && isStaleClaim(task, now);
			const reviewing = task.status === "in_review" && task.trashedAt === void 0;
			/** Submit the quick-reject: one atomic route (move + optional note). */
			const submitReject = () => {
				controller.reject(task.id, task.version, note).then((ok) => {
					if (ok) {
						setRejectOpen(false);
						setNote("");
					}
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "button",
				tabIndex: 0,
				className: "dsh-atb-card",
				"data-urgency": task.urgency,
				draggable: draggable && !rejectOpen,
				onDragStart: (e) => {
					if (running !== void 0) {
						e.preventDefault();
						const msg = `该任务正在由【${task.title}】会话执行，不能拖动`;
						if (onAlert !== void 0) onAlert(msg);
						else alert(msg);
						return;
					}
					e.dataTransfer.setData(DRAG_TYPE, task.id);
					e.dataTransfer.effectAllowed = "move";
					e.currentTarget.dataset.dragging = "true";
				},
				onDragEnd: (e) => {
					delete e.currentTarget.dataset.dragging;
				},
				onClick: () => controller.select(task.id),
				onKeyDown: (e) => {
					if (e.target !== e.currentTarget) return;
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						controller.select(task.id);
					}
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-card-title",
						children: task.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-card-meta",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								children: URGENCY_LABEL$1[task.urgency]
							}),
							task.blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "blocked",
								children: "受阻"
							}),
							stale && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "stale",
								children: "⏱ 认领超时"
							}),
							task.execution.mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-badge",
								"data-kind": "scheduled",
								children: ["⏰ ", fmtTime(task.execution.nextRunAt)]
							}),
							task.model !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								children: task.model.model
							}),
							task.status === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "done",
								children: "完成"
							}),
							last !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": last.outcome === "running" ? "running" : last.outcome,
								children: OUTCOME_LABEL$1[last.outcome] ?? last.outcome
							}),
							task.comments.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["💬 ", task.comments.length] }),
							task.trashedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-badge",
								"data-kind": "trashed",
								children: "待清除"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { marginLeft: "auto" },
								children: fmtTime(task.updatedAt)
							})
						]
					}),
					reviewing && (rejectOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-quick-reject",
						onClick: (e) => e.stopPropagation(),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "dsh-atb-input dsh-atb-quick-note",
								value: note,
								placeholder: "退回原因（可选，agent 开工前会读）…",
								autoFocus: true,
								spellCheck: false,
								onChange: (e) => setNote(e.target.value),
								onKeyDown: (e) => {
									if (e.key === "Enter") submitReject();
									else if (e.key === "Escape") {
										setRejectOpen(false);
										setNote("");
									}
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-quickbtn",
								"data-act": "reject-confirm",
								onClick: submitReject,
								children: "退回待办"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-quickbtn",
								"data-act": "reject-cancel",
								onClick: () => {
									setRejectOpen(false);
									setNote("");
								},
								children: "取消"
							})
						]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-quick",
						onClick: (e) => e.stopPropagation(),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-quickbtn",
							"data-act": "done",
							title: "验收完成：移至已完成",
							onClick: () => void controller.move(task.id, task.version, "done"),
							children: "✓ 完成"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-quickbtn",
							"data-act": "reject",
							title: "退回待办，可附退回原因",
							onClick: () => setRejectOpen(true),
							children: "✗ 退回"
						})]
					}))
				]
			});
		}

		//#endregion
		//#region src/client/board/AlertModal.tsx
		/**
		* A lightweight alert modal — replaces native alert() with a themed overlay
		* that matches the shell design tokens.
		*
		* @module dsh-taskboard/client/board/AlertModal
		*/
		/** Show a non-blocking alert modal. Returns true when opened. */
		function useAlert() {
			const [msg, setMsg] = (0, react.useState)(null);
			const show = (m) => setMsg(m);
			const close = () => setMsg(null);
			return {
				alert: show,
				el: msg !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AlertModal, {
					message: msg,
					onClose: close
				}) : null
			};
		}
		function AlertModal({ message, onClose }) {
			(0, react.useEffect)(() => {
				const handler = (e) => {
					if (e.key === "Escape") onClose();
				};
				window.addEventListener("keydown", handler);
				return () => window.removeEventListener("keydown", handler);
			}, [onClose]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-alert-backdrop",
				onClick: onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-alert",
					onClick: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-alert-icon",
							children: "⛔"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-alert-msg",
							children: message
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-btn",
							"data-primary": "true",
							onClick: onClose,
							children: "知道了"
						})
					]
				})
			});
		}

		//#endregion
		//#region src/client/board/TaskDetail.tsx
		/**
		* The task detail pane — visually polished: urgency accent header with
		* status pill and meta chips, card-wrapped description/prompt, chat-style
		* comment bubbles distinguishing user vs agent authors, a timeline of
		* executions with outcome pills, grouped actions (run / transitions /
		* danger zone), and the user comment composer.
		*
		* @module dsh-taskboard/client/board/TaskDetail
		*/
		/** Statuses a user may move this task to, per the state machine. */
		function moveTargets(task) {
			return [
				"backlog",
				"todo",
				"in_progress",
				"in_review",
				"done",
				"canceled",
				"archived"
			].filter((to) => canTransition(task.status, to));
		}
		const MOVE_LABEL = {
			backlog: "待规划",
			todo: "待办",
			in_progress: "进行中",
			in_review: "待验收",
			done: "完成",
			canceled: "取消",
			archived: "归档"
		};
		const STATUS_LABEL = { ...MOVE_LABEL };
		const URGENCY_LABEL = {
			urgent: "紧急",
			normal: "一般",
			relaxed: "不急"
		};
		const OUTCOME_LABEL = {
			running: "执行中",
			succeeded: "成功",
			failed: "失败",
			cancelled: "已取消"
		};
		/** Compact session-id display (execution sessions carry the taskboard infix). */
		function shortId(id) {
			if (id === void 0) return "";
			return id.replace(/^session-(taskboard-)?/, "").slice(0, 8);
		}
		/** Execution duration between start and end. */
		function duration(startedAt, endedAt) {
			if (startedAt === void 0 || endedAt === void 0) return "";
			const s = Math.max(0, Math.round((endedAt - startedAt) / 1e3));
			if (s < 60) return `${s}s`;
			if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
			return `${Math.floor(s / 3600)}h${Math.floor(s % 3600 / 60)}m`;
		}
		/** Small labelled meta chip. */
		function Chip({ icon, children, tone }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dsh-atb-chip2",
				"data-tone": tone,
				children: [icon !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsh-atb-chip2-icon",
					children: icon
				}), children]
			});
		}
		/** The most recent execution carrying isolation facts, newest first. */
		function latestIsolated(task) {
			return [...task.executions].reverse().find((e) => e.isolation !== void 0 || e.worktreePath !== void 0 || e.isolationNote !== void 0);
		}
		/** Short commit hash for display. */
		function shortHash(hash) {
			return hash === void 0 ? "" : hash.slice(0, 8);
		}
		/**
		* The 0.3.0 isolation block: branch / baseline→head commits / change stats /
		* uncommitted-changes warning, plus the user-only git actions (merge /
		* remove worktree — plan §3.3).
		*/
		function IsolationBlock({ task, controller }) {
			const { alert: showAlert, el: alertEl } = useAlert();
			const [confirmMerge, setConfirmMerge] = (0, react.useState)(false);
			const [confirmRemove, setConfirmRemove] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const execution = latestIsolated(task);
			const running = task.executions.some((e) => e.outcome === "running");
			if (execution === void 0) return null;
			const doMerge = () => {
				setBusy(true);
				controller.mergeBranch(task.id).then((result) => {
					setBusy(false);
					setConfirmMerge(false);
					if (!result.ok) showAlert(`合并失败：${result.error}`);
					else if (result.noop === true) showAlert("该分支没有领先主工作区的新提交，无需合并（可退回续跑或直接清理）");
				});
			};
			const doRemove = (deleteBranch) => {
				setBusy(true);
				controller.removeWorktree(task.id, deleteBranch).then((result) => {
					setBusy(false);
					setConfirmRemove(null);
					if (!result.ok) showAlert(`删除失败：${result.error}`);
					else if (result.branchError !== void 0) showAlert(`worktree 已删除，但分支删除失败：${result.branchError}`);
				});
			};
			if (execution.isolation !== "worktree" || execution.worktreePath === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-fieldcard",
				"data-kind": "isolation",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-fieldcard-label",
						children: "执行隔离"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-none",
						children: ["📁 原目录执行", execution.isolationNote !== void 0 ? ` · ${execution.isolationNote}` : ""]
					}),
					alertEl
				]
			});
			const commits = execution.commits ?? [];
			const commitTotal = execution.commitsTotal ?? commits.length;
			const dirty = execution.dirtyFiles ?? [];
			const dirtyTotal = execution.dirtyFilesTotal ?? dirty.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-fieldcard",
				"data-kind": "isolation",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-fieldcard-label",
						children: "执行隔离 · Worktree"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-facts",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-iso-fact",
								title: execution.worktreePath,
								children: ["🌿 分支 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: execution.branch ?? task.branch })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-iso-fact",
								children: [
									"基线 ",
									shortHash(execution.baseCommit),
									" → ",
									shortHash(execution.headCommit)
								]
							}),
							execution.changedFiles !== void 0 && execution.changedFiles > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-iso-fact",
								children: [
									"改动 ",
									execution.changedFiles,
									" 个文件"
								]
							}),
							execution.diffStat !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-fact",
								title: execution.diffStat,
								children: execution.diffStat
							})
						]
					}),
					commits.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-commits",
						children: [commits.slice(0, 10).map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-iso-commit",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: shortHash(c.hash) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: c.subject })]
						}, c.hash)), commitTotal > 10 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-iso-more",
							children: [
								"… 共 ",
								commitTotal,
								" 个提交"
							]
						})]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-iso-nocommit",
						children: "该次执行没有产生提交（改动可能未提交，见下方警告）"
					}),
					dirtyTotal > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-dirty",
						title: dirty.join("\n"),
						children: [
							"⚠ 有 ",
							dirtyTotal,
							" 处未提交修改（合并前请让 agent 提交，或手动处理）"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-iso-actions",
						children: [
							running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-hint",
								children: "执行中 — 结束后可合并或清理"
							}) : confirmMerge ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-confirm",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-confirm-label",
										children: "将分支以 --no-ff 合并到主工作区？"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										"data-primary": "true",
										disabled: busy,
										onClick: doMerge,
										children: "确认合并"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										onClick: () => setConfirmMerge(false),
										children: "取消"
									})
								]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								disabled: busy,
								title: "在主工作区 git merge --no-ff 该任务分支（要求主区干净；冲突会原样报告）",
								onClick: () => setConfirmMerge(true),
								children: "⇥ 合并到主工作区"
							}),
							!running && (confirmRemove === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								"data-danger": "true",
								disabled: busy,
								title: "git worktree remove（有未提交修改时拒绝）",
								onClick: () => setConfirmRemove("wt"),
								children: "🗑 删除 worktree"
							}), task.branch !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								"data-danger": "true",
								disabled: busy,
								title: "删除 worktree 并删除任务分支（有未提交修改时拒绝）",
								onClick: () => setConfirmRemove("wtb"),
								children: "🗑 删 worktree + 分支"
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-confirm",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-confirm-label",
										children: confirmRemove === "wtb" ? "删除 worktree 并删除分支？" : "删除 worktree 目录？"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										"data-danger": "true",
										disabled: busy,
										onClick: () => doRemove(confirmRemove === "wtb"),
										children: "确认删除"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										onClick: () => setConfirmRemove(null),
										children: "取消"
									})
								]
							})),
							!running && confirmRemove === null && !confirmMerge && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-iso-hint",
								children: "分支与 worktree 保留中 — 可退回继续修改"
							})
						]
					}),
					alertEl
				]
			});
		}
		/**
		* The detail view.
		* @param task - the task record.
		* @param controller - the controller.
		* @param now - current epoch ms (stale-claim highlight).
		*/
		function TaskDetail({ task, controller, now }) {
			const [comment, setComment] = (0, react.useState)("");
			const [confirmDone, setConfirmDone] = (0, react.useState)(false);
			const [confirmPurge, setConfirmPurge] = (0, react.useState)(false);
			const [confirmCancel, setConfirmCancel] = (0, react.useState)(false);
			const { alert: showAlert, el: alertEl } = useAlert();
			const ws = controller.getSnapshot().workspaces.find((w) => w.id === task.workspaceId);
			const canRun = task.status !== "in_progress" && task.status !== "done" && task.status !== "archived";
			const runningExecution = task.executions.find((e) => e.outcome === "running");
			const holder = task.status === "in_progress" ? task.claimedBy : void 0;
			const stale = now !== void 0 && isStaleClaim(task, now);
			/** Jump to an execution's session; prompt precisely when it cannot open. */
			const jumpToSession = (sessionId) => {
				controller.openSession(sessionId).then((result) => {
					if (result === "missing") showAlert(`该会话已被删除（${shortId(sessionId)}），无法打开`);
					else if (result === "archived") showAlert(`该会话已归档（${shortId(sessionId)}），已从会话列表隐藏`);
					else if (result === "unavailable") showAlert(`会话导航不可用，会话 ID：${sessionId}`);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-detail",
				"data-urgency": task.urgency,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-detail-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-detail-titlewrap",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-detail-titlebar",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: task.title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-statuspill",
										"data-status": task.status,
										children: STATUS_LABEL[task.status] ?? task.status
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-detail-chips",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											tone: task.urgency,
											children: ["● ", URGENCY_LABEL[task.urgency] ?? task.urgency]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "📁",
											children: ws?.title ?? shortId(task.workspaceId)
										}),
										task.model !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "✦",
											children: task.model.model
										}),
										task.presetId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🎛",
											children: task.presetId
										}),
										task.execution.mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											icon: "⏰",
											children: [
												task.execution.cron,
												" · 下次 ",
												fmtTime(task.execution.nextRunAt)
											]
										}),
										task.blocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "⛔",
											tone: "urgent",
											children: "受阻"
										}),
										task.branch !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											icon: "🌿",
											tone: void 0,
											children: ["Worktree · ", task.branch.length > 28 ? `${task.branch.slice(0, 28)}…` : task.branch]
										}),
										(task.isolation === void 0 || task.isolation === "worktree") && task.branch === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🌿",
											children: "Worktree 隔离"
										}),
										holder !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, {
											icon: stale ? "⏱" : "🔑",
											tone: stale ? "urgent" : void 0,
											children: [
												stale ? "认领超时 · " : "由 ",
												shortId(holder),
												" 持有"
											]
										}),
										task.trashedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
											icon: "🗑",
											tone: "urgent",
											children: "已删除待清除"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Chip, { children: ["v", task.version] })
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-detail-sub",
									children: [
										"更新 ",
										fmtTime(task.updatedAt),
										" · 最近操作 ",
										task.updatedBy.kind === "agent" ? `🤖 ${shortId(task.updatedBy.sessionId)}` : "👤 用户"
									]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-detail-topbtns",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-edit",
									onClick: () => controller.openEditor(task.id),
									children: "✎ 编辑"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-edit",
									title: "复制此任务的全部配置为一张新卡（待办列）",
									onClick: () => void controller.duplicate(task),
									children: "⧉ 复制"
								}),
								canRun && task.branch !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-run",
									title: "续跑：保留现有 worktree 与分支（上次的改动和提交都在原处），在其上继续执行；默认「立即执行」会重置为全新基线",
									onClick: () => void controller.run(task.id, true),
									children: "↻ 续跑"
								}),
								canRun && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-run",
									title: task.model !== void 0 ? `新会话执行（${task.model.model}）` : "新会话执行（默认模型）",
									onClick: () => void controller.run(task.id),
									children: "▶ 立即执行"
								}),
								runningExecution !== void 0 && (confirmCancel ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsh-atb-confirm",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-confirm-label",
											children: "停止该执行会话？"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											"data-danger": "true",
											onClick: () => {
												controller.cancel(task.id);
												setConfirmCancel(false);
											},
											children: "停止"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											onClick: () => setConfirmCancel(false),
											children: "取消"
										})
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-run",
									"data-danger": "true",
									title: `停止执行会话 ${runningExecution.sessionId ?? ""}（任务回到待办）`,
									onClick: () => setConfirmCancel(true),
									children: "■ 停止执行"
								})),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-detail-close",
									"aria-label": "关闭",
									onClick: () => controller.select(void 0),
									children: "✕"
								})
							]
						})]
					}),
					task.description.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-fieldcard",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-fieldcard-label",
							children: "描述"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-desc",
							children: task.description
						})]
					}),
					task.prompt.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-fieldcard",
						"data-kind": "prompt",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-fieldcard-label",
							children: "执行 Prompt"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-promptbox",
							children: task.prompt
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IsolationBlock, {
						task,
						controller
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-detail-actions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-movebtns",
							children: [
								moveTargets(task).map((to) => to === "done" ? confirmDone ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dsh-atb-confirm",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-confirm-label",
											children: "确认完成？"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											"data-primary": "true",
											onClick: () => {
												controller.move(task.id, task.version, "done");
												setConfirmDone(false);
											},
											children: "确认"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-btn",
											onClick: () => setConfirmDone(false),
											children: "取消"
										})
									]
								}, to) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": to,
									onClick: () => setConfirmDone(true),
									children: ["移至→", MOVE_LABEL[to]]
								}, to) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": to,
									onClick: () => void controller.move(task.id, task.version, to),
									children: ["移至→", MOVE_LABEL[to]]
								}, to)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": "blocked",
									onClick: () => void controller.toggleBlocked(task),
									children: task.blocked ? "✓ 解除受阻" : "⛔ 标记受阻"
								}),
								holder !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-movebtn",
									"data-to": "release",
									title: `释放 ${holder} 的认领：任务回到待办（持有会话可能仍在工作，确认它已停止后再释放）`,
									onClick: () => void controller.move(task.id, task.version, "todo"),
									children: "🔓 释放认领"
								})
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: ["评论", task.comments.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-count2",
								children: task.comments.length
							})] }),
							task.comments.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-atb-empty2",
								children: "暂无评论 — agent 交接时会在这里汇报改动与验证结果"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsh-atb-commentlist",
								children: task.comments.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-bubble",
									"data-from": c.threadId !== void 0 ? "agent" : "user",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-bubble-avatar",
										children: c.threadId !== void 0 ? "🤖" : "👤"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-bubble-main",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-bubble-meta",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: c.threadId !== void 0 ? `agent ${shortId(c.threadId)}` : "用户" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: fmtTime(c.createdAt) })]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dsh-atb-bubble-body",
											children: c.body
										})]
									})]
								}, c.id))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-composer",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: "dsh-atb-composer-input",
									value: comment,
									placeholder: "以用户身份留言（agent 开工前会读）…",
									onChange: (e) => setComment(e.target.value),
									onKeyDown: (e) => {
										if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && comment.trim().length > 0) {
											controller.comment(task.id, comment);
											setComment("");
										}
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-composer-send",
									disabled: comment.trim().length === 0,
									onClick: () => {
										controller.comment(task.id, comment);
										setComment("");
									},
									children: "发表"
								})]
							})
						]
					}),
					task.executions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-section",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h4", { children: [
							"执行记录",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-count2",
								children: task.executions.length
							}),
							task.executionsPruned !== void 0 && task.executionsPruned > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-count2",
								title: `更早的 ${task.executionsPruned} 条执行记录已按保留上限清理`,
								children: [
									"+",
									task.executionsPruned,
									" 已清理"
								]
							})
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-execlist",
							children: [...task.executions].reverse().map((e) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-exec-row",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-dot",
										"data-outcome": e.outcome
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-trigger",
										children: e.trigger === "manual" ? "手动" : "定时"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-exec-outcome",
										"data-outcome": e.outcome,
										children: OUTCOME_LABEL[e.outcome] ?? e.outcome
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-exec-time",
										children: [fmtTime(e.startedAt), e.endedAt !== void 0 && ` · ${duration(e.startedAt, e.endedAt)}`]
									}),
									e.sessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "dsh-atb-exec-session",
										title: `点击打开该执行会话：${e.sessionId}`,
										onClick: () => jumpToSession(e.sessionId),
										children: [
											"🤖 ",
											shortId(e.sessionId),
											" ↗"
										]
									}),
									e.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-exec-error",
										title: e.error,
										children: [e.error.slice(0, 80), e.error.length > 80 ? "…" : ""]
									})
								]
							}, e.id))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-dangerzone",
						children: task.trashedAt === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-btn",
							"data-danger": "true",
							onClick: () => void controller.remove(task.id, task.version, false),
							children: "🗑 删除（标记待清除）"
						}) : confirmPurge ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsh-atb-confirm",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-confirm-label",
									children: "物理清除不可恢复"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									"data-danger": "true",
									onClick: () => {
										controller.remove(task.id, task.version, true);
										setConfirmPurge(false);
									},
									children: "确认清除"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									onClick: () => setConfirmPurge(false),
									children: "取消"
								})
							]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dsh-atb-btn",
							"data-danger": "true",
							onClick: () => setConfirmPurge(true),
							children: "🔥 物理清除（需确认）"
						})
					}),
					alertEl
				]
			});
		}

		//#endregion
		//#region src/client/board/TaskFormModal.tsx
		/**
		* The task form modal — create and edit in one polished dialog: header with
		* icon / subtitle / close, a sectioned field grid (title, project, model,
		* urgency tri-picker with hints, description, prompt, execution-mode
		* segmented picker, cron with presets and a live next-run preview), and a
		* footer bar carrying the validation hint and the actions. Esc closes;
		* the title input is focused on open.
		*
		* @module dsh-taskboard/client/board/TaskFormModal
		*/
		/** Urgency segmented options with a one-line hint each. */
		const URGENCY_OPTIONS = [
			{
				value: "urgent",
				label: "紧急",
				hint: "优先处理"
			},
			{
				value: "normal",
				label: "一般",
				hint: "正常排期"
			},
			{
				value: "relaxed",
				label: "不急",
				hint: "有空再做"
			}
		];
		/** Cron presets offered in the scheduled mode. */
		const CRON_PRESETS = [
			{
				label: "每天 09:00",
				cron: "0 9 * * *"
			},
			{
				label: "每小时",
				cron: "0 * * * *"
			},
			{
				label: "每 10 分钟",
				cron: "*/10 * * * *"
			},
			{
				label: "每周一 09:00",
				cron: "0 9 * * 1"
			}
		];
		/** Field shell: label + control, optionally spanning the full grid row. */
		function Field({ label, required = false, full = false, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: "dsh-atb-field",
				"data-span": full ? "full" : void 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "dsh-atb-field-label",
					children: [label, required && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("em", {
						className: "dsh-atb-req",
						children: "*"
					})]
				}), children]
			});
		}
		/**
		* The form modal. Without `task` it composes a new task; with `task` it
		* edits that record (project, urgency, execution, model included — the GUI
		* is the owner surface).
		* @param controller - the controller.
		* @param task - the task being edited (create mode when absent).
		*/
		function TaskFormModal({ controller, task }) {
			const state = controller.getSnapshot();
			const editing = task !== void 0;
			const [title, setTitle] = (0, react.useState)(task?.title ?? "");
			const [description, setDescription] = (0, react.useState)(task?.description ?? "");
			const [prompt, setPrompt] = (0, react.useState)(task?.prompt ?? "");
			const [workspaceId, setWorkspaceId] = (0, react.useState)(task?.workspaceId ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? "");
			const [urgency, setUrgency] = (0, react.useState)(task?.urgency ?? "normal");
			const [mode, setMode] = (0, react.useState)(task?.execution.mode === "scheduled" ? "scheduled" : "claim");
			const [cron, setCron] = (0, react.useState)(task?.execution.cron ?? "0 9 * * *");
			const [catalog, setCatalog] = (0, react.useState)([]);
			const [model, setModel] = (0, react.useState)(task?.model !== void 0 ? JSON.stringify(task.model) : "");
			const [presetId, setPresetId] = (0, react.useState)(task?.presetId ?? "");
			const [presets, setPresets] = (0, react.useState)([]);
			const [presetDefault, setPresetDefault] = (0, react.useState)(void 0);
			const [isolation, setIsolation] = (0, react.useState)(task?.isolation ?? loadDefaultIsolation());
			const titleRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				titleRef.current?.focus();
				const onKey = (e) => {
					if (e.key === "Escape") controller.closeForm();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [controller]);
			(0, react.useEffect)(() => {
				const face = controller.modelCatalog;
				if (face === void 0) return;
				face().then(setCatalog).catch(() => setCatalog([]));
			}, [controller]);
			(0, react.useEffect)(() => {
				const face = controller.presetCatalog;
				if (face === void 0) return;
				face().then((roster) => {
					setPresets(roster.presets);
					setPresetDefault(roster.defaultId);
					if (task?.presetId === void 0 && roster.defaultId !== void 0) setPresetId(roster.defaultId);
				}).catch(() => setPresets([]));
			}, [controller, task?.presetId]);
			const cronMatch = mode === "scheduled" ? parseCron(cron.trim()) : null;
			const nextRun = cronMatch !== null ? nextCronTime(cronMatch, Date.now()) : null;
			const cronBad = mode === "scheduled" && (cronMatch === null || nextRun === null);
			const valid = title.trim().length > 0 && workspaceId !== "" && !cronBad;
			const runBlocked = editing && task.status === "in_progress";
			const isolationLocked = editing && ((task.executions?.length ?? 0) > 0 || task.status === "in_progress");
			const gitOk = controller.gitAvailable(workspaceId);
			const isolationDisabled = isolationLocked || !gitOk;
			/** Isolation payload for submit: undefined keeps the default (degrades naturally). */
			const isolationPayload = () => {
				if (!gitOk) return void 0;
				if (!editing) saveDefaultIsolation(isolation);
				return isolation;
			};
			/** Preset payload: '' = follow the deployment default (submit omits). */
			const presetPayload = () => presetId.trim().length > 0 ? presetId.trim() : void 0;
			const submit = () => {
				if (!valid) return;
				const picked = model !== "" ? JSON.parse(model) : void 0;
				const isolationOut = isolationPayload();
				const presetOut = presetPayload();
				if (editing) controller.update(task.id, task.version, {
					title,
					description,
					prompt,
					urgency,
					workspaceId,
					execution: mode === "scheduled" ? {
						mode,
						cron: cron.trim()
					} : { mode },
					model: picked ?? null,
					...isolationOut !== void 0 && !isolationLocked ? { isolation: isolationOut } : {},
					presetId: presetOut ?? null
				});
				else controller.create({
					title,
					workspaceId,
					urgency,
					description: description.length > 0 ? description : void 0,
					prompt: prompt.length > 0 ? prompt : void 0,
					execution: mode === "scheduled" ? {
						mode,
						cron: cron.trim()
					} : { mode },
					model: picked,
					...isolationOut !== void 0 ? { isolation: isolationOut } : {},
					...presetOut !== void 0 ? { presetId: presetOut } : {}
				});
			};
			/** Save the form, then immediately trigger a manual run of the task. */
			const submitAndRun = () => {
				if (!valid || runBlocked) return;
				const picked = model !== "" ? JSON.parse(model) : void 0;
				const isolationOut = isolationPayload();
				const presetOut = presetPayload();
				if (editing) (async () => {
					if (await controller.update(task.id, task.version, {
						title,
						description,
						prompt,
						urgency,
						workspaceId,
						execution: mode === "scheduled" ? {
							mode,
							cron: cron.trim()
						} : { mode },
						model: picked ?? null,
						...isolationOut !== void 0 && !isolationLocked ? { isolation: isolationOut } : {},
						presetId: presetOut ?? null
					})) await controller.run(task.id);
				})();
				else (async () => {
					const id = await controller.create({
						title,
						workspaceId,
						urgency,
						description: description.length > 0 ? description : void 0,
						prompt: prompt.length > 0 ? prompt : void 0,
						execution: mode === "scheduled" ? {
							mode,
							cron: cron.trim()
						} : { mode },
						model: picked,
						...isolationOut !== void 0 ? { isolation: isolationOut } : {},
						...presetOut !== void 0 ? { presetId: presetOut } : {}
					});
					if (id !== void 0) await controller.run(id);
				})();
			};
			const hint = !valid ? title.trim().length === 0 ? "请填写标题" : workspaceId === "" ? "请选择项目" : "Cron 表达式无效（分 时 日 月 周）" : mode === "scheduled" && nextRun !== null ? `下次运行 ${fmtTime(nextRun)}` : editing ? `保存后版本 v${task.version} → v${task.version + 1}` : "创建后项目内会话可认领执行";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) controller.closeForm();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal",
					"data-mode": editing ? "edit" : "create",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": editing ? "编辑任务" : "新建任务",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-modal-headicon",
									children: editing ? "✎" : "✚"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-modal-headtext",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: editing ? "编辑任务" : "新建任务" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: editing ? "调整任务内容与执行配置" : "推入看板，项目内会话可认领执行" })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-modal-close",
									"aria-label": "关闭",
									onClick: () => controller.closeForm(),
									children: "✕"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-body",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "标题",
									required: true,
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										ref: titleRef,
										value: title,
										onChange: (e) => setTitle(e.target.value),
										placeholder: "一句话说清要做什么",
										maxLength: 200
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "项目",
									required: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: workspaceId,
										onChange: (e) => setWorkspaceId(e.target.value),
										children: state.workspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: ws.id,
											children: ws.title || ws.path
										}, ws.id))
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "模型（默认 = 会话默认模型）",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										value: model,
										onChange: (e) => setModel(e.target.value),
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: "默认模型"
										}), catalog.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: JSON.stringify({
												provider: m.provider,
												model: m.model
											}),
											children: [
												m.name ?? m.model,
												"（",
												m.provider,
												"）"
											]
										}, `${m.provider}/${m.model}`))]
									})
								}),
								presets.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "执行模式（preset）",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										value: presetId,
										onChange: (e) => setPresetId(e.target.value),
										title: "执行会话按该 preset 组合（决定工具集与人设）；默认 = 部署默认 preset",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: "",
											children: ["跟随部署默认", presetDefault !== void 0 ? `（当前：${presets.find((p) => p.id === presetDefault)?.name ?? presetDefault}）` : ""]
										}), presets.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
											value: p.id,
											children: [p.name ?? p.id, p.id === presetDefault ? "（部署默认）" : ""]
										}, p.id))]
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "紧急度",
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-urgency-picker",
										children: URGENCY_OPTIONS.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-urgency-opt",
											"data-urgency": o.value,
											"data-on": urgency === o.value,
											onClick: () => setUrgency(o.value),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dsh-atb-urgency-name",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dsh-atb-dot",
													"data-urgency": o.value
												}), o.label]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-urgency-hint",
												children: o.hint
											})]
										}, o.value))
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: editing ? "描述" : "描述（可选）",
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										value: description,
										onChange: (e) => setDescription(e.target.value),
										placeholder: "需求细节、验收标准…"
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: editing ? "执行 Prompt" : "执行 Prompt（可选，默认 = 标题+描述）",
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										value: prompt,
										onChange: (e) => setPrompt(e.target.value),
										placeholder: "发给执行会话的完整指令。支持模板变量：{{lastExecution}}（上次执行结果）、{{lastComments}}（最近 3 条评论）"
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
									label: "执行方式",
									full: true,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-mode-picker",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-mode-opt",
											"data-on": mode === "claim",
											onClick: () => setMode("claim"),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-name",
												children: "🤝 认领制"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: "项目内会话认领"
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-mode-opt",
											"data-on": mode === "scheduled",
											onClick: () => setMode("scheduled"),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-name",
												children: "⏰ 定时执行"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: "到点自动开跑"
											})]
										})]
									})
								}),
								mode === "scheduled" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Field, {
									label: "Cron 表达式",
									required: true,
									full: true,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: cronBad ? "dsh-atb-input-bad" : void 0,
										value: cron,
										onChange: (e) => setCron(e.target.value),
										placeholder: "分 时 日 月 周",
										spellCheck: false
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "dsh-atb-cron-presets",
										children: [CRON_PRESETS.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dsh-atb-cron-preset",
											"data-on": cron.trim() === p.cron,
											onClick: () => setCron(p.cron),
											children: p.label
										}, p.cron)), !cronBad && nextRun !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-atb-cron-next",
											children: ["下次 ", fmtTime(nextRun)]
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Field, {
									label: "执行隔离",
									full: true,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-mode-picker",
										"data-disabled": isolationDisabled ? "true" : void 0,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-mode-opt",
											"data-on": isolation === "worktree",
											disabled: isolationDisabled,
											title: isolationLocked ? "任务已有执行记录，隔离方式已锁定" : !gitOk ? "当前项目非 git 仓库" : "每次执行在独立 worktree 分支上进行",
											onClick: () => setIsolation("worktree"),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-name",
												children: "🌿 Worktree 隔离"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: isolationLocked ? "已锁定（执行开始后不可更改）" : !gitOk ? "当前项目非 git 仓库" : "独立分支 task/标题+ID，互不污染"
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dsh-atb-mode-opt",
											"data-on": isolation === "none",
											disabled: isolationDisabled,
											title: isolationLocked ? "任务已有执行记录，隔离方式已锁定" : "直接在项目目录执行（不使用 git）",
											onClick: () => setIsolation("none"),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-name",
												children: "📁 原目录执行"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dsh-atb-mode-hint",
												children: isolationLocked ? "已锁定（执行开始后不可更改）" : !gitOk ? "当前项目非 git 仓库，将在原目录执行" : "不使用 git，直接在项目目录工作"
											})]
										})]
									}), !gitOk && !isolationLocked && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dsh-atb-isolation-note",
										children: "当前项目非 git 仓库，将在原目录执行（任务仍按默认配置创建，运行时自动降级）"
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-atb-modal-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-hint",
								"data-tone": valid ? void 0 : "bad",
								children: hint
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-modal-footbtns",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										onClick: () => controller.closeForm(),
										children: "取消"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										disabled: !valid || runBlocked,
										title: runBlocked ? "任务正在执行中，不能重复发起" : "保存后立即发起执行（新会话）",
										onClick: submitAndRun,
										children: "⚡ 立即执行"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dsh-atb-btn",
										"data-primary": "true",
										disabled: !valid,
										onClick: submit,
										children: editing ? "保存修改" : "创建任务"
									})
								]
							})]
						})
					]
				})
			});
		}

		//#endregion
		//#region src/client/board/TaskBoard.tsx
		/**
		* The main board view: toolbar (project filter, urgency chips, secondary tab,
		* composer), five status columns, the detail pane, and the new-task modal.
		*
		* @module dsh-taskboard/client/board/TaskBoard
		*/
		/** Column labels. */
		const COLUMN_LABELS = {
			backlog: "待规划",
			todo: "待办",
			in_progress: "进行中",
			in_review: "待验收",
			done: "已完成",
			canceled: "已取消",
			archived: "已归档"
		};
		/** Urgency chip labels. */
		const URGENCY_LABELS = {
			urgent: "紧急",
			normal: "一般",
			relaxed: "不急"
		};
		/** Format an epoch ms as a short local stamp. */
		function fmtTime(ms) {
			if (ms === void 0) return "";
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}
		/** A claim idle for longer than this is highlighted as stale (ms). */
		const STALE_CLAIM_MS = 30 * 6e4;
		/** Whether the task's claim is stale (in_progress, held, idle too long). */
		function isStaleClaim(task, now) {
			return task.status === "in_progress" && task.claimedAt !== void 0 && now - task.claimedAt > 18e5;
		}
		/** Urgency sort rank (urgent first). */
		const URGENCY_RANK = {
			urgent: 0,
			normal: 1,
			relaxed: 2
		};
		/** Apply the active filters + search + sort to a task list. */
		function filterTasks(state, tasks) {
			const q = state.search.trim().toLowerCase();
			const filtered = tasks.filter((t) => (state.filters.workspaceId === void 0 || t.workspaceId === state.filters.workspaceId) && (state.filters.urgencies.length === 0 || state.filters.urgencies.includes(t.urgency)) && (q.length === 0 || t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)));
			if (state.sortBy === "default") return filtered;
			const sorted = [...filtered];
			if (state.sortBy === "updated") sorted.sort((a, b) => b.updatedAt - a.updatedAt);
			else if (state.sortBy === "created") sorted.sort((a, b) => b.createdAt - a.createdAt);
			else if (state.sortBy === "urgency") sorted.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || b.updatedAt - a.updatedAt);
			return sorted;
		}
		/**
		* The board view root.
		* @param controller - the controller.
		*/
		function TaskBoard({ controller }) {
			const state = (0, react.useSyncExternalStore)((cb) => controller.subscribe(cb), () => controller.getSnapshot());
			const [now, setNow] = (0, react.useState)(() => Date.now());
			(0, react.useEffect)(() => {
				const timer = setInterval(() => setNow(Date.now()), 6e4);
				return () => clearInterval(timer);
			}, []);
			const live = filterTasks(state, state.ledger.tasks.filter((t) => t.trashedAt === void 0));
			const selected = state.selectedId === void 0 ? void 0 : state.ledger.tasks.find((t) => t.id === state.selectedId);
			const { alert: showAlert, el: alertEl } = useAlert();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-atb-board",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-toolbar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-mobile-only dsh-atb-mobile-nav",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									title: "呼出侧边栏",
									onClick: () => {
										window.__dshAtbLayoutToggle?.();
									},
									children: "☰ 侧边栏"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dsh-atb-btn",
									title: "返回会话",
									onClick: () => controller.closeBoard(),
									children: "✕ 返回"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: "dsh-atb-title",
								children: "Agent 任务看板"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsh-atb-count",
								children: [
									live.length,
									" 任务 · rev ",
									state.ledger.revision
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								"data-primary": "true",
								onClick: () => controller.setComposer(true),
								children: "+ 新建任务"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "dsh-atb-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "dsh-atb-input dsh-atb-search",
								value: state.search,
								placeholder: "搜索标题 / ID…",
								spellCheck: false,
								onChange: (e) => controller.setSearch(e.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "dsh-atb-select",
								value: state.filters.workspaceId ?? "",
								onChange: (e) => controller.setWorkspaceFilter(e.target.value === "" ? void 0 : e.target.value),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "全部项目"
								}), state.workspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: ws.id,
									children: ws.title || ws.path
								}, ws.id))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "dsh-atb-select",
								value: state.sortBy,
								title: "列内排序",
								onChange: (e) => controller.setSortBy(e.target.value),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "default",
										children: "默认排序"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "updated",
										children: "最近更新"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "urgency",
										children: "按紧急度"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "created",
										children: "创建时间"
									})
								]
							}),
							[
								"urgent",
								"normal",
								"relaxed"
							].map((u) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dsh-atb-chip",
								"data-urgency": u,
								"data-on": state.filters.urgencies.includes(u),
								onClick: () => controller.toggleUrgency(u),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsh-atb-dot",
									"data-urgency": u
								}), URGENCY_LABELS[u]]
							}, u)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								onClick: () => controller.toggleSecondary(),
								children: state.secondaryOpen ? "返回看板" : "其它任务"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								title: "健康诊断：遗留 worktree、台账基本项",
								onClick: () => controller.openDiagnostics(),
								children: "⚙ 诊断"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								title: "下载完整台账备份（JSON）",
								onClick: () => controller.exportJson(),
								children: "⬇ JSON"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-btn",
								title: "下载任务清单（CSV）",
								onClick: () => controller.exportCsv(),
								children: "⬇ CSV"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
								className: "dsh-atb-ver",
								href: "https://github.com/cloader/dsh-taskboard",
								target: "_blank",
								rel: "noopener noreferrer",
								children: ["V", PLUGIN_VERSION]
							})
						]
					}),
					state.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-error",
						children: state.error
					}),
					state.secondaryOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SecondaryTab, {
						controller,
						tasks: filterTasks(state, state.ledger.tasks)
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-columns",
						children: MAIN_STATUSES.map((status) => {
							const columnTasks = live.filter((t) => t.status === status);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-column",
								onDragOver: (e) => {
									if (e.dataTransfer.types.includes("application/x-dsh-atb-task")) {
										e.preventDefault();
										e.dataTransfer.dropEffect = "move";
										e.currentTarget.dataset.dragover = "true";
									}
								},
								onDragLeave: (e) => {
									delete e.currentTarget.dataset.dragover;
								},
								onDrop: (e) => {
									e.preventDefault();
									delete e.currentTarget.dataset.dragover;
									const id = e.dataTransfer.getData(DRAG_TYPE);
									if (id.length === 0) return;
									const task = state.ledger.tasks.find((t) => t.id === id);
									if (task === void 0 || task.status === status) return;
									if (!canTransition(task.status, status)) {
										showAlert(`无法从「${COLUMN_LABELS[task.status]}」拖至「${COLUMN_LABELS[status]}」`);
										return;
									}
									controller.move(id, task.version, status);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-colhead",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-dot",
											"data-status": status
										}),
										COLUMN_LABELS[status],
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dsh-atb-colcount",
											children: columnTasks.length
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dsh-atb-cards",
									children: [columnTasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
										task,
										controller,
										draggable: true,
										now,
										onAlert: showAlert
									}, task.id)), columnTasks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-empty",
										children: "无任务"
									})]
								})]
							}, status);
						})
					}),
					selected !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-detailpanel",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskDetail, {
							task: selected,
							controller,
							now
						})
					}),
					state.composerOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskFormModal, {
						controller,
						task: state.editingId === void 0 ? void 0 : state.ledger.tasks.find((t) => t.id === state.editingId)
					}),
					state.diagOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiagnosticsPanel, { controller }),
					alertEl
				]
			});
		}
		/** ⚙ Health-diagnostics panel (plan §3.6): ledger basics + orphan worktrees + one-click cleanup. */
		function DiagnosticsPanel({ controller }) {
			const state = controller.getSnapshot();
			const diag = state.diagnostics;
			const wsName = (id) => {
				const ws = state.workspaces.find((w) => w.id === id);
				return ws?.title ?? ws?.path ?? id.slice(0, 8);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-modal-backdrop",
				onClick: (e) => {
					if (e.target === e.currentTarget) controller.closeDiagnostics();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-modal dsh-atb-diag",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": "健康诊断",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-modal-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-modal-headicon",
								children: "⚙"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-modal-headtext",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "健康诊断" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "台账基本项与 worktree 遗留清理" })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dsh-atb-modal-close",
								"aria-label": "关闭",
								onClick: () => controller.closeDiagnostics(),
								children: "✕"
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsh-atb-modal-body",
						children: diag === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-empty2",
							children: "读取中…"
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-diag-grid",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.revision }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "台账修订号" })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.tasks }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "任务总数" })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										"data-bad": diag.staleRunning > 0 ? "true" : void 0,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.staleRunning }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "执行中" })]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dsh-atb-diag-item",
										"data-bad": diag.orphanWorktrees.length > 0 ? "true" : void 0,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: diag.orphanWorktrees.length }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "遗留 worktree" })]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-diag-sec",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "遗留 worktree（台账无主但目录存在）" }),
									diag.orphanWorktrees.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-empty2",
										children: "无遗留 — 各项目 .dsh-worktrees 目录干净"
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-diag-orphans",
										children: diag.orphanWorktrees.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dsh-atb-diag-orphan",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dsh-atb-diag-orphan-path",
												title: o.path,
												children: [
													wsName(o.workspaceId),
													" · ",
													o.taskId
												]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dsh-atb-btn",
												"data-danger": "true",
												onClick: () => void controller.cleanupOrphan(o.workspaceId, o.taskId),
												children: "清理"
											})]
										}, o.path))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-empty2",
										children: "提示：有未提交修改的遗留目录会被拒绝清理，请先手动处理其内容。live 任务的 worktree 请在任务详情页删除。"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dsh-atb-diag-sec",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: "gitignore 建议" }), (diag.gitIgnoreSuggestions ?? []).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-empty2",
									children: "无待办 — 各 git 项目已忽略 .dsh-worktrees 目录"
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dsh-atb-diag-orphans",
									children: diag.gitIgnoreSuggestions.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dsh-atb-diag-orphan",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dsh-atb-diag-orphan-path",
											title: s.workspacePath,
											children: [
												wsName(s.workspaceId),
												" · 建议在 .gitignore 加入一行 ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: ".dsh-worktrees/" }),
												"（不会自动修改）"
											]
										})
									}, s.workspaceId))
								})]
							})
						] })
					})]
				})
			});
		}
		/** Secondary tab: tasks grouped into canceled / archived / trashed columns. */
		function SecondaryTab({ controller, tasks }) {
			const trashed = tasks.filter((t) => t.trashedAt !== void 0);
			const archived = tasks.filter((t) => t.trashedAt === void 0 && t.status === "archived");
			const canceled = tasks.filter((t) => t.trashedAt === void 0 && t.status === "canceled");
			const groups = [
				{
					label: "已取消",
					dot: "canceled",
					rows: canceled
				},
				{
					label: "已归档",
					dot: "archived",
					rows: archived
				},
				{
					label: "已删除",
					dot: "trashed",
					rows: trashed
				}
			];
			if (trashed.length + archived.length + canceled.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-secondary",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dsh-atb-empty",
					children: "无已取消 / 已归档 / 已删除任务"
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsh-atb-columns",
				children: groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-atb-column",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-colhead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-dot",
								"data-status": group.dot
							}),
							group.label,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-atb-colcount",
								children: group.rows.length
							})
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-atb-cards",
						children: [group.rows.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
							task,
							controller
						}, task.id)), group.rows.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dsh-atb-empty",
							children: "无任务"
						})]
					})]
				}, group.label))
			});
		}

		//#endregion
		//#region src/client/board-mount.tsx
		/**
		* Board view mounting: a container appended inside the `[data-pane=
		* "conversation"]` grid item (a trailing child React never manages), with a
		* stylesheet rule hiding the conversation content while the board is active.
		* Toggling rides a data attribute on <html> — no React involvement in the
		* shell.
		*
		* @module dsh-taskboard/client/board-mount
		*/
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"]";
		const ACTIVE_ATTR = "data-dsh-atb-active";
		/** Sibling panels' activation attributes, evicted when this board opens. */
		const OTHER_ACTIVE_ATTRS = ["data-dsh-taskboard-active", "data-dsh-ssh-active"];
		/** Cross-plugin activation event; detail is the activating panel name. */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "dsh-taskboard";
		/** Find the center column. */
		function conversationColumn() {
			return document.querySelector(CONVERSATION_COLUMN_SELECTOR) ?? void 0;
		}
		/**
		* Mount the board React tree and bind visibility to the controller.
		* @param controller - the controller.
		* @returns disposer.
		*/
		function mountBoard(controller) {
			let root;
			let container;
			const ensure = () => {
				if (container !== void 0) return;
				const column = conversationColumn();
				if (column === void 0) return;
				container = document.createElement("div");
				container.dataset.dshAtbView = "";
				container.className = "dsh-atb-view";
				column.appendChild(container);
				root = (0, react_dom_client.createRoot)(container);
				root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskBoard, { controller }));
			};
			const waitObserver = new MutationObserver(() => {
				ensure();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			const applyActive = () => {
				if (controller.getSnapshot().boardOpen) {
					for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr);
					document.documentElement.setAttribute(ACTIVE_ATTR, "");
					document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
				} else document.documentElement.removeAttribute(ACTIVE_ATTR);
			};
			const onOtherActivate = (event) => {
				if (event.detail !== PANEL_NAME && controller.getSnapshot().boardOpen) controller.closeBoard();
			};
			const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
			const onClickSidebarRow = (event) => {
				if (!controller.getSnapshot().boardOpen) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.closeBoard();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			const unsubscribe = controller.subscribe(applyActive);
			applyActive();
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				waitObserver.disconnect();
				unsubscribe();
				document.documentElement.removeAttribute(ACTIVE_ATTR);
				root?.unmount();
				container?.remove();
			};
		}

		//#endregion
		//#region src/client/session-jump.ts
		/**
		* Build the jump function the controller installs.
		* @param access - lazy service accessors, consulted on every jump.
		* @returns the jump function: `(sessionId) => Promise<SessionJumpResult>`.
		*/
		function createSessionJumper(access) {
			const lookup = (sessions, workspaces, sessionId) => {
				if (sessions.list.getSnapshot().byId[sessionId] === void 0) return "absent";
				return workspaces?.list.getSnapshot().archivedSessionIds.includes(sessionId) ?? false ? "archived" : "openable";
			};
			return async (sessionId) => {
				const sessions = access.getSessions();
				if (sessions === void 0) return "unavailable";
				try {
					let state = lookup(sessions, access.getWorkspaces(), sessionId);
					if (state === "absent") {
						try {
							await sessions.refresh();
						} catch {}
						state = lookup(sessions, access.getWorkspaces(), sessionId);
					}
					if (state === "archived") return "archived";
					if (state === "absent") return "missing";
					sessions.open(sessionId);
					return "opened";
				} catch {
					return "unavailable";
				}
			};
		}

		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half entry for dsh-taskboard: wires the route client and the
		* board controller, exposes the model catalog (via the runtime's llm.models
		* RPC when the connection service is present), mounts the sidebar entry and
		* the board view.
		*
		* Failure policy: DOM mounting problems are logged, never thrown — the web
		* shell fails the whole boot when a plugin apply throws.
		*
		* Export shape: `name` / `inject` / `apply`, no default.
		*
		* @module dsh-taskboard/client
		*/
		/** Client plugin name. */
		const name = "dsh-taskboard/client";
		/** Required client services (fiber inject waiting). */
		const inject = ["connection", "layout"];
		/**
		* Mount the client half.
		* @param ctx - the client context (connection injected).
		*/
		function apply(ctx) {
			try {
				injectStyles();
				const controller = new BoardController(createClient());
				const connection = ctx.get?.("connection");
				if (connection !== void 0) {
					controller.modelCatalog = async () => {
						const response = await connection.api.llm.models({});
						if (!response.result.ok) return [];
						const out = [];
						for (const group of response.result.value.groups) for (const model of group.models) out.push({
							provider: group.id,
							model: model.id,
							name: model.name
						});
						return out;
					};
					controller.presetCatalog = async () => {
						const list = connection.api.agentPresets;
						if (list === void 0) return { presets: [] };
						const response = await list.list({});
						if (!response.result.ok) return { presets: [] };
						const presets = response.result.value.presets.map((p) => ({
							id: p.id,
							name: p.name
						}));
						const def = response.result.value.presets.find((p) => p.isDefault);
						return {
							presets,
							...def !== void 0 ? { defaultId: def.id } : {}
						};
					};
				}
				controller.installSessionJumper(createSessionJumper({
					getSessions: () => ctx.get?.("sessions"),
					getWorkspaces: () => ctx.get?.("workspaces")
				}));
				controller.start();
				const layout = ctx.get?.("layout");
				window.__dshAtbLayoutToggle = () => {
					layout?.toggleSidebar?.();
				};
				const disposers = [];
				try {
					disposers.push(mountSidebarEntry(controller));
					disposers.push(mountBoard(controller));
				} catch (error) {
					console.error("[dsh-taskboard] mount failed:", error);
				}
				ctx.effect?.(() => () => {
					for (const d of disposers.splice(0)) d();
					controller.dispose();
				}, "dsh-taskboard: client mount");
			} catch (error) {
				console.error("[dsh-taskboard] client half failed to start:", error);
			}
		}

		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
