import { useState } from "react"

import type { OzonStoresOverview } from "@/bindings/commands"
import { rememberStoreRoster } from "./store-roster-cache"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

/** Both tags and groups are `{ uuid, name, store_count }` rows (WorkspaceStoreTagView). */
export type StoreTaxonomyItem = {
  uuid: string
  name: string
  store_count: number
}

/**
 * 标签与分组 share one rename/delete list dialog: same rows, the same busy
 * gate, the same confirm — only the Cloud command and the copy differ, so the
 * two dialogs are thin bindings over this shell.
 */
export function StoreTaxonomyDialog({
  open,
  onOpenChange,
  items,
  workspaceId,
  noun,
  description,
  emptyHint,
  renameItem,
  deleteItem,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: readonly StoreTaxonomyItem[]
  workspaceId?: number
  /** 标签 / 分组 — interpolated into every label and toast. */
  noun: string
  description: string
  emptyHint: string
  renameItem: (input: { uuid: string; name: string }) => Promise<OzonStoresOverview>
  deleteItem: (uuid: string) => Promise<OzonStoresOverview>
}) {
  const [editing, setEditing] = useState<string>()
  const [editingName, setEditingName] = useState("")
  const [busy, setBusy] = useState<string>()
  const [deleteUuid, setDeleteUuid] = useState<string>()
  const deleteCandidate = items.find((item) => item.uuid === deleteUuid)

  async function rename(uuid: string) {
    if (!editingName.trim()) return
    setBusy(uuid)
    try {
      rememberStoreRoster(
        await renameItem({
          uuid,
          name: editingName.trim(),
        }),
        workspaceId,
      )
      setEditing(undefined)
      notifySuccess(`${noun}已重命名`)
    } catch (reason) {
      notifyCommandError(reason, `无法重命名${noun}，请稍后重试。`)
    } finally {
      setBusy(undefined)
    }
  }

  async function remove() {
    if (!deleteUuid) return
    setBusy(deleteUuid)
    try {
      rememberStoreRoster(await deleteItem(deleteUuid), workspaceId)
      setDeleteUuid(undefined)
      notifySuccess(`${noun}已删除`)
    } catch (reason) {
      notifyCommandError(reason, `无法删除${noun}，请稍后重试。`)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="grid max-h-[min(46rem,calc(100dvh-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b border-border px-5 py-3.5">
            <DialogTitle>{noun}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto p-5">
            <div className="space-y-2">
              {items.map((item) => (
                <div
                  key={item.uuid}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                >
                  {editing === item.uuid ? (
                    <Input
                      className="h-8"
                      value={editingName}
                      disabled={busy !== undefined}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void rename(item.uuid)
                      }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  )}
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {item.store_count} 家店铺
                  </span>
                  {editing === item.uuid ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={!editingName.trim() || busy !== undefined}
                      onClick={() => void rename(item.uuid)}
                    >
                      {busy === item.uuid ? (
                        <Spinner data-icon="inline-start" />
                      ) : null}
                      保存
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy !== undefined}
                      onClick={() => {
                        setEditing(item.uuid)
                        setEditingName(item.name)
                      }}
                    >
                      重命名
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={busy !== undefined}
                    onClick={() => setDeleteUuid(item.uuid)}
                  >
                    删除
                  </Button>
                </div>
              ))}
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{emptyHint}</p>
              ) : null}
            </div>
          </div>
          <DialogFooter className="border-t border-border px-5 py-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleteCandidate)}
        title={`删除${noun}「${deleteCandidate?.name ?? ""}」？`}
        description={`将从 ${deleteCandidate?.store_count ?? 0} 家店铺中解除此${noun}。`}
        confirmText={`删除${noun}`}
        busy={busy === deleteUuid}
        onOpenChange={(next) => {
          if (!next && busy !== deleteUuid) setDeleteUuid(undefined)
        }}
        onConfirm={() => void remove()}
      />
    </>
  )
}
