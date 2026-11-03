import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { ERROR_ID_PATTERN, formatErrorId, newErrorId } from "./error-id"

test("Base32 receipts retain all 64 bits, including leading zeroes and the maximum value", () => {
  const random = mock.method(crypto, "getRandomValues")
  try {
    for (const [high, low, expected] of [
      [0, 0, "0000000000000"],
      [0, 1, "0000000000001"],
      [0x798e_89b8, 0x9a6c_22da, "7K3M9Q2D6R8PT"],
      [0xffff_ffff, 0xffff_ffff, "FZZZZZZZZZZZZ"],
    ] as const) {
      random.mock.mockImplementation((array) => {
        new Uint32Array(array.buffer, array.byteOffset, 2).set([high, low])
        return array
      })
      const id = newErrorId()
      assert.equal(id, expected)
      assert.match(id, ERROR_ID_PATTERN)
    }
  } finally { random.mock.restore() }
})

test("receipt presentation groups 4-4-5 without changing the stored ID", () => {
  const id = "7K3M9Q2D6R8PT"
  assert.equal(formatErrorId(id), "7K3M-9Q2D-6R8PT")
  assert.equal(formatErrorId(id).replaceAll("-", ""), id)
  assert.equal(formatErrorId("another-event-id"), "another-event-id")
})
