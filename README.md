# Ekstraklasa Typer 2026/27

Prywatny typer 1X2 dla sezonu Ekstraklasy 2026/27. Każdy poprawny rezultat (`1`, `X` albo `2`) daje 1 punkt. Nie ma typowania dokładnego wyniku ani prawdziwych pieniędzy.

## Uruchomienie lokalne

Wymagany jest Node.js 18 lub nowszy.

```powershell
npm run dev
```

Aplikacja będzie dostępna pod adresem `http://localhost:5173`.

Bez dodatkowej konfiguracji działa pełny interfejs, terminarz, typowanie zapisywane lokalnie i konto demonstracyjne.

## Logowanie Google i Facebook

1. Utwórz aplikację webową w [Firebase Console](https://console.firebase.google.com/).
2. W Authentication włącz dostawców Google i Facebook. Dla Facebooka dodaj App ID i App Secret z Meta for Developers.
3. Wklej dane aplikacji webowej do `firebase-config.js`.
4. Utwórz Firestore i opublikuj reguły z `firestore.rules`.
5. Dodaj `localhost` i późniejszą domenę produkcyjną do Authorized domains.

Gdy `apiKey` jest pusty, przyciski Google i Facebook świadomie przechodzą w lokalny tryb demonstracyjny — dzięki temu frontend można testować bez cudzych kluczy.

## Dane LIVE

Źródłem wyników jest bezterminowo darmowy plan API-Football, liga `106`, sezon `2026`. Klucz pozostaje wyłącznie po stronie serwera.

```powershell
$env:API_FOOTBALL_KEY="TWÓJ_KLUCZ"
npm run dev
```

Na stałe można skopiować `.env.example` jako `.env` i wpisać klucz w tym pliku. `.env` jest ignorowany przez Git i automatycznie wczytywany przy każdym uruchomieniu serwera.

Serwer działa według stałego budżetu 95 z dostępnych 100 zapytań dziennie:

- synchronizuje pełny terminarz najwyżej raz na 7 dni;
- odpytuje wszystkie mecze danego dnia jednym wywołaniem;
- uruchamia polling tylko od 10 minut przed meczem do jego zakończenia;
- aktualizuje wynik mniej więcej co 6 minut;
- zapisuje terminarz, wyniki i licznik zapytań w `.cache/`, dzięki czemu restart nie zeruje lokalnego budżetu;
- udostępnia przeglądarkom wyłącznie własny cache przez `/api/live` — liczba użytkowników nie zwiększa liczby wywołań API-Football.

Frontend sprawdza lokalny cache co 30 sekund. Nie są pobierane gole, kartki, zmiany, kontuzje ani składy.

### Ręczna korekta wyniku

Awaryjny wynik można wpisać do `manual-results.json` pod identyfikatorem meczu z `data.js`. Można też ustawić `ADMIN_RESULT_TOKEN` i użyć chronionego endpointu:

```powershell
$env:ADMIN_RESULT_TOKEN="WŁASNY_DŁUGI_TOKEN"
$headers = @{ "x-admin-token" = $env:ADMIN_RESULT_TOKEN }
$body = @{ matchId = "1-radomiak-wieczysta"; homeScore = 2; awayScore = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:5173/api/admin/result" -Headers $headers -ContentType "application/json" -Body $body
```

Ręczna korekta ma pierwszeństwo przed wynikiem dostawcy. Szczegóły są opisane w `docs/LIVE-DATA.md`.

## Terminarz

- Kolejki 1–17: runda 1.
- Kolejki 18–34: runda 2 (rewanżowa).
- Pełne pary pochodzą z oficjalnego terminarza Ekstraklasy.
- Dokładne godziny pierwszych czterech kolejek są potwierdzone oficjalnie.
- Kolejne spotkania mają datę ramową i są wyraźnie oznaczone jako „godz. do ustalenia”; data ramowa nie blokuje typu.

Po publikacji dokładnych godzin należy uzupełnić mapę `exactKickoffs` w `data.js` lub zastąpić ją synchronizacją z API-Football.

## Co przeniesiono z WC 2026 Buk

Przeniesione zostały wyłącznie sprawdzone wzorce: osobne dane bazowe i nakładka live, blokada typów na podstawie prawdziwego kickoffu, logowanie społecznościowe, zapis własnych typów oraz trzymanie sekretów po stronie serwera. Interfejs, model 1X2, podział sezonu i centrum zdarzeń są zbudowane od nowa dla Ekstraklasy.
