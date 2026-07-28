# Connector

The bounded context of a node that forwards packets for payment. Terms only — decisions
live in `docs/adr/`.

## Language

### Forwarding

**Connector**:
A node that accepts a packet, decides where it goes, exchanges value for carrying it, and
hands it on. Never interprets the payload of a packet it forwards — opacity is a property of
carriage, not of the node. At a route termination the same node does interpret it, because
that is what terminating means.
_Avoid_: terminator, connector-as-terminator, gateway

**App**:
The payment-oblivious service a connector delivers to at the end of a route. It is told nothing
about the payment that brought the packet to it — not who paid, not how much, not even which
destination was addressed. Whatever arrives at one of its handlers was paid for, at that
handler's one price (ADR 0020).
_Avoid_: BLS, Business Logic Server, agent runtime, backend

**Handler**:
The app's receiving endpoint, and the unit a price attaches to: one handler, one price. An app
charges differently for different work by exposing a handler for each.

**Packet**:
The unit of forwarding: a destination, an amount, an expiry, and a payload that is opaque to
every hop that carries it. Every packet terminates in either fulfilment or rejection.

**Condition**:
A commitment minted by the sender and carried on the packet, naming what will count as proof of
delivery. Every packet carries a real one; a hop pays out only against something that satisfies it.
_Avoid_: execution condition (when the layer is already clear), hashlock

**Fulfilment**:
What satisfies a packet's condition, and so the proof that the packet was delivered. Value moves
on fulfilment and only on fulfilment. At a route termination the terminating connector produces
it; every hop upstream checks it and is paid against it.
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

**Controller**:
Whatever decides the connector's leased routes and peering. Outside the connector by
definition — the connector never learns, announces, or discovers.

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

**Route termination**:
The property of a route that ends at this connector, where a packet becomes a delivery to
an app. The point at which a payload stops being opaque: the terminating connector reads the
packet's envelope to know what request to make.

**Envelope**:
What a packet carries: going in, the request a terminating connector is to make of an app — a
method, a target, headers and a body; coming back, that app's response — a status, headers and a
body. One shape, two directions. It is a description of an HTTP message, not an HTTP message:
the app is handed ordinary HTTP, but nothing on the wire is text to be parsed.
_Avoid_: inner request, proxied request, HTTP envelope (when the layer is already clear),
response envelope (as a separate term — the response is an envelope)

**Gift wrap**:
The sealing of a packet's payload so that only its intended reader can open it. A sender seals to
the terminating connector's identity, and carries in the wrap the secret that packet's fulfilment
derives from; that connector seals its answer back with the same secret. Because no hop between
them can open either, opacity in carriage is a property of the packet rather than a rule every hop
is trusted to keep. A reject raised short of the termination cannot be sealed — no secret is shared
with the sender — which is what makes a sealed reject proof that the destination itself said no.
_Avoid_: encryption (when the layer is already clear), wrapper, seal

**Packet plane**:
The part of a connector on the path of every packet — routing, claim handling, forwarding.
_Avoid_: data plane, hot path

**Operator surface**:
The part of a connector that runs at human frequency — configuration, inspection,
lifecycle. Never on a packet's path.
_Avoid_: control plane, admin

### Protocol surfaces

**Peer wire**:
The protocol two connectors speak to each other. Both ends are operator-controlled.

**Client edge**:
The protocol a client speaks to the connector it attaches to. The far end is installed on
machines the operator does not control.
_Avoid_: client API, ingress

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

**Nonce**:
The counter that orders claims within a channel. A payee accepts a claim only if its nonce
advances.

**Watermark**:
The highest nonce a payee has accepted on a channel.

**Exposure**:
Value a payee has delivered but does not yet hold a claim for. One packet under normal flow;
more only when a payer has fulfilled packets and stopped claiming.

**Ceiling**:
The exposure a peering relation tolerates before the connector stops forwarding for that
peer.
_Avoid_: credit limit, debt limit

**Flush**:
Sending a claim that would otherwise have waited to travel with the next packet to that peer.
Bounds how long a payee's trailing exposure can persist when traffic stops.

**In flight**:
The state of a packet that has been forwarded but has neither fulfilled nor been rejected nor
expired. In-flight packets carry no value; value moves only on fulfilment.

**Projection**:
Money state derived by replaying claims and fulfilments — balances and exposure. Never a
source of truth, always rebuildable.

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

**Minimum delivery**:
The amount a packet declares must reach its destination. A hop that cannot meet it after its
fee rejects the packet rather than delivering less.

**Probe**:
A packet sent in the expectation that it will be rejected, in order to learn from the reject
what the path costs. Not a distinct kind of packet — only a way of using one.

**Settlement backend**:
The chain-specific implementation of opening, funding, closing and redeeming for one
chain.

### Storage

**Store**:
The storage node.
_Avoid_: DVM
