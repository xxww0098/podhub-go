//! Prints the native JSON for each case. The Go wazero host must match it.
use std::env;
use std::fs;
use std::process::ExitCode;

use listing_tags::{Call, eval_call};
use serde::Deserialize;
use serde::Serialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    request: Call,
}

#[derive(Serialize)]
struct Row<'a> {
    name: &'a str,
    request: &'a Call,
    response: listing_tags::Out,
}

fn main() -> ExitCode {
    let path = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: oracle cases.json");
        std::process::exit(2);
    });
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(error) => {
            eprintln!("{path}: {error}");
            return ExitCode::from(1);
        }
    };
    let cases: Vec<Case> = match serde_json::from_slice(&raw) {
        Ok(cases) => cases,
        Err(error) => {
            eprintln!("{path}: {error}");
            return ExitCode::from(1);
        }
    };
    let mut rows = Vec::with_capacity(cases.len());
    for case in &cases {
        let response = match eval_call(&case.request) {
            Ok(response) => response,
            Err(error) => {
                eprintln!("{}: {error}", case.name);
                return ExitCode::from(1);
            }
        };
        rows.push(Row {
            name: &case.name,
            request: &case.request,
            response,
        });
    }
    println!("{}", serde_json::to_string_pretty(&rows).expect("encode"));
    ExitCode::SUCCESS
}
