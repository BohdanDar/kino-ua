#!/usr/bin/env python3
"""Повідомлення власнику репозиторію через GitHub Issues (GitHub надсилає їх на пошту).

- Робот не зміг оновити розклад або кінотеатр довго не відповідає: одна задача
  «Проблема з оновленням розкладу», яка сама закривається, коли все знову працює.
- Фільм без українського опису: задача «[переклад] <ключ>» з польським текстом;
  закривається сама, коли переклад зʼявиться (TMDB, Планета Кіно чи synopsis_uk.json).

Запускає GitHub Actions після build.py; змінні BUILD_RESULT і REPORT (звіт build.py), GH_REPO, GH_TOKEN.
"""
import json
import os
import subprocess

PROBLEM = "Проблема з оновленням розкладу"
TRANSLATE = "[переклад] "
RUN_URL = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GH_REPO', '')}" \
          f"/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"


def gh(*args, data=None):
    return subprocess.run(["gh", *args], input=data or "", text=True, capture_output=True, check=True).stdout


def issues(state):
    out = gh("issue", "list", "--state", state, "--limit", "200", "--json", "number,title")
    return json.loads(out or "[]")


def main():
    result = os.environ.get("BUILD_RESULT", "")
    try:
        report = json.loads(os.environ.get("REPORT") or "{}")
    except ValueError:
        report = {}
    opened = issues("open")
    problem = next((i for i in opened if i["title"] == PROBLEM), None)

    # збій: робот упав або джерело не відповідає й старих даних (до 12 год) уже немає
    hard = [f"{day}: {e}" for day, errs in (report.get("errors") or {}).items()
            for e in errs if "показано дані з" not in e]
    if result != "success" or hard:
        if not problem:
            why = "Робот не зміг зібрати розклад." if result != "success" else \
                "Частина кінотеатрів не відповідає, тож у застосунку їхніх сеансів може не бути:\n\n" + \
                "\n".join(f"- {h}" for h in hard[:20])
            body = (f"{why}\n\nЗапуск: {RUN_URL}\n\nНапишіть Claude у проєкті, щоб розібратися. "
                    "Ця задача закриється сама, щойно все знову запрацює.")
            gh("issue", "create", "--title", PROBLEM, "--body-file", "-", data=body)
    elif problem:
        gh("issue", "close", str(problem["number"]), "--comment", f"Знову все працює: {RUN_URL}")

    if result != "success":
        return
    need = {u["key"]: u for u in report.get("untranslated") or []}
    every = issues("all")
    for key, u in need.items():
        if any(i["title"].startswith(TRANSLATE + key + " ") for i in every):
            continue  # уже просили (навіть якщо задачу закрили)
        body = (f"Для фільму «{u['title']}» немає українського опису ні в TMDB, ні в Планеті Кіно, "
                f"тож застосунок показує його польською:\n\n> {u['synopsis_pl']}\n\n"
                f"Попросіть Claude у проєкті перекласти його (ключ `{key}` у synopsis_uk.json). "
                "Задача закриється сама, коли переклад зʼявиться.")
        gh("issue", "create", "--title", f"{TRANSLATE}{key} — {u['title']}", "--body-file", "-", data=body)
    for i in opened:
        if i["title"].startswith(TRANSLATE):
            key = i["title"][len(TRANSLATE):].split(" ", 1)[0]
            if key not in need:
                note = "Переклад зʼявився." if key in (report.get("keys") or []) else \
                    "Фільм зник з розкладу, переклад більше не потрібен."
                gh("issue", "close", str(i["number"]), "--comment", note)


if __name__ == "__main__":
    main()
