import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart2,
  Check,
  FileInput,
  FileOutput,
  Hash,
  KeyRound,
  Pencil,
  Plus,
  Search,
  SearchX,
  Store,
  Trash2,
  Unlink,
} from "lucide-react";

import type {
  AccountOverview,
  CategoryTreeNodeView,
  OzonStoreView,
} from "@/bindings/commands";
import { indexCategoryNodes } from "@/features/category-schema/category-tree";
import { readCategoryTreeCache } from "@/features/category-schema/category-tree-cache";
import { loadCategoryTree } from "@/features/category-schema/category-tree-load";
import { StoreGroupsDialog } from "./store-groups-dialog";
import { StoreTagsDialog } from "./store-tags-dialog";
import { filterStoresByTags } from "./store-tags";
import { filterStoresBySearch } from "./store-search";
import { FinanceBalanceCell } from "./finance-balance-cell";
import { productQuotaItems } from "./product-quota";
import { isStoreKeyExpired, useStoreRoster } from "./store-roster-cache";
import { useScreenActive } from "@/components/screen-pane";
import { IdCode } from "@/components/id-code";
import { IdentityTile } from "@/components/identity-tile";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StateChip } from "@/components/state-chip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ReasonTooltip } from "@/components/reason-tooltip";
import { useStoreCommands, type StoreBusyKind } from "./use-store-commands"
import { useStoreEditor } from "./use-store-editor"
import { useStoreRosterTransfer } from "./use-store-roster-transfer"
import { StoreDeleteDialog } from "./store-delete-dialog"
import { StoreExportDialog } from "./store-export-dialog"
import { StoreImportDialog } from "./store-import-dialog"

type StoresScreenProps = {
  overview?: AccountOverview;
  onOpenAccount?: () => void;
};


const UPDATED_AT_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatUpdatedAt(ms: number) {
  if (!ms) return "—";
  try {
    return UPDATED_AT_FORMAT.format(new Date(ms));
  } catch {
    return "—";
  }
}

/** Ozon keys are time-limited and cabinet-rotated — flag them ahead of lapse. */
const KEY_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;

function keyExpiryState(
  expiresAtMs?: number | null,
): "expired" | "soon" | null {
  if (!expiresAtMs) return null;
  const remaining = expiresAtMs - Date.now();
  if (remaining <= 0) return "expired";
  if (remaining <= KEY_EXPIRY_WARN_MS) return "soon";
  return null;
}


function ProductQuotaCell({
  store,
  mode = "progress",
  categoryNames,
}: {
  store: OzonStoreView;
  mode?: "progress" | "number";
  categoryNames?: ReadonlyMap<number, string>;
}) {
  const items = productQuotaItems(
    store.product_quota,
    categoryNames ? (id) => categoryNames.get(id) : undefined,
  );
  if (items.length === 0) {
    return (
      <span className="text-faint-foreground">
        {store.configured ? "尚未查询" : "—"}
      </span>
    );
  }

  if (mode === "number") {
    return (
      <dl className="grid w-max grid-cols-[auto_auto] gap-x-2 gap-y-0.5 font-mono text-xs tabular-nums">
        {items.map((item) => (
          <Fragment key={item.label}>
            <dt className="text-faint-foreground" title={item.tooltip}>
              {item.label}
            </dt>
            <dd className="text-right" title={item.tooltip}>
              {item.formatted}
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  return (
    <div className="flex flex-col gap-1 w-full min-w-28 font-mono text-xs select-none">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-center gap-1.5"
          title={item.tooltip}
        >
          <span className="w-6 shrink-0 text-meta text-faint-foreground">
            {item.label}
          </span>
          <div className="relative h-1.5 flex-1 min-w-8 rounded-full bg-border/60 overflow-hidden">
            <div
              className="h-full rounded-full transition-[width,background-color] duration-300"
              style={{
                width: `${item.barWidth}%`,
                backgroundColor: item.color,
              }}
            />
          </div>
          <span
            aria-hidden="true"
            className={cn(
              "w-11 shrink-0 text-right text-meta tabular-nums font-mono",
              item.tier === "danger"
                ? "text-st-bad-ink font-medium"
                : "text-muted-foreground",
            )}
          >
            {item.remainingFormatted}
          </span>
          <span className="sr-only"> {item.formatted}</span>
        </div>
      ))}
    </div>
  );
}

function CreateStoreButton({
  canCreate,
  creating,
  disabledReason,
  onClick,
  storesUsed,
  storeLimit,
}: {
  canCreate: boolean;
  creating: boolean;
  disabledReason?: string;
  onClick: () => void;
  storesUsed?: number;
  storeLimit?: number;
}) {
  const button = (
    <Button
      type="button"
      disabled={!canCreate}
      // Disabled, the button's own title must not shadow the reason the
      // wrapper carries — the innermost title under the cursor wins.
      title={disabledReason ?? "新增店铺后录入 Client ID 与 API Key"}
      onClick={onClick}
    >
      {creating ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <Plus data-icon="inline-start" />
      )}
      <span>新增店铺</span>
      {storeLimit !== undefined ? (
        <span className="font-mono text-xs tabular-nums opacity-75">
          {storesUsed !== undefined ? storesUsed : "—"} / {storeLimit}
        </span>
      ) : null}
    </Button>
  );

  return (
    <ReasonTooltip reason={disabledReason}>{button}</ReasonTooltip>
  );
}

/** The value the assignee picker uses for "nobody": Select has no null item. */
const UNASSIGNED = "unassigned";

export type CreateStoreGateInput = {
  rosterLoaded: boolean;
  hasWorkspace: boolean;
  storesUsed: number;
  storeLimit: number;
  busy: StoreBusyKind | undefined;
  /** True while the create/edit draft dialog is open — creation is parked on it. */
  draftOpen: boolean;
};

export type CreateStoreGate = {
  canCreate: boolean;
  disabledReason?: string;
};

/**
 * Single source for both the create-button state and the reason it must show
 * when disabled. Keeping them in one chain is the fix: a condition folded into
 * `canCreate` without a matching reason leaves a grey button that explains
 * nothing (the draft-open case did exactly that).
 */
export function createStoreGate(input: CreateStoreGateInput): CreateStoreGate {
  if (!input.rosterLoaded) {
    return {
      canCreate: false,
      disabledReason: "请先登录并加载当前 Workspace 的店铺名册",
    };
  }
  if (!input.hasWorkspace) {
    return { canCreate: false, disabledReason: "请先加入或创建 Workspace" };
  }
  if (input.storesUsed >= input.storeLimit) {
    return {
      canCreate: false,
      disabledReason: `当前 Workspace 店铺名额 ${input.storeLimit}，已达上限`,
    };
  }
  // `busy !== undefined` covers every StoreBusyKind: any in-flight roster
  // operation (load/save/clear/delete/test/assign/grant/import/export/tag)
  // parks creation, and all share this one reason.
  if (input.busy !== undefined) {
    return { canCreate: false, disabledReason: "请稍候，正在处理…" };
  }
  if (input.draftOpen) {
    return {
      canCreate: false,
      disabledReason: "正在新建店铺，请先完成或取消",
    };
  }
  return { canCreate: true };
}

/** Store operations and Owner-controlled key permissions share the roster. */
export function StoresScreen({ overview, onOpenAccount }: StoresScreenProps) {
  const active = useScreenActive();
  const workspaceId = overview?.active_workspace?.id;
  const workspaceRole = overview?.active_workspace?.role;
  const roster = useStoreRoster(workspaceId)?.overview;
  const {
    busy,
    setBusy,
    members,
    testingId,
    setTestingId,
    editingId,
    setEditingId,
    selectedStoreIds,
    setSelectedStoreIds,
    deleteCandidateIds,
    setDeleteCandidateIds,
    clearCandidateId,
    setClearCandidateId,
    draft,
    setDraft,
    selectedTagUuids,
    setSelectedTagUuids,
    untaggedOnly,
    setUntaggedOnly,
    tagsOpen,
    setTagsOpen,
    newTagName,
    setNewTagName,
    wasActive,
    actionLock,
    stores,
    editor,
    editingSecretStatus,
    deleteCandidates,
    canEditName,
    canManageKey,
    canManageRoster,
    canManageTags,
    tagsChanged,
    groupChanged,
    tagsOnlySave,
    groupsOpen,
    setGroupsOpen,
    newGroupName,
    setNewGroupName,
  } = useStoreEditor({ workspaceId, workspaceRole, roster, active })
  // The editor's Store can lose its key to expiry too; mirror the row gate so
  // the button explains itself before Cloud refuses the activation.
  const activeDisabledReason = !editor
    ? undefined
    : !editor.configured
      ? "尚未登记密钥，无法设为当前"
      : editor.manual_disabled === true
        ? "店铺已停用，无法设为当前"
        : editor.quota_suspended === true
          ? "店铺超出名额，无法设为当前"
          : isStoreKeyExpired(editor)
            ? "Seller 密钥已过期，请在卖家后台重新生成后登记"
            : busy !== undefined
              ? "请稍候，正在处理其他店铺操作"
              : undefined;
  const [query, setQuery] = useState("");
  const [quotaDisplayMode, setQuotaDisplayMode] = useState<
    "progress" | "number"
  >(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("ozon.stores.quota-display-mode");
      if (saved === "number" || saved === "progress") return saved;
    }
    return "progress";
  });

  const toggleQuotaDisplayMode = () => {
    setQuotaDisplayMode((previous) => {
      const next = previous === "progress" ? "number" : "progress";
      try {
        localStorage.setItem("ozon.stores.quota-display-mode", next);
      } catch {
        // ignore localStorage errors
      }
      return next;
    });
  };

  // 附加限额按 description_category_id 给热门类目。类目名从共享类目树解析 —
  // 先读本地缓存，未命中走只读 GET /api/catalog/tree（不带 storeId 即缓存直答，
  // 名册不打 Ozon），解析不到时 tooltip 回退为裸 id。
  const needsCategoryNames = stores.some(
    (store) => (store.product_quota?.total?.categories?.length ?? 0) > 0,
  );
  const [quotaCategoryTree, setQuotaCategoryTree] = useState<
    CategoryTreeNodeView[]
  >(() => readCategoryTreeCache() ?? []);
  useEffect(() => {
    if (!needsCategoryNames || quotaCategoryTree.length > 0 || !active) return;
    let cancelled = false;
    void loadCategoryTree()
      .then((tree) => {
        if (cancelled || tree.length === 0) return;
        setQuotaCategoryTree(tree);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needsCategoryNames, quotaCategoryTree.length, active]);
  const quotaCategoryNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const [id, node] of indexCategoryNodes(quotaCategoryTree)) {
      names.set(id, node.category_name);
    }
    return names;
  }, [quotaCategoryTree]);
  const canDeleteStore = (store: OzonStoreView) =>
    store.permissions.delete_store;
  const storeLimit =
    roster?.store_limit ?? overview?.entitlement?.limits.stores ?? 1;
  const storesUsed = roster?.stores_used ?? stores.length;
  // Selection derives from the painted roster, so a stale id after a Workspace
  // switch is inert: every batch action maps over the intersection. Tag
  // filtering and the keyword search narrow the paint, and selections prune to
  // it — a batch action must never reach a Store the filter hides.
  const visibleStores = useMemo(
    () =>
      filterStoresBySearch(
        filterStoresByTags(stores, [...selectedTagUuids], untaggedOnly),
        query,
      ),
    [stores, selectedTagUuids, untaggedOnly, query],
  );
  useEffect(() => {
    const visibleIds = new Set(visibleStores.map((store) => store.id));
    setSelectedStoreIds((previous) => {
      const next = new Set([...previous].filter((id) => visibleIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [visibleStores]);
  const selectedStores = stores.filter((store) =>
    selectedStoreIds.has(store.id),
  );
  const manageableStores = visibleStores.filter((store) =>
    canDeleteStore(store),
  );
  const allManageableSelected =
    manageableStores.length > 0 &&
    manageableStores.every((store) => selectedStoreIds.has(store.id));
  const someManageableSelected = manageableStores.some((store) =>
    selectedStoreIds.has(store.id),
  );
  const allSelectedTestable =
    selectedStores.length > 0 &&
    selectedStores.every(
      (store) =>
        store.configured &&
        !store.manual_disabled &&
        !store.quota_suspended &&
        !isStoreKeyExpired(store) &&
        store.permissions.test_key,
    );
  const {
    reload, refreshFinanceBalances, openEditor, createStore, createTag, createGroup, saveKey, clearStore,
    deleteStores, testStores, assignStore, setKeyGrant, setActive, testStore,
  } = useStoreCommands({
    workspaceId, roster,
    canEditName, canManageTags, tagsChanged, groupChanged, editor, draft, editingId, newTagName, newGroupName,
    actionLock, setBusy, setDraft, setEditingId, setNewTagName, setNewGroupName, setTestingId,
    setSelectedStoreIds, setDeleteCandidateIds, onOpenAccount,
  })

  const transfer = useStoreRosterTransfer({
    workspaceId,
    rosterTags: roster?.tags ?? [],
    stores,
    actionLock,
    onBusy: (kind) => setBusy(kind),
    reload,
  })
  const { exportText, setExportText, exportKeys } = transfer

  useEffect(() => {
    void reload();
  }, []);



  useEffect(() => {
    const becameActive = active && !wasActive.current;
    wasActive.current = active;
    // Soft refresh on revisit — keep the painted roster, never flash the skeleton.
    if (!becameActive || !roster) return;
    void reload({ soft: true });
  }, [active, roster]);


  const { canCreate, disabledReason: createDisabledReason } = createStoreGate({
    rosterLoaded: Boolean(roster),
    hasWorkspace: Boolean(overview?.active_workspace),
    storesUsed,
    storeLimit,
    busy,
    draftOpen: draft !== undefined,
  });

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4">
      <h1 className="sr-only">店铺</h1>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="relative w-64">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索店铺"
                placeholder="搜索店铺、Client ID、标签、分组"
                className="h-9 pl-8"
              />
            </div>
            {query.trim() ? (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                显示 {visibleStores.length} 家
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {selectedStores.length > 0 ? (
              <>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  已选 {selectedStores.length}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!allSelectedTestable || busy !== undefined}
                  title={
                    allSelectedTestable
                      ? undefined
                      : "部分已选店铺未登记密钥、已停用、密钥已过期或超出名额"
                  }
                  onClick={() =>
                    void testStores(selectedStores.map((store) => store.id))
                  }
                >
                  <Activity />
                  测试连接
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy !== undefined}
                  onClick={() =>
                    setDeleteCandidateIds(
                      selectedStores.map((store) => store.id),
                    )
                  }
                >
                  <Trash2 />
                  移除
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={
                !roster ||
                !overview?.active_workspace ||
                busy !== undefined ||
                Boolean(draft)
              }
              title="每行一条：店铺名,Client ID,API Key，行尾可加 #标签"
              onClick={() => {
                transfer.setImportResults(undefined);
                transfer.setImportOpen(true);
              }}
            >
              <FileInput data-icon="inline-start" />
              批量导入
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                busy !== undefined ||
                !stores.some(
                  (store) => store.configured && store.permissions.manage_key,
                )
              }
              title="导出你有权管理的店铺密钥与标签，格式同批量导入"
              onClick={() => void exportKeys()}
            >
              {busy === "export" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FileOutput data-icon="inline-start" />
              )}
              批量导出
            </Button>
            <CreateStoreButton
              canCreate={canCreate}
              creating={false}
              disabledReason={createDisabledReason}
              onClick={() => createStore()}
              storesUsed={
                roster ? (roster.stores_used ?? stores.length) : undefined
              }
              storeLimit={storeLimit}
            />
          </div>
        </div>
        {(roster?.tags ?? []).length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            {(roster?.tags ?? []).map((tag) => {
              const selected = selectedTagUuids.has(tag.uuid);
              return (
                <Button
                  key={tag.uuid}
                  type="button"
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  aria-pressed={selected}
                  onClick={() =>
                    setSelectedTagUuids((previous) => {
                      const next = new Set(previous);
                      if (selected) next.delete(tag.uuid);
                      else next.add(tag.uuid);
                      return next;
                    })
                  }
                >
                  {tag.name}{" "}
                  <span className="ml-1 font-mono text-xs opacity-70">
                    {tag.store_count}
                  </span>
                </Button>
              );
            })}
            <Button
              type="button"
              size="sm"
              variant={untaggedOnly ? "default" : "outline"}
              aria-pressed={untaggedOnly}
              onClick={() => setUntaggedOnly((value) => !value)}
            >
              无标签
            </Button>
          </div>
        ) : null}
        {busy === "load" && !roster ? (
          <div className="flex min-h-0 flex-1 items-center gap-2 px-4 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在读取店铺…
          </div>
        ) : stores.length === 0 ? (
          <Empty className="min-h-0 flex-1 rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Store />
              </EmptyMedia>
              <EmptyTitle>还没有店铺</EmptyTitle>
              <EmptyDescription>
                新增后由所有者登记 Client ID 和 API
                Key；也可以允许指派人管理该店密钥。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : visibleStores.length === 0 ? (
          <Empty className="min-h-0 flex-1 rounded-none border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchX />
              </EmptyMedia>
              <EmptyTitle>没有匹配的店铺</EmptyTitle>
              <EmptyDescription>
                换个关键词，或调整上方的标签筛选。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allManageableSelected}
                      indeterminate={
                        someManageableSelected && !allManageableSelected
                      }
                      aria-label="选择全部可管理店铺"
                      onCheckedChange={() =>
                        setSelectedStoreIds((previous) => {
                          const next = new Set(previous);
                          for (const store of manageableStores) {
                            if (!allManageableSelected) next.add(store.id);
                            else next.delete(store.id);
                          }
                          return next;
                        })
                      }
                    />
                  </TableHead>
                  <TableHead className="w-[20%]">店铺</TableHead>
                  <TableHead>标签</TableHead>
                  <TableHead>分组</TableHead>
                  <TableHead>凭据</TableHead>
                  <TableHead
                    className="min-w-36"
                    title="Ozon 今日还能新建、更新的数量，以及商品上限：基础限额适用于所有类目（上限含归档回补，与卖家后台一致），附加限额只覆盖热门类目（先扣附加、再扣基础）。-1 为不限。"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span>上架额度</span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleQuotaDisplayMode();
                        }}
                        className="inline-flex items-center gap-1 rounded border border-border/80 bg-background px-1.5 py-0.5 text-meta font-normal text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                        title={
                          quotaDisplayMode === "progress"
                            ? "当前为进度条，点击切换为数字显示"
                            : "当前为数字，点击切换为进度条显示"
                        }
                        aria-label={
                          quotaDisplayMode === "progress"
                            ? "切换为数字显示"
                            : "切换为进度条显示"
                        }
                      >
                        {quotaDisplayMode === "progress" ? (
                          <>
                            <BarChart2
                              className="size-3 text-st-good"
                              aria-hidden
                            />
                            <span>进度</span>
                          </>
                        ) : (
                          <>
                            <Hash
                              className="size-3 text-brand-ink"
                              aria-hidden
                            />
                            <span>数字</span>
                          </>
                        )}
                      </button>
                    </div>
                  </TableHead>
                  <TableHead
                    title="Ozon 财务 → 余额的期末金额（POST /v1/finance/balance 的 total.closing_balance）。Seller API 没有可提现字段。币种以接口返回为准；只有原币是卢布且已盖上俄罗斯央行汇率时，才按店铺合同币种换算。"
                  >
                    期末余额
                  </TableHead>
                  <TableHead>归属</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead className="w-32 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleStores.map((store) => {
                  // Expiry precedes the permission gate: Cloud reports
                  // `permissions.testKey=false` for a lapsed key too, and the
                  // operator must read why, not "no permission".
                  const testDisabledReason = !store.configured
                    ? "尚未登记密钥，无法测试"
                    : store.manual_disabled
                      ? "店铺已停用，无法测试"
                      : store.quota_suspended
                        ? "店铺超出名额，无法测试"
                        : isStoreKeyExpired(store)
                          ? "Seller 密钥已过期，请在卖家后台重新生成后登记"
                          : !store.permissions.test_key
                            ? "没有测试这家店的权限"
                            : busy !== undefined
                              ? "请稍候，正在处理其他店铺操作"
                              : undefined;
                  const mutateDisabledReason =
                    store.permissions.manage_key || store.permissions.edit_name
                      ? undefined
                      : "没有修改这家店的权限";
                  return (
                    <TableRow
                      key={store.id}
                      className={
                        store.permissions.manage_key ||
                        store.permissions.edit_name
                          ? "cursor-pointer"
                          : undefined
                      }
                      data-state={
                        editingId === store.id ? "selected" : undefined
                      }
                      onClick={() => {
                        if (
                          store.permissions.manage_key ||
                          store.permissions.edit_name
                        )
                          openEditor(store);
                      }}
                    >
                      <TableCell
                        className="w-10"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Checkbox
                          checked={selectedStoreIds.has(store.id)}
                          disabled={!canDeleteStore(store)}
                          aria-label={`选择 ${store.label || "未命名店铺"}`}
                          onCheckedChange={(checked) =>
                            setSelectedStoreIds((previous) => {
                              const next = new Set(previous);
                              if (checked === true) next.add(store.id);
                              else next.delete(store.id);
                              return next;
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <IdentityTile
                            icon={Store}
                            status={store.configured ? "present" : "absent"}
                          />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-md font-medium">
                                {store.label || "未命名店铺"}
                              </span>
                              {store.active ? (
                                <StateChip
                                  status="skipped_policy"
                                  label="当前"
                                />
                              ) : null}
                              {store.cloud_status === "manual_disabled" ? (
                                <StateChip status="failed" label="店铺已停用" />
                              ) : store.cloud_status === "quota_suspended" ? (
                                <StateChip
                                  status="failed"
                                  label="超出 Workspace 名额"
                                />
                              ) : null}
                            </div>
                            <div className="mt-0.5">
                              {store.client_id ? (
                                <IdCode value={store.client_id} />
                              ) : (
                                <span className="text-xs text-faint-foreground">
                                  未填写
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {store.tags?.length ? (
                          <div className="flex flex-wrap gap-1">
                            {store.tags.map((tag) => (
                              <Badge
                                key={tag.uuid}
                                variant="outline"
                                className="px-1.5 py-0 text-meta font-normal"
                              >
                                {tag.name}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-faint-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {store.group?.name ? (
                          <Badge
                            variant="outline"
                            className="px-1.5 py-0 text-meta font-normal"
                          >
                            {store.group.name}
                          </Badge>
                        ) : (
                          <span className="text-xs text-faint-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1.5">
                          <div className="flex flex-wrap gap-1.5">
                            <StateChip
                              status={store.configured ? "present" : "absent"}
                              label={
                                store.configured
                                  ? "Cloud 已托管"
                                  : "Cloud 未登记"
                              }
                            />
                            <StateChip
                              status={
                                store.verified_at_ms ? "verified" : "absent"
                              }
                              label={
                                store.verified_at_ms
                                  ? "API 已验证"
                                  : "API 待测试"
                              }
                            />
                            {keyExpiryState(store.key_expires_at_ms) ===
                            "expired" ? (
                              <StateChip
                                status="unavailable"
                                tone="bad"
                                label="密钥已过期"
                              />
                            ) : keyExpiryState(store.key_expires_at_ms) ===
                              "soon" ? (
                              <StateChip
                                status="expiring"
                                tone="flight"
                                label="密钥将到期"
                              />
                            ) : null}
                          </div>
                          {store.verified_at_ms ? (
                            <span className="text-meta text-faint-foreground">
                              最近验证 {formatUpdatedAt(store.verified_at_ms)}
                            </span>
                          ) : null}
                          {store.key_expires_at_ms ? (
                            <span
                              className="text-meta text-faint-foreground"
                              title="Ozon 密钥到期后需在卖家后台重新生成并登记"
                            >
                              密钥到期{" "}
                              {formatDate(store.key_expires_at_ms)}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell
                        className="align-top text-xs text-muted-foreground cursor-pointer select-none"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleQuotaDisplayMode();
                        }}
                        title="点击切换进度条/数字显示"
                      >
                        <div className="group/quota rounded p-1 -m-1 transition-colors hover:bg-muted/40">
                          <ProductQuotaCell
                            store={store}
                            mode={quotaDisplayMode}
                            categoryNames={quotaCategoryNames}
                          />
                        </div>
                      </TableCell>
                      <TableCell
                        className="align-top text-xs"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <FinanceBalanceCell
                          store={store}
                          reading={busy === "load"}
                          onRetry={() => void refreshFinanceBalances()}
                        />
                      </TableCell>
                      <TableCell
                        className="text-xs"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {store.permissions.manage_store && members ? (
                          <Select
                            value={
                              store.assignee_membership_id == null
                                ? UNASSIGNED
                                : String(store.assignee_membership_id)
                            }
                            disabled={busy !== undefined}
                            onValueChange={(value) => {
                              const next =
                                value == null || value === UNASSIGNED
                                  ? null
                                  : Number(value);
                              if (
                                next === (store.assignee_membership_id ?? null)
                              )
                                return;
                              void assignStore(store.id, next);
                            }}
                          >
                            <SelectTrigger
                              size="sm"
                              className="min-w-36 cursor-pointer"
                              title="换指派人会关闭「允许指派人管理密钥」"
                              aria-label={`改派 ${store.label || "未命名店铺"}`}
                            >
                              <SelectValue>
                                {store.assignee_name ?? (
                                  <span className="text-faint-foreground">
                                    未分配
                                  </span>
                                )}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNASSIGNED}>未分配</SelectItem>
                              {members.map((member) => (
                                <SelectItem
                                  key={member.id}
                                  value={String(member.id)}
                                >
                                  {member.name || member.email}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {store.assignee_name ? (
                              <span className="text-muted-foreground">
                                {store.assignee_name}
                              </span>
                            ) : (
                              <span className="text-faint-foreground">
                                未分配
                              </span>
                            )}
                            {store.assignee_email ? (
                              <span className="text-faint-foreground">
                                {store.assignee_email}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {store.last_used_at_ms
                          ? formatUpdatedAt(store.last_used_at_ms)
                          : "尚未使用"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="outline"
                                  aria-label="测试连接"
                                  disabled={testDisabledReason !== undefined}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void testStore(store.id);
                                  }}
                                />
                              }
                            >
                              {busy === "test" && testingId === store.id ? (
                                <Spinner aria-hidden />
                              ) : (
                                <Activity aria-hidden />
                              )}
                            </TooltipTrigger>
                            <TooltipContent>
                              {testDisabledReason ??
                                "由 Cloud 探测 Seller 连接，不显示密钥"}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="outline"
                                  aria-label="店铺资料"
                                  disabled={mutateDisabledReason !== undefined}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openEditor(store);
                                  }}
                                />
                              }
                            >
                              <Pencil aria-hidden />
                            </TooltipTrigger>
                            <TooltipContent>
                              {mutateDisabledReason ?? "店铺资料"}
                            </TooltipContent>
                          </Tooltip>
                          {canDeleteStore(store) ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    type="button"
                                    size="icon-sm"
                                    variant="destructive"
                                    aria-label={`移除店铺 ${store.label} 并释放名额`}
                                    disabled={
                                      mutateDisabledReason !== undefined ||
                                      busy !== undefined
                                    }
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setDeleteCandidateIds([store.id]);
                                    }}
                                  />
                                }
                              >
                                <Trash2 aria-hidden />
                              </TooltipTrigger>
                              <TooltipContent>
                                {mutateDisabledReason ?? "移除店铺并释放名额"}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open && busy === undefined) {
            setEditingId(undefined);
            setDraft(undefined);
          }
        }}
      >
        <DialogContent
          showCloseButton={busy === undefined}
          className="grid max-h-[min(46rem,calc(100dvh-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          {editor && draft ? (
            <>
              <DialogHeader className="gap-1 border-b border-border px-5 py-3.5">
                <DialogTitle className="pr-6 text-base font-semibold">
                  {draft.label.trim() || editor.label || "新店铺"}
                </DialogTitle>
                <DialogDescription>
                  {draft.id
                    ? "Cloud 验证并托管 Seller 凭据。登录后任意设备可直接使用，保存后不回显密钥。"
                    : "创建工作空间店铺将占用一个店铺名额；标签会在店铺创建后应用。"}
                </DialogDescription>
              </DialogHeader>

              <div className="grid min-h-0 overflow-y-auto">
                <div className="min-h-0 space-y-5 p-5 sm:overflow-y-auto sm:p-6">
                  {draft.id ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <StateChip
                          status={editor.configured ? "present" : "absent"}
                          label={
                            editor.configured ? "Cloud 已托管" : "Cloud 未登记"
                          }
                        />
                        {editor.configured ? (
                          <StateChip
                            status={
                              editor.verified_at_ms ? "verified" : "absent"
                            }
                            label={
                              editor.verified_at_ms
                                ? "API 已验证"
                                : "API 待测试"
                            }
                          />
                        ) : null}
                        {editor.active ? (
                          <StateChip
                            status="skipped_policy"
                            label="当前上架目标"
                          />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label="设为当前"
                                  disabled={activeDisabledReason !== undefined}
                                  onClick={() => void setActive(editor.id)}
                                />
                              }
                            >
                              <Check aria-hidden />
                            </TooltipTrigger>
                            <TooltipContent>
                              {activeDisabledReason ?? "设为当前"}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>

                      <p className="text-sm text-muted-foreground">
                        指派决定谁运营这家店。密钥是工作空间资产：所有者可管理全部店铺；自己新建并指派给自己的店可以立刻录入密钥。界面不回显已托管的密钥。
                        {!canManageKey && draft.id
                          ? " 密钥由所有者登记。若要由你粘贴，请所有者把你设为指派人，并打开「允许指派人管理密钥」。"
                          : ""}
                      </p>
                    </>
                  ) : null}

                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="store-label">
                        店铺名称{" "}
                        <span className="text-destructive" aria-hidden="true">
                          *
                        </span>
                      </FieldLabel>
                      <Input
                        id="store-label"
                        required
                        value={draft.label}
                        disabled={!canEditName || busy !== undefined}
                        placeholder="主店"
                        onChange={(event) =>
                          setDraft((prev) =>
                            prev
                              ? { ...prev, label: event.target.value }
                              : prev,
                          )
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="store-client-id">
                        Client ID{" "}
                        <span className="text-destructive" aria-hidden="true">
                          *
                        </span>
                      </FieldLabel>
                      <Input
                        id="store-client-id"
                        required
                        inputMode="numeric"
                        autoComplete="off"
                        value={draft.clientId}
                        disabled={!canManageKey || busy !== undefined}
                        placeholder="请输入 Client ID"
                        onChange={(event) =>
                          setDraft((prev) =>
                            prev
                              ? { ...prev, clientId: event.target.value }
                              : prev,
                          )
                        }
                      />
                    </Field>
                    <Field>
                      <div className="flex items-center justify-between gap-2">
                        <FieldLabel>标签</FieldLabel>
                        {canManageTags ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs text-muted-foreground"
                            disabled={busy !== undefined}
                            onClick={() => setTagsOpen(true)}
                          >
                            管理
                          </Button>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(roster?.tags ?? []).map((tag) => {
                          const selected = draft.tagUuids.includes(tag.uuid);
                          return canManageTags ? (
                            <Button
                              key={tag.uuid}
                              type="button"
                              size="sm"
                              variant={selected ? "default" : "outline"}
                              aria-pressed={selected}
                              disabled={busy !== undefined}
                              onClick={() =>
                                setDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        tagUuids: selected
                                          ? prev.tagUuids.filter(
                                              (uuid) => uuid !== tag.uuid,
                                            )
                                          : [...prev.tagUuids, tag.uuid],
                                      }
                                    : prev,
                                )
                              }
                            >
                              {tag.name}
                            </Button>
                          ) : selected ? (
                            <Badge key={tag.uuid} variant="outline">
                              {tag.name}
                            </Badge>
                          ) : null;
                        })}
                        {(roster?.tags ?? []).length === 0 ? (
                          <span className="text-sm text-muted-foreground">
                            暂无标签
                          </span>
                        ) : null}
                      </div>
                      {canManageTags ? (
                        <div className="flex gap-2">
                          <Input
                            id="store-new-tag"
                            value={newTagName}
                            disabled={busy !== undefined}
                            placeholder="输入名称新建标签"
                            onChange={(event) =>
                              setNewTagName(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void createTag();
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!newTagName.trim() || busy !== undefined}
                            onClick={() => void createTag()}
                          >
                            {busy === "tag" ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <Plus data-icon="inline-start" />
                            )}
                            新建
                          </Button>
                        </div>
                      ) : null}
                    </Field>
                    <Field>
                      <div className="flex items-center justify-between gap-2">
                        <FieldLabel>分组</FieldLabel>
                        {canManageTags ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs text-muted-foreground"
                            disabled={busy !== undefined}
                            onClick={() => setGroupsOpen(true)}
                          >
                            管理
                          </Button>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(roster?.groups ?? []).map((group) => {
                          const selected = draft.groupUuid === group.uuid;
                          return canManageTags ? (
                            <Button
                              key={group.uuid}
                              type="button"
                              size="sm"
                              variant={selected ? "default" : "outline"}
                              aria-pressed={selected}
                              disabled={busy !== undefined}
                              onClick={() =>
                                setDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        groupUuid: selected ? null : group.uuid,
                                      }
                                    : prev,
                                )
                              }
                            >
                              {group.name}
                            </Button>
                          ) : selected ? (
                            <Badge key={group.uuid} variant="outline">
                              {group.name}
                            </Badge>
                          ) : null;
                        })}
                        {(roster?.groups ?? []).length === 0 ? (
                          <span className="text-sm text-muted-foreground">
                            暂无分组
                          </span>
                        ) : null}
                      </div>
                      {canManageTags ? (
                        <div className="flex gap-2">
                          <Input
                            id="store-new-group"
                            value={newGroupName}
                            disabled={busy !== undefined}
                            placeholder="输入名称新建分组"
                            onChange={(event) =>
                              setNewGroupName(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void createGroup();
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!newGroupName.trim() || busy !== undefined}
                            onClick={() => void createGroup()}
                          >
                            {busy === "group" ? (
                              <Spinner data-icon="inline-start" />
                            ) : (
                              <Plus data-icon="inline-start" />
                            )}
                            新建
                          </Button>
                        </div>
                      ) : null}
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="store-api-key">
                        API Key{" "}
                        {!editor.configured ? (
                          <span className="text-destructive" aria-hidden="true">
                            *
                          </span>
                        ) : null}
                      </FieldLabel>
                      <Input
                        id="store-api-key"
                        type="password"
                        required={!editor.configured}
                        disabled={!canManageKey || busy !== undefined}
                        autoComplete="new-password"
                        value={draft.apiKey}
                        placeholder={
                          editor.configured
                            ? "已托管 · 输入新值以更换"
                            : "粘贴 Seller API Key"
                        }
                        onChange={(event) =>
                          setDraft((prev) =>
                            prev
                              ? { ...prev, apiKey: event.target.value }
                              : prev,
                          )
                        }
                      />
                      <FieldDescription>
                        保存须同时填写 Client ID 和 API
                        Key。已托管的密钥永不回显。
                      </FieldDescription>
                    </Field>
                    {editor.id &&
                    editor.permissions.manage_key_grants &&
                    editor.assignee_membership_id != null ? (
                      <Field>
                        <label className="flex cursor-pointer items-center gap-2 text-xs">
                          <Checkbox
                            checked={editor.assignee_key_manage}
                            disabled={busy !== undefined}
                            aria-label="允许指派人管理密钥"
                            onCheckedChange={(value) => {
                              void setKeyGrant(editor.id, value === true);
                            }}
                          />
                          允许指派人管理密钥
                        </label>
                        <FieldDescription>
                          允许被指派的成员登记和修改该店铺的 Seller 密钥。
                        </FieldDescription>
                      </Field>
                    ) : null}
                  </FieldGroup>
                </div>
              </div>

              <DialogFooter className="m-0 gap-2 rounded-none border-t border-border bg-popover px-5 py-3 sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  {canManageKey && draft.id ? (
                    <Button
                      type="button"
                      variant="ghost"
                      title="只删除托管密钥，店铺仍占用名额"
                      disabled={
                        (!editor.configured &&
                          editingSecretStatus !== "present") ||
                        busy !== undefined
                      }
                      onClick={() => setClearCandidateId(editor.id)}
                    >
                      {busy === "clear" ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <Unlink data-icon="inline-start" />
                      )}
                      仅清除密钥
                    </Button>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    disabled={
                      busy !== undefined ||
                      !draft.label.trim() ||
                      (!draft.id
                        ? !canManageKey ||
                          !draft.clientId.trim() ||
                          !draft.apiKey.trim()
                        : !editor.configured
                          ? !(
                              (canManageKey &&
                                draft.clientId.trim() &&
                                draft.apiKey.trim()) ||
                              tagsOnlySave
                            )
                          : !(
                              (canManageKey &&
                                draft.apiKey.trim() &&
                                draft.clientId.trim()) ||
                              (canEditName &&
                                draft.label.trim() !== editor.label &&
                                (!draft.clientId.trim() ||
                                  draft.clientId.trim() ===
                                    (editor.client_id || "")) &&
                                !draft.apiKey.trim()) ||
                              tagsOnlySave
                            ))
                    }
                    onClick={() => void saveKey()}
                  >
                    {busy === "save" ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <KeyRound data-icon="inline-start" />
                    )}
                    验证并保存
                  </Button>
                </div>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {roster ? (
        <StoreTagsDialog
          open={tagsOpen}
          onOpenChange={setTagsOpen}
          overview={roster}
          workspaceId={workspaceId}
        />
      ) : null}
      {roster ? (
        <StoreGroupsDialog
          open={groupsOpen}
          onOpenChange={setGroupsOpen}
          overview={roster}
          workspaceId={workspaceId}
        />
      ) : null}

      <StoreImportDialog
        transfer={transfer}
        busy={busy}
        canManageRoster={canManageRoster}
      />
      <StoreExportDialog exportText={exportText} setExportText={setExportText} />
      <ConfirmDialog
        open={Boolean(clearCandidateId)}
        title="清除这家店的密钥？"
        description="将删除 Cloud 托管的 Seller API Key。店铺记录和名额保留。上架在重新登记之前会失败。"
        confirmText="清除密钥"
        footerLayout="end"
        busy={busy === "clear"}
        onOpenChange={(open) => {
          if (!open && busy !== "clear") setClearCandidateId(undefined);
        }}
        onConfirm={() => {
          if (clearCandidateId)
            void clearStore(clearCandidateId).then((ok) => {
              if (ok) setClearCandidateId(undefined);
            });
        }}
      />

      <StoreDeleteDialog
        busy={busy}
        deleteCandidateIds={deleteCandidateIds}
        deleteCandidates={deleteCandidates}
        deleteStores={deleteStores}
        setDeleteCandidateIds={setDeleteCandidateIds}
      />
    </div>
  );
}
