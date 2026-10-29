//! ns per get()/render(), single- and multi-threaded.
//!
//!   cargo run --release --example bench
use std::time::Instant;

fn main() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/fixtures/v12");
    let c = kyp::Client::builder().app("demo").snapshot_dir(dir).log_level(None).build().expect("snapshot");
    let n = 2_000_000u32;
    let t = Instant::now();
    for _ in 0..n {
        std::hint::black_box(c.get(std::hint::black_box("greeting")));
    }
    println!("get:    {:6.1} ns/op (1 thread)", t.elapsed().as_nanos() as f64 / f64::from(n));
    let t = Instant::now();
    for _ in 0..n / 4 {
        std::hint::black_box(c.render("greeting", &[("name", "Ana"), ("company", "Acme")]).unwrap());
    }
    println!("render: {:6.1} ns/op (1 thread)", t.elapsed().as_nanos() as f64 / f64::from(n / 4));
    let t = Instant::now();
    for _ in 0..n {
        std::hint::black_box(c.get_with(std::hint::black_box("greeting"), str::len));
    }
    println!("get_with: {:6.1} ns/op (1 thread)", t.elapsed().as_nanos() as f64 / f64::from(n));
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get() as u32);
    for threads in [2u32, cores] {
        let run = |label: &str, f: &(dyn Fn() + Sync)| {
            let t = Instant::now();
            std::thread::scope(|s| {
                for _ in 0..threads {
                    s.spawn(|| {
                        for _ in 0..n / 4 {
                            f();
                        }
                    });
                }
            });
            let per = t.elapsed().as_nanos() as f64 / f64::from(n / 4);
            println!("{label}: {per:6.1} ns/op per thread ({threads} threads in parallel)");
        };
        run("get     ", &|| {
            std::hint::black_box(c.get(std::hint::black_box("greeting")));
        });
        run("get_with", &|| {
            std::hint::black_box(c.get_with(std::hint::black_box("greeting"), str::len));
        });
        run("render  ", &|| {
            std::hint::black_box(c.render("greeting", &[("name", "Ana"), ("company", "Acme")]).unwrap());
        });
    }
}
