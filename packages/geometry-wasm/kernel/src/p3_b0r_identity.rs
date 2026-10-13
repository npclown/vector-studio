//! B0R unit U0: native identity digest harness for `pnpm test:p3-fill-identity`
//! (docs/plans/p3-b0r-kernel-performance-contract.md section 7, oracles O4 and O7).
//!
//! The ignored test runs in the release test profile on this tree and on the merge base, into
//! which `tooling/compare-p3-fill-identity.mjs` copies this file and its `mod` declaration (the
//! bootstrap overlay). It must therefore use only crate APIs that exist at the B0R merge base.
//!
//! Every case runs one entry on one path and records a SHA-256 digest of every observable
//! section 2 field: the result with its exact error variant, `CubicFillDiagnostics`,
//! `topology_stats()`, `rounded_stats()`, `allocated_bytes()` and, when published, the complete
//! `output()` (commands, ranges, points, owners, sources, the rounded mesh with its ledger, and
//! the mesh vertex f64 bits). Values are rendered with `Debug`, whose f64 form is the shortest
//! round-trip representation (bit-exact for every non-NaN value, signed zero included); mesh
//! vertices are also hashed as raw bits. The V2 cascade case digests the `FillEngine` batch
//! status, `result_len`, `required_output_bytes` and every published output byte.
//!
//! O7: the tracking allocator counts only inside the entry call (`attempt*` or
//! `FillEngine::process`); digests, formatting and packing run outside that window.
use core::fmt::{self, Write as _};
use core::mem::size_of;
use std::env;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;

use crate::codec::{PathInput, Request};
use crate::cubic_fill::{
    CubicFillDiagnostics, CubicFillError, CubicFillWorkspace, MAX_FLAT_COMMANDS,
};
use crate::engine::BATCH_OK;
use crate::fill_export::{tolerances, FillEngine, FILL_INPUT_MAGIC};
use crate::line_fill::LineFillRule;
use crate::native_cubic_fill_tests::{FLATTEN_TOLERANCE, LIMITS, TOPOLOGY_TOLERANCE};

const B0_MAGIC: &[u8; 8] = b"P3B0COR1";
const RANDOM_MAGIC: &[u8; 8] = b"P3BRRND1";
/// B0 runs at flattening tolerance 0.125 and topology tolerance 0.0625, that is 2^-3.
const B0_EXPONENT: i32 = -3;
/// Randomized families are split into chunks of this many paths; each chunk starts from fresh
/// workspaces, so the case sequence seen by each workspace is fixed by this constant.
const RANDOM_CHUNK: usize = 50;
const ENGINE_INPUT_BYTES: u32 = 64 * 1024;
const ENGINE_OUTPUT_BYTES: u32 = 1024 * 1024;
const OUTPUT_HEADER_BYTES: usize = 64;
const THREAD_STACK_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy)]
enum Entry {
    Attempt,
    Transverse,
    Mixed,
    TriangleFree,
}

const ENTRIES: [(Entry, &str); 4] = [
    (Entry::Attempt, "attempt"),
    (Entry::Transverse, "attempt_transverse"),
    (Entry::Mixed, "attempt_mixed_transverse"),
    (Entry::TriangleFree, "attempt_triangle_free"),
];

struct CorpusPath {
    rule: LineFillRule,
    exponent: i32,
    verbs: Vec<u8>,
    point_bytes: Vec<u8>,
}

/// A run of consecutive paths of one cell or family, processed by fresh workspaces.
struct Chunk {
    prefix: String,
    first: usize,
    paths: Vec<CorpusPath>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> &[u8] {
        let end = self
            .offset
            .checked_add(count)
            .expect("corpus offset overflow");
        assert!(end <= self.bytes.len(), "truncated corpus");
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        slice
    }

    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }

    fn u32(&mut self) -> usize {
        let bytes: [u8; 4] = self.take(4).try_into().expect("u32 width");
        usize::try_from(u32::from_le_bytes(bytes)).expect("u32 fits usize")
    }

    fn i32(&mut self) -> i32 {
        let bytes: [u8; 4] = self.take(4).try_into().expect("i32 width");
        i32::from_le_bytes(bytes)
    }

    fn string(&mut self) -> String {
        let length = self.u32();
        String::from_utf8(self.take(length).to_vec()).expect("ASCII identifier")
    }

    fn path(&mut self, rule: LineFillRule, exponent: i32) -> CorpusPath {
        let verb_count = self.u32();
        let verbs = self.take(verb_count).to_vec();
        let scalar_count = self.u32();
        let point_bytes = self
            .take(scalar_count.checked_mul(8).expect("scalar bytes"))
            .to_vec();
        CorpusPath {
            rule,
            exponent,
            verbs,
            point_bytes,
        }
    }

    fn finish(&self) {
        assert_eq!(self.offset, self.bytes.len(), "trailing corpus bytes");
    }
}

/// The frozen B0 frame (`tests/geometry/p3-b0/corpus.ts`): one chunk per cell, nonzero rule.
fn read_b0(bytes: &[u8]) -> Vec<Chunk> {
    let mut reader = Reader { bytes, offset: 0 };
    assert_eq!(reader.take(8), B0_MAGIC, "B0 corpus magic");
    let cells = reader.u32();
    let mut chunks = Vec::with_capacity(cells);
    for _ in 0..cells {
        let id = reader.string();
        let _entry = reader.u8();
        let _contours = reader.u32();
        let _cubics = reader.u32();
        let _lambda = reader.u32();
        let count = reader.u32();
        let paths = (0..count)
            .map(|_| reader.path(LineFillRule::Nonzero, B0_EXPONENT))
            .collect();
        chunks.push(Chunk {
            prefix: format!("b0/{id}"),
            first: 0,
            paths,
        });
    }
    reader.finish();
    chunks
}

/// The `p3-b0r-random/v1` frame (`tests/geometry/p3-b0r/corpus.ts`).
fn read_random(bytes: &[u8]) -> Vec<Chunk> {
    let mut reader = Reader { bytes, offset: 0 };
    assert_eq!(reader.take(8), RANDOM_MAGIC, "randomized corpus magic");
    let families = reader.u32();
    let mut chunks = Vec::new();
    for _ in 0..families {
        let id = reader.string();
        let _entry = reader.u8();
        let count = reader.u32();
        let mut paths = Vec::with_capacity(count);
        for _ in 0..count {
            let rule = match reader.u8() {
                0 => LineFillRule::Nonzero,
                1 => LineFillRule::Evenodd,
                other => panic!("unknown fill rule {other}"),
            };
            let exponent = reader.i32();
            assert!(
                (-1021..=1023).contains(&exponent),
                "tolerance exponent {exponent} outside the fill-v0 range"
            );
            paths.push(reader.path(rule, exponent));
        }
        let mut first = 0;
        let mut rest = paths.into_iter().peekable();
        while rest.peek().is_some() {
            let part: Vec<CorpusPath> = rest.by_ref().take(RANDOM_CHUNK).collect();
            let length = part.len();
            chunks.push(Chunk {
                prefix: format!("rnd/{id}"),
                first,
                paths: part,
            });
            first += length;
        }
    }
    reader.finish();
    chunks
}

/// FIPS 180-4 SHA-256; std-only, so the kernel keeps no dependency.
struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffered: usize,
    length: u64,
}

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buffer: [0; 64],
            buffered: 0,
            length: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        while !data.is_empty() {
            let take = (64 - self.buffered).min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buffered = 0;
            }
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut schedule = [0u32; 64];
        for (word, bytes) in schedule.iter_mut().zip(block.chunks_exact(4)) {
            *word = u32::from_be_bytes(bytes.try_into().expect("four bytes"));
        }
        for index in 16..64 {
            let early = schedule[index - 15];
            let late = schedule[index - 2];
            let s0 = early.rotate_right(7) ^ early.rotate_right(18) ^ (early >> 3);
            let s1 = late.rotate_right(17) ^ late.rotate_right(19) ^ (late >> 10);
            schedule[index] = schedule[index - 16]
                .wrapping_add(s0)
                .wrapping_add(schedule[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for (constant, word) in SHA256_K.iter().zip(schedule.iter()) {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ (!e & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(*constant)
                .wrapping_add(*word);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (state, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *state = state.wrapping_add(value);
        }
    }

    fn finish(mut self) -> String {
        let bits = self.length.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buffered != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        debug_assert_eq!(self.buffered, 0);
        let mut hex = String::with_capacity(64);
        for word in self.state {
            let _ = write!(hex, "{word:08x}");
        }
        hex
    }
}

impl fmt::Write for Sha256 {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        self.update(text.as_bytes());
        Ok(())
    }
}

/// One output line: case, digest, allocations inside the entry call, outcome code, crossings.
fn line(
    output: &mut String,
    case: &str,
    digest: &str,
    allocations: usize,
    code: &str,
    crossings: usize,
) {
    let _ = writeln!(
        output,
        "{case}\t{digest}\t{allocations}\t{code}\t{crossings}"
    );
}

/// Digest of every section 2 field observable after one `CubicFillWorkspace` entry call, the
/// outcome code in the B0 harness's vocabulary, and the number of proper crossing events of a
/// published mesh (raw events are both endpoints of every edge, then the crossings).
fn attempt_digest(
    name: &str,
    result: &Result<CubicFillDiagnostics, CubicFillError>,
    workspace: &CubicFillWorkspace,
) -> (String, String, usize) {
    let mut hash = Sha256::new();
    let _ = write!(
        hash,
        "entry={name}\nresult={result:?}\ndiagnostics={:?}\ntopology_stats={:?}\nrounded_stats={:?}\nallocated_bytes={}\n",
        workspace.diagnostics(),
        workspace.topology_stats(),
        workspace.rounded_stats(),
        workspace.allocated_bytes(),
    );
    let output = workspace.output();
    match output {
        None => hash.update(b"output=None\n"),
        Some(output) => {
            let _ = write!(
                hash,
                "commands={:?}\nranges={:?}\npoints={:?}\nowners={:?}\nsources={:?}\nrounded={:?}\nrounded_stats={:?}\n",
                output.commands,
                output.ranges,
                output.points,
                output.owners,
                output.sources,
                output.rounded,
                output.rounded_stats,
            );
            for vertex in output.rounded.vertices {
                hash.update(&vertex.x.to_bits().to_le_bytes());
                hash.update(&vertex.y.to_bits().to_le_bytes());
            }
        }
    }
    let (code, crossings) = match (result, output) {
        (Err(error), _) => (format!("{error:?}"), 0),
        (Ok(diagnostics), None) => (
            format!("NO_MESH(flat_status={})", diagnostics.flat_status),
            0,
        ),
        (Ok(_), Some(output))
            if output.rounded.vertices.is_empty() || output.rounded.indices.is_empty() =>
        {
            ("EMPTY_MESH".to_owned(), 0)
        }
        (Ok(_), Some(output)) => {
            let stats = output.rounded_stats;
            (
                "OK".to_owned(),
                stats.events.saturating_sub(stats.edges.saturating_mul(2)),
            )
        }
    };
    (hash.finish(), code, crossings)
}

/// A one-path fill-v0 input, laid out as section a of the V2 contract fixes it.
fn pack(path: &CorpusPath, request_id: u32) -> Vec<u8> {
    let requests = 48usize;
    let path_offsets = requests + 16;
    let point_offsets = path_offsets + 8;
    let verbs = point_offsets + 8;
    let points = (verbs + path.verbs.len()).next_multiple_of(8);
    let total = points + path.point_bytes.len();
    let scalars = path.point_bytes.len() / 8;
    let as_u32 = |value: usize| u32::try_from(value).expect("fill-v0 field fits u32");
    let mut bytes = vec![0u8; total];
    let mut put = |offset: usize, value: u32| {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    };
    let header = [
        FILL_INPUT_MAGIC,
        0,
        as_u32(total),
        1,
        as_u32(path.verbs.len()),
        as_u32(scalars),
        as_u32(requests),
        as_u32(path_offsets),
        as_u32(point_offsets),
        as_u32(verbs),
        as_u32(points),
        0,
    ];
    for (index, value) in header.into_iter().enumerate() {
        put(index * 4, value);
    }
    put(requests, request_id);
    put(
        requests + 4,
        match path.rule {
            LineFillRule::Nonzero => 0,
            LineFillRule::Evenodd => 1,
        },
    );
    put(requests + 8, path.exponent as u32);
    put(path_offsets + 4, as_u32(path.verbs.len()));
    put(point_offsets + 4, as_u32(scalars));
    bytes[verbs..verbs + path.verbs.len()].copy_from_slice(&path.verbs);
    bytes[points..].copy_from_slice(&path.point_bytes);
    bytes
}

fn run_chunk(chunk: &Chunk) -> String {
    let mut workspace = CubicFillWorkspace::new(LIMITS).expect("construct identity workspace");
    let mut engine = FillEngine::new();
    assert_eq!(
        engine.reserve(ENGINE_INPUT_BYTES, ENGINE_OUTPUT_BYTES),
        BATCH_OK,
        "reserve the fill-v0 engine"
    );
    let mut output = String::new();
    for (offset, path) in chunk.paths.iter().enumerate() {
        let index = chunk.first + offset;
        let (flatten, topology) = tolerances(path.exponent);
        let input = PathInput::from_test_parts(
            Request {
                request_id: 0,
                source_epoch: 0,
                source_revision: 0,
                tolerance: flatten,
            },
            &path.verbs,
            &path.point_bytes,
        );
        for (entry, name) in ENTRIES {
            crate::allocation_test_support::start();
            let result = match entry {
                Entry::Attempt => workspace.attempt(input, path.rule, topology, MAX_FLAT_COMMANDS),
                Entry::Transverse => {
                    workspace.attempt_transverse(input, path.rule, topology, MAX_FLAT_COMMANDS)
                }
                Entry::Mixed => workspace.attempt_mixed_transverse(
                    input,
                    path.rule,
                    topology,
                    MAX_FLAT_COMMANDS,
                ),
                Entry::TriangleFree => {
                    workspace.attempt_triangle_free(input, path.rule, topology, MAX_FLAT_COMMANDS)
                }
            };
            let allocations = crate::allocation_test_support::stop();
            let (digest, code, crossings) = attempt_digest(name, &result, &workspace);
            let case = format!("{}/{index:04}/{name}", chunk.prefix);
            line(&mut output, &case, &digest, allocations, &code, crossings);
        }

        let request_id = u32::try_from(index).expect("path index fits u32");
        let bytes = pack(path, request_id);
        let length = u32::try_from(bytes.len()).expect("input length fits u32");
        engine.input_bytes_mut()[..bytes.len()].copy_from_slice(&bytes);
        crate::allocation_test_support::start();
        let status = engine.process(length);
        let allocations = crate::allocation_test_support::stop();
        let required = engine.required_output_bytes();
        let published = engine.output_bytes();
        let mut hash = Sha256::new();
        let _ = write!(
            hash,
            "entry=fill_v0_cascade\nstatus={status}\nresult_len={}\nrequired_output_bytes={required}\n",
            published.len(),
        );
        hash.update(published);
        let (code, crossings) = if status == BATCH_OK {
            let record = &published[OUTPUT_HEADER_BYTES + 4..OUTPUT_HEADER_BYTES + 8];
            let path_status = u32::from_le_bytes(record.try_into().expect("u32 status"));
            let crossings = match (
                path_status,
                engine.workspace().and_then(CubicFillWorkspace::output),
            ) {
                (0, Some(mesh)) => mesh
                    .rounded_stats
                    .events
                    .saturating_sub(mesh.rounded_stats.edges.saturating_mul(2)),
                _ => 0,
            };
            (format!("path_status={path_status}"), crossings)
        } else {
            (format!("batch_status={status}"), 0)
        };
        let case = format!("{}/{index:04}/fill_v0_cascade", chunk.prefix);
        line(
            &mut output,
            &case,
            &hash.finish(),
            allocations,
            &code,
            crossings,
        );
    }
    output
}

/// Inline sizes and retained bytes of both workspaces (section 2, "Every workspace").
fn meta_line(output: &mut String) {
    let workspace = CubicFillWorkspace::new(LIMITS).expect("construct identity workspace");
    let mut engine = FillEngine::new();
    assert_eq!(
        engine.reserve(ENGINE_INPUT_BYTES, ENGINE_OUTPUT_BYTES),
        BATCH_OK
    );
    let mut hash = Sha256::new();
    let _ = write!(
        hash,
        "cubic_inline={}\ncubic_allocated={}\nengine_inline={}\nengine_heap={}\nscratch={:?}\n",
        size_of::<CubicFillWorkspace>(),
        workspace.allocated_bytes(),
        size_of::<FillEngine>(),
        engine.heap_bytes(),
        FillEngine::scratch_sizes(),
    );
    line(output, "meta/workspace-sizes", &hash.finish(), 0, "META", 0);
}

fn read_file(variable: &str) -> Vec<u8> {
    let path = env::var(variable).unwrap_or_else(|_| panic!("{variable} is required"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("read {path}: {error}"))
}

#[test]
#[ignore = "B0R identity digests; run only by pnpm test:p3-fill-identity"]
fn dump_native_digests() {
    assert_eq!(
        tolerances(B0_EXPONENT),
        (FLATTEN_TOLERANCE, TOPOLOGY_TOLERANCE),
        "B0 tolerances"
    );
    let mut chunks = read_b0(&read_file("P3_B0R_B0_CORPUS"));
    chunks.extend(read_random(&read_file("P3_B0R_RANDOM_CORPUS")));
    let threads = env::var("P3_B0R_THREADS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| thread::available_parallelism().map_or(1, usize::from))
        .max(1);
    let start = Instant::now();
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
                    .expect("spawn identity worker")
            })
            .collect();
        for worker in workers {
            worker.join().expect("identity worker panicked");
        }
    });
    let mut output = String::new();
    meta_line(&mut output);
    for slot in results {
        output.push_str(&slot.into_inner().expect("result slot").expect("chunk ran"));
    }
    let path = env::var("P3_B0R_OUTPUT").expect("P3_B0R_OUTPUT is required");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("create exclusive identity output");
    file.write_all(output.as_bytes())
        .expect("write identity output");
    println!(
        "p3-b0r identity: {} chunks, {} lines, {threads} threads, {} ms",
        chunks.len(),
        output.lines().count(),
        start.elapsed().as_millis()
    );
}

#[test]
fn sha256_matches_fips_180_known_answers() {
    let digest = |data: &[u8]| {
        let mut hash = Sha256::new();
        hash.update(data);
        hash.finish()
    };
    assert_eq!(
        digest(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        digest(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        digest(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    let mut split = Sha256::new();
    for byte in b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq" {
        split.update(&[*byte]);
    }
    assert_eq!(
        split.finish(),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
}

#[test]
fn packed_fill_input_has_the_section_a_layout() {
    let path = CorpusPath {
        rule: LineFillRule::Evenodd,
        exponent: -3,
        verbs: vec![0, 1, 1, 3],
        point_bytes: [0.0f64, 0.0, 1.0, 0.0, 0.0, 1.0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect(),
    };
    let bytes = pack(&path, 7);
    let mut engine = FillEngine::new();
    assert_eq!(
        engine.reserve(ENGINE_INPUT_BYTES, ENGINE_OUTPUT_BYTES),
        BATCH_OK
    );
    engine.input_bytes_mut()[..bytes.len()].copy_from_slice(&bytes);
    assert_eq!(engine.process(bytes.len() as u32), BATCH_OK);
    let published = engine.output_bytes();
    let id = u32::from_le_bytes(
        published[OUTPUT_HEADER_BYTES..OUTPUT_HEADER_BYTES + 4]
            .try_into()
            .unwrap(),
    );
    let status = u32::from_le_bytes(
        published[OUTPUT_HEADER_BYTES + 4..OUTPUT_HEADER_BYTES + 8]
            .try_into()
            .unwrap(),
    );
    assert_eq!((id, status), (7, 0));
}
