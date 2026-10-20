import { Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

import type { StoreBusyKind } from "./use-store-commands"

/** 确认删除店铺: which stores leave the roster, and the busy gate. */
export function StoreDeleteDialog({
  busy,
  deleteCandidateIds,
  deleteCandidates,
  deleteStores,
  setDeleteCandidateIds,
}: {
  busy: StoreBusyKind | undefined
  deleteCandidateIds: string[] | undefined
  deleteCandidates: { id: string, label: string }[]
  deleteStores: (ids: string[]) => Promise<void>
  setDeleteCandidateIds: (ids: string[] | undefined) => void
}) {
  return (
  <Dialog
    open={Boolean(deleteCandidateIds)}
    onOpenChange={(open) => {
      if (!open && busy !== "delete") setDeleteCandidateIds(undefined);
    }}
  >
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>确认删除店铺</DialogTitle>
        <DialogDescription>
          {deleteCandidates.length === 1 ? (
            <>
              将从当前工作空间删除「
              {deleteCandidates[0].label || "未命名店铺"}
              」。运营权立即失效，托管密钥同时删除，不可恢复。
            </>
          ) : (
            <>
              将从当前工作空间删除 {deleteCandidates.length}{" "}
              家店铺。运营权立即失效，托管密钥同时删除，不可恢复。
            </>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy === "delete"}
          onClick={() => setDeleteCandidateIds(undefined)}
        >
          取消
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={deleteCandidates.length === 0 || busy === "delete"}
          onClick={() => {
            if (deleteCandidateIds) void deleteStores(deleteCandidateIds);
          }}
        >
          {busy === "delete" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Trash2 data-icon="inline-start" />
          )}
          移除店铺并释放名额
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  )
}
