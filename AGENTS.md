# Repository Guidelines

This project is an MCP server that generates images with Gemini 3 Pro Image on Vertex AI. This guide covers structure, workflows, and expectations for changes.

## Project Structure & Module Organization
- `src/index.ts` is the MCP server entrypoint (tool schema, auth, GCS uploads, and Vertex calls).
- `dist/` is the compiled output from TypeScript; treat it as build artifacts and do not edit by hand.
- `public/` and `architecture.png` hold static docs/assets.
- `tmp/` is gitignored scratch output for local experiments.
- `.env.example` documents runtime configuration; `.env` is local-only.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run dev` starts the TypeScript entrypoint with `tsx` for local development.
- `npm run build` compiles `src/` into `dist/` via `tsc`.
- `npm start` runs the compiled server from `dist/index.js` (use after `npm run build`).

## Coding Style & Naming Conventions
- TypeScript (ESM) with strict mode enabled (`tsconfig.json`).
- Indentation is 2 spaces; keep line wrapping consistent with existing files.
- Use `camelCase` for variables/functions, `PascalCase` for types, and `UPPER_SNAKE_CASE` for env vars.
- Keep new logic close to the relevant tool handler in `src/index.ts` and prefer small helper functions.

## Testing Guidelines
- No automated test suite is currently defined.
- For risky changes, document manual verification steps in the PR (e.g., run `npm run dev` and invoke the MCP tool with a sample payload).

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and sentence-case (examples in history: "Update README...", "Add GCS bucket...").
- PRs should include: a concise summary, testing notes (commands run or manual checks), and any config changes (e.g., new env vars in `.env.example`).

## Configuration & Security Notes
- Required env vars include `GOOGLE_SERVICE_ACCOUNT_JSON` and, when needed, `NANO_BANANA_GCS_BUCKET`.
- Never commit real service account JSON or `.env`; update `.env.example` when adding new settings.
