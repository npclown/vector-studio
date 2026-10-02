use core::mem::size_of;
use std::collections::HashSet;
use std::env;
use std::fs::File;
use std::io::Read;

use crate::geometry::{Point, Provenance};
use crate::rounded_line_fill_tests::print_points;
use crate::simple_cubic_topology::{
    SimpleCubicTopologyWorkspace, TopologyCubic, TopologyError, TopologyInput, TopologyLeaf,
    TopologyLimits, TopologyOutput, TopologyRange,
};

const INPUT_LIMIT_BYTES: u64 = 512 * 1024;
const EXPECTED_ROWS: usize = 54;

pub(crate) struct SourceRow {
    pub(crate) id: String,
    pub(crate) contours: Vec<TopologyRange>,
    pub(crate) cubics: Vec<TopologyCubic>,
    pub(crate) leaves: Vec<TopologyLeaf>,
}

fn exact_tokens<'a>(line: &'a str, expected: usize, label: &str) -> Vec<&'a str> {
    let tokens: Vec<_> = line.split_ascii_whitespace().collect();
    assert_eq!(tokens.len(), expected, "{label} field count");
    assert_eq!(tokens.join(" "), line, "{label} spacing");
    tokens
}

fn decimal_usize(token: &str, label: &str) -> usize {
    let value: usize = token.parse().unwrap_or_else(|_| panic!("{label} integer"));
    assert_eq!(value.to_string(), token, "{label} canonical integer");
    value
}

fn decimal_u32(token: &str, label: &str) -> u32 {
    let value: u32 = token.parse().unwrap_or_else(|_| panic!("{label} u32"));
    assert_eq!(value.to_string(), token, "{label} canonical u32");
    value
}

fn finite_bits(token: &str, label: &str) -> f64 {
    assert_eq!(token.len(), 16, "{label} bits length");
    assert!(
        token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "{label} lowercase hexadecimal"
    );
    let bits = u64::from_str_radix(token, 16).unwrap_or_else(|_| panic!("{label} bits"));
    let value = f64::from_bits(bits);
    assert!(value.is_finite(), "{label} finite");
    value
}

fn parse_fixture() -> Vec<SourceRow> {
    let path = env::var("P3_NATIVE_TOPOLOGY_INPUT").expect("P3_NATIVE_TOPOLOGY_INPUT required");
    read_topology_fixture(&path, "# p3-native-topology-v1", EXPECTED_ROWS)
}

pub(crate) fn read_topology_fixture(
    path: &str,
    expected_header: &str,
    expected_rows: usize,
) -> Vec<SourceRow> {
    assert!(
        (1..=EXPECTED_ROWS).contains(&expected_rows),
        "fixture row limit"
    );
    let mut bytes = Vec::new();
    File::open(path)
        .expect("native topology fixture open")
        .take(INPUT_LIMIT_BYTES + 1)
        .read_to_end(&mut bytes)
        .expect("native topology fixture read");
    assert!(
        bytes.len() <= INPUT_LIMIT_BYTES as usize,
        "fixture byte limit"
    );
    let text = String::from_utf8(bytes).expect("fixture UTF-8");
    assert!(!text.contains('\r'), "fixture must use LF");
    assert!(text.ends_with('\n'), "fixture terminal LF");
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some(expected_header));
    let row_header = format!("# rows {expected_rows}");
    assert_eq!(lines.next(), Some(row_header.as_str()));

    let mut rows = Vec::with_capacity(expected_rows);
    let mut ids = HashSet::with_capacity(expected_rows);
    for row_index in 0..expected_rows {
        let header = exact_tokens(
            lines.next().expect("row header"),
            3,
            &format!("row {row_index}"),
        );
        assert_eq!(header[0], "row");
        assert!(
            !header[1].is_empty()
                && header[1]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'/' || byte == b'-'),
            "row {row_index} id"
        );
        assert!(ids.insert(header[1].to_owned()), "duplicate row id");
        let contour_count = decimal_usize(header[2], "contour count");
        assert!((1..=4).contains(&contour_count), "contour count limit");
        let mut contours = Vec::with_capacity(contour_count);
        let mut cubics = Vec::new();
        let mut leaves = Vec::new();

        for contour_index in 0..contour_count {
            let contour_line = exact_tokens(
                lines.next().expect("contour row"),
                2,
                &format!("row {row_index} contour {contour_index}"),
            );
            assert_eq!(contour_line[0], "contour");
            let cubic_count = decimal_usize(contour_line[1], "cubic count");
            assert!(cubic_count > 0, "empty contour");
            assert!(cubic_count <= 16 - cubics.len(), "cubic count limit");
            let cubic_start = cubics.len();
            for cubic_index in 0..cubic_count {
                let cubic_line = exact_tokens(
                    lines.next().expect("cubic row"),
                    11,
                    &format!("row {row_index} contour {contour_index} cubic {cubic_index}"),
                );
                assert_eq!(cubic_line[0], "cubic");
                let source_verb = decimal_u32(cubic_line[1], "cubic source");
                let points = [
                    Point {
                        x: finite_bits(cubic_line[2], "p0x"),
                        y: finite_bits(cubic_line[3], "p0y"),
                    },
                    Point {
                        x: finite_bits(cubic_line[4], "p1x"),
                        y: finite_bits(cubic_line[5], "p1y"),
                    },
                    Point {
                        x: finite_bits(cubic_line[6], "p2x"),
                        y: finite_bits(cubic_line[7], "p2y"),
                    },
                    Point {
                        x: finite_bits(cubic_line[8], "p3x"),
                        y: finite_bits(cubic_line[9], "p3y"),
                    },
                ];
                let leaf_count = decimal_usize(cubic_line[10], "leaf count");
                assert!(leaf_count > 0, "empty cubic leaf range");
                assert!(leaf_count <= 64 - leaves.len(), "leaf count limit");
                let leaf_start = leaves.len();
                for leaf_index in 0..leaf_count {
                    let leaf_line = exact_tokens(
                        lines.next().expect("leaf row"),
                        6,
                        &format!(
                            "row {row_index} contour {contour_index} cubic {cubic_index} leaf {leaf_index}"
                        ),
                    );
                    assert_eq!(leaf_line[0], "leaf");
                    leaves.push(TopologyLeaf {
                        end: Point {
                            x: finite_bits(leaf_line[4], "leaf x"),
                            y: finite_bits(leaf_line[5], "leaf y"),
                        },
                        provenance: Provenance {
                            source_verb: decimal_u32(leaf_line[1], "leaf source"),
                            end_numerator: decimal_u32(leaf_line[2], "leaf numerator"),
                            depth: decimal_u32(leaf_line[3], "leaf depth"),
                        },
                    });
                }
                cubics.push(TopologyCubic {
                    points,
                    source_verb,
                    leaves: TopologyRange {
                        start: leaf_start,
                        count: leaf_count,
                    },
                });
            }
            contours.push(TopologyRange {
                start: cubic_start,
                count: cubic_count,
            });
        }
        let end = exact_tokens(
            lines.next().expect("row end"),
            1,
            &format!("row {row_index} end"),
        );
        assert_eq!(end[0], "end");
        rows.push(SourceRow {
            id: header[1].to_owned(),
            contours,
            cubics,
            leaves,
        });
    }
    assert!(lines.next().is_none(), "extra fixture rows");
    rows
}

pub(crate) fn status_name(result: Result<(), TopologyError>) -> &'static str {
    match result {
        Ok(()) => "Certified",
        Err(TopologyError::InvalidLimits) => "InvalidLimits",
        Err(TopologyError::AllocationFailed) => "AllocationFailed",
        Err(TopologyError::ByteLimit) => "ByteLimit",
        Err(TopologyError::InvalidInput) => "InvalidInput",
        Err(TopologyError::InvalidProvenance) => "InvalidProvenance",
        Err(TopologyError::KnotMismatch) => "KnotMismatch",
        Err(TopologyError::Unresolved) => "Unresolved",
        Err(TopologyError::WorkLimit) => "WorkLimit",
    }
}

fn print_token(token: &str, first: &mut bool) {
    if !*first {
        print!(",");
    }
    *first = false;
    print!("\"{token}\"");
}

fn print_usize(value: usize, first: &mut bool) {
    print_token(&value.to_string(), first);
}

fn print_u32(value: u32, first: &mut bool) {
    print_token(&value.to_string(), first);
}

fn print_bits(value: f64, first: &mut bool) {
    print_token(&format!("{:016x}", value.to_bits()), first);
}

pub(crate) fn print_input_tokens(row: &SourceRow) {
    print!("[");
    let mut first = true;
    print_token("row", &mut first);
    print_token(&row.id, &mut first);
    print_usize(row.contours.len(), &mut first);
    for contour in &row.contours {
        print_token("contour", &mut first);
        print_usize(contour.count, &mut first);
        for cubic in &row.cubics[contour.start..contour.start + contour.count] {
            print_token("cubic", &mut first);
            print_u32(cubic.source_verb, &mut first);
            for point in cubic.points {
                print_bits(point.x, &mut first);
                print_bits(point.y, &mut first);
            }
            print_usize(cubic.leaves.count, &mut first);
            for leaf in &row.leaves[cubic.leaves.start..cubic.leaves.start + cubic.leaves.count] {
                print_token("leaf", &mut first);
                print_u32(leaf.provenance.source_verb, &mut first);
                print_u32(leaf.provenance.end_numerator, &mut first);
                print_u32(leaf.provenance.depth, &mut first);
                print_bits(leaf.end.x, &mut first);
                print_bits(leaf.end.y, &mut first);
            }
        }
    }
    print_token("end", &mut first);
    print!("]");
}

fn print_ranges(ranges: &[TopologyRange]) {
    print!("[");
    for (index, range) in ranges.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!("{{\"start\":{},\"count\":{}}}", range.start, range.count);
    }
    print!("]");
}

pub(crate) fn print_output(output: TopologyOutput<'_>) {
    print!("{{\"points\":");
    print_points(output.points);
    print!(",\"contours\":");
    print_ranges(output.contours);
    print!(",\"orientations\":[");
    for (index, orientation) in output.orientations.iter().enumerate() {
        if index != 0 {
            print!(",");
        }
        print!("{orientation}");
    }
    print!("],\"winding\":[");
    for (row_index, row) in output.winding.iter().enumerate() {
        if row_index != 0 {
            print!(",");
        }
        print!("[{},{},{},{}]", row[0], row[1], row[2], row[3]);
    }
    print!("]}}");
}

fn certify_checked(
    limits: TopologyLimits,
    contours: &[TopologyRange],
    cubics: &[TopologyCubic],
    leaves: &[TopologyLeaf],
    expected: Result<(), TopologyError>,
    expected_leaves: usize,
    expected_pairs: usize,
) {
    let mut workspace = SimpleCubicTopologyWorkspace::new(limits).unwrap();
    let allocated_bytes = workspace.allocated_bytes();
    crate::allocation_test_support::start();
    let result = workspace.certify(TopologyInput {
        contours,
        cubics,
        leaves,
    });
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(result, expected);
    assert_eq!(workspace.stats().leaves, expected_leaves);
    assert_eq!(workspace.stats().pairs, expected_pairs);
    assert_eq!(allocations, 0);
    assert_eq!(workspace.allocated_bytes(), allocated_bytes);
    assert_eq!(workspace.output().is_some(), result.is_ok());
}

fn verify_literal_limits(rows: &[SourceRow]) {
    let c04 = rows.iter().find(|row| row.id == "C04/identity").unwrap();
    certify_checked(
        TopologyLimits {
            max_leaves: 12,
            ..TopologyLimits::default()
        },
        &c04.contours,
        &c04.cubics,
        &c04.leaves,
        Err(TopologyError::WorkLimit),
        12,
        0,
    );
    certify_checked(
        TopologyLimits {
            max_leaves: 13,
            ..TopologyLimits::default()
        },
        &c04.contours,
        &c04.cubics,
        &c04.leaves,
        Ok(()),
        13,
        78,
    );

    let negative = rows
        .iter()
        .find(|row| row.id == "negative-projection")
        .unwrap();
    let mut combined_contours = c04.contours.clone();
    combined_contours.push(TopologyRange {
        start: c04.cubics.len(),
        count: negative.cubics.len(),
    });
    let mut combined_cubics = c04.cubics.clone();
    combined_cubics.extend(negative.cubics.iter().map(|cubic| TopologyCubic {
        source_verb: 99,
        leaves: TopologyRange {
            start: cubic.leaves.start + c04.leaves.len(),
            count: cubic.leaves.count,
        },
        ..*cubic
    }));
    let mut combined_leaves = c04.leaves.clone();
    combined_leaves.extend(negative.leaves.iter().map(|leaf| TopologyLeaf {
        provenance: Provenance {
            source_verb: 99,
            ..leaf.provenance
        },
        ..*leaf
    }));
    certify_checked(
        TopologyLimits {
            max_leaves: 13,
            ..TopologyLimits::default()
        },
        &combined_contours,
        &combined_cubics,
        &combined_leaves,
        Err(TopologyError::WorkLimit),
        13,
        0,
    );

    let c05 = rows.iter().find(|row| row.id == "C05/identity").unwrap();
    certify_checked(
        TopologyLimits::default(),
        &c05.contours,
        &c05.cubics,
        &c05.leaves,
        Ok(()),
        64,
        2016,
    );
    for limits in [
        TopologyLimits {
            max_contours: 3,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_cubics: 15,
            ..TopologyLimits::default()
        },
        TopologyLimits {
            max_leaves: 63,
            ..TopologyLimits::default()
        },
    ] {
        certify_checked(
            limits,
            &c05.contours,
            &c05.cubics,
            &c05.leaves,
            Err(TopologyError::WorkLimit),
            0,
            0,
        );
    }
    certify_checked(
        TopologyLimits {
            max_pairs: 2015,
            ..TopologyLimits::default()
        },
        &c05.contours,
        &c05.cubics,
        &c05.leaves,
        Err(TopologyError::WorkLimit),
        64,
        2015,
    );
}

#[test]
#[ignore]
fn emit_simple_cubic_topology() {
    let rows = parse_fixture();
    verify_literal_limits(&rows);
    let mut workspace = SimpleCubicTopologyWorkspace::new(TopologyLimits::default()).unwrap();
    let allocated_bytes = workspace.allocated_bytes();
    let inline_bytes = size_of::<SimpleCubicTopologyWorkspace>();
    println!("P3_NATIVE_TOPOLOGY_BEGIN");
    for row in rows {
        let input = TopologyInput {
            contours: &row.contours,
            cubics: &row.cubics,
            leaves: &row.leaves,
        };
        crate::allocation_test_support::start();
        let result = workspace.certify(input);
        let allocations = crate::allocation_test_support::stop();
        let stats = workspace.stats();
        assert_eq!(workspace.allocated_bytes(), allocated_bytes);
        print!("{{\"id\":\"{}\",\"input_tokens\":", row.id);
        print_input_tokens(&row);
        print!(
            ",\"status\":\"{}\",\"leaves\":{},\"pairs\":{},\"output\":",
            status_name(result),
            stats.leaves,
            stats.pairs
        );
        match workspace.output() {
            Some(output) => print_output(output),
            None => print!("null"),
        }
        println!(
            ",\"allocations\":{allocations},\"allocated_bytes\":{allocated_bytes},\"inline_bytes\":{inline_bytes}}}"
        );
    }
    println!("P3_NATIVE_TOPOLOGY_END");
}
