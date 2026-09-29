#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod codec;
mod engine;
// P3 predicates are prepared independently; P2 v1 has no fill caller or new export.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
mod fill_predicates;
mod geometry;

#[cfg(test)]
mod fill_predicates_tests;

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
