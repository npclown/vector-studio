//! ST-U3 and ST-U4 oracle hand-off (`docs/plans/p3-b2-stroke-contract.md` section 11.1): the
//! ignored test `emit_stroke_dump` reads a `P3STKIN1` text input and writes one framed JSON line
//! per case: the request, the status, the classification (segments with their cubic class,
//! triples, joins), every piece with its kind, source segment, parameter interval, leaf range,
//! depth and index, sample triples and emitted points, and the mesh. Every binary64 value is
//! written as its 16-digit hexadecimal bit pattern, so nothing is rounded.
//! `tests/geometry/stroke-oracle.test.ts` writes the input and reads the dump.
//!
//! ST-U4 adds an optional ninth input field of comma-separated test flags: the seeded defects
//! `knot-join` (ST-D6), `omit-cusp-disk` (ST-D7) and `leaf-factor-two` (ST-D8), and `wide`, which
//! runs the case on a workspace with the test-only arrangement limits `WIDE_TEST_LIMITS` (never
//! a production configuration). D9 E2-U2 adds the seeded defects `band-no-fold` (E2-D2) and
//! `band-half-bound` (E2-D3).

use std::env;
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;

use crate::geometry::Point;
use crate::stroke_cubic_tests::WIDE_TEST_LIMITS;
use crate::stroke_outline::{
    JoinClass, PieceKind, StrokeCap, StrokeJoin, StrokeOutcome, StrokeRequest, StrokeWorkspace,
    Triple, STROKE_PATH_EMPTY, STROKE_PATH_INVALID_PATH, STROKE_PATH_INVALID_STROKE,
    STROKE_PATH_INVALID_TOLERANCE, STROKE_PATH_NUMERIC_RANGE, STROKE_PATH_UNSUPPORTED_GEOMETRY,
    STROKE_PATH_WORK_LIMIT,
};

const INPUT_MAGIC: &str = "P3STKIN1";
const OUTPUT_MAGIC: &str = "P3STKDUMP1";

/// One dump case.
#[derive(Clone, Debug)]
struct Case {
    name: String,
    request: StrokeRequest,
    verbs: Vec<u8>,
    points: Vec<f64>,
    flags: Vec<String>,
}

fn parse_bits(text: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(text, 16).unwrap_or_else(|_| panic!("bits {text}")))
}

fn parse_cap(text: &str) -> StrokeCap {
    match text {
        "butt" => StrokeCap::Butt,
        "round" => StrokeCap::Round,
        "square" => StrokeCap::Square,
        _ => panic!("cap {text}"),
    }
}

fn parse_join(text: &str) -> StrokeJoin {
    match text {
        "miter" => StrokeJoin::Miter,
        "round" => StrokeJoin::Round,
        "bevel" => StrokeJoin::Bevel,
        _ => panic!("join {text}"),
    }
}

/// `P3STKIN1` then one tab-separated line per case:
/// `name, exponent, width bits, cap, join, miterLimit bits, verb digits, point bits (comma)`,
/// and an optional ninth field of comma-separated test flags.
fn read_input(text: &str) -> Vec<Case> {
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some(INPUT_MAGIC), "input magic");
    lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            assert!(
                fields.len() == 8 || fields.len() == 9,
                "case fields: {line}"
            );
            let flags: Vec<String> = fields
                .get(8)
                .filter(|text| !text.is_empty())
                .map(|text| text.split(',').map(str::to_owned).collect())
                .unwrap_or_default();
            for flag in &flags {
                assert!(
                    matches!(
                        flag.as_str(),
                        "wide"
                            | "knot-join"
                            | "omit-cusp-disk"
                            | "leaf-factor-two"
                            | "band-no-fold"
                            | "band-half-bound"
                    ),
                    "flag {flag}"
                );
            }
            Case {
                name: fields[0].to_owned(),
                request: StrokeRequest {
                    request_id: 0,
                    width: parse_bits(fields[2]),
                    cap: parse_cap(fields[3]),
                    join: parse_join(fields[4]),
                    miter_limit: parse_bits(fields[5]),
                    exponent: fields[1].parse().expect("exponent"),
                },
                verbs: fields[6]
                    .bytes()
                    .map(|digit| {
                        assert!(digit.is_ascii_digit());
                        digit - b'0'
                    })
                    .collect(),
                points: if fields[7].is_empty() {
                    Vec::new()
                } else {
                    fields[7].split(',').map(parse_bits).collect()
                },
                flags,
            }
        })
        .collect()
}

fn hex(value: f64) -> String {
    format!("\"{:016x}\"", value.to_bits())
}

fn point(value: Point) -> String {
    format!("[{},{}]", hex(value.x), hex(value.y))
}

fn triple_text(value: Triple) -> String {
    format!(
        "[{},{},{}]",
        point(value.minus),
        point(value.center),
        point(value.plus)
    )
}

/// A JSON string body: the double quote, the backslash and every control character are escaped.
fn json_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

fn status_name(status: u32) -> &'static str {
    match status {
        STROKE_PATH_EMPTY => "empty",
        STROKE_PATH_INVALID_PATH => "invalid-path",
        STROKE_PATH_INVALID_TOLERANCE => "invalid-tolerance",
        STROKE_PATH_NUMERIC_RANGE => "numeric-range",
        STROKE_PATH_WORK_LIMIT => "work-limit",
        STROKE_PATH_UNSUPPORTED_GEOMETRY => "unsupported-geometry",
        STROKE_PATH_INVALID_STROKE => "invalid-stroke",
        _ => "unknown",
    }
}

fn class_name(class: JoinClass) -> &'static str {
    match class {
        JoinClass::TurnLeft => "turn-left",
        JoinClass::TurnRight => "turn-right",
        JoinClass::Continuation => "continuation",
        JoinClass::Reversal => "reversal",
    }
}

fn cap_name(cap: StrokeCap) -> &'static str {
    match cap {
        StrokeCap::Butt => "butt",
        StrokeCap::Round => "round",
        StrokeCap::Square => "square",
    }
}

fn join_name(join: StrokeJoin) -> &'static str {
    match join {
        StrokeJoin::Miter => "miter",
        StrokeJoin::Round => "round",
        StrokeJoin::Bevel => "bevel",
    }
}

fn dump_case(workspace: &mut StrokeWorkspace, case: &Case) -> String {
    let bytes: Vec<u8> = case.points.iter().flat_map(|v| v.to_le_bytes()).collect();
    {
        let defects = workspace.defects_mut();
        *defects = crate::stroke_outline::StrokeDefects::default();
        for flag in &case.flags {
            match flag.as_str() {
                "knot-join" => defects.knot_join = true,
                "omit-cusp-disk" => defects.omit_cusp_disk = true,
                "leaf-factor-two" => defects.leaf_factor_two = true,
                "band-no-fold" => defects.band_no_fold = true,
                "band-half-bound" => defects.band_half_bound = true,
                _ => {}
            }
        }
    }
    let outcome = workspace.build(case.request, &case.verbs, &bytes);
    let mut line = String::new();
    let request = case.request;
    write!(
        line,
        "{{\"name\":\"{}\",\"request\":{{\"width\":{},\"cap\":\"{}\",\"join\":\"{}\",\"miterLimit\":{},\"exponent\":{}}}",
        json_escape(&case.name),
        hex(request.width),
        cap_name(request.cap),
        join_name(request.join),
        hex(request.miter_limit),
        request.exponent
    )
    .unwrap();
    let status = match outcome {
        Err(_) => "internal-error",
        Ok(StrokeOutcome::Mesh) => "ok",
        Ok(StrokeOutcome::Status(status)) => status_name(status),
    };
    write!(line, ",\"status\":\"{status}\"").unwrap();
    // The failing stage of a non-ok case (test diagnostics; "front-end" or "arrangement").
    let failure = workspace.last_error().map_or("null".to_owned(), |error| {
        let stage = match error {
            crate::stroke_outline::StrokeError::Front(_) => "front-end",
            crate::stroke_outline::StrokeError::Rounded(_) => "arrangement",
        };
        format!("{{\"stage\":\"{stage}\",\"error\":\"{error:?}\"}}")
    });
    write!(line, ",\"failure\":{failure}").unwrap();
    line.push_str(",\"subpaths\":[");
    for (index, subpath) in workspace.subpaths().iter().enumerate() {
        if index > 0 {
            line.push(',');
        }
        write!(
            line,
            "{{\"firstSegment\":{},\"segmentCount\":{},\"closed\":{}}}",
            subpath.first_segment, subpath.segment_count, subpath.closed
        )
        .unwrap();
    }
    line.push_str("],\"segments\":[");
    for (index, segment) in workspace.segments().iter().enumerate() {
        if index > 0 {
            line.push(',');
        }
        let join = segment.join_after.map_or("null".to_owned(), |join| {
            format!(
                "{{\"class\":\"{}\",\"next\":{},\"seam\":{}}}",
                class_name(join.class),
                join.next,
                join.seam
            )
        });
        let class = if segment.cubic {
            format!("\"{}\"", segment.class.name())
        } else {
            "null".to_owned()
        };
        write!(
            line,
            "{{\"subpath\":{},\"verb\":{},\"cubic\":{class},\"a\":{},\"b\":{},\"start\":{},\"end\":{},\"join\":{join}}}",
            segment.subpath,
            segment.verb,
            point(segment.a),
            point(segment.b),
            triple_text(segment.start),
            triple_text(segment.end),
        )
        .unwrap();
    }
    line.push_str("],\"pieces\":[");
    // Since D9 E2-U1 every emitted piece's points are stored; the `r4` cap of 1,024 stored
    // points applies only under the A/B switch `unmerged`.
    let complete = workspace
        .pieces()
        .iter()
        .all(|piece| workspace.piece_points(piece).is_some());
    for (index, piece) in workspace.pieces().iter().enumerate() {
        if index > 0 {
            line.push(',');
        }
        let point_piece = matches!(piece.kind, PieceKind::PointRound | PieceKind::PointSquare);
        let segments = workspace.segments();
        let (verb, next_verb) = if point_piece {
            (piece.segment, None)
        } else {
            let segment = segments[piece.segment];
            let next = segment
                .join_after
                .filter(|_| {
                    matches!(
                        piece.kind,
                        PieceKind::Bevel | PieceKind::Miter | PieceKind::RoundJoin
                    )
                })
                .map(|join| segments[join.next].verb);
            (segment.verb, next)
        };
        let extra = piece.extra[..piece.extra_count]
            .iter()
            .map(|value| point(*value))
            .collect::<Vec<_>>()
            .join(",");
        let meta = piece.meta;
        write!(
            line,
            "{{\"kind\":\"{}\",\"segment\":{},\"verb\":{verb},\"nextVerb\":{},\"dropped\":{},\"extra\":[{extra}],\"t\":[{},{}],\"disk\":{},\"part\":{},\"range\":[{},{}],\"depth\":{},\"index\":{},\"samples\":[{},{}],\"points\":[",
            piece.kind.name(),
            piece.segment,
            next_verb.map_or("null".to_owned(), |verb| verb.to_string()),
            piece.dropped,
            hex(piece.t0),
            hex(piece.t1),
            piece.disk_vertices,
            meta.part,
            hex(meta.range.0),
            hex(meta.range.1),
            meta.depth,
            meta.index,
            triple_text(meta.samples[0]),
            triple_text(meta.samples[1]),
        )
        .unwrap();
        if complete {
            let points = workspace.piece_points(piece).unwrap_or_default();
            for (offset, value) in points.iter().enumerate() {
                if offset > 0 {
                    line.push(',');
                }
                line.push_str(&point(*value));
            }
        }
        line.push_str("]}");
    }
    line.push(']');
    if let (Ok(StrokeOutcome::Mesh), Some((vertices, triangles, boundary))) =
        (outcome, workspace.mesh())
    {
        line.push_str(",\"mesh\":{\"positions\":[");
        for (index, vertex) in vertices.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            write!(line, "{},{}", hex(vertex.x), hex(vertex.y)).unwrap();
        }
        line.push_str("],\"indices\":[");
        for (index, value) in triangles.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            write!(line, "{value}").unwrap();
        }
        line.push_str("],\"boundaryEdges\":[");
        for (index, [a, b]) in boundary.iter().enumerate() {
            if index > 0 {
                line.push(',');
            }
            write!(line, "{a},{b}").unwrap();
        }
        line.push_str("]}");
    } else {
        line.push_str(",\"mesh\":null");
    }
    line.push('}');
    line
}

fn dump(cases: &[Case]) -> String {
    let mut workspace = StrokeWorkspace::new().expect("the stroke workspace reserves");
    let mut wide: Option<StrokeWorkspace> = None;
    let mut text = String::new();
    writeln!(text, "{OUTPUT_MAGIC} {}", cases.len()).unwrap();
    for case in cases {
        let line = if case.flags.iter().any(|flag| flag == "wide") {
            let wide = wide.get_or_insert_with(|| {
                StrokeWorkspace::with_limits(WIDE_TEST_LIMITS).expect("the wide workspace")
            });
            dump_case(wide, case)
        } else {
            dump_case(&mut workspace, case)
        };
        writeln!(text, "{} {line}", line.len()).unwrap();
    }
    text
}

/// The oracles' hand-off (section 11.1), run by `tests/geometry/stroke-oracle.test.ts`.
#[test]
#[ignore = "ST-U3 oracle hand-off; needs P3_STROKE_INPUT and P3_STROKE_DUMP"]
fn emit_stroke_dump() {
    let input = env::var("P3_STROKE_INPUT").expect("P3_STROKE_INPUT is required");
    let text =
        std::fs::read_to_string(&input).unwrap_or_else(|error| panic!("read {input}: {error}"));
    let cases = read_input(&text);
    let output = dump(&cases);
    let path = env::var("P3_STROKE_DUMP").expect("P3_STROKE_DUMP is required");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create the exclusive stroke dump");
    file.write_all(output.as_bytes())
        .expect("write the stroke dump");
    println!(
        "p3-stroke dump: {} cases, {} bytes",
        cases.len(),
        output.len()
    );
}

/// The debug layer's check of the hand-off: a three-case input dumps three framed lines, and
/// a ninth flag field is read.
#[test]
fn dump_reads_its_input_and_frames_each_case() {
    let bits = |value: f64| format!("{:016x}", value.to_bits());
    let points = [0.0, 0.0, 4.0, 0.0]
        .iter()
        .map(|value| bits(*value))
        .collect::<Vec<_>>()
        .join(",");
    let cubic = [0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0]
        .iter()
        .map(|value| bits(*value))
        .collect::<Vec<_>>()
        .join(",");
    let text = format!(
        "{INPUT_MAGIC}\nST-F1\t-3\t{}\tbutt\tmiter\t{}\t01\t{points}\nST-F7\t-3\t{}\tround\tround\t{}\t0\t{}\nF16-D7\t-3\t{}\tbutt\tmiter\t{}\t02\t{cubic}\tomit-cusp-disk\n",
        bits(2.0),
        bits(4.0),
        bits(2.0),
        bits(4.0),
        [bits(4.0), bits(5.0)].join(","),
        bits(0.125),
        bits(4.0),
    );
    let cases = read_input(&text);
    assert_eq!(cases.len(), 3);
    assert_eq!(cases[2].flags, ["omit-cusp-disk"]);
    let output = dump(&cases);
    let mut lines = output.lines();
    assert_eq!(lines.next(), Some("P3STKDUMP1 3"));
    for (expected, line) in ["\"status\":\"ok\"", "\"status\":\"empty\"", "\"cusp\""]
        .into_iter()
        .zip(lines)
    {
        let (length, body) = line.split_once(' ').unwrap();
        assert_eq!(length.parse::<usize>().unwrap(), body.len());
        assert!(body.contains(expected), "{body}");
        if expected == "\"cusp\"" {
            assert!(!body.contains("\"cusp-disk\""), "{body}");
        }
    }
}

/// M6: a case name with a quote, a backslash or a control character stays valid JSON.
#[test]
fn dump_escapes_case_names() {
    assert_eq!(json_escape("ST-F1/a"), "ST-F1/a");
    assert_eq!(json_escape("a\"b\\c"), "a\\\"b\\\\c");
    assert_eq!(json_escape("t\u{1}\u{1f}\r"), "t\\u0001\\u001f\\r");
}
