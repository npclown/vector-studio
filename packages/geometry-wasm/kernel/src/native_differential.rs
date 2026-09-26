//! Test-only transport of the existing packed ABI to the independent TS oracle.
//! No numerical logic, pointer casts or public production API lives here.
use super::{
    words_as_bytes, words_as_bytes_mut, Engine, BATCH_OK, BATCH_OUTPUT_CAPACITY, INPUT_CAP_BYTES,
};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};

#[test]
#[ignore = "requires framed files; explicitly executed by pnpm test:geometry"]
fn run_framed_inputs() {
    let input_path = std::env::var_os("P2_NATIVE_INPUT").expect("P2_NATIVE_INPUT is required");
    let output_path = std::env::var_os("P2_NATIVE_OUTPUT").expect("P2_NATIVE_OUTPUT is required");
    let input = File::open(input_path).expect("open native differential input");
    assert!(input.metadata().unwrap().len() <= 512 * 1024 * 1024);
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
    loop {
        let mut length_bytes = [0_u8; 4];
        // EOF is valid only between frames; a partial prefix or payload fails.
        if reader.read(&mut length_bytes[..1]).unwrap() == 0 {
            break;
        }
        reader.read_exact(&mut length_bytes[1..]).unwrap();
        let length = u32::from_le_bytes(length_bytes);
        assert!(length <= INPUT_CAP_BYTES);
        count += 1;
        assert!(count <= 20_000, "unexpected native fixture count");
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
            assert_eq!(engine.reserve(length, required), BATCH_OK);
            words_as_bytes_mut(&mut engine.input)[..bytes.len()].copy_from_slice(&bytes);
            status = engine.process(length);
        }
        assert_ne!(status, BATCH_OUTPUT_CAPACITY, "retry must resolve capacity");
        let result_length = engine.result_len();
        if status != BATCH_OK {
            assert_eq!(result_length, 0, "failed batch published partial output");
        }
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
