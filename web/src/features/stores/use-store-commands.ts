import type { Dispatch, SetStateAction } from "react"

import type { OzonStoreView } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { shouldOpenAccount } from "@/features/stores/stores-error"
import { isCredentialExpiredAt } from "@/lib/credential-expiry"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

import { loadStoreRoster, rememberStoreRoster, useStoreRoster } from "./store-roster-cache"

export type EditorDraft = {
  id: string;
  label: string;
  clientId: string;
  apiKey: string;
  tagUuids: string[];
  groupUuid: string | null;
};

export type StoreBusyKind = | "load" | "save" | "clear" | "delete" | "test" | "assign" | "grant" | "import" | "export" | "tag" | "group"

type Roster = NonNullable<ReturnType<typeof useStoreRoster>>["overview"]

/**
 * Every roster command: reload, the editor save/clear/delete paths, key
 * testing and grants, membership assignment and activation. The screen owns
 * the state these commands read and write; this hook owns what they do, so a
 * refusal is answered the same way from every entry point.
 */
export function useStoreCommands({
  workspaceId, roster,
  canEditName, canManageTags, tagsChanged, groupChanged, editor, draft, editingId, newTagName, newGroupName,
  actionLock, setBusy, setDraft, setEditingId, setNewTagName, setNewGroupName, setTestingId,
  setSelectedStoreIds, setDeleteCandidateIds, onOpenAccount,
}: {
  workspaceId?: number
  roster?: Roster
  canEditName?: boolean
  canManageTags: boolean
  tagsChanged?: boolean
  groupChanged?: boolean
  editor?: OzonStoreView
  draft?: EditorDraft
  editingId?: string
  newTagName: string
  newGroupName: string
  actionLock: { current: boolean }
  setBusy: Dispatch<SetStateAction<StoreBusyKind | undefined>>
  setDraft: Dispatch<SetStateAction<EditorDraft | undefined>>
  setEditingId: Dispatch<SetStateAction<string | undefined>>
  setNewTagName: Dispatch<SetStateAction<string>>
  setNewGroupName: Dispatch<SetStateAction<string>>
  setTestingId: Dispatch<SetStateAction<string | undefined>>
  setSelectedStoreIds: Dispatch<SetStateAction<Set<string>>>
  setDeleteCandidateIds: Dispatch<SetStateAction<string[] | undefined>>
  onOpenAccount?: () => void
}) {
    async function reload(options?: {
      soft?: boolean;
      force?: boolean;
      refreshQuota?: boolean;
    }) {
      const soft = Boolean(options?.soft);
      if (!soft) {
        setBusy("load");
      }
      try {
        const next = await loadStoreRoster({
          workspaceId,
          force: Boolean(options?.force),
        });
        rememberStoreRoster(next, workspaceId);
        // Opening 店铺 must not spend a lapsed key on Ozon: Cloud refuses the
        // refresh for it anyway, so skip the whole round trip.
        const shouldRefreshQuota =
          options?.refreshQuota !== false &&
          next.stores.some(
            (store) =>
              store.configured &&
              !store.manual_disabled &&
              !store.quota_suspended &&
              !isCredentialExpiredAt(store.key_expires_at_ms) &&
              store.permissions.test_key,
          );
        if (shouldRefreshQuota) {
          try {
            rememberStoreRoster(
              await integrationsHttp.integrationsRefreshStoreProductQuotas(),
              workspaceId,
            );
          } catch {
            // Keep the last painted snapshot when Ozon or Cloud is unavailable.
          }
          // After the quota write, so this roster response keeps both snapshots.
          try {
            rememberStoreRoster(
              await integrationsHttp.integrationsRefreshStoreFinanceBalances(),
              workspaceId,
            );
          } catch {
            // A finance-balance miss must not wipe the quota snapshot just painted.
          }
        }
      } catch (reason) {
        if (!soft) notifyCommandError(reason, "无法读取店铺列表，请稍后重试。");
      } finally {
        if (!soft) setBusy(undefined);
      }
    }

    function openEditor(store: OzonStoreView) {
      setEditingId(store.id);
      setDraft({
        id: store.id,
        label: store.label,
        clientId: store.client_id,
        apiKey: "",
        tagUuids: store.tags?.map((tag) => tag.uuid) ?? [],
        groupUuid: store.group?.uuid ?? null,
      });
    }

    function createStore() {
      setEditingId(undefined);
      setDraft({
        id: "",
        label: "",
        clientId: "",
        apiKey: "",
        tagUuids: [],
        groupUuid: null,
      });
    }

    async function createTag() {
      const name = newTagName.trim();
      if (!name || !draft || actionLock.current) return;
      actionLock.current = true;
      setBusy("tag");
      try {
        const known = new Set((roster?.tags ?? []).map((tag) => tag.uuid));
        const next = await integrationsHttp.integrationsCreateStoreTag({ name });
        rememberStoreRoster(next, workspaceId);
        const created = (next.tags ?? []).find((tag) => !known.has(tag.uuid));
        if (created) {
          // A freshly created tag is almost always meant for the store being
          // edited, so attach it to the draft instead of making the operator
          // hunt for the new chip.
          setDraft((previous) =>
            previous && !previous.tagUuids.includes(created.uuid)
              ? { ...previous, tagUuids: [...previous.tagUuids, created.uuid] }
              : previous,
          );
        }
        setNewTagName("");
        notifySuccess(`标签「${name}」已创建`);
      } catch (reason) {
        notifyCommandError(reason, "无法创建标签，请稍后重试。");
      } finally {
        actionLock.current = false;
        setBusy(undefined);
      }
    }

    async function createGroup() {
      const name = newGroupName.trim();
      if (!name || !draft || actionLock.current) return;
      actionLock.current = true;
      setBusy("group");
      try {
        const known = new Set((roster?.groups ?? []).map((group) => group.uuid));
        const next = await integrationsHttp.integrationsCreateStoreGroup({ name });
        rememberStoreRoster(next, workspaceId);
        const created = (next.groups ?? []).find((group) => !known.has(group.uuid));
        if (created) {
          setDraft((previous) =>
            previous ? { ...previous, groupUuid: created.uuid } : previous,
          );
        }
        setNewGroupName("");
        notifySuccess(`分组「${name}」已创建`);
      } catch (reason) {
        notifyCommandError(reason, "无法创建分组，请稍后重试。");
      } finally {
        actionLock.current = false;
        setBusy(undefined);
      }
    }

    async function saveKey() {
      if (!draft || !draft.label.trim() || actionLock.current) return;
      actionLock.current = true;
      setBusy("save");
      try {
        const isNew = !draft.id;
        const isConfigured = Boolean(editor?.configured);
        const hasKey = Boolean(draft.apiKey.trim());
        const groupSave = Boolean(groupChanged && canManageTags);

        if (
          isNew ||
          (!isConfigured && !(tagsChanged && canManageTags) && !groupSave) ||
          hasKey
        ) {
          // Single submit uses integrationsUpsertOzonStore; integrationsCreateOzonStore remains in the client binding.
          const upserted = await integrationsHttp.integrationsUpsertOzonStore({
            id: draft.id,
            label: draft.label,
            client_id: draft.clientId,
            api_key: draft.apiKey,
          });
          if (
            draft.id &&
            editor &&
            draft.label.trim() !== editor.label &&
            canEditName
          ) {
            const renamed = await integrationsHttp.integrationsRenameOzonStore({
              id: draft.id,
              name: draft.label.trim(),
            });
            rememberStoreRoster(renamed, workspaceId);
          } else {
            rememberStoreRoster(upserted.overview, workspaceId);
          }
          if (tagsChanged && canManageTags) {
            // `store_id` is the exact row upsert touched — adopted or promoted —
            // so tag application never re-derives identity from typed fields.
            rememberStoreRoster(
              await integrationsHttp.integrationsSetStoreTags({
                id: upserted.store_id,
                tag_uuids: draft.tagUuids,
              }),
              workspaceId,
            );
          }
          if (groupSave) {
            rememberStoreRoster(
              await integrationsHttp.integrationsSetStoreGroup({
                id: upserted.store_id,
                group_uuid: draft.groupUuid,
              }),
              workspaceId,
            );
          }
          setEditingId(undefined);
          setDraft(undefined);
          notifySuccess("密钥已验证并加密托管", {
            description: "登录任意设备即可使用；界面不会回显密钥。",
          });
        } else if (
          draft.id &&
          editor &&
          ((draft.label.trim() !== editor.label && canEditName) ||
            (tagsChanged && canManageTags) ||
            groupSave)
        ) {
          const nameChanged = draft.label.trim() !== editor.label && canEditName;
          let next = await integrationsHttp.integrationsListOzonStores();
          if (nameChanged) {
            next = await integrationsHttp.integrationsRenameOzonStore({
              id: draft.id,
              name: draft.label.trim(),
            });
          }
          if (tagsChanged && canManageTags)
            next = await integrationsHttp.integrationsSetStoreTags({
              id: draft.id,
              tag_uuids: draft.tagUuids,
            });
          if (groupSave)
            next = await integrationsHttp.integrationsSetStoreGroup({
              id: draft.id,
              group_uuid: draft.groupUuid,
            });
          rememberStoreRoster(next, workspaceId);
          setEditingId(undefined);
          setDraft(undefined);
          const saved = [
            nameChanged ? "店铺名称" : "",
            tagsChanged && canManageTags ? "标签" : "",
            groupSave ? "分组" : "",
          ].filter(Boolean);
          notifySuccess(
            saved.length > 1 ? `${saved.join("与")}已保存` : `${saved[0]}已保存`,
          );
        }
      } catch (reason) {
        notifyCommandError(reason, "无法保存店铺，请稍后重试。");
      } finally {
        actionLock.current = false;
        setBusy(undefined);
      }
    }

    async function clearStore(id: string) {
      if (actionLock.current) return false;
      actionLock.current = true;
      setBusy("clear");
      try {
        const next = await integrationsHttp.integrationsClearOzonStore({ id });
        rememberStoreRoster(next, workspaceId);
        if (editingId === id) {
          setDraft((current) => (current ? { ...current, apiKey: "" } : current));
        }
        notifySuccess("已清除密钥", {
          description: "Cloud 密文已删除，店铺槽位仍保留。",
        });
        return true;
      } catch (reason) {
        notifyCommandError(reason, "无法清除密钥，请稍后重试。");
        return false;
      } finally {
        actionLock.current = false;
        setBusy(undefined);
      }
    }

    async function deleteStores(ids: string[]) {
      setBusy("delete");
      try {
        for (const id of ids) {
          await integrationsHttp.integrationsDeleteOzonStore({ id });
        }
        setDeleteCandidateIds(undefined);
        setSelectedStoreIds((previous) => {
          const next = new Set(previous);
          for (const id of ids) next.delete(id);
          return next.size === previous.size ? previous : next;
        });
        if (editingId && ids.includes(editingId)) {
          setEditingId(undefined);
          setDraft(undefined);
        }
        await reload({ soft: true, force: true });
        notifySuccess(
          ids.length === 1 ? "已删除店铺" : `已删除 ${ids.length} 家店铺`,
          {
            description: "店铺记录与密钥引用已删除，店铺名额已释放。",
          },
        );
      } catch (reason) {
        notifyCommandError(reason, "无法删除店铺，请稍后重试。");
      } finally {
        setBusy(undefined);
      }
    }

    async function testStores(ids: string[]) {
      setBusy("test");
      try {
        let failed = 0;
        for (const id of ids) {
          try {
            await integrationsHttp.integrationsTestOzonStore({ id });
          } catch {
            failed += 1;
          }
        }
        await reload({ soft: true, force: true, refreshQuota: false });
        notifySuccess(
          failed
            ? `已测试 ${ids.length} 家店铺，${failed} 家验证失败`
            : ids.length === 1
              ? "Ozon API 验证成功 · 已记录验证时间"
              : `已验证 ${ids.length} 家店铺的 Seller 密钥`,
        );
      } finally {
        setBusy(undefined);
      }
    }

    async function assignStore(id: string, membershipId: number | null) {
      setBusy("assign");
      try {
        const next = await integrationsHttp.integrationsAssignOzonStore({
          id,
          membership_id: membershipId,
        });
        rememberStoreRoster(next, workspaceId);
        notifySuccess(membershipId == null ? "店铺已置为未分配" : "店铺已改派");
      } catch (reason) {
        notifyCommandError(reason, "无法改派店铺，请稍后重试。");
      } finally {
        setBusy(undefined);
      }
    }

    async function setKeyGrant(id: string, manage: boolean) {
      setBusy("grant");
      try {
        const roster = await integrationsHttp.integrationsSetStoreKeyGrant({
          id,
          assignee_key_manage: manage,
        });
        rememberStoreRoster(roster, workspaceId);
        notifySuccess(manage ? "已允许指派人管理密钥" : "已关闭指派人的密钥管理");
      } catch (reason) {
        notifyCommandError(reason, "无法更新密钥管理，请稍后重试。");
      } finally {
        setBusy(undefined);
      }
    }

    async function setActive(id: string) {
      try {
        await integrationsHttp.integrationsSetActiveOzonStore({ id });
        await reload({ soft: true, force: true });
      } catch (reason) {
        notifyCommandError(reason, "无法切换当前店铺，请稍后重试。");
      }
    }

    async function testStore(id: string) {
      setBusy("test");
      setTestingId(id);
      try {
        await integrationsHttp.integrationsTestOzonStore({ id });
        await reload({ soft: true, force: true, refreshQuota: false });
        notifySuccess("Ozon API 验证成功 · 已记录验证时间");
      } catch (reason) {
        try {
          const next = await loadStoreRoster({ workspaceId, force: true });
          rememberStoreRoster(next, workspaceId);
        } catch {
          // Keep the painted roster when the follow-up status refresh also fails.
        }
        if (shouldOpenAccount(reason)) {
          onOpenAccount?.();
        }
        notifyCommandError(reason, "Ozon API 验证失败，请按错误提示处理后重试。");
      } finally {
        setBusy(undefined);
        setTestingId(undefined);
      }
    }

  async function refreshFinanceBalances() {
    try {
      rememberStoreRoster(
        await integrationsHttp.integrationsRefreshStoreFinanceBalances(),
        workspaceId,
      );
    } catch (reason) {
      notifyCommandError(reason, "无法读取期末余额，请稍后重试。");
    }
  }

  return {
    reload, refreshFinanceBalances, openEditor, createStore, createTag, createGroup, saveKey, clearStore,
    deleteStores, testStores, assignStore, setKeyGrant, setActive, testStore,
  }
}
