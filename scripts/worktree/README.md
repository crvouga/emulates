# Worktree lifecycle

Every agent orchestrator that creates a git worktree per task runs the same three scripts from the
worktree root. Each host reads its own project config, and those configs are generated from one
definition in [`sync.ts`](sync.ts), so the hosts cannot drift:

| Host | Config (generated) |
| --- | --- |
| [Superset](https://docs.superset.sh/setup-teardown-scripts) | `.superset/config.json` |
| [super.engineering](https://super.engineering/docs/project-config-and-scripts/) | `.super.engineering/config.json` |

| When | Script | What it does |
| --- | --- | --- |
| Worktree created | `./scripts/worktree/setup.sh` | Copies untracked files and `.env*` from the main checkout (without overwriting), reserves a docs port, then `bun run setup` (install, build, create `.env.local`) |
| Run action | `./scripts/worktree/run.sh` | Builds the docs site's dependencies and starts `bun docs` on that port |
| Worktree deleted | `./scripts/worktree/teardown.sh` | Stops the dev server and releases the port |

Edit the scripts, or `LIFECYCLE` in `sync.ts`; never a host's config. `bun run worktree:sync`
rewrites the configs and `bun run check:worktree` (part of `bun run check`) fails on drift. To
support another orchestrator, add an entry to `HOSTS` in `sync.ts` that renders `LIFECYCLE` into
the file that host reads.

The scripts read no host-specific variables. The main checkout is found through git
(`git rev-parse --git-common-dir`), so they behave the same under any host, or none.

The docs site (`sites/docs`, Astro) is the dev server. Its default port is 4321, so parallel
worktrees would collide. Setup reserves one slot per worktree in `~/.superset/port-allocations.json`
— 20-port slots aligned at 3000, the shared file described in the
[Superset port docs](https://docs.superset.sh/ports), used under every host so worktrees from
either never overlap — and serves the site on the base of that slot. The first free slot is usually
port 3000. The server listens on `http://127.0.0.1:<port>`.

Per-worktree state (`.worktree/dev-port`, `.worktree/dev-server.pid`) is gitignored. Setup also
writes `.superset/ports.json` so Superset labels the listening port "Docs"; other hosts ignore it.

Run the same scripts from any checkout, without an orchestrator:

```bash
./scripts/worktree/setup.sh
./scripts/worktree/run.sh
./scripts/worktree/teardown.sh
```
