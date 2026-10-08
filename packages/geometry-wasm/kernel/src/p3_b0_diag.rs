//! P3 B0 diagnostic instrumentation, compiled only with `--cfg p3_b0_diag`.
//! It counts top-level calls of the exact routines named by the frozen B0
//! contract, captures replayable operands and offers a stage stop marker.
//! Production, WASM and ordinary test builds never compile this module.
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

pub(crate) const STAGE_FULL: u8 = 0;
pub(crate) const STAGE_S1: u8 = 1;
pub(crate) const STAGE_S2: u8 = 2;
const CAPTURE_LIMIT: usize = 1_000;

type Key = (&'static str, &'static str);
type Replay = Box<dyn Fn()>;

thread_local! {
    static STOP: Cell<u8> = const { Cell::new(STAGE_FULL) };
    static DEPTH: Cell<u32> = const { Cell::new(0) };
    static COUNTING: Cell<bool> = const { Cell::new(false) };
    static CAPTURING: Cell<bool> = const { Cell::new(false) };
    static COUNTS: RefCell<BTreeMap<Key, u64>> = const { RefCell::new(BTreeMap::new()) };
    static CAPTURED: RefCell<BTreeMap<Key, Vec<Replay>>> = const { RefCell::new(BTreeMap::new()) };
}

pub(crate) struct Guard;

impl Drop for Guard {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}

/// Enters a counted routine. Only a call with no counted routine above it is
/// counted or captured, so counts are top-level and unit costs inclusive.
pub(crate) fn enter<F: Fn() + 'static>(
    routine: &'static str,
    instance: &'static str,
    replay: F,
) -> Guard {
    let top = DEPTH.with(|depth| {
        let value = depth.get();
        depth.set(value + 1);
        value == 0
    });
    if top {
        let key = (routine, instance);
        if COUNTING.with(Cell::get) {
            COUNTS.with(|counts| *counts.borrow_mut().entry(key).or_insert(0) += 1);
        }
        if CAPTURING.with(Cell::get) {
            CAPTURED.with(|captured| {
                let mut captured = captured.borrow_mut();
                let list = captured.entry(key).or_default();
                if list.len() < CAPTURE_LIMIT {
                    list.push(Box::new(replay));
                }
            });
        }
    }
    Guard
}

pub(crate) fn stop_stage() -> u8 {
    STOP.with(Cell::get)
}

pub(crate) fn set_stop_stage(stage: u8) {
    STOP.with(|stop| stop.set(stage));
}

pub(crate) fn set_counting(enabled: bool) {
    COUNTING.with(|counting| counting.set(enabled));
}

pub(crate) fn set_capturing(enabled: bool) {
    CAPTURING.with(|capturing| capturing.set(enabled));
}

pub(crate) fn take_counts() -> Vec<(Key, u64)> {
    COUNTS.with(|counts| {
        core::mem::take(&mut *counts.borrow_mut())
            .into_iter()
            .collect()
    })
}

pub(crate) fn take_captured() -> Vec<(Key, Vec<Replay>)> {
    CAPTURED.with(|captured| {
        core::mem::take(&mut *captured.borrow_mut())
            .into_iter()
            .collect()
    })
}
