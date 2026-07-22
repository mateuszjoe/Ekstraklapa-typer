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
  const allowedMatchIds = new Set(matches.map((match) => match.id));
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
  const basePath = `/projects/${projectId}/databases/(default)/documents`;
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
      },
      updateMask: { fieldPaths: ["matchday", "closesAt", "revealsAt", "updatedAt"] }
    };
  });
  const client = new Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });
  const trustedDocuments = [];
  let pageToken = "";
  do {
    const response = await client.get(`${basePath}/seasons/2026-27/matches`, {
      queryParams: { pageSize: 300, ...(pageToken ? { pageToken } : {}) }
    });
    trustedDocuments.push(...(response.body?.documents || []));
    pageToken = response.body?.nextPageToken || "";
  } while (pageToken);

  const removedDocuments = trustedDocuments.filter((document) => {
    const matchId = String(document.name || "").split("/").at(-1);
    const matchday = Number(document.fields?.matchday?.integerValue);
    return !allowedMatchIds.has(matchId) || !Number.isInteger(matchday) || matchday < 1 || matchday > 17;
  });
  writes.push(...removedDocuments.map((document) => ({ delete: document.name })));
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

  for (let index = 0; index < writes.length; index += 450) {
    await client.post(`${basePath}:commit`, { writes: writes.slice(index, index + 450) });
  }
  const verification = await client.get(`${basePath}/scheduleMeta/2026-27`);
  if (Number(verification.body?.fields?.matchCount?.integerValue) !== confirmed.length) {
    throw new Error("Firestore nie potwierdził pełnego zapisu terminarza.");
  }
  console.log(`Zapisano ${confirmed.length} potwierdzonych terminów w projekcie ${projectId}. Usunięto ${removedDocuments.length} dokumentów spoza rundy jesiennej.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
