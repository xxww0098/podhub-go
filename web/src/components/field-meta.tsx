import { CircleHelp } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function FieldMeta({ name, required, essential, description }: {
  name: string
  required?: boolean
  /** 核心业务信息，不增加接口必填约束。 */
  essential?: boolean
  description?: string
}) {
  return <>
    {description ? <Tooltip>
      <TooltipTrigger delay={350} render={<button type="button" aria-label={`查看“${name}”填写说明`}
        className="inline-flex size-6 shrink-0 cursor-help items-center justify-center rounded-md text-faint-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11" />}>
        <CircleHelp aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent side="top">{description}</TooltipContent>
    </Tooltip> : null}
    {required ? <Badge variant="outline">必填</Badge> : null}
    {!required && essential ? <span data-field-meta="essential" className="text-meta font-normal text-faint-foreground">建议</span> : null}
  </>
}
