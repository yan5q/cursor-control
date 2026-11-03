import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import esbuild from "esbuild";

const e2e = process.argv.includes("--e2e");
const outdir = e2e ? "dist-e2e" : "dist";

await esbuild.build({
  entryPoints: {
    background: "src/background.ts",
    popup: "src/popup.ts",
  },
  bundle: true,
  format: "esm",
  outdir,
  target: "chrome120",
  sourcemap: true,
});

await esbuild.build({
  entryPoints: ["src/offscreen.ts"],
  bundle: true,
  format: "iife",
  outfile: path.join(outdir, "offscreen.js"),
  target: "chrome120",
  sourcemap: true,
});

await esbuild.build({
  entryPoints: ["src/overlay.ts"],
  bundle: true,
  format: "iife",
  outfile: path.join(outdir, "overlay.js"),
  target: "chrome120",
  sourcemap: true,
});

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (e2e) {
  const permissions = new Set(manifest.permissions ?? []);
  for (const permission of manifest.optional_permissions ?? []) permissions.add(permission);
  manifest.permissions = [...permissions];
  delete manifest.optional_permissions;
  manifest.host_permissions = manifest.optional_host_permissions ?? ["<all_urls>"];
  delete manifest.optional_host_permissions;
}
writeFileSync(path.join(outdir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
cpSync("src/popup.html", path.join(outdir, "popup.html"));
cpSync("src/offscreen.html", path.join(outdir, "offscreen.html"));

const iconDir = path.join(outdir, "icons");
mkdirSync(iconDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(iconDir, `${size}.png`), icon(size));
}

function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const arrow = [
    [0.24, 0.16],
    [0.24, 0.7],
    [0.38, 0.56],
    [0.34, 0.84],
    [0.48, 0.76],
    [0.44, 0.54],
    [0.68, 0.54],
  ];
  const inset = size * 0.08;
  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const index = row + 1 + x * 4;
      if (!insideRoundedRect(x + 0.5, y + 0.5, size, inset, radius)) continue;
      let red = 26;
      let green = 23;
      let blue = 20;
      if (pointInPoly((x + 0.5) / size, (y + 0.5) / size, arrow)) {
        red = 255;
        green = 92;
        blue = 28;
      }
      if (Math.hypot(x + 0.5 - size * 0.72, y + 0.5 - size * 0.72) < size * 0.08) {
        red = 198;
        green = 242;
        blue = 90;
      }
      raw[index] = red;
      raw[index + 1] = green;
      raw[index + 2] = blue;
      raw[index + 3] = 255;
    }
  }
  return encodePng(size, raw);
}

function insideRoundedRect(x, y, size, inset, radius) {
  const left = inset;
  const top = inset;
  const right = size - inset;
  const bottom = size - inset;
  if (x < left || y < top || x >= right || y >= bottom) return false;
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  return Math.hypot(x - nearestX, y - nearestY) <= radius || (x >= left + radius && x < right - radius) || (y >= top + radius && y < bottom - radius);
}

function pointInPoly(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    const crosses = current[1] > y !== prior[1] > y;
    const xAtY = ((prior[0] - current[0]) * (y - current[1])) / (prior[1] - current[1] + 0.00001) + current[0];
    if (crosses && x < xAtY) inside = !inside;
  }
  return inside;
}

function encodePng(size, raw) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
