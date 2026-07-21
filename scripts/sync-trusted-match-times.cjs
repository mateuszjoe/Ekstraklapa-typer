const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const root = resolve(__dirname, "..");
  const firebaseToolsLib = join(process.env.APPDATA || "", "npm", "node_modules", "firebase-tools", "lib");
  if (!existsSync(join(firebaseToolsLib, "auth.js"))) {
    throw new Error("Brak globalnego Firebase CLI. Zainstaluj firebase-tools i zaloguj się poleceniem firebase login.");
  }

  const projectId = JSON.parse(readFileSync(join(root, ".firebaserc"), "utf8")).projects?.default;
  if (!projectId) throw new Error("Brak domyślnego projektu w .firebaserc.");
  const { matches } = await import(pathToFileURL(join(root, "data.js")).href);
  const confirmed = matches
    .filter((match) => match.kickoffConfirmed && Number.isFinite(new Date(match.kickoffAt).getTime()))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!confirmed.length) throw new Error("W data.js nie ma potwierdzonych terminów.");

  const auth = require(join(firebaseToolsLib, "auth.js"));
  const { Client } = require(join(firebaseToolsLib, "apiv2.js"));
  const account = auth.getProjectDefaultAccount(root) || auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI nie jest zalogowane. Uruchom firebase login.");
  auth.setActiveAccount({}, account);

  const baseName = `projects/${projectId}/databases/(default)/documents`;
  const updatedAt = new Date().toISOString();
  const signature = confirmed.map((match) => `${match.id}:${match.matchday}:${new Date(match.kickoffAt).toISOString()}`).join("|");
  const writes = confirmed.map((match) => {
    const kickoff = new Date(match.kickoffAt).toISOString();
    return {
      update: {
        name: `${baseName}/seasons/2026-27/matches/${match.id}`,
        fields: {
          matchday: { integerValue: String(match.matchday) },
          closesAt: { timestampValue: kickoff },
          revealsAt: { timestampValue: kickoff },
          updatedAt: { timestampValue: updatedAt }
        }
      }
    };
  });
  writes.push({
    update: {
      name: `${baseName}/scheduleMeta/2026-27`,
      fields: {
        seasonId: { stringValue: "2026-27" },
        signature: { stringValue: signature },
        matchCount: { integerValue: String(confirmed.length) },
        updatedAt: { timestampValue: updatedAt }
      }
    }
  });

  const client = new Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });
  await client.post(`/projects/${projectId}/databases/(default)/documents:commit`, { writes });
  const verification = await client.get(`/projects/${projectId}/databases/(default)/documents/scheduleMeta/2026-27`);
  if (Number(verification.body?.fields?.matchCount?.integerValue) !== confirmed.length) {
    throw new Error("Firestore nie potwierdził pełnego zapisu terminarza.");
  }
  console.log(`Zapisano ${confirmed.length} potwierdzonych terminów w projekcie ${projectId}.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
