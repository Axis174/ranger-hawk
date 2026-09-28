"""Synthetic contact-builder tests plus a counts-only real-data provenance check."""

import datetime
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
from scraper import build_access_contacts as builder


ROOT = Path(__file__).resolve().parents[1]


def layer(*features):
    return {"type": "FeatureCollection", "features": list(features)}


def wia(name="T Example Ranch", county="Example", rule="Call first.", contact="", geometry=None):
    fields = {
        "PropertyID": "{ABC-123}", "Name": name, "County": county,
        "SpecialRestrict": rule, "ContactInfo": contact,
    }
    return {"properties": {"UDWR.DWRADMIN.DWR_PROPERTIES." + key: value
                           for key, value in fields.items()}, "geometry": geometry}


def dwr(name="TExample Ranch", county="Example", rule="Written permission required.", geometry=None):
    return {"properties": {"id": 230, "name": name, "county": county,
                           "type_": "Test program", "restrictions": rule}, "geometry": geometry}


class PhoneTests(unittest.TestCase):
    def test_published_formats(self):
        for value in ("(435) 555-0142", "435-555-0142", "435.555.0142",
                      "1-(435)-555-0142", "(435)555-0142"):
            with self.subTest(format=value):
                self.assertEqual(builder.phone_numbers(value), ["4355550142"])

    def test_two_numbers_in_order_and_deduplicated(self):
        text = "Call (435) 555-0143 or (435) 555-0142; retry (435) 555-0143."
        self.assertEqual(builder.phone_numbers(text), ["4355550143", "4355550142"])

    def test_dates_zip_codes_and_short_numbers_are_not_phones(self):
        self.assertEqual(builder.phone_numbers("2026-09-28, 84010-1234, 555-0142"), [])


class PropertyTests(unittest.TestCase):
    def test_unqualified_property_is_left_out(self):
        entries = builder.build_properties(layer(wia(rule="Foot access only.")), layer())
        self.assertEqual(entries, [])

    def test_merge_normalized_name_and_county(self):
        entries = builder.build_properties(
            layer(wia(contact="Pat: (435) 555-0142")), layer(dwr(county="EXAMPLE")))
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["ids"], ["wia:abc-123", "dwr:230"])
        self.assertEqual(entry["asks"], "Call first. Written permission required.")
        self.assertEqual(entry["program"], "Walk-In Access")
        self.assertEqual(entry["phones"], [])
        self.assertNotIn("Pat", entry["contact"])
        self.assertTrue(entry["needs_contact"])

    def test_merge_keeps_id_from_unqualified_counterpart(self):
        entries = builder.build_properties(layer(wia()), layer(dwr(rule="Foot access only.")))
        self.assertEqual(entries[0]["ids"], ["wia:abc-123", "dwr:230"])
        self.assertEqual(entries[0]["asks"], "Call first. Foot access only.")

    def test_identical_rules_are_not_repeated(self):
        entries = builder.build_properties(layer(wia()), layer(dwr(rule="Call first.")))
        self.assertEqual(entries[0]["asks"], "Call first.")

    def test_contact_precedes_rules_for_number_order(self):
        entries = builder.build_properties(
            layer(wia(contact="(435) 555-0143", rule="Call (435) 555-0142 or (435) 555-0143.")),
            layer(dwr(rule="Call (435) 555-0144.")))
        # Numbers are never published; the requirement to call survives without them.
        self.assertEqual(entries[0]["phones"], [])
        self.assertNotIn("555", entries[0]["asks"])
        self.assertIn(builder.PHONE_SUB, entries[0]["asks"])

    def test_empty_name_uses_propname_and_all_text_is_normalized(self):
        feature = wia(name=" \n ", county=" Example\tCounty ", rule=None, contact=" Pat\n (435) 555-0142 ")
        feature["properties"]["UDWR.DWRADMIN.DWR_PROPERTIES.PropName"] = " T\tExample Ranch "
        entries = builder.build_properties(layer(feature), layer())
        self.assertEqual(entries[0]["name"], "T Example Ranch")
        self.assertEqual(entries[0]["county"], "Example County")
        self.assertEqual(entries[0]["asks"], "")
        # A contact that is only a person and a number becomes the routing line.
        self.assertEqual(entries[0]["contact"], builder.ROUTE)
        self.assertNotIn("Pat", entries[0]["contact"])
        self.assertNotIn("555", entries[0]["contact"])
        self.assertTrue(entries[0]["needs_contact"])

    def test_ask_is_case_insensitive_in_contact_or_rule(self):
        for wording in ("CONTACT THE LANDOWNER", "Landowner must be contacted",
                        "Landowner should be contacted", "CALL", "by phone",
                        "Written permission", "Permission from the owner"):
            with self.subTest(wording=wording):
                entries = builder.build_properties(layer(wia(rule="", contact=wording)), layer())
                self.assertTrue(entries[0]["needs_contact"])

    def test_number_alone_in_rule_qualifies(self):
        entries = builder.build_properties(layer(wia(rule="(435) 555-0142")), layer())
        self.assertEqual(entries[0]["phones"], [])
        self.assertEqual(entries[0]["asks"], builder.PHONE_SUB)
        # A bare number still means the property wants a call.
        self.assertTrue(entries[0]["needs_contact"])

    def test_run_together_number_is_redacted(self):
        """UDWR writes some numbers as 1(435)-2794420, with no separator before the last
        four. The first redactor missed that shape and its check used the same pattern, so
        the number shipped. Both the stripper and the independent check must catch it."""
        for shape in ("1(435)-2794420", "1-(435)-279-4360", "4352794420", "(435) 279 4420"):
            with self.subTest(shape=shape):
                entries = builder.build_properties(
                    layer(wia(rule="Call the owner at " + shape + " before you go.")), layer())
                self.assertEqual(entries[0]["phones"], [])
                self.assertNotIn("4420", entries[0]["asks"])
                self.assertNotIn("4360", entries[0]["asks"])
                self.assertFalse(builder._has_number(entries[0]["asks"]))

    def test_dates_and_small_numbers_survive_redaction(self):
        entries = builder.build_properties(
            layer(wia(rule="Call first. Open Oct. 3, 2026-Jan. 16, 2027. No more than 2 dogs.")), layer())
        self.assertIn("2026", entries[0]["asks"])
        self.assertIn("2 dogs", entries[0]["asks"])

    def test_outside_utah_position_is_dropped_but_entry_remains(self):
        geometry = {"type": "Polygon", "coordinates": [[[-120, 45], [-121, 46], [-120, 45]]]}
        entries = builder.build_properties(layer(wia(geometry=geometry)), layer())
        self.assertEqual(len(entries), 1)
        self.assertNotIn("lat", entries[0])
        self.assertNotIn("lon", entries[0])

    def test_first_ring_of_first_polygon_and_rounding(self):
        ring = [[-112.123456, 40.123456], [-112.223456, 40.223456], [-112.123456, 40.123456]]
        ignored_ring = [[0, 0], [0, 1], [0, 0]]
        expected = {"lat": 40.15679, "lon": -112.15679}
        self.assertEqual(builder.position({"type": "Polygon", "coordinates": [ring, ignored_ring]}), expected)
        self.assertEqual(builder.position({"type": "MultiPolygon", "coordinates": [[ring, ignored_ring], [ignored_ring]]}), expected)

    def test_sorted_by_county_then_name(self):
        entries = builder.build_properties(
            layer(wia(name="T Z Ranch", county="A County"),
                  wia(name="T A Ranch", county="B County"),
                  wia(name="T A Ranch", county="A County")), layer())
        self.assertEqual([(entry["county"], entry["name"]) for entry in entries],
                         [("A County", "T A Ranch"), ("A County", "T Z Ranch"), ("B County", "T A Ranch")])


class FileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix=".test-access-", dir=ROOT)
        self.addCleanup(self.directory.cleanup)
        self.data_dir = Path(self.directory.name)
        self.output = self.data_dir / "access_contacts.json"
        self.write_input("raw_wia_properties.json", layer(wia()))
        self.write_input("raw_dwr_properties.json", layer())

    def write_input(self, filename, contents):
        (self.data_dir / filename).write_text(json.dumps(contents), encoding="utf-8")

    def run_builder(self):
        code = "from pathlib import Path; import sys; from scraper.build_access_contacts import main; sys.exit(main(Path(sys.argv[1])))"
        return subprocess.run([sys.executable, "-B", "-c", code, str(self.data_dir)],
                              cwd=ROOT, capture_output=True, text=True)

    def test_missing_input_exits_one_and_preserves_output_bytes(self):
        for filename in ("raw_wia_properties.json", "raw_dwr_properties.json"):
            with self.subTest(filename=filename):
                original = (self.data_dir / filename).read_bytes()
                (self.data_dir / filename).unlink()
                sentinel = b'{"previous": "unchanged bytes"}\n'
                self.output.write_bytes(sentinel)
                result = self.run_builder()
                self.assertEqual(result.returncode, 1)
                self.assertIn(filename, result.stdout)
                self.assertEqual(self.output.read_bytes(), sentinel)
                (self.data_dir / filename).write_bytes(original)

    def test_invalid_input_exits_one_and_preserves_output_bytes(self):
        for filename in ("raw_wia_properties.json", "raw_dwr_properties.json"):
            with self.subTest(filename=filename):
                original = (self.data_dir / filename).read_bytes()
                (self.data_dir / filename).write_text("{invalid JSON", encoding="utf-8")
                sentinel = b'{"previous": "unchanged bytes"}\n'
                self.output.write_bytes(sentinel)
                result = self.run_builder()
                self.assertEqual(result.returncode, 1)
                self.assertIn(filename, result.stdout)
                self.assertEqual(self.output.read_bytes(), sentinel)
                (self.data_dir / filename).write_bytes(original)

    def test_second_run_prints_unchanged_and_preserves_date_bytes_and_mtime(self):
        first = self.run_builder()
        self.assertEqual(first.returncode, 0)
        self.assertEqual(first.stdout.strip(),
                         "wrote docs/data/access_contacts.json: 1 properties, 1 ask for contact, 0 with a number")
        old = json.loads(self.output.read_text(encoding="utf-8"))
        old["_built"] = "2000-01-01"
        self.output.write_text(json.dumps(old, indent=1) + "\n", encoding="utf-8")
        before = self.output.read_bytes()
        mtime = self.output.stat().st_mtime_ns
        second = self.run_builder()
        self.assertEqual(second.returncode, 0)
        self.assertEqual(second.stdout.strip(), "unchanged")
        self.assertEqual(self.output.read_bytes(), before)
        self.assertEqual(self.output.stat().st_mtime_ns, mtime)

    def test_empty_result_is_written_with_metadata(self):
        self.write_input("raw_wia_properties.json", layer(wia(rule="Foot access only.")))
        result = self.run_builder()
        self.assertEqual(result.returncode, 0)
        output = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(output["properties"], [])
        self.assertEqual(output["_source"], builder.SOURCE)
        self.assertEqual(output["_note"], builder.NOTE)
        self.assertEqual(output["_built"], datetime.date.today().isoformat())

    def test_unicode_is_written_without_ascii_escapes(self):
        self.write_input("raw_wia_properties.json", layer(wia(name="T Ex\u00e1mple Ranch")))
        self.assertEqual(self.run_builder().returncode, 0)
        contents = self.output.read_text(encoding="utf-8")
        self.assertIn("T Ex\u00e1mple Ranch", contents)
        self.assertNotIn("\\u00e1", contents)


class RealDataTests(unittest.TestCase):
    def test_every_generated_phone_has_same_ordered_digits_in_source_wording(self):
        layers = [builder.read_layer(builder.DATA_DIR / filename)
                  for filename in ("raw_wia_properties.json", "raw_dwr_properties.json")]
        generated = json.loads((builder.DATA_DIR / "access_contacts.json").read_text(encoding="utf-8"))
        entries = generated["properties"]
        self.assertTrue(entries == builder.build_properties(*layers),
                        "Generated property data differs from the current source layers.")
        invalid = 0
        for entry in entries:
            digits = re.sub(r"\D", "", entry["contact"] + entry["asks"])
            for phone in entry["phones"]:
                if not isinstance(phone, str) or not re.fullmatch(r"\d{10}", phone) or phone not in digits:
                    invalid += 1
        self.assertEqual(invalid, 0, "Generated phone provenance failures: {}".format(invalid))


if __name__ == "__main__":
    unittest.main()
