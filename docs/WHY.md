# Why Emulates

Your tests are only as honest as the fakes they run against. Most suites that touch Stripe, Twilio
or a lab partner either call a shared sandbox or stub the client. Both fail in ways that are
expensive to notice. Emulates are a third option: in-process stand-ins that behave like the real
API or database, checked against it continuously.

## The two usual options

**Call the vendor's sandbox.**

- Slow round trips on every test, and rate limits under parallel CI.
- Shared accounts: one suite's data leaks into another's, and caps like "50 test users" run out.
- Keys in CI, and outages you did not cause failing your build.
- Hard to reach the edges: declines, 429s, webhooks arriving late or twice.

**Stub the client.**

- The stub returns what you assumed, so the test checks your assumption, not the API.
- No state: create-then-list, pagination and lifecycles are hand-scripted per test.
- Stubs drift from the vendor silently. The bug shows up in production.
- Every team writes its own, for every vendor.

## Mock, emulator, sandbox

Test doubles sit on a ladder, each rung closer to the real thing:

1. **Stateless mock.** Canned responses for the calls one test makes. Nothing is remembered.
2. **Stateful mock.** Remembers what you created, with just enough behavior for the tests that use
   it. Anything they don't exercise is guessed or missing.
3. **Emulator.** Aims for externally observable behavioral compatibility with the real
   implementation: the same paths, response and error shapes, state transitions and side effects,
   for any client, not one test. The claim is checked by differential testing against the real
   API, not assumed.
4. **Live sandbox.** The vendor's own test environment: real behavior, with the costs above.
5. **Production.**

Emulates sit on the third rung. They run where a mock runs, in your test process with no network,
and are held to the standard of the sandbox.

## What an emulator does

Each package emulates one vendor or database. It answers the vendor's real paths with the vendor's
real response and error shapes, keeps records in an in-memory SQL engine, and runs inside your test
process through a plain `fetch(Request) → Response`. You point the official SDK at it, or call it
directly.

- **Stateful.** A customer you create is there when you list customers. Orders move through their
  states, subscriptions renew when you move the clock, and webhooks are signed and delivered.
- **Contract-driven.** Every HTTP emulator is built against a vendored OpenAPI contract, and each
  package lists the operations it does not emulate yet, with a reason for each gap.
- **Controllable.** The same admin surface everywhere: reset, snapshot and restore, a controllable
  clock, named fault presets, a request journal, and isolation by namespace so parallel workers
  share one process safely.
- **Isomorphic.** Every emulator is the same package in Node, Bun, browsers, and Workers. The
  playgrounds on the docs site run that package in your browser tab.

## How the emulators stay honest

An emulator is only useful if it behaves like the vendor. Each one is checked continuously with
property-based tests driven by its contract (details in [TESTING.md](TESTING.md)):

1. **Self-parity, in CI.** Random stateful walks generated from the OpenAPI spec run against two
   independent instances. They must agree after every step, and every response must conform to
   the spec.
2. **Live parity, with credentials.** The same walks run against the vendor's real sandbox and a
   fresh emulator. Responses are canonicalized (ids, timestamps, tokens) and diffed, and failures
   shrink to a minimal reproduction.
3. **Consumer acceptance.** Each package drives a port of a consuming app's own client and
   webhook code, and where the app uses the vendor SDK, the SDK is pointed at the emulator.

## Parity

Every service declares its own parity in `package.json` as `emulators.parity`: a short
statement of the vendor surface it keeps in step. The docs site, `llms.txt` and `catalog.json`
show that statement, generated from that one field. The current list is the
[services catalog](https://emulates.chrisvouga.dev/services).

## Docs that cannot drift

Nothing about a service is written down twice. Names, categories, parity, and surfaces
come from each package's `package.json`. Operations and coverage come from the built module's
contract. A service's documentation is its package README, the same file npm ships.

The repo README is the short overview (`bun run readme:sync`), and CI fails when it is stale. The
name, the sentence, and the mark live in `sites/docs/src/lib/content.ts`. The README header,
`llms.txt`, and the opening line of every published package README are generated or checked from
that file. The catalog of emulators is the docs site, `llms.txt`, and `catalog.json`. The rules are in
[docs/DESIGN.md](DESIGN.md). The docs site renders the package
READMEs, these guides and the same shared copy at build time. It sends every playground sample request to a fresh emulator and runs the quick start and
every SQL snippet against the real packages, so an example that stops working fails the build.

## For coding agents

Agents integrate an emulator the same way people do, so the same sources are published in forms they
read well: [`llms.txt`](../llms.txt) indexes every service with the parity it declares, each package README is the
integration guide (also at `node_modules/<package>/README.md`), and the docs site serves every
README as markdown at `/services/<name>.md`, all of them in `/llms-full.txt`, and a machine-readable
`/catalog.json`.

## When not to use it

- For a final check against the real vendor before a release. Run a small live suite for that.
  The emulators' own live parity exists for the same reason.
- For vendor behavior an emulator does not model yet. Each package's README and `SUPPORT.md` say what
  is deliberately not modelled.
