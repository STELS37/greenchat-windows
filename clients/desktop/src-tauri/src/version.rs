// T-412: semver comparison for the force-update gate. Pure + unit-tested so the "version < min_supported
// → block" decision (CLIENTS §9) is verified by `cargo test` without a running server. Handles the
// MAJOR.MINOR.PATCH core; a pre-release suffix (-beta.1) sorts BELOW the same core release (per semver).
// Build metadata (+…) is ignored. Non-numeric / missing components are treated as 0 (lenient).

#[derive(Debug, PartialEq, Eq)]
pub enum Ord3 {
    Less,
    Equal,
    Greater,
}

fn parse_core(v: &str) -> ([u64; 3], Option<String>) {
    let v = v.trim().trim_start_matches('v');
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p.split('+').next().unwrap_or("").to_string())),
        None => (v.split('+').next().unwrap_or(v), None),
    };
    let mut parts = [0u64; 3];
    for (i, seg) in core.split('.').take(3).enumerate() {
        parts[i] = seg.parse().unwrap_or(0);
    }
    (parts, pre.filter(|s| !s.is_empty()))
}

/// Compare two semver strings. Pre-release < release; identifiers compared as documented in semver §11
/// (numeric identifiers numerically, alphanumeric lexically, more identifiers wins when all else equal).
pub fn compare(a: &str, b: &str) -> Ord3 {
    let (ca, pa) = parse_core(a);
    let (cb, pb) = parse_core(b);
    if ca != cb {
        return if ca < cb { Ord3::Less } else { Ord3::Greater };
    }
    match (pa, pb) {
        (None, None) => Ord3::Equal,
        (Some(_), None) => Ord3::Less,    // 1.0.0-beta < 1.0.0
        (None, Some(_)) => Ord3::Greater, // 1.0.0 > 1.0.0-beta
        (Some(x), Some(y)) => compare_pre(&x, &y),
    }
}

fn compare_pre(x: &str, y: &str) -> Ord3 {
    let (xs, ys): (Vec<&str>, Vec<&str>) = (x.split('.').collect(), y.split('.').collect());
    for i in 0..xs.len().max(ys.len()) {
        match (xs.get(i), ys.get(i)) {
            (Some(_), None) => return Ord3::Greater, // more identifiers = higher precedence
            (None, Some(_)) => return Ord3::Less,
            (Some(a), Some(b)) => {
                let (na, nb) = (a.parse::<u64>().ok(), b.parse::<u64>().ok());
                let c = match (na, nb) {
                    (Some(pa), Some(pb)) => pa.cmp(&pb),
                    (Some(_), None) => std::cmp::Ordering::Less, // numeric < alphanumeric
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.cmp(b),
                };
                match c {
                    std::cmp::Ordering::Less => return Ord3::Less,
                    std::cmp::Ordering::Greater => return Ord3::Greater,
                    std::cmp::Ordering::Equal => {}
                }
            }
            (None, None) => {}
        }
    }
    Ord3::Equal
}

/// The force-update gate: is `current` strictly below `min_supported`?
pub fn below_min(current: &str, min_supported: &str) -> bool {
    compare(current, min_supported) == Ord3::Less
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_core_versions() {
        assert_eq!(compare("1.2.3", "1.2.3"), Ord3::Equal);
        assert_eq!(compare("1.2.3", "1.2.4"), Ord3::Less);
        assert_eq!(compare("1.3.0", "1.2.9"), Ord3::Greater);
        assert_eq!(compare("2.0.0", "1.99.99"), Ord3::Greater);
        assert_eq!(compare("v1.0.0", "1.0.0"), Ord3::Equal); // leading v tolerated
    }

    #[test]
    fn prerelease_sorts_below_release() {
        assert_eq!(compare("1.0.0-beta", "1.0.0"), Ord3::Less);
        assert_eq!(compare("1.0.0", "1.0.0-beta"), Ord3::Greater);
        assert_eq!(compare("1.0.0-beta.1", "1.0.0-beta.2"), Ord3::Less);
        assert_eq!(compare("1.0.0-alpha", "1.0.0-beta"), Ord3::Less);
        assert_eq!(compare("1.0.0-1", "1.0.0-1"), Ord3::Equal);
    }

    #[test]
    fn force_update_gate() {
        assert!(below_min("0.1.0", "0.2.0")); // too old → blocked
        assert!(!below_min("0.2.0", "0.2.0")); // exactly min → allowed
        assert!(!below_min("0.3.0", "0.2.0")); // newer → allowed
        assert!(below_min("1.0.0-beta", "1.0.0")); // pre-release just under the min release → blocked
    }

    #[test]
    fn missing_or_partial_components_default_to_zero() {
        assert_eq!(compare("1", "1.0.0"), Ord3::Equal);
        assert_eq!(compare("1.2", "1.2.0"), Ord3::Equal);
        assert_eq!(compare("1.2", "1.2.1"), Ord3::Less);
    }
}
