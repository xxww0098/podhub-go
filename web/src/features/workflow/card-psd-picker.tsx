import { FileImage, RefreshCw, RotateCcw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { usePsdTransfer } from "./card/psd-transfer"

/**
 * The library cell's PSD binding.
 *
 * A supplier softlink projects the online template until the operator binds
 * one here; the Card's own digest then outranks that projection. Picking opens
 * the system file chooser directly and the bytes are staged into OPFS at bind
 * time, so moving the source file afterwards cannot break the binding.
 * 恢复商库默认 writes the empty binding back, which hands the field to the
 * supplier again.
 */
export function CardPsdPicker({
  draftId,
  fileName,
  supplierBound = false,
  disabled = false,
  saving = false,
  onPick,
  onClear,
}: {
  draftId?: string
  fileName: string
  supplierBound?: boolean
  disabled?: boolean
  saving?: boolean
  onPick: () => void | Promise<void>
  onClear?: () => void | Promise<void>
}) {
  const transfer = usePsdTransfer(draftId)
  const active = transfer && transfer.phase !== "error" ? transfer : undefined
  const failed = transfer?.phase === "error" ? transfer : undefined
  const shown = (active?.fileName || failed?.fileName || fileName).trim()
  const bound = Boolean(shown)
  const label = bound ? `PSD 绑定：${shown}` : "绑定 PSD"
  const clearLabel = supplierBound ? "恢复商库默认" : "清除 PSD 绑定"

  if (!bound && !saving && !active && !failed) {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        data-testid="card-psd-binding"
        className="mt-0.5 -ml-1 flex h-6 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border-strong px-2 text-meta whitespace-nowrap text-muted-foreground outline-none transition-colors hover:border-brand/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
        onClick={() => void onPick()}
      >
        绑定 PSD
      </button>
    )
  }

  return (
    <span className="mt-0.5 -ml-1 flex max-w-full items-center gap-0.5">
      <button
        type="button"
        disabled={disabled || saving}
        aria-label={label}
        title="重新选择 PSD 模板"
        data-testid="card-psd-binding"
        className="flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
        onClick={() => void onPick()}
      >
        <FileImage
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 truncate font-mono text-meta text-faint-foreground">
          {shown || "PSD"}
          {active ? <span className="ml-1 text-muted-foreground">{active.label}</span> : null}
          {failed ? <span className="ml-1 text-muted-foreground">{failed.label}</span> : null}
        </span>
        {saving || active ? (
          <Spinner
            className="size-3.5 shrink-0 text-muted-foreground"
            role="presentation"
            aria-hidden="true"
          />
        ) : null}
      </button>
      {active?.abort ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="取消 PSD 上传"
          onClick={active.abort}
        >
          <X aria-hidden />
        </Button>
      ) : null}
      {failed?.retry ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="重试 PSD 上传"
          aria-invalid="true"
          onClick={failed.retry}
        >
          <RefreshCw aria-hidden />
        </Button>
      ) : null}
      {onClear && fileName.trim() ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={disabled || saving}
                aria-label={clearLabel}
                className="cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={() => void onClear()}
              />
            }
          >
            <RotateCcw aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{clearLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}
