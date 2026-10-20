import assert from "node:assert/strict"
import test from "node:test"
import { nativeSolutions, type NativeSolutionTable, type Solution } from "./publish-solutions-native"

/** Real negative assignments compiled by the regular TypeScript gate. If any
 * omission becomes admissible, its unused @ts-expect-error fails that gate.
 * No source snapshots, compiler subprocess, emitted files or new dependency. */
function omissionChecks() {
  const { required: omittedCode, ...codes } = nativeSolutions.ozon.validate
  // @ts-expect-error TS2741: the native validate code `required` is mandatory.
  const missingCode: NativeSolutionTable = { ...nativeSolutions, ozon: { ...nativeSolutions.ozon, validate: codes } }
  const { validate: omittedStage, ...stages } = nativeSolutions.ozon
  // @ts-expect-error TS2741: the native stage `validate` is mandatory.
  const missingStage: NativeSolutionTable = { ...nativeSolutions, ozon: stages }
  const { wb: omittedPlatform, ...platforms } = nativeSolutions
  // @ts-expect-error TS2741: the native platform `wb` is mandatory.
  const missingPlatform: NativeSolutionTable = platforms
  const { diagnosticCode: omittedCategory, ...withoutCategory } = nativeSolutions.ozon.validate.required
  // @ts-expect-error Every canonical solution must decide its diagnostic category explicitly.
  const missingCategory: Solution = withoutCategory
  return { missingCode, missingStage, missingPlatform, omittedCode, omittedStage, omittedPlatform, missingCategory, omittedCategory }
}

test("native code, stage and platform omissions remain negative TypeScript assignments", () => {
  const values = omissionChecks()
  assert.equal(Object.hasOwn(values.missingCode.ozon.validate, "required"), false)
  assert.equal(Object.hasOwn(values.missingStage.ozon, "validate"), false)
  assert.equal(Object.hasOwn(values.missingPlatform, "wb"), false)
  assert.ok(values.omittedCode && values.omittedStage && values.omittedPlatform)
  assert.equal(Object.hasOwn(values.missingCategory, "diagnosticCode"), false)
})
