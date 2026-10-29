# Automatyczny terminarz typowania

Przeglądarka pobiera oficjalne terminy, ale Firestore zamyka i odkrywa typy według dokumentów `seasons/2026-27/matches/{matchId}`. Brak takiego dokumentu oznacza odmowę zapisu typu. Synchronizacja tych dokumentów musi działać w backendzie również wtedy, gdy administrator nie otwiera strony.

## Tożsamość backendu

Synchronizator używa osobnego konta Firebase Auth `trusted-schedule-sync-2026-27` z flagą `scheduleSync: true` i dostawcą logowania `custom`. Reguły Firestore ograniczają to konto do pól terminarza. Konto nie jest uczestnikiem gry, nie ma dostępu do typów, profili, rankingu ani chatu. Jego dane nie są dodawane do kolekcji graczy.

Cloudflare przechowuje wyłącznie sekret `FIREBASE_SCHEDULE_REFRESH_TOKEN`. Worker wymienia go na krótkotrwały Firebase ID token. Nie otrzymuje sesji administratora, prywatnego klucza konta usługowego ani roli IAM umożliwiającej dostęp do całej bazy.

## Jednorazowe przygotowanie

Wymagane są zalogowane Firebase CLI i Wrangler oraz zainstalowane zależności projektu. Najpierw sprawdź dostęp:

```powershell
node scripts/provision-schedule-sync.cjs --check
```

Polecenie sprawdza obecność konta automatu, nazwy sekretów Workera i możliwość przygotowania dedykowanego konta podpisującego. Nie tworzy konta, tokenu ani sekretu. Opcjonalne `--wrangler` wskazuje zainstalowany plik `wrangler.js`.

Po przeglądzie zakresu zmian:

```powershell
node scripts/provision-schedule-sync.cjs --provision
```

Skrypt odmawia działania, gdy UID należy do konta człowieka lub konto jest wyłączone. Tworzy lub ponownie wykorzystuje wyłącznie oznaczone konto usługowe `typer-schedule-bootstrap`, bez ról IAM na projekcie i bez prywatnego klucza. Odmawia jego użycia, jeśli wykryje przypisaną rolę projektową. Dodaje bieżącemu administratorowi tymczasową rolę `roles/iam.serviceAccountTokenCreator` wyłącznie na tym koncie. Zdalnie podpisuje jednorazowy, pięciominutowy custom token, po czym usuwa dodany wpis w bloku `finally` i potwierdza usunięcie odczytem polityki IAM. Inne wpisy i aktualny `etag` pozostają zachowane, także przy równoległej zmianie polityki.

Następnie tworzy oznaczone konto Firebase Auth, ustawia wyłącznie jego rolę, wymienia custom token na sesję i przekazuje refresh token do `wrangler secret put` przez stdin. Wartości tokenów nie trafiają do argumentów procesu, plików ani wyjścia. Istniejącego sekretu nie nadpisuje automatycznie. Wyłączona dodatkowa usługa IAM Credentials może być obsłużona jednorazowym podpisem przez istniejący endpoint IAM; oba wymagają tego samego uprawnienia i używają klucza zarządzanego przez Google.

Do przygotowania potrzebne są prawa administratora do utworzenia konta usługowego i modyfikacji jego polityki IAM. Skrypt nie przyznaje ról dostępu do danych ani trwałej roli człowiekowi. Brak odpowiednich uprawnień lub wygasła sesja Cloudflare przerywają przygotowanie przed zmianami. Jeśli nie uda się potwierdzić usunięcia tymczasowego wpisu IAM, skrypt kończy się błędem i wymaga sprawdzenia polityki `typer-schedule-bootstrap`; nie kontynuuje wtedy wymiany tokenu ani konfiguracji Workera.

Następnie wdroż reguły i Worker zgodnie z konfiguracją projektu. Potwierdź jego stan synchronizacji oraz odczytaj dokumenty terminów z Firestore. Samo istnienie sekretu nie dowodzi, że harmonogram działa.

## Odwołanie dostępu

Wyłączenie konta automatu lub odwołanie jego sesji w Firebase blokuje odświeżanie ID tokenów. Usunięcie sekretu Workera zatrzymuje dalsze uwierzytelnianie. Zmiana dotyczy tylko automatu; nie wymaga zmiany kont użytkowników.

Dokumentacja dostawcy: [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth), [custom tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens), [IAM Credentials signBlob](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/signBlob).
