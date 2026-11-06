//! D9 rendering-track item E35 (`docs/evidence/e35-hairpin-stroke-2026-11-06.md`): the stroke
//! retry after a `work-limit` (`stroke-v0+r8`). The fixtures are the four pen paths from the
//! user's editor (2026-11-06) that drew nothing at `stroke-v0+r7`, in document coordinates
//! (unit path points times the frame plus its origin), width 1, butt, miter 4, and the V-25
//! triangle whose cubic has a 1 px handle. In each the last cubic is a hairpin: the editor paths'
//! first control equals the start and the second points back past the end.
//!
//! E35-K1 groups a near-cusp fan of leaves into two side hulls, E35-K2 uses the relative cone
//! guard (ST-OB7) and E35-K3 replaces a near reversal by a disk. The retry runs only after a
//! `work-limit`, so every path that was `ok` keeps its mesh bit for bit.

use crate::geometry::{VERB_CUBIC, VERB_MOVE};
use crate::stroke_outline::{
    PieceKind, StrokeCap, StrokeJoin, StrokeOutcome, StrokeWorkspace, STROKE_PATH_OK,
    STROKE_PATH_WORK_LIMIT,
};
use crate::stroke_outline_tests::{request, PathSpec};

const CASES: [&str; 5] = ["node5", "node3a", "node3b", "node7", "triangle"];

fn case(name: &str) -> PathSpec {
    match name {
        "node5" => PathSpec::new()
            .m(339.20001220703125, 99.19999694824219)
            .c([
                288.79998779296875,
                113.60000610351562,
                227.20001220703125,
                110.39999389648438,
                167.20001220703125,
                181.60000610351562,
            ])
            .c([
                107.20001220703125,
                252.80001831054688,
                -104.80001831054688,
                157.60003662109375,
                52.0,
                320.8000183105469,
            ])
            .c([
                208.80001831054688,
                484.0,
                164.79998779296875,
                593.6000366210938,
                255.20001220703125,
                474.4000244140625,
            ])
            .c([
                345.60003662109375,
                355.20001220703125,
                384.79998779296875,
                224.8000030517578,
                380.79998779296875,
                180.0,
            ])
            .c([
                376.79998779296875,
                135.1999969482422,
                352.0,
                98.40000915527344,
                352.0,
                98.40000915527344,
            ])
            .c([
                352.0,
                98.40000915527344,
                389.60003662109375,
                84.79998779296875,
                339.20001220703125,
                99.19999694824219,
            ])
            .z(),
        "node3a" => PathSpec::new()
            .m(368.0, 132.0)
            .c([
                324.0,
                160.0,
                199.20001220703125,
                194.39999389648438,
                197.60000610351562,
                228.0,
            ])
            .c([
                196.0,
                261.6000061035156,
                147.20001220703125,
                282.3999938964844,
                212.80001831054688,
                316.0,
            ])
            .c([
                278.4000244140625,
                349.6000061035156,
                262.4000244140625,
                360.8000183105469,
                346.4000244140625,
                372.8000183105469,
            ])
            .c([
                430.4000244140625,
                384.8000183105469,
                474.39996337890625,
                471.1999816894531,
                460.79998779296875,
                338.3999938964844,
            ])
            .c([
                447.20001220703125,
                205.60000610351562,
                456.0,
                172.0,
                432.0,
                164.0,
            ])
            .c([
                408.0,
                156.0,
                376.79998779296875,
                142.40000915527344,
                376.79998779296875,
                142.40000915527344,
            ])
            .l(371.20001220703125, 129.60000610351562)
            .c([
                371.20001220703125,
                129.60000610351562,
                412.0,
                104.0,
                368.0,
                132.0,
            ])
            .z(),
        "node3b" => PathSpec::new()
            .m(335.20001220703125, 89.60000610351562)
            .c([
                321.5999755859375,
                103.19999694824219,
                306.39996337890625,
                155.20001220703125,
                294.39996337890625,
                170.40000915527344,
            ])
            .c([
                282.39996337890625,
                185.60000610351562,
                276.0,
                176.79998779296875,
                276.79998779296875,
                240.0,
            ])
            .c([
                277.5999755859375,
                303.20001220703125,
                292.0,
                347.20001220703125,
                316.79998779296875,
                359.20001220703125,
            ])
            .c([
                341.5999755859375,
                371.20001220703125,
                376.79998779296875,
                389.5999755859375,
                396.79998779296875,
                370.3999938964844,
            ])
            .c([
                416.79998779296875,
                351.20001220703125,
                466.39996337890625,
                360.0,
                462.39996337890625,
                324.0,
            ])
            .c([
                458.39996337890625,
                288.0,
                428.79998779296875,
                254.40000915527344,
                420.79998779296875,
                225.60000610351562,
            ])
            .c([
                412.79998779296875,
                196.8000030517578,
                333.5999755859375,
                195.1999969482422,
                412.79998779296875,
                192.0,
            ])
            .c([
                492.0,
                188.8000030517578,
                617.6000366210938,
                177.60000610351562,
                628.0,
                200.0,
            ])
            .c([
                638.3999633789062,
                222.39999389648438,
                864.0000610351562,
                323.20001220703125,
                587.2000122070312,
                287.20001220703125,
            ])
            .c([
                310.39996337890625,
                251.20001220703125,
                241.60003662109375,
                260.8000030517578,
                311.20001220703125,
                192.0,
            ])
            .c([
                380.79998779296875,
                123.19999694824219,
                384.0,
                120.0,
                384.0,
                120.0,
            ])
            .c([
                384.0,
                120.0,
                395.20001220703125,
                123.20001220703125,
                372.0,
                113.60000610351562,
            ])
            .c([
                348.79998779296875,
                104.0,
                332.79998779296875,
                92.00001525878906,
                332.79998779296875,
                92.00001525878906,
            ])
            .c([
                332.79998779296875,
                92.00001525878906,
                348.800048828125,
                76.00001525878906,
                335.20001220703125,
                89.60000610351562,
            ])
            .z(),
        "node7" => PathSpec::new()
            .m(298.4000244140625, 72.0)
            .c([
                280.79998779296875,
                83.20000457763672,
                172.79998779296875,
                127.20001220703125,
                114.39999389648438,
                193.60000610351562,
            ])
            .c([
                56.0,
                260.0,
                47.999969482421875,
                306.3999938964844,
                58.399993896484375,
                370.3999938964844,
            ])
            .c([
                68.80001831054688,
                434.3999938964844,
                58.399993896484375,
                444.79998779296875,
                102.39999389648438,
                488.0,
            ])
            .c([
                146.39999389648438,
                531.2000122070312,
                -42.39996337890625,
                768.7999572753906,
                204.80001831054688,
                548.7999877929688,
            ])
            .c([
                452.0,
                328.8000183105469,
                422.39996337890625,
                208.8000030517578,
                420.0,
                180.8000030517578,
            ])
            .c([
                417.60003662109375,
                152.8000030517578,
                396.0,
                96.80000305175781,
                395.20001220703125,
                92.80000305175781,
            ])
            .c([
                394.4000244140625,
                88.80000305175781,
                409.60003662109375,
                76.0,
                381.60003662109375,
                76.0,
            ])
            .c([
                353.60003662109375,
                76.0,
                334.39996337890625,
                76.00000762939453,
                324.79998779296875,
                75.20000457763672,
            ])
            .c([
                315.20001220703125,
                74.4000015258789,
                302.4000244140625,
                69.5999984741211,
                302.4000244140625,
                69.5999984741211,
            ])
            .c([
                302.4000244140625,
                69.5999984741211,
                316.00006103515625,
                60.79999542236328,
                298.4000244140625,
                72.0,
            ])
            .z(),
        "triangle" => PathSpec::new()
            .m(0.0, 0.0)
            .c([0.0, 0.0, 99.0, 0.4, 100.0, 0.0])
            .c([101.0, -0.4, 50.0, 80.0, 50.0, 80.0])
            .l(0.0, 60.0)
            .z(),
        _ => unreachable!("unknown case {name}"),
    }
}

/// The path's last cubic alone (the hairpin).
fn closing_cubic(path: &PathSpec) -> PathSpec {
    let cubic = path
        .verbs
        .iter()
        .rposition(|verb| *verb == VERB_CUBIC)
        .expect("a cubic");
    let mut point = 0usize;
    let mut start = 0usize;
    for (index, verb) in path.verbs.iter().enumerate() {
        if index == cubic {
            start = point - 1;
        }
        point += match *verb {
            VERB_CUBIC => 3,
            VERB_MOVE => 1,
            _ if *verb == crate::geometry::VERB_LINE => 1,
            _ => 0,
        };
    }
    let p = |i: usize| (path.points[2 * i], path.points[2 * i + 1]);
    let (x, y) = p(start);
    let (a, b, c) = (p(start + 1), p(start + 2), p(start + 3));
    PathSpec::new().m(x, y).c([a.0, a.1, b.0, b.1, c.0, c.1])
}

type Mesh = (Vec<u64>, Vec<u32>, Vec<[u32; 2]>);

/// Builds at `r8` (or at the `r7` baseline) and returns the status and the mesh bits.
fn build(
    ws: &mut StrokeWorkspace,
    path: &PathSpec,
    exponent: i32,
    r7: bool,
) -> (u32, Option<Mesh>) {
    ws.defects_mut().no_retry = r7;
    let outcome = ws
        .build(
            request(1.0, StrokeCap::Butt, StrokeJoin::Miter, 4.0, exponent),
            &path.verbs,
            &path.bytes(),
        )
        .expect("no internal error");
    let status = match outcome {
        StrokeOutcome::Mesh => STROKE_PATH_OK,
        StrokeOutcome::Status(status) => status,
    };
    let mesh = (status == STROKE_PATH_OK).then(|| {
        let (vertices, triangles, boundary) = ws.mesh().expect("an ok mesh");
        (
            vertices
                .iter()
                .flat_map(|point| [point.x.to_bits(), point.y.to_bits()])
                .collect(),
            triangles.to_vec(),
            boundary.to_vec(),
        )
    });
    (status, mesh)
}

fn count(ws: &StrokeWorkspace, kind: PieceKind) -> usize {
    ws.pieces()
        .iter()
        .filter(|piece| piece.kind == kind)
        .count()
}

/// E35-A1: the user's paths at zoom 1, DPR 1 (`e = -3`), or at `e = -2` for node3b, whose
/// `e = -3` stroke still meets the arrangement's node cap (the renderer's coarser retry reaches
/// `-2`), were `work-limit` at `r7` and are `ok` at `r8`.
#[test]
fn e35_user_paths_build_after_the_retry() {
    let mut ws = StrokeWorkspace::new().expect("workspace");
    for (name, exponent) in [
        ("node5", -3),
        ("node5", -2),
        ("node3a", -3),
        ("node3a", -4),
        ("node3b", -2),
        ("node7", -3),
        ("node7", -4),
    ] {
        let path = case(name);
        let (before, _) = build(&mut ws, &path, exponent, true);
        assert_eq!(before, STROKE_PATH_WORK_LIMIT, "{name} e={exponent} at r7");
        let (after, mesh) = build(&mut ws, &path, exponent, false);
        assert_eq!(after, STROKE_PATH_OK, "{name} e={exponent} at r8");
        assert!(
            !mesh.expect("mesh").1.is_empty(),
            "{name} e={exponent} triangles"
        );
    }
}

/// E35-A2: each closing hairpin alone builds from `e = 2` down to `e = -4` (node3b's, a
/// near-exact reversal on a line, through E35-K3's disk).
#[test]
fn e35_closing_hairpins_build_alone() {
    let mut ws = StrokeWorkspace::new().expect("workspace");
    for name in CASES {
        let hairpin = closing_cubic(&case(name));
        for exponent in [2, 0, -2, -3, -4] {
            let (status, _) = build(&mut ws, &hairpin, exponent, false);
            assert_eq!(status, STROKE_PATH_OK, "{name} closing cubic e={exponent}");
        }
    }
    let (status, _) = build(&mut ws, &closing_cubic(&case("node3b")), -3, false);
    assert_eq!(status, STROKE_PATH_OK);
    assert_eq!(
        count(&ws, PieceKind::ReversalDisk),
        1,
        "node3b uses one reversal disk"
    );
    let (status, _) = build(&mut ws, &closing_cubic(&case("node5")), -3, false);
    assert_eq!(status, STROKE_PATH_OK);
    assert!(
        count(&ws, PieceKind::FanSide) >= 2,
        "node5's tip is grouped"
    );
}

/// E35-A3: the retry runs only after a `work-limit`: whenever `r7` builds a path, `r8` gives
/// the same mesh bit for bit, and a path that `r8` still refuses stays `work-limit`.
#[test]
fn e35_ok_meshes_are_unchanged() {
    let mut ws = StrokeWorkspace::new().expect("workspace");
    let mut compared = 0;
    for name in CASES {
        let path = case(name);
        for candidate in [path.clone(), closing_cubic(&path)] {
            for exponent in [2, 0, -1, -2, -3, -4, -5] {
                let (before, old) = build(&mut ws, &candidate, exponent, true);
                let (after, new) = build(&mut ws, &candidate, exponent, false);
                if before == STROKE_PATH_OK {
                    assert_eq!(after, STROKE_PATH_OK, "{name} e={exponent}");
                    assert_eq!(old, new, "{name} e={exponent}: mesh changed");
                    assert_eq!(count(&ws, PieceKind::FanSide), 0, "{name} e={exponent}");
                    compared += 1;
                } else {
                    assert!(
                        after == STROKE_PATH_OK || after == before,
                        "{name} e={exponent}: {before} became {after}"
                    );
                }
            }
        }
    }
    assert!(compared > 10, "enough ok builds compared: {compared}");
}

/// E35-A4: every vertex of a fan side or reversal disk lies within `r + 2^e` of the curve
/// (dense samples), the outward half of the two-sided bound.
#[test]
fn e35_grouped_pieces_stay_near_the_curve() {
    let mut ws = StrokeWorkspace::new().expect("workspace");
    for name in CASES {
        let hairpin = closing_cubic(&case(name));
        let q: Vec<(f64, f64)> = (0..4)
            .map(|i| (hairpin.points[2 * i], hairpin.points[2 * i + 1]))
            .collect();
        let samples: Vec<(f64, f64)> = (0..=200_000)
            .map(|k| {
                let t = f64::from(k) / 200_000.0;
                let s = 1.0 - t;
                let w = [s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t];
                (
                    (0..4).map(|i| w[i] * q[i].0).sum::<f64>(),
                    (0..4).map(|i| w[i] * q[i].1).sum::<f64>(),
                )
            })
            .collect();
        for exponent in [-2, -3, -4] {
            let (status, _) = build(&mut ws, &hairpin, exponent, false);
            assert_eq!(status, STROKE_PATH_OK, "{name} e={exponent}");
            let bound = 0.5 + 2f64.powi(exponent);
            for piece in ws.pieces() {
                if !matches!(piece.kind, PieceKind::FanSide | PieceKind::ReversalDisk) {
                    continue;
                }
                for vertex in ws.piece_points(piece).expect("stored") {
                    let nearest = samples
                        .iter()
                        .map(|(x, y)| ((vertex.x - x).powi(2) + (vertex.y - y).powi(2)).sqrt())
                        .fold(f64::INFINITY, f64::min);
                    assert!(nearest <= bound, "{name} e={exponent}: {nearest} > {bound}");
                }
            }
        }
    }
}

