//! `AsyncClient`: the same engine on tokio + reqwest (feature `tokio`).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::client::Builder;
use crate::engine::{read_api, Engine, LogLevel};
use crate::error::{Error, Result};
use crate::fetch::ReqwestTransport;
use crate::telemetry::RefreshTrigger;

/// The tokio client. Reads are the same lock-free, memory-only calls as on
/// [`Client`](crate::Client); refreshing runs as a tokio task that is aborted on drop.
///
/// ```no_run
/// # async fn demo() -> kyp::Result<()> {
/// let prompts = kyp::Client::builder().app("support-bot").delivery_key("kypd_...").build_async().await?;
/// let text = prompts.render("triage", &[("company", "Acme")])?;
/// # Ok(()) }
/// ```
pub struct AsyncClient {
    pub(crate) engine: Arc<Engine<ReqwestTransport>>,
    refresh: Arc<tokio::sync::Mutex<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl std::fmt::Debug for AsyncClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AsyncClient").field("what", &self.engine.what()).field("revision", &self.revision()).finish()
    }
}

impl Builder {
    /// Like [`Builder::build`], for tokio: must be called inside a runtime.
    pub async fn build_async(self) -> Result<AsyncClient> {
        let engine = Arc::new(Engine::new(self.cfg, ReqwestTransport::new, false)?);
        engine.load_local().await;
        engine.deliver_records();
        let loaded_locally = engine.current().is_some();
        let refresh = Arc::new(tokio::sync::Mutex::new(()));
        if !loaded_locally {
            if engine.polled.is_empty() {
                if !engine.cfg.start_empty {
                    return Err(engine.unavailable("no snapshot or disk cache found and no remote mirror configured"));
                }
            } else {
                let deadline = Instant::now() + engine.cfg.startup_timeout;
                let mut delay = Duration::from_millis(100);
                while engine.current().is_none() {
                    {
                        let _g = refresh.lock().await;
                        engine.round(true, Some(deadline), RefreshTrigger::Start).await;
                    }
                    if engine.current().is_some() || Instant::now() + delay >= deadline {
                        break;
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(1));
                }
                engine.clear_pending();
                engine.deliver_records();
                if engine.current().is_none() {
                    let err = engine.last_error();
                    if !engine.cfg.start_empty {
                        return Err(Error::Unavailable(format!(
                            "could not load {} within {} ms: {err}",
                            engine.what(),
                            engine.cfg.startup_timeout.as_millis()
                        )));
                    }
                    engine.log(LogLevel::Warn, &format!("starting empty, will keep trying: {err}"));
                }
            }
        }
        let task = if engine.polled.is_empty() {
            None
        } else {
            let immediate = loaded_locally || engine.current().is_none();
            let (e, r) = (engine.clone(), refresh.clone());
            Some(tokio::spawn(async move {
                let mut first = immediate;
                while !e.stop.load(Ordering::Relaxed) {
                    if !first {
                        tokio::time::sleep(e.cfg.poll_interval.mul_f64(crate::engine::jitter(0.9, 1.1))).await;
                    }
                    first = false;
                    {
                        let _g = r.lock().await;
                        e.round(false, None, RefreshTrigger::Poll).await;
                    }
                    e.deliver_updates();
                }
            }))
        };
        Ok(AsyncClient { engine, refresh, task })
    }
}

impl AsyncClient {
    read_api!();

    /// Revalidates now across mirrors (ignoring backoff). Returns `true` if a mirror answered.
    pub async fn refresh(&self) -> bool {
        if self.engine.polled.is_empty() || self.engine.stop.load(Ordering::Relaxed) {
            return false;
        }
        let ok = {
            let _g = self.refresh.lock().await;
            self.engine.round(true, None, RefreshTrigger::Manual).await
        };
        self.engine.deliver_updates();
        ok
    }

    /// Stops the refresher task. Reads keep working. Called on drop.
    pub fn close(&mut self) {
        self.engine.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

impl Drop for AsyncClient {
    fn drop(&mut self) {
        self.close();
    }
}
