<p align="center">
  <img src="assets/brand/logo-horizontal.png" width="520" alt="Ekstraklasa Typer" />
</p>

# Ekstraklasa Typer 2026/27

Typer 1X2 dla sezonu Ekstraklasy 2026/27. Każdy poprawny rezultat (`1`, `X` albo `2`) daje 1 punkt. Nie ma typowania dokładnego wyniku.

## Uruchomienie lokalne

Wymagany jest Node.js 18 lub nowszy.

```powershell
npm run dev
```

Aplikacja będzie dostępna pod adresem `http://localhost:5173`.

Pełny interfejs i terminarz są dostępne publicznie. Oddawanie typów wymaga zalogowania prawdziwym kontem Google.

Po publikacji przez HTTPS aplikację można dodać do ekranu głównego telefonu. Manifest wykorzystuje osobne ikony 192 × 192 i 512 × 512, a urządzenia Apple plik 180 × 180.

## Logowanie Google

Aplikacja korzysta z osobnego projektu Firebase `ekstraklasa-typer-2026-27`. Publiczna konfiguracja aplikacji webowej znajduje się w `firebase-config.js`, a dostawca Google jest zarządzany jako kod w `firebase.json`.

- domena produkcyjna `ekstraklasa-typer.mateuszjoe.chatgpt.site` i `localhost` muszą znajdować się w Firebase Authentication → Authorized domains;
- typy zalogowanego gracza zapisują się w Firestore i synchronizują między urządzeniami;
- kliknięcie avatara w rankingu, oknie konta lub chacie otwiera typy gracza z zakładkami kolejek 1–34; cudze typy są dostępne dopiero od serwerowej godziny rozpoczęcia meczu;
- avatar profilu można ustawić jako zdjęcie Google, własną pomniejszoną grafikę, herb klubu albo jeden z gotowych avatarów;
- pływający chat graczy działa w czasie rzeczywistym i obsługuje odpowiedzi, reakcje oraz automatycznie pomniejszone grafiki;
- licznik uczestników jest zwiększany transakcyjnie tylko raz dla danego konta Google, a sekcja zasad wylicza aktualną pulę i trzy nagrody;
- dostęp do dokumentów zabezpieczają reguły z `firestore.rules`;
- Facebook nie jest używany jako dostawca logowania.

Konfigurację backendu wdraża się poleceniami `firebase deploy --only auth` oraz `firebase deploy --only firestore:rules`.

Potwierdzone terminy, na których Firestore opiera zamykanie i odkrywanie typów, synchronizuje administrator:

```powershell
npm run sync:schedule
```

Skrypt korzysta z zalogowanej sesji Firebase CLI i nie zapisuje żadnych sekretów w repozytorium. Jednorazową migrację starego układu dokumentów wykonuje `npm run migrate:picks`.

## Dane LIVE

Wyniki pochodzą z publicznego API oficjalnego Centrum Meczowego Ekstraklasy. Kanał nie wymaga klucza, konta ani płatnego planu. Aplikacja pobiera historyczne wyniki, bieżącą kolejkę oraz wszystkie trwające spotkania, mapuje je do własnego terminarza i udostępnia graczom przez `/api/live`.

- podczas meczów odpowiedzi są współdzielone przez cache przez 45 sekund, a poza nimi przez 5 minut;
- zakończone wyniki są odświeżane co najwyżej co 5 minut, a bieżąca i poprzednia kolejka stanowią świeżą nakładkę;
- równoczesne odświeżenia są łączone w jedno zapytanie;
- po chwilowej awarii przez maksymalnie 5 minut dostępny jest ostatni poprawny zapis; starszy status LIVE jest wygaszany;
- blok LIVE pojawia się na głównej stronie wyłącznie podczas meczu;
- nie są pobierane gole, kartki, zmiany, kontuzje ani składy.

Źródło jest publiczne i używane przez oficjalną stronę ligi, ale nie ma opublikowanego SLA. Adapter jest odseparowany od interfejsu, aby można go było podmienić bez przebudowy typowania. Szczegóły są opisane w `docs/LIVE-DATA.md`.

### Ręczna korekta wyniku

W lokalnym serwerze Node awaryjny wynik można wpisać do `manual-results.json` pod identyfikatorem meczu z `data.js`. Można też ustawić `ADMIN_RESULT_TOKEN` i użyć chronionego endpointu:

```powershell
$env:ADMIN_RESULT_TOKEN="WŁASNY_DŁUGI_TOKEN"
$headers = @{ "x-admin-token" = $env:ADMIN_RESULT_TOKEN }
$body = @{ matchId = "1-radomiak-wieczysta"; homeScore = 2; awayScore = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:5173/api/admin/result" -Headers $headers -ContentType "application/json" -Body $body
```

Ręczna korekta ma pierwszeństwo przed wynikiem dostawcy. Wersja produkcyjna na Cloudflare nie ma jeszcze trwałego panelu korekt — przed rozgrywką komercyjną należy dodać chronione, trwałe źródło administracyjne. Szczegóły są opisane w `docs/LIVE-DATA.md`.

## Terminarz

- Kolejki 1–17: runda 1.
- Kolejki 18–34: runda 2 (rewanżowa).
- Pełne pary pochodzą z oficjalnego terminarza Ekstraklasy.
- Dokładne godziny pierwszych czterech kolejek są potwierdzone oficjalnie.
- Kolejne spotkania mają datę ramową i są wyraźnie oznaczone jako „godz. do ustalenia”; typowanie uruchamia się dopiero po potwierdzeniu dokładnej godziny.

Po publikacji dokładnych godzin należy uzupełnić mapę `exactKickoffs` w `data.js` i wykonać `npm run sync:schedule`; zalogowane konto administratora synchronizuje też nowe oficjalne terminy otrzymane z kanału LIVE.

## Co przeniesiono z WC 2026 Buk

Przeniesione zostały wyłącznie sprawdzone wzorce: osobne dane bazowe i nakładka live, blokada typów na podstawie prawdziwego kickoffu, logowanie społecznościowe oraz zapis własnych typów. Interfejs, model 1X2, podział sezonu i prezentacja wyników LIVE są zbudowane od nowa dla Ekstraklasy.
