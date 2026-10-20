/** 主要信息：供货事实与素材失焦即写；平台价确认后追加新版本。 */
import { useRef, useState } from "react"
import {
  Box,
  Brush,
  ClipboardList,
  Clock,
  Hash,
  Layers,
  Plus,
  Ruler,
  Scale,
  Tag,
  Type,
  Weight,
} from "lucide-react"

import type {
  SupplierDbPropDef,
  SupplierDbRow,
  UpsertSupplierDbPropRequest,
} from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { notifyError } from "@/lib/notify"

import { SupplierPropIcon } from "./supplier-prop-icon"
import {
  CommitInput,
  CommitTextarea,
  centsToInput,
  formatCnyCents,
  nonNegativeCentsFromYuan,
  positiveIntFromInput,
  priceCentsFromYuan,
} from "./supplier-prop-editors"
import {
  CustomPropField,
  PropRow,
  SheetSection,
  WeightCommitInput,
  type Patch,
  type PatchFn,
} from "./supplier-row-fields"
import { SupplierRowMedia } from "./supplier-row-media"

export function SupplierRowInfoTab({
  row,
  propDefs,
  onPatch,
  onUpdateProp,
  onAddProp,
  onAdjustPrice,
}: {
  row: SupplierDbRow
  propDefs: SupplierDbPropDef[]
  onPatch: PatchFn
  onUpdateProp?: (
    def: SupplierDbPropDef,
    patch: Partial<UpsertSupplierDbPropRequest>,
  ) => Promise<boolean>
  onAddProp?: () => void
  onAdjustPrice: (priceCents: number, note: string) => Promise<boolean>
}) {
  const [adjusting, setAdjusting] = useState(false)
  const [price, setPrice] = useState("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const pending = useRef(false)

  return (
    <div className="flex flex-col gap-5" data-supplier-row-info-tab="">
      <SheetSection title="商品资料" columns={2}>
        <PropRow icon={<Type />} name="名称">
          <CommitInput
            ariaLabel="名称"
            value={row.title}
            placeholder="未命名"
            onCommit={(next) => onPatch({ title: next })}
          />
        </PropRow>
        <PropRow icon={<Hash />} name="编号">
          <CommitInput
            ariaLabel="编号"
            value={row.platformCode}
            placeholder="全库唯一"
            mono
            onCommit={(next) => onPatch({ platformCode: next })}
          />
        </PropRow>
        {/* 规格是同款切换的判别字段：跟编号放一起，改它即改页头规格名。 */}
        <PropRow icon={<Ruler />} name="规格">
          <CommitInput
            ariaLabel="规格"
            value={row.size}
            placeholder="如 40×50cm"
            onCommit={(next) => onPatch({ size: next })}
          />
        </PropRow>
        <PropRow icon={<Layers />} name="款号（同款分组）">
          <CommitInput
            ariaLabel="款号（同款分组）"
            value={row.variantGroup ?? ""}
            placeholder="留空为独立商品"
            onCommit={(next) => onPatch({ variantGroup: next })}
          />
        </PropRow>
        <PropRow icon={<Layers />} name="材质">
          <CommitInput
            ariaLabel="材质"
            value={row.material}
            placeholder="如 纯棉"
            onCommit={(next) => onPatch({ material: next })}
          />
        </PropRow>
        <PropRow icon={<Tag />} name="品牌">
          <CommitInput
            ariaLabel="品牌"
            value={row.brand}
            placeholder="如 无品牌"
            onCommit={(next) => onPatch({ brand: next })}
          />
        </PropRow>
        <PropRow icon={<Brush />} name="工艺">
          <CommitInput
            ariaLabel="工艺"
            value={row.craft}
            placeholder="如 数码直喷"
            onCommit={(next) => onPatch({ craft: next })}
          />
        </PropRow>
        <PropRow icon={<Clock />} name="交期">
          <CommitInput
            ariaLabel="交期"
            value={row.leadTime}
            placeholder="如 3–5 天"
            onCommit={(next) => onPatch({ leadTime: next })}
          />
        </PropRow>
        {propDefs.map((def) => (
          <PropRow
            key={def.propId}
            icon={<SupplierPropIcon type={def.type} />}
            name={def.name}
            locked={!def.sellerVisible}
            wide={def.type === "long_text" || def.type === "multi_select"}
          >
            <CustomPropField
              def={def}
              row={row}
              onPatch={onPatch}
              onUpdateProp={onUpdateProp}
            />
          </PropRow>
        ))}
        {onAddProp ? (
          <button
            type="button"
            className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-compact text-faint-foreground hover:text-foreground"
            data-supplier-row-add-prop=""
            onClick={onAddProp}
          >
            <Plus aria-hidden className="size-3.5" />
            添加属性
          </button>
        ) : propDefs.length ? null : (
          <p className="text-meta text-faint-foreground">
            自定义属性在表头「＋ 添加属性」维护。
          </p>
        )}
      </SheetSection>

      <SheetSection title="价格" columns={2}>
        <PropRow icon={<Hash />} name="成本价" locked>
          <CommitInput
            ariaLabel="成本价（元）"
            value={centsToInput(row.costCents)}
            inputMode="decimal"
            mono
            placeholder="¥"
            onCommit={async (next) => {
              const cents = priceCentsFromYuan(next)
              if (cents === undefined) {
                notifyError("成本价需为大于 0 的金额（元）")
                return false
              }
              return onPatch({ costCents: cents })
            }}
          />
        </PropRow>
        {/* 不填即零运费：空值在面板里按 ¥0.00 读出；提交 0 或清空都落回
            null —— offer 行只记 > 0 的成本事实（ck_sc_source_offers_shipping）。 */}
        <PropRow icon={<Hash />} name="运费" locked>
          <CommitInput
            ariaLabel="运费（元）"
            value={centsToInput(row.shippingCostCents ?? 0)}
            inputMode="decimal"
            mono
            placeholder="¥"
            onCommit={async (next) => {
              const cents = nonNegativeCentsFromYuan(next)
              if (cents === undefined) {
                notifyError("运费需为不小于 0 的金额（元）")
                return false
              }
              return onPatch({ shippingCostCents: cents === 0 ? null : cents })
            }}
          />
        </PropRow>
        <PropRow icon={<Hash />} name="平台价">
          <div className="flex min-h-9 items-center justify-between gap-2">
            <span className="font-mono tabular-nums">{formatCnyCents(row.platformPriceCents)}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setPrice(centsToInput(row.platformPriceCents))
                setNote("")
                setInvalid(false)
                setAdjusting(true)
              }}
            >
              调价
            </Button>
          </div>
        </PropRow>
        <PropRow icon={<Hash />} name="建议零售价">
          <CommitInput
            ariaLabel="建议零售价（元）"
            value={centsToInput(row.suggestedRetailCents)}
            inputMode="decimal"
            mono
            placeholder="¥"
            onCommit={async (next) => {
              const cents = priceCentsFromYuan(next)
              if (cents === undefined) {
                notifyError("零售价需为大于 0 的金额（元）")
                return false
              }
              return onPatch({ suggestedRetailCents: cents })
            }}
          />
        </PropRow>
        <PropRow icon={<Hash />} name="平台划线价">
          <CommitInput
            ariaLabel="平台划线价（元）"
            value={centsToInput(row.suggestedOldPriceCents)}
            inputMode="decimal"
            mono
            placeholder="¥"
            onCommit={async (next) => {
              const cents = priceCentsFromYuan(next)
              if (cents === undefined) {
                notifyError("划线价（平台）需为大于 0 的金额（元）")
                return false
              }
              return onPatch({ suggestedOldPriceCents: cents })
            }}
          />
        </PropRow>
      </SheetSection>

      <SheetSection title="包装与清单" columns={2}>
        <p className="col-span-full text-meta text-muted-foreground">
          厂家供货资料；各销售平台的包装字段独立维护。
        </p>
        <PropRow icon={<Box />} name="包装尺寸" wide>
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["packWidthMm", "包装宽度"],
                ["packHeightMm", "包装高度"],
                ["packDepthMm", "包装深度"],
              ] as const
            ).map(([key, label], index) => (
              <label key={key} className="flex min-w-0 flex-col gap-1.5 text-meta text-muted-foreground">
                {label}（mm）
                <CommitInput
                  ariaLabel={`${label}（mm）`}
                  value={row[key] == null ? "" : String(row[key])}
                  inputMode="decimal"
                  mono
                  placeholder={["宽", "高", "深"][index]}
                  onCommit={async (next) => {
                    const mm = positiveIntFromInput(next)
                    if (mm === undefined) {
                      notifyError(`${label}需为大于 0 的整数（mm）`)
                      return false
                    }
                    return onPatch({ [key]: mm } as Patch)
                  }}
                />
              </label>
            ))}
          </div>
        </PropRow>
        <PropRow icon={<Weight />} name="毛重">
          <WeightCommitInput
            name="毛重"
            grams={row.grossWeightG}
            onCommit={(grams) => onPatch({ grossWeightG: grams })}
          />
        </PropRow>
        <PropRow icon={<Scale />} name="包装重量">
          <WeightCommitInput
            name="包装重量"
            grams={row.packWeightG}
            onCommit={(grams) => onPatch({ packWeightG: grams })}
          />
        </PropRow>
        <PropRow icon={<ClipboardList />} name="商品清单" wide>
          <CommitTextarea
            ariaLabel="商品清单"
            value={row.contents}
            rows={3}
            placeholder="商品包含什么，每行一件，如 画布 40×50cm ×1"
            onCommit={(next) => onPatch({ contents: next })}
          />
        </PropRow>
      </SheetSection>

      <SheetSection title="素材">
        <SupplierRowMedia row={row} />
      </SheetSection>

      <SheetSection title="描述与备注">
        <PropRow icon={<Type />} name="商品描述">
          <CommitTextarea
            ariaLabel="商品描述"
            value={row.description}
            rows={5}
            placeholder="多行正文，按换行展示"
            onCommit={(next) => onPatch({ description: next })}
          />
        </PropRow>
        <PropRow icon={<ClipboardList />} name="内部备注" locked>
          <CommitTextarea
            ariaLabel="内部备注"
            value={row.internalNote}
            rows={3}
            placeholder="仅平台可见"
            onCommit={(next) => onPatch({ internalNote: next })}
          />
        </PropRow>
      </SheetSection>
      <ConfirmDialog
        open={adjusting}
        onOpenChange={setAdjusting}
        title="平台调价"
        description={`当前 ${formatCnyCents(row.platformPriceCents)}；确认后追加价格版本，旧价保留在历史中。`}
        confirmText="确认调价"
        variant="brand"
        busy={saving}
        onConfirm={async () => {
          if (pending.current) return
          const cents = priceCentsFromYuan(price)
          if (cents == null || cents <= 0) {
            setInvalid(true)
            notifyError("平台价需为大于 0 的金额（元）")
            return
          }
          pending.current = true
          setSaving(true)
          try {
            const ok = await onAdjustPrice(cents, note.trim())
            setInvalid(!ok)
            if (ok) setAdjusting(false)
          } finally {
            pending.current = false
            setSaving(false)
          }
        }}
      >
        <label className="flex flex-col gap-2 text-compact">
          新平台价（元）
          <Input
            aria-label="新平台价（元）"
            aria-invalid={invalid || undefined}
            inputMode="decimal"
            value={price}
            disabled={saving}
            onChange={(event) => {
              setPrice(event.target.value)
              setInvalid(false)
            }}
          />
        </label>
        <label className="flex flex-col gap-2 text-compact">
          调价备注（可选）
          <Input
            aria-label="调价备注"
            value={note}
            disabled={saving}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </ConfirmDialog>
    </div>
  )
}
