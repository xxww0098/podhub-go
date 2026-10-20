import { Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

function storeExportName(): string {
  return `ozon-stores-${new Date().toISOString().slice(0, 10)}.txt`;
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText(value: string, message: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    notifySuccess(message);
    return true;
  } catch {
    notifyCommandError(undefined, "复制失败，请改用下载。");
    return false;
  }
}

/** 批量导出密钥: the document the operator copies or downloads. */
export function StoreExportDialog({
  exportText,
  setExportText,
}: {
  exportText: string | undefined
  setExportText: (value: string | undefined) => void
}) {
  return (
  <Dialog
    open={exportText !== undefined}
    onOpenChange={(open) => {
      if (!open) setExportText(undefined);
    }}
  >
    <DialogContent className="grid max-h-[min(46rem,calc(100dvh-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl">
      <DialogHeader className="gap-1 border-b border-border px-5 py-3.5">
        <DialogTitle className="pr-6 text-base font-semibold">
          批量导出密钥
        </DialogTitle>
        <DialogDescription>
          {`共 ${exportText ? exportText.split("\n").length : 0} 家店铺，格式同批量导入。密钥为明文，请妥善保存。`}
        </DialogDescription>
      </DialogHeader>

      <div className="grid min-h-0 overflow-y-auto">
        <div className="min-h-0 p-5 sm:p-6">
          <Textarea
            readOnly
            aria-label="导出的店铺密钥"
            className="min-h-40 font-mono text-xs"
            value={exportText ?? ""}
            onFocus={(event) => event.target.select()}
          />
        </div>
      </div>

      <DialogFooter className="m-0 gap-2 rounded-none border-t border-border bg-popover px-5 py-3 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (exportText) void copyText(exportText, "已复制全部店铺密钥");
          }}
        >
          复制
        </Button>
        <Button
          type="button"
          onClick={() => {
            if (exportText)
              downloadText(storeExportName(), `${exportText}\n`);
          }}
        >
          <Download data-icon="inline-start" />
          下载 .txt
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  )
}
