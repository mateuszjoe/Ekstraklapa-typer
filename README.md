<p align="center">
  <img src="assets/brand/logo-horizontal.png" width="520" alt="Ekstraklapa Typer" />
</p>

# Ekstraklapa Typer 2026/27

Typer 1X2 dla rundy jesiennej sezonu Ekstraklasy 2026/27. Każdy poprawny rezultat (`1`, `X` albo `2`) daje 1 punkt. Nie ma typowania dokładnego wyniku.

## Uruchomienie lokalne

Wymagany jest Node.js 18 lub nowszy.

```powershell
npm run dev
```

Aplikacja będzie dostępna pod adresem `http://localhost:5173`.

Pełny interfejs i terminarz są dostępne publicznie. Oddawanie typów wymaga zalogowania prawdziwym kontem Google.

Po publikacji przez HTTPS aplikację można dodać do ekranu głównego telefonu. Manifest wykorzystuje osobne ikony 192 × 192 i 512 × 512, a urządzenia Apple plik 180 × 180.

## Aplikacja na Androida

Podpisany APK jest publikowany jako wydanie GitHuba oraz bezpośrednio na GitHub Pages. Można go pobrać z popupu na Androidzie albo ze stałego przycisku w stopce. Aktualna wersja: `1.0.2` (`pl.ekstraklapatyper.app`).

Bezpośrednie pobieranie:

`https://mateuszjoe.github.io/Ekstraklapa-typer/downloads/Typer-v1.0.2.apk`

Projekt źródłowy znajduje się w `android/`, a podpisany build wykonuje `.github/workflows/android-apk.yml`. Klucz wydaniowy i jego hasło są przechowywane wyłącznie jako sekrety GitHuba oraz w ignorowanym katalogu `.local-secrets/`. Kolejne wydania muszą zachować package ID i klucz oraz zwiększać `versionCode`.

## Logowanie Google

Aplikacja korzysta z osobnego projektu Firebase `ekstraklasa-typer-2026-27`. Publiczna konfiguracja aplikacji webowej znajduje się w `firebase-config.js`, a dostawca Google jest zarządzany jako kod w `firebase.json`.

- domena produkcyjna `mateuszjoe.github.io` i `localhost` muszą znajdować się w Firebase Authentication → Authorized domains;
- typy zalogowanego gracza zapisują się w Firestore i synchronizują między urządzeniami;
- kliknięcie avatara w rankingu, oknie konta lub chacie otwiera typy gracza z zakładkami kolejek 1–17; cudze typy są dostępne dopiero od serwerowej godziny rozpoczęcia meczu;
- nazwę gracza można zmienić w ustawieniach, a profil synchronizuje ją między urządzeniami;
- avatar profilu można ustawić jako zdjęcie Google, własną pomniejszoną grafikę, herb klubu albo jeden z gotowych avatarów;
- pływający chat graczy działa w czasie rzeczywistym i obsługuje odpowiedzi, reakcje oraz automatycznie pomniejszone grafiki;
- pełne powiadomienia Web Push są przypisane do urządzenia i docierają również po zamknięciu strony lub aplikacji; obejmują chat, nowych graczy, przypomnienia o kolejce, opublikowane składy, wynik i punkt za mecz oraz podsumowanie kolejki;
- licznik uczestników jest zwiększany transakcyjnie tylko raz dla danego konta Google, a sekcja zasad wylicza aktualną pulę i trzy nagrody;
- dostęp do dokumentów zabezpieczają reguły z `firestore.rules`;
- Facebook nie jest używany jako dostawca logowania.

Konfigurację podstawowego backendu wdraża się poleceniami `firebase deploy --only auth` oraz `firebase deploy --only firestore:rules`.

### Backend powiadomień

Produkcyjny backend działa bez Firebase Functions i planu Blaze. Kod znajduje się w `notifications-worker/`, konfiguracja w `notifications-wrangler.jsonc`, a bezpłatny Cloudflare Worker korzysta z D1, crona oraz Cloudflare Queue. Żądania strony tylko weryfikują dane i zapisują zadanie, natomiast szyfrowanie oraz wysyłka Web Push odbywają się asynchronicznie w consumerze kolejki. Worker sprawdza token Firebase i prawdziwe dokumenty uczestnika, typu oraz wiadomości w Firestore. Trwała kolejka D1, dzierżawy i tabela dostarczeń zapobiegają pomijaniu odbiorców oraz niekontrolowanym duplikatom.

Publiczny klucz VAPID znajduje się w `firebase-config.js` i Workerze. Prywatny klucz pozostaje wyłącznie w ignorowanym katalogu `.local-secrets/` i zaszyfrowanych sekretach Cloudflare. Pierwsze wdrożenie:

```powershell
npm install
npx wrangler queues create ekstraklasa-typer-notifications --config notifications-wrangler.jsonc
npx wrangler d1 execute ekstraklasa-typer-notifications --remote --file notifications-worker/schema.sql --config notifications-wrangler.jsonc
npx wrangler secret put VAPID_PRIVATE_KEY --config notifications-wrangler.jsonc
npx wrangler deploy --config notifications-wrangler.jsonc
```

Endpoint rejestracji wymaga zalogowanego, zweryfikowanego konta Google i uczestnictwa w sezonie. Typy trafiają do D1 dopiero po porównaniu z własnym dokumentem w Firestore, a wiadomość chatu może zgłosić wyłącznie jej autor.

Potwierdzone terminy, na których Firestore opiera zamykanie i odkrywanie typów, synchronizuje administrator:

```powershell
npm run sync:schedule
```

Skrypt korzysta z zalogowanej sesji Firebase CLI i nie zapisuje żadnych sekretów w repozytorium. Jednorazową migrację starego układu dokumentów wykonuje `npm run migrate:picks`.

## Dane LIVE

Wyniki pochodzą z publicznego API oficjalnego Centrum Meczowego Ekstraklasy. Kanał nie wymaga klucza, konta ani płatnego planu. Aplikacja mapuje wyłącznie 153 mecze rundy jesiennej (kolejki 1–17).

- na GitHub Pages przeglądarka korzysta bezpośrednio z oficjalnego kanału CORS; lokalny serwer nadal udostępnia kompatybilny adapter `/api/live`;
- podczas meczów dane są odświeżane co 45 sekund, a poza nimi co 5 minut;
- zakończone wyniki są odświeżane co najwyżej co 5 minut, a bieżąca i poprzednia kolejka stanowią świeżą nakładkę;
- równoczesne odświeżenia są łączone w jedno zapytanie;
- po chwilowej awarii przez maksymalnie 5 minut dostępny jest ostatni poprawny zapis; starszy status LIVE jest wygaszany;
- blok LIVE pojawia się na głównej stronie wyłącznie podczas meczu;
- nie są pobierane gole, kartki, zmiany ani kontuzje; oficjalne składy są pobierane osobnym, cache'owanym kanałem dopiero przed meczem.

Źródło jest publiczne i używane przez oficjalną stronę ligi, ale nie ma opublikowanego SLA. Adapter jest odseparowany od interfejsu, aby można go było podmienić bez przebudowy typowania. Szczegóły są opisane w `docs/LIVE-DATA.md`.

### Tabela, drużyny i składy

Zakładka `Ekstraklasa` korzysta z wydzielonego adaptera `league-provider.js`. Pokazuje oficjalną tabelę, terminarz, formę i ostatnie wyniki każdej drużyny oraz centrum meczu ze składami. Nazwy i herby prowadzą do trwałych adresów `#ekstraklasa/druzyna/...`, a mecze do `#ekstraklasa/mecz/...`; pozostałe widoki również mają własne adresy, więc odświeżenie i cofanie nie zmieniają bieżącej podstrony.

Worker od 120 minut przed pierwszym gwizdkiem sprawdza oficjalny kanał składów. Skład zostaje uznany za opublikowany dopiero po potwierdzeniu dwóch różnych drużyn i 11 unikalnych zawodników podstawowych po każdej stronie. Pierwsza poprawna publikacja jest zapisywana w D1 i uruchamia jedno powiadomienie Web Push na gracza; późniejsze korekty aktualizują widok bez ponownego alarmu.

### Oceny zawodników

Gotowa ocena każdego występu pochodzi z udokumentowanego endpointu API-Football `/fixtures/players`. Typer nie tworzy własnej oceny. Worker pobiera dane dopiero po zakończeniu meczu, zapisuje je w D1 i dla zawodnika oblicza zwykłą średnią z maksymalnie pięciu ostatnich ocenionych występów. Przy mniejszej próbie interfejs pokazuje jej wielkość, np. `7,2 (3 w.)`; po pięciu występach pokazuje samo `7,2`.

Ruch użytkowników nie wywołuje zapytań do API-Football. Jedna kolejka wymaga zwykle jednego pobrania szczegółów na zakończony mecz, a trwały licznik D1 zatrzymuje Workera przed przekroczeniem bezpłatnego limitu. Produkcyjny klucz musi być zapisany wyłącznie jako sekret Cloudflare:

```powershell
npx wrangler d1 execute DB --remote --file notifications-worker/migrations/0002_api_football_ratings.sql --config notifications-wrangler.jsonc
npx wrangler secret put API_FOOTBALL_KEY --config notifications-wrangler.jsonc
npx wrangler deploy --config notifications-wrangler.jsonc
```

Lokalnie klucz można umieścić w ignorowanym pliku `.env` zgodnie z `.env.example`. API-Football jest zewnętrznym dostawcą, a nie oficjalnym partnerem Ekstraklasy; dostępność ocen zależy od pokrycia danego meczu i planu dostawcy.

### Ręczna korekta wyniku

W lokalnym serwerze Node awaryjny wynik można wpisać do `manual-results.json` pod identyfikatorem meczu z `data.js`. Można też ustawić `ADMIN_RESULT_TOKEN` i użyć chronionego endpointu:

```powershell
$env:ADMIN_RESULT_TOKEN="WŁASNY_DŁUGI_TOKEN"
$headers = @{ "x-admin-token" = $env:ADMIN_RESULT_TOKEN }
$body = @{ matchId = "1-radomiak-wieczysta"; homeScore = 2; awayScore = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:5173/api/admin/result" -Headers $headers -ContentType "application/json" -Body $body
```

Ręczna korekta ma pierwszeństwo przed wynikiem dostawcy w lokalnym serwerze. Statyczna wersja GitHub Pages nie ma jeszcze trwałego panelu korekt — przed rozgrywką komercyjną należy dodać chronione, trwałe źródło administracyjne. Szczegóły są opisane w `docs/LIVE-DATA.md`.

## Publikacja na GitHub Pages

Strona jest publikowana wprost z gałęzi `main`, z katalogu głównego repozytorium — tak samo jak `WC2026Buk`. Nie wymaga osobnego builda po stronie GitHub Pages. Plik `.nojekyll` wyłącza przetwarzanie Jekyll i pozostawia wszystkie zasoby bez zmian.

Adres produkcyjny:

`https://mateuszjoe.github.io/Ekstraklapa-typer/`

## Terminarz

- Kolejki 1–17: runda jesienna.
- Wszystkie 153 mecze pochodzą z oficjalnego terminarza Ekstraklasy.
- Dokładne godziny pierwszych czterech kolejek są potwierdzone oficjalnie.
- Kolejne spotkania mają datę ramową i są wyraźnie oznaczone jako „godz. do ustalenia”; typowanie uruchamia się dopiero po potwierdzeniu dokładnej godziny.

Po publikacji dokładnych godzin należy uzupełnić mapę `exactKickoffs` w `data.js` i wykonać `npm run sync:schedule`; zalogowane konto administratora synchronizuje też nowe oficjalne terminy otrzymane z kanału LIVE.

## Co przeniesiono z WC 2026 Buk

Przeniesione zostały wyłącznie sprawdzone wzorce: osobne dane bazowe i nakładka live, blokada typów na podstawie prawdziwego kickoffu, logowanie społecznościowe oraz zapis własnych typów. Interfejs, model 1X2, zakres rundy jesiennej i prezentacja wyników LIVE są zbudowane od nowa dla Ekstraklasy.
