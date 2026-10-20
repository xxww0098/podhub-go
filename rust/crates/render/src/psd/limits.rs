use serde::{Deserialize, Serialize};

/// Product resource policy for managed PSD/PSB intake and production
/// rendering. Historical probes deliberately keep their own explicitly named
/// profile outside the application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductResourcePolicy {
    pub max_input_bytes: u64,
    pub max_parser_live_bytes: usize,
    pub max_psd_side: u32,
    pub max_psb_side: u32,
    pub max_canvas_pixels: u64,
    pub max_output_side: u32,
    pub max_output_pixels: u64,
    pub max_descriptor_depth: u32,
    pub max_embedded_document_depth: u32,
    pub max_layer_records: u32,
    pub max_parser_metadata_bytes: usize,
    pub max_encoded_bytes: u64,
}

impl ProductResourcePolicy {
    pub fn parser_limits(self) -> Limits {
        Limits {
            max_input_bytes: self.max_input_bytes,
            max_decode_memory_bytes: self.max_parser_live_bytes,
            max_pixels: self.max_canvas_pixels,
            max_recursion_depth: self.max_descriptor_depth,
            max_psd_side: self.max_psd_side,
            max_psb_side: self.max_psb_side,
            max_layer_records: self.max_layer_records,
            max_embedded_document_depth: self.max_embedded_document_depth,
            max_metadata_bytes: self.max_parser_metadata_bytes,
        }
    }

    pub fn document_side_limit(self, version: u16) -> u32 {
        if version == 1 {
            self.max_psd_side
        } else {
            self.max_psb_side
        }
    }

    pub fn input_remediation(self) -> String {
        format!(
            "Choose a PSD/PSB no larger than {} MiB, or reduce document size before import.",
            self.max_input_bytes / (1024 * 1024)
        )
    }

    pub fn document_side_remediation(self, version: u16) -> String {
        format!(
            "Document dimensions exceed the import ceiling. Reduce width/height to {} px or less.",
            format_integer(u64::from(self.document_side_limit(version)))
        )
    }

    pub fn document_format_remediation(self) -> String {
        format!(
            "Document dimensions exceed the import ceiling. Reduce PSD width/height to {} px or less, or PSB width/height to {} px or less.",
            format_integer(u64::from(self.max_psd_side)),
            format_integer(u64::from(self.max_psb_side))
        )
    }
}

impl Default for ProductResourcePolicy {
    fn default() -> Self {
        Self {
            max_input_bytes: 512 * 1024 * 1024,
            max_parser_live_bytes: 512 * 1024 * 1024,
            max_psd_side: 30_000,
            max_psb_side: 32_768,
            max_canvas_pixels: 64 * 1024 * 1024,
            max_output_side: 30_000,
            max_output_pixels: 64 * 1024 * 1024,
            max_descriptor_depth: 32,
            max_embedded_document_depth: 4,
            max_layer_records: 8_192,
            max_parser_metadata_bytes: 64 * 1024 * 1024,
            max_encoded_bytes: 128 * 1024 * 1024,
        }
    }
}

fn format_integer(value: u64) -> String {
    let digits = value.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            formatted.push(',');
        }
        formatted.push(character);
    }
    formatted
}

/// Parser-facing projection derived from [`ProductResourcePolicy`].
/// Render admission uses this same type — there is no second isomorphic
/// `RenderAdmissionLimits` struct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_input_bytes: u64,
    pub max_decode_memory_bytes: usize,
    pub max_pixels: u64,
    pub max_recursion_depth: u32,
    pub max_psd_side: u32,
    pub max_psb_side: u32,
    pub max_layer_records: u32,
    pub max_embedded_document_depth: u32,
    pub max_metadata_bytes: usize,
}

impl Limits {
    pub fn document_side_limit(self, version: u16) -> u32 {
        if version == 1 {
            self.max_psd_side
        } else {
            self.max_psb_side
        }
    }

    pub fn product_policy(self) -> ProductResourcePolicy {
        ProductResourcePolicy {
            max_input_bytes: self.max_input_bytes,
            max_parser_live_bytes: self.max_decode_memory_bytes,
            max_psd_side: self.max_psd_side,
            max_psb_side: self.max_psb_side,
            max_canvas_pixels: self.max_pixels,
            max_descriptor_depth: self.max_recursion_depth,
            max_layer_records: self.max_layer_records,
            max_embedded_document_depth: self.max_embedded_document_depth,
            max_parser_metadata_bytes: self.max_metadata_bytes,
            ..ProductResourcePolicy::default()
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        ProductResourcePolicy::default().parser_limits()
    }
}

#[cfg(test)]
mod product_policy_tests {
    use super::*;

    #[test]
    fn product_policy_derives_every_approved_ceiling() {
        let policy = ProductResourcePolicy::default();

        assert_eq!(policy.max_input_bytes, 512 * 1024 * 1024);
        assert_eq!(policy.max_parser_live_bytes, 512 * 1024 * 1024);
        assert_eq!(policy.max_psd_side, 30_000);
        assert_eq!(policy.max_psb_side, 32_768);
        assert_eq!(policy.max_canvas_pixels, 64 * 1024 * 1024);
        assert_eq!(policy.max_output_side, 30_000);
        assert_eq!(policy.max_output_pixels, 64 * 1024 * 1024);
        assert_eq!(policy.max_descriptor_depth, 32);
        assert_eq!(policy.max_embedded_document_depth, 4);
        assert_eq!(policy.max_layer_records, 8_192);
        assert_eq!(policy.max_parser_metadata_bytes, 64 * 1024 * 1024);
        assert_eq!(policy.max_encoded_bytes, 128 * 1024 * 1024);

        let parser = policy.parser_limits();
        assert_eq!(parser.max_input_bytes, policy.max_input_bytes);
        assert_eq!(parser.max_decode_memory_bytes, policy.max_parser_live_bytes);
        assert_eq!(parser.max_pixels, policy.max_canvas_pixels);
        assert_eq!(parser.max_recursion_depth, policy.max_descriptor_depth);
        assert_eq!(parser.max_layer_records, policy.max_layer_records);
        assert_eq!(
            parser.max_embedded_document_depth,
            policy.max_embedded_document_depth
        );
        assert_eq!(parser.max_metadata_bytes, policy.max_parser_metadata_bytes);
    }

    #[test]
    fn remediation_is_derived_from_an_overridden_policy() {
        let policy = ProductResourcePolicy {
            max_input_bytes: 10 * 1024 * 1024,
            max_psd_side: 12_345,
            ..ProductResourcePolicy::default()
        };

        assert!(policy.input_remediation().contains("10 MiB"));
        assert!(policy.document_side_remediation(1).contains("12,345 px"));
        assert!(!policy.input_remediation().contains("64 MiB"));
        assert!(!policy.document_side_remediation(1).contains("16,384 px"));
    }
}
