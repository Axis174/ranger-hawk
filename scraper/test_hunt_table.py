"""Offline checks for the hunt-list producer and guidebook hunt table.

The expected counts, selected rows and dates below were read from the 2026
guidebook, independently of the parser. No test pulls a live source or writes
the committed data. The real PDF's layout excerpt is a committed test fixture.
"""
import copy
import hashlib
import html
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit

sys.dont_write_bytecode = True
from scraper import build_hunt_units as lists
from scraper import build_hunt_table as table_builder

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data" / "ut"
FIXTURE = ROOT / "scraper" / "hunting" / "biggameapp_2026_tables.txt"


def read(name):
    return json.loads((DATA / name).read_text())


def report():
    return {"changes": [], "ok": [], "errors": []}


def fake_arcgis(rows, extra_services=()):
    """Simulate real attribute-only pages, including a server's small page cap."""
    by_service = {service: rows[key] for key, service in lists.SEED_SERVICES.items()}

    def get(url):
        parsed = urlsplit(url)
        if parsed.path.endswith("/services"):
            return {"services": [{"name": name, "type": "FeatureServer"}
                                 for name in [*by_service, *extra_services]]}
        match = re.search(r"/services/([^/]+)/FeatureServer/0", parsed.path)
        if not match:
            raise AssertionError("unexpected network request: " + url)
        values = by_service[unquote(match[1])]
        if not parsed.path.endswith("/query"):
            return {"objectIdField": "OBJECTID"}
        query = parse_qs(parsed.query)
        if query.get("returnCountOnly") == ["true"]:
            return {"count": len(values)}
        assert query["returnGeometry"] == ["false"]
        offset = int(query.get("resultOffset", [0])[0])
        page = values[offset:offset + 7]
        return {"features": [{"attributes": {
            "OBJECTID": offset + i + 1, "boundary_name": row["unit"],
            "hunt_type": row["type"], "season": row["season"],
            "species": row["species"], "description": row["description"],
        }} for i, row in enumerate(page)],
            "exceededTransferLimit": offset + len(page) < len(values)}
    return get


class HuntListTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = read("hunt_units_2026.json")
        cls.raw = read("raw_big_game_units.json")
        cls.geo = read("units_geo.json")

    def test_twelve_lists_263_rows_and_140_polygons(self):
        self.assertEqual(set(self.document["hunts"]), set(lists.SEED_SERVICES))
        self.assertEqual(sum(map(len, self.document["hunts"].values())), 263)
        self.assertEqual(len(self.document["slugs"]), 140)

    def test_every_list_row_is_fully_resolved_and_description_is_verbatim(self):
        names = {u["id"]: u["n"] for u in self.geo["units"]}
        descriptions = {f["properties"]["BoundaryID"]: f["properties"]["Description"]
                        for f in self.raw["features"]}
        for key, rows in self.document["hunts"].items():
            for row in rows:
                with self.subTest(list=key, unit=row["unit"]):
                    self.assertIn(row["boundary_id"], names)
                    self.assertEqual(names[row["boundary_id"]], lists.LIST_ALIASES.get(row["unit"], row["unit"]))
                    self.assertTrue(isinstance(row["description"], str) and row["description"])
                    self.assertNotRegex(row["description"], r"&#?\w+;")
                    if "offline enrichment" in self.document["_source"]:
                        self.assertEqual(row["description"], html.unescape(descriptions[row["boundary_id"]]))

    def test_same_live_data_on_later_days_preserves_bytes_and_all_five_aliases_are_used(self):
        # The lead's committed live file is the fixture. Re-enriching from the
        # older raw boundary attributes would restore Cedar/Stansbury's prefix.
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            before = self.temporary_data(directory)
            for pulled in ["2026-10-22", "2026-10-23"]:
                log = report()
                result = lists.update_hunt_units(directory, fake_arcgis(self.document["hunts"]), log, pulled)
                self.assertFalse(result["updated"])
                self.assertEqual((directory / "hunt_units_2026.json").read_bytes(), before)
                self.assertEqual(result["document"], self.document)
                self.assertEqual(log["errors"], [])
                self.assertEqual(log["changes"], [])
                self.assertEqual([row["source"] for row in log["ok"]], ["hunt_units"])
                unused = sorted(set(lists.LIST_ALIASES) - set(result["used_aliases"]))
                print("Unused list aliases:", unused)
                self.assertEqual(unused, [])

    def test_live_cedar_stansbury_description_keeps_the_leads_pull(self):
        descriptions = [r["description"] for rows in self.document["hunts"].values()
                        for r in rows if r["unit"] == "Cedar/Stansbury"]
        self.assertEqual(len(descriptions), 3)
        self.assertEqual(len(set(descriptions)), 1)
        self.assertTrue(all(s.startswith("Tooele and Juab counties") for s in descriptions))
        self.assertNotIn("offline enrichment", self.document["_source"])

    def test_slugs_cover_exactly_reached_polygons_and_are_unique(self):
        reached = {r["boundary_id"] for rows in self.document["hunts"].values() for r in rows}
        names = {u["n"] for u in self.geo["units"] if u["id"] in reached}
        self.assertEqual(set(self.document["slugs"]), names)
        self.assertEqual(len(set(self.document["slugs"].values())), len(names))
        self.assertTrue(all(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", v)
                            for v in self.document["slugs"].values()))

    def test_discovery_is_year_prefixed_case_insensitive_and_excludes_pheasant(self):
        services, following = lists.discover_services({"services": [
            {"name": "2026MountainGOATHuntNew", "type": "FeatureServer"},
            {"name": "2026_Pheasant_Release_Areas_view", "type": "FeatureServer"},
            {"name": "Ancient2026ElkHunts", "type": "FeatureServer"},
            {"name": "2027MuleDeerHunts", "type": "FeatureServer"},
        ]}, 2026)
        self.assertIn("2026MountainGOATHuntNew", services.values())
        self.assertNotIn("2026_Pheasant_Release_Areas_view", services.values())
        self.assertNotIn("Ancient2026ElkHunts", services.values())
        self.assertNotIn("2027MuleDeerHunts", services.values())
        self.assertEqual(following, ["2027MuleDeerHunts"])

    def temporary_data(self, directory):
        for name in ["config.json", "hunt_units_2026.json", "raw_big_game_units.json", "units_geo.json"]:
            (directory / name).write_bytes((DATA / name).read_bytes())
        return (directory / "hunt_units_2026.json").read_bytes()

    def test_live_adapter_pages_every_service_and_preserves_four_existing_fields(self):
        rows = copy.deepcopy(self.document["hunts"])
        # A live 2026 description may differ from committed 2025 attributes.
        rows["elk_anybull"][0]["description"] = "UDWR's revised live boundary description."
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.temporary_data(directory)
            log = report()
            result = lists.update_hunt_units(directory, fake_arcgis(rows), log, "2026-10-14")
            self.assertEqual(log["errors"], [])
            self.assertTrue(result["updated"])
            for key, rows in result["document"]["hunts"].items():
                self.assertEqual([{k: r[k] for k in lists.ROW_FIELDS} for r in rows],
                                 [{k: r[k] for k in lists.ROW_FIELDS} for r in self.document["hunts"][key]])
            self.assertIn("pulled 2026-10-14", result["document"]["_source"])
            self.assertEqual(result["document"]["hunts"]["elk_anybull"][0]["description"],
                             "UDWR's revised live boundary description.")

    def test_live_description_html_entities_are_decoded(self):
        # UDWR's Box Elder and Cache, East Rich attributes spell the dash as "&#8212;".
        rows = copy.deepcopy(self.document["hunts"])
        rows["elk_anybull"][0]["description"] = "Rich County&#8212;Boundary begins at the state line &amp; US-89."
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.temporary_data(directory)
            log = report()
            result = lists.update_hunt_units(directory, fake_arcgis(rows), log, "2026-10-22")
            self.assertEqual(log["errors"], [])
            self.assertTrue(result["updated"])
            self.assertEqual(result["document"]["hunts"]["elk_anybull"][0]["description"],
                             "Rich County\u2014Boundary begins at the state line & US-89.")

    def test_real_row_id_description_and_slug_changes_still_rewrite(self):
        # A changed description is checked through the full adapter above.
        # Each remaining payload category must also survive the comparison.
        for kind in ["row", "boundary_id", "slugs"]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / "hunt_units_2026.json"
                before = lists.serialize_document(self.document)
                output.write_bytes(before)
                changed = copy.deepcopy(self.document)
                changed["_source"] = "same source stamp"
                if kind == "row":
                    changed["hunts"]["elk_anybull"][0]["season"] = "UDWR revised season label"
                elif kind == "boundary_id":
                    changed["hunts"]["elk_anybull"][0]["boundary_id"] += 100000
                else:
                    name = next(iter(changed["slugs"]))
                    changed["slugs"][name] += "-revised"
                self.assertTrue(lists.atomic_write(output, changed))
                self.assertNotEqual(output.read_bytes(), before)
                self.assertEqual(json.loads(output.read_text()), changed)

    def assert_failure_preserves(self, get, expected_list=None, expected_name=None):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            before = self.temporary_data(directory)
            log = report()
            result = lists.update_hunt_units(directory, get, log, "2026-10-14")
            self.assertFalse(result["updated"])
            self.assertEqual((directory / "hunt_units_2026.json").read_bytes(), before)
            self.assertEqual(len(log["errors"]), 1)
            self.assertEqual(log["errors"][0]["source"], "hunt_units")
            if expected_list:
                self.assertEqual(log["errors"][0]["list"], expected_list)
            if expected_name:
                self.assertIn(expected_name, log["errors"][0]["names"])

    def test_pull_failure_is_nonfatal_preserves_bytes_and_records_one_flag(self):
        def broken(url):
            raise OSError("source unavailable")
        self.assert_failure_preserves(broken)

    def test_unresolved_list_name_preserves_bytes_and_names_the_list_and_name(self):
        rows = copy.deepcopy(self.document["hunts"])
        rows["elk_anybull"][0]["unit"] = "Unmapped synthetic polygon"
        self.assert_failure_preserves(fake_arcgis(rows), "elk_anybull", "Unmapped synthetic polygon")

    def test_drop_over_one_third_preserves_bytes(self):
        rows = copy.deepcopy(self.document["hunts"])
        rows["elk_spike"] = rows["elk_spike"][:15]  # 24 -> 15 is over one third.
        self.assert_failure_preserves(fake_arcgis(rows), "elk_spike")

    def test_drop_exactly_one_third_is_allowed(self):
        rows = copy.deepcopy(self.document["hunts"])
        rows["elk_spike"] = rows["elk_spike"][:16]  # 24 -> 16 is exactly one third.
        built, _ = lists.build_document(rows, self.raw, self.geo, self.document, 2026,
                                         "2026-10-14", lists.SEED_SERVICES)
        self.assertEqual(len(built["hunts"]["elk_spike"]), 16)

    def test_polygon_slug_collision_is_rejected(self):
        geo, raw = copy.deepcopy(self.geo), copy.deepcopy(self.raw)
        a, b = geo["units"][:2]
        a["n"], b["n"] = "Synthetic & Unit", "Synthetic and Unit"
        for f in raw["features"]:
            if f["properties"]["BoundaryID"] == a["id"]:
                f["properties"]["Boundary_Name"] = a["n"]
            if f["properties"]["BoundaryID"] == b["id"]:
                f["properties"]["Boundary_Name"] = b["n"]
        with self.assertRaises(lists.HuntBuildError):
            lists.build_document(self.document["hunts"], raw, geo, self.document,
                                 2026, "2026-10-14", lists.SEED_SERVICES)

    def test_next_year_flag_changes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            before = self.temporary_data(directory)
            log = report()
            result = lists.update_hunt_units(directory, fake_arcgis(self.document["hunts"],
                ["2027ElkBullGeneralSeasonAnyBull1"]), log, "2026-10-14")
            self.assertFalse(result["updated"])
            self.assertEqual((directory / "hunt_units_2026.json").read_bytes(), before)
            self.assertEqual(log["errors"], [])
            self.assertEqual(len(log["changes"]), 1)
            self.assertEqual(log["changes"][0]["desc"], "2027 hunt lists published")

    def test_table_join_never_uses_another_species_polygon(self):
        # The exact-name North polygon is a sheep unit; pronghorn has North A.
        self.assertEqual(lists.resolve_hunt_name("San Rafael, North", "Pronghorn", self.document), [202])
        self.assertEqual(lists.resolve_hunt_name("San Rafael, North", "Desert Bighorn Sheep", self.document), [194])
        self.assertEqual(lists.resolve_hunt_name("Henry Mtns", "Bison", self.document), [637])
        self.assertNotEqual(lists.resolve_hunt_name("Henry Mtns", "Deer", self.document), [637])


class HuntTableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = read("hunt_table_2026.json")
        cls.rows = cls.document["hunts"]
        cls.by_code = {r["code"]: r for r in cls.rows}
        cls.hunts = read("hunt_units_2026.json")

    def test_one_row_per_public_hunt_code_and_no_cwmu_rows(self):
        self.assertEqual(len(self.rows), 510)
        self.assertEqual(len(self.by_code), len(self.rows))
        for r in self.rows:
            with self.subTest(code=r["code"]):
                self.assertTrue(re.fullmatch(r"[A-Z]{2}\d{4}", r["code"]))
                self.assertNotIn("CWMU", r["hunt_group"])
                self.assertTrue(all(k in r for k in ["name", "marks", "species", "hunt_type", "list_type",
                    "hunt_group", "weapon", "units", "boundary_ids", "seasons", "start", "end"]))

    def test_at_least_440_dated_rows_with_zero_or_one_printed_span(self):
        dated = [r for r in self.rows if r["seasons"]]
        self.assertGreaterEqual(len(dated), 440)
        self.assertEqual(len(dated), 451)
        for r in self.rows:
            self.assertLessEqual(len(r["seasons"]), 1, r["code"])
            if r["seasons"]:
                span = r["seasons"][0]
                self.assertEqual((r["start"], r["end"]), (span["start"], span["end"]))
                self.assertTrue("2026-07-01" <= r["start"] <= r["end"] <= "2027-01-31", r["code"])
            else:
                self.assertIsNone(r["start"], r["code"])
                self.assertIsNone(r["end"], r["code"])

    def test_undated_hunts_are_not_inferred_and_other_types_are_printed(self):
        undated = [r for r in self.rows if not r["seasons"]]
        self.assertEqual(len(undated), 59)
        other = [r["code"] for r in undated if not re.search(r"multiseason|dedicated", r["hunt_type"], re.I)]
        print("Undated codes of another type:", other)
        self.assertEqual(other, ["DB0008"])
        for code in ["DB1044", "DB1109", "EB3124", "DB1800", "DB0008"]:
            self.assertEqual(self.by_code[code]["seasons"], [], code)

    def test_at_least_95_percent_dated_codes_have_last_year_draw_keys(self):
        odds = read("draw_odds.json")
        latest = odds["years"][max(odds["years"])]
        dated = [r["code"] for r in self.rows if r["seasons"]]
        missing = sorted(set(dated) - set(latest))
        print("Dated codes without last-year draw data:", missing)
        self.assertGreaterEqual((len(dated) - len(missing)) / len(dated), .95)
        self.assertEqual(missing, ["BI6539", "DB1121", "EB1007", "EB3168"])

    def test_early_deer_names_exactly_the_twelve_lead_units(self):
        early = [r for r in self.rows if r["species"] == "Deer" and
                 (r["start"], r["end"]) == ("2026-10-07", "2026-10-11")]
        named = {lists.HUNT_ALIASES.get("Deer", {}).get(n, n) for r in early for n in r["units"]}
        season = next(s for s in read("seasons.json")["seasons"] if s["id"] == "deer-early-rifle")
        self.assertEqual(named, set(season["units"]))
        self.assertEqual(len(named), 12)

    def test_most_specific_headings_keep_management_cactus_and_east_canyon_apart(self):
        self.assertIn("Management", self.by_code["DB1121"]["hunt_type"])
        self.assertIn("Cactus", self.by_code["DB1058"]["hunt_type"])
        self.assertIn("general-season", self.by_code["DB1101"]["hunt_type"])
        self.assertIn("HAMSS", self.by_code["DB1105"]["hunt_type"])
        self.assertNotEqual(self.by_code["DB1101"]["hunt_type"], self.by_code["DB1105"]["hunt_type"])

    def test_new_and_footnote_marks_are_separate_from_printed_name(self):
        r = self.by_code["DB1121"]
        self.assertEqual(r["name"], "Antelope Island (any legal weapon)")
        self.assertIn("(new)", r["marks"])
        self.assertEqual(r["units"], ["Antelope Island"])
        self.assertEqual(self.by_code["MB6002"]["name"], "East Canyon")
        self.assertIn("†", self.by_code["MB6002"]["marks"])
        self.assertEqual(self.by_code["DS6608"]["units"], ["San Rafael, Dirty Devil"])
        self.assertEqual(self.by_code["DS6610"]["units"], ["San Rafael, South"])

    def test_no_weapon_is_invented_when_not_printed(self):
        for code in ["DB1058", "MB6002", "EB1007"]:
            self.assertIsNone(self.by_code[code]["weapon"], code)

    def test_abbreviated_and_cross_year_dates(self):
        expected = {"DB1121": ("2026-11-16", "2026-11-20"),
                    "BI6539": ("2027-01-06", "2027-01-17"),
                    "BI6509": ("2027-01-18", "2027-01-31"),
                    "EB3044": ("2026-12-05", "2027-01-31"),
                    "BI6537": ("2026-11-07", "2027-01-31")}
        for code, dates in expected.items():
            self.assertEqual((self.by_code[code]["start"], self.by_code[code]["end"]), dates, code)

    def test_edition_comes_from_the_hashed_pdf(self):
        edition = self.document["_edition"]
        self.assertEqual(edition["reissued"], "2026-04-06")
        self.assertEqual(edition["title"], "Utah Big Game Application Guidebook - 2026")
        self.assertEqual(edition["sha"][:16], read("pdf_hashes.json")["big_game_application"]["sha"])

    def test_guidebook_aliases_all_appear_in_actual_hunt_rows(self):
        printed = {(r["species"], n) for r in self.rows for n in r["units"]}
        unused = [(s, n) for s, aliases in lists.HUNT_ALIASES.items() for n in aliases if (s, n) not in printed]
        print("Unused hunt-table aliases:", unused)
        self.assertEqual(unused, [])

    def test_boundary_ids_only_come_from_the_same_species_lists(self):
        for r in self.rows:
            available = {v["boundary_id"] for rows in self.hunts["hunts"].values()
                         for v in rows if v["species"] == r["species"]}
            self.assertTrue(set(r["boundary_ids"]) <= available, r["code"])
        for code in ["PB5015", "PB5056", "PB5046"]:
            self.assertEqual(self.by_code[code]["boundary_ids"], [202], code)
        for code in ["DB1115", "DB0008", "EB1007"]:
            self.assertEqual(self.by_code[code]["boundary_ids"], [], code)
        self.assertEqual(sum(not r["boundary_ids"] for r in self.rows), 3)

    def test_every_nonempty_mapping_exists_on_its_assigned_species_polygon_list(self):
        available = {(row["species"], row["boundary_id"], row["type"])
                     for rows in self.hunts["hunts"].values() for row in rows}
        for row in self.rows:
            expected = table_builder.HUNT_TYPE_MAP[(row["hunt_group"], row["hunt_type"])]
            self.assertEqual(row["list_type"], expected, row["code"])
            if row["list_type"] is not None:
                for ident in row["boundary_ids"]:
                    self.assertIn((row["species"], ident, row["list_type"]), available, row["code"])

    def test_dedicated_hunter_keeps_identity_ids_and_the_approved_null_mapping(self):
        dedicated = [r for r in self.rows if r["hunt_group"] == "DEDICATED HUNTER BUCK DEER"]
        self.assertEqual(len(dedicated), 31)
        self.assertTrue(all(r["boundary_ids"] and r["list_type"] is None for r in dedicated))

    def test_missing_nonempty_list_type_is_left_unplaced_and_reported(self):
        row = copy.deepcopy(self.by_code["DB1121"])
        hunts = copy.deepcopy(self.hunts)
        for values in hunts["hunts"].values():
            for entry in values:
                if entry["boundary_id"] in row["boundary_ids"] and entry["species"] == "Deer" and entry["type"] == "Management Buck":
                    entry["type"] = "A different UDWR hunt type"
        warnings = table_builder.place_rows([row], hunts)
        self.assertEqual(row["boundary_ids"], [])
        self.assertEqual([w["code"] for w in warnings], ["DB1121"])
        self.assertEqual(warnings[0]["list_type"], "Management Buck")

    def test_committed_layout_fixture_reproduces_every_parsed_row(self):
        parsed = table_builder.parse_layout(FIXTURE.read_text(), year=2026, first_page=43)
        fields = ["code", "name", "marks", "species", "hunt_type", "hunt_group", "list_type",
                  "weapon", "units", "seasons", "start", "end"]
        self.assertEqual([{k: r[k] for k in fields} for r in parsed],
                         [{k: r[k] for k in fields} for r in self.rows])
        self.assertEqual(table_builder.parse_layout(FIXTURE.read_text(), year=2026, first_page=43), parsed)

    def test_two_builds_from_the_same_inputs_serialize_identical_bytes(self):
        # Replace only the external Poppler processes with their recorded text.
        # The builder's hash check, config, parsing, joins and serializer run.
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            pdf = directory / "input.pdf"
            pdf.write_bytes(b"a deterministic test PDF input")
            (directory / "config.json").write_text(json.dumps({"hunt_year": 2026}))
            (directory / "pdf_hashes.json").write_text(json.dumps({"big_game_application": {
                "sha": hashlib.sha256(pdf.read_bytes()).hexdigest()[:16]}}))
            layout = "\f" * 42 + FIXTURE.read_text()
            metadata = {"title": "Utah Big Game Application Guidebook - 2026", "reissued": "2026-04-06"}
            with patch.object(table_builder, "DATA", directory), \
                 patch.object(table_builder, "pdf_layout", return_value=layout), \
                 patch.object(table_builder, "pdf_metadata", return_value=metadata):
                a = table_builder.build_table(pdf, self.hunts, pulled="2026-10-14")
                b = table_builder.build_table(pdf, self.hunts, pulled="2026-10-14")
            self.assertEqual(table_builder.serialize_table(a), table_builder.serialize_table(b))
            self.assertEqual(a["hunts"], self.rows)

    def test_invalid_or_out_of_cycle_printed_dates_are_rejected(self):
        for printed in ["Nov. 35–Dec. 2", "Jan. 6, 2026–Jan. 17, 2026", "Feb. 1–Feb. 2", "dates unknown"]:
            with self.subTest(printed=printed), self.assertRaises(table_builder.BuildError):
                table_builder.parse_span(printed, 2026)

    def test_unmatched_pdf_hash_is_rejected_before_poppler_or_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "wrong.pdf"
            pdf.write_bytes(b"a different edition")
            with patch.object(table_builder, "pdf_layout") as poppler:
                with self.assertRaises(table_builder.BuildError):
                    table_builder.build_table(pdf, self.hunts, pulled="2026-10-14", year=2026)
            poppler.assert_not_called()


if __name__ == "__main__":
    unittest.main()
