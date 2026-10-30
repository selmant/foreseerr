//! `dns.promises.Resolver`'s `resolve4`/`resolve6` with `{ ttl: true }`.
//!
//! `dns-caching` uses them to learn record TTLs: plain DNS queries to the
//! servers in /etc/resolv.conf (no hosts file, no search list, as c-ares'
//! `ares_query`), each address with its TTL capped by the CNAMEs that led
//! to it.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// c-ares' per-try timeout.
const TRY_TIMEOUT: Duration = Duration::from_secs(2);
/// c-ares' tries per server.
const TRIES: usize = 3;

/// `A` or `AAAA`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// `resolve4`.
    V4,
    /// `resolve6`.
    V6,
}

impl Family {
    const fn qtype(self) -> u16 {
        match self {
            Self::V4 => 1,
            Self::V6 => 28,
        }
    }
}

/// One answer: an address and its TTL in seconds.
pub type Record = (IpAddr, u32);

/// The name servers of /etc/resolv.conf (c-ares falls back to loopback).
fn servers() -> Vec<SocketAddr> {
    let text = std::fs::read_to_string("/etc/resolv.conf").unwrap_or_default();
    let mut out: Vec<SocketAddr> = text
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            (words.next() == Some("nameserver"))
                .then(|| words.next())
                .flatten()
                .and_then(|ip| ip.split('%').next()?.parse::<IpAddr>().ok())
                .map(|ip| SocketAddr::new(ip, 53))
        })
        .collect();
    if out.is_empty() {
        out.push(SocketAddr::from(([127, 0, 0, 1], 53)));
    }
    out
}

/// The query packet for `host`; `None` for a name DNS can't carry.
fn query(id: u16, host: &str, family: Family) -> Option<Vec<u8>> {
    let mut packet = Vec::with_capacity(host.len() + 18);
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in host.trim_end_matches('.').split('.') {
        let len = u8::try_from(label.len())
            .ok()
            .filter(|l| (1..64).contains(l))?;
        packet.push(len);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    packet.extend_from_slice(&family.qtype().to_be_bytes());
    packet.extend_from_slice(&[0, 1]);
    Some(packet)
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

/// The offset just past the (possibly compressed) name at `at`.
fn skip_name(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let len = *bytes.get(at)?;
        if len & 0xC0 == 0xC0 {
            return Some(at + 2);
        }
        if len == 0 {
            return Some(at + 1);
        }
        at += usize::from(len) + 1;
    }
}

/// What an answer said.
#[derive(Debug, PartialEq, Eq)]
enum Parsed {
    /// The addresses of the asked type.
    Records(Vec<Record>),
    /// Truncated: ask again over TCP.
    Truncated,
    /// An error code (`NXDOMAIN`, `SERVFAIL`, …).
    Failed(u8),
}

fn parse(bytes: &[u8], id: u16, family: Family) -> Option<Parsed> {
    if u16_at(bytes, 0)? != id {
        return None;
    }
    let flags = u16_at(bytes, 2)?;
    if flags & 0x0200 != 0 {
        return Some(Parsed::Truncated);
    }
    let rcode = u8::try_from(flags & 0x000F).ok()?;
    if rcode != 0 {
        return Some(Parsed::Failed(rcode));
    }
    let questions = u16_at(bytes, 4)?;
    let answers = u16_at(bytes, 6)?;
    let mut at = 12;
    for _ in 0..questions {
        at = skip_name(bytes, at)? + 4;
    }
    let mut records = Vec::new();
    let mut cname_ttl = u32::MAX;
    for _ in 0..answers {
        at = skip_name(bytes, at)?;
        let kind = u16_at(bytes, at)?;
        let ttl = u32_at(bytes, at + 4)?;
        let len = usize::from(u16_at(bytes, at + 8)?);
        let data = bytes.get(at + 10..at + 10 + len)?;
        at += 10 + len;
        match (kind, family) {
            (5, _) => cname_ttl = cname_ttl.min(ttl),
            (1, Family::V4) => {
                let octets: [u8; 4] = data.try_into().ok()?;
                records.push((IpAddr::V4(Ipv4Addr::from(octets)), ttl));
            }
            (28, Family::V6) => {
                let octets: [u8; 16] = data.try_into().ok()?;
                records.push((IpAddr::V6(Ipv6Addr::from(octets)), ttl));
            }
            _ => {}
        }
    }
    for record in &mut records {
        record.1 = record.1.min(cname_ttl);
    }
    Some(Parsed::Records(records))
}

async fn ask_udp(server: SocketAddr, packet: &[u8], id: u16, family: Family) -> Option<Parsed> {
    let bind: SocketAddr = if server.is_ipv4() {
        SocketAddr::from(([0, 0, 0, 0], 0))
    } else {
        SocketAddr::from(([0_u16; 8], 0))
    };
    let socket = tokio::net::UdpSocket::bind(bind).await.ok()?;
    socket.connect(server).await.ok()?;
    socket.send(packet).await.ok()?;
    let mut buf = vec![0_u8; 4096];
    loop {
        let n = tokio::time::timeout(TRY_TIMEOUT, socket.recv(&mut buf))
            .await
            .ok()?
            .ok()?;
        if let Some(parsed) = buf.get(..n).and_then(|b| parse(b, id, family)) {
            return Some(parsed);
        }
    }
}

async fn ask_tcp(server: SocketAddr, packet: &[u8], id: u16, family: Family) -> Option<Parsed> {
    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect(server).await.ok()?;
        let len = u16::try_from(packet.len()).ok()?;
        stream.write_all(&len.to_be_bytes()).await.ok()?;
        stream.write_all(packet).await.ok()?;
        let mut head = [0_u8; 2];
        stream.read_exact(&mut head).await.ok()?;
        let mut body = vec![0_u8; usize::from(u16::from_be_bytes(head))];
        stream.read_exact(&mut body).await.ok()?;
        parse(&body, id, family)
    };
    tokio::time::timeout(TRY_TIMEOUT, exchange).await.ok()?
}

/// `resolver.resolve4/6(host, { ttl: true })`.
///
/// # Errors
///
/// Fails as the resolver rejects: no such name, no records of the type,
/// a server failure, or no answer in time.
pub async fn resolve(host: &str, family: Family) -> std::io::Result<Vec<Record>> {
    let not_found = || {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("queryA ENOTFOUND {host}"),
        )
    };
    if let Ok(ip) = host.parse::<IpAddr>() {
        // c-ares answers an address literal of the asked family itself.
        return match (ip, family) {
            (IpAddr::V4(_), Family::V4) | (IpAddr::V6(_), Family::V6) => Ok(vec![(ip, 0)]),
            _ => Err(not_found()),
        };
    }
    let id = u16::from_be_bytes(rand::random::<[u8; 2]>());
    let packet = query(id, host, family).ok_or_else(not_found)?;
    let servers = servers();
    for _ in 0..TRIES {
        for server in &servers {
            let answer = match ask_udp(*server, &packet, id, family).await {
                Some(Parsed::Truncated) => ask_tcp(*server, &packet, id, family).await,
                other => other,
            };
            match answer {
                Some(Parsed::Records(records)) if records.is_empty() => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        format!("query ENODATA {host}"),
                    ));
                }
                Some(Parsed::Records(records)) => return Ok(records),
                Some(Parsed::Failed(3)) => return Err(not_found()),
                Some(Parsed::Failed(_) | Parsed::Truncated) | None => {}
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!("query ETIMEOUT {host}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_queries() {
        assert_eq!(
            query(0x1234, "a.bc", Family::V4),
            Some(vec![
                0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, b'a', 2, b'b', b'c', 0, 0, 1, 0, 1
            ]),
            "an A query"
        );
        assert_eq!(query(1, "a..b", Family::V6), None, "an empty label");
    }

    #[test]
    fn parses_answers_with_cname_ttls() {
        let mut packet = vec![0x12, 0x34, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0];
        packet.extend_from_slice(&[1, b'a', 0, 0, 1, 0, 1]);
        // a CNAME (TTL 30) pointing at the question name, then an A (TTL 300).
        packet.extend_from_slice(&[0xC0, 12, 0, 5, 0, 1, 0, 0, 0, 30, 0, 2, 0xC0, 12]);
        packet.extend_from_slice(&[0xC0, 12, 0, 1, 0, 1, 0, 0, 1, 44, 0, 4, 10, 0, 0, 1]);
        assert_eq!(
            parse(&packet, 0x1234, Family::V4),
            Some(Parsed::Records(vec![(IpAddr::from([10, 0, 0, 1]), 30)])),
            "the address with the chain's lowest TTL"
        );
        let mut nx = vec![0x12, 0x34, 0x81, 0x83, 0, 0, 0, 0, 0, 0, 0, 0];
        nx.truncate(12);
        assert_eq!(
            parse(&nx, 0x1234, Family::V4),
            Some(Parsed::Failed(3)),
            "NXDOMAIN"
        );
        assert_eq!(parse(&nx, 1, Family::V4), None, "another query's answer");
    }
}
