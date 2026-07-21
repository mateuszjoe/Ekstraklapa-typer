import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedEntry = join(root, "dist", "ekstraklasa_typer", "index.js");
const serverEntry = join(root, "dist", "server", "index.js");

await stat(generatedEntry);
await mkdir(join(root, "dist", "server"), { recursive: true });
await cp(generatedEntry, serverEntry);
await mkdir(join(root, "dist", ".openai"), { recursive: true });
await cp(join(root, ".openai", "hosting.json"), join(root, "dist", ".openai", "hosting.json"));

console.log("Pakiet Vinext gotowy do wdrożenia.");
