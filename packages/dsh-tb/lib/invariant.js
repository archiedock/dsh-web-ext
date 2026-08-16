//#region src/invariant.ts
/**
* Invariant companion for dsh-taskboard.
*
* DSH convention (see dsh-base / dsh-workspace): packages may ship an
* `./invariant` export — a minimal companion plugin that reserves package
* ownership in compositions that load invariants without the full plugin.
* No behavior in P0; the real plugin carries everything.
*/
/** Cordis plugin name. */
const name = "dsh-taskboard-invariant";
/** No services required. */
const inject = [];
/**
* Register the invariant companion (no-op in P0).
* @param _ctx - the plugin context.
*/
function apply(_ctx) {}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=invariant.js.map