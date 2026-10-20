use std::path::PathBuf;

use anyhow::anyhow;
use psdx::psd::ReadOptions;
use psdx::read_psd;
use psdx::render::{ExportConcurrency, ExportFormat, ExportOptions, export_groups};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let input = PathBuf::from(args.next().ok_or_else(|| {
        anyhow!(
            "usage: export_as <input.psd> <output-dir> [png|jpg|gif] [top-level-index] [off|auto|N]"
        )
    })?);
    let output = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow!("missing output directory"))?,
    );
    let format = match args
        .next()
        .and_then(|value| value.into_string().ok())
        .as_deref()
    {
        None | Some("png") => ExportFormat::Png,
        Some("jpg" | "jpeg") => ExportFormat::Jpeg,
        Some("gif") => ExportFormat::Gif,
        Some(_) => anyhow::bail!("format must be png, jpg, or gif"),
    };
    let selected_top_level_groups = args
        .next()
        .map(|value| {
            let value = value
                .into_string()
                .map_err(|_| anyhow!("group index must be UTF-8"))?;
            if value == "all" {
                Ok(None)
            } else {
                value
                    .parse::<usize>()
                    .map(|index| Some(vec![index]))
                    .map_err(|_| anyhow!("group index must be 'all' or a non-negative integer"))
            }
        })
        .transpose()?
        .flatten();
    let concurrency = match args
        .next()
        .and_then(|value| value.into_string().ok())
        .as_deref()
    {
        None | Some("auto") => ExportConcurrency::Auto,
        Some("off") => ExportConcurrency::Off,
        Some(workers) => ExportConcurrency::Fixed(
            workers
                .parse()
                .map_err(|_| anyhow!("concurrency must be off, auto, or a positive integer"))?,
        ),
    };

    let bytes = std::fs::read(input)?;
    let psd = read_psd(&bytes, &ReadOptions::default())?;
    let result = export_groups(
        &psd,
        &ExportOptions {
            format,
            selected_top_level_groups,
            concurrency,
            ..ExportOptions::default()
        },
    )?;
    eprintln!("export workers: {}", result.workers_used);
    std::fs::create_dir_all(&output)?;
    for asset in result.assets {
        let target = output.join(&asset.file_name);
        std::fs::write(&target, asset.bytes)?;
        println!(
            "{}\t{}x{}\t{}",
            asset.group_name,
            asset.width,
            asset.height,
            target.display()
        );
    }
    for warning in result.warnings {
        eprintln!("warning: {warning}");
    }
    Ok(())
}
