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
  FieldGroup,
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
      className="grid max-h-[min(46rem,calc(100dvh-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl"
    >
      <DialogHeader className="gap-1 border-b border-border px-5 py-3.5">
        <DialogTitle className="pr-6 text-base font-semibold">
          批量导入密钥
        </DialogTitle>
        <DialogDescription>
          每行一家店铺：店铺名,Client ID,API Key，行尾可追加
          #标签（空格分隔多个，按名称匹配，不存在的会自动创建）。Cloud
          逐行验证并托管密钥；Client ID
          相同的已有店铺会改为更新密钥并应用所给标签，不写 # 则不动标签。
        </DialogDescription>
      </DialogHeader>

      <div className="grid min-h-0 overflow-y-auto">
        <div className="min-h-0 space-y-4 p-5 sm:p-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="store-import-lines">
                店铺密钥{" "}
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
                className="min-h-40 font-mono text-xs"
                placeholder={
                  "店铺 1,4995868,763954c3-5e68-48c9-b2a9-fa5dcbcd77e9 #华东"
                }
                value={transfer.importText}
                onChange={(event) => transfer.setImportText(event.target.value)}
              />
              <FieldDescription>
                {transfer.importParsed.rows.length > 0
                  ? `已解析 ${transfer.importParsed.rows.length} 行${
                      transfer.importParsed.issues.length > 0
                        ? `，${transfer.importParsed.issues.length} 行无法解析将被跳过`
                        : ""
                    }${
                      transfer.importNewTags > 0
                        ? `；含 ${transfer.importNewTags} 个不存在的标签${
                            canManageRoster
                              ? "，导入时将自动创建"
                              : "，需要主管先创建"
                          }`
                        : ""
                    }`
                  : "支持逗号或中文逗号分隔，行尾可加 #标签；空行忽略。"}
              </FieldDescription>
            </Field>
          </FieldGroup>

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
      </div>

      <DialogFooter className="m-0 gap-2 rounded-none border-t border-border bg-popover px-5 py-3 sm:justify-end">
        <Button
          type="button"
          variant="ghost"
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
          disabled={busy !== undefined || transfer.importParsed.rows.length === 0}
          onClick={() => void transfer.importKeys()}
        >
          {busy === "import" ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <FileInput data-icon="inline-start" />
          )}
          {transfer.importParsed.rows.length > 0
            ? `导入 ${transfer.importParsed.rows.length} 家`
            : "导入"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  )
}
