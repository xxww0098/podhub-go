/**
 * 行页面「默认字段」分区 —— 与上架表格（上架方案卡）同一条逻辑链：
 * `GET /api/catalog/schema` 拉类目字段，`GET …/ozon-config` 把线上配置投成
 * `WorkflowCategoryDraft` 起稿，共用 schema 字段编辑器按拍摄时的坐标经
 * 700ms 去抖整配置 PUT 回 `…/ozon-config`（expectedRevision CAS）。
 * 逐行生成的字段（名称 / 编号 / 简介 / 媒体位…）按 `rowOwnedFields` 锁定，
 * 锁理由指到行内分区而非上架表格列；售价反向锁定——最终值在上架表格里
 * 逐行填写，这里只留说明。
 *
 * 类目未选只留提示，schema 或配置读取失败只留重试按钮（错误走
 * notifyCommandError）；409 CAS 冲突不自动拉新基线再写 —— 那会是静默
 * 最后写赢 —— 而是把行锁回「重新读取」，用户确认后重拉再改。
 * 本组件不渲染内联错误。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"

import type {
  CategorySchemaRequest,
  CategorySchemaView,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
} from "@/bindings/commands"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { categorySchemaFlight } from "@/features/category-schema/schema-sync"
import { SupplierRowDefaultsForm } from "./supplier-row-defaults-form"
import {
  DurableAutosave,
  type DurableAutosavePhase,
} from "@/features/workflow/editing/durable-autosave"
import { AUTOSAVE_DEBOUNCE_MS } from "@/features/workflow/editing/use-card-autosave"
import {
  addComplexItem,
  removeComplexItem,
  writeWorkflowValue,
  type WorkflowValueLocation,
} from "@/features/workflow/workflow-draft"
import { notifyCommandError, notifyError } from "@/lib/notify"

import { OzonConfigSession } from "./supplier-ozon-config-session"
import {
  seedSupplierRowDefaults,
  supplierOzonConfigIO,
  type SupplierOzonConfigData,
  type SupplierOzonConfigIO,
} from "./supplier-ozon-config"

const loadCategorySchema = (request: CategorySchemaRequest) =>
  categorySchemaFlight(request)

/**
 * 挂账写回绑死拍摄时的坐标与 schema：换行 / 换类目之后落盘的仍是编辑发生
 * 的那一行那一版；CAS 基线由会话（session.baseline）在落盘时提供，不进快照。
 */
type PendingRowDefaults = {
  draft: WorkflowCategoryDraft
  schema: CategorySchemaView
  coordinate: { descriptionCategoryId: number; typeId: number }
}

export function SupplierRowDefaults({
  row,
  loadSchema = loadCategorySchema,
  io = supplierOzonConfigIO,
  onNavigate,
  configEpoch = 0,
  onConfigSaved,
}: {
  row: SupplierDbRow
  configEpoch?: number
  onConfigSaved?: () => void
  /** 测试与宿主注入；生产走 `/api/catalog/schema`。 */
  loadSchema?: (request: CategorySchemaRequest) => Promise<CategorySchemaView>
  /** 测试注入；生产走 GET/PUT `…/ozon-config`。 */
  io?: SupplierOzonConfigIO
  /**
   * 类目在当前平台内，媒体在主要信息；宿主负责导航并聚焦。
   */
  onNavigate?: (target: "category" | "media") => void
}) {
  const coordinateReady =
    row.descriptionCategoryId != null && row.typeId != null
  const [schema, setSchema] = useState<CategorySchemaView | undefined>(undefined)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadNonce, setLoadNonce] = useState(0)
  const [config, setConfig] = useState<SupplierOzonConfigData | undefined>(
    undefined,
  )
  const [configFetched, setConfigFetched] = useState(false)
  const [draft, setDraft] = useState<WorkflowCategoryDraft | undefined>(undefined)
  const [phase, setPhase] = useState<DurableAutosavePhase>("idle")

  const savedCallback = useRef(onConfigSaved)
  savedCallback.current = onConfigSaved
  const seenEpoch = useRef(configEpoch)
  const draftRef = useRef<WorkflowCategoryDraft | undefined>(undefined)
  const sentJsonRef = useRef<string | undefined>(undefined)
  const timerRef = useRef<number | undefined>(undefined)
  const loadSchemaRef = useRef(loadSchema)
  loadSchemaRef.current = loadSchema

  /**
   * 一行一次挂载 = 一个会话：行身份（同坐标换行也重建）、回带字段与 CAS
   * 基线都随会话走，已卸下的会话不再碰 UI 相位与新行配置。换坐标也隔离
   * 会话：旧挂账只能拿旧 revision，不能借新配置的 revision 覆写旧坐标。
   */
  const session = useMemo(
    () => new OzonConfigSession(row.sourceId, row.productId, io),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [row.sourceId, row.productId, row.descriptionCategoryId, row.typeId, io],
  )

  /**
   * 写入序列化与「最新编辑赢」相位 —— 与上架方案卡同一个 DurableAutosave。
   * 随会话重建：旧实例只负责在 cleanup 里把挂账落完。409 冲突不在这里拉新
   * 基线 —— 停写、清挂账、让用户重新读取，杜绝盲写覆盖别人刚改的配置。
   */
  const autosave = useMemo(
    () =>
      new DurableAutosave<PendingRowDefaults, SupplierOzonConfigData>(
        async (pending) => {
          try {
            return await session.save(
              pending.draft,
              pending.schema,
              pending.coordinate,
            )
          } catch (reason) {
            if (session.conflicted && !session.disposed) {
              autosave.reset()
              setLoadFailed(true)
              notifyError(
                "Ozon 配置在他处已被修改，自动保存已停 —— 请重新读取后再改",
              )
            } else {
              notifyCommandError(reason, "保存 Ozon 配置失败")
            }
            throw reason
          }
        },
        (saved) => {
          if (session.disposed) return
          setConfig(saved)
          sentJsonRef.current = JSON.stringify(saved.values)
          savedCallback.current?.()
        },
        (next) => {
          if (!session.disposed) setPhase(next)
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session],
  )

  const coordinateKey = coordinateReady
    ? `${row.descriptionCategoryId}:${row.typeId}`
    : ""

  // StrictMode 会重放 effect；每次接管恢复 UI 回调，cleanup 仍落盘旧挂账。
  useEffect(() => {
    session.disposed = false
    return () => {
      session.disposed = true
      if (autosave.hasPendingChanges()) void autosave.flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // 类目 schema 与行配置并行拉：schema 走平台密钥补齐缓存，配置 404 即
  // 「还没有」按空起稿；换行 / 换坐标 / 手动重试即重拉。旧会话的挂账
  // 使用旧 CAS 基线；行写已切换配置坐标时，旧挂账应冲突而不是覆盖新配置。
  useEffect(() => {
    setSchema(undefined)
    setLoadFailed(false)
    setConfig(undefined)
    setConfigFetched(false)
    setDraft(undefined)
    draftRef.current = undefined
    sentJsonRef.current = undefined
    setPhase("idle")
    return () => {
      window.clearTimeout(timerRef.current)
      if (autosave.hasPendingChanges()) void autosave.flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, coordinateKey, loadNonce])

  useEffect(() => {
    if (!coordinateKey) return
    let cancelled = false
    const [descriptionCategoryId, typeId] = coordinateKey.split(":").map(Number)
    const request: CategorySchemaRequest = {
      description_category_id: descriptionCategoryId,
      type_id: typeId,
      language: "zh_hans",
    }
    void loadSchemaRef
      .current(request)
      .then((next) => {
        if (!cancelled && !session.disposed) setSchema(next)
      })
      .catch((reason) => {
        if (cancelled || session.disposed) return
        setLoadFailed(true)
        notifyCommandError(reason, "无法读取类目字段")
      })
    void session
      .load()
      .then((next) => {
        if (cancelled || session.disposed || !next) return
        setConfig(next)
      })
      .catch((reason) => {
        if (cancelled || session.disposed) return
        setLoadFailed(true)
        notifyCommandError(reason, "无法读取 Ozon 配置")
      })
      .finally(() => {
        if (!cancelled && !session.disposed) setConfigFetched(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, coordinateKey, loadNonce])

  // 行 PUT / 提示词 PATCH 可能推进共用的配置 revision：本地干净时跟上基线。
  useEffect(() => {
    void session
      .followRowRevision(row.revision, !autosave.hasPendingChanges())
      .then((reloaded) => {
        if (reloaded && !session.disposed) setConfig(session.baseline)
      })
      .catch((reason) => {
        if (!session.disposed) notifyCommandError(reason, "无法重新读取 Ozon 配置")
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, row.revision])

  // 提示词页的识图开关也写同一配置；本地干净时刷新CAS基线，有草稿则保留。
  useEffect(() => {
    if (seenEpoch.current === configEpoch || autosave.hasPendingChanges() || session.conflicted) return
    seenEpoch.current = configEpoch
    let cancelled = false
    void session.load().then((next) => {
      if (!cancelled && !session.disposed) setConfig(next)
    }).catch((reason) => {
      if (!cancelled && !session.disposed) notifyCommandError(reason, "无法重新读取 Ozon 配置")
    })
    return () => { cancelled = true }
  }, [configEpoch, phase, session, autosave])

  // 编辑初值：schema 与配置都就位后起稿（坐标键重盖到行当前坐标）；外部改写
  // 在本地干净时采纳，本地有未落盘编辑时保留本地（下一次落盘仍是最后写赢）。
  const valuesJson = configFetched
    ? JSON.stringify(config?.values ?? {})
    : ""
  useEffect(() => {
    if (!schema || !coordinateKey || !configFetched) return
    if (valuesJson === sentJsonRef.current) return
    if (autosave.hasPendingChanges()) return
    sentJsonRef.current = valuesJson
    const next = seedSupplierRowDefaults(schema, config?.values, {
      description_category_id: row.descriptionCategoryId!,
      type_id: row.typeId!,
    })
    draftRef.current = next
    setDraft(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, valuesJson, configFetched, coordinateKey])

  function queueEdit(
    mutate: (current: WorkflowCategoryDraft) => WorkflowCategoryDraft,
  ) {
    const current = draftRef.current
    if (!current || !schema) return
    const next = mutate(current)
    draftRef.current = next
    setDraft(next)
    autosave.markDirty({
      draft: next,
      schema,
      coordinate: {
        descriptionCategoryId: row.descriptionCategoryId!,
        typeId: row.typeId!,
      },
    })
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(
      () => void autosave.flush(),
      AUTOSAVE_DEBOUNCE_MS,
    )
  }

  if (!coordinateReady) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2.5"
        data-supplier-row-defaults-empty=""
      >
        <p className="text-meta leading-5 text-muted-foreground">
          先选择 Ozon 类目，字段会随类目变化。
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => {
            if (onNavigate) {
              onNavigate("category")
              return
            }
            const cell = document.querySelector<HTMLElement>(
              "[data-supplier-row-category]",
            )
            cell?.scrollIntoView({ block: "nearest", behavior: "smooth" })
            cell?.querySelector("button")?.focus()
          }}
        >
          去选择类目
        </Button>
      </div>
    )
  }
  if (loadFailed) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2.5"
        data-supplier-row-defaults-error=""
      >
        <p className="text-meta leading-5 text-muted-foreground">
          默认字段暂未读到。
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setLoadNonce((nonce) => nonce + 1)}
        >
          <RefreshCw data-icon="inline-start" aria-hidden />
          重新读取
        </Button>
      </div>
    )
  }
  if (!schema || !configFetched || !draft) {
    return (
      <p className="flex items-center gap-2 text-compact text-faint-foreground">
        <Spinner data-icon="inline-start" />
        正在读取默认字段…
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2" data-supplier-row-defaults="">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={phase === "saving"}
          onClick={() => {
            if (!schema) return
            window.clearTimeout(timerRef.current)
            autosave.markDirty({
              draft,
              schema,
              coordinate: {
                descriptionCategoryId: row.descriptionCategoryId!,
                typeId: row.typeId!,
              },
            })
            void autosave.flush()
          }}
        >
          保存并校验 Ozon 配置
        </Button>
        <span
          className="ml-auto inline-flex items-center"
          role="status"
          aria-live="polite"
        >
          {phase === "error" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void autosave.flush()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden />
              重试保存
            </Button>
          ) : phase === "saving" ? (
            <span className="text-meta text-muted-foreground">保存中…</span>
          ) : phase === "saved" ? (
            <span className="text-meta text-muted-foreground">已自动保存</span>
          ) : phase === "dirty" ? (
            <span className="text-meta text-muted-foreground">待保存…</span>
          ) : null}
        </span>
      </div>
      <SupplierRowDefaultsForm
        schema={schema}
        draft={draft}
        onUpdateValue={(
          fieldKey: string,
          value: WorkflowDraftValue | undefined,
          location: WorkflowValueLocation,
        ) =>
          queueEdit((current) =>
            writeWorkflowValue(current, fieldKey, value, location),
          )
        }
        onAddComplexItem={(complexId) => {
          // 配置模型对一个复杂组只存一份值 —— 多条目没有 wire 槽位。
          if (
            draft.complex_values.some(
              (group) =>
                group.complex_id === complexId && group.items.length >= 1,
            )
          ) {
            notifyError("此字段组只支持一条")
            return
          }
          queueEdit((current) => addComplexItem(current, complexId))
        }}
        onRemoveComplexItem={(complexId, itemIndex) =>
          queueEdit((current) =>
            removeComplexItem(current, complexId, itemIndex),
          )
        }
      />
    </div>
  )
}
