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
  "(?<![\\d.])(\\d{1,2})(?![\\d./:a-zа-яіїєґ])",          // 25 (але не 3D і не 4DX)
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
  // ключ: регулярний вираз; «вихідн»/«тижд» з будь-яким закінченням, «усі» лише цілим словом
  const words = { "вихідн[а-яіїєґ]*": () => {
      const wd = weekday(today);
      if (wd === 0) return [today, today];
      const sat = addDays(today, (6 - wd + 7) % 7);
      return [sat, addDays(sat, 1)];
    },
    "тижд[а-яіїєґ]*": () => [today, addDays(today, 6)],
    "усі|все|всі|увесь|весь": () => [today, lastDay()],
  };
  for (const [re, fn] of Object.entries(words)) {
    q = q.replace(new RegExp(`(?:^|\\s)(?:${re})(?=\\s|$)`, "g"), () => { ranges.push(fn()); return " "; });
  }
  // час: «19:50» шукає сеанс саме тоді, «після 18» або «після 18:30» усі пізніші
  let after = null;
  const times = [];
  q = q.replace(/(?:після|after)\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:год|годин[а-яіїєґ]*))?(?=\s|$)/g, (_, h, m) => {
    if (+h > 23) return _;
    after = `${h.padStart(2, "0")}:${m || "00"}`;
    return " ";
  });
  q = q.replace(/(?<![\d.])(\d{1,2}):(\d{2})(?!\d)/g, (_, h, m) => { times.push(`${h.padStart(2, "0")}:${m}`); return " "; });
  const pts = [...q.matchAll(POINT)].map(m => ({ m, at: m.index, end: m.index + m[0].length, v: pointDates(m, today) }));
  let rest = q;
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
      rest = rest.slice(0, a.at) + " ".repeat(b.end - a.at) + rest.slice(b.end);
      i++;
      continue;
    }
    const d = a.v && a.v.bare ? resolveDay(a.v.bare, 0, 0, today) : a.v;
    if (d) ranges.push([d, d]);
    rest = rest.slice(0, a.at) + " ".repeat(a.end - a.at) + rest.slice(a.end);
  }
  const terms = rest.split(/[\s,;:]+/).filter(w => w && !STOP.has(w));
  return { ranges, terms, times, after };
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
const skel = s => lat(s).replace(/kh|ch/g, "h").replace(/[yj]/g, "i").replace(/w/g, "v").replace(/c/g, "k")
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
  return words.list.some(w => distance(t, w.slice(0, t.length), max) <= max ||
    (w.length !== t.length && distance(t, w, max) <= max));
}
const wordsOf = text => { const sk = skel(text); return { skel: sk, list: sk.split(/[^a-z0-9]+/).filter(w => w.length >= 3) }; };

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

function search(raw) {
  const now = warsawNow();
  let { ranges, terms, times, after } = parseQuery(raw, now.date);
  terms = terms.map(norm);
  const anyFilter = terms.length || times.length || after;
  let note = "";
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
  return { films, ranges, terms: [...terms, ...times, ...(after ? [`після ${after}`] : [])], now, note, explicit };
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
  const url = safeUrl(f.url);
  const title = (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(f.title)}</a>` : esc(f.title)) +
    (NEWS.keys.has(f.key) ? '<span class="tag">Новинка</span>' : "");
  const meta = filmMeta(f);
  const uk = f.title_uk && f.title_uk.toLowerCase() !== f.title.toLowerCase() ? `<p class="uk">${esc(f.title_uk)}</p>` : "";
  return `<article class="film"><h2>${title}</h2>${uk}${meta ? `<p class="meta">${esc(meta)}</p>` : ""}` +
    `<p class="syn${f.translated ? "" : " pl"}">${esc(f.synopsis || "Опису поки немає.")}</p>` +
    `<div class="shows">${rows.join("")}</div>` +
    `<button class="share" data-share="${esc(f.key)}">Поділитися</button></article>`;
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
  let html = (note ? `<p class="empty">${esc(note)}</p>` : "") + films.map(f => card(f, now.date, multiDay)).join("");
  if (!films.length) {
    const next = [...new Set(DATA.films.flatMap(f => f.shows.map(s => s.date)))].filter(d => d >= ranges[0][0]).sort().slice(0, 4);
    html = `<p class="empty">Українських сеансів за цим запитом не знайдено.` +
      (next.length ? ` Найближчі дні з сеансами: ${next.map(d => `<button data-q="${d.slice(8)}.${d.slice(5, 7)}">${esc(dayLabel(d, now.date))}</button>`).join(", ")}.` : "") +
      `</p>`;
  }
  if (ranges.some(([, b]) => b > lastDay())) {
    html += `<p class="empty">Розклад зібрано до ${esc(dayLabel(lastDay(), now.date))}; далі кінотеатри ще не публікують сеанси.</p>`;
  } else if (explicit && ranges.some(([, b]) => b > addDays(now.date, 6))) {
    html += `<p class="empty">Далі ніж на тиждень розклад неповний: DCF і Нові Горизонти публікують сеанси приблизно на тиждень наперед, тож тут ще можуть зʼявитися нові.</p>`;
  }
  const errs = Object.entries(DATA.errors || {}).filter(([d]) => ranges.some(([a, b]) => a <= d && d <= b));
  if (errs.length) html += `<p class="err">Не вдалося перевірити: ${errs.map(([d, e]) => esc(`${d.slice(8)}.${d.slice(5, 7)}: ${e.join("; ")}`)).join(" · ")}</p>`;
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
  DATA.errors = { [today]: ["Helios: HTTP Error 503: Service Unavailable", "Multikino: timed out, показано дані з 10:17"],
    [addDays(today, 1)]: ["Helios: HTTP Error 503: Service Unavailable"] };
  DATA.generated_at = new Date(Date.now() - 7 * 36e5).toISOString();
  const bar = document.createElement("p");
  bar.className = "err";
  bar.innerHTML = 'Демо-режим: новинки й проблеми тут вигадані. <a href="./">Вийти з демо</a>';
  document.querySelector(".wrap").prepend(bar);
}

// Новинки: фільми, що вперше зʼявилися в розкладі після минулого відкриття застосунку на цьому пристрої.
// Дата відкриття живе лише в браузері (localStorage), нічого нікуди не надсилається.
function markNews() {
  let since = null;
  if (DEMO) since = new Date(Date.now() - 30 * 864e5).toISOString();
  else try {
    since = localStorage.getItem("kino-last-visit");
    localStorage.setItem("kino-last-visit", new Date().toISOString());
  } catch (e) { /* приватний режим: без новинок */ }
  // лише фільми, на які ще можна піти: хоч один сеанс попереду
  const now = warsawNow();
  const ahead = s => s.date > now.date || (s.date === now.date && s.time > now.time);
  const fresh = since ? DATA.films.filter(f => f.first_seen && f.first_seen > since && f.shows.some(ahead)) : [];
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
  if (sh) share(sh);
});

// «Поділитися»: назва й сеанси з екрана; на телефоні системне меню, на компі копія в буфер
async function share(btn) {
  const f = SHOWN.find(x => x.key === btn.dataset.share);
  if (!f) return;
  const today = warsawNow().date;
  const lines = [f.title_uk && f.title_uk !== f.title ? `${f.title_uk} (${f.title})` : f.title, ""];
  for (const s of f.shows.filter(s => !s.started)) {
    lines.push(`${dayLabel(s.date, today)}, ${s.time}, ${s.cinema}${safeUrl(s.link) ? ": " + s.link : ""}`);
  }
  const text = lines.join("\n").trim();
  const url = location.origin + location.pathname + "?q=" + encodeURIComponent(f.title_uk || f.title);
  try {
    if (navigator.share) return await navigator.share({ title: f.title_uk || f.title, text, url });
    await navigator.clipboard.writeText(text + "\n\n" + url);
    btn.textContent = "Скопійовано";
    setTimeout(() => { btn.textContent = "Поділитися"; }, 2000);
  } catch (e) { /* користувач закрив меню */ }
}

// Відкритий застосунок щохвилини оновлює «вже почався», а після повернення на екран бере свіжий розклад
setInterval(() => { if (DATA) { render(); renderStatus(); } }, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && DATA) refresh(); });
async function refresh() {
  try {
    const r = await fetch("data.json", { cache: "no-cache" });
    if (r.ok) { DATA = await r.json(); footer(); }
  } catch (e) { /* офлайн: лишаємо, що є */ }
  render();
  renderStatus();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
load();
