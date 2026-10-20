use super::protocol::{CardGroup, CardVariant};
use super::{EncodeError as Error, MAX_UPLOAD_BYTES, ValidationError, encode_upload};

fn variant(vendor_code: impl Into<String>) -> CardVariant {
    CardVariant {
        vendor_code: vendor_code.into(),
        brand: None,
        title: None,
        description: None,
        kiz_marked: None,
        wholesale: None,
        dimensions: None,
        sizes: Vec::new(),
        characteristics: Vec::new(),
        documents: None,
    }
}

#[test]
fn upload_group_and_variant_limits_are_inclusive() {
    let one = CardGroup {
        subject_id: 1,
        variants: vec![variant("A")],
    };
    assert!(matches!(
        encode_upload(&[]),
        Err(Error::Validation(ValidationError::EmptyUpload))
    ));
    assert!(matches!(
        encode_upload(&[CardGroup {
            subject_id: 1,
            variants: Vec::new(),
        }]),
        Err(Error::Validation(ValidationError::InvalidVariantCount {
            actual: 0,
            ..
        }))
    ));
    assert!(encode_upload(&vec![one.clone(); 100]).is_ok());
    assert!(matches!(
        encode_upload(&vec![one.clone(); 101]),
        Err(Error::Validation(ValidationError::TooManyGroups {
            actual: 101,
            ..
        }))
    ));

    let thirty = CardGroup {
        subject_id: 1,
        variants: vec![variant("A"); 30],
    };
    assert!(encode_upload(&[thirty]).is_ok());
    let thirty_one = CardGroup {
        subject_id: 1,
        variants: vec![variant("A"); 31],
    };
    assert!(matches!(
        encode_upload(&[thirty_one]),
        Err(Error::Validation(ValidationError::InvalidVariantCount {
            actual: 31,
            ..
        }))
    ));
}

#[test]
fn upload_text_limits_count_unicode_characters_not_bytes() {
    let mut item = variant("界".repeat(72));
    item.title = Some("🦀".repeat(60));
    assert!(
        encode_upload(&[CardGroup {
            subject_id: 1,
            variants: vec![item]
        }])
        .is_ok()
    );

    assert!(matches!(
        encode_upload(&[CardGroup {
            subject_id: 1,
            variants: vec![variant("界".repeat(73))],
        }]),
        Err(Error::Validation(ValidationError::VendorCodeTooLong {
            characters: 73,
            ..
        }))
    ));

    let mut item = variant("A");
    item.title = Some("🦀".repeat(61));
    assert!(matches!(
        encode_upload(&[CardGroup {
            subject_id: 1,
            variants: vec![item]
        }]),
        Err(Error::Validation(ValidationError::TitleTooLong {
            characters: 61,
            ..
        }))
    ));
}

#[test]
fn upload_size_uses_exact_serialized_bytes_at_ten_mib_boundary() {
    let mut item = variant("A");
    item.description = Some(String::new());
    let mut groups = vec![CardGroup {
        subject_id: 1,
        variants: vec![item],
    }];
    let base = encode_upload(&groups).expect("base body").len();
    groups[0].variants[0].description = Some("x".repeat(MAX_UPLOAD_BYTES - base));
    assert_eq!(
        encode_upload(&groups).expect("exact limit").len(),
        MAX_UPLOAD_BYTES
    );

    groups[0].variants[0]
        .description
        .as_mut()
        .expect("description")
        .push('x');
    assert!(matches!(
        encode_upload(&groups),
        Err(Error::Validation(ValidationError::UploadTooLarge {
            bytes,
            maximum: MAX_UPLOAD_BYTES,
        })) if bytes == MAX_UPLOAD_BYTES + 1
    ));
}

#[test]
fn upload_size_counts_utf8_bytes_and_json_escaping() {
    let mut item = variant("界");
    item.description = Some("\"\\\n".into());
    let mut groups = vec![CardGroup {
        subject_id: 1,
        variants: vec![item],
    }];
    let base = encode_upload(&groups).unwrap().len();
    let remaining = MAX_UPLOAD_BYTES - base;
    let text = groups[0].variants[0].description.as_mut().unwrap();
    text.push_str(&"界".repeat(remaining / 3));
    text.push_str(&"x".repeat(remaining % 3));
    assert_eq!(encode_upload(&groups).unwrap().len(), MAX_UPLOAD_BYTES);
    groups[0].variants[0]
        .description
        .as_mut()
        .unwrap()
        .push('界');
    assert!(
        matches!(encode_upload(&groups), Err(Error::Validation(ValidationError::UploadTooLarge { bytes, .. })) if bytes == MAX_UPLOAD_BYTES + 3)
    );
}
