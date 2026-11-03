import { useMemo, useState } from "react"

import type { ImportOzonStoreResultView } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { formatStoreImportText, parseStoreImportText, writableGroupName } from "./store-import"
import { rememberStoreRoster } from "./store-roster-cache"

/**
 * Roster key import/export: the paste box text, the parsed preview, the
 * per-row results Ozon answered with, and the export document. The screen
 * keeps the roster itself and the shared command lock.
 */
export function useStoreRosterTransfer({
  workspaceId,
  rosterGroups,
  stores,
  actionLock,
  onBusy,
  reload,
}: {
  workspaceId?: number
  rosterGroups: readonly { name: string }[]
  stores: readonly { id: string, group?: { name: string } | null }[]
  actionLock: { current: boolean }
  onBusy: (kind: "import" | "export" | undefined) => void
  reload: (options?: { soft?: boolean, force?: boolean }) => Promise<void> | void
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importResults, setImportResults] =
  useState<ImportOzonStoreResultView[]>();
  const [exportText, setExportText] = useState<string>();

  const importParsed = useMemo(
  () => parseStoreImportText(importText),
  [importText],
  );
  const importNewGroups = useMemo(() => {
  const known = new Set(
    rosterGroups.map((group) => group.name.toLowerCase()),
  );
  return new Set(
    importParsed.rows
      .map((row) => row.group?.toLowerCase())
      .filter((group): group is string => !!group && !known.has(group)),
  ).size;
  }, [importParsed, rosterGroups]);

  async function importKeys() {
  if (actionLock.current) return;
  const parsed = parseStoreImportText(importText);
  const issueResults: ImportOzonStoreResultView[] = parsed.issues.map(
    (issue) => ({
      source_ref: String(issue.line),
      name: "",
      status: "failed",
      uuid: null,
      quota_suspended: false,
      reason: issue.reason,
    }),
  );
  if (parsed.rows.length === 0) {
    setImportResults(issueResults.length ? issueResults : undefined);
    notifyError("没有可导入的店铺行", {
      description: "每行一条：店铺名,Client ID,API Key，行尾可加 #分组。",
    });
    return;
  }
  actionLock.current = true;
  onBusy("import");
  try {
    const sourceByRef = new Map<string, string>();
    for (const row of parsed.rows)
      sourceByRef.set(String(row.line), row.source);
    for (const issue of parsed.issues)
      sourceByRef.set(String(issue.line), issue.source);
    const outcome = await integrationsHttp.integrationsImportOzonStores({
      items: parsed.rows.map((row) => ({
        source_ref: String(row.line),
        name: row.name,
        client_id: row.clientId,
        api_key: row.apiKey,
        group_name: row.group,
      })),
    });
    rememberStoreRoster(outcome.overview, workspaceId);
    const all = [...issueResults, ...outcome.results].sort(
      (a, b) => Number(a.source_ref) - Number(b.source_ref),
    );
    setImportResults(all);
    const failed = all.filter((result) => result.status === "failed");
    if (failed.length === 0) {
      setImportOpen(false);
      setImportText("");
      setImportResults(undefined);
      notifySuccess(
        all.length === 1
          ? "已导入 1 家店铺密钥"
          : `已导入 ${all.length} 家店铺密钥`,
        { description: "密钥已验证并加密托管；界面不会回显密钥。" },
      );
    } else {
      setImportText(
        failed
          .map((result) => sourceByRef.get(result.source_ref) ?? "")
          .filter((line) => line.length > 0)
          .join("\n"),
      );
      notifyError(
        `导入完成：成功 ${all.length - failed.length} 家，失败 ${failed.length} 家`,
        { description: "失败行已保留在输入框，可修正后重试。" },
      );
    }
  } catch (reason) {
    notifyCommandError(reason, "批量导入失败，请稍后重试。");
    void reload({ soft: true, force: true });
  } finally {
    actionLock.current = false;
    onBusy(undefined);
  }
  }

  async function exportKeys() {
  if (actionLock.current) return;
  actionLock.current = true;
  onBusy("export");
  try {
    const data = await integrationsHttp.integrationsExportOzonStores();
    if (data.items.length === 0) {
      notifyInfo("没有可导出的店铺密钥");
      return;
    }
    // Group names join on the painted roster — every exportable Store is
    // visible to this operator, so its uuid is always present here.
    const groupByUuid = new Map(
      stores.map((store) => [store.id, store.group?.name ?? null]),
    );
    let unwritable = 0;
    const items = data.items.map((item) => {
      const group = groupByUuid.get(item.uuid);
      if (group && writableGroupName(group) === undefined) unwritable += 1;
      return { ...item, group };
    });
    setExportText(formatStoreImportText(items));
    if (unwritable > 0) {
      notifyInfo(`${unwritable} 个分组名含有分隔符，未能写入导出文本`);
    }
  } catch (reason) {
    notifyCommandError(reason, "批量导出失败，请稍后重试。");
  } finally {
    actionLock.current = false;
    onBusy(undefined);
  }
  }

  return {
    importOpen,
    setImportOpen,
    importText,
    setImportText,
    importResults,
    setImportResults,
    exportText,
    setExportText,
    importParsed,
    importNewGroups,
    importKeys,
    exportKeys,
  }
}
