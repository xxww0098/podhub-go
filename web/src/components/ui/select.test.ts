import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const source = readFileSync(fileURLToPath(new URL("./select.tsx", import.meta.url)), "utf8")

test("select popup floors at trigger width, grows to content, and caps to viewport", () => {
  assert.match(source, /min-w-\(--anchor-width\)/)
  assert.match(source, /max-w-\(--available-width\)/)
  assert.doesNotMatch(source, /(?<![\w-])w-\(--anchor-width\)/)
})

test("select item text may wrap instead of being clipped at the popup edge", () => {
  const itemText = source.match(/ItemText className="([^"]+)"/)?.[1] ?? ""
  assert.equal(itemText.includes("whitespace-nowrap"), false)
  assert.equal(itemText.includes("shrink-0"), false)
})
