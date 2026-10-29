//! kyp-snapshot: pull the deployed prompts into a folder (a complete offline mirror),
//! and optionally write a Rust module that compiles it into your binary.
//!
//!   kyp-snapshot --app support-bot --env prod --out ./prompts [--rust-module src/prompts.rs]
use std::process::ExitCode;

const USAGE: &str = "usage: kyp-snapshot --app <app> [--env prod] --out <dir> [--key <kypd_...>] \
[--cdn <url>] [--origin <url>] [--git <url> [--git-token <t>]] [--rust-module <file.rs>] [-q]
The delivery key defaults to $KYP_DELIVERY_KEY.";

fn main() -> ExitCode {
    let mut b = kyp::Builder::from_env().log_level(None);
    let (mut out, mut module, mut quiet, mut has_app) = (None, None, false, std::env::var("KYP_APP").is_ok());
    let mut git: Option<String> = None;
    let mut git_token = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = || args.next().ok_or_else(|| format!("{a} needs a value"));
        let r: Result<(), String> = (|| {
            match a.as_str() {
                "--app" => {
                    b = b.clone().app(val()?);
                    has_app = true;
                }
                "--env" => b = b.clone().env(val()?),
                "--out" => out = Some(val()?),
                "--key" => b = b.clone().delivery_key(val()?),
                "--cdn" => b = b.clone().cdn_base(val()?),
                "--origin" => b = b.clone().origin_base(val()?),
                "--git" => git = Some(val()?),
                "--git-token" => git_token = val()?,
                "--rust-module" => module = Some(val()?),
                "-q" | "--quiet" => quiet = true,
                "-h" | "--help" => return Err(String::new()),
                other => return Err(format!("unknown argument {other}")),
            }
            Ok(())
        })();
        if let Err(e) = r {
            if e.is_empty() {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            eprintln!("kyp-snapshot: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    }
    if let Some(g) = git {
        b = b.git_mirror(g, git_token);
    }
    let Some(out) = out.filter(|_| has_app) else {
        eprintln!("kyp-snapshot: --app and --out are required\n{USAGE}");
        return ExitCode::from(2);
    };
    match kyp::pull_snapshot(&b, &out) {
        Ok(info) => {
            if !quiet {
                println!(
                    "wrote {out}: workspace {} revision {}, {} prompts ({} new blobs) from {}",
                    info.workspace, info.revision, info.prompt_count, info.blobs_written, info.source
                );
            }
        }
        Err(e) => {
            eprintln!("kyp-snapshot: {e}");
            return ExitCode::FAILURE;
        }
    }
    if let Some(m) = module {
        let path = std::path::Path::new(&m);
        let rel = relative(path.parent().unwrap_or(std::path::Path::new(".")), std::path::Path::new(&out));
        match kyp::embed_module_source(&out, &rel).and_then(|src| std::fs::write(path, src)) {
            Ok(()) => {
                if !quiet {
                    println!("wrote {m}: use `mod ...; Builder::embedded(SNAPSHOT)`");
                }
            }
            Err(e) => {
                eprintln!("kyp-snapshot: writing {m}: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}

/// Path of `target` relative to directory `from` (both made absolute).
fn relative(from: &std::path::Path, target: &std::path::Path) -> String {
    let abs = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (from, target) = (abs(from), abs(target));
    let f: Vec<_> = from.components().collect();
    let t: Vec<_> = target.components().collect();
    let common = f.iter().zip(&t).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); f.len() - common];
    parts.extend(t[common..].iter().map(|c| c.as_os_str().to_string_lossy().into_owned()));
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}
