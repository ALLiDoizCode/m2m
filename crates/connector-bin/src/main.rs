//! Thin binary: load configuration, construct the runtime, merge routers,
//! serve -- and nothing else. See ADR 0001.
//!
//! Issue #784 gave the CLI a second verb (`connector announce`), and this
//! file is deliberately almost unchanged by it: `connector_cli::run` still
//! makes every decision and hands back a [`connector_cli::Command`] saying
//! which of the two things a process can do at the end of startup applies
//! -- hold a socket open, or print and exit. The binary parses nothing and
//! branches on no argument.

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

    let server = axum::Server::bind(&node.client_edge_addr).serve(node.router.into_make_service());
    tracing::info!(addr = %server.local_addr(), "connector listening");
    if let Err(err) = server.await {
        eprintln!("{err}");
        std::process::exit(1);
    }
}
