# Wyniki LIVE bez klucza API

Stan weryfikacji: 21 lipca 2026.

## Źródło

Aplikacja korzysta z publicznego API oficjalnego Centrum Meczowego Ekstraklasy:

- `GET https://api.centrum-meczowe.ekstraklasa.org/v1/seasons/current`
- `GET https://api.centrum-meczowe.ekstraklasa.org/v1/matches`
- `GET https://api.centrum-meczowe.ekstraklasa.org/v1/team_season_standings`
- `GET https://api.centrum-meczowe.ekstraklasa.org/v1/match_details/lineups/{matchId}`

To ten sam kanał, którego używa oficjalna strona `ekstraklasa.org`. Zwraca 306 meczów całego sezonu 2026/27 oraz statusy `fixture`, `playing`, `played`, `postponed`, `suspended`, `cancelled` i `awarded`. Typer filtruje ten feed do 153 meczów rundy jesiennej, czyli kolejek 1–17. Kanał nie wymaga klucza, konta ani płatnego planu. Nie jest jednak udokumentowaną usługą z gwarancją SLA, dlatego cała integracja jest zamknięta w adapterze i może zostać później wymieniona.

Kanał LIVE pobiera tylko termin, status i wynik. Osobny adapter ligi pobiera tabelę i oficjalne składy, ale nadal nie pobiera strzelców, kartek, zmian, kontuzji ani innych zdarzeń meczowych.

## Tabela i składy

`league-provider.js` normalizuje pełny sezon do lokalnych identyfikatorów 18 klubów. Odpowiedź ligi zawiera 306 unikalnych spotkań, aktualną tabelę i formę z pięciu ostatnich wyników. Frontend używa cache'u pięciominutowego i w pierwszej kolejności odpytuje Cloudflare Worker; bezpośredni kanał CORS jest awaryjnym fallbackiem.

Składy są sprawdzane serwerowo od 120 minut przed rozpoczęciem meczu. Odpowiedź jest publikowana w aplikacji dopiero, gdy obie drużyny mają po 11 unikalnych zawodników z miejscami formacji 1–11. Worker zapisuje pierwszą publikację w D1, deduplikuje powiadomienia i wygasza je najpóźniej wraz z pierwszym gwizdkiem.

## Ograniczanie ruchu

1. Wersja GitHub Pages korzysta z wydzielonego modułu `live-provider.js`, który pobiera dane bezpośrednio z oficjalnego kanału CORS. Lokalny serwer udostępnia ten sam kontrakt przez `/api/live`.
2. Adapter składa odpowiedź z historycznych wyników, bieżącej i poprzedniej kolejki oraz ewentualnych meczów ze statusem `playing`.
3. Podczas okna meczowego dane są przechowywane przez 45 sekund, a poza nim przez 5 minut.
4. Równoczesne odświeżenia w tej samej karcie lub instancji serwera są łączone w jedno zapytanie.
5. Serwerowy `/api/live` dodatkowo korzysta z cache odpowiedzi, natomiast statyczny GitHub Pages zachowuje cache w pamięci każdej otwartej aplikacji.
6. Po chwilowej awarii przez maksymalnie 5 minut może zostać zwrócony ostatni poprawny zapis. Potem stary status `LIVE` zmienia się na `SUSP`, aby mecz nie wisiał jako trwający bez końca.

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

## Kontrakt danych LIVE

Odpowiedź zawiera:

- `fixtures` — zakończone mecze, bieżąca kolejka i aktualnie trwające spotkania wyłącznie z rundy jesiennej;
- `mode` — `waiting`, `live-polling`, `stale` albo `degraded`;
- `provider` — `ekstraklasa-match-center`;
- `updatedAt`, `nextPollAt` i `pollIntervalSeconds`;
- neutralny kod błędu w razie czasowej niedostępności źródła.
