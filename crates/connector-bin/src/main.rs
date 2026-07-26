//! Thin binary: load configuration, construct the runtime, merge routers, serve. See ADR 0001.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match connector_cli::load_config(&args) {
        Ok(_config) => {
            // Nothing else exists to start yet: the runtime, routers and
            // server land in later tickets (ADR 0001). Loading and fully
            // validating configuration before any other startup work is
            // this ticket's entire scope (ADR 0009).
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}
