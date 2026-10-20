/**
 * The SPA has one path authority: ./routes.ts.
 *
 * A path spelled anywhere else is a second fact about the same endpoint, and the
 * two drift silently: the SPA keeps calling a route the server renamed, and only
 * production notices. This gate is what makes the authority real.
 *
 * It is a ratchet. The files that predate the authority are listed below; each
 * one that stops carrying a literal must have its line deleted, so the list can
 * only shrink. A file that grows a new literal fails immediately.
 *
 * Only a literal whose value starts with the Cloud prefix counts: an import from
 * @/api/client contains the same characters and is not a path.
 */
import assert from 'node:assert/strict'
import { ROUTES } from './routes'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** A string literal whose value is a Cloud path. */
const PATH_LITERAL = /["'`]\/api\//

/**
 * Files whose "/api/..." literal is deliberately not a route call: the client
 * failure fixtures point at paths no router serves, and the mounted-route
 * ratchet carries the paths it has to compare rather than calling them.
 */
const NON_ROUTE_LITERAL_FILES = new Set(["api/client.test.ts", "api/mounted.test.ts"])

/** The authority and the generated view it is pinned to. */
const AUTHORITY = new Set(["api/routes.ts", "api/schema.d.ts"])

/**
 * Files that still spell a Cloud path themselves. Shrink only: delete the line
 * when the file stops carrying one, and never add one for a new call site —
 * spell the path in @/api/routes and import it.
 */
const LEGACY_LITERAL_FILES = new Set([
  "features/category-schema/schema-revision-cache.test.ts",
  "features/workflow/listing-commands.test.ts",
])

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sources(path, found)
      continue
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path)
  }
  return found
}

/**
 * Comment lines call nothing: a path named in prose is documentation, and a file
 * whose only remaining mention is a comment has already been migrated.
 */
function codeLines(absolute: string): string {
  return readFileSync(absolute, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

test('every Cloud path comes from the routes authority', () => {
  const offenders: string[] = []
  const stale: string[] = []
  for (const absolute of sources(SRC)) {
    const path = relative(SRC, absolute)
    if (AUTHORITY.has(path) || NON_ROUTE_LITERAL_FILES.has(path)) continue
    const carries = PATH_LITERAL.test(codeLines(absolute))
    const listed = LEGACY_LITERAL_FILES.has(path)
    if (carries && !listed) offenders.push(path)
    if (!carries && listed) stale.push(path)
  }
  assert.deepEqual(
    offenders,
    [],
    'these files spell a Cloud path themselves; add the path to @/api/routes and call route(...) instead',
  )
  assert.deepEqual(
    stale,
    [],
    'these files no longer carry a path literal; delete their LEGACY_LITERAL_FILES line',
  )
})

/**
 * The authority has to be the whole truth, not a subset: a route the server
 * added is one the SPA can call, and forgetting to regenerate routes.ts leaves
 * it unreachable from typed code.
 */
test('routes.ts spells the documented paths', () => {
  const schema = readFileSync(join(SRC, 'api/schema.d.ts'), 'utf8')
  const documented = new Set(
    [...schema.matchAll(/^ {2}"(\/api\/[^"]+)": \{/gm)].map((match) => match[1]),
  )
  const spelled = new Set<string>(Object.values(ROUTES))
  assert.ok(documented.size > 0, 'schema.d.ts carries no /api paths; the scan is broken')
  assert.deepEqual(
    [...documented].filter((path) => !spelled.has(path)).sort(),
    [],
    'documented but missing from routes.ts; run bun run api:routes',
  )
  assert.deepEqual(
    [...spelled].filter((path) => !documented.has(path)).sort(),
    [],
    'spelled in routes.ts but no longer documented; run bun run api:routes',
  )
})
