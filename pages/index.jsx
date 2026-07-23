import Head from "next/head";
import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    if (document.querySelector("script[data-ekstraklasa-runtime]")) return;

    const script = document.createElement("script");
    script.type = "module";
    script.src = "/legacy/app.js?v=29";
    script.dataset.ekstraklasaRuntime = "true";
    document.body.appendChild(script);
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
