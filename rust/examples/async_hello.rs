//! The tokio client.
//!
//!   KYP_APP=demo KYP_SNAPSHOT_DIR=../conformance/fixtures/v12 cargo run --features tokio --example async_hello
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), kyp::Error> {
    let prompts = kyp::Builder::from_env().build_async().await?;
    if let Some(text) = prompts.get("greeting") {
        println!("greeting: {text}");
    }
    prompts.refresh().await;
    println!("{:?}", prompts.status());
    Ok(())
}
