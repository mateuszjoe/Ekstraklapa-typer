const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

async function main() {
  const root = resolve(__dirname, "..");
  const firebaseToolsLib = join(process.env.APPDATA || "", "npm", "node_modules", "firebase-tools", "lib");
  if (!existsSync(join(firebaseToolsLib, "auth.js"))) {
    throw new Error("Brak globalnego Firebase CLI. Zainstaluj firebase-tools i zaloguj się poleceniem firebase login.");
  }

  const auth = require(join(firebaseToolsLib, "auth.js"));
  const { Client } = require(join(firebaseToolsLib, "apiv2.js"));
  const account = auth.getProjectDefaultAccount(root) || auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI nie jest zalogowane.");
  auth.setActiveAccount({}, account);

  const projectId = "ekstraklasa-typer-2026-27";
  const baseName = `projects/${projectId}/databases/(default)/documents`;
  const basePath = `/projects/${projectId}/databases/(default)/documents`;
  const client = new Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });

  async function listDocuments(path) {
    const documents = [];
    let pageToken = "";
    do {
      const response = await client.get(`${basePath}/${path}`, {
        queryParams: { pageSize: 300, ...(pageToken ? { pageToken } : {}) }
      });
      documents.push(...(response.body?.documents || []));
      pageToken = response.body?.nextPageToken || "";
    } while (pageToken);
    return documents;
  }

  async function getOptionalDocument(path) {
    try {
      const response = await client.get(`${basePath}/${path}`);
      return response.body || null;
    } catch (error) {
      if (error?.status === 404 || error?.context?.response?.statusCode === 404) return null;
      throw error;
    }
  }

  const participants = await listDocuments("seasons/2026-27/participants");
  const existingLeaderboard = await listDocuments("seasons/2026-27/leaderboard");
  const existingById = new Map(existingLeaderboard.map((document) => [String(document.name || "").split("/").at(-1), document]));
  const updatedAt = new Date().toISOString();
  const writes = [];

  for (const participant of participants) {
    const uid = String(participant.name || "").split("/").at(-1);
    if (!uid) continue;
    const existing = existingById.get(uid);
    if (existing) {
      if (existing.fields?.settledMatchIds?.arrayValue) continue;
      if (Number(existing.fields?.typed?.integerValue || 0) !== 0) {
        throw new Error(`Gracz ${uid} ma już rozliczone typy i wymaga ręcznej migracji listy meczów.`);
      }
      writes.push({
        update: {
          name: `${baseName}/seasons/2026-27/leaderboard/${uid}`,
          fields: {
            settledMatchIds: { arrayValue: { values: [] } },
            updatedAt: { timestampValue: updatedAt }
          }
        },
        updateMask: { fieldPaths: ["settledMatchIds", "updatedAt"] }
      });
      continue;
    }
    const scoreDocuments = await listDocuments(`seasons/2026-27/players/${uid}/scores`);
    if (scoreDocuments.length) {
      throw new Error(`Gracz ${uid} ma już rozliczone mecze, ale nie ma agregatu rankingu. Przerwano bez nadpisywania punktów.`);
    }
    const joinedAt = participant.fields?.joinedAt;
    if (!joinedAt?.timestampValue) throw new Error(`Uczestnik ${uid} nie ma poprawnego joinedAt.`);
    const profile = await getOptionalDocument(`profiles/${uid}`);
    const displayName = profile?.fields?.displayName?.stringValue || "Gracz";
    const avatarType = profile?.fields?.avatarType?.stringValue || "google";
    const avatarValue = profile?.fields?.avatarValue?.stringValue || "";
    writes.push({
      update: {
        name: `${baseName}/seasons/2026-27/leaderboard/${uid}`,
        fields: {
          uid: { stringValue: uid },
          displayName: { stringValue: displayName },
          avatarType: { stringValue: avatarType },
          avatarValue: { stringValue: avatarValue },
          points: { integerValue: "0" },
          typed: { integerValue: "0" },
          joinedAt,
          lastScoreMatchId: { stringValue: "" },
          settledMatchIds: { arrayValue: { values: [] } },
          updatedAt: { timestampValue: updatedAt }
        }
      },
      currentDocument: { exists: false }
    });
  }

  for (let index = 0; index < writes.length; index += 450) {
    await client.post(`${basePath}:commit`, { writes: writes.slice(index, index + 450) });
  }

  console.log(`Ranking gotowy: ${participants.length} uczestników, wykonano ${writes.length} bezpiecznych migracji, istniejących wpisów: ${existingById.size}.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
