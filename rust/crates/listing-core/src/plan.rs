//! Pure Execution Plan projection for Validated listing drafts.
//!
//! Planning never creates Intent, dispatches to Ozon, writes media files, or
//! performs network I/O: the plan is derived from the Validated snapshot and
//! recomputed on every read.

#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use std::sync::Arc;

use super::records::{ListingDraftRecord, ListingLifecycleState, NormalizedListingSnapshot};

pub use super::records::{ExecutionPlan, PlannedMediaOperation, PlannedOzonOperation};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlanError {
    #[error("Execution Plan requires a Validated listing draft")]
    NotValidated,
    #[error("Validated draft is missing its normalized snapshot")]
    MissingNormalizedSnapshot,
}

/// Build an Execution Plan from a Validated draft. Pure: no I/O, no clocks.
pub fn build_execution_plan(draft: &ListingDraftRecord) -> Result<ExecutionPlan, PlanError> {
    match draft.lifecycle_state {
        ListingLifecycleState::Validated | ListingLifecycleState::Planned => {}
        ListingLifecycleState::Draft => return Err(PlanError::NotValidated),
    }
    let snapshot = draft
        .normalized_snapshot
        .as_ref()
        .ok_or(PlanError::MissingNormalizedSnapshot)?;
    Ok(plan_from_snapshot(draft, snapshot))
}

fn plan_from_snapshot(
    draft: &ListingDraftRecord,
    snapshot: &NormalizedListingSnapshot,
) -> ExecutionPlan {
    let offer_id = snapshot.offer_id.clone();
    let load = PlannedMediaOperation {
        id: "load-image".to_owned(),
        kind: "media.load-image".to_owned(),
        summary: format!("加载货号 {offer_id} 的本地图片资源（仅读取，不上传）"),
        effect: "local-read".to_owned(),
        depends_on: Vec::new(),
        produces: vec!["bounded image asset with source fingerprint".to_owned()],
    };
    let render = PlannedMediaOperation {
        id: "render".to_owned(),
        kind: "media.render".to_owned(),
        summary: format!("渲染货号 {offer_id} 的装饰画切片集（本地渲染；公开 URL 待 Intent）"),
        effect: "local-render".to_owned(),
        depends_on: vec!["load-image".to_owned()],
        produces: vec![
            "ordered complete slice set".to_owned(),
            "content-addressed media ready for attach".to_owned(),
        ],
    };
    let card = PlannedOzonOperation {
        id: "card".to_owned(),
        kind: "ozon.card".to_owned(),
        summary: format!(
            "组装 Ozon 商品卡片（类目 {} / 类型 {}，offer_id {offer_id}）",
            snapshot.description_category_id, snapshot.type_id
        ),
        effect: "none".to_owned(),
        depends_on: vec!["render".to_owned()],
        produces: vec!["validated Ozon draft projection".to_owned()],
    };
    let publish = PlannedOzonOperation {
        id: "publish".to_owned(),
        kind: "ozon.product-import".to_owned(),
        summary: format!(
            "准备 /v3/product/import（offer_id {offer_id}）— 预览不创建 Intent，不发起网络请求"
        ),
        effect: "ozon.product-import".to_owned(),
        depends_on: vec!["card".to_owned()],
        produces: vec![
            "effect identity inputs for later Intent".to_owned(),
            "product-import payload shape".to_owned(),
        ],
    };

    ExecutionPlan {
        draft_id: draft.draft_id.clone(),
        draft_revision: draft.draft_revision,
        category_key: draft.category_key.clone(),
        description_category_id: draft.description_category_id,
        type_id: draft.type_id,
        schema_revision: draft.schema_revision.clone(),
        recipe_id: draft.recipe_id,
        recipe_revision: draft.recipe_revision,
        catalog_schema_version: draft.catalog_schema_version,
        offer_id,
        media_operations: vec![load, render],
        ozon_operations: vec![card, publish],
        topological_order: vec![
            "load-image".to_owned(),
            "render".to_owned(),
            "card".to_owned(),
            "publish".to_owned(),
        ],
    }
}

/// Compare a built plan against the target golden and the approved legacy mapping.
#[cfg(test)]
pub fn assert_plan_goldens(fixtures_root: &Path) -> Result<(), String> {
    let target_path = fixtures_root.join("plans/decorative-wall-art-target.json");
    let raw = std::fs::read_to_string(&target_path)
        .map_err(|error| format!("read {}: {error}", target_path.display()))?;
    let expected: ExecutionPlan = serde_json::from_str(&raw)
        .map_err(|error| format!("{}: {error}", target_path.display()))?;

    let draft = validated_fixture_draft(fixtures_root)?;
    let actual = build_execution_plan(&draft).map_err(|error| error.to_string())?;
    if actual != expected {
        return Err(format!(
            "target plan golden mismatch\nexpected: {}\nactual:   {}",
            serde_json::to_string_pretty(&expected).unwrap_or_default(),
            serde_json::to_string_pretty(&actual).unwrap_or_default()
        ));
    }

    assert_legacy_mapping(fixtures_root)?;
    Ok(())
}

#[cfg(test)]
fn validated_fixture_draft(fixtures_root: &Path) -> Result<ListingDraftRecord, String> {
    let success_path = fixtures_root.join("validation/success-normalized.json");
    let raw = std::fs::read_to_string(&success_path)
        .map_err(|error| format!("read {}: {error}", success_path.display()))?;
    let case: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("{}: {error}", success_path.display()))?;
    let field_values: std::collections::BTreeMap<String, String> =
        serde_json::from_value(case["field_values"].clone())
            .map_err(|error| format!("field_values: {error}"))?;
    let schema = crate::categories::decorative_wall_art::local_schema_snapshot();
    let mut draft = ListingDraftRecord {
        draft_id: "draft-plan-golden".to_owned(),
        draft_revision: 1,
        category_key: crate::categories::decorative_wall_art::CATEGORY_KEY.to_owned(),
        description_category_id: 17027906,
        type_id: 91976,
        schema_revision: schema.schema_revision.clone(),
        recipe_id: schema.recipe_id,
        recipe_revision: schema.recipe_revision,
        catalog_schema_version: schema.catalog_schema_version,
        schema_snapshot: Arc::new(schema),
        field_values,
        raw_values: std::collections::BTreeMap::new(),
        list_elements: Default::default(),
        complex_values: std::collections::BTreeMap::new(),
        field_origins: Vec::new(),
        lifecycle_state: ListingLifecycleState::Draft,
        normalized_snapshot: None,
        execution_plan: None,
        updated_at_ms: 0,
        envelope_version: crate::records::CURRENT_ENVELOPE_VERSION,
        unusable: false,
        preview_required: false,
        decode_failures: Vec::new(),
    };
    match crate::validate::normalize_and_validate(&draft) {
        crate::validate::ValidationOutcome::Accepted {
            normalized_values,
            snapshot,
        } => {
            draft.field_values = normalized_values;
            draft.lifecycle_state = ListingLifecycleState::Validated;
            draft.normalized_snapshot = Some(snapshot);
            Ok(draft)
        }
        crate::validate::ValidationOutcome::Rejected { issues } => Err(format!(
            "success golden must validate for plan fixture: {issues:?}"
        )),
    }
}

#[cfg(test)]
fn assert_legacy_mapping(fixtures_root: &Path) -> Result<(), String> {
    let legacy_path = fixtures_root.join("plans/decorative-wall-art.json");
    let raw = std::fs::read_to_string(&legacy_path)
        .map_err(|error| format!("read {}: {error}", legacy_path.display()))?;
    let legacy: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("{}: {error}", legacy_path.display()))?;
    let steps = legacy["steps"]
        .as_array()
        .ok_or_else(|| "legacy plan missing steps".to_owned())?;
    let legacy_kinds: Vec<&str> = steps
        .iter()
        .filter_map(|step| step["kind"].as_str())
        .collect();
    let expected_legacy = [
        "media.load-image",
        "media.render",
        "ai.image-recognition",
        "ozon.card",
        "ozon.publish",
    ];
    if legacy_kinds != expected_legacy {
        return Err(format!(
            "legacy plan kinds drifted: {legacy_kinds:?} (update the Execution Plan mapping if intentional)"
        ));
    }

    let draft = validated_fixture_draft(fixtures_root)?;
    let plan = build_execution_plan(&draft).map_err(|error| error.to_string())?;
    let media_kinds: Vec<&str> = plan
        .media_operations
        .iter()
        .map(|operation| operation.kind.as_str())
        .collect();
    let ozon_kinds: Vec<&str> = plan
        .ozon_operations
        .iter()
        .map(|operation| operation.kind.as_str())
        .collect();
    if media_kinds != ["media.load-image", "media.render"] {
        return Err(format!("unexpected media kinds: {media_kinds:?}"));
    }
    if ozon_kinds != ["ozon.card", "ozon.product-import"] {
        return Err(format!("unexpected ozon kinds: {ozon_kinds:?}"));
    }
    let has_ai = plan
        .media_operations
        .iter()
        .any(|operation| operation.kind.contains("ai."))
        || plan
            .ozon_operations
            .iter()
            .any(|operation| operation.kind.contains("ai."));
    if has_ai {
        return Err("target plan must not include AI recognition steps".to_owned());
    }
    if plan.topological_order != ["load-image", "render", "card", "publish"] {
        return Err(format!(
            "unexpected topological_order: {:?}",
            plan.topological_order
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::decorative_wall_art;
    use crate::draft::default_field_values;
    use crate::validate::{ValidationOutcome, normalize_and_validate};

    fn validated_draft() -> ListingDraftRecord {
        let schema = decorative_wall_art::local_schema_snapshot();
        let mut values = default_field_values(&schema);
        values.insert("offer_id".to_owned(), "ART-001".to_owned());
        values.insert("name".to_owned(), "Настенная картина".to_owned());
        values.insert("price".to_owned(), "90".to_owned());
        values.insert("currency_code".to_owned(), "RUB".to_owned());
        values.insert("barcode".to_owned(), "4006381333931".to_owned());
        values.insert("description".to_owned(), "40 × 50 cm".to_owned());
        values.insert("brand".to_owned(), "NoBrand".to_owned());
        values.insert("merge".to_owned(), "group-a".to_owned());
        values.insert("width".to_owned(), "400".to_owned());
        values.insert("height".to_owned(), "25".to_owned());
        values.insert("depth".to_owned(), "300".to_owned());
        values.insert("weight".to_owned(), "310".to_owned());
        let mut draft = ListingDraftRecord {
            draft_id: "draft-plan-1".to_owned(),
            draft_revision: 1,
            category_key: decorative_wall_art::CATEGORY_KEY.to_owned(),
            description_category_id: 17027906,
            type_id: 91976,
            schema_revision: schema.schema_revision.clone(),
            recipe_id: schema.recipe_id,
            recipe_revision: schema.recipe_revision,
            catalog_schema_version: schema.catalog_schema_version,
            schema_snapshot: Arc::new(schema),
            field_values: values,
            raw_values: Default::default(),
            list_elements: Default::default(),
            complex_values: Default::default(),
            field_origins: Default::default(),
            lifecycle_state: ListingLifecycleState::Draft,
            normalized_snapshot: None,
            execution_plan: None,
            updated_at_ms: 1,
            envelope_version: crate::records::CURRENT_ENVELOPE_VERSION,
            unusable: false,
            preview_required: false,
            decode_failures: Vec::new(),
        };
        let ValidationOutcome::Accepted {
            normalized_values,
            snapshot,
        } = normalize_and_validate(&draft)
        else {
            panic!("fixture must validate");
        };
        draft.field_values = normalized_values;
        draft.lifecycle_state = ListingLifecycleState::Validated;
        draft.normalized_snapshot = Some(snapshot);
        draft
    }

    #[test]
    fn planner_is_pure_and_deterministic() {
        let draft = validated_draft();
        let first = build_execution_plan(&draft).expect("plan");
        let second = build_execution_plan(&draft).expect("plan");
        assert_eq!(first, second);
        assert_eq!(first.offer_id, "ART-001");
        let encoded = serde_json::to_string(&first).expect("json");
        let again = serde_json::to_string(&second).expect("json");
        assert_eq!(encoded, again);
    }

    #[test]
    fn planner_rejects_unvalidated_draft() {
        let mut draft = validated_draft();
        draft.lifecycle_state = ListingLifecycleState::Draft;
        assert!(matches!(
            build_execution_plan(&draft),
            Err(PlanError::NotValidated)
        ));
    }

    #[test]
    fn planner_has_no_external_effect_markers() {
        let plan = build_execution_plan(&validated_draft()).expect("plan");
        for operation in &plan.media_operations {
            assert!(
                operation.effect == "local-read" || operation.effect == "local-render",
                "media effect must stay local: {}",
                operation.effect
            );
        }
        let publish = plan
            .ozon_operations
            .iter()
            .find(|operation| operation.id == "publish")
            .expect("publish");
        assert!(publish.summary.contains("不创建 Intent"));
        assert!(publish.summary.contains("不发起网络请求"));
    }

    #[test]
    fn golden_target_and_legacy_mapping() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/listing");
        assert_plan_goldens(&root).expect("plan goldens");
    }

    #[test]
    fn same_offer_produces_stable_operation_ids() {
        let plan = build_execution_plan(&validated_draft()).expect("plan");
        assert_eq!(plan.offer_id, "ART-001");
        assert_eq!(
            plan.topological_order,
            vec!["load-image", "render", "card", "publish"]
        );
    }
}
