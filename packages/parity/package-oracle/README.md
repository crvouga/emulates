# Provider package oracle

Emulate 0.12.1 is installed only as a dev dependency in this private test package. Test targets are native vendor packages, never a competing emulator compatibility API. The source commit and complete observed route inventory are pinned in coverage.json.

Run `bun run --cwd packages/parity/package-oracle parity` from an initialized checkout. Differential results are evidence of package-oracle agreement, separately from real-vendor verification. Route probes cover method/path dispatch and response structure; stateful scenarios compare selected semantic values. They are complementary, not exhaustive vendor certification. The competitor's inspector/assets are excluded from vendor coverage.
