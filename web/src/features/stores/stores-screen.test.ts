import assert from "node:assert/strict";
import test from "node:test";

import type { StoreBusyKind } from "./use-store-commands";
import { createStoreGate } from "./stores-screen";

const BASE = {
  rosterLoaded: true,
  hasWorkspace: true,
  storesUsed: 1,
  storeLimit: 5,
  busy: undefined,
  draftOpen: false,
};

test("an open create draft disables the button and says why", () => {
  // The walkthrough's 1/5 case: quota free, nothing busy, but the draft
  // dialog is open — the button must be grey AND carry a reason, otherwise
  // the tooltip never renders and the operator sees an unexplained lock.
  const gate = createStoreGate({ ...BASE, draftOpen: true });
  assert.equal(gate.canCreate, false);
  assert.match(gate.disabledReason ?? "", /正在新建店铺/);
  assert.match(gate.disabledReason ?? "", /完成或取消/);
});

test("every busy kind disables creation with the busy reason", () => {
  const kinds: StoreBusyKind[] = [
    "load",
    "save",
    "clear",
    "delete",
    "test",
    "assign",
    "grant",
    "import",
    "export",
    "tag",
  ];
  for (const busy of kinds) {
    const gate = createStoreGate({ ...BASE, busy });
    assert.equal(gate.canCreate, false, `busy=${busy} must disable creation`);
    assert.equal(gate.disabledReason, "请稍候，正在处理…");
  }
});

test("each blocking condition maps to exactly one reason", () => {
  assert.deepEqual(createStoreGate({ ...BASE, rosterLoaded: false }), {
    canCreate: false,
    disabledReason: "请先登录并加载当前 Workspace 的店铺名册",
  });
  assert.deepEqual(createStoreGate({ ...BASE, hasWorkspace: false }), {
    canCreate: false,
    disabledReason: "请先加入或创建 Workspace",
  });
  assert.deepEqual(
    createStoreGate({ ...BASE, storesUsed: 5, storeLimit: 5 }),
    {
      canCreate: false,
      disabledReason: "当前 Workspace 店铺名额 5，已达上限",
    },
  );
});

test("a free slot with nothing parked enables creation without a reason", () => {
  const gate = createStoreGate(BASE);
  assert.equal(gate.canCreate, true);
  assert.equal(gate.disabledReason, undefined);
});
