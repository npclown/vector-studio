//! P3 B2 stroke-mesh transport v0, unit ST-U5.
//!
//! The frozen contract is `docs/plans/p3-b2-stroke-contract.md`, section 7. This engine is the
//! third module-level engine: it owns its own arenas, epoch and `StrokeWorkspace`, and shares no
//! field, epoch, arena or workspace with the P2 `Engine` or the `FillEngine`. The framing is
//! V2's (`docs/plans/p3-v2-fill-mesh-transport-contract.md`, sections a and c) with the stroke
//! magics and a 32-byte request record. The per-path stage order, the front end, the
//! arrangement call and the refinement are `StrokeWorkspace::build`'s, unchanged.

use crate::codec::{align_up, read_f64, read_u32, write_f64, write_u32};
use crate::engine::{
    BATCH_ALLOCATION_FAILED, BATCH_DISPOSED, BATCH_INTERNAL_ERROR, BATCH_INVALID_BATCH, BATCH_OK,
    BATCH_OUTPUT_CAPACITY, BATCH_RESOURCE_LIMIT,
};
use crate::fill_export::{
    SelfCheckFailure, INPUT_CAP_BYTES, INPUT_HEADER_BYTES, OUTPUT_CAP_BYTES, OUTPUT_HEADER_BYTES,
    RESULT_BYTES,
};
use crate::geometry::Point;
use crate::stroke_outline::{
    StrokeCap, StrokeJoin, StrokeOutcome, StrokeRequest, StrokeWorkspace, STROKE_PATH_OK,
    STROKE_V0_HEAP_CAP,
};

/// Section 7.1 identity.
pub const STROKE_V0_VERSION: u32 = 0;
/// Revision 2 (2026-10-21): one sample triple per cusp knot (plan: ST-U4 cusp shared triple).
pub const STROKE_V0_REVISION: u32 = 2;
/// Bytes `VGT0`.
pub const STROKE_INPUT_MAGIC: u32 = 0x3054_4756;
/// Bytes `VGU0`.
pub const STROKE_OUTPUT_MAGIC: u32 = 0x3055_4756;

/// Section 7.3 request record: requestId, cap, join, exponent, width, miterLimit.
pub(crate) const STROKE_REQUEST_BYTES: usize = 32;

fn section(start: usize, count: usize, width: usize, total: usize) -> Option<(usize, usize)> {
    let end = start.checked_add(count.checked_mul(width)?)?;
    (end <= total).then_some((start, end))
}

fn all_zero(bytes: &[u8], start: usize, end: usize) -> bool {
    bytes
        .get(start..end)
        .is_some_and(|padding| padding.iter().all(|byte| *byte == 0))
}

fn read_usize(bytes: &[u8], offset: usize) -> Option<usize> {
    usize::try_from(read_u32(bytes, offset)?).ok()
}

fn decode_cap(value: u32) -> Option<StrokeCap> {
    match value {
        0 => Some(StrokeCap::Butt),
        1 => Some(StrokeCap::Round),
        2 => Some(StrokeCap::Square),
        _ => None,
    }
}

fn decode_join(value: u32) -> Option<StrokeJoin> {
    match value {
        0 => Some(StrokeJoin::Miter),
        1 => Some(StrokeJoin::Round),
        2 => Some(StrokeJoin::Bevel),
        _ => None,
    }
}

/// A parsed stroke-v0 input (section 7.3). Every framing rule of V2's input section is checked
/// by `parse`; the width, miter-limit, verb, point and exponent values are path content.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StrokeInput<'a> {
    bytes: &'a [u8],
    path_count: usize,
    requests_offset: usize,
    path_offsets_offset: usize,
    point_offsets_offset: usize,
    verbs_offset: usize,
    points_offset: usize,
}

impl<'a> StrokeInput<'a> {
    pub(crate) fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < INPUT_HEADER_BYTES
            || read_u32(bytes, 0)? != STROKE_INPUT_MAGIC
            || read_u32(bytes, 4)? != STROKE_V0_VERSION
            || read_usize(bytes, 8)? != bytes.len()
            || read_u32(bytes, 44)? != 0
        {
            return None;
        }
        let path_count = read_usize(bytes, 12)?;
        let verb_count = read_usize(bytes, 16)?;
        let point_count = read_usize(bytes, 20)?;
        let total = bytes.len();

        let requests = section(
            align_up(INPUT_HEADER_BYTES, 8)?,
            path_count,
            STROKE_REQUEST_BYTES,
            total,
        )?;
        let table_entries = path_count.checked_add(1)?;
        let path_offsets = section(align_up(requests.1, 4)?, table_entries, 4, total)?;
        let point_offsets = section(align_up(path_offsets.1, 4)?, table_entries, 4, total)?;
        let verbs = section(point_offsets.1, verb_count, 1, total)?;
        let points = section(align_up(verbs.1, 8)?, point_count, 8, total)?;

        if read_usize(bytes, 24)? != requests.0
            || read_usize(bytes, 28)? != path_offsets.0
            || read_usize(bytes, 32)? != point_offsets.0
            || read_usize(bytes, 36)? != verbs.0
            || read_usize(bytes, 40)? != points.0
            || points.1 != total
            || !all_zero(bytes, INPUT_HEADER_BYTES, requests.0)
            || !all_zero(bytes, requests.1, path_offsets.0)
            || !all_zero(bytes, path_offsets.1, point_offsets.0)
            || !all_zero(bytes, verbs.1, points.0)
        {
            return None;
        }

        // Section 7.3: a `cap` or `join` value above 2 is INVALID_BATCH for the whole input.
        for index in 0..path_count {
            let request = requests
                .0
                .checked_add(index.checked_mul(STROKE_REQUEST_BYTES)?)?;
            decode_cap(read_u32(bytes, request.checked_add(4)?)?)?;
            decode_join(read_u32(bytes, request.checked_add(8)?)?)?;
        }

        for (table, count) in [(path_offsets.0, verb_count), (point_offsets.0, point_count)] {
            if read_u32(bytes, table)? != 0 {
                return None;
            }
            let mut previous = 0usize;
            for index in 1..=path_count {
                let value = read_usize(bytes, table.checked_add(index.checked_mul(4)?)?)?;
                if value < previous {
                    return None;
                }
                previous = value;
            }
            if previous != count {
                return None;
            }
        }

        Some(Self {
            bytes,
            path_count,
            requests_offset: requests.0,
            path_offsets_offset: path_offsets.0,
            point_offsets_offset: point_offsets.0,
            verbs_offset: verbs.0,
            points_offset: points.0,
        })
    }

    pub(crate) fn path_count(self) -> usize {
        self.path_count
    }

    pub(crate) fn request(self, index: usize) -> Option<StrokeRequest> {
        if index >= self.path_count {
            return None;
        }
        let offset = self
            .requests_offset
            .checked_add(index.checked_mul(STROKE_REQUEST_BYTES)?)?;
        Some(StrokeRequest {
            request_id: read_u32(self.bytes, offset)?,
            cap: decode_cap(read_u32(self.bytes, offset.checked_add(4)?)?)?,
            join: decode_join(read_u32(self.bytes, offset.checked_add(8)?)?)?,
            exponent: read_u32(self.bytes, offset.checked_add(12)?)? as i32,
            width: read_f64(self.bytes, offset.checked_add(16)?)?,
            miter_limit: read_f64(self.bytes, offset.checked_add(24)?)?,
        })
    }

    /// Verb bytes and point bytes of one path.
    pub(crate) fn path(self, index: usize) -> Option<(&'a [u8], &'a [u8])> {
        if index >= self.path_count {
            return None;
        }
        let entry = index.checked_mul(4)?;
        let next = entry.checked_add(4)?;
        let verb_start = read_usize(self.bytes, self.path_offsets_offset.checked_add(entry)?)?;
        let verb_end = read_usize(self.bytes, self.path_offsets_offset.checked_add(next)?)?;
        let point_start = read_usize(self.bytes, self.point_offsets_offset.checked_add(entry)?)?;
        let point_end = read_usize(self.bytes, self.point_offsets_offset.checked_add(next)?)?;
        let verbs = self.bytes.get(
            self.verbs_offset.checked_add(verb_start)?..self.verbs_offset.checked_add(verb_end)?,
        )?;
        let points = self.bytes.get(
            self.points_offset
                .checked_add(point_start.checked_mul(8)?)?
                ..self.points_offset.checked_add(point_end.checked_mul(8)?)?,
        )?;
        Some((verbs, points))
    }
}

/// Exact vertex bounds `[minX, minY, maxX, maxY]`.
fn vertex_bounds(vertices: &[Point]) -> [f64; 4] {
    let mut bounds = [vertices[0].x, vertices[0].y, vertices[0].x, vertices[0].y];
    for point in &vertices[1..] {
        bounds[0] = bounds[0].min(point.x);
        bounds[1] = bounds[1].min(point.y);
        bounds[2] = bounds[2].max(point.x);
        bounds[3] = bounds[3].max(point.y);
    }
    bounds
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BatchOutcome {
    Published(u32),
    Capacity(u32),
    ResourceLimit,
    Internal,
}

#[derive(Clone, Copy, Debug, Default)]
struct BlockRecord {
    offset: u32,
    vertices: u32,
    indices: u32,
    boundary: u32,
    bytes: u32,
    bounds: [f64; 4],
}

/// V2's 80-byte result record (section 7.4): echoes, status, block fields and bounds; every
/// other byte zero.
fn write_record(
    output: &mut [u8],
    offset: usize,
    request: StrokeRequest,
    status: u32,
    block: BlockRecord,
) -> Option<()> {
    output
        .get_mut(offset..offset.checked_add(RESULT_BYTES)?)?
        .fill(0);
    write_u32(output, offset, request.request_id)?;
    write_u32(output, offset + 4, status)?;
    write_u32(output, offset + 8, request.exponent as u32)?;
    write_u32(output, offset + 16, block.offset)?;
    write_u32(output, offset + 20, block.vertices)?;
    write_u32(output, offset + 24, block.indices)?;
    write_u32(output, offset + 28, block.boundary)?;
    write_u32(output, offset + 32, block.bytes)?;
    for (index, value) in block.bounds.into_iter().enumerate() {
        write_f64(output, offset + 48 + index * 8, value)?;
    }
    Some(())
}

fn write_block(
    output: &mut [u8],
    offset: usize,
    bytes: usize,
    vertices: &[Point],
    triangles: &[u32],
    boundary: &[[u32; 2]],
) -> Option<()> {
    output.get_mut(offset..offset.checked_add(bytes)?)?.fill(0);
    let mut cursor = offset;
    for point in vertices {
        write_f64(output, cursor, point.x)?;
        write_f64(output, cursor + 8, point.y)?;
        cursor += 16;
    }
    for index in triangles {
        write_u32(output, cursor, *index)?;
        cursor += 4;
    }
    for pair in boundary {
        write_u32(output, cursor, pair[0])?;
        write_u32(output, cursor + 4, pair[1])?;
        cursor += 8;
    }
    Some(())
}

/// One pass over the batch (V2 section a): every path is built once, records and blocks are
/// written where they fit, the exact total is computed, and the header is written last.
fn run_batch(
    input: StrokeInput<'_>,
    workspace: &mut StrokeWorkspace,
    output: &mut [u8],
    output_cap: u32,
    fault_path: Option<usize>,
) -> BatchOutcome {
    let capacity = output.len() as u64;
    let path_count = input.path_count();
    let Some(data_offset) = (path_count as u64)
        .checked_mul(RESULT_BYTES as u64)
        .and_then(|bytes| bytes.checked_add(OUTPUT_HEADER_BYTES as u64))
    else {
        return BatchOutcome::ResourceLimit;
    };
    let mut cursor = data_offset;
    let mut overflow = false;
    for index in 0..path_count {
        let (Some(request), Some((verbs, points))) = (input.request(index), input.path(index))
        else {
            return BatchOutcome::Internal;
        };
        if fault_path == Some(index) {
            return BatchOutcome::Internal;
        }
        let outcome = match workspace.build(request, verbs, points) {
            Ok(outcome) => outcome,
            Err(SelfCheckFailure) => return BatchOutcome::Internal,
        };
        let record_offset = OUTPUT_HEADER_BYTES as u64 + (index as u64) * RESULT_BYTES as u64;
        let record_fits = record_offset + RESULT_BYTES as u64 <= capacity;
        let (status, block) = match outcome {
            StrokeOutcome::Status(status) => (status, BlockRecord::default()),
            StrokeOutcome::Mesh => {
                let Some((vertices, triangles, boundary)) = workspace.mesh() else {
                    return BatchOutcome::Internal;
                };
                if vertices.is_empty() || triangles.is_empty() {
                    return BatchOutcome::Internal;
                }
                let payload = 16 * vertices.len() as u64
                    + 4 * (triangles.len() as u64 + 2 * boundary.len() as u64);
                let block_bytes = payload.div_ceil(8) * 8;
                let block_offset = cursor;
                match cursor.checked_add(block_bytes) {
                    Some(next) => cursor = next,
                    None => overflow = true,
                }
                let fits = !overflow && cursor <= capacity;
                if fits
                    && write_block(
                        output,
                        block_offset as usize,
                        block_bytes as usize,
                        vertices,
                        triangles,
                        boundary,
                    )
                    .is_none()
                {
                    return BatchOutcome::Internal;
                }
                let record = if record_fits && fits {
                    let (
                        Ok(offset),
                        Ok(vertex_count),
                        Ok(index_count),
                        Ok(boundary_count),
                        Ok(bytes),
                    ) = (
                        u32::try_from(block_offset),
                        u32::try_from(vertices.len()),
                        u32::try_from(triangles.len()),
                        u32::try_from(boundary.len() * 2),
                        u32::try_from(block_bytes),
                    )
                    else {
                        return BatchOutcome::Internal;
                    };
                    BlockRecord {
                        offset,
                        vertices: vertex_count,
                        indices: index_count,
                        boundary: boundary_count,
                        bytes,
                        bounds: vertex_bounds(vertices),
                    }
                } else {
                    BlockRecord::default()
                };
                (STROKE_PATH_OK, record)
            }
        };
        if record_fits
            && write_record(output, record_offset as usize, request, status, block).is_none()
        {
            return BatchOutcome::Internal;
        }
    }
    if overflow || cursor > u64::from(output_cap) || cursor > u64::from(u32::MAX) {
        return BatchOutcome::ResourceLimit;
    }
    let total = cursor as u32;
    if cursor > capacity {
        return BatchOutcome::Capacity(total);
    }
    let (Ok(count), Ok(data)) = (u32::try_from(path_count), u32::try_from(data_offset)) else {
        return BatchOutcome::Internal;
    };
    let header = [
        STROKE_OUTPUT_MAGIC,
        STROKE_V0_VERSION,
        total,
        count,
        OUTPUT_HEADER_BYTES as u32,
        data,
    ];
    let Some(header_bytes) = output.get_mut(..OUTPUT_HEADER_BYTES) else {
        return BatchOutcome::Internal;
    };
    header_bytes.fill(0);
    for (index, value) in header.into_iter().enumerate() {
        if write_u32(output, index * 4, value).is_none() {
            return BatchOutcome::Internal;
        }
    }
    BatchOutcome::Published(total)
}

/// The stroke-v0 engine: a third, independent module-level engine (section 7.2).
pub struct StrokeEngine {
    input: Vec<u64>,
    output: Vec<u64>,
    input_capacity: u32,
    output_capacity: u32,
    epoch: u32,
    result_len: u32,
    required_output_bytes: u32,
    disposed: bool,
    workspace: Option<StrokeWorkspace>,
    heap_bytes: usize,
    #[cfg(test)]
    test_hooks: TestHooks,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct TestHooks {
    pub(crate) fail_workspace: Option<u32>,
    pub(crate) fault_path: Option<usize>,
    pub(crate) output_cap: Option<u32>,
    /// Replaces the section 7.5 heap cap at the next workspace construction.
    pub(crate) heap_cap: Option<usize>,
}

impl Default for StrokeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl StrokeEngine {
    pub const fn new() -> Self {
        Self {
            input: Vec::new(),
            output: Vec::new(),
            input_capacity: 0,
            output_capacity: 0,
            epoch: 0,
            result_len: 0,
            required_output_bytes: 0,
            disposed: false,
            workspace: None,
            heap_bytes: 0,
            #[cfg(test)]
            test_hooks: TestHooks {
                fail_workspace: None,
                fault_path: None,
                output_cap: None,
                heap_cap: None,
            },
        }
    }

    /// V2 section a: grows the arenas to at least the requested sizes (never shrinks them) and
    /// builds the stroke workspace once. All allocation happens here.
    pub fn reserve(&mut self, input_bytes: u32, output_bytes: u32) -> u32 {
        if !self.begin_mutation() || self.disposed {
            return BATCH_DISPOSED;
        }
        self.invalidate_result();
        if input_bytes > INPUT_CAP_BYTES || output_bytes > OUTPUT_CAP_BYTES {
            return BATCH_RESOURCE_LIMIT;
        }
        let new_input = self.input_capacity.max(input_bytes);
        let new_output = self.output_capacity.max(output_bytes);
        if !grow_zeroed(&mut self.input, words_for(new_input))
            || !grow_zeroed(&mut self.output, words_for(new_output))
        {
            return BATCH_ALLOCATION_FAILED;
        }
        self.input_capacity = new_input;
        self.output_capacity = new_output;
        if self.workspace.is_none() {
            return match self.build_workspace() {
                Ok(()) => BATCH_OK,
                Err(status) => {
                    self.workspace = None;
                    self.heap_bytes = 0;
                    status
                }
            };
        }
        BATCH_OK
    }

    fn build_workspace(&mut self) -> Result<(), u32> {
        #[cfg(test)]
        if let Some(status) = self.test_hooks.fail_workspace.take() {
            return Err(status);
        }
        let cap = STROKE_V0_HEAP_CAP;
        #[cfg(test)]
        let cap = self.test_hooks.heap_cap.take().unwrap_or(cap);
        // `StrokeWorkspace::new` reserves the front end, the `RoundedFillWorkspace` and the
        // `FillScratch` from `STROKE_V0_LIMITS` and maps a construction failure as V2 does
        // (`ALLOCATION_FAILED` or `INTERNAL_ERROR`). The combined heap is checked again here,
        // with checked arithmetic, against the section 7.5 cap.
        let workspace = StrokeWorkspace::new()?;
        let total = workspace.allocated_bytes().ok_or(BATCH_INTERNAL_ERROR)?;
        if total > cap {
            return Err(BATCH_INTERNAL_ERROR);
        }
        self.workspace = Some(workspace);
        self.heap_bytes = total;
        Ok(())
    }

    pub fn process(&mut self, input_length: u32) -> u32 {
        if !self.begin_mutation() || self.disposed {
            return BATCH_DISPOSED;
        }
        self.invalidate_result();
        let capacity = self.output_capacity as usize;
        let output_storage = words_as_bytes_mut(&mut self.output);
        if capacity >= OUTPUT_HEADER_BYTES {
            output_storage[..OUTPUT_HEADER_BYTES].fill(0);
        }
        if input_length > self.input_capacity {
            return BATCH_INVALID_BATCH;
        }
        let Some(input_bytes) = words_as_bytes(&self.input).get(..input_length as usize) else {
            return BATCH_INVALID_BATCH;
        };
        let Some(input) = StrokeInput::parse(input_bytes) else {
            return BATCH_INVALID_BATCH;
        };
        let Some(workspace) = self.workspace.as_mut() else {
            return BATCH_ALLOCATION_FAILED;
        };
        #[cfg(test)]
        let (fault_path, output_cap) = (
            self.test_hooks.fault_path,
            self.test_hooks.output_cap.unwrap_or(OUTPUT_CAP_BYTES),
        );
        #[cfg(not(test))]
        let (fault_path, output_cap) = (None, OUTPUT_CAP_BYTES);
        let output = &mut words_as_bytes_mut(&mut self.output)[..capacity];
        match run_batch(input, workspace, output, output_cap, fault_path) {
            BatchOutcome::Published(total) => {
                self.result_len = total;
                BATCH_OK
            }
            BatchOutcome::Capacity(total) => {
                self.required_output_bytes = total;
                BATCH_OUTPUT_CAPACITY
            }
            BatchOutcome::ResourceLimit => BATCH_RESOURCE_LIMIT,
            BatchOutcome::Internal => {
                if capacity >= OUTPUT_HEADER_BYTES {
                    words_as_bytes_mut(&mut self.output)[..OUTPUT_HEADER_BYTES].fill(0);
                }
                BATCH_INTERNAL_ERROR
            }
        }
    }

    pub fn dispose(&mut self) -> u32 {
        self.epoch = self.epoch.saturating_add(1);
        self.disposed = true;
        self.invalidate_result();
        self.input = Vec::new();
        self.output = Vec::new();
        self.input_capacity = 0;
        self.output_capacity = 0;
        self.workspace = None;
        self.heap_bytes = 0;
        BATCH_OK
    }

    fn begin_mutation(&mut self) -> bool {
        if self.epoch == u32::MAX {
            self.disposed = true;
            self.invalidate_result();
            return false;
        }
        self.epoch += 1;
        true
    }

    fn invalidate_result(&mut self) {
        self.result_len = 0;
        self.required_output_bytes = 0;
    }

    pub fn input_ptr(&mut self) -> u32 {
        self.input.as_mut_ptr() as usize as u32
    }

    pub fn input_capacity(&mut self) -> u32 {
        self.input_capacity
    }

    pub fn output_ptr(&mut self) -> u32 {
        self.output.as_mut_ptr() as usize as u32
    }

    pub fn output_capacity(&mut self) -> u32 {
        self.output_capacity
    }

    pub fn memory_epoch(&mut self) -> u32 {
        self.epoch
    }

    pub fn result_len(&mut self) -> u32 {
        self.result_len
    }

    pub fn required_output_bytes(&mut self) -> u32 {
        self.required_output_bytes
    }
}

#[cfg(test)]
impl StrokeEngine {
    pub(crate) fn hooks(&mut self) -> &mut TestHooks {
        &mut self.test_hooks
    }

    pub(crate) fn input_bytes_mut(&mut self) -> &mut [u8] {
        words_as_bytes_mut(&mut self.input)
    }

    pub(crate) fn output_bytes(&self) -> &[u8] {
        &words_as_bytes(&self.output)[..self.result_len as usize]
    }

    pub(crate) fn raw_output(&self) -> &[u8] {
        words_as_bytes(&self.output)
    }

    pub(crate) fn has_workspace(&self) -> bool {
        self.workspace.is_some()
    }

    pub(crate) fn workspace_bytes(&self) -> Option<usize> {
        self.workspace
            .as_ref()
            .and_then(StrokeWorkspace::allocated_bytes)
    }

    pub(crate) fn heap_bytes(&self) -> usize {
        self.heap_bytes
    }

    pub(crate) fn set_epoch(&mut self, epoch: u32) {
        self.epoch = epoch;
    }

    pub(crate) fn is_disposed(&self) -> bool {
        self.disposed
    }

    /// Arena pointers and capacities, for the storage-stability check.
    pub(crate) fn storage(&self) -> [(usize, usize); 2] {
        [
            (self.input.as_ptr() as usize, self.input.capacity()),
            (self.output.as_ptr() as usize, self.output.capacity()),
        ]
    }
}

fn words_for(bytes: u32) -> usize {
    (bytes as usize).div_ceil(8)
}

fn grow_zeroed(storage: &mut Vec<u64>, length: usize) -> bool {
    if length <= storage.len() {
        return true;
    }
    if storage.try_reserve_exact(length - storage.len()).is_err() {
        return false;
    }
    storage.resize(length, 0);
    true
}

fn words_as_bytes(words: &[u64]) -> &[u8] {
    // SAFETY: u8 has alignment one, every u64 bit pattern is valid, and the
    // byte length is exactly eight times the source length.
    unsafe { core::slice::from_raw_parts(words.as_ptr().cast(), words.len() * 8) }
}

fn words_as_bytes_mut(words: &mut [u64]) -> &mut [u8] {
    // SAFETY: same representation argument as words_as_bytes; the mutable
    // borrow guarantees exclusive access for the returned byte slice.
    unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr().cast(), words.len() * 8) }
}
