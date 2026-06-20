import { startScheduler } from "./scheduler.js";

startScheduler().catch((err) => {
  console.error("[process] fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
