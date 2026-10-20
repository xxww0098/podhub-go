import assert from "node:assert/strict"
import test from "node:test"

import { isCredentialExpiredAt } from "./credential-expiry"

test("only a real timestamp already passed counts as an expired key", () => {
  const now = 1_700_000_000_000
  assert.equal(isCredentialExpiredAt(now - 1, now), true)
  // Cloud's boundary: an expiry equal to now is already lapsed.
  assert.equal(isCredentialExpiredAt(now, now), true)
  assert.equal(isCredentialExpiredAt(now + 1, now), false)
  // null/absent is the legacy key that never expires; 0 is a real timestamp.
  assert.equal(isCredentialExpiredAt(null, now), false)
  assert.equal(isCredentialExpiredAt(undefined, now), false)
  assert.equal(isCredentialExpiredAt(0, now), true)
})
