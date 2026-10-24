#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod codec;
// Private canonical cubic composition has no P2 v1 caller or WASM export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod cubic_fill;
mod engine;
// P3 D8 V2 fill-mesh transport v0, beside the unchanged P2 ABI v1.
mod fill_export;
// P3 symbolic ordering has no P2 v1 caller or WASM export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_event_order;
// Shared fixed-width arithmetic for private P3 geometry; no P2 export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_exact;
// B0R binary64 filters with exact fallback (private; no P2 caller or export).
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_filter;
// P3 placement is private preparation; no P2 v1 caller or WASM export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_intersections;
// P3 predicates are prepared independently; P2 v1 has no fill caller or new export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_predicates;
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_sections;
mod geometry;
// P3 exact-output line meshes remain private and have no P2 v1 export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod line_fill;
// P3 rounded meshes are private and preserve the existing P2 ABI.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod rounded_line_fill;
// Restricted cubic topology is private preparation with no P2 v1 export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod simple_cubic_topology;

// P3 B0 diagnostic counters and stage marker; only under --cfg p3_b0_diag.
#[cfg(p3_b0_diag)]
mod p3_b0_diag;

#[cfg(test)]
mod fill_event_order_filter_tests;
#[cfg(test)]
mod fill_event_order_tests;
#[cfg(test)]
mod fill_exact_tests;
#[cfg(test)]
mod fill_export_tests;
#[cfg(test)]
mod fill_filter_tests;
#[cfg(test)]
mod fill_intersections_tests;
#[cfg(test)]
mod fill_predicates_filter_tests;
#[cfg(test)]
mod fill_predicates_tests;
#[cfg(test)]
mod fill_sections_filter_tests;
#[cfg(test)]
mod fill_sections_slab_tests;
#[cfg(test)]
mod line_fill_tests;
#[cfg(test)]
mod mixed_line_arrangement_tests;
#[cfg(test)]
mod native_cubic_fill_tests;
#[cfg(test)]
mod p3_b0_bench;
#[cfg(test)]
mod p3_b0r_identity;
#[cfg(test)]
mod rounded_cubic_topology_tests;
#[cfg(test)]
mod rounded_line_fill_loop_tests;
#[cfg(test)]
mod rounded_line_fill_scan_tests;
#[cfg(test)]
mod rounded_line_fill_tests;
#[cfg(test)]
mod simple_cubic_topology_filter_tests;
#[cfg(test)]
mod simple_cubic_topology_sweep_tests;
#[cfg(test)]
mod simple_cubic_topology_tests;
#[cfg(test)]
mod transverse_arrangement_tests;
#[cfg(test)]
mod transverse_pair_tests;
#[cfg(test)]
mod triangle_free_arrangement_tests;

#[cfg(target_arch = "wasm32")]
use core::cell::UnsafeCell;
#[cfg(target_arch = "wasm32")]
use engine::Engine;

pub use engine::{
    BATCH_ALLOCATION_FAILED, BATCH_DISPOSED, BATCH_INTERNAL_ERROR, BATCH_INVALID_BATCH, BATCH_OK,
    BATCH_OUTPUT_CAPACITY, BATCH_RESOURCE_LIMIT,
};

#[cfg(target_arch = "wasm32")]
struct GlobalEngine(UnsafeCell<Engine>);

// The ABI is explicitly single-threaded and non-reentrant. Native tests use
// independent Engine values rather than this process-global export state.
#[cfg(target_arch = "wasm32")]
unsafe impl Sync for GlobalEngine {}

#[cfg(target_arch = "wasm32")]
static GLOBAL_ENGINE: GlobalEngine = GlobalEngine(UnsafeCell::new(Engine::new()));

#[cfg(target_arch = "wasm32")]
fn with_engine<T>(f: impl FnOnce(&mut Engine) -> T) -> T {
    // SAFETY: the frozen ABI permits one single-threaded, non-reentrant caller.
    // No reference to the Engine escapes this function.
    unsafe { f(&mut *GLOBAL_ENGINE.0.get()) }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn abi_version() -> u32 {
    1
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn reserve(input_bytes: u32, output_bytes: u32) -> u32 {
    with_engine(|engine| engine.reserve(input_bytes, output_bytes))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn input_ptr() -> u32 {
    with_engine(Engine::input_ptr)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn input_capacity() -> u32 {
    with_engine(Engine::input_capacity)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn output_ptr() -> u32 {
    with_engine(Engine::output_ptr)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn output_capacity() -> u32 {
    with_engine(Engine::output_capacity)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn memory_epoch() -> u32 {
    with_engine(Engine::memory_epoch)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn process(input_length: u32) -> u32 {
    with_engine(|engine| engine.process(input_length))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn result_len() -> u32 {
    with_engine(Engine::result_len)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn required_output_bytes() -> u32 {
    with_engine(Engine::required_output_bytes)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn statistics_ptr() -> u32 {
    with_engine(Engine::statistics_ptr)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn dispose() -> u32 {
    with_engine(Engine::dispose)
}

// P3 D8 V2 fill-mesh transport v0 (docs/plans/p3-v2-fill-mesh-transport-contract.md).
// A second module-level engine; it shares no state with GLOBAL_ENGINE.
#[cfg(target_arch = "wasm32")]
struct GlobalFillEngine(UnsafeCell<fill_export::FillEngine>);

// Same single-threaded, non-reentrant rule as GlobalEngine.
#[cfg(target_arch = "wasm32")]
unsafe impl Sync for GlobalFillEngine {}

#[cfg(target_arch = "wasm32")]
static GLOBAL_FILL_ENGINE: GlobalFillEngine =
    GlobalFillEngine(UnsafeCell::new(fill_export::FillEngine::new()));

#[cfg(target_arch = "wasm32")]
fn with_fill_engine<T>(f: impl FnOnce(&mut fill_export::FillEngine) -> T) -> T {
    // SAFETY: the fill ABI permits one single-threaded, non-reentrant caller.
    // No reference to the FillEngine escapes this function.
    unsafe { f(&mut *GLOBAL_FILL_ENGINE.0.get()) }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_version() -> u32 {
    fill_export::FILL_V0_VERSION
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_revision() -> u32 {
    fill_export::FILL_V0_REVISION
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_reserve(input_bytes: u32, output_bytes: u32) -> u32 {
    with_fill_engine(|engine| engine.reserve(input_bytes, output_bytes))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_input_ptr() -> u32 {
    with_fill_engine(fill_export::FillEngine::input_ptr)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_input_capacity() -> u32 {
    with_fill_engine(fill_export::FillEngine::input_capacity)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_output_ptr() -> u32 {
    with_fill_engine(fill_export::FillEngine::output_ptr)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_output_capacity() -> u32 {
    with_fill_engine(fill_export::FillEngine::output_capacity)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_memory_epoch() -> u32 {
    with_fill_engine(fill_export::FillEngine::memory_epoch)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_process(input_length: u32) -> u32 {
    with_fill_engine(|engine| engine.process(input_length))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_result_len() -> u32 {
    with_fill_engine(fill_export::FillEngine::result_len)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_required_output_bytes() -> u32 {
    with_fill_engine(fill_export::FillEngine::required_output_bytes)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn fill_v0_dispose() -> u32 {
    with_fill_engine(fill_export::FillEngine::dispose)
}

#[cfg(test)]
mod allocation_test_support {
    use core::cell::Cell;
    use std::alloc::{GlobalAlloc, Layout, System};

    thread_local! {
        static ENABLED: Cell<bool> = const { Cell::new(false) };
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub struct TrackingAllocator;

    unsafe impl GlobalAlloc for TrackingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            ENABLED.with(|enabled| {
                if enabled.get() {
                    COUNT.with(|count| count.set(count.get() + 1));
                }
            });
            // SAFETY: forwards the allocator contract unchanged to System.
            unsafe { System.alloc(layout) }
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            // SAFETY: pointer and layout came from the corresponding allocator.
            unsafe { System.dealloc(pointer, layout) };
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            ENABLED.with(|enabled| {
                if enabled.get() {
                    COUNT.with(|count| count.set(count.get() + 1));
                }
            });
            // SAFETY: forwards the allocator contract unchanged to System.
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            ENABLED.with(|enabled| {
                if enabled.get() {
                    COUNT.with(|count| count.set(count.get() + 1));
                }
            });
            // SAFETY: forwards the allocator contract unchanged to System.
            unsafe { System.realloc(pointer, layout, new_size) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: TrackingAllocator = TrackingAllocator;

    pub fn start() {
        COUNT.with(|count| count.set(0));
        ENABLED.with(|enabled| enabled.set(true));
    }

    pub fn stop() -> usize {
        ENABLED.with(|enabled| enabled.set(false));
        COUNT.with(Cell::get)
    }
}

// P3 B0 spike unit SL-U1 (docs/plans/p3-b0-spike-ladder-contract.md), test-only. Declared at
// the end of the file so that no existing line moves (the release WASM embeds source locations).
#[cfg(test)]
mod p3_b0_spike;
#[cfg(test)]
mod p3_b0_spike_tests;
// P3 B0 spike unit SL-U3 harness, test-only; appended for the same reason as above.
#[cfg(test)]
mod p3_b0_spike_bench;
// P3 Alt-A1 production fast rung and ladder, unit AL-U1
// (docs/plans/p3-alt-a1-fill-ladder-contract.md); wired into the fill export by AL-U3.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_ladder;
#[cfg(test)]
mod fill_ladder_tests;
// P3 Alt-A1 unit AL-U2: the oracles' hand-off and the branch-only rung record, test-only;
// appended for the same reason as above.
#[cfg(test)]
mod fill_ladder_dump_tests;
#[cfg(test)]
mod fill_ladder_identity;
// P3 Alt-A1 unit AL-U3: the ladder through the fill export, test-only; appended for the same
// reason as above.
#[cfg(test)]
mod fill_export_ladder_tests;
// P3 Alt-A1 unit AL-U4a: the certificate's sub-stage diagnostic split, test-only; appended for
// the same reason as above.
#[cfg(test)]
mod fill_ladder_diag_tests;
// P3 Alt-A1 unit AL-U5: the AL-S1 harness and its ratio mode, test-only; appended for the same
// reason as above.
#[cfg(test)]
mod p3_fill_ladder_bench;
// P3 B2 unit ST-U3 (docs/plans/p3-b2-stroke-contract.md): the line-stroke front end, private;
// no export until ST-U5. Appended for the same reason as above.
#[cfg(test)]
mod stroke_dump_tests;
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod stroke_outline;
#[cfg(test)]
mod stroke_outline_tests;
// P3 B2 unit ST-U4: cubic stroke classification and leaves, private; appended for the same
// reason as above.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod stroke_cubic;
#[cfg(test)]
mod stroke_cubic_tests;
// P3 B2 unit ST-U3b: the B2-Q8 native scaling probe, test-only; appended for the same reason as
// above.
#[cfg(test)]
mod stroke_probe_tests;
// P3 B2 unit ST-U5 (docs/plans/p3-b2-stroke-contract.md, section 7): the stroke-mesh transport
// v0. A third module-level engine; it shares no state with GLOBAL_ENGINE or GLOBAL_FILL_ENGINE.
// Appended for the same reason as above.
mod stroke_export;
#[cfg(test)]
mod stroke_export_tests;
// P3 rendering-track item E1, unit ST-U10 (docs/plans/p3-b2-stroke-contract.md, the ST-U9
// addendum): the E1-K1 early-abort fixtures and differential sweep, test-only; appended for the
// same reason as above.
#[cfg(test)]
mod stroke_early_abort_tests;

#[cfg(target_arch = "wasm32")]
struct GlobalStrokeEngine(UnsafeCell<stroke_export::StrokeEngine>);

// Same single-threaded, non-reentrant rule as GlobalEngine.
#[cfg(target_arch = "wasm32")]
unsafe impl Sync for GlobalStrokeEngine {}

#[cfg(target_arch = "wasm32")]
static GLOBAL_STROKE_ENGINE: GlobalStrokeEngine =
    GlobalStrokeEngine(UnsafeCell::new(stroke_export::StrokeEngine::new()));

#[cfg(target_arch = "wasm32")]
fn with_stroke_engine<T>(f: impl FnOnce(&mut stroke_export::StrokeEngine) -> T) -> T {
    // SAFETY: the stroke ABI permits one single-threaded, non-reentrant caller.
    // No reference to the StrokeEngine escapes this function.
    unsafe { f(&mut *GLOBAL_STROKE_ENGINE.0.get()) }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_version() -> u32 {
    stroke_export::STROKE_V0_VERSION
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_revision() -> u32 {
    stroke_export::STROKE_V0_REVISION
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_reserve(input_bytes: u32, output_bytes: u32) -> u32 {
    with_stroke_engine(|engine| engine.reserve(input_bytes, output_bytes))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_input_ptr() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::input_ptr)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_input_capacity() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::input_capacity)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_output_ptr() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::output_ptr)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_output_capacity() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::output_capacity)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_memory_epoch() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::memory_epoch)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_process(input_length: u32) -> u32 {
    with_stroke_engine(|engine| engine.process(input_length))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_result_len() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::result_len)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_required_output_bytes() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::required_output_bytes)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn stroke_v0_dispose() -> u32 {
    with_stroke_engine(stroke_export::StrokeEngine::dispose)
}

// P3 Alt-A1 AL-OB5 unit OB5-U1 (docs/plans/p3-al-ob5-workload-scenario-proposal.md), test-only.
// Declared at the end of the file so that no existing line moves.
#[cfg(test)]
mod p3_al_ob5_tests;

// P3 Alt-A1 AL-OB5 unit OB5-U2, the production-cap native harness, test-only. Declared at the
// end of the file so that no existing line moves.
#[cfg(test)]
mod p3_al_ob5_bench;

// D9 E8 unit E8-U1, the exact-rung direction hint's literal tests and emitters, test-only.
// Declared at the end of the file so that no existing line moves.
#[cfg(test)]
mod e8_direction_hint_tests;

// D9 E14, the fill cap diagnostic, test-only. Declared at the end of the file so that no
// existing line moves.
#[cfg(test)]
mod e14_fill_limit_diag_tests;
