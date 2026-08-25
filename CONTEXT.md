# Connector

The bounded context of a node that forwards packets for payment. Terms only — decisions
live in `docs/adr/`.

**The connector terminates payments the way nginx terminates SSL.** Value arrives wrapped in a
protocol the app never speaks; at the last hop the connector unwraps it, verifies it, and hands the
app ordinary HTTP that was already paid for. Read the rest of this glossary through that sentence.
A **route termination** is where the unwrapping happens, the **app** is the origin server behind
it, and the connector in front is a paid reverse proxy — not a library the app imports, and not a
role of its own beside the two.

## Language

### Forwarding

**Connector**:
A node that accepts a packet, decides where it goes, exchanges value for carrying it, and
hands it on. Never interprets the payload of a packet it forwards — opacity is a property of
carriage, not of the node. At a route termination the same node does interpret it, because
that is what terminating means.
_Avoid_: terminator, connector-as-terminator, gateway

**App**:
The payment-oblivious service a connector delivers to at the end of a route. It settles nothing,
holds no channel and is never told which destination was addressed. It IS told who paid, how much
and on what chain — `X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain`, from the client claim the
delivering connector verified itself (ADR 0040) — and told none of the three when that connector
was not the one paid. Either way, whatever arrives at one of its handlers was paid for, at that
handler's one price (ADR 0020).
_Avoid_: BLS, Business Logic Server, agent runtime, backend

**Handler**:
The app's receiving endpoint, and the unit a price attaches to: one handler, one price. An app
charges differently for different work by exposing a handler for each.

**Description**:
Operator-written text saying what the work behind a route is. Attaches exactly where a price
attaches — one handler, one description — comes from the connector's own configuration and from
nowhere else, and rides both the greeting and a probe's reject. A menu, not a warranty: whoever
reads one is reading text from a stranger. _(Decided and not yet built — ADR 0044.)_

**Packet**:
The unit of forwarding: a destination, an amount, an expiry, and a payload that is opaque to
every hop that carries it. Every packet terminates in either fulfilment or rejection.

**Condition**:
A commitment minted by the sender and carried on the packet, naming what will count as proof of
delivery. Every packet carries a real one; a hop pays out only against something that satisfies it.
_Avoid_: execution condition (when the layer is already clear), hashlock

**Fulfilment**:
What satisfies a packet's condition, and so the proof that the packet was delivered to its
intended receiver. It proves delivery; it does not move value — a packet carries its own claim.
At a route termination the terminating connector produces it; every hop upstream checks it.
_Avoid_: receipt, proof of payment, preimage (when the layer is already clear)

**Route**:
A mapping from a destination prefix to the next hop that should carry it.

**Static route**:
A route given to the connector by its configuration. Durable across restarts, and always
beats a leased route for the same prefix.

**Leased route**:
A route pushed in by a controller with a time limit, which lapses unless renewed. Expiry is
the mechanism by which a route to an unreachable peer stops being used.
_Avoid_: learned route, dynamic route

**Runtime route**:
A route or peer written through the operator surface that survives a restart — the third shape
beside static and leased. Durable like a static route, mutable like a leased one, and never able to
take a key the config file owns: a colliding write is refused outright rather than shadowing or
being shadowed.

**Controller**:
Whatever decides the connector's leased routes and peering. Outside the connector by
definition — the connector never learns, announces, or discovers.

**Operator**:
The human or organisation that runs a connector. Owns the config file, the identity key and the
operator surface, and is the only party that creates a peering or publishes a route. Distinct from
a **controller**, which is automation an operator points at a connector; and distinct from the
connector itself, which decides nothing the operator did not write down. Some verbs belong to the
operator and not to the process: announcing is one.

**Announcing**:
Pushing facts about yourself into a network unprompted. A connector never does this: deciding to
participate in a discovery network is the controller's business.
_Distinct from_: answering, which a connector does do.

**Answering**:
Telling whoever asks what your own configuration already says — your identity, and what a route of
yours costs. Mechanism, not policy: it decides nothing, and reaches nobody who did not ask. A
sender asks directly and pays through the network, so what it learns by asking is not something an
intermediary can substitute.
_Avoid_: discovery (for this — a connector answers, it does not discover)

**Greeting**:
What a connector answers an unpaid request to a priced route with: that route's terms — what it
costs and what is needed to pay it — instead of the work. This is what makes a connector that sells
safe to be reachable at all, because the unpaid case gets a defined, useful, unpaid answer rather
than free service.
_Avoid_: 402, x402 (those name the carrier, not the thing)

**Route termination**:
The property of a route that ends at this connector, where a packet becomes a delivery to
an app. The point at which a payload stops being opaque: the terminating connector reads the
packet's envelope to know what request to make.

**Client destination**:
An address that resolves to a live client session rather than to a handler. The connector delivers
to that client and never terminates: it does not open the payload, does not derive a fulfilment,
and takes back the one the client produced or rejects the packet. A destination is never both this
and a route termination — an overlap is a reported configuration error, not a precedence question.

**Envelope**:
What a packet carries: going in, the request a terminating connector is to make of an app — a
method, a target, headers and a body; coming back, that app's response — a status, headers and a
body. One shape, two directions. It is a description of an HTTP message, not an HTTP message:
the app is handed ordinary HTTP, but nothing on the wire is text to be parsed.
_Avoid_: inner request, proxied request, HTTP envelope (when the layer is already clear),
response envelope (as a separate term — the response is an envelope)

**Target**:
The path inside an envelope, naming which of an app's endpoints the request is for. Always resolved
_beneath_ the route's own configured handler path, never in place of it — so a packet can address
more of an app than one entry point, and can never reach a neighbouring route to buy its work at
this route's price.

**Gift wrap**:
The sealing of a packet's payload so that only its intended reader can open it. A sender seals to
the terminating connector's identity, and carries in the wrap the secret that packet's fulfilment
derives from; that connector seals its answer back with the same secret. Because no hop between
them can open either, opacity in carriage is a property of the packet rather than a rule every hop
is trusted to keep. A reject raised short of the termination cannot be sealed — no secret is shared
with the sender — which is what makes a sealed reject proof that the destination itself said no.
The converse does not hold: an **unsealed** reject proves nothing about who refused, because a
termination that never recovered the secret — no identity key, or a wrap it could not open — also
answers in plaintext. Sealed identifies the destination; unsealed identifies nobody.
_Avoid_: encryption (when the layer is already clear), wrapper, seal

**Identity key**:
The key that names a connector to everyone outside it. A sender seals to it, so it is what makes a
packet deliverable at all; and because a fulfilment derives from what it opens, it is load-bearing
for payment and not only for confidentiality. Rotating it invalidates conditions already minted
against the old one.

**Packet plane**:
The part of a connector on the path of every packet — routing, claim handling, forwarding.
_Avoid_: data plane, hot path

**Operator surface**:
The part of a connector that runs at human frequency — configuration, inspection,
lifecycle. Never on the path of a packet it did not originate. The exception is the whole of
it: `POST /packets` puts a packet on the path, because originating one is an operator act and
not carriage. What makes that safe is authentication rather than payment — an operator does not
pay their own connector, so the credential is a **write key** and never a **covering claim**.
_Avoid_: control plane, admin

### Protocol surfaces

**Peering**:
The configured bilateral relationship between two connectors: a counterparty key, a carriage to
reach it on, a fee, and a cap. Created by an **operator** — in the config file or through the
operator surface — and by nothing else. It cannot be bought, learned, earned or announced into
existence.

**Peer semantics**:
What a peer interaction _means_ — claim exchange, fees, reject codes,
accumulated cost. Both ends are operator-controlled. Says nothing about where the bytes ride:
that is carriage, below.
_Avoid_: peer wire (it named a deleted transport and this layer at once; see ADR 0027)

**Peer carriage**:
Where a peer interaction's bytes ride. There are two, and a connector may expose both: **BTP**
over `wss://`, and **ILP-over-HTTP** over `https://` — the same two the client edge already
serves. Which one a connector exposes, and which it dials for a given peer, is operator policy,
never a protocol constant. Below the transport port there is one pipeline: a PREPARE that arrived
over HTTP is indistinguishable from one that arrived over BTP, and peer behaviour that exists on
one carriage and not the other is a defect rather than a property of the carriage.
_Avoid_: peer wire, peer transport (when the layer is already clear)

**Interaction**:
The unit a role attaches to: one BTP session, from its websocket upgrade to its close, or one
HTTP request.

**Peer role**:
The authority of one interaction — `peer` or `client`. Decided by authentication, never by which
listener the bytes arrived on: an interaction is a `peer` only if it is bound to a configured peer
id and carries a claim on one of that peer's channels that verifies against the counterparty key
that peering configures. There is no third role, no unroled state, and no fallthrough — anything
that is not a proven peer is a client.
_Avoid_: peer wire, peer session (for the role rather than the connection)

**Client edge**:
The protocol a client speaks to the connector it attaches to. The far end is installed on
machines the operator does not control.
_Avoid_: client API, ingress

**Vector**:
A committed input/output pair — a wrapped packet, an envelope, a condition, the fulfilment it
derives — that every implementation replays as its own suite. Vectors are generated from the
properties, never captured from whatever an implementation happened to emit, and reproducing them
is what conformance means. Prose describing the wire is not normative; these are.
_Avoid_: fixture, golden file, test case (when the cross-repo contract is what is meant)

**Peer wire** _(retired term, [ADR 0027](docs/adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md), issue #679)_:
One word for three things: a raw-TCP transport, the semantics layer riding on it, and the
direction an arrival came from. The transport was deleted and never carried a production packet;
the other two are **peer carriage** and **peer role** above. Retired rather than renamed, because
each sense needed a different word. Still appears, deliberately, in three places: ADR bodies and
five ADR filenames, which are historical records and do not move; `peer_wire_addr`, which
`connector-config` parses **solely to reject** an old config that still sets it; and
`STORE_PEER_WIRE_BIND` in `infra/`, the same tombstone convention. Deleting either identifier
would let a stale config load with the key silently ignored.

### Value

**Payment channel**:
A two-party agreement, anchored on a chain, that lets value move between the parties many
times while touching the chain only to open, top up, and close.
_Avoid_: channel (when ambiguous with a route or a stream)

**Claim**:
A signed statement of a payment channel's cumulative state, handed from payer to payee.
Each claim supersedes the last, so a lost claim costs nothing and a replayed claim gains
nothing.
_Avoid_: receipt, voucher, payment, balance proof

**Covering claim**:
The claim that pays for one particular packet, carried **with** it rather than trailing behind it.
A packet arriving without one is greeted, not carried. This is what removes accumulation from the
model: nothing is ever owed between packets, so there is no window for a counterparty to walk away
inside. Enforced today at the client edge and at a priced termination; the forwarded case is decided
and not yet enforced (ADR 0042).

**Nonce**:
The counter that orders claims within a channel. A payee accepts a claim only if its nonce
advances.

**Watermark**:
The highest nonce a payee has accepted on a channel.

**Exposure** _(retired term, [ADR 0033](docs/adr/0033-the-exposure-machinery-is-retired-not-restated.md), issue #882)_:
Value a payee had delivered but did not yet hold a claim for, under the pre-#868 credit window.
One packet under normal flow; more only when a payer had fulfilled packets and stopped claiming.
Retired by ADR 0033: nothing tracks it, and no projection produces it. The reasoning was that a packet
would carry its own claim (ADR 0042) and so leave nothing trailing — **true today at a priced
termination, and not yet built for a forwarded arrival**, which is why the retirement is stated on ADR
0033's own terms rather than on that one's. Kept here because the term still appears in historical
prose (`docs/protocol/peer-semantics-pre-868.md` §3.2–§3.4, §5.3; [`docs/protocol/money-model-pre-868.md`](docs/protocol/money-model-pre-868.md)).

**Ceiling** _(retired term, ADR 0033, issue #882)_:
The exposure a peering relation tolerated before the connector stopped forwarding for that
peer. Retired along with exposure, above. Not to be confused with the **cap** below, which
bounds one packet rather than an accumulation.
_Avoid_: credit limit, debt limit

**Cap**:
The largest amount a connector will forward to one peer in a single packet. A packet needing
more is refused with `T04`, never carried and never split — and that reject's message states the
cap, which is the only way a sender learns it. Bounds a single packet, not an accumulation — there
is no accumulation, because a packet carries its own claim. The cap is how far a connector trusts a
peer, expressed as the most it is willing to lose in one theft; the number comes from outside the
connector, which never raises its own (ADR 0049).
_Avoid_: ceiling, limit, liquidity bound

**Flush** _(retired term, ADR 0033, issue #882)_:
Sending a claim that would otherwise have waited to travel with the next packet to that peer.
Bounded how long a payee's trailing exposure could persist when traffic stopped; retired along
with exposure, above. Not to be confused with `peer-carriage-spec.md` §6.4's still-live
`Toon-Flush-Requested` hint, which prompts a payer but binds nothing.

**In flight**:
The state of a packet that has been forwarded but has neither fulfilled nor been rejected nor
expired. An in-flight packet carries value — its claim rides with it — so value is at risk
between the forward and its outcome. Bounding that risk is the sender's business, not the
protocol's: small packets, and larger ones only on a path that has earned it.

**Journal**:
The durable record of what was signed or is otherwise irreversible — claims sent, claims accepted,
and the watermarks that came with them. It is the only money state the connector persists, which is
why recovery is replay rather than reconciliation between two stores that can disagree.

**Projection**:
Money state derived by replaying the journal — per-peer balances. Never a source of truth, always
rebuildable. (It once projected **exposure** as well; that is retired, ADR 0033.)

**Settlement**:
Making a claim's promised value real on-chain, by redeeming the latest claim or by
cooperative close. Rare and deliberate — the opposite of claims, which are constant and
automatic.
_Avoid_: payout, redemption (as a synonym for the whole act)

**Fee**:
What a connector charges to carry one packet across one peering relation. Flat per packet,
not proportional to the amount carried.
_Avoid_: spread, commission, rate

**Price**:
What a terminated route charges for the work the app does. Distinct from a fee — a fee buys
carriage, a price buys the thing at the end. Flat per packet, as a fee is: it does not vary with
the payload, so one probe answers what a route costs until the price itself changes. Pricing
granularity is handler granularity: an operator publishes a route per handler, and charges
differently for different work by pointing at a different handler — never by letting one route's
price vary with what the packet holds. That is how a connector prices without ever interpreting
what it carries.

**Cost**:
What a caller must send for a packet to be delivered: the fees of every hop that carries it, plus
the price of the route that terminates it. A reject states the cost of the path it travelled,
which is how a probe discovers it. The sum only — never the per-hop breakdown, and never the
split between fees and price.
_Avoid_: total fee, quote

**Minimum delivery** _(retired term, [ADR 0057](docs/adr/0057-minimum-delivery-is-retired-a-claim-bounds-erosion.md), issue #1143)_:
The amount a packet declared must reach its destination, checked by every hop after its own fee
and answered with `R01` when it could not be met. Retired: once a packet carries the claim that
pays for it (ADR 0042), the covering claim is already banked when a hop evaluates the floor, so
rejecting on it returns the sender nothing and only moves where the packet dies. What bounds
erosion is the claim itself — a hop mints one for the packet's **forwarded** value, so it holds a
claim for at least what it passes on, and that chains. The field, both its carriage bindings and its
two vectors are all deleted. `R01` is **not**: only its floor meaning went, and the code still
answers RFC 0027's own case — a hop's fee alone exceeding the arriving amount, so nothing would be
forwarded (ADR 0057 as corrected, ADR 0051). Kept here because the term still appears in historical prose
(`docs/protocol/peer-semantics-pre-868.md` §4, §5.1;
[`docs/protocol/money-model-pre-868.md`](docs/protocol/money-model-pre-868.md)) and in clauses
marked retired.
_Avoid_: floor, guaranteed delivery, minimum amount

**Probe**:
A packet sent in the expectation that it will be rejected, in order to learn from the reject
what the path costs. Not a distinct kind of packet — only a way of using one.

**Signer**:
What holds a connector's keys and signs with them — claims, settlement transactions, operator
writes. A local key or a key-management backend, with rotation, and nothing more: no mnemonic
recovery, no seed management, no human authentication. Those belong to an end-user wallet, which a
connector is not.
_Avoid_: wallet, key manager, custody

**Settlement backend**:
The chain-specific implementation of opening, funding, closing and redeeming for one
chain.

### Storage

**Store**:
The storage node.
_Avoid_: DVM

### Operations

**Breaking deploy**:
A build that makes a configuration a box already runs invalid — a new required key, a renamed
field, a narrowed type. It may never ride an automatic tag move: either the change is made
backward-compatible first, or a promotion lands the config before the image.

**Promotion**:
Moving the tag a box follows to one specific build, deliberately. The only moment at which a
candidate image and the fleet's committed configuration are in the same place, and therefore the
only place a breaking deploy can be caught.
