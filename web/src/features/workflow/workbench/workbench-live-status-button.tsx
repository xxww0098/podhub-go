import { Check, ChevronDown, CircleAlert, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { WorkbenchStatusCard } from "./workbench-live-status"
import { RIBBON_BUTTON, RIBBON_STATUS_GROUP } from "./workbench-ribbon-classes"

export function WorkbenchLiveStatusButton({ cards }: { cards: WorkbenchStatusCard[] }) {
  const failed = cards.some((card) => card.type === "error")
  const primary =
    cards.find((card) => card.type === "error") ??
    cards.find((card) => card.type === "loading") ??
    cards[0]!
  return (
    <div
      role="group"
      aria-label="运行状态"
      data-toolbar-slot="live-status"
      className={RIBBON_STATUS_GROUP}
    >
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                RIBBON_BUTTON,
                "justify-start",
                primary.type === "loading" && "border-primary/40 bg-primary/5 text-primary font-medium",
                failed && "border-st-bad/35 text-st-bad-ink",
              )}
              aria-label={`运行状态：${primary.title}`}
            >
              {failed ? (
                <CircleAlert aria-hidden />
              ) : primary.type === "loading" ? (
                <LoaderCircle aria-hidden className="animate-spin text-st-flight-ink" />
              ) : (
                <Check aria-hidden className="text-st-good" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{primary.title}</span>
              <ChevronDown aria-hidden className="size-3 opacity-60" />
            </Button>
          }
        />
        <PopoverContent align="end" aria-label="运行状态详情" className="w-[22rem] p-0">
          <div className="max-h-[min(60vh,28rem)] overflow-y-auto p-3" aria-live="polite">
            {cards.map((card, index) => (
              <section
                key={card.id}
                className={cn(
                  "min-w-0",
                  index > 0 && "mt-3 border-t border-border pt-3",
                )}
              >
                <div className="flex min-w-0 items-start gap-2">
                  {card.type === "error" ? (
                    <CircleAlert
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-st-bad-ink"
                    />
                  ) : card.type === "loading" ? (
                    <LoaderCircle
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 animate-spin text-st-flight-ink"
                    />
                  ) : card.type === "unknown" ? (
                    <CircleAlert
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-st-unknown-ink"
                    />
                  ) : (
                    <Check
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-st-good"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-compact font-semibold text-foreground">
                      {card.title}
                    </p>
                    {card.description ? (
                      <p
                        className={cn(
                          "mt-1 whitespace-pre-line break-words text-compact leading-5",
                          card.type === "error"
                            ? "text-st-bad-ink"
                            : "text-muted-foreground",
                        )}
                      >
                        {card.description}
                      </p>
                    ) : null}
                    {card.action ? (
                      <Button
                        type="button"
                        variant={card.type === "error" ? "destructive" : "outline"}
                        size="sm"
                        className="mt-2"
                        disabled={card.action.disabled}
                        onClick={card.action.onClick}
                      >
                        {card.action.label}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </section>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
