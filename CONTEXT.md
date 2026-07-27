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
The payment-oblivious service a connector delivers to at the end of a route.
_Avoid_: BLS, Business Logic Server, agent runtime, backend

**Handler**:
The app's receiving endpoint.

**Packet**:
The unit of forwarding: a destination, an amount, an expiry, and a payload that is opaque to
every hop that carries it. Every packet terminates in either fulfilment or rejection.

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

**Route termination**:
The property of a route that ends at this connector, where a packet becomes a delivery to
an app. The point at which a payload stops being opaque: the terminating connector reads the
packet's envelope to know what request to make.

**Envelope**:
The HTTP request carried in a packet's payload — a method, a target, headers and a body — that
a terminating connector makes to the app. Read only at a route termination; a forwarding hop
carries it without looking inside.
_Avoid_: inner request, proxied request, HTTP envelope (when the layer is already clear)

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
carriage, a price buys the thing at the end.

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
