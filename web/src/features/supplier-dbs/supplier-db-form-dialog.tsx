/**
 * 建库 / 改库共用的一张对话框（`SupplierDbFormDialog`），字段一致，建库多一个
 * 「套用厂家模板」开关。对话框归库屏持有（侧栏底钮、侧栏双击、库页「库设置」）。
 */
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

import { COUNTRY_OPTIONS, supplierDbCountryLabel } from "./supplier-db-list"
import type { SupplierDbDraft } from "./supplier-dbs-store"

/**
 * 厂家模板 — the server pre-seeds the agreed prop defs (docs §6.1). The id is a
 * contract with the backend; unknown ids behave like a blank database.
 */
export const SUPPLIER_DB_TEMPLATE_FACTORY = "factory"

/** A country is `''` or ISO-3166-1 alpha-2; the select covers the common ones. */
const COUNTRY_NONE = "none"
const COUNTRY_OTHER = "other"

function countrySelectValue(code: string): string {
  if (!code) return COUNTRY_NONE
  return COUNTRY_OPTIONS.some((option) => option.code === code)
    ? code
    : COUNTRY_OTHER
}

export type DbEditor = {
  /** Undefined = creating; set = editing that database. */
  sourceId?: string
  draft: SupplierDbDraft
}

/**
 * 建库 / 改库同一张表单、同一组字段：按「卖家可见 / 仅平台可见 / 开关」分组，
 * 建库时一次填齐，不必再进库设置补。建库另要厂家登录邮箱，并多一个「套用厂家模板」——
 * 模板只在建库时由服务端预置属性，建后再开没有语义。
 */
export function SupplierDbFormDialog({
  editor,
  busy,
  canRebind = false,
  boundEmail = "",
  onOpenChange,
  onDraftChange,
  onSubmit,
}: {
  editor: DbEditor | null
  busy: boolean
  /** 超级管理员才能换绑。普通平台管理员只看得到当前邮箱。 */
  canRebind?: boolean
  /** 当前已绑定的登录邮箱。和草稿不同才是换绑。 */
  boundEmail?: string
  onOpenChange: (open: boolean) => void
  onDraftChange: (draft: SupplierDbDraft) => void
  onSubmit: () => void | Promise<void>
}) {
  const draft = editor?.draft
  const creating = editor !== null && editor.sourceId === undefined
  const nextEmail = (draft?.accountEmail ?? "").trim().toLowerCase()
  const currentEmail = boundEmail.trim().toLowerCase()
  const rebinding = !creating && canRebind && nextEmail !== "" && nextEmail !== currentEmail
  const toggle = (
    id: string,
    title: string,
    hint: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
  ) => (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{title}</FieldLabel>
        <FieldDescription>{hint}</FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        disabled={busy}
        onCheckedChange={(next) => onChange(next === true)}
      />
    </Field>
  )
  return (
    <Dialog open={editor !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{creating ? "新建平台货源" : "库设置"}</DialogTitle>
          <DialogDescription>一个库对应一个厂家。</DialogDescription>
        </DialogHeader>
        {draft ? (
          <form
            data-supplier-db-form=""
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault()
              void onSubmit()
            }}
          >
            <FieldSet>
              <FieldLegend variant="label">卖家可见</FieldLegend>
              <div className="flex gap-3">
                <Field className="w-20 shrink-0">
                  <FieldLabel htmlFor="supplier-db-icon">图标</FieldLabel>
                  <Input
                    id="supplier-db-icon"
                    value={draft.icon}
                    placeholder="🏭"
                    aria-description="可选，emoji 或留空"
                    className="text-center"
                    disabled={busy}
                    onChange={(event) =>
                      onDraftChange({ ...draft, icon: event.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="supplier-db-name">名称</FieldLabel>
                  <Input
                    id="supplier-db-name"
                    value={draft.name}
                    placeholder="如：义乌博雅达工厂"
                    required
                    autoFocus={creating}
                    disabled={busy}
                    onChange={(event) =>
                      onDraftChange({ ...draft, name: event.target.value })
                    }
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="supplier-db-country">国家 / 地区</FieldLabel>
                <Select
                  value={countrySelectValue(draft.country)}
                  onValueChange={(next) => {
                    if (!next) return
                    onDraftChange({
                      ...draft,
                      country:
                        next === COUNTRY_NONE
                          ? ""
                          : next === COUNTRY_OTHER
                            ? draft.country
                            : next,
                    })
                  }}
                >
                  <SelectTrigger
                    id="supplier-db-country"
                    className="w-full cursor-pointer"
                  >
                    <SelectValue>
                      {() =>
                        draft.country
                          ? supplierDbCountryLabel(draft.country)
                          : "未指定"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={COUNTRY_NONE} className="cursor-pointer">
                      未指定
                    </SelectItem>
                    {COUNTRY_OPTIONS.map((option) => (
                      <SelectItem
                        key={option.code}
                        value={option.code}
                        className="cursor-pointer"
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                    <SelectItem value={COUNTRY_OTHER} className="cursor-pointer">
                      其他（填 ISO 代码）
                    </SelectItem>
                  </SelectContent>
                </Select>
                {countrySelectValue(draft.country) === COUNTRY_OTHER ? (
                  <Input
                    className="mt-1.5"
                    value={draft.country}
                    placeholder="ISO-3166-1，如 DE"
                    disabled={busy}
                    onChange={(event) =>
                      onDraftChange({ ...draft, country: event.target.value })
                    }
                  />
                ) : null}
              </Field>
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">仅平台可见</FieldLegend>
              <Field>
                <FieldLabel htmlFor="supplier-db-account-email">厂家登录邮箱</FieldLabel>
                <FieldDescription>
                  {creating
                    ? "超级管理员建库时开通这个邮箱的厂家账号，并绑定到本库。已有普通账号只绑定，不改密码。"
                    : rebinding
                      ? currentEmail
                        ? `保存后，${boundEmail.trim()} 不能再登录这家厂家。新邮箱没有账号时开通，密码只显示一次。`
                        : "保存后，这个邮箱可以登录这家厂家。没有账号时开通，密码只显示一次。"
                      : canRebind
                        ? "换成另一个邮箱会解除原来的厂家登录。新邮箱没有账号时开通，密码只显示一次；已有普通账号只绑定，不改密码。"
                        : "只有超级管理员可以换绑厂家登录邮箱。"}
                </FieldDescription>
                <Input
                  id="supplier-db-account-email"
                  type="email"
                  autoComplete="off"
                  value={draft.accountEmail ?? ""}
                  placeholder="factory@example.com"
                  required={creating || canRebind}
                  disabled={busy || (!creating && !canRebind)}
                  onChange={(event) =>
                    onDraftChange({ ...draft, accountEmail: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="supplier-db-contact">联系方式</FieldLabel>
                <Input
                  id="supplier-db-contact"
                  value={draft.contact}
                  placeholder="电话、微信或联系人"
                  disabled={busy}
                  onChange={(event) =>
                    onDraftChange({ ...draft, contact: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="supplier-db-note">内部备注</FieldLabel>
                <Textarea
                  id="supplier-db-note"
                  value={draft.internalNote}
                  placeholder="账期、质量、合作注意事项…"
                  rows={2}
                  disabled={busy}
                  onChange={(event) =>
                    onDraftChange({ ...draft, internalNote: event.target.value })
                  }
                />
              </Field>
            </FieldSet>

            <FieldSeparator />

            <FieldGroup>
              {toggle(
                "supplier-db-listed",
                "对卖家可见",
                "关闭后整库商品对卖家隐藏",
                draft.listed,
                (listed) => onDraftChange({ ...draft, listed }),
              )}
              {toggle(
                "supplier-db-accepts-delegate",
                "接受委托生产",
                "关闭只挡新绑定，不动在途委托单",
                draft.acceptsDelegate ?? false,
                (acceptsDelegate) => onDraftChange({ ...draft, acceptsDelegate }),
              )}
              {creating
                ? toggle(
                    "supplier-db-template",
                    "套用厂家模板",
                    "预置常用属性（主营类目、产地、起订量…）",
                    draft.template === SUPPLIER_DB_TEMPLATE_FACTORY,
                    (on) =>
                      onDraftChange({
                        ...draft,
                        template: on ? SUPPLIER_DB_TEMPLATE_FACTORY : null,
                      }),
                  )
                : null}
            </FieldGroup>

            <DialogFooter className="gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                className="cursor-pointer"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="brand"
                disabled={
                  busy ||
                  !draft.name.trim() ||
                  ((creating || canRebind) && !draft.accountEmail?.trim())
                }
                className="cursor-pointer"
              >
                {creating ? "创建" : rebinding ? (currentEmail ? "换绑并保存" : "绑定并保存") : "保存"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
