import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalPlayerRatingsProvider } from "../local-player-ratings.js";

const temporaryRoot = await mkdtemp(join(tmpdir(), "ekstraklapa-local-ratings-"));
const cacheFile = join(temporaryRoot, "ratings.json");
const calls = [];

const fixtureRows = [
  {
    fixture: { id: 102, date: "2026-07-30T18:00:00+00:00", timestamp: 1785434400, status: { short: "NS" } },
    teams: { home: { id: 1, name: "Wisla Krakow" }, away: { id: 4, name: "Lech Poznan" } }
  },
  {
    fixture: { id: 101, date: "2026-07-22T18:00:00+00:00", timestamp: 1784743200, status: { short: "FT" } },
    teams: { home: { id: 1, name: "Wisla Krakow" }, away: { id: 2, name: "Legia Warszawa" } }
  },
  {
    fixture: { id: 100, date: "2026-07-15T18:00:00+00:00", timestamp: 1784138400, status: { short: "FT" } },
    teams: { home: { id: 3, name: "Gornik Zabrze" }, away: { id: 1, name: "Wisla Krakow" } }
  }
];

const fixturePlayers = {
  "101": [{
    team: { id: 1, name: "Wisla Krakow" },
    players: [
      {
        player: { id: 10, name: "Jan Kowalski", firstname: "Jan", lastname: "Kowalski" },
        statistics: [{ games: { rating: "8.2" } }]
      },
      {
        player: { id: 11, name: "Piotr Zolc", firstname: "Piotr", lastname: "Zolc" },
        statistics: [{ games: { rating: null } }]
      }
    ]
  }, {
    team: { id: 2, name: "Legia Warszawa" },
    players: [{
      player: { id: 12, name: "Adam Nowak", firstname: "Adam", lastname: "Nowak" },
      statistics: [{ games: { rating: "6.9" } }]
    }]
  }],
  "100": [{
    team: { id: 1, name: "Wisla Krakow" },
    players: [
      {
        player: { id: 10, name: "Jan Kowalski", firstname: "Jan", lastname: "Kowalski" },
        statistics: [{ games: { rating: "7.0" } }]
      },
      {
        player: { id: 11, name: "Piotr Zolc", firstname: "Piotr", lastname: "Zolc" },
        statistics: [{ games: { rating: "6.4" } }]
      }
    ]
  }]
};

const fakeFetch = async (url, options) => {
  const parsed = new URL(url);
  calls.push({
    path: parsed.pathname,
    fixture: parsed.searchParams.get("fixture"),
    key: options?.headers?.["x-apisports-key"]
  });
  const response = parsed.pathname.endsWith("/fixtures/players")
    ? fixturePlayers[parsed.searchParams.get("fixture")] || []
    : fixtureRows;
  return {
    ok: true,
    status: 200,
    json: async () => ({ errors: [], response })
  };
};

const squad = {
  teamId: "wisla-krakow",
  players: [
    { id: "official-10", name: "Jan Kowalski", firstName: "Jan", lastName: "Kowalski" },
    { id: "official-11", name: "Piotr Żółć", firstName: "Piotr", lastName: "Żółć" }
  ],
  groups: [{
    id: "midfielders",
    players: [
      { id: "official-10", name: "Jan Kowalski", firstName: "Jan", lastName: "Kowalski" },
      { id: "official-11", name: "Piotr Żółć", firstName: "Piotr", lastName: "Żółć" }
    ]
  }]
};

const silentLogger = { warn() {} };

try {
  const provider = createLocalPlayerRatingsProvider({
    apiKey: "test-key",
    apiBaseUrl: "https://ratings.test/v3/",
    cacheFile,
    fetchImpl: fakeFetch,
    logger: silentLogger
  });
  const enriched = await provider.enrichTeamSquad(squad, "Wisła Kraków");

  assert.equal(enriched.ratingSource, "api-football");
  assert.equal(enriched.ratingsConfigured, true);
  assert.deepEqual(enriched.players[0].rating, { average: 7.6, appearances: 2 });
  assert.deepEqual(enriched.players[1].rating, { average: 6.4, appearances: 1 });
  assert.deepEqual(enriched.groups[0].players[0].rating, { average: 7.6, appearances: 2 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.key === "test-key"));

  await provider.enrichTeamSquad(squad, "Wisła Kraków");
  assert.equal(calls.length, 3, "second read should use the in-memory cache");

  const opponentSquad = {
    teamId: "legia",
    players: [{ id: "official-12", name: "Adam Nowak", firstName: "Adam", lastName: "Nowak" }],
    groups: [{
      id: "defenders",
      players: [{ id: "official-12", name: "Adam Nowak", firstName: "Adam", lastName: "Nowak" }]
    }]
  };
  const opponent = await provider.enrichTeamSquad(opponentSquad, "Legia Warszawa");
  assert.deepEqual(opponent.players[0].rating, { average: 6.9, appearances: 1 });
  assert.equal(calls.length, 3, "both teams should share one cached fixture response");

  const reloadedProvider = createLocalPlayerRatingsProvider({
    apiKey: "test-key",
    apiBaseUrl: "https://ratings.test/v3/",
    cacheFile,
    fetchImpl: fakeFetch,
    logger: silentLogger
  });
  const reloaded = await reloadedProvider.enrichTeamSquad(squad, "Wisła Kraków");
  assert.deepEqual(reloaded.players[0].rating, { average: 7.6, appearances: 2 });
  assert.equal(calls.length, 3, "a server restart should reuse the persistent file cache");

  const noKeyProvider = createLocalPlayerRatingsProvider({
    apiKey: "",
    fetchImpl: async () => {
      throw new Error("fetch must not be called without a key");
    },
    logger: silentLogger
  });
  const withoutRatings = await noKeyProvider.enrichTeamSquad(squad, "Wisła Kraków");
  assert.equal(withoutRatings.ratingsConfigured, false);
  assert.deepEqual(withoutRatings.players[0].rating, { average: null, appearances: 0 });
  assert.deepEqual(withoutRatings.groups[0].players[0].rating, { average: null, appearances: 0 });

  const sixFixtureRows = Array.from({ length: 6 }, (_, index) => ({
    fixture: {
      id: 200 + index,
      date: new Date(1785000000000 + index * 86_400_000).toISOString(),
      timestamp: 1785000000 + index * 86_400,
      status: { short: "FT" }
    },
    teams: { home: { id: 1, name: "Wisla Krakow" }, away: { id: 20 + index, name: `Rywal ${index}` } }
  }));
  const fiveOnlyProvider = createLocalPlayerRatingsProvider({
    apiKey: "test-key",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const fixtureId = Number(parsed.searchParams.get("fixture"));
      const response = parsed.pathname.endsWith("/fixtures/players")
        ? [{
            team: { id: 1, name: "Wisla Krakow" },
            players: [{
              player: { id: 10, name: "Jan Kowalski", firstname: "Jan", lastname: "Kowalski" },
              statistics: [{ games: { rating: String(fixtureId - 199) } }]
            }]
          }]
        : sixFixtureRows;
      return { ok: true, status: 200, json: async () => ({ errors: [], response }) };
    },
    logger: silentLogger
  });
  const latestFive = await fiveOnlyProvider.enrichTeamSquad(squad, "Wisła Kraków");
  assert.deepEqual(
    latestFive.players[0].rating,
    { average: 4, appearances: 5 },
    "the average must use only the five newest rated appearances"
  );

  console.log("OK: lokalne oceny API-Football, średnia, grupy i cache.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
