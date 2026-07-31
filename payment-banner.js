const copyButton = document.querySelector("[data-blik-copy]");
const phoneLabel = document.querySelector("[data-blik-phone-label]");
const status = document.querySelector("#blikCopyStatus");
const countdown = document.querySelector("[data-entry-fee-countdown]");
const countdownValue = document.querySelector("[data-entry-fee-countdown-value]");
const countdownParts = {
  days: document.querySelector("[data-entry-fee-days]"),
  hours: document.querySelector("[data-entry-fee-hours]"),
  minutes: document.querySelector("[data-entry-fee-minutes]"),
  seconds: document.querySelector("[data-entry-fee-seconds]")
};
const BLIK_PHONE = "796 590 050";
const ENTRY_FEE_DEADLINE = Date.parse("2026-08-03T00:00:00+02:00");
let statusTimer = null;
let countdownTimer = null;

function normalizedPhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

async function copyText(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy-unavailable");
}

function showStatus(message) {
  if (!status) return;
  clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.add("is-visible");
  statusTimer = setTimeout(() => {
    status.classList.remove("is-visible");
    status.textContent = "";
  }, 2400);
}

function polishPlural(value, one, few, many) {
  const normalized = Math.abs(Number(value) || 0);
  const lastTwo = normalized % 100;
  const last = normalized % 10;
  if (normalized === 1) return one;
  if (lastTwo < 12 || lastTwo > 14) {
    if (last >= 2 && last <= 4) return few;
  }
  return many;
}

function updateCountdown() {
  const hasAllParts = Object.values(countdownParts).every(Boolean);
  if (!countdown || !countdownValue || !hasAllParts || !Number.isFinite(ENTRY_FEE_DEADLINE)) return;
  const remainingSeconds = Math.max(0, Math.ceil((ENTRY_FEE_DEADLINE - Date.now()) / 1000));
  if (remainingSeconds <= 0) {
    countdownValue.textContent = "TERMIN MINĄŁ";
    countdown.setAttribute("aria-label", "Termin wpłaty składki minął");
    countdown.classList.add("is-expired");
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    return;
  }

  const days = Math.floor(remainingSeconds / 86400);
  const hours = Math.floor((remainingSeconds % 86400) / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  countdownParts.days.textContent = String(days).padStart(2, "0");
  countdownParts.hours.textContent = String(hours).padStart(2, "0");
  countdownParts.minutes.textContent = String(minutes).padStart(2, "0");
  countdownParts.seconds.textContent = String(seconds).padStart(2, "0");
  countdown.setAttribute(
    "aria-label",
    `Do terminu wpłaty pozostało ${days} ${polishPlural(days, "dzień", "dni", "dni")}, `
      + `${hours} ${polishPlural(hours, "godzina", "godziny", "godzin")}, `
      + `${minutes} ${polishPlural(minutes, "minuta", "minuty", "minut")} i `
      + `${seconds} ${polishPlural(seconds, "sekunda", "sekundy", "sekund")}. `
      + "Termin: 3 sierpnia 2026, godzina 00:00."
  );
}

if (countdown && countdownValue) {
  updateCountdown();
  if (!countdown.classList.contains("is-expired")) {
    countdownTimer = setInterval(updateCountdown, 1000);
  }
}

if (copyButton && phoneLabel) {
  const configuredPhone = String(copyButton.dataset.blikPhone || BLIK_PHONE).trim();
  const phone = normalizedPhone(configuredPhone);
  if (phone) {
    copyButton.dataset.blikPhone = configuredPhone;
    phoneLabel.textContent = configuredPhone;
    copyButton.disabled = false;
  }

  copyButton.addEventListener("click", async () => {
    const currentPhone = normalizedPhone(copyButton.dataset.blikPhone);
    if (!currentPhone) return;
    try {
      await copyText(currentPhone);
      showStatus("Numer skopiowany do schowka");
    } catch {
      showStatus("Nie udało się skopiować numeru");
    }
  });
}
