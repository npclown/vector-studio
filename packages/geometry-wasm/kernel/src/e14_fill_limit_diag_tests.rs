//! D9 E14 diagnostic: which fill cap a path hits. Test-only and functional; it changes no
//! output and writes no file.
//!
//! One input line per path: `id`, tolerance exponent, rule (`nonzero` or `evenodd`),
//! comma-separated verbs and comma-separated hexadecimal binary64 scalars, tab-separated. Each
//! path runs `build_path`'s stage-4 order on the fill-v0 caps: rung 0, then the exact cascade
//! (`attempt`, then `attempt_triangle_free` after `KnotMismatch` or `Unresolved`).
//! Stages 1-3 of `build_path` and its checks after a successful `attempt` (`map_flat_status`,
//! refinement, the empty check) are not modelled, and `attempt` runs even when rung 0 meshes;
//! a caller reads `attempt`'s result only after a rung-0 fallback. One JSON
//! object per path is printed with the S1 sizing plan's flat verb count, rung 0's reason and
//! each exact step's kernel error, unmapped, and the wall time of rung 0 and of the first exact
//! step (a diagnostic, not performance evidence). Since E16-U1 (fill-v0+r4) it also prints the
//! exact rung as `build_path` runs it, with E16-K2's retries (`exact_cascade`): the result,
//! the refinement depth, and when the retries ran and none succeeded, the last retry's depth
//! and error (`retryStop`), which the cascade at e's result does not show. Since E14-U2
//! (fill-v0+r5) it also runs the request through a reserved two-tier engine (`build_one`, all
//! of `build_path`) and prints that result's outcome, exact tier, unmapped error and the
//! rounded arrangement's charged work, `null` when the last attempt did not run it (`engine`, `tier`, `engineError`, `work`, `engineUs`), the
//! input to X-K3's work cap and X-A7's per-stratum report.
use std::thread;
use std::time::Instant;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{CubicFillError, CubicFillWorkspace, MAX_EXACT_FLAT_COMMANDS};
use crate::fill_export::{tolerances, FillRequest, FillScratch, FILL_V0_LIMITS};
use crate::fill_filter_tests::THREAD_STACK_BYTES;
use crate::fill_ladder::{exact_cascade, FillLadder};
use crate::line_fill::LineFillRule;
use crate::p3_b0r_identity::read_file;
use crate::simple_cubic_topology::TopologyError;

fn outcome<T>(result: &Result<T, CubicFillError>) -> String {
    match result {
        Ok(_) => "OK".to_owned(),
        Err(error) => format!("{error:?}"),
    }
}

/// The `retryStop` field (E16 contract section 4 item 4): `-`, or `<k>:<error>` with the
/// last retry's decimal depth and its unmapped error in `Debug` form.
pub(crate) fn retry_stop_field(stop: Option<(u32, CubicFillError)>) -> String {
    stop.map_or_else(
        || "-".to_owned(),
        |(depth, error)| format!("{depth}:{error:?}"),
    )
}

fn run() {
    let text = String::from_utf8(read_file("E14_FILL_INPUT")).expect("UTF-8 input");
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).unwrap();
    let (mut scratch, _) =
        FillScratch::reserve(FILL_V0_LIMITS, crate::fill_ladder::MAX_BOUNDARY_RECORDS).unwrap();
    let mut ladder = FillLadder::for_tests();
    let mut engine = crate::e14u2_fill_large_tier_tests::engine();
    println!("E14_FILL_DIAG_BEGIN");
    for row in text.lines().filter(|row| !row.is_empty()) {
        let fields: Vec<&str> = row.split('\t').collect();
        assert_eq!(fields.len(), 5, "E14 input row");
        let exponent: i32 = fields[1].parse().expect("exponent");
        let rule = match fields[2] {
            "nonzero" => LineFillRule::Nonzero,
            "evenodd" => LineFillRule::Evenodd,
            other => panic!("rule {other}"),
        };
        let verbs: Vec<u8> = fields[3]
            .split(',')
            .map(|value| value.parse().expect("verb"))
            .collect();
        let point_bytes: Vec<u8> = fields[4]
            .split(',')
            .flat_map(|value| {
                f64::from_bits(u64::from_str_radix(value, 16).expect("scalar bits")).to_le_bytes()
            })
            .collect();
        let request = FillRequest {
            request_id: 0,
            rule,
            exponent,
        };
        let clock = Instant::now();
        let fast = ladder.fast_rung(&mut workspace, request, &verbs, &point_bytes, &mut scratch);
        let fast_us = clock.elapsed().as_micros();
        let sizing = workspace.diagnostics().sizing_plan;
        let (flatten, topology) = tolerances(exponent);
        let input = PathInput::from_test_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: flatten,
            },
            &verbs,
            &point_bytes,
        );
        let clock = Instant::now();
        let legacy = workspace.attempt(input, rule, topology, MAX_EXACT_FLAT_COMMANDS);
        let legacy_us = clock.elapsed().as_micros();
        let stats = workspace.topology_stats();
        let triangle_free = if matches!(
            legacy,
            Err(CubicFillError::Topology(
                TopologyError::KnotMismatch | TopologyError::Unresolved
            ))
        ) {
            Some(outcome(&workspace.attempt_triangle_free(
                input,
                rule,
                topology,
                MAX_EXACT_FLAT_COMMANDS,
            )))
        } else {
            None
        };
        let refined = exact_cascade(&mut workspace, request, &verbs, &point_bytes);
        let retry_stop = retry_stop_field(refined.stop);
        let clock = Instant::now();
        let record = engine
            .build_one(request, &verbs, &point_bytes)
            .expect("reserved engine")
            .expect("no self-check failure");
        let engine_us = clock.elapsed().as_micros();
        // The rounded statistics persist across requests, so the work is printed only when this
        // request's last attempt ran the rounded arrangement; otherwise `null`.
        let built = engine.workspace().expect("workspace");
        let work = if built.diagnostics().rounded_invoked {
            built.rounded_stats().work_units.to_string()
        } else {
            "null".to_owned()
        };
        println!(
            "{{\"id\":\"{}\",\"exponent\":{exponent},\"flatStatus\":{},\"flatVerbs\":{},\"flatPoints\":{},\"fast\":\"{}\",\"legacy\":\"{}\",\"triangleFree\":\"{}\",\"exact\":\"{}\",\"depth\":{},\"retryStop\":\"{}\",\"fastUs\":{fast_us},\"legacyUs\":{legacy_us},\"topologyStats\":\"{:?}\",\"engine\":\"{:?}\",\"tier\":\"{:?}\",\"engineError\":\"{:?}\",\"work\":{work},\"engineUs\":{engine_us}}}",
            fields[0],
            sizing.status,
            sizing.verb_count,
            sizing.point_count,
            match fast {
                Ok(()) => "MESH".to_owned(),
                Err(reason) => reason.code().to_owned(),
            },
            outcome(&legacy),
            triangle_free.unwrap_or_else(|| "-".to_owned()),
            outcome(&refined.result),
            refined.depth,
            retry_stop,
            stats,
            record.outcome,
            record.tier,
            record.error,
        );
    }
    println!("E14_FILL_DIAG_END");
}

#[test]
#[ignore = "E14 fill cap diagnostic; run by hand with E14_FILL_INPUT"]
fn e14_fill_limit_diag() {
    thread::Builder::new()
        .stack_size(THREAD_STACK_BYTES)
        .spawn(run)
        .unwrap()
        .join()
        .unwrap();
}
