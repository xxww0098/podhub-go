import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import { DialogBody } from "../src/components/ui/dialog"
import { ConfirmDialog } from "../src/components/ui/confirm-dialog"

test("DialogBody renders with standard scrollable slot and structure", () => {
  const html = renderToStaticMarkup(
    <DialogBody className="custom-test-body">
      <span>Modal Body Content</span>
    </DialogBody>,
  )

  assert.match(html, /data-slot="dialog-body"/)
  assert.match(html, /custom-test-body/)
  assert.match(html, /Modal Body Content/)
  assert.match(html, /overflow-y-auto/)
})

test("ConfirmDialog component source enforces standard design contracts and invariants", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/components/ui/confirm-dialog.tsx", import.meta.url)),
    "utf8",
  )

  assert.match(source, /export function ConfirmDialog/)
  assert.match(source, /DialogHeader/)
  assert.match(source, /DialogTitle/)
  assert.match(source, /DialogDescription/)
  assert.match(source, /DialogFooter/)
  assert.match(source, /Spinner/)
  assert.match(source, /variant = "destructive"/)
  assert.match(source, /footerLayout/)
  assert.match(source, /showCloseButton/)
  assert.match(source, /sizeClasses/)
  assert.match(source, /sm:max-w-sm/)
  assert.match(source, /sm:max-w-md/)
  assert.match(source, /sm:max-w-lg/)
})

test("ConfirmDialog is consumed across feature screens instead of repeated boilerplate", () => {
  const workbenchSource = readFileSync(
    fileURLToPath(new URL("../src/features/workflow/workbench/workbench-dialogs.tsx", import.meta.url)),
    "utf8",
  )
  assert.match(workbenchSource, /<ConfirmDialog/)
  assert.match(workbenchSource, /title={`清空 \${pendingClearIds\.length} 行的生成内容？`}/)
  assert.match(workbenchSource, /title={`删除 \${pendingDeleteIds\.length} 行商品？`}/)
  assert.match(workbenchSource, /confirmText="确认发送"/)

  const cardLibrarySource = readFileSync(
    fileURLToPath(new URL("../src/features/workflow/card-library.tsx", import.meta.url)),
    "utf8",
  )
  assert.match(cardLibrarySource, /<ConfirmDialog/)
  assert.match(cardLibrarySource, /"删除上架方案？"/)

  const usersSource = readFileSync(
    fileURLToPath(new URL("../src/features/users/users-screen.tsx", import.meta.url)),
    "utf8",
  )
  assert.match(usersSource, /<ConfirmDialog/)
  assert.match(usersSource, /title="停用账户？"/)
  assert.match(usersSource, /`删除「\${workspace\.name}」？`/)

  const redeemSource = readFileSync(
    fileURLToPath(new URL("../src/features/redeem-codes/redeem-codes-screen.tsx", import.meta.url)),
    "utf8",
  )
  assert.match(redeemSource, /<ConfirmDialog/)
  assert.match(redeemSource, /title="删除兑换码？"/)
  // 一次性完整码不再叠确认弹窗：保存与放弃都是保存弹窗页脚上的按钮。
  assert.doesNotMatch(redeemSource, /尚未保存完整兑换码/)

  const fieldsSource = readFileSync(
    fileURLToPath(new URL("../src/features/workflow/default-fields-dialog.tsx", import.meta.url)),
    "utf8",
  )
  assert.match(fieldsSource, /<ConfirmDialog/)
  assert.match(fieldsSource, /title="删除字段包？"/)
})
