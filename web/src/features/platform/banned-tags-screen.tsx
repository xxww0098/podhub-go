import { useCallback, useEffect, useState } from "react"
import { Ban, RefreshCw } from "lucide-react"

import { api } from "@/api/client"
import { route } from "@/api/routes"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

type BannedTag = {
  id: number
  term: string
  matchMode: string
  note: string
  createdBy: string
  createdAt: string
  enabled: boolean
}

type MatchMode = "exact" | "stem"

/**
 * Super-admin list of platform banned product tags. The table is global;
 * a save here is visible to other API processes within one second.
 */
export function PlatformBannedTagsScreen() {
  const [tags, setTags] = useState<BannedTag[]>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [term, setTerm] = useState("")
  const [note, setNote] = useState("")
  const [mode, setMode] = useState<MatchMode>("stem")
  const [enabled, setEnabled] = useState(true)
  const [invalid, setInvalid] = useState(false)

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const data = await api.get<{ tags: BannedTag[] }>(route("adminBannedTags"))
      setTags(data.tags)
    } catch (reason) {
      setTags(undefined)
      setFailed(true)
      notifyCommandError(reason, "无法读取受限标签。")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function createTag() {
    const next = term.trim()
    if (!next || busy) {
      setInvalid(!next)
      return
    }
    setBusy(true)
    setInvalid(false)
    try {
      const data = await api.post<{ tags: BannedTag[] }>(route("adminBannedTags"), {
        term: next,
        matchMode: mode,
        note: note.trim(),
        enabled,
      })
      setTags(data.tags)
      setTerm("")
      setNote("")
      notifySuccess("已添加受限词")
    } catch (reason) {
      setInvalid(true)
      notifyCommandError(reason, "受限词没有保存。")
    } finally {
      setBusy(false)
    }
  }

  async function updateTag(tag: BannedTag, patch: Partial<Pick<BannedTag, "enabled">>) {
    if (busy) return
    setBusy(true)
    try {
      const data = await api.put<{ tags: BannedTag[] }>(route("adminBannedTagsById", { id: tag.id }), {
        term: tag.term,
        matchMode: tag.matchMode,
        note: tag.note,
        enabled: patch.enabled ?? tag.enabled,
      })
      setTags(data.tags)
      notifySuccess(patch.enabled === false ? "已停用" : "已更新")
    } catch (reason) {
      notifyCommandError(reason, "受限词没有更新。")
    } finally {
      setBusy(false)
    }
  }

  async function removeTag(tag: BannedTag) {
    if (busy) return
    setBusy(true)
    try {
      const data = await api.del<{ tags: BannedTag[] }>(route("adminBannedTagsById", { id: tag.id }))
      setTags(data.tags)
      notifySuccess("已删除受限词")
    } catch (reason) {
      notifyCommandError(reason, "受限词没有删除。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <PlatformAdminSurface
      summary={<span className="text-sm text-muted-foreground">全平台生效。保存后约 1 秒内所有 API 进程都会用上新词表。</span>}
      toolbar={
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Input
            aria-label="受限词"
            aria-invalid={invalid || undefined}
            placeholder="受限词，例如 сигарета"
            value={term}
            disabled={busy}
            onChange={(event) => {
              setTerm(event.target.value)
              setInvalid(false)
            }}
          />
          <Button
            type="button"
            size="sm"
            variant={mode === "stem" ? "default" : "outline"}
            disabled={busy}
            onClick={() => setMode("stem")}
          >
            词干
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "exact" ? "default" : "outline"}
            disabled={busy}
            onClick={() => setMode("exact")}
          >
            精确
          </Button>
          <Input
            aria-label="备注"
            placeholder="备注"
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            启用
            <Switch
              checked={enabled}
              disabled={busy}
              onCheckedChange={(checked) => setEnabled(checked === true)}
              aria-label="新建时启用"
            />
          </label>
          <Button type="button" disabled={busy} onClick={() => void createTag()}>
            添加
          </Button>
        </div>
      }
    >
      {tags === undefined && !failed ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Spinner />
          正在读取受限标签
        </div>
      ) : null}
      {failed ? (
        <div className="flex items-center gap-2 p-4">
          <Button type="button" variant="outline" onClick={() => void load()}>
            <RefreshCw aria-hidden />
            重试
          </Button>
        </div>
      ) : null}
      {tags && tags.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">还没有受限词。添加后，保存标签和推送 Ozon 前都会拦截。</p>
      ) : null}
      {tags && tags.length > 0 ? (
        <ul className="flex flex-col">
          {tags.map((tag) => (
            <li key={tag.id} className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
              <Ban className="size-4 text-muted-foreground" aria-hidden />
              <span className="font-medium">{tag.term}</span>
              <span className="text-sm text-muted-foreground">{tag.matchMode === "stem" ? "词干" : "精确"}</span>
              {tag.note ? <span className="text-sm text-muted-foreground">{tag.note}</span> : null}
              <span className="ml-auto flex items-center gap-3">
                <Switch
                  checked={tag.enabled}
                  disabled={busy}
                  aria-label={`${tag.term} 启用`}
                  onCheckedChange={(checked) => void updateTag(tag, { enabled: checked === true })}
                />
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void removeTag(tag)}>
                  删除
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </PlatformAdminSurface>
  )
}
