// T-411: deep-link → SPA hash mapping. Pure + unit-tested (no Tauri types) so the routing table is
// verified by `cargo test` without a display. Mirrors CLIENTS §deep-links "Web-эквивалент: /#/chat/<id>":
//   greenchat://chat/<id>                       -> #/chat/<id>
//   greenchat://chat/<id>/message/<mid>         -> #/chat/<id>/message/<mid>
//   greenchat://user/<username>                 -> #/user/<username>
//   greenchat://join/<invite>                   -> #/join/<invite>
//   greenchat://settings                        -> #/settings
//   greenchat://connect?host=<url>              -> #/connect?host=<url>   (T-419 server-address deep link)
//   gcpay://invoice/<code>                      -> #/pay/invoice/<code>   (PAYMENTS §5)
use url::Url;

/// Resolve one deep-link URL string to a SPA hash (leading '#'), or None if it is not a link we own.
pub fn resolve(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    let scheme = url.scheme();
    // host + path segments, tolerant of the authority slot ("greenchat://chat/1" parses host="chat").
    let mut segs: Vec<String> = Vec::new();
    if let Some(host) = url.host_str() {
        if !host.is_empty() {
            segs.push(host.to_string());
        }
    }
    if let Some(path_segs) = url.path_segments() {
        for s in path_segs {
            if !s.is_empty() {
                segs.push(s.to_string());
            }
        }
    }
    let parts: Vec<&str> = segs.iter().map(|s| s.as_str()).collect();

    match scheme {
        "greenchat" => match parts.as_slice() {
            ["chat", id, "message", mid] => {
                Some(format!("#/chat/{}/message/{}", enc(id), enc(mid)))
            }
            ["chat", id] => Some(format!("#/chat/{}", enc(id))),
            ["user", name] => Some(format!("#/user/{}", enc(name))),
            ["join", invite] => Some(format!("#/join/{}", enc(invite))),
            ["auth", "qr", token] => Some(format!("#/auth/qr/{}", enc(token))),
            ["settings"] => Some("#/settings".to_string()),
            // T-419: the «Адрес сервера» deep link carries the target server as a ?host= query. Byte-for-byte
            // parity with the Android bridge (mobile/bridge/deeplink.ts) — host re-encoded like encodeURIComponent.
            ["connect"] => Some(connect_hash(&url)),
            _ => None,
        },
        "gcpay" => match parts.as_slice() {
            ["invoice", code] => Some(format!("#/pay/invoice/{}", enc(code))),
            _ => None,
        },
        _ => None,
    }
}

/// Scan an argv/url list and return the hash of the first recognised deep link.
pub fn first_hash<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().find_map(|a| resolve(a.as_ref()))
}

// Minimal path-segment percent-encoding for the few chars that would break a hash route. Ids/usernames
// are already URL-safe by their server-side charset; this only guards stray spaces / '#' / '?'.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            '/' => out.push_str("%2F"),
            c => out.push(c),
        }
    }
    out
}

// The «Адрес сервера» hash: greenchat://connect?host=<server> -> #/connect?host=<server> (or bare #/connect
// when no host is given). The query value is re-encoded exactly like JS encodeURIComponent so the hash is
// byte-for-byte what the Android bridge (mobile/bridge/deeplink.ts) produces from the same deep link.
fn connect_hash(url: &Url) -> String {
    for (k, v) in url.query_pairs() {
        if k == "host" && !v.is_empty() {
            return format!("#/connect?host={}", enc_component(&v));
        }
    }
    "#/connect".to_string()
}

// Percent-encode a value the way JS encodeURIComponent does — unreserved set A-Z a-z 0-9 - _ . ! ~ * ' ( );
// every other byte becomes %XX (UTF-8 bytes for non-ASCII). Keeps the desktop deep link in lock-step with
// the Android bridge, whose `encodeURIComponent(host)` this mirrors.
fn enc_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_greenchat_routes() {
        assert_eq!(resolve("greenchat://chat/42").as_deref(), Some("#/chat/42"));
        assert_eq!(
            resolve("greenchat://chat/42/message/1007").as_deref(),
            Some("#/chat/42/message/1007")
        );
        assert_eq!(
            resolve("greenchat://user/alice").as_deref(),
            Some("#/user/alice")
        );
        assert_eq!(
            resolve("greenchat://join/AbC123").as_deref(),
            Some("#/join/AbC123")
        );
        assert_eq!(
            resolve("greenchat://settings").as_deref(),
            Some("#/settings")
        );
        let token = "a".repeat(96);
        assert_eq!(
            resolve(&format!("greenchat://auth/qr/{token}")).as_deref(),
            Some(format!("#/auth/qr/{token}").as_str())
        );
    }

    #[test]
    fn maps_gcpay_invoice() {
        assert_eq!(
            resolve("gcpay://invoice/INV-9").as_deref(),
            Some("#/pay/invoice/INV-9")
        );
    }

    #[test]
    fn maps_connect_with_host_query() {
        // T-419: byte-for-byte parity with the Android bridge (mobile/bridge/deeplink.ts).
        assert_eq!(
            resolve("greenchat://connect?host=https%3A%2F%2Fchat.example.org").as_deref(),
            Some("#/connect?host=https%3A%2F%2Fchat.example.org")
        );
        // A bare host value is re-encoded like encodeURIComponent (':' and '/' escaped).
        assert_eq!(
            resolve("greenchat://connect?host=https://my.host:8443").as_deref(),
            Some("#/connect?host=https%3A%2F%2Fmy.host%3A8443")
        );
        // No / empty host → the plain screen.
        assert_eq!(resolve("greenchat://connect").as_deref(), Some("#/connect"));
        assert_eq!(
            resolve("greenchat://connect?host=").as_deref(),
            Some("#/connect")
        );
    }

    #[test]
    fn rejects_foreign_or_malformed() {
        assert_eq!(resolve("https://example.com/chat/1"), None);
        assert_eq!(resolve("greenchat://unknown/1"), None);
        assert_eq!(resolve("not a url"), None);
        assert_eq!(resolve("gcpay://chat/1"), None);
    }

    #[test]
    fn first_hash_picks_the_deep_link_from_argv() {
        let argv = ["green-chat-desktop", "--flag", "greenchat://chat/7"];
        assert_eq!(first_hash(argv).as_deref(), Some("#/chat/7"));
        let none: [&str; 2] = ["green-chat-desktop", "--flag"];
        assert_eq!(first_hash(none), None);
    }
}
