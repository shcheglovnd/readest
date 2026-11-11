//! Android app-local, user-imported trust anchors. The app initializes
//! SSL_CERT_FILE before starting Rust; reqwest loads this bundle for each new
//! client alongside its normal WebPKI roots. Never disable peer verification.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use x509_parser::parse_x509_certificate;

const MAX_BYTES: usize = 65536;
const MAX_CERTIFICATES: usize = 16;
const BUNDLE_NAME: &str = "readest-ca-bundle.pem";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CertificateInfo {
    subject: String,
    issuer: String,
    fingerprint: String,
    valid_from: i64,
    valid_until: i64,
    currently_valid: bool,
}

struct ParsedCertificate {
    der: Vec<u8>,
    info: CertificateInfo,
}

fn parse_certificates(data: &[u8], require_valid: bool) -> Result<Vec<ParsedCertificate>, String> {
    if data.is_empty() || data.len() > MAX_BYTES {
        return Err("Choose a certificate file smaller than 64 KiB.".into());
    }
    let mut ders = Vec::new();
    if data.first() == Some(&0x30) {
        // A DER certificate is one complete ASN.1 sequence, not a bundle.
        ders.push(data.to_vec());
    } else {
        let mut text = std::str::from_utf8(data)
            .map_err(|_| "Choose a valid PEM or DER certificate.")?
            .trim();
        while !text.is_empty() {
            if !text.starts_with("-----BEGIN CERTIFICATE-----") {
                return Err("Import certificates only, never private keys.".into());
            }
            let end_marker = "-----END CERTIFICATE-----";
            let end = text
                .find(end_marker)
                .ok_or("Choose a valid PEM or DER certificate.")?
                + end_marker.len();
            let cert =
                pem::parse(&text[..end]).map_err(|_| "Choose a valid PEM or DER certificate.")?;
            ders.push(cert.into_contents());
            text = text[end..].trim();
            if ders.len() > MAX_CERTIFICATES {
                return Err("At most 16 certificates can be trusted.".into());
            }
        }
    }
    if ders.is_empty() {
        return Err("Choose a valid PEM or DER certificate.".into());
    }
    ders.into_iter()
        .map(|der| {
            let (remaining, cert) = parse_x509_certificate(&der)
                .map_err(|_| "Choose a valid PEM or DER certificate.")?;
            if !remaining.is_empty() {
                return Err("Choose a valid PEM or DER certificate.".into());
            }
            if !cert.is_ca() && cert.subject() != cert.issuer() {
                return Err("Import a CA or self-signed server certificate.".into());
            }
            let currently_valid = cert.validity().is_valid();
            if require_valid && !currently_valid {
                return Err("The certificate is expired or not yet valid.".into());
            }
            let info = CertificateInfo {
                subject: cert.subject().to_string(),
                issuer: cert.issuer().to_string(),
                fingerprint: Sha256::digest(&der)
                    .iter()
                    .map(|byte| format!("{byte:02X}"))
                    .collect::<Vec<_>>()
                    .join(":"),
                valid_from: cert.validity().not_before.timestamp(),
                valid_until: cert.validity().not_after.timestamp(),
                currently_valid,
            };
            Ok(ParsedCertificate { der, info })
        })
        .collect()
}

fn inspect_certificates(data: &[u8]) -> Result<Vec<CertificateInfo>, String> {
    Ok(parse_certificates(data, true)?
        .into_iter()
        .map(|cert| cert.info)
        .collect())
}

fn read_store(path: &Path) -> Result<Vec<ParsedCertificate>, String> {
    match std::fs::read(path) {
        Ok(data) if data.is_empty() => Ok(Vec::new()),
        // Expired anchors remain visible so the user can remove them.
        Ok(data) => parse_certificates(&data, false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("Could not read certificates.".into()),
    }
}

fn write_store(path: &Path, certs: &[ParsedCertificate]) -> Result<(), String> {
    if certs.len() > MAX_CERTIFICATES {
        return Err("At most 16 certificates can be trusted.".into());
    }
    let bundle: String = certs
        .iter()
        .map(|cert| pem::encode(&pem::Pem::new("CERTIFICATE", cert.der.clone())))
        .collect();
    if bundle.len() > MAX_BYTES {
        return Err("The certificate store exceeds 64 KiB.".into());
    }
    // Readers see either the old or the complete new bundle, never a partially
    // written trust store. The containing directory is Android app-private.
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bundle).map_err(|_| "Could not save certificates.")?;
    std::fs::rename(&temporary, path).map_err(|_| "Could not save certificates.".to_owned())
}

fn import_into_store(path: &Path, data: &[u8]) -> Result<Vec<CertificateInfo>, String> {
    let incoming = parse_certificates(data, true)?;
    let mut certs = read_store(path)?;
    for cert in incoming {
        if !certs
            .iter()
            .any(|stored| stored.info.fingerprint == cert.info.fingerprint)
        {
            certs.push(cert);
        }
    }
    write_store(path, &certs)?;
    Ok(certs.into_iter().map(|cert| cert.info).collect())
}

fn remove_from_store(path: &Path, fingerprint: &str) -> Result<Vec<CertificateInfo>, String> {
    let mut certs = read_store(path)?;
    certs.retain(|cert| cert.info.fingerprint != fingerprint);
    write_store(path, &certs)?;
    Ok(certs.into_iter().map(|cert| cert.info).collect())
}

#[cfg(target_os = "android")]
mod commands {
    use super::*;
    use std::sync::Mutex;
    use tauri::{AppHandle, Manager};

    static STORE_LOCK: Mutex<()> = Mutex::new(());

    #[tauri::command]
    pub(crate) fn inspect_server_certificates(
        data: Vec<u8>,
    ) -> Result<Vec<CertificateInfo>, String> {
        inspect_certificates(&data)
    }

    #[tauri::command]
    pub(crate) fn list_server_certificates(app: AppHandle) -> Result<Vec<CertificateInfo>, String> {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| "Could not read certificates.")?;
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| "Could not read certificates.")?
            .join(BUNDLE_NAME);
        Ok(read_store(&path)?
            .into_iter()
            .map(|cert| cert.info)
            .collect())
    }

    #[tauri::command]
    pub(crate) fn import_server_certificates(
        app: AppHandle,
        data: Vec<u8>,
    ) -> Result<Vec<CertificateInfo>, String> {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| "Could not save certificates.")?;
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| "Could not save certificates.")?
            .join(BUNDLE_NAME);
        import_into_store(&path, &data)
    }

    #[tauri::command]
    pub(crate) fn remove_server_certificate(
        app: AppHandle,
        fingerprint: String,
    ) -> Result<Vec<CertificateInfo>, String> {
        let _guard = STORE_LOCK
            .lock()
            .map_err(|_| "Could not save certificates.")?;
        let path = app
            .path()
            .app_data_dir()
            .map_err(|_| "Could not save certificates.")?
            .join(BUNDLE_NAME);
        remove_from_store(&path, &fingerprint)
    }
}

#[cfg(target_os = "android")]
pub(crate) use commands::*;

#[cfg(test)]
mod tests {
    use super::*;
    const CA: &[u8] = include_bytes!("../tests/fixtures/server-certificates/example-ca.pem");

    #[test]
    fn imports_a_pem_certificate_with_identity_and_fingerprint() {
        let certs = inspect_certificates(CA).unwrap();
        assert_eq!(certs.len(), 1);
        assert!(certs[0].subject.contains("example-ca.example.org"));
        assert_eq!(certs[0].fingerprint.len(), 95);
    }

    #[test]
    fn imports_der_as_well_as_pem() {
        let der = pem::parse(CA).unwrap();
        assert_eq!(inspect_certificates(der.contents()).unwrap().len(), 1);
    }

    #[test]
    fn rejects_expired_certificates_and_private_keys() {
        assert!(inspect_certificates(include_bytes!(
            "../tests/fixtures/server-certificates/expired-ca.pem"
        ))
        .is_err());
        let with_key = [
            CA,
            b"\n-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----\n",
        ]
        .concat();
        assert!(inspect_certificates(&with_key).is_err());
        assert!(inspect_certificates(b"not a certificate").is_err());
        assert!(inspect_certificates(b"   ").is_err());
        assert!(inspect_certificates(&vec![0; MAX_BYTES + 1]).is_err());
        let trailing_der = [pem::parse(CA).unwrap().contents(), b"junk"].concat();
        assert!(inspect_certificates(&trailing_der).is_err());
    }

    #[test]
    fn accepts_self_signed_server_certificates() {
        assert_eq!(
            inspect_certificates(include_bytes!(
                "../tests/fixtures/server-certificates/self-signed-server.pem"
            ))
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn persists_multiple_roots_deduplicates_and_removes_individual_certificates() {
        let directory = std::env::temp_dir().join(format!("readest-ca-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(BUNDLE_NAME);
        let first = import_into_store(&path, CA).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(import_into_store(&path, CA).unwrap().len(), 1);
        let second = include_bytes!("../tests/fixtures/server-certificates/second-ca.pem");
        assert_eq!(import_into_store(&path, second).unwrap().len(), 2);
        assert_eq!(read_store(&path).unwrap().len(), 2);
        let before = std::fs::read(&path).unwrap();
        assert!(import_into_store(&path, b"invalid").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let remaining = remove_from_store(&path, &first[0].fingerprint).unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].subject.contains("second-ca"));
        assert!(remove_from_store(&path, &remaining[0].fingerprint)
            .unwrap()
            .is_empty());
        assert!(read_store(&path).unwrap().is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reads_expired_anchors_for_removal_but_refuses_importing_them() {
        let expired = include_bytes!("../tests/fixtures/server-certificates/expired-ca.pem");
        assert!(
            !parse_certificates(expired, false).unwrap()[0]
                .info
                .currently_valid
        );
        assert!(inspect_certificates(expired).is_err());
    }
}
