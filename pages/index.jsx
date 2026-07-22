import Head from "next/head";
import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    if (document.querySelector("script[data-ekstraklasa-runtime]")) return;

    const script = document.createElement("script");
    script.type = "module";
    script.src = "/legacy/app.js?v=20";
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
          <button className="nav-link is-active" data-view="matches">Mecze</button>
          <button className="nav-link" data-view="ranking">Ranking</button>
          <button className="nav-link" data-view="rules">Zasady</button>
          <button className="nav-link" data-view="settings">Ustawienia</button>
        </nav>
        <button id="authButton" className="auth-button"><span className="user-icon">◉</span><span>Zaloguj się</span></button>
        <button id="menuButton" className="menu-button" aria-label="Otwórz menu">☰</button>
      </header>

      <main id="app" tabIndex="-1" />

      <footer>
        <div className="footer-brand"><img src="/assets/brand/logo-compact.png" alt="Ekstraklapa Typer" /></div>
        <p>Typowanie 1X2 · Runda jesienna</p>
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
        <button className="provider signout" data-sign-out>Wyloguj się</button>
      </dialog>

      <dialog id="matchDialog" className="modal match-modal" />
      <div id="toast" className="toast" role="status" aria-live="polite" />
    </>
  );
}
