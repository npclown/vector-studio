use crate::codec::{
    write_f64, write_u32, Input, OutputLayout, Request, ABI_VERSION, HEADER_BYTES, OUTPUT_MAGIC,
    RESULT_BYTES,
};
use crate::geometry::{
    run_path, Bounds, Pass, Plan, Point, Provenance, WorkStatistics, PATH_EMPTY, PATH_OK,
};

pub const BATCH_OK: u32 = 0;
pub const BATCH_INVALID_BATCH: u32 = 1;
pub const BATCH_OUTPUT_CAPACITY: u32 = 2;
pub const BATCH_ALLOCATION_FAILED: u32 = 3;
pub const BATCH_DISPOSED: u32 = 4;
pub const BATCH_RESOURCE_LIMIT: u32 = 5;
pub const BATCH_INTERNAL_ERROR: u32 = 6;

const INPUT_CAP_BYTES: u32 = 64 * 1024 * 1024;
const OUTPUT_CAP_BYTES: u32 = 256 * 1024 * 1024;

#[repr(C, align(8))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Statistics {
    logical_cubics: u64,
    sizing_visits: u64,
    emission_visits: u64,
    emitted_cubic_lines: u64,
    attempted_paths: u64,
    failed_paths: u64,
}

pub struct Engine {
    input: Vec<u64>,
    output: Vec<u64>,
    plans: Vec<Plan>,
    input_capacity: u32,
    output_capacity: u32,
    epoch: u32,
    result_len: u32,
    required_output_bytes: u32,
    statistics: Statistics,
    disposed: bool,
    #[cfg(test)]
    fail_next_allocation: bool,
}

impl Engine {
    pub const fn new() -> Self {
        Self {
            input: Vec::new(),
            output: Vec::new(),
            plans: Vec::new(),
            input_capacity: 0,
            output_capacity: 0,
            epoch: 0,
            result_len: 0,
            required_output_bytes: 0,
            statistics: Statistics {
                logical_cubics: 0,
                sizing_visits: 0,
                emission_visits: 0,
                emitted_cubic_lines: 0,
                attempted_paths: 0,
                failed_paths: 0,
            },
            disposed: false,
            #[cfg(test)]
            fail_next_allocation: false,
        }
    }

    pub fn reserve(&mut self, input_bytes: u32, output_bytes: u32) -> u32 {
        if !self.begin_mutation() || self.disposed {
            return BATCH_DISPOSED;
        }
        self.invalidate_result();
        if input_bytes > INPUT_CAP_BYTES || output_bytes > OUTPUT_CAP_BYTES {
            return BATCH_RESOURCE_LIMIT;
        }

        let new_input_capacity = self.input_capacity.max(input_bytes);
        let new_output_capacity = self.output_capacity.max(output_bytes);
        let input_words = words_for(new_input_capacity);
        let output_words = words_for(new_output_capacity);
        let plan_count = maximum_path_count(new_input_capacity);

        #[cfg(test)]
        if self.fail_next_allocation
            && (input_words > self.input.len()
                || output_words > self.output.len()
                || plan_count > self.plans.len())
        {
            self.fail_next_allocation = false;
            return BATCH_ALLOCATION_FAILED;
        }

        if !grow_zeroed(&mut self.input, input_words)
            || !grow_zeroed(&mut self.output, output_words)
            || !grow_plans(&mut self.plans, plan_count)
        {
            return BATCH_ALLOCATION_FAILED;
        }
        self.input_capacity = new_input_capacity;
        self.output_capacity = new_output_capacity;
        BATCH_OK
    }

    pub fn process(&mut self, input_length: u32) -> u32 {
        if !self.begin_mutation() || self.disposed {
            self.statistics = Statistics::default();
            return BATCH_DISPOSED;
        }
        self.invalidate_result();
        self.statistics = Statistics::default();
        if input_length > self.input_capacity {
            return BATCH_INVALID_BATCH;
        }
        let input_length = input_length as usize;
        let input_storage = words_as_bytes(&self.input);
        let Some(input_bytes) = input_storage.get(..input_length) else {
            return BATCH_INVALID_BATCH;
        };
        let Some(input) = Input::parse(input_bytes) else {
            return BATCH_INVALID_BATCH;
        };
        if input.path_count() > self.plans.len() {
            return BATCH_INVALID_BATCH;
        }

        let mut work = WorkStatistics::default();
        let mut total_verbs = 0usize;
        let mut total_points = 0usize;
        for index in 0..input.path_count() {
            self.statistics.attempted_paths += 1;
            let Some(path) = input.path(index) else {
                self.statistics = Statistics::default();
                return BATCH_INVALID_BATCH;
            };
            let (plan, _) = run_path(path, Pass::Sizing, &mut work, |_, _, _| true);
            if plan.status > PATH_EMPTY {
                self.statistics.failed_paths += 1;
            }
            self.plans[index] = plan;
            if plan.status == PATH_OK {
                let Some(next_verbs) = total_verbs.checked_add(plan.verb_count as usize) else {
                    copy_work_statistics(&mut self.statistics, work);
                    return BATCH_RESOURCE_LIMIT;
                };
                let Some(next_points) = total_points.checked_add(plan.point_count as usize) else {
                    copy_work_statistics(&mut self.statistics, work);
                    return BATCH_RESOURCE_LIMIT;
                };
                total_verbs = next_verbs;
                total_points = next_points;
            }
        }
        copy_work_statistics(&mut self.statistics, work);

        let Some(layout) = OutputLayout::calculate(input.path_count(), total_verbs, total_points)
        else {
            return BATCH_RESOURCE_LIMIT;
        };
        if layout.total_bytes > OUTPUT_CAP_BYTES as usize || layout.total_bytes > u32::MAX as usize
        {
            return BATCH_RESOURCE_LIMIT;
        }
        self.required_output_bytes = layout.total_bytes as u32;
        if layout.total_bytes > self.output_capacity as usize {
            return BATCH_OUTPUT_CAPACITY;
        }

        let output_storage = words_as_bytes_mut(&mut self.output);
        let Some(output) = output_storage.get_mut(..layout.total_bytes) else {
            self.required_output_bytes = 0;
            return BATCH_INTERNAL_ERROR;
        };
        output.fill(0);
        let mut writer = OutputWriter::new(output, layout);
        for index in 0..input.path_count() {
            let path = match input.path(index) {
                Some(path) => path,
                None => return self.internal_failure(),
            };
            let plan = self.plans[index];
            let starts = writer.cursors();
            if plan.status == PATH_OK {
                let (emitted, bounds) = run_path(
                    path,
                    Pass::Emission,
                    &mut work,
                    |verb, point, provenance| writer.emit(verb, point, provenance),
                );
                copy_work_statistics(&mut self.statistics, work);
                if emitted != plan
                    || writer.cursors().0 - starts.0 != plan.verb_count as usize
                    || writer.cursors().1 - starts.1 != plan.point_count as usize
                    || !writer.result(
                        index,
                        path.request,
                        emitted.status,
                        starts,
                        writer.cursors(),
                        bounds,
                    )
                {
                    return self.internal_failure();
                }
            } else if !writer.result(
                index,
                path.request,
                plan.status,
                starts,
                starts,
                Bounds::default(),
            ) {
                return self.internal_failure();
            }
        }
        if writer.cursors() != (total_verbs, total_points) || !writer.header(input.path_count()) {
            return self.internal_failure();
        }
        copy_work_statistics(&mut self.statistics, work);
        self.result_len = self.required_output_bytes;
        BATCH_OK
    }

    pub fn dispose(&mut self) -> u32 {
        self.epoch = self.epoch.saturating_add(1);
        self.disposed = true;
        self.invalidate_result();
        self.input = Vec::new();
        self.output = Vec::new();
        self.plans = Vec::new();
        self.input_capacity = 0;
        self.output_capacity = 0;
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

    fn internal_failure(&mut self) -> u32 {
        self.result_len = 0;
        if self.output.len() * 8 >= HEADER_BYTES {
            words_as_bytes_mut(&mut self.output)[..HEADER_BYTES].fill(0);
        }
        BATCH_INTERNAL_ERROR
    }

    pub fn input_ptr(&mut self) -> u32 {
        pointer_u32(self.input.as_mut_ptr().cast())
    }

    pub fn input_capacity(&mut self) -> u32 {
        self.input_capacity
    }

    pub fn output_ptr(&mut self) -> u32 {
        pointer_u32(self.output.as_mut_ptr().cast())
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

    pub fn statistics_ptr(&mut self) -> u32 {
        pointer_u32(core::ptr::from_mut(&mut self.statistics).cast())
    }

    #[cfg(test)]
    fn input_bytes_mut(&mut self) -> &mut [u8] {
        words_as_bytes_mut(&mut self.input)
    }

    #[cfg(test)]
    fn output_bytes(&self) -> &[u8] {
        words_as_bytes(&self.output)
    }

    #[cfg(test)]
    fn fail_next_allocation(&mut self) {
        self.fail_next_allocation = true;
    }
}

fn copy_work_statistics(statistics: &mut Statistics, work: WorkStatistics) {
    statistics.logical_cubics = work.logical_cubics;
    statistics.sizing_visits = work.sizing_visits;
    statistics.emission_visits = work.emission_visits;
    statistics.emitted_cubic_lines = work.emitted_cubic_lines;
}

fn words_for(bytes: u32) -> usize {
    (bytes as usize).div_ceil(8)
}

fn maximum_path_count(input_bytes: u32) -> usize {
    // The smallest legal packed batch is 56 bytes. Every path adds one
    // request (24 bytes) and two terminal-offset entries (8 bytes).
    (input_bytes as usize).saturating_sub(56) / 32
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

fn grow_plans(storage: &mut Vec<Plan>, length: usize) -> bool {
    if length <= storage.len() {
        return true;
    }
    if storage.try_reserve_exact(length - storage.len()).is_err() {
        return false;
    }
    storage.resize(length, Plan::default());
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

fn pointer_u32(pointer: *mut u8) -> u32 {
    pointer as usize as u32
}

struct OutputWriter<'a> {
    bytes: &'a mut [u8],
    layout: OutputLayout,
    verb_cursor: usize,
    point_cursor: usize,
}

impl<'a> OutputWriter<'a> {
    fn new(bytes: &'a mut [u8], layout: OutputLayout) -> Self {
        Self {
            bytes,
            layout,
            verb_cursor: 0,
            point_cursor: 0,
        }
    }

    fn cursors(&self) -> (usize, usize) {
        (self.verb_cursor, self.point_cursor)
    }

    fn emit(&mut self, verb: u8, point: Option<Point>, provenance: Provenance) -> bool {
        let Some(verb_offset) = self.layout.verbs_offset.checked_add(self.verb_cursor) else {
            return false;
        };
        let Some(slot) = self.bytes.get_mut(verb_offset) else {
            return false;
        };
        *slot = verb;
        let Some(provenance_offset) = self
            .layout
            .provenance_offset
            .checked_add(self.verb_cursor.saturating_mul(12))
        else {
            return false;
        };
        if write_u32(self.bytes, provenance_offset, provenance.source_verb).is_none()
            || write_u32(self.bytes, provenance_offset + 4, provenance.end_numerator).is_none()
            || write_u32(self.bytes, provenance_offset + 8, provenance.depth).is_none()
        {
            return false;
        }
        self.verb_cursor += 1;
        if let Some(point) = point {
            let Some(point_offset) = self
                .layout
                .points_offset
                .checked_add(self.point_cursor.saturating_mul(8))
            else {
                return false;
            };
            if write_f64(self.bytes, point_offset, point.x).is_none()
                || write_f64(self.bytes, point_offset + 8, point.y).is_none()
            {
                return false;
            }
            self.point_cursor += 2;
        }
        true
    }

    fn result(
        &mut self,
        index: usize,
        request: Request,
        status: u32,
        starts: (usize, usize),
        ends: (usize, usize),
        bounds: Bounds,
    ) -> bool {
        let Some(offset) = self
            .layout
            .results_offset
            .checked_add(index.saturating_mul(RESULT_BYTES))
        else {
            return false;
        };
        let values = [
            request.request_id,
            request.source_epoch,
            request.source_revision,
            status,
            match u32::try_from(starts.0) {
                Ok(value) => value,
                Err(_) => return false,
            },
            match u32::try_from(ends.0) {
                Ok(value) => value,
                Err(_) => return false,
            },
            match u32::try_from(starts.1) {
                Ok(value) => value,
                Err(_) => return false,
            },
            match u32::try_from(ends.1) {
                Ok(value) => value,
                Err(_) => return false,
            },
        ];
        for (field, value) in values.into_iter().enumerate() {
            if write_u32(self.bytes, offset + field * 4, value).is_none() {
                return false;
            }
        }
        write_f64(self.bytes, offset + 32, bounds.min_x).is_some()
            && write_f64(self.bytes, offset + 40, bounds.min_y).is_some()
            && write_f64(self.bytes, offset + 48, bounds.max_x).is_some()
            && write_f64(self.bytes, offset + 56, bounds.max_y).is_some()
    }

    fn header(&mut self, path_count: usize) -> bool {
        let fields = [
            OUTPUT_MAGIC,
            ABI_VERSION,
            match u32::try_from(self.layout.total_bytes) {
                Ok(value) => value,
                Err(_) => return false,
            },
            match u32::try_from(path_count) {
                Ok(value) => value,
                Err(_) => return false,
            },
            match u32::try_from(self.verb_cursor) {
                Ok(value) => value,
                Err(_) => return false,
            },
            match u32::try_from(self.point_cursor) {
                Ok(value) => value,
                Err(_) => return false,
            },
            self.layout.results_offset as u32,
            self.layout.verbs_offset as u32,
            self.layout.points_offset as u32,
            self.layout.provenance_offset as u32,
            0,
            0,
        ];
        fields
            .into_iter()
            .enumerate()
            .all(|(index, value)| write_u32(self.bytes, index * 4, value).is_some())
    }
}

#[cfg(test)]
#[path = "native_differential.rs"]
mod native_differential;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{align_up, read_f64, read_u32, INPUT_MAGIC};
    use crate::geometry::{PATH_INVALID, PATH_INVALID_TOLERANCE};

    #[derive(Clone)]
    struct TestPath {
        request: Request,
        verbs: Vec<u8>,
        points: Vec<f64>,
    }

    fn packed(paths: &[TestPath]) -> Vec<u8> {
        let path_count = paths.len();
        let verb_count: usize = paths.iter().map(|path| path.verbs.len()).sum();
        let point_count: usize = paths.iter().map(|path| path.points.len()).sum();
        let requests_offset = 48;
        let path_offsets_offset = requests_offset + path_count * 24;
        let point_offsets_offset = path_offsets_offset + (path_count + 1) * 4;
        let verbs_offset = point_offsets_offset + (path_count + 1) * 4;
        let points_offset = align_up(verbs_offset + verb_count, 8).unwrap();
        let total = points_offset + point_count * 8;
        let mut bytes = vec![0; total];
        let header = [
            INPUT_MAGIC,
            1,
            total as u32,
            path_count as u32,
            verb_count as u32,
            point_count as u32,
            requests_offset as u32,
            path_offsets_offset as u32,
            point_offsets_offset as u32,
            verbs_offset as u32,
            points_offset as u32,
            0,
        ];
        for (index, value) in header.into_iter().enumerate() {
            write_u32(&mut bytes, index * 4, value).unwrap();
        }
        let mut verb_cursor = 0;
        let mut point_cursor = 0;
        for (index, path) in paths.iter().enumerate() {
            let request = requests_offset + index * 24;
            write_u32(&mut bytes, request, path.request.request_id).unwrap();
            write_u32(&mut bytes, request + 4, path.request.source_epoch).unwrap();
            write_u32(&mut bytes, request + 8, path.request.source_revision).unwrap();
            write_f64(&mut bytes, request + 16, path.request.tolerance).unwrap();
            write_u32(
                &mut bytes,
                path_offsets_offset + index * 4,
                verb_cursor as u32,
            )
            .unwrap();
            write_u32(
                &mut bytes,
                point_offsets_offset + index * 4,
                point_cursor as u32,
            )
            .unwrap();
            bytes[verbs_offset + verb_cursor..verbs_offset + verb_cursor + path.verbs.len()]
                .copy_from_slice(&path.verbs);
            for (point_index, point) in path.points.iter().enumerate() {
                write_f64(
                    &mut bytes,
                    points_offset + (point_cursor + point_index) * 8,
                    *point,
                )
                .unwrap();
            }
            verb_cursor += path.verbs.len();
            point_cursor += path.points.len();
        }
        write_u32(
            &mut bytes,
            path_offsets_offset + path_count * 4,
            verb_cursor as u32,
        )
        .unwrap();
        write_u32(
            &mut bytes,
            point_offsets_offset + path_count * 4,
            point_cursor as u32,
        )
        .unwrap();
        bytes
    }

    fn request(id: u32, tolerance: f64) -> Request {
        Request {
            request_id: id,
            source_epoch: 7,
            source_revision: 9,
            tolerance,
        }
    }

    fn load(engine: &mut Engine, input: &[u8], output_capacity: u32) {
        assert_eq!(
            engine.reserve(input.len() as u32, output_capacity),
            BATCH_OK
        );
        engine.input_bytes_mut()[..input.len()].copy_from_slice(input);
    }

    #[test]
    fn malformed_envelope_is_atomic_and_reports_zero_work() {
        let mut bytes = packed(&[]);
        bytes[0] = 0;
        let mut engine = Engine::new();
        load(&mut engine, &bytes, 128);
        assert_eq!(engine.process(bytes.len() as u32), BATCH_INVALID_BATCH);
        assert_eq!(engine.result_len, 0);
        assert_eq!(engine.statistics, Statistics::default());
    }

    #[test]
    fn failed_path_does_not_block_later_path() {
        let bytes = packed(&[
            TestPath {
                request: request(10, f64::NAN),
                verbs: vec![0],
                points: vec![1.0, 2.0],
            },
            TestPath {
                request: request(11, 0.25),
                verbs: vec![0, 1],
                points: vec![3.0, 4.0, 5.0, 6.0],
            },
        ]);
        let mut engine = Engine::new();
        load(&mut engine, &bytes, 1024);
        assert_eq!(engine.process(bytes.len() as u32), BATCH_OK);
        let output = engine.output_bytes();
        let results = read_u32(output, 24).unwrap() as usize;
        assert_eq!(read_u32(output, results + 12), Some(PATH_INVALID_TOLERANCE));
        assert_eq!(read_u32(output, results + 64 + 12), Some(PATH_OK));
        assert_eq!(read_u32(output, results + 64 + 20), Some(2));
        assert_eq!(engine.statistics.attempted_paths, 2);
        assert_eq!(engine.statistics.failed_paths, 1);
    }

    #[test]
    fn invalid_path_wins_before_tolerance() {
        let bytes = packed(&[TestPath {
            request: request(1, f64::NAN),
            verbs: vec![1],
            points: vec![1.0, 2.0],
        }]);
        let mut engine = Engine::new();
        load(&mut engine, &bytes, 256);
        assert_eq!(engine.process(bytes.len() as u32), BATCH_OK);
        let results = read_u32(engine.output_bytes(), 24).unwrap() as usize;
        assert_eq!(
            read_u32(engine.output_bytes(), results + 12),
            Some(PATH_INVALID)
        );
    }

    #[test]
    fn capacity_retry_keeps_input_and_publishes_only_complete_output() {
        let bytes = packed(&[TestPath {
            request: request(1, 0.25),
            verbs: vec![0, 1],
            points: vec![1.0, 2.0, 3.0, 4.0],
        }]);
        let mut engine = Engine::new();
        load(&mut engine, &bytes, 8);
        assert_eq!(engine.process(bytes.len() as u32), BATCH_OUTPUT_CAPACITY);
        let required = engine.required_output_bytes;
        assert!(required > 8);
        assert_eq!(engine.result_len, 0);
        let epoch = engine.epoch;
        assert_eq!(engine.reserve(bytes.len() as u32, required), BATCH_OK);
        assert_eq!(engine.epoch, epoch + 1);
        assert_eq!(&engine.input_bytes_mut()[..bytes.len()], bytes);
        assert_eq!(engine.process(bytes.len() as u32), BATCH_OK);
        assert_eq!(engine.result_len, required);
        assert_eq!(read_u32(engine.output_bytes(), 0), Some(OUTPUT_MAGIC));
    }

    #[test]
    fn process_does_not_reallocate_reserved_storage() {
        let bytes = packed(&[TestPath {
            request: request(1, 0.125),
            verbs: vec![0, 2],
            points: vec![0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0],
        }]);
        let mut engine = Engine::new();
        load(&mut engine, &bytes, 4096);
        let input_pointer = engine.input.as_ptr();
        let output_pointer = engine.output.as_ptr();
        let input_capacity = engine.input.capacity();
        let output_capacity = engine.output.capacity();
        let plan_capacity = engine.plans.capacity();
        crate::allocation_test_support::start();
        let status = engine.process(bytes.len() as u32);
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(status, BATCH_OK);
        assert_eq!(allocations, 0, "process must not allocate");
        assert_eq!(engine.input.as_ptr(), input_pointer);
        assert_eq!(engine.output.as_ptr(), output_pointer);
        assert_eq!(engine.input.capacity(), input_capacity);
        assert_eq!(engine.output.capacity(), output_capacity);
        assert_eq!(engine.plans.capacity(), plan_capacity);
        assert_eq!(engine.statistics.logical_cubics, 1);
        assert!(engine.statistics.sizing_visits > 0);
        assert_eq!(
            engine.statistics.sizing_visits,
            engine.statistics.emission_visits
        );
    }

    #[test]
    fn allocation_counter_positive_control_detects_heap_work() {
        crate::allocation_test_support::start();
        let values = std::hint::black_box(vec![0u8; 1024]);
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(values.len(), 1024);
        assert!(allocations > 0);
    }

    #[test]
    fn allocation_failure_seam_leaves_no_result() {
        let mut engine = Engine::new();
        engine.fail_next_allocation();
        assert_eq!(engine.reserve(64, 64), BATCH_ALLOCATION_FAILED);
        assert_eq!(engine.result_len, 0);
        assert_eq!(engine.input_capacity, 0);
        assert_eq!(engine.output_capacity, 0);
    }

    #[test]
    fn resource_caps_reject_first_exceeding_byte() {
        let mut engine = Engine::new();
        assert_eq!(engine.reserve(INPUT_CAP_BYTES + 1, 0), BATCH_RESOURCE_LIMIT);
        assert_eq!(
            engine.reserve(0, OUTPUT_CAP_BYTES + 1),
            BATCH_RESOURCE_LIMIT
        );
        assert_eq!(engine.input_capacity, 0);
        assert_eq!(engine.output_capacity, 0);
    }

    #[test]
    fn dispose_is_terminal_and_epoch_advances_per_call() {
        let mut engine = Engine::new();
        assert_eq!(engine.reserve(64, 64), BATCH_OK);
        let first_epoch = engine.epoch;
        assert_eq!(engine.dispose(), BATCH_OK);
        assert_eq!(engine.epoch, first_epoch + 1);
        assert_eq!(engine.input_capacity, 0);
        assert_eq!(engine.reserve(64, 64), BATCH_DISPOSED);
        assert_eq!(engine.epoch, first_epoch + 2);
        assert_eq!(engine.dispose(), BATCH_OK);
        assert_eq!(engine.epoch, first_epoch + 3);
        assert_eq!(engine.input_capacity, 0);
    }

    #[test]
    fn epoch_exhaustion_fails_closed_without_wrapping() {
        let mut engine = Engine::new();
        assert_eq!(engine.reserve(64, 64), BATCH_OK);
        engine.epoch = u32::MAX;
        assert_eq!(engine.reserve(0, 0), BATCH_DISPOSED);
        assert_eq!(engine.epoch, u32::MAX);
        assert!(engine.disposed);
        assert!(!engine.input.is_empty());
        assert_eq!(engine.dispose(), BATCH_OK);
        assert_eq!(engine.epoch, u32::MAX);
        assert!(engine.input.is_empty());
        assert!(engine.output.is_empty());
        assert!(engine.plans.is_empty());
    }

    #[test]
    fn empty_batch_has_terminal_offsets_and_header_only_output() {
        let bytes = packed(&[]);
        let mut engine = Engine::new();
        load(&mut engine, &bytes, 48);
        assert_eq!(engine.process(bytes.len() as u32), BATCH_OK);
        assert_eq!(engine.result_len, 48);
        assert_eq!(read_u32(engine.output_bytes(), 12), Some(0));
        assert_eq!(read_u32(engine.output_bytes(), 40), Some(0));
        assert_eq!(read_u32(engine.output_bytes(), 44), Some(0));
    }

    #[test]
    fn result_bounds_and_source_echo_are_little_endian() {
        let bytes = packed(&[TestPath {
            request: Request {
                request_id: 0x1234_5678,
                source_epoch: 0x9abc_def0,
                source_revision: 42,
                tolerance: 0.25,
            },
            verbs: vec![0],
            points: vec![-2.0, 3.5],
        }]);
        let mut engine = Engine::new();
        load(&mut engine, &bytes, 256);
        assert_eq!(engine.process(bytes.len() as u32), BATCH_OK);
        let output = engine.output_bytes();
        let result = read_u32(output, 24).unwrap() as usize;
        assert_eq!(read_u32(output, result), Some(0x1234_5678));
        assert_eq!(read_u32(output, result + 4), Some(0x9abc_def0));
        assert_eq!(read_u32(output, result + 8), Some(42));
        assert_eq!(read_f64(output, result + 32), Some(-2.0));
        assert_eq!(read_f64(output, result + 40), Some(3.5));
        assert_eq!(read_f64(output, result + 48), Some(-2.0));
        assert_eq!(read_f64(output, result + 56), Some(3.5));
    }
}
