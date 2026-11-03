// scripts/dev-mock.mjs — `npm run dev:mock` without POSIX env syntax.
//
// The old script was `NEXT_PUBLIC_TRANSPORT=mock next dev ...`, which fails in
// Windows PowerShell/cmd. This shim sets the variable in Node and starts the
// same Next dev server on every platform.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", "-H", "0.0.0.0", "-p", "5173"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_TRANSPORT: "mock" },
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("error", (error) => {
  console.error("Could not start Next:", error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
