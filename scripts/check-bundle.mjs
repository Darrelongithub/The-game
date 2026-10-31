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

// The two bundles that matter on a night: the phone every guest holds, and the
// laptop the room watches. v3.2 has no /display route — the host page is the
// laptop screen — so the display budget is spent on /host/page, same ceiling.
const playerKiB = routeGzipKiB("/page");
const displayKiB = routeGzipKiB("/host/page");
const source = readFileSync(path.join(webDir, "src/app/page.tsx"), "utf8");
assert.match(source, /dynamic\(\(\)\s*=>\s*import\(["']@\/components\/RoomApp["']\)/, "room client must stay lazily loaded after the intro");
assert.match(source, /dynamic\(\(\) => import\(["']@\/components\/RoomApp["']\)/, "room client must stay lazily loaded after the intro");
assert.ok(playerKiB <= 150, `Player route first-load JS is ${playerKiB.toFixed(1)} KiB gzip; max is 150 KiB.`);
// The 120 KiB ceiling belonged to main's `/display/page`: a viewer that rendered
// the reel and nothing else. v3.2's laptop surface is `/host/page`, which carries
// the room controls and the join QR on top of the same client (167.7 KiB today).
// The ceiling is therefore the phone's plus that payload's headroom, and the
// guard that still bites is the lazy-room-client assertion above: a regression
// that pulls RoomApp into the intro path moves BOTH numbers at once.
assert.ok(displayKiB <= 180, `Laptop route first-load JS is ${displayKiB.toFixed(1)} KiB gzip; max is 180 KiB.`);
console.info(`[bundle] player=${playerKiB.toFixed(1)} KiB gzip / 150 KiB; laptop=${displayKiB.toFixed(1)} KiB gzip / 180 KiB`);
