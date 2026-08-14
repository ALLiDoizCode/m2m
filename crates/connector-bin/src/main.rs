//! Thin binary: load configuration, construct the runtime, merge routers,
//! serve -- and nothing else. See ADR 0001.
//!
//! Issue #784 gave the CLI a second verb (`connector announce`), and this
//! file is deliberately almost unchanged by it: `connector_cli::run` still
//! makes every decision and hands back a [`connector_cli::Command`] saying
//! which of the two things a process can do at the end of startup applies
//! -- hold a socket open, or print and exit. The binary parses nothing and
//! branches on no argument.
//!
//! Issue #709 gave `Serve` a graceful shutdown trigger (`SIGTERM`/`SIGINT`):
//! the server stops accepting new connections and `serve()` returns once
//! in-flight requests finish, letting `main` fall off the end and release
//! the node's router state -- which is what makes "clean shutdown flushes the claim journal's
//! unsynced watermark advances to zero" actually true in production rather
//! than only in a test that drops a gate directly. A bare `SIGTERM` with no
//! handler installed tears the process down without running any `Drop`
//! impl at all, so this is load-bearing, not cosmetic.

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .init();
}

#[tokio::main]
async fn main() {
    init_tracing();

    let args: Vec<String> = std::env::args().collect();
    let node = match connector_cli::run(&args).await {
        Ok(connector_cli::Command::Serve(node)) => node,
        Ok(connector_cli::Command::Finished { summary }) => {
            println!("{summary}");
            return;
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };

    let bound = axum::Server::bind(&node.client_edge_addr);
    tracing::info!(addr = %bound.local_addr(), "connector listening");
    let server = bound
        .serve(node.router.into_make_service())
        .with_graceful_shutdown(shutdown_signal());
    if let Err(err) = server.await {
        eprintln!("{err}");
        std::process::exit(1);
    }
    // Awaiting `server` consumed it, and with it the make-service holding
    // this node's router state. Whichever holder of that state is the last
    // -- the make-service here, or a detached session task the runtime
    // drops on its own way out below -- releases this node's
    // `ClientClaimGate`, running its `Drop` and flushing the claim
    // journal's unsynced watermark advances to zero before the process
    // actually exits (issue #709).
    tracing::info!("connector shut down cleanly");
}

/// Resolves once this process receives `SIGINT` (`ctrl_c` -- an operator's
/// own Ctrl-C on an attached container) or, on Unix, `SIGTERM` (what
/// `docker stop` and `docker compose restart`/`stop` send by default,
/// before the grace period runs out and `SIGKILL` follows) -- whichever
/// arrives first. Everything else about shutdown (draining
/// in-flight requests, then dropping the node) is `axum`'s
/// `with_graceful_shutdown` and ordinary `Drop`, not this function's job.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("installing a ctrl_c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("installing a SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    tracing::info!("shutdown signal received -- draining in-flight requests");
}
