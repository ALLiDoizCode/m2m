# The operator surface splits read authority from write authority

Reads on the operator surface — inspection, metrics, anything a dashboard needs — are
authenticated with a bearer token. Writes — route CRUD, payment-channel operations, and
originating a packet — require an RFC 9421 HTTP Message Signature from a key on an operator
allowlist, with RFC 9530 Content-Digest binding the signature to the request body. No shared
secret can move value.

## Why

Under ADR 0006 the operator surface is how routes are set and how channels are opened, funded
and closed. It decides where value goes and moves funds on-chain, which puts it on the same
footing as the settlement code rather than on the footing of an inspection API.

Today it is guarded by an IP allowlist and an API key that the production template ships
commented out as a TODO, with the allowlist covering all of `172.16/12` and `192.168/16` — any
container on any bridge network. The template's own comment calls this belt-and-braces while
the belt is disabled.

Signatures rather than a token, for writes specifically, because a shared secret has no
attribution and no partial revocation: it cannot say which operator did a thing, and losing it
loses everything at once. A signature makes each write attributable, makes revocation a matter
of removing one key from a list, and makes the audit record the signature itself rather than a
log line asserting that something happened.

The mechanism already exists in the repository. `auth/rfc9421` implements signing, verification
and Content-Digest, and is used on the client edge to bind a claim to the request it pays for.
This points it at a second surface rather than introducing anything.

## Consequences

The split is what keeps a dashboard buildable. A read-only front end needs a token and nothing
else — no in-browser signing, no signing proxy — while the operations that matter stay behind
keys. Requiring signatures uniformly would have made the read surface materially harder to
consume for no security gain, since reads move nothing.

Network-level controls remain, but stop being the only control. The allowlist and an
unpublished port are defence in depth beneath authentication, not a substitute for it.
