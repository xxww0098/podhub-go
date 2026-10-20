//! Draft ownership and explicit Candidate Edits. No persistence or clock.

use crate::{
    CategorySchemaView, WorkflowAiCandidate, WorkflowAiCandidateState, WorkflowAiFieldPolicy,
    WorkflowCategoryDraft, WorkflowDraftValue,
};

use super::envelope::{RowAi, RowPayload};
use super::records::{FieldAddress, FieldValueOrigin, FieldValueOriginKind};

pub const SOURCE_REVIEW: &str = "source_changed";

/// Mint a stable complex-item id from caller-supplied randomness.
///
/// This crate targets `wasm32-unknown-unknown` and may not depend on
/// `getrandom` (transitively pulled in by `uuid`'s `v4` feature, which needs
/// host RNG glue `wasm32-unknown-unknown` does not provide). The caller —
/// Cloud, or the browser host through `listing-core-wasm`'s
/// `env.fill_random` — is the one place that may own an RNG;
/// this function only formats the 16 bytes it is handed the same way
/// `uuid::Uuid::new_v4().simple()` always has (lowercase hex, no dashes), so
/// existing item ids stay valid.
pub fn mint_item_id(random_bytes: [u8; 16]) -> String {
    format!("ci_{}", uuid::Uuid::from_bytes(random_bytes).simple())
}

/// `item_{n}` and `workflow-{group}-{n}` are the retired index forms.
pub fn is_legacy_item_id(item_id: &str) -> bool {
    if let Some(rest) = item_id.strip_prefix("item_") {
        return !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit());
    }
    let Some(rest) = item_id.strip_prefix("workflow-") else {
        return false;
    };
    let Some((_, index)) = rest.rsplit_once('-') else {
        return false;
    };
    !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()) && rest.len() > index.len()
}

pub fn is_stable_item_id(item_id: &str) -> bool {
    !item_id.is_empty() && !is_legacy_item_id(item_id)
}

fn legacy_item_index(group_key: &str, item_id: &str) -> Option<usize> {
    if let Some(rest) = item_id.strip_prefix("item_")
        && !rest.is_empty()
        && rest.bytes().all(|byte| byte.is_ascii_digit())
    {
        return rest.parse().ok();
    }
    let prefix = format!("workflow-{group_key}-");
    let rest = item_id.strip_prefix(&prefix)?;
    if rest.is_empty() || !rest.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    rest.parse().ok()
}

pub fn field_key(address: &FieldAddress) -> &str {
    match address {
        FieldAddress::Plain { field_key } | FieldAddress::Complex { field_key, .. } => field_key,
    }
}

/// A complex address is an edit target only when it names a stored `item_id`.
/// Index forms and list splices are not a second read path.
pub fn candidate_address(address: &FieldAddress) -> Option<FieldAddress> {
    if let FieldAddress::Complex {
        item_id,
        value_index,
        ..
    } = address
    {
        if value_index.is_some() || !is_stable_item_id(item_id) {
            return None;
        }
    }
    Some(address.clone())
}

fn complex_item<'a>(
    draft: &'a super::WorkflowCategoryDraft,
    group_key: &str,
    item_id: &str,
) -> Option<&'a super::WorkflowComplexDraftItem> {
    let group_id = group_key.parse::<i64>().ok()?;
    draft
        .complex_values
        .iter()
        .find(|group| group.complex_id == group_id)?
        .items
        .iter()
        .find(|item| item.item_id == item_id)
}

fn complex_item_mut<'a>(
    draft: &'a mut super::WorkflowCategoryDraft,
    group_key: &str,
    item_id: &str,
) -> Option<&'a mut super::WorkflowComplexDraftItem> {
    let group_id = group_key.parse::<i64>().ok()?;
    draft
        .complex_values
        .iter_mut()
        .find(|group| group.complex_id == group_id)?
        .items
        .iter_mut()
        .find(|item| item.item_id == item_id)
}

pub fn value_at<'a>(
    draft: &'a WorkflowCategoryDraft,
    address: &FieldAddress,
) -> Option<&'a WorkflowDraftValue> {
    match address {
        FieldAddress::Plain { field_key } => draft.values.get(field_key),
        FieldAddress::Complex {
            group_key,
            item_id,
            field_key,
            value_index: None,
        } => complex_item(draft, group_key, item_id)?
            .values
            .get(field_key),
        _ => None,
    }
}

pub fn write_value(
    draft: &mut WorkflowCategoryDraft,
    address: &FieldAddress,
    value: Option<WorkflowDraftValue>,
) -> bool {
    let values = match address {
        FieldAddress::Plain { .. } => &mut draft.values,
        FieldAddress::Complex {
            group_key,
            item_id,
            value_index: None,
            ..
        } => {
            let Some(item) = complex_item_mut(draft, group_key, item_id) else {
                return false;
            };
            &mut item.values
        }
        _ => return false,
    };
    if let Some(value) = value {
        let key = field_key(address).to_owned();
        values.insert(key.clone(), value);
        if matches!(address, FieldAddress::Plain { .. }) {
            draft.cleared.remove(&key);
        }
    } else {
        values.remove(field_key(address));
    }
    true
}

pub fn has_content(value: Option<&WorkflowDraftValue>) -> bool {
    match value {
        None => false,
        Some(WorkflowDraftValue::Text(v) | WorkflowDraftValue::Url(v)) => !v.trim().is_empty(),
        Some(WorkflowDraftValue::TextList(v) | WorkflowDraftValue::UrlList(v)) => {
            v.iter().any(|v| !v.trim().is_empty())
        }
        Some(WorkflowDraftValue::IntegerList(v)) => !v.is_empty(),
        Some(WorkflowDraftValue::DecimalList(v)) => !v.is_empty(),
        Some(WorkflowDraftValue::BooleanList(v)) => !v.is_empty(),
        Some(WorkflowDraftValue::MultiSelect(v)) => !v.is_empty(),
        Some(WorkflowDraftValue::SingleSelect(v)) => {
            v.dictionary_value_id != 0 || !v.value.trim().is_empty()
        }
        Some(_) => true,
    }
}

pub fn addresses(draft: &WorkflowCategoryDraft) -> Vec<FieldAddress> {
    let mut addresses: Vec<_> = draft
        .values
        .keys()
        .map(|key| FieldAddress::Plain {
            field_key: key.clone(),
        })
        .collect();
    for group in &draft.complex_values {
        for item in group
            .items
            .iter()
            .filter(|item| is_stable_item_id(&item.item_id))
        {
            addresses.extend(item.values.keys().map(|key| FieldAddress::Complex {
                group_key: group.complex_id.to_string(),
                item_id: item.item_id.clone(),
                field_key: key.clone(),
                value_index: None,
            }));
        }
    }
    addresses
}

/// Give every content item a stable id. Placeholders stay id-less.
/// This is the save path: a new item beside already-identified items is not a
/// mixed stored row.
///
/// `random_source` is called once per minted id (a draft can need more than
/// one in a single save) — see [`mint_item_id`] for why this crate cannot
/// generate that randomness itself.
pub fn ensure_complex_item_ids(
    draft: &mut super::WorkflowCategoryDraft,
    random_source: &mut dyn FnMut() -> [u8; 16],
) {
    for group in &mut draft.complex_values {
        for item in &mut group.items {
            if item.values.is_empty() {
                item.item_id.clear();
                continue;
            }
            if !is_stable_item_id(&item.item_id) {
                item.item_id = mint_item_id(random_source());
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemIdMigration {
    Unchanged,
    Rewritten,
}

#[derive(Debug)]
pub struct MixedComplexItems;

/// One in-memory rewrite of a stored row. Already-stable ids are kept.
/// A row that is only partly migrated is [`MixedComplexItems`] and must not be
/// treated as done. See [`ensure_complex_item_ids`] for `random_source`.
pub fn rewrite_complex_item_ids(
    payload: &mut RowPayload,
    random_source: &mut dyn FnMut() -> [u8; 16],
) -> Result<ItemIdMigration, MixedComplexItems> {
    let mut working = payload.clone();
    let outcome = rewrite_complex_item_ids_in_place(&mut working, random_source)?;
    if outcome == ItemIdMigration::Rewritten {
        *payload = working;
    }
    Ok(outcome)
}

fn rewrite_complex_item_ids_in_place(
    payload: &mut RowPayload,
    random_source: &mut dyn FnMut() -> [u8; 16],
) -> Result<ItemIdMigration, MixedComplexItems> {
    let mut content_stable = false;
    let mut content_needs_id = false;
    for group in &payload.draft.complex_values {
        for item in group.items.iter().filter(|item| !item.values.is_empty()) {
            if is_stable_item_id(&item.item_id) {
                content_stable = true;
            } else {
                content_needs_id = true;
            }
        }
    }
    if content_stable && content_needs_id {
        return Err(MixedComplexItems);
    }
    if content_stable && complex_addresses_are_legacy(payload) {
        return Err(MixedComplexItems);
    }
    if !content_needs_id {
        let stripped = strip_idless_placeholders(&mut payload.draft);
        if complex_addresses_are_legacy(payload) {
            return Err(MixedComplexItems);
        }
        return Ok(if stripped {
            ItemIdMigration::Rewritten
        } else {
            ItemIdMigration::Unchanged
        });
    }
    if complex_addresses_are_stable(payload) {
        return Err(MixedComplexItems);
    }

    let mut index_to_id = std::collections::BTreeMap::<i64, Vec<Option<String>>>::new();
    for group in &mut payload.draft.complex_values {
        let mut assigned = Vec::with_capacity(group.items.len());
        let mut kept = Vec::new();
        for item in group.items.drain(..) {
            if item.values.is_empty() {
                assigned.push(None);
                continue;
            }
            let mut item = item;
            if !is_stable_item_id(&item.item_id) {
                item.item_id = mint_item_id(random_source());
            }
            assigned.push(Some(item.item_id.clone()));
            kept.push(item);
        }
        group.items = kept;
        index_to_id.insert(group.complex_id, assigned);
    }
    rewrite_stored_addresses(payload, &index_to_id)?;
    Ok(ItemIdMigration::Rewritten)
}

fn strip_idless_placeholders(draft: &mut super::WorkflowCategoryDraft) -> bool {
    let mut changed = false;
    for group in &mut draft.complex_values {
        let before = group.items.len();
        group.items.retain(|item| !item.values.is_empty());
        changed |= group.items.len() != before;
    }
    let before = draft.complex_values.len();
    draft.complex_values.retain(|group| !group.items.is_empty());
    changed || draft.complex_values.len() != before
}

fn complex_addresses_are_legacy(payload: &RowPayload) -> bool {
    stored_complex_ids(payload).any(|item_id| !is_stable_item_id(item_id))
}

fn complex_addresses_are_stable(payload: &RowPayload) -> bool {
    stored_complex_ids(payload).any(|item_id| is_stable_item_id(item_id))
}

fn stored_complex_ids(payload: &RowPayload) -> impl Iterator<Item = &str> {
    let origins = payload
        .field_origins
        .iter()
        .filter_map(|origin| match &origin.address {
            FieldAddress::Complex { item_id, .. } => Some(item_id.as_str()),
            FieldAddress::Plain { .. } => None,
        });
    let candidates =
        payload
            .ai
            .candidates
            .iter()
            .filter_map(|candidate| match &candidate.address {
                FieldAddress::Complex { item_id, .. } => Some(item_id.as_str()),
                FieldAddress::Plain { .. } => None,
            });
    let issues = payload
        .validation_issues
        .iter()
        .filter_map(|issue| match &issue.address {
            FieldAddress::Complex { item_id, .. } => Some(item_id.as_str()),
            FieldAddress::Plain { .. } => None,
        });
    origins.chain(candidates).chain(issues)
}

fn rewrite_stored_addresses(
    payload: &mut RowPayload,
    index_to_id: &std::collections::BTreeMap<i64, Vec<Option<String>>>,
) -> Result<(), MixedComplexItems> {
    let mut origins = Vec::new();
    for mut origin in payload.field_origins.drain(..) {
        match retarget(&mut origin.address, index_to_id)? {
            AddressRewrite::Keep | AddressRewrite::Retargeted => origins.push(origin),
            AddressRewrite::Drop => {}
        }
    }
    payload.field_origins = origins;

    let mut candidates = Vec::new();
    for mut candidate in payload.ai.candidates.drain(..) {
        match retarget(&mut candidate.address, index_to_id)? {
            AddressRewrite::Keep | AddressRewrite::Retargeted => candidates.push(candidate),
            AddressRewrite::Drop => {}
        }
    }
    payload.ai.candidates = candidates;

    let mut issues = Vec::new();
    for mut issue in payload.validation_issues.drain(..) {
        match retarget(&mut issue.address, index_to_id)? {
            AddressRewrite::Keep | AddressRewrite::Retargeted => issues.push(issue),
            AddressRewrite::Drop => {}
        }
    }
    payload.validation_issues = issues;
    Ok(())
}

enum AddressRewrite {
    Keep,
    Retargeted,
    Drop,
}

fn retarget(
    address: &mut FieldAddress,
    index_to_id: &std::collections::BTreeMap<i64, Vec<Option<String>>>,
) -> Result<AddressRewrite, MixedComplexItems> {
    let FieldAddress::Complex {
        group_key, item_id, ..
    } = address
    else {
        return Ok(AddressRewrite::Keep);
    };
    if is_stable_item_id(item_id) {
        return Ok(AddressRewrite::Keep);
    }
    let index = legacy_item_index(group_key, item_id).ok_or(MixedComplexItems)?;
    let group_id = group_key.parse::<i64>().map_err(|_| MixedComplexItems)?;
    match index_to_id.get(&group_id).and_then(|ids| ids.get(index)) {
        Some(Some(id)) => {
            *item_id = id.clone();
            Ok(AddressRewrite::Retargeted)
        }
        Some(None) => Ok(AddressRewrite::Drop),
        None => Err(MixedComplexItems),
    }
}

pub fn is_manual(payload: &RowPayload, address: &FieldAddress) -> bool {
    (matches!(address, FieldAddress::Plain { .. })
        && payload.hand_edited_keys.contains(field_key(address)))
        || payload
            .field_origins
            .iter()
            .any(|origin| origin.address == *address && origin.kind == FieldValueOriginKind::Manual)
}

pub fn ai_allowed(
    schema: &CategorySchemaView,
    policy: &WorkflowAiFieldPolicy,
    address: &FieldAddress,
) -> bool {
    let key = field_key(address);
    policy.allowed_field_keys.iter().any(|v| v == key)
        && !policy.protected_field_keys.iter().any(|v| v == key)
        && schema.fields.iter().any(|field| {
            field.key == key
                && !field.read_only
                && !super::projections::is_ai_protected_field(field)
                && match address {
                    FieldAddress::Plain { .. } => field.complex_id.is_none(),
                    FieldAddress::Complex { group_key, .. } => field
                        .complex_id
                        .is_some_and(|id| group_key == &id.to_string()),
                }
        })
}

pub fn record_origin(
    payload: &mut RowPayload,
    address: FieldAddress,
    kind: FieldValueOriginKind,
    source_ref: Option<String>,
    now_ms: u64,
) {
    payload
        .field_origins
        .retain(|origin| origin.address != address);
    payload.field_origins.push(FieldValueOrigin {
        address,
        kind,
        source_ref,
        updated_at_ms: now_ms,
    });
}

pub fn record_manual_changes(
    payload: &mut RowPayload,
    previous: &WorkflowCategoryDraft,
    now_ms: u64,
) {
    let mut all = addresses(previous);
    all.extend(addresses(&payload.draft));
    for address in all {
        if value_at(previous, &address) != value_at(&payload.draft, &address) {
            if matches!(address, FieldAddress::Plain { .. }) {
                let key = field_key(&address).to_owned();
                payload.hand_edited_keys.insert(key.clone());
                if value_at(&payload.draft, &address).is_none() {
                    payload.draft.cleared.insert(key);
                } else {
                    payload.draft.cleared.remove(&key);
                }
            }
            for candidate in &mut payload.ai.candidates {
                if candidate_address(&candidate.address).as_ref() == Some(&address)
                    && matches!(
                        candidate.state,
                        WorkflowAiCandidateState::Proposed | WorkflowAiCandidateState::Unresolved
                    )
                {
                    candidate.state = WorkflowAiCandidateState::Rejected;
                    candidate.issue = Some("已由人工修改".to_owned());
                }
            }
            record_origin(payload, address, FieldValueOriginKind::Manual, None, now_ms);
        }
    }
}

/// A new source retires only values with proven AI ownership. Unknown historical
/// values require an explicit keep/adopt decision; absence of Manual is no proof.
pub fn invalidate_source(payload: &mut RowPayload, had_source: bool, schema: &CategorySchemaView) {
    for origin in payload.field_origins.clone() {
        if origin.kind == FieldValueOriginKind::AiConfirmed && !is_manual(payload, &origin.address)
        {
            write_value(&mut payload.draft, &origin.address, None);
            payload
                .field_origins
                .retain(|current| current.address != origin.address);
        }
    }
    payload.ai = RowAi::default();
    if had_source {
        append_unknown_reviews(payload, schema);
    }
}

/// Neither OCR omissions nor a narrower Card policy prove an old value's origin.
/// Rebuild unresolved reviews from the remaining Draft, keeping fresh proposals.
pub fn append_unknown_reviews(payload: &mut RowPayload, schema: &CategorySchemaView) {
    let policy = super::projections::default_ai_policy(schema);
    for address in addresses(&payload.draft) {
        if ai_allowed(schema, &policy, &address)
            && !payload
                .ai
                .candidates
                .iter()
                .any(|candidate| candidate_address(&candidate.address).as_ref() == Some(&address))
            && !is_manual(payload, &address)
            && !payload
                .field_origins
                .iter()
                .any(|origin| origin.address == address)
            && has_content(value_at(&payload.draft, &address))
        {
            let Some(value) = value_at(&payload.draft, &address).cloned() else {
                continue;
            };
            payload.ai.candidates.push(WorkflowAiCandidate {
                address: address.clone(),
                value: value.clone(),
                current_value: Some(value),
                source: SOURCE_REVIEW.to_owned(),
                state: WorkflowAiCandidateState::Unresolved,
                issue: Some(
                    "源图已更换，旧值没有来源记录；请保留现值、手工修改或重新识别后采用新值"
                        .to_owned(),
                ),
            });
        }
    }
}

pub fn decide_candidate(
    payload: &mut RowPayload,
    schema: &CategorySchemaView,
    policy: &WorkflowAiFieldPolicy,
    index: usize,
    accept: bool,
    now_ms: u64,
) -> Result<(), &'static str> {
    let candidate = payload
        .ai
        .candidates
        .get(index)
        .ok_or("候选不存在，请刷新后重试")?
        .clone();
    if !matches!(
        candidate.state,
        WorkflowAiCandidateState::Proposed | WorkflowAiCandidateState::Unresolved
    ) {
        return Err("候选已经处理，请刷新后重试");
    }
    let address = candidate_address(&candidate.address);
    if accept {
        let address = address.ok_or("候选地址不可写，请保留现值或手工修改")?;
        if candidate.state != WorkflowAiCandidateState::Proposed
            || !ai_allowed(schema, policy, &address)
            || is_manual(payload, &address)
            || payload.draft.cleared.contains(field_key(&address))
        {
            return Err("候选不能覆盖人工或受保护字段");
        }
        if !write_value(&mut payload.draft, &address, Some(candidate.value.clone())) {
            return Err("候选复杂项已不存在");
        }
        record_origin(
            payload,
            address,
            FieldValueOriginKind::AiConfirmed,
            Some(payload.ai.request_id.clone()),
            now_ms,
        );
    } else if let Some(address) = address
        && (!has_content(value_at(&payload.draft, &address))
            || !payload
                .field_origins
                .iter()
                .any(|origin| origin.address == address))
    {
        // Keeping an unknown old value is now an operator decision, including
        // an intentional blank; future recognition must preserve it.
        if matches!(address, FieldAddress::Plain { .. }) {
            payload
                .hand_edited_keys
                .insert(field_key(&address).to_owned());
        }
        record_origin(payload, address, FieldValueOriginKind::Manual, None, now_ms);
    }
    payload.ai.candidates[index].state = if accept {
        WorkflowAiCandidateState::Confirmed
    } else {
        WorkflowAiCandidateState::Rejected
    };
    Ok(())
}
