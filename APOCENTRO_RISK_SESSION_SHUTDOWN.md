# Apocentro — Risk Assessment: Session Foundation Bankruptcy / Shutdown

> What breaks for Apocentro if **Session Foundation** dissolves, runs out of money,
> or shuts down its infrastructure — and what we can do about it. Grounded in the
> actual hardcoded dependencies in the codebase (file references included).

---

## 0. Executive summary

- **Apocentro is a fork of Session and rides Session/Oxen infrastructure.** A
  Session shutdown is a **real, material risk** — but **not a single cliff**. It
  splits into two very different failure modes:
  1. **Centralized helper servers go dark** (seed nodes, file server, push, TURN).
     → Partial, *fixable* breakage. We can self-host replacements.
  2. **The decentralized snode network itself collapses** (token economy dies →
     node operators leave). → **Existential.** This is the one that can kill
     Apocentro, and it is the hardest to mitigate inside the current design.
- **Key nuance:** the snode network is **not run by the Foundation directly** — it
  is operated by independent operators who stake the Session Token (formerly OXEN).
  So the Foundation can fail while the network limps on… *for a while*. The token
  losing all value is what eventually empties the network.
- **Strategic escape hatch:** because Apocentro is a **closed ecosystem**, it does
  **not** actually need the global incentivized network. We can run our **own
  permissioned set of storage/relay nodes** and cut the cord from Session/Oxen
  entirely. This is the single most important long-term de-risking move.
- **Legal:** Session is **GPLv3** and libsession is open source. There is **no IP
  cliff** — the code can be maintained and shipped forever regardless of the
  Foundation. The risk is operational/network, not legal.

**Overall residual risk: MEDIUM-HIGH today, reducible to LOW** if we execute the
self-hosting / own-nodes plan before relying on Apocentro for anything critical.

---

## 1. What Apocentro actually depends on (from the code)

| Dependency | Hardcoded at | What it does | If it disappears |
|---|---|---|---|
| **Seed nodes** | `preload.js:293` (`seed1/2/3.getsession.org:4443`), certs in `SeedNodeAPI.ts:90+` | Bootstrap: fetch the initial snode pool | New installs & cold-start clients can't join the network. Existing clients with a cached pool keep working. |
| **Snode network** | the whole `snode_api/*` stack | Stores & relays ALL messages; onion routing; swarms | **Total messaging failure.** Existential. |
| **File server** | `apis/index.ts:2` (`filev2.getsession.org`), `FileServerTarget.ts:11` (`potatofiles.getsession.org`) | Attachment/avatar upload+download, link previews | New attachments & avatars break. Already-downloaded files fine. |
| **Network/staking server** | `apis/index.ts:3` (`networkv1.getsession.org`) | Token/staking dashboard info | Cosmetic only — not needed for messaging. |
| **Pro backend** | `ProBackendTarget.ts:6` (`pro-backend-dev.getsession.org`) | Session Pro features | Pro features break; core messaging unaffected. |
| **Communities (SOGS)** | `ApiUtil.ts:36` (`open.getsession.org`) | Official public communities | Optional; closed ecosystem doesn't need it. |
| **TURN (calls)** | `CallManager.ts` (`turn:*.getsession.org`) | Relay for ~15–20% of calls | Calls behind strict NAT fail. **Already slated for replacement** with self-hosted coturn. |
| **Push server** (mobile) | iOS/Android repos | Privacy-preserving FCM/APNs proxy | Background push stops; messages still arrive on app open/poll. |
| **libsession** | vendored library | Crypto + config + protocol | No runtime dependency on the Foundation, but a **maintenance** dependency (security fixes). |

---

## 2. Failure scenarios (they are NOT the same)

### Scenario A — Foundation shuts down, network operators stay (best case)
The org dissolves; `getsession.org` helper servers go offline; but service-node
operators keep staking and running nodes.
- **Breaks immediately:** seed bootstrap, file server, push, TURN.
- **Keeps working:** existing clients' messaging (they refresh the snode pool from
  snodes themselves, not only from seeds).
- **Severity:** Medium. All fixable by self-hosting (see §4). Apocentro survives.

### Scenario B — Token collapse → network empties out (worst case)
The Foundation fails, confidence in the Session Token craters, staking rewards
become worthless, operators unstake and shut down nodes.
- **Breaks gradually then totally:** swarms lose redundancy → message store/retrieve
  fails intermittently → onion paths can't be built → messaging dies.
- **Timeline:** weeks-to-months of degradation, not instant.
- **Severity:** **Existential** under the current "use the public network" design.
- **Only real fix:** run our own nodes (see §3).

### Scenario C — Slow decline (most likely real-world shape)
Funding tightens, fewer nodes, helper servers degrade, security fixes to
libsession slow down. No dramatic event, just rising flakiness and growing
maintenance burden on us.
- **Severity:** Medium, creeping. Mitigated by the same actions as A + keeping our
  own fork of libsession patched.

---

## 3. The strategic escape hatch — run our own nodes

Session needs a **global, token-incentivized** network because it must resist
sybil attacks from anonymous strangers. **Apocentro does not** — it is a closed
ecosystem of known/trusted users. That changes everything:

- The storage/relay node software (`oxen-storage-server`) and the onion-routing
  protocol are **open source**. We can run a **permissioned pool** of our own
  nodes (on our VPS/home infra) and point clients at them via **our own seed list**.
- This **decouples Apocentro from Session/Oxen entirely** — no token, no
  Foundation, no `getsession.org`.
- Trade-offs: we take on running ~enough nodes for swarm redundancy (rule of
  thumb: a swarm wants multiple replicas; plan for a handful of nodes minimum,
  more for resilience), plus the security responsibility.
- This is the **definitive answer** to "what if Session dies": if we control the
  nodes, Session dying doesn't touch us.

> Recommendation: even if we don't switch now, **prove this works** (stand up a
> private 3–5 node Apocentro network in a lab) so the migration path is real and
> not theoretical. This converts an existential risk into a planned procedure.

---

## 4. Risk register

| # | Risk | Likelihood | Impact | Time to impact | Mitigation |
|---|------|:---:|:---:|---|---|
| R1 | Seed nodes offline → no bootstrap | Med (with shutdown) | Med | Immediate for new/cold clients | Hardcode **our own seed list** in `preload.js`; ship a few known node IPs |
| R2 | File server offline → attachments/avatars break | Med | Med-High | Immediate | **Self-host Session file server** (open source); repoint `apis/index.ts` + `FileServerTarget.ts` |
| R3 | Push server offline (mobile) | Med | Med | Immediate (background only) | Self-host push proxy; or accept poll-on-open |
| R4 | TURN offline → strict-NAT calls fail | Med | Low-Med | Immediate | **Self-host coturn** (already planned) |
| R5 | **Snode network collapse** (token death) | Low-Med | **Critical** | Weeks–months | **Run our own permissioned node pool** (§3) — the only durable fix |
| R6 | libsession unmaintained → security debt | Med | Med (rising) | Months–years | Maintain our **own fork**; track CVEs; budget for crypto review |
| R7 | Single hardcoded vendor domain (`getsession.org`) everywhere | High (today) | — | — | **Centralize all endpoints into one config module** so a switch is one PR, not a hunt |

---

## 5. Recommended actions

### Do now (cheap, high leverage)
1. **Centralize endpoints.** Pull every `getsession.org` constant (seed list, file
   server, network/pro servers, TURN) into a **single Apocentro config module** so
   we can repoint the whole app in one change. Today they are scattered across
   `preload.js`, `apis/index.ts`, `FileServerTarget.ts`, `CallManager.ts`, etc.
2. **Self-host coturn** for calls (already on the calling roadmap) — removes R4 and
   one `getsession.org` dependency immediately.
3. **Mirror libsession** into our org and pin versions; watch upstream for security
   fixes (R6).

### Do before depending on Apocentro for anything important
4. **Stand up our own seed nodes + file server** and point Apocentro at them (R1, R2).
5. **PoC our own node pool** (3–5 `oxen-storage-server` nodes) and verify Apocentro
   works end-to-end against it (R5). This is the rehearsal for Scenario B.

### Contingency (have the plan written, not necessarily executed)
6. Document the **"cut the cord" runbook**: switch seed list → our nodes, file
   server → ours, push → ours, TURN → ours. With §5.1 done, this is a config flip.

---

## 6. Bottom line

| Question | Answer |
|---|---|
| Will Apocentro instantly die if Session shuts down tomorrow? | **No.** Existing clients keep messaging for a while; helper-server features (attachments, push, calls, new-install bootstrap) break and are self-hostable. |
| What actually kills Apocentro? | The **decentralized node network emptying out** after a token collapse (Scenario B) — gradual, over weeks/months. |
| Can we make Apocentro fully independent of Session? | **Yes.** As a closed ecosystem we can run our own permissioned node pool + helper servers. The protocol and libsession are open (GPLv3). |
| Is there a legal/IP risk? | **No.** GPLv3 fork; we can maintain and ship indefinitely. |
| What's the #1 action? | **Centralize the endpoint config now**, then **PoC our own node pool** — together they turn an existential risk into a one-config-flip migration. |
