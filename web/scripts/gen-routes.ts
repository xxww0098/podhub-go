/**
 * Regenerate the ROUTES block of src/api/routes.ts from the generated OpenAPI
 * view (src/api/schema.d.ts).
 *
 * Run it after `bun run api:generate`: the schema is the fact, routes.ts is the
 * SPA's one spelling of it. The hand-written head and tail of routes.ts (the
 * `route()` helper and its documentation) are preserved — only the block between
 * the two markers is rewritten, so a regeneration diff is exactly the paths that
 * moved.
 *
 *   bun run api:routes
 */
import { readFileSync, writeFileSync } from "node:fs"

const SCHEMA = new URL("../src/api/schema.d.ts", import.meta.url)
const ROUTES = new URL("../src/api/routes.ts", import.meta.url)

const OPEN = "export const ROUTES = {\n"
const CLOSE = "} as const satisfies Record<string, ApiPath>"

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** `/api/listing/rows/{id}` -> `listingRowsById`, the same rule as the head documents. */
function keyFor(path: string): string {
  const name = path
    .split("/")
    .slice(2)
    .map((segment) =>
      segment.startsWith("{")
        ? "By" +
          segment
            .replace(/^\{\*?/, "")
            .replace(/\}$/, "")
            .split("_")
            .map(capitalize)
            .join("")
        : segment.split("-").map(capitalize).join(""),
    )
    .join("")
  return name.charAt(0).toLowerCase() + name.slice(1)
}

const schema = readFileSync(SCHEMA, "utf8")
const paths = [...schema.matchAll(/^ {2}"(\/api\/[^"]+)": \{/gm)].map((match) => match[1])
if (paths.length === 0) {
  throw new Error("no /api paths found in schema.d.ts; run api:generate first")
}

const current = readFileSync(ROUTES, "utf8")
const open = current.indexOf(OPEN)
const close = current.indexOf(CLOSE)
if (open < 0 || close < 0) {
  throw new Error("routes.ts lost its generated block markers")
}

const body = paths.map((path) => `  ${keyFor(path)}: "${path}",\n`).join("")
writeFileSync(ROUTES, current.slice(0, open + OPEN.length) + body + current.slice(close))
console.log(`routes.ts: ${paths.length} paths`)
