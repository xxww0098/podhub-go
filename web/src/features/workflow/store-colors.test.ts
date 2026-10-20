import assert from "node:assert/strict"
import test from "node:test"
import {
  defaultStoreColors,
  parseStoreColorPreferences,
  reassignStoreColor,
  resolveStoreColorAssignments,
} from "./store-colors"

test("store colours default to unique binding-order tones", () => {
  assert.deepEqual(resolveStoreColorAssignments(["a", "b", "c"], {}), {
    a: "blue",
    b: "amber",
    c: "teal",
  })
})

test("cannot choose a colour occupied by another store", () => {
  const next = reassignStoreColor({}, ["a", "b"], "a", "amber")
  assert.deepEqual(resolveStoreColorAssignments(["a", "b"], next), {
    a: "blue",
    b: "amber",
  })
})

test("can choose an unassigned colour", () => {
  const next = reassignStoreColor({}, ["a", "b"], "a", "teal")
  assert.deepEqual(resolveStoreColorAssignments(["a", "b"], next), {
    a: "teal",
    b: "blue",
  })
})

test("reset only removes the current card Stores and preserves other preferences", () => {
  assert.deepEqual(
    defaultStoreColors({ a: "coral", b: "cyan", elsewhere: "olive" }, ["a", "b"]),
    { elsewhere: "olive" },
  )
})

test("stored preferences discard corrupt and unknown palette values", () => {
  assert.deepEqual(
    parseStoreColorPreferences('{"a":"coral","b":"unknown","c":3}'),
    { a: "coral" },
  )
  assert.deepEqual(parseStoreColorPreferences("not-json"), {})
})
