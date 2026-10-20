//! OpenAPI component `KnownIssueKey`: the closed union generated from the
//! same declaration as the typed producers and the runtime manifest.
//!
//! `oneOf` with one object per `(platform, stage)`; each object pins
//! `platform` and `stage` to a single literal and enumerates that stage's
//! codes. A generated TypeScript client therefore sees a discriminated union
//! it can index `platform → stage → code` and check exhaustively, without a
//! hand-written code-to-stage table.

use std::borrow::Cow;

use utoipa::openapi::RefOr;
use utoipa::openapi::schema::{ObjectBuilder, OneOfBuilder, Schema, SchemaType, Type};

use super::{IssuePlatform, IssueStage, KnownIssueKey};

fn string_enum<'a>(values: impl IntoIterator<Item = &'a str>) -> RefOr<Schema> {
    RefOr::T(Schema::Object(
        ObjectBuilder::new()
            .schema_type(SchemaType::Type(Type::String))
            .enum_values(Some(values.into_iter().collect::<Vec<_>>()))
            .build(),
    ))
}

/// `(platform, stage, codes)` groups in manifest order. `ALL` is declared
/// stage by stage, so consecutive keys sharing a group are one run.
fn groups() -> Vec<(IssuePlatform, IssueStage, Vec<&'static str>)> {
    let mut groups: Vec<(IssuePlatform, IssueStage, Vec<&'static str>)> = Vec::new();
    for key in KnownIssueKey::ALL {
        match groups.last_mut() {
            Some((platform, stage, codes))
                if *platform == key.platform() && *stage == key.stage() =>
            {
                codes.push(key.code());
            }
            _ => groups.push((key.platform(), key.stage(), vec![key.code()])),
        }
    }
    groups
}

impl utoipa::PartialSchema for KnownIssueKey {
    fn schema() -> RefOr<Schema> {
        let mut one_of = OneOfBuilder::new();
        for (platform, stage, codes) in groups() {
            let object = ObjectBuilder::new()
                .property("platform", string_enum([platform.as_str()]))
                .required("platform")
                .property("stage", string_enum([stage.as_str()]))
                .required("stage")
                .property("code", string_enum(codes))
                .required("code")
                .build();
            one_of = one_of.item(RefOr::T(Schema::Object(object)));
        }
        RefOr::T(Schema::OneOf(one_of.build()))
    }
}

impl utoipa::ToSchema for KnownIssueKey {
    fn name() -> Cow<'static, str> {
        Cow::Borrowed("KnownIssueKey")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One object per declared stage, each carrying exactly that stage's
    /// codes: the union is the declaration, not a hand-kept copy.
    #[test]
    fn union_has_one_closed_object_per_stage() {
        let schema = serde_json::to_value(<KnownIssueKey as utoipa::PartialSchema>::schema())
            .expect("schema serializes");
        let items = schema["oneOf"].as_array().expect("oneOf");
        let summary: Vec<(String, String, usize)> = items
            .iter()
            .map(|item| {
                (
                    item["properties"]["platform"]["enum"][0]
                        .as_str()
                        .expect("platform literal")
                        .to_owned(),
                    item["properties"]["stage"]["enum"][0]
                        .as_str()
                        .expect("stage literal")
                        .to_owned(),
                    item["properties"]["code"]["enum"]
                        .as_array()
                        .expect("code enum")
                        .len(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("ozon".to_owned(), "validate".to_owned(), 19),
                ("ozon".to_owned(), "freeze".to_owned(), 6),
                ("ozon".to_owned(), "pre_dispatch".to_owned(), 7),
                ("ozon".to_owned(), "submit".to_owned(), 6),
                ("ozon".to_owned(), "preview".to_owned(), 9),
                ("wb".to_owned(), "metadata".to_owned(), 4),
                ("wb".to_owned(), "validate".to_owned(), 12),
                ("wb".to_owned(), "preview".to_owned(), 2),
            ]
        );
        for item in items {
            let required = item["required"].as_array().expect("required");
            assert_eq!(required.len(), 3, "{item}");
        }
    }
}
