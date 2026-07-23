import assert from "node:assert/strict";
import {
  extractOfficialPlayerPhotos,
  formatPlayerRating,
  normalizeOfficialTeamSquad,
  officialMatchPlayerRating
} from "../league-provider.js";

const personId = "00000000-0000-4000-8000-000000000000";
const rsc = JSON.stringify({
  initialPlayerStats: [{
    person_id: personId,
    slug: "test-player",
    photo_url: "$undefined"
  }],
  matchCenterTeamId: "test"
});
const html = `<script>self.__next_f.push(${JSON.stringify([1, rsc])})</script>
  <a href="/kluby/legia-warszawa/zawodnik/test-player/">
    <img src="https://media.cms.ekstraklasa.org/images/originals/background.png" alt="">
    <img src="https://media.cms.ekstraklasa.org/players/test.png?width=400&amp;format=png" alt="Test Player">
  </a>`;
const photos = extractOfficialPlayerPhotos(html);
assert.equal(
  photos.get(personId),
  "https://media.cms.ekstraklasa.org/players/test.png?width=360&format=webp"
);

const providerTeamId = "11111111-1111-4111-8111-111111111111";
const seasonId = "22222222-2222-4222-8222-222222222222";
const formations = ["goalkeeper", "defender", "midfielder", "attacker"];
const rows = Array.from({ length: 12 }, (_, index) => ({
  person_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  team_id: providerTeamId,
  season_id: seasonId,
  person: {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    first_name: "Test",
    last_name: `Player ${index}`,
    formation: formations[index % formations.length]
  },
  stat: [
    { key: "appearances", value: "3" },
    { key: "goals", value: index === 3 ? "2" : "0" },
    { key: "goal_assists", value: "1" },
    { key: "yellow_cards", value: "1" }
  ]
}));
const squad = normalizeOfficialTeamSquad({ data: rows }, {
  teamId: "legia",
  providerTeamId,
  seasonId
});
assert.equal(squad.players.length, 12);
assert.deepEqual(squad.groups.map((group) => group.players.length), [3, 3, 3, 3]);
assert.equal(squad.players.find((player) => player.lastName === "Player 3")?.stats.goals, 2);

const rating = officialMatchPlayerRating({
  stat: {
    mins_played: { total: "90" },
    goals: { total: "1" },
    goal_assist: { total: "1" },
    total_pass: { total: "40" },
    accurate_pass: { total: "35" },
    duel_won: { total: "7" },
    duel_lost: { total: "3" },
    won_tackle: { total: "2" },
    ball_recovery: { total: "6" }
  }
}, "midfielder");
assert.ok(rating >= 7 && rating <= 10);
assert.equal(formatPlayerRating(null), "—");
assert.equal(formatPlayerRating(undefined), "—");
assert.equal(formatPlayerRating(""), "—");
assert.equal(formatPlayerRating(6.4), "6,4");

console.log("OK: kadry, zdjęcia i Ocena Typera.");
