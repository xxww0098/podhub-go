/**
 * The dictionary picker the 默认字段 form control and the workbench 主题 cell share:
 * option list, collection limit, clear, and the close handshake. SSR never mounts
 * Base UI's portal, so these checks walk the emitted element tree instead of a DOM.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  CategoryFieldView,
  CategorySchemaView,
  WorkflowDraftValue,
} from "@/bindings/commands"
import {
  DictionaryDrawerField,
  DictionaryPickerDialog,
} from "./dictionary-drawer-field"

function themeField(
  overrides: Partial<CategoryFieldView> = {},
): CategoryFieldView {
  return {
    key: "attribute_7109",
    name: "主题",
    description: "请从列表中选择或手动输入。",
    group_name: "属性",
    source: "attribute",
    editor: "multi_select",
    complex_group_collection: false,
    read_only: false,
    aspect: null,
    constraints: { required: false, collection: true, max_value_count: 2 },
    attribute_id: 7109,
    options: [
      { id: 1, value: "花卉和植物", info: "", picture: "" },
      { id: 2, value: "猫", info: "", picture: "" },
      { id: 3, value: "风景", info: "", picture: "" },
    ],
    options_truncated: false,
    ...overrides,
  }
}

const schema: CategorySchemaView = {
  description_category_id: 17028964,
  type_id: 94897,
  language: "zh_hans",
  fields: [themeField()],
  complex_groups: [],
}

function pickerTree(input: {
  value?: WorkflowDraftValue
  onChange: (value: WorkflowDraftValue | undefined) => void
  onClose?: () => void
  field?: CategoryFieldView
}) {
  const field = input.field ?? themeField()
  let tree!: ReturnType<typeof DictionaryPickerDialog>
  function Capture() {
    tree = DictionaryPickerDialog({
      open: true,
      onClose: input.onClose ?? (() => undefined),
      field,
      schema,
      targetStoreId: "",
      value: input.value,
      onChange: input.onChange,
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  const pending: ReactNode[] = [tree]
  const elements: ReactElement<Record<string, unknown>>[] = []
  while (pending.length) {
    const element = pending.pop()
    if (!isValidElement<Record<string, unknown>>(element)) continue
    elements.push(element)
    pending.push(...Children.toArray(element.props.children as ReactNode))
    // Base UI triggers take their painted element through `render`, which is an
    // element rather than a child.
    if (isValidElement(element.props.render)) pending.push(element.props.render)
  }
  return elements
}

type Element = ReactElement<Record<string, unknown>>
/** Host button props, once a finder has proven the element is one. */
type ButtonElement = ReactElement<{
  onClick?: () => void
  disabled?: boolean
  children?: ReactNode
}>

/** Option buttons answer to their value; picked ones append the toggle hint. */
function optionButton(elements: readonly Element[], label: string): ButtonElement {
  const element = elements.find(
    (candidate) =>
      candidate.type === "button" &&
      String(candidate.props["aria-label"] ?? "").startsWith(label),
  )
  assert.ok(element, `no option button for ${label}`)
  return element as unknown as ButtonElement
}

function labeledButton(elements: readonly Element[], label: string): ButtonElement {
  const element = elements.find(
    (candidate) =>
      candidate.type === "button" && candidate.props["aria-label"] === label,
  )
  assert.ok(element, `no button labelled ${label}`)
  return element as unknown as ButtonElement
}

function buttonByText(elements: readonly Element[], text: string): ButtonElement {
  const element = elements.find(
    (candidate) => candidate.type === "button" && candidate.props.children === text,
  )
  assert.ok(element, `no button saying ${text}`)
  return element as unknown as ButtonElement
}

const flowers = { dictionary_value_id: 1, value: "花卉和植物" }
const cat = { dictionary_value_id: 2, value: "猫" }

test("the picker collects dictionary values until the field's limit", () => {
  const picks: Array<WorkflowDraftValue | undefined> = []
  const first = pickerTree({ onChange: (value) => picks.push(value) })
  optionButton(first, "花卉和植物").props.onClick!()
  assert.deepEqual(picks[0], { kind: "multi_select", value: [flowers] })

  const second = pickerTree({
    value: { kind: "multi_select", value: [flowers] },
    onChange: (value) => picks.push(value),
  })
  optionButton(second, "猫").props.onClick!()
  assert.deepEqual(picks[1], { kind: "multi_select", value: [flowers, cat] })
})

test("a full collection disables the rest and a picked option toggles off", () => {
  const picks: Array<WorkflowDraftValue | undefined> = []
  const elements = pickerTree({
    value: { kind: "multi_select", value: [flowers, cat] },
    onChange: (value) => picks.push(value),
  })

  assert.equal(
    optionButton(elements, "风景").props.disabled,
    true,
    "最多 2 项之后，未选中的选项不可再点",
  )
  optionButton(elements, "猫").props.onClick!()
  assert.deepEqual(picks[0], { kind: "multi_select", value: [flowers] })
})

test("清空 writes an empty collection and 完成 closes the picker", () => {
  const picks: Array<WorkflowDraftValue | undefined> = []
  let closes = 0
  const elements = pickerTree({
    value: { kind: "multi_select", value: [flowers, cat] },
    onChange: (value) => picks.push(value),
    onClose: () => {
      closes += 1
    },
  })

  labeledButton(elements, "清空").props.onClick!()
  assert.deepEqual(picks[0], { kind: "multi_select", value: [] })

  buttonByText(elements, "完成").props.onClick!()
  assert.equal(closes, 1, "完成 hands the close back to the caller")
})

test("a single choice picks once, closes, and never grows into a list", () => {
  const picks: Array<WorkflowDraftValue | undefined> = []
  let closes = 0
  const elements = pickerTree({
    field: themeField({
      editor: "single_select",
      constraints: { required: false, collection: false },
    }),
    onChange: (value) => picks.push(value),
    onClose: () => {
      closes += 1
    },
  })

  optionButton(elements, "猫").props.onClick!()
  assert.deepEqual(picks[0], {
    kind: "single_select",
    value: cat,
  })
  assert.equal(closes, 1, "单选选完即关，不留在弹窗里")
})

test("the drawer trigger summarises the pick and the dictionary size", () => {
  const empty = renderToStaticMarkup(
    <DictionaryDrawerField
      field={themeField()}
      schema={schema}
      targetStoreId=""
      value={undefined}
      invalid={false}
      onChange={() => undefined}
    />,
  )
  assert.match(empty, /data-dictionary-trigger="attribute_7109"/)
  assert.match(empty, /浏览并选择/)
  assert.match(empty, /3 个选项/)

  const picked = renderToStaticMarkup(
    <DictionaryDrawerField
      field={themeField()}
      schema={schema}
      targetStoreId=""
      value={{ kind: "multi_select", value: [flowers, cat] }}
      invalid={false}
      onChange={() => undefined}
    />,
  )
  assert.match(picked, /花卉和植物、猫/)
  assert.match(picked, /已选 2 项/)
  assert.doesNotMatch(picked, /浏览并选择/)
})
