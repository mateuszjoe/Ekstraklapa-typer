// Publiczna konfiguracja osobnego projektu Firebase dla Ekstraklapa Typer.
// Bezpieczeństwo danych zapewniają reguły z firestore.rules, nie ukrywanie apiKey.
export const firebaseConfig = {
  apiKey: "AIzaSyD3kgRWw3BROjcmulITWFXKcePgvhtpIDY",
  authDomain: "ekstraklasa-typer-2026-27.firebaseapp.com",
  projectId: "ekstraklasa-typer-2026-27",
  storageBucket: "ekstraklasa-typer-2026-27.firebasestorage.app",
  messagingSenderId: "400732734545",
  appId: "1:400732734545:web:8711cb73b12cc23b2f6470"
};

export const webPushPublicKey = "BHxWAMhHw3KJBpTqgJZK38Kr-fPA_dvKIYurfBjxTfuw9ie4D9I0cpYR8S9-5FEmzDYoLoBwdutcR_kLW7cADd0";

// Publiczny adres bezpłatnego backendu powiadomień Cloudflare.
export const notificationApiBase = "https://ekstraklapa-typer-notifications.mateuszjoe.workers.dev";

export const adminEmails = [];
