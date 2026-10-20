//! Pure `/v3/product/import` payload assembly from a Validated snapshot.

#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::DESCRIPTION_ATTRIBUTE_ID;
use crate::validate::NormalizedListingSnapshot;

const PUBLIC_MEDIA_PREFIX: &str = "https://";

// Field order and omitted empty fields are part of the pinned request hash.
// Seller API DTOs serialize differently; changing these shapes changes Intent identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductImportAttributeValue {
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dictionary_value_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductImportAttribute {
    pub id: i64,
    pub complex_id: i64,
    pub values: Vec<ProductImportAttributeValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductImportComplexAttribute {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attributes: Vec<ProductImportAttribute>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductImportPromotion {
    pub operation: String,
    #[serde(rename = "type")]
    pub promotion_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductImportItem {
    pub offer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub barcode: Option<String>,
    pub name: String,
    pub description_category_id: i64,
    pub type_id: i64,
    pub price: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency_code: Option<String>,
    pub vat: String,
    pub depth: i64,
    pub width: i64,
    pub height: i64,
    pub dimension_unit: String,
    pub weight: i64,
    pub weight_unit: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_image: Option<String>,
    pub images: Vec<String>,
    pub attributes: Vec<ProductImportAttribute>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub complex_attributes: Vec<ProductImportComplexAttribute>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images360: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pdf_list: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub promotions: Vec<ProductImportPromotion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductImportRequest {
    pub items: Vec<ProductImportItem>,
}

/// Seller media before it is copied onto the request. `Serialize` — and the
/// same derive on nested [`ProductImportVideo`] — is the build-digest field
/// list, not the `/v3/product/import` body. That body is [`ProductImportItem`],
/// filled by [`build_product_import_request`]. Empty fields stay in the JSON
/// so a new field still changes the digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProductImportMedia {
    pub primary_image: String,
    pub images: Vec<String>,
    pub color_image: Option<String>,
    /// Inputs for [`field_pack::occupies`]. Empty array is present; cleared is
    /// the other flag. The fallback below does not reinterpret them.
    pub color_present: bool,
    pub color_cleared: bool,
    pub images360: Vec<String>,
    /// Optional system-owned Product Video role. Category fields never carry
    /// these URLs; Listing appends the pinned semantic complex group while
    /// composing the final Seller payload.
    pub product_videos: Vec<ProductImportVideo>,
    pub video_cover_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProductImportVideo {
    pub title: String,
    pub public_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SerializeError {
    #[error("primary_image is required")]
    MissingPrimaryImage,
    #[error("images must contain at least one URL")]
    EmptyImages,
    #[error("invalid image URL: {0}")]
    InvalidImageUrl(String),
}

/// Placeholder media for wire-golden / reconcile tests that do not exercise Media.
/// Production submit with Plan media uses rendered asset URLs instead.
#[cfg(test)]
pub fn placeholder_media() -> ProductImportMedia {
    ProductImportMedia {
        primary_image: "https://media.example.invalid/hero.jpg".to_owned(),
        images: vec!["https://media.example.invalid/hero.jpg".to_owned()],
        color_image: None,
        color_present: false,
        color_cleared: false,
        images360: Vec::new(),
        product_videos: Vec::new(),
        video_cover_url: None,
    }
}

pub fn build_product_import_request(
    snapshot: &NormalizedListingSnapshot,
    media: &ProductImportMedia,
) -> Result<ProductImportRequest, SerializeError> {
    if media.primary_image.trim().is_empty() {
        return Err(SerializeError::MissingPrimaryImage);
    }
    if media.images.is_empty() {
        return Err(SerializeError::EmptyImages);
    }
    for url in std::iter::once(media.primary_image.as_str())
        .chain(media.images.iter().map(String::as_str))
        .chain(media.color_image.iter().map(String::as_str))
        .chain(media.images360.iter().map(String::as_str))
    {
        if !url.starts_with(PUBLIC_MEDIA_PREFIX) {
            return Err(SerializeError::InvalidImageUrl(url.to_owned()));
        }
    }

    let mut attributes: Vec<ProductImportAttribute> = snapshot
        .attributes
        .iter()
        .map(|attribute| ProductImportAttribute {
            id: attribute.id,
            complex_id: attribute.complex_id,
            values: attribute
                .values
                .iter()
                .map(|value| ProductImportAttributeValue {
                    value: value.value.clone(),
                    dictionary_value_id: value.dictionary_value_id,
                })
                .collect(),
        })
        .collect();

    let description = snapshot.description.trim();
    if !description.is_empty()
        && !attributes
            .iter()
            .any(|attribute| attribute.id == DESCRIPTION_ATTRIBUTE_ID)
    {
        attributes.push(ProductImportAttribute {
            id: DESCRIPTION_ATTRIBUTE_ID,
            complex_id: 0,
            values: vec![ProductImportAttributeValue {
                value: description.to_owned(),
                dictionary_value_id: None,
            }],
        });
    }
    attributes.sort_by_key(|attribute| attribute.id);

    let old_price = snapshot.old_price.trim();
    let mut item = ProductImportItem {
        offer_id: snapshot.offer_id.clone(),
        barcode: snapshot.barcode.clone(),
        name: snapshot.name.clone(),
        description_category_id: snapshot.description_category_id,
        type_id: snapshot.type_id,
        price: snapshot.price.clone(),
        old_price: if old_price.is_empty() {
            None
        } else {
            Some(old_price.to_owned())
        },
        currency_code: Some(snapshot.currency_code.clone()),
        vat: snapshot.vat.clone(),
        depth: i64::try_from(snapshot.depth).unwrap_or(i64::MAX),
        width: i64::try_from(snapshot.width).unwrap_or(i64::MAX),
        height: i64::try_from(snapshot.height).unwrap_or(i64::MAX),
        dimension_unit: snapshot.dimension_unit.clone(),
        weight: i64::try_from(snapshot.weight).unwrap_or(i64::MAX),
        weight_unit: snapshot.weight_unit.clone(),
        primary_image: Some(media.primary_image.clone()),
        color_image: if super::field_pack::occupies(media.color_present, media.color_cleared) {
            media.color_image.clone()
        } else {
            media
                .color_image
                .clone()
                .or_else(|| media.images.first().cloned())
        },
        images: media.images.clone(),
        attributes,
        complex_attributes: snapshot
            .complex_attributes
            .iter()
            .map(|group| ProductImportComplexAttribute {
                attributes: group
                    .attributes
                    .iter()
                    .map(|attribute| ProductImportAttribute {
                        id: attribute.id,
                        complex_id: group.complex_id,
                        values: attribute
                            .values
                            .iter()
                            .map(|value| ProductImportAttributeValue {
                                value: value.value.clone(),
                                dictionary_value_id: value.dictionary_value_id,
                            })
                            .collect(),
                    })
                    .collect(),
            })
            .collect(),
        images360: media.images360.clone(),
        pdf_list: Vec::new(),
        promotions: Vec::new(),
    };

    if !media.product_videos.is_empty() {
        item.complex_attributes.retain(|group| {
            !group
                .attributes
                .iter()
                .any(|attribute| attribute.complex_id == 100001)
        });
        for video in &media.product_videos {
            push_media_complex_group(
                &mut item.complex_attributes,
                100001,
                vec![
                    (
                        21837,
                        if video.title.trim().is_empty() {
                            item.name.clone()
                        } else {
                            video.title.clone()
                        },
                    ),
                    (21841, video.public_url.clone()),
                    (22273, item.offer_id.clone()),
                ],
            );
        }
    }
    if let Some(cover_url) = media.video_cover_url.as_ref() {
        upsert_media_complex_group(
            &mut item.complex_attributes,
            100002,
            vec![(21845, cover_url.clone())],
        );
    }

    Ok(ProductImportRequest { items: vec![item] })
}

fn upsert_media_complex_group(
    groups: &mut Vec<ProductImportComplexAttribute>,
    complex_id: i64,
    values: Vec<(i64, String)>,
) {
    let attributes = values
        .into_iter()
        .map(|(id, value)| ProductImportAttribute {
            id,
            complex_id,
            values: vec![ProductImportAttributeValue {
                value,
                dictionary_value_id: None,
            }],
        })
        .collect::<Vec<_>>();
    if let Some(group) = groups.iter_mut().find(|group| {
        group
            .attributes
            .iter()
            .any(|attribute| attribute.complex_id == complex_id)
    }) {
        group.attributes = attributes;
    } else {
        groups.push(ProductImportComplexAttribute { attributes });
    }
}

fn push_media_complex_group(
    groups: &mut Vec<ProductImportComplexAttribute>,
    complex_id: i64,
    values: Vec<(i64, String)>,
) {
    groups.push(ProductImportComplexAttribute {
        attributes: values
            .into_iter()
            .map(|(id, value)| ProductImportAttribute {
                id,
                complex_id,
                values: vec![ProductImportAttributeValue {
                    value,
                    dictionary_value_id: None,
                }],
            })
            .collect(),
    });
}

/// Compare serializer output against the wire golden for validation-covered fields.
#[cfg(test)]
pub fn assert_product_import_golden(fixtures_root: &Path) -> Result<(), String> {
    let golden_path = fixtures_root.join("ozon/product-import-request.json");
    let raw = std::fs::read_to_string(&golden_path)
        .map_err(|error| format!("read {}: {error}", golden_path.display()))?;
    let expected: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("{}: {error}", golden_path.display()))?;

    let draft = validated_fixture_draft(fixtures_root)?;
    let snapshot = draft
        .normalized_snapshot
        .as_ref()
        .ok_or_else(|| "fixture missing normalized snapshot".to_owned())?;
    let actual_request = build_product_import_request(snapshot, &placeholder_media())
        .map_err(|error| error.to_string())?;
    let actual = serde_json::to_value(&actual_request).map_err(|error| error.to_string())?;

    assert_wire_shape(&actual, &expected)?;
    Ok(())
}

#[cfg(test)]
fn assert_wire_shape(actual: &Value, expected: &Value) -> Result<(), String> {
    let actual_item = &actual["items"][0];
    let expected_item = &expected["items"][0];
    for key in [
        "offer_id",
        "barcode",
        "name",
        "description_category_id",
        "type_id",
        "price",
        "currency_code",
        "vat",
        "depth",
        "width",
        "height",
        "dimension_unit",
        "weight",
        "weight_unit",
        "primary_image",
        "color_image",
        "images",
    ] {
        if actual_item[key] != expected_item[key] {
            return Err(format!(
                "wire field `{key}` mismatch\nexpected: {}\nactual:   {}",
                expected_item[key], actual_item[key]
            ));
        }
    }
    if actual_item.get("old_price").is_some() {
        return Err("blank old_price must be omitted from the wire payload".to_owned());
    }
    if actual["items"].as_array().map(|items| items.len()) != Some(1) {
        return Err("envelope must contain exactly one item".to_owned());
    }
    let attrs = actual_item["attributes"]
        .as_array()
        .ok_or_else(|| "attributes missing".to_owned())?;
    if !attrs
        .iter()
        .any(|attribute| attribute["id"] == DESCRIPTION_ATTRIBUTE_ID)
    {
        return Err(format!(
            "description attribute {DESCRIPTION_ATTRIBUTE_ID} must be present"
        ));
    }
    if actual_item["color_image"] != actual_item["images"][0] {
        return Err("color_image must equal images[0]".to_owned());
    }
    // Brand/merge are validation-covered and must serialize; golden may list fewer.
    for attribute in expected_item["attributes"]
        .as_array()
        .ok_or_else(|| "expected attributes".to_owned())?
    {
        let id = attribute["id"].as_i64().ok_or("attr id")?;
        let found = attrs.iter().find(|entry| entry["id"] == id);
        match found {
            Some(actual_attr) if actual_attr["values"] == attribute["values"] => {}
            Some(actual_attr) => {
                return Err(format!(
                    "attribute {id} values mismatch: {} vs {}",
                    attribute["values"], actual_attr["values"]
                ));
            }
            None => return Err(format!("missing golden attribute {id}")),
        }
    }
    Ok(())
}

#[cfg(test)]
fn validated_fixture_draft(
    fixtures_root: &Path,
) -> Result<crate::draft::ListingDraftRecord, String> {
    let success_path = fixtures_root.join("validation/success-normalized.json");
    let raw = std::fs::read_to_string(&success_path)
        .map_err(|error| format!("read {}: {error}", success_path.display()))?;
    let case: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("{}: {error}", success_path.display()))?;
    let field_values: std::collections::BTreeMap<String, String> =
        serde_json::from_value(case["field_values"].clone())
            .map_err(|error| format!("field_values: {error}"))?;
    let schema = crate::categories::decorative_wall_art::local_schema_snapshot();
    let mut draft = crate::draft::ListingDraftRecord {
        draft_id: "draft-ozon-golden".to_owned(),
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
        raw_values: Default::default(),
        list_elements: Default::default(),
        complex_values: Default::default(),
        field_origins: Default::default(),
        lifecycle_state: crate::validate::ListingLifecycleState::Draft,
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
            draft.lifecycle_state = crate::validate::ListingLifecycleState::Validated;
            draft.normalized_snapshot = Some(snapshot);
            Ok(draft)
        }
        crate::validate::ValidationOutcome::Rejected { issues } => Err(format!(
            "success golden must validate for serializer fixture: {issues:?}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::decorative_wall_art;
    use crate::draft::default_field_values;
    use crate::validate::{ListingLifecycleState, ValidationOutcome, normalize_and_validate};

    fn validated_snapshot() -> NormalizedListingSnapshot {
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
        let draft = crate::draft::ListingDraftRecord {
            draft_id: "draft-ser".to_owned(),
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
        let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
            panic!("must validate");
        };
        snapshot
    }

    #[test]
    fn validated_draft_never_fails_serialization() {
        let request =
            build_product_import_request(&validated_snapshot(), &placeholder_media()).expect("ser");
        assert_eq!(request.items.len(), 1);
        assert_eq!(request.items[0].offer_id, "ART-001");
        assert!(request.items[0].old_price.is_none());
        assert_eq!(
            request.items[0].color_image.as_deref(),
            Some(request.items[0].images[0].as_str())
        );
    }

    #[test]
    fn non_empty_old_price_reaches_the_seller_payload() {
        let mut snapshot = validated_snapshot();
        snapshot.old_price = "120.50".to_owned();

        let request = build_product_import_request(&snapshot, &placeholder_media()).expect("ser");

        assert_eq!(request.items[0].old_price.as_deref(), Some("120.50"));
    }

    #[test]
    fn category_image_fields_are_sent_as_their_exact_wire_urls() {
        let mut media = placeholder_media();
        media.primary_image = "https://cdn.example.test/primary.jpg".to_owned();
        media.images = vec!["https://cdn.example.test/gallery.jpg".to_owned()];
        media.color_image = Some("https://cdn.example.test/color.jpg".to_owned());
        media.images360 = vec!["https://cdn.example.test/360.jpg".to_owned()];

        let request = build_product_import_request(&validated_snapshot(), &media).expect("ser");
        let item = &request.items[0];
        assert_eq!(
            item.primary_image.as_deref(),
            Some(media.primary_image.as_str())
        );
        assert_eq!(item.images, media.images);
        assert_eq!(item.color_image, media.color_image);
        assert_eq!(item.images360, media.images360);
    }

    #[test]
    fn occupied_color_image_does_not_fall_back_to_the_first_image() {
        let mut media = placeholder_media();
        media.color_present = true;
        media.color_image = None;
        let request = build_product_import_request(&validated_snapshot(), &media).expect("ser");
        assert!(request.items[0].color_image.is_none());

        media.color_present = false;
        media.color_cleared = true;
        let request = build_product_import_request(&validated_snapshot(), &media).expect("ser");
        assert!(request.items[0].color_image.is_none());
    }

    #[test]
    fn listing_snapshot_serializes_repeated_complex_attributes() {
        let mut snapshot = validated_snapshot();
        snapshot.complex_attributes = ["first", "second"]
            .into_iter()
            .map(|value| crate::validate::NormalizedComplexAttributeGroup {
                complex_id: 100001,
                attributes: vec![crate::validate::NormalizedAttribute {
                    id: 21841,
                    complex_id: 100001,
                    values: vec![crate::validate::NormalizedAttributeValue {
                        value: value.to_owned(),
                        dictionary_value_id: None,
                    }],
                }],
            })
            .collect();
        let request = build_product_import_request(&snapshot, &placeholder_media()).expect("ser");
        assert_eq!(request.items[0].complex_attributes.len(), 2);
        assert_eq!(
            request.items[0]
                .complex_attributes
                .iter()
                .map(|group| group.attributes[0].values[0].value.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
    }

    #[test]
    fn system_media_roles_are_composed_by_listing_with_exact_complex_ids() {
        let mut media = placeholder_media();
        media.product_videos.push(ProductImportVideo {
            title: "demo.mp4".to_owned(),
            public_url: "https://cdn.example.test/demo.mp4".to_owned(),
        });
        media.product_videos.push(ProductImportVideo {
            title: "detail.mov".to_owned(),
            public_url: "https://cdn.example.test/detail.mov".to_owned(),
        });
        media.video_cover_url = Some("https://cdn.example.test/cover.mp4".to_owned());
        let request = build_product_import_request(&validated_snapshot(), &media).expect("ser");
        let groups = &request.items[0].complex_attributes;
        let video = groups
            .iter()
            .find(|group| {
                group
                    .attributes
                    .iter()
                    .any(|attribute| attribute.complex_id == 100001)
            })
            .expect("product video group");
        assert_eq!(
            video
                .attributes
                .iter()
                .map(|attribute| attribute.id)
                .collect::<Vec<_>>(),
            vec![21837, 21841, 22273]
        );
        assert_eq!(
            groups
                .iter()
                .filter(|group| {
                    group
                        .attributes
                        .iter()
                        .any(|attribute| attribute.complex_id == 100001)
                })
                .count(),
            2
        );
        assert!(groups.iter().any(|group| {
            group.attributes.len() == 1
                && group.attributes[0].complex_id == 100002
                && group.attributes[0].id == 21845
        }));
    }

    #[test]
    fn publish_media_rejects_non_https_urls() {
        let snapshot = validated_snapshot();
        let mut media = placeholder_media();
        media.images = vec!["http://cdn.example.test/main.jpg".to_owned()];
        assert!(matches!(
            build_product_import_request(&snapshot, &media),
            Err(SerializeError::InvalidImageUrl(_))
        ));
    }

    #[test]
    fn golden_wire_shape() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/listing");
        assert_product_import_golden(&root).expect("golden");
    }

    /// Fixed Validated Draft used by the wire golden and idempotency pins.
    fn golden_validated_draft_request() -> (String, String, ProductImportRequest) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/listing");
        let draft = super::validated_fixture_draft(&root).expect("validated fixture draft");
        let snapshot = draft
            .normalized_snapshot
            .as_ref()
            .expect("fixture missing normalized snapshot");
        let request = build_product_import_request(snapshot, &placeholder_media())
            .expect("golden draft must serialize");
        (draft.draft_id, snapshot.offer_id.clone(), request)
    }

    /// Protects Intent dedupe: changing the request digest for a fixed Draft
    /// would make already-Dispatched listings look new and risk a second Ozon submit.
    #[test]
    fn request_digest_is_pinned_so_idempotency_identity_cannot_silently_change() {
        const PINNED_REQUEST_DIGEST: &str =
            "sha256:86486aa18947881ff742c51d4d3a26b03e8972caa18be7d257625325643b0e89";

        let (_draft_id, _offer_id, request) = golden_validated_draft_request();
        let digest = super::super::compose::request_hash(&request).expect("request digest");
        assert_eq!(
            digest, PINNED_REQUEST_DIGEST,
            "idempotency identity changed: request digest for the wire-golden Validated Draft no longer matches the pinned sha256 constant"
        );
    }

    /// Protects persisted Intent request_json equivalence with the wire golden.
    /// A shape change here would strand committed Intents and shift the digest.
    #[test]
    fn persisted_intent_request_json_equals_wire_golden_so_idempotency_payload_stays_stable() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/listing");
        let golden_path = root.join("ozon/product-import-request.json");
        let golden_raw = std::fs::read_to_string(&golden_path)
            .unwrap_or_else(|error| panic!("read {}: {error}", golden_path.display()));
        let expected: Value = serde_json::from_str(&golden_raw)
            .unwrap_or_else(|error| panic!("{}: {error}", golden_path.display()));

        let (_draft_id, _offer_id, request) = golden_validated_draft_request();
        // prepare_intent persists via serde_json::to_string; compare as Value so
        // pretty-printed golden whitespace is not part of the identity.
        let persisted_payload =
            serde_json::to_value(&request).expect("serialize persisted payload");
        assert_eq!(
            persisted_payload, expected,
            "idempotency identity changed: Intent request payload JSON no longer equals the recorded wire golden fixture"
        );
    }
}
