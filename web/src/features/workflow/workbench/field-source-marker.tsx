import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { overriddenByCopy, sourceMarker, type FieldLayerView } from "./field-source"

/**
 * The in-cell source marker: one small icon naming the layer that wrote the
 * value; hover says the layer and who may still overwrite it (D3).
 */
export function FieldSourceMarker({ layer }: { layer: FieldLayerView }) {
  const marker = sourceMarker(layer)
  const Icon = marker.icon
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`字段来源：${marker.label}`}
            className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", marker.tone)}
          />
        }
      >
        <Icon aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">字段来源：{marker.label}</p>
        <p>{overriddenByCopy(marker)}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export type { FieldLayerView }
