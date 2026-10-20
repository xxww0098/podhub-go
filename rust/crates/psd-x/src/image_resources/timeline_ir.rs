//! Timeline Information image resource (id 1075).

use crate::additional_info::timeline::{frac, parse_track_list, serialize_track_list, write_frac};
use crate::descriptor::{
    Descriptor, DescriptorValue, read_version_and_descriptor, write_version_and_descriptor,
};
use crate::psd::*;
use crate::reader::{PsdReader, ReadResult};
use crate::writer::PsdWriter;

pub(crate) fn read_timeline_information(
    reader: &mut PsdReader,
    target: &mut ImageResources,
) -> ReadResult<()> {
    let desc = read_version_and_descriptor(reader)?;
    let global_tracks = match desc.list("globalTrackList") {
        Some(list) => parse_track_list(list)?,
        None => Vec::new(),
    };
    let mut info = TimelineInformation {
        enabled: desc.bool("enab").unwrap_or(false),
        frame_step: frac(desc.get("frameStep")),
        frame_rate: desc.number("frameRate").unwrap_or(0.0),
        time: frac(desc.get("time")),
        duration: frac(desc.get("duration")),
        work_in_time: frac(desc.get("workInTime")),
        work_out_time: frac(desc.get("workOutTime")),
        repeats: desc.number("LCnt").unwrap_or(0.0),
        has_motion: desc.bool("hasMotion").unwrap_or(false),
        global_tracks,
        audio_clip_groups: None,
    };

    if let Some(acgl) = desc.descriptor("audioClipGroupList") {
        if let Some(groups) = acgl.list("audioClipGroupList") {
            if !groups.is_empty() {
                let mut out = Vec::new();
                for g in groups {
                    let DescriptorValue::Descriptor(g) = g else {
                        continue;
                    };
                    let mut clips = Vec::new();
                    if let Some(clip_list) = g.list("audioClipList") {
                        for c in clip_list {
                            let DescriptorValue::Descriptor(c) = c else {
                                continue;
                            };
                            let time_scope = c.descriptor("timeScope");
                            let frame_reader = c.descriptor("frameReader");
                            let link = frame_reader.and_then(|fr| fr.descriptor("Lnk "));
                            clips.push(AudioClip {
                                id: c.text("clipID").unwrap_or_default(),
                                start: time_scope.map(|t| frac(t.get("Strt"))).unwrap_or_default(),
                                duration: time_scope
                                    .map(|t| frac(t.get("duration")))
                                    .unwrap_or_default(),
                                in_time: time_scope
                                    .map(|t| frac(t.get("inTime")))
                                    .unwrap_or_default(),
                                out_time: time_scope
                                    .map(|t| frac(t.get("outTime")))
                                    .unwrap_or_default(),
                                muted: c.bool("muted").unwrap_or(false),
                                audio_level: c.number("audioLevel").unwrap_or(0.0),
                                frame_reader: AudioClipFrameReader {
                                    reader_type: frame_reader
                                        .and_then(|fr| fr.number("frameReaderType"))
                                        .unwrap_or(0.0),
                                    media_descriptor: frame_reader
                                        .and_then(|fr| fr.text("mediaDescriptor"))
                                        .unwrap_or_default(),
                                    link: AudioClipFrameReaderLink {
                                        name: link.and_then(|l| l.text("Nm  ")).unwrap_or_default(),
                                        full_path: link
                                            .and_then(|l| l.text("fullPath"))
                                            .unwrap_or_default(),
                                        relative_path: link
                                            .and_then(|l| l.text("relPath"))
                                            .unwrap_or_default(),
                                    },
                                },
                            });
                        }
                    }
                    out.push(AudioClipGroup {
                        id: g.text("groupID").unwrap_or_default(),
                        muted: g.bool("muted").unwrap_or(false),
                        audio_clips: clips,
                    });
                }
                info.audio_clip_groups = Some(out);
            }
        }
    }

    target.timeline_information = Some(info);
    Ok(())
}

pub(crate) fn write_timeline_information(
    writer: &mut PsdWriter,
    target: &ImageResources,
) -> ReadResult<()> {
    let timeline = target.timeline_information.as_ref().unwrap();
    let mut desc = Descriptor::new("", "null");
    desc.set("Vrsn", DescriptorValue::Integer(1));
    desc.set("enab", DescriptorValue::Boolean(timeline.enabled));
    desc.set("frameStep", write_frac(&timeline.frame_step));
    desc.set("frameRate", DescriptorValue::Double(timeline.frame_rate));
    desc.set("time", write_frac(&timeline.time));
    desc.set("duration", write_frac(&timeline.duration));
    desc.set("workInTime", write_frac(&timeline.work_in_time));
    desc.set("workOutTime", write_frac(&timeline.work_out_time));
    desc.set("LCnt", DescriptorValue::Integer(timeline.repeats as i32));
    desc.set(
        "globalTrackList",
        DescriptorValue::List(serialize_track_list(&timeline.global_tracks)?),
    );

    let mut acgl = Descriptor::new("", "null");
    let group_list: Vec<DescriptorValue> = timeline
        .audio_clip_groups
        .as_ref()
        .map(|groups| {
            groups
                .iter()
                .map(|a| {
                    let mut gd = Descriptor::new("", "null");
                    gd.set("groupID", DescriptorValue::Text(a.id.clone()));
                    gd.set("muted", DescriptorValue::Boolean(a.muted));
                    let clips: Vec<DescriptorValue> = a
                        .audio_clips
                        .iter()
                        .map(|c| {
                            let mut cd = Descriptor::new("", "null");
                            cd.set("clipID", DescriptorValue::Text(c.id.clone()));
                            let mut time_scope = Descriptor::new("", "null");
                            time_scope.set("Vrsn", DescriptorValue::Integer(1));
                            time_scope.set("Strt", write_frac(&c.start));
                            time_scope.set("duration", write_frac(&c.duration));
                            time_scope.set("inTime", write_frac(&c.in_time));
                            time_scope.set("outTime", write_frac(&c.out_time));
                            cd.set("timeScope", DescriptorValue::Descriptor(time_scope));
                            let mut fr = Descriptor::new("", "FrameReader");
                            fr.set(
                                "frameReaderType",
                                DescriptorValue::Integer(c.frame_reader.reader_type as i32),
                            );
                            fr.set("descVersion", DescriptorValue::Integer(1));
                            // fieldToExtType: Lnk  → ExternalFileLink
                            let mut lnk = Descriptor::new("", "ExternalFileLink");
                            lnk.set("descVersion", DescriptorValue::Integer(1));
                            lnk.set(
                                "Nm  ",
                                DescriptorValue::Text(c.frame_reader.link.name.clone()),
                            );
                            lnk.set(
                                "fullPath",
                                DescriptorValue::Text(c.frame_reader.link.full_path.clone()),
                            );
                            lnk.set(
                                "relPath",
                                DescriptorValue::Text(c.frame_reader.link.relative_path.clone()),
                            );
                            fr.set("Lnk ", DescriptorValue::Descriptor(lnk));
                            fr.set(
                                "mediaDescriptor",
                                DescriptorValue::Text(c.frame_reader.media_descriptor.clone()),
                            );
                            cd.set("frameReader", DescriptorValue::Descriptor(fr));
                            cd.set("muted", DescriptorValue::Boolean(c.muted));
                            cd.set("audioLevel", DescriptorValue::Double(c.audio_level));
                            DescriptorValue::Descriptor(cd)
                        })
                        .collect();
                    gd.set("audioClipList", DescriptorValue::List(clips));
                    DescriptorValue::Descriptor(gd)
                })
                .collect()
        })
        .unwrap_or_default();
    acgl.set("audioClipGroupList", DescriptorValue::List(group_list));
    desc.set("audioClipGroupList", DescriptorValue::Descriptor(acgl));
    desc.set("hasMotion", DescriptorValue::Boolean(timeline.has_motion));

    write_version_and_descriptor(writer, &desc);
    Ok(())
}

// ===========================================================================
