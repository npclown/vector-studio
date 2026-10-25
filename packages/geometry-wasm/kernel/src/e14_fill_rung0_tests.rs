//! D9 E14-U1 tests (`docs/plans/d9-e14-fill-rung0-edge-cap-contract.md`, section 8): the
//! fixtures E14-F1 to E14-F8 read natively through `build_path` (E14-A2), the work cap's
//! inclusive bound and the seeded defects E14-D1, E14-D2 and E14-D4. E14-D3 is
//! `fill_ladder_tests::e14_d3_scratch_sized_from_the_exact_limits_only_is_refused`; E14-A3 and
//! E14-A6 for the release WASM are `tests/geometry/e14-fill-rung0.test.ts`.
use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    with_exact_rung_fast_caps, CubicFillError, CubicFillWorkspace, MAX_EDGE_OWNERS,
    MAX_FAST_EDGE_OWNERS, MAX_FLAT_COMMANDS,
};
use crate::engine::BATCH_OK;
use crate::fill_export::{
    tolerances, BuiltPath, FillEngine, FillRequest, PathOutcome, FILL_PATH_WORK_LIMIT,
    FILL_V0_LIMITS,
};
use crate::fill_ladder::{
    graph_select_for_tests, with_ladder_faults, with_next_half_differential, with_work_cap,
    LadderFault, Reason, Rung, MAX_FAST_WORK,
};
use crate::fill_predicates::orient2d;
use crate::geometry::{Point, VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE};
use crate::line_fill::LineFillRule;
use core::cmp::Ordering;

/// The fixtures' circle constant (section 8).
const KAPPA: f64 = 0.552_284_749_8;

#[derive(Clone)]
pub(crate) struct Fixture {
    pub(crate) exponent: i32,
    pub(crate) rule: LineFillRule,
    pub(crate) verbs: Vec<u8>,
    pub(crate) points: Vec<f64>,
}

impl Fixture {
    fn new(exponent: i32) -> Self {
        Self {
            exponent,
            rule: LineFillRule::Nonzero,
            verbs: Vec::new(),
            points: Vec::new(),
        }
    }

    fn move_to(mut self, point: Point) -> Self {
        self.verbs.push(VERB_MOVE);
        self.points.extend([point.x, point.y]);
        self
    }

    fn line_to(mut self, point: Point) -> Self {
        self.verbs.push(VERB_LINE);
        self.points.extend([point.x, point.y]);
        self
    }

    fn cubic_to(mut self, controls: [Point; 3]) -> Self {
        self.verbs.push(VERB_CUBIC);
        for point in controls {
            self.points.extend([point.x, point.y]);
        }
        self
    }

    fn close(mut self) -> Self {
        self.verbs.push(VERB_CLOSE);
        self
    }

    fn point_bytes(&self) -> Vec<u8> {
        self.points
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    fn request(&self) -> FillRequest {
        FillRequest {
            request_id: 0,
            rule: self.rule,
            exponent: self.exponent,
        }
    }

    fn input<'a>(&'a self, bytes: &'a [u8]) -> PathInput<'a> {
        PathInput::from_test_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: tolerances(self.exponent).0,
            },
            &self.verbs,
            bytes,
        )
    }
}

fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// The four quarter cubics of a circle of radius `r` about the origin, counterclockwise from
/// (r, 0).
fn quarters(r: f64) -> [[Point; 4]; 4] {
    let k = r * KAPPA;
    [
        [point(r, 0.0), point(r, k), point(k, r), point(0.0, r)],
        [point(0.0, r), point(-k, r), point(-r, k), point(-r, 0.0)],
        [point(-r, 0.0), point(-r, -k), point(-k, -r), point(0.0, -r)],
        [point(0.0, -r), point(k, -r), point(r, -k), point(r, 0.0)],
    ]
}

pub(crate) fn circle(exponent: i32, r: f64) -> Fixture {
    let mut path = Fixture::new(exponent).move_to(point(r, 0.0));
    for [_, one, two, end] in quarters(r) {
        path = path.cubic_to([one, two, end]);
    }
    path.close()
}

/// De Casteljau at 1/2 with binary64 basic operations only, so the literals are the same on
/// every platform.
fn halves(c: [Point; 4]) -> [[Point; 4]; 2] {
    let mid = |a: Point, b: Point| point((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
    let (p01, p12, p23) = (mid(c[0], c[1]), mid(c[1], c[2]), mid(c[2], c[3]));
    let (p012, p123) = (mid(p01, p12), mid(p12, p23));
    let m = mid(p012, p123);
    [[c[0], p01, p012, m], [m, p123, p23, c[3]]]
}

/// E14-F4's 64 cubics: each quarter cubic of a circle of radius `r` halved four times.
fn sixty_four_cubics(r: f64) -> Vec<[Point; 4]> {
    let mut cubics: Vec<[Point; 4]> = quarters(r).to_vec();
    for _ in 0..4 {
        cubics = cubics.into_iter().flat_map(halves).collect();
    }
    cubics
}

/// E14-F4 with exactly E0 flat edges (`extra = false`), or its variant whose last cubic ends one
/// unit short of the start so the implicit closure adds one edge (`extra = true`).
fn f4(extra: bool) -> Fixture {
    let mut cubics = sixty_four_cubics(F4_RADIUS);
    assert_eq!(cubics.len(), 64);
    if extra {
        let last = cubics.last_mut().expect("64 cubics");
        last[3].y -= 1.0;
    }
    let mut path = Fixture::new(-3).move_to(cubics[0][0]);
    for [_, one, two, end] in cubics {
        path = path.cubic_to([one, two, end]);
    }
    path.close()
}

/// E14-F4's radius, found by the search of `e14_f4_search` (section 8): every one of the 64
/// cubics flattens to 128 leaves at e = −3.
const F4_RADIUS: f64 = 1_048_576.0;

/// E14-F7: two concentric half circles of radii 2,048.2 and 2,048, joined at both ends by
/// segments 0.2 px long (section 8, a simple near-touching path).
fn f7() -> Fixture {
    let (outer, inner) = (2_048.2, 2_048.0);
    let [o1, o2, ..] = quarters(outer);
    let [i1, i2, ..] = quarters(inner);
    Fixture::new(-3)
        .move_to(o1[0])
        .cubic_to([o1[1], o1[2], o1[3]])
        .cubic_to([o2[1], o2[2], o2[3]])
        .line_to(i2[3])
        .cubic_to([i2[2], i2[1], i2[0]])
        .cubic_to([i1[2], i1[1], i1[0]])
        .close()
}

/// A row of the E14 diagnostic's input (`tooling/run-e14-fill-diag.mjs`, scene
/// `p3-exit-stress/v1`): tolerance exponent, rule, verbs and hexadecimal binary64 scalars.
fn scene(exponent: i32, rule: LineFillRule, verbs: &str, scalars: &str) -> Fixture {
    let mut path = Fixture::new(exponent);
    path.rule = rule;
    path.verbs = verbs.split(',').map(|v| v.parse().expect("verb")).collect();
    path.points = scalars
        .split(',')
        .map(|v| f64::from_bits(u64::from_str_radix(v.trim(), 16).expect("scalar")))
        .collect();
    path
}

/// E14-F5: scene path 3, the lowest-index looping path with E + 1 to E0 flat edges. No looping
/// path in that range reaches `CROSSING` at r3: all 190 stop at `MONOTONE` first (FR4 runs
/// before FR5's crossing check), so the fixture is the lowest-index one with its actual reason
/// (E14-U1 evidence).
pub(crate) fn f5() -> Fixture {
    scene(
        -5,
        LineFillRule::Evenodd,
        "0,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,3",
        "406678b000000000,0000000000000000,40643da800000000,c022138000000000,407015c000000000,\
     c05bfd3000000000,4071c37c00000000,404c446000000000,4065da5800000000,c03e1c8000000000,\
     4079ef5c00000000,404f330000000000,4073182400000000,405fa2f000000000,406a747800000000,\
     4023d90000000000,4068981800000000,c05167f000000000,406a335800000000,406181b800000000,\
     407363c400000000,4075abb000000000,4073df1800000000,403a648000000000,406a695000000000,\
     406a695000000000,40734cf800000000,40675bb000000000,4069ec0000000000,4056618000000000,\
     4060160000000000,4068130000000000,4072592800000000,40635e3800000000,406fcfa800000000,\
     4075058000000000,4052529000000000,40661e0000000000,406abd0000000000,4054698000000000,\
     404653c000000000,40699ee800000000,404639a000000000,406beee000000000,40692b5000000000,\
     4062cf7800000000,403bd68000000000,40801ed800000000,0000000000000000,4074597000000000,\
     c05df04000000000,406ee9a800000000,c063ff7800000000,40723ad000000000,c04cfdc000000000,\
     407237ec00000000,4054f53000000000,407472b000000000,c06a127000000000,40722c8000000000,\
     c05e92c000000000,407273d800000000,c060397800000000,406833b000000000,c0628f2000000000,\
     405ad5d000000000,c05b51a000000000,4064715800000000,c039098000000000,405d572000000000,\
     c04121c000000000,4068420800000000,c065032800000000,4065032800000000,c06d3a3000000000,\
     4050128000000000,c064076800000000,4037598000000000,c068d47800000000,4060974800000000,\
     c020528000000000,4058f58000000000,c078103400000000,c04b2b2000000000,c06a3bc000000000,\
     4055bb8000000000,c0640ce000000000,c022740000000000,c0751fac00000000,406acb8800000000,\
     c06cb4b000000000,4046d70000000000,c06ef02800000000,40367e0000000000,c060835800000000,\
     c060bfb800000000,c06f366000000000,0000000000000000,c0793ec000000000,c005c20000000000,\
     c06e43a800000000,c05212a000000000,c06b4cb800000000,c045b88000000000,c051381000000000,\
     c06b78d800000000,c055df5000000000,c065c7b800000000,c06c622800000000,c057838000000000,\
     c06bd77000000000,4051ad6000000000,c054524000000000,c06071c800000000,c069bf6000000000,\
     c061343800000000,c066f12800000000,c02d248000000000,c063f96000000000,c048c1e000000000,\
     c0640b8000000000,c0640b8000000000,c05b3e4000000000,c06d533000000000,c066ebd800000000,\
     c076523c00000000,c06381c000000000,c06d31a800000000,c06ab2f800000000,c05a836000000000,\
     c072ec2c00000000,c056f1d000000000,c05a379000000000,c06fa59800000000,c056698000000000,\
     c069761800000000,c068441800000000,c0706bd000000000,c04865e000000000,c06eaa0800000000,\
     bfead80000000000,c064eea800000000,c063e15000000000,c07c165800000000,8000000000000000,\
     c073b72000000000,40373dc000000000,c063719800000000,c06336e000000000,c07d72b000000000,\
     405014a000000000,c07435f000000000,40498c6000000000,c073148c00000000,c0538c9000000000,\
     c06310a000000000,405ce07000000000,c0716db800000000,405ad1d000000000,c0598a5000000000,\
     407597e000000000,c074182c00000000,4064613000000000,c06e801000000000,406fe45000000000,\
     c070734c00000000,40608d1000000000,c057b41000000000,4062f71000000000,c062f71000000000,\
     c019f90000000000,403d394000000000,4038f48000000000,c05682a000000000,406dd92000000000,\
     c063f1a000000000,40636f9800000000,c06460e800000000,40785b3400000000,c031ef8000000000,\
     4072021000000000,c05dd63000000000,407c71c000000000,c06e221800000000,405b2c7000000000,\
     405c26f000000000,4066d89800000000,c0422d8000000000,407588c000000000,c05aa07000000000,\
     406e92d800000000,40426d8000000000,406678b000000000,0000000000000000",
    )
}

/// E14-F6: scene path 500, the smooth path with 9,284 flat verbs.
fn f6() -> Fixture {
    scene(
        -11,
        LineFillRule::Nonzero,
        "0,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,3",
        "40711b4c00000000,0000000000000000,4070c05000000000,4025d08000000000,406314e800000000,\
     40292f0000000000,40626e0800000000,403d53c000000000,4061c72800000000,4047080000000000,\
     406e9cc000000000,4056a28000000000,406e4d6000000000,40591a7000000000,406dfe0000000000,\
     405b926000000000,4061f8b800000000,405307b000000000,406091d000000000,4056249000000000,\
     405e55d000000000,4059417000000000,4066c97800000000,4064f1d000000000,4065e3e800000000,\
     4065e3e800000000,4064fe5800000000,4066d60000000000,405b368000000000,40616c1800000000,\
     405660d000000000,4060bee800000000,40518b2000000000,406011b800000000,4050704000000000,\
     405edf2000000000,404d8b4000000000,4061d4d000000000,404a362000000000,40643a1000000000,\
     404daf0000000000,406d65b800000000,4048c28000000000,406f1e6000000000,4043d60000000000,\
     40706b8400000000,402f1f0000000000,406cc0e000000000,0000000000000000,406c28b000000000,\
     c02f1f0000000000,406b908000000000,c03f258000000000,406c69d000000000,c045ebe000000000,\
     406b8d3800000000,c04c450000000000,406ab0a000000000,c050551000000000,40682f2800000000,\
     c0530b6000000000,4066fd1800000000,c055c1a000000000,4065cb0800000000,c056a32000000000,\
     4064534000000000,c05b3ba000000000,406460e800000000,c05fd41000000000,40646e9000000000,\
     c0660c9000000000,406858e000000000,c0674f1800000000,40674f1800000000,c06891a000000000,\
     4066455000000000,c065ac2000000000,4060a17000000000,c0652d0800000000,405c4c7000000000,\
     c064ade800000000,4057560000000000,c062f59000000000,40539be000000000,c064547000000000,\
     4050d78000000000,c065b34800000000,404c264000000000,c06cb38000000000,404d016000000000,\
     c06d663000000000,4047644000000000,c06e18d800000000,4041c72000000000,c0682a4800000000,\
     403027c000000000,c068847800000000,0000000000000000,c068dea800000000,c03027c000000000,\
     c06f63e000000000,c042196000000000,c06f835800000000,c04912c000000000,c06fa2d000000000,\
     c050061000000000,c06abbc800000000,c051f7e000000000,c069414800000000,c054ec0000000000,\
     c067c6c800000000,c057e02000000000,c066dce800000000,c059c4b000000000,c066a46000000000,\
     c05e421000000000,c0666bd800000000,c0615fb000000000,c069bf1800000000,c06785b800000000,\
     c067ee0800000000,c067ee0800000000,c0661cf800000000,c068565800000000,c05c223000000000,\
     c0618b9000000000,c0577c1000000000,c06192d800000000,c052d5f000000000,c0619a2000000000,\
     c055eb0000000000,c066193800000000,c053f73000000000,c06819b800000000,c052036000000000,\
     c06a1a3800000000,c04e31e000000000,c06e522800000000,c0478a2000000000,c06d95e000000000,\
     c040e26000000000,c06cd99800000000,c02eda8000000000,c063dac000000000,8000000000000000,\
     c063aff800000000,402edb0000000000,c063853000000000,4041e64000000000,c06cf10000000000,\
     4046be0000000000,c06c954000000000,404b95c000000000,c06c398000000000,4048d3c000000000,\
     c0634ce000000000,404d0e8000000000,c061898000000000,4050a4a000000000,c05f8c4000000000,\
     4054ab3000000000,c062054800000000,40580f5000000000,c062010800000000,405b737000000000,\
     c061fcc800000000,405fdbe000000000,c062174000000000,4061700000000000,c061700000000000,\
     4062f21000000000,c060c8c000000000,40645d2000000000,c05efb2000000000,406513f800000000,\
     c05c2af000000000,4065cad000000000,c0595ac000000000,4065742800000000,c0552fa000000000,\
     4065b92000000000,c051ff0000000000,4065fe2000000000,c04d9cc000000000,40649cf800000000,\
     c0480e4000000000,4066b1e000000000,c0420ea000000000,4068c6c800000000,c0381e0000000000,\
     4071764800000000,c025d08000000000,40711b4c00000000,0000000000000000",
    )
}

/// The first pair of edges of the path's S1 polygon (rung 0's prefix) that cross properly:
/// strictly opposite exact `orient2d` signs at both edges, the E14-Q1 class test.
fn proper_crossing(path: &Fixture) -> Option<(usize, usize)> {
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let bytes = path.point_bytes();
    let commands = workspace.fast_flat_commands();
    let view = workspace
        .prepare_prefix(path.input(&bytes), commands)
        .map_err(|failure| format!("{failure:?}"))
        .expect("prefix");
    let mut edges = Vec::new();
    for range in view.ranges {
        let points = &view.points[range.start..range.start + range.count];
        for index in 0..points.len() {
            edges.push((points[index], points[(index + 1) % points.len()]));
        }
    }
    let side = |a: Point, b: Point, c: Point| orient2d(a, b, c).expect("orient2d");
    let opposite = |x: Ordering, y: Ordering| x != Ordering::Equal && y == x.reverse();
    for i in 0..edges.len() {
        let (a, b) = edges[i];
        for (j, &(c, d)) in edges.iter().enumerate().skip(i + 1) {
            if a.x.max(b.x) < c.x.min(d.x)
                || c.x.max(d.x) < a.x.min(b.x)
                || a.y.max(b.y) < c.y.min(d.y)
                || c.y.max(d.y) < a.y.min(b.y)
            {
                continue;
            }
            if opposite(side(a, b, c), side(a, b, d)) && opposite(side(c, d, a), side(c, d, b)) {
                return Some((i, j));
            }
        }
    }
    None
}

fn engine() -> FillEngine {
    let mut engine = FillEngine::new();
    assert_eq!(engine.reserve(1 << 16, 1 << 20), BATCH_OK);
    engine
}

fn built(engine: &mut FillEngine, path: &Fixture) -> BuiltPath {
    engine
        .build_one(path.request(), &path.verbs, &path.point_bytes())
        .expect("reserved engine")
        .expect("no self-check failure")
}

/// The rung-0 prefix's flat edge count (fast caps), or its failure.
fn fast_edges(path: &Fixture) -> Result<usize, String> {
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let bytes = path.point_bytes();
    workspace
        .prepare_prefix(path.input(&bytes), workspace.fast_flat_commands())
        .map(|view| view.owners.len())
        .map_err(|failure| format!("{failure:?}"))
}

/// The exact rung's Legacy attempt.
fn exact(path: &Fixture) -> Result<(), CubicFillError> {
    let mut workspace = CubicFillWorkspace::new(FILL_V0_LIMITS).expect("workspace");
    let bytes = path.point_bytes();
    let topology = tolerances(path.exponent).1;
    workspace
        .attempt(path.input(&bytes), path.rule, topology, MAX_FLAT_COMMANDS)
        .map(|_| ())
}

fn assert_fast(engine: &mut FillEngine, path: &Fixture, name: &str) -> u32 {
    let record = built(engine, path);
    assert_eq!(
        (record.rung, record.reason, record.outcome),
        (Some(Rung::Fast), None, PathOutcome::Mesh),
        "{name}"
    );
    engine.fast_work()
}

fn assert_fallback(engine: &mut FillEngine, path: &Fixture, reason: Reason, name: &str) {
    let record = built(engine, path);
    assert_eq!(
        (record.rung, record.reason, record.outcome),
        (
            Some(Rung::Exact),
            Some(reason),
            PathOutcome::Status(FILL_PATH_WORK_LIMIT)
        ),
        "{name}"
    );
}

#[test]
fn e14_f1_to_f3_circles() {
    let mut engine = engine();
    // E14-F1: 256 flat edges, rung 0 today and at r3 (`fill_export_tests::e14_f1_output_is_the_r2_output`
    // pins the bytes).
    let f1 = circle(-3, 512.0);
    assert_eq!(fast_edges(&f1), Ok(MAX_EDGE_OWNERS));
    assert_eq!(exact(&f1), Ok(()));
    assert_fast(&mut engine, &f1, "E14-F1");
    // E14-F2 and E14-F3: over E, `CommandLimit` in the exact rung, meshed by rung 0.
    for (name, r, edges) in [("E14-F2", 2_048.0, 512), ("E14-F3", 32_768.0, 2_048)] {
        let path = circle(-3, r);
        assert_eq!(fast_edges(&path), Ok(edges), "{name}");
        assert_eq!(exact(&path), Err(CubicFillError::CommandLimit), "{name}");
        let work = assert_fast(&mut engine, &path, name);
        println!("{name}: {edges} flat edges, rung-0 work {work}");
    }
}

#[test]
fn e14_f4_cap_is_inclusive() {
    let mut engine = engine();
    let at_cap = f4(false);
    assert_eq!(at_cap.verbs.len(), 1 + 64 + 1);
    assert_eq!(fast_edges(&at_cap), Ok(MAX_FAST_EDGE_OWNERS));
    let work = assert_fast(&mut engine, &at_cap, "E14-F4 at E0");
    println!("E14-F4 at E0: rung-0 work {work}");
    let over = f4(true);
    assert_eq!(
        fast_edges(&over),
        Err(format!(
            "{:?}",
            crate::cubic_fill::PrefixFailure::Error(CubicFillError::OwnerLimit)
        ))
    );
    assert_eq!(exact(&over), Err(CubicFillError::CommandLimit));
    assert_fallback(&mut engine, &over, Reason::Prefix, "E14-F4 at E0 + 1");
}

#[test]
fn e14_f7_near_touching_simple_path_falls_back() {
    let mut engine = engine();
    let path = f7();
    let edges = fast_edges(&path).expect("prefix");
    assert!(edges > MAX_EDGE_OWNERS, "{edges} flat edges");
    let record = built(&mut engine, &path);
    println!("E14-F7: {edges} flat edges, reason {:?}", record.reason);
    assert_eq!(record.rung, Some(Rung::Exact));
    assert_eq!(record.reason, Some(Reason::Clearance));
    assert_eq!(record.outcome, PathOutcome::Status(FILL_PATH_WORK_LIMIT));
    assert_eq!(exact(&path), Err(CubicFillError::CommandLimit));
}

#[test]
fn e14_f5_f6_scene_paths_stay_work_limit() {
    let mut engine = engine();
    let path = f5();
    let edges = fast_edges(&path).expect("prefix");
    // The E14-Q1 class test: two edges of the S1 polygon cross properly (exact `orient2d`).
    assert!(
        proper_crossing(&path).is_some(),
        "E14-F5 has no proper crossing"
    );
    assert_eq!(edges, 3_463, "E14-F5 flat edges");
    assert_eq!(exact(&path), Err(CubicFillError::CommandLimit));
    assert_fallback(&mut engine, &path, Reason::Monotone, "E14-F5");
    let path = f6();
    assert_eq!(
        fast_edges(&path),
        Err(format!(
            "{:?}",
            crate::cubic_fill::PrefixFailure::Error(CubicFillError::CommandLimit)
        ))
    );
    assert_eq!(exact(&path), Err(CubicFillError::CommandLimit));
    assert_fallback(&mut engine, &path, Reason::Prefix, "E14-F6");
}

/// E14-K3: W0 is inclusive. A call that charges exactly `cap` times succeeds; one fewer
/// allowed is `WORK`. E14-D2: with W0 not enforced, a lowered cap is not observed.
#[test]
fn e14_work_cap_is_inclusive_and_d2_is_caught() {
    let mut engine = engine();
    let path = circle(-3, 32_768.0);
    let work = assert_fast(&mut engine, &path, "E14-F3");
    assert!(work > 0 && work < MAX_FAST_WORK);
    with_work_cap(Some(work), || assert_fast(&mut engine, &path, "cap = work"));
    with_work_cap(Some(work - 1), || {
        assert_fallback(&mut engine, &path, Reason::Work, "cap = work − 1");
    });
    // E14-D2: the cap not enforced; the lowered-cap fixture no longer returns `WORK`.
    with_work_cap(None, || assert_fast(&mut engine, &path, "E14-D2"));
}

/// E14-D1: the exact rung run with the E0 caps. A path over E that rung 0 refuses no longer
/// reaches the exact rung's `CommandLimit`, so its fallback row changes, which E14-G1 reports.
#[test]
fn e14_d1_exact_rung_with_fast_caps_is_caught() {
    let path = f7();
    assert_eq!(exact(&path), Err(CubicFillError::CommandLimit));
    let seeded = with_exact_rung_fast_caps(|| exact(&path));
    assert_ne!(
        seeded,
        Err(CubicFillError::CommandLimit),
        "E14-D1 not caught"
    );
}

/// E14-D4, module level: a synthetic face-tracing graph at vertex w = 1, reached from u = 0,
/// with two candidates whose directions tie (class 1, both on the ray opposite to w → u: the
/// boundary successor 2 and diagonal (1, 3)) and a better one (class 0: diagonal (1, 4)). In
/// today's order the tie is compared first, which is `TRIANGLE`; with the index reversed the
/// better candidate comes before the tied diagonal and the pick succeeds.
#[test]
fn e14_d4_diagonal_order_is_observable_on_a_tie() {
    let vertices = [
        point(-1.0, 0.0),
        point(0.0, 0.0),
        point(1.0, 0.0),
        point(2.0, 0.0),
        point(1.0, 1.0),
    ];
    let next = [1, 2, 3, 4, 0];
    let diagonals = [(1, 3), (1, 4)];
    // Half-edge 0 is the boundary edge 0 → 1.
    let today = graph_select_for_tests(&vertices, &next, &diagonals, 0);
    assert_eq!(today, Err(Reason::Triangle));
    // The seeded defect: `index_diagonals` under `LadderFault::DiagonalIndexReversed`, the fault
    // the production FR7 build reads.
    let reversed = with_ladder_faults(&[LadderFault::DiagonalIndexReversed], || {
        graph_select_for_tests(&vertices, &next, &diagonals, 0)
    });
    // Diagonal 1's forward half-edge, n + 2 = 7, goes to vertex 4.
    assert_eq!(reversed, Ok(7));
}

/// E14-D4, differential over the E14 fixtures: the indexed `next_half` equals today's linear
/// scan on every call. The circles and E14-F4 are convex, so monotone decomposition adds no
/// diagonal and every call compares only w → next(w); the differential that reaches diagonal
/// candidates runs over the AL-I3 corpus in `fill_ladder_tests`
/// (`e14_d4_next_half_differential_on_the_debug_sample` and its full-corpus release test).
#[test]
fn e14_d4_indexed_next_half_equals_the_linear_scan_on_the_fixtures() {
    let mut engine = engine();
    let paths = [
        circle(-3, 512.0),
        circle(-3, 2_048.0),
        circle(-3, 32_768.0),
        f4(false),
    ];
    let ((), counts) = with_next_half_differential(|| {
        for path in &paths {
            assert_fast(&mut engine, path, "differential");
        }
    });
    assert!(counts.compared > 10_000, "{counts:?}");
    assert_eq!(
        counts.with_diagonals, 0,
        "convex fixtures have no diagonals"
    );
}

/// Section 8 search for E14-F4: the radius at which every one of the 64 halved cubics
/// flattens to 128 leaves (8,192 flat edges). Ignored; run by hand.
#[test]
#[ignore = "E14-F4 literal search; run by hand"]
fn e14_f4_search() {
    for exponent in 16..24 {
        let r = f64::from(1u32 << exponent);
        let mut path = Fixture::new(-3).move_to(point(r, 0.0));
        for [_, one, two, end] in sixty_four_cubics(r) {
            path = path.cubic_to([one, two, end]);
        }
        let path = path.close();
        println!("E14-F4 search: r = 2^{exponent}: {:?}", fast_edges(&path));
    }
}
