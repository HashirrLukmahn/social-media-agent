import { config as loadEnv } from "dotenv";
import type { Config } from "drizzle-kit";

// Load .env so DATABASE_URL is available when drizzle-kit runs (cwd = app dir).
loadEnv(); // app-dir .env if present
loadEnv({ path: "../.env" }); // repo-root .env (real keys)

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? (() => { throw new Error("DATABASE_URL not set"); })(),
  },
} satisfies Config;
