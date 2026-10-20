"""Трейлер українською й рейтинги IMDb та Rotten Tomatoes для карток фільмів.

Перевірено з GitHub Actions 2026-10-20: пошук YouTube відповідає (перші результати для
«<назва> трейлер українською» це українські трейлери), сторінки IMDb і Rotten Tomatoes
роботів не пускають (202/403). Тому:
- трейлер: перший ролик з пошуку YouTube з «трейлер»/«тизер» і повною назвою фільму (див. _same_film);
- IMDb: ідентифікатор з TMDB, рейтинг з офіційного набору datasets.imdbws.com (оновлюється щодня);
- Rotten Tomatoes: через OMDb (omdbapi.com), лише якщо задано ключ OMDB_API_KEY.
Чого не знайшли, того в картці немає; трейлер тоді веде на пошук YouTube.
"""
import concurrent.futures as cf
import gzip
import json
import os
import re
import time
import urllib.parse
import urllib.request

import kino_ua as k

YT = "https://www.youtube.com/results?hl=uk&search_query="
IMDB_RATINGS = "https://datasets.imdbws.com/title.ratings.tsv.gz"
OMDB = "https://www.omdbapi.com/"
FRESH = 20 * 3600  # рейтинги оновлюємо раз на добу


def remember(kind, key, ttl_found, ttl_empty, fn):
    """Як k.cached, але «не знайдено» тримаємо коротше, ніж знайдене. Помилку (мережа) не кешуємо."""
    with k._cache_lock:
        hit = k._load_cache().get(kind, {}).get(key)
    if hit and time.time() - hit[0] < (ttl_found if hit[1] else ttl_empty):
        return hit[1]
    return k.cached(kind, key, 0, fn)


def stale(kind, key):
    with k._cache_lock:
        hit = k._load_cache().get(kind, {}).get(key)
    return hit[1] if hit else None


STOP_WORDS = {"the", "and", "for", "with"}


def _words(s):
    return [w[:5] for w in re.findall(r"\w+", (s or "").lower()) if len(w) >= 3 and w not in STOP_WORDS]


def _same_film(video, f):
    """Ролик про цей фільм: усі слова української або оригінальної назви є в назві ролика
    (за першими 5 літерами, бо слова відмінюються), і не згадано інший рік."""
    have = set(_words(video))
    if not any(ws and set(ws) <= have for ws in (_words(f.get("title_uk")), _words(f.get("original")))):
        return False
    years = set(re.findall(r"\b(?:19|20)\d\d\b", video))
    return not years or not f.get("year") or str(f["year"]) in years


def _trailer(f):
    name = f.get("title_uk") or f.get("original") or f["title"]
    page = k.fetch(YT + urllib.parse.quote(f"{name} трейлер українською"), accept="text/html")
    found = []
    for vid, title in re.findall(r'"videoId":"([\w-]{11})".{0,600}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"', page)[:12]:
        t = json.loads(f'"{title}"').lower()
        if k.CYRILLIC.search(t) and re.search(r"трейлер|тизер", t) and _same_film(t, f):
            found.append((0 if "україн" in t else 1, vid))
    return min(found)[1] if found else ""


def trailer(f):
    return remember("trailer", f["key"], 7 * k.DAY, k.DAY, lambda: _trailer(f))


def _imdb_id(f):
    name = f.get("original") or re.split(r"\s*[.:]\s+", f["title"])[0]
    m = k._tmdb_movie(f["title"], name, f.get("year") or "")
    tmdb = re.search(r"/movie/(\d+)", m["url"]) if m else None
    if not tmdb:
        return ""
    key = os.environ.get("TMDB_API_KEY", "").strip()
    headers, params = {**k.UA_HEADERS, "Accept": "application/json"}, {}
    if key.startswith("ey"):
        headers["Authorization"] = f"Bearer {key}"
    elif key:
        params["api_key"] = key
    url = f"{k.TMDB}/movie/{tmdb[1]}/external_ids?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=k.TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8")).get("imdb_id") or ""


def imdb_id(f):
    return remember("imdb_id", f["key"], k.MONTH, k.DAY, lambda: _imdb_id(f))


def imdb_ratings(ids):
    """{tt…: "7.6"} з офіційного набору IMDb (≈9 МБ). Завантажуємо, лише якщо щось застаріло."""
    out, todo = {}, set()
    for i in ids:
        with k._cache_lock:
            hit = k._load_cache().get("imdb_rating", {}).get(i)
        if hit and time.time() - hit[0] < FRESH:
            out[i] = hit[1]
        else:
            todo.add(i)
    if todo:
        found = {}
        try:
            with urllib.request.urlopen(urllib.request.Request(IMDB_RATINGS, headers=k.UA_HEADERS), timeout=60) as r:
                for line in gzip.GzipFile(fileobj=r):
                    tt = line[:line.index(b"\t")].decode()
                    if tt in todo:
                        found[tt] = line.decode().split("\t")[1]
            for i in todo:
                out[i] = k.cached("imdb_rating", i, 0, lambda i=i: found.get(i, ""))
        except Exception as e:
            print(f"Рейтинги IMDb недоступні ({e}), беру попередні", flush=True)
            out.update({i: stale("imdb_rating", i) or "" for i in todo})
    return out


def _rotten(tt, key):
    q = urllib.parse.urlencode({"i": tt, "apikey": key})
    data = json.loads(k.fetch(f"{OMDB}?{q}"))
    return next((r["Value"] for r in data.get("Ratings") or [] if r.get("Source") == "Rotten Tomatoes"), "")


def rotten(tt):
    key = os.environ.get("OMDB_API_KEY", "").strip()
    if not key or not tt:
        return ""
    try:
        return k.cached("rotten", tt, FRESH, lambda: _rotten(tt, key))
    except Exception:
        return stale("rotten", tt) or ""


def add(films):
    """Дописує у кожен фільм trailer (id ролика YouTube), imdb (tt…), imdb_rating і rt."""
    def one(f):
        for field, kind, fn in (("trailer", "trailer", trailer), ("imdb", "imdb_id", imdb_id)):
            try:
                f[field] = fn(f)
            except Exception:  # мережа: беремо, що знали раніше
                f[field] = stale(kind, f["key"]) or ""
    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(one, films))
    ratings = imdb_ratings({f["imdb"] for f in films if f["imdb"]})
    with cf.ThreadPoolExecutor(8) as ex:
        rts = list(ex.map(lambda f: rotten(f["imdb"]), films))
    for f, rt in zip(films, rts):
        f["imdb_rating"] = ratings.get(f["imdb"], "") if f["imdb"] else ""
        f["rt"] = rt
