import Head from "next/head";

export default function Home() {
  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#08261d" />
        <meta name="description" content="Ekstraklasa Typer 2026/27 — prosty typer 1X2 ze znajomymi." />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Ekstraklasa Typer" />
        <title>Ekstraklasa Typer</title>
        <link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/assets/brand/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="/styles.css" />
      </Head>

      <header className="site-header">
        <a className="brand" href="#mecze" data-route="matches" aria-label="Ekstraklasa Typer — strona główna">
          <span className="brand-mark"><img src="/assets/brand/brand-mark.png" alt="" /></span>
          <span><b>EKSTRAKLASA</b><small>TYPER · 2026/27</small></span>
        </a>
        <nav className="main-nav" aria-label="Główna nawigacja">
          <button className="nav-link is-active" data-view="matches">Mecze</button>
          <button className="nav-link" data-view="ranking">Ranking</button>
          <button className="nav-link" data-view="live">Centrum live <i className="live-dot" /></button>
          <button className="nav-link" data-view="rules">Zasady</button>
        </nav>
        <button id="authButton" className="auth-button"><span className="user-icon">◉</span><span>Zaloguj się</span></button>
        <button id="menuButton" className="menu-button" aria-label="Otwórz menu">☰</button>
      </header>

      <main id="app" tabIndex="-1" />

      <footer>
        <div className="footer-brand"><img src="/assets/brand/brand-mark.png" alt="" /><span>Ekstraklasa Typer</span></div>
        <p>Prywatna zabawa na punkty. Bez zakładów i prawdziwych pieniędzy.</p>
        <span>Sezon 2026/27</span>
      </footer>

      <dialog id="authDialog" className="modal auth-modal">
        <button className="modal-close" data-close aria-label="Zamknij">×</button>
        <img className="modal-logo" src="/assets/ekstraklasa-2026.png" alt="Ekstraklasa" />
        <p className="eyebrow">DOŁĄCZ DO GRY</p>
        <h2>Zaloguj się i typuj</h2>
        <p className="modal-copy">Twoje typy będą dostępne na każdym urządzeniu. Jeden klik i jesteś w grze.</p>
        <button className="provider google" data-provider="google"><span>G</span> Kontynuuj przez Google</button>
        <button className="provider facebook" data-provider="facebook"><span>f</span> Kontynuuj przez Facebook</button>
        <div className="or"><span>lub lokalnie</span></div>
        <button className="provider demo" data-provider="demo">Uruchom konto demonstracyjne</button>
        <small>Logując się, akceptujesz zasady prywatnej ligi.</small>
      </dialog>

      <dialog id="matchDialog" className="modal match-modal" />
      <div id="toast" className="toast" role="status" aria-live="polite" />
      <script type="module" src="/legacy/app.js" />
    </>
  );
}
