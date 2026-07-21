import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");

if (!output.startsWith(`${root}${sep}`)) throw new Error("Nieprawidłowy katalog builda");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const files = [
  "index.html",
  "styles.css",
  "app.js",
  "data.js",
  "firebase-config.js",
  "manifest.webmanifest",
  "sw.js"
];

await Promise.all(files.map((file) => cp(join(root, file), join(output, file))));
await cp(join(root, "assets"), join(output, "assets"), { recursive: true });

console.log(`Build gotowy: ${output}`);
