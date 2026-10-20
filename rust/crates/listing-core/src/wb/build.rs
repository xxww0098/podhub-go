use super::encode::{EncodeError, ValidationError};
use super::fields::field_issue;
use super::{FieldValue, Issue, IssueField, IssueScope, Material, Preview, WbProductConfig};
use super::{encode_upload, metadata_issues, protocol, validate_fields};
use crate::issue_keys::{WbPreviewCode, WbValidateCode};

/// Compose defaults → manual → clear, validate the complete native group, then
/// preview the exact upload bytes. This operation never sends anything.
pub fn build_preview(material: &Material, config: &WbProductConfig) -> Preview {
    let mut issues = metadata_issues(material);
    if config.subject_id <= 0 || config.subject_id != material.subject_id {
        issues.push(Issue::new(
            WbValidateCode::CoordinateMismatch.key(),
            IssueField::Subject,
            IssueScope::Group,
        ));
    }
    if config.language != material.language {
        issues.push(Issue::new(
            WbValidateCode::CoordinateMismatch.key(),
            IssueField::Language,
            IssueScope::Group,
        ));
    }
    if !issues.is_empty() {
        return refused(issues);
    }
    let Some(catalog) = &material.catalog else {
        return refused(issues);
    };
    let mut variants = Vec::with_capacity(config.variants.len());
    for (index, variant) in config.variants.iter().enumerate() {
        let mut values = material
            .defaults
            .as_ref()
            .map(|defaults| defaults.values.clone())
            .unwrap_or_default();
        values.extend(variant.characteristics.clone());
        for id in &variant.cleared {
            values.remove(id);
            if !catalog.fields.iter().any(|field| field.id == *id) {
                let mut issue = field_issue(WbValidateCode::UnknownCharacteristic, *id);
                issue.variant_index = Some(index);
                issues.push(issue);
            }
        }
        for mut issue in validate_fields(&catalog.fields, &values, true) {
            issue.variant_index = Some(index);
            issues.push(issue);
        }
        if variant
            .dimensions
            .as_ref()
            .and_then(|dimensions| dimensions.weight_brutto)
            .is_some_and(|weight| weight < 0.0)
        {
            let mut issue = Issue::new(
                WbValidateCode::InvalidDimensions.key(),
                IssueField::Dimensions,
                IssueScope::Variant,
            );
            issue.variant_index = Some(index);
            issues.push(issue);
        }
        let characteristics = values
            .into_iter()
            .filter_map(|(id, value)| {
                let value = match value {
                    FieldValue::Text(values) => protocol::CharacteristicValue::Strings(values),
                    // Non-finite numbers already have an issue; no body is returned.
                    FieldValue::Number(value) => {
                        protocol::CharacteristicValue::Number(serde_json::Number::from_f64(value)?)
                    }
                };
                Some(protocol::CardCharacteristic {
                    id: id as u64,
                    value,
                })
            })
            .collect();
        variants.push(protocol::CardVariant {
            vendor_code: variant.vendor_code.clone(),
            title: variant.title.clone(),
            brand: variant.brand.clone(),
            description: variant.description.clone(),
            kiz_marked: variant.kiz_marked,
            wholesale: variant.wholesale.clone(),
            dimensions: variant.dimensions.clone(),
            sizes: variant.sizes.clone(),
            documents: variant.documents.clone(),
            characteristics,
        });
    }
    let group = protocol::CardGroup {
        subject_id: config.subject_id as u64,
        variants,
    };
    // Upload limits have one owner. Project its structured refusal into the
    // preview issue contract rather than reimplementing these rules here.
    let encoded = encode_upload(std::slice::from_ref(&group));
    match encoded {
        Err(error) => {
            issues.push(encoding_issue(error));
            refused(issues)
        }
        Ok(_) if !issues.is_empty() => refused(issues),
        Ok(bytes) => Preview {
            group: Some(group),
            upload_bytes: Some(bytes),
            issues,
        },
    }
}

fn refused(issues: Vec<Issue>) -> Preview {
    Preview {
        group: None,
        upload_bytes: None,
        issues,
    }
}

fn encoding_issue(error: EncodeError) -> Issue {
    let (key, field, variant) = match error {
        EncodeError::Validation(error) => match error {
            ValidationError::InvalidVariantCount { .. } => (
                WbValidateCode::VariantCount.key(),
                IssueField::Variants,
                None,
            ),
            ValidationError::EmptyVendorCode { variant, .. } => (
                WbValidateCode::VendorCodeRequired.key(),
                IssueField::VendorCode,
                Some(variant),
            ),
            ValidationError::VendorCodeTooLong { variant, .. } => (
                WbValidateCode::VendorCodeTooLong.key(),
                IssueField::VendorCode,
                Some(variant),
            ),
            ValidationError::TitleTooLong { variant, .. } => (
                WbValidateCode::TitleTooLong.key(),
                IssueField::Title,
                Some(variant),
            ),
            ValidationError::UploadTooLarge { .. } => (
                WbPreviewCode::UploadTooLarge.key(),
                IssueField::Payload,
                None,
            ),
            ValidationError::NonfiniteDimension { variant, .. } => (
                WbValidateCode::InvalidDimensions.key(),
                IssueField::Dimensions,
                Some(variant),
            ),
            ValidationError::EmptyUpload | ValidationError::TooManyGroups { .. } => (
                WbPreviewCode::EncodingFailed.key(),
                IssueField::Payload,
                None,
            ),
        },
        EncodeError::Serialize(_) => (
            WbPreviewCode::EncodingFailed.key(),
            IssueField::Payload,
            None,
        ),
    };
    let mut issue = Issue::new(
        key,
        field,
        if variant.is_some() {
            IssueScope::Variant
        } else {
            IssueScope::Group
        },
    );
    issue.variant_index = variant;
    issue
}
