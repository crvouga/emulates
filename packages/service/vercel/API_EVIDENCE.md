# Vercel evidence

The target is the public vendor API covered by Emulate 0.12.1, pinned to commit c77cb73e7ab525c5260dd36c04c91a54a23e7e75. Package differential checks compare native Mockingbird responses and state transitions against a separate npm-installed oracle. This is not live-vendor proof. Oracle scenarios and results live in packages/parity/package-oracle.


Added vendor routes are checked against the pinned Emulate 0.12.1 npm package and licensed provider regression tests. Native fixture, namespace, checkpoint, branch and clock checks run separately. This is offline package evidence, not live vendor proof. See [coverage audit](../../../docs/EMULATE_COVERAGE.md) for the pinned source, coverage gate, reviewed differences and exact commands.
