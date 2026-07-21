import { matches, teams } from "../data.js";

const fail = (message) => { console.error(message); process.exitCode = 1; };
const ids = new Set(matches.map((match) => match.id));
const teamIds = new Set(teams.map((team) => team.id));

if (teams.length !== 18) fail(`Oczekiwano 18 drużyn, jest ${teams.length}`);
if (matches.length !== 153) fail(`Oczekiwano 153 meczów, jest ${matches.length}`);
if (ids.size !== matches.length) fail("Terminarz zawiera powielone ID meczów");

for (let round = 1; round <= 17; round += 1) {
  const roundMatches = matches.filter((match) => match.matchday === round);
  if (roundMatches.length !== 9) fail(`Kolejka ${round}: oczekiwano 9 meczów, jest ${roundMatches.length}`);
  const appearances = new Map();
  roundMatches.flatMap((match) => [match.home, match.away]).forEach((team) => appearances.set(team, (appearances.get(team) || 0) + 1));
  if (appearances.size !== 18 || [...appearances.values()].some((count) => count !== 1)) fail(`Kolejka ${round}: drużyna występuje zero lub kilka razy`);
}

for (const match of matches) {
  if (!teamIds.has(match.home) || !teamIds.has(match.away)) fail(`Nieznana drużyna w meczu ${match.id}`);
}

if (!process.exitCode) console.log("OK: 18 drużyn, 17 kolejek rundy jesiennej, 153 unikalne mecze.");
