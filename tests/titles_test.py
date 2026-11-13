# Перевірка, що один фільм не показується двічі. Запуск: python3 tests/titles_test.py
# Робот запускає це перед збором розкладу: якщо перевірка не пройде, сайт лишається старим.
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import kino_ua as k  # noqa: E402


def film(title, title_uk="", shows=1, **more):
    return {"title": title, "title_uk": title_uk, "shows": [{"time": "12:00"}] * shows, **more}


class Translit(unittest.TestCase):
    def merged(self, films):
        k.merge_translit(films, fill=("year", "poster"))
        return {key: len(f["shows"]) for key, f in films.items()}

    def test_helios_without_original_title(self):
        # 13.11.2026: Helios «Skrudzh i dukhy Rizdva - UA» без оригінальної назви
        self.assertEqual(self.merged({
            "ebenezerscrooge": film("Ebenezer Scrooge. Opowieść wigilijna", "Скрудж і духи Різдва", 3),
            "skrudzhidukhyrizdva": film("Skrudzh i dukhy Rizdva", "", 2, translated=True, year="2026"),
        }), {"ebenezerscrooge": 5})

    def test_other_transliteration_systems(self):
        for latin in ("Hlynolykyi", "Glinolikij", "Hlynolykyj"):
            self.assertEqual(self.merged({"clayface": film("Clayface", "Глиноликий"),
                                          "x": film(latin)}), {"clayface": 2}, latin)

    def test_subtitle_and_typo(self):
        self.assertEqual(self.merged({
            "krashanka": film("Krashanka 2.0. Kwantowy paradoks", "Крашанка 2.0: Квантовий парадокс"),
            "x": film("Krashanka 2.0 Kvantovyy paradox")}), {"krashanka": 2})

    def test_different_films_stay(self):
        self.assertEqual(self.merged({
            "kotprot": film("Kot prot", "Кіт у капелюсі"),
            "kit": film("Kit"),                         # коротка назва: лише точний збіг
            "verity": film("Verity", "Веріті"),
            "residentevil": film("Resident Evil"),
            "zrodlo": film("Źródło"),                   # польська назва, не трансліт
        }), {"kotprot": 1, "kit": 1, "verity": 1, "residentevil": 1, "zrodlo": 1})


if __name__ == "__main__":
    unittest.main(verbosity=1)
