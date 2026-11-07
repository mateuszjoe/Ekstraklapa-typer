import { saveAdminPickCorrection } from "./admin-pick-transaction.js";

const OUTBOX_KEY = "ekstraklasa-typer:admin-pick-sync:v1";
const PICKS = new Set(["1", "X", "2"]);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

function readOutbox(actorUid) {
  try {
    const items = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    return Array.isArray(items) ? items.filter((item) => item?.actorUid === actorUid
      && typeof item.uid === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(item.matchId || "")
      && /^[A-Za-z0-9_-]{10,100}$/.test(item.correctionId || "")) : [];
  } catch { return []; }
}

function persistOutbox(actorUid, items) {
  try {
    const stored = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    const otherActors = Array.isArray(stored) ? stored.filter((item) => item?.actorUid !== actorUid) : [];
    localStorage.setItem(OUTBOX_KEY, JSON.stringify([...otherActors, ...items]));
    return true;
  } catch { return false; }
}

// This dialog is mounted outside #app so live score renders never discard a draft.
export function createAdminPicksPanel({ getContext, getMatches, syncCorrection, onChanged, onComplete, lastMatchday = 17 }) {
  let dialog;
  let session = null;
  let generation = 0;

  function active(current) {
    const context = getContext();
    return Boolean(current && context && current === session && context.actorUid === current.actorUid
      && context.db === current.db);
  }

  function pending(current) {
    return current.outbox.filter((item) => item.uid === current.uid);
  }

  function addPending(current, item) {
    if (!current.outbox.some((entry) => entry.correctionId === item.correctionId)) {
      current.outbox.push({ actorUid: current.actorUid, ...item });
    }
    if (!persistOutbox(current.actorUid, current.outbox)) current.storageWarning = true;
  }

  function removePending(current, correctionId) {
    current.outbox = current.outbox.filter((item) => item.correctionId !== correctionId);
    if (!persistOutbox(current.actorUid, current.outbox)) current.storageWarning = true;
  }

  function dirtyRows(current) {
    return current.rows.filter((row) => row.loaded && PICKS.has(row.selected) && row.selected !== row.pick);
  }

  function mount() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "adminPicksDialog";
    dialog.className = "modal admin-picks-modal";
    dialog.setAttribute("aria-labelledby", "adminPicksHeading");
    dialog.addEventListener("cancel", (event) => { if (session?.busy) event.preventDefault(); });
    dialog.addEventListener("click", (event) => {
      if (!session?.busy && (event.target === dialog || event.target.closest("[data-admin-picks-close]"))) dialog.close();
    });
    dialog.addEventListener("input", (event) => {
      if (event.target.name === "reason" && session) session.reason = event.target.value;
    });
    dialog.addEventListener("change", (event) => {
      const current = session;
      if (!current || current.busy) return;
      if (event.target.name === "matchday") {
        if (dirtyRows(current).length && !window.confirm("Zmiana kolejki odrzuci niezapisane wybory. Zmienić kolejkę?")) {
          event.target.value = String(current.matchday);
          return;
        }
        void loadRound(Number(event.target.value));
      }
      if (event.target.dataset.pickMatch) {
        const row = current.rows.find((item) => item.match.id === event.target.dataset.pickMatch);
        if (row) {
          row.selected = event.target.value;
          row.correctionId = "";
          row.error = "";
          current.message = "";
          render();
        }
      }
    });
    dialog.addEventListener("submit", (event) => { event.preventDefault(); void save(); });
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-admin-picks-retry]")) void retrySync();
      if (event.target.closest("[data-admin-picks-reload]")) {
        if (!session || session.busy) return;
        if (dirtyRows(session).length && !window.confirm("Pobrać aktualne typy i odrzucić niezapisane wybory?")) return;
        void loadRound(session.matchday);
      }
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function render() {
    const current = session;
    if (!current || !active(current)) return;
    const focused = dialog.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : "";
    const scrollTop = dialog.scrollTop;
    const changed = dirtyRows(current).length;
    const waiting = pending(current).length;
    const disabled = current.busy || current.loading;
    dialog.innerHTML = `<button type="button" class="modal-close" data-admin-picks-close aria-label="Zamknij" ${current.busy ? "disabled" : ""}>×</button>
      <header class="admin-picks-heading"><p class="eyebrow">KOREKTA ADMINISTRATORA</p><h2 id="adminPicksHeading">${escapeHtml(current.name)}</h2>
      <p>Uzupełnij zgłoszenie gracza lub popraw jego typ. Każda zmiana zachowuje poprzedni typ, powód, administratora i rzeczywisty czas zapisu.</p></header>
      <form class="admin-picks-form">
        <div class="admin-picks-toolbar"><label>Kolejka<select name="matchday" data-focus-key="matchday" ${disabled ? "disabled" : ""}>${Array.from({ length: lastMatchday }, (_, index) => index + 1).map((round) => `<option value="${round}" ${round === current.matchday ? "selected" : ""}>${round}</option>`).join("")}</select></label>
        <button type="button" data-admin-picks-reload ${disabled ? "disabled" : ""}>ODŚWIEŻ TYPY</button></div>
        <div class="admin-picks-list" aria-busy="${current.loading}">${current.loading ? `<p>Pobieramy aktualne typy z serwera…</p>` : current.rows.map((row) => {
          const match = row.match;
          const closed = match.closed || Date.now() >= new Date(match.kickoffAt).getTime();
          const label = !match.kickoffConfirmed ? "Termin niepotwierdzony" : closed ? "Po terminie typowania · korekta" : "Przed terminem typowania";
          return `<article class="admin-picks-row ${row.error ? "has-error" : ""}"><div><strong>${escapeHtml(match.label)}</strong><small>${escapeHtml(match.when)} · ${label}</small>
            <p>Aktualny typ: <b>${row.loaded ? escapeHtml(row.pick || "brak") : "nie udało się odczytać"}</b>${row.correctionIdFromServer ? " · zapis administratora" : ""}</p>
            ${row.error ? `<p class="admin-picks-row-error" role="status">${escapeHtml(row.error)}</p>` : ""}</div>
            <label><span>Nowy typ</span><select aria-label="Nowy typ: ${escapeHtml(match.label)}" data-pick-match="${escapeHtml(match.id)}" data-focus-key="${escapeHtml(match.id)}" ${disabled || !row.loaded ? "disabled" : ""}>
            <option value="">Bez zmian</option>${["1", "X", "2"].map((pick) => `<option value="${pick}" ${row.selected === pick ? "selected" : ""}>${pick}${pick === "1" ? " · gospodarze" : pick === "X" ? " · remis" : " · goście"}</option>`).join("")}</select></label></article>`;
        }).join("")}</div>
        <label class="admin-picks-reason">Powód korekty<textarea name="reason" data-focus-key="reason" required minlength="5" maxlength="500" rows="3" placeholder="Np. awaria aplikacji; zgłoszenie gracza otrzymane przed meczem" ${current.busy ? "disabled" : ""}>${escapeHtml(current.reason)}</textarea></label>
        <p class="admin-picks-status" role="status" aria-live="polite">${escapeHtml(current.message || (changed ? `Wybrane zmiany: ${changed}. Zapis dotyczy tylko tych meczów.` : "Wybierz typy, które chcesz zmienić."))}</p>
        ${waiting ? `<div class="admin-picks-sync"><p>Typy zapisane, oczekują na synchronizację rankingu: <b>${waiting}</b>. Ponowienie nie zmieni ponownie typów.</p><button type="button" data-admin-picks-retry ${current.busy ? "disabled" : ""}>PONÓW SYNCHRONIZACJĘ</button></div>` : ""}
        ${current.storageWarning ? `<p class="admin-picks-row-error">Przeglądarka nie zachowała listy synchronizacji. Pozostaw to okno otwarte i ponów synchronizację. Po odświeżeniu można odzyskać ją przez odczyt tej kolejki.</p>` : ""}
        <footer class="admin-picks-actions"><button type="button" data-admin-picks-close ${current.busy ? "disabled" : ""}>ZAMKNIJ</button><button type="submit" ${disabled || !changed ? "disabled" : ""}>${current.busy ? "ZAPISYWANIE…" : `ZAPISZ ZMIANY${changed ? ` (${changed})` : ""}`}</button></footer>
      </form>`;
    dialog.scrollTop = scrollTop;
    if (focused) [...dialog.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }

  async function loadRound(matchday) {
    const current = session;
    if (!active(current) || current.busy || !Number.isInteger(matchday) || matchday < 1 || matchday > lastMatchday) return;
    current.matchday = matchday;
    current.loading = true;
    current.message = "";
    const revision = ++generation;
    render();
    const { doc, getDocFromServer } = current.sdk;
    const rows = await Promise.all(getMatches(matchday).map(async (match) => {
      try {
        if (typeof getDocFromServer !== "function") throw new Error("Odczyt z serwera jest niedostępny.");
        const snapshot = await getDocFromServer(doc(current.db, "seasons", "2026-27", "players", current.uid, "picks", match.id));
        const data = snapshot.exists() ? snapshot.data() : null;
        if (data && !PICKS.has(data.pick)) throw new Error("Nieprawidłowy zapis typu. Wymaga sprawdzenia.");
        return { match, loaded: true, pick: data?.pick || "", selected: "", error: "", correctionIdFromServer: data?.correctionId || "", correctionId: "" };
      } catch (error) {
        return { match, loaded: false, pick: "", selected: "", error: error?.message || "Nie udało się odczytać typu." };
      }
    }));
    if (!active(current) || generation !== revision) return;
    current.rows = rows;
    current.loading = false;
    // A committed correction may have lost its HTTP response before the browser
    // could persist a receipt. Its canonical ID is sufficient to recover sync.
    rows.filter((row) => /^[A-Za-z0-9_-]{10,100}$/.test(row.correctionIdFromServer)).forEach((row) => {
      addPending(current, { uid: current.uid, matchId: row.match.id, correctionId: row.correctionIdFromServer });
    });
    render();
    if (pending(current).length) void retrySync();
  }

  async function synchronize(current, item) {
    if (!active(current)) return false;
    const result = await syncCorrection({ uid: item.uid, matchId: item.matchId, correctionId: item.correctionId });
    if (!["synced", "superseded"].includes(result?.status)) throw new Error("Backend nie potwierdził synchronizacji rankingu.");
    removePending(current, item.correctionId);
    if (active(current)) {
      const row = current.rows.find((entry) => entry.match.id === item.matchId);
      if (row && PICKS.has(result.pick)) {
        row.pick = result.pick;
        if (row.syncError) { row.error = ""; row.syncError = false; }
        if (result.status === "superseded") {
          row.error = "W międzyczasie zapisano nowszy typ. Ranking uwzględnia aktualną wersję.";
          row.selected = "";
        }
      }
      onChanged?.({ uid: item.uid, matchId: item.matchId, pick: result.pick });
    }
    return true;
  }

  async function retrySync() {
    const current = session;
    if (!active(current) || current.busy || !pending(current).length) return;
    current.busy = true;
    current.message = "Synchronizujemy zapisane typy z rankingiem…";
    render();
    let failed = 0;
    for (const item of [...pending(current)]) {
      if (!active(current)) break;
      try { await synchronize(current, item); } catch { failed += 1; }
    }
    current.busy = false;
    if (!active(current)) return;
    current.message = failed ? "Część zapisów nadal czeka na synchronizację. Możesz ponowić próbę." : "Ranking został zsynchronizowany z zapisanymi typami.";
    render();
    onComplete?.();
  }

  async function save() {
    const current = session;
    if (!active(current) || current.busy || current.loading) return;
    const reason = current.reason.trim();
    const changed = dirtyRows(current);
    if (!changed.length) return;
    if (reason.length < 5 || reason.length > 500) {
      current.message = "Wpisz powód korekty (od 5 do 500 znaków).";
      render();
      return;
    }
    current.busy = true;
    current.message = "Zapisujemy wybrane korekty…";
    render();
    let saved = 0;
    let failed = 0;
    for (const row of changed) {
      if (!active(current)) break;
      if (!row.correctionId) {
        row.correctionId = crypto.randomUUID();
        row.attemptReason = reason;
      }
      const item = { uid: current.uid, matchId: row.match.id, correctionId: row.correctionId };
      try {
        await saveAdminPickCorrection({ db: current.db, sdk: current.sdk, actorUid: current.actorUid,
          ...item, pick: row.selected, reason: row.attemptReason, expectedPick: row.pick });
        row.pick = row.selected;
        row.selected = "";
        row.error = "";
        row.correctionIdFromServer = row.correctionId;
        saved += 1;
        addPending(current, item);
        if (!active(current)) break;
        onChanged?.({ uid: current.uid, matchId: row.match.id, pick: row.pick });
        try { await synchronize(current, item); }
        catch {
          row.syncError = true;
          row.error = "Typ zapisany. Ranking oczekuje na synchronizację — użyj przycisku poniżej.";
        }
      } catch (error) {
        failed += 1;
        row.error = error?.code === "admin-pick/conflict"
          ? "Typ zmienił się od odczytu. Nie nadpisano go. Odśwież typy i sprawdź ponownie."
          : error?.message || "Nie udało się potwierdzić zapisu korekty. Ponów próbę.";
      }
      if (active(current)) render();
    }
    current.busy = false;
    if (!active(current)) return;
    current.message = `Zapisano korekty: ${saved}.${failed ? ` Nie zapisano: ${failed}. Sprawdź komunikaty przy meczach.` : ""}${pending(current).length ? " Ranking wymaga dokończenia synchronizacji." : saved ? " Ranking zsynchronizowany." : ""}`;
    render();
    onComplete?.();
  }

  return {
    open({ uid, name, matchday }) {
      const context = getContext();
      if (!context || !uid) return;
      mount();
      if (session?.busy) return;
      if (session && session.actorUid === context.actorUid && session.uid === uid) {
        render();
        if (!dialog.open) dialog.showModal();
        if (!dirtyRows(session).length) void loadRound(matchday);
        return;
      }
      session = { ...context, uid, name, matchday, rows: [], reason: "", loading: true, busy: false,
        message: "", storageWarning: false, outbox: readOutbox(context.actorUid) };
      if (!dialog.open) dialog.showModal();
      void loadRound(matchday);
    },
    reset() {
      generation += 1;
      session = null;
      dialog?.close();
      if (dialog) dialog.replaceChildren();
    }
  };
}
