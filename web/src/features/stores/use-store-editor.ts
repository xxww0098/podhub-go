import { useEffect, useRef, useState } from "react"

import type { OzonStoreView, WorkspaceMemberView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"

import { sameTagUuids } from "./store-tags"
import { useStoreRoster } from "./store-roster-cache"
import type { EditorDraft, StoreBusyKind } from "./use-store-commands"

const EMPTY_EDITOR_STORE: OzonStoreView = {
  id: "",
  label: "",
  client_id: "",
  watermark_name: "",
  advertising_client_id: "",
  advertising_configured: false,
  configured: false,
  secret_status: "absent",
  ref_id: "",
  updated_at_ms: 0,
  verified_at_ms: null,
  last_used_at_ms: null,
  key_expires_at_ms: null,
  active: false,
  cloud_store_uuid: null,
  create_order: null,
  cloud_status: null,
  manual_disabled: null,
  quota_suspended: null,
  cloud_revision: null,
  credential_revision: null,
  needs_reentry: false,
  can_manage: false,
  can_edit_credential: false,
  assignee_key_manage: false,
  permissions: {
    manage_store: false,
    edit_name: true,
    manage_key_grants: false,
    test_key: false,
    manage_key: false,
    delete_store: false,
    manage_tags: false,
  },
  tags: [],
};

/**
 * The roster editor: which Store is open, the draft being typed, the batch
 * selection, tag filtering and the permission gates the buttons read. The
 * commands that write with this state live in `use-store-commands`.
 */
export function useStoreEditor({
  workspaceId,
  workspaceRole,
  roster,
  active,
}: {
  workspaceId?: number
  workspaceRole?: string
  active: boolean
  roster?: NonNullable<ReturnType<typeof useStoreRoster>>["overview"]
}) {
  const [busy, setBusy] = useState<StoreBusyKind>();
  const [members, setMembers] = useState<WorkspaceMemberView[]>();
  const [testingId, setTestingId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(
  new Set(),
  );
  const [deleteCandidateIds, setDeleteCandidateIds] = useState<string[]>();
  const [clearCandidateId, setClearCandidateId] = useState<string>();
  const [draft, setDraft] = useState<EditorDraft>();

  const [selectedTagUuids, setSelectedTagUuids] = useState<Set<string>>(
    new Set(),
  );
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [groupsOpen, setGroupsOpen] = useState(false);
  const wasActive = useRef(active);
  const actionLock = useRef(false);

  const stores = roster?.stores ?? [];

  const editing = stores.find((store) => store.id === editingId);
  const editor = editing ?? (draft ? EMPTY_EDITOR_STORE : undefined);
  const editingSecretStatus =
  editor?.secret_status ?? (editor?.configured ? "present" : "absent");
  const deleteCandidates = deleteCandidateIds
  ? stores.filter((store) => deleteCandidateIds.includes(store.id))
  : [];

  const canEditName = editor?.permissions.edit_name ?? Boolean(draft);
  const canManageKey =
  draft && !draft.id ? true : (editor?.permissions.manage_key ?? false);
  const canManageRoster =
  workspaceRole === "owner" || workspaceRole === "manager";
  const canManageTags = draft?.id
  ? (editor?.permissions.manage_tags ?? false)
  : canManageRoster;
  const tagsChanged =
  draft &&
  !sameTagUuids(draft.tagUuids, editor?.tags?.map((tag) => tag.uuid) ?? []);
  const groupChanged = Boolean(
    draft && (draft.groupUuid ?? null) !== (editor?.group?.uuid ?? null),
  );
  // A tags-only save shares the rename gate on identity fields: a typed Client
  // ID or API Key that the save would not carry must never be discarded.
  const identityUntouched = Boolean(
  draft &&
  (!draft.clientId.trim() ||
    draft.clientId.trim() === (editor?.client_id || "")) &&
  !draft.apiKey.trim(),
  );
  const tagsOnlySave = Boolean(
  canManageTags && (tagsChanged || groupChanged) && identityUntouched,
  );

  useEffect(() => {
  const available = new Set((roster?.tags ?? []).map((tag) => tag.uuid));
  setSelectedTagUuids((previous) => {
    const next = new Set([...previous].filter((uuid) => available.has(uuid)));
    return next.size === previous.size ? previous : next;
  });
  }, [roster?.tags]);

  useEffect(() => {
  if (!canManageRoster) {
    setMembers(undefined);
    return;
  }
  let cancelled = false;
  accountHttp
    .accountGetWorkspaceDirectory()
    .then((directory) => {
      if (!cancelled) setMembers(directory.members);
    })
    .catch(() => {
      if (!cancelled) setMembers([]);
    });
  return () => {
    cancelled = true;
  };
  }, [canManageRoster, workspaceId]);

  return {
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
  }
}
