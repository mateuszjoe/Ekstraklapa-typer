import { matches as baseMatches, teamById, teams, roundDatesByNumber } from "./data.js";
import { firebaseConfig } from "./firebase-config.js";

const bootStartedAt = performance.now();
const app = document.querySelector("#app");
const STORAGE_KEY = "ekstraklasa-typer-state-v1";
const FINAL = new Set(["FT", "AET", "PEN", "AWD", "WO", "FINISHED", "AWARDED"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "IN_PLAY", "PAUSED"]);
const VIEWS = new Set(["matches", "ranking", "rules"]);

function loadSavedState() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    console.warn("Pominięto uszkodzony lokalny zapis typera:", error);
    localStorage.removeItem(STORAGE_KEY);
    return {};
  }
}

const saved = loadSavedState();
const savedLocalUser = saved.user?.provider === "demo" ? saved.user : null;
if (saved.user && !savedLocalUser) {
  delete saved.user;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}
const savedAnonymousPredictions = saved.anonymousPredictions || saved.predictions || {};
const requestedView = location.hash.slice(1);
const state = {
  view: VIEWS.has(requestedView) ? requestedView : "matches",
  leg: Number(saved.leg || 1),
  matchday: Number(saved.matchday || 1),
  predictions: { ...savedAnonymousPredictions },
  anonymousPredictions: { ...savedAnonymousPredictions },
  predictionsByUser: saved.predictionsByUser || {},
  user: savedLocalUser,
  matches: baseMatches.map((match) => ({ ...match })),
  liveSignature: "",
  auth: null,
  db: null,
  authStatus: "loading",
  authBusy: false,
  firebaseModules: null,
  firebaseReady: null
};

if (location.hash && !VIEWS.has(requestedView)) {
  history.replaceState(null, "", `${location.pathname}${location.search}#matches`);
}

const demoPlayers = [
  ["Marek K.", 12, 18, 67], ["Ola W.", 11, 18, 61], ["Krzysztof P.", 10, 18, 56],
  ["Ania S.", 9, 18, 50], ["Bartek M.", 8, 18, 44]
];

async function finishLoadingScreen() {
  const fontsReady = document.fonts?.ready || Promise.resolve();
  await Promise.race([
    Promise.resolve(fontsReady).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1800))
  ]);

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const minimumDuration = reduceMotion ? 180 : 800;
  const remaining = Math.max(0, minimumDuration - (performance.now() - bootStartedAt));

  setTimeout(() => {
    clearTimeout(window.__etLoaderFallback);
    document.documentElement.classList.add("app-ready");
    document.documentElement.classList.remove("app-loading");
    document.querySelector("#appLoader")?.setAttribute("aria-hidden", "true");
    setTimeout(() => document.querySelector("#appLoader")?.remove(), 500);
  }, remaining);
}

function save() {
  if (state.user?.provider === "google.com") {
    state.predictionsByUser[state.user.uid] = { ...state.predictions };
  } else {
    state.anonymousPredictions = { ...state.predictions };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    leg: state.leg,
    matchday: state.matchday,
    anonymousPredictions: state.anonymousPredictions,
    predictionsByUser: state.predictionsByUser,
    user: state.user?.provider === "demo" ? state.user : null
  }));
}

const icon = (name) => ({
  calendar: "<svg viewBox='0 0 24 24'><path d='M7 2v3M17 2v3M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z'/></svg>",
  trophy: "<svg viewBox='0 0 24 24'><path d='M8 4h8v4c0 4-2 7-4 7s-4-3-4-7V4Zm4 11v5m-4 0h8M8 6H4c0 4 2 6 5 6m7-6h4c0 4-2 6-5 6'/></svg>",
  lock: "<svg viewBox='0 0 24 24'><rect x='4' y='10' width='16' height='11' rx='2'/><path d='M8 10V7a4 4 0 0 1 8 0v3'/></svg>",
  check: "<svg viewBox='0 0 24 24'><path d='m5 12 4 4L19 6'/></svg>",
  arrow: "<svg viewBox='0 0 24 24'><path d='m9 18 6-6-6-6'/></svg>"
}[name] || "");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDay(match) {
  const date = new Date(match.kickoffAt);
  return new Intl.DateTimeFormat("pl-PL", { weekday: "short", day: "2-digit", month: "2-digit" }).format(date).replace(",", "");
}

function formatTime(match) {
  if (!match.kickoffConfirmed) return "godz. do ustalenia";
  return new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" }).format(new Date(match.kickoffAt));
}

function resultOf(match) {
  if (!FINAL.has(match.status) || !Number.isFinite(match.homeScore) || !Number.isFinite(match.awayScore)) return null;
  return match.homeScore === match.awayScore ? "X" : match.homeScore > match.awayScore ? "1" : "2";
}

function isLocked(match) {
  return match.kickoffConfirmed && Date.now() >= new Date(match.kickoffAt).getTime();
}

function pointsFor(match) {
  const result = resultOf(match);
  return result && state.predictions[match.id] === result ? 1 : 0;
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".nav-link").forEach((node) => node.classList.toggle("is-active", node.dataset.view === view));
  document.querySelector(".main-nav").classList.remove("is-open");
  render();
  app.focus({ preventScroll: true });
}

function hero() {
  const selected = state.matches.filter((match) => match.matchday === state.matchday);
  const typed = selected.filter((match) => state.predictions[match.id]).length;
  const next = [...state.matches]
    .filter((match) => new Date(match.kickoffAt) > new Date() && match.kickoffConfirmed)
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt))[0];
  return `<section class="hero">
    <div class="hero-glow"></div>
    <div class="hero-copy">
      <span class="season-pill">SEZON 2026/27 · 100 LAT LIGI</span>
      <h1>Jeden typ.<br><em>Jedna emocja.</em></h1>
      <p>Wybierz 1, X albo 2. Każdy trafiony rezultat to punkt. Bez kombinowania — liczy się piłkarskie wyczucie.</p>
      <div class="hero-actions">
        <button class="primary-button" data-scroll-matches>Typuj mecze ${icon("arrow")}</button>
        <button class="text-button" data-view-jump="rules">Jak to działa?</button>
      </div>
    </div>
    <div class="hero-side">
      <p class="eyebrow">NAJBLIŻSZY MECZ</p>
      ${next ? `<div class="next-match">
        <div class="next-date"><b>${formatDay(next)}</b><span>${formatTime(next)}</span></div>
        <div class="next-teams">
          <div><img src="${teamById[next.home].crest}" alt=""><b>${teamById[next.home].short}</b></div>
          <span>VS</span>
          <div><img src="${teamById[next.away].crest}" alt=""><b>${teamById[next.away].short}</b></div>
        </div>
        <div class="countdown" data-countdown="${next.kickoffAt}">Start za chwilę</div>
      </div>` : "<p>Brak nadchodzących meczów.</p>"}
      <div class="hero-progress"><span><b>${typed}/9</b> typów w tej kolejce</span><i><u style="width:${typed / 9 * 100}%"></u></i></div>
    </div>
  </section>`;
}

function matchCard(match) {
  const home = teamById[match.home];
  const away = teamById[match.away];
  const prediction = state.predictions[match.id];
  const locked = isLocked(match);
  const live = LIVE.has(match.status);
  const final = FINAL.has(match.status);
  const score = (live || final) && Number.isFinite(match.homeScore) ? `${match.homeScore} : ${match.awayScore}` : null;
  return `<article class="match-card ${prediction ? "is-typed" : ""} ${live ? "is-live" : ""}">
    <div class="match-meta">
      <span>${live ? `<b class="live-label">LIVE${Number.isFinite(match.liveElapsed) ? ` ${match.liveElapsed}'` : ""}</b>` : `${formatDay(match)} · ${formatTime(match)}`}</span>
      <span>${locked ? `${icon("lock")} zamknięty` : prediction ? `${icon("check")} typ zapisany` : "1 pkt do zdobycia"}</span>
    </div>
    <div class="match-teams">
      <div class="team home"><span>${home.name}</span><img src="${home.crest}" alt="Herb ${home.name}"></div>
      <div class="score-zone">${score ? `<strong>${score}</strong>` : `<span>VS</span>`}</div>
      <div class="team away"><img src="${away.crest}" alt="Herb ${away.name}"><span>${away.name}</span></div>
    </div>
    <div class="prediction-row" role="group" aria-label="Typ na mecz ${home.name} — ${away.name}">
      ${[["1",home.short],["X","REMIS"],["2",away.short]].map(([pick,label]) => `<button data-pick="${pick}" data-match="${match.id}" class="pick ${prediction === pick ? "selected" : ""}" aria-pressed="${prediction === pick}" ${locked ? "disabled" : ""}><b>${pick}</b><small>${label}</small></button>`).join("")}
    </div>
    ${(live || final) ? `<button class="match-centre-link" data-match-centre="${match.id}">Szczegóły wyniku ${icon("arrow")}</button>` : ""}
  </article>`;
}

function liveMatchesSection() {
  const liveMatches = state.matches
    .filter((match) => LIVE.has(match.status))
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));

  if (!liveMatches.length) return "";

  return `<section class="content-section live-now-section" aria-labelledby="live-now-title">
    <div class="live-now-heading">
      <div><p class="eyebrow"><i class="live-dot"></i> NA ŻYWO</p><h2 id="live-now-title">Mecze trwające teraz</h2></div>
      <p>Wyniki spotkań aktualizują się automatycznie.</p>
    </div>
    <div class="matches-grid live-now-grid">${liveMatches.map(matchCard).join("")}</div>
  </section>`;
}

function matchesView() {
  const visible = state.matches
    .filter((match) => match.matchday === state.matchday && !LIVE.has(match.status))
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
  const roundOptions = Array.from({ length: 17 }, (_, index) => index + (state.leg === 1 ? 1 : 18));
  return `${hero()}
    <section class="club-ribbon" aria-label="Kluby sezonu 2026/27">${teams.map((team) => `<img src="${team.crest}" alt="${team.name}" title="${team.name}">`).join("")}</section>
    ${liveMatchesSection()}
    <section class="content-section" id="mecze">
      <div class="section-heading">
        <div><p class="eyebrow">TERMINARZ I TYPY</p><h2>Mecze Ekstraklasy</h2><p>Wybierz rezultat każdego spotkania. Typ blokuje się wraz z pierwszym gwizdkiem.</p></div>
        <div class="stats-inline"><span><b>${state.matches.filter((m) => state.predictions[m.id]).length}</b> oddanych typów</span><span><b>${state.matches.reduce((sum, m) => sum + pointsFor(m), 0)}</b> punktów</span></div>
      </div>
      <div class="filters">
        <div class="segmented"><button data-leg="1" class="${state.leg === 1 ? "active" : ""}" aria-pressed="${state.leg === 1}">Runda 1 <small>kolejki 1–17</small></button><button data-leg="2" class="${state.leg === 2 ? "active" : ""}" aria-pressed="${state.leg === 2}">Runda 2 <small>kolejki 18–34</small></button></div>
        <label class="select-wrap">${icon("calendar")}<select id="matchdaySelect">${roundOptions.map((round) => `<option value="${round}" ${state.matchday === round ? "selected" : ""}>${round}. kolejka · ${new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "long" }).format(new Date(`${roundDatesByNumber[round]}T12:00:00`))}</option>`).join("")}</select></label>
      </div>
      <div class="round-note"><span>${visible.some((m) => !m.kickoffConfirmed) ? "Daty ramowe" : "Terminy potwierdzone"}</span>${visible.some((m) => !m.kickoffConfirmed) ? "Dokładne dni i godziny tej kolejki nie zostały jeszcze opublikowane. Typy nie zostaną zablokowane na podstawie daty ramowej." : "Godziny zgodne z oficjalnym terminarzem Ekstraklasy."}</div>
      <div class="matches-grid">${visible.map(matchCard).join("")}</div>
    </section>`;
}

function rankingView() {
  const ownPoints = state.matches.reduce((sum, match) => sum + pointsFor(match), 0);
  const ownTyped = Object.keys(state.predictions).length;
  const players = state.user ? [[state.user.name, ownPoints, ownTyped, ownTyped ? Math.round(ownPoints / ownTyped * 100) : 0, true], ...demoPlayers] : demoPlayers;
  return `<section class="subpage-hero"><p class="eyebrow">KLASYFIKACJA</p><h1>Ranking typerów</h1><p>Każdy trafiony rezultat to dokładnie jeden punkt.</p></section>
    <section class="content-section narrow">
      ${!state.user ? `<div class="notice">Zaloguj się, żeby pojawić się w rankingu i zapisywać typy między urządzeniami.</div>` : ""}
      <div class="ranking-card">
        <div class="ranking-head"><span>#</span><span>Gracz</span><span>Punkty</span><span>Typy</span><span>Skuteczność</span></div>
        ${players.sort((a,b) => b[1]-a[1]).map((player,index) => {
          const playerName = String(player[0] || "Gracz");
          return `<div class="ranking-row ${player[4] ? "me" : ""}"><b>${index + 1}</b><span><i>${escapeHtml(playerName.slice(0,1))}</i><strong>${escapeHtml(playerName)}</strong>${player[4] ? "<small>TY</small>" : ""}</span><strong>${player[1]}</strong><span>${player[2]}</span><span>${player[3]}%</span></div>`;
        }).join("")}
      </div>
      <p class="demo-caption">Pozostali gracze są danymi demonstracyjnymi do czasu podłączenia Firebase.</p>
    </section>`;
}

function rulesView() {
  return `<section class="subpage-hero"><p class="eyebrow">PROSTE ZASADY</p><h1>Piłka jest prosta.<br>Ten typer też.</h1></section>
    <section class="content-section narrow rules-grid">
      <article><b>01</b><span>${icon("calendar")}</span><h3>Wybierz 1, X lub 2</h3><p>1 oznacza wygraną gospodarzy, X remis, a 2 wygraną gości. Nie typujemy dokładnych wyników.</p></article>
      <article><b>02</b><span>${icon("lock")}</span><h3>Zdąż przed gwizdkiem</h3><p>Typ możesz zmieniać do rozpoczęcia meczu. Później zostaje automatycznie zablokowany.</p></article>
      <article><b>03</b><span>${icon("trophy")}</span><h3>Zdobądź 1 punkt</h3><p>Za każdy prawidłowy rezultat otrzymujesz jeden punkt. Wygrywa najwyższy wynik po 34. kolejce.</p></article>
      <div class="rule-banner">
        <div class="rule-stat"><strong>100 zł</strong><span>wstępne wpisowe</span></div>
        <div class="rule-stat"><strong>306</strong><span>meczów</span></div>
        <div class="rule-stat"><strong>34</strong><span>kolejki</span></div>
        <div class="rule-stat"><strong>1</strong><span>punkt za trafienie</span></div>
      </div>
      <p class="rule-pool-note"><strong>Ważne:</strong> szczegóły dotyczące podziału puli oraz ostateczna wysokość składki zostaną ustalone wkrótce.</p>
    </section>`;
}

function render() {
  app.innerHTML = state.view === "ranking" ? rankingView() : state.view === "rules" ? rulesView() : matchesView();
  document.querySelectorAll(".nav-link").forEach((node) => node.classList.toggle("is-active", node.dataset.view === state.view));
  updateAuthButton();
  bindRendered();
  updateCountdowns();
}

function bindRendered() {
  app.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", () => setPrediction(button.dataset.match, button.dataset.pick)));
  app.querySelectorAll("[data-leg]").forEach((button) => button.addEventListener("click", () => {
    state.leg = Number(button.dataset.leg); state.matchday = state.leg === 1 ? 1 : 18; save(); render();
  }));
  app.querySelector("#matchdaySelect")?.addEventListener("change", (event) => { state.matchday = Number(event.target.value); save(); render(); });
  app.querySelectorAll("[data-view-jump]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewJump)));
  app.querySelector("[data-scroll-matches]")?.addEventListener("click", () => document.querySelector("#mecze")?.scrollIntoView({ behavior: "smooth" }));
  app.querySelectorAll("[data-match-centre]").forEach((button) => button.addEventListener("click", () => showMatchCentre(button.dataset.matchCentre)));
}

async function setPrediction(matchId, pick) {
  const match = state.matches.find((item) => item.id === matchId);
  if (!match || isLocked(match)) return notify("Ten mecz już się rozpoczął — typ jest zamknięty.");
  state.predictions[matchId] = pick;
  save();
  let synced = true;
  if (state.auth?.currentUser?.uid === state.user?.uid) {
    try {
      await saveRemotePrediction(matchId, pick);
    } catch (error) {
      synced = false;
      console.error("Nie udało się zapisać typu w Firestore:", error);
    }
  }
  render();
  notify(synced ? `Typ ${pick} zapisany` : `Typ ${pick} zapisany lokalnie — synchronizacja spróbuje ponownie później`);
}

function showMatchCentre(matchId) {
  const match = state.matches.find((item) => item.id === matchId);
  const home = teamById[match.home], away = teamById[match.away];
  const status = LIVE.has(match.status) ? `LIVE${match.liveElapsed ? ` · ${match.liveElapsed}'` : ""}` : FINAL.has(match.status) ? "Mecz zakończony" : "Mecz zaplanowany";
  const matchDialog = document.querySelector("#matchDialog");
  matchDialog.innerHTML = `<button class="modal-close" data-close>×</button><p class="eyebrow">WYNIK MECZU</p><div class="modal-score"><div><img src="${home.crest}" alt=""><b>${home.name}</b></div><strong>${Number.isFinite(match.homeScore) ? `${match.homeScore} : ${match.awayScore}` : "– : –"}</strong><div><img src="${away.crest}" alt=""><b>${away.name}</b></div></div><p class="no-events">${status}</p>`;
  matchDialog.showModal();
}

function notify(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message; toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2400);
}

function updateAuthButton() {
  const authButton = document.querySelector("#authButton");
  const iconNode = document.createElement("span");
  const labelNode = document.createElement("span");
  if (state.user) {
    iconNode.className = "avatar";
    iconNode.textContent = state.user.name.slice(0, 1).toUpperCase();
    labelNode.textContent = state.user.name.split(" ")[0];
  } else {
    iconNode.className = "user-icon";
    iconNode.textContent = "◉";
    labelNode.textContent = "Zaloguj się";
  }
  authButton.replaceChildren(iconNode, labelNode);

  const googleButton = document.querySelector("#authDialog [data-provider='google']");
  if (googleButton) {
    googleButton.disabled = state.authStatus !== "ready" || state.authBusy;
    googleButton.innerHTML = state.authBusy
      ? "Otwieranie Google…"
      : state.authStatus === "loading"
      ? "Łączenie z Google…"
      : state.authStatus === "unavailable"
        ? "Logowanie Google chwilowo niedostępne"
        : "<span>G</span> Kontynuuj przez Google";
  }
}

function openAccountDialog() {
  const dialog = document.querySelector("#accountDialog");
  if (!dialog || !state.user) return;
  dialog.querySelector("#accountName").textContent = state.user.name;
  dialog.querySelector("#accountDetails").textContent = state.user.provider === "google.com"
    ? state.user.email || "Zalogowano przez Google"
    : "Tryb demonstracyjny · dane tylko na tym urządzeniu";
  dialog.showModal();
}

function updateCountdowns() {
  document.querySelectorAll("[data-countdown]").forEach((node) => {
    const delta = new Date(node.dataset.countdown) - new Date();
    if (delta <= 0) return node.textContent = "Mecz rozpoczęty";
    const days = Math.floor(delta / 86400000); const hours = Math.floor(delta % 86400000 / 3600000);
    node.textContent = days ? `Start za ${days} dni i ${hours} godz.` : `Start za ${hours} godz.`;
  });
}

function loginDemo() {
  state.user = { uid: "demo-local", name: "Gracz Demo", provider: "demo" };
  state.predictions = { ...state.anonymousPredictions };
  save();
  document.querySelector("#authDialog")?.close();
  render();
  notify("Uruchomiono tryb demonstracyjny na tym urządzeniu");
}

function isInAppBrowser() {
  return /FBAN|FBAV|FB_IAB|Instagram|Messenger|LinkedInApp|; wv\)|\bwv\b/i.test(navigator.userAgent || "");
}

function authErrorMessage(error) {
  const messages = {
    "auth/unauthorized-domain": "Ta domena nie jest jeszcze dopuszczona w Google. Odśwież stronę za chwilę.",
    "auth/operation-not-allowed": "Logowanie Google nie jest włączone w Firebase.",
    "auth/popup-blocked": "Przeglądarka zablokowała okno Google. Zezwól na wyskakujące okna i spróbuj ponownie.",
    "auth/popup-closed-by-user": "Okno logowania Google zostało zamknięte.",
    "auth/cancelled-popup-request": "Poprzednia próba logowania została anulowana. Spróbuj ponownie.",
    "auth/network-request-failed": "Nie udało się połączyć z Google. Sprawdź internet i spróbuj ponownie.",
    "auth/invalid-api-key": "Konfiguracja logowania Google jest nieprawidłowa."
  };
  return messages[error?.code] || "Logowanie Google nie powiodło się. Spróbuj ponownie.";
}

async function handleAuthState(user) {
  state.authStatus = "ready";
  if (!user) {
    if (state.user?.provider === "google.com") {
      state.user = null;
      state.predictions = { ...state.anonymousPredictions };
      save();
    }
    render();
    return;
  }

  const previousWasGoogle = state.user?.provider === "google.com";
  const pendingLocal = previousWasGoogle ? {} : { ...state.anonymousPredictions };
  const cached = state.predictionsByUser[user.uid] || {};
  state.user = {
    uid: user.uid,
    name: user.displayName || user.email || "Gracz",
    email: user.email || "",
    provider: "google.com"
  };

  let remote = {};
  try {
    remote = await loadRemotePredictions(user.uid);
  } catch (error) {
    console.error("Nie udało się pobrać typów z Firestore:", error);
    notify("Zalogowano przez Google, ale synchronizacja typów jest chwilowo niedostępna");
  }

  if (state.auth?.currentUser?.uid !== user.uid) return;

  state.predictions = { ...cached, ...pendingLocal, ...remote };
  state.predictionsByUser[user.uid] = { ...state.predictions };
  if (Object.keys(pendingLocal).length) state.anonymousPredictions = {};
  save();
  render();
  document.querySelector("#authDialog")?.close();

  try {
    await syncPredictionsToRemote();
  } catch (error) {
    console.error("Nie udało się zsynchronizować lokalnych typów:", error);
  }
}

async function initFirebase() {
  if (!firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId) {
    state.authStatus = "unavailable";
    render();
    return;
  }

  try {
    const [{ initializeApp }, authModule, firestore] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js")
    ]);
    const firebaseApp = initializeApp(firebaseConfig);
    state.auth = authModule.getAuth(firebaseApp);
    state.db = firestore.getFirestore(firebaseApp);
    state.firebaseModules = { ...authModule, ...firestore };
    authModule.onAuthStateChanged(state.auth, (user) => {
      handleAuthState(user).catch((error) => {
        console.error("Błąd obsługi sesji Firebase:", error);
        state.authStatus = "ready";
        render();
      });
    });
  } catch (error) {
    state.authStatus = "unavailable";
    console.error("Firebase nie został uruchomiony:", error);
    render();
  }
}

async function loginGoogle() {
  if (isInAppBrowser()) {
    notify("Otwórz tę stronę w Chrome lub Safari, aby zalogować się przez Google");
    return;
  }
  if (state.authStatus === "loading") await state.firebaseReady;
  if (!state.auth || !state.firebaseModules || state.authStatus !== "ready") {
    notify("Logowanie Google jest chwilowo niedostępne. Odśwież stronę i spróbuj ponownie.");
    return;
  }
  if (state.authBusy) return;

  const { GoogleAuthProvider, signInWithPopup } = state.firebaseModules;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  state.authBusy = true;
  updateAuthButton();
  try {
    await signInWithPopup(state.auth, provider);
    document.querySelector("#authDialog")?.close();
  } catch (error) {
    console.error("Logowanie Google nie powiodło się:", error?.code, error);
    notify(authErrorMessage(error));
  } finally {
    state.authBusy = false;
    updateAuthButton();
  }
}

async function logout() {
  document.querySelector("#accountDialog")?.close();
  if (state.auth?.currentUser && state.firebaseModules?.signOut) {
    try {
      await state.firebaseModules.signOut(state.auth);
      notify("Wylogowano");
    } catch (error) {
      console.error("Wylogowanie nie powiodło się:", error);
      notify("Nie udało się wylogować. Spróbuj ponownie.");
    }
    return;
  }

  state.user = null;
  state.predictions = { ...state.anonymousPredictions };
  save();
  render();
  notify("Wyłączono tryb demonstracyjny");
}

async function saveRemotePrediction(matchId, pick) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== state.user?.uid) return;
  const { doc, setDoc, serverTimestamp } = state.firebaseModules;
  await setDoc(doc(state.db, "predictions", `${state.user.uid}_${matchId}`), {
    uid: state.user.uid,
    matchId,
    pick,
    updatedAt: serverTimestamp()
  });
}

async function loadRemotePredictions(uid) {
  const { collection, query, where, getDocs } = state.firebaseModules;
  const snapshot = await getDocs(query(collection(state.db, "predictions"), where("uid", "==", uid)));
  const predictions = {};
  snapshot.forEach((item) => {
    const data = item.data();
    if (typeof data.matchId === "string" && ["1", "X", "2"].includes(data.pick)) predictions[data.matchId] = data.pick;
  });
  return predictions;
}

async function syncPredictionsToRemote() {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== state.user?.uid) return;
  const entries = Object.entries(state.predictions).filter(([matchId, pick]) => {
    const match = state.matches.find((item) => item.id === matchId);
    return match && !isLocked(match) && ["1", "X", "2"].includes(pick);
  });
  if (!entries.length) return;
  const { doc, writeBatch, serverTimestamp } = state.firebaseModules;
  const batch = writeBatch(state.db);
  entries.forEach(([matchId, pick]) => {
    batch.set(doc(state.db, "predictions", `${state.user.uid}_${matchId}`), {
      uid: state.user.uid,
      matchId,
      pick,
      updatedAt: serverTimestamp()
    });
  });
  await batch.commit();
}

function normalizeName(value) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

async function pollLive() {
  let nextDelay = 5 * 60_000;
  try {
    const response = await fetch("./api/live");
    if (!response.ok) return;
    const payload = await response.json();
    const providerInterval = Number(payload.pollIntervalSeconds) * 1000;
    if (Number.isFinite(providerInterval)) {
      nextDelay = Math.min(5 * 60_000, Math.max(30_000, providerInterval));
    }
    const incomingMatchIds = new Set(
      (payload.fixtures || []).map((fixture) => fixture.localMatchId).filter(Boolean)
    );
    state.matches.forEach((match) => {
      if (LIVE.has(match.status) && !incomingMatchIds.has(match.id)) {
        match.status = "SUSP";
        match.liveElapsed = null;
      }
    });
    const signature = (payload.fixtures || []).map((fixture) => [
      fixture.providerId, fixture.status, fixture.elapsed, fixture.score?.home,
      fixture.score?.away, fixture.kickoffAt, fixture.source
    ].join(":")).join("|");
    const dataChanged = signature !== state.liveSignature;
    state.liveSignature = signature;
    payload.fixtures?.forEach((fixture) => {
      const target = state.matches.find((match) => match.id === fixture.localMatchId) || state.matches.find((match) => {
        const sameTeams = normalizeName(teamById[match.home].name).includes(normalizeName(fixture.home.name)) || normalizeName(fixture.home.name).includes(normalizeName(teamById[match.home].name));
        const sameAway = normalizeName(teamById[match.away].name).includes(normalizeName(fixture.away.name)) || normalizeName(fixture.away.name).includes(normalizeName(teamById[match.away].name));
        const close = Math.abs(new Date(match.kickoffAt) - new Date(fixture.kickoffAt)) < 3 * 3600000;
        return sameTeams && sameAway && close;
      });
      if (!target) return;
      Object.assign(target, {
        status: fixture.status,
        liveElapsed: fixture.elapsed,
        homeScore: fixture.score.home,
        awayScore: fixture.score.away,
        kickoffAt: fixture.kickoffAt || target.kickoffAt,
        kickoffConfirmed: Boolean(fixture.kickoffAt),
        resultSource: fixture.source
      });
    });
    if (dataChanged || state.matches.some((match) => LIVE.has(match.status))) render();
  } catch { /* statyczny serwer lub brak adaptera — aplikacja nadal działa */ }
  finally { setTimeout(pollLive, nextDelay); }
}

document.addEventListener("click", (event) => {
  const navButton = event.target.closest?.(".nav-link[data-view]");
  if (navButton) {
    event.preventDefault();
    setView(navButton.dataset.view);
    return;
  }

  const routeLink = event.target.closest?.("[data-route]");
  if (routeLink) {
    event.preventDefault();
    setView(routeLink.dataset.route);
    return;
  }

  if (event.target.closest?.("#menuButton")) {
    document.querySelector(".main-nav")?.classList.toggle("is-open");
    return;
  }

  if (event.target.closest?.("#authButton")) {
    if (state.user) openAccountDialog();
    else document.querySelector("#authDialog")?.showModal();
    return;
  }

  const providerButton = event.target.closest?.("#authDialog [data-provider]");
  if (providerButton) {
    if (providerButton.dataset.provider === "demo") loginDemo();
    else loginGoogle();
    return;
  }

  if (event.target.closest?.("[data-sign-out]")) {
    logout();
    return;
  }

  const closeButton = event.target.closest?.("dialog [data-close]");
  if (closeButton) {
    closeButton.closest("dialog")?.close();
    return;
  }

  if (event.target.matches?.("#matchDialog")) event.target.close();
}, { capture: true });
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (!VIEWS.has(view)) {
    history.replaceState(null, "", `${location.pathname}${location.search}#matches`);
    setView("matches");
    return;
  }
  setView(view);
});

render();
finishLoadingScreen();
state.firebaseReady = initFirebase();
pollLive();
setInterval(updateCountdowns, 60000);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const registerServiceWorker = () => navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (document.readyState === "complete") registerServiceWorker();
  else window.addEventListener("load", registerServiceWorker, { once: true });
}
