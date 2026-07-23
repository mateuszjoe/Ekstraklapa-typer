import assert from "node:assert/strict";
import {
  API_FOOTBALL_LEAGUE_ID,
  API_FOOTBALL_SEASON,
  apiFootballGet,
  discoverApiFootballFixture,
  normalizeApiFootballPlayerRatings,
  normalizedRatingPlayerFallbackKey,
  normalizedRatingPlayerKey,
  resolveApiFootballFixture
} from "./api-football-ratings.js";

const apiKey = "test-key-that-is-never-printed-123456";
const fixture = {
  localMatchId: "1-radomiak-wieczysta",
  kickoffAt: "2026-07-24T18:00:00+02:00",
  home: "radomiak",
  away: "wieczysta"
};
const fixturePayload = {
  errors: [],
  response: [{
    fixture: { id: 9001, date: fixture.kickoffAt },
    league: { id: API_FOOTBALL_LEAGUE_ID, season: API_FOOTBALL_SEASON },
    teams: {
      home: { id: 101, name: "Radomiak Radom" },
      away: { id: 202, name: "Wieczysta Krakow" }
    }
  }]
};

assert.equal(normalizedRatingPlayerKey("Łukasz Piszczek"), "lukaszpiszczek");
assert.equal(normalizedRatingPlayerFallbackKey("Marc Gual"), "mgual");
assert.equal(normalizedRatingPlayerFallbackKey("João Pedro Silva"), "jsilva");
assert.deepEqual(resolveApiFootballFixture(fixturePayload, fixture), {
  apiFixtureId: 9001,
  homeApiTeamId: 101,
  awayApiTeamId: 202,
  home: "radomiak",
  away: "wieczysta",
  kickoffAt: fixture.kickoffAt
});

let requestedUrl = "";
const discovered = await discoverApiFootballFixture(fixture, {
  apiKey,
  fetchImpl: async (url, options) => {
    requestedUrl = String(url);
    assert.equal(options.headers["x-apisports-key"], apiKey);
    assert.equal(requestedUrl.includes(apiKey), false);
    return new Response(JSON.stringify(fixturePayload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
});
assert.equal(discovered.apiFixtureId, 9001);
assert.match(requestedUrl, /\/fixtures\?/);
assert.match(requestedUrl, /league=106/);
assert.match(requestedUrl, /season=2026/);
assert.match(requestedUrl, /date=2026-07-24/);

const ratingsPayload = {
  errors: [],
  response: [{
    team: { id: 101, name: "Radomiak Radom" },
    players: [{
      player: {
        id: 301,
        name: "M. Gual",
        firstname: "Marc",
        lastname: "Gual",
        photo: "https://media.api-sports.io/football/players/301.png"
      },
      statistics: [{ games: { minutes: 90, position: "F", rating: "6.8" } }]
    }, {
      player: { id: 302, name: "Bez Oceny", firstname: "Bez", lastname: "Oceny" },
      statistics: [{ games: { minutes: 3, position: "M", rating: null } }]
    }]
  }, {
    team: { id: 202, name: "Wieczysta Krakow" },
    players: [{
      player: {
        id: 401,
        name: "A. Pululu",
        photo: "https://malicious.example/401.png"
      },
      statistics: [{ games: { minutes: 75, position: "F", rating: 7.2 } }]
    }]
  }]
};
const ratings = normalizeApiFootballPlayerRatings(ratingsPayload, {
  ...discovered,
  home: fixture.home,
  away: fixture.away
});
assert.equal(ratings.length, 2);
assert.deepEqual(ratings[0], {
  apiFixtureId: 9001,
  apiPlayerId: 301,
  teamId: "radomiak",
  playerKey: "marcgual",
  fallbackKey: "mgual",
  playerName: "Marc Gual",
  photoUrl: "https://media.api-sports.io/football/players/301.png",
  rating: 6.8,
  minutes: 90,
  position: "F"
});
assert.equal(ratings[1].playerKey, "apululu");
assert.equal(ratings[1].fallbackKey, "apululu");
assert.equal(ratings[1].photoUrl, "");

let detailCalls = 0;
await apiFootballGet("/fixtures/players", { fixture: 9001 }, {
  apiKey,
  fetchImpl: async (url, options) => {
    detailCalls += 1;
    assert.equal(String(url).includes(apiKey), false);
    assert.equal(options.headers["x-apisports-key"], apiKey);
    return new Response(JSON.stringify(ratingsPayload), { status: 200 });
  }
});
assert.equal(detailCalls, 1);

console.log("OK: bezpieczny adapter i normalizacja gotowych ocen API-Football.");
