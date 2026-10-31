// scripts/tmp-showcase.ts — run one night and print the reveal, so a human
// can read the slides. Temporary: deleted after the review.
import { startServer } from "./bots.ts";

void startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
