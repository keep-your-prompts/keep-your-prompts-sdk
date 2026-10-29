//! The ten-line integration.
//!
//!   KYP_APP=support-bot KYP_DELIVERY_KEY=kypd_... cargo run --example hello
//!   KYP_APP=demo KYP_SNAPSHOT_DIR=../conformance/fixtures/v12 cargo run --example hello
fn main() -> Result<(), kyp::Error> {
    let prompts = kyp::Builder::from_env()
        .on_update(|u| eprintln!("prompts updated: revision {} -> {} {:?}", u.old_revision, u.new_revision, u.changed))
        .build()?;
    for name in prompts.names() {
        let p = prompts.prompt(&name).expect("listed");
        println!("{name} v{} variables {:?}", p.version, p.variables);
    }
    let st = prompts.status();
    println!("revision {} from {} (stale for {:?})", st.revision, st.source, st.stale_for);
    Ok(())
}
