/// Render admission limits aligned with legacy `media.render@9`.
#[derive(Debug, Clone, Copy)]
pub(super) struct RenderLimits {
    pub max_template_bytes: u64,
    pub max_output_pixels: u64,
    pub max_output_side: u32,
    pub max_nesting_depth: u32,
    pub max_encoded_bytes: u64,
    pub max_linked_payload_bytes: u64,
    pub max_embedded_working_bytes: u64,
}

impl From<crate::psd::ProductResourcePolicy> for RenderLimits {
    fn from(policy: crate::psd::ProductResourcePolicy) -> Self {
        Self {
            max_template_bytes: policy.max_input_bytes,
            max_output_pixels: policy.max_output_pixels,
            max_output_side: policy.max_output_side,
            max_nesting_depth: policy.max_embedded_document_depth,
            max_encoded_bytes: policy.max_encoded_bytes,
            max_linked_payload_bytes: policy.max_input_bytes,
            max_embedded_working_bytes: policy.max_parser_live_bytes as u64,
        }
    }
}

impl RenderLimits {
    /// The same task-local ceiling for a linked raster or nested PSD. A linked
    /// source is resolved by the group that needs it, so it must never quietly
    /// fall back to the process-wide 512 MiB parser policy.
    pub(crate) fn linked_source_policy(self) -> crate::psd::ProductResourcePolicy {
        crate::psd::ProductResourcePolicy {
            max_input_bytes: self.max_linked_payload_bytes,
            max_parser_live_bytes: usize::try_from(self.max_embedded_working_bytes)
                .unwrap_or(usize::MAX),
            max_psd_side: self.max_output_side,
            max_psb_side: self.max_output_side,
            max_canvas_pixels: self.max_output_pixels,
            max_output_side: self.max_output_side,
            max_output_pixels: self.max_output_pixels,
            max_embedded_document_depth: self.max_nesting_depth,
            max_encoded_bytes: self.max_encoded_bytes,
            ..crate::psd::ProductResourcePolicy::default()
        }
    }
}

impl Default for RenderLimits {
    fn default() -> Self {
        crate::psd::ProductResourcePolicy::default().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::ProductResourcePolicy;

    #[test]
    fn render_limits_are_a_projection_of_product_policy() {
        let policy = ProductResourcePolicy {
            max_input_bytes: 7,
            max_output_pixels: 11,
            max_output_side: 13,
            max_embedded_document_depth: 17,
            max_encoded_bytes: 19,
            ..ProductResourcePolicy::default()
        };

        let limits = RenderLimits::from(policy);
        assert_eq!(limits.max_template_bytes, 7);
        assert_eq!(limits.max_output_pixels, 11);
        assert_eq!(limits.max_output_side, 13);
        assert_eq!(limits.max_nesting_depth, 17);
        assert_eq!(limits.max_encoded_bytes, 19);
        assert_eq!(limits.max_linked_payload_bytes, 7);
        assert_eq!(
            limits.max_embedded_working_bytes,
            policy.max_parser_live_bytes as u64
        );
    }
}
