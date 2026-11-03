import { useRef, useState } from "react"
import { Building2, Check, ChevronsUpDown } from "lucide-react"

import type { components } from "@/api/schema"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type Source = components["schemas"]["SupplierSourceCard"]

function sourceName(source: Source): string {
  return source.name.trim() || source.source_id
}

export function FactoryWorkspaceMenu({
  sources,
  selectedId,
  onSelect,
}: {
  sources: Source[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  const { state, isMobile } = useSidebar()
  const [open, setOpen] = useState(false)
  const side = useRef<"bottom" | "right">("bottom")
  const selected = sources.find((source) => source.source_id === selectedId)
  const name = selected ? sourceName(selected) : "未选择工作空间"

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) side.current = !isMobile && state === "collapsed" ? "right" : "bottom"
        setOpen(next)
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              aria-label={`工厂工作空间：${name}`}
              render={<button type="button" className={cn(
                "shell-workspace-trigger flex h-18! w-full min-w-0 items-center gap-2 rounded-lg border px-3 text-left",
                "cursor-pointer text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0",
              )} />}
            />
          }
        >
          <Building2 aria-hidden className="hidden size-5 shrink-0 text-brand group-data-[collapsible=icon]:block" />
          <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
            <span className="truncate text-xl font-semibold" title={name}>{name}</span>
            <span className="truncate text-lg text-muted-foreground">工厂工作空间</span>
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
        </TooltipTrigger>
        <TooltipContent side="right" hidden={state !== "collapsed" || isMobile || open}>
          {name}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent side={side.current} align="start" sideOffset={1} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel><span className="block py-1 text-lg">工厂工作空间</span></DropdownMenuLabel>
          {sources.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-muted-foreground">暂无可用工作空间</p>
          ) : sources.map((source) => {
            const active = source.source_id === selectedId
            const label = sourceName(source)
            return (
              <DropdownMenuItem
                key={source.source_id}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  if (!active) onSelect(source.source_id)
                }}
              >
                <span className={cn("flex min-h-16 w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-2", active && "bg-brand-soft text-brand")}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xl font-medium" title={label}>{label}</span>
                    {source.country.trim() ? <span className="truncate text-sm text-muted-foreground">{source.country}</span> : null}
                  </span>
                  {active ? <Check aria-hidden className="size-4 text-brand" /> : null}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
