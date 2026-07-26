//! Thin binary: load configuration, construct the runtime, merge routers,
//! serve -- and nothing else. See ADR 0001.

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
    let (app, addr) = match connector_cli::run(&args) {
        Ok(built) => built,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };

    let server = axum::Server::bind(&addr).serve(app.into_make_service());
    tracing::info!(addr = %server.local_addr(), "connector listening");
    if let Err(err) = server.await {
        eprintln!("{err}");
        std::process::exit(1);
    }
}
