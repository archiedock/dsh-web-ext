/**
 * Wrap the CJS client bundle (lib/client.cjs, built by tsdown.client.config.ts)
 * into the DSH web shell's lazy-CJS plugin registration format.
 *
 * The web shell's module loader (dsh-client-modules) executes the served
 * /plugins/<id>/client.js classic script, which must REGISTER — not run —
 * the plugin: a single `window.__ModuleLoader__.load({ id, factory })` call
 * whose factory materializes the module on demand with a host-provided
 * `require` (react, @deepseek-ai/* leaves). The factory body is the CJS
 * bundle verbatim; `module.exports` is the plugin's exports surface
 * (name / inject / apply).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const cjs = readFileSync(new URL('../lib/client.cjs', import.meta.url), 'utf8')

const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${cjs
  .split('\n')
  .map(line => (line === '' ? '' : `\t\t${line}`))
  .join('\n')}
\t\treturn module.exports;
\t}
});
`

writeFileSync(new URL('../lib/client.js', import.meta.url), out)
console.log(`wrapped lib/client.cjs (${cjs.length} bytes) -> lib/client.js (${out.length} bytes)`)
