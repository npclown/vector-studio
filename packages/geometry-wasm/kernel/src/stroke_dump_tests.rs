//! ST-U3 oracle hand-off (`docs/plans/p3-b2-stroke-contract.md` section 11.1): the ignored test
//! `emit_stroke_dump` reads a `P3STKIN1` text input and writes one framed JSON line per case:
//! the request, the status, the classification (segments, triples, joins), every piece with
//! its kind, source segment, parameter interval and emitted points, and the mesh. Every
//! binary64 value is written as its 16-digit hexadecimal bit pattern, so nothing is rounded.
//! `tests/geometry/stroke-oracle.test.ts` writes the input and reads the dump.

use std::env;
use std::fmt::Write as _;
use std::fs::OpenOptions;
use std::io::Write as _;

use crate::geometry::Point;
use crate::stroke_outline::{
    JoinClass, PieceKind, StrokeCap, StrokeJoin, StrokeOutcome, StrokeRequest, StrokeWorkspace,
    STROKE_PATH_EMPTY, STROKE_PATH_INVALID_PATH, STROKE_PATH_INVALID_STROKE,
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
/// `name, exponent, width bits, cap, join, miterLimit bits, verb digits, point bits (comma)`.
fn read_input(text: &str) -> Vec<Case> {
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some(INPUT_MAGIC), "input magic");
    lines
        .filter(|line| !line.is_empty())
        .map(|line| {
            let fields: Vec<&str> = line.split('\t').collect();
            assert_eq!(fields.len(), 8, "case fields: {line}");
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
    let outcome = workspace.build(case.request, &case.verbs, &bytes);
    let mut line = String::new();
    let request = case.request;
    write!(
        line,
        "{{\"name\":\"{}\",\"request\":{{\"width\":{},\"cap\":\"{}\",\"join\":\"{}\",\"miterLimit\":{},\"exponent\":{}}}",
        case.name,
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
        write!(
            line,
            "{{\"subpath\":{},\"a\":{},\"b\":{},\"start\":[{},{},{}],\"end\":[{},{},{}],\"join\":{join}}}",
            segment.subpath,
            point(segment.a),
            point(segment.b),
            point(segment.start.minus),
            point(segment.start.center),
            point(segment.start.plus),
            point(segment.end.minus),
            point(segment.end.center),
            point(segment.end.plus),
        )
        .unwrap();
    }
    line.push_str("],\"pieces\":[");
    let stored: usize = workspace.pieces().iter().map(|piece| piece.count).sum();
    let complete = stored <= crate::stroke_outline::STROKE_V0_LIMITS.max_input_vertices;
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
        write!(
            line,
            "{{\"kind\":\"{}\",\"segment\":{},\"verb\":{verb},\"nextVerb\":{},\"dropped\":{},\"extra\":[{extra}],\"t\":[{},{}],\"disk\":{},\"points\":[",
            piece.kind.name(),
            piece.segment,
            next_verb.map_or("null".to_owned(), |verb| verb.to_string()),
            piece.dropped,
            hex(piece.t0),
            hex(piece.t1),
            piece.disk_vertices
        )
        .unwrap();
        if complete {
            for (offset, value) in workspace.piece_points(piece).iter().enumerate() {
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
    let mut text = String::new();
    writeln!(text, "{OUTPUT_MAGIC} {}", cases.len()).unwrap();
    for case in cases {
        let line = dump_case(&mut workspace, case);
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

/// The debug layer's check of the hand-off: a two-case input dumps two framed lines.
#[test]
fn dump_reads_its_input_and_frames_each_case() {
    let bits = |value: f64| format!("{:016x}", value.to_bits());
    let points = [0.0, 0.0, 4.0, 0.0]
        .iter()
        .map(|value| bits(*value))
        .collect::<Vec<_>>()
        .join(",");
    let text = format!(
        "{INPUT_MAGIC}\nST-F1\t-3\t{}\tbutt\tmiter\t{}\t01\t{points}\nST-F7\t-3\t{}\tround\tround\t{}\t0\t{}\n",
        bits(2.0),
        bits(4.0),
        bits(2.0),
        bits(4.0),
        [bits(4.0), bits(5.0)].join(","),
    );
    let cases = read_input(&text);
    assert_eq!(cases.len(), 2);
    let output = dump(&cases);
    let mut lines = output.lines();
    assert_eq!(lines.next(), Some("P3STKDUMP1 2"));
    for (expected, line) in ["\"status\":\"ok\"", "\"status\":\"empty\""]
        .into_iter()
        .zip(lines)
    {
        let (length, body) = line.split_once(' ').unwrap();
        assert_eq!(length.parse::<usize>().unwrap(), body.len());
        assert!(body.contains(expected), "{body}");
    }
}
