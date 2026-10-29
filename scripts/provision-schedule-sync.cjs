const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const PROJECT_ID = "ekstraklasa-typer-2026-27";
const MACHINE_UID = "trusted-schedule-sync-2026-27";
const MACHINE_NAME = "Trusted schedule sync 2026-27";
const SECRET_NAME = "FIREBASE_SCHEDULE_REFRESH_TOKEN";
const SIGNER_ID = "typer-schedule-bootstrap";
const SIGNER_EMAIL = `${SIGNER_ID}@${PROJECT_ID}.iam.gserviceaccount.com`;
const SIGNER_NAME = "Typer schedule bootstrap (no data access)";
const TEMP_SIGNER_ROLE = "roles/iam.serviceAccountTokenCreator";
const ROOT = resolve(__dirname, "..");

function parseArguments(args) {
  const options = { mode: "check", serviceAccount: "", wranglerPath: "" };
  let modeSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--check", "--provision"].includes(arg) && !modeSeen) {
      options.mode = arg.slice(2);
      modeSeen = true;
    } else if (["--service-account", "--wrangler"].includes(arg) && args[index + 1]) {
      const value = args[++index];
      if (value.startsWith("--")) throw new Error("Brak wartości argumentu.");
      if (arg === "--service-account") options.serviceAccount = value;
      else options.wranglerPath = resolve(value);
    } else {
      throw new Error("Użycie: node scripts/provision-schedule-sync.cjs [--check|--provision] [--service-account EMAIL] [--wrangler ŚCIEŻKA_DO_WRANGLER_JS]");
    }
  }
  return options;
}

function machineClaims(user) {
  try { return JSON.parse(user?.customAttributes || "{}"); }
  catch { throw new Error("Konto automatu ma nieprawidłowe customAttributes."); }
}

function assertMachineAccount(user) {
  if (!user) return;
  const claims = machineClaims(user);
  if (user.localId !== MACHINE_UID || user.email || user.phoneNumber || user.passwordHash
    || user.providerUserInfo?.length || user.disabled
    || (user.displayName !== MACHINE_NAME && claims.scheduleSync !== true)
    || Object.keys(claims).some((key) => key !== "scheduleSync")) {
    throw new Error("Zarezerwowany UID jest zajęty przez inne lub wyłączone konto. Nie zmieniono konta.");
  }
}

async function requestJson(url, label, { token, body, method = body ? "POST" : "GET" } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error(`${label}: połączenie nie powiodło się.`);
  }
  // Responses can contain authentication credentials. Never print their body,
  // error message, request options or cause, including on an unsuccessful call.
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${label}: nieprawidłowa odpowiedź HTTP ${response.status}.`); }
  if (!response.ok) {
    const code = String(data?.error?.status || "");
    const safeCode = /^[A-Z_]{1,64}$/.test(code) ? ` ${code}` : "";
    const reasons = (data?.error?.details || []).map((item) => item?.reason)
      .filter((reason) => typeof reason === "string" && /^[A-Z_]{1,64}$/.test(reason));
    const error = new Error(`${label}: HTTP ${response.status}${safeCode}${reasons.length ? ` (${reasons.join(", ")})` : ""}.`);
    error.status = response.status;
    error.apiCode = code;
    error.apiReasons = reasons;
    throw error;
  }
  return data;
}

function wranglerEnvironment(args, inherited = process.env) {
  // Wrangler emits the JSON result of `secret list` through logger.log().
  // Raising that command's level to error suppresses the machine-readable data.
  // Only this read-only command gets log; secret writes stay at error level.
  const listsNames = args.length === 2 && args[0] === "secret" && args[1] === "list";
  return {
    ...inherited,
    CI: "true",
    NO_COLOR: "1",
    WRANGLER_LOG: listsNames ? "log" : "error",
    WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_METRICS: "false"
  };
}

function runWrangler(wranglerPath, args, input) {
  const child = spawnSync(process.execPath, [wranglerPath, ...args, "--config", join(ROOT, "notifications-wrangler.jsonc")], {
    cwd: ROOT,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024,
    timeout: 120_000,
    env: wranglerEnvironment(args)
  });
  if (child.error || child.status !== 0) {
    const expired = /not logged in|auth token has expired|CLOUDFLARE_API_TOKEN/i.test(`${child.stdout || ""}${child.stderr || ""}`);
    throw new Error(expired
      ? "Wrangler: brak aktywnej sesji Cloudflare. Wykonaj wrangler login. Nie zmieniono konfiguracji usługi."
      : `Wrangler ${args.slice(0, 2).join(" ")}: operacja nie powiodła się (kod ${child.status ?? "brak"}). Wyjście pominięto, aby chronić dane uwierzytelniające.`);
  }
  return child.stdout;
}

function parseSecretNames(output) {
  let secrets;
  try { secrets = JSON.parse(output); }
  catch { throw new Error("Wrangler nie zwrócił listy nazw sekretów w formacie JSON."); }
  if (!Array.isArray(secrets) || secrets.some((secret) => typeof secret?.name !== "string" || !secret.name.trim())) {
    throw new Error("Nieprawidłowa lista sekretów Workera.");
  }
  return new Set(secrets.map((secret) => secret.name));
}

function listSecrets(wranglerPath) {
  return parseSecretNames(runWrangler(wranglerPath, ["secret", "list"]));
}

function customTokenPayload(serviceAccount, nowSeconds) {
  return {
    iss: serviceAccount,
    sub: serviceAccount,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: nowSeconds,
    exp: nowSeconds + 300,
    uid: MACHINE_UID,
    claims: { scheduleSync: true }
  };
}

function addTemporarySigner(policy, member) {
  const bindings = structuredClone(policy.bindings || []);
  let binding = bindings.find((item) => item.role === TEMP_SIGNER_ROLE && !item.condition);
  if (binding?.members?.includes(member)) return { policy, added: false };
  if (!binding) {
    binding = { role: TEMP_SIGNER_ROLE, members: [] };
    bindings.push(binding);
  }
  binding.members = [...(binding.members || []), member];
  return { policy: { ...policy, version: 3, bindings }, added: true };
}

function removeTemporarySigner(policy, member) {
  const bindings = structuredClone(policy.bindings || []).map((binding) => {
    if (binding.role !== TEMP_SIGNER_ROLE || binding.condition) return binding;
    return { ...binding, members: (binding.members || []).filter((value) => value !== member) };
  }).filter((binding) => binding.members?.length);
  return { ...policy, version: 3, bindings };
}

function getSignerPolicy(adminRequest) {
  // IAM's service-account getIamPolicy is POST with an empty body (unlike GET
  // serviceAccounts.get). Keep policy version in the documented query option.
  const resource = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER_EMAIL)}`;
  return adminRequest(`${resource}:getIamPolicy?options.requestedPolicyVersion=3`,
    "Odczyt uprawnień konta podpisującego", undefined, "POST");
}

async function signWithTemporaryPermission(adminRequest, member, signingInput) {
  const iamResource = `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER_EMAIL)}`;
  const getPolicy = () => getSignerPolicy(adminRequest);
  const initialPolicy = await getPolicy();
  const grant = addTemporarySigner(initialPolicy, member);
  let grantAttempted = false;
  try {
    if (grant.added) {
      // Even an uncertain network response after this request must enter the
      // cleanup path: the grant may already have reached IAM.
      grantAttempted = true;
      await adminRequest(`${iamResource}:setIamPolicy`, "Tymczasowe prawo podpisu na koncie bez ról danych", { policy: grant.policy });
    }
    // IAM allow-policy changes commonly need about two minutes to propagate.
    // Wait at most three minutes, with visible progress and no sleeps over 30s.
    const retryDelays = [0, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (retryDelays[attempt]) {
        console.log(`IAM propaguje tymczasowe prawo podpisu. Ponowna próba za 30 s (${attempt}/6).`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelays[attempt]));
      }
      // Regenerate the short-lived JWT each time; waiting for IAM must not use
      // up the five-minute custom-token validity before it is actually signed.
      const currentSigningInput = typeof signingInput === "function" ? signingInput() : signingInput;
      const payload = Buffer.from(currentSigningInput).toString("base64");
      try {
        try {
          const signed = await adminRequest(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER_EMAIL)}:signBlob`,
            "Jednorazowy podpis tokenu automatu", { payload });
          if (!signed.signedBlob) throw new Error("Usługa podpisująca nie zwróciła podpisu.");
          return { signingInput: currentSigningInput, signature: signed.signedBlob };
        } catch (error) {
          if (!error.apiReasons?.includes("SERVICE_DISABLED")) throw error;
          // The older IAM endpoint uses the same permission and managed key.
          // This one-time fallback avoids enabling an extra API just to bootstrap.
          const signed = await adminRequest(`${iamResource}:signBlob`, "Jednorazowy podpis tokenu automatu (IAM)", { bytesToSign: payload });
          if (!signed.signature) throw new Error("Usługa podpisująca nie zwróciła podpisu.");
          return { signingInput: currentSigningInput, signature: signed.signature };
        }
      } catch (error) {
        if (!retryableSigningError(error) || attempt === retryDelays.length - 1) throw error;
      }
    }
    throw new Error("Nie udało się podpisać tokenu automatu.");
  } finally {
    if (grantAttempted) {
      // Re-read the current policy/etag so that concurrent unrelated grants are
      // preserved. Remove only the member added by this invocation.
      let cleaned = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const current = await getPolicy();
          await adminRequest(`${iamResource}:setIamPolicy`, "Usunięcie tymczasowego prawa podpisu", { policy: removeTemporarySigner(current, member) });
          const verified = await getPolicy();
          cleaned = !(verified.bindings || []).some((binding) => binding.role === TEMP_SIGNER_ROLE && !binding.condition && binding.members?.includes(member));
          if (cleaned) break;
        } catch { /* Retry cleanup without exposing the request or response. */ }
      }
      if (!cleaned) throw new Error("Nie potwierdzono usunięcia tymczasowego prawa podpisu. Sprawdź politykę IAM konta typer-schedule-bootstrap przed ponowieniem.");
    }
  }
}

function retryableSigningError(error) {
  return error?.status === 403 && error.apiCode === "PERMISSION_DENIED"
    && (!error.apiReasons?.length || error.apiReasons.includes("IAM_PERMISSION_DENIED"));
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const configuredProject = JSON.parse(readFileSync(join(ROOT, ".firebaserc"), "utf8")).projects?.default;
  if (configuredProject !== PROJECT_ID) throw new Error("Ten skrypt jest przeznaczony wyłącznie dla projektu Ekstraklapa Typer 2026-27.");
  const { firebaseConfig } = await import(pathToFileURL(join(ROOT, "firebase-config.js")).href);
  if (firebaseConfig.projectId !== PROJECT_ID || !firebaseConfig.apiKey) throw new Error("Niezgodna publiczna konfiguracja Firebase.");
  const wranglerPath = options.wranglerPath || join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wranglerPath)) throw new Error("Brak Wrangler. Wykonaj npm ci albo wskaż zainstalowany plik przez --wrangler.");

  const lib = join(process.env.APPDATA || "", "npm", "node_modules", "firebase-tools", "lib");
  if (!existsSync(join(lib, "auth.js"))) throw new Error("Brak globalnego Firebase CLI. Zainstaluj firebase-tools i wykonaj firebase login.");
  const auth = require(join(lib, "auth.js"));
  const account = auth.getProjectDefaultAccount(ROOT) || auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI nie jest zalogowane.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.user?.email || "")) throw new Error("Brak jednoznacznego konta administratora Firebase CLI.");
  let oauthToken;
  let oauthScope;
  try {
    auth.setActiveAccount({}, account);
    const session = await auth.getAccessToken(account.tokens.refresh_token, []);
    oauthToken = session.access_token;
    oauthScope = session.scope;
  } catch { throw new Error("Nie udało się odświeżyć sesji administratora Firebase CLI."); }
  if (!oauthToken) throw new Error("Brak tokenu administratora Firebase CLI.");
  const adminRequest = (url, label, body, method) => requestJson(url, label, { token: oauthToken, body, ...(method ? { method } : {}) });
  const identity = await adminRequest("https://openidconnect.googleapis.com/v1/userinfo", "Weryfikacja tożsamości administratora OAuth");
  if (identity.email !== account.user.email) throw new Error("Sesja OAuth nie zgadza się z kontem zapisanym w Firebase CLI. Odmowa zmiany IAM.");
  const scopes = String(oauthScope || "").split(/\s+/);
  console.log(`Tożsamość OAuth zgodna z Firebase CLI; zakres cloud-platform: ${scopes.includes("https://www.googleapis.com/auth/cloud-platform")}; zakres IAM: ${scopes.includes("https://www.googleapis.com/auth/iam")}.`);
  const authBase = `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}`;
  const lookupMachine = async () => {
    const payload = await adminRequest(`${authBase}/accounts:lookup`, "Odczyt konta automatu", { localId: [MACHINE_UID] });
    return payload.users?.find((user) => user.localId === MACHINE_UID) || null;
  };
  const machine = await lookupMachine();
  assertMachineAccount(machine);
  let cloudflareError = null;
  let secrets = new Set();
  try { secrets = listSecrets(wranglerPath); }
  catch (error) {
    if (options.mode === "provision") throw error;
    cloudflareError = error;
    console.log(error.message);
  }
  console.log(`Projekt: ${PROJECT_ID}; UID automatu: ${MACHINE_UID}.`);
  console.log(`Konto automatu: ${machine ? "istnieje" : "brak"}; claim scheduleSync: ${machineClaims(machine).scheduleSync === true}; sekret Workera: ${cloudflareError ? "nie sprawdzono" : secrets.has(SECRET_NAME)}.`);
  if (machineClaims(machine).scheduleSync === true && secrets.has(SECRET_NAME)) {
    console.log("Automat jest już skonfigurowany. Nie utworzono nowych danych dostępowych.");
    return;
  }
  if (secrets.has(SECRET_NAME)) throw new Error("Sekret Workera już istnieje, ale konto nie jest gotowe. Odmowa nadpisania sekretu bez wyjaśnienia stanu.");

  if (options.serviceAccount && options.serviceAccount !== SIGNER_EMAIL) throw new Error("Dozwolone jest wyłącznie dedykowane konto typer-schedule-bootstrap, bez ról dostępu do danych.");
  let signer = null;
  try {
    signer = await adminRequest(`https://iam.googleapis.com/v1/projects/${PROJECT_ID}/serviceAccounts/${encodeURIComponent(SIGNER_EMAIL)}`, "Odczyt konta podpisującego");
  } catch (error) { if (error.status !== 404) throw error; }
  if (signer && (signer.projectId !== PROJECT_ID || signer.email !== SIGNER_EMAIL || signer.disabled || signer.displayName !== SIGNER_NAME)) {
    throw new Error("Dedykowana nazwa konta podpisującego jest zajęta przez nieoczekiwaną konfigurację.");
  }
  const projectPolicy = await adminRequest(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:getIamPolicy`,
    "Kontrola braku ról danych konta podpisującego", { options: { requestedPolicyVersion: 3 } });
  if ((projectPolicy.bindings || []).some((binding) => binding.members?.includes(`serviceAccount:${SIGNER_EMAIL}`))) {
    throw new Error("Konto podpisujące ma przyznane role na projekcie. Odmowa użycia tożsamości z dostępem do danych.");
  }
  const permissions = await adminRequest(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}:testIamPermissions`,
    "Kontrola możliwości przygotowania dedykowanego konta podpisującego", {
      permissions: ["iam.serviceAccounts.create", "iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy"]
    });
  const required = ["iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy", ...(!signer ? ["iam.serviceAccounts.create"] : [])];
  const missing = required.filter((permission) => !permissions.permissions?.includes(permission));
  console.log(`Konto podpisujące: ${SIGNER_EMAIL}; istnieje: ${Boolean(signer)}; role na projekcie: brak; przygotowanie IAM: ${missing.length ? "niedostępne" : "dozwolone"}.`);
  if (missing.length) throw new Error(`Brakuje uprawnień do ograniczonego przygotowania podpisu: ${missing.join(", ")}. Nie zmieniono IAM.`);
  if (signer) {
    const signerPolicy = await getSignerPolicy(adminRequest);
    const temporaryGrant = (signerPolicy.bindings || []).some((binding) => binding.role === TEMP_SIGNER_ROLE
      && !binding.condition && binding.members?.includes(`user:${account.user.email}`));
    console.log(`Polityka konta podpisującego: ${signerPolicy.bindings?.length || 0} wpisów; tymczasowy grant operatora: ${temporaryGrant}.`);
  }
  if (options.mode === "check") {
    console.log("Kontrola zakończona. Nie utworzono konta, tokenu ani sekretu.");
    if (cloudflareError) throw cloudflareError;
    return;
  }

  // The JWT is signed remotely with a system-managed key. Neither a
  // private service-account key nor the administrator's token enters Cloudflare.
  if (!signer) {
    signer = await adminRequest(`https://iam.googleapis.com/v1/projects/${PROJECT_ID}/serviceAccounts`, "Utworzenie konta podpisującego bez ról danych", {
      accountId: SIGNER_ID,
      serviceAccount: { displayName: SIGNER_NAME, description: "One-time Firebase custom identity bootstrap. No project IAM/data roles or private keys." }
    });
    if (signer.email !== SIGNER_EMAIL) throw new Error("IAM nie potwierdził oczekiwanego konta podpisującego.");
  }
  const signed = await signWithTemporaryPermission(adminRequest, `user:${account.user.email}`, () => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify(customTokenPayload(SIGNER_EMAIL, Math.floor(Date.now() / 1000)))).toString("base64url");
    return `${header}.${claims}`;
  });

  if (!machine) {
    await adminRequest(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      "Utworzenie konta automatu", { targetProjectId: PROJECT_ID, localId: MACHINE_UID, displayName: MACHINE_NAME });
  }
  await adminRequest(`${authBase}/accounts:update`, "Ograniczenie roli automatu", {
    localId: MACHINE_UID,
    displayName: MACHINE_NAME,
    customAttributes: JSON.stringify({ scheduleSync: true }),
    returnSecureToken: false
  });
  const verifiedMachine = await lookupMachine();
  assertMachineAccount(verifiedMachine);
  if (machineClaims(verifiedMachine).scheduleSync !== true) throw new Error("Firebase nie potwierdził roli automatu.");

  const customToken = `${signed.signingInput}.${Buffer.from(signed.signature, "base64").toString("base64url")}`;
  const session = await requestJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    "Logowanie automatu", { body: { token: customToken, returnSecureToken: true } });
  if (typeof session.refreshToken !== "string" || !session.refreshToken || typeof session.idToken !== "string") {
    throw new Error("Firebase nie potwierdził sesji automatu.");
  }
  let idClaims;
  try { idClaims = JSON.parse(Buffer.from(session.idToken.split(".")[1], "base64url").toString("utf8")); }
  catch { throw new Error("Nieprawidłowy token sesji automatu."); }
  if (idClaims.sub !== MACHINE_UID || idClaims.aud !== PROJECT_ID || idClaims.scheduleSync !== true
    || idClaims.firebase?.sign_in_provider !== "custom") throw new Error("Token sesji ma niewłaściwą tożsamość lub rolę.");
  runWrangler(wranglerPath, ["secret", "put", SECRET_NAME], `${session.refreshToken}\n`);
  if (!listSecrets(wranglerPath).has(SECRET_NAME)) throw new Error("Cloudflare nie potwierdził zapisu sekretu.");
  console.log(`Zapisano ${SECRET_NAME} w istniejącym Workerze. Token przekazano wyłącznie przez stdin; nie zapisano go w pliku ani logu.`);
  console.log("Następnie wdroż reguły i Worker, a stan synchronizacji potwierdź w jego health endpoint.");
}

module.exports = { parseArguments, assertMachineAccount, customTokenPayload, addTemporarySigner, removeTemporarySigner, wranglerEnvironment, parseSecretNames, getSignerPolicy, retryableSigningError };
if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || "Konfiguracja synchronizacji nie powiodła się.");
    process.exitCode = 1;
  });
}
