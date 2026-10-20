import assert from "node:assert/strict"
import test from "node:test"
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { Button } from "@/components/ui/button"

import { SupplierDbFormDialog } from "./supplier-db-form-dialog"
import { EMPTY_DB_DRAFT } from "./supplier-dbs-store"

function tree(accountEmail: string, boundEmail: string) {
  let root!: ReactElement
  function Capture() {
    root = SupplierDbFormDialog({
      editor: {
        sourceId: "src_1",
        draft: { ...EMPTY_DB_DRAFT, name: "探针", accountEmail },
      },
      busy: false,
      canRebind: true,
      boundEmail,
      onOpenChange: () => undefined,
      onDraftChange: () => undefined,
      onSubmit: () => undefined,
    }) as ReactElement
    return null
  }
  renderToStaticMarkup(<Capture />)
  const pending: ReactNode[] = [root]
  const elements: ReactElement<Record<string, unknown>>[] = []
  while (pending.length) {
    const element = pending.pop()
    if (!isValidElement<Record<string, unknown>>(element)) continue
    elements.push(element)
    pending.push(...Children.toArray(element.props.children as ReactNode))
  }
  return elements
}

function submitLabel(accountEmail: string, boundEmail: string): string {
  const button = tree(accountEmail, boundEmail).find(
    (element) => element.type === Button && element.props.type === "submit",
  )
  assert.ok(button, "missing submit")
  assert.equal(typeof button.props.children, "string")
  return button.props.children as string
}

test("邮箱没变仍是保存；换掉才标明会解除原登录", () => {
  assert.equal(submitLabel("old@example.com", "Old@Example.com"), "保存")
  assert.equal(submitLabel("next@example.com", "old@example.com"), "换绑并保存")
  assert.equal(submitLabel("next@example.com", ""), "绑定并保存")
  const copy = tree("next@example.com", "old@example.com")
    .map((element) => element.props.children)
    .filter((child) => typeof child === "string")
    .join("\n")
  assert.match(copy, /old@example.com 不能再登录这家厂家/)
})
