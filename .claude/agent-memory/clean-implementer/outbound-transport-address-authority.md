# Outbound transport: the child is the address authority (F3/F4 fix)

`src/docker/outbound-transport.ts`. Closed security finding **F3** (nested-mode SSRF was
*delegated* to the parent proxy) and **F4** (`dnsLookup` test seam silently implied
`allowPrivateDestinationsForTests`), plus the egress-listener passthrough hole.

## The architectural rule (do NOT "fix" SSRF at the parent)
A parent proxy **cannot** re-derive a derived-CDN authority: that host is authorized only as
the immediate `Location` of one specific authorized response. A parent registry-egress
listener sees a *client-initiated* request to an unlisted host and fails closed; a
standard-mode parent 403s the CONNECT. So the CHILD must resolve and screen. Any future
"just let the parent check it" proposal is wrong for this reason.

## Shape of the fix
- `createGuardedLookup(lookup, allowPrivate)` is now **exported** — one implementation of the
  address policy for name destinations, shared by 3 call sites: direct transport
  (`RequestOptions.lookup`), fixed-parent `createDestinationScreen`, and mitm-proxy's raw
  passthrough tunnel (`net.connect({..., lookup})`).
- `OutboundTransport.addressGuard: 'local-resolver' | 'delegated'` — a **checked capability**,
  not a comment. Both factories return `'local-resolver'`. `registry-egress-proxy.ts`
  `assertLocalAddressAuthority` (wired as `MediatedEgressConfig.assertReady`) refuses
  anything else with 502 *before* upstream contact, because registry follows attacker-chosen
  redirect authorities. Written fail-closed (`!== 'local-resolver'`) so a stub missing the
  field is refused, not silently admitted.
- `ParentProxyOutboundTransportOptions` mirrors `DirectOutboundTransportOptions`
  (`lookup?`, `allowPrivateDestinationsForTests?`).

## Where the screen lives, and why (non-obvious)
`request()` must stay SYNCHRONOUS (returns `http.ClientRequest`), but the screen is async and
must complete BEFORE any authority reaches the parent. Both branches therefore screen inside
an **Agent's `createConnection`** — the only async-with-error seam that runs before bytes fly:
- HTTPS: `FixedParentProxyHttpsAgent` screens, then writes CONNECT.
- Plain HTTP: added `FixedParentProxyHttpAgent`; the request changed from
  `http.request({...proxy, path: absoluteUrl})` to
  `http.request({hostname: dest, port: dest, path: absoluteUrl, agent})` so the *destination*
  is visible in `createConnection`'s options; the agent then dials the parent via
  `parentConnectOptions()` (`{path}` for UDS, `{host,port}` for TCP).
  Node contract: returning `undefined` from `createConnection` and calling the callback later
  is supported; an error there surfaces as `'error'` on the ClientRequest.
  Side effect: the parent connection is now `Connection: close` (agent `keepAlive:false`)
  instead of the global agent's keep-alive. Benign, and no cross-destination socket reuse.
- Literal destinations skip the resolver (already screened by `assertHostnameIsEligible`, and
  `net.connect` would not resolve them either).

## Accepted residual — recorded in the module doc, do not "discover" it again
The parent path restores the *policy* check but NOT direct mode's *pinning*: the parent
re-resolves, so a TTL-0 rebind between the two resolutions is possible. Pinning by sending
the resolved literal as the CONNECT authority is NOT an option — that authority is also the
SNI / cert-validation identity. Accepted under the trusted-host model.

## Open wiring-phase question (flagged, not solved)
The child now needs a working resolver. A `--network=none` nested container has none, so a
production wiring of `createParentProxyOutboundTransport` must supply one (host-mediated
resolver, or `/etc/hosts` entries for the reviewed frozen origins). Failing closed is the
correct direction, but it is a functional prerequisite. No production caller exists yet.

## F4 + the passthrough narrowing in mitm-proxy.ts
- `dnsLookup` and `allowPrivateDestinationsForTests` are now INDEPENDENT. Every fixture that
  passes `localhostDnsLookup` must also pass `allowPrivateDestinationsForTests: true`
  (~21 call sites across `test/mitm-proxy.test.ts`, `test/mitm-proxy-token-stream.test.ts`,
  `test/docker/openrouter-mitm.test.ts`).
- `passthroughEligible = listenerMode.kind === 'standard'` gates ALL THREE passthrough
  eligibility sites (CONNECT tunnel, plain-HTTP dispatch, WS upgrade). Reason: build-/
  registry-egress listeners have no providers and no registries, so `isKnownStaticHost` is
  false for EVERY host — under `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS=1` every host became
  wildcard-eligible and a `direct` transport turned the CONNECT into a raw tunnel that never
  consults the guard. Egress modes TLS-terminate instead and the guard 403s.

## Test seams worth reusing
- `test/helpers/fake-parent-proxy.ts` — `createTlsIdentity(hostnames)` (node-forge self-signed,
  used as BOTH server cert and client `ca`) + `startFakeParentProxy({socketPath, identity,
  routes})` which really answers CONNECT, TLS-terminates, and records `connectAuthorities`.
  That array is how you prove "the parent was never asked for host X".
- `publicDnsLookup` in `test/helpers/mitm-tls-harness.ts` — resolves everything to
  93.184.216.34; use where a name must be *screened* but the answer is never dialed
  (fixed-parent path), so a fixture stays hermetic without disabling the policy.
- Proving "refused before I/O" on the parent path: count `server.on('connection')` on the
  parent UDS and assert 0.
- eslint `no-unnecessary-condition`: the repo has no `noUncheckedIndexedAccess`, so a
  `Record<string, T>` lookup is `T`, and `=== undefined` is flagged. Type stub maps as
  `Record<string, T | undefined>`.
