import { integrationOverview, writeIntegrationConfig } from "./integration-config"
/**
 * Integrations HTTP wire: Workspace Stores, AI accounts, object storage and
 * payment-provider config.
 *
 * Screens import `integrationsHttp` directly. Credential planning lives in
 * `./integration-writes`; this file is the Cloud route binding.
 */
import { api, request as apiRequest } from "@/api/client";
import { route } from "@/api/routes";
import { putDirectUpload } from "./direct-upload";
import type { components } from "@/api/schema";
import { accountOverview } from "./http-account";
import {
  applyMediaDelete,
  applyMediaUpsert,
  healthcheckDigest,
  HEALTHCHECK_PNG,
  ozonStoreUpsertKind,
  readActiveStore,
  requireCredentialForIdentity,
  requireRosterStore,
  renameOzonStoreRequest,
  writeActiveStore,
} from "./integration-writes";
import { isCredentialExpiredAt } from "@/lib/credential-expiry";
import { errorMessage } from "@/lib/error-message";
import { refuse } from "./refusal";
import type {
  AccountIdRequest,
  AssignOzonStoreRequest,
  CreateOzonStoreRequest,
  ImportOzonStoresResult,
  ImportOzonStoreResultView,
  MediaPurgeData,
  MediaStorageDeleteData,
  MediaStorageData,
  MediaStorageObjectKind,
  MediaStorageObjectsData,
  MediaStorageRequest,
  MediaStorageUploadTarget,
  SupplierDbStorageDeleteData,
  SupplierDbStorageObjectKind,
  SupplierDbStorageObjectsData,
  SupplierDbStorageUploadTarget,
  AccountOverview,
  OzonStoresOverview,
  OzonStoreView,
  PaymentConfigData,
  ReplacePaymentConfigRequest,
  SellerRelayData,
  SellerRelayProbeData,
  IntegrationMediaRole,
  UpsertMediaAccountRequest,
  UpsertOzonStoreRequest,
} from "./commands";

type IntegrationConfigData = components["schemas"]["IntegrationConfigData"];

type WorkspaceStoreRosterData =
  components["schemas"]["WorkspaceStoreRosterData"];

type WorkspaceStoreData = components["schemas"]["WorkspaceStoreData"];

type WorkspaceStoreView = components["schemas"]["WorkspaceStoreView"];

const INTEGRATION_CONFIG = route("integrationsConfig");

const WORKSPACE_STORES = route("workspacesStores");

function storePath(uuid: string, suffix = ""): string {
  return `${WORKSPACE_STORES}/${encodeURIComponent(uuid)}${suffix}`;
}

/**
 * The active Store is a per-browser preference, so a server-side roster
 * projection never marks one (`OzonStoresOverview.active_id` is always null
 * on the wire). Overlay the browser's pick and let the roster itself correct
 * it: a Store that is gone, disabled or unkeyed is not the active one.
 */
export function withActiveStore(
  roster: OzonStoresOverview,
  workspaceUuid: string | undefined,
): OzonStoresOverview {
  const picked = workspaceUuid ? readActiveStore(workspaceUuid) : null;
  const stores = roster.stores.map((store) => ({
    ...store,
    active:
      store.id === picked &&
      store.cloud_status === "active" &&
      store.configured,
  }));
  return {
    ...roster,
    stores,
    active_id: stores.find((store) => store.active)?.id ?? null,
  };
}

/**
 * The Store list every integrations surface paints.
 *
 * Cloud's roster is the whole truth about a Store: the browser keeps no
 * Secret, so `credentialConfigured` is "configured" and the active pick is a
 * per-browser preference reconciled against this very roster. A tombstone the
 * roster still carries is acknowledged once per read; a failed acknowledgement
 * is retried on the next read.
 */
async function ozonStoresOverview(
  knownOverview?: AccountOverview | null,
): Promise<OzonStoresOverview> {
  const [roster, overview] = await Promise.all([
    api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES),
    knownOverview ? Promise.resolve(knownOverview) : accountOverview(),
  ]);
  for (const tombstone of roster.tombstones ?? []) {
    await api
      .post(storePath(tombstone.uuid, "/tombstone-consumed"))
      .catch(() => undefined);
  }
  const workspace = overview.active_workspace;
  const stores = roster.stores.map((cloud): OzonStoreView => ({
    // Keep legacy fields as projections for older consumers; authorization is
    // driven by the server's explicit permissions object.
    permissions: cloud.permissions,
    id: cloud.uuid,
    label: cloud.name,
    client_id: cloud.client_id ?? "",
    watermark_name: "",
    advertising_client_id: "",
    advertising_configured: false,
    configured: cloud.credential_configured,
    secret_status: cloud.credential_configured ? "present" : "absent",
    ref_id: cloud.uuid,
    updated_at_ms: 0,
    verified_at_ms: cloud.credential_last_verified_at_ms ?? null,
    last_used_at_ms: cloud.credential_last_used_at_ms ?? null,
    key_expires_at_ms: cloud.credential_key_expires_at_ms ?? null,
    active: false,
    cloud_store_uuid: cloud.uuid,
    create_order: cloud.create_order,
    cloud_status: cloud.status,
    manual_disabled: cloud.manual_disabled,
    quota_suspended: cloud.quota_suspended,
    cloud_revision: cloud.revision,
    credential_revision: cloud.credential_revision,
    needs_reentry: false,
    assignee_name: cloud.assignee?.name,
    assignee_membership_id: cloud.assignee?.membership_id,
    assignee_email: cloud.assignee?.email,
    can_manage: cloud.permissions.manage_store,
    can_edit_credential: cloud.permissions.manage_key,
    assignee_key_manage: cloud.assignee_key_manage,
    product_quota: cloud.product_quota ?? null,
    finance_balance: cloud.finance_balance ?? null,
    tags: cloud.tags ?? [],
    group: cloud.group ?? null,
  }));
  return withActiveStore(
    {
      stores,
      active_id: null,
      store_limit: roster.store_limit,
      stores_used: roster.stores_used,
      suspended: roster.suspended,
      tags: roster.tags ?? [],
      groups: roster.groups ?? [],
    },
    workspace?.uuid,
  );
}

/** Verifying or activating a Store needs it live and keyed on Cloud. */
async function executableStore(id: string): Promise<WorkspaceStoreView> {
  const store = requireRosterStore(
    await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES),
    id,
  );
  if (store.status !== "active") {
    throw refuse(
      "workspace_store_unavailable",
      "Store 当前被工作空间停用或受名额限制，不能验证或设为当前",
    );
  }
  if (!store.credential_configured) {
    throw refuse(
      "workspace_store_cloud_credential_missing",
      "Cloud 尚未登记 Seller API Key，请重新输入后再执行",
    );
  }
  // Cloud answers `CREDENTIAL_EXPIRED` (409) on every Ozon exit; refuse here
  // too so a lapsed key never leaves the browser as a fresh test/activation.
  if (isCredentialExpiredAt(store.credential_key_expires_at_ms)) {
    throw refuse(
      "workspace_store_credential_expired",
      "Seller 密钥已过期，请在卖家后台重新生成后登记",
    );
  }
  return store;
}


/** Append the filter pairs an admin table actually set; blanks stay off the URL. */
function filterQuery(filters: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    const text = value?.trim();
    if (text) search.append(key, text);
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const integrationsHttp = {
  integrationsGetCredentials: async () =>
    integrationOverview(
      await api.get<IntegrationConfigData>(INTEGRATION_CONFIG),
    ),
  integrationsGetPaymentConfig: () =>
    api.get<PaymentConfigData>(route("adminPaymentConfig")),
  integrationsReplacePaymentConfig: (request: ReplacePaymentConfigRequest) =>
    api.put<PaymentConfigData>(route("adminPaymentConfig"), request),
  integrationsGetSellerRelay: () =>
    api.get<SellerRelayData>(route("adminSellerRelay")),
  integrationsImportSellerRelayNodes: (links: string) =>
    api.post<SellerRelayData>(route("adminSellerRelayNodes"), { links }),
  integrationsSwitchSellerRelay: (nodeId: string | null) =>
    api.put<SellerRelayData>(route("adminSellerRelayActive"), { nodeId }),
  integrationsDeleteSellerRelayNode: (nodeId: string) =>
    api.del<SellerRelayData>(
      route("adminSellerRelayNodesByNodeId", { node_id: nodeId }),
    ),
  integrationsProbeSellerRelay: () =>
    api.post<SellerRelayProbeData>(route("adminSellerRelayProbe")),
  integrationsListOzonStores: ozonStoresOverview,
  integrationsCreateOzonStore: async (request: CreateOzonStoreRequest) => {
    const created = await api.post<WorkspaceStoreData>(WORKSPACE_STORES, {
      name: request.label.trim(),
    });
    return { id: created.store.uuid, roster: await ozonStoresOverview() };
  },
  integrationsUpsertOzonStore: async (request: UpsertOzonStoreRequest) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const clientId = request.client_id.trim();
    const name = request.label.trim();
    const decision = ozonStoreUpsertKind(request.id, clientId, roster);
    // A Store minted for this save must not keep a quota slot when the
    // credential it was minted for never registers.
    let minted: WorkspaceStoreView | null = null;
    let store: WorkspaceStoreView;
    if (decision.kind === "promote") {
      store = (
        await api.post<WorkspaceStoreData>(WORKSPACE_STORES, {
          name: name || "新店铺",
        })
      ).store;
      minted = store;
    } else {
      store = requireRosterStore(roster, decision.uuid);
    }
    try {
      const apiKey = request.api_key.trim();
      requireCredentialForIdentity({
        identityChanged: clientId.length > 0 && store.client_id !== clientId,
        apiKey,
        credentialConfigured: store.credential_configured,
      });
      if (apiKey.length > 0) {
        await api.post(storePath(store.uuid, "/credential"), {
          client_id: clientId,
          api_key: apiKey,
          confirm_upload: true,
          expected_store_revision: store.revision,
          expected_credential_revision: store.credential_configured
            ? store.credential_revision
            : null,
        });
      } else if (!store.client_id) {
        throw refuse(
          "workspace_store_identity_incomplete",
          "Store 的 Client ID 尚未配置",
        );
      }
    } catch (reason) {
      if (minted) {
        await apiRequest("DELETE", storePath(minted.uuid), {
          revision: minted.revision,
        }).catch(() => undefined);
      }
      throw reason;
    }
    // `store.uuid` is the exact row the save touched — promoted or adopted — so
    // callers attaching tags afterwards never have to re-derive it from a
    // name/Client-ID match.
    return { overview: await ozonStoresOverview(), store_id: store.uuid };
  },
  /**
   * One paste row per Store: create the row, then register the Seller key on
   * the credential route — the same pair `integrationsUpsertOzonStore` runs.
   * A Client ID the roster already carries adopts that Store and rotates its
   * key instead of spending a second quota slot. A Store minted for a line
   * whose key is refused is deleted again, and the line keeps its own failure
   * rather than aborting the batch.
   *
   * `tag_names` are the `#标签` tokens parsed from the line: absent leaves the
   * Store's tags alone, a present list replaces the set. Names resolve
   * case-insensitively against the tag library and missing ones are minted up
   * front — a line whose tag cannot be created fails before any credential
   * write, and a line whose tags cannot be applied fails with the key already
   * registered, so retrying the same text is always safe.
   */
  integrationsImportOzonStores: async (request: {
    items: Array<{
      source_ref: string;
      name: string;
      client_id: string;
      api_key: string;
      tag_names?: string[];
    }>;
  }): Promise<ImportOzonStoresResult> => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const stores = [...roster.stores];
    const results: ImportOzonStoreResultView[] = [];
    const tagUuidByName = new Map(
      (roster.tags ?? []).map((tag) => [tag.name.toLowerCase(), tag.uuid]),
    );
    const wantedTags = new Map<string, string>();
    for (const item of request.items) {
      for (const tag of item.tag_names ?? []) {
        const key = tag.toLowerCase();
        if (!tagUuidByName.has(key)) wantedTags.set(key, tag);
      }
    }
    const tagErrors = new Map<string, string>();
    for (const [key, tag] of wantedTags) {
      try {
        const created = await api.post<
          components["schemas"]["WorkspaceStoreTagData"]
        >(route("workspacesStoresTags"), { name: tag });
        tagUuidByName.set(key, created.tag.uuid);
      } catch (reason) {
        tagErrors.set(key, errorMessage(reason, "无法创建标签"));
      }
    }
    for (const item of request.items) {
      const name = item.name.trim() || "新店铺";
      const clientId = item.client_id.trim();
      const apiKey = item.api_key.trim();
      const failedTag = (item.tag_names ?? []).find((tag) =>
        tagErrors.has(tag.toLowerCase()),
      );
      if (failedTag !== undefined) {
        results.push({
          source_ref: item.source_ref,
          name,
          status: "failed",
          uuid: null,
          quota_suspended: false,
          reason: `标签「${failedTag}」未能创建：${tagErrors.get(failedTag.toLowerCase())}`,
        });
        continue;
      }
      let store = stores.find((row) => row.client_id === clientId);
      let minted: WorkspaceStoreView | null = null;
      try {
        if (!store) {
          store = (
            await api.post<WorkspaceStoreData>(WORKSPACE_STORES, {
              name,
              client_id: clientId,
            })
          ).store;
          minted = store;
          stores.push(store);
        }
        const registered = await api.post<
          components["schemas"]["RegisterWorkspaceStoreCredentialData"]
        >(storePath(store.uuid, "/credential"), {
          client_id: clientId,
          api_key: apiKey,
          confirm_upload: true,
          expected_store_revision: store.revision,
          expected_credential_revision: store.credential_configured
            ? store.credential_revision
            : null,
        });
        // Keep the mirror current so a repeated Client ID later in the same
        // batch adopts this Store instead of minting another.
        store.client_id = clientId;
        store.credential_configured = true;
        store.revision = registered.revision;
        store.credential_revision = registered.credential_revision;
      } catch (reason) {
        if (minted) {
          await apiRequest("DELETE", storePath(minted.uuid), {
            revision: minted.revision,
          }).catch(() => undefined);
          const index = stores.indexOf(minted);
          if (index >= 0) stores.splice(index, 1);
        }
        results.push({
          source_ref: item.source_ref,
          name,
          status: "failed",
          uuid: minted ? null : (store?.uuid ?? null),
          quota_suspended: store?.quota_suspended ?? false,
          reason: errorMessage(reason, "导入失败"),
        });
        continue;
      }
      // Tags apply only after the key is in — a refused key never takes tags
      // with it. A fresh mint with an empty list has nothing to clear.
      if (
        item.tag_names !== undefined &&
        !(minted && item.tag_names.length === 0)
      ) {
        try {
          const updated = await api.put<WorkspaceStoreData>(
            storePath(store.uuid),
            {
              tag_uuids: item.tag_names.map((tag) =>
                tagUuidByName.get(tag.toLowerCase())!,
              ),
              revision: store.revision,
            },
          );
          store.revision = updated.store.revision;
        } catch (reason) {
          results.push({
            source_ref: item.source_ref,
            name,
            status: "failed",
            uuid: store.uuid,
            quota_suspended: store.quota_suspended,
            reason: `密钥已登记，但标签未能应用：${errorMessage(reason, "标签写入失败")}`,
          });
          continue;
        }
      }
      results.push({
        source_ref: item.source_ref,
        name,
        status: minted ? "created" : "updated",
        uuid: store.uuid,
        quota_suspended: store.quota_suspended,
        reason: null,
      });
    }
    return { results, overview: await ozonStoresOverview() };
  },
  /**
   * The plaintext counterpart of the import: Cloud answers every keyed Store
   * the operator may manage keys for. This is the only route where a key
   * travels back to the browser.
   */
  integrationsExportOzonStores: () =>
    api.post<components["schemas"]["ExportWorkspaceStoreCredentialsData"]>(
      route("workspacesStoresCredentialsExport"),
    ),
  integrationsRenameOzonStore: async (request: {
    id: string;
    name: string;
  }) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const store = requireRosterStore(roster, request.id);
    await api.put<WorkspaceStoreData>(
      storePath(store.uuid),
      renameOzonStoreRequest(request.name, store.revision),
    );
    return ozonStoresOverview();
  },
  integrationsCreateStoreTag: async (request: { name: string }) => {
    await api.post(route("workspacesStoresTags"), { name: request.name });
    return ozonStoresOverview();
  },
  integrationsRenameStoreTag: async (request: {
    uuid: string;
    name: string;
  }) => {
    await api.put(route("workspacesStoresTagsByUuid", { uuid: request.uuid }), {
      name: request.name,
    });
    return ozonStoresOverview();
  },
  integrationsDeleteStoreTag: async (request: { uuid: string }) => {
    await apiRequest(
      "DELETE",
      route("workspacesStoresTagsByUuid", { uuid: request.uuid }),
    );
    return ozonStoresOverview();
  },
  integrationsCreateStoreGroup: async (request: { name: string }) => {
    await api.post(route("workspacesStoresGroups"), { name: request.name });
    return ozonStoresOverview();
  },
  integrationsRenameStoreGroup: async (request: {
    uuid: string;
    name: string;
  }) => {
    await api.put(route("workspacesStoresGroupsByUuid", { uuid: request.uuid }), {
      name: request.name,
    });
    return ozonStoresOverview();
  },
  integrationsDeleteStoreGroup: async (request: { uuid: string }) => {
    await apiRequest(
      "DELETE",
      route("workspacesStoresGroupsByUuid", { uuid: request.uuid }),
    );
    return ozonStoresOverview();
  },
  integrationsSetStoreTags: async (request: {
    id: string;
    tag_uuids: string[];
  }) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const store = requireRosterStore(roster, request.id);
    await api.put<WorkspaceStoreData>(storePath(store.uuid), {
      tag_uuids: request.tag_uuids,
      revision: store.revision,
    });
    return ozonStoresOverview();
  },
  integrationsSetStoreGroup: async (request: {
    id: string;
    group_uuid: string | null;
  }) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const store = requireRosterStore(roster, request.id);
    await api.put<WorkspaceStoreData>(storePath(store.uuid), {
      group_uuid: request.group_uuid ?? "",
      revision: store.revision,
    });
    return ozonStoresOverview();
  },
  integrationsClearOzonStore: async (request: AccountIdRequest) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const store = requireRosterStore(roster, request.id);
    await apiRequest("DELETE", storePath(store.uuid, "/credential"), {
      expected_store_revision: store.revision,
      expected_credential_revision: store.credential_revision,
    });
    return ozonStoresOverview();
  },
  integrationsDeleteOzonStore: async (request: AccountIdRequest) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const store = requireRosterStore(roster, request.id);
    await apiRequest("DELETE", storePath(store.uuid), {
      revision: store.revision,
    });
    return ozonStoresOverview();
  },
  /** Reassign a Store; `membership_id: null` makes it unassigned. Owner / Manager only. */
  /** Reassign a Store; `membership_id: null` makes it unassigned. Owner / Manager only. */
  integrationsAssignOzonStore: async (request: AssignOzonStoreRequest) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const store = requireRosterStore(roster, request.id);
    await api.post<WorkspaceStoreData>(storePath(store.uuid, "/assignee"), {
      assigneeMembershipId: request.membership_id,
      revision: store.revision,
    });
    return ozonStoresOverview();
  },
  integrationsSetStoreKeyGrant: async (request: {
    id: string;
    assignee_key_manage: boolean;
  }) => {
    const roster = await api.get<WorkspaceStoreRosterData>(WORKSPACE_STORES);
    const store = requireRosterStore(roster, request.id);
    await api.put<WorkspaceStoreData>(storePath(store.uuid), {
      assigneeKeyManage: request.assignee_key_manage,
      revision: store.revision,
    });
    return ozonStoresOverview();
  },
  integrationsSetActiveOzonStore: async (request: AccountIdRequest) => {
    const store = await executableStore(request.id);
    const workspace = (await accountOverview()).active_workspace;
    if (!workspace)
      throw refuse(
        "workspace_store_not_found",
        "目标 Store 不属于当前 Active Workspace",
      );
    writeActiveStore(workspace.uuid, store.uuid);
    return ozonStoresOverview();
  },
  integrationsTestOzonStore: async (request: AccountIdRequest) => {
    const store = await executableStore(request.id);
    await api.post(storePath(store.uuid, "/credential/test"));
    return ozonStoresOverview();
  },
  integrationsRefreshStoreProductQuotas: async () => {
    await api.post(`${WORKSPACE_STORES}/product-quotas/refresh`);
    return ozonStoresOverview();
  },
  integrationsRefreshStoreFinanceBalances: async () => {
    await api.post(route("workspacesStoresFinanceBalancesRefresh"));
    return ozonStoresOverview();
  },
  integrationsUpsertMediaAccount: async (upsert: UpsertMediaAccountRequest) => {
    const snapshot = await api.get<IntegrationConfigData>(INTEGRATION_CONFIG);
    const { config, credential } = applyMediaUpsert(snapshot, upsert);
    return writeIntegrationConfig(config, undefined, credential);
  },
  integrationsTestMediaAccount: async (target: AccountIdRequest & { workspaceUuid: string }) => {
    const accountId = target.id.trim();
    if (accountId.length === 0)
      throw refuse("integration_media_invalid", "对象存储账号不存在");
    // Snapshot the caller's scope before any await so this upload cannot drift.
    const workspaceUuid = target.workspaceUuid.trim();
    if (!workspaceUuid)
      throw refuse("media_connection_test_failed", "请先选择工作空间再测试对象存储");
    // Cloud recognises this one digest as a connection test rather than as
    // seller media, so the probe is neither billed nor collected.
    const object = route("mediaObjectsByDigestByExtensionPresign", {
      digest: await healthcheckDigest(),
      extension: "png",
    }).slice(0, -"/presign".length);
    const query = `?accountId=${encodeURIComponent(accountId)}`;
    const startedAt = performance.now();
    const probe = await api.post<components["schemas"]["MediaObjectProbeData"]>(
      `${object}/probe${query}`,
    );
    if (!probe.exists) {
      const prepared = await api.post<components["schemas"]["MediaObjectPresignData"]>(`${object}/presign`,
        { account_id: accountId, workspace_uuid: workspaceUuid, byte_length: HEALTHCHECK_PNG.byteLength } satisfies components["schemas"]["MediaObjectPresignRequest"]);
      if (prepared.transport === "direct") {
        if (!prepared.upload || !prepared.upload_ticket) throw refuse("media_connection_test_failed", "对象存储未返回上传授权");
        try { await putDirectUpload(prepared.upload, HEALTHCHECK_PNG, { expectedByteLength: HEALTHCHECK_PNG.byteLength }); }
        catch (reason) { if (!(reason as { outcomeUnknown?: boolean }).outcomeUnknown) throw reason; }
        await api.post(`${object}/complete`, { account_id: prepared.account_id, object_key: prepared.object_key,
          workspace_uuid: workspaceUuid, byte_length: HEALTHCHECK_PNG.byteLength,
          storage_revision: prepared.storage_revision, upload_ticket: prepared.upload_ticket } satisfies components["schemas"]["MediaObjectCompleteRequest"]);
      }
    }
    return { latency_ms: Math.round(performance.now() - startedAt) };
  },
  integrationsDeleteMediaAccount: async (target: { role: IntegrationMediaRole }) =>
    writeIntegrationConfig(
      applyMediaDelete(
        await api.get<IntegrationConfigData>(INTEGRATION_CONFIG),
        target.role,
      ),
    ),
  integrationsMediaStorage: (storage: MediaStorageRequest) =>
    api.get<MediaStorageData>(
      `${route("adminMediaStorage")}${filterQuery({ accountId: storage.id, prefix: storage.prefix })}`,
    ),
  integrationsPurgeMedia: async (storage: MediaStorageRequest) => {
    const prefix = storage.prefix.trim();
    if (prefix.length === 0)
      throw refuse("media_purge_invalid", "请先输入要清理的前缀");
    return api.post<MediaPurgeData>(route("adminMediaPurge"), {
      accountId: storage.id,
      prefix,
    });
  },
  mediaStorageObjects: (accountId: string, prefix = "", cursor?: string) =>
    api.get<MediaStorageObjectsData>(
      `${route("adminMediaObjects")}${filterQuery({ accountId, prefix, cursor })}`,
    ),
  createMediaStorageDirectory: (accountId: string, path: string) =>
    api.post<{ accountId: string; path: string }>(
      route("adminMediaDirectories"),
      {
        accountId,
        path,
      },
    ),
  presignMediaStorageUpload: async (
    accountId: string,
    file: File,
    path: string,
  ) =>
    (
      await api.post<{ upload: MediaStorageUploadTarget }>(
        route("adminMediaUploads"),
        {
          accountId,
          path,
          contentType: file.type || "application/octet-stream",
          bytes: file.size,
        },
      )
    ).upload,
  moveMediaStorageObject: (
    accountId: string,
    sourcePath: string,
    destinationPath: string,
    kind: MediaStorageObjectKind,
  ) =>
    api.post<{
      accountId: string;
      sourcePath: string;
      destinationPath: string;
    }>(route("adminMediaObjectsMove"), {
      accountId,
      sourcePath,
      destinationPath,
      kind,
    }),
  deleteMediaStorageObject: (
    accountId: string,
    path: string,
    kind: MediaStorageObjectKind,
  ) =>
    api.post<MediaStorageDeleteData>(route("adminMediaObjectsDelete"), {
      accountId,
      path,
      kind,
    }),
  supplierDbStorageObjects: (prefix = "", cursor?: string) =>
    api.get<SupplierDbStorageObjectsData>(
      `${route("adminSupplierDbStorageObjects")}${filterQuery({ prefix, cursor })}`,
    ),
  createSupplierDbStorageDirectory: (path: string) =>
    api.post<{ path: string }>(route("adminSupplierDbStorageDirectories"), {
      path,
    }),
  presignSupplierDbStorageUpload: async (file: File, path: string) =>
    (
      await api.post<{ upload: SupplierDbStorageUploadTarget }>(
        route("adminSupplierDbStorageUploads"),
        {
          path,
          contentType: file.type || "application/octet-stream",
          bytes: file.size,
        },
      )
    ).upload,
  moveSupplierDbStorageObject: (
    sourcePath: string,
    destinationPath: string,
    kind: SupplierDbStorageObjectKind,
  ) =>
    api.post<{ sourcePath: string; destinationPath: string }>(
      route("adminSupplierDbStorageObjectsMove"),
      { sourcePath, destinationPath, kind },
    ),
  deleteSupplierDbStorageObject: (
    path: string,
    kind: SupplierDbStorageObjectKind,
  ) =>
    api.post<SupplierDbStorageDeleteData>(
      route("adminSupplierDbStorageObjectsDelete"),
      {
        path,
        kind,
      },
    ),
};
