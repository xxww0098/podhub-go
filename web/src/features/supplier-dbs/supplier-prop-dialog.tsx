/**
 * 「＋ 添加属性」/「编辑属性」对话框 — Notion 的 property editor：命名 +
 * 类型（六选一）+ 单选/多选的选项表 + 对卖家可见开关。
 *
 * 创建走 `store.createProp` / `insertPropAt`（列头菜单的左插/右插）；
 * 编辑走 `store.updateProp` —— 值按 `prop_id` 键挂在行上，改属性名不掉值。
 * `PropEditorForm` 是无 Dialog 壳的内联体，node 测试直接渲染它。
 */
import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"

import type {
  SupplierDbPropDef,
  SupplierDbPropOption,
  SupplierDbPropType,
  UpsertSupplierDbPropRequest,
} from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"

import { nextOptionValue } from "./supplier-prop-editors"
import { commandFailure } from "./supplier-dbs-errors"
import {
  SUPPLIER_PROP_TYPE_LABELS,
  SupplierPropIcon,
} from "./supplier-prop-icon"
import type { SupplierDbsStore } from "./supplier-dbs-store"

export const SUPPLIER_PROP_TYPES: readonly SupplierDbPropType[] = [
  "text",
  "long_text",
  "number",
  "select",
  "multi_select",
  "checkbox",
]

/** select / multi_select 需要维护选项表 — 其余类型不需要。 */
export function propTypeHasOptions(type: SupplierDbPropType): boolean {
  return type === "select" || type === "multi_select"
}

export type PropEditorTarget =
  | { mode: "create"; position?: number }
  | { mode: "edit"; def: SupplierDbPropDef }

export type PropDraft = {
  name: string
  type: SupplierDbPropType
  options: SupplierDbPropOption[]
  sellerVisible: boolean
}

export function propDraftFrom(target: PropEditorTarget): PropDraft {
  if (target.mode === "edit") {
    return {
      name: target.def.name,
      type: target.def.type,
      options: target.def.options.map((option) => ({ ...option })),
      sellerVisible: target.def.sellerVisible,
    }
  }
  return { name: "", type: "text", options: [], sellerVisible: true }
}

/** Options 表编辑：标签可改、可增删；value 生成走 nextOptionValue。 */
export function PropOptionsEditor({
  options,
  onChange,
  disabled,
}: {
  options: SupplierDbPropOption[]
  onChange: (next: SupplierDbPropOption[]) => void
  disabled?: boolean
}) {
  const [entry, setEntry] = useState("")

  const addEntry = () => {
    const label = entry.trim()
    if (!label) return
    onChange([
      ...options,
      { value: nextOptionValue(label, options), label },
    ])
    setEntry("")
  }

  return (
    <div className="flex flex-col gap-1.5" data-prop-options-editor="">
      {options.map((option, index) => (
        <div key={option.value} className="flex items-center gap-1.5">
          <Input
            aria-label={`选项 ${index + 1}`}
            value={option.label}
            disabled={disabled}
            className="h-8 flex-1"
            onChange={(event) =>
              onChange(
                options.map((item, i) =>
                  i === index ? { ...item, label: event.target.value } : item,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`删除选项 ${option.label || index + 1}`}
            disabled={disabled}
            className="cursor-pointer text-faint-foreground hover:text-destructive"
            onClick={() => onChange(options.filter((_, i) => i !== index))}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="新选项名称"
          value={entry}
          disabled={disabled}
          placeholder="输入选项名，回车添加"
          className="h-8 flex-1"
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              addEntry()
            }
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="添加选项"
          disabled={disabled || !entry.trim()}
          className="cursor-pointer"
          onClick={addEntry}
        >
          <Plus aria-hidden />
        </Button>
      </div>
      <p className="text-meta text-faint-foreground">
        选项保存在属性定义上，行内点选即写。
      </p>
    </div>
  )
}

/** 表单内联部分（无 Dialog 壳）：name + 类型网格 + 选项表 + 卖家可见。 */
export function PropEditorForm({
  draft,
  onChange,
  busy,
}: {
  draft: PropDraft
  onChange: (next: PropDraft) => void
  busy?: boolean
}) {
  return (
    <FieldGroup className="flex flex-col gap-3" data-prop-editor-form="">
      <Field>
        <FieldLabel htmlFor="supplier-prop-name">名称</FieldLabel>
        <Input
          id="supplier-prop-name"
          value={draft.name}
          placeholder="如 材质 / 规格"
          disabled={busy}
          onChange={(event) =>
            onChange({ ...draft, name: event.target.value })
          }
        />
      </Field>
      <Field>
        <FieldLabel>类型</FieldLabel>
        <div
          role="radiogroup"
          aria-label="属性类型"
          className="grid grid-cols-3 gap-1.5"
        >
          {SUPPLIER_PROP_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={draft.type === type}
              data-prop-type={type}
              disabled={busy}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-compact outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
                draft.type === type &&
                  "border-brand bg-brand-soft text-foreground",
              )}
              onClick={() => onChange({ ...draft, type })}
            >
              <SupplierPropIcon type={type} />
              {SUPPLIER_PROP_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </Field>
      {propTypeHasOptions(draft.type) ? (
        <Field>
          <FieldLabel>选项</FieldLabel>
          <PropOptionsEditor
            options={draft.options}
            disabled={busy}
            onChange={(options) => onChange({ ...draft, options })}
          />
        </Field>
      ) : null}
      <Field className="flex flex-row items-center justify-between gap-4">
        <FieldLabel htmlFor="supplier-prop-visible" className="flex-1">
          对卖家可见
          <span className="block text-xs font-normal text-muted-foreground">
            关闭后该属性不进画廊视图
          </span>
        </FieldLabel>
        <Switch
          id="supplier-prop-visible"
          checked={draft.sellerVisible}
          disabled={busy}
          onCheckedChange={(checked) =>
            onChange({ ...draft, sellerVisible: checked === true })
          }
        />
      </Field>
    </FieldGroup>
  )
}

export function PropEditorDialog({
  store,
  sourceId,
  target,
  onClose,
}: {
  store: SupplierDbsStore
  sourceId: string
  target: PropEditorTarget | null
  onClose: () => void
}) {
  const [draft, setDraft] = useState<PropDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const editing = target?.mode === "edit" ? target.def : null
  const current = draft ?? (target ? propDraftFrom(target) : null)

  // Re-seed the draft whenever a different target opens (dialog stays mounted).
  const [seededFor, setSeededFor] = useState<PropEditorTarget | null>(null)
  if (target !== seededFor) {
    setSeededFor(target)
    setDraft(target ? propDraftFrom(target) : null)
  }

  const submit = async () => {
    if (!target || !current) return
    const name = current.name.trim()
    if (!name) {
      notifyError("请填写属性名")
      return
    }
    if (propTypeHasOptions(current.type) && current.options.length === 0) {
      notifyError("单选 / 多选属性至少需要一个选项")
      return
    }
    const request: UpsertSupplierDbPropRequest = {
      name,
      type: current.type,
      options: current.options.filter((option) => option.label.trim()),
      sellerVisible: current.sellerVisible,
    }
    setBusy(true)
    const result =
      target.mode === "edit"
        ? await store.updateProp(sourceId, editing!.propId, {
            ...request,
            position: editing!.position,
          })
        : target.position === undefined
          ? await store.createProp(sourceId, request)
          : await store.insertPropAt(sourceId, request, target.position)
    setBusy(false)
    if (result.ok) {
      notifySuccess(editing ? "属性已保存" : `属性「${name}」已添加`)
      setDraft(null)
      onClose()
    } else {
      notifyCommandError(
        commandFailure(result),
        editing ? "保存属性失败" : "添加属性失败",
      )
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setDraft(null)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑属性" : "添加属性"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "改属性名不掉值 — 行上的值按属性 id 键存。"
              : "自定义属性会成为库的新列，行内直接填值。"}
          </DialogDescription>
        </DialogHeader>
        {current ? (
          <form
            data-supplier-prop-form=""
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <PropEditorForm
              draft={current}
              busy={busy}
              onChange={setDraft}
            />
            <DialogFooter className="mt-4 gap-2">
              <Button
                type="submit"
                size="sm"
                variant="brand"
                disabled={busy}
                className="cursor-pointer"
              >
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {editing ? "保存" : "添加"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
