# BELGOBETON

Secure operations brain for a ready-mix concrete company (pilot, **fake data only**).
Start with [docs/BRIEF.md](docs/BRIEF.md), the spec index [CAPABILITY-MAP.md](CAPABILITY-MAP.md) and the plan [tasks/plan.md](tasks/plan.md).

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm via Corepack (version pinned in `package.json`): run `corepack pnpm <command>`, or `corepack enable` once to get a `pnpm` shim

Dependency install scripts are blocked by default; see `pnpm-workspace.yaml` before allowing one.

## Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev          # http://localhost:3000 → /fr or /ar
corepack pnpm lint         # eslint (incl. module boundaries) + prettier --check
corepack pnpm typecheck    # tsc --noEmit
corepack pnpm test         # vitest run
corepack pnpm build
corepack pnpm ci:local     # lint + typecheck + test + build (CI is local until a private remote exists)
```

More commands (database, backups, audit verification, simulation) arrive with their tasks; the full list is in CAPABILITY-MAP.md §4.

## Module boundaries

`module-map.mjs` mirrors the module map in CAPABILITY-MAP.md §1. A module may import only itself, `src/lib`, `src/i18n` and the modules it depends on; `pnpm lint` fails otherwise. Change the map in CAPABILITY-MAP.md first.
