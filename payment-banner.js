const copyButton = document.querySelector("[data-blik-copy]");
const phoneLabel = document.querySelector("[data-blik-phone-label]");
const status = document.querySelector("#blikCopyStatus");
const BLIK_PHONE = "796 590 050";
let statusTimer = null;

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
