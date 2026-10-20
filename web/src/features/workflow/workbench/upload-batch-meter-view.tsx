import { Button } from "@/components/ui/button"
import { formatEta, formatRate } from "@/bindings/multipart-upload"
import type { PreparationActivity } from "../prepare/preparation-tracks"
import {
  failedUploadRowIds,
  useUploadBatchMeter,
} from "../prepare/upload-batch-meter"
import type { ListingRow } from "../model/listing-row"

/**
 * Live slice-batch progress, plus a retry that only touches rows whose upload failed.
 */
export function UploadBatchMeter({
  rows,
  activity,
  disabled,
  onRetryFailed,
}: {
  rows: readonly ListingRow[]
  activity: PreparationActivity
  disabled: boolean
  onRetryFailed: (rowIds: string[]) => void
}) {
  const meter = useUploadBatchMeter()
  const failed = failedUploadRowIds(rows, activity.deliver)
  if (!meter.active && failed.length === 0 && !meter.gateNote) return null
  const rate = meter.active ? formatRate(meter.bytesPerSec) : ""
  const eta = meter.active ? formatEta(meter.etaSec) : ""
  const progress = meter.total > 0 ? `上传 ${meter.completed}/${meter.total}` : ""
  const summary = [progress, rate, eta, meter.gateNote].filter(Boolean).join(" · ")
  const reason = meter.failureMessage || rows.find((row) => failed.includes(row.id))?.preparationUpload?.message || ""
  return (
    <div className="flex min-w-0 items-center gap-2" aria-live="polite">
      {summary ? <span className="text-meta tabular-nums text-muted-foreground">{summary}</span> : null}
      {reason ? <span className="max-w-xs truncate text-meta text-muted-foreground">{reason}</span> : null}
      {failed.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label={`重试全部失败（${failed.length}）`}
          onClick={() => onRetryFailed(failed)}
        >
          重试全部失败
          <span className="tabular-nums">{failed.length}</span>
        </Button>
      ) : null}
    </div>
  )
}
