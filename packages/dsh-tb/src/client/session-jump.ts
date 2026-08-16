/**
 * Session jump: resolve an execution's session against the runtime's live
 * session list and open it in the GUI. The runtime's `sessions` service owns
 * the list mirror (`list.getSnapshot().byId`) and staging (`open`); the
 * `workspaces` service carries the registry-global archive set.
 *
 * Outcomes are split so the UI can prompt precisely:
 * - `opened`     — staged and opened; the board closes over it.
 * - `archived`   — in the list but archived (hidden from the sidebar; its log
 *                  survives, so it is distinguishable from deletion).
 * - `missing`    — absent from the live list: deleted.
 * - `unavailable`— runtime session services absent (service timing / errors).
 *
 * Service resolution is deliberately LAZY (per click): plugin apply may run
 * before the runtime provides `sessions`, and a once-captured undefined would
 * permanently disable the jump. When the id misses, the list mirror may also
 * simply lag (reconnect re-pull, late mount): one `refresh()` is awaited and
 * the lookup retried before deciding.
 *
 * @module dsh-taskboard/client/session-jump
 */

/** Outcome of one jump attempt. */
export type SessionJumpResult =
  | 'opened'
  | 'archived'
  | 'missing'
  | 'unavailable'

/** Narrow face of the runtime `sessions` service this module needs. */
export interface SessionsServiceFace {
  /** Select a listed session as current (the window opens with it). */
  open(id: string): void
  /** Re-pull the session list baseline (mirror catch-up). */
  refresh(): Promise<void>
  /** Live session list snapshot. */
  list: {
    getSnapshot(): {
      byId: Record<string, unknown>
    }
  }
}

/** Narrow face of the runtime `workspaces` service this module needs. */
export interface WorkspacesServiceFace {
  /** Workspace list snapshot (carries the archive set). */
  list: {
    getSnapshot(): {
      archivedSessionIds: readonly string[]
    }
  }
}

/** Lazy per-click service resolution (services may appear after apply). */
export interface SessionServiceAccess {
  /** The runtime sessions service, when currently provided. */
  getSessions(): SessionsServiceFace | undefined
  /** The runtime workspaces service, when currently provided (optional). */
  getWorkspaces(): WorkspacesServiceFace | undefined
}

/**
 * Build the jump function the controller installs.
 * @param access - lazy service accessors, consulted on every jump.
 * @returns the jump function: `(sessionId) => Promise<SessionJumpResult>`.
 */
export function createSessionJumper(access: SessionServiceAccess): (sessionId: string) => Promise<SessionJumpResult> {
  const lookup = (sessions: SessionsServiceFace, workspaces: WorkspacesServiceFace | undefined, sessionId: string): 'openable' | 'archived' | 'absent' => {
    const list = sessions.list.getSnapshot()
    if (list.byId[sessionId] === undefined) return 'absent'
    const archived = workspaces?.list.getSnapshot().archivedSessionIds.includes(sessionId) ?? false
    return archived ? 'archived' : 'openable'
  }
  return async (sessionId: string): Promise<SessionJumpResult> => {
    const sessions = access.getSessions()
    if (sessions === undefined) return 'unavailable'
    try {
      let state = lookup(sessions, access.getWorkspaces(), sessionId)
      if (state === 'absent') {
        // Only the absent case can be a lagging mirror (reconnect re-pull,
        // late mount); archived is a definitive verdict. One refresh, re-check.
        try { await sessions.refresh() } catch { /* keep the pre-refresh verdict */ }
        state = lookup(sessions, access.getWorkspaces(), sessionId)
      }
      if (state === 'archived') return 'archived'
      if (state === 'absent') return 'missing'
      sessions.open(sessionId)
      return 'opened'
    } catch {
      return 'unavailable'
    }
  }
}
