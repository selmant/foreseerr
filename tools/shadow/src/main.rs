//! shadow: record real Foreseerr traffic, replay it against several backends,
//! and compare what they did. Built to check a reimplementation of the
//! backend against the current one. See README.md.

pub mod ca;
pub mod compare;
pub mod db;
pub mod httpx;
pub mod jsondiff;
pub mod model;
pub mod record;
pub mod replay;
pub mod snapshot;
pub mod upstream;
pub mod urlnorm;

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(name = "shadow", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Create (or show) the CA the backend must trust for HTTPS recording.
    Ca {
        /// Directory for ca.pem and ca.key.
        #[arg(long, default_value = "shadow-ca")]
        dir: PathBuf,
    },
    /// Proxy a running backend and record its inbound and outgoing traffic.
    Record(record::RecordArgs),
    /// Replay a recording against one or more backends in lockstep.
    Replay(replay::ReplayArgs),
    /// Compare the targets of a replay run and write report.md / report.json.
    Compare(compare::CompareArgs),
}

#[tokio::main]
async fn main() -> Result<ExitCode> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("shadow=info")),
        )
        .with_target(false)
        .init();
    if rustls::crypto::ring::default_provider()
        .install_default()
        .is_err()
    {
        tracing::debug!("a rustls crypto provider was already installed");
    }

    match Cli::parse().command {
        Command::Ca { dir } => {
            let ca = ca::CertAuthority::load_or_create(&dir)?;
            let path = std::fs::canonicalize(ca.pem_path())?;
            writeln!(std::io::stdout().lock(), "{}", path.display())?;
        }
        Command::Record(args) => record::run(args).await?,
        Command::Replay(args) => replay::run(args).await?,
        Command::Compare(args) => {
            if !compare::run(&args)? {
                return Ok(ExitCode::FAILURE);
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}
