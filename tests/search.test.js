// Перевірка пошуку застосунку на складних запитах. Запуск: node tests/search.test.js
// Бере справжній site/app.js, підставляє вигаданий розклад (tests/data.json) і «сьогодні» = вівторок, 20.10.2026.
// Робот запускає це перед публікацією: якщо хоч одна перевірка не пройде, сайт лишається старим.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Сторінки в Node немає: усе, чого app.js торкається при завантаженні, замінюємо «порожнім» обʼєктом
const stub = new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub,
  apply: () => stub, construct: () => stub, set: () => true,
});
const ctx = vm.createContext({
  document: stub, window: stub, navigator: { userAgent: "test" }, localStorage: stub, history: stub,
  location: { href: "https://example.org/kino-ua/", origin: "https://example.org", pathname: "/kino-ua/", hash: "" },
  fetch: () => new Promise(() => {}), setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {},
  CSS: { escape: s => s }, URL, Intl, Date, Math, JSON, Set, Map, Promise, console,
});
const root = path.join(__dirname, "..");
vm.runInContext(fs.readFileSync(path.join(root, "site/app.js"), "utf8"), ctx, { filename: "app.js" });
ctx.TEST_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8"));
vm.runInContext(`DATA = TEST_DATA; warsawNow = () => ({ date: "2026-10-20", time: "12:00" });`, ctx);
const run = q => vm.runInContext(`(() => { const r = search(${JSON.stringify(q)});
  return { films: r.films.map(f => f.key), ranges: r.ranges, note: r.note,
           shows: r.films.reduce((n, f) => n + f.shows.length, 0), pinned: pinnedQuery({ ranges: r.ranges,
           terms: r.terms, dated: r.explicit || !r.terms.length }) }; })()`, ctx);

// [запит, очікувані дати [від, до], очікувані фільми (ключі) або null — не перевіряти, додатково]
const ALL = ["2026-10-20", "2026-11-02"];
const CASES = [
  ["", ["2026-10-20", "2026-10-20"], ["verity", "residentevil"]],
  ["сьогодні", ["2026-10-20", "2026-10-20"], ["verity", "residentevil"]],
  ["завтра", ["2026-10-21", "2026-10-21"], ["verity"], { pinned: "21.10" }],
  ["післязавтра", ["2026-10-22", "2026-10-22"], []],
  ["вихідні", ["2026-10-24", "2026-10-25"], ["residentevil", "verity", "krashanka20kvantovyiparadoks"]],
  ["тиждень", ["2026-10-20", "2026-10-26"], null],
  ["усі", ALL, null],
  ["Усі 2 тижні", ALL, null],
  ["наступного тижня", ["2026-10-26", "2026-11-01"], ["28latpozniej", "clayface", "vsesvit"]],
  ["25.10", ["2026-10-25", "2026-10-25"], null],
  ["25.10.2026", ["2026-10-25", "2026-10-25"], null],
  ["25 жовтня", ["2026-10-25", "2026-10-25"], null],
  ["25", ["2026-10-25", "2026-10-25"], null],
  ["з 22 по 25", ["2026-10-22", "2026-10-25"], null],
  ["22-24", ["2026-10-22", "2026-10-24"], null],
  ["22.10-24.10", ["2026-10-22", "2026-10-24"], null],
  ["з 22.10 по 25.10", ["2026-10-22", "2026-10-25"], null],
  ["до неділі", ["2026-10-20", "2026-10-25"], null],
  ["з пʼятниці по неділю", ["2026-10-23", "2026-10-25"], null],
  ["з п'ятниці по неділю", ["2026-10-23", "2026-10-25"], null],
  ["у суботу", ["2026-10-24", "2026-10-24"], ["residentevil"]],
  ["з пʼятниці", ["2026-10-23", "2026-11-02"], null],
  ["з 25", ["2026-10-25", "2026-11-02"], null],
  ["веріті", ALL, ["verity"]],
  ["Веріті", ALL, ["verity"]],
  ["verity", ALL, ["verity"]],
  ["вертіі", ALL, ["verity"]],
  ["клейфейс", ALL, ["clayface"]],
  ["глинолик", ALL, ["clayface"]],
  ["Крашанка 2.0. Квантовий парадокс", ALL, ["krashanka20kvantovyiparadoks"]],
  ["Krashanka 2.0. Kvantovyi paradoks - UA", ALL, ["krashanka20kvantovyiparadoks"]],
  ["крашанка 2.0", ALL, ["krashanka20kvantovyiparadoks"]],
  ["крашанка", ALL, ["krashanka20kvantovyiparadoks"]],
  ["1917", ALL, ["1917"]],
  ["1917 у пʼятницю", ["2026-10-23", "2026-10-23"], ["1917"]],
  ["28 років потому", ALL, ["28latpozniej"]],
  ["28 років", ALL, ["28latpozniej"]],
  ["28 Years Later", ALL, ["28latpozniej"]],
  ["Resident Evil: Оселя Зла", ALL, ["residentevil"]],
  ["оселя зла", ALL, ["residentevil"]],
  ["resident evil 21:30", ALL, []],
  ["жахи", ALL, ["residentevil"]],
  ["multikino", ALL, ["residentevil"]],
  ["imax", ALL, ["1917"]],
  ["3d", ALL, ["1917"]],
  ["19:50", ALL, ["verity"]],
  ["веріті 18:10", ALL, ["verity"]],
  ["після 20", ALL, ["residentevil", "1917", "28latpozniej"]],
  ["сьогодні ввечері", ["2026-10-20", "2026-10-20"], ["verity", "residentevil"]],
  ["31.02", ["2026-10-20", "2026-10-20"], ["verity", "residentevil"], { note: /немає в календарі/ }],
  ["всесвіт", ALL, ["vsesvit"]],
  ["щось невідоме", ALL, []],
  ["веріті щось", ALL, ["verity"], { note: /Не знайшов/ }],
  ["2.0", ALL, ["krashanka20kvantovyiparadoks"]],
  ["alert(2)", ALL, []],
];

let failed = 0;
for (const [q, range, films, extra = {}] of CASES) {
  const r = run(q);
  const errs = [];
  const got = r.ranges.length === 1 ? r.ranges[0] : r.ranges;
  if (JSON.stringify(got) !== JSON.stringify(range)) errs.push(`дати ${JSON.stringify(got)}, а треба ${JSON.stringify(range)}`);
  if (films && JSON.stringify([...r.films].sort()) !== JSON.stringify([...films].sort()))
    errs.push(`фільми ${JSON.stringify(r.films)}, а треба ${JSON.stringify(films)}`);
  if (extra.note && !extra.note.test(r.note)) errs.push(`примітка «${r.note}»`);
  if (extra.pinned && r.pinned !== extra.pinned) errs.push(`посилання «${r.pinned}», а треба «${extra.pinned}»`);
  if (errs.length) { failed++; console.log(`✗ «${q}»: ${errs.join("; ")}`); }
}
console.log(`${CASES.length - failed} з ${CASES.length} перевірок пошуку пройдено`);
process.exit(failed ? 1 : 0);
