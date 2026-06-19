import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? (() => { throw new Error("DATABASE_URL not set"); })(),
  },
} satisfies Config;
