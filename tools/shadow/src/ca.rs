//! A throwaway certificate authority so the forward proxy can read HTTPS calls.
//!
//! The backend has to trust `ca.pem` (for Bun/Node: `NODE_EXTRA_CA_CERTS`).
//! Leaf certificates are minted per host on first use and cached.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;

use crate::httpx::lock;

/// The CA plus a cache of per-host TLS configs.
pub struct CertAuthority {
    cert: rcgen::Certificate,
    key: KeyPair,
    pem_path: PathBuf,
    leaves: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

impl fmt::Debug for CertAuthority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CertAuthority")
            .field("pem_path", &self.pem_path)
            .field("cached_hosts", &lock(&self.leaves).len())
            .finish_non_exhaustive()
    }
}

impl CertAuthority {
    /// Load `ca.pem` + `ca.key` from `dir`, creating them on first use.
    ///
    /// # Errors
    ///
    /// Fails when the directory can't be written or existing files can't be
    /// parsed.
    pub fn load_or_create(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let pem_path = dir.join("ca.pem");
        let key_path = dir.join("ca.key");

        let (cert, key) = if pem_path.exists() && key_path.exists() {
            let key = KeyPair::from_pem(&std::fs::read_to_string(&key_path)?)
                .context("reading ca.key")?;
            let params = CertificateParams::from_ca_cert_pem(&std::fs::read_to_string(&pem_path)?)
                .context("reading ca.pem")?;
            // Re-signing keeps the subject and key, so leaves still chain to the
            // ca.pem the backend already trusts.
            let cert = params.self_signed(&key)?;
            (cert, key)
        } else {
            let key = KeyPair::generate()?;
            let mut params = CertificateParams::new(Vec::<String>::new())?;
            let mut dn = DistinguishedName::new();
            dn.push(DnType::CommonName, "foreseerr shadow proxy CA");
            dn.push(DnType::OrganizationName, "foreseerr shadow");
            params.distinguished_name = dn;
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![
                KeyUsagePurpose::KeyCertSign,
                KeyUsagePurpose::CrlSign,
                KeyUsagePurpose::DigitalSignature,
            ];
            let now = time::OffsetDateTime::now_utc();
            params.not_before = now - time::Duration::days(1);
            params.not_after = now + time::Duration::days(3650);
            let cert = params.self_signed(&key)?;
            write_private(&key_path, key.serialize_pem().as_bytes())?;
            std::fs::write(&pem_path, cert.pem())?;
            tracing::info!("created CA at {}", pem_path.display());
            (cert, key)
        };

        Ok(Self {
            cert,
            key,
            pem_path,
            leaves: Mutex::new(HashMap::new()),
        })
    }

    /// Where the CA certificate the backend must trust lives.
    #[must_use]
    pub fn pem_path(&self) -> &Path {
        &self.pem_path
    }

    /// TLS server config presenting a certificate for `host`.
    ///
    /// # Errors
    ///
    /// Fails when a certificate can't be generated for the name.
    pub fn server_config(&self, host: &str) -> Result<Arc<ServerConfig>> {
        if let Some(cfg) = lock(&self.leaves).get(host) {
            return Ok(Arc::clone(cfg));
        }
        let leaf_key = KeyPair::generate()?;
        let mut params = CertificateParams::new(vec![host.to_owned()])?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, host);
        params.distinguished_name = dn;
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::days(1);
        params.not_after = now + time::Duration::days(365);
        let leaf = params.signed_by(&leaf_key, &self.cert, &self.key)?;

        let chain = vec![
            leaf.der().clone(),
            CertificateDer::from(self.cert.der().to_vec()),
        ];
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));
        let mut cfg =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()?
                .with_no_client_auth()
                .with_single_cert(chain, key)?;
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let cfg = Arc::new(cfg);
        lock(&self.leaves).insert(host.to_owned(), Arc::clone(&cfg));
        Ok(cfg)
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}
