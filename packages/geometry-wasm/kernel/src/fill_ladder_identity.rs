//! P3 Alt-A1 unit AL-U2 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` section 4.4): the
//! branch's rung record for `pnpm test:p3-fill-identity --revision-change`.
//!
//! This file is branch-only: the identity tool's bootstrap overlay copies `p3_b0r_identity.rs`
//! into the merge-base tree, never this file, so it may use APIs that the merge base lacks. The
//! ignored test `dump_rungs` runs on the branch tree only, over the same corpora and case names
//! as `p3_b0r_identity::dump_native_digests` (`b0/<cell>/<index>` and
//! `rnd/<family>/<index>`, four-digit indices). For every path it computes the rung through
//! AL-U1's `fill_ladder` module directly: rung 0 on the case's request (its fill rule and
//! tolerance exponent), then on a fallback V2's unchanged exact cascade, the order the export
//! takes from AL-U3 (contract section 3.1). Each line is
//! `<path>\t<rung>\t<reason>\t<exact step>\t<exact result>`, with rung 0 (fast) or 1 (exact)
//! and `-` for a field that does not apply.
use std::env;
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;

use crate::cubic_fill::CubicFillWorkspace;
use crate::fill_export::{FillRequest, FILL_V0_LIMITS};
use crate::fill_ladder::{ExactStep, FillLadder, Rung};
use crate::fill_ladder_dump_tests::OnceScan;
use crate::line_fill::LineFillRule;
use crate::p3_b0_bench::Reader;

const RANDOM_MAGIC: &[u8; 8] = b"P3BRRND1";
/// B0 runs at e = −3 under nonzero, as `p3_b0r_identity.rs`.
const B0_EXPONENT: i32 = -3;
/// Randomized families are split into chunks of this many paths, as `p3_b0r_identity.rs`.
const RANDOM_CHUNK: usize = 50;
const THREAD_STACK_BYTES: usize = 16 * 1024 * 1024;

struct RungPath {
    name: String,
    request: FillRequest,
    verbs: Vec<u8>,
    point_bytes: Vec<u8>,
}

fn b0_paths(file: &str) -> Vec<Vec<RungPath>> {
    crate::p3_b0_bench::read_corpus(file)
        .into_iter()
        .map(|cell| {
            cell.paths
                .into_iter()
                .enumerate()
                .map(|(index, path)| RungPath {
                    name: format!("b0/{}/{index:04}", cell.id),
                    request: FillRequest {
                        request_id: 0,
                        rule: LineFillRule::Nonzero,
                        exponent: B0_EXPONENT,
                    },
                    verbs: path.verbs,
                    point_bytes: path.point_bytes,
                })
                .collect()
        })
        .collect()
}

/// A `p3-b0r-random/v1`-frame corpus (`P3BRRND1`), chunked as `p3_b0r_identity.rs` chunks it.
fn random_paths(file: &str) -> Vec<Vec<RungPath>> {
    let bytes = std::fs::read(file).unwrap_or_else(|error| panic!("read {file}: {error}"));
    let mut reader = Reader {
        bytes: &bytes,
        offset: 0,
    };
    assert_eq!(reader.take(8), RANDOM_MAGIC, "randomized corpus magic");
    let families = reader.u32();
    let mut chunks = Vec::new();
    for _ in 0..families {
        let length = reader.u32();
        let id = String::from_utf8(reader.take(length).to_vec()).expect("family id");
        let _entry = reader.u8();
        let count = reader.u32();
        let mut paths = Vec::with_capacity(count);
        for index in 0..count {
            let rule = match reader.u8() {
                0 => LineFillRule::Nonzero,
                1 => LineFillRule::Evenodd,
                other => panic!("unknown fill rule {other}"),
            };
            let exponent = i32::from_le_bytes(reader.take(4).try_into().expect("exponent"));
            assert!(
                (-1021..=1023).contains(&exponent),
                "tolerance exponent {exponent} outside the fill-v0 range"
            );
            let verb_count = reader.u32();
            let verbs = reader.take(verb_count).to_vec();
            let scalars = reader.u32();
            let point_bytes = reader.take(scalars * 8).to_vec();
            paths.push(RungPath {
                name: format!("rnd/{id}/{index:04}"),
                request: FillRequest {
                    request_id: 0,
                    rule,
                    exponent,
                },
                verbs,
                point_bytes,
            });
        }
        let mut rest = paths.into_iter().peekable();
        while rest.peek().is_some() {
            chunks.push(rest.by_ref().take(RANDOM_CHUNK).collect());
        }
    }
    assert_eq!(reader.offset, bytes.len(), "trailing corpus bytes");
    chunks
}

/// The rung record lines of one chunk, from fresh workspaces.
fn run_chunk(chunk: &[RungPath]) -> String {
    let mut ladder = FillLadder::for_tests();
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let mut scan = OnceScan::new();
    let mut out = String::new();
    for path in chunk {
        let outcome = ladder.run(
            &mut workspace,
            path.request,
            &path.verbs,
            &path.point_bytes,
            &mut scan,
        );
        let rung = match outcome.rung {
            Rung::Fast => 0,
            Rung::Exact => 1,
        };
        let reason = outcome.reason.map_or("-", |reason| reason.code());
        let (step, exact) = match outcome.exact {
            None => ("-", "-".to_owned()),
            Some(exact) => (
                match exact.step {
                    ExactStep::Legacy => "Legacy",
                    ExactStep::TriangleFree => "TriangleFree",
                },
                match exact.result {
                    Ok(diagnostics) => format!("Ok(flat_status={})", diagnostics.flat_status),
                    Err(error) => format!("{error:?}"),
                },
            ),
        };
        let _ = writeln!(out, "{}\t{rung}\t{reason}\t{step}\t{exact}", path.name);
    }
    out
}

fn required(variable: &str) -> String {
    env::var(variable).unwrap_or_else(|_| panic!("{variable} is required"))
}

#[test]
#[ignore = "AL-U2 rung record; run only by pnpm test:p3-fill-identity --revision-change"]
fn dump_rungs() {
    let mut chunks = b0_paths(&required("P3_B0R_B0_CORPUS"));
    chunks.extend(random_paths(&required("P3_B0R_RANDOM_CORPUS")));
    chunks.extend(random_paths(&required("P3_FILL_LADDER_CORPUS")));
    let threads = env::var("P3_B0R_THREADS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| thread::available_parallelism().map_or(1, usize::from))
        .max(1);
    let next = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<String>>> = chunks.iter().map(|_| Mutex::new(None)).collect();
    thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                thread::Builder::new()
                    .stack_size(THREAD_STACK_BYTES)
                    .spawn_scoped(scope, || loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(chunk) = chunks.get(index) else {
                            break;
                        };
                        let text = run_chunk(chunk);
                        *results[index].lock().expect("result slot") = Some(text);
                    })
                    .expect("spawn rung worker")
            })
            .collect();
        for worker in workers {
            worker.join().expect("rung worker panicked");
        }
    });
    let mut output = String::new();
    for slot in results {
        output.push_str(&slot.into_inner().expect("result slot").expect("chunk ran"));
    }
    let path = required("P3_FILL_LADDER_RUNGS");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create the exclusive rung record");
    file.write_all(output.as_bytes())
        .expect("write the rung record");
    println!(
        "p3-fill-ladder rungs: {} chunks, {} paths, {threads} threads",
        chunks.len(),
        output.lines().count()
    );
}

/// The debug layer's check of the record format on two real paths: F01 takes rung 0, and
/// F04 (two coincident squares) falls back with `CROSSING` to the exact cascade.
#[test]
fn rung_lines_name_the_rung_reason_and_exact_step() {
    let square: Vec<u8> = [0.0f64, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let request = FillRequest {
        request_id: 0,
        rule: LineFillRule::Nonzero,
        exponent: B0_EXPONENT,
    };
    let chunk = [
        RungPath {
            name: "rnd/T/0000".to_owned(),
            request,
            verbs: vec![0, 1, 1, 1, 3],
            point_bytes: square.clone(),
        },
        RungPath {
            name: "rnd/T/0001".to_owned(),
            request,
            verbs: vec![0, 1, 1, 1, 3, 0, 1, 1, 1, 3],
            point_bytes: [square.clone(), square].concat(),
        },
    ];
    let text = run_chunk(&chunk);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "rnd/T/0000\t0\t-\t-\t-");
    assert!(
        lines[1].starts_with("rnd/T/0001\t1\tCROSSING\t"),
        "{}",
        lines[1]
    );
}
