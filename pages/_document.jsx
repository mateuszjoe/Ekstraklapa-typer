import { Head, Html, Main, NextScript } from "next/document";

const loaderCss = `
  html.app-loading, html.app-loading body { min-height: 100%; overflow: hidden; background: #021d15; }
  html.app-loading body > *:not(#appLoader):not(script) { visibility: hidden !important; }
  #appLoader { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; overflow: hidden; color: #fff; background: radial-gradient(circle at 50% 38%, rgba(42, 225, 139, .2), transparent 32%), linear-gradient(145deg, #021a13 0%, #053d2c 100%); font-family: Arial, sans-serif; opacity: 1; visibility: visible; transition: opacity .42s ease, visibility .42s ease; }
  #appLoader::before { content: ""; position: absolute; inset: -30%; opacity: .14; transform: rotate(-12deg); background-image: linear-gradient(rgba(168, 255, 111, .25) 1px, transparent 1px), linear-gradient(90deg, rgba(168, 255, 111, .25) 1px, transparent 1px); background-size: 72px 72px; mask-image: radial-gradient(circle, #000 0%, transparent 62%); }
  #appLoader::after { content: ""; position: absolute; width: min(72vw, 760px); aspect-ratio: 1; border: 1px solid rgba(172, 255, 105, .14); border-radius: 50%; box-shadow: 0 0 0 70px rgba(172, 255, 105, .025), 0 0 0 140px rgba(172, 255, 105, .018); }
  .loader-card { position: relative; z-index: 1; width: min(370px, calc(100vw - 48px)); text-align: center; }
  .loader-emblem { position: relative; width: 112px; height: 112px; margin: 0 auto 30px; padding: 12px; border: 1px solid rgba(255,255,255,.14); border-radius: 31px; background: rgba(255,255,255,.07); box-shadow: 0 24px 70px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.12); backdrop-filter: blur(10px); }
  .loader-emblem::before { content: ""; position: absolute; inset: -10px; border: 2px solid transparent; border-top-color: #a8ff6a; border-right-color: rgba(168,255,106,.28); border-radius: 37px; animation: loader-spin 1.8s linear infinite; }
  .loader-emblem::after { content: ""; position: absolute; right: -12px; top: 50%; width: 7px; height: 7px; margin-top: -4px; border-radius: 50%; background: #a8ff6a; box-shadow: 0 0 18px #a8ff6a; }
  .loader-emblem img { display: block; width: 88px; height: 88px; border-radius: 22px; object-fit: cover; animation: loader-breathe 1.8s ease-in-out infinite; }
  .loader-kicker { margin: 0 0 9px; color: #a8ff6a; font-size: 10px; font-weight: 800; letter-spacing: .24em; }
  .loader-title { display: block; font-size: clamp(24px, 5vw, 31px); line-height: 1; letter-spacing: .055em; }
  .loader-title span { color: #a8ff6a; }
  .loader-copy { margin: 13px 0 24px; color: rgba(255,255,255,.62); font-size: 12px; line-height: 1.5; }
  .loader-track { width: 220px; height: 3px; margin: 0 auto; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.11); }
  .loader-track i { display: block; width: 42%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, transparent, #a8ff6a, #fff); box-shadow: 0 0 14px rgba(168,255,106,.7); animation: loader-progress 1.25s cubic-bezier(.65,0,.35,1) infinite; }
  .loader-status { display: flex; align-items: center; justify-content: center; gap: 5px; margin-top: 13px; color: rgba(255,255,255,.46); font-size: 9px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  .loader-status i { width: 3px; height: 3px; border-radius: 50%; background: #a8ff6a; animation: loader-dot 1.2s ease-in-out infinite; }
  .loader-status i:nth-child(2) { animation-delay: .15s; }
  .loader-status i:nth-child(3) { margin-right: 5px; animation-delay: .3s; }
  html.app-ready #appLoader { opacity: 0; visibility: hidden; pointer-events: none; }
  @keyframes loader-spin { to { transform: rotate(360deg); } }
  @keyframes loader-breathe { 50% { transform: scale(.94); filter: saturate(1.15) brightness(1.06); } }
  @keyframes loader-progress { from { transform: translateX(-115%); } to { transform: translateX(340%); } }
  @keyframes loader-dot { 0%, 70%, 100% { opacity: .25; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-3px); } }
  @media (prefers-reduced-motion: reduce) { .loader-emblem::before, .loader-emblem img, .loader-track i, .loader-status i { animation: none; } }
`;

const loaderFallback = `window.__etLoaderFallback=setTimeout(function(){var root=document.documentElement;root.classList.remove("app-loading");root.classList.add("app-ready");},8000);`;

export default function Document() {
  return (
    <Html lang="pl" className="app-loading">
      <Head>
        <link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/favicon-32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/assets/brand/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="preload" as="image" href="/assets/brand/app-icon-192.png" />
        <style dangerouslySetInnerHTML={{ __html: loaderCss }} />
        <link rel="stylesheet" href="/styles.css" />
      </Head>
      <body>
        <div id="appLoader" role="status" aria-live="polite" aria-label="Wczytywanie Ekstraklasa Typer">
          <div className="loader-card">
            <div className="loader-emblem"><img src="/assets/brand/app-icon-192.png" width="88" height="88" alt="" /></div>
            <p className="loader-kicker">SEZON 2026/27</p>
            <strong className="loader-title">EKSTRAKLASA <span>TYPER</span></strong>
            <p className="loader-copy">Przygotowujemy mecze i Twoje typy</p>
            <div className="loader-track" aria-hidden="true"><i /></div>
            <div className="loader-status" aria-hidden="true"><i /><i /><i />Wczytywanie</div>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: loaderFallback }} />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
