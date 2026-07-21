const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

function firebaseString(field) {
  return typeof field?.stringValue === "string" ? field.stringValue : "";
}

function firebaseTimestamp(field) {
  const value = field?.timestampValue;
  return typeof value === "string" && Number.isFinite(new Date(value).getTime()) ? value : null;
}

async function main() {
  const root = resolve(__dirname, "..");
  const firebaseToolsLib = join(process.env.APPDATA || "", "npm", "node_modules", "firebase-tools", "lib");
  if (!existsSync(join(firebaseToolsLib, "auth.js"))) {
    throw new Error("Brak globalnego Firebase CLI. Zainstaluj firebase-tools i zaloguj się poleceniem firebase login.");
  }
  const projectId = JSON.parse(readFileSync(join(root, ".firebaserc"), "utf8")).projects?.default;
  if (!projectId) throw new Error("Brak domyślnego projektu w .firebaserc.");
  const { matches } = await import(pathToFileURL(join(root, "data.js")).href);
  const matchIds = new Set(matches.map((match) => match.id));

  const auth = require(join(firebaseToolsLib, "auth.js"));
  const { Client } = require(join(firebaseToolsLib, "apiv2.js"));
  const account = auth.getProjectDefaultAccount(root) || auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI nie jest zalogowane. Uruchom firebase login.");
  auth.setActiveAccount({}, account);
  const client = new Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });
  const basePath = `/projects/${projectId}/databases/(default)/documents`;
  const baseName = `projects/${projectId}/databases/(default)/documents`;

  const legacyDocuments = [];
  let pageToken = "";
  do {
    const response = await client.get(`${basePath}/predictions`, {
      queryParams: { pageSize: 300, ...(pageToken ? { pageToken } : {}) }
    });
    legacyDocuments.push(...(response.body?.documents || []));
    pageToken = response.body?.nextPageToken || "";
  } while (pageToken);

  const writes = [];
  let skipped = 0;
  for (const legacy of legacyDocuments) {
    const uid = firebaseString(legacy.fields?.uid);
    const matchId = firebaseString(legacy.fields?.matchId);
    const pick = firebaseString(legacy.fields?.pick);
    const legacyUpdatedAt = firebaseTimestamp(legacy.fields?.updatedAt) || legacy.updateTime || new Date().toISOString();
    if (!uid || uid.includes("/") || !matchIds.has(matchId) || !["1", "X", "2"].includes(pick)) {
      skipped += 1;
      continue;
    }

    const targetPath = `${basePath}/seasons/2026-27/players/${uid}/picks/${matchId}`;
    try {
      const current = await client.get(targetPath);
      const currentUpdatedAt = firebaseTimestamp(current.body?.fields?.updatedAt) || current.body?.updateTime;
      if (currentUpdatedAt && new Date(currentUpdatedAt) >= new Date(legacyUpdatedAt)) {
        skipped += 1;
        continue;
      }
    } catch (error) {
      if (!String(error?.message || error).includes("HTTP Error: 404")) throw error;
    }

    writes.push({
      update: {
        name: `${baseName}/seasons/2026-27/players/${uid}/picks/${matchId}`,
        fields: {
          pick: { stringValue: pick },
          updatedAt: { timestampValue: legacyUpdatedAt }
        }
      }
    });
  }

  for (let index = 0; index < writes.length; index += 450) {
    await client.post(`${basePath}:commit`, { writes: writes.slice(index, index + 450) });
  }
  console.log(`Migracja zakończona: ${writes.length} typów przeniesionych, ${skipped} pominiętych.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
