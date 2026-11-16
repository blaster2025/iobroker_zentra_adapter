# CLAUDE.md

## Project

ioBroker adapter `zentra` (title "ZENTRA") that pulls data from METER Group ZENTRA Cloud via API v5. TypeScript, scaffolded with `@iobroker/create-adapter`.

- The adapter is meant for ioBroker in general. Development happens on Windows; the target system is a Linux ioBroker server.
- Design: [Docs/Concept.md](Docs/Concept.md). API summary: [Docs/ZentraCloud-API-v5.md](Docs/ZentraCloud-API-v5.md). Installation: [Docs/Deployment.md](Docs/Deployment.md).
- Commands:
  - `npm run build` – compile to `build/`. `build/` is committed so the adapter can be installed from GitHub.
  - `npm run check` – type check
  - `npm run lint` – lint
  - `npm test` – unit and package tests
- Node.js is installed in `C:\Program Files\nodejs`. That folder may be missing from PATH in a new shell; prepend it if needed.

## Rules

- **Documentation location:** All documentation is written as Markdown (`.md`) files in the `Docs/` folder.
- **Documentation language:** Written documentation is always in **English**, even when the conversation is in German. This covers files in `Docs/`, README files, code comments, and commit messages.
