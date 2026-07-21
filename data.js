export const teams = [
  ["cracovia", "Cracovia", "CRA", "cracovia.png"],
  ["gks-katowice", "GKS Katowice", "GKS", "gks-katowice.png"],
  ["gornik-zabrze", "Górnik Zabrze", "GÓR", "gornik-zabrze.png"],
  ["jagiellonia", "Jagiellonia Białystok", "JAG", "jagiellonia-bialystok.png"],
  ["korona", "Korona Kielce", "KOR", "korona-kielce.png"],
  ["lech", "Lech Poznań", "LPO", "lech-poznan.png"],
  ["legia", "Legia Warszawa", "LEG", "legia-warszawa.png"],
  ["motor", "Motor Lublin", "MOT", "motor-lublin.png"],
  ["piast", "Piast Gliwice", "PIA", "piast-gliwice.png"],
  ["pogon", "Pogoń Szczecin", "POG", "pogon-szczecin.png"],
  ["radomiak", "Radomiak Radom", "RAD", "radomiak-radom.png"],
  ["rakow", "Raków Częstochowa", "RCZ", "rakow-czestochowa.png"],
  ["slask", "Śląsk Wrocław", "ŚLĄ", "slask-wroclaw.png"],
  ["widzew", "Widzew Łódź", "WID", "widzew-lodz.png"],
  ["wieczysta", "Wieczysta Kraków", "WIE", "wieczysta-krakow.png"],
  ["wisla-krakow", "Wisła Kraków", "WIS", "wisla-krakow.png"],
  ["wisla-plock", "Wisła Płock", "WPŁ", "wisla-plock.png"],
  ["zaglebie", "KGHM Zagłębie Lubin", "ZAG", "zaglebie-lubin.png"]
].map(([id, name, short, crest]) => ({ id, name, short, crest: `./assets/clubs/${crest}` }));

export const teamById = Object.fromEntries(teams.map((team) => [team.id, team]));

const firstLeg = [
  [["wisla-krakow","gks-katowice"],["radomiak","wieczysta"],["pogon","legia"],["rakow","wisla-plock"],["widzew","motor"],["jagiellonia","korona"],["gornik-zabrze","slask"],["zaglebie","piast"],["lech","cracovia"]],
  [["motor","jagiellonia"],["korona","gornik-zabrze"],["wieczysta","lech"],["cracovia","pogon"],["legia","zaglebie"],["gks-katowice","radomiak"],["slask","rakow"],["piast","wisla-krakow"],["wisla-plock","widzew"]],
  [["korona","legia"],["wisla-krakow","wisla-plock"],["radomiak","gornik-zabrze"],["pogon","motor"],["rakow","zaglebie"],["gks-katowice","wieczysta"],["slask","cracovia"],["jagiellonia","widzew"],["lech","piast"]],
  [["motor","gks-katowice"],["cracovia","rakow"],["legia","radomiak"],["widzew","korona"],["piast","wieczysta"],["jagiellonia","pogon"],["gornik-zabrze","wisla-krakow"],["zaglebie","slask"],["wisla-plock","lech"]],
  [["korona","motor"],["cracovia","wieczysta"],["radomiak","zaglebie"],["pogon","wisla-krakow"],["rakow","gornik-zabrze"],["gks-katowice","wisla-plock"],["slask","widzew"],["piast","legia"],["lech","jagiellonia"]],
  [["motor","piast"],["wisla-krakow","wieczysta"],["radomiak","cracovia"],["legia","slask"],["rakow","jagiellonia"],["widzew","lech"],["gornik-zabrze","gks-katowice"],["zaglebie","pogon"],["wisla-plock","korona"]],
  [["motor","legia"],["korona","wisla-krakow"],["wieczysta","zaglebie"],["cracovia","gornik-zabrze"],["pogon","wisla-plock"],["widzew","radomiak"],["piast","gks-katowice"],["jagiellonia","slask"],["lech","rakow"]],
  [["wisla-krakow","jagiellonia"],["radomiak","piast"],["legia","widzew"],["pogon","wieczysta"],["rakow","motor"],["slask","korona"],["gornik-zabrze","lech"],["zaglebie","gks-katowice"],["wisla-plock","cracovia"]],
  [["motor","gornik-zabrze"],["korona","rakow"],["wisla-krakow","slask"],["gks-katowice","cracovia"],["widzew","wieczysta"],["piast","pogon"],["jagiellonia","legia"],["zaglebie","wisla-plock"],["lech","radomiak"]],
  [["wieczysta","wisla-plock"],["cracovia","zaglebie"],["radomiak","motor"],["legia","wisla-krakow"],["pogon","korona"],["rakow","gks-katowice"],["slask","lech"],["piast","widzew"],["jagiellonia","gornik-zabrze"]],
  [["motor","slask"],["wieczysta","rakow"],["cracovia","legia"],["gks-katowice","pogon"],["widzew","wisla-krakow"],["gornik-zabrze","piast"],["zaglebie","jagiellonia"],["wisla-plock","radomiak"],["lech","korona"]],
  [["motor","zaglebie"],["korona","gks-katowice"],["wisla-krakow","rakow"],["legia","lech"],["pogon","radomiak"],["slask","wieczysta"],["widzew","gornik-zabrze"],["piast","cracovia"],["jagiellonia","wisla-plock"]],
  [["wieczysta","jagiellonia"],["cracovia","motor"],["radomiak","slask"],["rakow","pogon"],["gks-katowice","widzew"],["gornik-zabrze","legia"],["zaglebie","korona"],["wisla-plock","piast"],["lech","wisla-krakow"]],
  [["motor","wisla-plock"],["korona","radomiak"],["wisla-krakow","cracovia"],["legia","rakow"],["slask","piast"],["widzew","pogon"],["jagiellonia","gks-katowice"],["gornik-zabrze","wieczysta"],["lech","zaglebie"]],
  [["wieczysta","motor"],["cracovia","jagiellonia"],["radomiak","wisla-krakow"],["pogon","slask"],["rakow","widzew"],["gks-katowice","lech"],["piast","korona"],["zaglebie","gornik-zabrze"],["wisla-plock","legia"]],
  [["korona","cracovia"],["wisla-krakow","motor"],["legia","wieczysta"],["rakow","piast"],["slask","gks-katowice"],["widzew","zaglebie"],["jagiellonia","radomiak"],["gornik-zabrze","wisla-plock"],["lech","pogon"]],
  [["motor","lech"],["wieczysta","korona"],["cracovia","widzew"],["radomiak","rakow"],["pogon","gornik-zabrze"],["gks-katowice","legia"],["piast","jagiellonia"],["zaglebie","wisla-krakow"],["wisla-plock","slask"]]
];

const roundDates = [
  "2026-07-25","2026-08-01","2026-08-08","2026-08-15","2026-08-22","2026-08-29","2026-09-05","2026-09-12","2026-09-19","2026-10-10","2026-10-17","2026-10-24","2026-10-31","2026-11-07","2026-11-21","2026-11-28","2026-12-05",
  "2026-12-12","2027-01-30","2027-02-06","2027-02-13","2027-02-20","2027-02-27","2027-03-06","2027-03-13","2027-03-20","2027-04-03","2027-04-10","2027-04-17","2027-04-23","2027-05-01","2027-05-08","2027-05-15","2027-05-22"
];

const exactKickoffs = {
  "1-radomiak-wieczysta":"2026-07-24T18:00:00+02:00",
  "1-pogon-legia":"2026-07-24T20:30:00+02:00",
  "1-jagiellonia-korona":"2026-07-25T14:45:00+02:00",
  "1-gornik-zabrze-slask":"2026-07-25T17:30:00+02:00",
  "1-lech-cracovia":"2026-07-25T20:15:00+02:00",
  "1-rakow-wisla-plock":"2026-07-26T14:45:00+02:00",
  "1-widzew-motor":"2026-07-26T17:30:00+02:00",
  "1-wisla-krakow-gks-katowice":"2026-07-26T20:15:00+02:00",
  "1-zaglebie-piast":"2026-07-27T19:00:00+02:00",
  "2-wisla-plock-widzew":"2026-07-31T18:00:00+02:00",
  "2-motor-jagiellonia":"2026-07-31T20:30:00+02:00",
  "2-piast-wisla-krakow":"2026-08-01T14:45:00+02:00",
  "2-wieczysta-lech":"2026-08-01T17:30:00+02:00",
  "2-korona-gornik-zabrze":"2026-08-01T20:15:00+02:00",
  "2-legia-zaglebie":"2026-08-02T14:45:00+02:00",
  "2-slask-rakow":"2026-08-02T17:30:00+02:00",
  "2-gks-katowice-radomiak":"2026-08-02T20:15:00+02:00",
  "2-cracovia-pogon":"2026-08-03T19:00:00+02:00",
  "3-pogon-motor":"2026-08-07T18:00:00+02:00",
  "3-wisla-krakow-wisla-plock":"2026-08-07T20:30:00+02:00",
  "3-radomiak-gornik-zabrze":"2026-08-08T14:45:00+02:00",
  "3-lech-piast":"2026-08-08T17:30:00+02:00",
  "3-korona-legia":"2026-08-08T20:15:00+02:00",
  "3-rakow-zaglebie":"2026-08-09T14:45:00+02:00",
  "3-gks-katowice-wieczysta":"2026-08-09T17:30:00+02:00",
  "3-jagiellonia-widzew":"2026-08-09T20:15:00+02:00",
  "3-slask-cracovia":"2026-08-10T19:00:00+02:00",
  "4-widzew-korona":"2026-08-14T18:00:00+02:00",
  "4-legia-radomiak":"2026-08-14T20:30:00+02:00",
  "4-zaglebie-slask":"2026-08-15T14:45:00+02:00",
  "4-wisla-plock-lech":"2026-08-15T17:30:00+02:00",
  "4-gornik-zabrze-wisla-krakow":"2026-08-15T20:15:00+02:00",
  "4-motor-gks-katowice":"2026-08-16T14:45:00+02:00",
  "4-jagiellonia-pogon":"2026-08-16T17:30:00+02:00",
  "4-cracovia-rakow":"2026-08-16T20:15:00+02:00",
  "4-piast-wieczysta":"2026-08-17T19:00:00+02:00"
};

const allRounds = [
  ...firstLeg,
  ...firstLeg.map((round) => round.map(([home, away]) => [away, home]))
];

export const matches = allRounds.flatMap((round, roundIndex) => {
  const matchday = roundIndex + 1;
  return round.map(([home, away], index) => {
    const id = `${matchday}-${home}-${away}`;
    const exact = exactKickoffs[id];
    return {
      id,
      matchday,
      leg: matchday <= 17 ? 1 : 2,
      home,
      away,
      kickoffAt: exact || `${roundDates[roundIndex]}T13:00:00+02:00`,
      kickoffConfirmed: Boolean(exact),
      status: "SCHEDULED",
      homeScore: null,
      awayScore: null,
      events: [],
      source: "official-fixture"
    };
  });
});

export const roundDatesByNumber = Object.fromEntries(roundDates.map((date, i) => [i + 1, date]));
