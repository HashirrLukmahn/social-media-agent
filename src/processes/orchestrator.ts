import { startOpenClaw } from "../orchestrator/openClaw.js";

startOpenClaw().catch((err) => {
  console.error("[process:orchestrator] fatal error:", err);
  process.exit(1);
});
