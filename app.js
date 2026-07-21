import { matches as baseMatches, teamById, teams, roundDatesByNumber } from "./data.js";
import { firebaseConfig } from "./firebase-config.js";

const bootStartedAt = performance.now();
const app = document.querySelector("#app");
const STORAGE_KEY = "ekstraklasa-typer-state-v1";
const FINAL = new Set(["FT", "AET", "PEN", "AWD", "WO", "FINISHED", "AWARDED"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "IN_PLAY", "PAUSED"]);
const VIEWS = new Set(["matches", "ranking", "rules", "settings"]);
const DEFAULT_AVATAR = Object.freeze({ type: "google", value: "" });
const MAX_AVATAR_FILE_SIZE = 8 * 1024 * 1024;
const MAX_AVATAR_DATA_LENGTH = 180_000;

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

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const saved = loadSavedState();
const deprecatedLocalKeys = ["user", "predictions", "anonymousPredictions"];
if (deprecatedLocalKeys.some((key) => key in saved)) {
  deprecatedLocalKeys.forEach((key) => delete saved[key]);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}
const requestedView = location.hash.slice(1);
const state = {
  view: VIEWS.has(requestedView) ? requestedView : "matches",
  leg: Number(saved.leg || 1),
  matchday: Number(saved.matchday || 1),
  predictions: {},
  predictionsByUser: asRecord(saved.predictionsByUser),
  avatar: { ...DEFAULT_AVATAR },
  avatarsByUser: asRecord(saved.avatarsByUser),
  avatarBusy: false,
  avatarPending: false,
  avatarOperationId: 0,
  user: null,
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
    if (state.avatar.type === "upload") delete state.avatarsByUser[state.user.uid];
    else state.avatarsByUser[state.user.uid] = { ...state.avatar };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    leg: state.leg,
    matchday: state.matchday,
    predictionsByUser: state.predictionsByUser,
    avatarsByUser: state.avatarsByUser
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

function stockAvatarSource({ emoji, background, accent }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="${background}"/><circle cx="96" cy="92" r="69" fill="#fffdf8" stroke="#0d0d0d" stroke-width="7"/><path d="M31 157c28-17 102-17 130 0" fill="none" stroke="${accent}" stroke-width="11" stroke-linecap="round"/><text x="96" y="119" text-anchor="middle" font-size="80" font-family="Segoe UI Emoji,Apple Color Emoji,Noto Color Emoji,sans-serif">${emoji}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const stockAvatars = [
  { id: "bananowy-drybler", label: "Bananowy drybler", emoji: "🍌", background: "#ffd000", accent: "#6ead32" },
  { id: "goat-osiedlowy", label: "GOAT osiedlowy", emoji: "🐐", background: "#a9df77", accent: "#ffd000" },
  { id: "sedzia-var", label: "Sędzia z VAR-u", emoji: "🥸", background: "#f2eee3", accent: "#e44735" },
  { id: "krol-murawy", label: "Król murawy", emoji: "👑", background: "#ffd86b", accent: "#0d0d0d" },
  { id: "kibic-incognito", label: "Kibic incognito", emoji: "🕶️", background: "#d5cef7", accent: "#6ead32" },
  { id: "magik-pilki", label: "Magik piłki", emoji: "🧙", background: "#bfe5ff", accent: "#ffd000" }
].map((avatar) => ({ ...avatar, src: stockAvatarSource(avatar) }));

function normalizeAvatar(value) {
  const type = value?.type || value?.avatarType;
  const avatarValue = value?.value ?? value?.avatarValue ?? "";
  if (type === "google" && avatarValue === "") return { type, value: "" };
  if (type === "club" && typeof avatarValue === "string" && teamById[avatarValue]) return { type, value: avatarValue };
  if (type === "stock" && stockAvatars.some((avatar) => avatar.id === avatarValue)) return { type, value: avatarValue };
  if (type === "upload" && typeof avatarValue === "string" && /^data:image\/(?:webp|jpeg);base64,/i.test(avatarValue) && avatarValue.length <= MAX_AVATAR_DATA_LENGTH) {
    return { type, value: avatarValue };
  }
  return null;
}

function avatarSource(avatar = state.avatar, user = state.user) {
  const normalized = normalizeAvatar(avatar) || { ...DEFAULT_AVATAR };
  if (normalized.type === "club") return teamById[normalized.value]?.crest || "";
  if (normalized.type === "stock") return stockAvatars.find((item) => item.id === normalized.value)?.src || "";
  if (normalized.type === "upload") return normalized.value;
  return user?.photoURL || "";
}

function avatarVisualMarkup(className, label, avatar = state.avatar, user = state.user) {
  const normalized = normalizeAvatar(avatar) || { ...DEFAULT_AVATAR };
  const source = avatarSource(normalized, user);
  const initial = String(user?.name || "G").slice(0, 1).toUpperCase();
  const clubClass = normalized.type === "club" ? " is-club" : "";
  return `<span class="${className} avatar-visual${clubClass}"><span aria-hidden="true">${escapeHtml(initial)}</span>${source ? `<img data-avatar-image src="${escapeHtml(source)}" alt="${escapeHtml(label || "Avatar")}">` : ""}</span>`;
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
  const player = state.user
    ? [state.user.name, ownPoints, ownTyped, ownTyped ? Math.round(ownPoints / ownTyped * 100) : 0]
    : null;
  return `<section class="subpage-hero"><p class="eyebrow">KLASYFIKACJA</p><h1>Ranking typerów</h1><p>Każdy trafiony rezultat to dokładnie jeden punkt.</p></section>
    <section class="content-section narrow">
      ${!state.user ? `<div class="notice">Zaloguj się przez Google, żeby pojawić się w rankingu i zapisywać typy między urządzeniami.</div>` : ""}
      <div class="ranking-card">
        <div class="ranking-head"><span>#</span><span>Gracz</span><span>Punkty</span><span>Typy</span><span>Skuteczność</span></div>
        ${player ? (() => {
          const playerName = String(player[0] || "Gracz");
          return `<div class="ranking-row me"><b>—</b><span>${avatarVisualMarkup("ranking-avatar", `Avatar ${playerName}`)}<strong>${escapeHtml(playerName)}</strong><small>TY</small></span><strong>${player[1]}</strong><span>${player[2]}</span><span>${player[3]}%</span></div>`;
        })() : `<div class="ranking-empty"><strong>Brak graczy do wyświetlenia</strong><span>Ranking pokazuje wyłącznie prawdziwe konta Google — bez fikcyjnych wpisów.</span></div>`}
      </div>
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

function settingsView() {
  const heroMarkup = `<section class="subpage-hero"><p class="eyebrow">TWÓJ PROFIL</p><h1>Ustawienia</h1><p>Wybierz twarz, z którą wchodzisz do gry.</p></section>`;
  if (!state.user) {
    return `${heroMarkup}<section class="content-section narrow"><div class="settings-locked"><div class="settings-lock-icon">G</div><h2>Zaloguj się przez Google</h2><p>Avatar jest częścią prawdziwego profilu gracza i synchronizuje się między urządzeniami.</p><button class="primary-button" data-open-auth>PRZEJDŹ DO LOGOWANIA ${icon("arrow")}</button></div></section>`;
  }

  const disabled = state.avatarBusy ? "disabled" : "";
  const currentType = state.avatar.type;
  const currentValue = state.avatar.value;
  const googleAvatar = { type: "google", value: "" };
  return `${heroMarkup}<section class="content-section settings-section">
    <div class="settings-profile-card">
      ${avatarVisualMarkup("settings-avatar-preview", `Avatar ${state.user.name}`)}
      <div><p class="eyebrow">AKTUALNY AVATAR</p><h2>${escapeHtml(state.user.name)}</h2><span>${escapeHtml(state.user.email || "Konto Google")}</span></div>
      <small>${state.avatarBusy ? "Zapisywanie…" : state.avatarPending ? "Oczekuje na synchronizację" : "Zapisany na Twoim koncie"}</small>
    </div>
    <div class="settings-panels">
      <article class="settings-panel">
        <div class="settings-panel-heading"><span>01</span><div><h3>Zdjęcie lub grafika</h3><p>Użyj zdjęcia Google albo wgraj własny plik. Grafikę automatycznie przytniemy do kwadratu.</p></div></div>
        <div class="avatar-source-actions">
          <button class="avatar-source-card ${currentType === "google" ? "is-selected" : ""}" data-avatar-type="google" data-avatar-value="" aria-pressed="${currentType === "google"}" ${disabled}>
            ${avatarVisualMarkup("avatar-option-image", "Zdjęcie Google", googleAvatar)}<span><strong>Zdjęcie Google</strong><small>lub inicjał konta</small></span>
          </button>
          <label class="avatar-upload-card ${currentType === "upload" ? "is-selected" : ""} ${state.avatarBusy ? "is-disabled" : ""}">
            <input id="avatarUpload" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" ${disabled}>
            <span class="upload-mark">↑</span><span><strong>Wgraj własną</strong><small>JPG, PNG lub WEBP · maks. 8 MB</small></span>
          </label>
        </div>
      </article>

      <article class="settings-panel">
        <div class="settings-panel-heading"><span>02</span><div><h3>Twój klub Ekstraklasy</h3><p>Wybierz herb, który będzie reprezentował Cię w typerze.</p></div></div>
        <div class="club-avatar-grid">${teams.map((team) => `<button class="avatar-choice club-avatar-choice ${currentType === "club" && currentValue === team.id ? "is-selected" : ""}" data-avatar-type="club" data-avatar-value="${team.id}" aria-pressed="${currentType === "club" && currentValue === team.id}" title="${escapeHtml(team.name)}" ${disabled}><img src="${team.crest}" alt=""><span>${escapeHtml(team.name)}</span></button>`).join("")}</div>
      </article>

      <article class="settings-panel">
        <div class="settings-panel-heading"><span>03</span><div><h3>Śmieszne gotowce</h3><p>Gdy herb to za mało, wybierz avatara z lekkim poślizgiem.</p></div></div>
        <div class="stock-avatar-grid">${stockAvatars.map((avatar) => `<button class="avatar-choice stock-avatar-choice ${currentType === "stock" && currentValue === avatar.id ? "is-selected" : ""}" data-avatar-type="stock" data-avatar-value="${avatar.id}" aria-pressed="${currentType === "stock" && currentValue === avatar.id}" ${disabled}><img src="${escapeHtml(avatar.src)}" alt=""><span>${escapeHtml(avatar.label)}</span></button>`).join("")}</div>
      </article>
    </div>
  </section>`;
}

function render() {
  app.innerHTML = state.view === "ranking"
    ? rankingView()
    : state.view === "rules"
      ? rulesView()
      : state.view === "settings"
        ? settingsView()
        : matchesView();
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
  app.querySelector("[data-open-auth]")?.addEventListener("click", () => document.querySelector("#authDialog")?.showModal());
  app.querySelectorAll("[data-avatar-type]").forEach((button) => button.addEventListener("click", () => selectAvatar(button.dataset.avatarType, button.dataset.avatarValue || "")));
  app.querySelector("#avatarUpload")?.addEventListener("change", (event) => handleAvatarUpload(event.target.files?.[0]));
  app.querySelectorAll("[data-avatar-image]").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));
}

async function setPrediction(matchId, pick) {
  if (!state.user || state.user.provider !== "google.com" || state.auth?.currentUser?.uid !== state.user.uid) {
    document.querySelector("#authDialog")?.showModal();
    notify("Zaloguj się przez Google, aby oddać typ");
    return;
  }
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
    const source = avatarSource();
    if (state.avatar.type === "club") iconNode.classList.add("is-club");
    if (source) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = "";
      image.addEventListener("error", () => image.remove(), { once: true });
      iconNode.append(image);
    }
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
  dialog.querySelector("#accountDetails").textContent = state.user.email || "Zalogowano przez Google";
  const avatarHost = dialog.querySelector("#accountAvatar");
  if (avatarHost) {
    avatarHost.innerHTML = avatarVisualMarkup("account-avatar-image", `Avatar ${state.user.name}`);
    avatarHost.querySelector("[data-avatar-image]")?.addEventListener("error", (event) => event.currentTarget.remove(), { once: true });
  }
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

async function selectAvatar(type, value) {
  if (!state.user || state.auth?.currentUser?.uid !== state.user.uid) {
    document.querySelector("#authDialog")?.showModal();
    return;
  }
  if (state.avatarBusy) return;

  const nextAvatar = normalizeAvatar({ type, value });
  if (!nextAvatar) {
    notify("Nie udało się wybrać tego avatara");
    return;
  }

  const uid = state.user.uid;
  const operationId = ++state.avatarOperationId;
  const previousAvatar = { ...state.avatar };
  state.avatar = nextAvatar;
  state.avatarBusy = true;
  state.avatarPending = false;
  save();
  render();

  const saveResult = saveRemoteAvatar(uid, nextAvatar).then(
    () => ({ status: "saved" }),
    (error) => ({ status: "failed", error })
  );
  const result = await Promise.race([
    saveResult,
    new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 6500))
  ]);
  if (state.auth?.currentUser?.uid !== uid || state.avatarOperationId !== operationId) return;

  if (result.status === "failed") {
    console.error("Nie udało się zapisać avatara:", result.error);
    state.avatar = previousAvatar;
    state.avatarBusy = false;
    state.avatarPending = false;
    save();
    render();
    notify("Nie udało się zapisać avatara. Spróbuj ponownie.");
    return;
  }

  if (result.status === "saved") {
    state.avatarBusy = false;
    state.avatarPending = false;
    render();
    notify("Avatar zapisany");
    return;
  }

  state.avatarBusy = false;
  state.avatarPending = true;
  render();
  notify("Avatar ustawiony — synchronizacja czeka na internet");
  saveResult.then((lateResult) => {
    if (state.auth?.currentUser?.uid !== uid || state.avatarOperationId !== operationId) return;
    state.avatarPending = lateResult.status !== "saved";
    render();
    if (lateResult.status === "saved") notify("Avatar zsynchronizowany");
    else {
      console.error("Opóźniony zapis avatara nie powiódł się:", lateResult.error);
      notify("Nie udało się zsynchronizować avatara — wybierz go ponownie");
    }
  });
}

function loadImageFileFallback(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, cleanup: () => URL.revokeObjectURL(objectUrl) });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Nieobsługiwany format obrazu"));
    };
    image.src = objectUrl;
  });
}

async function decodeImageFile(file) {
  if ("ImageDecoder" in window && typeof ImageDecoder.isTypeSupported === "function") {
    try {
      if (await ImageDecoder.isTypeSupported(file.type)) {
        const metadataDecoder = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
        await metadataDecoder.tracks.ready;
        const track = metadataDecoder.tracks.selectedTrack;
        const width = track?.codedWidth || 0;
        const height = track?.codedHeight || 0;
        metadataDecoder.close();
        if (width && height) {
          const scale = Math.min(1, 1024 / Math.max(width, height));
          const decoder = new ImageDecoder({
            data: await file.arrayBuffer(),
            type: file.type,
            desiredWidth: Math.max(1, Math.round(width * scale)),
            desiredHeight: Math.max(1, Math.round(height * scale))
          });
          const result = await decoder.decode({ frameIndex: 0 });
          return { image: result.image, cleanup: () => { result.image.close(); decoder.close(); } };
        }
      }
    } catch (error) {
      console.warn("ImageDecoder nie odczytał avatara, używam bezpiecznego fallbacku:", error);
    }
  }

  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { resizeWidth: 1024, resizeQuality: "high" });
    return { image: bitmap, cleanup: () => bitmap.close() };
  }

  if (file.size > 3 * 1024 * 1024) throw new Error("Na tym urządzeniu wybierz grafikę mniejszą niż 3 MB");
  return loadImageFileFallback(file);
}

function renderAvatarCanvas(image, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, size, size);
  const imageWidth = image.displayWidth || image.codedWidth || image.naturalWidth || image.width;
  const imageHeight = image.displayHeight || image.codedHeight || image.naturalHeight || image.height;
  const sourceSize = Math.min(imageWidth, imageHeight);
  const sourceX = Math.max(0, (imageWidth - sourceSize) / 2);
  const sourceY = Math.max(0, (imageHeight - sourceSize) / 2);
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);
  return canvas;
}

async function avatarDataFromFile(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Wybierz plik graficzny");
  if (file.size > MAX_AVATAR_FILE_SIZE) throw new Error("Plik jest większy niż 8 MB");
  const { image, cleanup } = await decodeImageFile(file);
  try {
    const imageWidth = image.displayWidth || image.codedWidth || image.naturalWidth || image.width;
    const imageHeight = image.displayHeight || image.codedHeight || image.naturalHeight || image.height;
    if (!imageWidth || !imageHeight) throw new Error("Nie udało się odczytać grafiki");
    for (const size of [256, 224, 192]) {
      const canvas = renderAvatarCanvas(image, size);
      for (const quality of [.84, .7, .56]) {
        const webp = canvas.toDataURL("image/webp", quality);
        const data = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", quality);
        if (data.length <= MAX_AVATAR_DATA_LENGTH) return data;
      }
    }
    throw new Error("Grafiki nie udało się wystarczająco zmniejszyć");
  } finally {
    cleanup();
  }
}

async function handleAvatarUpload(file) {
  if (!file || state.avatarBusy || !state.user) return;
  const uid = state.user.uid;
  const preparationId = ++state.avatarOperationId;
  state.avatarBusy = true;
  state.avatarPending = false;
  render();
  notify("Przygotowuję avatar…");
  try {
    const data = await avatarDataFromFile(file);
    if (state.auth?.currentUser?.uid !== uid || state.avatarOperationId !== preparationId) return;
    state.avatarBusy = false;
    await selectAvatar("upload", data);
  } catch (error) {
    console.error("Nie udało się przygotować avatara:", error);
    if (state.auth?.currentUser?.uid === uid && state.avatarOperationId === preparationId) {
      state.avatarBusy = false;
      render();
      notify(error.message || "Nie udało się przygotować grafiki");
    }
  }
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

function isGoogleAccount(user) {
  return Boolean(user?.providerData?.some((provider) => provider.providerId === "google.com"));
}

async function handleAuthState(user) {
  state.authStatus = "ready";
  state.avatarOperationId += 1;
  state.avatarBusy = false;
  state.avatarPending = false;
  if (user && !isGoogleAccount(user)) {
    state.user = null;
    state.predictions = {};
    state.avatar = { ...DEFAULT_AVATAR };
    render();
    notify("Ta liga obsługuje wyłącznie prawdziwe konta Google");
    if (state.auth?.currentUser?.uid === user.uid && state.firebaseModules?.signOut) {
      state.firebaseModules.signOut(state.auth).catch((error) => console.error("Nie udało się odrzucić nieobsługiwanej sesji:", error));
    }
    return;
  }
  if (!user) {
    if (state.user?.provider === "google.com") {
      state.user = null;
      state.predictions = {};
      state.avatar = { ...DEFAULT_AVATAR };
      save();
    }
    render();
    return;
  }

  const cached = state.predictionsByUser[user.uid] || {};
  const cachedAvatar = normalizeAvatar(state.avatarsByUser[user.uid]) || { ...DEFAULT_AVATAR };
  state.user = {
    uid: user.uid,
    name: user.displayName || user.email || "Gracz",
    email: user.email || "",
    photoURL: user.photoURL || "",
    provider: "google.com"
  };
  state.avatar = cachedAvatar;

  let remote = {};
  let remoteAvatar = null;
  const [predictionsResult, avatarResult] = await Promise.allSettled([
    loadRemotePredictions(user.uid),
    loadRemoteAvatar(user.uid)
  ]);
  if (predictionsResult.status === "fulfilled") remote = predictionsResult.value;
  else console.error("Nie udało się pobrać typów z Firestore:", predictionsResult.reason);
  if (avatarResult.status === "fulfilled") remoteAvatar = avatarResult.value;
  else console.error("Nie udało się pobrać avatara z Firestore:", avatarResult.reason);
  if (predictionsResult.status === "rejected" || avatarResult.status === "rejected") {
    notify("Zalogowano przez Google, ale synchronizacja danych jest chwilowo niedostępna");
  }

  if (state.auth?.currentUser?.uid !== user.uid) return;

  state.predictions = { ...cached, ...remote };
  state.avatar = remoteAvatar || cachedAvatar;
  state.predictionsByUser[user.uid] = { ...state.predictions };
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
    try {
      const cacheOptions = typeof firestore.persistentMultipleTabManager === "function"
        ? { tabManager: firestore.persistentMultipleTabManager() }
        : {};
      state.db = firestore.initializeFirestore(firebaseApp, {
        localCache: firestore.persistentLocalCache(cacheOptions)
      });
    } catch (error) {
      console.warn("Trwały cache Firestore jest niedostępny, używam cache w pamięci:", error);
      state.db = firestore.getFirestore(firebaseApp);
    }
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
  state.predictions = {};
  state.avatar = { ...DEFAULT_AVATAR };
  state.avatarBusy = false;
  state.avatarPending = false;
  state.avatarOperationId += 1;
  save();
  render();
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

async function saveRemoteAvatar(uid, avatar) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid) throw new Error("Brak aktywnej sesji Google");
  const normalized = normalizeAvatar(avatar);
  if (!normalized) throw new Error("Nieprawidłowy avatar");
  const { doc, setDoc, serverTimestamp } = state.firebaseModules;
  await setDoc(doc(state.db, "profiles", uid), {
    uid,
    avatarType: normalized.type,
    avatarValue: normalized.value,
    updatedAt: serverTimestamp()
  });
}

async function loadRemoteAvatar(uid) {
  const { doc, getDoc } = state.firebaseModules;
  const snapshot = await getDoc(doc(state.db, "profiles", uid));
  if (!snapshot.exists()) return null;
  return normalizeAvatar(snapshot.data());
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
    loginGoogle();
    return;
  }

  if (event.target.closest?.("[data-account-settings]")) {
    document.querySelector("#accountDialog")?.close();
    setView("settings");
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
