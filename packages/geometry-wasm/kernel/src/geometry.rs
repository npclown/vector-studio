use crate::codec::PathInput;

pub const VERB_MOVE: u8 = 0;
pub const VERB_LINE: u8 = 1;
pub const VERB_CUBIC: u8 = 2;
pub const VERB_CLOSE: u8 = 3;

pub const PATH_OK: u32 = 0;
pub const PATH_EMPTY: u32 = 1;
pub const PATH_INVALID: u32 = 2;
pub const PATH_INVALID_TOLERANCE: u32 = 3;
pub const PATH_NUMERIC_RANGE: u32 = 4;
pub const PATH_WORK_LIMIT: u32 = 5;

const EPSILON: f64 = f64::EPSILON;
const MAX_DEPTH: u32 = 20;
const MAX_LINES_PER_CUBIC: u32 = 8_192;
const MAX_VISITS_PER_PATH: u32 = 1_048_576;
const MAX_OUTPUT_VERBS_PER_PATH: u32 = 65_536;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    fn checked_sub(self, other: Self) -> Result<Self, u32> {
        let point = Self {
            x: self.x - other.x,
            y: self.y - other.y,
        };
        point.is_finite().then_some(point).ok_or(PATH_NUMERIC_RANGE)
    }

    fn midpoint(self, other: Self) -> Result<Self, u32> {
        let point = Self {
            x: self.x * 0.5 + other.x * 0.5,
            y: self.y * 0.5 + other.y * 0.5,
        };
        point.is_finite().then_some(point).ok_or(PATH_NUMERIC_RANGE)
    }

    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }

    fn max_abs(self) -> f64 {
        self.x.abs().max(self.y.abs())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Bounds {
    fn point(point: Point) -> Self {
        Self {
            min_x: point.x,
            min_y: point.y,
            max_x: point.x,
            max_y: point.y,
        }
    }

    fn include_point(&mut self, point: Point) {
        self.min_x = self.min_x.min(point.x);
        self.min_y = self.min_y.min(point.y);
        self.max_x = self.max_x.max(point.x);
        self.max_y = self.max_y.max(point.y);
    }

    fn include_bounds(&mut self, other: Self) {
        self.include_point(Point {
            x: other.min_x,
            y: other.min_y,
        });
        self.include_point(Point {
            x: other.max_x,
            y: other.max_y,
        });
    }

    fn is_finite(self) -> bool {
        self.min_x.is_finite()
            && self.min_y.is_finite()
            && self.max_x.is_finite()
            && self.max_y.is_finite()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Provenance {
    pub source_verb: u32,
    pub end_numerator: u32,
    pub depth: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub status: u32,
    pub verb_count: u32,
    pub point_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WorkStatistics {
    pub logical_cubics: u64,
    pub sizing_visits: u64,
    pub emission_visits: u64,
    pub emitted_cubic_lines: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pass {
    Sizing,
    Emission,
}

#[derive(Clone, Copy, Debug)]
struct Cubic {
    points: [Point; 4],
    original_origin: Point,
    max_abs_original: f64,
    max_abs_relative: f64,
}

#[derive(Clone, Copy, Debug)]
struct Leaf {
    endpoint: Point,
    end_numerator: u32,
    depth: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct PathWork {
    visits: u32,
    output_verbs: u32,
}

pub fn run_path(
    input: PathInput<'_>,
    pass: Pass,
    statistics: &mut WorkStatistics,
    mut emit: impl FnMut(u8, Option<Point>, Provenance) -> bool,
) -> (Plan, Bounds) {
    if validate_path(input).is_err() {
        return (failure(PATH_INVALID), Bounds::default());
    }
    if !input.request.tolerance.is_finite() || input.request.tolerance <= 0.0 {
        return (failure(PATH_INVALID_TOLERANCE), Bounds::default());
    }
    if input.verbs.is_empty() {
        return (failure(PATH_EMPTY), Bounds::default());
    }

    match compute_path(input, pass, statistics, &mut emit) {
        Ok(value) => value,
        Err(status) => (failure(status), Bounds::default()),
    }
}

fn failure(status: u32) -> Plan {
    Plan {
        status,
        verb_count: 0,
        point_count: 0,
    }
}

fn validate_path(input: PathInput<'_>) -> Result<(), ()> {
    let mut point_index = 0usize;
    let mut open = false;
    for verb in input.verbs {
        let arity = match *verb {
            VERB_MOVE => {
                open = true;
                2
            }
            VERB_LINE => {
                if !open {
                    return Err(());
                }
                2
            }
            VERB_CUBIC => {
                if !open {
                    return Err(());
                }
                6
            }
            VERB_CLOSE => {
                if !open {
                    return Err(());
                }
                open = false;
                0
            }
            _ => return Err(()),
        };
        let end = point_index.checked_add(arity).ok_or(())?;
        if end > input.point_count() {
            return Err(());
        }
        for scalar in point_index..end {
            if !input.point(scalar).ok_or(())?.is_finite() {
                return Err(());
            }
        }
        point_index = end;
    }
    (point_index == input.point_count()).then_some(()).ok_or(())
}

fn compute_path(
    input: PathInput<'_>,
    pass: Pass,
    statistics: &mut WorkStatistics,
    emit: &mut impl FnMut(u8, Option<Point>, Provenance) -> bool,
) -> Result<(Plan, Bounds), u32> {
    let mut point_index = 0usize;
    let mut current = Point::default();
    let mut subpath_start = Point::default();
    let mut bounds: Option<Bounds> = None;
    let mut output_points = 0u32;
    let mut work = PathWork::default();

    for (ordinal, verb) in input.verbs.iter().copied().enumerate() {
        let provenance = Provenance {
            source_verb: u32::try_from(ordinal).map_err(|_| PATH_WORK_LIMIT)?,
            end_numerator: 1,
            depth: 0,
        };
        match verb {
            VERB_MOVE => {
                current = read_point(input, point_index)?;
                point_index += 2;
                subpath_start = current;
                include(&mut bounds, Bounds::point(current));
                add_output_verb(&mut work)?;
                output_points = output_points.checked_add(2).ok_or(PATH_WORK_LIMIT)?;
                if !emit(VERB_MOVE, Some(current), provenance) {
                    return Err(PATH_NUMERIC_RANGE);
                }
            }
            VERB_LINE => {
                current = read_point(input, point_index)?;
                point_index += 2;
                include(&mut bounds, Bounds::point(current));
                add_output_verb(&mut work)?;
                output_points = output_points.checked_add(2).ok_or(PATH_WORK_LIMIT)?;
                if !emit(VERB_LINE, Some(current), provenance) {
                    return Err(PATH_NUMERIC_RANGE);
                }
            }
            VERB_CUBIC => {
                let controls = [
                    current,
                    read_point(input, point_index)?,
                    read_point(input, point_index + 2)?,
                    read_point(input, point_index + 4)?,
                ];
                point_index += 6;
                if pass == Pass::Sizing {
                    statistics.logical_cubics += 1;
                }
                let cubic = Cubic::relative(controls)?;
                let guard = cubic.guard(0)?;
                if guard >= input.request.tolerance {
                    return Err(PATH_NUMERIC_RANGE);
                }
                include(&mut bounds, cubic.bounds(guard)?);
                let mut cubic_lines = 0u32;
                flatten(
                    cubic,
                    input.request.tolerance,
                    provenance.source_verb,
                    pass,
                    statistics,
                    &mut work,
                    &mut cubic_lines,
                    emit,
                )?;
                output_points = output_points
                    .checked_add(cubic_lines.checked_mul(2).ok_or(PATH_WORK_LIMIT)?)
                    .ok_or(PATH_WORK_LIMIT)?;
                current = controls[3];
            }
            VERB_CLOSE => {
                current = subpath_start;
                add_output_verb(&mut work)?;
                if !emit(VERB_CLOSE, None, provenance) {
                    return Err(PATH_NUMERIC_RANGE);
                }
            }
            _ => return Err(PATH_INVALID),
        }
    }

    let bounds = bounds.ok_or(PATH_INVALID)?;
    if !bounds.is_finite() {
        return Err(PATH_NUMERIC_RANGE);
    }
    Ok((
        Plan {
            status: PATH_OK,
            verb_count: work.output_verbs,
            point_count: output_points,
        },
        bounds,
    ))
}

fn read_point(input: PathInput<'_>, scalar: usize) -> Result<Point, u32> {
    let point = Point {
        x: input.point(scalar).ok_or(PATH_INVALID)?,
        y: input.point(scalar + 1).ok_or(PATH_INVALID)?,
    };
    point.is_finite().then_some(point).ok_or(PATH_INVALID)
}

fn include(bounds: &mut Option<Bounds>, candidate: Bounds) {
    if let Some(bounds) = bounds {
        bounds.include_bounds(candidate);
    } else {
        *bounds = Some(candidate);
    }
}

fn add_output_verb(work: &mut PathWork) -> Result<(), u32> {
    if work.output_verbs >= MAX_OUTPUT_VERBS_PER_PATH {
        return Err(PATH_WORK_LIMIT);
    }
    work.output_verbs += 1;
    Ok(())
}

impl Cubic {
    fn relative(original: [Point; 4]) -> Result<Self, u32> {
        let origin = original[0];
        let relative = [
            Point::default(),
            original[1].checked_sub(origin)?,
            original[2].checked_sub(origin)?,
            original[3].checked_sub(origin)?,
        ];
        let max_abs_original = original
            .iter()
            .fold(1.0f64, |value, point| value.max(point.max_abs()));
        let max_abs_relative = relative
            .iter()
            .fold(0.0f64, |value, point| value.max(point.max_abs()));
        if !max_abs_original.is_finite() || !max_abs_relative.is_finite() {
            return Err(PATH_NUMERIC_RANGE);
        }
        Ok(Self {
            points: relative,
            original_origin: origin,
            max_abs_original,
            max_abs_relative,
        })
    }

    fn guard(self, depth: u32) -> Result<f64, u32> {
        let guard = 128.0
            * EPSILON
            * (self.max_abs_original + (f64::from(depth) + 1.0) * self.max_abs_relative);
        (guard.is_finite() && guard >= 0.0)
            .then_some(guard)
            .ok_or(PATH_NUMERIC_RANGE)
    }

    fn bounds(self, guard: f64) -> Result<Bounds, u32> {
        let mut min_x = self.points[0].x.min(self.points[3].x);
        let mut max_x = self.points[0].x.max(self.points[3].x);
        let mut min_y = self.points[0].y.min(self.points[3].y);
        let mut max_y = self.points[0].y.max(self.points[3].y);
        extrema(
            [
                self.points[0].x,
                self.points[1].x,
                self.points[2].x,
                self.points[3].x,
            ],
            guard,
            |value| {
                min_x = min_x.min(value);
                max_x = max_x.max(value);
            },
        )?;
        extrema(
            [
                self.points[0].y,
                self.points[1].y,
                self.points[2].y,
                self.points[3].y,
            ],
            guard,
            |value| {
                min_y = min_y.min(value);
                max_y = max_y.max(value);
            },
        )?;
        let bounds = Bounds {
            min_x: self.original_origin.x + (min_x - guard),
            min_y: self.original_origin.y + (min_y - guard),
            max_x: self.original_origin.x + (max_x + guard),
            max_y: self.original_origin.y + (max_y + guard),
        };
        bounds
            .is_finite()
            .then_some(bounds)
            .ok_or(PATH_NUMERIC_RANGE)
    }
}

fn extrema(mut p: [f64; 4], guard: f64, mut include: impl FnMut(f64)) -> Result<(), u32> {
    let c = p[1] - p[0];
    let b = 2.0 * (p[2] - 2.0 * p[1] + p[0]);
    let a = p[3] - 3.0 * p[2] + 3.0 * p[1] - p[0];
    if !a.is_finite() || !b.is_finite() || !c.is_finite() {
        return Err(PATH_NUMERIC_RANGE);
    }
    let endpoint_min = p[0].min(p[3]);
    let endpoint_max = p[0].max(p[3]);
    if p[1] >= endpoint_min && p[1] <= endpoint_max && p[2] >= endpoint_min && p[2] <= endpoint_max
    {
        return Ok(());
    }
    let scale = a.abs().max(b.abs()).max(c.abs());
    if scale == 0.0 {
        return Ok(());
    }
    let a = a / scale;
    let b = b / scale;
    let c = c / scale;
    if a == 0.0 {
        if b != 0.0 {
            evaluate_root(-c / b, &mut p, &mut include)?;
        }
        return Ok(());
    }

    let bb = b * b;
    let four_ac = 4.0 * a * c;
    let discriminant = bb - four_ac;
    let delta = 64.0 * EPSILON * (bb + four_ac.abs() + 1.0);
    if !discriminant.is_finite() || !delta.is_finite() {
        return Err(PATH_NUMERIC_RANGE);
    }
    if discriminant < -delta {
        return Ok(());
    }
    if discriminant > delta {
        let root = discriminant.sqrt();
        let q = -0.5 * (b + root.copysign(b));
        if q == 0.0 || !q.is_finite() {
            return Err(PATH_NUMERIC_RANGE);
        }
        evaluate_root(q / a, &mut p, &mut include)?;
        evaluate_root(c / q, &mut p, &mut include)?;
        return Ok(());
    }

    let vertex = -b / (2.0 * a);
    let radius = (discriminant.abs() + delta).sqrt() / (2.0 * a.abs());
    if !vertex.is_finite() || !radius.is_finite() {
        return Err(PATH_NUMERIC_RANGE);
    }
    if vertex + radius >= 0.0 && vertex - radius <= 1.0 {
        // a/b/c omit the common factor three from B'. Restore the full
        // derivative coefficient scale before comparing coordinate error.
        let derivative_scale = 3.0 * scale;
        let uncertainty = radius
            * derivative_scale
            * (a.abs() * radius * radius + (discriminant.abs() + delta) / (4.0 * a.abs()));
        if !uncertainty.is_finite() || uncertainty > guard {
            return Err(PATH_NUMERIC_RANGE);
        }
        evaluate_root(vertex.clamp(0.0, 1.0), &mut p, &mut include)?;
    }
    Ok(())
}

fn evaluate_root(
    root: f64,
    points: &mut [f64; 4],
    include: &mut impl FnMut(f64),
) -> Result<(), u32> {
    if root > 0.0 && root < 1.0 {
        let a = midpoint_at(points[0], points[1], root)?;
        let b = midpoint_at(points[1], points[2], root)?;
        let c = midpoint_at(points[2], points[3], root)?;
        let d = midpoint_at(a, b, root)?;
        let e = midpoint_at(b, c, root)?;
        include(midpoint_at(d, e, root)?);
    }
    Ok(())
}

fn midpoint_at(a: f64, b: f64, t: f64) -> Result<f64, u32> {
    let value = a * (1.0 - t) + b * t;
    value.is_finite().then_some(value).ok_or(PATH_NUMERIC_RANGE)
}

#[allow(clippy::too_many_arguments)]
fn flatten(
    cubic: Cubic,
    tolerance: f64,
    source_verb: u32,
    pass: Pass,
    statistics: &mut WorkStatistics,
    path_work: &mut PathWork,
    cubic_lines: &mut u32,
    emit: &mut impl FnMut(u8, Option<Point>, Provenance) -> bool,
) -> Result<(), u32> {
    visit(
        cubic,
        cubic.points,
        tolerance,
        source_verb,
        0,
        0,
        pass,
        statistics,
        path_work,
        cubic_lines,
        emit,
    )
}

#[allow(clippy::too_many_arguments)]
fn visit(
    cubic: Cubic,
    points: [Point; 4],
    tolerance: f64,
    source_verb: u32,
    depth: u32,
    start_numerator: u32,
    pass: Pass,
    statistics: &mut WorkStatistics,
    path_work: &mut PathWork,
    cubic_lines: &mut u32,
    emit: &mut impl FnMut(u8, Option<Point>, Provenance) -> bool,
) -> Result<(), u32> {
    if path_work.visits >= MAX_VISITS_PER_PATH {
        return Err(PATH_WORK_LIMIT);
    }
    path_work.visits += 1;
    match pass {
        Pass::Sizing => statistics.sizing_visits += 1,
        Pass::Emission => statistics.emission_visits += 1,
    }

    let guard = cubic.guard(depth)?;
    if guard >= tolerance {
        return Err(PATH_NUMERIC_RANGE);
    }
    let chord_1 = Point {
        x: points[0].x + (points[3].x - points[0].x) / 3.0,
        y: points[0].y + (points[3].y - points[0].y) / 3.0,
    };
    let chord_2 = Point {
        x: points[0].x + 2.0 * (points[3].x - points[0].x) / 3.0,
        y: points[0].y + 2.0 * (points[3].y - points[0].y) / 3.0,
    };
    let q1 = points[1].checked_sub(chord_1)?;
    let q2 = points[2].checked_sub(chord_2)?;
    let flatness = q1.x.hypot(q1.y).max(q2.x.hypot(q2.y));
    if !flatness.is_finite() {
        return Err(PATH_NUMERIC_RANGE);
    }
    let guarded_flatness = flatness + guard;
    if !guarded_flatness.is_finite() {
        return Err(PATH_NUMERIC_RANGE);
    }
    if guarded_flatness <= tolerance {
        return emit_leaf(
            cubic,
            Leaf {
                endpoint: points[3],
                end_numerator: start_numerator.checked_add(1).ok_or(PATH_WORK_LIMIT)?,
                depth,
            },
            source_verb,
            pass,
            statistics,
            path_work,
            cubic_lines,
            emit,
        );
    }
    if depth >= MAX_DEPTH {
        return Err(PATH_WORK_LIMIT);
    }

    let p01 = points[0].midpoint(points[1])?;
    let p12 = points[1].midpoint(points[2])?;
    let p23 = points[2].midpoint(points[3])?;
    let p012 = p01.midpoint(p12)?;
    let p123 = p12.midpoint(p23)?;
    let middle = p012.midpoint(p123)?;
    let child_depth = depth + 1;
    let left_start = start_numerator.checked_mul(2).ok_or(PATH_WORK_LIMIT)?;
    visit(
        cubic,
        [points[0], p01, p012, middle],
        tolerance,
        source_verb,
        child_depth,
        left_start,
        pass,
        statistics,
        path_work,
        cubic_lines,
        emit,
    )?;
    visit(
        cubic,
        [middle, p123, p23, points[3]],
        tolerance,
        source_verb,
        child_depth,
        left_start.checked_add(1).ok_or(PATH_WORK_LIMIT)?,
        pass,
        statistics,
        path_work,
        cubic_lines,
        emit,
    )
}

#[allow(clippy::too_many_arguments)]
fn emit_leaf(
    cubic: Cubic,
    leaf: Leaf,
    source_verb: u32,
    pass: Pass,
    statistics: &mut WorkStatistics,
    path_work: &mut PathWork,
    cubic_lines: &mut u32,
    emit: &mut impl FnMut(u8, Option<Point>, Provenance) -> bool,
) -> Result<(), u32> {
    if *cubic_lines >= MAX_LINES_PER_CUBIC {
        return Err(PATH_WORK_LIMIT);
    }
    add_output_verb(path_work)?;
    *cubic_lines += 1;
    if pass == Pass::Emission {
        statistics.emitted_cubic_lines += 1;
    }
    let endpoint = Point {
        x: cubic.original_origin.x + leaf.endpoint.x,
        y: cubic.original_origin.y + leaf.endpoint.y,
    };
    if !endpoint.is_finite() {
        return Err(PATH_NUMERIC_RANGE);
    }
    let denominator = 1u32.checked_shl(leaf.depth).ok_or(PATH_WORK_LIMIT)?;
    let end_numerator = if leaf.depth == 0 {
        1
    } else {
        leaf.end_numerator
    };
    if end_numerator == 0 || end_numerator > denominator {
        return Err(PATH_NUMERIC_RANGE);
    }
    if !emit(
        VERB_LINE,
        Some(endpoint),
        Provenance {
            source_verb,
            end_numerator,
            depth: leaf.depth,
        },
    ) {
        return Err(PATH_NUMERIC_RANGE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::Request;

    fn path<'a>(verbs: &'a [u8], point_bytes: &'a [u8], tolerance: f64) -> PathInput<'a> {
        PathInput::from_test_parts(
            Request {
                request_id: 1,
                source_epoch: 2,
                source_revision: 3,
                tolerance,
            },
            verbs,
            point_bytes,
        )
    }

    fn points(values: &[f64]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    fn cubic_points(x: [f64; 4], y: [f64; 4]) -> Vec<u8> {
        let mut values = Vec::with_capacity(8);
        for index in 0..4 {
            values.push(x[index]);
            values.push(y[index]);
        }
        points(&values)
    }

    fn measured_run(
        verbs: &[u8],
        point_bytes: &[u8],
        tolerance: f64,
        pass: Pass,
    ) -> (Plan, Bounds, WorkStatistics) {
        let mut statistics = WorkStatistics::default();
        crate::allocation_test_support::start();
        let (plan, bounds) = run_path(
            path(verbs, point_bytes, tolerance),
            pass,
            &mut statistics,
            |_, _, _| true,
        );
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(allocations, 0, "geometry pass allocated");
        (plan, bounds, statistics)
    }

    fn endpoint_bounds(x: [f64; 4], y: [f64; 4]) -> Bounds {
        let controls = core::array::from_fn(|index| Point {
            x: x[index],
            y: y[index],
        });
        let cubic = Cubic::relative(controls).unwrap();
        let guard = cubic.guard(0).unwrap();
        Bounds {
            min_x: controls[0].x + (cubic.points[0].x.min(cubic.points[3].x) - guard),
            min_y: controls[0].y + (cubic.points[0].y.min(cubic.points[3].y) - guard),
            max_x: controls[0].x + (cubic.points[0].x.max(cubic.points[3].x) + guard),
            max_y: controls[0].y + (cubic.points[0].y.max(cubic.points[3].y) + guard),
        }
    }

    fn translated_thirds() -> [f64; 4] {
        [
            1.0,
            f64::from_bits(0x3ff5_5555_5555_5555),
            f64::from_bits(0x3ffa_aaaa_aaaa_aaaa),
            2.0,
        ]
    }

    #[test]
    fn endpoint_hull_certifies_translated_reverse_reflected_and_axis_cases() {
        let translated = translated_thirds();
        let reverse = [
            1.0,
            f64::from_bits(0x3fe5_5555_5555_5556),
            f64::from_bits(0x3fd5_5555_5555_5556),
            0.0,
        ];
        let reflected = translated.map(|value| -value);
        let shifted = translated.map(|value| value + 8.0);
        let zero = [0.0; 4];
        for (x, y) in [
            (translated, zero),
            (reverse, zero),
            (reflected, zero),
            (shifted, zero),
            (zero, translated),
            (translated, [-0.0, 0.0, -0.0, 0.0]),
        ] {
            let bytes = cubic_points(x, y);
            for pass in [Pass::Sizing, Pass::Emission] {
                let (plan, bounds, _) = measured_run(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.25, pass);
                assert_eq!(plan.status, PATH_OK);
                assert_eq!(bounds, endpoint_bounds(x, y));
            }
        }

        let cubic = Cubic::relative(core::array::from_fn(|index| Point {
            x: translated[index],
            y: 0.0,
        }))
        .unwrap();
        assert_eq!(cubic.guard(0).unwrap(), 384.0 * EPSILON);
    }

    #[test]
    fn endpoint_hull_is_inclusive_and_does_not_require_control_order() {
        for x in [[0.0, 3.0, 1.0, 4.0], [0.0, 0.0, 1.0, 1.0]] {
            let y = [0.0; 4];
            let bytes = cubic_points(x, y);
            let (plan, bounds, _) =
                measured_run(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.25, Pass::Sizing);
            assert_eq!(plan.status, PATH_OK);
            assert_eq!(bounds, endpoint_bounds(x, y));
        }
    }

    #[test]
    fn endpoint_hull_is_per_axis_and_non_hull_fallback_remains_active() {
        let translated = translated_thirds();
        let arch = [0.0, 3.0, 3.0, 0.0];
        let bytes = cubic_points(translated, arch);
        let (plan, bounds, _) = measured_run(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.25, Pass::Sizing);
        assert_eq!(plan.status, PATH_OK);
        let guard = Cubic::relative(core::array::from_fn(|index| Point {
            x: translated[index],
            y: arch[index],
        }))
        .unwrap()
        .guard(0)
        .unwrap();
        assert_eq!(bounds.min_x, 1.0 - guard);
        assert_eq!(bounds.max_x, 2.0 + guard);
        assert_eq!(bounds.min_y, -guard);
        assert_eq!(bounds.max_y, 2.25 + guard);

        let repeated_root = [0.0, 1.0 / 16.0, -1.0 / 8.0, 7.0 / 16.0];
        let bytes = cubic_points(repeated_root, [0.0; 4]);
        let (plan, bounds, _) = measured_run(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.25, Pass::Sizing);
        assert_eq!(plan.status, PATH_OK);
        assert_eq!(bounds, endpoint_bounds(repeated_root, [0.0; 4]));
    }

    #[test]
    fn endpoint_hull_preserves_overflow_and_guard_failure_precedence() {
        let huge = cubic_points([f64::MAX, -f64::MAX, f64::MAX, -f64::MAX], [0.0; 4]);
        let (plan, bounds, _) = measured_run(&[VERB_MOVE, VERB_CUBIC], &huge, 0.25, Pass::Sizing);
        assert_eq!(plan, failure(PATH_NUMERIC_RANGE));
        assert_eq!(bounds, Bounds::default());

        let coefficient_overflow = f64::from_bits(0x7fd8_0000_0000_0000);
        let finite_coefficient = 2.0f64.powi(1022);
        let overflow_cubic = Cubic::relative([
            Point { x: 0.0, y: 0.0 },
            Point {
                x: coefficient_overflow,
                y: 0.0,
            },
            Point {
                x: coefficient_overflow,
                y: 0.0,
            },
            Point {
                x: coefficient_overflow,
                y: 0.0,
            },
        ])
        .unwrap();
        let overflow_guard = overflow_cubic.guard(0).unwrap();
        assert!(overflow_guard.is_finite());
        assert!(overflow_guard < 2.0f64.powi(1000));
        assert_eq!(
            extrema(
                [
                    0.0,
                    coefficient_overflow,
                    coefficient_overflow,
                    coefficient_overflow,
                ],
                0.0,
                |_| {}
            ),
            Err(PATH_NUMERIC_RANGE)
        );
        assert_eq!(
            extrema(
                [
                    0.0,
                    finite_coefficient,
                    finite_coefficient,
                    finite_coefficient,
                ],
                0.0,
                |_| {}
            ),
            Ok(())
        );
        let overflow_bytes = cubic_points(
            [
                0.0,
                coefficient_overflow,
                coefficient_overflow,
                coefficient_overflow,
            ],
            [0.0; 4],
        );
        let (plan, bounds, _) = measured_run(
            &[VERB_MOVE, VERB_CUBIC],
            &overflow_bytes,
            2.0f64.powi(1000),
            Pass::Sizing,
        );
        assert_eq!(plan, failure(PATH_NUMERIC_RANGE));
        assert_eq!(bounds, Bounds::default());

        let translated = cubic_points(translated_thirds(), [0.0; 4]);
        let (plan, bounds, statistics) = measured_run(
            &[VERB_MOVE, VERB_CUBIC],
            &translated,
            2.0f64.powi(-50),
            Pass::Sizing,
        );
        assert_eq!(plan, failure(PATH_NUMERIC_RANGE));
        assert_eq!(bounds, Bounds::default());
        assert_eq!(statistics.sizing_visits, 0);
    }

    #[test]
    fn uncertain_non_hull_seam_rejects_without_publishing_a_candidate() {
        let mut candidate = None;
        assert_eq!(
            extrema([0.0, 1.0 / 16.0, -1.0 / 8.0, 7.0 / 16.0], 0.0, |value| {
                candidate = Some(value)
            },),
            Err(PATH_NUMERIC_RANGE)
        );
        assert_eq!(candidate, None);
    }

    #[test]
    fn endpoint_hull_success_and_failure_passes_do_not_allocate() {
        let translated = cubic_points(translated_thirds(), [0.0; 4]);
        let overflow = f64::from_bits(0x7fd8_0000_0000_0000);
        let coefficient_overflow = cubic_points([0.0, overflow, overflow, overflow], [0.0; 4]);
        for pass in [Pass::Sizing, Pass::Emission] {
            let (success, _, _) = measured_run(&[VERB_MOVE, VERB_CUBIC], &translated, 0.25, pass);
            assert_eq!(success.status, PATH_OK);
            let (failure_plan, bounds, _) = measured_run(
                &[VERB_MOVE, VERB_CUBIC],
                &coefficient_overflow,
                2.0f64.powi(1000),
                pass,
            );
            assert_eq!(failure_plan, failure(PATH_NUMERIC_RANGE));
            assert_eq!(bounds, Bounds::default());
        }
    }

    #[test]
    fn earlier_path_failure_retains_later_path_progress() {
        let first = points(&[
            0.0,
            0.0,
            1.0,
            0.0,
            f64::MAX,
            0.0,
            -f64::MAX,
            0.0,
            f64::MAX,
            0.0,
            -f64::MAX,
            0.0,
        ]);
        let (first_plan, first_bounds, first_statistics) = measured_run(
            &[VERB_MOVE, VERB_LINE, VERB_MOVE, VERB_CUBIC],
            &first,
            0.25,
            Pass::Sizing,
        );
        assert_eq!(first_plan, failure(PATH_NUMERIC_RANGE));
        assert_eq!(first_bounds, Bounds::default());
        assert_eq!(first_statistics.logical_cubics, 1);

        let second = cubic_points(translated_thirds(), [0.0; 4]);
        let (second_plan, second_bounds, _) =
            measured_run(&[VERB_MOVE, VERB_CUBIC], &second, 0.25, Pass::Sizing);
        assert_eq!(second_plan.status, PATH_OK);
        assert_eq!(
            second_bounds,
            endpoint_bounds(translated_thirds(), [0.0; 4])
        );
    }

    #[test]
    fn translated_endpoint_hull_emission_keeps_endpoint_and_provenance() {
        let bytes = cubic_points(translated_thirds(), [0.0; 4]);
        let mut endpoint = None;
        let mut provenance = None;
        let mut statistics = WorkStatistics::default();
        crate::allocation_test_support::start();
        let (plan, _) = run_path(
            path(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.25),
            Pass::Emission,
            &mut statistics,
            |verb, point, source| {
                if verb == VERB_LINE {
                    endpoint = point;
                    provenance = Some(source);
                }
                true
            },
        );
        let allocations = crate::allocation_test_support::stop();
        assert_eq!(allocations, 0);
        assert_eq!(plan.status, PATH_OK);
        assert_eq!(endpoint, Some(Point { x: 2.0, y: 0.0 }));
        assert_eq!(
            provenance,
            Some(Provenance {
                source_verb: 1,
                end_numerator: 1,
                depth: 0,
            })
        );
        assert_eq!(statistics.emitted_cubic_lines, 1);
    }

    #[test]
    fn line_and_close_preserve_structure() {
        let bytes = points(&[1.0, 2.0, 3.0, 4.0]);
        let mut output = Vec::new();
        let (plan, bounds) = run_path(
            path(&[VERB_MOVE, VERB_LINE, VERB_CLOSE], &bytes, 0.25),
            Pass::Sizing,
            &mut WorkStatistics::default(),
            |verb, point, provenance| {
                output.push((verb, point, provenance));
                true
            },
        );
        assert_eq!(
            plan,
            Plan {
                status: PATH_OK,
                verb_count: 3,
                point_count: 4
            }
        );
        assert_eq!(
            bounds,
            Bounds {
                min_x: 1.0,
                min_y: 2.0,
                max_x: 3.0,
                max_y: 4.0
            }
        );
        assert_eq!(output[2].0, VERB_CLOSE);
        assert_eq!(output[2].1, None);
    }

    #[test]
    fn invalid_state_precedes_invalid_tolerance() {
        let bytes = points(&[1.0, 2.0]);
        let (plan, _) = run_path(
            path(&[VERB_LINE], &bytes, f64::NAN),
            Pass::Sizing,
            &mut WorkStatistics::default(),
            |_, _, _| true,
        );
        assert_eq!(plan.status, PATH_INVALID);
    }

    #[test]
    fn cubic_emits_dyadic_coverage_and_tight_extrema() {
        let bytes = points(&[0.0, 0.0, 0.0, 3.0, 3.0, 3.0, 3.0, 0.0]);
        let mut provenance = Vec::new();
        let mut statistics = WorkStatistics::default();
        let (plan, bounds) = run_path(
            path(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.125),
            Pass::Emission,
            &mut statistics,
            |verb, _, source| {
                if verb == VERB_LINE {
                    provenance.push(source);
                }
                true
            },
        );
        assert_eq!(plan.status, PATH_OK);
        assert!(provenance.len() > 1);
        assert_eq!(
            provenance.last().unwrap().end_numerator,
            1 << provenance.last().unwrap().depth
        );
        assert!(bounds.min_x <= 0.0 && bounds.max_x >= 3.0);
        assert!((bounds.max_y - 2.25).abs() < 1.0e-12);
        assert_eq!(statistics.emitted_cubic_lines, provenance.len() as u64);
    }

    #[test]
    fn huge_opposite_controls_fail_without_panicking() {
        let bytes = points(&[f64::MAX, 0.0, -f64::MAX, 0.0, f64::MAX, 0.0, -f64::MAX, 0.0]);
        let (plan, _) = run_path(
            path(&[VERB_MOVE, VERB_CUBIC], &bytes, 1.0),
            Pass::Sizing,
            &mut WorkStatistics::default(),
            |_, _, _| true,
        );
        assert_eq!(plan.status, PATH_NUMERIC_RANGE);
    }

    #[test]
    fn depth_or_line_cap_returns_work_limit() {
        let bytes = points(&[0.0, 0.0, 0.0, 1.0e12, 1.0, 1.0e12, 1.0, 0.0]);
        let (plan, _) = run_path(
            path(&[VERB_MOVE, VERB_CUBIC], &bytes, 1.0),
            Pass::Sizing,
            &mut WorkStatistics::default(),
            |_, _, _| true,
        );
        assert_eq!(plan.status, PATH_WORK_LIMIT);
    }

    #[test]
    fn raised_line_cap_admits_the_frozen_8192_leaf_boundary() {
        let bytes = points(&[
            1807.2471809573472,
            709.6245270222425,
            -1884.8323626443744,
            -942.0818486250937,
            -1583.087441045791,
            -619.90946251899,
            2841.777014080435,
            760.4788057506084,
        ]);
        let mut emitted_lines = 0;
        let mut statistics = WorkStatistics::default();
        let (plan, _) = run_path(
            path(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.000_244_140_625),
            Pass::Sizing,
            &mut statistics,
            |verb, _, _| {
                if verb == VERB_LINE {
                    emitted_lines += 1;
                }
                true
            },
        );
        assert_eq!(plan.status, PATH_OK);
        assert_eq!(plan.verb_count, MAX_LINES_PER_CUBIC + 1);
        assert_eq!(emitted_lines, MAX_LINES_PER_CUBIC);
        assert_eq!(statistics.sizing_visits, 16_383);
    }

    #[test]
    fn previous_conflict_index_209_now_succeeds_with_4873_leaves() {
        let bytes = points(&[
            -2661.498059052974,
            -826.6451233066618,
            970.641509629786,
            553.8398623466492,
            -2108.662119600922,
            -690.7536224462092,
            -1913.5083323344588,
            -939.6924353204668,
        ]);
        let mut emitted_lines = 0;
        let mut statistics = WorkStatistics::default();
        let (plan, _) = run_path(
            path(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.000_244_140_625),
            Pass::Sizing,
            &mut statistics,
            |verb, _, _| {
                if verb == VERB_LINE {
                    emitted_lines += 1;
                }
                true
            },
        );
        assert_eq!(plan.status, PATH_OK);
        assert_eq!(plan.verb_count, 4_874);
        assert_eq!(emitted_lines, 4_873);
        assert_eq!(statistics.sizing_visits, 9_745);
    }

    #[test]
    fn raised_line_cap_rejects_the_first_exceeding_leaf() {
        let scaled: Vec<f64> = [
            1807.2471809573472,
            709.6245270222425,
            -1884.8323626443744,
            -942.0818486250937,
            -1583.087441045791,
            -619.90946251899,
            2841.777014080435,
            760.4788057506084,
        ]
        .into_iter()
        .map(|value| value * 4.0)
        .collect();
        let bytes = points(&scaled);
        let mut emitted_lines = 0;
        let (plan, _) = run_path(
            path(&[VERB_MOVE, VERB_CUBIC], &bytes, 0.000_244_140_625),
            Pass::Sizing,
            &mut WorkStatistics::default(),
            |verb, _, _| {
                if verb == VERB_LINE {
                    emitted_lines += 1;
                }
                true
            },
        );
        assert_eq!(plan, failure(PATH_WORK_LIMIT));
        assert_eq!(emitted_lines, MAX_LINES_PER_CUBIC);
    }

    #[test]
    fn depth_twenty_is_inclusive_and_its_first_exceeding_split_is_rejected() {
        // Exercise the exact depth guard independently of earlier numeric and
        // output-line guards by seeding visit at the boundary.
        let line = Cubic::relative([
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 1.0 },
            Point { x: 2.0, y: 2.0 },
            Point { x: 3.0, y: 3.0 },
        ])
        .unwrap();
        let mut statistics = WorkStatistics::default();
        let mut work = PathWork::default();
        let mut lines = 0;
        let mut provenance = None;
        assert_eq!(
            visit(
                line,
                line.points,
                1.0,
                1,
                MAX_DEPTH,
                0,
                Pass::Sizing,
                &mut statistics,
                &mut work,
                &mut lines,
                &mut |_, _, value| {
                    provenance = Some(value);
                    true
                },
            ),
            Ok(())
        );
        assert_eq!(provenance.unwrap().depth, MAX_DEPTH);

        let curved = Cubic::relative([
            Point { x: 0.0, y: 0.0 },
            Point { x: 0.0, y: 3.0 },
            Point { x: 3.0, y: 3.0 },
            Point { x: 3.0, y: 0.0 },
        ])
        .unwrap();
        assert_eq!(
            visit(
                curved,
                curved.points,
                0.25,
                1,
                MAX_DEPTH,
                0,
                Pass::Sizing,
                &mut WorkStatistics::default(),
                &mut PathWork::default(),
                &mut 0,
                &mut |_, _, _| true,
            ),
            Err(PATH_WORK_LIMIT)
        );
    }

    #[test]
    fn path_visit_limit_is_inclusive_at_the_internal_node_seam() {
        // Output verbs cap ordinary traversals first, so initialize the
        // monotonic visit counter immediately below its independent limit.
        let line = Cubic::relative([
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 1.0 },
            Point { x: 2.0, y: 2.0 },
            Point { x: 3.0, y: 3.0 },
        ])
        .unwrap();
        let mut work = PathWork {
            visits: MAX_VISITS_PER_PATH - 1,
            output_verbs: 0,
        };
        let mut lines = 0;
        assert_eq!(
            visit(
                line,
                line.points,
                1.0,
                1,
                0,
                0,
                Pass::Sizing,
                &mut WorkStatistics::default(),
                &mut work,
                &mut lines,
                &mut |_, _, _| true,
            ),
            Ok(())
        );
        assert_eq!(work.visits, MAX_VISITS_PER_PATH);
        assert_eq!(
            visit(
                line,
                line.points,
                1.0,
                1,
                0,
                0,
                Pass::Sizing,
                &mut WorkStatistics::default(),
                &mut work,
                &mut lines,
                &mut |_, _, _| true,
            ),
            Err(PATH_WORK_LIMIT)
        );
        assert_eq!(work.visits, MAX_VISITS_PER_PATH);
    }

    #[test]
    fn output_verb_limit_is_inclusive() {
        let accepted_verbs = vec![VERB_MOVE; MAX_OUTPUT_VERBS_PER_PATH as usize];
        let accepted_points = points(&vec![0.0; MAX_OUTPUT_VERBS_PER_PATH as usize * 2]);
        let (accepted, _) = run_path(
            path(&accepted_verbs, &accepted_points, 1.0),
            Pass::Sizing,
            &mut WorkStatistics::default(),
            |_, _, _| true,
        );
        assert_eq!(accepted.status, PATH_OK);
        assert_eq!(accepted.verb_count, MAX_OUTPUT_VERBS_PER_PATH);

        let rejected_count = MAX_OUTPUT_VERBS_PER_PATH as usize + 1;
        let rejected_verbs = vec![VERB_MOVE; rejected_count];
        let rejected_points = points(&vec![0.0; rejected_count * 2]);
        let (rejected, _) = run_path(
            path(&rejected_verbs, &rejected_points, 1.0),
            Pass::Sizing,
            &mut WorkStatistics::default(),
            |_, _, _| true,
        );
        assert_eq!(rejected.status, PATH_WORK_LIMIT);
    }
}
