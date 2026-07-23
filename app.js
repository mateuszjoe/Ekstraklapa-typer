import { matches as baseMatches, teamById, teams, roundDatesByNumber } from "./data.js";
import { firebaseConfig, notificationApiBase, webPushPublicKey } from "./firebase-config.js";
import { getOfficialLivePayload } from "./live-provider.js";
import {
  getOfficialLeaguePayload,
  getOfficialMatchLineup,
  getOfficialTeamSquad
} from "./league-provider.js";

const bootStartedAt = performance.now();
const app = document.querySelector("#app");
const STORAGE_KEY = "ekstraklasa-typer-state-v1";
const APK_VERSION = "1.0.2";
const APK_PROMPT_CAMPAIGN = "android-v3";
const APK_PROMPT_STORAGE_KEY = "ekstraklasa-typer:apk-prompt";
const APK_PROMPT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const APK_DOWNLOAD_URL = "./downloads/Typer-v1.0.2.apk";
const CHAT_PUSH_STATE_CACHE = "ekstraklapa-typer-push-state-v1";
const CHAT_PUSH_STATE_URL = new URL("./__chat-push-state__", location.href).href;
const NOTIFICATION_PRIMER_KEY = "ekstraklasa-typer:notification-primer:v1";
const NOTIFICATION_PRIMER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const NOTIFICATION_OUTBOX_KEY = "ekstraklasa-typer:notification-outbox:v1";
const NOTIFICATION_OUTBOX_MAX_ITEMS = 220;
const NOTIFICATION_OUTBOX_PICK_BATCH_SIZE = 10;
const NOTIFICATION_OUTBOX_MAX_REQUESTS = 4;
const NOTIFICATION_OUTBOX_CHAT_TTL_MS = 9 * 60 * 1000;
const NOTIFICATION_OUTBOX_PLAYER_TTL_MS = 14 * 60 * 1000;
const NOTIFICATION_OUTBOX_PICK_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const NOTIFICATION_OUTBOX_NAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const APP_SERVICE_WORKER_VERSION = "32";
const FINAL = new Set(["FT", "AET", "PEN", "AWD", "WO", "FINISHED", "AWARDED"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "IN_PLAY", "PAUSED"]);
const VIEWS = new Set(["matches", "ekstraklasa", "ranking", "rules", "settings", "admin"]);
const DEFAULT_AVATAR = Object.freeze({ type: "google", value: "" });
const SEASON_ID = "2026-27";
const ADMIN_EMAIL = "mateuszjoe@gmail.com";
const ENTRY_FEE = 100;
const MINIMUM_PLAYERS = 5;
const LAST_MATCHDAY = 17;
const TYPER_MATCH_COUNT = 153;
const MAX_AVATAR_FILE_SIZE = 8 * 1024 * 1024;
const MAX_AVATAR_DATA_LENGTH = 180_000;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_CHAT_IMAGE_DATA_LENGTH = 90_000;
const CHAT_LIVE_LIMIT = 30;
const CHAT_PAGE_LIMIT = 20;
const CHAT_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
const LEAGUE_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const LINEUP_PENDING_CACHE_MS = 60 * 1000;
const TEAM_SQUAD_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

function routeSegment(value) {
  try {
    return decodeURIComponent(String(value || "")).trim();
  } catch {
    return "";
  }
}

function parseAppRoute(hash = location.hash) {
  const segments = String(hash || "")
    .replace(/^#\/?/, "")
    .split("/")
    .map(routeSegment)
    .filter(Boolean);
  const view = segments[0] || "matches";
  if (!VIEWS.has(view)) return { view: "matches", valid: false };
  if (view === "matches") {
    const matchday = Number(segments[1]);
    return {
      view,
      matchday: Number.isInteger(matchday) && matchday >= 1 && matchday <= LAST_MATCHDAY ? matchday : null,
      valid: segments.length <= 2 && (!segments[1] || (Number.isInteger(matchday) && matchday >= 1 && matchday <= LAST_MATCHDAY))
    };
  }
  if (view === "ekstraklasa" && segments[1] === "druzyna") {
    const teamId = segments[2];
    return { view, teamId: teamById[teamId] ? teamId : "", valid: segments.length === 3 && Boolean(teamById[teamId]) };
  }
  if (view === "ekstraklasa" && segments[1] === "mecz") {
    const matchId = segments[2] || "";
    const validMatchId = /^[A-Za-z0-9-]{1,100}$/.test(matchId);
    return { view, matchId: validMatchId ? matchId : "", valid: segments.length === 3 && validMatchId };
  }
  return { view, valid: segments.length === 1 };
}

function appRouteHash(route) {
  if (route.view === "matches") {
    const matchday = Number.isInteger(route.matchday) ? route.matchday : 1;
    return `#matches/${Math.min(LAST_MATCHDAY, Math.max(1, matchday))}`;
  }
  if (route.view === "ekstraklasa" && route.teamId && teamById[route.teamId]) {
    return `#ekstraklasa/druzyna/${encodeURIComponent(route.teamId)}`;
  }
  if (route.view === "ekstraklasa" && /^[A-Za-z0-9-]{1,100}$/.test(route.matchId || "")) {
    return `#ekstraklasa/mecz/${encodeURIComponent(route.matchId)}`;
  }
  return `#${VIEWS.has(route.view) ? route.view : "matches"}`;
}

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
const notificationQuery = new URLSearchParams(location.search);
const openChatFromNotification = notificationQuery.get("chat") === "open";
const notificationMatchday = Number(notificationQuery.get("matchday"));
let notificationMatchId = notificationQuery.get("match") || "";
const openSummaryFromNotification = notificationQuery.get("summary") === "open";
const notificationPlayerId = notificationQuery.get("player") || "";
let launchedFromNotification = openChatFromNotification
  || Boolean(notificationMatchId)
  || openSummaryFromNotification
  || (Number.isInteger(notificationMatchday) && notificationMatchday >= 1 && notificationMatchday <= LAST_MATCHDAY)
  || Boolean(notificationPlayerId);
let legacyPredictionsByUser = asRecord(saved.predictionsByUser);
const deprecatedLocalKeys = ["user", "predictions", "anonymousPredictions"];
if (deprecatedLocalKeys.some((key) => key in saved)) {
  deprecatedLocalKeys.forEach((key) => delete saved[key]);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
}
const initialRoute = parseAppRoute();
const savedMatchday = Number(saved.matchday);
const initialMatchday = Number.isInteger(notificationMatchday) && notificationMatchday >= 1 && notificationMatchday <= LAST_MATCHDAY
  ? notificationMatchday
  : Number.isInteger(initialRoute.matchday)
    ? initialRoute.matchday
  : Number.isInteger(savedMatchday) && savedMatchday >= 1 && savedMatchday <= LAST_MATCHDAY
    ? savedMatchday
    : 1;
const typerMatchIds = new Set(baseMatches.map((match) => match.id));
const state = {
  view: initialRoute.valid ? initialRoute.view : "matches",
  matchday: initialMatchday,
  leagueTeamId: initialRoute.valid ? initialRoute.teamId || "" : "",
  leagueMatchId: initialRoute.valid ? initialRoute.matchId || "" : "",
  leagueData: null,
  leagueStatus: "idle",
  leagueError: "",
  leagueLoadedAt: 0,
  leagueSource: "",
  lineupsByMatch: {},
  lineupStatusByMatch: {},
  lineupErrorByMatch: {},
  lineupLoadedAtByMatch: {},
  teamSquadsById: {},
  teamSquadStatusById: {},
  teamSquadErrorById: {},
  teamSquadLoadedAtById: {},
  predictions: {},
  confirmedPredictions: {},
  avatar: { ...DEFAULT_AVATAR },
  avatarsByUser: asRecord(saved.avatarsByUser),
  avatarBusy: false,
  avatarPending: false,
  avatarOperationId: 0,
  nameBusy: false,
  profileNamePolicy: { selfRenameUsed: false, pendingNameRequestId: "", nameVersion: 0 },
  nameRequest: null,
  nameRequestStatus: "idle",
  nameRequestError: "",
  adminPlayers: [],
  adminPlayersStatus: "idle",
  adminPlayersError: "",
  adminRequests: [],
  adminRequestsStatus: "idle",
  adminRequestsError: "",
  adminBusyId: "",
  adminSearch: "",
  participantReady: false,
  userDataReady: false,
  participantActivationBusy: false,
  participantActivationError: false,
  participantCount: null,
  participantCountStatus: "loading",
  rankingPlayers: [],
  rankingStatus: "idle",
  rankingError: "",
  playerForm: [],
  playerFormStatus: "idle",
  playerFormError: "",
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
  chatNotificationsByUser: asRecord(saved.chatNotificationsByUser),
  chatNotificationsEnabled: false,
  chatNotificationsSyncPending: false,
  chatNotificationsBusy: false,
  chatSending: false,
  chatLastReadMs: 0,
  chatRemoteReadMs: 0,
  chatReadSaving: false,
  chatReadRetryAt: 0,
  chatReaders: {},
  chatAuthorReadMs: {},
  playerPicksUid: null,
  playerPicksMatchday: initialMatchday,
  playerPicksStatus: "idle",
  playerPicksCache: {},
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
let ownProfileUnsubscribe = null;
let ownProfileRequestRevision = 0;
let adminNameRequestsUnsubscribe = null;
let adminRequestsSnapshotReady = false;
let adminPendingRequestIds = new Set();
let chatUnsubscribes = [];
let serviceWorkerRegistrationPromise = null;
let chatPushOperation = Promise.resolve();
let chatPushSessionRevision = 0;
let chatPushPendingOperations = 0;
let chatPushSessionClosing = false;
let notificationPickSyncOperation = Promise.resolve();
let notificationFullPickSyncKey = "";
let notificationFullPickSyncPromise = null;
let notificationFullPickSyncCompletedAt = 0;
let notificationOutboxFlushOperation = Promise.resolve();
let notificationOutboxRetryTimer = null;
let notificationOutboxRetryDueAt = 0;
const chatProfileLoads = new Set();
const predictionWriteQueues = new Map();
const predictionWriteVersions = new Map();
let chatViewportHandler = null;
let playerPicksLoadId = 0;
let rankingLoadPromise = null;
let rankingLoadRevision = 0;
let rankingReloadPending = false;
let playerFormLoadPromise = null;
let playerFormLoadRevision = 0;
let trustedMatchesSyncPromise = null;
let notificationDeepLinkHandled = false;
let notificationPrimerTimer = null;
let notificationPrimerRetries = 0;
let notificationPrimerBusy = false;
let notificationRouteApplying = false;
let firstLivePollSettled = false;
let notificationLoginPromptShown = false;
let liveTransport = location.hostname.endsWith(".github.io") ? "official" : "server";

const canonicalInitialRoute = state.view === "matches"
  ? { view: "matches", matchday: state.matchday }
  : state.view === "ekstraklasa"
    ? { view: "ekstraklasa", teamId: state.leagueTeamId, matchId: state.leagueMatchId }
    : { view: state.view };
const canonicalInitialHash = appRouteHash(canonicalInitialRoute);
if (!initialRoute.valid || location.hash !== canonicalInitialHash) {
  history.replaceState(null, "", `${location.pathname}${location.search}${canonicalInitialHash}`);
}
let lastAppliedRouteHref = location.href;

async function finishLoadingScreen() {
  const fontsReady = document.fonts?.ready || Promise.resolve();
  await Promise.race([
    Promise.resolve(fontsReady).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1800))
  ]);

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const minimumDuration = reduceMotion ? 180 : 800;
  const remaining = Math.max(0, minimumDuration - (performance.now() - bootStartedAt));

  await new Promise((resolve) => setTimeout(resolve, remaining));
  clearTimeout(window.__etLoaderFallback);
  document.documentElement.classList.add("app-ready");
  document.documentElement.classList.remove("app-loading");
  document.querySelector("#appLoader")?.setAttribute("aria-hidden", "true");
  setTimeout(() => document.querySelector("#appLoader")?.remove(), 500);
}

function save() {
  if (state.user?.provider === "google.com") {
    if (state.avatar.type === "upload") delete state.avatarsByUser[state.user.uid];
    else state.avatarsByUser[state.user.uid] = { ...state.avatar };
  }
  const nextSavedState = {
    matchday: state.matchday,
    avatarsByUser: state.avatarsByUser,
    chatNotificationsByUser: state.chatNotificationsByUser
  };
  if (Object.keys(legacyPredictionsByUser).length) {
    nextSavedState.predictionsByUser = legacyPredictionsByUser;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSavedState));
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
  return googleFullName(user).slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function googleFullName(user) {
  const name = normalizeDisplayName(user?.displayName);
  return name ? name.slice(0, 120) : "Gracz";
}

function normalizeDisplayName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function validDisplayName(value) {
  return value.length > 0 && value.length <= MAX_DISPLAY_NAME_LENGTH;
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isCurrentUserAdmin() {
  const currentUser = state.auth?.currentUser;
  return Boolean(
    currentUser
    && state.user
    && currentUser.uid === state.user.uid
    && currentUser.emailVerified === true
    && normalizedEmail(currentUser.email) === ADMIN_EMAIL
    && normalizedEmail(state.user.email) === ADMIN_EMAIL
  );
}

function normalizeProfileNamePolicy(value = {}) {
  const version = Number(value?.nameVersion);
  return {
    selfRenameUsed: value?.selfRenameUsed === true,
    pendingNameRequestId: typeof value?.pendingNameRequestId === "string"
      ? value.pendingNameRequestId.slice(0, 160)
      : "",
    nameVersion: Number.isInteger(version) && version >= 0 ? version : 0
  };
}

function normalizeNameChangeRequest(id, value = {}) {
  const status = ["pending", "approved", "rejected"].includes(value?.status) ? value.status : "";
  const uid = typeof value?.uid === "string" ? value.uid : "";
  const currentName = normalizeDisplayName(value?.currentName).slice(0, MAX_DISPLAY_NAME_LENGTH);
  const requestedName = normalizeDisplayName(value?.requestedName).slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (!id || !uid || !status || !currentName || !requestedName) return null;
  return {
    id,
    uid,
    currentName,
    requestedName,
    status,
    createdAt: value?.createdAt || null,
    resolvedAt: value?.resolvedAt || null,
    resolvedBy: typeof value?.resolvedBy === "string" ? value.resolvedBy : "",
    adminNote: typeof value?.adminNote === "string" ? value.adminNote.slice(0, 300) : ""
  };
}

function formatAdminDate(value) {
  const timestamp = firestoreTimeMs(value) || Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "brak danych";
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Warsaw"
  }).format(new Date(timestamp));
}

function normalizePublicProfile(uid, value = {}) {
  const normalizedName = normalizeDisplayName(value.displayName || value.name);
  const name = normalizedName ? normalizedName.slice(0, MAX_DISPLAY_NAME_LENGTH) : "Gracz";
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

function playerAvatarButton(uid, className = "chat-avatar") {
  const profile = profileForUid(uid);
  if (!uid) return avatarVisualMarkup(className, `Avatar ${profile.name}`, profile.avatar, profile);
  return `<button type="button" class="player-avatar-button" data-player-picks="${escapeHtml(uid)}" aria-label="Zobacz typy gracza ${escapeHtml(profile.name)}" title="Pokaż typy: ${escapeHtml(profile.name)}">${avatarVisualMarkup(className, `Avatar ${profile.name}`, profile.avatar, profile)}</button>`;
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

function isPredictionOpen(match) {
  return Boolean(match?.kickoffConfirmed && !isLocked(match));
}

function pointsFor(match) {
  if (!typerMatchIds.has(match?.id)) return 0;
  const result = resultOf(match);
  return result && state.predictions[match.id] === result ? 1 : 0;
}

function settledResultsSignature() {
  return state.matches
    .filter((match) => typerMatchIds.has(match.id) && resultOf(match))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((match) => `${match.id}:${resultOf(match)}`)
    .join("|");
}

function setMainMenuOpen(open, restoreFocus = false) {
  const navigation = document.querySelector(".main-nav");
  const button = document.querySelector("#menuButton");
  navigation?.classList.toggle("is-open", Boolean(open));
  button?.setAttribute("aria-expanded", String(Boolean(open)));
  if (open) {
    requestAnimationFrame(() => navigation?.querySelector(".nav-link:not([hidden])")?.focus({ preventScroll: true }));
  }
  button?.setAttribute("aria-label", open ? "Zamknij menu" : "Otwórz menu");
  if (!open && restoreFocus) button?.focus({ preventScroll: true });
}

function currentAppRoute() {
  if (state.view === "matches") return { view: "matches", matchday: state.matchday };
  if (state.view === "ekstraklasa") {
    return {
      view: "ekstraklasa",
      teamId: state.leagueTeamId || "",
      matchId: state.leagueMatchId || ""
    };
  }
  return { view: state.view };
}

function teamRouteHref(teamId) {
  return `#ekstraklasa/druzyna/${encodeURIComponent(teamId)}`;
}

function matchRouteHref(matchId) {
  return `#ekstraklasa/mecz/${encodeURIComponent(matchId)}`;
}

function writeAppRoute(route, historyMode = "push") {
  if (historyMode === "none") return;
  const target = `${location.pathname}${location.search}${appRouteHash(route)}`;
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (target === current) {
    lastAppliedRouteHref = location.href;
    return;
  }
  history[historyMode === "replace" ? "replaceState" : "pushState"](null, "", target);
  lastAppliedRouteHref = location.href;
}

function applyAppRoute(route, { historyMode = "none", focus = true } = {}) {
  const view = VIEWS.has(route?.view) ? route.view : "matches";
  state.view = view;
  if (view === "matches" && Number.isInteger(route.matchday) && route.matchday >= 1 && route.matchday <= LAST_MATCHDAY) {
    state.matchday = route.matchday;
    save();
  }
  state.leagueTeamId = view === "ekstraklasa" && teamById[route.teamId] ? route.teamId : "";
  state.leagueMatchId = view === "ekstraklasa" && /^[A-Za-z0-9-]{1,100}$/.test(route.matchId || "") ? route.matchId : "";
  writeAppRoute(currentAppRoute(), historyMode);
  document.querySelectorAll(".nav-link").forEach((node) => node.classList.toggle("is-active", node.dataset.view === view));
  setMainMenuOpen(false);
  render();
  if (view === "ranking" && state.user && state.participantReady) void loadRankingData();
  if (view === "matches" && state.user && state.userDataReady && state.participantReady
    && (state.rankingStatus !== "ready" || state.playerFormStatus !== "ready")) void loadPlayerDashboardData();
  if (view === "ekstraklasa") void loadLeagueData();
  if (view === "admin" && isCurrentUserAdmin()) void loadAdminPlayers();
  if (focus) app.focus({ preventScroll: true });
}

function setView(view, options = {}) {
  const route = view === "matches"
    ? { view, matchday: state.matchday }
    : { view };
  applyAppRoute(route, { historyMode: options.historyMode || "push", focus: options.focus !== false });
}

function openTeamDetails(teamId, options = {}) {
  if (!teamById[teamId]) return;
  applyAppRoute({ view: "ekstraklasa", teamId }, {
    historyMode: options.historyMode || "push",
    focus: options.focus !== false
  });
}

function openLeagueMatch(matchId, options = {}) {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(matchId || "")) return;
  applyAppRoute({ view: "ekstraklasa", matchId }, {
    historyMode: options.historyMode || "push",
    focus: options.focus !== false
  });
}

function applyRouteFromLocation() {
  if (location.href === lastAppliedRouteHref) return;
  const route = parseAppRoute();
  const normalized = route.valid ? route : { view: "matches", matchday: state.matchday };
  if (!route.valid) {
    history.replaceState(null, "", `${location.pathname}${location.search}${appRouteHash(normalized)}`);
  }
  lastAppliedRouteHref = location.href;
  applyAppRoute(normalized, { historyMode: "none", focus: false });
}

function rankingPosition(players, player) {
  if (!player) return null;
  const index = players.findIndex((candidate) => candidate.points === player.points);
  return index >= 0 ? index + 1 : null;
}

function playerMiniRankingHtml(players, ownUid) {
  if (state.rankingStatus === "error") {
    return `<div class="player-mini-ranking-state">Ranking jest chwilowo niedostępny.</div>`;
  }
  if (state.rankingStatus !== "ready") {
    return `<div class="player-mini-ranking-state is-loading"><i></i><span>Pobieramy klasyfikację…</span></div>`;
  }
  if (!players.length) {
    return `<div class="player-mini-ranking-state">Klasyfikacja pojawi się po dołączeniu graczy.</div>`;
  }

  const ownIndex = players.findIndex((player) => player.uid === ownUid);
  const visible = players.slice(0, 3).map((player) => ({ player, separated: false }));
  if (ownIndex >= 3) visible.push({ player: players[ownIndex], separated: true });

  return `<div class="player-mini-ranking-list">${visible.map(({ player, separated }) => {
    const profile = profileForUid(player.uid);
    const position = rankingPosition(players, player);
    const mine = player.uid === ownUid;
    return `<div class="player-mini-ranking-row${mine ? " is-me" : ""}${separated ? " is-separated" : ""}">
      <b>${position || "—"}</b>
      ${playerAvatarButton(player.uid, "player-mini-avatar")}
      <span>${escapeHtml(profile.name)}${mine ? "<small>TY</small>" : ""}</span>
      <strong>${player.points}<small>pkt</small></strong>
    </div>`;
  }).join("")}</div>`;
}

function playerFormHtml() {
  if (state.playerFormStatus === "error") {
    return `<p class="player-form-empty">Nie udało się pobrać ostatnich typów.</p>`;
  }
  if (state.playerFormStatus !== "ready") {
    return `<div class="player-form-loading" aria-label="Pobieramy ostatnie typy"><i></i><i></i><i></i><i></i><i></i></div>`;
  }
  if (!state.playerForm.length) {
    return `<p class="player-form-empty">Forma pojawi się po rozliczeniu pierwszego typu.</p>`;
  }

  return `<div class="player-form-dots">${state.playerForm.map((item) => {
    const match = state.matches.find((candidate) => candidate.id === item.matchId);
    const home = teamById[match?.home]?.name || "Gospodarze";
    const away = teamById[match?.away]?.name || "Goście";
    const result = match ? resultOf(match) : null;
    const label = `${item.hit ? "Trafiony" : "Nietrafiony"} typ ${item.pick}${result ? `, wynik 1X2: ${result}` : ""}, ${home} – ${away}`;
    return `<span class="player-form-dot ${item.hit ? "is-hit" : "is-miss"}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${item.hit ? "✓" : "×"}</span>`;
  }).join("")}</div>`;
}

function playerDashboardHtml() {
  if (!state.user) {
    return `<div class="player-dashboard-card is-guest">
      <span class="season-pill">SEZON 2026/27 · RUNDA JESIENNA</span>
      <div class="player-dashboard-guest">
        <span class="player-dashboard-guest-avatar">G</span>
        <div><p class="eyebrow">PANEL GRACZA</p><h1>Zaloguj się do gry</h1><p>Po zalogowaniu zobaczysz tutaj swoje miejsce, punkty, ostatnią formę i czołówkę rankingu.</p></div>
      </div>
      <div class="player-dashboard-actions">
        <button class="primary-button" data-open-auth>ZALOGUJ PRZEZ GOOGLE ${icon("arrow")}</button>
        <button class="text-button" data-scroll-matches>Zobacz mecze</button>
      </div>
    </div>`;
  }

  const players = rankingRows();
  const own = state.rankingStatus === "ready"
    ? players.find((player) => player.uid === state.user.uid) || null
    : null;
  const position = rankingPosition(players, own);
  const points = own?.points;
  const typed = own?.typed;
  const accuracy = own?.accuracy;
  const recentHits = state.playerForm.filter((item) => item.hit).length;
  const positionLabel = state.rankingStatus === "ready" && position ? `#${position}` : "—";
  const positionStatus = state.rankingStatus === "error" ? "brak danych" : state.rankingStatus === "ready" ? "miejsce" : "liczymy";
  const formStatus = state.playerFormStatus === "ready" && state.playerForm.length
    ? `${recentHits}/${state.playerForm.length} trafionych`
    : state.playerFormStatus === "error" ? "brak danych" : "ostatnie 5";

  return `<div class="player-dashboard-card" aria-busy="${state.rankingStatus === "loading" || state.playerFormStatus === "loading"}">
    <span class="season-pill">SEZON 2026/27 · RUNDA JESIENNA</span>
    <header class="player-dashboard-head">
      ${avatarVisualMarkup("player-dashboard-avatar", `Avatar ${state.user.name}`)}
      <div class="player-dashboard-identity"><p class="eyebrow">TWÓJ PANEL GRACZA</p><h1>${escapeHtml(state.user.name)}</h1><span>${Number.isInteger(typed) ? `${typed} rozliczonych typów` : "Synchronizujemy wynik"}</span></div>
      <div class="player-dashboard-place"><small>${positionStatus}</small><strong>${positionLabel}</strong></div>
    </header>
    <div class="player-dashboard-stats">
      <span><b>${Number.isInteger(points) ? points : "—"}</b>punkty</span>
      <span><b>${Number.isInteger(typed) ? typed : "—"}</b>rozliczone</span>
      <span><b>${Number.isInteger(accuracy) ? `${accuracy}%` : "—"}</b>skuteczność</span>
    </div>
    <div class="player-dashboard-data">
      <section class="player-form-panel" aria-label="Forma gracza w ostatnich typach">
        <header><span>OSTATNIE TYPY</span><small>${formStatus}</small></header>
        ${playerFormHtml()}
      </section>
      <section class="player-mini-ranking" aria-label="Mini ranking graczy">
        <header><span>MINI RANKING</span><button type="button" data-view-jump="ranking">PEŁNY</button></header>
        ${playerMiniRankingHtml(players, state.user.uid)}
      </section>
    </div>
    <div class="player-dashboard-actions">
      <button class="primary-button" data-scroll-matches>TYPUJ MECZE ${icon("arrow")}</button>
    </div>
  </div>`;
}

function hero() {
  const selected = state.matches.filter((match) => match.matchday === state.matchday);
  const typed = selected.filter((match) => state.predictions[match.id]).length;
  const next = [...state.matches]
    .filter((match) => typerMatchIds.has(match.id) && new Date(match.kickoffAt) > new Date() && match.kickoffConfirmed)
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt))[0];
  return `<section class="hero">
    <div class="hero-glow"></div>
    ${playerDashboardHtml()}
    <div class="hero-side">
      <p class="eyebrow">NAJBLIŻSZY MECZ</p>
      ${next ? `<div class="next-match">
        <div class="next-date"><b>${formatDay(next)}</b><span>${formatTime(next)}</span></div>
        <div class="next-teams">
          <div><a class="team-route-tile" href="${teamRouteHref(next.home)}" data-team-route="${next.home}" aria-label="Szczegóły ${escapeHtml(teamById[next.home].name)}"><img src="${teamById[next.home].crest}" alt=""><b>${teamById[next.home].short}</b></a></div>
          <span>VS</span>
          <div><a class="team-route-tile" href="${teamRouteHref(next.away)}" data-team-route="${next.away}" aria-label="Szczegóły ${escapeHtml(teamById[next.away].name)}"><img src="${teamById[next.away].crest}" alt=""><b>${teamById[next.away].short}</b></a></div>
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
  const waitingForKickoff = !match.kickoffConfirmed;
  const waitingForPlayer = Boolean(state.user && (!state.userDataReady || !state.participantReady));
  const live = LIVE.has(match.status);
  const final = FINAL.has(match.status);
  const score = (live || final) && Number.isFinite(match.homeScore) ? `${match.homeScore} : ${match.awayScore}` : null;
  return `<article class="match-card ${prediction ? "is-typed" : ""} ${live ? "is-live" : ""}">
    <div class="match-meta">
      <span>${live ? `<b class="live-label">LIVE${Number.isFinite(match.liveElapsed) ? ` ${match.liveElapsed}'` : ""}</b>` : `${formatDay(match)} · ${formatTime(match)}`}</span>
      <span>${locked ? `${icon("lock")} zamknięty` : waitingForKickoff ? `${icon("calendar")} czeka na termin` : waitingForPlayer ? `${icon("calendar")} synchronizacja konta` : prediction ? `${icon("check")} typ zapisany` : "1 pkt do zdobycia"}</span>
    </div>
    <div class="match-teams">
      <div class="team home"><a class="team-route-link" href="${teamRouteHref(home.id)}" data-team-route="${home.id}"><span>${home.name}</span><img src="${home.crest}" alt="Herb ${home.name}"></a></div>
      <div class="score-zone">${score ? `<strong>${score}</strong>` : `<span>VS</span>`}</div>
      <div class="team away"><a class="team-route-link" href="${teamRouteHref(away.id)}" data-team-route="${away.id}"><img src="${away.crest}" alt="Herb ${away.name}"><span>${away.name}</span></a></div>
    </div>
    <div class="prediction-row" role="group" aria-label="Typ na mecz ${home.name} — ${away.name}">
      ${[["1",home.short],["X","REMIS"],["2",away.short]].map(([pick,label]) => `<button data-pick="${pick}" data-match="${match.id}" class="pick ${prediction === pick ? "selected" : ""}" aria-pressed="${prediction === pick}" ${locked || waitingForKickoff || waitingForPlayer ? "disabled" : ""}><b>${pick}</b><small>${label}</small></button>`).join("")}
    </div>
    ${(live || final) ? `<button class="match-centre-link" data-match-centre="${match.id}">Szczegóły wyniku ${icon("arrow")}</button>` : ""}
  </article>`;
}

function liveMatchesSection() {
  const liveMatches = state.matches
    .filter((match) => typerMatchIds.has(match.id) && LIVE.has(match.status))
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
  const matchdayDate = new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "long" })
    .format(new Date(`${roundDatesByNumber[state.matchday]}T12:00:00`));
  const typerMatches = state.matches.filter((match) => typerMatchIds.has(match.id));
  return `${hero()}
    <section class="club-ribbon" aria-label="Kluby sezonu 2026/27">${teams.map((team) => `<a href="${teamRouteHref(team.id)}" data-team-route="${team.id}" aria-label="Szczegóły ${escapeHtml(team.name)}"><img src="${team.crest}" alt="" title="${escapeHtml(team.name)}"></a>`).join("")}</section>
    ${liveMatchesSection()}
    <section class="content-section" id="mecze">
      <div class="section-heading">
        <div><p class="eyebrow">TERMINARZ I TYPY</p><h2>Mecze Ekstraklasy</h2><p>Wybierz rezultat każdego spotkania. Typ blokuje się wraz z pierwszym gwizdkiem.</p></div>
        <div class="stats-inline"><span><b>${typerMatches.filter((match) => state.predictions[match.id]).length}</b> oddanych typów</span><span><b>${typerMatches.reduce((sum, match) => sum + pointsFor(match), 0)}</b> punktów</span></div>
      </div>
      <div class="filters">
        <div class="stage-label"><strong>Runda jesienna</strong><small>kolejki 1–17</small></div>
        <nav class="matchday-switcher" aria-label="Przełączanie kolejek">
          <button type="button" class="matchday-switch-button is-previous" data-matchday-step="-1" aria-label="${state.matchday === 1 ? "To jest pierwsza kolejka" : `Pokaż ${state.matchday - 1}. kolejkę`}" ${state.matchday === 1 ? "disabled" : ""}>${icon("arrow")}<span>Poprzednia</span></button>
          <div class="matchday-current" aria-live="polite" aria-atomic="true">${icon("calendar")}<span><strong>${state.matchday}. kolejka</strong><small>${matchdayDate}</small></span></div>
          <button type="button" class="matchday-switch-button is-next" data-matchday-step="1" aria-label="${state.matchday === LAST_MATCHDAY ? "To jest ostatnia kolejka" : `Pokaż ${state.matchday + 1}. kolejkę`}" ${state.matchday === LAST_MATCHDAY ? "disabled" : ""}><span>Następna</span>${icon("arrow")}</button>
        </nav>
      </div>
      <div class="round-note"><span>${visible.some((m) => !m.kickoffConfirmed) ? "Daty ramowe" : "Terminy potwierdzone"}</span>${visible.some((m) => !m.kickoffConfirmed) ? "Dokładne dni i godziny tej kolejki nie zostały jeszcze opublikowane. Typowanie uruchomi się po potwierdzeniu terminów." : "Godziny zgodne z oficjalnym terminarzem Ekstraklasy."}</div>
      <div class="matches-grid">${visible.map(matchCard).join("")}</div>
    </section>`;
}

function leagueMatchKey(match) {
  return String(match?.localMatchId || match?.id || match?.providerId || "");
}

function leagueMatchByRoute(matchId = state.leagueMatchId) {
  return (state.leagueData?.matches || []).find((match) => [
    match.localMatchId,
    match.id,
    match.providerId
  ].some((value) => String(value || "") === String(matchId || ""))) || null;
}

function leagueMatchTimestamp(match) {
  const timestamp = new Date(match?.kickoffAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function leagueMatchIsFinal(match) {
  return FINAL.has(String(match?.status || "").toUpperCase());
}

function leagueMatchHasScore(match) {
  return match?.homeScore !== null
    && match?.homeScore !== undefined
    && match?.homeScore !== ""
    && match?.awayScore !== null
    && match?.awayScore !== undefined
    && match?.awayScore !== ""
    && Number.isInteger(Number(match.homeScore))
    && Number.isInteger(Number(match.awayScore));
}

function leagueMatchStatus(match) {
  if (LIVE.has(match?.status)) return `LIVE${Number.isFinite(match.liveElapsed) ? ` · ${match.liveElapsed}'` : ""}`;
  if (leagueMatchIsFinal(match)) return "Zakończony";
  if (match?.status === "PST") return "Przełożony";
  if (match?.status === "CANC") return "Odwołany";
  return "Zaplanowany";
}

function leagueKickoffLabel(match) {
  const timestamp = leagueMatchTimestamp(match);
  if (!timestamp) return "Termin do ustalenia";
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function leagueOutcome(match, teamId) {
  if (!leagueMatchIsFinal(match) || !leagueMatchHasScore(match)) return "";
  const homeScore = Number(match.homeScore);
  const awayScore = Number(match.awayScore);
  if (homeScore === awayScore) return "D";
  const teamWon = (match.home === teamId && homeScore > awayScore) || (match.away === teamId && awayScore > homeScore);
  return teamWon ? "W" : "L";
}

function recentLeagueMatches(teamId, limit = 5) {
  return (state.leagueData?.matches || [])
    .filter((match) => (match.home === teamId || match.away === teamId) && leagueMatchIsFinal(match) && leagueMatchHasScore(match))
    .sort((a, b) => leagueMatchTimestamp(b) - leagueMatchTimestamp(a))
    .slice(0, limit);
}

function upcomingLeagueMatches(teamId = "", limit = 6) {
  const now = Date.now();
  return (state.leagueData?.matches || [])
    .filter((match) => (!teamId || match.home === teamId || match.away === teamId)
      && !leagueMatchIsFinal(match)
      && match.status !== "CANC"
      && leagueMatchTimestamp(match) >= now - 3 * 60 * 60 * 1000)
    .sort((a, b) => leagueMatchTimestamp(a) - leagueMatchTimestamp(b))
    .slice(0, limit);
}

function teamStanding(teamId) {
  return (state.leagueData?.standings || []).find((row) => row.teamId === teamId) || null;
}

function teamForm(teamId, standing = teamStanding(teamId)) {
  const official = Array.isArray(standing?.form)
    ? standing.form.map((value) => String(value || "").toUpperCase()).filter((value) => ["W", "D", "L"].includes(value)).slice(-5)
    : [];
  if (official.length) return official;
  return recentLeagueMatches(teamId, 5).reverse().map((match) => leagueOutcome(match, teamId)).filter(Boolean);
}

function formHtml(form, emptyLabel = "Brak meczów") {
  if (!form.length) return `<span class="league-form-empty">${emptyLabel}</span>`;
  const labels = { W: "Z", D: "R", L: "P" };
  return form.map((value) => `<span class="league-form-dot is-${value.toLowerCase()}" title="${value === "W" ? "Zwycięstwo" : value === "D" ? "Remis" : "Porażka"}">${labels[value]}</span>`).join("");
}

function leagueFixtureHtml(match, focusTeamId = "") {
  const home = teamById[match.home];
  const away = teamById[match.away];
  if (!home || !away) return "";
  const key = leagueMatchKey(match);
  const score = leagueMatchHasScore(match) && (leagueMatchIsFinal(match) || LIVE.has(match.status))
    ? `${Number(match.homeScore)} : ${Number(match.awayScore)}`
    : "– : –";
  const outcome = focusTeamId ? leagueOutcome(match, focusTeamId) : "";
  return `<article class="league-fixture${outcome ? ` is-${outcome.toLowerCase()}` : ""}">
    <a class="league-fixture-meta" href="${matchRouteHref(key)}" data-league-match-route="${escapeHtml(key)}">${escapeHtml(leagueKickoffLabel(match))}<small>${escapeHtml(leagueMatchStatus(match))}</small></a>
    <span class="league-fixture-teams">
      <a class="league-fixture-team" href="${teamRouteHref(home.id)}" data-team-route="${home.id}"><span>${escapeHtml(home.name)}</span><img src="${home.crest}" alt=""></a>
      <a class="league-fixture-score" href="${matchRouteHref(key)}" data-league-match-route="${escapeHtml(key)}" aria-label="Szczegóły meczu ${escapeHtml(home.name)} – ${escapeHtml(away.name)}"><strong>${score}</strong></a>
      <a class="league-fixture-team" href="${teamRouteHref(away.id)}" data-team-route="${away.id}"><img src="${away.crest}" alt=""><span>${escapeHtml(away.name)}</span></a>
    </span>
    <a class="league-fixture-action" href="${matchRouteHref(key)}" data-league-match-route="${escapeHtml(key)}" aria-label="Otwórz centrum meczu">${outcome ? `<b class="league-fixture-outcome">${{ W: "Z", D: "R", L: "P" }[outcome]}</b>` : icon("arrow")}</a>
  </article>`;
}

function leagueLoadingHtml() {
  const error = state.leagueError
    ? `<div class="notice league-notice"><span>${escapeHtml(state.leagueError)}</span><button type="button" data-league-refresh>SPRÓBUJ PONOWNIE</button></div>`
    : "";
  return `<section class="subpage-hero"><p class="eyebrow">PKO BP EKSTRAKLASA</p><h1>Ekstraklasa</h1><p>Tabela, forma drużyn, terminarz i oficjalne składy meczowe.</p></section>
    <section class="content-section narrow league-loading" aria-live="polite">${error}<div class="league-loading-mark"></div><h2>${state.leagueError ? "Dane są chwilowo niedostępne" : "Pobieramy dane ligi…"}</h2><p>Łączymy się z oficjalnym Centrum Meczowym Ekstraklasy.</p></section>`;
}

function leagueTableHtml() {
  const rows = state.leagueData?.standings || [];
  return `<article class="league-panel league-table-card">
    <div class="league-panel-head"><div><p class="eyebrow">TABELA LIGOWA</p><h2>Sezon ${escapeHtml(state.leagueData?.season?.name || "2026/27")}</h2></div><span>Aktualizacja: ${new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" }).format(new Date(state.leagueData?.updatedAt || Date.now()))}</span></div>
    <div class="league-table-scroll">
      <table class="league-table">
        <thead><tr><th>#</th><th>Klub</th><th title="Mecze">M</th><th title="Zwycięstwa">Z</th><th title="Remisy">R</th><th title="Porażki">P</th><th>Bramki</th><th>+/-</th><th>Forma</th><th>Pkt</th></tr></thead>
        <tbody>${rows.map((row, index) => {
          const team = teamById[row.teamId];
          if (!team) return "";
          const form = teamForm(team.id, row);
          return `<tr>
            <td><b>${Number(row.rank) || index + 1}</b></td>
            <td><a class="league-table-team" href="${teamRouteHref(team.id)}" data-team-route="${team.id}"><img src="${team.crest}" alt=""><span>${escapeHtml(team.name)}</span></a></td>
            <td>${Number(row.played) || 0}</td><td>${Number(row.wins) || 0}</td><td>${Number(row.draws) || 0}</td><td>${Number(row.losses) || 0}</td>
            <td>${Number(row.goalsFor) || 0}:${Number(row.goalsAgainst) || 0}</td><td>${Number(row.goalDifference) > 0 ? "+" : ""}${Number(row.goalDifference) || 0}</td>
            <td><span class="league-form">${formHtml(form, "—")}</span></td><td><strong>${Number(row.points) || 0}</strong></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
  </article>`;
}

function leagueOverviewView() {
  const upcoming = upcomingLeagueMatches("", 6);
  return `<section class="subpage-hero"><p class="eyebrow">PKO BP EKSTRAKLASA</p><h1>Ekstraklasa</h1><p>Tabela, forma drużyn, terminarz i oficjalne składy meczowe.</p></section>
    <section class="content-section league-section">
      <div class="league-source-bar"><span><i></i>Dane: oficjalne Centrum Meczowe Ekstraklasy</span><button type="button" data-league-refresh>ODŚWIEŻ</button></div>
      ${leagueTableHtml()}
      <div class="league-two-column">
        <article class="league-panel"><div class="league-panel-head"><div><p class="eyebrow">TERMINARZ</p><h2>Najbliższe mecze</h2></div></div><div class="league-fixtures">${upcoming.length ? upcoming.map((match) => leagueFixtureHtml(match)).join("") : `<p class="league-empty">Brak nadchodzących spotkań.</p>`}</div></article>
        <article class="league-panel"><div class="league-panel-head"><div><p class="eyebrow">18 DRUŻYN</p><h2>Kluby Ekstraklasy</h2></div></div><div class="league-club-grid">${teams.map((team) => `<a href="${teamRouteHref(team.id)}" data-team-route="${team.id}"><img src="${team.crest}" alt=""><span>${escapeHtml(team.name)}</span>${icon("arrow")}</a>`).join("")}</div></article>
      </div>
    </section>`;
}

function playerInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toLocaleUpperCase("pl-PL")
    .slice(0, 2) || "ET";
}

function leaguePlayerRowHtml(player) {
  const stats = player?.stats || {};
  const isGoalkeeper = player?.position === "goalkeeper";
  const photo = player?.photoUrl
    ? `<img src="${escapeHtml(player.photoUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-player-photo>`
    : "";
  const statisticCells = isGoalkeeper
    ? [
        ["Wyst.", Number(stats.appearances) || 0],
        ["Czyste", Number(stats.cleanSheets) || 0],
        ["ŻK", Number(stats.yellowCards) || 0],
        ["CzK", Number(stats.redCards) || 0]
      ]
    : [
        ["Wyst.", Number(stats.appearances) || 0],
        ["Gole", Number(stats.goals) || 0],
        ["Asysty", Number(stats.assists) || 0],
        ["ŻK", Number(stats.yellowCards) || 0],
        ["CzK", Number(stats.redCards) || 0]
      ];
  return `<tr role="row">
    <th scope="row" role="rowheader"><span class="squad-table-player"><span class="squad-player-photo" data-player-photo-frame>${photo}<i aria-hidden="true">${escapeHtml(playerInitials(player?.name))}</i></span><strong>${escapeHtml(player?.name || "Zawodnik")}</strong></span></th>
    ${statisticCells.map(([label, value]) => `<td role="cell" data-label="${escapeHtml(label)}">${value}</td>`).join("")}
  </tr>`;
}

function leagueSquadGroupHtml(group, teamId) {
  const players = Array.isArray(group?.players) ? group.players : [];
  const isGoalkeeperGroup = group?.id === "goalkeepers";
  const headers = isGoalkeeperGroup
    ? ["Zawodnik", "Wyst.", "Czyste konta", "ŻK", "CzK"]
    : ["Zawodnik", "Wyst.", "Gole", "Asysty", "ŻK", "CzK"];
  const groupLabel = String(group?.label || "Zawodnicy");
  return `<section class="squad-group" aria-labelledby="squad-${escapeHtml(teamId)}-${escapeHtml(group?.id || "")}">
    <header><h3 id="squad-${escapeHtml(teamId)}-${escapeHtml(group?.id || "")}">${escapeHtml(groupLabel)}</h3><span>${players.length}</span></header>
    ${players.length ? `<div class="squad-table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(`${groupLabel} – tabela statystyk`)}">
      <table class="squad-table${isGoalkeeperGroup ? " is-goalkeeper" : ""}" role="table">
        <thead role="rowgroup"><tr role="row">${headers.map((header) => `<th scope="col" role="columnheader">${escapeHtml(header)}</th>`).join("")}</tr></thead>
        <tbody role="rowgroup">${players.map(leaguePlayerRowHtml).join("")}</tbody>
      </table>
    </div>` : `<p class="league-empty">Brak zgłoszonych zawodników w tej formacji.</p>`}
  </section>`;
}

function leagueTeamSquadHtml(teamId) {
  const squad = state.teamSquadsById[teamId];
  const status = state.teamSquadStatusById[teamId] || "idle";
  const error = state.teamSquadErrorById[teamId] || "";
  if (status === "loading" || (status === "idle" && !squad)) {
    return `<article class="league-panel squad-panel">
      <div class="league-panel-head"><div><p class="eyebrow">KADRA ZGŁOSZONA</p><h2>Zawodnicy</h2></div></div>
      <div class="squad-loading"><span class="league-loading-mark"></span><h3>Pobieramy aktualną kadrę…</h3><p>Łączymy skład i statystyki z oficjalnego Centrum Meczowego.</p></div>
    </article>`;
  }
  if (!squad || status === "error") {
    return `<article class="league-panel squad-panel">
      <div class="league-panel-head"><div><p class="eyebrow">KADRA ZGŁOSZONA</p><h2>Zawodnicy</h2></div></div>
      <div class="squad-loading"><span class="lineup-clock">XI</span><h3>Nie udało się pobrać kadry</h3><p>${escapeHtml(error || "Oficjalne dane są chwilowo niedostępne.")}</p><button type="button" class="primary-button" data-team-squad-retry="${escapeHtml(teamId)}">SPRÓBUJ PONOWNIE</button></div>
    </article>`;
  }
  const groups = Array.isArray(squad.groups) ? squad.groups : [];
  return `<article class="league-panel squad-panel">
    <div class="league-panel-head squad-panel-head">
      <div><p class="eyebrow">KADRA ZGŁOSZONA</p><h2>Zawodnicy</h2></div>
      <span>${squad.players?.length || 0} zawodników · sezon ${escapeHtml(state.leagueData?.season?.name || "2026/27")}</span>
    </div>
    <div class="squad-groups">${groups.map((group) => leagueSquadGroupHtml(group, teamId)).join("")}</div>
    <footer class="squad-source-note"><strong>Źródło:</strong> oficjalne Centrum Meczowe i serwis Ekstraklasy. Statystyki pochodzą bezpośrednio z danych Ekstraklasy, a zdjęcie pojawia się tylko wtedy, gdy publikuje je oficjalny serwis.</footer>
  </article>`;
}

function leagueTeamView(teamId) {
  const team = teamById[teamId];
  if (!team) return leagueOverviewView();
  const standing = teamStanding(teamId);
  const recent = recentLeagueMatches(teamId, 5);
  const upcoming = upcomingLeagueMatches(teamId, 5);
  const form = teamForm(teamId, standing);
  return `<section class="team-profile-hero">
      <a class="league-back" href="#ekstraklasa" data-view-jump="ekstraklasa">← Wszystkie drużyny</a>
      <img src="${team.crest}" alt="Herb ${escapeHtml(team.name)}"><div><p class="eyebrow">DRUŻYNA EKSTRAKLASY</p><h1>${escapeHtml(team.name)}</h1><span class="league-form team-profile-form">${formHtml(form, "Forma pojawi się po pierwszych meczach")}</span></div>
      <div class="team-profile-stats"><span><b>${Number(standing?.rank) || "—"}</b>miejsce</span><span><b>${Number(standing?.points) || 0}</b>punktów</span><span><b>${Number(standing?.played) || 0}</b>meczów</span></div>
    </section>
    <section class="content-section league-section team-profile-content">
      <div class="league-two-column">
        <article class="league-panel"><div class="league-panel-head"><div><p class="eyebrow">FORMA</p><h2>Ostatnie wyniki</h2></div></div><div class="league-fixtures">${recent.length ? recent.map((match) => leagueFixtureHtml(match, teamId)).join("") : `<p class="league-empty">Brak rozegranych meczów ${escapeHtml(team.name)} w sezonie 2026/27.</p>`}</div></article>
        <article class="league-panel"><div class="league-panel-head"><div><p class="eyebrow">TERMINARZ</p><h2>Najbliższe mecze</h2></div></div><div class="league-fixtures">${upcoming.length ? upcoming.map((match) => leagueFixtureHtml(match, teamId)).join("") : `<p class="league-empty">Brak kolejnych spotkań w terminarzu.</p>`}</div></article>
      </div>
      ${leagueTeamSquadHtml(teamId)}
    </section>`;
}

function lineupPlayerHtml(player) {
  const name = player.name || [player.firstName, player.lastName].filter(Boolean).join(" ") || "Zawodnik";
  return `<li><span>${escapeHtml(player.shirtNumber ?? "—")}</span><strong>${escapeHtml(name)}${player.isCaptain ? " (C)" : ""}</strong><small>${escapeHtml(player.position || "")}</small></li>`;
}

function lineupTeamHtml(lineupTeam, fallbackTeam) {
  const team = teamById[lineupTeam?.teamId] || fallbackTeam;
  const starters = Array.isArray(lineupTeam?.starters) ? lineupTeam.starters : [];
  const substitutes = Array.isArray(lineupTeam?.substitutes) ? lineupTeam.substitutes : [];
  return `<article class="lineup-team">
    <header><img src="${team?.crest || ""}" alt=""><div><h3>${escapeHtml(team?.name || lineupTeam?.name || "Drużyna")}</h3><span>Ustawienie: ${escapeHtml(lineupTeam?.formation || "—")}</span></div></header>
    <h4>Wyjściowa jedenastka</h4><ol>${starters.map(lineupPlayerHtml).join("")}</ol>
    ${substitutes.length ? `<details><summary>Rezerwowi (${substitutes.length})</summary><ul>${substitutes.map(lineupPlayerHtml).join("")}</ul></details>` : ""}
  </article>`;
}

function leagueMatchView(matchId) {
  const match = leagueMatchByRoute(matchId);
  if (!match) {
    return `<section class="subpage-hero"><p class="eyebrow">CENTRUM MECZU</p><h1>Nie znaleziono meczu</h1><p>Ten adres nie odpowiada spotkaniu z aktualnego sezonu.</p></section><section class="content-section narrow"><a class="primary-button" href="#ekstraklasa" data-view-jump="ekstraklasa">WRÓĆ DO EKSTRAKLASY</a></section>`;
  }
  const home = teamById[match.home];
  const away = teamById[match.away];
  const providerId = String(match.providerId || "");
  const lineup = state.lineupsByMatch[providerId];
  const lineupStatus = state.lineupStatusByMatch[providerId] || "idle";
  const lineupError = state.lineupErrorByMatch[providerId] || "";
  const homeLineup = lineup?.teams?.find((team) => team.side === "home" || team.teamId === home?.id) || lineup?.teams?.[0];
  const awayLineup = lineup?.teams?.find((team) => team.side === "away" || team.teamId === away?.id) || lineup?.teams?.[1];
  const score = leagueMatchHasScore(match) && (leagueMatchIsFinal(match) || LIVE.has(match.status)) ? `${Number(match.homeScore)} : ${Number(match.awayScore)}` : "– : –";
  const lineupBody = lineupStatus === "loading"
    ? `<div class="lineup-state"><span class="league-loading-mark"></span><h2>Pobieramy składy…</h2><p>Sprawdzamy oficjalne dane obu klubów.</p></div>`
    : lineup?.published
      ? `<div class="lineup-grid">${lineupTeamHtml(homeLineup, home)}${lineupTeamHtml(awayLineup, away)}</div>`
      : `<div class="lineup-state"><span class="lineup-clock">XI</span><h2>${lineupError ? "Nie udało się pobrać składów" : "Składy nie zostały jeszcze podane"}</h2><p>${lineupError ? escapeHtml(lineupError) : "Gdy oba kluby opublikują wyjściowe jedenastki, pojawią się tutaj automatycznie i wyślemy powiadomienie."}</p><button type="button" class="primary-button" data-lineup-retry="${escapeHtml(providerId)}">SPRAWDŹ PONOWNIE</button></div>`;
  return `<section class="match-profile-hero">
      <a class="league-back" href="#ekstraklasa" data-view-jump="ekstraklasa">← Ekstraklasa</a>
      <p class="eyebrow">${escapeHtml(leagueKickoffLabel(match))} · ${escapeHtml(leagueMatchStatus(match))}</p>
      <div class="match-profile-score">
        <a href="${teamRouteHref(home.id)}" data-team-route="${home.id}"><img src="${home.crest}" alt=""><strong>${escapeHtml(home.name)}</strong></a>
        <b>${score}</b>
        <a href="${teamRouteHref(away.id)}" data-team-route="${away.id}"><img src="${away.crest}" alt=""><strong>${escapeHtml(away.name)}</strong></a>
      </div>
    </section>
    <section class="content-section league-section"><article class="league-panel lineup-panel"><div class="league-panel-head"><div><p class="eyebrow">OFICJALNE DANE</p><h2>Składy meczowe</h2></div><span>${lineup?.updatedAt ? `Aktualizacja: ${new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" }).format(new Date(lineup.updatedAt))}` : ""}</span></div>${lineupBody}</article></section>`;
}

function leagueView() {
  if (!state.leagueData || state.leagueStatus === "loading" || state.leagueStatus === "error") return leagueLoadingHtml();
  if (state.leagueMatchId) return leagueMatchView(state.leagueMatchId);
  if (state.leagueTeamId) return leagueTeamView(state.leagueTeamId);
  return leagueOverviewView();
}

function leagueBackendUrl(path) {
  const base = String(notificationApiBase || "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

async function fetchLeagueBackend(path) {
  const response = await fetch(leagueBackendUrl(path), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`League backend returned HTTP ${response.status}`);
  return response.json();
}

async function loadLeagueData({ force = false } = {}) {
  if (state.leagueStatus === "loading") return;
  const fresh = state.leagueData && Date.now() - state.leagueLoadedAt < LEAGUE_CACHE_MAX_AGE_MS;
  if (!force && fresh) {
    const selected = leagueMatchByRoute();
    if (selected) void loadLeagueLineup(selected);
    if (state.leagueTeamId) void loadLeagueTeamSquad(state.leagueTeamId);
    return;
  }
  state.leagueStatus = "loading";
  state.leagueError = "";
  if (state.view === "ekstraklasa") render();
  try {
    let payload;
    try {
      payload = await fetchLeagueBackend("/api/league");
      state.leagueSource = "worker";
    } catch (backendError) {
      console.warn("Backend ligi jest niedostępny, używam oficjalnego źródła bezpośrednio:", backendError);
      payload = await getOfficialLeaguePayload({ force });
      state.leagueSource = "official-direct";
    }
    if (!payload || !Array.isArray(payload.standings) || !Array.isArray(payload.matches)) throw new Error("Nieprawidłowa odpowiedź źródła ligi");
    state.leagueData = payload;
    state.leagueStatus = "ready";
    state.leagueError = "";
    state.leagueLoadedAt = Date.now();
  } catch (error) {
    console.error("Nie udało się pobrać danych Ekstraklasy:", error);
    state.leagueStatus = state.leagueData ? "ready" : "error";
    state.leagueError = "Nie udało się pobrać aktualnej tabeli i terminarza. Sprawdź internet i spróbuj ponownie.";
  }
  if (state.view === "ekstraklasa") render();
  const selected = leagueMatchByRoute();
  if (selected) void loadLeagueLineup(selected, { force });
  if (state.leagueTeamId) void loadLeagueTeamSquad(state.leagueTeamId, { force });
}

async function loadLeagueTeamSquad(teamId, { force = false } = {}) {
  if (!teamById[teamId] || state.teamSquadStatusById[teamId] === "loading") return;
  const cached = state.teamSquadsById[teamId];
  const loadedAt = Number(state.teamSquadLoadedAtById[teamId]) || 0;
  if (!force && cached && Date.now() - loadedAt < TEAM_SQUAD_CACHE_MAX_AGE_MS) return;
  state.teamSquadStatusById[teamId] = "loading";
  state.teamSquadErrorById[teamId] = "";
  if (state.view === "ekstraklasa" && state.leagueTeamId === teamId) render();
  try {
    let payload;
    try {
      payload = await fetchLeagueBackend(`/api/league/team-squad?team=${encodeURIComponent(teamId)}`);
    } catch (backendError) {
      console.warn("Backend kadry jest niedostępny, używam oficjalnego źródła bezpośrednio:", backendError);
      payload = await getOfficialTeamSquad(teamId, { force });
    }
    if (payload?.teamId !== teamId
      || !Array.isArray(payload?.players)
      || !Array.isArray(payload?.groups)
      || payload.players.length < 10) {
      throw new Error("Nieprawidłowa odpowiedź kadry");
    }
    state.teamSquadsById[teamId] = payload;
    state.teamSquadStatusById[teamId] = "ready";
    state.teamSquadErrorById[teamId] = "";
    state.teamSquadLoadedAtById[teamId] = Date.now();
  } catch (error) {
    console.error("Nie udało się pobrać kadry drużyny:", error);
    state.teamSquadStatusById[teamId] = cached ? "ready" : "error";
    state.teamSquadErrorById[teamId] = "Aktualna kadra jest teraz chwilowo niedostępna.";
    state.teamSquadLoadedAtById[teamId] = Date.now();
  }
  if (state.view === "ekstraklasa" && state.leagueTeamId === teamId) render();
}

async function loadLeagueLineup(match, { force = false } = {}) {
  const providerId = String(match?.providerId || "");
  if (!providerId || state.lineupStatusByMatch[providerId] === "loading") return;
  const cached = state.lineupsByMatch[providerId];
  const loadedAt = Number(state.lineupLoadedAtByMatch[providerId]) || 0;
  if (!force && cached?.published) return;
  if (!force && cached && Date.now() - loadedAt < LINEUP_PENDING_CACHE_MS) return;
  state.lineupStatusByMatch[providerId] = "loading";
  state.lineupErrorByMatch[providerId] = "";
  if (state.view === "ekstraklasa" && state.leagueMatchId) render();
  try {
    let payload;
    try {
      payload = await fetchLeagueBackend(`/api/league/lineups?provider=${encodeURIComponent(providerId)}`);
    } catch (backendError) {
      console.warn("Backend składów jest niedostępny, używam oficjalnego źródła bezpośrednio:", backendError);
      payload = await getOfficialMatchLineup(providerId, { force });
    }
    const lineup = payload?.lineup || payload;
    if (!lineup || !Array.isArray(lineup.teams)) throw new Error("Nieprawidłowa odpowiedź składów");
    state.lineupsByMatch[providerId] = lineup;
    state.lineupStatusByMatch[providerId] = "ready";
    state.lineupErrorByMatch[providerId] = "";
    state.lineupLoadedAtByMatch[providerId] = Date.now();
  } catch (error) {
    console.error("Nie udało się pobrać składów:", error);
    state.lineupStatusByMatch[providerId] = "error";
    state.lineupErrorByMatch[providerId] = "Oficjalne składy są teraz chwilowo niedostępne.";
    state.lineupLoadedAtByMatch[providerId] = Date.now();
  }
  if (state.view === "ekstraklasa" && state.leagueMatchId) render();
}

function rankingRows() {
  return state.rankingPlayers.map((player) => {
    const typed = Number.isInteger(player.typed) ? player.typed : 0;
    const points = Number.isInteger(player.points) ? player.points : 0;
    return {
      ...player,
      points,
      typed,
      accuracy: typed ? Math.round(points / typed * 100) : 0
    };
  }).sort((a, b) => b.points - a.points
    || a.joinedAtMs - b.joinedAtMs
    || profileForUid(a.uid).name.localeCompare(profileForUid(b.uid).name, "pl"));
}

function rankingView() {
  const players = rankingRows();
  return `<section class="subpage-hero"><p class="eyebrow">KLASYFIKACJA</p><h1>Ranking typerów</h1><p>Ranking obejmuje rundę jesienną. Każdy trafiony rezultat to dokładnie jeden punkt.</p></section>
    <section class="content-section narrow">
      ${!state.user ? `<div class="notice">Zaloguj się przez Google, żeby pojawić się w rankingu i zapisywać typy między urządzeniami.</div>` : ""}
      ${state.rankingError ? `<div class="notice ranking-notice"><span>${escapeHtml(state.rankingError)}</span><button type="button" data-ranking-retry>SPRÓBUJ PONOWNIE</button></div>` : ""}
      <div class="ranking-card" aria-live="polite" aria-busy="${state.rankingStatus === "loading"}">
        <div class="ranking-head"><span>#</span><span>Gracz</span><span>Punkty</span><span>Typy</span><span>Skuteczność</span></div>
        ${state.user && (state.rankingStatus === "idle" || state.rankingStatus === "loading") && !players.length
          ? `<div class="ranking-empty ranking-loading"><strong>Pobieramy prawdziwych graczy…</strong><span>Za chwilę zobaczysz aktualną klasyfikację.</span></div>`
          : players.length
            ? players.map((player, index) => {
              const profile = profileForUid(player.uid);
              const mine = player.uid === state.user?.uid;
              const rank = players.findIndex((candidate) => candidate.points === player.points) + 1;
              return `<div class="ranking-row${mine ? " me" : ""}"><b>${rank}</b><span>${playerAvatarButton(player.uid, "ranking-avatar")}<strong>${escapeHtml(profile.name)}</strong>${mine ? "<small>TY</small>" : ""}</span><strong>${player.points}</strong><span>${player.typed}</span><span>${player.accuracy}%</span></div>`;
            }).join("")
            : `<div class="ranking-empty"><strong>Brak graczy do wyświetlenia</strong><span>Ranking pokazuje wyłącznie prawdziwe konta Google — bez fikcyjnych wpisów.</span></div>`}
      </div>
    </section>`;
}

async function loadRankingData() {
  if (!state.user || !state.participantReady || !state.db || !state.firebaseModules) return;
  if (rankingLoadPromise) {
    rankingReloadPending = true;
    return rankingLoadPromise;
  }

  const uid = state.user.uid;
  const revision = ++rankingLoadRevision;
  state.rankingStatus = "loading";
  state.rankingError = "";
  if (["matches", "ranking"].includes(state.view)) render();

  const operation = (async () => {
    const { collection, getDocs } = state.firebaseModules;
    await syncOwnLeaderboardIdentity(uid);
    await reconcileOwnLeaderboard(uid);
    const leaderboardSnapshot = await getDocs(collection(state.db, "seasons", SEASON_ID, "leaderboard"));
    const profiles = {};
    const players = leaderboardSnapshot.docs.map((item) => {
      const data = item.data();
      profiles[item.id] = normalizePublicProfile(item.id, data);
      return {
        uid: item.id,
        joinedAtMs: firestoreTimeMs(data.joinedAt),
        points: Number.isInteger(data.points) && data.points >= 0 ? data.points : 0,
        typed: Number.isInteger(data.typed) && data.typed >= 0 ? data.typed : 0
      };
    });

    if (state.user?.uid !== uid || revision !== rankingLoadRevision) return;
    state.chatProfiles = { ...state.chatProfiles, ...profiles };
    state.rankingPlayers = players;
    state.rankingStatus = "ready";
    state.rankingError = "";
  })().catch((error) => {
    if (state.user?.uid !== uid || revision !== rankingLoadRevision) return;
    console.error("Nie udało się pobrać rankingu graczy:", error);
    state.rankingStatus = "error";
    state.rankingError = "Nie udało się pobrać aktualnego rankingu. Sprawdź internet i spróbuj ponownie.";
  }).finally(() => {
    if (revision === rankingLoadRevision) rankingLoadPromise = null;
    if (revision === rankingLoadRevision && ["matches", "ranking"].includes(state.view) && state.user?.uid === uid) render();
    if (revision === rankingLoadRevision && rankingReloadPending) {
      rankingReloadPending = false;
      void loadRankingData();
    }
  });

  rankingLoadPromise = operation;
  return operation;
}

async function loadOwnPlayerForm() {
  if (!state.user || !state.participantReady || !state.db || !state.firebaseModules) return;
  if (playerFormLoadPromise) return playerFormLoadPromise;

  const uid = state.user.uid;
  const revision = ++playerFormLoadRevision;
  state.playerFormStatus = "loading";
  state.playerFormError = "";
  if (state.view === "matches") render();

  const operation = (async () => {
    const { collection, getDocs, limit, orderBy, query } = state.firebaseModules;
    const scoresQuery = query(
      collection(state.db, "seasons", SEASON_ID, "players", uid, "scores"),
      orderBy("settledAt", "desc"),
      limit(5)
    );
    const snapshot = await getDocs(scoresQuery);
    const form = snapshot.docs.map((item) => {
      const data = item.data();
      const matchId = typeof data.matchId === "string" ? data.matchId : item.id;
      const points = Number(data.points);
      const pick = ["1", "X", "2"].includes(data.pick) ? data.pick : "";
      if (data.uid !== uid || !typerMatchIds.has(matchId) || !pick || ![0, 1].includes(points)) return null;
      return { matchId, pick, points, hit: points === 1 };
    }).filter(Boolean);

    if (state.user?.uid !== uid || revision !== playerFormLoadRevision) return;
    state.playerForm = form;
    state.playerFormStatus = "ready";
    state.playerFormError = "";
  })().catch((error) => {
    if (state.user?.uid !== uid || revision !== playerFormLoadRevision) return;
    console.error("Nie udało się pobrać ostatniej formy gracza:", error);
    state.playerForm = [];
    state.playerFormStatus = "error";
    state.playerFormError = "Nie udało się pobrać ostatnich rozliczonych typów.";
  }).finally(() => {
    if (revision === playerFormLoadRevision) playerFormLoadPromise = null;
    if (revision === playerFormLoadRevision && state.view === "matches" && state.user?.uid === uid) render();
  });

  playerFormLoadPromise = operation;
  return operation;
}

async function loadPlayerDashboardData({ refreshRanking = false, refreshForm = false } = {}) {
  const uid = state.user?.uid;
  if (!uid || !state.participantReady) return;
  if (refreshRanking || state.rankingStatus !== "ready") await loadRankingData();
  if (state.user?.uid !== uid || !state.participantReady) return;
  if (refreshForm || state.playerFormStatus !== "ready") await loadOwnPlayerForm();
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
    return `<div class="prize-pool-card"><div class="prize-pool-waiting"><strong>Nie uzbierano minimalnej liczby graczy.</strong></div></div>`;
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
  return `<section class="subpage-hero"><p class="eyebrow">PROSTE ZASADY</p><h1>Piłka jest prosta.<br>Ten typer też.</h1><p>Typujemy wyłącznie rundę jesienną: kolejki 1–17.</p></section>
    <section class="content-section narrow rules-grid">
      <article><b>01</b><span>${icon("calendar")}</span><h3>Wybierz 1, X lub 2</h3><p>1 oznacza wygraną gospodarzy, X remis, a 2 wygraną gości. Nie typujemy dokładnych wyników.</p></article>
      <article><b>02</b><span>${icon("lock")}</span><h3>Zdąż przed gwizdkiem</h3><p>Typ możesz zmieniać do rozpoczęcia meczu. Później zostaje automatycznie zablokowany.</p></article>
      <article><b>03</b><span>${icon("trophy")}</span><h3>Zdobądź 1 punkt</h3><p>Za każdy prawidłowy rezultat otrzymujesz jeden punkt. Wygrywa najwyższy wynik po 17. kolejce.</p></article>
      <div class="rule-banner">
        <div class="rule-stat"><strong>100 zł</strong><span>wpisowe za gracza</span></div>
        <div class="rule-stat"><strong>${TYPER_MATCH_COUNT}</strong><span>mecze rundy jesiennej</span></div>
        <div class="rule-stat"><strong>${LAST_MATCHDAY}</strong><span>kolejek</span></div>
        <div class="rule-stat"><strong>1</strong><span>punkt za trafienie</span></div>
      </div>
      ${prizePoolHtml()}
    </section>`;
}

function adminRequestStatusLabel(status) {
  return status === "approved" ? "Zatwierdzony" : status === "rejected" ? "Odrzucony" : "Oczekuje";
}

function adminPlayerCard(player) {
  const profileReady = player.hasProfile === true && Boolean(player.displayName);
  const displayName = profileReady ? player.displayName : "Brak profilu gracza";
  const googleName = player.googleName || "Pojawi się po ponownym logowaniu";
  const email = player.email || "Pojawi się po ponownym logowaniu";
  const policy = player.selfRenameUsed
    ? "Darmowa zmiana wykorzystana"
    : "Darmowa zmiana dostępna";
  const pending = player.pendingNameRequestId
    ? `<span class="admin-player-pending">Wniosek oczekuje</span>`
    : "";
  return `<article class="admin-player-card" data-admin-player data-admin-uid="${escapeHtml(player.uid)}">
    <header>
      <span class="admin-player-initial">${escapeHtml(String(displayName || "G").slice(0, 1).toUpperCase())}</span>
      <div><h3>${escapeHtml(displayName)}</h3><small>UID: ${escapeHtml(player.uid)}</small></div>
      ${pending}
    </header>
    <dl class="admin-player-data">
      <div><dt>Nazwa Google</dt><dd>${escapeHtml(googleName)}</dd></div>
      <div><dt>Email</dt><dd>${escapeHtml(email)}</dd></div>
      <div><dt>Ostatnie logowanie</dt><dd>${escapeHtml(formatAdminDate(player.lastSeenAt))}</dd></div>
      <div><dt>Zmiana własna</dt><dd>${escapeHtml(policy)}</dd></div>
    </dl>
    <form class="admin-player-name-form" data-admin-name-form="${escapeHtml(player.uid)}">
      <label><span>Nick w typerze</span><input name="displayName" type="text" maxlength="${MAX_DISPLAY_NAME_LENGTH}" value="${escapeHtml(player.displayName || "")}" autocomplete="off" ${profileReady ? "" : "disabled"}></label>
      <button type="submit" ${!profileReady || state.adminBusyId === player.uid ? "disabled" : ""}>${state.adminBusyId === player.uid ? "ZAPISYWANIE…" : "ZAPISZ NICK"}</button>
    </form>
    ${profileReady ? "" : `<p class="admin-player-note">Edycja będzie dostępna, gdy konto utworzy profil i wpis w rankingu.</p>`}
  </article>`;
}

function adminRequestCard(request, playersByUid) {
  const player = playersByUid.get(request.uid);
  const identity = player?.email || player?.googleName || request.uid;
  const pending = request.status === "pending";
  const busy = state.adminBusyId === request.id;
  return `<article class="admin-request-card is-${request.status}" data-admin-request="${escapeHtml(request.id)}">
    <header>
      <span class="admin-status-chip is-${request.status}">${escapeHtml(adminRequestStatusLabel(request.status))}</span>
      <time>${escapeHtml(formatAdminDate(request.createdAt))}</time>
    </header>
    <div class="admin-request-change">
      <span><small>Obecny nick</small><strong>${escapeHtml(request.currentName)}</strong></span>
      <b aria-hidden="true">→</b>
      <span><small>Proponowany nick</small><strong>${escapeHtml(request.requestedName)}</strong></span>
    </div>
    <p class="admin-request-owner">${escapeHtml(identity)}<small>${escapeHtml(request.uid)}</small></p>
    ${request.adminNote ? `<p class="admin-request-resolution"><strong>Notatka:</strong> ${escapeHtml(request.adminNote)}</p>` : ""}
    ${request.resolvedAt ? `<p class="admin-request-resolution">Rozpatrzono: ${escapeHtml(formatAdminDate(request.resolvedAt))}</p>` : ""}
    ${pending ? `<label class="admin-request-note"><span>Notatka dla gracza (opcjonalnie)</span><input name="adminNote" maxlength="300" placeholder="Np. nick jest już zajęty"></label>
      <div class="admin-request-actions">
        <button type="button" data-admin-request-action="approve" data-request-id="${escapeHtml(request.id)}" ${busy ? "disabled" : ""}>${busy ? "ZAPISYWANIE…" : "ZATWIERDŹ"}</button>
        <button type="button" class="is-reject" data-admin-request-action="reject" data-request-id="${escapeHtml(request.id)}" ${busy ? "disabled" : ""}>ODRZUĆ</button>
      </div>` : ""}
  </article>`;
}

function adminView() {
  const heroMarkup = `<section class="subpage-hero admin-hero"><p class="eyebrow">ZARZĄDZANIE LIGĄ</p><h1>Panel admina</h1><p>Gracze, nicki i wnioski o kolejną zmianę nazwy.</p></section>`;
  if (state.authStatus === "loading") {
    return `${heroMarkup}<section class="content-section admin-section"><div class="admin-state-card"><span class="admin-state-spinner"></span><h2>Sprawdzamy uprawnienia</h2><p>Panel otworzy się po potwierdzeniu sesji Google.</p></div></section>`;
  }
  if (!isCurrentUserAdmin()) {
    return `${heroMarkup}<section class="content-section admin-section"><div class="admin-state-card is-forbidden"><strong>403</strong><h2>Brak dostępu</h2><p>Ten panel jest dostępny wyłącznie dla administratora zalogowanego zweryfikowanym kontem Google.</p>${state.user ? `<a class="primary-button" href="#matches/${state.matchday}" data-view-jump="matches">WRÓĆ DO MECZÓW</a>` : `<button class="primary-button" data-open-auth>ZALOGUJ PRZEZ GOOGLE</button>`}</div></section>`;
  }

  const pendingCount = state.adminRequests.filter((request) => request.status === "pending").length;
  const approvedCount = state.adminRequests.filter((request) => request.status === "approved").length;
  const rejectedCount = state.adminRequests.filter((request) => request.status === "rejected").length;
  const playersByUid = new Map(state.adminPlayers.map((player) => [player.uid, player]));
  const requestMarkup = state.adminRequestsStatus === "loading" || state.adminRequestsStatus === "idle"
    ? `<div class="admin-state-inline"><span class="admin-state-spinner"></span>Wczytujemy wnioski…</div>`
    : state.adminRequestsStatus === "error"
      ? `<div class="admin-error"><span>${escapeHtml(state.adminRequestsError || "Nie udało się pobrać wniosków.")}</span><button type="button" data-admin-retry>SPRÓBUJ PONOWNIE</button></div>`
      : state.adminRequests.length
        ? `<div class="admin-request-list">${state.adminRequests.map((request) => adminRequestCard(request, playersByUid)).join("")}</div>`
        : `<div class="admin-empty"><h3>Brak wniosków</h3><p>Gdy gracz wykorzysta darmową zmianę i poprosi o kolejną, wniosek pojawi się tutaj.</p></div>`;
  const playersMarkup = state.adminPlayersStatus === "loading" || state.adminPlayersStatus === "idle"
    ? `<div class="admin-state-inline"><span class="admin-state-spinner"></span>Wczytujemy konta graczy…</div>`
    : state.adminPlayersStatus === "error"
      ? `<div class="admin-error"><span>${escapeHtml(state.adminPlayersError || "Nie udało się pobrać graczy.")}</span><button type="button" data-admin-retry>SPRÓBUJ PONOWNIE</button></div>`
      : state.adminPlayers.length
        ? `<div class="admin-player-list">${state.adminPlayers.map(adminPlayerCard).join("")}</div><div class="admin-empty admin-search-empty" data-admin-search-empty hidden><h3>Brak wyników</h3><p>Zmień wyszukiwaną nazwę, email albo UID.</p></div>`
        : `<div class="admin-empty"><h3>Brak graczy</h3><p>Dane kont pojawią się po zalogowaniu użytkowników.</p></div>`;

  return `${heroMarkup}<section class="content-section admin-section">
    <div class="admin-stats">
      <article><strong>${state.adminPlayers.length}</strong><span>graczy</span></article>
      <article><strong>${pendingCount}</strong><span>oczekujących</span></article>
      <article><strong>${approvedCount}</strong><span>zatwierdzonych</span></article>
      <article><strong>${rejectedCount}</strong><span>odrzuconych</span></article>
    </div>
    <article class="admin-panel">
      <div class="admin-panel-heading"><div><p class="eyebrow">WNIOSKI O NICK</p><h2>Wszystkie zgłoszenia</h2></div><span>Najpierw oczekujące, potem najnowsze.</span></div>
      ${requestMarkup}
    </article>
    <article class="admin-panel">
      <div class="admin-panel-heading admin-player-heading"><div><p class="eyebrow">KONTA GOOGLE</p><h2>Gracze</h2></div>
        <label class="admin-search"><span>Wyszukaj gracza</span><input id="adminPlayerSearch" type="search" value="${escapeHtml(state.adminSearch)}" placeholder="Nick, nazwa Google, email lub UID" autocomplete="off"></label>
      </div>
      ${state.adminPlayersStatus === "ready" && state.adminPlayersError ? `<div class="admin-warning">${escapeHtml(state.adminPlayersError)} Brakujące dane pojawią się po ponownym logowaniu gracza.</div>` : ""}
      ${playersMarkup}
    </article>
  </section>`;
}

function settingsView() {
  const heroMarkup = `<section class="subpage-hero"><p class="eyebrow">TWÓJ PROFIL</p><h1>Ustawienia</h1><p>Ustaw nazwę i avatar, z którymi wchodzisz do gry.</p></section>`;
  if (!state.user) {
    return `${heroMarkup}<section class="content-section narrow"><div class="settings-locked"><div class="settings-lock-icon">G</div><h2>Zaloguj się przez Google</h2><p>Nazwa i avatar są częścią profilu gracza i synchronizują się między urządzeniami.</p><button class="primary-button" data-open-auth>PRZEJDŹ DO LOGOWANIA ${icon("arrow")}</button></div></section>`;
  }

  const profileBusy = state.avatarBusy || state.nameBusy;
  const disabled = profileBusy ? "disabled" : "";
  const namePolicy = normalizeProfileNamePolicy(state.profileNamePolicy);
  const hasPendingNameRequest = Boolean(namePolicy.pendingNameRequestId);
  const nameInputDisabled = profileBusy || !state.userDataReady || hasPendingNameRequest;
  const nameDisabled = nameInputDisabled ? "disabled" : "";
  const freeRenameAvailable = !namePolicy.selfRenameUsed;
  const nameSubmitLabel = state.nameBusy
    ? "ZAPISYWANIE…"
    : hasPendingNameRequest
      ? "WNIOSEK OCZEKUJE"
      : freeRenameAvailable
        ? "ZMIEŃ NICK"
        : "WYŚLIJ WNIOSEK";
  const nameStatusMarkup = hasPendingNameRequest
    ? `<div class="profile-name-status is-pending"><strong>Wniosek oczekuje na decyzję</strong><span>${state.nameRequest?.requestedName ? `Proponowany nick: ${escapeHtml(state.nameRequest.requestedName)}.` : "Szczegóły wniosku są synchronizowane."} Do czasu decyzji używasz nazwy ${escapeHtml(state.user.name)}.</span></div>`
    : freeRenameAvailable
      ? `<div class="profile-name-status is-free"><strong>Masz jedną bezpłatną zmianę</strong><span>Zapisanie nowego nicku wykorzysta ją od razu. Każda następna zmiana będzie wymagała zgody administratora.</span></div>`
      : `<div class="profile-name-status"><strong>Bezpłatna zmiana została wykorzystana</strong><span>Możesz zaproponować kolejny nick. Zmieni się dopiero po zatwierdzeniu wniosku przez administratora.</span></div>`;
  const currentType = state.avatar.type;
  const currentValue = state.avatar.value;
  const googleAvatar = { type: "google", value: "" };
  const notificationState = chatNotificationState();
  const notificationEnabled = notificationState === "enabled";
  const notificationBusy = notificationState === "busy";
  const notificationPending = notificationState === "pending";
  const notificationBlocked = notificationBusy || notificationState === "unsupported";
  const notificationCopy = notificationState === "unsupported"
    ? "To urządzenie nie obsługuje powiadomień webowych."
    : notificationState === "denied"
      ? "Powiadomienia są zablokowane w ustawieniach aplikacji lub przeglądarki."
      : notificationBusy
        ? "Łączymy to urządzenie z bezpiecznym kanałem powiadomień."
      : notificationPending
        ? "Urządzenie zachowało zgodę, ale kanał czeka na ponowne połączenie z backendem."
      : notificationEnabled
        ? "Dostaniesz wiadomości z chatu, podane składy, przypomnienia o kolejce, wyniki i podsumowania punktów także po zamknięciu Typera."
        : "Włącz powiadomienia o chacie, nowych graczach, podanych składach, starcie kolejki, wynikach meczów i zdobytych punktach.";
  return `${heroMarkup}<section class="content-section settings-section">
    <div class="settings-profile-card">
      ${avatarVisualMarkup("settings-avatar-preview", `Avatar ${state.user.name}`)}
      <div><p class="eyebrow">TWÓJ PROFIL</p><h2>${escapeHtml(state.user.name)}</h2><span class="settings-identity"><b>Nazwa Google</b>${escapeHtml(state.user.googleName || "Brak nazwy Google")}<b>Email</b>${escapeHtml(state.user.email || "Konto Google")}</span></div>
      <small>${state.nameBusy ? "Zapisywanie nazwy…" : state.avatarBusy ? "Zapisywanie avatara…" : state.avatarPending ? "Oczekuje na synchronizację" : "Zapisany na Twoim koncie"}</small>
    </div>
    <div class="settings-panels">
      <article class="settings-panel">
        <div class="settings-panel-heading"><span>01</span><div><h3>Nick gracza</h3><p>Publiczna nazwa widoczna w typerze, rankingu i chacie. Nie zmienia nazwy Twojego konta Google.</p></div></div>
        ${nameStatusMarkup}
        ${state.nameRequestStatus === "error" ? `<div class="profile-name-error">${escapeHtml(state.nameRequestError || "Nie udało się pobrać stanu wniosku.")}</div>` : ""}
        <form id="displayNameForm" class="profile-name-form">
          <label class="profile-name-field" for="displayNameInput"><span>Nick w typerze</span><input id="displayNameInput" class="profile-name-input" type="text" value="${escapeHtml(state.user.name)}" maxlength="${MAX_DISPLAY_NAME_LENGTH}" autocomplete="nickname" required ${nameDisabled}></label>
          <button class="primary-button profile-name-save" type="submit" ${nameDisabled}>${nameSubmitLabel}</button>
          <small class="profile-name-help">Maksymalnie ${MAX_DISPLAY_NAME_LENGTH} znaków. ${freeRenameAvailable ? "To Twoja jedyna natychmiastowa, bezpłatna zmiana." : "Kolejna zmiana wymaga akceptacji administratora."}</small>
        </form>
      </article>

      <article class="settings-panel">
        <div class="settings-panel-heading"><span>02</span><div><h3>Zdjęcie lub grafika</h3><p>Użyj zdjęcia Google albo wgraj własny plik. Grafikę automatycznie przytniemy do kwadratu.</p></div></div>
        <div class="avatar-source-actions">
          <button class="avatar-source-card ${currentType === "google" ? "is-selected" : ""}" data-avatar-type="google" data-avatar-value="" aria-pressed="${currentType === "google"}" ${disabled}>
            ${avatarVisualMarkup("avatar-option-image", "Zdjęcie Google", googleAvatar)}<span><strong>Zdjęcie Google</strong><small>lub inicjał konta</small></span>
          </button>
          <label class="avatar-upload-card ${currentType === "upload" ? "is-selected" : ""} ${profileBusy ? "is-disabled" : ""}">
            <input id="avatarUpload" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" ${disabled}>
            <span class="upload-mark">↑</span><span><strong>Wgraj własną</strong><small>JPG, PNG lub WEBP · maks. 8 MB</small></span>
          </label>
        </div>
      </article>

      <article class="settings-panel">
        <div class="settings-panel-heading"><span>03</span><div><h3>Twój klub Ekstraklasy</h3><p>Wybierz herb, który będzie reprezentował Cię w typerze.</p></div></div>
        <div class="club-avatar-grid">${teams.map((team) => `<button class="avatar-choice club-avatar-choice ${currentType === "club" && currentValue === team.id ? "is-selected" : ""}" data-avatar-type="club" data-avatar-value="${team.id}" aria-pressed="${currentType === "club" && currentValue === team.id}" title="${escapeHtml(team.name)}" ${disabled}><img src="${team.crest}" alt=""><span>${escapeHtml(team.name)}</span></button>`).join("")}</div>
      </article>

      <article class="settings-panel">
        <div class="settings-panel-heading"><span>04</span><div><h3>Gotowe avatary</h3><p>Wybierz jeden z 18 gotowych motywów.</p></div></div>
        <div class="stock-avatar-grid">${stockAvatars.map((avatar) => `<button class="avatar-choice stock-avatar-choice ${currentType === "stock" && currentValue === avatar.id ? "is-selected" : ""}" data-avatar-type="stock" data-avatar-value="${avatar.id}" aria-pressed="${currentType === "stock" && currentValue === avatar.id}" ${disabled}><img src="${escapeHtml(avatar.src)}" alt=""><span>${escapeHtml(avatar.label)}</span></button>`).join("")}</div>
      </article>

      <article class="settings-panel settings-notification-panel">
        <div class="settings-panel-heading"><span>05</span><div><h3>Powiadomienia</h3><p>${notificationCopy}</p></div></div>
        <div class="settings-notification-row">
          <span class="settings-notification-status ${notificationEnabled ? "is-enabled" : ""}">${notificationBusy ? "Łączenie…" : notificationPending ? "Oczekuje" : notificationEnabled ? "Włączone" : notificationState === "denied" ? "Zablokowane" : notificationState === "unsupported" ? "Niedostępne" : "Wyłączone"}</span>
          <button type="button" class="settings-notification-button" data-chat-notifications ${notificationBlocked ? "disabled" : ""}>${notificationBusy ? "ŁĄCZENIE…" : notificationPending ? "SPRÓBUJ PONOWNIE" : notificationEnabled ? "WYŁĄCZ" : "WŁĄCZ POWIADOMIENIA"}</button>
        </div>
      </article>

      <article class="settings-panel settings-account-panel">
        <div class="settings-panel-heading"><span>06</span><div><h3>Konto</h3><p>Zakończ sesję na tym urządzeniu. Twoje zapisane typy i ustawienia pozostaną na koncie.</p></div></div>
        <div class="settings-account-row">
          <div><strong>Nick: ${escapeHtml(state.user.name)}</strong><span>Nazwa Google: ${escapeHtml(state.user.googleName || "brak")} · ${escapeHtml(state.user.email || "Konto Google")}</span></div>
          <button type="button" class="settings-signout-button" data-sign-out>WYLOGUJ SIĘ</button>
        </div>
      </article>
    </div>
  </section>`;
}

function currentDocumentTitle() {
  if (state.view === "ekstraklasa") {
    if (state.leagueTeamId && teamById[state.leagueTeamId]) return `${teamById[state.leagueTeamId].name} – Ekstraklapa Typer`;
    const match = leagueMatchByRoute();
    if (match && teamById[match.home] && teamById[match.away]) {
      return `${teamById[match.home].name} – ${teamById[match.away].name} – Ekstraklapa Typer`;
    }
    return "Ekstraklasa – Ekstraklapa Typer";
  }
  const labels = { matches: "Mecze", ranking: "Ranking", rules: "Zasady", settings: "Ustawienia", admin: "Panel admina" };
  return `${labels[state.view] || "Typer"} – Ekstraklapa Typer`;
}

function render() {
  app.innerHTML = state.view === "ranking"
    ? rankingView()
    : state.view === "ekstraklasa"
      ? leagueView()
    : state.view === "rules"
      ? rulesView()
      : state.view === "settings"
        ? settingsView()
        : state.view === "admin"
          ? adminView()
          : matchesView();
  document.title = currentDocumentTitle();
  document.querySelectorAll(".nav-link").forEach((node) => node.classList.toggle("is-active", node.dataset.view === state.view));
  updateAuthButton();
  bindRendered();
  updateCountdowns();
  updateChatWidget({ keepScroll: true });
}

function bindRendered() {
  app.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", () => setPrediction(button.dataset.match, button.dataset.pick)));
  app.querySelectorAll("[data-matchday-step]").forEach((button) => button.addEventListener("click", (event) => {
    const step = Number(button.dataset.matchdayStep);
    const matchday = state.matchday + step;
    if (![-1, 1].includes(step) || !Number.isInteger(matchday) || matchday < 1 || matchday > LAST_MATCHDAY) return;
    const restoreKeyboardFocus = event.detail === 0;
    applyAppRoute({ view: "matches", matchday }, { historyMode: "push", focus: false });
    if (restoreKeyboardFocus) {
      requestAnimationFrame(() => {
        const sameDirection = app.querySelector(`[data-matchday-step="${step}"]`);
        const fallbackDirection = app.querySelector(`[data-matchday-step="${-step}"]`);
        (sameDirection?.disabled ? fallbackDirection : sameDirection)?.focus({ preventScroll: true });
      });
    }
  }));
  app.querySelectorAll("[data-view-jump]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    setView(button.dataset.viewJump);
  }));
  app.querySelector("[data-scroll-matches]")?.addEventListener("click", () => document.querySelector("#mecze")?.scrollIntoView({ behavior: "smooth" }));
  app.querySelectorAll("[data-match-centre]").forEach((button) => button.addEventListener("click", () => showMatchCentre(button.dataset.matchCentre)));
  app.querySelector("[data-open-auth]")?.addEventListener("click", openAuthDialog);
  app.querySelectorAll("[data-avatar-type]").forEach((button) => button.addEventListener("click", () => selectAvatar(button.dataset.avatarType, button.dataset.avatarValue || "")));
  app.querySelector("#avatarUpload")?.addEventListener("change", (event) => handleAvatarUpload(event.target.files?.[0]));
  app.querySelector("#displayNameForm")?.addEventListener("submit", saveDisplayName);
  const adminPlayerSearch = app.querySelector("#adminPlayerSearch");
  adminPlayerSearch?.addEventListener("input", filterAdminPlayers);
  if (adminPlayerSearch && state.adminSearch) filterAdminPlayers({ currentTarget: adminPlayerSearch });
  app.querySelectorAll("[data-admin-name-form]").forEach((form) => form.addEventListener("submit", saveAdminDisplayName));
  app.querySelectorAll("[data-admin-request-action]").forEach((button) => button.addEventListener("click", decideAdminNameRequest));
  app.querySelectorAll("[data-admin-retry]").forEach((button) => button.addEventListener("click", () => {
    startAdminNameRequestsRealtime({ restart: true });
    void loadAdminPlayers({ force: true });
  }));
  app.querySelector("[data-chat-notifications]")?.addEventListener("click", toggleChatNotifications);
  app.querySelector("[data-ranking-retry]")?.addEventListener("click", () => loadRankingData());
  app.querySelector("[data-league-refresh]")?.addEventListener("click", () => loadLeagueData({ force: true }));
  app.querySelector("[data-lineup-retry]")?.addEventListener("click", () => {
    const match = leagueMatchByRoute();
    if (match) void loadLeagueLineup(match, { force: true });
  });
  app.querySelector("[data-team-squad-retry]")?.addEventListener("click", (event) => {
    const teamId = event.currentTarget.dataset.teamSquadRetry;
    if (teamById[teamId]) void loadLeagueTeamSquad(teamId, { force: true });
  });
  app.querySelectorAll("[data-player-photo]").forEach((image) => image.addEventListener("error", () => {
    image.closest("[data-player-photo-frame]")?.classList.add("is-fallback");
    image.remove();
  }, { once: true }));
  app.querySelectorAll("[data-avatar-image]").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));
}

function refreshPredictionUi() {
  render();
  if (state.playerPicksUid === state.user?.uid && document.querySelector("#playerPicksDialog")?.open) {
    renderPlayerPicksDialog();
  }
}

function setPrediction(matchId, pick) {
  if (!state.user || state.user.provider !== "google.com" || state.auth?.currentUser?.uid !== state.user.uid) {
    openAuthDialog();
    notify("Zaloguj się przez Google, aby oddać typ");
    return;
  }
  if (!state.userDataReady || !state.participantReady) {
    notify("Kończymy synchronizację konta — typowanie będzie dostępne za chwilę.");
    return;
  }
  const match = state.matches.find((item) => item.id === matchId);
  if (!match) return;
  if (!typerMatchIds.has(match.id) || match.matchday > LAST_MATCHDAY) return notify("Ten mecz nie należy do rundy jesiennej typera.");
  if (!match.kickoffConfirmed) return notify("Typowanie ruszy po potwierdzeniu dokładnego terminu meczu.");
  if (!isPredictionOpen(match)) return notify("Ten mecz już się rozpoczął — typ jest zamknięty.");
  const uid = state.user.uid;
  const queueKey = `${uid}:${matchId}`;
  const version = (predictionWriteVersions.get(queueKey) || 0) + 1;
  predictionWriteVersions.set(queueKey, version);
  state.predictions[matchId] = pick;
  refreshPredictionUi();

  const previousWrite = predictionWriteQueues.get(queueKey) || Promise.resolve();
  const operation = previousWrite.catch(() => {}).then(async () => {
    await saveRemotePrediction(uid, matchId, pick);
    if (state.user?.uid === uid) state.confirmedPredictions[matchId] = pick;
  });
  predictionWriteQueues.set(queueKey, operation);
  operation.then(() => {
    if (state.user?.uid === uid && predictionWriteVersions.get(queueKey) === version) {
      refreshPredictionUi();
      notify(`Typ ${pick} zapisany`);
    }
  }).catch((error) => {
    console.error("Nie udało się zapisać typu w Firestore:", error);
    if (state.user?.uid !== uid || predictionWriteVersions.get(queueKey) !== version) return;
    const confirmed = state.confirmedPredictions[matchId];
    if (["1", "X", "2"].includes(confirmed)) state.predictions[matchId] = confirmed;
    else delete state.predictions[matchId];
    refreshPredictionUi();
    notify(error?.code === "permission-denied"
      ? "Serwer zamknął już ten mecz — typ nie został zmieniony."
      : "Nie udało się zapisać typu. Sprawdź internet i spróbuj ponownie.");
  }).finally(() => {
    if (predictionWriteQueues.get(queueKey) === operation) predictionWriteQueues.delete(queueKey);
  });
}

function showMatchCentre(matchId) {
  const match = state.matches.find((item) => item.id === matchId);
  if (!match || !typerMatchIds.has(match.id)) {
    notify("Nie udało się odnaleźć tego meczu.");
    return false;
  }
  const home = teamById[match.home], away = teamById[match.away];
  const status = LIVE.has(match.status) ? `LIVE${match.liveElapsed ? ` · ${match.liveElapsed}'` : ""}` : FINAL.has(match.status) ? "Mecz zakończony" : "Mecz zaplanowany";
  const matchDialog = document.querySelector("#matchDialog");
  if (!home || !away || !matchDialog) return false;
  const pick = state.user ? state.predictions[match.id] : null;
  const result = resultOf(match);
  const points = pick && result ? (pick === result ? 1 : 0) : null;
  const pickSummary = state.user
    ? `<div class="match-pick-summary${points === 1 ? " is-hit" : points === 0 ? " is-miss" : ""}"><span>Twój typ</span><strong>${pick || "—"}</strong><small>${points === 1 ? "+1 pkt · trafiony" : points === 0 ? "0 pkt · nietrafiony" : pick ? "Czeka na rozliczenie" : "Brak oddanego typu"}</small></div>`
    : "";
  matchDialog.dataset.matchId = match.id;
  matchDialog.innerHTML = `<button class="modal-close" data-close>×</button><p class="eyebrow">WYNIK MECZU</p><div class="modal-score"><a href="${teamRouteHref(home.id)}" data-team-route="${home.id}"><img src="${home.crest}" alt=""><b>${home.name}</b></a><strong>${Number.isFinite(match.homeScore) ? `${match.homeScore} : ${match.awayScore}` : "– : –"}</strong><a href="${teamRouteHref(away.id)}" data-team-route="${away.id}"><img src="${away.crest}" alt=""><b>${away.name}</b></a></div><p class="no-events">${status}</p>${pickSummary}`;
  if (!matchDialog.open) matchDialog.showModal();
  return true;
}

function notify(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message; toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2400);
}

function clearNotificationRoute(route = currentAppRoute()) {
  const query = new URLSearchParams(location.search);
  ["chat", "match", "matchday", "summary", "player", "notification"].forEach((key) => query.delete(key));
  const queryString = query.toString();
  history.replaceState(null, "", `${location.pathname}${queryString ? `?${queryString}` : ""}${appRouteHash(typeof route === "string" ? { view: route, matchday: state.matchday } : route)}`);
  lastAppliedRouteHref = location.href;
}

function discardInvalidNotificationMatchRoute() {
  notificationMatchId = "";
  const query = new URLSearchParams(location.search);
  query.delete("match");
  const queryString = query.toString();
  history.replaceState(null, "", `${location.pathname}${queryString ? `?${queryString}` : ""}${location.hash || "#matches"}`);
  launchedFromNotification = openChatFromNotification
    || openSummaryFromNotification
    || (Number.isInteger(notificationMatchday) && notificationMatchday >= 1 && notificationMatchday <= LAST_MATCHDAY)
    || Boolean(notificationPlayerId);
  if (!launchedFromNotification) scheduleNotificationPrimer(300);
}

async function tryApplyNotificationRoute() {
  if (!launchedFromNotification || notificationDeepLinkHandled || notificationRouteApplying) return;
  notificationRouteApplying = true;
  try {
    const validMatchday = Number.isInteger(notificationMatchday) && notificationMatchday >= 1 && notificationMatchday <= LAST_MATCHDAY
      ? notificationMatchday
      : null;

    if (notificationMatchId) {
      if (!firstLivePollSettled || state.authStatus === "loading") return;
      if (state.user && !state.userDataReady) return;
      if (!typerMatchIds.has(notificationMatchId)) {
        discardInvalidNotificationMatchRoute();
      } else {
        const match = state.matches.find((item) => item.id === notificationMatchId);
        if (match) state.matchday = validMatchday || match.matchday;
        setView("matches", { historyMode: "replace", focus: false });
        if (!showMatchCentre(notificationMatchId)) {
          discardInvalidNotificationMatchRoute();
        } else {
          notificationDeepLinkHandled = true;
          clearNotificationRoute("matches");
          return;
        }
      }
    }

    if (openSummaryFromNotification) {
      if (state.authStatus === "loading" || !firstLivePollSettled) return;
      if (!state.user) {
        if (!notificationLoginPromptShown) {
          notificationLoginPromptShown = true;
          openAuthDialog();
          notify("Zaloguj się, aby zobaczyć podsumowanie swoich punktów.");
        }
        return;
      }
      if (!state.userDataReady || !state.participantReady) return;
      const summaryMatchday = validMatchday || state.matchday;
      state.matchday = summaryMatchday;
      setView("matches", { historyMode: "replace", focus: false });
      await openPlayerPicks(state.user.uid, summaryMatchday);
      if (state.playerPicksUid !== state.user.uid) return;
      notificationDeepLinkHandled = true;
      clearNotificationRoute("matches");
      return;
    }

    if (openChatFromNotification) {
      setView("matches", { historyMode: "replace", focus: false });
      toggleChat(true);
      notificationDeepLinkHandled = true;
      clearNotificationRoute("matches");
      return;
    }

    if (notificationPlayerId) {
      if (state.authStatus === "loading") return;
      if (!state.user) {
        if (!notificationLoginPromptShown) {
          notificationLoginPromptShown = true;
          openAuthDialog();
          notify("Zaloguj się, aby zobaczyć profil nowego gracza.");
        }
        return;
      }
      if (!state.userDataReady || !state.participantReady) return;
      setView("ranking", { historyMode: "replace", focus: false });
      await openPlayerPicks(notificationPlayerId, validMatchday || defaultPlayerPicksMatchday());
      if (state.playerPicksUid !== notificationPlayerId) return;
      notificationDeepLinkHandled = true;
      clearNotificationRoute("ranking");
      return;
    }

    if (validMatchday) {
      state.matchday = validMatchday;
      save();
      setView("matches", { historyMode: "replace", focus: false });
      requestAnimationFrame(() => document.querySelector("#mecze")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      notificationDeepLinkHandled = true;
      clearNotificationRoute("matches");
    }
  } finally {
    notificationRouteApplying = false;
  }
}

function openAuthDialog() {
  const dialog = document.querySelector("#authDialog");
  if (!dialog) return;
  setMainMenuOpen(false);
  if (!dialog.open) dialog.showModal();
  document.querySelector("#authButton")?.setAttribute("aria-expanded", "true");
}

function updateAuthButton() {
  const authButton = document.querySelector("#authButton");
  const iconNode = document.createElement("span");
  const labelNode = document.createElement("span");
  const fullLabelNode = document.createElement("span");
  const shortLabelNode = document.createElement("span");
  const chevronNode = document.createElement("span");
  labelNode.className = "auth-button-label";
  fullLabelNode.className = "auth-label-full";
  shortLabelNode.className = "auth-label-short";
  chevronNode.className = "auth-button-chevron";
  chevronNode.setAttribute("aria-hidden", "true");
  if (state.user) {
    const fullName = String(state.user.name || "Gracz").trim() || "Gracz";
    iconNode.className = "avatar";
    iconNode.textContent = fullName.slice(0, 1).toUpperCase();
    const source = avatarSource();
    if (state.avatar.type === "club") iconNode.classList.add("is-club");
    if (source) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = "";
      image.addEventListener("error", () => image.remove(), { once: true });
      iconNode.append(image);
    }
    fullLabelNode.textContent = fullName;
    shortLabelNode.textContent = fullName;
    chevronNode.textContent = "⌄";
    authButton.setAttribute("aria-label", `Konto gracza ${fullName}. Otwórz menu konta`);
    authButton.setAttribute("aria-controls", "accountDialog");
    authButton.title = fullName;
  } else {
    iconNode.className = "user-icon";
    iconNode.textContent = "G";
    fullLabelNode.textContent = state.authBusy ? "Otwieranie Google…" : "Zaloguj przez Google";
    shortLabelNode.textContent = state.authBusy ? "Łączenie…" : "Zaloguj";
    chevronNode.textContent = "→";
    authButton.setAttribute("aria-label", "Zaloguj się przez Google");
    authButton.setAttribute("aria-controls", "authDialog");
    authButton.removeAttribute("title");
  }
  labelNode.append(fullLabelNode, shortLabelNode);
  authButton.replaceChildren(iconNode, labelNode, chevronNode);
  authButton.disabled = Boolean(!state.user && state.authBusy);
  const controlledDialog = document.querySelector(`#${authButton.getAttribute("aria-controls")}`);
  authButton.setAttribute("aria-expanded", String(Boolean(controlledDialog?.open)));

  const mobileSignOut = document.querySelector(".nav-signout");
  if (mobileSignOut) mobileSignOut.hidden = !state.user;
  const mobileAccount = document.querySelector(".nav-account-summary");
  const mobileAccountName = document.querySelector("#mobileAccountName");
  if (mobileAccount) mobileAccount.hidden = !state.user;
  if (mobileAccountName) mobileAccountName.textContent = state.user?.name || "Gracz";
  const adminAllowed = isCurrentUserAdmin();
  const pendingAdminRequests = state.adminRequests.filter((request) => request.status === "pending").length;
  document.querySelectorAll("[data-admin-nav]").forEach((node) => {
    node.hidden = !adminAllowed;
    const badge = node.querySelector("[data-admin-badge]");
    if (badge) {
      badge.textContent = String(pendingAdminRequests);
      badge.hidden = pendingAdminRequests < 1;
    }
  });
  document.querySelectorAll("[data-account-admin]").forEach((node) => {
    node.hidden = !adminAllowed;
  });

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
  setMainMenuOpen(false);
  dialog.querySelector("#accountName").textContent = state.user.name;
  dialog.querySelector("#accountDetails").textContent = `${state.user.googleName || "Konto Google"} · ${state.user.email || "Zalogowano przez Google"}`;
  const avatarHost = dialog.querySelector("#accountAvatar");
  if (avatarHost) {
    avatarHost.innerHTML = playerAvatarButton(state.user.uid, "account-avatar-image");
    avatarHost.querySelector("[data-avatar-image]")?.addEventListener("error", (event) => event.currentTarget.remove(), { once: true });
  }
  dialog.showModal();
  document.querySelector("#authButton")?.setAttribute("aria-expanded", "true");
}

function androidAppPromptState() {
  try {
    const value = JSON.parse(localStorage.getItem(APK_PROMPT_STORAGE_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function rememberAndroidAppPrompt(action) {
  try {
    localStorage.setItem(APK_PROMPT_STORAGE_KEY, JSON.stringify({
      campaign: APK_PROMPT_CAMPAIGN,
      action,
      at: Date.now()
    }));
  } catch {}
}

function isAndroidDevice() {
  const platform = navigator.userAgentData?.platform || "";
  return /^Android$/i.test(platform) || /Android/i.test(navigator.userAgent || "");
}

function runsAsInstalledApp() {
  const source = new URLSearchParams(location.search).get("source");
  return source === "android-app"
    || document.referrer.startsWith("android-app://")
    || window.matchMedia?.("(display-mode: standalone)").matches
    || window.matchMedia?.("(display-mode: fullscreen)").matches
    || navigator.standalone === true;
}

function shouldShowAndroidAppPrompt() {
  if (!isAndroidDevice() || runsAsInstalledApp() || !navigator.onLine) return false;
  if (document.querySelector("dialog[open], #androidAppDialog")) return false;
  const savedPrompt = androidAppPromptState();
  if (!savedPrompt || savedPrompt.campaign !== APK_PROMPT_CAMPAIGN) return true;
  if (savedPrompt.action === "downloaded") return false;
  return savedPrompt.action !== "dismissed"
    || !Number.isFinite(savedPrompt.at)
    || Date.now() - savedPrompt.at >= APK_PROMPT_COOLDOWN_MS;
}

function showAndroidAppPrompt() {
  if (launchedFromNotification || !shouldShowAndroidAppPrompt()) return;
  const dialog = document.createElement("dialog");
  dialog.id = "androidAppDialog";
  dialog.className = "modal android-app-modal";
  dialog.setAttribute("aria-labelledby", "androidAppTitle");
  dialog.setAttribute("aria-describedby", "androidAppDescription");
  dialog.innerHTML = `<button type="button" class="modal-close" data-apk-dismiss aria-label="Zamknij">×</button>
    <div class="android-app-visual" aria-hidden="true"><span>ANDROID</span><img src="./assets/brand/app-icon-192.png?v=14" alt=""></div>
    <p class="eyebrow">APLIKACJA NA ANDROIDA</p>
    <h2 id="androidAppTitle">Typer zawsze pod ręką.</h2>
    <p id="androidAppDescription" class="modal-copy">Zainstaluj Ekstraklapa Typer na telefonie i uruchamiaj go prosto z ekranu głównego.</p>
    <ul class="android-app-benefits">
      <li>te same konto, typy i ranking</li>
      <li>bezpieczne logowanie przez Google</li>
      <li>szybki dostęp bez szukania adresu</li>
    </ul>
    <a class="primary-button android-app-download" data-apk-download href="${APK_DOWNLOAD_URL}" download="Typer-v1.0.2.apk" type="application/vnd.android.package-archive"><span>POBIERZ APK</span><small>v${APK_VERSION} · 4,0 MB</small></a>
    <button type="button" class="android-app-later" data-apk-dismiss>NIE TERAZ</button>
    <small class="android-app-note">Po pobraniu otwórz plik Typer-v1.0.2.apk. Android może poprosić o jednorazową zgodę na instalowanie aplikacji z tej przeglądarki.</small>`;

  const dismiss = () => {
    rememberAndroidAppPrompt("dismissed");
    dialog.close();
  };
  dialog.querySelectorAll("[data-apk-dismiss]").forEach((button) => button.addEventListener("click", dismiss));
  dialog.querySelector("[data-apk-download]")?.addEventListener("click", () => {
    rememberAndroidAppPrompt("downloaded");
    setTimeout(() => dialog.close(), 150);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function chatNotificationsSupported() {
  return location.protocol === "https:"
    && "Notification" in window
    && "serviceWorker" in navigator
    && "PushManager" in window
    && Boolean(window.crypto?.subtle)
    && Boolean(webPushPublicKey)
    && Boolean(notificationApiBase);
}

function chatNotificationState() {
  if (!chatNotificationsSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (state.chatNotificationsBusy) return "busy";
  if (state.chatNotificationsSyncPending) return "pending";
  return state.chatNotificationsEnabled && Notification.permission === "granted" ? "enabled" : "disabled";
}

function webPushKeyBytes(value = webPushPublicKey) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(`${value}${padding}`.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function samePushKey(left, right) {
  if (!left || !right) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

async function readLocalChatPushState() {
  if (!("caches" in window)) return {};
  try {
    const cache = await caches.open(CHAT_PUSH_STATE_CACHE);
    const response = await cache.match(CHAT_PUSH_STATE_URL);
    const value = response ? await response.json() : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function withChatPushStateLock(operation) {
  if (navigator.locks?.request) {
    return navigator.locks.request("ekstraklapa-typer-chat-push-state", { mode: "exclusive" }, operation);
  }
  return operation();
}

async function writeLocalChatPushStateUnlocked(patch) {
  if (!("caches" in window)) throw new Error("Pamięć stanu powiadomień nie jest dostępna.");
  const cache = await caches.open(CHAT_PUSH_STATE_CACHE);
  const previous = await readLocalChatPushState();
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await cache.put(CHAT_PUSH_STATE_URL, new Response(JSON.stringify(next), {
    headers: { "content-type": "application/json; charset=utf-8" }
  }));
  return next;
}

async function writeLocalChatPushState(patch) {
  return withChatPushStateLock(() => writeLocalChatPushStateUnlocked(patch));
}

async function ensureAppServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    throw new Error("Service worker nie jest obsługiwany na tym urządzeniu.");
  }
  if (!serviceWorkerRegistrationPromise) {
    serviceWorkerRegistrationPromise = navigator.serviceWorker.register(`./sw.js?v=${APP_SERVICE_WORKER_VERSION}`, {
      updateViaCache: "none"
    }).then(async (registration) => {
      await registration.update().catch(() => {});
      const candidate = registration.installing || registration.waiting;
      if (candidate && candidate.state !== "activated") {
        await Promise.race([
          new Promise((resolve) => {
            const handleStateChange = () => {
              if (candidate.state === "activated" || candidate.state === "redundant") {
                candidate.removeEventListener("statechange", handleStateChange);
                resolve();
              }
            };
            candidate.addEventListener("statechange", handleStateChange);
            handleStateChange();
          }),
          new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
      }
      const readyRegistration = await bounded(navigator.serviceWorker.ready, 7000);
      if (!readyRegistration?.active) throw new Error("Service worker nie został aktywowany na czas.");
      const activeVersion = new URL(readyRegistration.active.scriptURL).searchParams.get("v");
      if (activeVersion !== APP_SERVICE_WORKER_VERSION) {
        throw new Error("Nowa wersja obsługi powiadomień nie została jeszcze aktywowana. Odśwież aplikację.");
      }
      return readyRegistration;
    }).catch((error) => {
      serviceWorkerRegistrationPromise = null;
      throw error;
    });
  }
  return serviceWorkerRegistrationPromise;
}

async function appPushSubscription(create = false) {
  const registration = await ensureAppServiceWorkerRegistration();
  const expectedKey = webPushKeyBytes();
  let subscription = await registration.pushManager.getSubscription();
  let createdNow = false;
  if (subscription && !samePushKey(subscription.options.applicationServerKey, expectedKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription && create) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: expectedKey
    });
    createdNow = true;
  }
  return { subscription, createdNow };
}

function serializablePushSubscription(subscription) {
  const value = subscription?.toJSON?.();
  if (!value?.endpoint || !value?.keys?.p256dh || !value?.keys?.auth) {
    throw new Error("Przeglądarka nie zwróciła kompletnej subskrypcji Web Push.");
  }
  return {
    endpoint: value.endpoint,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth }
  };
}

async function callPushBackend(name, data) {
  const paths = {
    registerPushSubscription: "/api/push/register",
    unregisterPushSubscription: "/api/push/unregister"
  };
  const path = paths[name];
  if (!path) throw new Error("Nieznana operacja backendu powiadomień.");
  return { data: await notificationApiRequest(path, data) };
}

async function notificationApiRequest(path, data = {}, options = {}) {
  const base = String(notificationApiBase || "").replace(/\/$/, "");
  const currentUser = state.auth?.currentUser;
  if (!base || !currentUser) throw new Error("Backend powiadomień nie jest gotowy.");
  const method = String(options.method || "POST").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error("Nieobsługiwana metoda backendu.");
  const token = await currentUser.getIdToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = { authorization: `Bearer ${token}` };
    if (method !== "GET") headers["content-type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers,
      body: method === "GET" ? undefined : JSON.stringify(data),
      keepalive: options.keepalive === true,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || payload?.message || `Backend powiadomień: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

function reportNotificationSyncError(label, error) {
  if (error?.name === "AbortError") console.warn(`${label}: backend nie odpowiedział na czas.`);
  else console.warn(label, error);
}

function notificationOutboxId(type, uid, data) {
  if (!uid) return "";
  if (type === "player") return `player:${uid}`;
  if (type === "chat" && typeof data?.messageId === "string" && data.messageId) return `chat:${uid}:${data.messageId}`;
  if (type === "pick" && typerMatchIds.has(data?.matchId) && ["1", "X", "2"].includes(data?.pick)) {
    return `pick:${uid}:${data.matchId}`;
  }
  if (type === "name-request" && typeof data?.requestId === "string" && data.requestId) {
    return `name-request:${uid}:${data.requestId}`;
  }
  if (type === "name-changed" && Number.isInteger(data?.nameVersion) && data.nameVersion >= 1) {
    return `name-changed:${uid}:${data.nameVersion}`;
  }
  if (type === "name-decision" && typeof data?.requestId === "string" && data.requestId) {
    return `name-decision:${uid}:${data.requestId}`;
  }
  if (type === "admin-name-edited" && typeof data?.uid === "string" && data.uid && Number.isInteger(data?.nameVersion)) {
    return `admin-name-edited:${uid}:${data.uid}:${data.nameVersion}`;
  }
  return "";
}

function notificationOutboxSignature(type, data) {
  if (type === "player") return "joined";
  if (type === "chat") return String(data?.messageId || "");
  if (type === "pick") return `${data?.matchId || ""}:${data?.pick || ""}`;
  if (["name-request", "name-changed", "name-decision", "admin-name-edited"].includes(type)) {
    return JSON.stringify(data);
  }
  return "";
}

function notificationOutboxTtl(type) {
  if (type === "chat") return NOTIFICATION_OUTBOX_CHAT_TTL_MS;
  if (type === "player") return NOTIFICATION_OUTBOX_PLAYER_TTL_MS;
  if (["name-request", "name-changed", "name-decision", "admin-name-edited"].includes(type)) {
    return NOTIFICATION_OUTBOX_NAME_TTL_MS;
  }
  return NOTIFICATION_OUTBOX_PICK_TTL_MS;
}

function normalizeNotificationOutboxItem(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.uid !== "string") return null;
  const type = ["chat", "player", "pick", "name-request", "name-changed", "name-decision", "admin-name-edited"].includes(value.type) ? value.type : "";
  const data = asRecord(value.data);
  const id = notificationOutboxId(type, value.uid, data);
  const signature = notificationOutboxSignature(type, data);
  if (!id || !signature) return null;
  const createdAt = Number.isFinite(value.createdAt) ? value.createdAt : now;
  const expiresAt = Number.isFinite(value.expiresAt) ? value.expiresAt : createdAt + notificationOutboxTtl(type);
  if (expiresAt <= now) return null;
  return {
    id,
    uid: value.uid,
    type,
    data,
    signature,
    createdAt,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt,
    expiresAt,
    attempts: Math.max(0, Math.min(12, Number(value.attempts) || 0)),
    nextAttemptAt: Math.max(0, Number(value.nextAttemptAt) || 0),
    sentAt: Math.max(0, Number(value.sentAt) || 0)
  };
}

function readNotificationOutbox() {
  const now = Date.now();
  try {
    const stored = JSON.parse(localStorage.getItem(NOTIFICATION_OUTBOX_KEY) || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.map((item) => normalizeNotificationOutboxItem(item, now)).filter(Boolean);
  } catch (error) {
    console.warn("Pominięto uszkodzoną kolejkę powiadomień:", error);
    return [];
  }
}

function writeNotificationOutbox(items) {
  const now = Date.now();
  const normalized = items.map((item) => normalizeNotificationOutboxItem(item, now)).filter(Boolean);
  const pending = normalized.filter((item) => !item.sentAt).sort((a, b) => b.updatedAt - a.updatedAt);
  const receipts = normalized.filter((item) => item.sentAt).sort((a, b) => b.sentAt - a.sentAt);
  try {
    localStorage.setItem(NOTIFICATION_OUTBOX_KEY, JSON.stringify(
      [...pending, ...receipts].slice(0, NOTIFICATION_OUTBOX_MAX_ITEMS)
    ));
  } catch (error) {
    console.warn("Nie udało się zapisać kolejki powiadomień:", error);
  }
}

function clearNotificationOutboxForUser(uid) {
  if (!uid) return;
  writeNotificationOutbox(readNotificationOutbox().filter((item) => item.uid !== uid));
}

function enqueueNotificationOutbox(type, uid, data, options = {}) {
  const id = notificationOutboxId(type, uid, data);
  const signature = notificationOutboxSignature(type, data);
  if (!id || !signature) return false;
  const now = Date.now();
  const items = readNotificationOutbox();
  const previous = items.find((item) => item.id === id);
  if (previous?.signature === signature) {
    if (!previous.sentAt && options.schedule !== false) scheduleNotificationOutboxFlush(500);
    return true;
  }
  const next = items.filter((item) => item.id !== id);
  next.push({
    id,
    uid,
    type,
    data: { ...data },
    signature,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + notificationOutboxTtl(type),
    attempts: 0,
    nextAttemptAt: 0,
    sentAt: 0
  });
  writeNotificationOutbox(next);
  if (options.schedule !== false) scheduleNotificationOutboxFlush(250);
  return true;
}

function updateNotificationOutboxItems(selected, operation) {
  if (!selected.length) return;
  const selectedById = new Map(selected.map((item) => [item.id, item.signature]));
  const next = [];
  readNotificationOutbox().forEach((item) => {
    if (selectedById.get(item.id) !== item.signature) {
      next.push(item);
      return;
    }
    const updated = operation(item);
    if (updated) next.push(updated);
  });
  writeNotificationOutbox(next);
}

function markNotificationOutboxSent(selected) {
  const now = Date.now();
  updateNotificationOutboxItems(selected, (item) => {
    if (item.type === "pick") return null;
    const receiptTtl = ["name-request", "name-changed", "name-decision", "admin-name-edited"].includes(item.type)
      ? NOTIFICATION_OUTBOX_NAME_TTL_MS
      : item.type === "player"
        ? 180 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
    return {
      ...item,
      sentAt: now,
      updatedAt: now,
      nextAttemptAt: 0,
      expiresAt: now + receiptTtl
    };
  });
}

function discardNotificationOutboxItems(selected) {
  updateNotificationOutboxItems(selected, () => null);
}

function retryNotificationOutboxItems(selected, error) {
  const now = Date.now();
  updateNotificationOutboxItems(selected, (item) => {
    const attempts = item.attempts + 1;
    const rateLimited = error?.status === 429;
    const delay = rateLimited
      ? 60_000
      : Math.min(5 * 60_000, 5000 * (2 ** Math.min(attempts - 1, 6)));
    return { ...item, attempts, updatedAt: now, nextAttemptAt: now + delay };
  });
}

function rejectedPicksFromResponse(payload) {
  if (!Array.isArray(payload?.rejected)) return [];
  return payload.rejected.map((entry) => {
    if (typeof entry === "string") return { matchId: entry, retryable: false, reason: "rejected" };
    return {
      matchId: typeof entry?.matchId === "string" ? entry.matchId : "",
      retryable: entry?.retryable === true,
      reason: entry?.reason || entry?.code || "rejected"
    };
  }).filter((entry) => entry.matchId);
}

function enqueueCurrentNotificationPick(uid, entry, options = {}) {
  if (!uid || state.user?.uid !== uid || state.predictions?.[entry?.matchId] !== entry?.pick) return false;
  return enqueueNotificationOutbox("pick", uid, entry, options);
}

function handlePartialPickSync(entries, payload, { outbox = false, uid = state.user?.uid } = {}) {
  const rejected = rejectedPicksFromResponse(payload);
  if (!rejected.length) {
    if (Number.isInteger(payload?.count) && payload.count < entries.length) {
      throw new Error("Backend zwrócił niepełny wynik synchronizacji typów bez listy odrzuceń.");
    }
    if (outbox) markNotificationOutboxSent(entries);
    return;
  }
  const rejectedById = new Map(rejected.map((entry) => [entry.matchId, entry]));
  const accepted = entries.filter((entry) => !rejectedById.has(entry.data?.matchId || entry.matchId));
  const retryable = entries.filter((entry) => rejectedById.get(entry.data?.matchId || entry.matchId)?.retryable);
  const permanent = entries.filter((entry) => {
    const rejection = rejectedById.get(entry.data?.matchId || entry.matchId);
    return rejection && !rejection.retryable;
  });
  if (outbox) {
    markNotificationOutboxSent(accepted);
    discardNotificationOutboxItems(permanent);
    if (retryable.length) retryNotificationOutboxItems(retryable, { status: 503 });
  } else {
    retryable.forEach((entry) => enqueueCurrentNotificationPick(uid, entry, { schedule: false }));
  }
  rejected.forEach((entry) => console.warn(`Backend odrzucił synchronizację typu ${entry.matchId}: ${entry.reason}`));
}

function notificationOutboxPath(item) {
  if (item.type === "chat") return "/api/events/chat-message";
  if (item.type === "player") return "/api/events/player-joined";
  if (item.type === "name-request") return "/api/events/name-change-request";
  if (item.type === "name-changed") return "/api/events/player-name-changed";
  if (item.type === "name-decision") return "/api/events/name-change-decision";
  if (item.type === "admin-name-edited") return "/api/events/admin-name-edited";
  return "/api/picks/sync";
}

function scheduleNotificationOutboxFlush(delay = 1000) {
  if (!state.user?.uid) return;
  const dueAt = Date.now() + Math.max(0, delay);
  if (notificationOutboxRetryTimer && notificationOutboxRetryDueAt <= dueAt) return;
  clearTimeout(notificationOutboxRetryTimer);
  notificationOutboxRetryDueAt = dueAt;
  notificationOutboxRetryTimer = setTimeout(() => {
    notificationOutboxRetryTimer = null;
    notificationOutboxRetryDueAt = 0;
    flushNotificationOutbox(state.user?.uid).catch((error) => reportNotificationSyncError("Nie udało się opróżnić kolejki powiadomień", error));
  }, Math.max(0, dueAt - Date.now()));
}

function pendingNotificationOutboxForUser(uid) {
  const now = Date.now();
  return readNotificationOutbox()
    .filter((item) => item.uid === uid && !item.sentAt)
    .sort((a, b) => {
      const aReady = a.nextAttemptAt <= now ? 0 : 1;
      const bReady = b.nextAttemptAt <= now ? 0 : 1;
      if (aReady !== bReady) return aReady - bReady;
      const typePriority = (item) => item.type === "pick" ? 1 : 0;
      if (typePriority(a) !== typePriority(b)) return typePriority(a) - typePriority(b);
      return a.createdAt - b.createdAt;
    });
}

async function performNotificationOutboxFlush(uid) {
  if (!uid || !navigator.onLine || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
  let requests = 0;
  while (requests < NOTIFICATION_OUTBOX_MAX_REQUESTS) {
    const pending = pendingNotificationOutboxForUser(uid);
    const ready = pending.filter((item) => item.nextAttemptAt <= Date.now());
    if (!ready.length) break;
    const first = ready[0];
    const selected = first.type === "pick"
      ? ready.filter((item) => item.type === "pick" && (!first.attempts ? item.attempts === 0 : item.id === first.id))
        .slice(0, first.attempts ? 1 : NOTIFICATION_OUTBOX_PICK_BATCH_SIZE)
      : [first];
    const path = notificationOutboxPath(first);
    const body = first.type === "pick"
      ? { picks: selected.map((item) => item.data) }
      : first.data;
    requests += 1;
    try {
      const payload = await notificationApiRequest(path, body, { keepalive: true });
      if (first.type === "pick") handlePartialPickSync(selected, payload, { outbox: true });
      else markNotificationOutboxSent(selected);
    } catch (error) {
      const permanent = [400, 404, 409, 410, 422].includes(error?.status);
      if (permanent && (first.type !== "pick" || selected.length === 1)) {
        discardNotificationOutboxItems(selected);
        reportNotificationSyncError("Backend trwale odrzucił element kolejki powiadomień", error);
        continue;
      }
      retryNotificationOutboxItems(selected, error);
      reportNotificationSyncError("Element kolejki powiadomień zostanie ponowiony", error);
      if (!permanent) break;
    }
  }
  const remaining = pendingNotificationOutboxForUser(uid);
  if (!remaining.length) return;
  const earliest = Math.min(...remaining.map((item) => item.nextAttemptAt || Date.now()));
  scheduleNotificationOutboxFlush(Math.max(12_000, earliest - Date.now()));
}

function flushNotificationOutbox(uid = state.user?.uid) {
  const queued = notificationOutboxFlushOperation.catch(() => {}).then(() => performNotificationOutboxFlush(uid));
  notificationOutboxFlushOperation = queued.catch(() => {});
  return queued;
}

async function syncNotificationPicks(picks = state.confirmedPredictions) {
  if (!state.participantReady || !state.user || state.auth?.currentUser?.uid !== state.user.uid) return;
  const uid = state.user.uid;
  const entries = Object.entries(asRecord(picks))
    .filter(([matchId, pick]) => typerMatchIds.has(matchId) && ["1", "X", "2"].includes(pick))
    .map(([matchId, pick]) => ({ matchId, pick }));
  const errors = [];
  for (let index = 0; index < entries.length; index += NOTIFICATION_OUTBOX_PICK_BATCH_SIZE) {
    if (state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
    const chunk = entries.slice(index, index + NOTIFICATION_OUTBOX_PICK_BATCH_SIZE);
    try {
      const payload = await notificationApiRequest("/api/picks/sync", { picks: chunk });
      handlePartialPickSync(chunk, payload, { uid });
    } catch (error) {
      chunk.forEach((entry) => enqueueCurrentNotificationPick(uid, entry, { schedule: false }));
      errors.push(error);
      const isolatedRejection = [400, 404, 409, 410, 422].includes(error?.status);
      if (!isolatedRejection) {
        entries.slice(index + NOTIFICATION_OUTBOX_PICK_BATCH_SIZE)
          .forEach((entry) => enqueueCurrentNotificationPick(uid, entry, { schedule: false }));
        break;
      }
    }
  }
  if (pendingNotificationOutboxForUser(uid).length) scheduleNotificationOutboxFlush(2000);
  if (errors.length) {
    throw new AggregateError(errors, `Nie udało się od razu zsynchronizować ${errors.length} partii typów.`);
  }
}

function queueNotificationPicksSync(picks = state.confirmedPredictions, uid = state.user?.uid) {
  const snapshot = { ...asRecord(picks) };
  const signature = Object.entries(snapshot)
    .filter(([matchId, pick]) => typerMatchIds.has(matchId) && ["1", "X", "2"].includes(pick))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([matchId, pick]) => `${matchId}:${pick}`)
    .join("|");
  const syncKey = `${uid || ""}:${signature}`;
  if (notificationFullPickSyncKey === syncKey) {
    if (notificationFullPickSyncPromise) return notificationFullPickSyncPromise;
    if (Date.now() - notificationFullPickSyncCompletedAt < 5 * 60 * 1000) return Promise.resolve();
  }
  notificationFullPickSyncKey = syncKey;
  const queued = notificationPickSyncOperation.catch(() => {}).then(() => {
    if (!uid || state.user?.uid !== uid || state.auth?.currentUser?.uid !== uid) return;
    return syncNotificationPicks(snapshot);
  });
  notificationPickSyncOperation = queued.catch(() => {});
  notificationFullPickSyncPromise = queued;
  queued.then(() => {
    if (notificationFullPickSyncKey === syncKey) notificationFullPickSyncCompletedAt = Date.now();
  }).finally(() => {
    if (notificationFullPickSyncPromise === queued) notificationFullPickSyncPromise = null;
  }).catch(() => {});
  return queued;
}

function queueNotificationPickSync(matchId, pick, uid = state.user?.uid) {
  if (uid) enqueueNotificationOutbox("pick", uid, { matchId, pick });
  const queued = notificationPickSyncOperation.catch(() => {}).then(() => {
    if (!uid || state.user?.uid !== uid || state.auth?.currentUser?.uid !== uid) return;
    return flushNotificationOutbox(uid);
  });
  notificationPickSyncOperation = queued.catch(() => {});
  return queued;
}

async function announceSeasonParticipant() {
  const uid = state.user?.uid;
  if (!uid || !enqueueNotificationOutbox("player", uid, {})) return;
  await flushNotificationOutbox(uid);
}

async function announceChatMessage(messageId) {
  const uid = state.user?.uid;
  if (!uid || !messageId || !enqueueNotificationOutbox("chat", uid, { messageId })) return;
  await flushNotificationOutbox(uid);
}

function setChatNotificationPreference(uid, enabled) {
  if (!uid) return;
  if (enabled) state.chatNotificationsByUser[uid] = true;
  else delete state.chatNotificationsByUser[uid];
  if (state.user?.uid === uid) state.chatNotificationsEnabled = enabled;
  save();
}

function chatPushSessionIsCurrent(uid, revision) {
  return revision === chatPushSessionRevision
    && !chatPushSessionClosing
    && state.auth?.currentUser?.uid === uid
    && state.user?.uid === uid
    && state.participantReady;
}

function queueChatPushOperation(operation) {
  chatPushPendingOperations += 1;
  state.chatNotificationsBusy = true;
  if (state.view === "settings") render();
  const queued = chatPushOperation.catch(() => {}).then(operation);
  chatPushOperation = queued.catch(() => {});
  return queued.finally(() => {
    chatPushPendingOperations = Math.max(0, chatPushPendingOperations - 1);
    state.chatNotificationsBusy = chatPushPendingOperations > 0;
    if (state.view === "settings") render();
  });
}

async function detachLocalChatPush() {
  let muted = false;
  try {
    await writeLocalChatPushState({
      muted: true,
      endpoint: "",
      rotationToken: "",
      needsSync: false,
      rotationAttempts: 0
    });
    muted = true;
  } catch (error) {
    console.warn("Nie udało się zapisać lokalnego wyciszenia push:", error);
  }

  const registration = "serviceWorker" in navigator
    ? await navigator.serviceWorker.getRegistration()
    : null;
  const subscription = await registration?.pushManager?.getSubscription?.();
  const endpoint = subscription?.endpoint || "";
  let detached = !subscription;
  if (subscription) {
    try {
      detached = await subscription.unsubscribe();
    } catch (error) {
      console.warn("Nie udało się wypisać lokalnej subskrypcji push:", error);
    }
  }
  if (!detached && registration) {
    try {
      detached = await registration.unregister();
      if (detached) serviceWorkerRegistrationPromise = null;
    } catch (error) {
      console.warn("Nie udało się awaryjnie wyrejestrować service workera:", error);
    }
  }
  if (!muted && !detached) {
    throw new Error("Nie udało się bezpiecznie odłączyć powiadomień tego konta.");
  }
  return endpoint;
}

async function bounded(promise, timeoutMs = 5000) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Przekroczono czas operacji push.")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function enableChatPush(uid, options = {}) {
  if (chatPushSessionClosing || state.chatNotificationsBusy || !uid || state.auth?.currentUser?.uid !== uid || !state.participantReady) return false;
  const revision = chatPushSessionRevision;
  return queueChatPushOperation(async () => {
    let subscription = null;
    let createdNow = false;
    let backendRegistered = false;
    try {
      if (!chatPushSessionIsCurrent(uid, revision)) return false;
      ({ subscription, createdNow } = await appPushSubscription(true));
      if (!subscription || !chatPushSessionIsCurrent(uid, revision)) {
        await subscription?.unsubscribe().catch(() => {});
        return false;
      }
      const subscriptionData = serializablePushSubscription(subscription);
      await withChatPushStateLock(async () => {
        if (!chatPushSessionIsCurrent(uid, revision)) throw new Error("Sesja zmieniła się przed rejestracją push.");
        const localState = await readLocalChatPushState();
        const reusableRotationToken = localState.endpoint === subscription.endpoint
          && /^[A-Za-z0-9_-]{43}$/.test(localState.rotationToken || "")
          ? localState.rotationToken
          : "";
        const registrationResult = await callPushBackend("registerPushSubscription", {
          subscription: subscriptionData,
          rotationToken: reusableRotationToken
        });
        backendRegistered = true;
        const rotationToken = typeof registrationResult?.data?.rotationToken === "string"
          ? registrationResult.data.rotationToken
          : "";
        if (!/^[A-Za-z0-9_-]{43}$/.test(rotationToken)) {
          throw new Error("Backend nie zwrócił bezpiecznego tokenu odnowienia push.");
        }
        if (!chatPushSessionIsCurrent(uid, revision)) throw new Error("Sesja zmieniła się podczas rejestracji push.");
        await writeLocalChatPushStateUnlocked({
          muted: false,
          endpoint: subscription.endpoint,
          rotationToken,
          needsSync: false,
          rotationAttempts: 0
        });
      });
      if (!chatPushSessionIsCurrent(uid, revision)) {
        await detachLocalChatPush().catch(() => {});
        if (state.auth?.currentUser?.uid === uid) {
          await callPushBackend("unregisterPushSubscription", { endpoint: subscription.endpoint }).catch(() => {});
        }
        return false;
      }
      setChatNotificationPreference(uid, true);
      state.chatNotificationsSyncPending = false;
      queueNotificationPicksSync(state.confirmedPredictions, uid).catch((error) => reportNotificationSyncError("Nie udało się zsynchronizować typów po włączeniu powiadomień", error));
      if (!options.silent) notify("Powiadomienia Typera są włączone.");
      return true;
    } catch (error) {
      const sessionChanged = !chatPushSessionIsCurrent(uid, revision);
      console.error("Nie udało się włączyć powiadomień Typera:", error);
      if (backendRegistered && subscription && state.auth?.currentUser?.uid === uid) {
        await callPushBackend("unregisterPushSubscription", { endpoint: subscription.endpoint }).catch(() => {});
      }
      if (sessionChanged || createdNow) {
        await subscription?.unsubscribe().catch(() => {});
        if (!sessionChanged) {
          setChatNotificationPreference(uid, false);
          state.chatNotificationsSyncPending = false;
        }
      } else {
        setChatNotificationPreference(uid, true);
        state.chatNotificationsSyncPending = true;
      }
      if (!options.silent && !sessionChanged) notify("Nie udało się połączyć urządzenia z kanałem push.");
      return false;
    }
  });
}

async function disableChatPush(uid, options = {}) {
  chatPushSessionRevision += 1;
  chatPushSessionClosing = true;
  state.chatNotificationsBusy = true;
  state.chatNotificationsSyncPending = false;
  if (!options.preservePreference) setChatNotificationPreference(uid, false);
  let firstEndpoint = "";
  try {
    firstEndpoint = await detachLocalChatPush();
  } catch (error) {
    chatPushSessionClosing = false;
    state.chatNotificationsBusy = chatPushPendingOperations > 0;
    state.chatNotificationsSyncPending = true;
    if (!options.preservePreference) setChatNotificationPreference(uid, true);
    if (state.view === "settings") render();
    console.error("Nie udało się bezpiecznie wyłączyć powiadomień:", error);
    if (!options.silent) notify("Nie udało się bezpiecznie odłączyć powiadomień. Spróbuj ponownie.");
    return false;
  }
  return queueChatPushOperation(async () => {
    let backendError = null;
    const endpoints = new Set([firstEndpoint]);
    endpoints.add(await detachLocalChatPush().catch(() => ""));
    endpoints.delete("");
    if (uid && state.auth?.currentUser?.uid === uid) {
      for (const endpoint of endpoints) {
        try {
          await callPushBackend("unregisterPushSubscription", { endpoint });
        } catch (error) {
          backendError ||= error;
        }
      }
    }
    if (backendError) console.warn("Urządzenie odłączono lokalnie; backend usunie wygasłą subskrypcję:", backendError);
    if (!options.silent) notify("Powiadomienia Typera wyłączone.");
    return true;
  }).finally(() => {
    chatPushSessionClosing = false;
  });
}

async function reconcileChatPush(uid) {
  state.chatNotificationsEnabled = state.chatNotificationsByUser[uid] === true;
  state.chatNotificationsSyncPending = false;
  if (!chatNotificationsSupported()) return;
  if (!state.chatNotificationsEnabled || Notification.permission !== "granted") {
    await disableChatPush(uid, { silent: true, render: false });
    return;
  }
  await enableChatPush(uid, { silent: true });
}

async function retryChatPushIfNeeded() {
  const uid = state.user?.uid;
  if (!uid || !state.participantReady || state.chatNotificationsByUser[uid] !== true
    || !chatNotificationsSupported() || Notification.permission !== "granted"
    || state.chatNotificationsBusy || chatPushSessionClosing) return;
  const localState = await readLocalChatPushState();
  const localStateReady = localState.muted === false
    && typeof localState.endpoint === "string"
    && localState.endpoint.startsWith("https://")
    && /^[A-Za-z0-9_-]{43}$/.test(localState.rotationToken || "");
  if (!state.chatNotificationsSyncPending && localState.needsSync !== true && localStateReady) return;
  await enableChatPush(uid, { silent: true });
}

async function detachChatPushBeforeLogout(uid) {
  chatPushSessionRevision += 1;
  chatPushSessionClosing = true;
  state.chatNotificationsBusy = true;
  state.chatNotificationsSyncPending = false;
  setChatNotificationPreference(uid, false);
  let firstEndpoint = "";
  try {
    firstEndpoint = await detachLocalChatPush();
  } catch (error) {
    chatPushSessionClosing = false;
    state.chatNotificationsBusy = chatPushPendingOperations > 0;
    state.chatNotificationsSyncPending = true;
    setChatNotificationPreference(uid, true);
    throw error;
  }
  const endpoints = new Set([firstEndpoint]);
  await bounded(chatPushOperation, 5000).catch(() => {});
  endpoints.add(await detachLocalChatPush().catch(() => ""));
  endpoints.delete("");
  if (state.auth?.currentUser?.uid === uid) {
    for (const endpoint of endpoints) {
      await bounded(callPushBackend("unregisterPushSubscription", { endpoint }), 5000).catch((error) => {
        console.warn("Subskrypcja push została odłączona lokalnie, ale backend odpowiadał zbyt długo:", error);
      });
    }
  }
}

async function detachChatPushWithoutSession() {
  chatPushSessionRevision += 1;
  chatPushSessionClosing = true;
  state.chatNotificationsEnabled = false;
  state.chatNotificationsSyncPending = false;
  try {
    await detachLocalChatPush();
  } finally {
    chatPushSessionClosing = false;
  }
}

async function toggleChatNotifications() {
  if (chatPushSessionClosing || state.chatNotificationsBusy) return { completed: false, enabled: state.chatNotificationsEnabled };
  if (!chatNotificationsSupported()) {
    notify("To urządzenie nie obsługuje pełnych powiadomień push.");
    return { completed: false, enabled: false };
  }
  if (state.chatNotificationsSyncPending && Notification.permission === "granted") {
    const enabled = await enableChatPush(state.user?.uid);
    return { completed: enabled, enabled };
  }
  if (state.chatNotificationsEnabled && Notification.permission === "granted") {
    const disabled = await disableChatPush(state.user?.uid);
    return { completed: true, enabled: !disabled };
  }
  if (Notification.permission === "denied") {
    notify("Powiadomienia są zablokowane w ustawieniach aplikacji lub przeglądarki.");
    return { completed: true, enabled: false };
  }
  let permission = "denied";
  try {
    permission = await Notification.requestPermission();
  } catch (error) {
    console.warn("Nie udało się poprosić o zgodę na powiadomienia:", error);
    notify("Nie udało się otworzyć zgody na powiadomienia.");
    return { completed: false, enabled: false };
  }
  if (permission !== "granted") {
    setChatNotificationPreference(state.user?.uid, false);
    state.chatNotificationsSyncPending = false;
    render();
    notify("Nie przyznano zgody na powiadomienia.");
    return { completed: true, enabled: false };
  }
  const enabled = await enableChatPush(state.user?.uid);
  return { completed: enabled, enabled };
}

function notificationPrimerStorageKey(uid = state.user?.uid) {
  return uid ? `${NOTIFICATION_PRIMER_KEY}:${uid}` : "";
}

function rememberNotificationPrimer(action) {
  const key = notificationPrimerStorageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ action, at: Date.now() }));
  } catch {}
}

function notificationPrimerRecentlyDismissed() {
  const key = notificationPrimerStorageKey();
  if (!key) return true;
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return ["later", "asked"].includes(value?.action)
      && Number.isFinite(value.at)
      && Date.now() - value.at < NOTIFICATION_PRIMER_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function shouldShowNotificationPrimer() {
  if (launchedFromNotification || !state.user || !state.userDataReady || !state.participantReady) return false;
  if (notificationPrimerBusy || chatPushSessionClosing || state.chatNotificationsBusy) return false;
  if (!chatNotificationsSupported() || Notification.permission === "denied" || state.chatNotificationsEnabled) return false;
  if (notificationPrimerRecentlyDismissed()) return false;
  return !document.querySelector("dialog[open]");
}

function scheduleNotificationPrimer(delay = 1000, retry = false) {
  if (!retry) notificationPrimerRetries = 0;
  clearTimeout(notificationPrimerTimer);
  if (launchedFromNotification || !state.user) return;
  notificationPrimerTimer = setTimeout(() => {
    const dialog = document.querySelector("#notificationPrimerDialog");
    if (!dialog || dialog.open) return;
    if (!shouldShowNotificationPrimer()) {
      if (state.user && state.userDataReady && state.participantReady && !notificationPrimerRecentlyDismissed()
        && globalThis.Notification?.permission !== "denied"
        && (document.querySelector("dialog[open]") || chatPushSessionClosing || state.chatNotificationsBusy)) {
        notificationPrimerRetries += 1;
        if (notificationPrimerRetries < 20) scheduleNotificationPrimer(1500, true);
      }
      return;
    }
    dialog.showModal();
  }, delay);
}

function dismissNotificationPrimer() {
  if (notificationPrimerBusy || state.chatNotificationsBusy) return;
  rememberNotificationPrimer("later");
  document.querySelector("#notificationPrimerDialog")?.close();
}

async function enableNotificationsFromPrimer() {
  const dialog = document.querySelector("#notificationPrimerDialog");
  if (!dialog?.open || notificationPrimerBusy || chatPushSessionClosing || state.chatNotificationsBusy || !chatNotificationsSupported()) return;
  notificationPrimerBusy = true;
  const controls = [...dialog.querySelectorAll("button")];
  controls.forEach((button) => { button.disabled = true; });
  dialog.setAttribute("aria-busy", "true");
  try {
    const result = await toggleChatNotifications();
    if (!result?.completed) return;
    rememberNotificationPrimer("asked");
    dialog.close();
  } finally {
    notificationPrimerBusy = false;
    dialog.removeAttribute("aria-busy");
    controls.forEach((button) => { button.disabled = false; });
  }
}

function defaultPlayerPicksMatchday() {
  const liveMatch = state.matches.find((match) => typerMatchIds.has(match.id) && LIVE.has(match.status));
  if (liveMatch) return liveMatch.matchday;
  const latestStarted = state.matches
    .filter((match) => typerMatchIds.has(match.id) && match.kickoffConfirmed && isLocked(match))
    .sort((a, b) => new Date(b.kickoffAt) - new Date(a.kickoffAt))[0];
  return latestStarted?.matchday || (state.matchday >= 1 && state.matchday <= LAST_MATCHDAY ? state.matchday : 1);
}

function mountPlayerPicksDialog() {
  let dialog = document.querySelector("#playerPicksDialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "playerPicksDialog";
  dialog.className = "modal player-picks-modal";
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    playerPicksLoadId += 1;
    state.playerPicksUid = null;
    state.playerPicksStatus = "idle";
  });
  document.body.appendChild(dialog);
  return dialog;
}

function playerPicksCacheKey(uid, matchday) {
  return `${uid}:${matchday}`;
}

function playerPickDisplay(uid, match) {
  const ownProfile = uid === state.user?.uid;
  if (ownProfile) return { status: "ready", pick: state.predictions[match.id] || null };
  if (!match.kickoffConfirmed || !isLocked(match)) return { status: "hidden", pick: null };
  const cached = state.playerPicksCache[playerPicksCacheKey(uid, match.matchday)] || {};
  return cached[match.id] || { status: state.playerPicksStatus === "loading" ? "loading" : "unavailable", pick: null };
}

function playerPickRowHtml(uid, match) {
  const home = teamById[match.home];
  const away = teamById[match.away];
  const display = playerPickDisplay(uid, match);
  const result = resultOf(match);
  const hit = display.pick && result ? display.pick === result : null;
  const score = Number.isFinite(match.homeScore) && (LIVE.has(match.status) || FINAL.has(match.status))
    ? `${match.homeScore}:${match.awayScore}`
    : "–:–";
  const pickMarkup = display.status === "hidden"
    ? `<span class="player-pick-lock">${icon("lock")}</span><small>Typ ukryty do pierwszego gwizdka</small>`
    : display.status === "loading"
      ? `<span class="player-pick-loader" aria-hidden="true"></span><small>Sprawdzamy typ…</small>`
      : display.status === "unavailable"
        ? `<span class="player-pick-none">!</span><small>Chwilowo niedostępny</small>`
        : display.pick
          ? `<span class="player-pick-value">${display.pick}</span><small>${hit === true ? "Trafiony · 1 pkt" : hit === false ? "Nietrafiony · 0 pkt" : "Oddany typ"}</small>`
          : `<span class="player-pick-none">—</span><small>Brak typu</small>`;
  return `<article class="player-pick-row${hit === true ? " is-hit" : hit === false ? " is-miss" : ""}">
    <div class="player-pick-match-meta"><span>${formatDay(match)} · ${formatTime(match)}</span><b>${score}</b></div>
    <div class="player-pick-teams">
      <a href="${teamRouteHref(home.id)}" data-team-route="${home.id}"><img src="${home.crest}" alt=""><span class="player-pick-team-name">${escapeHtml(home.name)}</span></a>
      <i>VS</i>
      <a href="${teamRouteHref(away.id)}" data-team-route="${away.id}"><img src="${away.crest}" alt=""><span class="player-pick-team-name">${escapeHtml(away.name)}</span></a>
    </div>
    <div class="player-pick-result ${display.status}">${pickMarkup}</div>
  </article>`;
}

function renderPlayerPicksDialog() {
  const dialog = mountPlayerPicksDialog();
  const uid = state.playerPicksUid;
  if (!uid) return;
  const focusedMatchday = dialog.contains(document.activeElement)
    ? document.activeElement?.dataset?.playerMatchday || null
    : null;
  const roundScrollPositions = [...dialog.querySelectorAll(".player-round-group > div")]
    .map((group) => group.scrollLeft);
  const listScrollPosition = dialog.querySelector(".player-picks-list")?.scrollTop || 0;
  const profile = profileForUid(uid);
  const matchday = state.playerPicksMatchday;
  const roundMatches = state.matches
    .filter((match) => match.matchday === matchday)
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
  const displays = roundMatches.map((match) => ({ match, ...playerPickDisplay(uid, match) }));
  const visiblePicks = displays.filter((item) => item.pick);
  const points = visiblePicks.reduce((total, item) => total + (resultOf(item.match) === item.pick ? 1 : 0), 0);
  const ownProfile = uid === state.user?.uid;
  const roundTabs = (start, end, label) => `<div class="player-round-group"><span>${label}</span><div>${Array.from({ length: end - start + 1 }, (_, index) => index + start).map((round) => `<button type="button" data-player-matchday="${round}" class="${round === matchday ? "active" : ""}" aria-pressed="${round === matchday}" aria-label="Kolejka ${round}">${round}</button>`).join("")}</div></div>`;
  dialog.innerHTML = `<button class="modal-close" data-close aria-label="Zamknij">×</button>
    <header class="player-picks-head">
      ${avatarVisualMarkup("player-picks-avatar", `Avatar ${profile.name}`, profile.avatar, profile)}
      <div><p class="eyebrow">TYPY GRACZA</p><h2>${escapeHtml(profile.name)}</h2><span>${ownProfile ? "Twój profil typowania" : "Typy odkrywają się po rozpoczęciu meczu"}</span></div>
    </header>
    <nav class="player-round-tabs" aria-label="Kolejki rundy jesiennej">${roundTabs(1, LAST_MATCHDAY, "Runda jesienna")}</nav>
    <div class="player-picks-summary"><div><span>Kolejka</span><strong>${matchday}</strong></div><div><span>Widoczne typy</span><strong>${visiblePicks.length}/${roundMatches.length}</strong></div><div><span>Punkty</span><strong>${points}</strong></div></div>
    <div class="player-picks-list" aria-live="polite">${roundMatches.length ? roundMatches.map((match) => playerPickRowHtml(uid, match)).join("") : `<div class="player-picks-empty">Brak meczów w tej kolejce.</div>`}</div>
    ${!ownProfile ? `<p class="player-picks-privacy">Przed pierwszym gwizdkiem cudzy typ pozostaje ukryty także bezpośrednio w bazie danych.</p>` : ""}`;
  dialog.querySelectorAll("[data-avatar-image]").forEach((image) => image.addEventListener("error", () => image.remove(), { once: true }));
  dialog.querySelectorAll(".player-round-group > div").forEach((group, index) => {
    const savedScrollPosition = roundScrollPositions[index];
    group.scrollLeft = Number.isFinite(savedScrollPosition) ? savedScrollPosition : 0;
    const activeButton = group.querySelector("button.active");
    if (!activeButton) return;
    requestAnimationFrame(() => {
      const activeLeft = activeButton.offsetLeft;
      const activeRight = activeLeft + activeButton.offsetWidth;
      const visibleLeft = group.scrollLeft;
      const visibleRight = visibleLeft + group.clientWidth;
      if (activeLeft >= visibleLeft && activeRight <= visibleRight) return;
      group.scrollTo({
        left: Math.max(0, activeLeft - ((group.clientWidth - activeButton.offsetWidth) / 2)),
        behavior: "auto",
      });
    });
  });
  const list = dialog.querySelector(".player-picks-list");
  if (list) list.scrollTop = listScrollPosition;
  if (focusedMatchday) {
    requestAnimationFrame(() => {
      const button = dialog.querySelector(`[data-player-matchday="${focusedMatchday}"]`);
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
}

async function ensurePlayerPicksProfile(uid) {
  if (!uid || uid === state.user?.uid || state.chatProfiles[uid] || !state.db || !state.firebaseModules) return;
  try {
    const { doc, getDoc } = state.firebaseModules;
    const snapshot = await getDoc(doc(state.db, "profiles", uid));
    state.chatProfiles[uid] = snapshot.exists() ? normalizePublicProfile(uid, snapshot.data()) : normalizePublicProfile(uid);
    if (state.playerPicksUid === uid) renderPlayerPicksDialog();
  } catch (error) {
    console.error("Nie udało się pobrać profilu gracza:", error);
  }
}

async function loadPlayerPicksMatchday(matchday) {
  const uid = state.playerPicksUid;
  if (!uid || !Number.isInteger(matchday) || matchday < 1 || matchday > LAST_MATCHDAY) return;
  state.playerPicksMatchday = matchday;
  const loadId = ++playerPicksLoadId;
  if (uid === state.user?.uid) {
    state.playerPicksStatus = "ready";
    renderPlayerPicksDialog();
    return;
  }

  const cacheKey = playerPicksCacheKey(uid, matchday);
  const cached = state.playerPicksCache[cacheKey] || {};
  const readableMatches = state.matches.filter((match) => match.matchday === matchday && match.kickoffConfirmed && isLocked(match));
  const missing = readableMatches.filter((match) => !Object.hasOwn(cached, match.id));
  state.playerPicksStatus = missing.length ? "loading" : "ready";
  renderPlayerPicksDialog();
  if (!missing.length) return;

  const { doc, getDocFromServer } = state.firebaseModules;
  const results = await Promise.all(missing.map(async (match) => {
    try {
      if (typeof getDocFromServer !== "function") throw new Error("Brak bezpiecznego odczytu bezpośrednio z serwera.");
      const snapshot = await getDocFromServer(doc(state.db, "seasons", SEASON_ID, "players", uid, "picks", match.id));
      const data = snapshot.exists() ? snapshot.data() : null;
      const pick = ["1", "X", "2"].includes(data?.pick) ? data.pick : null;
      return [match.id, { status: "ready", pick }];
    } catch (error) {
      console.error(`Nie udało się pobrać typu ${uid}/${match.id}:`, error);
      return [match.id, { status: "unavailable", pick: null }];
    }
  }));
  if (loadId !== playerPicksLoadId || state.playerPicksUid !== uid || state.playerPicksMatchday !== matchday) return;
  state.playerPicksCache[cacheKey] = { ...cached, ...Object.fromEntries(results) };
  state.playerPicksStatus = "ready";
  renderPlayerPicksDialog();
}

async function openPlayerPicks(uid, requestedMatchday = defaultPlayerPicksMatchday()) {
  if (!uid) return;
  if (!state.user || state.auth?.currentUser?.uid !== state.user.uid) {
    openAuthDialog();
    notify("Zaloguj się przez Google, aby zobaczyć typy graczy.");
    return;
  }
  if (!state.participantReady) {
    const sessionUid = state.user.uid;
    const activated = await activateSeasonParticipant(sessionUid, { notifyOnError: true });
    if (!activated) return;
    if (state.auth?.currentUser?.uid !== sessionUid || state.user?.uid !== sessionUid) return;
  }
  state.playerPicksUid = uid;
  state.playerPicksMatchday = Number.isInteger(requestedMatchday) && requestedMatchday >= 1 && requestedMatchday <= LAST_MATCHDAY
    ? requestedMatchday
    : defaultPlayerPicksMatchday();
  document.querySelector("#accountDialog")?.close();
  if (state.chatOpen) toggleChat(false);
  const dialog = mountPlayerPicksDialog();
  renderPlayerPicksDialog();
  if (!dialog.open) dialog.showModal();
  ensurePlayerPicksProfile(uid);
  loadPlayerPicksMatchday(state.playerPicksMatchday);
}

function updateCountdowns() {
  document.querySelectorAll("[data-countdown]").forEach((node) => {
    const delta = new Date(node.dataset.countdown) - new Date();
    if (delta <= 0) return node.textContent = "Mecz rozpoczęty";
    const days = Math.floor(delta / 86400000); const hours = Math.floor(delta % 86400000 / 3600000);
    node.textContent = days ? `Start za ${days} dni i ${hours} godz.` : `Start za ${hours} godz.`;
  });
}

async function enqueueAndFlushNameEvent(type, data, uid = state.user?.uid) {
  if (!uid) return;
  const queued = enqueueNotificationOutbox(type, uid, data, { schedule: false });
  if (!queued) {
    console.warn(`Nie udało się dodać zdarzenia ${type} do kolejki.`);
    return;
  }
  try {
    await flushNotificationOutbox(uid);
  } catch (error) {
    reportNotificationSyncError(`Zdarzenie ${type} pozostaje w kolejce do ponowienia`, error);
  }
}

async function saveDisplayName(event) {
  event.preventDefault();
  if (!state.user || state.auth?.currentUser?.uid !== state.user.uid || !state.db || !state.firebaseModules) {
    openAuthDialog();
    return;
  }
  if (state.nameBusy || state.avatarBusy) return;

  const input = event.currentTarget.querySelector("#displayNameInput");
  const nextName = normalizeDisplayName(input?.value);
  if (!validDisplayName(nextName)) {
    notify(`Nazwa musi mieć od 1 do ${MAX_DISPLAY_NAME_LENGTH} znaków.`);
    input?.focus();
    return;
  }
  if (nextName === state.user.name) {
    if (input) input.value = nextName;
    notify("To już jest Twoja aktualna nazwa.");
    return;
  }

  const uid = state.user.uid;
  state.nameBusy = true;
  render();
  try {
    const result = await saveRemoteDisplayName(uid, nextName);
    if (state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
    if (result.kind === "changed") {
      state.user.name = result.displayName;
      state.profileNamePolicy = {
        selfRenameUsed: true,
        pendingNameRequestId: "",
        nameVersion: result.nameVersion
      };
      state.nameRequest = null;
      state.nameRequestStatus = "ready";
      state.chatProfiles[uid] = normalizePublicProfile(uid, {
        displayName: result.displayName,
        avatarType: state.avatar.type,
        avatarValue: state.avatar.value
      });
      await enqueueAndFlushNameEvent("name-changed", { nameVersion: result.nameVersion }, uid);
      notify("Nick został zmieniony. Bezpłatna zmiana została wykorzystana.");
    } else {
      state.profileNamePolicy = {
        ...state.profileNamePolicy,
        selfRenameUsed: true,
        pendingNameRequestId: result.requestId
      };
      state.nameRequest = {
        id: result.requestId,
        uid,
        currentName: result.currentName,
        requestedName: result.requestedName,
        status: "pending",
        createdAt: Date.now(),
        resolvedAt: null,
        resolvedBy: "",
        adminNote: ""
      };
      state.nameRequestStatus = "ready";
      await enqueueAndFlushNameEvent("name-request", { requestId: result.requestId }, uid);
      notify("Wniosek o zmianę nicku został wysłany do administratora.");
    }
  } catch (error) {
    console.error("Nie udało się zapisać nazwy gracza:", error);
    const message = error?.code === "name-request/pending"
      ? "Masz już oczekujący wniosek o zmianę nicku."
      : error?.code === "name-change/profile-missing"
        ? "Profil jest jeszcze synchronizowany. Spróbuj ponownie za chwilę."
        : error?.code === "name-change/leaderboard-missing"
          ? "Konto nie jest jeszcze gotowe w rankingu. Spróbuj ponownie za chwilę."
          : "Nie udało się zapisać zmiany. Spróbuj ponownie.";
    notify(message);
  } finally {
    if (state.auth?.currentUser?.uid === uid && state.user?.uid === uid) {
      state.nameBusy = false;
      render();
    }
  }
}

async function selectAvatar(type, value) {
  if (!state.user || state.auth?.currentUser?.uid !== state.user.uid) {
    openAuthDialog();
    return;
  }
  if (state.avatarBusy || state.nameBusy) return;

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
  if (!file || state.avatarBusy || state.nameBusy || !state.user) return;
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
    createdAt: data.createdAt || null,
    pending: Boolean(item.metadata?.hasPendingWrites)
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

function chatReadersForMessage(message) {
  if (!state.user || message.uid !== state.user.uid) return [];
  const messageMs = firestoreTimeMs(message.createdAt);
  if (!messageMs) return [];
  return Object.values(state.chatReaders)
    .filter((reader) => reader?.uid
      && reader.uid !== state.user.uid
      && (reader.lastReadMs > messageMs
        || (reader.lastReadMs === messageMs && reader.lastReadMessageId.localeCompare(message.id) >= 0)))
    .sort((a, b) => profileForUid(a.uid).name.localeCompare(profileForUid(b.uid).name, "pl"));
}

function chatReadReceiptHtml(message) {
  if (!state.user || message.uid !== state.user.uid) return "";
  if (message.pending) return `<div class="chat-read-receipt is-sent" aria-label="Wiadomość jest wysyłana"><span class="chat-read-check" aria-hidden="true">…</span><span>Wysyłanie</span></div>`;
  const readers = chatReadersForMessage(message);
  if (!readers.length) return `<div class="chat-read-receipt is-sent" aria-label="Wiadomość wysłana, jeszcze bez potwierdzenia odczytu"><span class="chat-read-check" aria-hidden="true">✓</span><span>Wysłano</span></div>`;
  const names = readers.map((reader) => profileForUid(reader.uid).name);
  return `<details class="chat-read-receipt">
    <summary aria-label="Liczba osób, które odczytały: ${readers.length}. Pokaż listę">
      <span class="chat-read-check" aria-hidden="true">✓✓</span>
      <span>Odczytano: ${readers.length}</span>
      <span class="chat-read-avatars" aria-hidden="true">${readers.slice(0, 3).map((reader) => avatarForUid(reader.uid, "chat-read-avatar")).join("")}${readers.length > 3 ? `<b>+${readers.length - 3}</b>` : ""}</span>
    </summary>
    <span class="chat-read-names">${escapeHtml(names.join(", "))}</span>
  </details>`;
}

function chatMessageHtml(message) {
  const profile = profileForUid(message.uid);
  const mine = state.user?.uid === message.uid;
  const replyMessage = message.replyToId ? chatMessageById(message.replyToId) : null;
  const reply = replyMessage ? chatReplySummary(replyMessage) : message.replyToId ? { id: message.replyToId, name: "Wcześniejsza wiadomość", text: "Pokaż kontekst", image: false } : null;
  const text = escapeHtml(message.text).replaceAll("\n", "<br>");
  return `<article class="chat-msg${mine ? " mine" : ""}" data-chat-message="${escapeHtml(message.id)}">
    ${playerAvatarButton(message.uid)}
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
      ${chatReadReceiptHtml(message)}
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

  host.querySelector("[data-chat-login]")?.addEventListener("click", openAuthDialog);
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
    }).then((reference) => ({ status: "saved", messageId: reference.id }), (error) => ({ status: "failed", error }));
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
    if (result.status === "saved") {
      announceChatMessage(result.messageId).catch((error) => reportNotificationSyncError("Nie udało się rozesłać powiadomienia z chatu", error));
    }
    if (result.status === "pending") {
      notify("Wiadomość czeka na połączenie z internetem");
      writeResult.then((lateResult) => {
        if (lateResult.status === "failed" && state.auth?.currentUser?.uid === uid) {
          console.error("Opóźniona wysyłka wiadomości nie powiodła się:", lateResult.error);
          notify("Nie udało się zsynchronizować wiadomości");
        }
        if (lateResult.status === "saved" && state.auth?.currentUser?.uid === uid) {
          announceChatMessage(lateResult.messageId).catch((error) => reportNotificationSyncError("Nie udało się rozesłać opóźnionego powiadomienia z chatu", error));
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
    if (event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 120) markChatRead();
  });
  widget.querySelector(".chat-messages")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-chat-login]")) {
      openAuthDialog();
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
  if (document.visibilityState !== "visible" || !state.chatOpen || !canUseChat() || !state.chat.length) return;
  const list = document.querySelector("#chat-widget .chat-messages");
  if (list && list.scrollHeight - list.scrollTop - list.clientHeight > 120) return;
  const latestMessageMs = Math.max(...state.chat.map((message) => firestoreTimeMs(message.createdAt)));
  if (!latestMessageMs) return;
  state.chatLastReadMs = Math.max(state.chatLastReadMs, latestMessageMs);
  const latestByAuthor = new Map();
  state.chat.forEach((message) => {
    const messageMs = firestoreTimeMs(message.createdAt);
    if (!messageMs || message.uid === state.user.uid) return;
    const previous = latestByAuthor.get(message.uid);
    if (!previous || compareChatMessages(previous, message) < 0) latestByAuthor.set(message.uid, message);
  });
  const pendingAuthorReads = [...latestByAuthor.entries()].filter(([authorUid, message]) => (
    firestoreTimeMs(message.createdAt) > (state.chatAuthorReadMs[authorUid] || 0)
  ));
  const shouldSaveOwnCursor = latestMessageMs > state.chatRemoteReadMs;
  if ((!shouldSaveOwnCursor && !pendingAuthorReads.length) || state.chatReadSaving || Date.now() < state.chatReadRetryAt) return;
  if ("onLine" in navigator && !navigator.onLine) return;
  const uid = state.user.uid;
  const { doc, serverTimestamp, setDoc, writeBatch } = state.firebaseModules;
  state.chatReadSaving = true;
  const writes = [];
  if (shouldSaveOwnCursor) {
    writes.push(setDoc(doc(state.db, "chatReads", uid), {
      uid,
      lastReadAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }));
  }
  for (let index = 0; index < pendingAuthorReads.length; index += 8) {
    const batch = writeBatch(state.db);
    pendingAuthorReads.slice(index, index + 8).forEach(([authorUid, message]) => {
      batch.set(doc(state.db, "chatReads", authorUid, "readers", uid), {
        authorUid,
        readerUid: uid,
        lastReadMessageId: message.id,
        lastReadAt: message.createdAt,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });
    writes.push(batch.commit());
  }
  const writeResult = Promise.all(writes).then(() => ({ status: "saved" }), (error) => ({ status: "failed", error }));
  Promise.race([
    writeResult,
    new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 6500))
  ]).then((result) => {
    if (state.auth?.currentUser?.uid !== uid) return;
    state.chatReadSaving = false;
    if (result.status === "saved") {
      state.chatRemoteReadMs = Math.max(state.chatRemoteReadMs, latestMessageMs);
      pendingAuthorReads.forEach(([authorUid, message]) => {
        state.chatAuthorReadMs[authorUid] = Math.max(state.chatAuthorReadMs[authorUid] || 0, firestoreTimeMs(message.createdAt));
      });
      state.chatReadRetryAt = 0;
    }
    else {
      state.chatReadRetryAt = Date.now() + 15000;
      if (result.status === "failed") console.error("Nie udało się zapisać odczytu chatu:", result.error);
    }
    setTimeout(markChatRead, 0);
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
  state.chatReaders = {};
  state.chatAuthorReadMs = {};
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

  chatUnsubscribes.push(onSnapshot(collection(state.db, "chatReads", uid, "readers"), (snapshot) => {
    const readers = {};
    snapshot.forEach((item) => {
      const data = item.data({ serverTimestamps: "estimate" });
      const readerUid = typeof data.readerUid === "string" ? data.readerUid : item.id;
      const lastReadMs = firestoreTimeMs(data.lastReadAt);
      if (!readerUid || readerUid === uid || !lastReadMs) return;
      readers[readerUid] = {
        uid: readerUid,
        lastReadMessageId: typeof data.lastReadMessageId === "string" ? data.lastReadMessageId : "",
        lastReadMs
      };
      ensureChatProfile(readerUid);
    });
    state.chatReaders = readers;
    updateChatWidget({ keepScroll: true });
  }, (error) => console.error("Lista odczytów wiadomości jest niedostępna:", error)));
}

function subscribeSeasonStats() {
  seasonStatsUnsubscribe?.();
  const { doc, onSnapshot } = state.firebaseModules;
  seasonStatsUnsubscribe = onSnapshot(doc(state.db, "seasonStats", SEASON_ID), (snapshot) => {
    const count = snapshot.exists() ? snapshot.data().participantCount : 0;
    state.participantCount = Number.isInteger(count) && count >= 0 ? count : 0;
    state.participantCountStatus = "ready";
    if (state.view === "rules") render();
    if (state.view === "ranking" && state.user && state.participantReady) void loadRankingData();
    if (state.view === "matches" && state.user && state.userDataReady && state.participantReady) {
      void loadPlayerDashboardData({ refreshRanking: true });
    }
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
  const leaderboardReference = doc(state.db, "seasons", SEASON_ID, "leaderboard", uid);
  const avatar = normalizeAvatar(state.avatar) || { ...DEFAULT_AVATAR };
  const displayName = normalizeDisplayName(state.user?.name) || "Gracz";
  await runTransaction(state.db, async (transaction) => {
    const [participantSnapshot, leaderboardSnapshot] = await Promise.all([
      transaction.get(participantReference),
      transaction.get(leaderboardReference)
    ]);
    if (participantSnapshot.exists() && leaderboardSnapshot.exists()) return;

    const joinedAt = participantSnapshot.exists() ? participantSnapshot.data().joinedAt : serverTimestamp();
    if (!participantSnapshot.exists()) {
      const statsSnapshot = await transaction.get(statsReference);
      const currentCount = statsSnapshot.exists() && Number.isInteger(statsSnapshot.data().participantCount)
        ? statsSnapshot.data().participantCount
        : 0;
      transaction.set(participantReference, { uid, seasonId: SEASON_ID, joinedAt });
      transaction.set(statsReference, {
        seasonId: SEASON_ID,
        participantCount: currentCount + 1,
        updatedAt: serverTimestamp()
      });
    }
    if (!leaderboardSnapshot.exists()) {
      transaction.set(leaderboardReference, {
        uid,
        displayName,
        avatarType: avatar.type,
        avatarValue: avatar.value,
        points: 0,
        typed: 0,
        joinedAt,
        lastScoreMatchId: "",
        settledMatchIds: [],
        updatedAt: serverTimestamp()
      });
    }
  });
}

async function reconcileOwnLeaderboard(uid) {
  if (!uid || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid || !state.participantReady) return;
  const { arrayUnion, doc, getDoc, runTransaction, serverTimestamp } = state.firebaseModules;
  const leaderboardReference = doc(state.db, "seasons", SEASON_ID, "leaderboard", uid);
  const leaderboardSummary = await getDoc(leaderboardReference);
  if (!leaderboardSummary.exists()) return;
  const settledMatchIds = new Set(Array.isArray(leaderboardSummary.data().settledMatchIds)
    ? leaderboardSummary.data().settledMatchIds.filter((matchId) => typeof matchId === "string")
    : []);
  const settledPicks = state.matches
    .filter((match) => typerMatchIds.has(match.id)
      && !settledMatchIds.has(match.id)
      && resultOf(match)
      && ["1", "X", "2"].includes(state.predictions[match.id]))
    .sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
  if (!settledPicks.length) return;

  for (const match of settledPicks) {
    if (state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
    const scoreReference = doc(state.db, "seasons", SEASON_ID, "players", uid, "scores", match.id);
    try {
      await runTransaction(state.db, async (transaction) => {
        const [scoreSnapshot, leaderboardSnapshot] = await Promise.all([
          transaction.get(scoreReference),
          transaction.get(leaderboardReference)
        ]);
        if (scoreSnapshot.exists()) return;
        if (!leaderboardSnapshot.exists()) throw new Error("Brak wpisu gracza w rankingu.");
        const leaderboard = leaderboardSnapshot.data();
        const pick = state.predictions[match.id];
        const points = pick === resultOf(match) ? 1 : 0;
        transaction.set(scoreReference, {
          uid,
          matchId: match.id,
          pick,
          points,
          settledAt: serverTimestamp()
        });
        transaction.update(leaderboardReference, {
          points: (Number.isInteger(leaderboard.points) ? leaderboard.points : 0) + points,
          typed: (Number.isInteger(leaderboard.typed) ? leaderboard.typed : 0) + 1,
          lastScoreMatchId: match.id,
          settledMatchIds: arrayUnion(match.id),
          updatedAt: serverTimestamp()
        });
      });
      settledMatchIds.add(match.id);
    } catch (error) {
      console.warn("Nie udało się jeszcze rozliczyć typu w rankingu:", match.id, error);
    }
  }
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
    if (state.view === "ranking") void loadRankingData();
    if (state.view === "matches" && state.userDataReady) void loadPlayerDashboardData();
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
  stopOwnProfileRealtime();
  const previousUid = state.user?.uid || null;
  state.userDataReady = false;
  if (previousUid && (!user || previousUid !== user.uid)) {
    resetAdminClientState();
    await detachChatPushWithoutSession();
    state.predictions = {};
    state.confirmedPredictions = {};
    state.playerPicksCache = {};
    predictionWriteQueues.clear();
    predictionWriteVersions.clear();
    location.reload();
    return;
  }
  if (!user) {
    await detachChatPushWithoutSession();
    document.querySelector("#playerPicksDialog")?.close();
    state.playerPicksUid = null;
    state.playerPicksCache = {};
    state.confirmedPredictions = {};
    predictionWriteQueues.clear();
    predictionWriteVersions.clear();
  }
  state.authStatus = "ready";
  state.avatarOperationId += 1;
  state.avatarBusy = false;
  state.avatarPending = false;
  state.nameBusy = false;
  state.profileNamePolicy = { selfRenameUsed: false, pendingNameRequestId: "", nameVersion: 0 };
  state.nameRequest = null;
  state.nameRequestStatus = "idle";
  state.nameRequestError = "";
  state.participantReady = false;
  state.participantActivationBusy = false;
  state.participantActivationError = false;
  state.rankingPlayers = [];
  state.rankingStatus = "idle";
  state.rankingError = "";
  state.playerForm = [];
  state.playerFormStatus = "idle";
  state.playerFormError = "";
  rankingLoadRevision += 1;
  rankingLoadPromise = null;
  rankingReloadPending = false;
  playerFormLoadRevision += 1;
  playerFormLoadPromise = null;
  stopChatRealtime();
  if (user && !isGoogleAccount(user)) {
    resetAdminClientState();
    await detachChatPushWithoutSession();
    state.user = null;
    state.predictions = {};
    state.confirmedPredictions = {};
    state.userDataReady = false;
    state.avatar = { ...DEFAULT_AVATAR };
    render();
    notify("Ta liga obsługuje wyłącznie prawdziwe konta Google");
    if (state.auth?.currentUser?.uid === user.uid && state.firebaseModules?.signOut) {
      state.firebaseModules.signOut(state.auth).catch((error) => console.error("Nie udało się odrzucić nieobsługiwanej sesji:", error));
    }
    return;
  }
  if (!user) {
    resetAdminClientState();
    state.user = null;
    state.predictions = {};
    state.confirmedPredictions = {};
    state.userDataReady = false;
    state.avatar = { ...DEFAULT_AVATAR };
    save();
    render();
    tryApplyNotificationRoute().catch((error) => console.warn("Nie udało się otworzyć widoku z powiadomienia:", error));
    return;
  }

  const cachedAvatar = normalizeAvatar(state.avatarsByUser[user.uid]) || { ...DEFAULT_AVATAR };
  const googleName = googleFullName(user);
  state.user = {
    uid: user.uid,
    name: googleAccountName(user),
    googleName,
    email: user.email || "",
    photoURL: safePhotoUrl(user.photoURL),
    provider: "google.com"
  };
  state.avatar = cachedAvatar;
  state.chatNotificationsEnabled = state.chatNotificationsByUser[user.uid] === true;
  state.chatNotificationsSyncPending = false;
  if (isCurrentUserAdmin()) startAdminNameRequestsRealtime();
  else resetAdminClientState();

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

  state.predictions = { ...remote };
  state.confirmedPredictions = { ...remote };
  state.avatar = remoteProfile?.avatar || cachedAvatar;
  const savedDisplayName = normalizeDisplayName(remoteProfile?.data?.displayName);
  if (savedDisplayName) state.user.name = savedDisplayName.slice(0, MAX_DISPLAY_NAME_LENGTH);
  state.profileNamePolicy = normalizeProfileNamePolicy(remoteProfile?.data || {});
  await loadOwnNameRequest(user.uid, state.profileNamePolicy.pendingNameRequestId);
  if (state.auth?.currentUser?.uid !== user.uid) return;
  state.chatProfiles[user.uid] = normalizePublicProfile(user.uid, {
    displayName: state.user.name,
    photoURL: state.user.photoURL,
    avatarType: state.avatar.type,
    avatarValue: state.avatar.value
  });

  const profileDidNotExist = profileResult.status === "fulfilled" && !remoteProfile;
  if (profileDidNotExist) {
    try {
      await saveRemoteProfile(user.uid, state.avatar, null, state.user.name);
    } catch (error) {
      console.error("Nie udało się utworzyć profilu przed aktywacją gracza:", error);
      notify("Konto Google jest zalogowane, ale profil gracza nie został jeszcze utworzony. Spróbuj odświeżyć stronę.");
    }
  }
  if (state.auth?.currentUser?.uid !== user.uid) return;

  await activateSeasonParticipant(user.uid, { startRealtime: false, notifyOnError: true });
  if (state.auth?.currentUser?.uid !== user.uid) return;
  const profileMetadataSync = state.participantReady
    ? syncAuthenticatedProfileMetadata(user.uid)
    : Promise.resolve();

  const migratedPredictions = await migrateLegacyLocalPredictions(user.uid);
  if (state.auth?.currentUser?.uid !== user.uid) return;
  Object.assign(state.predictions, migratedPredictions);
  Object.assign(state.confirmedPredictions, migratedPredictions);

  if (profileResult.status === "fulfilled" && !profileDidNotExist) {
    try {
      const profileSave = saveRemoteProfile(user.uid, state.avatar, remoteProfile?.data || null).then(
        () => ({ status: "saved" }),
        (error) => ({ status: "failed", error })
      );
      const profileWriteResult = await Promise.race([
        profileSave,
        new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), 6500))
      ]);
      if (profileWriteResult.status === "failed") throw profileWriteResult.error;
    } catch (error) {
      console.error("Nie udało się uzupełnić profilu gracza:", error);
    }
  }
  if (state.auth?.currentUser?.uid !== user.uid) return;

  state.userDataReady = true;
  startOwnProfileRealtime(user.uid);
  save();
  render();
  profileMetadataSync.finally(() => {
    if (!isCurrentUserAdmin() || state.auth?.currentUser?.uid !== user.uid) return;
    startAdminNameRequestsRealtime();
    if (state.view === "admin") void loadAdminPlayers({ force: true });
  });
  Promise.allSettled([
    announceSeasonParticipant(),
    queueNotificationPicksSync(state.confirmedPredictions, user.uid)
  ]).then((results) => {
    results.forEach((result, index) => {
      if (result.status === "rejected") reportNotificationSyncError(index === 0
        ? "Nie udało się zsynchronizować powiadomienia o graczu"
        : "Nie udało się zsynchronizować typów z powiadomieniami", result.reason);
    });
  });
  if (state.view === "ranking" && state.participantReady) void loadRankingData();
  if (state.view === "matches" && state.participantReady) void loadPlayerDashboardData();
  if (state.participantReady) startChatRealtime(user.uid);
  if (state.participantReady) reconcileChatPush(user.uid).catch((error) => {
    console.warn("Nie udało się uzgodnić stanu powiadomień tego urządzenia:", error);
  });
  document.querySelector("#authDialog")?.close();
  scheduleNotificationPrimer(1200);
  tryApplyNotificationRoute().catch((error) => console.warn("Nie udało się otworzyć widoku z powiadomienia:", error));

  syncTrustedMatchTimes().then(() => {
    if (state.view === "ranking" && state.user?.uid === user.uid && state.participantReady) void loadRankingData();
  });
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
      const firestoreOptions = typeof firestore.memoryLocalCache === "function"
        ? { localCache: firestore.memoryLocalCache() }
        : {};
      state.db = firestore.initializeFirestore(firebaseApp, firestoreOptions);
      if (typeof firestore.clearIndexedDbPersistence === "function") {
        try {
          await firestore.clearIndexedDbPersistence(state.db);
        } catch (error) {
          console.warn("Nie udało się usunąć starego cache Firestore z innej otwartej karty:", error);
        }
      }
    } catch (error) {
      console.warn("Nie udało się jawnie ustawić cache w pamięci Firestore:", error);
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
  resetAdminClientState();
  if (state.auth?.currentUser && state.firebaseModules?.signOut) {
    const uid = state.auth.currentUser.uid;
    try {
      await detachChatPushBeforeLogout(uid);
      await state.firebaseModules.signOut(state.auth);
      clearNotificationOutboxForUser(uid);
      state.user = null;
      state.predictions = {};
      state.confirmedPredictions = {};
      state.userDataReady = false;
      predictionWriteQueues.clear();
      predictionWriteVersions.clear();
      save();
      location.reload();
    } catch (error) {
      console.error("Wylogowanie nie powiodło się:", error);
      notify("Nie udało się wylogować. Spróbuj ponownie.");
    } finally {
      chatPushSessionClosing = false;
      state.chatNotificationsBusy = chatPushPendingOperations > 0;
      if (state.auth?.currentUser?.uid === uid) updateAuthButton();
    }
    return;
  }

  clearNotificationOutboxForUser(state.user?.uid);
  state.user = null;
  state.predictions = {};
  state.confirmedPredictions = {};
  state.userDataReady = false;
  state.avatar = { ...DEFAULT_AVATAR };
  state.avatarBusy = false;
  state.avatarPending = false;
  state.nameBusy = false;
  state.profileNamePolicy = { selfRenameUsed: false, pendingNameRequestId: "", nameVersion: 0 };
  state.nameRequest = null;
  state.nameRequestStatus = "idle";
  state.nameRequestError = "";
  state.avatarOperationId += 1;
  state.participantReady = false;
  state.participantActivationBusy = false;
  state.participantActivationError = false;
  stopChatRealtime();
  predictionWriteQueues.clear();
  predictionWriteVersions.clear();
  save();
  render();
}

async function saveRemotePrediction(uid, matchId, pick) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) {
    const error = new Error("Sesja gracza zmieniła się przed zapisem typu.");
    error.code = "auth/session-changed";
    throw error;
  }
  if (!typerMatchIds.has(matchId)) throw new Error("Mecz nie należy do rundy jesiennej typera.");
  const { doc, setDoc, serverTimestamp } = state.firebaseModules;
  await setDoc(doc(state.db, "seasons", SEASON_ID, "players", uid, "picks", matchId), {
    pick,
    updatedAt: serverTimestamp()
  });
  queueNotificationPickSync(matchId, pick, uid).catch((error) => reportNotificationSyncError("Nie udało się zsynchronizować typu z powiadomieniami", error));
}

async function loadRemotePredictions(uid) {
  const { collection, query, where, getDocs } = state.firebaseModules;
  const predictions = {};
  const [legacyResult, currentResult] = await Promise.allSettled([
    getDocs(query(collection(state.db, "predictions"), where("uid", "==", uid))),
    getDocs(collection(state.db, "seasons", SEASON_ID, "players", uid, "picks"))
  ]);
  if (legacyResult.status === "fulfilled") {
    legacyResult.value.forEach((item) => {
      const data = item.data();
      if (typeof data.matchId === "string" && typerMatchIds.has(data.matchId) && ["1", "X", "2"].includes(data.pick)) predictions[data.matchId] = data.pick;
    });
  }
  if (currentResult.status === "fulfilled") {
    currentResult.value.forEach((item) => {
      const data = item.data();
      if (typerMatchIds.has(item.id) && ["1", "X", "2"].includes(data.pick)) predictions[item.id] = data.pick;
    });
  }
  if (legacyResult.status === "rejected" && currentResult.status === "rejected") throw currentResult.reason;
  return predictions;
}

async function saveRemoteAvatar(uid, avatar) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid) throw new Error("Brak aktywnej sesji Google");
  const normalized = normalizeAvatar(avatar);
  if (!normalized) throw new Error("Nieprawidłowy avatar");
  const { doc, getDoc, serverTimestamp, updateDoc } = state.firebaseModules;
  const reference = doc(state.db, "profiles", uid);
  const snapshot = await getDoc(reference);
  if (!snapshot.exists()) {
    await saveRemoteProfile(uid, normalized, null);
    return;
  }
  await updateDoc(reference, {
    avatarType: normalized.type,
    avatarValue: normalized.value,
    updatedAt: serverTimestamp()
  });
  await syncOwnLeaderboardIdentity(uid, state.user?.name, normalized);
}

async function saveRemoteDisplayName(uid, displayName) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) {
    throw new Error("Brak aktywnej sesji Google");
  }
  const normalizedName = normalizeDisplayName(displayName);
  if (!validDisplayName(normalizedName)) throw new Error("Nieprawidłowa nazwa gracza");
  const { collection, doc, runTransaction, serverTimestamp } = state.firebaseModules;
  const profileReference = doc(state.db, "profiles", uid);
  const leaderboardReference = doc(state.db, "seasons", SEASON_ID, "leaderboard", uid);
  const requestReference = doc(collection(state.db, "nameChangeRequests"));
  return runTransaction(state.db, async (transaction) => {
    const [profileSnapshot, leaderboardSnapshot] = await Promise.all([
      transaction.get(profileReference),
      transaction.get(leaderboardReference)
    ]);
    if (!profileSnapshot.exists()) {
      const error = new Error("Profil gracza jeszcze nie istnieje.");
      error.code = "name-change/profile-missing";
      throw error;
    }
    const profile = profileSnapshot.data();
    const currentName = normalizeDisplayName(profile.displayName || state.user?.name);
    const policy = normalizeProfileNamePolicy(profile);
    if (normalizedName === currentName) {
      const error = new Error("To już jest aktualna nazwa.");
      error.code = "name-change/unchanged";
      throw error;
    }

    if (!policy.selfRenameUsed) {
      if (!leaderboardSnapshot.exists()) {
        const error = new Error("Gracz nie ma jeszcze wpisu w rankingu.");
        error.code = "name-change/leaderboard-missing";
        throw error;
      }
      const nextVersion = policy.nameVersion + 1;
      transaction.update(profileReference, {
        displayName: normalizedName,
        selfRenameUsed: true,
        pendingNameRequestId: "",
        nameVersion: nextVersion,
        updatedAt: serverTimestamp()
      });
      transaction.update(leaderboardReference, {
        displayName: normalizedName,
        updatedAt: serverTimestamp()
      });
      return {
        kind: "changed",
        previousName: currentName,
        displayName: normalizedName,
        nameVersion: nextVersion
      };
    }

    if (policy.pendingNameRequestId) {
      const existingRequestReference = doc(state.db, "nameChangeRequests", policy.pendingNameRequestId);
      const existingRequestSnapshot = await transaction.get(existingRequestReference);
      if (existingRequestSnapshot.exists() && existingRequestSnapshot.data()?.status === "pending") {
        const error = new Error("Wniosek o zmianę nazwy już oczekuje.");
        error.code = "name-request/pending";
        throw error;
      }
    }
    transaction.set(requestReference, {
      uid,
      currentName,
      requestedName: normalizedName,
      status: "pending",
      createdAt: serverTimestamp(),
      resolvedAt: null,
      resolvedBy: "",
      adminNote: ""
    });
    transaction.update(profileReference, {
      pendingNameRequestId: requestReference.id,
      updatedAt: serverTimestamp()
    });
    return {
      kind: "requested",
      requestId: requestReference.id,
      currentName,
      requestedName: normalizedName
    };
  });
}

async function saveRemoteProfile(uid, avatar, existingData = null, displayName = state.user?.name) {
  if (!state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) {
    throw new Error("Brak aktywnej sesji Google");
  }
  const normalized = normalizeAvatar(avatar) || { ...DEFAULT_AVATAR };
  const normalizedName = normalizeDisplayName(displayName);
  if (!validDisplayName(normalizedName)) throw new Error("Nieprawidłowa nazwa gracza");
  const { doc, setDoc, serverTimestamp } = state.firebaseModules;
  const payload = {
    uid,
    displayName: normalizedName,
    avatarType: normalized.type,
    avatarValue: normalized.value,
    joinedAt: existingData?.joinedAt || serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  if (typeof existingData?.selfRenameUsed !== "boolean") payload.selfRenameUsed = false;
  if (typeof existingData?.pendingNameRequestId !== "string") payload.pendingNameRequestId = "";
  if (!Number.isInteger(existingData?.nameVersion) || existingData.nameVersion < 0) payload.nameVersion = 0;
  await setDoc(doc(state.db, "profiles", uid), payload, { merge: true });
  await syncOwnLeaderboardIdentity(uid, normalizedName, normalized);
}

async function syncOwnLeaderboardIdentity(uid, displayName = state.user?.name, avatar = state.avatar) {
  if (!state.participantReady || !state.db || !state.firebaseModules || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
  const normalizedAvatar = normalizeAvatar(avatar) || { ...DEFAULT_AVATAR };
  const normalizedName = normalizeDisplayName(displayName);
  if (!validDisplayName(normalizedName)) return;
  const { doc, serverTimestamp, updateDoc } = state.firebaseModules;
  try {
    await updateDoc(doc(state.db, "seasons", SEASON_ID, "leaderboard", uid), {
      displayName: normalizedName,
      avatarType: normalizedAvatar.type,
      avatarValue: normalizedAvatar.value,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    console.warn("Nie udało się od razu odświeżyć profilu w rankingu:", error);
  }
}

async function loadRemoteProfile(uid) {
  const { doc, getDoc } = state.firebaseModules;
  const snapshot = await getDoc(doc(state.db, "profiles", uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return { data, avatar: normalizeAvatar(data) };
}

function stopOwnProfileRealtime() {
  ownProfileUnsubscribe?.();
  ownProfileUnsubscribe = null;
  ownProfileRequestRevision += 1;
}

function startOwnProfileRealtime(uid) {
  stopOwnProfileRealtime();
  if (!uid || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid || !state.db || !state.firebaseModules) return;
  const { doc, onSnapshot } = state.firebaseModules;
  ownProfileUnsubscribe = onSnapshot(doc(state.db, "profiles", uid), (snapshot) => {
    if (!snapshot.exists() || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
    const data = snapshot.data({ serverTimestamps: "estimate" });
    const nextName = normalizeDisplayName(data?.displayName).slice(0, MAX_DISPLAY_NAME_LENGTH);
    const nextAvatar = normalizeAvatar(data) || { ...DEFAULT_AVATAR };
    const nextPolicy = normalizeProfileNamePolicy(data);
    const pendingChanged = nextPolicy.pendingNameRequestId !== state.profileNamePolicy.pendingNameRequestId;
    const identityChanged = Boolean(nextName && nextName !== state.user.name)
      || nextAvatar.type !== state.avatar.type
      || nextAvatar.value !== state.avatar.value;
    const policyChanged = nextPolicy.selfRenameUsed !== state.profileNamePolicy.selfRenameUsed
      || nextPolicy.nameVersion !== state.profileNamePolicy.nameVersion
      || pendingChanged;

    if (nextName) state.user.name = nextName;
    state.avatar = nextAvatar;
    state.profileNamePolicy = nextPolicy;
    state.chatProfiles[uid] = normalizePublicProfile(uid, {
      displayName: state.user.name,
      avatarType: nextAvatar.type,
      avatarValue: nextAvatar.value
    });
    state.avatarsByUser[uid] = { ...nextAvatar };
    if (identityChanged) save();
    if (identityChanged) updateChatWidget({ keepScroll: true });

    if (pendingChanged) {
      const revision = ++ownProfileRequestRevision;
      loadOwnNameRequest(uid, nextPolicy.pendingNameRequestId).finally(() => {
        if (revision !== ownProfileRequestRevision || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
        updateAuthButton();
        if (["matches", "settings", "ranking"].includes(state.view)) render();
      });
      return;
    }
    if (identityChanged || policyChanged) {
      updateAuthButton();
      if (["matches", "settings", "ranking"].includes(state.view)) render();
    }
  }, (error) => {
    console.warn("Aktualizacja profilu gracza na żywo jest chwilowo niedostępna:", error);
  });
}

async function loadOwnNameRequest(uid, requestId) {
  state.nameRequest = null;
  state.nameRequestError = "";
  if (!requestId) {
    state.nameRequestStatus = "ready";
    return null;
  }
  state.nameRequestStatus = "loading";
  try {
    const { doc, getDoc } = state.firebaseModules;
    const snapshot = await getDoc(doc(state.db, "nameChangeRequests", requestId));
    if (state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return null;
    const request = snapshot.exists() ? normalizeNameChangeRequest(snapshot.id, snapshot.data()) : null;
    if (request && request.uid !== uid) throw new Error("Wniosek nie należy do tego konta.");
    state.nameRequest = request;
    state.nameRequestStatus = "ready";
    return request;
  } catch (error) {
    if (state.auth?.currentUser?.uid === uid && state.user?.uid === uid) {
      state.nameRequestStatus = "error";
      state.nameRequestError = "Nie udało się pobrać szczegółów oczekującego wniosku.";
    }
    console.warn("Nie udało się pobrać wniosku o zmianę nicku:", error);
    return null;
  }
}

async function syncAuthenticatedProfileMetadata(uid) {
  if (!uid || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return;
  try {
    await notificationApiRequest("/api/profile/sync", {});
  } catch (error) {
    reportNotificationSyncError("Nie udało się zsynchronizować prywatnych danych konta", error);
  }
  if (!isCurrentUserAdmin() || state.auth?.currentUser?.uid !== uid) return;
  try {
    await notificationApiRequest("/api/admin/bootstrap", {});
  } catch (error) {
    reportNotificationSyncError("Nie udało się przygotować danych panelu administratora", error);
  }
}

function stopAdminNameRequestsRealtime({ reset = true } = {}) {
  adminNameRequestsUnsubscribe?.();
  adminNameRequestsUnsubscribe = null;
  adminRequestsSnapshotReady = false;
  adminPendingRequestIds = new Set();
  if (!reset) return;
  state.adminRequests = [];
  state.adminRequestsStatus = "idle";
  state.adminRequestsError = "";
}

function resetAdminClientState() {
  stopAdminNameRequestsRealtime();
  state.adminPlayers = [];
  state.adminPlayersStatus = "idle";
  state.adminPlayersError = "";
  state.adminBusyId = "";
  state.adminSearch = "";
}

function startAdminNameRequestsRealtime({ restart = false } = {}) {
  if (restart) stopAdminNameRequestsRealtime({ reset: false });
  if (adminNameRequestsUnsubscribe || !isCurrentUserAdmin() || !state.db || !state.firebaseModules) return;
  const { collection, onSnapshot } = state.firebaseModules;
  state.adminRequestsStatus = "loading";
  state.adminRequestsError = "";
  adminNameRequestsUnsubscribe = onSnapshot(collection(state.db, "nameChangeRequests"), (snapshot) => {
    if (!isCurrentUserAdmin()) {
      stopAdminNameRequestsRealtime();
      return;
    }
    const requests = [];
    snapshot.forEach((item) => {
      const request = normalizeNameChangeRequest(item.id, item.data({ serverTimestamps: "estimate" }));
      if (request) requests.push(request);
    });
    requests.sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return firestoreTimeMs(b.createdAt) - firestoreTimeMs(a.createdAt);
    });
    const nextPendingIds = new Set(requests.filter((request) => request.status === "pending").map((request) => request.id));
    if (adminRequestsSnapshotReady) {
      const newPending = requests.find((request) => request.status === "pending" && !adminPendingRequestIds.has(request.id));
      if (newPending) notify(`Nowy wniosek o zmianę nicku: ${newPending.currentName} → ${newPending.requestedName}`);
    }
    adminPendingRequestIds = nextPendingIds;
    adminRequestsSnapshotReady = true;
    state.adminRequests = requests;
    state.adminRequestsStatus = "ready";
    state.adminRequestsError = "";
    updateAuthButton();
    if (state.view === "admin") render();
  }, (error) => {
    console.error("Lista wniosków o zmianę nicku jest niedostępna:", error);
    state.adminRequestsStatus = "error";
    state.adminRequestsError = "Nie udało się uruchomić aktualizacji wniosków na żywo.";
    updateAuthButton();
    if (state.view === "admin") render();
  });
}

function normalizeAdminPrivatePlayer(value = {}) {
  const uid = typeof value?.uid === "string" ? value.uid : "";
  if (!uid) return null;
  return {
    uid,
    email: typeof value?.email === "string" ? value.email.trim().slice(0, 320) : "",
    googleName: normalizeDisplayName(value?.googleName).slice(0, 120),
    lastSeenAt: value?.lastSeenAt || null,
    hasProfile: false
  };
}

async function loadAdminPlayers({ force = false } = {}) {
  if (!isCurrentUserAdmin() || !state.db || !state.firebaseModules) return;
  if (!force && state.adminPlayersStatus === "loading") return;
  state.adminPlayersStatus = "loading";
  state.adminPlayersError = "";
  if (state.view === "admin") render();
  const { collection, getDocs } = state.firebaseModules;
  const [privateResult, profilesResult] = await Promise.allSettled([
    notificationApiRequest("/api/admin/players", {}, { method: "GET" }),
    getDocs(collection(state.db, "profiles"))
  ]);
  if (!isCurrentUserAdmin()) return;
  if (privateResult.status === "rejected" && profilesResult.status === "rejected") {
    state.adminPlayers = [];
    state.adminPlayersStatus = "error";
    state.adminPlayersError = "Nie udało się pobrać ani danych kont, ani publicznych profili.";
    if (state.view === "admin") render();
    return;
  }

  const byUid = new Map();
  if (privateResult.status === "fulfilled") {
    const privatePlayers = Array.isArray(privateResult.value?.players) ? privateResult.value.players : [];
    privatePlayers.forEach((value) => {
      const player = normalizeAdminPrivatePlayer(value);
      if (player) byUid.set(player.uid, { ...player });
    });
  }
  if (profilesResult.status === "fulfilled") {
    profilesResult.value.forEach((snapshot) => {
      const data = snapshot.data({ serverTimestamps: "estimate" });
      const previous = byUid.get(snapshot.id) || { uid: snapshot.id, email: "", googleName: "", lastSeenAt: null };
      const policy = normalizeProfileNamePolicy(data);
      byUid.set(snapshot.id, {
        ...previous,
        hasProfile: true,
        displayName: normalizeDisplayName(data?.displayName).slice(0, MAX_DISPLAY_NAME_LENGTH),
        avatarType: typeof data?.avatarType === "string" ? data.avatarType : "",
        avatarValue: typeof data?.avatarValue === "string" ? data.avatarValue : "",
        ...policy
      });
    });
  }
  state.adminRequests.forEach((request) => {
    if (!byUid.has(request.uid)) {
      byUid.set(request.uid, {
        uid: request.uid,
        email: "",
        googleName: "",
        lastSeenAt: null,
        hasProfile: false,
        displayName: request.currentName,
        selfRenameUsed: true,
        pendingNameRequestId: request.status === "pending" ? request.id : "",
        nameVersion: 0
      });
    }
  });
  state.adminPlayers = [...byUid.values()].sort((a, b) => (
    String(a.displayName || a.googleName || a.email || a.uid)
      .localeCompare(String(b.displayName || b.googleName || b.email || b.uid), "pl", { sensitivity: "base" })
  ));
  state.adminPlayersStatus = "ready";
  const partialErrors = [];
  if (privateResult.status === "rejected") partialErrors.push("Prywatne dane kont są chwilowo niedostępne.");
  if (profilesResult.status === "rejected") partialErrors.push("Publiczne profile są chwilowo niedostępne.");
  state.adminPlayersError = partialErrors.join(" ");
  if (state.view === "admin") render();
}

function filterAdminPlayers(event) {
  const input = event?.currentTarget || document.querySelector("#adminPlayerSearch");
  if (!input) return;
  state.adminSearch = String(input.value || "").trim();
  const queryValue = state.adminSearch.toLocaleLowerCase("pl");
  let visible = 0;
  app.querySelectorAll("[data-admin-player]").forEach((card) => {
    const matches = !queryValue || card.textContent.toLocaleLowerCase("pl").includes(queryValue);
    card.hidden = !matches;
    if (matches) visible += 1;
  });
  const empty = app.querySelector("[data-admin-search-empty]");
  if (empty) empty.hidden = visible > 0;
}

function normalizeAdminNote(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function resolveAdminNameRequest(requestId, decision, adminNote = "") {
  if (!isCurrentUserAdmin() || !["approved", "rejected"].includes(decision)) throw new Error("Brak uprawnień administratora.");
  const { doc, runTransaction, serverTimestamp } = state.firebaseModules;
  const requestReference = doc(state.db, "nameChangeRequests", requestId);
  return runTransaction(state.db, async (transaction) => {
    const requestSnapshot = await transaction.get(requestReference);
    const request = requestSnapshot.exists() ? normalizeNameChangeRequest(requestSnapshot.id, requestSnapshot.data()) : null;
    if (!request || request.status !== "pending") {
      const error = new Error("Wniosek został już rozpatrzony albo nie istnieje.");
      error.code = "admin/request-resolved";
      throw error;
    }
    const profileReference = doc(state.db, "profiles", request.uid);
    const leaderboardReference = doc(state.db, "seasons", SEASON_ID, "leaderboard", request.uid);
    const [profileSnapshot, leaderboardSnapshot] = await Promise.all([
      transaction.get(profileReference),
      transaction.get(leaderboardReference)
    ]);
    if (!profileSnapshot.exists()) throw new Error("Profil gracza nie istnieje.");
    const profile = profileSnapshot.data();
    const policy = normalizeProfileNamePolicy(profile);
    if (decision === "approved") {
      if (policy.pendingNameRequestId !== requestId) {
        const error = new Error("Wniosek nie jest już aktywnym wnioskiem tego gracza.");
        error.code = "admin/request-stale";
        throw error;
      }
      if (!leaderboardSnapshot.exists()) throw new Error("Gracz nie ma wpisu w rankingu.");
      const nextVersion = policy.nameVersion + 1;
      transaction.update(profileReference, {
        displayName: request.requestedName,
        pendingNameRequestId: "",
        nameVersion: nextVersion,
        updatedAt: serverTimestamp()
      });
      transaction.update(leaderboardReference, {
        displayName: request.requestedName,
        updatedAt: serverTimestamp()
      });
    } else if (policy.pendingNameRequestId === requestId) {
      transaction.update(profileReference, {
        pendingNameRequestId: "",
        updatedAt: serverTimestamp()
      });
    }
    transaction.update(requestReference, {
      status: decision,
      resolvedAt: serverTimestamp(),
      resolvedBy: state.user.uid,
      adminNote
    });
    return {
      requestId,
      uid: request.uid,
      status: decision,
      currentName: request.currentName,
      requestedName: request.requestedName,
      adminNote
    };
  });
}

async function decideAdminNameRequest(event) {
  const button = event.currentTarget;
  const requestId = button.dataset.requestId || "";
  const decision = button.dataset.adminRequestAction === "approve" ? "approved" : "rejected";
  if (!requestId || state.adminBusyId || !isCurrentUserAdmin()) return;
  const note = normalizeAdminNote(button.closest("[data-admin-request]")?.querySelector("[name='adminNote']")?.value);
  state.adminBusyId = requestId;
  render();
  try {
    const result = await resolveAdminNameRequest(requestId, decision, note);
    await enqueueAndFlushNameEvent("name-decision", { requestId: result.requestId }, state.user.uid);
    notify(decision === "approved" ? "Nick gracza został zatwierdzony." : "Wniosek został odrzucony.");
    await loadAdminPlayers({ force: true });
  } catch (error) {
    console.error("Nie udało się rozpatrzyć wniosku:", error);
    notify(error?.message || "Nie udało się rozpatrzyć wniosku.");
  } finally {
    if (isCurrentUserAdmin()) {
      state.adminBusyId = "";
      if (state.view === "admin") render();
    }
  }
}

async function editAdminPlayerName(uid, displayName) {
  if (!isCurrentUserAdmin()) throw new Error("Brak uprawnień administratora.");
  const normalizedName = normalizeDisplayName(displayName);
  if (!validDisplayName(normalizedName)) throw new Error(`Nick musi mieć od 1 do ${MAX_DISPLAY_NAME_LENGTH} znaków.`);
  const { doc, runTransaction, serverTimestamp } = state.firebaseModules;
  const profileReference = doc(state.db, "profiles", uid);
  const leaderboardReference = doc(state.db, "seasons", SEASON_ID, "leaderboard", uid);
  return runTransaction(state.db, async (transaction) => {
    const [profileSnapshot, leaderboardSnapshot] = await Promise.all([
      transaction.get(profileReference),
      transaction.get(leaderboardReference)
    ]);
    if (!profileSnapshot.exists()) throw new Error("Profil gracza nie istnieje.");
    if (!leaderboardSnapshot.exists()) throw new Error("Gracz nie ma wpisu w rankingu.");
    const profile = profileSnapshot.data();
    const previousName = normalizeDisplayName(profile.displayName);
    if (previousName === normalizedName) throw new Error("To już jest aktualny nick gracza.");
    const policy = normalizeProfileNamePolicy(profile);
    let pendingRequestReference = null;
    let pendingRequest = null;
    if (policy.pendingNameRequestId) {
      pendingRequestReference = doc(state.db, "nameChangeRequests", policy.pendingNameRequestId);
      const pendingSnapshot = await transaction.get(pendingRequestReference);
      pendingRequest = pendingSnapshot.exists()
        ? normalizeNameChangeRequest(pendingSnapshot.id, pendingSnapshot.data())
        : null;
    }
    const nextVersion = policy.nameVersion + 1;
    transaction.update(profileReference, {
      displayName: normalizedName,
      selfRenameUsed: policy.selfRenameUsed,
      pendingNameRequestId: "",
      nameVersion: nextVersion,
      updatedAt: serverTimestamp()
    });
    transaction.update(leaderboardReference, {
      displayName: normalizedName,
      updatedAt: serverTimestamp()
    });
    if (pendingRequestReference && pendingRequest?.status === "pending") {
      transaction.update(pendingRequestReference, {
        status: "rejected",
        resolvedAt: serverTimestamp(),
        resolvedBy: state.user.uid,
        adminNote: "Nick został zmieniony bezpośrednio przez administratora."
      });
    }
    return {
      uid,
      previousName,
      displayName: normalizedName,
      nameVersion: nextVersion,
      rejectedRequestId: pendingRequest?.status === "pending" ? pendingRequest.id : ""
    };
  });
}

async function saveAdminDisplayName(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const uid = form.dataset.adminNameForm || "";
  const nextName = normalizeDisplayName(form.querySelector("[name='displayName']")?.value);
  if (!uid || state.adminBusyId || !isCurrentUserAdmin()) return;
  if (!validDisplayName(nextName)) {
    notify(`Nick musi mieć od 1 do ${MAX_DISPLAY_NAME_LENGTH} znaków.`);
    return;
  }
  state.adminBusyId = uid;
  render();
  try {
    const result = await editAdminPlayerName(uid, nextName);
    await enqueueAndFlushNameEvent("admin-name-edited", {
      uid: result.uid,
      nameVersion: result.nameVersion
    }, state.user.uid);
    notify("Nick gracza został zmieniony przez administratora.");
    await loadAdminPlayers({ force: true });
  } catch (error) {
    console.error("Nie udało się zmienić nicku gracza:", error);
    notify(error?.message || "Nie udało się zmienić nicku gracza.");
  } finally {
    if (isCurrentUserAdmin()) {
      state.adminBusyId = "";
      if (state.view === "admin") render();
    }
  }
}

async function migrateLegacyLocalPredictions(uid) {
  const source = asRecord(legacyPredictionsByUser[uid]);
  const validEntries = Object.entries(source).filter(([matchId, pick]) => (
    typerMatchIds.has(matchId) && ["1", "X", "2"].includes(pick)
  ));
  if (!validEntries.length) {
    if (uid in legacyPredictionsByUser) {
      delete legacyPredictionsByUser[uid];
      save();
    }
    return {};
  }
  if (!state.participantReady || state.auth?.currentUser?.uid !== uid || state.user?.uid !== uid) return {};

  const serverBackedIds = new Set(
    validEntries
      .filter(([matchId]) => Object.hasOwn(state.confirmedPredictions, matchId))
      .map(([matchId]) => matchId)
  );
  const writableEntries = validEntries.filter(([matchId]) => {
    const match = state.matches.find((item) => item.id === matchId);
    return !serverBackedIds.has(matchId) && isPredictionOpen(match);
  });
  const results = await Promise.allSettled(
    writableEntries.map(([matchId, pick]) => saveRemotePrediction(uid, matchId, pick))
  );
  const migrated = {};
  const migratedIds = new Set();
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const [matchId, pick] = writableEntries[index];
    migrated[matchId] = pick;
    migratedIds.add(matchId);
  });

  const remaining = Object.fromEntries(validEntries.filter(([matchId]) => (
    !serverBackedIds.has(matchId) && !migratedIds.has(matchId)
  )));
  if (Object.keys(remaining).length) legacyPredictionsByUser[uid] = remaining;
  else delete legacyPredictionsByUser[uid];
  save();
  return migrated;
}

async function syncTrustedMatchTimes() {
  if (trustedMatchesSyncPromise) return trustedMatchesSyncPromise;
  if (state.user?.email !== "mateuszjoe@gmail.com" || state.auth?.currentUser?.uid !== state.user.uid || !state.db || !state.firebaseModules) return;
  const confirmedMatches = state.matches
    .filter((match) => typerMatchIds.has(match.id) && match.matchday <= LAST_MATCHDAY && match.kickoffConfirmed && Number.isFinite(new Date(match.kickoffAt).getTime()))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!confirmedMatches.length) return;
  const signature = confirmedMatches.map((match) => `${match.id}:${match.matchday}:${new Date(match.kickoffAt).toISOString()}:${resultOf(match) || ""}`).join("|");

  trustedMatchesSyncPromise = (async () => {
    const { doc, getDoc, serverTimestamp, Timestamp, writeBatch } = state.firebaseModules;
    const metaReference = doc(state.db, "scheduleMeta", SEASON_ID);
    const metaSnapshot = await getDoc(metaReference);
    if (metaSnapshot.exists() && metaSnapshot.data().signature === signature) return;
    const batch = writeBatch(state.db);
    confirmedMatches.forEach((match) => {
      const kickoff = Timestamp.fromDate(new Date(match.kickoffAt));
      batch.set(doc(state.db, "seasons", SEASON_ID, "matches", match.id), {
        matchday: match.matchday,
        closesAt: kickoff,
        revealsAt: kickoff,
        result: resultOf(match) || "",
        updatedAt: serverTimestamp()
      });
    });
    batch.set(metaReference, {
      seasonId: SEASON_ID,
      signature,
      matchCount: confirmedMatches.length,
      updatedAt: serverTimestamp()
    });
    await batch.commit();
  })().catch((error) => {
    console.error("Nie udało się zsynchronizować bezpiecznych terminów meczów:", error);
  }).finally(() => {
    trustedMatchesSyncPromise = null;
  });
  return trustedMatchesSyncPromise;
}

function normalizeName(value) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

async function loadLivePayloadForClient() {
  if (liveTransport === "server") {
    try {
      const response = await fetch("./api/live");
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("application/json")) throw new Error(`LIVE HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.warn("Serwerowy kanał LIVE jest niedostępny, używam oficjalnego API bezpośrednio:", error.message);
      liveTransport = "official";
    }
  }
  return getOfficialLivePayload();
}

async function pollLive() {
  let nextDelay = 5 * 60_000;
  try {
    const payload = await loadLivePayloadForClient();
    const settledResultsBefore = settledResultsSignature();
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
    const settledResultsChanged = settledResultsBefore !== settledResultsSignature();
    if (settledResultsChanged && state.user) {
      state.rankingStatus = "idle";
      state.rankingError = "";
      state.playerFormStatus = "idle";
      state.playerFormError = "";
      rankingLoadRevision += 1;
      rankingLoadPromise = null;
      rankingReloadPending = false;
      playerFormLoadRevision += 1;
      playerFormLoadPromise = null;
    }
    const trustedMatchSync = syncTrustedMatchTimes();
    if (dataChanged || state.matches.some((match) => typerMatchIds.has(match.id) && LIVE.has(match.status))) render();
    const openMatchDialog = document.querySelector("#matchDialog[open]");
    if (dataChanged && openMatchDialog?.dataset.matchId) showMatchCentre(openMatchDialog.dataset.matchId);
    if (settledResultsChanged && ["matches", "ranking"].includes(state.view) && state.user && state.userDataReady && state.participantReady) {
      Promise.resolve(trustedMatchSync).finally(() => {
        if (state.view === "ranking" && state.user && state.participantReady) void loadRankingData();
        if (state.view === "matches" && state.user && state.userDataReady && state.participantReady) void loadPlayerDashboardData();
      });
    }
  } catch (error) {
    let liveStateChanged = false;
    state.matches.forEach((match) => {
      if (!LIVE.has(match.status)) return;
      match.status = "SUSP";
      match.liveElapsed = null;
      liveStateChanged = true;
    });
    if (liveStateChanged) render();
    console.warn("Kanał LIVE jest chwilowo niedostępny:", error.message);
  }
  finally {
    firstLivePollSettled = true;
    tryApplyNotificationRoute().catch((error) => console.warn("Nie udało się otworzyć widoku z powiadomienia:", error));
    setTimeout(pollLive, nextDelay);
  }
}

document.addEventListener("click", (event) => {
  const teamRouteLink = event.target.closest?.("[data-team-route]");
  if (teamRouteLink) {
    event.preventDefault();
    teamRouteLink.closest("dialog")?.close();
    openTeamDetails(teamRouteLink.dataset.teamRoute);
    return;
  }

  const leagueMatchRouteLink = event.target.closest?.("[data-league-match-route]");
  if (leagueMatchRouteLink) {
    event.preventDefault();
    leagueMatchRouteLink.closest("dialog")?.close();
    openLeagueMatch(leagueMatchRouteLink.dataset.leagueMatchRoute);
    return;
  }

  const playerButton = event.target.closest?.("[data-player-picks]");
  if (playerButton) {
    event.preventDefault();
    openPlayerPicks(playerButton.dataset.playerPicks);
    return;
  }

  const playerMatchdayButton = event.target.closest?.("[data-player-matchday]");
  if (playerMatchdayButton) {
    loadPlayerPicksMatchday(Number(playerMatchdayButton.dataset.playerMatchday));
    return;
  }

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
    setMainMenuOpen(!document.querySelector(".main-nav")?.classList.contains("is-open"));
    return;
  }

  if (event.target.closest?.("#authButton")) {
    if (state.user) openAccountDialog();
    else {
      openAuthDialog();
    }
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

  if (event.target.closest?.("[data-account-admin]")) {
    document.querySelector("#accountDialog")?.close();
    if (isCurrentUserAdmin()) setView("admin");
    return;
  }

  if (event.target.closest?.("[data-sign-out]")) {
    const signedOutFromMenu = Boolean(event.target.closest?.(".main-nav"));
    setMainMenuOpen(false, signedOutFromMenu);
    logout();
    return;
  }

  const closeButton = event.target.closest?.("dialog [data-close]");
  if (closeButton) {
    closeButton.closest("dialog")?.close();
    return;
  }

  if (event.target.matches?.("#matchDialog, #playerPicksDialog")) event.target.close();
}, { capture: true });
document.querySelectorAll("#authDialog, #accountDialog").forEach((dialog) => {
  dialog.addEventListener("close", () => document.querySelector("#authButton")?.setAttribute("aria-expanded", "false"));
});
document.querySelector("#notificationPrimerDialog [data-enable-notifications]")?.addEventListener("click", enableNotificationsFromPrimer);
document.querySelectorAll("#notificationPrimerDialog [data-notification-later]").forEach((button) => {
  button.addEventListener("click", dismissNotificationPrimer);
});
document.querySelector("#notificationPrimerDialog")?.addEventListener("cancel", (event) => {
  event.preventDefault();
  dismissNotificationPrimer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector(".main-nav")?.classList.contains("is-open")) {
    setMainMenuOpen(false, true);
  }
});
window.addEventListener("popstate", applyRouteFromLocation);
window.addEventListener("hashchange", applyRouteFromLocation);
window.addEventListener("online", () => {
  state.chatReadRetryAt = 0;
  markChatRead();
  if (state.user && !state.participantReady && !state.participantActivationBusy) {
    activateSeasonParticipant(state.user.uid, { notifyOnError: false });
  }
  retryChatPushIfNeeded().catch(() => {});
  flushNotificationOutbox(state.user?.uid).catch((error) => reportNotificationSyncError("Nie udało się ponowić kolejki powiadomień po odzyskaniu sieci", error));
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !navigator.onLine) return;
  state.chatReadRetryAt = 0;
  markChatRead();
  retryChatPushIfNeeded().catch(() => {});
  flushNotificationOutbox(state.user?.uid).catch((error) => reportNotificationSyncError("Nie udało się ponowić kolejki powiadomień po powrocie do aplikacji", error));
});

render();
if (state.view === "ekstraklasa") void loadLeagueData();
tryApplyNotificationRoute().catch((error) => console.warn("Nie udało się otworzyć widoku z powiadomienia:", error));
finishLoadingScreen().then(() => setTimeout(showAndroidAppPrompt, 700));
state.firebaseReady = initFirebase();
pollLive();
setInterval(updateCountdowns, 60000);

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const localPreview = new Set(["localhost", "127.0.0.1", "::1"]).has(location.hostname);
  if (localPreview) {
    const clearLocalPwaState = async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if (!("caches" in window)) return;
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames
        .filter((name) => name.startsWith("ekstraklasa-typer-"))
        .map((name) => caches.delete(name)));
    };
    const cleanLocalPreview = () => clearLocalPwaState().catch(() => {});
    if (document.readyState === "complete") cleanLocalPreview();
    else window.addEventListener("load", cleanLocalPreview, { once: true });
  } else {
    const registerServiceWorker = () => ensureAppServiceWorkerRegistration().catch(() => {});
    if (document.readyState === "complete") registerServiceWorker();
    else window.addEventListener("load", registerServiceWorker, { once: true });
  }
}
