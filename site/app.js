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

function dayLabel(s, today) {
  const rel = { 0: "сьогодні", 1: "завтра", 2: "післязавтра" }[(parseIso(s) - parseIso(today)) / 864e5];
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
  "(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?",           // 25.10, 25/10/2026
  `(\\d{1,2})\\s*(${MONTH_STEMS.join("|")})[а-яіїєґ]*`,     // 25 жовтня
  "(?<![\\d.])(\\d{1,2})(?![\\d./])",                       // 25
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
  const ranges = [];
  // слова-періоди
  const words = { "вихідн": () => {
      const wd = weekday(today);
      if (wd === 0) return [today, today];
      const sat = addDays(today, (6 - wd + 7) % 7);
      return [sat, addDays(sat, 1)];
    },
    "тижд": () => [today, addDays(today, 6)],
    "усі|все|всі|увесь|весь": () => [today, lastDay()],
  };
  for (const [re, fn] of Object.entries(words)) {
    q = q.replace(new RegExp(`(?:^|\\s)(?:${re})[а-яіїєґ]*`, "g"), () => { ranges.push(fn()); return " "; });
  }
  const pts = [...q.matchAll(POINT)].map(m => ({ m, at: m.index, end: m.index + m[0].length, v: pointDates(m, today) }));
  let rest = q;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const between = b && q.slice(a.end, b.at).trim();
    if (b && /^(-|–|—|по|до|і)?$/.test(between) && between !== "і" && (between || a.v.bare)) {
      // діапазон: «з 20 по 25 жовтня» бере місяць з другої дати
      let to = b.v.bare ? resolveDay(b.v.bare, 0, 0, today) : b.v;
      let from = a.v.bare
        ? (b.v.bare ? resolveDay(a.v.bare, 0, 0, today)
          : resolveDay(a.v.bare, parseIso(to).getUTCMonth() + 1, parseIso(to).getUTCFullYear(), today))
        : a.v;
      if (from && to) ranges.push(from <= to ? [from, to] : [to, from]);
      rest = rest.slice(0, a.at) + " ".repeat(b.end - a.at) + rest.slice(b.end);
      i++;
      continue;
    }
    const d = a.v && a.v.bare ? resolveDay(a.v.bare, 0, 0, today) : a.v;
    if (d) ranges.push([d, d]);
    rest = rest.slice(0, a.at) + " ".repeat(a.end - a.at) + rest.slice(a.end);
  }
  const terms = rest.split(/[\s,;]+/).filter(w => w && !STOP.has(w));
  return { ranges, terms };
}

// ---------------------------------------------------------------- пошук
const norm = s => (s || "").toLowerCase().replace(/[ʼ'’`]/g, "").replace(/ё/g, "е");

function search(raw) {
  const now = warsawNow();
  let { ranges, terms } = parseQuery(raw, now.date);
  if (!ranges.length) ranges = terms.length ? [[now.date, lastDay()]] : [[now.date, now.date]];
  const inRange = d => ranges.some(([a, b]) => a <= d && d <= b);
  const films = [];
  for (const f of DATA.films) {
    const filmText = norm([f.title, f.title_uk, f.original, ...(f.genres || [])].join(" "));
    const shows = f.shows.filter(s => {
      if (!inRange(s.date)) return false;
      const text = filmText + " " + norm([s.cinema, s.hall, s.version, DATA.cinemas[s.cinema]].join(" "));
      return terms.every(t => text.includes(t));
    }).map(s => ({ ...s, started: s.date < now.date || (s.date === now.date && s.time <= now.time) }));
    if (shows.length) films.push({ ...f, shows });
  }
  // фільми, де всі сеанси вже почалися, ідуть у кінці
  films.sort((a, b) => (a.shows.every(s => s.started) - b.shows.every(s => s.started)) ||
    (a.shows[0].date + a.shows[0].time).localeCompare(b.shows[0].date + b.shows[0].time));
  return { films, ranges, terms, now };
}

// ---------------------------------------------------------------- вивід
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
    rows.push(s.started
      ? `<div class="show past">${inner}<span class="buy">почався</span></div>`
      : `<a class="show" href="${esc(s.link)}" target="_blank" rel="noopener">${inner}<span class="buy">Квитки →</span></a>`);
  }
  const title = f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a>` : esc(f.title);
  const meta = filmMeta(f);
  const uk = f.title_uk && f.title_uk.toLowerCase() !== f.title.toLowerCase() ? `<p class="uk">${esc(f.title_uk)}</p>` : "";
  return `<article class="film"><h2>${title}</h2>${uk}${meta ? `<p class="meta">${esc(meta)}</p>` : ""}` +
    `<p class="syn${f.translated ? "" : " pl"}">${esc(f.synopsis || "Опису поки немає.")}</p>` +
    `<div class="shows">${rows.join("")}</div></article>`;
}

function render() {
  const raw = document.getElementById("q").value;
  const { films, ranges, terms, now } = search(raw);
  const multiDay = new Set(films.flatMap(f => f.shows.map(s => s.date))).size > 1 ||
    ranges.some(([a, b]) => a !== b);
  const nShows = films.reduce((n, f) => n + f.shows.length, 0);
  const label = rangeLabel(ranges, now.date);
  const summary = films.length ? `${plural(films.length, "фільм", "фільми", "фільмів")}, ${plural(nShows, "сеанс", "сеанси", "сеансів")}` : "";
  document.getElementById("sub").textContent =
    [label && label[0].toUpperCase() + label.slice(1), terms.length ? `«${terms.join(" ")}»` : "", summary].filter(Boolean).join(" · ");
  let html = films.map(f => card(f, now.date, multiDay)).join("");
  if (!films.length) {
    const next = [...new Set(DATA.films.flatMap(f => f.shows.map(s => s.date)))].filter(d => d >= ranges[0][0]).sort().slice(0, 4);
    html = `<p class="empty">Українських сеансів за цим запитом не знайдено.` +
      (next.length ? ` Найближчі дні з сеансами: ${next.map(d => `<button data-q="${d.slice(8)}.${d.slice(5, 7)}">${esc(dayLabel(d, now.date))}</button>`).join(", ")}.` : "") +
      `</p>`;
  }
  if (ranges.some(([, b]) => b > lastDay())) {
    html += `<p class="empty">Розклад зібрано до ${esc(dayLabel(lastDay(), now.date))}; далі кінотеатри ще не публікують сеанси.</p>`;
  }
  const errs = Object.entries(DATA.errors || {}).filter(([d]) => ranges.some(([a, b]) => a <= d && d <= b));
  if (errs.length) html += `<p class="err">Не вдалося перевірити: ${errs.map(([d, e]) => esc(`${d.slice(8)}.${d.slice(5, 7)}: ${e.join("; ")}`)).join(" · ")}</p>`;
  document.getElementById("out").innerHTML = html;
  document.querySelectorAll(".chips button").forEach(b => b.setAttribute("aria-pressed", String(norm(b.dataset.q) === norm(raw.trim()))));
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
    DATA = await r.json();
  } catch (e) {
    document.getElementById("out").innerHTML = '<p class="err">Не вдалося завантажити розклад. Перевірте інтернет і відкрийте ще раз.</p>';
    return;
  }
  footer();
  render();
}

document.getElementById("q").addEventListener("input", () => setQuery(document.getElementById("q").value));
document.getElementById("search").addEventListener("submit", e => { e.preventDefault(); document.getElementById("q").blur(); });
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-q]");
  if (b) setQuery(b.dataset.q);
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
load();
