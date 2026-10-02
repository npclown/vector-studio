//! Test-only transport of the existing packed ABI to the independent TS oracle.
//! No numerical logic, pointer casts or public production API lives here.
use super::{
    words_as_bytes, words_as_bytes_mut, Engine, BATCH_OK, BATCH_OUTPUT_CAPACITY, INPUT_CAP_BYTES,
    OUTPUT_CAP_BYTES,
};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};

#[derive(Clone, Copy, Debug)]
struct TransportLimits {
    frames: u32,
    input_frame: u32,
    input_total: u64,
    output_frame: u32,
    output_total: u64,
}

impl TransportLimits {
    fn from_mode(mode: Option<&str>) -> Self {
        match mode {
            None => Self {
                frames: 20_000,
                input_frame: INPUT_CAP_BYTES,
                input_total: 512 * 1024 * 1024,
                output_frame: OUTPUT_CAP_BYTES,
                output_total: u64::MAX,
            },
            Some("bounded-v1") => Self {
                frames: 1_000,
                input_frame: 4_096,
                input_total: 4 * 1024 * 1024,
                output_frame: 256 * 1024,
                output_total: 128 * 1024 * 1024,
            },
            Some(_) => panic!("unknown P3_CENSUS_MODE"),
        }
    }

    fn input(self, count: u32, length: u32, previous: u64) -> u64 {
        assert!(count <= self.frames, "unexpected native fixture count");
        assert!(length <= self.input_frame, "native input frame limit");
        let total = previous.checked_add(u64::from(length) + 4).unwrap();
        assert!(total <= self.input_total, "native total input limit");
        total
    }

    fn output(self, length: u32, previous: u64) -> u64 {
        assert!(length <= self.output_frame, "native output frame limit");
        let total = previous.checked_add(u64::from(length) + 8).unwrap();
        assert!(total <= self.output_total, "native total output limit");
        total
    }
}

#[test]
#[ignore = "requires framed files; explicitly executed by pnpm test:geometry"]
fn run_framed_inputs() {
    let mode = std::env::var_os("P3_CENSUS_MODE");
    let limits = TransportLimits::from_mode(
        mode.as_deref()
            .map(|value| value.to_str().expect("P3_CENSUS_MODE must be UTF-8")),
    );
    let input_path = std::env::var_os("P2_NATIVE_INPUT").expect("P2_NATIVE_INPUT is required");
    let output_path = std::env::var_os("P2_NATIVE_OUTPUT").expect("P2_NATIVE_OUTPUT is required");
    let input = File::open(input_path).expect("open native differential input");
    assert!(input.metadata().unwrap().len() <= limits.input_total);
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output_path)
        .expect("native differential output must be new");
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    let mut engine = Engine::new();
    let mut count = 0;
    let mut retries = 0;
    let mut input_bytes = 0;
    let mut output_bytes = 0;
    loop {
        let mut length_bytes = [0_u8; 4];
        // EOF is valid only between frames; a partial prefix or payload fails.
        if reader.read(&mut length_bytes[..1]).unwrap() == 0 {
            break;
        }
        reader.read_exact(&mut length_bytes[1..]).unwrap();
        let length = u32::from_le_bytes(length_bytes);
        count += 1;
        input_bytes = limits.input(count, length, input_bytes);
        let mut bytes = vec![0_u8; length as usize];
        reader.read_exact(&mut bytes).unwrap();
        assert_eq!(engine.reserve(length, 256 * 1024), BATCH_OK);
        words_as_bytes_mut(&mut engine.input)[..bytes.len()].copy_from_slice(&bytes);
        let mut status = engine.process(length);
        if status == BATCH_OUTPUT_CAPACITY {
            retries += 1;
            assert_eq!(engine.result_len(), 0);
            let required = engine.required_output_bytes();
            assert!(required > engine.output_capacity());
            assert!(required <= limits.output_frame, "native retry output limit");
            assert_eq!(engine.reserve(length, required), BATCH_OK);
            words_as_bytes_mut(&mut engine.input)[..bytes.len()].copy_from_slice(&bytes);
            status = engine.process(length);
        }
        assert_ne!(status, BATCH_OUTPUT_CAPACITY, "retry must resolve capacity");
        let result_length = engine.result_len();
        if status != BATCH_OK {
            assert_eq!(result_length, 0, "failed batch published partial output");
        }
        output_bytes = limits.output(result_length, output_bytes);
        writer.write_all(&status.to_le_bytes()).unwrap();
        writer.write_all(&result_length.to_le_bytes()).unwrap();
        writer
            .write_all(&words_as_bytes(&engine.output)[..result_length as usize])
            .unwrap();
    }
    assert!(count > 0, "native differential corpus cannot be empty");
    assert_eq!(engine.dispose(), BATCH_OK);
    writer.flush().unwrap();
    println!("P2 native differential frames: {count}");
    println!("P2 native differential capacity retries: {retries}");
}

#[test]
fn census_transport_limits_reject_before_allocation_or_write() {
    let limits = TransportLimits::from_mode(Some("bounded-v1"));
    assert_eq!(limits.input(1_000, 4_096, 0), 4_100);
    assert_eq!(
        limits.input(1, 0, limits.input_total - 4),
        limits.input_total
    );
    assert_eq!(limits.output(262_144, 0), 262_152);
    assert_eq!(
        limits.output(0, limits.output_total - 8),
        limits.output_total
    );
    for (count, length, previous) in [(1_001, 0, 0), (1, 4_097, 0), (1, 0, limits.input_total - 3)]
    {
        assert!(std::panic::catch_unwind(|| limits.input(count, length, previous)).is_err());
    }
    for (length, previous) in [(262_145, 0), (0, limits.output_total - 7), (0, u64::MAX)] {
        assert!(std::panic::catch_unwind(|| limits.output(length, previous)).is_err());
    }
    assert!(std::panic::catch_unwind(|| TransportLimits::from_mode(Some(""))).is_err());
    assert!(std::panic::catch_unwind(|| TransportLimits::from_mode(Some("full"))).is_err());
}

#[test]
fn ordinary_differential_transport_retains_existing_limits() {
    let limits = TransportLimits::from_mode(None);
    assert_eq!(limits.frames, 20_000);
    assert_eq!(limits.input_total, 512 * 1024 * 1024);
    assert_eq!(
        limits.input(20_000, INPUT_CAP_BYTES, 0),
        u64::from(INPUT_CAP_BYTES) + 4
    );
    assert_eq!(
        limits.output(OUTPUT_CAP_BYTES, 0),
        u64::from(OUTPUT_CAP_BYTES) + 8
    );
    assert_eq!(limits.output_total, u64::MAX);
}
