# Property tests over a pure core; fakes are allowed, mocks are not

Testing runs in three tiers: property tests over `connector-core`, which has no I/O at all;
contract tests defined once per port and run against every implementation of it; and
integration tests against real chains, only where a chain is genuinely involved. An
implementation that upholds a port's contract and passes its contract suite is a legitimate
test subject. A stub that asserts a sequence of calls is not, and stays banned.

## Why this replaces "never use mocks"

The existing rule is emphatic and was right for the code it governed: when every path needs a
chain, a socket and a database to execute, mocks are the only alternative to slow tests, and
mocks in money code are worse than slow tests. But it treated the symptom. Nothing could be
tested cheaply because nothing was pure, and the result is 72,433 lines of test code — more
than the source — with a Docker chain in the loop for changes to arithmetic.

Extracting `connector-core` removes the premise. Route selection, claim validation, nonce and
watermark rules, the balance projection, ceiling arithmetic and expiry are all decidable from
values alone. They are tested exhaustively in milliseconds by not needing I/O, rather than by
pretending to have it.

The rule also failed to distinguish two very different things. `InMemoryLedgerClient` was
never a mock: it is a working implementation of a contract, and it shipped to production as
the only ledger anyone actually ran. The line that matters is not real-versus-fake, it is
whether the thing under test upholds a contract or merely replays a script.

## Consequences

Every port owes a contract suite before it owes a second implementation. The suite is the
definition of the port; an implementation that has not passed it is not an implementation.
This is also what makes an in-memory backend safe to trust — it is held to the same statements
as the real one.

Integration tests shrink to the cases where chain behaviour is the thing under test: gas
estimation, nonce conflicts, reorgs, confirmation semantics. Everything that merely _involves_
a chain incidentally moves down a tier.
