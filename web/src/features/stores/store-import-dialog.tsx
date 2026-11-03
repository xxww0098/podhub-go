import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { FileInput } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { StateChip } from "@/components/state-chip"
import { Textarea } from "@/components/ui/textarea"

import type { StoreBusyKind } from "./use-store-commands"
import type { useStoreRosterTransfer } from "./use-store-roster-transfer"

/**
 * 批量导入密钥: one paste box, the parse preview and the per-row answer Ozon
 * gave back. The transfer hook owns the text and the results; the screen owns
 * the command lock and the busy chip.
 */
export function StoreImportDialog({
  transfer,
  busy,
  canManageRoster,
}: {
  transfer: ReturnType<typeof useStoreRosterTransfer>
  busy: StoreBusyKind | undefined
  canManageRoster: boolean
}) {
  const { rows, issues } = transfer.importParsed

  return (
    <Dialog
      open={transfer.importOpen}
      onOpenChange={(open) => {
        if (!open && busy !== "import") {
          transfer.setImportOpen(false);
          transfer.setImportText("");
          transfer.setImportResults(undefined);
        }
      }}
    >
      <DialogContent
        showCloseButton={busy !== "import"}
        className="grid max-h-[min(46rem,calc(100dvh-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogHeader className="gap-1 border-b border-border px-5 py-3.5">
          <DialogTitle className="pr-6 text-base font-semibold">
            批量导入
          </DialogTitle>
          <DialogDescription className="text-balance">
            已有 Client ID 会更新密钥；不填写分组则保留原分组。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          <Field>
            <FieldLabel htmlFor="store-import-lines">
              店铺信息{" "}
              <span className="text-destructive" aria-hidden="true">
                *
              </span>
            </FieldLabel>
            <Textarea
              id="store-import-lines"
              required
              autoComplete="off"
              spellCheck={false}
              disabled={busy === "import"}
              rows={5}
              className="field-sizing-fixed max-h-64 min-h-32 font-mono text-xs"
              placeholder={
                "店铺名,Client ID,API Key #分组\n店铺名,Client ID,API Key"
              }
              value={transfer.importText}
              onChange={(event) => transfer.setImportText(event.target.value)}
            />
            <FieldDescription aria-live="polite">
              {rows.length > 0 || issues.length > 0
                ? `${rows.length} 家可导入${
                    issues.length > 0
                      ? `，${issues.length} 行无法解析将被跳过`
                      : ""
                  }${
                    transfer.importNewGroups > 0
                      ? `；${transfer.importNewGroups} 个新分组${
                          canManageRoster
                            ? "，导入时将自动创建"
                            : "，需要主管先创建"
                        }`
                      : ""
                  }`
                : "每行一家，支持中英文逗号，空行忽略。"}
            </FieldDescription>
          </Field>

          {transfer.importResults && transfer.importResults.length > 0 ? (
            <ul className="space-y-1.5">
              {transfer.importResults.map((result) => (
                <li
                  key={result.source_ref}
                  className="flex flex-wrap items-center gap-2 text-xs"
                >
                  <StateChip
                    status={
                      result.status === "failed" ? "failed" : "verified"
                    }
                    label={
                      result.status === "created"
                        ? "已创建"
                        : result.status === "updated"
                          ? "已更新密钥"
                          : "失败"
                    }
                  />
                  <span className="text-muted-foreground">
                    第 {result.source_ref} 行
                    {result.name ? ` · ${result.name}` : ""}
                  </span>
                  {result.reason ? (
                    <span className="text-faint-foreground">
                      {result.reason}
                    </span>
                  ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
        </div>

        <DialogFooter className="m-0 gap-2 rounded-none border-t border-border bg-popover px-5 py-3 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={busy === "import"}
            onClick={() => {
              transfer.setImportOpen(false);
              transfer.setImportText("");
              transfer.setImportResults(undefined);
            }}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={busy !== undefined || rows.length === 0}
            onClick={() => void transfer.importKeys()}
          >
            {busy === "import" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <FileInput data-icon="inline-start" />
            )}
            {rows.length > 0
              ? `导入 ${rows.length} 家`
              : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
