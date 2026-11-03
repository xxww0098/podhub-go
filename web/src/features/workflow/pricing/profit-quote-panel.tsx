import { useEffect, useMemo, useRef, useState } from "react"
import { Calculator, Plus, Trash2 } from "lucide-react"
import type { WorkflowDraftValue } from "@/bindings/commands"
import { cardPayload, draftPriceText } from "@/bindings/listing-projection"
import { ErrorNotice } from "@/components/error-notice"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorMessage } from "@/lib/error-message"
import { openCardSession, peekCardSession } from "../card/card-session"
import { listingCardSaveProfitAssumptions } from "../card/card-writes"
import {
  calculateManualProfitQuote, minorMoney, percentToBps, profitQuoteApplyIssue,
  type ManualProfitAssumptions, type PricingCurrency,
} from "./profit-quote"

type Cost = { id: number; name: string; amount: string; currency: PricingCurrency; exchangeRate: string }
type Fee = { id: number; name: string; percent: string }

function Currency({ value, label, disabled, onChange }: {
  value: PricingCurrency; label: string; disabled: boolean; onChange: (value: PricingCurrency) => void
}) {
  return <Select value={value} onValueChange={(next) => { if (next === "CNY" || next === "RUB") onChange(next) }}>
    <SelectTrigger size="sm" aria-label={label} disabled={disabled}><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="CNY">CNY</SelectItem><SelectItem value="RUB">RUB</SelectItem></SelectContent>
  </Select>
}

/** Manual assumptions only. No supplier platform-price or incomplete official fees are inferred. */
export function ProfitQuotePanel({ cardId, title, disabled, onApply }: {
  cardId: string; title: string; disabled: boolean
  onApply?: (input: ManualProfitAssumptions) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [currency, setCurrency] = useState<PricingCurrency>("CNY")
  const [savedCurrency, setSavedCurrency] = useState<WorkflowDraftValue>()
  const [supplierBound, setSupplierBound] = useState(false)
  const [oldPrice, setOldPrice] = useState<string>()
  const [costs, setCosts] = useState<Cost[]>([{ id: 0, name: "成本", amount: "", currency: "CNY", exchangeRate: "" }])
  const [fees, setFees] = useState<Fee[]>([{ id: 1, name: "佣金", percent: "" }])
  const [margin, setMargin] = useState("")
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const nextId = useRef(2)
  const initializedCard = useRef("")

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener("resize", close)
    return () => window.removeEventListener("resize", close)
  }, [open])

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setError("")
    void openCardSession(cardId).then((session) => {
      if (!live) return
      const payload = cardPayload(session.card())
      const currentCurrency = payload.defaults.values.currency_code
      setSavedCurrency(currentCurrency)
      setSupplierBound(Boolean(payload.supplierProductId))
      setOldPrice(draftPriceText(payload.defaults, "old_price") ?? (payload.defaults.values.old_price ? "invalid" : undefined))
      if (initializedCard.current !== cardId) {
        const saved = payload.pricingAssumptions
        if (saved) {
          setCurrency(saved.currency)
          setCosts(saved.costs.map((cost) => ({ ...cost, exchangeRate: cost.exchangeRate ?? "", id: nextId.current++ })))
          setFees(saved.fees.map((fee) => ({ name: fee.name, percent: String(fee.rateBps / 100), id: nextId.current++ })))
          setMargin(String(saved.targetMarginBps / 100))
        } else if (currentCurrency?.kind === "text" && (currentCurrency.value === "CNY" || currentCurrency.value === "RUB")) {
          setCurrency(currentCurrency.value)
        }
        initializedCard.current = cardId
      }
      setLoading(false)
      setLoaded(true)
    }).catch((reason) => { if (live) setError(errorMessage(reason, "无法读取试算参数，请关闭后重试")) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [open, cardId])

  const calculation = useMemo(() => {
    try {
      const input: ManualProfitAssumptions = {
        currency,
        costs: costs.map((cost) => ({ name: cost.name, amount: cost.amount, currency: cost.currency,
          ...(cost.currency !== currency ? { exchangeRate: cost.exchangeRate } : {}) })),
        fees: fees.map((fee) => ({ name: fee.name, rateBps: percentToBps(fee.percent) })),
        targetMarginBps: percentToBps(margin),
      }
      return { input, quote: calculateManualProfitQuote(input), issue: "" }
    } catch (reason) {
      return { input: undefined, quote: undefined, issue: errorMessage(reason, "请填写完整的成本、人工费率和净利率") }
    }
  }, [currency, costs, fees, margin])
  const applyIssue = calculation.quote ? supplierBound ? "供应方案当前仅可试算和保存参数" : profitQuoteApplyIssue(savedCurrency, currency, calculation.quote.price, oldPrice) : undefined
  const locked = disabled || busy || loading || !loaded
  const changed = () => { setError(""); setNotice("") }
  const updateCost = (id: number, patch: Partial<Cost>) => { changed(); setCosts((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item)) }
  const updateFee = (id: number, patch: Partial<Fee>) => { changed(); setFees((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item)) }

  async function save(apply: boolean) {
    setAttempted(true)
    if (locked || !calculation.input || !calculation.quote) return
    setBusy(true); setError(""); setNotice("")
    try {
      if (apply) {
        if (!onApply) throw new Error("当前仅可试算")
        await onApply(calculation.input)
      } else {
        await listingCardSaveProfitAssumptions(cardId, calculation.input)
      }
      const session = peekCardSession(cardId)
      if (session) {
        const current = cardPayload(session.card())
        setSavedCurrency(current.defaults.values.currency_code)
        setOldPrice(draftPriceText(current.defaults, "old_price") ?? (current.defaults.values.old_price ? "invalid" : undefined))
      }
      setNotice(apply ? "已应用到方案" : "参数已保存")
    } catch (reason) {
      setError(errorMessage(reason, apply ? "应用失败，输入已保留" : "保存失败，输入已保留"))
      // A conflict replay may have read a new currency or old price. Retain
      // the operator's assumptions while updating only the application fence.
      const session = peekCardSession(cardId)
      if (session) {
        const current = cardPayload(session.card())
        setSavedCurrency(current.defaults.values.currency_code)
        setOldPrice(draftPriceText(current.defaults, "old_price") ?? (current.defaults.values.old_price ? "invalid" : undefined))
      }
    } finally { setBusy(false) }
  }

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button variant="ghost" size="icon-xs" disabled={disabled || busy} aria-label={`利润试算 ${title}`} title="利润试算（人工费用）" />}><Calculator /></PopoverTrigger>
    <PopoverContent aria-label={`利润试算 ${title}`} align="start" className="w-[30rem] max-h-[min(36rem,calc(100dvh-24px))] overflow-y-auto p-2">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs">售价币种<Currency value={currency} label="售价币种" disabled={locked} onChange={(value) => { changed(); setCurrency(value) }} /></label>
          <Tooltip><TooltipTrigger render={<label className="flex items-center gap-1 text-xs" />}>净利率 %<Input className="h-7 w-20" aria-label="目标净利率百分比" inputMode="decimal" value={margin} disabled={locked} onChange={(event) => { changed(); setMargin(event.target.value) }} onBlur={() => setAttempted(true)} /></TooltipTrigger><TooltipContent>净利润 ÷ 售价；扣除下方已输入的全部成本和人工费率</TooltipContent></Tooltip>
          {loading || busy ? <Spinner className="size-3.5" aria-label={loading ? "读取参数" : "保存中"} /> : null}
        </div>
        <div className="grid gap-1">
          {costs.map((cost, index) => <div key={cost.id} className="flex flex-wrap items-center gap-1">
            <Input className="h-7 w-24 grow" aria-label={`成本 ${index + 1} 名称`} value={cost.name} maxLength={80} disabled={locked} onChange={(event) => updateCost(cost.id, { name: event.target.value })} />
            <Input className="h-7 w-24 grow" aria-label={`成本 ${index + 1} 金额`} placeholder="金额" inputMode="decimal" value={cost.amount} disabled={locked} onChange={(event) => updateCost(cost.id, { amount: event.target.value })} onBlur={() => setAttempted(true)} />
            <Currency value={cost.currency} label={`成本 ${index + 1} 币种`} disabled={locked} onChange={(value) => updateCost(cost.id, { currency: value })} />
            {cost.currency !== currency ? <label className="flex w-40 grow items-center gap-1 text-xs">
              <span className="whitespace-nowrap">{cost.currency}→{currency}</span>
              <Input className="h-7 min-w-0" aria-label={`1 ${cost.currency} 兑换 ${currency}`} title={`1 ${cost.currency} = 多少 ${currency}`} placeholder="汇率" inputMode="decimal" value={cost.exchangeRate} disabled={locked} onChange={(event) => updateCost(cost.id, { exchangeRate: event.target.value })} onBlur={() => setAttempted(true)} />
            </label> : null}
            <IconButton icon={Trash2} label={`删除成本 ${index + 1}`} size="icon-xs" disabled={locked || costs.length === 1} onClick={() => { changed(); setCosts((items) => items.filter((item) => item.id !== cost.id)) }} />
          </div>)}
        </div>
        <div className="grid gap-1">
          {fees.map((fee, index) => <div key={fee.id} className="flex items-center gap-1">
            <Input className="h-7 min-w-0 flex-1" aria-label={`人工费用 ${index + 1} 名称`} value={fee.name} maxLength={80} disabled={locked} onChange={(event) => updateFee(fee.id, { name: event.target.value })} />
            <Input className="h-7 w-24" aria-label={`人工费率 ${index + 1} 百分比`} placeholder="人工费率" inputMode="decimal" value={fee.percent} disabled={locked} onChange={(event) => updateFee(fee.id, { percent: event.target.value })} onBlur={() => setAttempted(true)} /><span className="text-xs">%</span>
            <IconButton icon={Trash2} label={`删除人工费用 ${index + 1}`} size="icon-xs" disabled={locked} onClick={() => { changed(); setFees((items) => items.filter((item) => item.id !== fee.id)) }} />
          </div>)}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="xs" variant="outline" disabled={locked || costs.length >= 32} onClick={() => { changed(); setCosts((items) => [...items, { id: nextId.current++, name: "费用", amount: "", currency, exchangeRate: "" }]) }}><Plus />固定成本</Button>
          <Button size="xs" variant="outline" disabled={locked || fees.length >= 32} onClick={() => { changed(); setFees((items) => [...items, { id: nextId.current++, name: "费用", percent: "" }]) }}><Plus />人工费率</Button>
          {!fees.length ? <span className="text-xs text-muted-foreground">未计比例费用</span> : null}
        </div>
        {calculation.quote ? <output className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t pt-2 text-xs tabular-nums" aria-live="polite">
          <span>建议 <strong className="text-sm">{currency} {calculation.quote.price}</strong></span>
          <span>成本 {minorMoney(calculation.quote.fixedCostMinor)}</span>
          <span>费用 {minorMoney(calculation.quote.fees.reduce((sum, fee) => sum + BigInt(fee.amountMinor), 0n).toString())}</span>
          <span>净利 {minorMoney(calculation.quote.profitMinor)}</span>
        </output> : null}
        <ProfitQuoteFeedback error={error || (attempted ? calculation.issue : "")} applyIssue={applyIssue} />
        <div className="flex flex-wrap items-center gap-1 border-t pt-2">
          <Button size="xs" variant="outline" disabled={locked} onClick={() => void save(false)}>保存参数</Button>
          <Button size="xs" disabled={locked || !calculation.quote || Boolean(applyIssue) || !onApply} onClick={() => void save(true)}>应用到方案</Button>
          {notice ? <span role="status" className="text-xs text-muted-foreground">{notice}</span> : null}
        </div>
      </div>
    </PopoverContent>
  </Popover>
}

export function ProfitQuoteFeedback({ error, applyIssue }: { error: string; applyIssue?: string }) {
  return <>
    {error ? <ErrorNotice layout="text" title={error} /> : null}
    {applyIssue && applyIssue !== error ? <p className="text-xs text-muted-foreground">{applyIssue}</p> : null}
  </>
}
