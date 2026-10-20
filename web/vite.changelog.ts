import { readFileSync } from "node:fs"
import path from "node:path"

import { CHANGELOG_VISIBLE_LIMIT, parseChangelog } from "./src/lib/changelog.ts"

/**
 * JSON for Vite `define`. A missing or unreadable CHANGELOG becomes `[]`
 * so the SPA still builds and the dialog can show its empty state.
 */
export function changelogJsonFromRoot(fromDir: string): string {
  try {
    const markdown = readFileSync(path.resolve(fromDir, "../CHANGELOG.md"), "utf8")
    return JSON.stringify(parseChangelog(markdown, CHANGELOG_VISIBLE_LIMIT))
  } catch {
    return "[]"
  }
}
