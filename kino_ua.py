#!/usr/bin/env python3
"""Сеанси українською мовою в кінотеатрах Вроцлава.

Використання:
    python3 kino_ua.py                    # сьогодні
    python3 kino_ua.py завтра             # або: післязавтра, субота, 25.10, 2026-10-25
    python3 kino_ua.py сьогодні --json    # машинний формат
    python3 kino_ua.py --html kino.html   # гарна сторінка з картками фільмів
    python3 kino_ua.py --artifact kino.html  # те саме для публікації як Artifact (без doctype)

Лише стандартна бібліотека Python 3.8+.
"""
import concurrent.futures as cf
import datetime as dt
import html
import json
import os
import re
import sys
import threading
import time as _time
import urllib.error
import urllib.parse
import urllib.request

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Warsaw")
except Exception:  # Python < 3.9 або немає бази часових поясів
    TZ = None

UA_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "pl-PL,pl;q=0.9,uk;q=0.8",
}

# Ознаки українського сеансу в назвах і атрибутах. Короткі коди лише великими
# літерами, щоб не ловити випадкові "ua" у тексті.
UA_TEXT = re.compile(r"(?i:ukrai|ukraï|ukrain|українськ)|\bUA\b|\bUKR?\b")
# Позначка української версії в кінці назви: "- UA", "(UKR)", "ukraiński dubbing",
# "wersja ukraińska", "| dubbing UA"... Слово "Ukraina" саме по собі не позначка.
UA_SUFFIX = re.compile(
    r"\s*[-–|,(\[]?\s*(?:(?:wersja|dubbing|napisy|lektor)\s+)?"
    r"\b(?:UA|UKR|ukraiń\w*|ukrainian|ukraïn\w*|українськ\w*)"
    r"(?:\s+(?:dubbing|napisy|lektor|wersja|version|dub)\w*)?\s*[)\]]?\s*$", re.I)


def now():
    """Поточний час у Вроцлаві (а не в часовому поясі машини, де запущено скрипт)."""
    if TZ:
        return dt.datetime.now(TZ).replace(tzinfo=None)
    # Запасний варіант: Польща UTC+1, літній час з останньої неділі березня до останньої неділі жовтня.
    utc = dt.datetime.utcnow()
    y = utc.year
    last_sun = lambda m: max(dt.date(y, m, d) for d in range(25, 32)
                             if dt.date(y, m, d).weekday() == 6)
    summer = dt.datetime.combine(last_sun(3), dt.time(1)) <= utc < \
        dt.datetime.combine(last_sun(10), dt.time(1))
    return utc + dt.timedelta(hours=2 if summer else 1)


TIMEOUT = 20  # с на один запит: лише щоб завислий сайт не тримав запуск вічно


def fetch(url, accept="application/json", tries=2):
    req = urllib.request.Request(url, headers={**UA_HEADERS, "Accept": accept})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code < 500 or i == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if i == tries - 1:
                raise
        _time.sleep(1.5)


# ------------------------------------------------------------------- Кеш
# Дані, що майже не змінюються (список кінотеатрів Helios, назви й описи фільмів,
# країна виробництва, посилання на квитки DCF), зберігаються на диску, щоб
# повторний запуск не робив ланцюжків запитів. Готовий результат на дату живе
# RESULT_TTL секунд (повторний запит у цей час миттєвий); --fresh його оминає.
HERE = os.path.dirname(os.path.realpath(__file__)) if os.path.isabs(__file__) else \
    os.path.dirname(os.path.join(os.environ.get("PWD", "."), __file__))
CACHE_FILE = os.path.join(HERE, ".kino_cache.json")
RESULT_TTL = 10 * 60
_cache, _cache_lock, _cache_dirty = None, threading.Lock(), False


def _load_cache():
    global _cache
    if _cache is None:
        try:
            with open(CACHE_FILE, encoding="utf-8") as fh:
                _cache = json.load(fh)
        except (OSError, ValueError):
            _cache = {}
    return _cache


def cached(kind, key, ttl, fn):
    """Повертає fn(), запам'ятовуючи результат на ttl секунд."""
    global _cache_dirty
    with _cache_lock:
        hit = _load_cache().get(kind, {}).get(key)
    if hit and _time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    with _cache_lock:
        _load_cache().setdefault(kind, {})[key] = [_time.time(), value]
        _cache_dirty = True
    return value


def save_cache():
    if not _cache_dirty:
        return
    now_ts = _time.time()
    try:  # фоновий процес міг записати свіже: зливаємо, перемагає новіший запис
        with open(CACHE_FILE, encoding="utf-8") as fh:
            disk = json.load(fh)
    except (OSError, ValueError):
        disk = {}
    with _cache_lock:
        for k, v in _cache.items():
            d = disk.setdefault(k, {})
            for kk, vv in v.items():
                if kk not in d or d[kk][0] <= vv[0]:
                    d[kk] = vv
        # викидаємо записи, старші за 60 днів; розклади на конкретний день (source,
        # result) потрібні лише ~12 годин, тож їх тримаємо 2 дні
        keep = {"source": 2 * 86400, "result": 2 * 86400}
        data = {k: {kk: vv for kk, vv in v.items() if now_ts - vv[0] < keep.get(k, 60 * 86400)}
                for k, v in disk.items()}
    try:
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, CACHE_FILE)
    except OSError:
        pass


DAY, MONTH = 86400, 30 * 86400


WEEKDAYS = {"понеділок": 0, "вівторок": 1, "середа": 2, "середу": 2, "четвер": 3,
            "пятниця": 4, "п'ятниця": 4, "п’ятниця": 4, "пʼятниця": 4, "пятницю": 4,
            "п'ятницю": 4, "субота": 5, "суботу": 5, "неділя": 6, "неділю": 6}
UK_DAYS = ["понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота", "неділя"]
UK_MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня",
             "серпня", "вересня", "жовтня", "листопада", "грудня"]


def parse_date(arg):
    today = now().date()
    a = re.sub(r"^(в|у|на)\s+", "", (arg or "").strip().lower())
    if a in ("", "сьогодні", "сегодня", "today", "dzis", "dziś"):
        return today
    if a in ("завтра", "tomorrow", "jutro"):
        return today + dt.timedelta(days=1)
    if a in ("післязавтра", "pojutrze"):
        return today + dt.timedelta(days=2)
    if a in WEEKDAYS:
        return today + dt.timedelta(days=(WEEKDAYS[a] - today.weekday()) % 7)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", a):
        return dt.date.fromisoformat(a)
    m = re.fullmatch(r"(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?", a)
    if m:
        d, mo = int(m[1]), int(m[2])
        y = int(m[3]) if m[3] else today.year
        day = dt.date(y, mo, d)
        if not m[3] and day < today - dt.timedelta(days=60):
            day = dt.date(y + 1, mo, d)  # "05.01", сказане в грудні, означає наступний рік
        return day
    raise SystemExit(f"Не розумію дату: {arg!r}")


def hhmm(t):
    m = re.search(r"(\d{1,2}):(\d{2})", t or "")
    return f"{int(m[1]):02d}:{m[2]}" if m else (t or "")


def show(cinema, title, time, version, link, note="", about=""):
    """Один сеанс. about: сторінка фільму, звідки можна взяти опис."""
    return {"cinema": cinema, "title": cc_clean_title(title), "time": hhmm(time), "version": version,
            "link": link, "note": note, "about": about}


def title_key(t):
    """Ключ для об'єднання одного фільму з різних джерел:
    'Street Fighter. Uliczny Wojownik' і 'Street Fighter: uliczny wojownik' -> 'streetfighter'."""
    t = re.sub(r"\s*\|.*$", "", t)                       # "Sanatorium | KinoUkraïna"
    t = re.split(r"\s*[.:–—]\s+|\s+-\s+", t)[0]          # частина до підзаголовка
    return re.sub(r"[^0-9a-ząćęłńóśźżа-яіїєґ]", "", t.lower())


def _strip(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def short(text, limit=260):
    """Скорочує опис до 1-2 речень."""
    text = _strip(text or "")
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[:end + 1] if end > 80 else cut.rsplit(" ", 1)[0] + "…"


def meta_description(url):
    return cached("about", url, MONTH, lambda: _meta_description(url))


def _meta_description(url):
    page = fetch(url, accept="text/html")
    for pat in (r'<meta[^>]+property="og:description"[^>]+content="([^"]+)"',
                r'<meta[^>]+name="description"[^>]+content="([^"]+)"',
                r'itemprop="description"[^>]*>(.*?)</'):
        m = re.search(pat, page, re.S)
        if m and len(_strip(m[1])) > 40:
            return short(m[1])
    return ""


# ---------------------------------------------------------------- Cinema City
# Перевірено 2026-10-18: офіційний JSON API сайту.
CC_API = "https://www.cinema-city.pl/pl/data-api-service/v1/quickbook/10103"
CC_CINEMAS = {"1067": "Cinema City Korona", "1097": "Cinema City Wroclavia"}
CC_VERSION = {"dubbed-lang-uk": "дубляж UA", "subbed-lang-uk": "субтитри UA",
              "first-subbed-lang-uk": "субтитри UA",
              "original-lang-uk": "оригінал українською"}


def cc_clean_title(name):
    # "Verity. Coraz większy mrok ukraiński dubbing" -> "Verity. Coraz większy mrok"
    return UA_SUFFIX.sub("", name).strip() or name


def cinema_city(day):
    out = []
    for cid, cname in CC_CINEMAS.items():
        url = f"{CC_API}/film-events/in-cinema/{cid}/at-date/{day}?attr=&lang=pl_PL"
        body = json.loads(fetch(url)).get("body") or {}
        films = {f["id"]: f for f in body.get("films", [])}
        for ev in body.get("events", []):
            film = films.get(ev["filmId"], {})
            attrs = ev.get("attributeIds", []) + film.get("attributeIds", [])
            versions = sorted({v for a, v in CC_VERSION.items() if a in attrs})
            if not versions:
                continue
            fmt = " ".join(x.upper() for x in ("4dx", "imax", "vip", "3d") if x in attrs)
            out.append(show(cname, cc_clean_title(film.get("name", "?")),
                            ev["eventDateTime"][11:16], ", ".join(versions),
                            ev.get("bookingLink") or film.get("link", ""),
                            " ".join(filter(None, [ev.get("auditorium", ""), fmt])),
                            film.get("link", "")))
    return out


# ------------------------------------------------------------------- Filmweb
# Перевірено 2026-10-18: filmweb.pl/showtimes/Wrocław/<кінотеатр>-<id>?day=N
# (N = днів від сьогодні, 0..~20) віддає HTML з сеансами та описами фільмів;
# український дубляж позначено data-lang="dubbing UK". Filmweb іноді пропускає
# сеанси, тому для більшості кінотеатрів він лише доповнює їхні власні джерела,
# а для Multikino (сайт закритий Cloudflare) є основним джерелом.
FW = "https://www.filmweb.pl/showtimes/Wroc%C5%82aw/"
FW_CINEMAS = {
    "Multikino+Pasa%C5%BC+Grunwaldzki-638": "Multikino Pasaż Grunwaldzki",
    "Cinema+City+Wroclavia-2019": "Cinema City Wroclavia",
    "IMAX-2026": "Cinema City Wroclavia",
    "Cinema+City+Korona-169": "Cinema City Korona",
    "Helios+Magnolia+Park-1133": "Helios Galeria Magnolia",
    "Helios+Aleja+Bielany-1911": "Helios Aleja Bielany",
    "Kino+Nowe+Horyzonty-1737": "Kino Nowe Horyzonty",
    "Dolno%C5%9Bl%C4%85skie+Centrum+Filmowe-1475": "DCF (Dolnośląskie Centrum Filmowe)",
    "Dyskusyjny+Klub+Filmowy+Politechnika-1645": "DKF Politechnika",
}
GENRES_UK = {
    "akcja": "бойовик", "animacja": "анімація", "biograficzny": "біографічний",
    "dokumentalny": "документальний", "dramat": "драма", "familijny": "сімейний",
    "fantasy": "фентезі", "horror": "жахи", "komedia": "комедія", "kryminał": "кримінал",
    "musical": "мюзикл", "muzyczny": "музичний", "przygodowy": "пригоди",
    "romans": "мелодрама", "sci-fi": "фантастика", "thriller": "трилер",
    "wojenny": "воєнний", "historyczny": "історичний", "sensacyjny": "бойовик",
    "psychologiczny": "психологічний", "obyczajowy": "побутова драма",
    "dla dzieci": "для дітей", "kostiumowy": "костюмний", "western": "вестерн",
    "komedia rom.": "романтична комедія", "kino familijne": "сімейний",
    "sztuki walki": "бойові мистецтва", "komedia romantyczna": "романтична комедія",
    "katastroficzny": "фільм-катастрофа", "kryminalny": "кримінал", "baśń": "казка",
    "dramat historyczny": "історична драма", "dramat obyczajowy": "побутова драма",
    "dreszczowiec": "трилер", "melodramat": "мелодрама", "szpiegowski": "шпигунський",
}
_fw_cache = {}


def _fw_page(path, offset):
    page = fetch(f"{FW}{path}?day={offset}", accept="text/html")
    shows, info = [], {}
    for block in page.split("showtimesFilmsListSection__film ShowtimesFilmsItem")[1:]:
        t = re.search(r'itemprop="name" content="([^"]*)"', block)
        title = html.unescape(t[1]) if t else "?"
        plot = re.search(r'preview__plotText[^>]*>(.*?)</div>', block, re.S)
        year = re.search(r'preview__year"[^>]*>(\d{4})', block)
        dur = re.search(r'preview__duration" content="\s*PT(?:(\d+)H)?(?:(\d+)M)?', block)
        genres = re.findall(r'entity@genre:\d+"[^>]*>([^<]+)<', block)
        url = re.search(r'class="preview__link" href="([^"]+)"', block)
        poster = re.search(r'class="poster__image"[^>]*src="([^"]+)"', block)
        alt = re.search(r'preview__alternateTitle"[^>]*>([^<]+)<', block)
        info[title_key(title)] = {
            "synopsis": short(plot[1]) if plot else "",
            "year": year[1] if year else "",
            "minutes": (int(dur[1] or 0) * 60 + int(dur[2] or 0)) if dur else 0,
            "genres": list(dict.fromkeys(GENRES_UK.get(g.strip().lower(), g.strip().lower())
                                         for g in genres)),
            "url": "https://www.filmweb.pl" + url[1] if url and url[1].startswith("/") else "",
            "poster": poster[1] if poster else "",
            "original": html.unescape(alt[1]).strip() if alt else "",
        }
        for d, typ, lang, time, link in re.findall(
                r'data-date="([^"]*)" data-type="([^"]*)" data-lang="([^"]*)" '
                r'data-value="([^"]*)"[^>]*>\s*<div[^>]*>\s*'
                r'(?:<a class="seanceTile__link" href="([^"]*)")?', block):
            if not re.search(r"\bUK\b", lang):
                continue
            version = "субтитри UA" if "subtitles" in lang else "дубляж UA"
            shows.append((d, show(FW_CINEMAS[path], title, time, version,
                                  html.unescape(link) or FW + path,
                                  " ".join(filter(None, [typ.upper(), "за даними Filmweb"])))))
    return shows, info


# Кінотеатри, для яких Filmweb є основним джерелом (у них немає свого відкритого
# розкладу). Решту сторінок Filmweb читаємо лише для перехресної перевірки (--full)
# або коли бракує опису нового фільму: кожна сторінка ~370 КБ і ~1 с.
FW_PRIMARY = ["Multikino+Pasa%C5%BC+Grunwaldzki-638", "Dyskusyjny+Klub+Filmowy+Politechnika-1645"]


def filmweb_pages(day, paths):
    """Повертає (сеанси українською, {ключ назви: інфо про фільм}) з вибраних сторінок."""
    paths = [p for p in paths if (day, p) not in _fw_cache]
    offset = (day - now().date()).days
    if paths and offset < 0:
        raise RuntimeError("Filmweb не показує минулі дні")
    if paths:
        with cf.ThreadPoolExecutor(len(paths)) as ex:
            for p, (s, i) in zip(paths, ex.map(lambda p: _fw_page(p, offset), paths)):
                _fw_cache[(day, p)] = ([x for d, x in s if d == str(day)], i)
                for k, v in i.items():  # опис фільму не змінюється: тримаємо місяць
                    cached("fw_info", k, MONTH, lambda v=v: v)
    shows = []
    for (d, p), (s, _) in list(_fw_cache.items()):
        if d == day:
            shows += s
    return shows


def multikino(day):
    # Сайт multikino.pl закритий перевіркою Cloudflare, тому беремо його розклад з
    # Filmweb; посилання ведуть прямо на бронювання multikino.pl.
    return [x for x in filmweb_pages(day, FW_PRIMARY) if x["cinema"] == FW_CINEMAS[FW_PRIMARY[0]]]


def dkf(day):
    return [x for x in filmweb_pages(day, FW_PRIMARY) if x["cinema"] == FW_CINEMAS[FW_PRIMARY[1]]]


def fw_info(key):
    with _cache_lock:
        hit = _load_cache().get("fw_info", {}).get(key)
    return hit[1] if hit else {}


# -------------------------------------------------------------------- Helios
# Перевірено 2026-10-18: restapi.helios.pl відкритий (сам helios.pl з хмари
# недоступний). Кінотеатри у Вроцлаві: Aleja Bielany, Galeria Magnolia.
# У сеансі є speakingType (ORG/Napisy/DUB), language, subtitles, release;
# мова дубляжу окремо не позначена, тому шукаємо UA у цих полях і в назві.
HELIOS_API = "https://restapi.helios.pl/api"
HELIOS_SITE = "https://helios.pl/"


def helios(day):
    cinemas = cached("helios_cinemas", "wroclaw", 7 * DAY, lambda: [
        {"id": c["id"], "name": c["name"]} for c in json.loads(fetch(f"{HELIOS_API}/cinema"))
        if str(c.get("city", "")).lower().startswith("wroc")])
    if not cinemas:
        raise RuntimeError("не знайдено кінотеатрів Helios у Вроцлаві в API")
    def day_list(c):
        name = "Helios " + re.sub(r"^WROCŁAW\s*", "", c["name"])
        url = (f"{HELIOS_API}/cinema/{c['id']}/screening"
               f"?dateTimeFrom={day}T00:00:00&dateTimeTo={day}T23:59:59")
        return [(name, s) for s in json.loads(fetch(url))]
    with cf.ThreadPoolExecutor(4) as ex:
        screenings = [x for part in ex.map(day_list, cinemas) for x in part]

    def movie(mid):
        def load():
            m = json.loads(fetch(f"{HELIOS_API}/movie/{mid}"))
            return {k: m.get(k) for k in ("title", "onlineTitle", "originalTitle",
                                          "shortDescription", "description")}
        try:
            return mid, cached("helios_movie2", mid, MONTH, load)  # 2: з originalTitle
        except Exception:
            return mid, {}
    with cf.ThreadPoolExecutor(12) as ex:
        movies = dict(ex.map(movie, {s.get("movieId") for _, s in screenings}))
    # Українська версія інколи окремий фільм з транслітом: "Hlynolykyi - UA" (оригінал
    # "Clayface"). Назву тоді беремо з польської версії того ж фільму або оригінальну.
    polish = {m.get("originalTitle"): m.get("title") for m in movies.values()
              if m.get("originalTitle") and not UA_SUFFIX.search(m.get("title") or "")}
    out = []
    for name, s in screenings:
        m = movies.get(s.get("movieId")) or {}
        title = m.get("title") or m.get("onlineTitle") or "?"
        fields = " ".join(str(s.get(k) or "") for k in
                          ("language", "subtitles", "subtitles2", "release",
                           "onlineRelease", "movieSubPrintLabel"))
        if not UA_TEXT.search(fields + " " + title):
            continue
        original = m.get("originalTitle") or ""
        if UA_SUFFIX.search(title) and original:
            title = polish.get(original) or original
        kind = str(s.get("speakingType", "")).lower()
        version = "субтитри UA" if "nap" in kind else "дубляж UA" if "dub" in kind \
            else "українською (див. деталі)"
        x = show(name, cc_clean_title(title), s["screeningTimeFrom"][11:16],
                 version, HELIOS_SITE, s.get("printType") or "")
        x["synopsis"] = short(m.get("shortDescription") or m.get("description") or "")
        x["original"] = original
        out.append(x)
    return out


# ------------------------------------------------------- Kino Nowe Horyzonty
# Перевірено 2026-10-18: сторінка kinonh.pl довантажує розклад з rep.json?dzien=DD-MM-YYYY
# (HTML у полі "lista"). Версія показу в мітках data-etykieta (dubbing, napisy...).
# Ознак мови дубляжу немає, тому додатково дивимось країну виробництва на
# сторінці фільму: українські фільми показуються мовою оригіналу.
NH = "https://www.kinonh.pl/"


def nowe_horyzonty(day):
    data = json.loads(fetch(f"{NH}rep.json?dzien={day.strftime('%d-%m-%Y')}&forwardback="))
    if data.get("blad"):
        raise RuntimeError(data["blad"])
    films = []
    for box in (data.get("lista") or "").split('class="boks')[1:]:
        m = re.search(r'class="tyt" href="(op\.s\?id=\d+)">(.*?)</a>', box, re.S)
        if m:
            films.append((box, m[1], _strip(m[2])))

    def production(f):
        def load():
            m = re.search(r"produkcja:\s*([^<]*)", fetch(NH + f[1], accept="text/html"))
            return m[1].strip() if m else ""
        try:
            return cached("nh_production", f[1], MONTH, load)
        except Exception:
            return ""
    with cf.ThreadPoolExecutor(16) as ex:
        prods = list(ex.map(production, films))
    out = []
    for (box, op, title), prod in zip(films, prods):
        labels = re.findall(r"data-etykieta='([^']*)'", box)
        ua_label = UA_TEXT.search(title + " " + " ".join(labels))
        if not ua_label and "Ukrain" not in prod:
            continue
        version = ("дубляж UA" if ua_label and "dubbing" in labels else
                   "українською" if ua_label else "український фільм, мова оригіналу")
        # Усі сеанси дня, і ті, на які квитків уже немає (у них посилання javascript:).
        for href, t in re.findall(r"<a id='ev_\d+' href='([^']*)'[^>]*>(\d{1,2}:\d{2})</a>", box):
            link = NH + href if href.startswith("bilet.s") else NH + op
            note = ", ".join(filter(None, [prod, ", ".join(labels)]))
            out.append(show("Kino Nowe Horyzonty", title, t, version, link, note, NH + op))
    return out


# ----------------------------------------------- DCF (Dolnośląskie Centrum Filmowe)
# Перевірено 2026-10-18. Українські покази йдуть у циклі "KinoUkraïna" (фільми
# мовою оригіналу). Беремо сторінку циклу: там кожен показ має дату й посилання на
# сторінку фільму, і покази не зникають після початку. Загальний репертуар
# (dcf.wroclaw.pl/repertuar) не читаємо: він відповідає ~3 с і нічого не додає.
DCF = "https://dcf.wroclaw.pl/repertuar/"
DCF_CYCLE = "https://dcf.wroclaw.pl/cykle/kino-ukraina/"
DCF_NAME = "DCF (Dolnośląskie Centrum Filmowe)"


def dcf(day):
    want = day.strftime("%d.%m.%Y")
    out = []
    cycle = fetch(DCF_CYCLE, accept="text/html")
    for m in re.finditer(r'single__info">\s*(\d{2}\.\d{2}\.\d{4})\s+(\d{1,2}:\d{2}).*?'
                         r'<h3[^>]*>\s*<a href="([^"]+)">(.*?)</a>', cycle, re.S):
        if m[1] != want:
            continue
        def tickets(url=m[3]):
            t = re.search(r'https://dcf\.bilety24\.pl/kup-bilety/\?id=\d+',
                          fetch(url, accept="text/html"))
            return t[0] if t else url
        x = show(DCF_NAME, _strip(m[4]), m[2], "мова оригіналу, цикл KinoUkraïna",
                 cached("dcf_tickets", f"{m[3]}|{want}|{m[2]}", DAY, tickets), "", m[3])
        out.append(x)
    return out


SOURCES = [("Cinema City", cinema_city), ("Multikino", multikino), ("DKF Politechnika", dkf),
           ("Helios", helios), ("Kino Nowe Horyzonty", nowe_horyzonty), ("DCF", dcf)]
CINEMA_MAPS = {
    "Cinema City Wroclavia": "Wroclavia, вул. Sucha 1",
    "Cinema City Korona": "Korona, вул. Bolesława Krzywoustego 126",
    "Multikino Pasaż Grunwaldzki": "Pasaż Grunwaldzki, pl. Grunwaldzki 22",
    "Helios Galeria Magnolia": "Magnolia Park, вул. Legnicka 58",
    "Helios Aleja Bielany": "Aleja Bielany, вул. Czekoladowa 7-9, Bielany Wrocławskie",
    "Kino Nowe Horyzonty": "вул. Kazimierza Wielkiego 19a-21",
    DCF_NAME: "вул. Piłsudskiego 64a",
    "DKF Politechnika": "Політехніка, wyb. Wyspiańskiego 27",
}


# ------------------------------------------------- Українські назва й опис
# Перевірено 2026-10-18. Після TMDB (нижче) шукаємо фільм на Планеті Кіно
# (planetakino.ua/movie/<slug оригінальної назви>/, один запит на фільм).
# Результат тримаємо місяць, тож пошук іде лише для нових фільмів. Польських
# фільмів, яких нема в українському прокаті, там не буде: для них лишається
# synopsis_uk.json. Multiplex не використовуємо: пошук там вимагає обходу всієї
# афіші (десятки сторінок, до хвилини).
PK = "https://planetakino.ua"


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception:
        return None


def _slug(t):
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")


def _pk_movie(original):
    page = fetch(f"{PK}/movie/{_slug(original)}/", accept="text/html")
    title = re.search(r"<title>(.*?)\s*(?:\(\d{4}\))?\s*—", page)
    name = html.unescape(title[1]).strip() if title else ""
    descs = [json.loads(f'"{d}"') for d in re.findall(r'escription:"((?:[^"\\]|\\.){60,})"', page)]
    plot = next((d for d in descs if name and name.split(":")[-1].strip()[:12] in d
                 and "квитки" not in d), "")
    return {"name": name, "original": original, "synopsis": short(plot),
            "url": f"{PK}/movie/{_slug(original)}/"} if name else None


# TMDB (api.themoviedb.org): один пошуковий запит на фільм з language=uk-UA дає
# українські назву й опис. Ключ береться зі змінної TMDB_API_KEY (ключ API v3 або
# токен v4); без ключа запит усе одно пробуємо, раптом середовище підставляє
# його саме. Опис українською буває порожнім для нішевих фільмів.
TMDB = "https://api.themoviedb.org/3"
CYRILLIC = re.compile("[\u0400-\u04ff]")


def is_ukrainian(text):
    """Текст переважно кирилицею (а не польський опис з кількома кириличними назвами)."""
    cyr = len(CYRILLIC.findall(text))
    return cyr > 0 and cyr > len(re.findall(r"[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]", text))


def _tmdb_movie(title, original, year):
    key = os.environ.get("TMDB_API_KEY", "").strip()
    headers = {}
    params = {"query": original or title, "language": "uk-UA", "include_adult": "false"}
    if key.startswith("ey"):           # токен доступу v4
        headers["Authorization"] = f"Bearer {key}"
    elif key:
        params["api_key"] = key
    def search(extra):
        url = f"{TMDB}/search/movie?" + urllib.parse.urlencode({**params, **extra})
        req = urllib.request.Request(url, headers={**UA_HEADERS, **headers,
                                                   "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8")).get("results") or []
    results = search({"year": year} if year else {}) or (search({}) if year else [])
    if not results:
        return None
    m = results[0]
    if not m.get("title"):
        return None
    # у TMDB трапляється латинська «i» серед кирилиці («Верітi»)
    fix = lambda t: re.sub(r"(?<=[\u0400-\u04ff])[iI]|[iI](?=[\u0400-\u04ff])",
                           lambda x: "і" if x.group() == "i" else "І", t)
    return {"name": fix(m["title"]), "original": m.get("original_title", ""),
            "synopsis": fix(short(m.get("overview") or "")),
            "url": f"https://www.themoviedb.org/movie/{m['id']}?language=uk-UA"}


def ukrainian_info(films):
    """Для кожного фільму {ключ: {name, synopsis, url}} з українських сайтів (з кешем)."""
    out, todo = {}, []
    with _cache_lock:
        known = _load_cache().get("ua_info", {})
    for key, f in films.items():
        hit = known.get(key)
        if hit and _time.time() - hit[0] < (MONTH if hit[1] else 7 * DAY):
            if hit[1]:
                out[key] = hit[1]
        else:
            todo.append((key, f))
    if not todo:
        return out
    tmdb_failed = set()  # TMDB не відповів (ключ, мережа): такий «не знайдено» не кешуємо
    def tmdb(f):
        name = f.get("original") or re.split(r"\s*[.:]\s+", f["title"])[0]
        try:
            m = _tmdb_movie(f["title"], name, f.get("year") or "")
        except Exception:
            tmdb_failed.add(f["title"])
            return None
        # без опису українською TMDB дає лише назву: опис доберемо з інших джерел
        return m
    def find(item):
        key, f = item
        t = tmdb(f)
        if t and t["synopsis"]:
            return t
        names = [n for n in (f.get("original"), f["title"]) if n]
        for n in names:
            m = _safe(_pk_movie, re.split(r"\s*[.:]\s+", n)[0] if n == f["title"] else n)
            if m:
                return m
        return t  # хоча б українська назва з TMDB
    with cf.ThreadPoolExecutor(8) as ex:
        for (key, f), m in zip(todo, ex.map(find, todo)):
            if m or f["title"] not in tmdb_failed:
                cached("ua_info", key, 0, lambda m=m: m)
            if m:
                out[key] = m
    return out


# Власні переклади: {ключ назви: опис} або {ключ: {"title": ..., "synopsis": ...}}. Скрипт сам не перекладає
# (лише стандартна бібліотека), тому переклади дописує Claude у цей файл
# перед публікацією сторінки; вони зберігаються й для наступних днів.
TRANSLATIONS = os.path.join(HERE, "synopsis_uk.json")


def load_translations():
    try:
        with open(TRANSLATIONS, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


POOL = cf.ThreadPoolExecutor(32)  # потоки не чекаємо: після виводу процес завершується


def collect(day, full=False, reuse=0):
    """Збирає сеанси з усіх джерел паралельно й групує їх за фільмами.
    full: перехресно перевірити всі кінотеатри через Filmweb (+~1 с).
    reuse: секунд, протягом яких вдалий розклад джерела на цей день береться з кешу без запиту.
    Повертає (фільми, помилки, чи всі джерела відповіли)."""
    shows, errors, complete = [], [], True
    jobs = []
    for name, fn in SOURCES:
        with _cache_lock:
            old = _load_cache().get("source", {}).get(f"{name}|{day}")
        if reuse and old and _time.time() - old[0] < reuse:
            shows += old[1]
        else:
            jobs.append((name, fn))
    if full:
        jobs.append(("Filmweb", lambda d: filmweb_pages(d, list(FW_CINEMAS))))
    futs = {POOL.submit(fn, day): name for name, fn in jobs}
    cf.wait(futs)
    for f, name in futs.items():
        key = f"{name}|{day}"
        if f.done() and not f.exception():
            got = f.result()
            cached("source", key, 0, lambda got=got: got)  # останній вдалий результат
            shows += got
            continue
        complete = False
        with _cache_lock:
            old = _load_cache().get("source", {}).get(key)
        why = str(f.exception())
        if old and _time.time() - old[0] < 12 * 3600:
            shows += old[1]
            errors.append(f"{name}: {why}, показано дані з {dt.datetime.fromtimestamp(old[0]):%H:%M}")
        else:
            errors.append(f"{name}: {why}")
    # Filmweb як перехресна перевірка: дублікати власних джерел відкидаємо.
    seen, unique = set(), []
    for s in shows:
        k = (s["cinema"], s["time"], title_key(s["title"]))
        if k not in seen:
            seen.add(k)
            unique.append(s)
    shows = unique
    # Описи нових фільмів: дочитуємо сторінки Filmweb тих кінотеатрів, де вони йдуть.
    missing = {s["cinema"] for s in shows if not fw_info(title_key(s["title"]))}
    paths = [p for p, c in FW_CINEMAS.items() if c in missing and "IMAX" not in p]
    if paths:
        POOL.submit(filmweb_pages, day, paths).exception()  # чекаємо завершення

    current = now()
    for s in shows:
        start = dt.datetime.combine(day, dt.time(*map(int, s["time"].split(":")))) \
            if re.fullmatch(r"\d{2}:\d{2}", s["time"]) else None
        s["started"] = bool(start and start <= current)

    films = {}
    for s in sorted(shows, key=lambda s: s["time"]):
        f = films.setdefault(title_key(s["title"]), {"title": s["title"], "shows": [],
                                                    "synopsis": "", "about": []})
        if len(s["title"]) > len(f["title"]):   # найповніша назва
            f["title"] = s["title"]
        if s.get("synopsis") and not f["synopsis"]:
            f["synopsis"] = s["synopsis"]
        if s.get("original") and not f.get("original"):
            f["original"] = s["original"]
        if s.get("about"):
            f["about"].append(s["about"])
        f["shows"].append({k: v for k, v in s.items() if k not in ("about", "synopsis", "original")})
    # Деталі фільму: спершу Filmweb, далі сторінка фільму в самому кінотеатрі.
    for key, f in films.items():
        info = fw_info(key)
        f.update({k: info.get(k, "") or f.get(k, "") for k in
                  ("year", "minutes", "genres", "url", "poster")})
        f["synopsis"] = f["synopsis"] or info.get("synopsis", "")
        f["original"] = info.get("original", "") or f.get("original", "")
    ua = ukrainian_info(films)
    for key, f in films.items():
        m = ua.get(key) or {}
        f["title_uk"] = m.get("name", "")
        f["synopsis_uk"] = m.get("synopsis", "")
        f["url_uk"] = m.get("url", "")
    need = [f for f in films.values() if not f["synopsis"] and f["about"]]

    def describe(f):
        for url in dict.fromkeys(f["about"]):
            try:
                text = meta_description(url)
                if text:
                    return text
            except Exception:
                pass
        return ""
    dfuts = [(f, POOL.submit(describe, f)) for f in need]
    for f, fut in dfuts:
        f["synopsis"] = fut.result()
    uk = load_translations()
    for key, f in films.items():
        f.pop("about")
        f["key"] = key
        f["synopsis_pl"] = f["synopsis"]
        mine = uk.get(key) or {}
        if isinstance(mine, str):
            mine = {"synopsis": mine}
        if not CYRILLIC.search(f["title_uk"]):  # TMDB без перекладу назви віддає оригінал
            f["title_uk"] = mine.get("title") or f["title_uk"]
        f["synopsis"] = f["synopsis_uk"] or mine.get("synopsis") or f["synopsis"]
        # кінотеатр (Helios для української версії) сам може дати опис українською
        f["translated"] = bool(f["synopsis_uk"] or mine.get("synopsis") or is_ukrainian(f["synopsis"]))
    order = sorted(films.values(),
                   key=lambda f: (all(s["started"] for s in f["shows"]), f["shows"][0]["time"]))
    return order, sorted(errors), complete


# ------------------------------------------------------------------- Вивід
def day_label(day):
    today = now().date()
    rel = {0: "сьогодні", 1: "завтра", 2: "післязавтра"}.get((day - today).days)
    text = f"{UK_DAYS[day.weekday()]}, {day.day} {UK_MONTHS[day.month - 1]}"
    return f"{rel}, {text}" if rel else text


def plural(n, one, few, many):
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} {one}"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} {few}"
    return f"{n} {many}"


def film_meta(f):
    bits = []
    if f.get("genres"):
        bits.append(", ".join(f["genres"][:3]))
    if f.get("minutes"):
        h, m = divmod(f["minutes"], 60)
        bits.append(f"{h} год {m:02d} хв" if h else f"{m} хв")
    if f.get("year"):
        bits.append(f["year"])
    return " · ".join(bits)


def where(s):
    hall = s["note"].replace("за даними Filmweb", "").strip(" ,")
    return s["cinema"] + (f" ({hall})" if hall else "")


def source_note(films):
    if films and all(f.get("translated") or not f["synopsis"] for f in films):
        return "Українські назви й описи з TMDB і Планети Кіно, решта перекладена."
    return "Частина описів польською: перекладу ще немає."


def render_markdown(day, films, errors):
    n_shows = sum(len(f["shows"]) for f in films)
    out = [f"# 🎬 Кіно українською у Вроцлаві", f"**{day_label(day).capitalize()}**", ""]
    if not films:
        out += ["Українських сеансів на цей день не знайдено.", ""]
    else:
        out += [f"{plural(len(films), 'фільм', 'фільми', 'фільмів')}, "
                f"{plural(n_shows, 'сеанс', 'сеанси', 'сеансів')}", ""]
    for f in films:
        out.append(f"## {f['title']}")
        if f.get("title_uk") and f["title_uk"].lower() != f["title"].lower():
            out.append(f"🇺🇦 **{f['title_uk']}**")
        meta = film_meta(f)
        if meta:
            out.append(f"*{meta}*")
        if f["synopsis"]:
            out += ["", f"> {f['synopsis']}"]
        out += ["", "| Час | Кінотеатр | Версія | Квитки |", "|---|---|---|---|"]
        for s in f["shows"]:
            t = f"~~{s['time']}~~ уже почався" if s["started"] else f"**{s['time']}**"
            buy = "—" if s["started"] else f"[купити]({s['link']})"
            out.append(f"| {t} | {where(s)} | {s['version']} | {buy} |")
        out.append("")
    if errors:
        out += ["⚠️ Не вдалося перевірити:"] + [f"- {e}" for e in errors] + [""]
    out.append(f"_{source_note(films)} "
               f"Оновлено {now():%d.%m %H:%M}._")
    return "\n".join(out)


CSS = """
/* Афіша: вузька колонка карток фільмів, усередині кожної список сеансів як квитки */
:root{
  --bg:#eef1f5; --card:#ffffff; --ink:#15202b; --mute:#5b6675; --line:#dbe1e8;
  --blue:#0b5cad; --gold:#f2c230; --past:#8b95a2;
  --display:"Unbounded","Arial Black",system-ui,sans-serif;
  --body:"Golos Text",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0f141a; --card:#18202a; --ink:#e9eef4; --mute:#9aa6b4; --line:#27313d;
  --blue:#6fb0ff; --gold:#f2c230; --past:#6b7684; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#0f141a; --card:#18202a; --ink:#e9eef4; --mute:#9aa6b4; --line:#27313d;
  --blue:#6fb0ff; --gold:#f2c230; --past:#6b7684; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.5 var(--body);
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.wrap{max-width:760px;margin:0 auto;padding-block:28px 40px;display:flex;flex-direction:column;gap:14px}
header{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}
.flag{display:flex;width:34px;height:6px;border-radius:3px;overflow:hidden}
.flag i{flex:1;background:var(--blue)}.flag i+i{background:var(--gold)}
h1{font:600 clamp(22px,5vw,30px)/1.15 var(--display);margin:0;letter-spacing:-.01em;text-wrap:balance}
.sub{margin:0;color:var(--mute)}
.film{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 18px 8px;display:flex;flex-direction:column;gap:6px;min-width:0}
h2{font:600 19px/1.25 var(--display);margin:0;text-wrap:balance}
.uk{margin:-2px 0 0;font-weight:600;color:var(--blue)}
h2 a{color:inherit;text-decoration:none}h2 a:hover{text-decoration:underline}
.meta{margin:0;color:var(--mute);font-size:14px}
.syn{margin:2px 0 8px;max-width:65ch}
.shows{display:flex;flex-direction:column}
.show{display:grid;grid-template-columns:70px 1fr auto;gap:4px 12px;align-items:center;padding:11px 0;border-top:1px dashed var(--line);color:inherit;text-decoration:none}
.show:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:6px}
.time{font:600 20px/1 var(--display);font-variant-numeric:tabular-nums;grid-row:1/3}
.where{font-weight:600;min-width:0}
.det{grid-column:2;color:var(--mute);font-size:13.5px;min-width:0}
.buy{grid-column:3;grid-row:1/3;color:var(--blue);font-weight:600;white-space:nowrap}
a.show:hover .buy{text-decoration:underline}
.past .time,.past .where,.past .det,.past .buy{color:var(--past)}.past .time{text-decoration:line-through}
.empty,.err,footer{color:var(--mute);font-size:14px;margin:0}
.err{border-left:3px solid var(--gold);padding-left:10px}
"""


def render_html(day, films, errors, artifact=False):
    e = html.escape
    cards = []
    for f in films:
        rows = []
        for s in f["shows"]:
            hall = where(s)[len(s["cinema"]):].strip(" ()")
            det = " · ".join(filter(None, [CINEMA_MAPS.get(s["cinema"], ""), hall, s["version"]]))
            inner = (f'<span class="time">{e(s["time"])}</span>'
                     f'<span class="where">{e(s["cinema"])}</span>'
                     f'<span class="det">{e(det)}</span>')
            if s["started"]:
                rows.append(f'<div class="show past">{inner}<span class="buy">почався</span></div>')
            else:
                rows.append(f'<a class="show" href="{e(s["link"])}" target="_blank" rel="noopener">'
                            f'{inner}<span class="buy">Квитки →</span></a>')
        title = (f'<a href="{e(f["url"])}" target="_blank" rel="noopener">{e(f["title"])}</a>'
                 if f.get("url") else e(f["title"]))
        meta = film_meta(f)
        cards.append(
            f'<article class="film"><h2>{title}</h2>'
            + (f'<p class="uk">{e(f["title_uk"])}</p>'
               if f.get("title_uk") and f["title_uk"].lower() != f["title"].lower() else "")
            + (f'<p class="meta">{e(meta)}</p>' if meta else "")
            + f'<p class="syn">{e(f["synopsis"] or "Опису поки немає.")}</p>'
            f'<div class="shows">{"".join(rows)}</div></article>')
    n_shows = sum(len(f["shows"]) for f in films)
    summary = (f"{plural(len(films), 'фільм', 'фільми', 'фільмів')}, "
               f"{plural(n_shows, 'сеанс', 'сеанси', 'сеансів')}" if films else "")
    body = (f'<div class="wrap"><header><span class="flag"><i></i><i></i></span>'
            f'<h1>Кіно українською у Вроцлаві</h1>'
            f'<p class="sub">{e(day_label(day).capitalize())}{" · " + summary if summary else ""}</p>'
            f'</header>'
            + ("".join(cards) or '<p class="empty">Українських сеансів на цей день не знайдено.</p>')
            + ("<p class='err'>Не вдалося перевірити: " + "; ".join(map(e, errors)) + "</p>"
               if errors else "")
            + f'<footer>{e(source_note(films))} '
              f'Оновлено {now():%d.%m.%Y о %H:%M}.</footer></div>')
    head = ('<title>Кіно українською</title>\n'
            '<meta name="claude:viewport-fit-sides" content="cover">\n'
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
            'family=Golos+Text:wght@400;600&family=Unbounded:wght@600&display=swap">\n'
            f'<style>{CSS}</style>\n')
    if artifact:  # Artifact сам додає doctype, head і body
        return head + body
    return ('<!doctype html>\n<html lang="uk"><head><meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
            f'{head}</head><body>{body}</body></html>')


def main(argv):
    as_json = "--json" in argv
    html_out, artifact = None, False
    for flag in ("--html", "--artifact"):
        if flag in argv:
            i = argv.index(flag)
            html_out = argv[i + 1] if i + 1 < len(argv) else "kino.html"
            artifact = flag == "--artifact"
            argv = argv[:i] + argv[i + 2:]
    flags = {"--json", "--fresh", "--full"}
    fresh, full = "--fresh" in argv, "--full" in argv
    day = parse_date(" ".join(a for a in argv if a not in flags))
    rkey = str(day) + ("+full" if full else "")
    with _cache_lock:
        hit = _load_cache().get("result", {}).get(rkey)
    if hit and not fresh and _time.time() - hit[0] < RESULT_TTL:
        films, errors = hit[1]
    else:
        films, errors, complete = collect(day, full)
        if complete and not errors:  # неповний результат не кешуємо
            cached("result", rkey, 0, lambda: [films, errors])
        save_cache()
    uk = load_translations()  # переклади могли з'явитися після кешування
    for f in films:
        mine = uk.get(f.get("key")) or {}
        if isinstance(mine, str):
            mine = {"synopsis": mine}
        if not CYRILLIC.search(f.get("title_uk") or ""):
            f["title_uk"] = mine.get("title") or f.get("title_uk") or ""
        if not f.get("synopsis_uk") and mine.get("synopsis"):
            f["synopsis"], f["translated"] = mine["synopsis"], True
    current = now()
    for f in films:  # "уже почався" рахуємо на момент виводу, а не кешування
        for s in f["shows"]:
            if re.fullmatch(r"\d{2}:\d{2}", s["time"]):
                start = dt.datetime.combine(day, dt.time(*map(int, s["time"].split(":"))))
                s["started"] = start <= current
    if html_out:
        with open(html_out, "w", encoding="utf-8") as fh:
            fh.write(render_html(day, films, errors, artifact))
        print(f"Збережено {html_out}")
    if as_json:
        print(json.dumps({"date": str(day), "films": films, "errors": errors},
                         ensure_ascii=False, indent=2))
    elif not html_out:
        print(render_markdown(day, films, errors))
    sys.stdout.flush()
    os._exit(0)  # не чекаємо фонових потоків, що ще дочитують сайти


if __name__ == "__main__":
    main(sys.argv[1:])
