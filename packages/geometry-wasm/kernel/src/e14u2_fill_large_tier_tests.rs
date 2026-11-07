//! D9 rendering-track item E14, unit E14-U2 X-U1
//! (`docs/plans/d9-e14-u2-fill-exact-edge-cap-contract.md` section 9): the fill exact rung's
//! large tier (`fill-v0+r5`). The fixtures X-F1 to X-F10 are read natively through `build_path`
//! (X-A2), with the rung, the tier and the kernel error; the seeded defects X-D1 to X-D5 run
//! through the `cfg(test)` limits override `CubicFillWorkspace::e14u2_override_large` (X-A5).
//!
//! X-F2 and X-F3 are the user's pen paths node-3 and node-8 from the editor (2026-11-06), in
//! document coordinates (unit path points times the frame plus its origin), at zoom 1.

use crate::cubic_fill::{
    with_small_paths_in_large_tier, CubicFillError, CubicFillWorkspace, FillTier, LargeTierLimits,
    MAX_EDGE_OWNERS, MAX_LARGE_EDGE_OWNERS,
};
use crate::engine::BATCH_OK;
use crate::fill_export::{
    tolerances, BuiltPath, FillEngine, FillRequest, PathOutcome, FILL_PATH_UNSUPPORTED_GEOMETRY,
    FILL_PATH_WORK_LIMIT, FILL_V0_LARGE_TIER, FILL_V0_LIMITS,
};
use crate::fill_ladder::Rung;
use crate::line_fill::LineFillRule;
use crate::rounded_line_fill::RoundedFillError;
use crate::simple_cubic_topology::{TopologyError, TopologyLimits};
use crate::stroke_outline_tests::PathSpec;

/// X-F2: the user's node-3 (619 × 410 px, 28 cubics and a line).
pub(crate) fn node3() -> PathSpec {
    PathSpec::new()
        .m(376.0, 114.40000915527344)
        .c([
            357.60003662109375,
            130.40000915527344,
            346.4000244140625,
            110.39999389648438,
            326.4000244140625,
            140.0,
        ])
        .c([
            306.4000244140625,
            169.60000610351562,
            308.79998779296875,
            172.00001525878906,
            304.79998779296875,
            189.60000610351562,
        ])
        .c([
            300.79998779296875,
            207.1999969482422,
            302.3999938964844,
            218.39999389648438,
            284.0,
            233.60000610351562,
        ])
        .c([
            265.6000061035156,
            248.80001831054688,
            256.8000183105469,
            266.3999938964844,
            255.20001220703125,
            276.0,
        ])
        .c([
            253.60000610351562,
            285.6000061035156,
            226.4000244140625,
            243.99996948242188,
            263.20001220703125,
            286.3999938964844,
        ])
        .c([
            300.0,
            328.8000183105469,
            356.79998779296875,
            288.79998779296875,
            339.20001220703125,
            338.3999938964844,
        ])
        .c([
            321.60003662109375,
            388.0,
            317.60003662109375,
            392.0,
            329.60003662109375,
            396.0,
        ])
        .c([
            341.60003662109375,
            400.0,
            275.199951171875,
            445.6000061035156,
            376.79998779296875,
            416.0,
        ])
        .c([
            478.4000244140625,
            386.3999938964844,
            567.9999389648438,
            337.6000061035156,
            568.7999877929688,
            332.0,
        ])
        .c([
            569.6000366210938,
            326.3999938964844,
            523.2000122070312,
            276.0,
            564.0,
            256.0,
        ])
        .c([
            604.7999877929688,
            236.0,
            643.2000732421875,
            193.60000610351562,
            653.6000366210938,
            221.60000610351562,
        ])
        .c([
            664.0,
            249.60000610351562,
            652.7999877929688,
            328.8000183105469,
            623.2000122070312,
            364.8000183105469,
        ])
        .c([
            593.6000366210938,
            400.8000183105469,
            594.4000244140625,
            416.8000183105469,
            567.2000122070312,
            416.8000183105469,
        ])
        .c([
            540.0,
            416.8000183105469,
            541.6000366210938,
            396.0,
            515.2000122070312,
            305.6000061035156,
        ])
        .c([
            488.79998779296875,
            215.20001220703125,
            502.39996337890625,
            170.40000915527344,
            516.7999877929688,
            168.8000030517578,
        ])
        .c([
            531.2000122070312,
            167.1999969482422,
            516.7999877929688,
            165.60000610351562,
            580.0,
            161.60000610351562,
        ])
        .c([
            643.2000122070312,
            157.60000610351562,
            845.5999755859375,
            211.1999969482422,
            720.7999877929688,
            176.0,
        ])
        .c([
            596.0,
            140.8000030517578,
            512.0000610351562,
            76.0,
            462.4000244140625,
            108.80000305175781,
        ])
        .c([
            412.79998779296875,
            141.60000610351562,
            412.0,
            112.80001831054688,
            404.0,
            158.40000915527344,
        ])
        .c([
            396.0,
            204.0,
            376.00006103515625,
            202.4000244140625,
            406.4000244140625,
            212.80001831054688,
        ])
        .c([
            436.79998779296875,
            223.20001220703125,
            464.00006103515625,
            273.60003662109375,
            482.4000244140625,
            220.80001831054688,
        ])
        .c([
            500.79998779296875,
            168.0,
            546.4000244140625,
            153.60000610351562,
            502.4000244140625,
            120.80000305175781,
        ])
        .c([
            458.4000244140625,
            88.0,
            458.4000244140625,
            85.5999984741211,
            442.4000244140625,
            80.0,
        ])
        .c([
            426.4000244140625,
            74.4000015258789,
            420.00006103515625,
            36.0,
            397.60003662109375,
            67.20000457763672,
        ])
        .c([
            375.20001220703125,
            98.40000915527344,
            364.0,
            102.40000915527344,
            375.20001220703125,
            101.60000610351562,
        ])
        .c([
            386.4000244140625,
            100.80000305175781,
            402.4000244140625,
            99.20001220703125,
            395.20001220703125,
            106.40000915527344,
        ])
        .c([
            388.0,
            113.60000610351562,
            374.4000244140625,
            118.40000915527344,
            374.4000244140625,
            118.40000915527344,
        ])
        .l(379.20001220703125, 112.0)
        .c([
            379.20001220703125,
            112.0,
            394.39996337890625,
            98.40000915527344,
            376.0,
            114.40000915527344,
        ])
        .z()
}

/// X-F3: the user's node-8 (1,076 × 557 px, 16 cubics).
pub(crate) fn node8() -> PathSpec {
    PathSpec::new()
        .m(458.4000244140625, 170.40000915527344)
        .c([
            389.60003662109375,
            186.40000915527344,
            216.0,
            170.39999389648438,
            152.0,
            220.0,
        ])
        .c([
            88.0,
            269.6000061035156,
            75.20004272460938,
            308.79998779296875,
            136.80001831054688,
            350.3999938964844,
        ])
        .c([
            198.39999389648438,
            392.0,
            280.00006103515625,
            420.8000183105469,
            286.4000244140625,
            437.6000061035156,
        ])
        .c([
            292.79998779296875,
            454.3999938964844,
            315.20001220703125,
            435.20007324218756,
            247.20001220703125,
            497.60003662109375,
        ])
        .c([
            179.20001220703125,
            560.0,
            -47.20001220703125,
            569.6000366210938,
            257.6000061035156,
            571.2000122070312,
        ])
        .c([
            562.4000244140625,
            572.7999877929688,
            616.0,
            631.2000122070312,
            595.2000122070312,
            531.2000122070312,
        ])
        .c([
            574.4000244140625,
            431.20001220703125,
            446.3999633789063,
            390.3999938964844,
            484.0,
            312.0,
        ])
        .c([
            521.6000366210938,
            233.60000610351562,
            572.0000610351562,
            153.59999084472656,
            622.4000244140625,
            160.0,
        ])
        .c([
            672.7999877929688,
            166.40000915527344,
            679.199951171875,
            74.4000244140625,
            772.7999877929688,
            202.40000915527344,
        ])
        .c([
            866.4000244140625,
            330.3999938964844,
            1028.7999877929688,
            324.0000305175781,
            848.0,
            367.20001220703125,
        ])
        .c([
            667.2000122070312,
            410.3999938964844,
            761.6000366210938,
            420.79998779296875,
            594.4000244140625,
            394.3999938964844,
        ])
        .c([
            427.20001220703125,
            368.0,
            400.79998779296875,
            368.79998779296875,
            407.20001220703125,
            322.3999938964844,
        ])
        .c([
            413.60003662109375,
            276.0,
            417.60003662109375,
            244.80001831054688,
            431.20001220703125,
            236.80001831054688,
        ])
        .c([
            444.7999877929687,
            228.8000183105469,
            451.99993896484375,
            227.99998474121094,
            452.79998779296875,
            211.1999969482422,
        ])
        .c([
            453.60003662109375,
            194.40000915527344,
            452.79998779296875,
            172.0,
            452.79998779296875,
            172.0,
        ])
        .c([
            452.79998779296875,
            172.0,
            527.2000122070312,
            154.40000915527344,
            458.4000244140625,
            170.40000915527344,
        ])
        .z()
}

pub(crate) fn engine() -> FillEngine {
    let mut engine = FillEngine::new();
    assert_eq!(engine.reserve(1 << 16, 1 << 20), BATCH_OK);
    engine
}

pub(crate) fn built(
    engine: &mut FillEngine,
    path: &PathSpec,
    rule: LineFillRule,
    exponent: i32,
) -> BuiltPath {
    engine
        .build_one(
            FillRequest {
                request_id: 0,
                rule,
                exponent,
            },
            &path.verbs,
            &path.bytes(),
        )
        .expect("reserved engine")
        .expect("no self-check failure")
}

/// The flat edge count of the S1 prefix at `exponent` with rung 0's caps.
pub(crate) fn flat_edges(path: &PathSpec, exponent: i32) -> Result<usize, String> {
    let mut workspace =
        crate::cubic_fill::CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let bytes = path.bytes();
    let input = crate::codec::PathInput::from_test_parts(
        crate::codec::Request {
            request_id: 0,
            source_epoch: 0,
            source_revision: 0,
            tolerance: tolerances(exponent).0,
        },
        &path.verbs,
        &bytes,
    );
    let capacity = workspace.fast_flat_commands();
    workspace
        .prepare_prefix(input, capacity)
        .map(|view| view.owners.len())
        .map_err(|failure| format!("{failure:?}"))
}

pub(crate) fn scaled(path: &PathSpec, factor: f64) -> PathSpec {
    PathSpec {
        verbs: path.verbs.clone(),
        points: path.points.iter().map(|value| value * factor).collect(),
    }
}

/// One row of the measurement: outcome, rung, tier, kernel error, the large tier's charged work
/// and crossing records, and the native time.
fn describe(engine: &mut FillEngine, path: &PathSpec, rule: LineFillRule, exponent: i32) -> String {
    let start = std::time::Instant::now();
    let record = built(engine, path, rule, exponent);
    let elapsed = start.elapsed();
    let workspace = engine.workspace().expect("workspace");
    format!(
        "{:?} rung {:?} reason {:?} tier {:?} error {:?} depth {} work {} crossings {} scan {} \
         {:.1} ms",
        record.outcome,
        record.rung,
        record.reason,
        record.tier,
        record.error,
        record.depth,
        workspace.rounded_stats().work_units,
        workspace.crossing_count(),
        workspace.crossing_scan(),
        elapsed.as_secs_f64() * 1_000.0
    )
}

#[test]
#[ignore = "E14-U2 measurement, run by hand for the evidence"]
fn e14u2_measure_user_paths() {
    let mut engine = engine();
    for (name, path) in [("node-3", node3()), ("node-8", node8())] {
        for exponent in [0, -1, -2, -3, -4, -5] {
            println!(
                "{name} e {exponent}: edges {:?}: {}",
                flat_edges(&path, exponent),
                describe(&mut engine, &path, LineFillRule::Nonzero, exponent)
            );
        }
    }
}

/// Scales `path` by a factor found by bisection so that its flat edge count at `exponent` is
/// `target`, or the closest factor found.
fn search_scale(path: &PathSpec, exponent: i32, target: usize) -> Option<f64> {
    let (mut low, mut high) = (0.01f64, 100.0f64);
    for _ in 0..200 {
        let middle = (low * high).sqrt();
        match flat_edges(&scaled(path, middle), exponent) {
            Ok(edges) if edges == target => return Some(middle),
            Ok(edges) if edges < target => low = middle,
            _ => high = middle,
        }
    }
    None
}

#[test]
#[ignore = "E14-U2 fixture search, run by hand"]
fn e14u2_search_fixture_scales() {
    for (name, path) in [("node-3", node3()), ("node-8", node8())] {
        for (exponent, target) in [
            (0, MAX_EDGE_OWNERS),
            (0, MAX_EDGE_OWNERS + 1),
            (-4, MAX_LARGE_EDGE_OWNERS),
            (-4, MAX_LARGE_EDGE_OWNERS + 1),
        ] {
            let factor = search_scale(&path, exponent, target);
            println!(
                "{name} e {exponent} target {target}: factor {factor:?} bits {:?}",
                factor.map(f64::to_bits)
            );
        }
    }
}

/// The `fill-v0+r4` reference: an engine whose workspace and scratch have no large tier.
pub(crate) fn r4_engine() -> FillEngine {
    let mut engine = FillEngine::new();
    engine.hooks().small_tier_only = true;
    assert_eq!(engine.reserve(1 << 16, 1 << 20), BATCH_OK);
    engine
}

/// X-F1 and X-F1b: node-3 scaled so that it has exactly E and E + 1 flat edges at e = 0, and
/// X-F7: exactly EX and EX + 1 at e = -4. The factors were found by bisection
/// (`e14u2_search_fixture_scales`); each point is one binary64 product, the same on every
/// platform.
const X_F1_SCALE: u64 = 4_607_832_927_290_624_918;
const X_F1B_SCALE: u64 = 4_607_867_813_692_433_366;
const X_F7_SCALE: u64 = 4_608_245_551_170_185_427;
const X_F7B_SCALE: u64 = 4_608_248_687_529_219_662;

fn node3_scaled(bits: u64) -> PathSpec {
    scaled(&node3(), f64::from_bits(bits))
}

/// X-F7: node-3 with exactly EX flat edges at e = -4.
pub(crate) fn x_f7() -> PathSpec {
    node3_scaled(X_F7_SCALE)
}

/// X-F9: a self-crossing line-only path of E + 1 segments: a zigzag between x = 0 and 100,
/// one unit per segment, whose closing edge crosses every segment.
fn x_f9() -> PathSpec {
    let mut path = PathSpec::new().m(0.0, 0.0);
    for index in 1..=MAX_EDGE_OWNERS + 1 {
        path = path.l(100.0 * (index % 2) as f64, index as f64);
    }
    path.z()
}

/// X-F10: a small path past the small tier's 32-crossing ceiling: a 17-segment zigzag across a
/// thin band (34 crossings with its two long edges), closed below the band by a cubic so the
/// exact rung builds a topology certificate.
fn x_f10() -> PathSpec {
    let mut path = PathSpec::new().m(0.0, -20.0);
    for index in 1..=17 {
        let y = if index % 2 == 1 { 20.0 } else { -20.0 };
        path = path.l(5.0 * index as f64, y);
    }
    path.l(85.0, -40.0)
        .c([60.0, -60.0, 25.0, -60.0, 0.0, -40.0])
        .z()
        .m(-10.0, -1.0)
        .l(200.0, -1.0)
        .l(200.0, 1.0)
        .l(-10.0, 1.0)
        .z()
}

fn e14_f5() -> PathSpec {
    let fixture = crate::e14_fill_rung0_tests::f5();
    PathSpec {
        verbs: fixture.verbs,
        points: fixture.points,
    }
}

fn e14_f7() -> PathSpec {
    let fixture = crate::e14_fill_rung0_tests::f7();
    PathSpec {
        verbs: fixture.verbs,
        points: fixture.points,
    }
}

fn e16_f8() -> (PathSpec, LineFillRule, i32) {
    let fixture = crate::e16_fill_remedy_tests::corpus("E16-F8");
    (
        PathSpec {
            verbs: fixture.verbs,
            points: fixture.points,
        },
        fixture.rule,
        fixture.exponent,
    )
}

/// The fixture table of section 9 (X-A2): (id, path, rule, exponent).
fn fixtures() -> Vec<(&'static str, PathSpec, LineFillRule, i32)> {
    let nonzero = LineFillRule::Nonzero;
    let (f8, f8_rule, f8_exponent) = e16_f8();
    let mut rows = vec![
        ("X-F1", node3_scaled(X_F1_SCALE), nonzero, 0),
        ("X-F1b", node3_scaled(X_F1B_SCALE), nonzero, 0),
    ];
    for exponent in [-2, -3, -4] {
        rows.push(("X-F2", node3(), nonzero, exponent));
    }
    for exponent in [-2, -3, -4] {
        rows.push(("X-F3", node8(), nonzero, exponent));
    }
    rows.extend([
        ("X-F4", e14_f5(), LineFillRule::Evenodd, -5),
        ("X-F5", e14_f7(), nonzero, -3),
        ("X-F6", node3(), nonzero, -5),
        ("X-F7", x_f7(), nonzero, -4),
        ("X-F7b", node3_scaled(X_F7B_SCALE), nonzero, -4),
        ("X-F8", f8, f8_rule, f8_exponent),
        ("X-F9", x_f9(), nonzero, -3),
        ("X-F10", x_f10(), nonzero, -3),
    ]);
    rows
}

/// The expected `r5` record of each fixture: outcome, tier and kernel error.
fn expected(id: &str) -> (PathOutcome, Option<FillTier>, Option<CubicFillError>) {
    let mesh = PathOutcome::Mesh;
    let work_limit = PathOutcome::Status(FILL_PATH_WORK_LIMIT);
    let large = Some(FillTier::Large);
    let small = Some(FillTier::Small);
    match id {
        // At exactly E flat edges node-3's crossings take the rounded arrangement past the small
        // tier's 2E events, as at `r4`: the small-tier control is identical, a stop.
        "X-F1" => (
            work_limit,
            small,
            Some(CubicFillError::Rounded(RoundedFillError::EventLimit)),
        ),
        "X-F1b" | "X-F2" | "X-F3" | "X-F5" => (mesh, large, None),
        // At exactly EX the same event cap stops the large tier (a listed stop, section 9).
        "X-F7" => (
            work_limit,
            large,
            Some(CubicFillError::Rounded(RoundedFillError::EventLimit)),
        ),
        "X-F4" | "X-F6" => (work_limit, large, Some(CubicFillError::CommandLimit)),
        // EX + 1 edges fit the large tier's EX + 8 commands and stop at the owner cap.
        "X-F7b" => (work_limit, large, Some(CubicFillError::OwnerLimit)),
        "X-F8" => (
            PathOutcome::Status(FILL_PATH_UNSUPPORTED_GEOMETRY),
            small,
            Some(CubicFillError::Topology(TopologyError::Unresolved)),
        ),
        "X-F9" => (work_limit, small, Some(CubicFillError::SourceLimit)),
        "X-F10" => (
            work_limit,
            small,
            Some(CubicFillError::Topology(TopologyError::WorkLimit)),
        ),
        other => panic!("no fixture {other}"),
    }
}

/// X-A2: the fixture table through `build_path`, with the flat edge counts of section 9, and
/// the `r4` reference: every small-tier fixture is identical to `r4`, every large one was
/// `work-limit` at `r4`.
#[test]
fn e14u2_fixture_table_holds() {
    let mut engine = engine();
    let mut reference = r4_engine();
    for (id, path, rule, exponent) in fixtures() {
        let edges = flat_edges(&path, exponent);
        match id {
            "X-F1" => assert_eq!(edges, Ok(MAX_EDGE_OWNERS), "{id}"),
            "X-F1b" => assert_eq!(edges, Ok(MAX_EDGE_OWNERS + 1), "{id}"),
            "X-F7" => assert_eq!(edges, Ok(MAX_LARGE_EDGE_OWNERS), "{id}"),
            "X-F7b" => assert_eq!(edges, Ok(MAX_LARGE_EDGE_OWNERS + 1), "{id}"),
            _ => {}
        }
        let record = built(&mut engine, &path, rule, exponent);
        let old = built(&mut reference, &path, rule, exponent);
        println!(
            "{id} e {exponent}: edges {edges:?}; r5 {:?} {:?} {:?} {:?}; r4 {:?} {:?}",
            record.outcome, record.rung, record.tier, record.error, old.outcome, old.error
        );
        assert_eq!(record.rung, Some(Rung::Exact), "{id} e {exponent}");
        let (outcome, tier, error) = expected(id);
        assert_eq!(
            (record.outcome, record.tier, record.error),
            (outcome, tier, error),
            "{id} e {exponent}"
        );
        if tier == Some(FillTier::Small) {
            assert_eq!(record, old, "{id} e {exponent}: small tier equals r4");
        } else {
            assert_eq!(
                old.outcome,
                PathOutcome::Status(FILL_PATH_WORK_LIMIT),
                "{id} e {exponent}: r4"
            );
        }
    }
}

/// Runs node-3 at e = -2 (X-F2) on an engine whose large tier is `large`.
fn x_f2_with(large: LargeTierLimits) -> BuiltPath {
    let mut engine = engine();
    engine
        .workspace_mut()
        .expect("workspace")
        .e14u2_override_large(large);
    built(&mut engine, &node3(), LineFillRule::Nonzero, -2)
}

/// X-G3: the two-tier workspace's growth over the small-only one.
fn growth(large: LargeTierLimits) -> Result<usize, CubicFillError> {
    let small = CubicFillWorkspace::new(FILL_V0_LIMITS)?.allocated_bytes();
    let both = CubicFillWorkspace::new_two_tier(FILL_V0_LIMITS, large)?.allocated_bytes();
    Ok(both - small)
}

const X_G3_GROWTH: usize = 16 * 1024 * 1024;
const MOVED_TOPOLOGY_SCRATCH: usize = 4_662_016 - 4_514_304;

#[test]
fn e14u2_x_g3_memory_growth_is_bounded() {
    let grown = growth(FILL_V0_LARGE_TIER).expect("two-tier workspace");
    println!("E14-U2 X-G3: the exact workspace grows by {grown} bytes");
    assert!(grown <= X_G3_GROWTH, "{grown}");
    // `r4_engine` is the r5 small-only engine: it already holds the topology scratch that moved
    // from the stack to the heap in both tiers (the bridge workspace's pin, 4,514,304 to
    // 4,662,016 bytes), so the growth over the real r4 adds it back.
    let small = r4_engine().heap_bytes() - MOVED_TOPOLOGY_SCRATCH;
    let both = engine().heap_bytes();
    println!("E14-U2 X-G3: fill engine reserved bytes {small} at r4, {both} at r5");
    assert!(both - small <= X_G3_GROWTH);
}

/// X-D1: a quadratic large-tier section budget fails X-G3's byte check.
#[test]
fn e14u2_x_d1_quadratic_sections_fail_the_byte_check() {
    let mut defect = FILL_V0_LARGE_TIER;
    let edges = MAX_LARGE_EDGE_OWNERS;
    defect.rounded.max_sections = 2 * edges * edges + 2 * edges;
    defect.rounded.max_bytes = 256 * 1024 * 1024;
    assert!(growth(defect).is_ok_and(|grown| grown > X_G3_GROWTH) || growth(defect).is_err());
}

/// X-D2: the large tier's topology leaf cap at 256 stops X-F2 in the certificate.
#[test]
fn e14u2_x_d2_small_leaf_cap_stops_x_f2() {
    let mut defect = FILL_V0_LARGE_TIER;
    defect.topology = TopologyLimits::default();
    let record = x_f2_with(defect);
    assert_eq!(
        (record.outcome, record.error),
        (
            PathOutcome::Status(FILL_PATH_WORK_LIMIT),
            Some(CubicFillError::Topology(TopologyError::WorkLimit))
        )
    );
}

/// X-D3: a work cap below X-F2's measured work stops it.
#[test]
fn e14u2_x_d3_low_work_cap_stops_x_f2() {
    let mut engine = engine();
    let record = built(&mut engine, &node3(), LineFillRule::Nonzero, -2);
    assert_eq!(record.outcome, PathOutcome::Mesh);
    let work = engine
        .workspace()
        .expect("workspace")
        .rounded_stats()
        .work_units;
    let mut defect = FILL_V0_LARGE_TIER;
    defect.rounded.max_work = work - 1;
    let record = x_f2_with(defect);
    assert_eq!(
        (record.outcome, record.error),
        (
            PathOutcome::Status(FILL_PATH_WORK_LIMIT),
            Some(CubicFillError::Rounded(RoundedFillError::WorkLimit))
        )
    );
}

/// X-D4: small paths run in the large tier change X-F10, which stops at the small tier's
/// 32-crossing ceiling.
#[test]
fn e14u2_x_d4_small_paths_in_the_large_tier_change_x_f10() {
    let mut engine = engine();
    let path = x_f10();
    let record = built(&mut engine, &path, LineFillRule::Nonzero, -3);
    assert_eq!(
        record.error,
        Some(CubicFillError::Topology(TopologyError::WorkLimit))
    );
    assert_eq!(engine.workspace().expect("workspace").crossing_count(), 32);
    let defect =
        with_small_paths_in_large_tier(|| built(&mut engine, &path, LineFillRule::Nonzero, -3));
    println!("E14-U2 X-D4: X-F10 in the large tier {defect:?}");
    assert_eq!(defect.tier, Some(FillTier::Large));
    assert_ne!(
        (defect.outcome, defect.error),
        (record.outcome, record.error)
    );
}

/// X-D5: with the crossing scan's cap lowered below X-F2's charge, X-F2 stops at `ScanLimit`
/// (`work-limit`); uncapped, it meshes, so an uncapped large tier is caught. The pair loop runs
/// in the production `Sweep` mode.
#[test]
fn e14u2_x_d5_lowered_scan_cap_returns_scan_limit() {
    let mut engine = engine();
    built(&mut engine, &node3(), LineFillRule::Nonzero, -2);
    let charged = engine.workspace().expect("workspace").crossing_scan();
    assert!(charged > 0);
    let mut lowered = FILL_V0_LARGE_TIER;
    lowered.crossing_scan = charged - 1;
    let record = x_f2_with(lowered);
    assert_eq!(
        (record.outcome, record.error),
        (
            PathOutcome::Status(FILL_PATH_WORK_LIMIT),
            Some(CubicFillError::Topology(TopologyError::ScanLimit))
        )
    );
    let mut uncapped = FILL_V0_LARGE_TIER;
    uncapped.crossing_scan = u64::MAX;
    assert_eq!(x_f2_with(uncapped).outcome, PathOutcome::Mesh);
}

/// The WASM fixtures of X-A3 and X-A6 (`tests/fixtures/e14u2-fill-large-tier-v1.txt`, read by
/// `tests/geometry/e14u2-fill-large-tier.test.ts`): the same literals as the native table,
/// one request per line. `E14U2_WRITE_FIXTURES=1` rewrites the file; otherwise it must match.
#[test]
fn e14u2_wasm_fixture_file_matches_the_literals() {
    let mut text = String::from(
        "# D9 E14-U2 X-A3/X-A6 fixtures (docs/plans/d9-e14-u2-fill-exact-edge-cap-contract.md \
         section 9), written by\n# e14u2_wasm_fixture_file_matches_the_literals. Columns: \
         fixture, exponent, rule, verbs, scalars (f64 bits).\n",
    );
    for (id, path, rule, exponent) in fixtures() {
        if !matches!(id, "X-F1b" | "X-F2" | "X-F3" | "X-F5" | "X-F7") {
            continue;
        }
        let rule = match rule {
            LineFillRule::Nonzero => "nonzero",
            LineFillRule::Evenodd => "evenodd",
        };
        let verbs: Vec<String> = path.verbs.iter().map(u8::to_string).collect();
        let scalars: Vec<String> = path
            .points
            .iter()
            .map(|value| format!("{:016x}", value.to_bits()))
            .collect();
        text.push_str(&format!(
            "{id}/e{exponent}\t{exponent}\t{rule}\t{}\t{}\n",
            verbs.join(","),
            scalars.join(",")
        ));
    }
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/fixtures/e14u2-fill-large-tier-v1.txt");
    if std::env::var("E14U2_WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&file, &text).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
}

/// X-F9b (review follow-up): a self-crossing line-only path that stops at a prefix cap under the
/// line-only caps. 64 open bowtie contours of 4 segments each are 256 segments (the line cap)
/// but 320 flat edges with their closing edges, so the exact prefix stops at `OwnerLimit`. A
/// line-only path must not switch to the large tier (`caps == self.caps` in `attempt_body`):
/// the record is identical to `r4` and stays small.
fn x_f9b() -> PathSpec {
    let mut path = PathSpec::new();
    for index in 0..64 {
        let x = 12.0 * f64::from(index % 8);
        let y = 12.0 * f64::from(index / 8);
        path = path
            .m(x, y)
            .l(x + 10.0, y + 10.0)
            .l(x + 10.0, y)
            .l(x, y + 10.0)
            .l(x + 5.0, y + 12.0);
    }
    path
}

#[test]
fn e14u2_x_f9b_line_only_prefix_stop_stays_small() {
    let path = x_f9b();
    let record = built(&mut engine(), &path, LineFillRule::Nonzero, -3);
    let old = built(&mut r4_engine(), &path, LineFillRule::Nonzero, -3);
    println!(
        "X-F9b: r5 {:?} {:?} {:?} {:?}",
        record.outcome, record.rung, record.tier, record.error
    );
    assert_eq!(record.rung, Some(Rung::Exact));
    assert_eq!(record.outcome, PathOutcome::Status(FILL_PATH_WORK_LIMIT));
    assert_eq!(record.error, Some(CubicFillError::OwnerLimit));
    assert_eq!(record.tier, Some(FillTier::Small));
    assert_eq!(record, old);
}
