# Claude Instructions for M2M Project

## Automatic Skill Usage

This project contains specialized RFC skills for Interledger Protocol specifications. **Automatically activate the relevant skill** when users ask questions related to any of these topics:

### RFC Skills Reference

1. **rfc-0001-interledger-architecture**
   - Topics: Interledger architecture, protocol layers, payment routing, ledger abstraction, system design
   - Triggers: "how Interledger works", "ILP architecture", "protocol stack", architectural concepts

2. **rfc-0009-simple-payment-setup-protocol**
   - Topics: Simple Payment Setup Protocol (SPSP), payment setup, receiver endpoints
   - Triggers: "SPSP", "payment setup", "receiver", payment initialization

3. **rfc-0015-ilp-addresses**
   - Topics: ILP addressing scheme, address format, hierarchical addressing
   - Triggers: "ILP address", "addressing", "address format", routing addresses

4. **rfc-0018-connector-risk-mitigations**
   - Topics: Connector security, risk management, fraud prevention
   - Triggers: "connector risk", "security", "fraud prevention", risk mitigation

5. **rfc-0019-glossary**
   - Topics: Interledger terminology, definitions, concept explanations
   - Triggers: "what is", "define", "terminology", "glossary"

6. **rfc-0022-hashed-timelock-agreements**
   - Topics: HTLAs, conditional payments, timelock mechanisms
   - Triggers: "HTLA", "hashed timelock", "conditional payment", escrow

7. **rfc-0023-bilateral-transfer-protocol**
   - Topics: BTP, bilateral transfers, ledger plugin protocol
   - Triggers: "BTP", "bilateral transfer", "ledger plugin"

8. **rfc-0026-payment-pointers**
   - Topics: Payment pointers, payment identifiers, addressing users
   - Triggers: "payment pointer", "$", payment identifier

9. **rfc-0027-interledger-protocol-4**
   - Topics: ILPv4, core protocol, packet format, routing, error codes
   - Triggers: "ILPv4", "ILP packet", "protocol format", "routing"

10. **rfc-0029-stream**
    - Topics: STREAM protocol, streaming payments, transport layer, flow control
    - Triggers: "STREAM", "streaming payment", "transport protocol", flow control

11. **rfc-0030-notes-on-oer-encoding**
    - Topics: OER encoding, data serialization, encoding format
    - Triggers: "OER", "encoding", "serialization", data format

12. **rfc-0031-dynamic-configuration-protocol**
    - Topics: Dynamic configuration, ILDCP, address discovery
    - Triggers: "ILDCP", "dynamic configuration", "address discovery"

13. **rfc-0032-peering-clearing-settlement**
    - Topics: Peering relationships, clearing, settlement processes
    - Triggers: "peering", "clearing", "settlement", connector relationships

14. **rfc-0033-relationship-between-protocols**
    - Topics: Protocol interactions, layer relationships, protocol stack
    - Triggers: "protocol relationships", "how protocols interact", protocol layers

15. **rfc-0034-connector-requirements**
    - Topics: Connector specifications, requirements, implementation guidelines
    - Triggers: "connector requirements", "connector implementation", connector specs

16. **rfc-0035-ilp-over-http**
    - Topics: HTTP transport, ILP over HTTP, transport bindings
    - Triggers: "ILP over HTTP", "HTTP transport", transport layer

17. **rfc-0038-settlement-engines**
    - Topics: Settlement engines, settlement API, payment settlement
    - Triggers: "settlement engine", "settlement API", settlement integration

18. **rfc-0039-stream-receipts**
    - Topics: STREAM receipts, payment receipts, proof of payment
    - Triggers: "receipt", "STREAM receipt", "proof of payment"

## Behavior Guidelines

- **Proactive Skill Activation**: When a user mentions any of the topics or trigger words above, immediately activate the corresponding skill without asking
- **Multiple Skills**: If a question spans multiple RFCs, activate all relevant skills
- **MCP Tool Usage**: Skills use the `mcp__interledger_org-v4_Docs__search_rfcs_documentation` tool to fetch authoritative information
- **Authoritative Answers**: Always base answers on the official RFC documentation accessed through skills
- **Cross-References**: When RFCs reference each other, mention related skills that might provide additional context

## Example Interactions

**User asks:** "How does STREAM work with ILPv4?"
**Action:** Activate both `rfc-0029-stream` and `rfc-0027-interledger-protocol-4` skills

**User asks:** "What's the payment pointer format?"
**Action:** Activate `rfc-0026-payment-pointers` skill

**User asks:** "Explain the Interledger architecture"
**Action:** Activate `rfc-0001-interledger-architecture` skill

## Important Notes

- Skills contain the most up-to-date and accurate information from the official Interledger RFCs
- Always prefer skill-based answers over general knowledge for RFC-related questions
- Skills automatically use MCP tools to fetch the latest documentation
