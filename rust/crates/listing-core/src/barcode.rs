//! Ozon barcode admission — GTIN-8 / UPC-A / GTIN-13 / GTIN-14 check-digit subset.
//!
//! Private Ozon formats are not guessed; sellers may leave barcode empty for
//! platform generation.

const GTIN_LENGTHS: &[usize] = &[8, 12, 13, 14];

fn expected_check_digit(body: &str) -> u32 {
    let mut sum = 0u32;
    for (position, digit_char) in body.chars().rev().enumerate() {
        let digit = digit_char.to_digit(10).unwrap_or(0);
        sum += digit * if position % 2 == 0 { 3 } else { 1 };
    }
    (10 - (sum % 10)) % 10
}

/// Returns a stable issue message when the barcode is present but not a supported GTIN.
pub(super) fn ozon_barcode_issue(value: &str) -> Option<&'static str> {
    let barcode = value.trim();
    if barcode.is_empty() {
        return None;
    }
    if !barcode.chars().all(|ch| ch.is_ascii_digit()) {
        return Some("条形码仅支持数字 GTIN；Ozon 私有格式请留空后由平台生成");
    }
    if !GTIN_LENGTHS.contains(&barcode.len()) {
        return Some("条形码长度只支持 GTIN-8、UPC-A（12 位）、GTIN-13 或 GTIN-14");
    }
    if barcode.chars().all(|ch| ch == '0') {
        return Some("条形码不能全部为 0");
    }
    let body = &barcode[..barcode.len() - 1];
    let actual = barcode
        .chars()
        .last()
        .and_then(|ch| ch.to_digit(10))
        .unwrap_or(u32::MAX);
    if expected_check_digit(body) != actual {
        return Some("条形码校验位不正确");
    }
    None
}

pub(super) fn is_supported_ozon_barcode(value: &str) -> bool {
    !value.trim().is_empty() && ozon_barcode_issue(value).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_fixture_gtin13() {
        assert!(is_supported_ozon_barcode("4006381333931"));
        assert!(ozon_barcode_issue("4006381333931").is_none());
    }

    #[test]
    fn rejects_bad_check_digit() {
        assert_eq!(
            ozon_barcode_issue("4006381333932"),
            Some("条形码校验位不正确")
        );
    }

    #[test]
    fn empty_is_not_an_issue() {
        assert!(ozon_barcode_issue("").is_none());
        assert!(ozon_barcode_issue("   ").is_none());
    }
}
