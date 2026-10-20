#!/usr/bin/env python3
"""Збирає українські сеанси у Вроцлаві на DAYS днів уперед у site/data.json.

Запускає GitHub Actions за розкладом; застосунок (site/) лише читає готовий файл.
    python3 build.py            # 14 днів від сьогодні
    python3 build.py 3          # 3 дні (для швидкої перевірки)
"""
import datetime as dt
import json
import os
import sys
import time

import kino_ua as k

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 14
OUT = os.path.join(k.HERE, "site", "data.json")
FILM_FIELDS = ("key", "title", "title_uk", "original", "year", "minutes", "genres",
               "url", "poster", "synopsis", "translated")


def main():
    t0 = time.time()
    today = k.now().date()
    films, errors = {}, {}
    for i in range(DAYS):
        day = today + dt.timedelta(days=i)
        day_films, day_errors, _ = k.collect(day)
        if day_errors:
            errors[str(day)] = day_errors
        for f in day_films:
            g = films.setdefault(f["key"], {x: f.get(x) for x in FILM_FIELDS} | {"shows": []})
            for x in FILM_FIELDS:  # найповніші дані серед усіх днів
                if f.get(x) and not g.get(x):
                    g[x] = f[x]
            if f.get("translated") and not g.get("translated"):
                g["synopsis"], g["translated"] = f["synopsis"], True
            for s in f["shows"]:
                g["shows"].append({"date": str(day), "time": s["time"], "cinema": s["cinema"],
                                   "hall": k.where(s)[len(s["cinema"]):].strip(" ()"),
                                   "version": s["version"], "link": s["link"]})
        print(f"{day}: {len(day_films)} фільмів, помилок {len(day_errors)}", flush=True)
    k.save_cache()
    for g in films.values():
        g["shows"].sort(key=lambda s: (s["date"], s["time"]))
    data = {"generated": k.now().strftime("%Y-%m-%dT%H:%M"),
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "from": str(today), "days": DAYS,
            "cinemas": k.CINEMA_MAPS,
            "films": sorted(films.values(), key=lambda g: (g["shows"][0]["date"], g["shows"][0]["time"])),
            "errors": errors}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    untranslated = [g["key"] for g in films.values() if not g.get("translated") and g.get("synopsis")]
    if os.environ.get("GITHUB_ACTIONS"):  # підсумок видно в анотаціях запуску, без читання логу
        for day, errs in errors.items():
            print(f"::warning title=Не вдалося перевірити {day}::{'; '.join(errs)}")
        print(f"::notice title=Розклад::{len(films)} фільмів, "
              f"{sum(len(g['shows']) for g in films.values())} сеансів; без перекладу: {untranslated or 'немає'}")
    print(f"Готово за {time.time() - t0:.1f} с: {len(films)} фільмів, "
          f"{sum(len(g['shows']) for g in films.values())} сеансів; без перекладу: {untranslated}")
    sys.stdout.flush()
    os._exit(0)  # як і kino_ua.py: не чекаємо фонових потоків


if __name__ == "__main__":
    main()
