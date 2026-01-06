# Bug Bounty Program - M2M Payment Channels

**Program Status:** Pre-Launch (Documentation Ready)
**Platform:** Immunefi (DeFi-focused bug bounty platform)
**Network:** Base Sepolia (Testnet)
**Duration:** 4-6 weeks on testnet before mainnet
**Total Bounty Pool:** $50,000 USD (in stablecoins)
**Last Updated:** 2026-01-05

## Program Overview

M2M Payment Channels Bug Bounty Program rewards security researchers for responsibly disclosing vulnerabilities in our smart contracts and infrastructure. This program aims to identify and fix security issues before mainnet deployment.

**Program Goals:**

1. Identify critical vulnerabilities missed by formal audit
2. Test edge cases and real-world attack scenarios
3. Engage security community for crowdsourced security
4. Build trust with users through transparent security practices

**Important:** This bounty program is for the **testnet deployment only**. A separate mainnet bug bounty will launch after successful testnet completion.

## Scope

### In-Scope

**Smart Contracts (Base Sepolia Testnet):**

1. **TokenNetworkRegistry.sol**
   - Address: [To be filled after testnet deployment]
   - Functions: createTokenNetwork, whitelist management, ownership
   - Critical Areas: Access control, registry logic

2. **TokenNetwork.sol (USDC, DAI, etc.)**
   - Addresses: [To be filled after testnet deployment]
   - Functions: All payment channel functions
   - Critical Areas: Settlement logic, signature verification, reentrancy protection

**Focus Areas:**

- ✅ Funds custody and security
- ✅ Signature verification and replay protection
- ✅ Settlement calculations and balance accounting
- ✅ Access control and authorization
- ✅ Reentrancy and external call safety
- ✅ Integer overflow/underflow (Solidity 0.8+)
- ✅ DoS and griefing attacks
- ✅ Economic attack vectors
- ✅ Gas limit vulnerabilities
- ✅ Front-running and MEV concerns

### Out-of-Scope

**NOT Eligible for Rewards:**

- ❌ Issues in third-party contracts (OpenZeppelin, etc.)
- ❌ Issues already reported in audit
- ❌ Issues found in out-of-scope contracts (test mocks)
- ❌ Theoretical issues without proof of concept
- ❌ Gas optimization suggestions (unless causing DoS)
- ❌ Code quality issues (unless security-relevant)
- ❌ UI/UX issues in dashboard (separate bounty)
- ❌ Known limitations documented in README
- ❌ Social engineering attacks
- ❌ DDoS attacks on infrastructure

## Severity Classification

### Critical - $15,000 to $25,000

**Definition:** Direct loss of funds or complete contract compromise

**Examples:**

- Theft of funds from TokenNetwork contract
- Unauthorized access to user deposits
- Settlement calculation allowing fund extraction
- Signature verification bypass enabling unauthorized actions
- Reentrancy allowing double withdrawal
- Emergency recovery function accessible without pause
- Channel state manipulation leading to fund loss

**Requirements for Payout:**

- Proof of concept demonstrating exploit
- Clear steps to reproduce
- Impact assessment showing fund loss
- Suggested fix or mitigation

**Proof of Concept Required:** Yes, must demonstrate actual exploit

### High - $5,000 to $15,000

**Definition:** Significant vulnerability with clear exploit path

**Examples:**

- Unauthorized channel closure
- Balance proof replay across different channels
- DoS attack locking funds indefinitely
- Access control bypass (non-owner calling owner functions)
- Challenge period bypass
- Incorrect balance calculations (without fund loss)
- Force-close mechanism failure
- Whitelist bypass allowing unauthorized tokens

**Requirements for Payout:**

- Detailed vulnerability description
- Proof of concept code
- Impact assessment
- Suggested mitigation

**Proof of Concept Required:** Yes, code demonstrating vulnerability

### Medium - $1,000 to $5,000

**Definition:** Moderate risk vulnerability or edge case

**Examples:**

- Gas griefing attacks (excessive gas consumption)
- Event emission inconsistencies
- Missing input validation (limited impact)
- Timestamp manipulation edge cases
- Fee-on-transfer token issues (if not properly handled)
- EIP-712 signature malleability (without impact)
- Edge cases in channel expiry logic

**Requirements for Payout:**

- Clear vulnerability description
- Scenario demonstrating issue
- Impact assessment (even if limited)
- Suggested fix

**Proof of Concept Required:** Recommended but not mandatory

### Low - $100 to $1,000

**Definition:** Minor security issues with minimal impact

**Examples:**

- Missing error messages
- Suboptimal error handling
- Misleading function names (security-relevant)
- Documentation inconsistencies (security docs)
- Best practice violations (with potential security relevance)

**Requirements for Payout:**

- Clear description
- Security relevance explained
- Suggested improvement

**Proof of Concept Required:** No

### Informational - $0 (Acknowledgment Only)

**Definition:** Non-security issues or already-known limitations

**Examples:**

- Code quality suggestions
- Gas optimizations (without security impact)
- Stylistic improvements
- Duplicate submissions
- Known issues from audit

**Reward:** Public acknowledgment in security documentation

## Rewards and Payouts

### Reward Determination

**Factors Considered:**

1. **Severity** (Critical > High > Medium > Low)
2. **Impact** (Funds at risk, number of users affected)
3. **Quality** (Clear PoC, suggested fix, thoroughness)
4. **Novelty** (First to report gets full reward)
5. **Likelihood** (How realistic is exploitation)

**Payout Structure:**

- **Maximum Reward:** First reporter of valid Critical issue
- **Reduced Reward:** Duplicate reports (10% of original)
- **No Reward:** Out-of-scope, invalid, or duplicate issues

### Payment Process

**Payment Timeline:**

1. **Submission:** Researcher submits via Immunefi
2. **Triage:** M2M team reviews (within 24-48 hours)
3. **Validation:** Reproduce issue (within 72 hours)
4. **Severity:** Assign severity level (within 1 week)
5. **Fix:** Implement and test fix (timeline varies)
6. **Payout:** Transfer reward after fix verification

**Payment Methods:**

- USDC (primary)
- DAI
- ETH
- Wire transfer (for large amounts >$10k)

**Payment Address:** Researcher provides during submission

### Bounty Pool Allocation

**Total Pool:** $50,000 USD

**Allocation Strategy:**

```
Critical Reserve: $25,000 (up to 1-2 Critical findings expected)
High Reserve: $15,000 (up to 2-3 High findings expected)
Medium Reserve: $7,000 (up to 5-10 Medium findings expected)
Low Reserve: $3,000 (up to 20-30 Low findings expected)
```

**Pool Depletion:** If pool exhausted, program may pause or extend budget

## Responsible Disclosure Policy

### Disclosure Requirements

**DO:**

- ✅ Report via Immunefi platform: https://immunefi.com/bounty/m2m/
- ✅ Provide detailed vulnerability description
- ✅ Include proof of concept code
- ✅ Suggest mitigation or fix
- ✅ Allow M2M team time to fix (90 days before public disclosure)
- ✅ Disclose to M2M first (not public)

**DO NOT:**

- ❌ Publicly disclose vulnerability before fix
- ❌ Exploit vulnerability on mainnet (testnet only)
- ❌ Attempt to extract funds from other users
- ❌ DoS attack production infrastructure
- ❌ Access private user data
- ❌ Violate laws or regulations

### Disclosure Timeline

**Recommended Timeline:**

1. **Day 0:** Researcher submits vulnerability
2. **Day 1-2:** M2M team acknowledges receipt
3. **Day 3-7:** M2M team validates and assigns severity
4. **Day 7-30:** M2M team develops and tests fix
5. **Day 30-60:** Re-audit of fix (if Critical/High)
6. **Day 60-90:** Deploy fix to testnet/mainnet
7. **Day 90+:** Public disclosure (coordinated with researcher)

**Researcher Rights:**

- Public disclosure after 90 days (if M2M non-responsive)
- Earlier disclosure if agreed with M2M team
- Credit in security advisories and acknowledgments

## Submission Guidelines

### How to Submit

**Primary Channel:** Immunefi Platform

- URL: https://immunefi.com/bounty/m2m/ (will be created)
- Account Required: Yes (create free Immunefi account)
- Encrypted: Yes (end-to-end encrypted submissions)

**Backup Channel:** Email (if Immunefi unavailable)

- Email: security@m2m.com
- PGP Key: [To be provided]
- Encrypt sensitive information

### Submission Template

````markdown
# Vulnerability Report

## Summary

[Brief 1-2 sentence description]

## Severity Assessment

[Your assessment: Critical/High/Medium/Low]

## Vulnerability Details

### Affected Contract

- Contract Name: TokenNetwork
- Contract Address: 0x...
- Function: settleChannel()
- Lines: 550-650

### Description

[Detailed technical description of the vulnerability]

### Root Cause

[Why does this vulnerability exist?]

### Impact

[What can an attacker do? How much funds at risk?]

## Proof of Concept

### Setup

[Prerequisites and environment setup]

### Exploit Code

```solidity
// Foundry test demonstrating the exploit
function testExploit() public {
    // Step 1: Setup
    // Step 2: Exploit
    // Step 3: Verify impact
}
```
````

### Reproduction Steps

1. [Step 1]
2. [Step 2]
3. [Expected result showing vulnerability]

## Suggested Fix

### Proposed Mitigation

[How to fix the vulnerability]

### Code Changes

```solidity
// OLD (vulnerable)
function vulnerable() external {
    // vulnerable code
}

// NEW (fixed)
function fixed() external {
    // fixed code
}
```

### Additional Recommendations

[Any other security improvements]

## References

- [Link to similar vulnerability]
- [Link to relevant documentation]

## Contact Information

- Name: [Optional]
- Email: [Required for payout]
- Telegram/Discord: [Optional]
- Payment Address: [USDC/DAI/ETH address]

```

### Submission Quality Guidelines

**High-Quality Submission:**
- ✅ Clear and concise description
- ✅ Working proof of concept
- ✅ Accurate severity assessment
- ✅ Suggested fix included
- ✅ Professional formatting
- ✅ Relevant references cited

**Low-Quality Submission:**
- ❌ Vague description ("contract has bug")
- ❌ No proof of concept
- ❌ Theoretical issue without demonstration
- ❌ Incorrect severity assessment
- ❌ Duplicate of known issue

## Rules and Legal

### Eligibility

**Eligible Participants:**
- ✅ Security researchers worldwide
- ✅ Individual researchers
- ✅ Security research teams
- ✅ White hat hackers
- ✅ Academic researchers

**Ineligible Participants:**
- ❌ M2M team members and contractors
- ❌ Audit firm employees (primary audit firm)
- ❌ Family members of M2M team
- ❌ Individuals in countries with sanctions

### Terms and Conditions

**By Participating, You Agree:**
1. To follow responsible disclosure guidelines
2. To not exploit vulnerabilities beyond testnet PoC
3. To not violate laws or regulations
4. To allow M2M to use your findings for security improvements
5. To coordinate public disclosure with M2M team
6. To provide accurate contact information
7. That M2M's decision on severity and payout is final

**M2M Reserves the Right To:**
- Modify bounty amounts based on impact
- Refuse payment for out-of-scope issues
- Refuse payment for duplicate submissions
- Pause program if budget exhausted
- Extend program timeline if needed
- Request additional information from researcher

### Safe Harbor

**M2M Commits:**
- No legal action against researchers following responsible disclosure
- No action under CFAA (Computer Fraud and Abuse Act) for testnet testing
- Acknowledgment of your contribution (if desired)
- Prompt response to submissions
- Fair assessment of severity and impact

**Protection Extends To:**
- Testing on Base Sepolia testnet only
- Vulnerabilities disclosed responsibly
- Research conducted in good faith
- No harm to other users or systems

## Program Logistics

### Launch Timeline

**Pre-Launch (Current):**
- [ ] Create Immunefi program page
- [ ] Deploy contracts to Base Sepolia
- [ ] Fund bounty wallet (multisig)
- [ ] Test submission process
- [ ] Announce on social media

**Launch (After Testnet Deployment):**
- [ ] Publish program on Immunefi
- [ ] Tweet announcement
- [ ] Post on Discord/Telegram
- [ ] Email security researchers
- [ ] Monitor submissions

**Duration:**
- **Testnet Phase:** 4-6 weeks minimum
- **Extensions:** Possible based on findings
- **Mainnet Phase:** Separate program after testnet success

### Program Management

**Response Team:**
- **Primary Contact:** security@m2m.com
- **Security Lead:** [Name]
- **Smart Contract Developer:** [Name]
- **Audit Liaison:** [Contact from audit firm]

**Response Times:**
- **Acknowledgment:** Within 24 hours
- **Triage:** Within 48 hours
- **Validation:** Within 72 hours (Critical/High)
- **Severity Assessment:** Within 1 week
- **Payout:** Within 2 weeks of fix verification

### Communication Channels

**Updates:**
- Twitter: @M2MProtocol
- Discord: [Link]
- Blog: https://m2m.com/blog
- Immunefi: [Program page]

**Researcher Support:**
- Technical Questions: security@m2m.com
- Payment Questions: bounty@m2m.com
- Urgent Issues: Discord #bug-bounty channel

## Frequently Asked Questions

### Q: Can I submit issues found in previous audit?
**A:** No, audit findings are out-of-scope. Only new issues are eligible.

### Q: Can I test on mainnet?
**A:** No, only Base Sepolia testnet. Mainnet testing is not authorized.

### Q: What if I find a Critical issue?
**A:** Submit immediately via Immunefi. Do NOT exploit or disclose publicly.

### Q: How long until payout?
**A:** 1-2 weeks after fix verification for High/Critical. Up to 4 weeks for Medium/Low.

### Q: Can I remain anonymous?
**A:** Yes, but you must provide payment address and email for communication.

### Q: What if two researchers submit same issue?
**A:** First valid submission receives full reward. Duplicates receive 10% (if submitted within 24h).

### Q: Can I submit multiple vulnerabilities?
**A:** Yes! Each unique vulnerability is assessed separately.

### Q: Do gas optimizations count?
**A:** Only if they have security relevance (e.g., gas griefing DoS).

### Q: What about theoretical attacks?
**A:** Proof of concept required for High/Critical. Medium/Low can be theoretical.

### Q: Can audit firm participate?
**A:** No, primary audit firm employees are ineligible.

## Resources for Researchers

### Contract Documentation

**Source Code:**
- GitHub: https://github.com/m2m/payment-channels
- Tag: `v1.0.0-testnet`

**Documentation:**
- Architecture: docs/architecture/
- Audit Report: docs/audits/
- Test Suite: packages/contracts/test/

### Testing Environment

**Base Sepolia:**
- RPC: https://sepolia.base.org
- Explorer: https://sepolia.basescan.org
- Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet

**Deployed Contracts:**
- TokenNetworkRegistry: [To be filled]
- USDC TokenNetwork: [To be filled]
- DAI TokenNetwork: [To be filled]

**Test Tokens:**
- Test USDC: [To be filled] (faucet available)
- Test DAI: [To be filled] (faucet available)

### Security Research Tools

**Recommended Tools:**
- Foundry: https://book.getfoundry.sh
- Slither: https://github.com/crytic/slither
- Mythril: https://github.com/ConsenSys/mythril
- Echidna: https://github.com/crytic/echidna
- Manticore: https://github.com/trailofbits/manticore

### Past Vulnerabilities (Educational)

**Similar Projects:**
- Raiden Network: Payment channel vulnerabilities
- Lightning Network: Channel jamming attacks
- State Channel exploits: Historical examples

## Success Metrics

**Program Success Indicators:**
- Number of valid submissions received
- Critical/High issues identified and fixed
- Researcher satisfaction (survey after program)
- Community engagement (social media reach)
- Zero fund loss incidents

**Expected Outcomes:**
- 10-20 total submissions
- 0-2 Critical findings
- 2-5 High findings
- 5-10 Medium findings
- Improved security confidence before mainnet

---

**Program Launch Date:** [To be filled after testnet deployment]
**Program End Date:** [4-6 weeks from launch]
**Next Update:** After testnet deployment
**Contact:** security@m2m.com

**Stay Updated:**
- Twitter: [@M2MProtocol](https://twitter.com/M2MProtocol)
- Discord: [Link]
- Blog: [Link]
```
