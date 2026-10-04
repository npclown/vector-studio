use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::geometry::{Point, Provenance};
use crate::simple_cubic_topology::{
    certify_transverse_pair, TopologyError, TransverseLeafInput, TransversePairCertificate,
};

const FIXTURE_HEADER: &str = "p3-transverse-pairs-v1 60";
const FIXTURE_ROWS: usize = 60;
const FIXTURE_TOKENS: usize = 33;
const MAX_FIXTURE_BYTES: usize = 128 * 1024;
const EXPECTED_IDS: [&str; FIXTURE_ROWS] = [
    "S-base",
    "S-swap",
    "S-reflect-x",
    "S-reverse-both",
    "S-reverse-first",
    "N-base",
    "N-swap",
    "N-reflect-x",
    "N-reverse-both",
    "N-reverse-first",
    "K-base",
    "K-swap",
    "K-reflect-x",
    "K-reverse-both",
    "K-reverse-first",
    "U-base",
    "U-swap",
    "U-reflect-x",
    "U-reverse-both",
    "D0-base",
    "D0-swap",
    "D0-reflect-x",
    "D0-reverse-both",
    "D0-reverse-first",
    "D1-base",
    "D1-swap",
    "D1-reflect-x",
    "D1-reverse-both",
    "D1-reverse-first",
    "MIN-base",
    "MIN-swap",
    "MIN-reflect-x",
    "MIN-reverse-both",
    "MIN-reverse-first",
    "MAX-base",
    "MAX-swap",
    "MAX-reflect-x",
    "MAX-reverse-both",
    "MAX-reverse-first",
    "G01",
    "G02",
    "G03",
    "G04",
    "G05",
    "G06",
    "G07",
    "G08",
    "G09",
    "G10",
    "I01",
    "I02",
    "I03",
    "I04",
    "I05",
    "I06",
    "I07",
    "I08",
    "I09",
    "I10",
    "I11",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExpectedStatus {
    Certified,
    InvalidInput,
    InvalidProvenance,
    Unresolved,
}

impl ExpectedStatus {
    fn error(self) -> Option<TopologyError> {
        match self {
            Self::Certified => None,
            Self::InvalidInput => Some(TopologyError::InvalidInput),
            Self::InvalidProvenance => Some(TopologyError::InvalidProvenance),
            Self::Unresolved => Some(TopologyError::Unresolved),
        }
    }
}

#[derive(Clone, Debug)]
struct FixtureRow {
    id: String,
    status: ExpectedStatus,
    orientation: i8,
    leaves: [TransverseLeafInput; 2],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct InputSnapshot {
    provenances: [Provenance; 2],
    coordinate_bits: [[u64; 12]; 2],
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/p3-transverse-pairs-v1.txt")
}

fn load_fixture_bytes() -> Vec<u8> {
    let path = fixture_path();
    let file = File::open(&path).unwrap_or_else(|error| panic!("open {}: {error}", path.display()));
    let mut bytes = Vec::with_capacity(MAX_FIXTURE_BYTES + 1);
    file.take((MAX_FIXTURE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    bytes
}

fn parse_fixture_bytes(bytes: &[u8]) -> Result<Vec<FixtureRow>, String> {
    if bytes.len() > MAX_FIXTURE_BYTES {
        return Err("fixture exceeds 128 KiB".to_owned());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "fixture is not UTF-8".to_owned())?;
    if !text.is_ascii() {
        return Err("fixture is not ASCII".to_owned());
    }
    parse_fixture_text(text)
}

fn parse_fixture_text(text: &str) -> Result<Vec<FixtureRow>, String> {
    if text.len() > MAX_FIXTURE_BYTES {
        return Err("fixture exceeds 128 KiB".to_owned());
    }
    if text.contains('\r') {
        return Err("fixture must use LF line endings".to_owned());
    }
    let body = text
        .strip_suffix('\n')
        .ok_or_else(|| "fixture must be LF-terminated".to_owned())?;
    let mut lines = body.split('\n');
    if lines.next() != Some(FIXTURE_HEADER) {
        return Err("fixture header mismatch".to_owned());
    }

    let mut rows = Vec::with_capacity(FIXTURE_ROWS);
    let mut ids = HashSet::with_capacity(FIXTURE_ROWS);
    for line in lines {
        if line.is_empty() {
            return Err("blank fixture row".to_owned());
        }
        let tokens: Vec<&str> = line.split(' ').collect();
        if tokens.len() != FIXTURE_TOKENS || tokens.iter().any(|token| token.is_empty()) {
            return Err("fixture row must have exactly 33 single-space tokens".to_owned());
        }
        let id = tokens[0];
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("invalid fixture id".to_owned());
        }
        if !ids.insert(id.to_owned()) {
            return Err("duplicate fixture id".to_owned());
        }

        let status = match tokens[1] {
            "Certified" => ExpectedStatus::Certified,
            "InvalidInput" => ExpectedStatus::InvalidInput,
            "InvalidProvenance" => ExpectedStatus::InvalidProvenance,
            "Unresolved" => ExpectedStatus::Unresolved,
            _ => return Err("invalid fixture status".to_owned()),
        };
        let orientation = match tokens[2] {
            "-1" => -1,
            "0" => 0,
            "1" => 1,
            _ => return Err("invalid fixture orientation".to_owned()),
        };
        if (status == ExpectedStatus::Certified) != (orientation != 0) {
            return Err("fixture status/orientation mismatch".to_owned());
        }

        rows.push(FixtureRow {
            id: id.to_owned(),
            status,
            orientation,
            leaves: [parse_leaf(&tokens, 3)?, parse_leaf(&tokens, 18)?],
        });
    }
    if rows.len() != FIXTURE_ROWS {
        return Err(format!(
            "fixture row count {}, expected {FIXTURE_ROWS}",
            rows.len()
        ));
    }
    Ok(rows)
}

fn parse_leaf(tokens: &[&str], offset: usize) -> Result<TransverseLeafInput, String> {
    let provenance = Provenance {
        source_verb: parse_decimal(tokens[offset])?,
        end_numerator: parse_decimal(tokens[offset + 1])?,
        depth: parse_decimal(tokens[offset + 2])?,
    };
    let source = [
        parse_point(tokens, offset + 3)?,
        parse_point(tokens, offset + 5)?,
        parse_point(tokens, offset + 7)?,
        parse_point(tokens, offset + 9)?,
    ];
    let actual = [
        parse_point(tokens, offset + 11)?,
        parse_point(tokens, offset + 13)?,
    ];
    Ok(TransverseLeafInput {
        source,
        provenance,
        actual,
    })
}

fn parse_point(tokens: &[&str], offset: usize) -> Result<Point, String> {
    Ok(Point {
        x: f64::from_bits(parse_bits(tokens[offset])?),
        y: f64::from_bits(parse_bits(tokens[offset + 1])?),
    })
}

fn parse_decimal(token: &str) -> Result<u32, String> {
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("invalid decimal u32".to_owned());
    }
    token
        .parse::<u32>()
        .map_err(|_| "decimal u32 overflow".to_owned())
}

fn parse_bits(token: &str) -> Result<u64, String> {
    if token.len() != 16
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid binary64 bit token".to_owned());
    }
    u64::from_str_radix(token, 16).map_err(|_| "invalid binary64 bits".to_owned())
}

fn snapshot(leaves: &[TransverseLeafInput; 2]) -> InputSnapshot {
    InputSnapshot {
        provenances: [leaves[0].provenance, leaves[1].provenance],
        coordinate_bits: leaves.map(|leaf| {
            let mut bits = [0u64; 12];
            for (index, point) in leaf.source.iter().enumerate() {
                bits[index * 2] = point.x.to_bits();
                bits[index * 2 + 1] = point.y.to_bits();
            }
            for (index, point) in leaf.actual.iter().enumerate() {
                bits[8 + index * 2] = point.x.to_bits();
                bits[9 + index * 2] = point.y.to_bits();
            }
            bits
        }),
    }
}

fn measured_certify(
    leaves: &[TransverseLeafInput; 2],
) -> Result<TransversePairCertificate, TopologyError> {
    crate::allocation_test_support::start();
    let result = certify_transverse_pair(leaves);
    let allocations = crate::allocation_test_support::stop();
    assert_eq!(allocations, 0, "transverse pair certification allocated");
    result
}

fn replace_token(text: &str, row: usize, token: usize, replacement: &str) -> String {
    let mut lines: Vec<String> = text
        .strip_suffix('\n')
        .expect("reviewed fixture is LF-terminated")
        .split('\n')
        .map(str::to_owned)
        .collect();
    let mut tokens: Vec<&str> = lines[row].split(' ').collect();
    tokens[token] = replacement;
    lines[row] = tokens.join(" ");
    format!("{}\n", lines.join("\n"))
}

#[test]
fn frozen_sixty_rows_match_native_certificate_and_failure_precedence() {
    let rows = parse_fixture_bytes(&load_fixture_bytes()).expect("reviewed transverse fixture");
    assert_eq!(rows.len(), FIXTURE_ROWS);
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        EXPECTED_IDS
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.status == ExpectedStatus::Certified)
            .count(),
        39
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.status == ExpectedStatus::Unresolved)
            .count(),
        10
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.status == ExpectedStatus::InvalidInput)
            .count(),
        5
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.status == ExpectedStatus::InvalidProvenance)
            .count(),
        6
    );

    for row in &rows {
        let before = snapshot(&row.leaves);
        let first = measured_certify(&row.leaves);
        assert_eq!(snapshot(&row.leaves), before, "{} changed inputs", row.id);
        let second = measured_certify(&row.leaves);
        assert_eq!(second, first, "{} changed across repeated calls", row.id);
        assert_eq!(snapshot(&row.leaves), before, "{} changed inputs", row.id);

        match row.status.error() {
            None => {
                let certificate = first.unwrap_or_else(|error| {
                    panic!("{} expected certificate, got {error:?}", row.id)
                });
                assert_eq!(certificate.leaves, before.provenances, "{}", row.id);
                assert_eq!(certificate.orientation, row.orientation, "{}", row.id);
            }
            Some(error) => assert_eq!(first, Err(error), "{}", row.id),
        }
    }
}

#[test]
fn returned_copies_survive_later_input_changes_and_failures() {
    let rows = parse_fixture_bytes(&load_fixture_bytes()).expect("reviewed transverse fixture");
    let success = rows
        .iter()
        .find(|row| row.status == ExpectedStatus::Certified)
        .expect("fixture success");
    let failure = rows
        .iter()
        .find(|row| row.status != ExpectedStatus::Certified)
        .expect("fixture failure");

    let mut inputs = success.leaves;
    let certificate = measured_certify(&inputs).expect("fixture certificate");
    let saved_certificate = certificate;
    inputs[0].provenance = Provenance::default();
    inputs[0].source[0].x = 123.0;
    inputs[0].actual[0].y = -456.0;
    assert_ne!(snapshot(&inputs), snapshot(&success.leaves));
    assert_eq!(certificate, saved_certificate);

    assert_eq!(
        measured_certify(&failure.leaves),
        Err(failure.status.error().expect("fixture error"))
    );
    assert_eq!(certificate, saved_certificate);
    assert_eq!(
        certificate.leaves,
        success.leaves.map(|leaf| leaf.provenance)
    );

    let recovered = measured_certify(&success.leaves).expect("fixture certificate recovery");
    assert_eq!(recovered, saved_certificate);
    assert_eq!(certificate, saved_certificate);

    let mut opaque_ordinals = success.leaves;
    opaque_ordinals[0].provenance.source_verb = 0;
    opaque_ordinals[1].provenance.source_verb = u32::MAX;
    let opaque_certificate = measured_certify(&opaque_ordinals).expect("opaque source ordinals");
    assert_eq!(
        opaque_certificate.leaves,
        opaque_ordinals.map(|leaf| leaf.provenance)
    );
    assert_eq!(opaque_certificate.orientation, success.orientation);
}

#[test]
fn malformed_fixture_controls_reject() {
    let bytes = load_fixture_bytes();
    let text = std::str::from_utf8(&bytes).expect("reviewed fixture UTF-8");
    parse_fixture_text(text).expect("reviewed transverse fixture");

    let without_last_row = {
        let mut lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
        lines.pop();
        format!("{}\n", lines.join("\n"))
    };
    let extra_row = {
        let last = text.trim_end_matches('\n').rsplit('\n').next().unwrap();
        format!("{text}{last}\n")
    };
    let duplicate_id = {
        let first_id = text.lines().nth(1).unwrap().split(' ').next().unwrap();
        replace_token(text, 2, 0, first_id)
    };
    let controls = [
        text.replacen(FIXTURE_HEADER, "p3-transverse-pairs-v2 60", 1),
        text.replacen('\n', "\r\n", 1),
        text.trim_end_matches('\n').to_owned(),
        format!("{text}\n"),
        without_last_row,
        extra_row,
        duplicate_id,
        replace_token(text, 1, 1, "Unknown"),
        replace_token(text, 1, 2, "0"),
        replace_token(text, 1, 3, "+1"),
        replace_token(text, 1, 6, "3ff000000000000A"),
        replace_token(text, 1, 0, "bad_id"),
        replace_token(text, 1, 0, &"x".repeat(65)),
        format!("{} extra\n", text.trim_end_matches('\n')),
    ];
    for (index, control) in controls.iter().enumerate() {
        assert!(
            parse_fixture_text(control).is_err(),
            "malformed control {index} accepted"
        );
    }
    assert!(parse_fixture_bytes(&[0xff]).is_err());
    assert!(parse_fixture_bytes(&vec![b'x'; MAX_FIXTURE_BYTES + 1]).is_err());
}
