import assert from "node:assert/strict";
import { createAdminPicksPanel } from "../admin-picks-panel.js";

class Dialog {
  events = new Map();
  innerHTML = "";
  scrollTop = 0;
  open = false;
  setAttribute() {}
  contains() { return false; }
  querySelectorAll() { return []; }
  replaceChildren() { this.innerHTML = ""; }
  addEventListener(name, fn) { this.events.set(name, [...(this.events.get(name) || []), fn]); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  emit(name, target = {}, extra = {}) {
    for (const listener of this.events.get(name) || []) listener({ target: { closest: () => null, ...target }, preventDefault() {}, ...extra });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(condition) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  assert.ok(condition(), "asynchronous UI operation did not finish");
}

function harness({ unreadable = "" } = {}) {
  const dialog = new Dialog();
  const storage = new Map();
  globalThis.document = { activeElement: null, createElement: () => dialog, body: { appendChild() {} } };
  globalThis.window = { confirm: () => true };
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const prefix = "seasons/2026-27";
  const pickPath = (id) => `${prefix}/players/player-1/picks/${id}`;
  const store = new Map([[`${prefix}/participants/player-1`, { uid: "player-1", seasonId: "2026-27" }]]);
  ["m1", "m2"].forEach((id) => store.set(`${prefix}/matches/${id}`, { matchday: 14, result: "" }));
  const stats = { reads: 0, writes: 0, syncs: 0 };
  const sdk = {
    doc: (_db, ...segments) => segments.join("/"),
    getDocFromServer: async (path) => {
      stats.reads += 1;
      if (path === pickPath(unreadable)) throw new Error("Test read failure");
      return { exists: () => store.has(path), data: () => structuredClone(store.get(path)) };
    },
    serverTimestamp: () => ({ seconds: 1 }),
    runTransaction: async (_db, operation) => {
      const writes = [];
      const result = await operation({
        get: async (path) => ({ exists: () => store.has(path), data: () => structuredClone(store.get(path)) }),
        set: (path, value) => writes.push({ path, value }),
        update: (path, value) => writes.push({ path, value: { ...store.get(path), ...value } })
      });
      writes.forEach(({ path, value }) => store.set(path, value));
      stats.writes += writes.length;
      return result;
    }
  };
  let context = { actorUid: "admin-1", db: {}, sdk };
  let sync = async ({ matchId, correctionId }) => ({ status: "synced", pick: store.get(pickPath(matchId))?.pick, correctionId });
  const panel = createAdminPicksPanel({
    getContext: () => context,
    getMatches: () => ["m1", "m2"].map((id) => ({ id, label: `Home ${id} – Away ${id}`, when: "6.11 · 18:00", kickoffConfirmed: true, closed: true })),
    syncCorrection: async (data) => { stats.syncs += 1; return sync(data); }
  });
  const open = () => panel.open({ uid: "player-1", name: "Test player", matchday: 14 });
  const select = (id, value) => dialog.emit("change", { name: "pick", dataset: { pickMatch: id }, value });
  const reason = (value = "Zgłoszenie przed awarią telefonu") => dialog.emit("input", { name: "reason", value });
  const click = (attribute) => dialog.emit("click", { closest: (selector) => selector === `[${attribute}]` ? {} : null });
  return { panel, dialog, store, pickPath, stats, open, select, reason, click,
    setSync: (fn) => { sync = fn; }, signOut: () => { context = null; panel.reset(); } };
}

{
  const h = harness(); h.open();
  await until(() => h.dialog.innerHTML.includes("Aktualny typ"));
  h.reason(); h.select("m1", "1"); h.select("m2", "2");
  h.store.set(h.pickPath("m2"), { pick: "X" });
  h.setSync(async () => { throw new Error("Offline"); });
  h.dialog.emit("submit");
  await until(() => h.dialog.innerHTML.includes("Zapisano korekty: 1."));
  assert.equal(h.store.get(h.pickPath("m1")).pick, "1");
  assert.equal(h.store.get(h.pickPath("m2")).pick, "X", "stale form never overwrites a concurrent pick");
  assert.match(h.dialog.innerHTML, /Nie nadpisano go/);
  assert.match(h.dialog.innerHTML, /PONÓW SYNCHRONIZACJĘ/);
  assert.equal(h.stats.writes, 2, "only successful canonical pick and audit committed");
  h.setSync(async ({ correctionId }) => ({ status: "synced", pick: "1", correctionId }));
  h.click("data-admin-picks-retry");
  await until(() => h.dialog.innerHTML.includes("Ranking został zsynchronizowany"));
  assert.equal(h.stats.writes, 2, "retry sends mirror only, no extra correction");
  assert.doesNotMatch(h.dialog.innerHTML, /PONÓW SYNCHRONIZACJĘ/);
  assert.doesNotMatch(h.dialog.innerHTML, /Ranking oczekuje na synchronizację/);
}
{
  const h = harness(); h.open();
  await until(() => h.dialog.innerHTML.includes("Aktualny typ"));
  h.reason("Wiadomość otrzymana rano"); h.select("m1", "X");
  h.click("data-admin-picks-close");
  assert.equal(h.dialog.open, false);
  h.open();
  assert.equal(h.dialog.open, true);
  assert.match(h.dialog.innerHTML, /value="X" selected/);
  assert.match(h.dialog.innerHTML, /Wiadomość otrzymana rano/);
  assert.equal(h.stats.reads, 2, "closing and reopening does not discard draft or replace its expected value");
}
{
  const h = harness({ unreadable: "m2" }); h.open();
  await until(() => h.dialog.innerHTML.includes("Test read failure"));
  h.reason(); h.select("m2", "2"); h.dialog.emit("submit");
  await tick();
  assert.equal(h.stats.writes, 0, "an unreadable pick cannot be treated as a missing pick");
}
{
  const h = harness(); h.open();
  await until(() => h.dialog.innerHTML.includes("Aktualny typ"));
  h.reason(); h.select("m1", "1"); h.select("m2", "2");
  let release;
  h.setSync(() => new Promise((resolve) => { release = resolve; }));
  h.dialog.emit("submit");
  await until(() => typeof release === "function");
  let cancelled = false;
  h.dialog.emit("cancel", {}, { preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true, "busy batch cannot be dismissed accidentally");
  h.signOut(); release({ status: "synced", pick: "1" });
  await tick();
  assert.equal(h.stats.writes, 2);
  assert.equal(h.store.has(h.pickPath("m2")), false, "sign-out stops remaining batch writes");
  assert.equal(h.dialog.innerHTML, "", "sign-out removes admin content from the page");
}
console.log("OK: admin panel preserves drafts, blocks unreadable/stale writes, retries mirror only, reports partial saves and stops after sign-out.");
