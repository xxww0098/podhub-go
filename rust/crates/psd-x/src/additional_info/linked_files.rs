//! Document-level linked files (`lnk2` / `lnkD` / `lnk3` / `lnkE`).
//!
//! Upstream: `createLnkHandler` in `additionalInfo.ts` (~3910-4075).
//! Linked files live on [`crate::psd::Psd::linked_files`], so read needs
//! [`ReadCtx::psd`] and write/has need [`WriteCtx::linked_files`].

use crate::additional_info::{ReadCtx, WriteCtx};
use crate::descriptor::{
    Descriptor, DescriptorValue, read_version_and_descriptor, write_version_and_descriptor,
};
use crate::psd::{CompInfo, ExternalLinkedFile, LinkedFile, LinkedFileDescriptor};
use crate::reader::{
    AllocationCategory, PsdReader, ReadError, ReadResult, read_bytes_owned, read_float64,
    read_int32, read_pascal_string, read_signature, read_uint8, read_uint32, read_unicode_string,
    skip_bytes,
};
use crate::writer::{
    PsdWriter, write_bytes, write_float64, write_int32, write_signature, write_uint8, write_uint32,
};

pub fn read_lnk(
    key: &str,
    reader: &mut PsdReader,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &mut ReadCtx,
) -> ReadResult<()> {
    let Some(psd) = ctx.psd.as_mut() else {
        skip_bytes(reader, left(reader));
        return Ok(());
    };
    let files = psd.linked_files.get_or_insert_with(Vec::new);
    let skip_data = ctx.options.skip_linked_files_data == Some(true);

    while left(reader) > 8 {
        let mut size = read_length64(reader)?;
        let start = reader.offset;
        let typ = read_signature(reader)?;
        let version = read_int32(reader)?;
        let id = read_pascal_string(reader, 1)?;
        let name = read_unicode_string(reader)?;
        let file_type = read_signature(reader)?.trim().to_string();
        let creator_raw = read_signature(reader)?;
        let creator = creator_raw
            .trim_matches(|c| c == ' ' || c == '\0')
            .to_string();
        let data_size = read_length64(reader)?;
        let has_open = read_uint8(reader)? != 0;
        let open_desc = if has_open {
            Some(read_version_and_descriptor(reader)?)
        } else {
            None
        };
        let linked_desc = if typ == "liFE" {
            Some(read_version_and_descriptor(reader)?)
        } else {
            None
        };

        let mut file = LinkedFile {
            id,
            name,
            ..LinkedFile::default()
        };
        if !file_type.is_empty() {
            file.file_type = Some(file_type);
        }
        if !creator.is_empty() {
            file.creator = Some(creator);
        }
        if let Some(desc) = open_desc {
            if let Some(DescriptorValue::Descriptor(ci)) = desc.get("compInfo") {
                file.descriptor = Some(LinkedFileDescriptor {
                    comp_info: CompInfo {
                        comp_id: ci.number("compID").unwrap_or_default(),
                        original_comp_id: ci.number("originalCompID").unwrap_or_default(),
                    },
                });
            }
        }

        if typ == "liFE" && version > 3 {
            let year = read_int32(reader)?;
            let month = read_uint8(reader)?;
            let day = read_uint8(reader)?;
            let hour = read_uint8(reader)?;
            let minute = read_uint8(reader)?;
            let seconds = read_float64(reader)?;
            let whole = seconds.floor();
            let ms = ((seconds - whole) * 1000.0).round() as u32;
            // File stores 0-based month (Date.getUTCMonth); ISO uses 1-based.
            let iso_month = month as u16 + 1;
            file.time = Some(format!(
                "{year:04}-{iso_month:02}-{day:02}T{hour:02}:{minute:02}:{whole:02}.{ms:03}Z",
                whole = whole as i64
            ));
        }

        let file_size = if typ == "liFE" {
            read_length64(reader)? as f64
        } else {
            0.0
        };

        if typ == "liFA" {
            skip_bytes(reader, 8);
        }
        if typ == "liFD" {
            file.data = Some(read_bytes_owned(
                reader,
                data_size,
                AllocationCategory::LinkedPayload,
            )?);
        }
        if version >= 5 {
            file.child_document_id = Some(read_unicode_string(reader)?);
        }
        if version >= 6 {
            file.asset_mod_time = Some(read_float64(reader)?);
        }
        if version >= 7 {
            file.asset_locked_state = Some(read_uint8(reader)? as f64);
        }
        if typ == "liFE" && version == 2 {
            file.data = Some(read_bytes_owned(
                reader,
                file_size as usize,
                AllocationCategory::LinkedPayload,
            )?);
        }
        if skip_data {
            file.data = None;
        }

        if key == "lnkE" {
            let ld = linked_desc.as_ref();
            file.linked_file = Some(ExternalLinkedFile {
                file_size,
                name: ld.and_then(|d| d.text("Nm  ")).unwrap_or_default(),
                full_path: ld.and_then(|d| d.text("fullPath")).unwrap_or_default(),
                original_path: ld.and_then(|d| d.text("originalPath")).unwrap_or_default(),
                relative_path: ld.and_then(|d| d.text("relPath")).unwrap_or_default(),
            });
        }

        files.push(file);

        while size % 4 != 0 {
            size += 1;
        }
        reader.offset = start + size;
    }

    skip_bytes(reader, left(reader));
    Ok(())
}

/// Upstream: lnk2 when `linkedFiles.length > 0`; lnkE when some entry has `linkedFile`.
pub fn has_lnk(key: &str, ctx: &WriteCtx<'_>) -> bool {
    let Some(files) = ctx.linked_files else {
        return false;
    };
    if files.is_empty() {
        return false;
    }
    if key == "lnkE" {
        files.iter().any(|f| f.linked_file.is_some())
    } else {
        true
    }
}

pub fn write_lnk(key: &str, writer: &mut PsdWriter, ctx: &WriteCtx<'_>) -> ReadResult<()> {
    let files = ctx.linked_files.unwrap_or(&[]);
    write_linked_files(writer, key, files)
}

pub fn write_linked_files(
    writer: &mut PsdWriter,
    tag: &str,
    linked_files: &[LinkedFile],
) -> ReadResult<()> {
    for file in linked_files {
        if (tag == "lnkE") != file.linked_file.is_some() {
            continue;
        }

        let mut version = 2;
        if file.asset_locked_state.is_some() {
            version = 7;
        } else if file.asset_mod_time.is_some() {
            version = 6;
        } else if file.child_document_id.is_some() {
            version = 5;
        } else if tag == "lnkE" {
            version = 3;
        }

        write_length64(writer, 0);
        let size_offset = writer.offset;

        let sig = if tag == "lnkE" {
            "liFE"
        } else if file.data.is_some() {
            "liFD"
        } else {
            "liFA"
        };
        write_signature(writer, sig).expect("signature");
        write_int32(writer, version);

        check_guid(&file.id)?;
        crate::writer::write_pascal_string(writer, &file.id, 1).expect("pascal string");
        crate::writer::write_unicode_string_with_padding(writer, &file.name);

        write_signature(writer, &pad_sig(file.file_type.as_deref(), "    ")).expect("signature");
        write_signature(writer, &pad_sig(file.creator.as_deref(), "\0\0\0\0")).expect("signature");

        write_length64(writer, file.data.as_ref().map(|d| d.len()).unwrap_or(0));

        if let Some(desc) = &file.descriptor {
            write_uint8(writer, 1);
            let mut d = Descriptor::new("", "null");
            let mut ci = Descriptor::new("", "null");
            ci.set(
                "compID",
                DescriptorValue::Integer(desc.comp_info.comp_id as i32),
            );
            ci.set(
                "originalCompID",
                DescriptorValue::Integer(desc.comp_info.original_comp_id as i32),
            );
            d.set("compInfo", DescriptorValue::Descriptor(ci));
            write_version_and_descriptor(writer, &d);
        } else {
            write_uint8(writer, 0);
        }

        if tag == "lnkE" {
            let lf = file.linked_file.clone().unwrap_or_default();
            let mut d = Descriptor::new("", "ExternalFileLink");
            d.set("descVersion", DescriptorValue::Integer(2));
            d.set("Nm  ", DescriptorValue::Text(lf.name.clone()));
            d.set("fullPath", DescriptorValue::Text(lf.full_path.clone()));
            d.set(
                "originalPath",
                DescriptorValue::Text(lf.original_path.clone()),
            );
            d.set("relPath", DescriptorValue::Text(lf.relative_path.clone()));
            write_version_and_descriptor(writer, &d);

            let (y, mo, d_, h, mi, s) = parse_iso_utc(file.time.as_deref());
            write_int32(writer, y);
            write_uint8(writer, mo);
            write_uint8(writer, d_);
            write_uint8(writer, h);
            write_uint8(writer, mi);
            write_float64(writer, s);
        }

        if let Some(data) = &file.data {
            write_bytes(writer, Some(data));
        } else {
            write_length64(
                writer,
                file.linked_file
                    .as_ref()
                    .map(|l| l.file_size as usize)
                    .unwrap_or(0),
            );
        }

        if version >= 5 {
            crate::writer::write_unicode_string_with_padding(
                writer,
                file.child_document_id.as_deref().unwrap_or(""),
            );
        }
        if version >= 6 {
            write_float64(writer, file.asset_mod_time.unwrap_or(0.0));
        }
        if version >= 7 {
            write_uint8(writer, file.asset_locked_state.unwrap_or(0.0) as u8);
        }

        let mut size = writer.offset - size_offset;
        let bytes = (size as u32).to_be_bytes();
        writer.buffer[size_offset - 4..size_offset].copy_from_slice(&bytes);

        while size % 4 != 0 {
            write_uint8(writer, 0);
            size += 1;
        }
    }
    Ok(())
}

fn read_length64(reader: &mut PsdReader) -> ReadResult<usize> {
    let hi = read_uint32(reader)?;
    if hi != 0 {
        return Err(ReadError::StrictViolation(
            "Resource size above 4 GB limit".to_string(),
        ));
    }
    Ok(read_uint32(reader)? as usize)
}

fn write_length64(writer: &mut PsdWriter, length: usize) {
    write_uint32(writer, 0);
    write_uint32(writer, length as u32);
}

fn pad_sig(value: Option<&str>, empty: &str) -> String {
    match value {
        Some(v) if !v.is_empty() => {
            let mut s: String = v.chars().chain("    ".chars()).take(4).collect();
            s.truncate(4);
            s
        }
        _ => empty.to_string(),
    }
}

fn check_guid(id: &str) -> ReadResult<()> {
    if crate::guid::is_guid(id) {
        Ok(())
    } else {
        Err(ReadError::StrictViolation(
            "Linked file ID must be in a GUID format (example: 20953ddb-9391-11ec-b4f1-c15674f50bc4)"
                .to_string(),
        ))
    }
}

/// Minimal UTC ISO-8601 parse for lnkE timestamps. Missing/invalid → epoch.
fn parse_iso_utc(s: Option<&str>) -> (i32, u8, u8, u8, u8, f64) {
    let Some(s) = s else {
        return (1970, 0, 1, 0, 0, 0.0);
    };
    // YYYY-MM-DDTHH:MM:SS.sssZ or without ms
    let b = s.as_bytes();
    if b.len() < 19 {
        return (1970, 0, 1, 0, 0, 0.0);
    }
    let year: i32 = std::str::from_utf8(&b[0..4])
        .ok()
        .and_then(|x| x.parse().ok())
        .unwrap_or(1970);
    let month: u8 = std::str::from_utf8(&b[5..7])
        .ok()
        .and_then(|x| x.parse().ok())
        .unwrap_or(1);
    let day: u8 = std::str::from_utf8(&b[8..10])
        .ok()
        .and_then(|x| x.parse().ok())
        .unwrap_or(1);
    let hour: u8 = std::str::from_utf8(&b[11..13])
        .ok()
        .and_then(|x| x.parse().ok())
        .unwrap_or(0);
    let minute: u8 = std::str::from_utf8(&b[14..16])
        .ok()
        .and_then(|x| x.parse().ok())
        .unwrap_or(0);
    let sec_part = std::str::from_utf8(&b[17..])
        .unwrap_or("0")
        .trim_end_matches('Z');
    let seconds: f64 = sec_part.parse().unwrap_or(0.0);
    // upstream Date.UTC month is 0-based when writing getUTCMonth()
    (year, month.saturating_sub(1), day, hour, minute, seconds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reader::PsdReader;
    use crate::writer::create_writer_default;

    #[test]
    fn lnk2_round_trip_embedded() {
        let files = vec![LinkedFile {
            id: "20953ddb-9391-11ec-b4f1-c15674f50bc4".into(),
            name: "image.png".into(),
            data: Some(vec![1, 2, 3, 4, 5]),
            file_type: Some("8BPS".into()),
            creator: Some("8BIM".into()),
            ..LinkedFile::default()
        }];
        let mut writer = create_writer_default();
        write_linked_files(&mut writer, "lnk2", &files).unwrap();
        let buf = writer.to_bytes();
        assert_eq!(buf.len() % 4, 0);

        let mut reader = PsdReader::new(&buf, None, None);
        let total = buf.len();
        let left = move |r: &PsdReader| total - r.offset;
        let mut psd = crate::psd::Psd::default();
        let opts = crate::psd::ReadOptions::default();
        let mut ctx = ReadCtx {
            options: &opts,
            large: false,
            psd: Some(&mut psd),
            doc_width: 1.0,
            doc_height: 1.0,
        };
        read_lnk("lnk2", &mut reader, &left, &mut ctx).unwrap();
        let out = psd.linked_files.expect("files");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, files[0].id);
        assert_eq!(out[0].name, "image.png");
        assert_eq!(out[0].data.as_deref(), Some(&[1, 2, 3, 4, 5][..]));
        assert_eq!(out[0].file_type.as_deref(), Some("8BPS"));
    }
}
