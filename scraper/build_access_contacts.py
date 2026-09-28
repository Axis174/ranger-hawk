"""Build property contacts exclusively from the two stored UDWR layers."""

import datetime
import json
import math
from pathlib import Path
import re
import sys


PHONE = re.compile(r"(?:\b1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b")
ASK = re.compile(
    r"contact (?:the )?landowner|landowner (?:must|should) be contacted|call|by phone|written permission|permission from",
    re.IGNORECASE,
)
DATA_DIR = Path(__file__).resolve().parents[1] / "docs" / "data"
SOURCE = (
    "Utah Division of Wildlife Resources: Walk-In Access and property layers, "
    "as pulled by the daily job. The wording is UDWR's own."
)
NOTE = (
    "Numbers are the ones UDWR publishes for the property. Nothing here comes "
    "from any other source. Not legal advice."
)


def clean(value):
    """Normalize the whitespace of a source field without changing its words."""
    return " ".join(str(value).split()) if value is not None else ""


def phone_numbers(text):
    """Return unique ten-digit numbers in their original order."""
    return list(dict.fromkeys("".join(match.groups()) for match in PHONE.finditer(text)))


def position(geometry):
    """Average the vertices in the first ring of the first polygon."""
    if not isinstance(geometry, dict):
        return {}
    coordinates = geometry.get("coordinates")
    try:
        if geometry.get("type") == "Polygon":
            ring = coordinates[0]
        elif geometry.get("type") == "MultiPolygon":
            ring = coordinates[0][0]
        else:
            return {}
        lon = sum(float(vertex[0]) for vertex in ring) / len(ring)
        lat = sum(float(vertex[1]) for vertex in ring) / len(ring)
    except (TypeError, ValueError, IndexError, KeyError, ZeroDivisionError, OverflowError):
        return {}
    if not math.isfinite(lat) or not math.isfinite(lon):
        return {}
    if not (36.9 <= lat <= 42.1 and -114.1 <= lon <= -109.0):
        return {}
    return {"lat": round(lat, 5), "lon": round(lon, 5)}


def property_key(entry):
    name = "".join(character for character in entry["name"].lower() if character.isalnum())
    return name, entry["county"].lower()


def build_properties(wia, dwr):
    """Merge matching layer records, retaining the Walk-In Access wording first."""
    merged = {}
    for layer, is_wia in ((wia, True), (dwr, False)):
        for feature in layer["features"]:
            fields = {key.rsplit(".", 1)[-1]: clean(value)
                      for key, value in feature["properties"].items()}
            if is_wia:
                property_id = "wia:" + fields.get("PropertyID", "").replace("{", "").replace("}", "").lower()
                name = fields.get("Name", "") or fields.get("PropName", "")
                county = fields.get("County", "")
                program = "Walk-In Access"
                asks = fields.get("SpecialRestrict", "")
                contact = fields.get("ContactInfo", "")
            else:
                property_id = "dwr:" + fields.get("id", "")
                name = fields.get("name", "")
                county = fields.get("county", "")
                program = fields.get("type_", "")
                asks = fields.get("restrictions", "")
                contact = ""
            entry = {
                "ids": [property_id], "name": name, "county": county,
                "program": program, **position(feature.get("geometry")),
                "asks": asks, "contact": contact,
            }
            key = property_key(entry)
            if key not in merged:
                merged[key] = entry
                continue
            existing = merged[key]
            if property_id not in existing["ids"]:
                existing["ids"].append(property_id)
            for field in ("asks", "contact"):
                if entry[field] and entry[field] != existing[field]:
                    existing[field] = clean(existing[field] + " " + entry[field])
            if "lat" not in existing and "lat" in entry:
                existing.update(lat=entry["lat"], lon=entry["lon"])

    properties = []
    for entry in merged.values():
        wording = entry["contact"] + " " + entry["asks"]
        had_number = bool(phone_numbers(wording))
        entry["needs_contact"] = bool(ASK.search(wording)) or had_number
        keep = bool(entry["contact"]) or ASK.search(entry["asks"]) or had_number
        # Strip the person out before anything is written. See the privacy note above.
        entry["asks"] = redact(entry["contact"], entry["asks"])
        entry["contact"] = ROUTE if entry["needs_contact"] else ""
        entry["phones"] = []
        if keep:
            properties.append(entry)
    return sorted(properties, key=lambda entry: (entry["county"], entry["name"]))


# --- privacy -------------------------------------------------------------
# UDWR publishes some Walk-In Access landowners' own names and personal phone
# numbers in its layer. This app is a PUBLIC GitHub repo served as a public
# website, and those people never agreed to be on it. config.json already made
# this call once: it carries the same four Box Elder properties abbreviated and
# routed through the DWR office. So the requirement to call is kept, the person
# is not. The number is one tap away on UDWR's own map, where it belongs.
PHONE_SUB = "[number is on UDWR's Walk-In Access map]"
ROUTE = ("Contact required - UDWR publishes the landowner's number on its Walk-In Access map "
         "at wildlife.utah.gov/walkinaccess. If you are denied access, call the DWR regional office.")
# Sentence-initial and agency words that are capitalised but are not people.
SAFE = {
    "Hunters", "Hunter", "Before", "Anyone", "Any", "All", "This", "There", "Before",
    "The", "Please", "Contact", "Report", "Walk", "Access", "Utah", "Division", "Wildlife",
    "Resources", "County", "Creek", "Valley", "Ranch", "Road", "North", "South", "East",
    "West", "Trespassing", "Property", "Land", "Owner", "Landowner", "Permission", "Sons",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
}


def _person_stems(*texts):
    """Capitalised words sitting just before a phone number, plus every capitalised
    word in the contact field. Reduced to 4-character stems so Lauri and Laurie both go."""
    stems = set()
    for text in texts:
        for match in PHONE.finditer(text):
            lead = text[max(0, match.start() - 48):match.start()]
            for word in re.findall(r"\b[A-Z][a-z]{2,}\b", lead):
                if word not in SAFE:
                    stems.add(word[:4])
    for word in re.findall(r"\b[A-Z][a-z]{2,}\b", texts[0] if texts else ""):
        if word not in SAFE:
            stems.add(word[:4])
    return stems


# PHONE above needs a separator between the 3 and the 4, so it misses "1(435)-2794420"
# as UDWR actually writes it. Redaction has to be looser than extraction: take any run of
# digits and separators and judge it by how many digits it holds.
NUMISH = re.compile(r"\+?\(?\d[\d\s.\-()]{5,}\d\)?")


def _strip_numbers(text):
    def replace(match):
        digits = re.sub(r"\D", "", match.group(0))
        return PHONE_SUB if 7 <= len(digits) <= 11 else match.group(0)
    return NUMISH.sub(replace, text)


def _has_number(text):
    """Independent of the matcher above, on purpose: scan every span made only of digits
    and separators and count its digits. Validating with the pattern that did the work is
    not validation, which is how 1(435)-2794420 got through the first time."""
    for span in re.findall(r"[\d\s.\-()]+", text):
        if len(re.sub(r"\D", "", span)) >= 7:
            return True
    return bool(re.search(r"\d{7,}", text))


def redact(contact, asks):
    """Return asks text with every number and person removed. Raises if it cannot prove
    the result is clean, so a failure publishes nothing rather than leaking a number."""
    stems = _person_stems(contact, asks)
    out = _strip_numbers(asks)
    for stem in sorted(stems, key=len, reverse=True):
        out = re.sub(r"\b" + re.escape(stem) + r"\w*\b", "the landowner", out)
    out = re.sub(r"(the landowner[ ,]*)+", "the landowner ", out)
    out = re.sub(r"\s+([.,;:])", r"\1", out)          # redaction can leave " ." behind
    out = " ".join(out.split())
    if _has_number(out):
        raise ValueError("redaction left a phone number in the rule text: " + out[:80])
    for stem in stems:
        if re.search(r"\b" + re.escape(stem), out, re.IGNORECASE):
            raise ValueError("redaction left a landowner name in the rule text")
    return out


def read_layer(path):
    layer = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(layer, dict) or not isinstance(layer.get("features"), list):
        raise ValueError("expected a GeoJSON features list")
    if any(not isinstance(feature, dict) or not isinstance(feature.get("properties"), dict)
           for feature in layer["features"]):
        raise ValueError("expected a properties object on every feature")
    return layer


def main(data_dir=None):
    data_dir = Path(data_dir) if data_dir is not None else DATA_DIR
    layers = []
    for filename in ("raw_wia_properties.json", "raw_dwr_properties.json"):
        try:
            layers.append(read_layer(data_dir / filename))
        except (OSError, ValueError) as error:
            print("cannot read {}: {}".format(filename, error))
            return 1
    properties = build_properties(*layers)
    output = data_dir / "access_contacts.json"
    try:
        previous = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = None
    if isinstance(previous, dict) and previous.get("properties") == properties:
        print("unchanged")
        return 0
    document = {
        "_source": SOURCE, "_note": NOTE,
        "_built": datetime.date.today().isoformat(), "properties": properties,
    }
    output.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("wrote docs/data/access_contacts.json: {} properties, {} ask for contact, {} with a number".format(
        len(properties), sum(entry["needs_contact"] for entry in properties),
        sum(bool(entry["phones"]) for entry in properties),
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
