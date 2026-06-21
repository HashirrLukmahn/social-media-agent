// Loads .env for LOCAL development before anything reads process.env. Import this
// FIRST in every entrypoint (index.ts, scripts/*) so the load happens before any
// module evaluates process.env.
//
// In production (Railway) env vars are injected directly and these files won't
// exist, so dotenv simply no-ops. Paths are resolved from this module's location
// (not cwd), so it works the same under tsx (src/) and compiled node (dist/).
//
// The real .env currently lives at the repo root, one level above this app dir; an
// app-dir .env (next to package.json), if present, takes precedence. dotenv does
// not override already-set vars, so the first file to define a var wins.

import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // src/shared (or dist/shared)

config({ path: resolve(here, "../../.env") }); // app-dir .env (next to package.json)
config({ path: resolve(here, "../../../.env") }); // repo-root .env (real keys)
