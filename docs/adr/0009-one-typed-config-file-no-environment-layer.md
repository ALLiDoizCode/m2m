# Configuration is one typed file with no environment-variable layer

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

The connector reads a single configuration file, deserializes and validates it once at boot,
and holds the result as an immutable value for the process lifetime. There is no
environment-variable override layer. Secrets are referenced by location — a file path or a key
management identifier — and never written inline.

## Why

Two configuration surfaces means a precedence model, and a precedence model means a class of
bug where the deployed value is not the value anyone read. The existing connector carries 2,600
lines of configuration types, a 1,227-line loader, a 567-line environment validator and 56
distinct environment variables — and the devnet boxes are configured with hand-tuned
bind-mounted YAML that uses none of them. The environment layer is a maintained surface with no
users.

Validating once into an immutable value also removes a whole category of question at every
call site. Nothing downstream asks whether a field is present, in range, or mutually consistent
with another field, because a configuration that reaches the runtime has already answered that.
Anything genuinely operational — routes, channels, peers — changes through the operator surface
instead, where the change is authenticated and audited.

## Consequences

Desugaring happens at load. The existing `child-expander` already establishes the pattern:
a `children:` block is expanded into ordinary routes before the routing table exists, "so the
packet path stays topology-blind". Every convenience in the file is resolved the same way, and
the runtime sees only primitives. Complexity is absorbed at the boundary rather than carried
into the core.

Every deployment needs a mounted file, which is already how these nodes are deployed. Purely
environmental configuration is no longer possible, and that is intentional.

Reload is a restart. Since the configuration value is immutable, changing the file means
restarting the process — acceptable because the things that need to change while running have
been moved to the operator surface by design.
