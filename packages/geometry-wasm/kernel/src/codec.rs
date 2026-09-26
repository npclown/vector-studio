use core::ops::Range;

pub const INPUT_MAGIC: u32 = 0x3253_4756;
pub const OUTPUT_MAGIC: u32 = 0x3252_4756;
pub const ABI_VERSION: u32 = 1;
pub const HEADER_BYTES: usize = 48;
pub const REQUEST_BYTES: usize = 24;
pub const RESULT_BYTES: usize = 64;
pub const PROVENANCE_BYTES: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Request {
    pub request_id: u32,
    pub source_epoch: u32,
    pub source_revision: u32,
    pub tolerance: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Input<'a> {
    bytes: &'a [u8],
    path_count: usize,
    verb_count: usize,
    point_count: usize,
    requests_offset: usize,
    path_offsets_offset: usize,
    point_offsets_offset: usize,
    verbs_offset: usize,
    points_offset: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct PathInput<'a> {
    pub request: Request,
    pub verbs: &'a [u8],
    point_bytes: &'a [u8],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputLayout {
    pub total_bytes: usize,
    pub results_offset: usize,
    pub verbs_offset: usize,
    pub points_offset: usize,
    pub provenance_offset: usize,
}

pub fn align_up(value: usize, alignment: usize) -> Option<usize> {
    debug_assert!(alignment.is_power_of_two());
    value
        .checked_add(alignment - 1)
        .map(|v| v & !(alignment - 1))
}

fn checked_section(start: usize, count: usize, width: usize, total: usize) -> Option<Range<usize>> {
    let byte_len = count.checked_mul(width)?;
    let end = start.checked_add(byte_len)?;
    (end <= total).then_some(start..end)
}

pub fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let raw: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(u32::from_le_bytes(raw))
}

pub fn read_f64(bytes: &[u8], offset: usize) -> Option<f64> {
    let raw: [u8; 8] = bytes.get(offset..offset.checked_add(8)?)?.try_into().ok()?;
    Some(f64::from_le_bytes(raw))
}

pub fn write_u32(bytes: &mut [u8], offset: usize, value: u32) -> Option<()> {
    bytes
        .get_mut(offset..offset.checked_add(4)?)?
        .copy_from_slice(&value.to_le_bytes());
    Some(())
}

pub fn write_f64(bytes: &mut [u8], offset: usize, value: f64) -> Option<()> {
    bytes
        .get_mut(offset..offset.checked_add(8)?)?
        .copy_from_slice(&value.to_le_bytes());
    Some(())
}

fn all_zero(bytes: &[u8], range: Range<usize>) -> bool {
    bytes
        .get(range)
        .is_some_and(|padding| padding.iter().all(|byte| *byte == 0))
}

impl<'a> Input<'a> {
    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < HEADER_BYTES
            || read_u32(bytes, 0)? != INPUT_MAGIC
            || read_u32(bytes, 4)? != ABI_VERSION
            || usize::try_from(read_u32(bytes, 8)?).ok()? != bytes.len()
            || read_u32(bytes, 44)? != 0
        {
            return None;
        }

        let path_count = usize::try_from(read_u32(bytes, 12)?).ok()?;
        let verb_count = usize::try_from(read_u32(bytes, 16)?).ok()?;
        let point_count = usize::try_from(read_u32(bytes, 20)?).ok()?;
        let requests_offset = usize::try_from(read_u32(bytes, 24)?).ok()?;
        let path_offsets_offset = usize::try_from(read_u32(bytes, 28)?).ok()?;
        let point_offsets_offset = usize::try_from(read_u32(bytes, 32)?).ok()?;
        let verbs_offset = usize::try_from(read_u32(bytes, 36)?).ok()?;
        let points_offset = usize::try_from(read_u32(bytes, 40)?).ok()?;

        let expected_requests = align_up(HEADER_BYTES, 8)?;
        let requests = checked_section(expected_requests, path_count, REQUEST_BYTES, bytes.len())?;
        let expected_path_offsets = align_up(requests.end, 4)?;
        let path_offsets = checked_section(
            expected_path_offsets,
            path_count.checked_add(1)?,
            4,
            bytes.len(),
        )?;
        let expected_point_offsets = align_up(path_offsets.end, 4)?;
        let point_offsets = checked_section(
            expected_point_offsets,
            path_count.checked_add(1)?,
            4,
            bytes.len(),
        )?;
        let expected_verbs = point_offsets.end;
        let verbs = checked_section(expected_verbs, verb_count, 1, bytes.len())?;
        let expected_points = align_up(verbs.end, 8)?;
        let points = checked_section(expected_points, point_count, 8, bytes.len())?;

        if requests_offset != expected_requests
            || path_offsets_offset != expected_path_offsets
            || point_offsets_offset != expected_point_offsets
            || verbs_offset != expected_verbs
            || points_offset != expected_points
            || points.end != bytes.len()
            || requests_offset % 8 != 0
            || path_offsets_offset % 4 != 0
            || point_offsets_offset % 4 != 0
            || points_offset % 8 != 0
            || !all_zero(bytes, HEADER_BYTES..requests.start)
            || !all_zero(bytes, requests.end..path_offsets.start)
            || !all_zero(bytes, path_offsets.end..point_offsets.start)
            || !all_zero(bytes, verbs.end..points.start)
        {
            return None;
        }

        for index in 0..path_count {
            let request = requests_offset.checked_add(index.checked_mul(REQUEST_BYTES)?)?;
            if read_u32(bytes, request.checked_add(12)?)? != 0 {
                return None;
            }
        }

        if read_u32(bytes, path_offsets_offset)? != 0 || read_u32(bytes, point_offsets_offset)? != 0
        {
            return None;
        }
        let mut previous_verb = 0usize;
        let mut previous_point = 0usize;
        for index in 1..=path_count {
            let offset = index.checked_mul(4)?;
            let verb =
                usize::try_from(read_u32(bytes, path_offsets_offset.checked_add(offset)?)?).ok()?;
            let point =
                usize::try_from(read_u32(bytes, point_offsets_offset.checked_add(offset)?)?)
                    .ok()?;
            if verb < previous_verb || point < previous_point {
                return None;
            }
            previous_verb = verb;
            previous_point = point;
        }
        if previous_verb != verb_count || previous_point != point_count {
            return None;
        }

        Some(Self {
            bytes,
            path_count,
            verb_count,
            point_count,
            requests_offset,
            path_offsets_offset,
            point_offsets_offset,
            verbs_offset,
            points_offset,
        })
    }

    pub fn path_count(self) -> usize {
        self.path_count
    }

    pub fn path(self, index: usize) -> Option<PathInput<'a>> {
        if index >= self.path_count {
            return None;
        }
        let request_offset = self
            .requests_offset
            .checked_add(index.checked_mul(REQUEST_BYTES)?)?;
        let request = Request {
            request_id: read_u32(self.bytes, request_offset)?,
            source_epoch: read_u32(self.bytes, request_offset.checked_add(4)?)?,
            source_revision: read_u32(self.bytes, request_offset.checked_add(8)?)?,
            tolerance: read_f64(self.bytes, request_offset.checked_add(16)?)?,
        };
        let table_offset = index.checked_mul(4)?;
        let next_table_offset = table_offset.checked_add(4)?;
        let verb_start = usize::try_from(read_u32(
            self.bytes,
            self.path_offsets_offset.checked_add(table_offset)?,
        )?)
        .ok()?;
        let verb_end = usize::try_from(read_u32(
            self.bytes,
            self.path_offsets_offset.checked_add(next_table_offset)?,
        )?)
        .ok()?;
        let point_start = usize::try_from(read_u32(
            self.bytes,
            self.point_offsets_offset.checked_add(table_offset)?,
        )?)
        .ok()?;
        let point_end = usize::try_from(read_u32(
            self.bytes,
            self.point_offsets_offset.checked_add(next_table_offset)?,
        )?)
        .ok()?;
        if verb_end > self.verb_count || point_end > self.point_count {
            return None;
        }
        let verb_range =
            self.verbs_offset.checked_add(verb_start)?..self.verbs_offset.checked_add(verb_end)?;
        let point_byte_start = self
            .points_offset
            .checked_add(point_start.checked_mul(8)?)?;
        let point_byte_end = self.points_offset.checked_add(point_end.checked_mul(8)?)?;
        Some(PathInput {
            request,
            verbs: self.bytes.get(verb_range)?,
            point_bytes: self.bytes.get(point_byte_start..point_byte_end)?,
        })
    }
}

impl PathInput<'_> {
    pub fn point_count(self) -> usize {
        self.point_bytes.len() / 8
    }

    pub fn point(self, scalar_index: usize) -> Option<f64> {
        read_f64(self.point_bytes, scalar_index.checked_mul(8)?)
    }
}

#[cfg(test)]
impl<'a> PathInput<'a> {
    pub fn from_test_parts(request: Request, verbs: &'a [u8], point_bytes: &'a [u8]) -> Self {
        Self {
            request,
            verbs,
            point_bytes,
        }
    }
}

impl OutputLayout {
    pub fn calculate(path_count: usize, verb_count: usize, point_count: usize) -> Option<Self> {
        let results_offset = align_up(HEADER_BYTES, 8)?;
        let results_end = results_offset.checked_add(path_count.checked_mul(RESULT_BYTES)?)?;
        let verbs_offset = results_end;
        let verbs_end = verbs_offset.checked_add(verb_count)?;
        let points_offset = align_up(verbs_end, 8)?;
        let points_end = points_offset.checked_add(point_count.checked_mul(8)?)?;
        let provenance_offset = align_up(points_end, 4)?;
        let total_bytes =
            provenance_offset.checked_add(verb_count.checked_mul(PROVENANCE_BYTES)?)?;
        Some(Self {
            total_bytes,
            results_offset,
            verbs_offset,
            points_offset,
            provenance_offset,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_layout_observes_alignment_and_terminal_length() {
        let layout = OutputLayout::calculate(2, 3, 4).unwrap();
        assert_eq!(layout.results_offset, 48);
        assert_eq!(layout.verbs_offset, 176);
        assert_eq!(layout.points_offset, 184);
        assert_eq!(layout.provenance_offset, 216);
        assert_eq!(layout.total_bytes, 252);
    }

    #[test]
    fn checked_layout_rejects_overflow() {
        assert!(OutputLayout::calculate(usize::MAX, 0, 0).is_none());
        assert!(OutputLayout::calculate(0, usize::MAX, 0).is_none());
    }
}
