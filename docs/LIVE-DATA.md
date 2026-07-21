# Wyniki LIVE bez klucza API

Stan weryfikacji: 21 lipca 2026.

## Źródło

Aplikacja korzysta z publicznego API oficjalnego Centrum Meczowego Ekstraklasy:

- `GET https://api.centrum-meczowe.ekstraklasa.org/v1/seasons/current`
- `GET https://api.centrum-meczowe.ekstraklasa.org/v1/matches`

To ten sam kanał, którego używa oficjalna strona `ekstraklasa.org`. Zwraca 306 meczów całego sezonu 2026/27 oraz statusy `fixture`, `playing`, `played`, `postponed`, `suspended`, `cancelled` i `awarded`. Typer filtruje ten feed do 153 meczów rundy jesiennej, czyli kolejek 1–17. Kanał nie wymaga klucza, konta ani płatnego planu. Nie jest jednak udokumentowaną usługą z gwarancją SLA, dlatego cała integracja jest zamknięta w adapterze i może zostać później wymieniona.

Projekt pobiera tylko dane potrzebne typerowi: termin, status i wynik. Nie pobiera zdarzeń, składów, strzelców, kartek ani zmian.

## Ograniczanie ruchu

1. `/api/live` składa odpowiedź z historycznych wyników, bieżącej kolejki oraz ewentualnych meczów ze statusem `playing`.
2. Zakończone wyniki są cache'owane przez 5 minut; świeża bieżąca i poprzednia kolejka oraz mecze LIVE są nakładane na ten zapis.
3. Podczas okna meczowego wynik odpowiedzi jest współdzielony przez 45 sekund, a poza nim przez 5 minut.
4. Nagłówek `s-maxage` pozwala cache'owi produkcyjnemu obsłużyć wielu graczy jedną kopią odpowiedzi.
5. Równoczesne odświeżenia w tej samej instancji są łączone w jedno zapytanie.
6. Po chwilowej awarii przez maksymalnie 5 minut może zostać zwrócony ostatni poprawny zapis. Potem stary status `LIVE` zmienia się na `SUSP`, aby mecz nie wisiał jako trwający bez końca.
7. Przeglądarka odpytuje wyłącznie własne `/api/live`, nigdy zewnętrzne API bezpośrednio.

## Mapowanie statusów

- `fixture` → `NS`
- `playing` → `LIVE`
- `played` → `FT`
- `awarded` → `AWD`
- `postponed` → `PST`
- `suspended` → `SUSP`
- `cancelled` → `CANC`

Blok LIVE na stronie głównej pojawia się tylko wtedy, gdy co najmniej jeden mecz ma status `LIVE`. Poza meczem nie jest wyświetlany pusty ekran ani komunikat techniczny.

## Dlaczego nie ESPN

W bezpośrednim teście endpoint `site.api.espn.com/apis/site/v2/sports/soccer/pol.1/scoreboard` zwracał HTTP 400. Katalog lig ESPN nie zawierał Ekstraklasy, a zbiorczy feed nie zawierał meczów pierwszej kolejki sezonu 2026/27. ESPN nie jest więc obecnie źródłem danych tej aplikacji.

## Kontrakt `/api/live`

Odpowiedź zawiera:

- `fixtures` — zakończone mecze, bieżąca kolejka i aktualnie trwające spotkania wyłącznie z rundy jesiennej;
- `mode` — `waiting`, `live-polling`, `stale` albo `degraded`;
- `provider` — `ekstraklasa-match-center`;
- `updatedAt`, `nextPollAt` i `pollIntervalSeconds`;
- neutralny kod błędu w razie czasowej niedostępności źródła.
