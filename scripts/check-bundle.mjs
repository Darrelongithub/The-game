import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const webDir = path.resolve("apps/web");
const buildDir = path.join(webDir, ".next");
const manifestPath = path.join(buildDir, "app-build-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function routeGzipKiB(route) {
  const files = manifest.pages[route];
  assert.ok(Array.isArray(files), `Missing app build-manifest route ${route}; run npm run build first.`);
  const unique = new Set(files.filter(file => file.endsWith(".js")));
  return [...unique].reduce((sum, file) => sum + gzipSync(readFileSync(path.join(buildDir, file))).length, 0) / 1024;
}

// The two surfaces of a night: the phone every guest holds, and the laptop the
// room watches. v3.2 has no /display route — /host/page IS the laptop screen.
const playerKiB = routeGzipKiB("/page");
const laptopKiB = routeGzipKiB("/host/page");

// The guard that actually bites. RoomApp is loaded after the intro on purpose;
// anything that pulls it back into the entry chunk moves BOTH numbers below,
// which is why the numbers are printed even where one of them has no limit.
const source = readFileSync(path.join(webDir, "src/app/page.tsx"), "utf8");
assert.match(source, /dynamic\(\(\)\s*=>\s*import\(["']@\/components\/RoomApp["']\)/, "room client must stay lazily loaded after the intro");

// The phones are the whole game: 150 KiB is the ceiling they are held to, and
// the one that was never in question.
assert.ok(playerKiB <= 150, `Player route first-load JS is ${playerKiB.toFixed(1)} KiB gzip; max is 150 KiB.`);

// No ceiling on the laptop route (owner's call, after the v3.1 merge). The old
// 120 KiB was paid for by main's `/display/page` — a viewer that rendered the
// reel and nothing else. The v3.2 laptop page also carries the room controls and
// the join QR, so a number copied from that route would only ever measure the
// wrong page; the size is printed so a jump is still visible in the log.
console.info(`[bundle] player=${playerKiB.toFixed(1)} KiB gzip / 150 KiB; laptop=${laptopKiB.toFixed(1)} KiB gzip (measured, no ceiling)`);
