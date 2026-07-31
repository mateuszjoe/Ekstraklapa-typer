import Head from "next/head";
import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    if (!document.querySelector("script[data-payment-banner-runtime]")) {
      const paymentScript = document.createElement("script");
      paymentScript.type = "module";
      paymentScript.src = "/payment-banner.js?v=1";
      paymentScript.dataset.paymentBannerRuntime = "true";
      document.body.appendChild(paymentScript);
    }
    if (!document.querySelector("script[data-ekstraklasa-runtime]")) {
      const script = document.createElement("script");
      script.type = "module";
      script.src = "/app.js?v=39";
      script.dataset.ekstraklasaRuntime = "true";
      document.body.appendChild(script);
    }
  }, []);

  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#0d0d0d" />
        <meta name="description" content="Ekstraklapa Typer 2026/27 — typowanie 1X2 rundy jesiennej ze znajomymi." />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Ekstraklapa Typer" />
        <title>Ekstraklapa Typer</title>
      </Head>

      <header className="site-header">
        <a className="brand" href="#matches" data-route="matches" aria-label="Ekstraklapa Typer — strona główna">
          <img className="brand-logo" src="/assets/brand/logo-horizontal.png" alt="" />
        </a>
        <nav className="main-nav" aria-label="Główna nawigacja">
          <a href="#matches/1" className="nav-link is-active" data-view="matches">Mecze</a>
          <a href="#ekstraklasa" className="nav-link" data-view="ekstraklasa">Ekstraklasa</a>
          <a href="#ranking" className="nav-link" data-view="ranking">Ranking</a>
          <a href="#rules" className="nav-link" data-view="rules">Zasady</a>
          <a href="#settings" className="nav-link" data-view="settings">Ustawienia</a>
          <a href="#admin" className="nav-link nav-admin" data-view="admin" data-admin-nav hidden>Panel admina <span className="nav-admin-badge" data-admin-badge hidden>0</span></a>
          <div className="nav-account-summary" hidden><span>Zalogowano jako</span><strong id="mobileAccountName">Gracz</strong></div>
          <button type="button" className="nav-link nav-signout" data-sign-out hidden>Wyloguj się</button>
        </nav>
        <button id="authButton" className="auth-button"><span className="user-icon">◉</span><span>Zaloguj się</span></button>
        <button id="menuButton" className="menu-button" aria-label="Otwórz menu">☰</button>
      </header>

      <aside className="blik-payment-banner" aria-labelledby="blikPaymentTitle">
        <div className="blik-payment-banner__inner">
          <span className="blik-payment-banner__mark" aria-hidden="true">BLIK</span>
          <div className="blik-payment-banner__copy">
            <strong id="blikPaymentTitle">Pozostań w grze</strong>
            <span>Wpłać <b>100 zł</b> BLIK na telefon</span>
          </div>
          <button
            type="button"
            className="blik-payment-banner__phone"
            data-blik-copy
            data-blik-phone=""
            aria-label="Skopiuj numer telefonu do przelewu BLIK"
            aria-describedby="blikCopyStatus"
            disabled
          >
            <span className="blik-payment-banner__phone-label">Numer telefonu</span>
            <strong data-blik-phone-label>—</strong>
            <span className="blik-payment-banner__copy-action">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="8" y="8" width="11" height="11" rx="2" />
                <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
              </svg>
              Kopiuj
            </span>
          </button>
          <span id="blikCopyStatus" className="blik-payment-banner__status" role="status" aria-live="polite" />
        </div>
      </aside>

      <main id="app" tabIndex="-1" />

      <footer>
        <div className="footer-brand"><img src="/assets/brand/logo-compact.png" alt="Ekstraklapa Typer" /></div>
        <p>Typowanie 1X2 · Runda jesienna</p>
        <a className="footer-app-download" href="/downloads/Typer-v1.0.2.apk" download="Typer-v1.0.2.apk" type="application/vnd.android.package-archive">Pobierz aplikację na Android</a>
        <span>Sezon 2026/27</span>
      </footer>

      <dialog id="authDialog" className="modal auth-modal">
        <button className="modal-close" data-close aria-label="Zamknij">×</button>
        <img className="modal-logo" src="/assets/brand/logo-compact.png" alt="Ekstraklapa Typer" />
        <p className="eyebrow">DOŁĄCZ DO GRY</p>
        <h2>Zaloguj się i typuj</h2>
        <p className="modal-copy">Twoje typy będą dostępne na każdym urządzeniu. Jeden klik i jesteś w grze.</p>
        <button className="provider google" data-provider="google"><span>G</span> Kontynuuj przez Google</button>
        <small>Logując się, akceptujesz zasady prywatnej ligi.</small>
      </dialog>

      <dialog id="accountDialog" className="modal auth-modal account-modal">
        <button className="modal-close" data-close aria-label="Zamknij">×</button>
        <img className="modal-logo" src="/assets/brand/logo-compact.png" alt="Ekstraklapa Typer" />
        <div id="accountAvatar" className="account-avatar-host" />
        <p className="eyebrow">TWOJE KONTO</p>
        <h2 id="accountName">Gracz</h2>
        <p className="modal-copy" id="accountDetails">Zalogowano przez Google</p>
        <button className="provider account-settings" data-account-settings>Ustawienia profilu</button>
        <button className="provider account-admin" data-account-admin hidden>Panel administratora</button>
        <button className="provider signout" data-sign-out>Wyloguj się</button>
      </dialog>

      <dialog id="matchDialog" className="modal match-modal" />
      <div id="toast" className="toast" role="status" aria-live="polite" />
    </>
  );
}
