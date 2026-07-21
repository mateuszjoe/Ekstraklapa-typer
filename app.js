import { matches as baseMatches, teamById, teams, roundDatesByNumber } from "./data.js";
import { firebaseConfig } from "./firebase-config.js";

const bootStartedAt = performance.now();
const app = document.querySelector("#app");
const STORAGE_KEY = "ekstraklasa-typer-state-v1";
const FINAL = new Set(["FT", "AET", "PEN", "AWD", "WO", "FINISHED", "AWARDED"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "IN_PLAY", "PAUSED"]);
const VIEWS = new Set(["matches", "ranking", "rules", "settings"]);
const DEFAULT_AVATAR = Object.freeze({ type: "google", value: "" });
const SEASON_ID = "2026-27";
const ENTRY_FEE = 100;
const MINIMUM_PLAYERS = 5;
const MAX_AVATAR_FILE_SIZE = 8 * 1024 * 1024;
const MAX_AVATAR_DATA_LENGTH = 180_000;
const MAX_CHAT_IMAGE_DATA_LENGTH = 90_000;
const CHAT_LIVE_LIMIT = 30;
const CHAT_PAGE_LIMIT = 20;
const CHAT_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

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
  participantReady: false,
  participantActivationBusy: false,
  participantActivationError: false,
  participantCount: null,
  participantCountStatus: "loading",
  user: null,
  chat: [],
  chatLive: [],
  chatOlder: [],
  chatHasMore: true,
  chatReachedStart: false,
  chatLoadingOlder: false,
  chatStatus: "idle",
  chatDraft: "",
  chatImage: "",
  chatImageBusy: false,
  chatReplyTo: null,
  chatReactionPicker: null,
  chatReactions: {},
  chatProfiles: {},
  chatOpen: false,
  chatSending: false,
  chatLastReadMs: 0,
  chatRemoteReadMs: 0,
  chatReadSaving: false,
  chatReadRetryAt: 0,
  matches: baseMatches.map((match) => ({ ...match })),
  liveSignature: "",
  auth: null,
  db: null,
  authStatus: "loading",
  authBusy: false,
  firebaseModules: null,
  firebaseReady: null
};

let seasonStatsUnsubscribe = null;
let chatUnsubscribes = [];
const chatProfileLoads = new Set();
let chatViewportHandler = null;

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
  { id: "magik-pilki", label: "Magik piłki", emoji: "🧙", background: "#bfe5ff", accent: "#ffd000" },
  { id: "snajper-pola-karnego", label: "Snajper pola karnego", emoji: "🎯", background: "#ffd000", accent: "#0d0d0d" },
  { id: "numer-jeden", label: "Numer jeden", emoji: "🧤", background: "#f2eee3", accent: "#ffd000" },
  { id: "mur-obrony", label: "Mur obrony", emoji: "🧱", background: "#ffd4cc", accent: "#e44735" },
  { id: "boiskowy-strateg", label: "Boiskowy strateg", emoji: "🧠", background: "#a9df77", accent: "#0d0d0d" },
  { id: "kapitan-druzyny", label: "Kapitan drużyny", emoji: "🛡️", background: "#bfe5ff", accent: "#ffd000" },
  { id: "motor-napedowy", label: "Motor napędowy", emoji: "⚙️", background: "#ffd86b", accent: "#e44735" },
  { id: "joker-z-lawki", label: "Joker z ławki", emoji: "🃏", background: "#d5cef7", accent: "#6ead32" },
  { id: "glos-trybun", label: "Głos trybun", emoji: "📣", background: "#f2eee3", accent: "#6ead32" },
  { id: "weteran-sektora", label: "Weteran sektora", emoji: "🥁", background: "#bde3c2", accent: "#ffd000" },
  { id: "szybkie-skrzydlo", label: "Szybkie skrzydło", emoji: "⚡", background: "#ffe6a6", accent: "#0d0d0d" },
  { id: "profesor-futbolu", label: "Profesor futbolu", emoji: "🎓", background: "#c8d5e0", accent: "#6ead32" },
  { id: "talizman-druzyny", label: "Talizman drużyny", emoji: "🍀", background: "#dff0c8", accent: "#ffd000" }
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

function safePhotoUrl(value) {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https:\/\//i.test(url) && url.length <= 2048 ? url : "";
}

function googleAccountName(user) {
  const name = typeof user?.displayName === "string" ? user.displayName : "";
  return name.length > 0 && name.length <= 80 ? name : "Gracz";
}

function normalizePublicProfile(uid, value = {}) {
  const name = String(value.displayName || value.name || "Gracz").trim().slice(0, 80) || "Gracz";
  return {
    uid,
    name,
    // Nie ładujemy zdalnych zdjęć Google innych graczy. Dzięki temu profil
    // nie może zostać użyty jako zewnętrzny piksel śledzący w czacie.
    photoURL: "",
    avatar: normalizeAvatar(value) || { ...DEFAULT_AVATAR }
  };
}

function profileForUid(uid) {
  if (uid && state.user?.uid === uid) {
    return { uid, name: state.user.name, photoURL: state.user.photoURL, avatar: state.avatar };
  }
  return state.chatProfiles[uid] || normalizePublicProfile(uid);
}

function avatarForUid(uid, className = "chat-avatar") {
  const profile = profileForUid(uid);
  return avatarVisualMarkup(className, `Avatar ${profile.name}`, profile.avatar, profile);
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

function formatMoney(value) {
  return `${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value)} zł`;
}

function prizePoolHtml() {
  if (state.participantCountStatus === "loading") {
    return `<div class="prize-pool-card"><div class="prize-pool-status"><span></span>Liczymy zarejestrowanych graczy…</div></div>`;
  }
  if (state.participantCountStatus === "error" || !Number.isInteger(state.participantCount)) {
    return `<div class="prize-pool-card"><div class="prize-pool-waiting"><strong>Nie udało się pobrać aktualnej puli.</strong><span>Odśwież stronę za chwilę.</span></div></div>`;
  }

  const players = Math.max(0, state.participantCount);
  if (players < MINIMUM_PLAYERS) {
    return `<div class="prize-pool-card">
      <div class="prize-pool-head"><div><p class="eyebrow">PULA NAGRÓD</p><h3>${players} z ${MINIMUM_PLAYERS} graczy</h3></div><strong>${players}/${MINIMUM_PLAYERS}</strong></div>
      <div class="prize-pool-waiting"><strong>Nie uzbierano minimalnej liczby graczy.</strong><span>Kwoty nagród pojawią się automatycznie po dołączeniu piątego gracza.</span></div>
    </div>`;
  }

  const totalPool = players * ENTRY_FEE;
  return `<div class="prize-pool-card">
    <div class="prize-pool-head"><div><p class="eyebrow">PULA NAGRÓD</p><h3>Dotychczasowa pula</h3><span>${players} graczy po ${formatMoney(ENTRY_FEE)}</span></div><strong>${formatMoney(totalPool)}</strong></div>
    <div class="prize-grid">
      <div class="prize-place is-first"><span>I miejsce</span><strong>${formatMoney(players * 50)}</strong></div>
      <div class="prize-place"><span>II miejsce</span><strong>${formatMoney(players * 30)}</strong></div>
      <div class="prize-place"><span>III miejsce</span><strong>${formatMoney(players * 20)}</strong></div>
    </div>
  </div>`;
}

function rulesView() {
  return `<section class="subpage-hero"><p class="eyebrow">PROSTE ZASADY</p><h1>Piłka jest prosta.<br>Ten typer też.</h1></section>
    <section class="content-section narrow rules-grid">
      <article><b>01</b><span>${icon("calendar")}</span><h3>Wybierz 1, X lub 2</h3><p>1 oznacza wygraną gospodarzy, X remis, a 2 wygraną gości. Nie typujemy dokładnych wyników.</p></article>
      <article><b>02</b><span>${icon("lock")}</span><h3>Zdąż przed gwizdkiem</h3><p>Typ możesz zmieniać do rozpoczęcia meczu. Później zostaje automatycznie zablokowany.</p></article>
      <article><b>03</b><span>${icon("trophy")}</span><h3>Zdobądź 1 punkt</h3><p>Za każdy prawidłowy rezultat otrzymujesz jeden punkt. Wygrywa najwyższy wynik po 34. kolejce.</p></article>
      <div class="rule-banner">
        <div class="rule-stat"><strong>100 zł</strong><span>wpisowe za gracza</span></div>
        <div class="rule-stat"><strong>306</strong><span>meczów</span></div>
        <div class="rule-stat"><strong>34</strong><span>kolejki</span></div>
        <div class="rule-stat"><strong>1</strong><span>punkt za trafienie</span></div>
      </div>
      ${prizePoolHtml()}
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
        <div class="settings-panel-heading"><span>03</span><div><h3>Gotowe avatary</h3><p>Wybierz jeden z 18 gotowych motywów.</p></div></div>
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
  updateChatWidget({ keepScroll: true });
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

function firestoreTimeMs(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && Number.isFinite(value.seconds)) return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  return 0;
}

function formatChatTime(value) {
  const timestamp = firestoreTimeMs(value);
  if (!timestamp) return "teraz";
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function safeChatImage(value) {
  return typeof value === "string"
    && value.length <= MAX_CHAT_IMAGE_DATA_LENGTH
    && /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/=]+$/i.test(value)
    ? value
    : "";
}

function normalizeChatMessage(item) {
  const data = item.data({ serverTimestamps: "estimate" });
  return {
    id: item.id,
    uid: typeof data.uid === "string" ? data.uid : "",
    text: typeof data.text === "string" ? data.text.slice(0, 1000) : "",
    image: safeChatImage(data.image),
    replyToId: typeof data.replyToId === "string" ? data.replyToId.slice(0, 100) : "",
    createdAt: data.createdAt || null
  };
}

function rebuildChatList() {
  const messages = new Map();
  [...state.chatOlder, ...state.chatLive].forEach((message) => messages.set(message.id, message));
  state.chat = [...messages.values()].sort(compareChatMessages);
  state.chat.forEach((message) => ensureChatProfile(message.uid));
}

function compareChatMessages(a, b) {
  const difference = firestoreTimeMs(a.createdAt) - firestoreTimeMs(b.createdAt);
  return difference || a.id.localeCompare(b.id);
}

function chatMessageById(id) {
  return state.chat.find((message) => message.id === id) || null;
}

function compactChatMessage(message) {
  const text = String(message?.text || "").replace(/\s+/g, " ").trim() || (message?.image ? "Zdjęcie" : "Wiadomość");
  return text.length > 86 ? `${text.slice(0, 83)}…` : text;
}

function chatReplySummary(message) {
  if (!message) return null;
  return {
    id: message.id,
    name: profileForUid(message.uid).name,
    text: compactChatMessage(message),
    image: Boolean(message.image)
  };
}

function chatReplyPreviewHtml(reply, composer = false) {
  if (!reply) return "";
  return `<button type="button" class="chat-reply-preview${composer ? " composer" : ""}" data-chat-reply-preview="${escapeHtml(reply.id || "")}">
    <span class="chat-reply-bar"></span>
    <span class="chat-reply-copy"><strong>${escapeHtml(reply.name || "Gracz")}</strong><span>${reply.image ? `<span class="chat-reply-img">📷</span>` : ""}${escapeHtml(reply.text || "Wiadomość")}</span></span>
  </button>`;
}

function chatReactionsForMessage(messageId) {
  return Object.values(state.chatReactions).filter((reaction) => reaction?.msgId === messageId && CHAT_REACTION_EMOJIS.includes(reaction.emoji));
}

function myChatReaction(messageId) {
  return state.user ? chatReactionsForMessage(messageId).find((reaction) => reaction.uid === state.user.uid) || null : null;
}

function chatReactionsHtml(messageId) {
  const grouped = new Map();
  chatReactionsForMessage(messageId).forEach((reaction) => {
    if (!grouped.has(reaction.emoji)) grouped.set(reaction.emoji, []);
    grouped.get(reaction.emoji).push(reaction);
  });
  if (!grouped.size) return "";
  return `<div class="chat-reactions">${[...grouped.entries()].map(([emoji, reactions]) => {
    const mine = reactions.some((reaction) => reaction.uid === state.user?.uid);
    const names = reactions.map((reaction) => profileForUid(reaction.uid).name).join(", ");
    return `<button type="button" class="chat-reaction-chip${mine ? " mine" : ""}" data-chat-react="${escapeHtml(messageId)}" data-chat-emoji="${escapeHtml(emoji)}" title="${escapeHtml(names)}">${escapeHtml(emoji)} <span>${reactions.length}</span></button>`;
  }).join("")}</div>`;
}

function chatReactionPickerHtml(messageId) {
  if (!canUseChat() || state.chatReactionPicker !== messageId) return "";
  const mine = myChatReaction(messageId);
  return `<div class="chat-reaction-picker">${CHAT_REACTION_EMOJIS.map((emoji) => `<button type="button" class="${mine?.emoji === emoji ? "active" : ""}" data-chat-react="${escapeHtml(messageId)}" data-chat-emoji="${escapeHtml(emoji)}" aria-label="Reakcja ${escapeHtml(emoji)}">${escapeHtml(emoji)}</button>`).join("")}</div>`;
}

function chatMessageHtml(message) {
  const profile = profileForUid(message.uid);
  const mine = state.user?.uid === message.uid;
  const replyMessage = message.replyToId ? chatMessageById(message.replyToId) : null;
  const reply = replyMessage ? chatReplySummary(replyMessage) : message.replyToId ? { id: message.replyToId, name: "Wcześniejsza wiadomość", text: "Pokaż kontekst", image: false } : null;
  const text = escapeHtml(message.text).replaceAll("\n", "<br>");
  return `<article class="chat-msg${mine ? " mine" : ""}" data-chat-message="${escapeHtml(message.id)}">
    ${avatarForUid(message.uid)}
    <div class="chat-bubble">
      <div class="chat-head"><strong class="chat-name">${escapeHtml(profile.name)}</strong><time class="chat-time">${escapeHtml(formatChatTime(message.createdAt))}</time>
        <span class="chat-actions">
          <button type="button" class="chat-act" data-chat-reply="${escapeHtml(message.id)}" title="Odpowiedz">↩</button>
          <button type="button" class="chat-act" data-chat-reaction-toggle="${escapeHtml(message.id)}" title="Dodaj reakcję">☺</button>
          ${mine ? `<button type="button" class="chat-del" data-chat-delete="${escapeHtml(message.id)}" title="Usuń wiadomość">×</button>` : ""}
        </span>
      </div>
      ${reply ? chatReplyPreviewHtml(reply) : ""}
      ${text ? `<div class="chat-text">${text}</div>` : ""}
      ${message.image ? `<img class="chat-img" src="${escapeHtml(message.image)}" alt="Grafika wysłana przez ${escapeHtml(profile.name)}">` : ""}
      ${chatReactionsHtml(message.id)}
      ${chatReactionPickerHtml(message.id)}
    </div>
  </article>`;
}

function chatMessagesHtml() {
  if (!state.user) return `<div class="chat-login"><strong>Czat graczy</strong><span>Zaloguj się przez Google, aby czytać i pisać razem z uczestnikami ligi.</span></div>`;
  if (!state.participantReady) return state.participantActivationError
    ? `<div class="chat-login"><strong>Nie udało się aktywować konta gracza.</strong><span>Sprawdź internet i spróbuj ponownie poniżej.</span></div>`
    : `<div class="chat-login"><strong>Dołączamy Cię do gry…</strong><span>Po aktywacji konta chat uruchomi się automatycznie.</span></div>`;
  if (state.chatStatus === "loading") return `<div class="chat-empty"><strong>Ładujemy rozmowę…</strong></div>`;
  if (state.chatStatus === "error") return `<div class="chat-empty"><strong>Chat jest chwilowo niedostępny.</strong><span>Sprawdź internet i spróbuj ponownie.</span></div>`;
  if (!state.chat.length) return `<div class="chat-empty"><strong>Jeszcze tu cicho.</strong><span>Napisz pierwszą wiadomość do ligi.</span></div>`;
  return `${state.chatHasMore ? `<button type="button" class="chat-load-older" data-chat-load-older ${state.chatLoadingOlder ? "disabled" : ""}>${state.chatLoadingOlder ? "Ładowanie…" : "Pokaż starsze wiadomości"}</button>` : `<div class="chat-history-start">Początek rozmowy</div>`}${state.chat.map(chatMessageHtml).join("")}`;
}

function chatUnreadCount() {
  if (!state.user) return 0;
  return state.chat.filter((message) => message.uid !== state.user.uid && firestoreTimeMs(message.createdAt) > state.chatLastReadMs).length;
}

function canUseChat() {
  return Boolean(state.user?.provider === "google.com"
    && state.participantReady
    && state.auth?.currentUser?.uid === state.user.uid
    && state.db
    && state.firebaseModules);
}

function chatComposerMode() {
  return [state.user?.uid || "guest", state.participantReady ? "ready" : "waiting", state.participantActivationBusy ? "activation-busy" : "", state.participantActivationError ? "activation-error" : "", state.chatImageBusy ? "image-busy" : "", state.chatImage ? "image" : "", state.chatReplyTo?.id || ""].join(":");
}

function renderChatComposer() {
  const host = document.querySelector("#chat-widget .chat-composer-wrap");
  if (!host) return;
  host.dataset.mode = chatComposerMode();
  if (!state.user) {
    host.innerHTML = `<div class="chat-login"><span>Do rozmowy dołączają tylko zalogowani gracze.</span><button type="button" class="primary-button" data-chat-login>ZALOGUJ SIĘ PRZEZ GOOGLE</button></div>`;
  } else if (!state.participantReady) {
    host.innerHTML = state.participantActivationError
      ? `<div class="chat-login"><span>Aktywacja nie powiodła się.</span><button type="button" class="primary-button" data-chat-participant-retry ${state.participantActivationBusy ? "disabled" : ""}>${state.participantActivationBusy ? "ŁĄCZENIE…" : "SPRÓBUJ PONOWNIE"}</button></div>`
      : `<p class="chat-hint">Aktywujemy Twoje konto gracza…</p>`;
  } else {
    host.innerHTML = `${state.chatReplyTo ? `<div class="chat-reply-composer">${chatReplyPreviewHtml(state.chatReplyTo, true)}<button type="button" data-chat-reply-clear aria-label="Anuluj odpowiedź">×</button></div>` : ""}
      ${state.chatImage ? `<div class="chat-attach"><img src="${escapeHtml(state.chatImage)}" alt="Załączona grafika"><button type="button" data-chat-image-clear aria-label="Usuń załącznik">×</button></div>` : ""}
      <div class="chat-input-row">
        <label class="chat-photo${state.chatImageBusy ? " is-busy" : ""}" title="Dodaj grafikę"><input type="file" data-chat-image-input accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" ${state.chatImageBusy ? "disabled" : ""}><span>${state.chatImageBusy ? "…" : "📷"}</span></label>
        <textarea id="cw-text" rows="1" maxlength="1000" placeholder="Napisz wiadomość…">${escapeHtml(state.chatDraft)}</textarea>
        <button type="button" class="chat-send" data-chat-send aria-label="Wyślij wiadomość" ${state.chatSending || state.chatImageBusy ? "disabled" : ""}>➤</button>
      </div>
      <p class="chat-hint">Enter wysyła · Shift+Enter dodaje nową linię</p>`;
  }

  host.querySelector("[data-chat-login]")?.addEventListener("click", () => document.querySelector("#authDialog")?.showModal());
  host.querySelector("[data-chat-participant-retry]")?.addEventListener("click", () => activateSeasonParticipant(state.user?.uid));
  host.querySelector("[data-chat-reply-clear]")?.addEventListener("click", () => {
    state.chatReplyTo = null;
    renderChatComposer();
    document.querySelector("#cw-text")?.focus();
  });
  host.querySelector("[data-chat-image-clear]")?.addEventListener("click", () => {
    state.chatImage = "";
    renderChatComposer();
  });
  host.querySelector("[data-chat-image-input]")?.addEventListener("change", (event) => prepareChatImage(event.target.files?.[0]));
  host.querySelector("[data-chat-send]")?.addEventListener("click", sendChatMessage);
  const input = host.querySelector("#cw-text");
  input?.addEventListener("input", (event) => { state.chatDraft = event.target.value.slice(0, 1000); });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendChatMessage();
    }
  });
}

function renderChatImageCanvas(image, maxSide) {
  const imageWidth = image.displayWidth || image.codedWidth || image.naturalWidth || image.width;
  const imageHeight = image.displayHeight || image.codedHeight || image.naturalHeight || image.height;
  const scale = Math.min(1, maxSide / Math.max(imageWidth, imageHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(imageWidth * scale));
  canvas.height = Math.max(1, Math.round(imageHeight * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, imageWidth, imageHeight, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function chatImageDataFromFile(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Wybierz plik graficzny");
  if (file.size > MAX_AVATAR_FILE_SIZE) throw new Error("Plik jest większy niż 8 MB");
  const { image, cleanup } = await decodeImageFile(file);
  try {
    const width = image.displayWidth || image.codedWidth || image.naturalWidth || image.width;
    const height = image.displayHeight || image.codedHeight || image.naturalHeight || image.height;
    if (!width || !height) throw new Error("Nie udało się odczytać grafiki");
    for (const maxSide of [1024, 840, 680, 540]) {
      const canvas = renderChatImageCanvas(image, maxSide);
      for (const quality of [.8, .66, .52]) {
        const webp = canvas.toDataURL("image/webp", quality);
        const data = webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", quality);
        if (data.length <= MAX_CHAT_IMAGE_DATA_LENGTH) return data;
      }
    }
    throw new Error("Grafiki nie udało się wystarczająco zmniejszyć");
  } finally {
    cleanup();
  }
}

async function prepareChatImage(file) {
  if (!file || state.chatImageBusy || !canUseChat()) return;
  const uid = state.user.uid;
  state.chatImageBusy = true;
  renderChatComposer();
  try {
    const data = await chatImageDataFromFile(file);
    if (state.auth?.currentUser?.uid !== uid) return;
    state.chatImage = data;
  } catch (error) {
    console.error("Nie udało się przygotować grafiki do chatu:", error);
    notify(error.message || "Nie udało się przygotować grafiki");
  } finally {
    if (state.auth?.currentUser?.uid === uid) {
      state.chatImageBusy = false;
      renderChatComposer();
    }
  }
}

async function sendChatMessage() {
  if (!canUseChat() || state.chatSending || state.chatImageBusy) return;
  const text = state.chatDraft.trim().slice(0, 1000);
  const image = safeChatImage(state.chatImage);
  if (!text && !image) return;
  const uid = state.user.uid;
  const replyTo = state.chatReplyTo;
  state.chatSending = true;
  renderChatComposer();
  try {
    const { addDoc, collection, serverTimestamp } = state.firebaseModules;
    const writeResult = addDoc(collection(state.db, "chat"), {
      uid,
      text,
      image,
      replyToId: replyTo?.id || "",
      createdAt: serverTimestamp()
    }).then(() => ({ status: "saved" }), (error) => ({ status: "failed", error }));
    if (state.auth?.currentUser?.uid !== uid) return;
    state.chatDraft = "";
    state.chatImage = "";
    state.chatReplyTo = null;
    renderChatComposer();

    const result = await Promise.race([
      writeResult,
      new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 6500))
    ]);
    if (state.auth?.currentUser?.uid !== uid) return;
    if (result.status === "failed") {
      throw result.error;
    }
    if (result.status === "pending") {
      notify("Wiadomość czeka na połączenie z internetem");
      writeResult.then((lateResult) => {
        if (lateResult.status === "failed" && state.auth?.currentUser?.uid === uid) {
          console.error("Opóźniona wysyłka wiadomości nie powiodła się:", lateResult.error);
          notify("Nie udało się zsynchronizować wiadomości");
        }
      });
    }
  } catch (error) {
    console.error("Nie udało się wysłać wiadomości:", error);
    if (state.auth?.currentUser?.uid === uid && !state.chatDraft && !state.chatImage) {
      state.chatDraft = text;
      state.chatImage = image;
      state.chatReplyTo = replyTo;
    }
    notify("Nie udało się wysłać wiadomości");
  } finally {
    if (state.auth?.currentUser?.uid === uid) {
      state.chatSending = false;
      renderChatComposer();
      document.querySelector("#cw-text")?.focus();
    }
  }
}

async function setChatReaction(messageId, emoji) {
  if (!canUseChat() || !CHAT_REACTION_EMOJIS.includes(emoji) || !chatMessageById(messageId)) return;
  const uid = state.user.uid;
  const { deleteDoc, doc, serverTimestamp, setDoc } = state.firebaseModules;
  const reference = doc(state.db, "chatReactions", `${messageId}_${uid}`);
  try {
    if (myChatReaction(messageId)?.emoji === emoji) await deleteDoc(reference);
    else await setDoc(reference, { uid, msgId: messageId, emoji, updatedAt: serverTimestamp() });
    state.chatReactionPicker = null;
    updateChatWidget();
  } catch (error) {
    console.error("Nie udało się zapisać reakcji:", error);
    notify("Nie udało się zapisać reakcji");
  }
}

async function deleteChatMessage(messageId) {
  const message = chatMessageById(messageId);
  if (!canUseChat() || message?.uid !== state.user.uid || !window.confirm("Usunąć tę wiadomość?")) return;
  const previousLive = state.chatLive;
  const previousOlder = state.chatOlder;
  state.chatLive = state.chatLive.filter((item) => item.id !== messageId);
  state.chatOlder = state.chatOlder.filter((item) => item.id !== messageId);
  rebuildChatList();
  updateChatWidget({ keepScroll: true });
  try {
    const { collection, doc, getDocs, limit, query, where, writeBatch } = state.firebaseModules;
    const reactions = await getDocs(query(
      collection(state.db, "chatReactions"),
      where("msgId", "==", messageId),
      limit(450)
    ));
    const batch = writeBatch(state.db);
    reactions.forEach((item) => batch.delete(item.ref));
    batch.delete(doc(state.db, "chat", messageId));
    await batch.commit();
  } catch (error) {
    state.chatLive = previousLive;
    state.chatOlder = previousOlder;
    rebuildChatList();
    updateChatWidget({ keepScroll: true });
    console.error("Nie udało się usunąć wiadomości:", error);
    notify("Nie udało się usunąć wiadomości");
  }
}

async function loadOlderChat() {
  if (!canUseChat() || state.chatLoadingOlder || !state.chatHasMore || !state.chat.length) return;
  const oldest = state.chat[0];
  if (!oldest.createdAt) return;
  const list = document.querySelector("#chat-widget .chat-messages");
  const previousHeight = list?.scrollHeight || 0;
  state.chatLoadingOlder = true;
  updateChatWidget({ keepScroll: true });
  try {
    const { collection, documentId, getDocs, limit, orderBy, query, startAfter } = state.firebaseModules;
    const snapshot = await getDocs(query(
      collection(state.db, "chat"),
      orderBy("createdAt", "desc"),
      orderBy(documentId(), "desc"),
      startAfter(oldest.createdAt, oldest.id),
      limit(CHAT_PAGE_LIMIT)
    ));
    const older = snapshot.docs.map(normalizeChatMessage).reverse();
    const existing = new Map(state.chatOlder.map((message) => [message.id, message]));
    older.forEach((message) => existing.set(message.id, message));
    state.chatOlder = [...existing.values()];
    if (!snapshot.metadata.fromCache && snapshot.size < CHAT_PAGE_LIMIT) state.chatReachedStart = true;
    state.chatHasMore = !state.chatReachedStart;
    rebuildChatList();
    updateChatWidget({ keepScroll: true });
    if (list) list.scrollTop += Math.max(0, list.scrollHeight - previousHeight);
  } catch (error) {
    console.error("Nie udało się pobrać starszych wiadomości:", error);
    notify("Nie udało się pobrać starszych wiadomości");
  } finally {
    state.chatLoadingOlder = false;
    updateChatWidget({ keepScroll: true });
  }
}

function mountChatWidget() {
  let widget = document.querySelector("#chat-widget");
  if (widget) return widget;
  widget = document.createElement("aside");
  widget.id = "chat-widget";
  widget.className = "chat-widget";
  widget.innerHTML = `<button type="button" class="chat-fab" aria-label="Otwórz chat graczy" aria-expanded="false">
      <span class="chat-fab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 5h14v10H9l-4 4V5Z"/></svg></span><span class="chat-badge" hidden></span>
    </button>
    <section class="chat-panel" aria-label="Chat graczy" aria-hidden="true">
      <header class="chat-panel-head"><div><span class="chat-panel-kicker">EKSTRAKLAPA TYPER</span><strong class="chat-panel-title">Szatnia graczy</strong></div><button type="button" class="chat-close" aria-label="Zamknij chat">×</button></header>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-composer-wrap"></div>
    </section>`;
  document.body.appendChild(widget);

  widget.querySelector(".chat-fab")?.addEventListener("click", () => toggleChat(true));
  widget.querySelector(".chat-close")?.addEventListener("click", () => toggleChat(false));
  widget.querySelector(".chat-messages")?.addEventListener("scroll", (event) => {
    if (event.currentTarget.scrollTop < 28) loadOlderChat();
  });
  widget.querySelector(".chat-messages")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-chat-login]")) {
      document.querySelector("#authDialog")?.showModal();
      return;
    }
    if (event.target.closest("[data-chat-load-older]")) {
      loadOlderChat();
      return;
    }
    const replyButton = event.target.closest("[data-chat-reply]");
    if (replyButton && canUseChat()) {
      state.chatReplyTo = chatReplySummary(chatMessageById(replyButton.dataset.chatReply));
      renderChatComposer();
      document.querySelector("#cw-text")?.focus();
      return;
    }
    const reactionToggle = event.target.closest("[data-chat-reaction-toggle]");
    if (reactionToggle && canUseChat()) {
      const id = reactionToggle.dataset.chatReactionToggle;
      state.chatReactionPicker = state.chatReactionPicker === id ? null : id;
      updateChatWidget({ keepScroll: true });
      return;
    }
    const reaction = event.target.closest("[data-chat-react][data-chat-emoji]");
    if (reaction) {
      setChatReaction(reaction.dataset.chatReact, reaction.dataset.chatEmoji);
      return;
    }
    const preview = event.target.closest("[data-chat-reply-preview]");
    if (preview) {
      scrollToChatMessage(preview.dataset.chatReplyPreview);
      return;
    }
    const remove = event.target.closest("[data-chat-delete]");
    if (remove) deleteChatMessage(remove.dataset.chatDelete);
  });

  chatViewportHandler = () => positionChatPanel();
  window.visualViewport?.addEventListener("resize", chatViewportHandler);
  window.visualViewport?.addEventListener("scroll", chatViewportHandler);
  window.addEventListener("resize", chatViewportHandler);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.chatOpen) toggleChat(false);
  });
  renderChatComposer();
  return widget;
}

function positionChatPanel() {
  const panel = document.querySelector("#chat-widget .chat-panel");
  if (!panel) return;
  document.body.classList.toggle("chat-is-open", state.chatOpen && window.innerWidth <= 560);
  if (!state.chatOpen || window.innerWidth > 560 || !window.visualViewport) {
    panel.style.removeProperty("top");
    panel.style.removeProperty("height");
    panel.style.removeProperty("bottom");
    return;
  }
  const viewport = window.visualViewport;
  panel.style.top = `${Math.max(8, viewport.offsetTop + 8)}px`;
  panel.style.height = `${Math.max(80, viewport.height - 16)}px`;
  panel.style.bottom = "auto";
}

function toggleChat(force) {
  state.chatOpen = typeof force === "boolean" ? force : !state.chatOpen;
  const widget = mountChatWidget();
  widget.classList.toggle("open", state.chatOpen);
  widget.querySelector(".chat-panel")?.setAttribute("aria-hidden", String(!state.chatOpen));
  widget.querySelector(".chat-fab")?.setAttribute("aria-expanded", String(state.chatOpen));
  positionChatPanel();
  updateChatWidget();
  if (state.chatOpen) {
    requestAnimationFrame(() => {
      const list = widget.querySelector(".chat-messages");
      if (list) list.scrollTop = list.scrollHeight;
      document.querySelector("#cw-text")?.focus({ preventScroll: true });
    });
    markChatRead();
  }
}

function scrollToChatMessage(messageId) {
  const element = [...document.querySelectorAll("#chat-widget [data-chat-message]")]
    .find((node) => node.dataset.chatMessage === messageId);
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.classList.add("pulse");
  setTimeout(() => element.classList.remove("pulse"), 900);
}

function updateChatWidget(options = {}) {
  const widget = mountChatWidget();
  const unread = chatUnreadCount();
  const fab = widget.querySelector(".chat-fab");
  const badge = widget.querySelector(".chat-badge");
  fab?.classList.toggle("has-unread", unread > 0 && !state.chatOpen);
  if (badge) {
    badge.hidden = unread === 0 || state.chatOpen;
    badge.textContent = unread > 99 ? "99+" : String(unread);
  }

  const list = widget.querySelector(".chat-messages");
  if (list) {
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const stayAtBottom = !options.keepScroll && (distanceFromBottom < 90 || !list.dataset.rendered);
    const previousScroll = list.scrollTop;
    list.innerHTML = chatMessagesHtml();
    list.dataset.rendered = "true";
    list.querySelectorAll("[data-avatar-image], .chat-img").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));
    if (stayAtBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    else if (options.keepScroll) list.scrollTop = previousScroll;
  }

  const composer = widget.querySelector(".chat-composer-wrap");
  if (composer?.dataset.mode !== chatComposerMode()) renderChatComposer();
  if (state.chatOpen) markChatRead();
}

function markChatRead() {
  if (!state.chatOpen || !canUseChat() || !state.chat.length) return;
  const list = document.querySelector("#chat-widget .chat-messages");
  if (list && list.scrollHeight - list.scrollTop - list.clientHeight > 120) return;
  const latestMessageMs = Math.max(...state.chat.map((message) => firestoreTimeMs(message.createdAt)));
  if (!latestMessageMs) return;
  state.chatLastReadMs = Math.max(state.chatLastReadMs, latestMessageMs);
  if (latestMessageMs <= state.chatRemoteReadMs || state.chatReadSaving || Date.now() < state.chatReadRetryAt) return;
  if ("onLine" in navigator && !navigator.onLine) return;
  const uid = state.user.uid;
  const { doc, serverTimestamp, setDoc } = state.firebaseModules;
  state.chatReadSaving = true;
  const writeResult = setDoc(doc(state.db, "chatReads", uid), {
    uid,
    lastReadAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }).then(() => ({ status: "saved" }), (error) => ({ status: "failed", error }));
  Promise.race([
    writeResult,
    new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 6500))
  ]).then((result) => {
    if (state.auth?.currentUser?.uid !== uid) return;
    state.chatReadSaving = false;
    if (result.status === "saved") {
      state.chatRemoteReadMs = Math.max(state.chatRemoteReadMs, latestMessageMs);
      state.chatReadRetryAt = 0;
    }
    else {
      state.chatReadRetryAt = Date.now() + 15000;
      if (result.status === "failed") console.error("Nie udało się zapisać odczytu chatu:", result.error);
    }
  });
}

function ensureChatProfile(uid) {
  if (!uid || !canUseChat() || chatProfileLoads.has(uid)) return;
  const viewerUid = state.user.uid;
  const { doc, getDoc } = state.firebaseModules;
  chatProfileLoads.add(uid);
  getDoc(doc(state.db, "profiles", uid)).then((snapshot) => {
    if (!canUseChat() || state.user?.uid !== viewerUid) return;
    state.chatProfiles[uid] = snapshot.exists() ? normalizePublicProfile(uid, snapshot.data()) : normalizePublicProfile(uid);
    updateChatWidget({ keepScroll: true });
  }).catch((error) => console.error("Nie udało się pobrać profilu autora chatu:", error));
}

function stopChatRealtime() {
  chatUnsubscribes.forEach((unsubscribe) => unsubscribe());
  chatUnsubscribes = [];
  chatProfileLoads.clear();
  state.chat = [];
  state.chatLive = [];
  state.chatOlder = [];
  state.chatHasMore = true;
  state.chatReachedStart = false;
  state.chatLoadingOlder = false;
  state.chatStatus = "idle";
  state.chatDraft = "";
  state.chatImage = "";
  state.chatImageBusy = false;
  state.chatReplyTo = null;
  state.chatReactionPicker = null;
  state.chatReactions = {};
  state.chatProfiles = {};
  state.chatSending = false;
  state.chatLastReadMs = 0;
  state.chatRemoteReadMs = 0;
  state.chatReadSaving = false;
  state.chatReadRetryAt = 0;
  updateChatWidget({ keepScroll: true });
}

function startChatRealtime(uid) {
  stopChatRealtime();
  if (!canUseChat() || uid !== state.user?.uid) return;
  state.chatStatus = "loading";
  updateChatWidget();
  const { collection, doc, documentId, limit, onSnapshot, orderBy, query } = state.firebaseModules;
  const messageQuery = query(
    collection(state.db, "chat"),
    orderBy("createdAt", "desc"),
    orderBy(documentId(), "desc"),
    limit(CHAT_LIVE_LIMIT)
  );
  chatUnsubscribes.push(onSnapshot(messageQuery, (snapshot) => {
    const previousLive = state.chatLive;
    const nextLive = snapshot.docs.map(normalizeChatMessage).reverse();
    const nextIds = new Set(nextLive.map((message) => message.id));
    const older = new Map(state.chatOlder.map((message) => [message.id, message]));
    nextLive.forEach((message) => older.delete(message.id));
    const oldestLive = nextLive[0] || null;
    if (snapshot.size === CHAT_LIVE_LIMIT && oldestLive) {
      previousLive
        .filter((message) => !nextIds.has(message.id) && compareChatMessages(message, oldestLive) < 0)
        .forEach((message) => older.set(message.id, message));
    }
    if (!snapshot.metadata.fromCache) {
      if (snapshot.size < CHAT_LIVE_LIMIT) state.chatReachedStart = true;
    }
    state.chatLive = nextLive;
    state.chatOlder = [...older.values()];
    state.chatHasMore = !state.chatReachedStart;
    state.chatStatus = "ready";
    rebuildChatList();
    updateChatWidget();
  }, (error) => {
    console.error("Chat realtime jest niedostępny:", error);
    state.chatStatus = "error";
    updateChatWidget();
  }));

  const reactionQuery = query(collection(state.db, "chatReactions"), orderBy("updatedAt", "desc"), limit(300));
  chatUnsubscribes.push(onSnapshot(reactionQuery, (snapshot) => {
    const reactions = {};
    snapshot.forEach((item) => {
      const data = item.data();
      if (typeof data.uid === "string" && typeof data.msgId === "string" && CHAT_REACTION_EMOJIS.includes(data.emoji)) {
        reactions[item.id] = { uid: data.uid, msgId: data.msgId, emoji: data.emoji };
        ensureChatProfile(data.uid);
      }
    });
    state.chatReactions = reactions;
    updateChatWidget({ keepScroll: true });
  }, (error) => console.error("Reakcje chatu są niedostępne:", error)));

  chatUnsubscribes.push(onSnapshot(doc(state.db, "chatReads", uid), (snapshot) => {
    const ownRead = snapshot.exists() ? snapshot.data({ serverTimestamps: "estimate" }) : null;
    state.chatRemoteReadMs = Math.max(state.chatRemoteReadMs, firestoreTimeMs(ownRead?.lastReadAt));
    state.chatLastReadMs = Math.max(state.chatLastReadMs, state.chatRemoteReadMs);
    updateChatWidget({ keepScroll: true });
  }, (error) => console.error("Potwierdzenia odczytu chatu są niedostępne:", error)));
}

function subscribeSeasonStats() {
  seasonStatsUnsubscribe?.();
  const { doc, onSnapshot } = state.firebaseModules;
  seasonStatsUnsubscribe = onSnapshot(doc(state.db, "seasonStats", SEASON_ID), (snapshot) => {
    const count = snapshot.exists() ? snapshot.data().participantCount : 0;
    state.participantCount = Number.isInteger(count) && count >= 0 ? count : 0;
    state.participantCountStatus = "ready";
    if (state.view === "rules") render();
  }, (error) => {
    console.error("Nie udało się pobrać liczby graczy:", error);
    state.participantCount = null;
    state.participantCountStatus = "error";
    if (state.view === "rules") render();
  });
}

async function ensureSeasonParticipant(uid) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid) throw new Error("Brak aktywnej sesji Google");
  const { doc, runTransaction, serverTimestamp } = state.firebaseModules;
  const participantReference = doc(state.db, "seasons", SEASON_ID, "participants", uid);
  const statsReference = doc(state.db, "seasonStats", SEASON_ID);
  await runTransaction(state.db, async (transaction) => {
    const participantSnapshot = await transaction.get(participantReference);
    if (participantSnapshot.exists()) return;
    const statsSnapshot = await transaction.get(statsReference);
    const currentCount = statsSnapshot.exists() && Number.isInteger(statsSnapshot.data().participantCount)
      ? statsSnapshot.data().participantCount
      : 0;
    transaction.set(participantReference, { uid, seasonId: SEASON_ID, joinedAt: serverTimestamp() });
    transaction.set(statsReference, {
      seasonId: SEASON_ID,
      participantCount: currentCount + 1,
      updatedAt: serverTimestamp()
    });
  });
}

async function activateSeasonParticipant(uid, options = {}) {
  const { startRealtime = true, notifyOnError = true } = options;
  if (!uid || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return false;
  if (state.participantReady) {
    if (startRealtime && state.chatStatus === "idle") startChatRealtime(uid);
    return true;
  }
  if (state.participantActivationBusy) return false;

  state.participantActivationBusy = true;
  state.participantActivationError = false;
  updateChatWidget({ keepScroll: true });
  try {
    await ensureSeasonParticipant(uid);
    if (state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return false;
    state.participantReady = true;
    state.participantActivationError = false;
    if (startRealtime) startChatRealtime(uid);
    return true;
  } catch (error) {
    if (state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return false;
    state.participantActivationError = true;
    console.error("Nie udało się zarejestrować gracza w sezonie:", error);
    if (notifyOnError) notify("Nie udało się aktywować konta gracza. Sprawdź internet i spróbuj ponownie.");
    return false;
  } finally {
    if (state.auth?.currentUser?.uid === uid && state.user?.uid === uid) {
      state.participantActivationBusy = false;
      updateChatWidget({ keepScroll: true });
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
  state.participantReady = false;
  state.participantActivationBusy = false;
  state.participantActivationError = false;
  stopChatRealtime();
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
    name: googleAccountName(user),
    email: user.email || "",
    photoURL: safePhotoUrl(user.photoURL),
    provider: "google.com"
  };
  state.avatar = cachedAvatar;

  let remote = {};
  let remoteProfile = null;
  const [predictionsResult, profileResult] = await Promise.allSettled([
    loadRemotePredictions(user.uid),
    loadRemoteProfile(user.uid)
  ]);
  if (predictionsResult.status === "fulfilled") remote = predictionsResult.value;
  else console.error("Nie udało się pobrać typów z Firestore:", predictionsResult.reason);
  if (profileResult.status === "fulfilled") remoteProfile = profileResult.value;
  else console.error("Nie udało się pobrać profilu z Firestore:", profileResult.reason);
  if (predictionsResult.status === "rejected" || profileResult.status === "rejected") {
    notify("Zalogowano przez Google, ale synchronizacja danych jest chwilowo niedostępna");
  }

  if (state.auth?.currentUser?.uid !== user.uid) return;

  state.predictions = { ...cached, ...remote };
  state.avatar = remoteProfile?.avatar || cachedAvatar;
  state.predictionsByUser[user.uid] = { ...state.predictions };
  state.chatProfiles[user.uid] = normalizePublicProfile(user.uid, {
    displayName: state.user.name,
    photoURL: state.user.photoURL,
    avatarType: state.avatar.type,
    avatarValue: state.avatar.value
  });

  await activateSeasonParticipant(user.uid, { startRealtime: false, notifyOnError: true });
  if (state.auth?.currentUser?.uid !== user.uid) return;

  try {
    const profileSave = saveRemoteProfile(user.uid, state.avatar, remoteProfile?.data || null).then(
      () => ({ status: "saved" }),
      (error) => ({ status: "failed", error })
    );
    const profileResult = await Promise.race([
      profileSave,
      new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 6500))
    ]);
    if (profileResult.status === "failed") throw profileResult.error;
  } catch (error) {
    console.error("Nie udało się uzupełnić profilu gracza:", error);
  }
  if (state.auth?.currentUser?.uid !== user.uid) return;

  save();
  render();
  if (state.participantReady) startChatRealtime(user.uid);
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
    subscribeSeasonStats();
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
  state.participantReady = false;
  state.participantActivationBusy = false;
  state.participantActivationError = false;
  stopChatRealtime();
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
  const { doc, getDoc } = state.firebaseModules;
  const snapshot = await getDoc(doc(state.db, "profiles", uid));
  await saveRemoteProfile(uid, normalized, snapshot.exists() ? snapshot.data() : null);
}

async function saveRemoteProfile(uid, avatar, existingData = null) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) {
    throw new Error("Brak aktywnej sesji Google");
  }
  const normalized = normalizeAvatar(avatar) || { ...DEFAULT_AVATAR };
  const { doc, setDoc, serverTimestamp } = state.firebaseModules;
  await setDoc(doc(state.db, "profiles", uid), {
    uid,
    displayName: state.user.name,
    avatarType: normalized.type,
    avatarValue: normalized.value,
    joinedAt: existingData?.joinedAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

async function loadRemoteProfile(uid) {
  const { doc, getDoc } = state.firebaseModules;
  const snapshot = await getDoc(doc(state.db, "profiles", uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return { data, avatar: normalizeAvatar(data) };
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
window.addEventListener("online", () => {
  state.chatReadRetryAt = 0;
  markChatRead();
  if (state.user && !state.participantReady && !state.participantActivationBusy) {
    activateSeasonParticipant(state.user.uid, { notifyOnError: false });
  }
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
