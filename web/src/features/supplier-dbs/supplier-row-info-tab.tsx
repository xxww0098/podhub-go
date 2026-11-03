/** 商品信息只维护卖家选品事实与上架素材；平台价确认后追加新版本。 */
import { useRef, useState } from "react"
import { Plus } from "lucide-react"

import type {
  SupplierDbPriceVersion,
  SupplierDbPropDef,
  SupplierDbRow,
  UpsertSupplierDbPropRequest,
} from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { formatDateTimeMinute } from "@/lib/format"
import { notifyError } from "@/lib/notify"

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

/** 当前价在价格里；历史只列上一版与更早版本，避免和当前价重复。 */
function PriceHistoryLine({ versions }: { versions: SupplierDbPriceVersion[] }) {
  const previous = versions.slice(1)
  if (!previous.length) return null
  const [latest, ...older] = previous
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 text-meta text-muted-foreground">
      <span className="inline-flex flex-wrap items-baseline gap-x-2">
        <span>上次调价</span>
        <span className="font-mono text-compact tabular-nums text-foreground">
          {formatCnyCents(latest.priceCents)}
        </span>
        <span>{formatDateTimeMinute(latest.createdAtMs)}</span>
      </span>
      {older.length ? (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            全部 {previous.length} 次
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            <p className="text-compact font-medium">历史平台价</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {previous.map((version, index) => (
                <li
                  key={`${version.createdAtMs}-${index}`}
                  className="flex items-baseline justify-between gap-3 text-compact"
                >
                  <span className="font-mono tabular-nums">
                    {formatCnyCents(version.priceCents)}
                  </span>
                  <span className="text-meta text-muted-foreground">
                    {formatDateTimeMinute(version.createdAtMs)}
                  </span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

export function SupplierRowInfoTab({
  row,
  propDefs,
  onPatch,
  onUpdateProp,
  onAddProp,
  onAdjustPrice,
  canAdjustPrice = false,
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
  canAdjustPrice?: boolean
}) {
  const [adjusting, setAdjusting] = useState(false)
  const [price, setPrice] = useState("")
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const pending = useRef(false)
  const visiblePropDefs = propDefs.filter((def) => def.sourceId === row.sourceId && def.sellerVisible)

  return (
    <div className="flex flex-col gap-4" data-supplier-row-info-tab="">
      <SheetSection title="商品资料">
        <PropRow name="名称" essential note="用于选品识别，最多 80 个字符；留空时暂存为“未命名”。">
          <CommitInput
            ariaLabel="名称"
            value={row.title}
            placeholder="未命名"
            onCommit={(next) => onPatch({ title: next })}
          />
        </PropRow>
        <PropRow name="编号" required note="全库唯一的商品编号，新建商品时自动生成。">
          <CommitInput
            ariaLabel="编号"
            value={row.platformCode}
            placeholder="全库唯一"
            mono
            onCommit={(next) => onPatch({ platformCode: next })}
          />
        </PropRow>
        {/* 规格是同款切换的判别字段：跟编号放一起，改它即改页头规格名。 */}
        <PropRow name="规格" essential required={Boolean(row.variantGroup?.trim())} note="用于区分尺寸、颜色等款式；同款分组内必须填写且不能重复。">
          <CommitInput
            ariaLabel="规格"
            value={row.size}
            placeholder="如 40×50cm"
            onCommit={(next) => onPatch({ size: next })}
          />
        </PropRow>
      </SheetSection>

      <SheetSection title="价格">
        <PropRow name="成本价" note="内部供货成本，卖家不可见。">
          <CommitInput ariaLabel="成本价（元）" value={centsToInput(row.costCents)} inputMode="decimal" placeholder="未设置" onCommit={async (next) => {
            const cents = priceCentsFromYuan(next)
            if (cents === undefined || cents === null && row.shippingCostCents != null) { notifyError("成本价需大于 0；清空前请先将运费设为零"); return false }
            return onPatch({ costCents: cents })
          }} />
        </PropRow>
        <PropRow name="运费" essential note="卖家可见的货源运费，单位为人民币元；不填按零运费。供货成本在商品表格维护。">
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
        <PropRow name="平台价" required note="上架前必须设置平台价。通过调价追加价格版本，旧价保留在历史中。">
          <div className="flex flex-col gap-1.5">
            <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-1.5">
              {row.platformPriceCents == null ? (
                <span className="text-compact text-muted-foreground">未定价</span>
              ) : (
                <span className="font-mono text-base font-semibold tabular-nums">
                  {formatCnyCents(row.platformPriceCents)}
                </span>
              )}
              {canAdjustPrice ? (
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
              ) : (
                <span className="text-meta text-muted-foreground">由超级管理员定价</span>
              )}
            </div>
            <PriceHistoryLine versions={row.priceHistory ?? []} />
          </div>
        </PropRow>
      </SheetSection>

      <SheetSection title="素材">
        <SupplierRowMedia row={row} />
      </SheetSection>

      <SheetSection title="商品属性">
        <PropRow name="材质">
          <CommitInput
            ariaLabel="材质"
            value={row.material}
            placeholder="如 纯棉"
            onCommit={(next) => onPatch({ material: next })}
          />
        </PropRow>
        <PropRow name="品牌">
          <CommitInput
            ariaLabel="品牌"
            value={row.brand}
            placeholder="如 无品牌"
            onCommit={(next) => onPatch({ brand: next })}
          />
        </PropRow>
        <PropRow name="工艺">
          <CommitInput
            ariaLabel="工艺"
            value={row.craft}
            placeholder="如 数码直喷"
            onCommit={(next) => onPatch({ craft: next })}
          />
        </PropRow>
        <PropRow name="交期" essential note="预计发货时间，供卖家判断履约时效。">
          <CommitInput
            ariaLabel="交期"
            value={row.leadTime}
            placeholder="如 3–5 天"
            onCommit={(next) => onPatch({ leadTime: next })}
          />
        </PropRow>
        {visiblePropDefs.map((def) => (
          <PropRow
            key={def.propId}
            name={def.name}
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
        ) : null}
      </SheetSection>

      <SheetSection title="包装与清单">
        <PropRow name="包装尺寸" essential note="包装的宽、高、深，单位为毫米，用于评估运输体积。">
          <div className="grid grid-cols-3 gap-2">
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
        <PropRow name="毛重" essential note="商品含包装的总重量，用于评估运输费用；可切换 g / kg。">
          <WeightCommitInput
            name="毛重"
            grams={row.grossWeightG}
            onCommit={(grams) => onPatch({ grossWeightG: grams })}
          />
        </PropRow>
        <PropRow name="商品清单" essential wide note="明确一件商品实际包含的物品和数量。">
          <CommitTextarea
            ariaLabel="商品清单"
            value={row.contents}
            rows={3}
            placeholder="商品包含什么，每行一件，如 画布 40×50cm ×1"
            onCommit={(next) => onPatch({ contents: next })}
          />
        </PropRow>
      </SheetSection>

      <SheetSection title="商品说明">
        <PropRow name="商品描述">
          <CommitTextarea
            ariaLabel="商品描述"
            value={row.description}
            rows={5}
            placeholder="多行正文，按换行展示"
            onCommit={(next) => onPatch({ description: next })}
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
