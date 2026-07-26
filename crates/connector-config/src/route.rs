use std::collections::HashSet;

use serde::Deserialize;
use url::Url;

use crate::error::ConfigError;

/// Maximum length of an ILP address, per RFC 0015.
const MAX_ILP_ADDRESS_LEN: usize = 1023;

/// A single label between dots is alphanumeric plus `-`/`_`, matching RFC
/// 0015 and the existing TypeScript connector's `isValidILPAddress`.
fn is_valid_label(label: &str) -> bool {
    !label.is_empty()
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An ILP address is one or more valid labels joined by dots -- no leading,
/// trailing, or consecutive dots, and no characters outside the label set.
fn is_valid_ilp_address(address: &str) -> bool {
    !address.is_empty()
        && address.len() <= MAX_ILP_ADDRESS_LEN
        && address.split('.').all(is_valid_label)
}

/// A `[[routes]]` entry as written in the config file.
#[derive(Debug, Deserialize)]
pub(crate) struct RawRoute {
    prefix: String,
    handler_url: String,
}

/// A `[[children]]` entry: a convenience form that desugars into a
/// [`RawRoute`] at `<apex>.<name>` once the file is loaded (mirroring the
/// existing TypeScript `child-expander`), so the runtime never sees anything
/// but ordinary routes.
#[derive(Debug, Deserialize)]
pub(crate) struct RawChild {
    name: String,
    handler_url: String,
}

/// A static route that terminates at this connector: packets matching
/// `prefix` are delivered to the app at `handler_url`.
///
/// Constructed only by [`resolve_routes`], so a value that exists has
/// already had its prefix and URL validated -- downstream code never
/// re-checks either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticRoute {
    prefix: String,
    handler_url: Url,
}

impl StaticRoute {
    /// The destination prefix this route terminates.
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The app handler this route's traffic is delivered to.
    pub fn handler_url(&self) -> &Url {
        &self.handler_url
    }
}

fn build_route(prefix: String, handler_url: String) -> Result<StaticRoute, ConfigError> {
    if !is_valid_ilp_address(&prefix) {
        return Err(ConfigError::InvalidAddress {
            field: "prefix".to_string(),
            value: prefix,
        });
    }
    let url = Url::parse(&handler_url).map_err(|source| ConfigError::InvalidHandlerUrl {
        prefix: prefix.clone(),
        value: handler_url.clone(),
        source,
    })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ConfigError::UnsupportedUrlScheme {
            prefix,
            value: handler_url,
        });
    }
    Ok(StaticRoute {
        prefix,
        handler_url: url,
    })
}

fn insert_unique(
    seen: &mut HashSet<String>,
    routes: &mut Vec<StaticRoute>,
    route: StaticRoute,
) -> Result<(), ConfigError> {
    if !seen.insert(route.prefix.clone()) {
        return Err(ConfigError::DuplicatePrefix {
            prefix: route.prefix,
        });
    }
    routes.push(route);
    Ok(())
}

/// Resolve `routes` and desugar `children` (under `apex`) into a single,
/// fully validated, deduplicated list of [`StaticRoute`]s.
pub(crate) fn resolve_routes(
    apex: Option<&str>,
    raw_routes: Vec<RawRoute>,
    raw_children: Vec<RawChild>,
) -> Result<Vec<StaticRoute>, ConfigError> {
    let mut seen = HashSet::with_capacity(raw_routes.len() + raw_children.len());
    let mut routes = Vec::with_capacity(raw_routes.len() + raw_children.len());

    for raw in raw_routes {
        let route = build_route(raw.prefix, raw.handler_url)?;
        insert_unique(&mut seen, &mut routes, route)?;
    }

    if raw_children.is_empty() {
        return Ok(routes);
    }

    let apex = apex.ok_or(ConfigError::MissingApex)?;
    if !is_valid_ilp_address(apex) {
        return Err(ConfigError::InvalidAddress {
            field: "apex".to_string(),
            value: apex.to_string(),
        });
    }

    for child in raw_children {
        if !is_valid_label(&child.name) {
            return Err(ConfigError::InvalidChildName { name: child.name });
        }
        let prefix = format!("{apex}.{}", child.name);
        let route = build_route(prefix, child.handler_url)?;
        insert_unique(&mut seen, &mut routes, route)?;
    }

    Ok(routes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(prefix: &str, handler_url: &str) -> RawRoute {
        RawRoute {
            prefix: prefix.to_string(),
            handler_url: handler_url.to_string(),
        }
    }

    fn child(name: &str, handler_url: &str) -> RawChild {
        RawChild {
            name: name.to_string(),
            handler_url: handler_url.to_string(),
        }
    }

    #[test]
    fn resolves_explicit_routes() {
        let routes = resolve_routes(
            None,
            vec![route("g.example.app", "http://localhost:4000")],
            vec![],
        )
        .expect("resolve");

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix(), "g.example.app");
        assert_eq!(routes[0].handler_url().as_str(), "http://localhost:4000/");
    }

    #[test]
    fn rejects_an_invalid_prefix() {
        let result = resolve_routes(None, vec![route("g..app", "http://localhost:4000")], vec![]);
        assert!(matches!(result, Err(ConfigError::InvalidAddress { .. })));
    }

    #[test]
    fn rejects_a_non_http_handler_url() {
        let result = resolve_routes(None, vec![route("g.example.app", "not a url")], vec![]);
        assert!(matches!(result, Err(ConfigError::InvalidHandlerUrl { .. })));
    }

    #[test]
    fn rejects_a_non_http_scheme() {
        let result = resolve_routes(
            None,
            vec![route("g.example.app", "ftp://localhost:4000")],
            vec![],
        );
        assert!(matches!(
            result,
            Err(ConfigError::UnsupportedUrlScheme { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_prefixes() {
        let result = resolve_routes(
            None,
            vec![
                route("g.example.app", "http://localhost:4000"),
                route("g.example.app", "http://localhost:5000"),
            ],
            vec![],
        );
        assert!(matches!(result, Err(ConfigError::DuplicatePrefix { .. })));
    }

    #[test]
    fn expands_children_under_the_apex() {
        let routes = resolve_routes(
            Some("g.example.connector"),
            vec![],
            vec![child("billing", "http://localhost:4001")],
        )
        .expect("resolve");

        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix(), "g.example.connector.billing");
    }

    #[test]
    fn children_without_an_apex_is_a_specific_error() {
        let result = resolve_routes(
            None,
            vec![],
            vec![child("billing", "http://localhost:4001")],
        );
        assert!(matches!(result, Err(ConfigError::MissingApex)));
    }

    #[test]
    fn rejects_a_child_name_with_a_dot() {
        let result = resolve_routes(
            Some("g.example.connector"),
            vec![],
            vec![child("billing.sub", "http://localhost:4001")],
        );
        assert!(matches!(result, Err(ConfigError::InvalidChildName { .. })));
    }

    #[test]
    fn a_child_colliding_with_an_explicit_route_is_a_duplicate() {
        let result = resolve_routes(
            Some("g.example.connector"),
            vec![route(
                "g.example.connector.billing",
                "http://localhost:9000",
            )],
            vec![child("billing", "http://localhost:4001")],
        );
        assert!(matches!(result, Err(ConfigError::DuplicatePrefix { .. })));
    }
}
