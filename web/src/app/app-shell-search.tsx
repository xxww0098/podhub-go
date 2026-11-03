import { useEffect, useId, useState } from "react"
import { Search } from "lucide-react"
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { SCREEN_LABELS, type AppScreen } from "@/lib/app-screens"
import type { NavItem } from "@/lib/app-navigation"
import { cn } from "@/lib/utils"

type SearchGroup = { label: string; items: readonly NavItem[] }

export function ShellSearch({ groups, currentScreen, onNavigate }: {
  groups: readonly SearchGroup[]
  currentScreen: AppScreen | null
  onNavigate: (screen: AppScreen) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const term = query.trim().toLocaleLowerCase()
  const filteredGroups = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => SCREEN_LABELS[item.id].toLocaleLowerCase().includes(term)) }))
    .filter((group) => group.items.length > 0)
  const results = filteredGroups.flatMap((group) => group.items)
  const selected = results[Math.min(activeIndex, results.length - 1)]

  function changeOpen(next: boolean) {
    setOpen(next)
    if (!next) {
      setQuery("")
      setActiveIndex(0)
    }
  }

  function navigate(screen: AppScreen) {
    changeOpen(false)
    onNavigate(screen)
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.repeat) {
        event.preventDefault()
        changeOpen(!open)
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [open])

  useEffect(() => {
    if (open && selected) document.getElementById(`${listId}-${selected.id}`)?.scrollIntoView({ block: "nearest" })
  }, [listId, open, selected?.id])

  let resultIndex = 0
  return (
    <>
      <button type="button" aria-label="搜索页面" title="搜索页面（⌘ K / Ctrl K）" onClick={() => changeOpen(true)} className="shell-search">
        <Search aria-hidden className="size-4 shrink-0" />
        <span>搜索</span>
        <kbd aria-hidden>⌘K</kbd>
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent layout="panel" className="sm:max-w-lg">
          <DialogHeader variant="panel"><DialogTitle>切换页面</DialogTitle></DialogHeader>
          <div className="px-5 pb-1 pt-4">
            <InputGroup className="h-10">
              <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
              <InputGroupInput
                role="combobox"
                aria-label="搜索页面名称"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined}
                placeholder="搜索页面名称"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || results.length === 0) return
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    const step = event.key === "ArrowDown" ? 1 : -1
                    setActiveIndex((index) => (Math.min(index, results.length - 1) + step + results.length) % results.length)
                  } else if (event.key === "Enter" && selected) {
                    event.preventDefault()
                    navigate(selected.id)
                  }
                }}
              />
            </InputGroup>
          </div>
          <div className="min-h-0 max-h-96 flex-1 overflow-y-auto overscroll-contain">
            <DialogBody>
              <div id={listId} role="listbox" aria-label="搜索结果">
                {filteredGroups.map((group) => (
                  <div key={group.label} role="group" aria-label={group.label}>
                    <div aria-hidden className="px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">{group.label}</div>
                    {group.items.map(({ id, icon: Icon }) => {
                      const index = resultIndex++
                      const active = selected?.id === id
                      return (
                        <button
                          key={id}
                          id={`${listId}-${id}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          tabIndex={-1}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => navigate(id)}
                          className={cn(
                            "flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none",
                            active ? "bg-brand-soft text-brand-ink" : "text-foreground hover:bg-muted",
                          )}
                        >
                          <Icon aria-hidden className="size-4 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{SCREEN_LABELS[id]}</span>
                          {currentScreen === id ? <span className="text-xs text-muted-foreground">当前</span> : null}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
              {results.length === 0 ? <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">没有找到相关页面</p> : null}
            </DialogBody>
          </div>
          <div aria-hidden className="hidden shrink-0 items-center gap-4 border-t border-border bg-muted/30 px-5 py-3 text-xs text-muted-foreground sm:flex">
            <span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> 打开</span>
            <span><kbd>Esc</kbd> 关闭</span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
