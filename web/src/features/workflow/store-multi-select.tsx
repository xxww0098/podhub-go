import * as React from "react"
import { Check, ChevronDown, Store as StoreIcon } from "lucide-react"
import type { OzonStoreView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import {
  activeCloudStoreUid,
  isStoreKeyExpired,
} from "@/features/stores/store-roster-cache"
import { cn } from "@/lib/utils"

/**
 * The store checkbox list shared by the bind form's multi-select and the card
 * table's inline picker. Owns the toggle semantics: any change emits only ids
 * the roster still knows, so a stale binding drops on the next touch.
 */
export function StoreCheckList({
  stores = [],
  selectedStoreIds = [],
  onChange,
  disabled = false,
  title = "店铺",
  emptyContent,
}: {
  stores?: readonly OzonStoreView[]
  selectedStoreIds?: readonly string[]
  onChange: (nextStoreIds: string[]) => void
  disabled?: boolean
  title?: string
  emptyContent?: React.ReactNode
}) {
  const storeList = stores ?? []
  const selectedList = selectedStoreIds ?? []
  const selectedSet = new Set(selectedList)
  const configuredStores = storeList.filter((store) =>
    Boolean(activeCloudStoreUid(store)),
  )
  const staleIds = selectedList.filter(
    (id) => !storeList.some((store) => store.id === id),
  )

  const toggleStore = (storeId: string) => {
    if (disabled) return
    // Filter out any stale/unknown IDs when updating
    const currentValid = selectedList.filter((id) =>
      storeList.some((s) => s.id === id),
    )
    onChange(
      selectedSet.has(storeId)
        ? currentValid.filter((id) => id !== storeId)
        : [...currentValid, storeId],
    )
  }

  return (
    <>
      <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
        <span className="font-medium">{title}</span>
        {configuredStores.length > 1 ? (
          <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-meta"
              disabled={
                disabled ||
                configuredStores.every((s) => selectedSet.has(s.id))
              }
              onClick={(e) => {
                e.stopPropagation()
                if (!disabled) onChange(configuredStores.map((s) => s.id))
              }}
            >
              全选
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-5 px-1.5 text-meta"
              disabled={disabled || !selectedList.length}
              onClick={(e) => {
                e.stopPropagation()
                if (!disabled) onChange([])
              }}
            >
              清空
            </Button>
          </span>
        ) : null}
      </div>

      <div className="my-1 h-px bg-border/60" />

      <div
        role="listbox"
        aria-multiselectable="true"
        aria-label={title}
        className="max-h-52 overflow-y-auto space-y-0.5"
      >
        {staleIds.map((id) => (
          <StoreCheckRow
            key={id}
            id={id}
            label={id}
            checked
            badge="不在当前 Workspace"
            disabled={disabled}
            onToggle={toggleStore}
          />
        ))}
        {storeList.map((store) => (
          <StoreCheckRow
            key={store.id}
            id={store.id}
            label={store.label}
            checked={selectedSet.has(store.id)}
            badge={
              activeCloudStoreUid(store)
                ? undefined
                : isStoreKeyExpired(store)
                  ? "密钥已过期"
                  : store.configured
                    ? "Workspace 当前不可用"
                    : "Cloud 未配置"
            }
            executable={Boolean(activeCloudStoreUid(store))}
            disabled={disabled}
            onToggle={toggleStore}
          />
        ))}
        {!storeList.length && !staleIds.length
          ? (emptyContent ?? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                暂无店铺，先去「店铺」添加
              </div>
            ))
          : null}
      </div>
    </>
  )
}

/** One checkable store row; a checked row stays deselectable even when the store can no longer publish. */
function StoreCheckRow({
  id,
  label,
  checked,
  badge,
  executable = false,
  disabled = false,
  onToggle,
}: {
  id: string
  label: string
  checked: boolean
  badge?: string
  /** False bars a new selection but never unbinding — a bound store must stay removable. */
  executable?: boolean
  disabled?: boolean
  onToggle: (storeId: string) => void
}) {
  const itemDisabled = disabled || (!executable && !checked)
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      disabled={itemDisabled}
      onClick={() => {
        if (!itemDisabled) onToggle(id)
      }}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors select-none",
        itemDisabled
          ? "cursor-not-allowed opacity-50 text-muted-foreground"
          : "cursor-pointer hover:bg-accent hover:text-accent-foreground",
        checked && !itemDisabled && "bg-accent/40",
      )}
    >
      <span className="flex items-center gap-2 truncate">
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded border border-input transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "bg-transparent",
            itemDisabled && "opacity-50",
          )}
        >
          {checked ? <Check className="size-3" /> : null}
        </span>
        <span
          className={cn(
            "truncate font-medium",
            !executable && badge && "text-muted-foreground",
          )}
        >
          {label}
        </span>
      </span>
      {badge ? (
        <span className="shrink-0 rounded bg-destructive/10 px-1 py-0.5 text-meta font-medium text-destructive">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

export function StoreMultiSelect({
  stores = [],
  selectedStoreIds = [],
  onChange,
  disabled = false,
  placeholder = "选择绑定店铺",
  className,
}: {
  stores?: readonly OzonStoreView[]
  selectedStoreIds?: readonly string[]
  onChange: (nextStoreIds: string[]) => void
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)

  const storeList = React.useMemo(() => stores ?? [], [stores])
  const selectedList = React.useMemo(() => selectedStoreIds ?? [], [selectedStoreIds])

  const selectedLabels = React.useMemo(() => {
    return selectedList
      .map((id) => storeList.find((s) => s.id === id)?.label)
      .filter((label): label is string => Boolean(label))
  }, [selectedList, storeList])

  // Click outside and Esc listener to close dropdown cleanly
  React.useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        // The panel unmounts on close; without this focus falls to <body>.
        if (containerRef.current?.contains(document.activeElement)) {
          triggerRef.current?.focus()
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside, true)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside, true)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open])

  // Focus the first enabled option on open; the rows are real buttons so Tab
  // still works, and Arrow/Home/End below cover the listbox key map.
  React.useEffect(() => {
    if (!open) return
    panelRef.current
      ?.querySelector<HTMLElement>('[role="option"]:not([disabled])')
      ?.focus()
  }, [open])

  const displayText = React.useMemo(() => {
    if (!selectedLabels.length) return placeholder
    return selectedLabels.join("、")
  }, [selectedLabels, placeholder])

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onBlur={(event) => {
        // Tabbing past the last option must close the panel; the click-outside
        // listener only sees pointer input.
        if (
          open &&
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setOpen(false)
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={placeholder}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
          !selectedLabels.length && "text-muted-foreground",
          className,
        )}
      >
        <span className="flex items-center gap-1.5 truncate">
          <StoreIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{displayText}</span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground opacity-80 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="absolute top-full left-0 z-50 mt-1 flex max-h-72 w-full min-w-[16rem] flex-col overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-foreground/10 outline-none"
          onKeyDown={(event) => {
            const key = event.key
            if (
              key !== "ArrowDown" &&
              key !== "ArrowUp" &&
              key !== "Home" &&
              key !== "End"
            ) {
              return
            }
            const options = [
              ...(panelRef.current?.querySelectorAll<HTMLElement>(
                '[role="option"]:not([disabled])',
              ) ?? []),
            ]
            if (!options.length) return
            event.preventDefault()
            const index = options.indexOf(document.activeElement as HTMLElement)
            const next =
              key === "Home"
                ? 0
                : key === "End"
                  ? options.length - 1
                  : key === "ArrowDown"
                    ? Math.min(index + 1, options.length - 1)
                    : Math.max(index - 1, 0)
            options[next]?.focus()
          }}
        >
          <StoreCheckList
            stores={storeList}
            selectedStoreIds={selectedList}
            disabled={disabled}
            onChange={onChange}
          />
        </div>
      ) : null}
    </div>
  )
}
