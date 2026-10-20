// Кіно українською: шукає по data.json, який GitHub Actions оновлює кожні 2 години.
"use strict";

const UK_DAYS = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];
const UK_MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня",
  "серпня", "вересня", "жовтня", "листопада", "грудня"];
// Основи слів: «у суботу», «в пʼятницю», «до неділі» тощо
const WEEKDAY_STEMS = [["неділ", 0], ["понеділ", 1], ["вівтор", 2], ["серед", 3], ["четвер", 4],
  ["пятниц", 5], ["субот", 6]];
const MONTH_STEMS = ["січ", "лют", "берез", "квіт", "трав", "черв", "лип", "серп", "верес", "жовт", "листоп", "груд"];
const STOP = new Set(["з", "із", "від", "по", "до", "у", "в", "на", "і", "й", "та", "що", "йде", "кіно", "фільм",
  "фільми", "сеанс", "сеанси", "українською", "покажи", "мені", "в", "числа", "od", "do"]);

let DATA = null;
let SHOWN = [];  // фільми на екрані: з них беремо сеанси для «Поділитися»
let SHOWN_SEARCH = null;  // дати й слова поточного пошуку для «Поділитися списком»
let NEWS = { since: null, keys: new Set() };  // фільми, що зʼявилися після минулого відкриття на цьому пристрої

// ---------------------------------------------------------------- дати
// «Сьогодні» за Вроцлавом, незалежно від часового поясу пристрою
function warsawNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const iso = d => d.toISOString().slice(0, 10);
const lastDay = () => addDays(DATA.from, DATA.days - 1);
const parseIso = s => new Date(s + "T00:00:00Z");
const addDays = (s, n) => { const d = parseIso(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const weekday = s => parseIso(s).getUTCDay();

// Без today лише дата («середа, 21 жовтня»): для тексту, який прочитають пізніше
function dayLabel(s, today) {
  const rel = today && { 0: "сьогодні", 1: "завтра", 2: "післязавтра" }[(parseIso(s) - parseIso(today)) / 864e5];
  const d = parseIso(s);
  const text = `${UK_DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${UK_MONTHS[d.getUTCMonth()]}`;
  return rel ? `${rel}, ${text}` : text;
}

// День місяця без місяця: найближча така дата від сьогодні
function resolveDay(day, month, year, today) {
  const t = parseIso(today);
  let y = year || t.getUTCFullYear();
  let m = month ? month - 1 : t.getUTCMonth();
  let d = new Date(Date.UTC(y, m, day));
  if (d.getUTCDate() !== day) return null;
  if (d < t && !year) {
    if (month) d = new Date(Date.UTC(y + 1, m, day));
    else d = new Date(Date.UTC(y, m + 1, day));
  }
  return iso(d);
}

// Точки в запиті: дата, день тижня або «сьогодні/завтра». Повертає [{from, to, start, end}]
const POINT = new RegExp([
  "(\\d{4})-(\\d{1,2})-(\\d{1,2})",                        // 2026-10-25
  "(\\d{1,2})[./](0?[1-9]|1[0-2])(?:[./](\\d{2,4}))?(?![\\d])", // 25.10, 25/10/2026 (не «2.0» з назви)
  `(\\d{1,2})\\s*(${MONTH_STEMS.join("|")})[а-яіїєґ]*`,     // 25 жовтня
  "(?<=^|[\\s,–—-])(\\d{1,2})(?=$|[\\s,–—-])",              // 25 окремим словом (не 3D, не 4DX, не «(2)»)
  "(сьогодні|сегодня|завтра|післязавтра)",
  `(${WEEKDAY_STEMS.map(w => w[0]).join("|")})[а-яіїєґ]*`,
].join("|"), "g");

function pointDates(m, today) {
  if (m[1]) return resolveDay(+m[3], +m[2], +m[1], today);
  if (m[4]) return resolveDay(+m[4], +m[5], m[6] ? (m[6].length === 2 ? 2000 + +m[6] : +m[6]) : 0, today);
  if (m[7]) return resolveDay(+m[7], MONTH_STEMS.indexOf(m[8]) + 1, 0, today);
  if (m[9]) return { bare: +m[9] };
  if (m[10]) return addDays(today, { "сьогодні": 0, "сегодня": 0, "завтра": 1, "післязавтра": 2 }[m[10]]);
  const wd = WEEKDAY_STEMS.find(w => w[0] === m[11])[1];
  return addDays(today, (wd - weekday(today) + 7) % 7);
}

function parseQuery(raw, today) {
  let q = raw.toLowerCase().replace(/[ʼ'’`]/g, "").replace(/ё/g, "е").trim();
  // Число, що разом із сусіднім словом є частиною назви фільму («28 років потому», «28 lat»), не дата:
  // ховаємо його цифри від розбору дат і часу, а в кінці повертаємо в слова пошуку
  const titles = DATA ? DATA.films.map(f => norm([f.title, f.title_uk, f.original].join(" | "))).join(" | ") : "";
  q = q.replace(/(?<![\p{L}\d])\d+\s+\p{L}+|\p{L}+\s+\d+(?![\p{L}\d])/gu,
    m => titles.includes(norm(m)) ? m.replace(/\d/g, d => String.fromCharCode(0xE000 + +d)) : m);
  const ranges = [];
  // слова-періоди
  // ключ: регулярний вираз; «вихідн»/«тижд» з будь-яким закінченням, «усі» лише цілим словом
  const words = { "(\\d+)\\s+тиж[дн][а-яіїєґ]*": n => [today, addDays(today, 7 * Math.max(1, +n) - 1)],  // «2 тижні»
    "наступн[а-яіїєґ]*\\s+тиж[дн][а-яіїєґ]*": () => {
      const mon = addDays(today, (8 - weekday(today)) % 7 || 7);
      return [mon, addDays(mon, 6)];
    },
    "вихідн[а-яіїєґ]*": () => {
      const wd = weekday(today);
      if (wd === 0) return [today, today];
      const sat = addDays(today, (6 - wd + 7) % 7);
      return [sat, addDays(sat, 1)];
    },
    "тиж[дн][а-яіїєґ]*": () => [today, addDays(today, 6)],
    "усі|все|всі|увесь|весь": () => [today, lastDay()],
  };
  for (const [re, fn] of Object.entries(words)) {
    q = q.replace(new RegExp(`(?:^|\\s)(?:${re})(?=\\s|$)`, "g"), (_, n) => { ranges.push(fn(n)); return " "; });
  }
  // час: «19:50» шукає сеанс саме тоді, «після 18» або «після 18:30» усі пізніші
  let after = null;
  const times = [];
  q = q.replace(/(?:^|\s)(?:у|в)?вечері(?=\s|$)|(?:^|\s)вечором(?=\s|$)/g, () => { after = "17:00"; return " "; });
  q = q.replace(/(?:після|after)\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:год|годин[а-яіїєґ]*))?(?=\s|$)/g, (_, h, m) => {
    if (+h > 23) return _;
    after = `${h.padStart(2, "0")}:${m || "00"}`;
    return " ";
  });
  q = q.replace(/(?<![\d.])(\d{1,2}):(\d{2})(?!\d)/g, (_, h, m) => { times.push(`${h.padStart(2, "0")}:${m}`); return " "; });
  const found = [...q.matchAll(POINT)].map(m => ({ m, at: m.index, end: m.index + m[0].length, v: pointDates(m, today) }));
  const pts = found.filter(p => p.v);
  let rest = q;
  const bad = [];  // дати, яких немає в календарі («31.02»): пропускаємо з приміткою
  for (const p of found.filter(p => !p.v)) {
    bad.push(p.m[0].trim());
    rest = rest.slice(0, p.at) + " ".repeat(p.end - p.at) + rest.slice(p.end);
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const between = b && q.slice(a.end, b.at).trim();
    if (b && /^(-|–|—|по|до|і)?$/.test(between) && between !== "і" && (between || a.v.bare)) {
      // діапазон: «з 20 по 25 жовтня» бере місяць з другої дати
      let to = b.v.bare ? resolveDay(b.v.bare, 0, 0, today) : b.v;
      if (a.v.bare && b.v.bare && to) {
        // «з 20 по 25» — найближчий такий відрізок: початок у місяці кінця або в попередньому
        const t = parseIso(to);
        let from = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - (a.v.bare > b.v.bare ? 1 : 0), a.v.bare));
        from = iso(from) < today ? today : iso(from);
        ranges.push([from, to]);
        rest = rest.slice(0, a.at) + " ".repeat(b.end - a.at) + rest.slice(b.end);
        i++;
        continue;
      }
      if (a.m[11] && b.m[11]) {
        // «з пʼятниці по неділю»: найближчий такий відрізок, що ще не скінчився; минулі дні відкидаємо
        const span = (weekday(to) - weekday(a.v) + 7) % 7;
        const from = addDays(to, -span);
        ranges.push([from < today ? today : from, to]);
        rest = rest.slice(0, a.at) + " ".repeat(b.end - a.at) + rest.slice(b.end);
        i++;
        continue;
      }
      let from = a.v.bare
        ? (b.v.bare ? resolveDay(a.v.bare, 0, 0, today)
          : resolveDay(a.v.bare, parseIso(to).getUTCMonth() + 1, parseIso(to).getUTCFullYear(), today))
        : a.v;
      if (from && to) ranges.push(from <= to ? [from, to] : [to, from]);
      else bad.push(q.slice(a.at, b.end).trim());
      rest = rest.slice(0, a.at) + " ".repeat(b.end - a.at) + rest.slice(b.end);
      i++;
      continue;
    }
    const d = a.v && a.v.bare ? resolveDay(a.v.bare, 0, 0, today) : a.v;
    const before = q.slice(0, a.at);
    // «до неділі» від сьогодні до неї, «з пʼятниці» від неї до кінця розкладу
    if (d && /(?:^|\s)(?:до|по)\s*$/.test(before)) ranges.push([today, d]);
    else if (d && /(?:^|\s)(?:з|із|від)\s*$/.test(before)) ranges.push([d, d > lastDay() ? d : lastDay()]);
    else if (d) ranges.push([d, d]);
    if (!d) bad.push(a.m[0].trim());
    rest = rest.slice(0, a.at) + " ".repeat(a.end - a.at) + rest.slice(a.end);
  }
  const terms = rest.split(/[\s,;:]+/).filter(w => /[\p{L}\d\uE000-\uE009]/u.test(w) && !STOP.has(w) && !UK_MONTHS.includes(w) && !/^наступн/.test(w))
    .map(w => w.replace(/[\uE000-\uE009]/g, c => String(c.charCodeAt(0) - 0xE000)));
  // відрізки, що перекриваються («усі» і «2 тижні»), зливаємо в один
  ranges.sort((a, b) => a[0].localeCompare(b[0]));
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) { if (r[1] > last[1]) last[1] = r[1]; } else merged.push([...r]);
  }
  return { ranges: merged, terms, times, after, bad };
}

// ---------------------------------------------------------------- пошук
// Порівнюємо без регістру, апострофів і польських діакритиків, а кирилицю ще й латинкою,
// щоб «verity» знаходило «Веріті», а «zywiol» — «Żywioł».
const norm = s => (s || "").toLowerCase().replace(/[ʼ'’`]/g, "").replace(/ё/g, "е").replace(/ł/g, "l")
  .normalize("NFD").replace(/(?<=[a-z])[̀-ͯ]/g, "").normalize("NFC");
const LAT = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i",
  ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ъ: "" };
const lat = s => s.replace(/[а-яіїєґыэъ]/g, c => LAT[c] ?? c);
// латиниця й кирилиця по-різному передають ті самі звуки: зводимо до спільного «скелета»
const skel = s => lat(s).replace(/c(?=[eiy])/g, "s").replace(/kh|ch/g, "h").replace(/[yj]/g, "i").replace(/w/g, "v").replace(/c/g, "k")
  .replace(/x/g, "ks").replace(/(.)\1+/g, "$1");

// Відстань між словами з урахуванням переставлених сусідніх літер («вертіі» → «веріті»)
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Слово запиту підходить, якщо воно є в тексті, або майже збігається з якимсь словом (чи його початком)
function matches(term, text, words) {
  if (text.includes(term)) return true;
  const t = skel(term);
  if (t.length < 3) return false;
  if (words.skel.includes(t)) return true;
  const max = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
  if (!max) return false;
  if (words.list.some(w => distance(t, w.slice(0, t.length), max) <= max ||
    (w.length !== t.length && distance(t, w, max) <= max))) return true;
  // англійська назва, записана кирилицею на слух («клейфейс» → «clayface»): збігаються приголосні
  const c = consonants(t);
  return c.length >= 4 && words.cons.some(w => w === c);
}
const consonants = w => w.replace(/[aeiou]/g, "");
const wordsOf = text => {
  const sk = skel(text), list = sk.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  return { skel: sk, list, cons: list.map(consonants) };
};

function filterShows(ranges, terms, times, after, now) {
  const inRange = d => ranges.some(([a, b]) => a <= d && d <= b);
  const films = [];
  for (const f of DATA.films) {
    const filmText = norm([f.title, f.title_uk, f.original, ...(f.genres || [])].join(" "));
    const shows = f.shows.filter(s => {
      if (!inRange(s.date)) return false;
      if (times.length && !times.includes(s.time)) return false;
      if (after && s.time < after) return false;
      if (!terms.length) return true;
      const text = filmText + " " + norm([s.cinema, s.hall, s.version, DATA.cinemas[s.cinema]].join(" "));
      const words = wordsOf(text);
      return terms.every(t => matches(t, text, words));
    }).map(s => ({ ...s, started: s.date < now.date || (s.date === now.date && s.time <= now.time) }));
    if (shows.length) films.push({ ...f, shows });
  }
  // фільми, де всі сеанси вже почалися, ідуть у кінці
  films.sort((a, b) => (a.shows.every(s => s.started) - b.shows.every(s => s.started)) ||
    (a.shows[0].date + a.shows[0].time).localeCompare(b.shows[0].date + b.shows[0].time));
  return films;
}

// Усі слова розкладу (назви, жанри, кінотеатри, зали, формати): чи є слово запиту хоч десь
let VOCAB = null;
function inSchedule(term) {
  if (!VOCAB || VOCAB.data !== DATA) {
    const text = norm(DATA.films.map(f => [f.title, f.title_uk, f.original, ...(f.genres || []),
      ...f.shows.map(s => [s.cinema, s.hall, s.version, DATA.cinemas[s.cinema]].join(" "))].join(" ")).join(" "));
    VOCAB = { data: DATA, text, words: wordsOf(text) };
  }
  return matches(term, VOCAB.text, VOCAB.words);
}

function search(raw) {
  const now = warsawNow();
  // Запит дорівнює назві фільму (кнопки «Нове…» і посилання «Поділитися» ставлять саме її):
  // показуємо цей фільм на всі дні, не шукаючи в назві дат («Крашанка 2.0», «1917»)
  const q = norm(raw.trim());
  const exact = q && DATA.films.filter(f => [f.title, f.title_uk, f.original].some(t => t && norm(t) === q));
  if (exact && exact.length) {
    const keys = new Set(exact.map(f => f.key));
    const ranges = [[now.date, lastDay()]];
    const films = filterShows(ranges, [], [], null, now).filter(f => keys.has(f.key));
    return { films, ranges, terms: [raw.trim()], now, note: "", explicit: false };
  }
  let { ranges, terms, times, after, bad } = parseQuery(raw, now.date);
  terms = terms.map(norm);
  let note = bad.length ? `Дати ${bad.map(b => `«${b}»`).join(", ")} немає в календарі, тож пропускаю її. ` : "";
  // слово, якого немає в розкладі взагалі («наступна», «ввечері»), не повинно ховати все інше;
  // але якщо запит лише з таких слів, лишаємо «не знайдено»
  const unknown = terms.filter(t => !inSchedule(t));
  if (unknown.length && unknown.length < terms.length + ranges.length + times.length + (after ? 1 : 0)) {
    terms = terms.filter(t => !unknown.includes(t));
    note += `Не знайшов у розкладі ${unknown.map(t => `«${t}»`).join(", ")}, тож шукаю без ${unknown.length > 1 ? "цих слів" : "цього слова"}.`;
  }
  const anyFilter = terms.length || times.length || after;
  const explicit = ranges.length > 0;
  if (!ranges.length) ranges = anyFilter ? [[now.date, lastDay()]] : [[now.date, now.date]];
  let films = filterShows(ranges, terms, times, after, now);
  // порожній запит увечері: сьогодні вже нічого не лишилося, тож показуємо завтра
  if (!raw.trim() && !films.some(f => f.shows.some(s => !s.started))) {
    const tomorrow = addDays(now.date, 1);
    const next = filterShows([[tomorrow, tomorrow]], [], [], null, now);
    if (next.length) {
      note = "Сьогоднішні сеанси вже почалися, тож показую завтра.";
      ranges = [[tomorrow, tomorrow]];
      films = next;
    }
  }
  return { films, ranges, terms: [...terms, ...times, ...(after ? [`після ${after}`] : [])], now, note: note.trim(), explicit };
}

// ---------------------------------------------------------------- вивід
// Посилання з сайтів кінотеатрів пропускаємо лише як https: «javascript:» чи інші схеми відкидаємо
const safeUrl = u => /^https:\/\/[^\s"<>]+$/i.test(u || "") ? u : "";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function plural(n, one, few, many) {
  if (n % 10 === 1 && n % 100 !== 11) return `${n} ${one}`;
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

function filmMeta(f) {
  const bits = [];
  if (f.genres && f.genres.length) bits.push(f.genres.slice(0, 3).join(", "));
  if (f.minutes) { const h = Math.floor(f.minutes / 60), m = f.minutes % 60; bits.push(h ? `${h} год ${String(m).padStart(2, "0")} хв` : `${m} хв`); }
  if (f.year) bits.push(f.year);
  return bits.join(" · ");
}

function rangeLabel(ranges, today) {
  if (ranges.length !== 1) return "";
  // today не задано: лише дати, без «сьогодні/завтра»
  const [a, b] = ranges[0];
  if (a === b) return dayLabel(a, today);
  const da = parseIso(a), db = parseIso(b);
  return da.getUTCMonth() === db.getUTCMonth()
    ? `${da.getUTCDate()}–${db.getUTCDate()} ${UK_MONTHS[db.getUTCMonth()]}`
    : `${da.getUTCDate()} ${UK_MONTHS[da.getUTCMonth()]} – ${db.getUTCDate()} ${UK_MONTHS[db.getUTCMonth()]}`;
}

function card(f, today, multiDay) {
  const rows = [];
  let lastDay = null;
  for (const s of f.shows) {
    if (multiDay && s.date !== lastDay) {
      const label = dayLabel(s.date, today);
      rows.push(`<div class="day">${esc(label[0].toUpperCase() + label.slice(1))}</div>`);
      lastDay = s.date;
    }
    const det = [DATA.cinemas[s.cinema], s.hall, s.version].filter(Boolean).join(" · ");
    const inner = `<span class="time">${esc(s.time)}</span><span class="where">${esc(s.cinema)}</span><span class="det">${esc(det)}</span>`;
    const link = safeUrl(s.link);
    rows.push(s.started
      ? `<div class="show past">${inner}<span class="buy">почався</span></div>`
      : link ? `<a class="show" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${inner}<span class="buy">Квитки →</span></a>`
        : `<div class="show">${inner}<span class="buy"></span></div>`);
  }
  const title = esc(f.title) + (NEWS.keys.has(f.key) ? '<span class="tag">Новинка</span>' : "");
  const meta = filmMeta(f);
  const uk = f.title_uk && f.title_uk.toLowerCase() !== f.title.toLowerCase() ? `<p class="uk">${esc(f.title_uk)}</p>` : "";
  const rates = ratings(f);
  return `<article class="film${NEWS.keys.has(f.key) ? " new" : ""}"><div class="head">${actions(f)}<h2>${title}</h2></div>${uk}` +
    `<div class="meta">${rates}${meta ? `<span>${esc(meta)}</span>` : ""}</div>` +
    `<p class="syn${f.translated ? "" : " pl"}">${esc(f.synopsis || "Опису поки немає.")}</p>` +
    `<div class="shows">${rows.join("")}</div></article>`;
}

// На iPhone, iPad і Mac звичний квадрат зі стрілкою вгору, на Android і Windows три точки з лініями
const APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const SHARE_ICON = APPLE
  ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2"/></svg>'
  : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const BETA = '<span class="beta" title="Бета: ще може бути неточним">бета</span>';
// Трейлер: кнопка зі значком кіноплівки й словом «Трейлер», у стилі кнопки «Поділитися списком»
const YT_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/><path d="m10.5 9.5 3.5 2.5-3.5 2.5z" fill="currentColor" stroke-width="1.5"/></svg>Трейлер';

// Рейтинги перед жанрами: завжди обидва логотипи, без оцінки лише логотип; посилання ведуть на сайти рейтингів.
// Rotten Tomatoes і трейлер позначені «бета»: дані з OMDb і пошуку YouTube ще не завжди точні.
function ratings(f) {
  const imdb = /^tt\d+$/.test(f.imdb || "") ? f.imdb : "";
  const q = encodeURIComponent(f.original || f.title);
  const badge = (cls, href, title, logo, value, beta) =>
    `<a class="rate ${cls}${value ? "" : " none"}" href="${href}" target="_blank" rel="noopener noreferrer" title="${title}" ` +
    `aria-label="${title}${value ? `: ${esc(value)}` : ""}">${logo}${value ? `<span>${esc(value)}</span>` : ""}${beta ? BETA : ""}</a>`;
  return badge("imdb", imdb ? `https://www.imdb.com/title/${imdb}/` : `https://www.imdb.com/find/?q=${q}`,
      f.imdb_rating ? "Рейтинг IMDb (оцінки глядачів)" : "Рейтингу IMDb ще немає", "<b>IMDb</b>", f.imdb_rating) +
    badge("rt", `https://www.rottentomatoes.com/search?search=${q}`,
      f.rt ? "Rotten Tomatoes: частка позитивних рецензій критиків" : "Оцінки Rotten Tomatoes ще немає",
      '<span aria-hidden="true">🍅</span>', f.rt, true);
}

// Правий верхній кут картки: трейлер українською й «Поділитися»
function actions(f) {
  const yt = /^[\w-]{11}$/.test(f.trailer || "")
    ? `https://www.youtube.com/watch?v=${f.trailer}`
    : "https://www.youtube.com/results?search_query=" + encodeURIComponent(`${f.title_uk || f.original || f.title} трейлер українською`);
  return `<div class="acts"><a class="trailer" href="${esc(yt)}" target="_blank" rel="noopener noreferrer" aria-label="Трейлер українською на YouTube (бета)" title="Трейлер українською (бета)">${YT_ICON}${BETA}</a>` +
    `<button class="icon share" data-share="${esc(f.key)}" aria-label="Поділитися фільмом" title="Поділитися">${SHARE_ICON}</button></div>`;
}

function render() {
  const raw = document.getElementById("q").value;
  const { films, ranges, terms, now, note, explicit } = search(raw);
  SHOWN = films;
  const multiDay = new Set(films.flatMap(f => f.shows.map(s => s.date))).size > 1 ||
    ranges.some(([a, b]) => a !== b);
  const nShows = films.reduce((n, f) => n + f.shows.length, 0);
  const label = rangeLabel(ranges, now.date);
  const summary = films.length ? `${plural(films.length, "фільм", "фільми", "фільмів")}, ${plural(nShows, "сеанс", "сеанси", "сеансів")}` : "";
  document.getElementById("sub").textContent =
    [label && label[0].toUpperCase() + label.slice(1), terms.length ? `«${terms.join(" ")}»` : "", summary].filter(Boolean).join(" · ");
  SHOWN_SEARCH = { ranges, terms, dated: explicit || !terms.length };
  // один фільм ділиться кнопкою в його картці, тож список потрібен лише від двох
  document.getElementById("share-all").hidden = films.filter(f => f.shows.some(s => !s.started)).length < 2;
  let html = (note ? `<p class="empty">${esc(note)}</p>` : "") + films.map(f => card(f, now.date, multiDay)).join("");
  if (!films.length) {
    const next = [...new Set(DATA.films.flatMap(f => f.shows.map(s => s.date)))].filter(d => d >= ranges[0][0]).sort().slice(0, 4);
    html = (note ? `<p class="empty">${esc(note)}</p>` : "") + `<p class="empty">Українських сеансів за цим запитом не знайдено.` +
      (next.length ? ` Найближчі дні з сеансами: ${next.map(d => `<button data-q="${d.slice(8)}.${d.slice(5, 7)}">${esc(dayLabel(d, now.date))}</button>`).join(", ")}.` : "") +
      `</p>`;
  }
  if (ranges.some(([, b]) => b > lastDay())) {
    html += `<p class="empty">Розклад зібрано до ${esc(dayLabel(lastDay(), now.date))}; далі кінотеатри ще не публікують сеанси.</p>`;
  } else if (explicit && ranges.some(([, b]) => b > addDays(now.date, 6))) {
    html += `<p class="empty">Далі ніж на тиждень розклад неповний: DCF і Нові Горизонти публікують сеанси приблизно на тиждень наперед, тож тут ще можуть зʼявитися нові.</p>`;
  }
  document.getElementById("out").innerHTML = html;
  document.querySelectorAll(".chips button").forEach(b => b.setAttribute("aria-pressed", String(norm(b.dataset.q) === norm(raw.trim()))));
}

// ---------------------------------------------------------------- проблеми
// Що потребує уваги: робот давно не оновлював розклад, кінотеатр не відповідає, фільм без перекладу.
function problems() {
  const out = [];
  const now = warsawNow();
  const ageH = (Date.now() - new Date(DATA.generated_at)) / 36e5;
  if (ageH > 5) {
    out.push({ level: "bad", title: `Розклад не оновлювався ${Math.floor(ageH)} год`,
      text: "Робот мав запускатися кожні 2 години. Можливо, GitHub його вимкнув або він падає. Напишіть Claude у проєкті." });
  }
  const bySource = {};
  for (const [day, errs] of Object.entries(DATA.errors || {})) {
    if (day < now.date) continue;
    for (const e of errs) {
      const i = e.indexOf(": ");
      const name = i > 0 ? e.slice(0, i) : "Джерело";
      const why = i > 0 ? e.slice(i + 2) : e;
      const old = why.includes("показано дані з");
      const k = name + "|" + why.replace(/, показано дані з.*/, "");
      (bySource[k] ||= { name, why: why.replace(/, показано дані з.*/, ""), old, days: [] }).days.push(day);
    }
  }
  for (const p of Object.values(bySource)) {
    out.push({ level: p.old ? "warn" : "bad",
      title: `${p.name} не відповідає`,
      text: (p.old ? "Показано його останній вдалий розклад (до 12 годин). " : "Його сеансів у застосунку зараз немає. ") +
        `Дні: ${p.days.map(d => `${d.slice(8)}.${d.slice(5, 7)}`).join(", ")}. Помилка: ${p.why}. ` +
        "Якщо це триває довше за день, напишіть Claude у проєкті." });
  }
  for (const f of DATA.films) {
    if (f.translated || !f.synopsis || !f.shows.some(s => s.date >= now.date)) continue;
    out.push({ level: "warn", title: `Без українського опису: ${f.title}`,
      text: `Напишіть Claude у проєкті «переклади опис ${f.title}».`, pl: f.synopsis });
  }
  return out;
}

function renderStatus() {
  const list = problems();
  document.getElementById("alert").hidden = !list.length;
  document.getElementById("alert-n").textContent = list.length;
  const show = location.hash === "#status";
  document.getElementById("home").hidden = show;
  document.getElementById("status").hidden = !show;
  if (!show) return;
  document.getElementById("problems").innerHTML = list.length
    ? list.map(p => `<article class="problem${p.level === "warn" ? " warn" : ""}"><h3>${esc(p.title)}</h3><p>${esc(p.text)}</p>` +
      (p.pl ? `<p class="pl">${esc(p.pl)}</p>` : "") + `</article>`).join("")
    : '<p class="empty">Усе працює, проблем немає.</p>';
}

function footer() {
  const g = DATA.generated;
  const ageH = (Date.now() - new Date(DATA.generated_at)) / 36e5;
  document.getElementById("foot").textContent =
    `Розклад оновлено ${g.slice(8, 10)}.${g.slice(5, 7)} о ${g.slice(11)}. ` +
    "Українські назви й описи з TMDB і Планети Кіно; описи сірим ще не перекладені." +
    (ageH > 8 ? " Дані давно не оновлювалися, тож розклад може бути неповним." : "");
}

function setQuery(q) {
  document.getElementById("q").value = q;
  const u = new URL(location.href);
  if (q) u.searchParams.set("q", q); else u.searchParams.delete("q");
  history.replaceState(null, "", u);
  render();
}

async function load() {
  const q = new URL(location.href).searchParams.get("q") || "";
  document.getElementById("q").value = q;
  try {
    const r = await fetch("data.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    DATA = await r.json();
    if (DEMO) demoData();
  } catch (e) {
    document.getElementById("out").innerHTML = '<p class="err">Не вдалося завантажити розклад. Перевірте інтернет і відкрийте ще раз.</p>';
    return;
  }
  markNews();
  footer();
  render();
  renderStatus();
}

// Демо-режим (?demo): вигадані новинки й проблеми поверх справжнього розкладу, щоб побачити, як вони виглядають.
// Нічого не зберігає й не змінює «минуле відкриття».
const DEMO = new URL(location.href).searchParams.has("demo");
function demoData() {
  const today = warsawNow().date;
  DATA.films.forEach((f, i) => { f.first_seen = new Date(Date.now() - (i + 1) * 864e5).toISOString(); });
  const f = DATA.films[0];
  if (f) Object.assign(f, { translated: false,
    synopsis: "Przykładowy opis po polsku: tak wygląda film, dla którego nie ma jeszcze ukraińskiego tłumaczenia." });
  // другий фільм без оцінок: так видно порожні IMDb і Rotten Tomatoes
  if (DATA.films[1]) Object.assign(DATA.films[1], { imdb_rating: "", rt: "" });
  DATA.errors = { [today]: ["Helios: HTTP Error 503: Service Unavailable", "Multikino: timed out, показано дані з 10:17"],
    [addDays(today, 1)]: ["Helios: HTTP Error 503: Service Unavailable"] };
  DATA.generated_at = new Date(Date.now() - 7 * 36e5).toISOString();
  if (document.getElementById("demo-bar")) return;  // свіжий розклад після повернення на вкладку: напис уже є
  const bar = document.createElement("p");
  bar.id = "demo-bar";
  bar.className = "err";
  bar.innerHTML = 'Демо-режим: новинки, проблеми й порожні рейтинги тут вигадані. <a href="./">Вийти з демо</a>';
  document.querySelector(".wrap").prepend(bar);
}

// Новинки: фільми, що вперше зʼявилися в розкладі після минулого відкриття застосунку на цьому пристрої.
// Дата відкриття живе лише в браузері (localStorage), нічого нікуди не надсилається.
function markNews() {
  // Памʼятаємо версію розкладу (коли робот його зібрав), а не годинник пристрою: так фільм,
  // знайдений роботом за хвилину до вашого відкриття, але ще не опублікований, не загубиться.
  let since = null;
  if (DEMO) since = new Date(Date.now() - 30 * 864e5).toISOString();
  else try {
    since = localStorage.getItem("kino-seen-version") || localStorage.getItem("kino-last-visit");
    if (DATA.generated_at) {
      localStorage.setItem("kino-seen-version", DATA.generated_at);
      localStorage.removeItem("kino-last-visit");
    }
  } catch (e) { /* приватний режим: без новинок */ }
  // лише фільми, на які ще можна піти: хоч один сеанс попереду
  const now = warsawNow();
  const ahead = s => s.date > now.date || (s.date === now.date && s.time > now.time);
  const fresh = since ? DATA.films.filter(f => f.first_seen && new Date(f.first_seen) > new Date(since) && f.shows.some(ahead)) : [];
  NEWS = { since, keys: new Set(fresh.map(f => f.key)) };
  const box = document.getElementById("news");
  box.hidden = !fresh.length;
  if (!fresh.length) return;
  const d = new Date(since);
  const when = `${d.getDate()} ${UK_MONTHS[d.getMonth()]}`;
  box.innerHTML = `<p>Нове з вашого минулого відкриття (${esc(when)}): ` +
    fresh.map(f => `<button data-q="${esc(f.title_uk || f.title)}">${esc(f.title_uk || f.title)}</button>`).join(", ") + ".</p>";
}

window.addEventListener("hashchange", () => { if (DATA) renderStatus(); window.scrollTo(0, 0); });
document.getElementById("q").addEventListener("input", () => setQuery(document.getElementById("q").value));
document.getElementById("search").addEventListener("submit", e => { e.preventDefault(); document.getElementById("q").blur(); });
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-q]");
  if (b) setQuery(b.dataset.q);
  const sh = e.target.closest("button[data-share]");
  if (sh) shareFilm(sh.dataset.share);
  if (e.target.closest("#share-all")) shareAll();
});

// «Поділитися»: назви й сеанси з екрана; на телефоні системне меню, на компі копія в буфер
const filmName = f => f.title_uk && f.title_uk !== f.title ? `${f.title_uk} (${f.title})` : f.title;
const appUrl = q => location.origin + location.pathname + (q ? "?q=" + encodeURIComponent(q) : "");

async function shareFilm(key) {
  const f = SHOWN.find(x => x.key === key);
  if (!f) return;
  const lines = [filmName(f), ""];
  for (const s of f.shows.filter(s => !s.started)) {
    lines.push(`${dayLabel(s.date)}, ${s.time}, ${s.cinema}${safeUrl(s.link) ? ": " + s.link : ""}`);
  }
  await share(f.title_uk || f.title, lines.join("\n").trim(), appUrl(f.title_uk || f.title));
}

// Запит із конкретними датами замість «завтра» чи «вихідні»: посилання покаже ті самі дні й наступного дня
// Пошук лише за назвою чи кінотеатром дат не має: посилання покаже всі сеанси й тоді, коли додадуться нові
function pinnedQuery({ ranges, terms, dated }) {
  const dm = d => `${d.slice(8)}.${d.slice(5, 7)}`;
  const dates = !dated ? "" : ranges.map(([a, b]) => a === b ? dm(a) : `${dm(a)}-${dm(b)}`).join(" і ");
  return [dates, ...terms].filter(Boolean).join(" ");
}

// Увесь пошук: кожен фільм і його сеанси по днях, без посилань на квитки (вони за посиланням на застосунок)
async function shareAll() {
  if (!SHOWN_SEARCH) return;
  const label = rangeLabel(SHOWN_SEARCH.ranges);
  const head = "Кіно українською у Вроцлаві" + (label ? `, ${label}` : "");
  const blocks = [];
  for (const f of SHOWN) {
    const byDay = new Map();
    for (const s of f.shows.filter(s => !s.started)) {
      (byDay.get(s.date) || byDay.set(s.date, []).get(s.date)).push(`${s.time} ${s.cinema}`);
    }
    if (!byDay.size) continue;
    // без «сьогодні/завтра»: повідомлення можуть прочитати й наступного дня
    blocks.push([filmName(f), ...[...byDay].map(([d, list]) => `${dayLabel(d)}: ${list.join(", ")}`)].join("\n"));
  }
  if (!blocks.length) return;
  await share(head, [head, ...blocks].join("\n\n"), appUrl(pinnedQuery(SHOWN_SEARCH)));
}

async function share(title, text, url) {
  try {
    if (navigator.share) return await navigator.share({ title, text, url });
    await navigator.clipboard.writeText(text + "\n\n" + url);
    toast("Скопійовано, можна вставити в повідомлення");
  } catch (e) { /* користувач закрив меню */ }
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

// Відкритий застосунок щохвилини перевіряє, чи якийсь сеанс на екрані вже почався, і лише тоді перемальовує
// картки (фокус лишається на тій самій кнопці); прихована вкладка нічого не робить
setInterval(() => {
  if (!DATA || document.hidden) return;
  const now = warsawNow();
  const begun = SHOWN.some(f => f.shows.some(s => !s.started && (s.date < now.date || (s.date === now.date && s.time <= now.time))));
  if (begun) keepFocus(render);
  renderStatus();
}, 60 * 1000);

// Перемальовує, зберігаючи фокус на тій самій кнопці чи посиланні картки
function keepFocus(fn) {
  const a = document.activeElement;
  const sel = a && a.closest("#out") && (a.dataset.share ? `[data-share="${CSS.escape(a.dataset.share)}"]`
    : a.getAttribute("href") ? `[href="${CSS.escape(a.getAttribute("href"))}"]` : null);
  fn();
  if (sel) document.querySelector(`#out ${sel}`)?.focus();
}
// Розклад робот оновлює раз на 2 години, тож повторно качаємо його не частіше, ніж раз на 10 хвилин
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && DATA) refresh(); });
let FETCHED = Date.now();
async function refresh() {
  if (Date.now() - FETCHED > 10 * 60 * 1000) try {
    const r = await fetch("data.json", { cache: "no-cache" });
    if (r.ok) { DATA = await r.json(); FETCHED = Date.now(); if (DEMO) demoData(); footer(); }
  } catch (e) { /* офлайн: лишаємо, що є */ }
  keepFocus(render);
  renderStatus();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
document.querySelector("#share-all svg").outerHTML = SHARE_ICON;
load();
