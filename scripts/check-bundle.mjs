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

const playerKiB = routeGzipKiB("/page");
const displayKiB = routeGzipKiB("/display/page");
const source = readFileSync(path.join(webDir, "src/app/page.tsx"), "utf8");
assert.match(source, /dynamic\(\(\)\s*=>\s*import\(["']@\/components\/RoomApp["']\)/, "room client must stay lazily loaded after the intro");
assert.ok(playerKiB <= 150, `Player route first-load JS is ${playerKiB.toFixed(1)} KiB gzip; max is 150 KiB.`);
assert.ok(displayKiB <= 120, `Display route first-load JS is ${displayKiB.toFixed(1)} KiB gzip; max is 120 KiB.`);
console.info(`[bundle] player=${playerKiB.toFixed(1)} KiB gzip / 150 KiB; display=${displayKiB.toFixed(1)} KiB gzip / 120 KiB`);
