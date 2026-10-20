//! Field build: the one pass that produces every value of the send Draft,
//! layer by layer, before validation or serialization reads any of it.
//!
//! Send is a three-state pipeline, each state a type the next step consumes:
//! [`BuiltListing`] → [`ValidatedListing`](super::compose::ValidatedListing)
//! (or `FieldIssue[]`) → [`FrozenImport`](super::compose::FrozenImport).
//! Nothing downstream fills, defaults or overrides a field; if a value is not
//! in the built Draft, Ozon does not get it.
//!
//! Layers apply in this order, and each may only write where its rule allows:
//!
//! | layer | produces | may replace |
//! | --- | --- | --- |
//! | `DatabaseDefault` | Card 默认字段 on every address the instance does not own | — |
//! | `Instance` | instance-owned keys, hand-edited keys and clears stored on the row | `DatabaseDefault` |
//! | `UserCustom` / `Ocr` | Manual / AiConfirmed origins, by exact address | everything above |
//! | `SourceFile` | source filename stem → `offer_id` / 9024 / 9048 | blank values only |
//! | `Renderer` | delivered PSD slices → `images` / `images360` / `primary_image` / `color_image` | open (unset, uncleared) slots only |
//! | `SystemDefault` | Seller contract defaults `vat=0`, `dimension_unit=mm`, `weight_unit=g` | blank and uncleared only |
//!
//! System media — the product-video and video-cover groups and their
//! attributes (`projections::SystemMediaFields`) — is no layer. Only the send-time media
//! evidence in [`ProductImportMedia`] fills it, in the serializer. A system
//! media value or clear that a Card default, an instance value or a replayed
//! origin put on the Draft is dropped, with its source, right after the last
//! layer that could write one, so it can neither be validated nor sent.
//!
//! The built Draft is not a send input: send builds again from the current card.
//! The row keeps the operator's half and the card the shared half
//! (docs/listing-fields.md). [`BuildEvidence`] is the digest of one build;
//! persisting it belongs to the listing kernel, not this module.

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::compose::{lifecycle_media, media_slot_open};
use super::envelope::{CardPayload, RowPayload};
use super::product_import::ProductImportMedia;
use super::projections::SystemMediaFields;
use super::records::{FieldAddress, FieldValueOriginKind};
use super::workflow_dto::instance_defaults::product_instance_owned_keys;
use super::{
    CategorySchemaView, WorkflowCategoryDraft, WorkflowDraftValue, overlay_current_card_defaults,
    source_identity_keys,
};

/// Which source produced a built value. Stored origins map onto the same
/// vocabulary, so an instance value keeps the layer that first wrote it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FieldLayer {
    DatabaseDefault,
    SellerSku,
    Instance,
    UserCustom,
    Ocr,
    SourceFile,
    Renderer,
    SystemDefault,
}

/// `currency_code` is deliberately absent: the store's contract currency is
/// the operator's pick, never a guess.
const SYSTEM_DEFAULTS: [(&str, &str); 3] =
    [("vat", "0"), ("dimension_unit", "mm"), ("weight_unit", "g")];

impl FieldLayer {
    /// Name stored on the row and read by the future wire DTO. Not [`Serialize`]:
    /// the evidence digest still prints the Rust variant (`DatabaseDefault`).
    pub fn stored_name(self) -> &'static str {
        match self {
            Self::DatabaseDefault => "database_default",
            Self::SellerSku => "seller_sku",
            Self::Instance => "instance",
            Self::UserCustom => "user_custom",
            Self::Ocr => "ocr",
            Self::SourceFile => "source_file",
            Self::Renderer => "renderer",
            Self::SystemDefault => "system_default",
        }
    }

    pub fn from_stored_name(name: &str) -> Option<Self> {
        Some(match name {
            "database_default" => Self::DatabaseDefault,
            "seller_sku" => Self::SellerSku,
            "instance" => Self::Instance,
            "user_custom" => Self::UserCustom,
            "ocr" => Self::Ocr,
            "source_file" => Self::SourceFile,
            "renderer" => Self::Renderer,
            "system_default" => Self::SystemDefault,
            _ => return None,
        })
    }

    fn of_origin(kind: FieldValueOriginKind) -> Self {
        match kind {
            FieldValueOriginKind::CardDefault => Self::DatabaseDefault,
            FieldValueOriginKind::SellerSku => Self::SellerSku,
            FieldValueOriginKind::Manual => Self::UserCustom,
            FieldValueOriginKind::AiConfirmed => Self::Ocr,
            FieldValueOriginKind::SystemMedia => Self::Renderer,
        }
    }
}

/// Every send field, built. `media` is the exact Seller media the Draft's
/// image slots were stamped from.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltListing {
    pub draft: WorkflowCategoryDraft,
    pub media: ProductImportMedia,
    /// The layer behind each set or cleared address, last writer wins.
    pub sources: Vec<(FieldAddress, FieldLayer)>,
}

/// Digest of one [`build_listing`] result. Not persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuildEvidence {
    /// `sha256:` + lowercase hex of the canonical built draft, media, and
    /// address-sorted sources. Not the raw row, and not the schema snapshot.
    pub digest: String,
    /// `sha256:` + lowercase hex of `card.defaults` only.
    pub card_defaults_digest: String,
    /// [`FieldAddress`] order, not last-writer order.
    pub sources: Vec<(FieldAddress, FieldLayer)>,
}

impl BuiltListing {
    pub fn source_of(&self, address: &FieldAddress) -> Option<FieldLayer> {
        self.sources
            .iter()
            .find(|(candidate, _)| candidate == address)
            .map(|(_, layer)| *layer)
    }

    pub fn evidence(&self, card: &CardPayload) -> BuildEvidence {
        let mut sources = self.sources.clone();
        sources.sort_by(|left, right| left.0.cmp(&right.0));
        BuildEvidence {
            digest: digest_of(serde_json::json!({
                "draft": &self.draft,
                "media": &self.media,
                "sources": &sources,
            })),
            card_defaults_digest: card_defaults_digest(card),
            sources,
        }
    }
}

/// Hash only the card defaults the build reads. The caller passes the
/// projected [`CardPayload`]; this function does not project a supplier card.
pub fn card_defaults_digest(card: &CardPayload) -> String {
    digest_of(&card.defaults)
}

pub fn build_listing(row: &RowPayload, card: &CardPayload) -> BuiltListing {
    let schema = super::projections::category_schema_view(&row.schema_snapshot, Some(row.language));
    let mut build = Build {
        draft: overlay_current_card_defaults(
            row.draft.clone(),
            &card.defaults,
            &schema,
            &row.hand_edited_keys,
        ),
        sources: Vec::new(),
    };
    build.attribute_overlay(row, &schema);
    build.reassert_origins(row);
    build.strip_system_media(&schema);
    build.fill_source_identity(&schema, &row.source.file_name);
    let media = lifecycle_media(
        &row.media.images,
        &row.media.videos,
        row.media.video_cover.as_ref(),
        &build.draft,
    );
    build.stamp_renderer_media(&media);
    build.fill_system_defaults();
    BuiltListing {
        draft: build.draft,
        media,
        sources: build.sources,
    }
}

fn plain(key: &str) -> FieldAddress {
    FieldAddress::Plain {
        field_key: key.to_owned(),
    }
}

struct Build {
    draft: WorkflowCategoryDraft,
    sources: Vec<(FieldAddress, FieldLayer)>,
}

impl Build {
    fn record(&mut self, address: FieldAddress, layer: FieldLayer) {
        match self
            .sources
            .iter_mut()
            .find(|(candidate, _)| *candidate == address)
        {
            Some(entry) => entry.1 = layer,
            None => self.sources.push((address, layer)),
        }
    }

    /// `DatabaseDefault` and `Instance`: the card overlay already merged them;
    /// attribute each address to the half it came from.
    fn attribute_overlay(&mut self, row: &RowPayload, schema: &CategorySchemaView) {
        let owned = product_instance_owned_keys(schema);
        let stored = |address: &FieldAddress, fallback: FieldLayer| {
            row.field_origins
                .iter()
                .find(|origin| origin.address == *address)
                .map_or(fallback, |origin| FieldLayer::of_origin(origin.kind))
        };
        let mut attributed = Vec::new();
        let plain_keys = self.draft.values.keys().chain(&self.draft.cleared);
        for key in plain_keys {
            let address = plain(key);
            let layer = if row.draft.cleared.contains(key) || row.hand_edited_keys.contains(key) {
                stored(&address, FieldLayer::UserCustom)
            } else if owned.contains(key) {
                stored(&address, FieldLayer::Instance)
            } else {
                FieldLayer::DatabaseDefault
            };
            attributed.push((address, layer));
        }
        for group in &self.draft.complex_values {
            for item in &group.items {
                for key in item.values.keys() {
                    let address = FieldAddress::Complex {
                        group_key: group.complex_id.to_string(),
                        item_id: item.item_id.clone(),
                        field_key: key.clone(),
                        value_index: None,
                    };
                    let layer = if owned.contains(key) {
                        stored(&address, FieldLayer::Instance)
                    } else {
                        FieldLayer::DatabaseDefault
                    };
                    attributed.push((address, layer));
                }
            }
        }
        for (address, layer) in attributed {
            self.record(address, layer);
        }
    }

    /// `UserCustom` / `Ocr`: the operator's and the confirmed recognition's
    /// value wins over the card by exact address (`item_id` inside a group).
    fn reassert_origins(&mut self, row: &RowPayload) {
        for origin in &row.field_origins {
            let layer = match origin.kind {
                FieldValueOriginKind::Manual => FieldLayer::UserCustom,
                FieldValueOriginKind::AiConfirmed => FieldLayer::Ocr,
                _ => continue,
            };
            let value = super::content_policy::value_at(&row.draft, &origin.address).cloned();
            if super::content_policy::write_value(&mut self.draft, &origin.address, value) {
                self.record(origin.address.clone(), layer);
            }
        }
    }

    /// System media belongs to the media evidence, never to a layer: drop
    /// whatever the overlay or the origin replay left on it, and its source.
    /// The layers after this one never write a system media field.
    fn strip_system_media(&mut self, schema: &CategorySchemaView) {
        let system = SystemMediaFields::of_view(schema);
        system.strip(&mut self.draft);
        self.sources.retain(|(address, _)| !system.owns(address));
    }

    /// `SourceFile`: filename identity fills only what every layer above left
    /// blank.
    fn fill_source_identity(&mut self, schema: &CategorySchemaView, file_name: &str) {
        let blank_before: Vec<String> = source_identity_keys(schema)
            .into_iter()
            .filter(|key| {
                super::projections::draft_value_is_blank(self.draft.values.get(key.as_str()))
            })
            .collect();
        super::projections::inject_source_identity(schema, &mut self.draft, file_name);
        for key in blank_before {
            if !super::projections::draft_value_is_blank(self.draft.values.get(&key)) {
                self.record(plain(&key), FieldLayer::SourceFile);
            }
        }
    }

    /// `Renderer`: stamp the Seller media onto open slots so validation judges
    /// exactly the URLs the body will carry (360 count limit included).
    /// Occupied slots already are those URLs.
    fn stamp_renderer_media(&mut self, media: &ProductImportMedia) {
        let slots = [
            (
                "images",
                (!media.images.is_empty())
                    .then(|| WorkflowDraftValue::UrlList(media.images.clone())),
            ),
            (
                "images360",
                (!media.images360.is_empty())
                    .then(|| WorkflowDraftValue::UrlList(media.images360.clone())),
            ),
            (
                "primary_image",
                (!media.primary_image.is_empty())
                    .then(|| WorkflowDraftValue::Url(media.primary_image.clone())),
            ),
            (
                "color_image",
                media.color_image.clone().map(WorkflowDraftValue::Url),
            ),
        ];
        for (key, value) in slots {
            if let Some(value) = value
                && media_slot_open(&self.draft, key)
            {
                self.draft.values.insert(key.to_owned(), value);
                self.record(plain(key), FieldLayer::Renderer);
            }
        }
    }

    /// `SystemDefault`: what no source provided and nobody cleared.
    fn fill_system_defaults(&mut self) {
        for (key, value) in SYSTEM_DEFAULTS {
            if !self.draft.cleared.contains(key)
                && super::projections::draft_value_is_blank(self.draft.values.get(key))
            {
                self.draft
                    .values
                    .insert(key.to_owned(), WorkflowDraftValue::Text(value.to_owned()));
                self.record(plain(key), FieldLayer::SystemDefault);
            }
        }
    }
}

fn digest_of(value: impl Serialize) -> String {
    let value = serde_json::to_value(value).expect("canonical json");
    let bytes = serde_json::to_vec(&sort_object_keys(value)).expect("canonical json");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

/// Object keys sorted. `BTreeMap` is already ordered; a `HashMap` becomes a
/// JSON object whose key order is not, and this walk sorts it without
/// changing the draft's map type.
fn sort_object_keys(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(sort_object_keys).collect())
        }
        serde_json::Value::Object(map) => {
            let mut entries: Vec<_> = map
                .into_iter()
                .map(|(key, child)| (key, sort_object_keys(child)))
                .collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            serde_json::Value::Object(entries.into_iter().collect())
        }
        other => other,
    }
}

#[cfg(test)]
#[path = "build_tests.rs"]
mod build_tests;

// System media never built from a Draft, Card default or origin replay.
#[cfg(test)]
#[path = "build_media_tests.rs"]
mod build_media_tests;
