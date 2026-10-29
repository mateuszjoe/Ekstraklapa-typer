const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Użycie: npm run sync:schedule -- [--dry-run]");
  const dryRun = args.includes("--dry-run");
  const root = resolve(__dirname, "..");
  const firebaseToolsLib = join(process.env.APPDATA || "", "npm", "node_modules", "firebase-tools", "lib");
  if (!existsSync(join(firebaseToolsLib, "auth.js"))) {
    throw new Error("Brak globalnego Firebase CLI. Zainstaluj firebase-tools i zaloguj się poleceniem firebase login.");
  }

  const projectId = JSON.parse(readFileSync(join(root, ".firebaserc"), "utf8")).projects?.default;
  if (!projectId) throw new Error("Brak domyślnego projektu w .firebaserc.");
  const { getOfficialTrustedSchedule } = await import(pathToFileURL(join(root, "live-provider.js")).href);
  const { planTrustedSchedule, verifyTrustedSchedule } = await import(
    pathToFileURL(join(root, "notifications-worker/trusted-schedule.js")).href
  );

  const auth = require(join(firebaseToolsLib, "auth.js"));
  const { Client } = require(join(firebaseToolsLib, "apiv2.js"));
  const account = auth.getProjectDefaultAccount(root) || auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI nie jest zalogowane. Uruchom firebase login.");
  auth.setActiveAccount({}, account);

  const baseName = `projects/${projectId}/databases/(default)/documents`;
  const basePath = `/projects/${projectId}/databases/(default)/documents`;
  const client = new Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });
  async function readTrustedDocuments() {
    const documents = [];
    let pageToken = "";
    do {
      const response = await client.get(`${basePath}/seasons/2026-27/matches`, {
        queryParams: { pageSize: 300, ...(pageToken ? { pageToken } : {}) }
      });
      documents.push(...(response.body?.documents || []));
      pageToken = response.body?.nextPageToken || "";
    } while (pageToken);
    return documents;
  }
  const [payload, trustedDocuments] = await Promise.all([
    getOfficialTrustedSchedule({ force: true }),
    readTrustedDocuments()
  ]);
  if (payload.fixtures?.length !== 153) {
    throw new Error("Brak świeżego oficjalnego terminarza; nie zmieniono terminów w Firestore.");
  }
  const changes = planTrustedSchedule(payload.fixtures, trustedDocuments);
  console.log(`${dryRun ? "Podgląd" : "Synchronizacja"}: ${changes.length} zmian terminów w projekcie ${projectId}.`);
  for (const change of changes) console.log(`${change.id}: ${change.expected.kickoffConfirmed.booleanValue ? change.expected.closesAt.timestampValue : "oczekuje na dokładną godzinę / typowanie zamknięte"}`);
  if (dryRun || !changes.length) return;

  const writes = changes.map((change) => change.write);
  for (let index = 0; index < writes.length; index += 450) {
    await client.post(`${basePath}:commit`, { writes: writes.slice(index, index + 450) });
  }
  verifyTrustedSchedule(changes, await readTrustedDocuments());
  console.log(`Zapisano i zweryfikowano ${changes.length} dokumentów terminarza. Typy graczy pozostały bez zmian; zakończone wyniki pochodzą z oficjalnego źródła.`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
