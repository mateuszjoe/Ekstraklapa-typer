# Wyniki LIVE — rozwiązanie całosezonowe za 0 zł

Stan weryfikacji: 21 lipca 2026.

## Dostawca

API-Football obejmuje Ekstraklasę jako ligę `106`. Darmowy plan ma limit 100 zapytań dziennie i według aktualnej oferty pozostaje darmowy bezterminowo. Projekt świadomie korzysta wyłącznie z terminarza, statusu, minuty oraz wyniku.

Dokumentacja: https://api-sports.io/documentation/football/v3

Cennik i limity: https://www.api-football.com/

## Jak mieścimy się w 100 zapytaniach

1. Serwer rezerwuje pięć wywołań i wykorzystuje maksymalnie 95 dziennie.
2. Jedno zapytanie pobiera wszystkie spotkania Ekstraklasy z danego dnia.
3. Polling działa co 6 minut wyłącznie w oknie meczu: od 10 minut przed kickoffem do maksymalnie 180 minut po nim.
4. Mecze zakończone nie otwierają kolejnych okien pollingu.
5. Pełny terminarz jest odświeżany maksymalnie raz na 7 dni.
6. Cache i historia wykorzystania limitu są zapisywane w `.cache/api-football-state.json`.
7. `/api/live` nigdy nie wykonuje zewnętrznego zapytania. Zwraca tylko ostatni cache, dlatego ruch użytkowników nie zużywa limitu.

Przy paśmie spotkań trwającym około 8 godzin polling co 6 minut zużywa około 80 wywołań. Pozostaje margines na synchronizację terminarza, opóźnienia oraz zapytanie końcowe.

## Zachowanie przy awarii

- Bez klucza działają terminarz, typowanie i wyniki wpisane ręcznie.
- Po błędzie API serwer zachowuje ostatni poprawny cache i ponawia próbę dopiero po upływie interwału.
- Po wykorzystaniu lokalnego budżetu nie wykonuje kolejnych wywołań tego dnia.
- `manual-results.json` nadpisuje wynik API i pozwala administratorowi zatwierdzić rezultat.
- Chroniony endpoint `POST /api/admin/result` działa tylko po ustawieniu `ADMIN_RESULT_TOKEN`.

## Dlaczego nie ESPN

21 lipca 2026 bezpośredni test `site.api.espn.com/apis/site/v2/sports/soccer/pol.1/scoreboard` zwrócił HTTP 400, a endpoint drużyn HTTP 404. Kontrolny endpoint Premier League `eng.1` zwrócił HTTP 200. ESPN nie udostępnia więc obecnie Ekstraklasy pod deklarowanym wcześniej slugiem `pol.1`.

## Kontrakt `/api/live`

Odpowiedź zawiera:

- `fixtures` — zapisany terminarz i ostatnie wyniki;
- `mode` — `not-configured`, `waiting`, `live-polling` albo `quota-exhausted`;
- `quota.usedToday` i `quota.localBudget`;
- `updatedAt`, `scheduleUpdatedAt` oraz `nextPollAt`;
- ostatni błąd dostawcy, jeśli wystąpił.

Warstwa dostawcy jest zamknięta w `server.mjs`, więc w przyszłości można ją wymienić bez przebudowy typowania i interfejsu.
