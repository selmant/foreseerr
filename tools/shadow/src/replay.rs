//! `shadow replay`: feed a recording to several backends in lockstep.
//!
//! Every target starts from its own copy of the recording's snapshot and gets
//! its own forward proxy, which answers outgoing calls from the recording and
//! logs them. Events go to all targets at the same time, one event at a time,
//! so the order is deterministic and time-dependent output lines up.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use clap::Args;
use serde::{Deserialize, Serialize};

use crate::ca::CertAuthority;
use crate::compare::CompareConfig;
use crate::db::{DbFilter, DbSpec};
use crate::httpx::{lock, millis};
use crate::model::{
    decode_body, header, headers_from, now_rfc3339, read_json, read_jsonl, write_json, Body,
    HttpEvent, JobEvent, JsonlWriter, RecordingMeta, ReplayResult, RunMeta, RunTarget,
    TrafficEvent, UpstreamCall,
};
use crate::upstream::{bind, error_chain, ForwardProxy, Mode, ReplayStore, ReplayTarget};

/// Options for `shadow replay`.
#[derive(Args, Debug)]
pub struct ReplayArgs {
    /// Replay config (TOML). See tools/shadow/README.md.
    #[arg(long, short)]
    pub config: PathBuf,
    /// Recording directory (overrides `recording` in the config).
    #[arg(long)]
    pub recording: Option<PathBuf>,
    /// Output directory (overrides `out` in the config).
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Stop after this many events.
    #[arg(long)]
    pub limit: Option<usize>,
    /// Keep targets running after the replay (Ctrl-C to stop) for poking around.
    #[arg(long)]
    pub keep_running: bool,
}

/// What a target is compared as.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// The reference implementation (today: the Node backend).
    Baseline,
    /// A second copy of the baseline. Whatever differs between the two is
    /// noise (timestamps, random ids) and is ignored when judging candidates.
    Noise,
    /// The implementation under test.
    Candidate,
}

/// The replay config file. `shadow compare` reads the same file.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayConfig {
    /// Recording to replay.
    pub recording: Option<PathBuf>,
    /// Where results go.
    pub out: Option<PathBuf>,
    /// Directory with the CA the targets must trust.
    #[serde(default = "default_ca_dir")]
    pub ca_dir: PathBuf,
    /// After each write, wait until the target has made no outgoing call for
    /// this long (catches work done after the response was sent).
    #[serde(default = "default_settle_ms")]
    pub settle_ms: u64,
    /// Upper bound for that wait.
    #[serde(default = "default_settle_max_ms")]
    pub settle_max_ms: u64,
    /// Per-request timeout.
    #[serde(default = "default_request_timeout")]
    pub request_timeout_secs: u64,
    /// How long a replayed job may run.
    #[serde(default = "default_job_timeout")]
    pub job_timeout_secs: u64,
    /// Take per-table DB digests after every write, to find the first event
    /// where databases diverge.
    #[serde(default = "default_true")]
    pub db_checkpoints: bool,
    /// After targets are up, wait until each has made no outgoing call and
    /// not written its `SQLite` file for this long, so startup work (dataset
    /// downloads, migrations) doesn't bleed into the first events.
    #[serde(default = "default_startup_quiet_ms")]
    pub startup_quiet_ms: u64,
    /// Upper bound for that wait.
    #[serde(default = "default_startup_max_secs")]
    pub startup_max_secs: u64,
    /// Replay streaming responses too (they usually hang until the timeout).
    #[serde(default)]
    pub include_streaming: bool,
    /// Requests whose path starts with one of these are not replayed.
    #[serde(default)]
    pub skip_prefixes: Vec<String>,
    /// Query parameters ignored when matching outgoing calls (cache busters).
    #[serde(default)]
    pub ignore_query_params: Vec<String>,
    /// Request headers that carry a copy of a cookie value (CSRF tokens).
    #[serde(default = "default_token_headers")]
    pub token_headers: Vec<String>,
    /// Tables and columns left out of checkpoints and dumps.
    #[serde(default = "default_db_filter")]
    pub db: DbFilter,
    /// Largest body stored in full.
    #[serde(default = "default_max_body")]
    pub max_body: usize,
    /// The backends to replay against.
    #[serde(rename = "target")]
    pub targets: Vec<TargetConfig>,
    /// Settings for `shadow compare`; checked here so typos fail early.
    #[serde(default)]
    pub compare: Option<CompareConfig>,
}

/// One `[[target]]`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetConfig {
    /// Name used for its results directory.
    pub name: String,
    /// What it is compared as.
    pub role: Role,
    /// Base URL of the backend, e.g. `http://127.0.0.1:6101`.
    pub url: String,
    /// Port of this target's forward proxy. The runner points the target's
    /// settings.json proxy at it.
    pub proxy_port: u16,
    /// How to start the backend. Without it the target must already be
    /// running and configured by hand.
    #[serde(default)]
    pub command: Option<Vec<String>>,
    /// Working directory for `command`.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// Extra environment for `command`.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Environment variable that receives the target's config directory.
    #[serde(default = "default_config_env")]
    pub config_env: String,
    /// Rewrite settings.json: route outgoing calls through the proxy and push
    /// cron schedules out so jobs only run when the recording says so.
    #[serde(default = "default_true")]
    pub patch_settings: bool,
    /// Commands run before starting (e.g. restoring a Postgres dump).
    #[serde(default)]
    pub prepare: Vec<Vec<String>>,
    /// Path polled until the backend answers.
    #[serde(default = "default_ready_path")]
    pub ready_path: String,
    /// How long to wait for that.
    #[serde(default = "default_ready_timeout")]
    pub ready_timeout_secs: u64,
    /// Database to digest and dump. Defaults to the `SQLite` file in the
    /// target's config copy.
    #[serde(default)]
    pub db: Option<DbSpec>,
    /// API key used to trigger jobs. Defaults to settings.json `main.apiKey`.
    #[serde(default)]
    pub api_key: Option<String>,
}

fn default_ca_dir() -> PathBuf {
    PathBuf::from("shadow-ca")
}
const fn default_settle_ms() -> u64 {
    300
}
const fn default_settle_max_ms() -> u64 {
    5_000
}
const fn default_request_timeout() -> u64 {
    60
}
const fn default_job_timeout() -> u64 {
    900
}
const fn default_true() -> bool {
    true
}
fn default_token_headers() -> Vec<String> {
    ["xsrf-token", "x-xsrf-token", "csrf-token", "x-csrf-token"]
        .map(String::from)
        .to_vec()
}
/// Tables left out unless the config says otherwise.
#[must_use]
pub fn default_db_filter() -> DbFilter {
    DbFilter {
        ignore_tables: vec![String::from("session")],
        ignore_columns: Vec::new(),
    }
}
const fn default_max_body() -> usize {
    8 * 1024 * 1024
}
fn default_config_env() -> String {
    String::from("CONFIG_DIRECTORY")
}
fn default_ready_path() -> String {
    String::from("/api/v1/status")
}
const fn default_startup_quiet_ms() -> u64 {
    3_000
}
const fn default_startup_max_secs() -> u64 {
    600
}
const fn default_ready_timeout() -> u64 {
    180
}

/// Cron expression that fires once a year, so scheduled jobs stay out of the way.
const PARKED_SCHEDULE: &str = "0 0 0 1 1 *";

/// Read and parse a replay config.
///
/// # Errors
///
/// Fails when the file can't be read or isn't a valid config.
pub fn read_config(path: &Path) -> Result<ReplayConfig> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

/// Maps recorded cookie values to the ones a target issued.
#[derive(Debug, Default)]
pub struct CookieMap(HashMap<String, String>);

impl CookieMap {
    /// When the recording and the target both set a cookie, remember that the
    /// recorded value now means the target's value.
    pub fn learn(&mut self, recorded: &[(String, String)], target: &[(String, String)]) {
        let tgt = set_cookies(target);
        for (name, rec_value) in set_cookies(recorded) {
            if let Some(tgt_value) = tgt.get(&name) {
                if !rec_value.is_empty() && &rec_value != tgt_value {
                    self.0.insert(rec_value, tgt_value.clone());
                }
            }
        }
    }

    /// Replace recorded cookie values in a `Cookie` header.
    #[must_use]
    pub fn rewrite_header(&self, header: &str) -> String {
        header
            .split(';')
            .map(|pair| {
                let pair = pair.trim();
                pair.split_once('=')
                    .and_then(|(name, value)| {
                        self.0.get(value).map(|mapped| format!("{name}={mapped}"))
                    })
                    .unwrap_or_else(|| pair.to_owned())
            })
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// The target's value for a recorded one (CSRF headers repeat cookie values).
    #[must_use]
    pub fn value(&self, recorded: &str) -> String {
        self.0
            .get(recorded)
            .cloned()
            .unwrap_or_else(|| recorded.to_owned())
    }
}

fn set_cookies(headers: &[(String, String)]) -> HashMap<String, String> {
    headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
        .filter_map(|(_, v)| {
            let first = v.split(';').next()?;
            let (name, value) = first.split_once('=')?;
            Some((name.trim().to_owned(), value.trim().to_owned()))
        })
        .collect()
}

#[derive(Debug)]
struct Target {
    cfg: TargetConfig,
    workdir: PathBuf,
    replay: Arc<ReplayTarget>,
    child: Option<tokio::process::Child>,
    db: Option<DbSpec>,
    api_key: Option<String>,
    cookies: Mutex<CookieMap>,
    results: JsonlWriter,
}

/// Everything targets share while starting.
#[derive(Debug, Clone)]
struct StartCtx {
    cfg: Arc<ReplayConfig>,
    out: PathBuf,
    snapshot: Option<PathBuf>,
    recording: PathBuf,
    ca: Arc<CertAuthority>,
    store: Arc<ReplayStore>,
    base: PathBuf,
}

/// Replay a recording against every configured target.
///
/// # Errors
///
/// Fails when the config or recording is unusable, or a target can't start.
pub async fn run(args: ReplayArgs) -> Result<()> {
    let cfg = Arc::new(read_config(&args.config)?);
    let base = args
        .config
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let resolve = |p: &Path| {
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            base.join(p)
        }
    };

    let recording = args
        .recording
        .clone()
        .or_else(|| cfg.recording.as_deref().map(resolve))
        .context("no recording: pass --recording or set `recording` in the config")?;
    let out = args
        .out
        .clone()
        .or_else(|| cfg.out.as_deref().map(resolve))
        .context("no output directory: pass --out or set `out` in the config")?;
    validate_targets(&cfg.targets)?;

    let meta: RecordingMeta = read_json(&recording.join("meta.json"))?;
    let events = load_events(&recording, &cfg, args.limit)?;
    let upstream_path = recording.join("upstream.jsonl");
    let upstream: Vec<UpstreamCall> = if upstream_path.exists() {
        read_jsonl(&upstream_path)?
    } else {
        Vec::new()
    };
    tracing::info!(
        "{} events to replay, {} recorded upstream calls",
        events.len(),
        upstream.len()
    );
    crate::snapshot::create_private_dir(&out)?;

    let ctx = StartCtx {
        ca: Arc::new(CertAuthority::load_or_create(&resolve(&cfg.ca_dir))?),
        store: Arc::new(ReplayStore::new(upstream, &cfg.ignore_query_params)),
        snapshot: meta.snapshot.as_ref().map(|s| recording.join(s)),
        cfg: Arc::clone(&cfg),
        out: out.clone(),
        recording: recording.clone(),
        base: base.clone(),
    };
    let targets = start_all(&ctx).await?;
    // Make sure processes go away if anything below fails.
    let guard = KillOnDrop(targets.clone());
    settle_all(&targets, &cfg).await?;
    write_json(
        &out.join("run.json"),
        &RunMeta {
            recording: recording.display().to_string(),
            started_at: now_rfc3339(),
            events: events.len(),
            targets: targets
                .iter()
                .map(|t| RunTarget {
                    name: t.cfg.name.clone(),
                    role: t.cfg.role,
                    dir: t.cfg.name.clone(),
                })
                .collect(),
        },
    )?;
    replay_all(&targets, &events, &cfg).await?;
    for t in &targets {
        if let Some(spec) = &t.db {
            let dump = crate::db::dump(spec, &cfg.db)
                .await
                .with_context(|| format!("dumping {} DB", t.cfg.name))?;
            write_json(&t.workdir.join("db.json"), &dump)?;
        }
    }
    tracing::info!("replay finished; results in {}", out.display());

    if args.keep_running {
        tracing::info!("targets still running, Ctrl-C to stop");
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("listening for Ctrl-C: {e}");
        }
    }
    drop(guard);
    for t in targets {
        if let Ok(mut t) = Arc::try_unwrap(t) {
            stop_child(&mut t.child).await;
        }
    }
    Ok(())
}

/// Start every target at once, so wall-clock values written during startup
/// stay close together across targets.
async fn start_all(ctx: &StartCtx) -> Result<Vec<Arc<Target>>> {
    let mut starting = Vec::new();
    for tcfg in &ctx.cfg.targets {
        let (tcfg, ctx) = (tcfg.clone(), ctx.clone());
        starting.push(tokio::spawn(async move { start_target(&tcfg, &ctx).await }));
    }
    let mut targets = Vec::new();
    let mut failure = None;
    for s in starting {
        match s.await? {
            Ok(t) => targets.push(Arc::new(t)),
            Err(e) => failure = failure.or(Some(e)),
        }
    }
    if let Some(e) = failure {
        drop(KillOnDrop(targets));
        return Err(e);
    }
    Ok(targets)
}

async fn settle_all(targets: &[Arc<Target>], cfg: &ReplayConfig) -> Result<()> {
    let quiet = Duration::from_millis(cfg.startup_quiet_ms);
    let max = Duration::from_secs(cfg.startup_max_secs);
    let mut waits = Vec::new();
    for t in targets {
        let t = Arc::clone(t);
        waits.push(tokio::spawn(
            async move { settle_startup(&t, quiet, max).await },
        ));
    }
    for w in waits {
        w.await??;
    }
    Ok(())
}

async fn replay_all(
    targets: &[Arc<Target>],
    events: &[TrafficEvent],
    cfg: &Arc<ReplayConfig>,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(cfg.request_timeout_secs))
        .build()?;
    let started = Instant::now();
    for (i, event) in events.iter().enumerate() {
        let mut handles = Vec::new();
        for t in targets {
            let (t, event, client, cfg) = (
                Arc::clone(t),
                event.clone(),
                client.clone(),
                Arc::clone(cfg),
            );
            handles.push(tokio::spawn(async move {
                replay_event(&t, &event, &client, &cfg).await
            }));
        }
        for h in handles {
            h.await??;
        }
        let done = i + 1;
        if done % 25 == 0 || done == events.len() {
            tracing::info!("{done}/{} events ({:.0?})", events.len(), started.elapsed());
        }
    }
    Ok(())
}

fn validate_targets(targets: &[TargetConfig]) -> Result<()> {
    let baselines = targets.iter().filter(|t| t.role == Role::Baseline).count();
    if baselines != 1 {
        bail!("need exactly one target with role = \"baseline\" (found {baselines})");
    }
    let mut names = HashSet::new();
    let mut ports = HashSet::new();
    for t in targets {
        if !names.insert(&t.name) {
            bail!("duplicate target name {}", t.name);
        }
        if !ports.insert(t.proxy_port) {
            bail!("targets share proxy_port {}", t.proxy_port);
        }
    }
    Ok(())
}

/// Events to replay, in recorded order, minus the ones that can't be replayed.
///
/// # Errors
///
/// Fails when `traffic.jsonl` can't be read.
pub fn load_events(
    recording: &Path,
    cfg: &ReplayConfig,
    limit: Option<usize>,
) -> Result<Vec<TrafficEvent>> {
    let mut events: Vec<TrafficEvent> = read_jsonl(&recording.join("traffic.jsonl"))?;
    events.sort_by_key(|e| (e.ts_ms(), e.seq()));

    // Jobs started by hand show up twice: as the POST and as a job start.
    let manual_runs: Vec<(String, i64)> = events
        .iter()
        .filter_map(|e| match e {
            TrafficEvent::Http(h) if h.request.method == "POST" => h
                .request
                .uri
                .strip_prefix("/api/v1/settings/jobs/")
                .and_then(|r| r.strip_suffix("/run"))
                .map(|id| (id.to_owned(), h.ts_ms)),
            TrafficEvent::Http(_) | TrafficEvent::Job(_) => None,
        })
        .collect();

    let mut skipped: BTreeMap<&str, usize> = BTreeMap::new();
    let mut kept = Vec::new();
    for e in events {
        let reason = match &e {
            TrafficEvent::Http(h) => skip_reason(h, cfg),
            TrafficEvent::Job(j) => manual_runs
                .iter()
                .any(|(id, ts)| id == &j.job_id && (j.ts_ms - ts).abs() < 15_000)
                .then_some("job started by a recorded request"),
        };
        match reason {
            Some(r) => *skipped.entry(r).or_default() += 1,
            None => kept.push(e),
        }
    }
    for (reason, n) in skipped {
        tracing::info!("skipping {n} events: {reason}");
    }
    if let Some(limit) = limit {
        kept.truncate(limit);
    }
    Ok(kept)
}

fn skip_reason(h: &HttpEvent, cfg: &ReplayConfig) -> Option<&'static str> {
    if h.streaming && !cfg.include_streaming {
        return Some("streaming response");
    }
    if h.response.is_none() {
        return Some("backend was unreachable while recording");
    }
    if h.request.body.truncated {
        return Some("request body too large to replay");
    }
    if cfg
        .skip_prefixes
        .iter()
        .any(|p| h.request.uri.starts_with(p.as_str()))
    {
        return Some("matches skip_prefixes");
    }
    None
}

#[derive(Debug)]
struct Vars {
    workdir: String,
    config: String,
    snapshot: String,
    recording: String,
    proxy_port: String,
}

impl Vars {
    fn apply(&self, s: &str) -> String {
        s.replace("{workdir}", &self.workdir)
            .replace("{config}", &self.config)
            .replace("{snapshot}", &self.snapshot)
            .replace("{recording}", &self.recording)
            .replace("{proxy_port}", &self.proxy_port)
    }

    fn apply_db(&self, spec: DbSpec) -> DbSpec {
        match spec {
            DbSpec::Sqlite { path } => DbSpec::Sqlite {
                path: PathBuf::from(self.apply(&path.display().to_string())),
            },
            DbSpec::Postgres { url } => DbSpec::Postgres {
                url: self.apply(&url),
            },
        }
    }
}

async fn start_target(tcfg: &TargetConfig, ctx: &StartCtx) -> Result<Target> {
    let workdir = ctx.out.join(&tcfg.name);
    if workdir.exists() {
        std::fs::remove_dir_all(&workdir)?;
    }
    std::fs::create_dir_all(&workdir)?;
    let workdir = std::fs::canonicalize(&workdir)?;
    let config_dir = workdir.join("config");
    let vars = Vars {
        workdir: workdir.display().to_string(),
        config: config_dir.display().to_string(),
        snapshot: ctx
            .snapshot
            .as_ref()
            .map(|s| s.display().to_string())
            .unwrap_or_default(),
        recording: ctx.recording.display().to_string(),
        proxy_port: tcfg.proxy_port.to_string(),
    };

    let replay = Arc::new(ReplayTarget::new(Arc::clone(&ctx.store)));
    let proxy = Arc::new(ForwardProxy {
        ca: Arc::clone(&ctx.ca),
        mode: Mode::Replay(Arc::clone(&replay)),
        max_body: ctx.cfg.max_body,
        ignore_params: ctx.cfg.ignore_query_params.clone(),
    });
    let listener = bind(([127, 0, 0, 1], tcfg.proxy_port).into()).await?;
    tokio::spawn(async move {
        if let Err(e) = proxy.serve(listener).await {
            tracing::error!("forward proxy stopped: {e}");
        }
    });

    let managed = tcfg.command.is_some();
    let child = match &tcfg.command {
        Some(command) => Some(spawn_backend(tcfg, ctx, &vars, &workdir, command).await?),
        None => None,
    };
    let mut target = Target {
        db: tcfg.db.clone().map(|d| vars.apply_db(d)).or_else(|| {
            managed.then(|| DbSpec::Sqlite {
                path: config_dir.join("db/db.sqlite3"),
            })
        }),
        api_key: tcfg.api_key.clone(),
        cfg: tcfg.clone(),
        results: JsonlWriter::create(&workdir.join("results.jsonl"))?,
        workdir,
        replay,
        child,
        cookies: Mutex::new(CookieMap::default()),
    };
    wait_ready(&mut target).await?;
    // A backend started from a fresh config writes its API key on first boot.
    if target.api_key.is_none() && managed {
        target.api_key = crate::record::read_api_key(&config_dir.join("settings.json")).ok();
    }
    Ok(target)
}

/// Copy the snapshot, patch it, run `prepare`, then start `command`.
async fn spawn_backend(
    tcfg: &TargetConfig,
    ctx: &StartCtx,
    vars: &Vars,
    workdir: &Path,
    command: &[String],
) -> Result<tokio::process::Child> {
    let config_dir = workdir.join("config");
    let snapshot = ctx
        .snapshot
        .as_deref()
        .context("the recording has no snapshot; record with --config-dir")?;
    crate::snapshot::copy_dir(snapshot, &config_dir)?;
    if tcfg.patch_settings {
        patch_settings(&config_dir.join("settings.json"), tcfg.proxy_port)?;
    }
    for cmd in &tcfg.prepare {
        let cmd: Vec<String> = cmd.iter().map(|c| vars.apply(c)).collect();
        let (prog, rest) = cmd.split_first().context("empty prepare command")?;
        let status = tokio::process::Command::new(prog)
            .args(rest)
            .status()
            .await?;
        if !status.success() {
            bail!(
                "{}: prepare command {cmd:?} failed with {status}",
                tcfg.name
            );
        }
    }
    let cmd: Vec<String> = command.iter().map(|c| vars.apply(c)).collect();
    let (prog, rest) = cmd.split_first().context("empty command")?;
    let log = std::fs::File::create(workdir.join("target.log"))?;
    let mut c = tokio::process::Command::new(prog);
    c.args(rest)
        .env(&tcfg.config_env, &config_dir)
        .env("NODE_EXTRA_CA_CERTS", ctx.ca.pem_path())
        .env("SHADOW_CA_FILE", ctx.ca.pem_path())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true);
    for (k, v) in &tcfg.env {
        c.env(k, vars.apply(v));
    }
    if let Some(cwd) = &tcfg.cwd {
        c.current_dir(if cwd.is_absolute() {
            cwd.clone()
        } else {
            ctx.base.join(cwd)
        });
    }
    tracing::info!("{}: starting {cmd:?}", tcfg.name);
    c.spawn().with_context(|| format!("starting {}", tcfg.name))
}

/// Route the target's outgoing calls through its replay proxy and park the
/// cron schedules; job runs come from the recording instead.
///
/// # Errors
///
/// Fails when settings.json can't be read, parsed or written.
pub fn patch_settings(path: &Path, proxy_port: u16) -> Result<()> {
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let root = v
        .as_object_mut()
        .context("settings.json is not an object")?;
    let network = root
        .entry("network")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .context("settings.json network is not an object")?;
    network.insert(
        String::from("proxy"),
        serde_json::json!({
            "enabled": true,
            "hostname": "127.0.0.1",
            "port": proxy_port,
            "useSsl": false,
            "user": "",
            "password": "",
            "bypassFilter": "",
            "bypassLocalAddresses": false,
        }),
    );
    if let Some(jobs) = root
        .get_mut("jobs")
        .and_then(serde_json::Value::as_object_mut)
    {
        for job in jobs.values_mut() {
            if let Some(obj) = job.as_object_mut() {
                obj.insert(String::from("schedule"), PARKED_SCHEDULE.into());
            }
        }
    }
    std::fs::write(path, serde_json::to_string_pretty(&v)?)?;
    Ok(())
}

/// Wait for startup work to finish, then set aside the calls it made.
async fn settle_startup(t: &Target, quiet: Duration, max: Duration) -> Result<()> {
    let started = Instant::now();
    let files: Vec<PathBuf> = match &t.db {
        Some(DbSpec::Sqlite { path }) => vec![
            path.clone(),
            PathBuf::from(format!("{}-wal", path.display())),
        ],
        Some(DbSpec::Postgres { .. }) | None => Vec::new(),
    };
    loop {
        t.replay
            .wait_quiet(quiet, max.saturating_sub(started.elapsed()))
            .await;
        let db_idle = files
            .iter()
            .filter_map(|f| std::fs::metadata(f).and_then(|m| m.modified()).ok())
            .filter_map(|m| m.elapsed().ok())
            .all(|age| age >= quiet);
        if db_idle || started.elapsed() >= max {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let calls = t.replay.take_calls();
    let log = JsonlWriter::create(&t.workdir.join("startup.jsonl"))?;
    for c in &calls {
        log.write(c)?;
    }
    tracing::info!(
        "{}: startup settled after {:.1?} ({} outgoing calls, see startup.jsonl)",
        t.cfg.name,
        started.elapsed(),
        calls.len()
    );
    Ok(())
}

async fn wait_ready(t: &mut Target) -> Result<()> {
    let url = format!("{}{}", t.cfg.url.trim_end_matches('/'), t.cfg.ready_path);
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?;
    let started = Instant::now();
    let timeout = Duration::from_secs(t.cfg.ready_timeout_secs);
    loop {
        if let Some(child) = &mut t.child {
            if let Some(status) = child.try_wait()? {
                bail!(
                    "{} exited with {status} before becoming ready. Last log lines:\n{}",
                    t.cfg.name,
                    tail(&t.workdir.join("target.log"), 30)
                );
            }
        }
        if let Ok(r) = client.get(&url).send().await {
            if r.status().as_u16() < 500 {
                tracing::info!("{} is ready", t.cfg.name);
                return Ok(());
            }
        }
        if started.elapsed() > timeout {
            bail!(
                "{} not ready after {}s ({url})",
                t.cfg.name,
                t.cfg.ready_timeout_secs
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn tail(path: &Path, n: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines
        .get(lines.len().saturating_sub(n)..)
        .unwrap_or_default()
        .join("\n")
}

async fn replay_event(
    t: &Target,
    event: &TrafficEvent,
    client: &reqwest::Client,
    cfg: &ReplayConfig,
) -> Result<()> {
    t.replay.begin_event(event.seq(), event.ts_ms());
    let started = Instant::now();
    let (mut result, is_write) = match event {
        TrafficEvent::Http(h) => {
            let r = send_http(t, h, client, cfg).await;
            repark_schedule(t, h, &r, client).await;
            (
                r,
                !matches!(h.request.method.as_str(), "GET" | "HEAD" | "OPTIONS"),
            )
        }
        TrafficEvent::Job(j) => (run_job(t, j, client, cfg).await, true),
    };
    if is_write {
        t.replay
            .wait_quiet(
                Duration::from_millis(cfg.settle_ms),
                Duration::from_millis(cfg.settle_max_ms),
            )
            .await;
        if cfg.db_checkpoints {
            if let Some(spec) = &t.db {
                match crate::db::digests(spec, &cfg.db).await {
                    Ok(d) => result.db_digest = Some(d),
                    Err(e) => tracing::warn!("{}: DB checkpoint failed: {e}", t.cfg.name),
                }
            }
        }
    }
    result.outgoing = t.replay.take_calls();
    result.duration_ms = millis(started.elapsed());
    t.results.write(&result)?;
    Ok(())
}

fn build_request(
    t: &Target,
    h: &HttpEvent,
    client: &reqwest::Client,
    cfg: &ReplayConfig,
) -> Result<reqwest::RequestBuilder> {
    let url = format!("{}{}", t.cfg.url.trim_end_matches('/'), h.request.uri);
    let method = reqwest::Method::from_bytes(h.request.method.as_bytes())?;
    let mut req = client.request(method, &url);
    let cookies = lock(&t.cookies);
    for (name, value) in &h.request.headers {
        let lname = name.to_ascii_lowercase();
        if crate::httpx::is_hop_by_hop(&lname)
            || lname == "content-length"
            || lname == "accept-encoding"
        {
            continue;
        }
        let value = if lname == "cookie" {
            cookies.rewrite_header(value)
        } else if cfg
            .token_headers
            .iter()
            .any(|h| h.eq_ignore_ascii_case(&lname))
        {
            cookies.value(value)
        } else {
            value.clone()
        };
        req = req.header(name.as_str(), value);
    }
    drop(cookies);
    if let Some(body) = h.request.body.bytes().filter(|b| !b.is_empty()) {
        req = req.body(body);
    }
    Ok(req)
}

async fn send_http(
    t: &Target,
    h: &HttpEvent,
    client: &reqwest::Client,
    cfg: &ReplayConfig,
) -> ReplayResult {
    let mut result = ReplayResult {
        seq: h.seq,
        kind: String::from("http"),
        label: format!("{} {}", h.request.method, h.request.uri),
        ..ReplayResult::default()
    };
    let req = match build_request(t, h, client, cfg) {
        Ok(r) => r,
        Err(e) => {
            result.error = Some(format!("building request: {e}"));
            return result;
        }
    };
    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let headers = headers_from(resp.headers());
            match resp.bytes().await {
                Ok(bytes) => {
                    result.body = decode_body(header(&headers, "content-encoding"), &bytes)
                        .map_or_else(
                            || Body::capture(&bytes, cfg.max_body),
                            |(plain, from)| Body {
                                decoded_from: Some(from),
                                ..Body::capture(&plain, cfg.max_body)
                            },
                        );
                }
                Err(e) => result.error = Some(format!("reading body: {e}")),
            }
            if let Some(recorded) = &h.response {
                lock(&t.cookies).learn(&recorded.headers, &headers);
            }
            result.status = Some(status);
            result.headers = headers;
        }
        Err(e) => result.error = Some(error_chain(&e)),
    }
    result
}

/// A recorded schedule change would turn the target's own cron back on;
/// park it again so jobs keep running only where the recording ran them.
async fn repark_schedule(t: &Target, h: &HttpEvent, r: &ReplayResult, client: &reqwest::Client) {
    if !t.cfg.patch_settings || h.request.method != "POST" || r.status != Some(200) {
        return;
    }
    let path = h.request.uri.split('?').next().unwrap_or("");
    let Some(job) = path
        .strip_prefix("/api/v1/settings/jobs/")
        .and_then(|rest| rest.strip_suffix("/schedule"))
    else {
        return;
    };
    let Some(key) = &t.api_key else {
        return;
    };
    let res = client
        .post(format!(
            "{}/api/v1/settings/jobs/{job}/schedule",
            t.cfg.url.trim_end_matches('/')
        ))
        .header("x-api-key", key)
        .json(&serde_json::json!({ "schedule": PARKED_SCHEDULE }))
        .send()
        .await;
    if !res.is_ok_and(|r| r.status().is_success()) {
        tracing::warn!("{}: could not park the schedule of {job} again", t.cfg.name);
    }
}

async fn run_job(
    t: &Target,
    j: &JobEvent,
    client: &reqwest::Client,
    cfg: &ReplayConfig,
) -> ReplayResult {
    let mut result = ReplayResult {
        seq: j.seq,
        kind: String::from("job"),
        label: format!("job {}", j.job_id),
        ..ReplayResult::default()
    };
    let Some(key) = &t.api_key else {
        result.error = Some(String::from("no API key for this target; cannot run jobs"));
        return result;
    };
    let base = t.cfg.url.trim_end_matches('/');
    let status = match client
        .post(format!("{base}/api/v1/settings/jobs/{}/run", j.job_id))
        .header("x-api-key", key)
        .send()
        .await
    {
        Ok(r) => r.status().as_u16(),
        Err(e) => {
            result.error = Some(error_chain(&e));
            return result;
        }
    };
    result.status = Some(status);
    let mut finished = false;
    if status == 200 {
        let started = Instant::now();
        let timeout = Duration::from_secs(cfg.job_timeout_secs);
        while started.elapsed() < timeout {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if job_running(client, base, key, &j.job_id).await == Some(false) {
                finished = true;
                break;
            }
        }
        if !finished {
            result.error = Some(format!(
                "job did not finish within {}s",
                cfg.job_timeout_secs
            ));
        }
    }
    let body = serde_json::json!({ "job": j.job_id, "finished": finished }).to_string();
    result.body = Body::capture(body.as_bytes(), cfg.max_body);
    result
}

/// Whether the backend reports `job_id` as running; `None` when unknown.
async fn job_running(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    job_id: &str,
) -> Option<bool> {
    let jobs: Vec<serde_json::Value> = client
        .get(format!("{base}/api/v1/settings/jobs"))
        .header("x-api-key", key)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    jobs.into_iter()
        .find(|x| x.get("id").and_then(serde_json::Value::as_str) == Some(job_id))
        .map(|x| {
            x.get("running")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
}

#[derive(Debug)]
struct KillOnDrop(Vec<Arc<Target>>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        for t in &self.0 {
            let Some(pid) = t.child.as_ref().and_then(tokio::process::Child::id) else {
                continue;
            };
            // SIGTERM lets the backend close its database cleanly.
            if let Err(e) = std::process::Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status()
            {
                tracing::warn!("{}: sending SIGTERM to {pid}: {e}", t.cfg.name);
            }
        }
    }
}

async fn stop_child(child: &mut Option<tokio::process::Child>) {
    let Some(c) = child else {
        return;
    };
    if tokio::time::timeout(Duration::from_secs(10), c.wait())
        .await
        .is_err()
    {
        tracing::warn!("target did not exit after SIGTERM, killing it");
    }
    if let Err(e) = c.kill().await {
        tracing::debug!("killing target: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_mapping() {
        let mut map = CookieMap::default();
        map.learn(
            &[(
                String::from("set-cookie"),
                String::from("connect.sid=s%3Arec.sig; Path=/; HttpOnly"),
            )],
            &[(
                String::from("Set-Cookie"),
                String::from("connect.sid=s%3Atgt.sig; Path=/"),
            )],
        );
        assert_eq!(
            map.rewrite_header("theme=dark; connect.sid=s%3Arec.sig"),
            "theme=dark; connect.sid=s%3Atgt.sig",
            "only the mapped cookie changes"
        );
        assert_eq!(
            map.value("s%3Arec.sig"),
            "s%3Atgt.sig",
            "token headers map too"
        );
        assert_eq!(map.value("other"), "other", "unknown values pass through");
    }

    #[test]
    fn settings_are_patched() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("shadow-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let p = dir.join("settings.json");
        std::fs::write(
            &p,
            r#"{"main":{"apiKey":"k"},"network":{"proxy":{"enabled":false}},"jobs":{"radarr-scan":{"schedule":"0 */15 * * * *"}}}"#,
        )?;
        patch_settings(&p, 7001)?;
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p)?)?;
        assert_eq!(
            v.pointer("/network/proxy/port"),
            Some(&serde_json::json!(7001)),
            "proxy points at the replay proxy"
        );
        assert_eq!(
            v.pointer("/network/proxy/bypassLocalAddresses"),
            Some(&serde_json::json!(false)),
            "LAN services go through the proxy too"
        );
        assert_eq!(
            v.pointer("/jobs/radarr-scan/schedule"),
            Some(&serde_json::json!(PARKED_SCHEDULE)),
            "cron parked"
        );
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn example_config_parses() -> Result<()> {
        let cfg: ReplayConfig = toml::from_str(
            r#"
            recording = "rec"
            [compare]
            ignore_paths = ["updatedAt"]
            [[target]]
            name = "node"
            role = "baseline"
            url = "http://127.0.0.1:6101"
            proxy_port = 6201
            "#,
        )?;
        validate_targets(&cfg.targets)?;
        assert_eq!(
            cfg.compare.map(|c| c.ignore_paths),
            Some(vec![String::from("updatedAt")]),
            "compare section is typed"
        );
        assert!(
            toml::from_str::<ReplayConfig>("target = []\ntypo = 1").is_err(),
            "unknown keys are rejected"
        );
        Ok(())
    }
}
