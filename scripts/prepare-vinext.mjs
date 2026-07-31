import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public");
const buildOutput = resolve(root, "dist");
if (!output.startsWith(`${root}${sep}`)) throw new Error("Nieprawidłowy katalog public");
if (!buildOutput.startsWith(`${root}${sep}`)) throw new Error("Nieprawidłowy katalog dist");

await rm(output, { recursive: true, force: true });
await rm(buildOutput, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await Promise.all([
  cp(join(root, "app.js"), join(output, "app.js")),
  cp(join(root, "data.js"), join(output, "data.js")),
  cp(join(root, "firebase-config.js"), join(output, "firebase-config.js")),
  cp(join(root, "live-provider.js"), join(output, "live-provider.js")),
  cp(join(root, "league-provider.js"), join(output, "league-provider.js")),
  cp(join(root, "player-rating.js"), join(output, "player-rating.js")),
  cp(join(root, "payment-banner.js"), join(output, "payment-banner.js")),
  cp(join(root, "styles.css"), join(output, "styles.css")),
  cp(join(root, "payment-banner.css"), join(output, "payment-banner.css")),
  cp(join(root, "manifest.webmanifest"), join(output, "manifest.webmanifest")),
  cp(join(root, "sw.js"), join(output, "sw.js")),
  cp(join(root, "downloads"), join(output, "downloads"), { recursive: true }),
  cp(join(root, "assets"), join(output, "assets"), { recursive: true })
]);

console.log(`Zasoby Vinext gotowe: ${output}`);
