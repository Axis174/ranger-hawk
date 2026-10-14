#!/usr/bin/env python3
"""Parse UDWR's public-land Big Game Application Guidebook hunt tables.

Hand-run when the PDF-hash flag asks for a human review; never run by refresh.py.
The PDF is checked against the committed hash before any output is written:

    python3 scraper/build_hunt_table.py
    python3 scraper/build_hunt_table.py --pdf biggameapp.pdf --date 2026-10-14

With no --pdf, the manual CLI downloads the canonical PDF to a temporary file.
Imports and tests never download it. --pdf uses a cached copy without a network
request, and --date fixes the Utah pull date for a repeatable build.

Dates come only from each row's printed date column. Dedicated Hunter,
multiseason, and a reference to another page retain an empty seasons list.
Unit spelling is preserved; boundary ids come only from species-matching hunt
lists through build_hunt_units.py's reviewed alias table, never from polygons.
"""

import argparse
from datetime import date, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data" / "ut"
PDF_URL = "https://wildlife.utah.gov/guidebooks/biggameapp.pdf"
TABLE_FIRST_PAGE, TABLE_LAST_PAGE = 43, 68
# scraper/hunting/biggameapp_2026_tables.txt is the exact -layout extraction of
# these 26 pages from sha16 84e2e3529b527291, preserving spaces and form feeds.


class BuildError(ValueError):
    """An unrecognised or incomplete source leaves the output unchanged."""


GROUP_SPECIES = {
    "GENERAL-SEASON BUCK DEER": "Deer",
    "DEDICATED HUNTER BUCK DEER": "Deer",
    "PREMIUM LIMITED-ENTRY BUCK DEER": "Deer",
    "MANAGEMENT AND CACTUS BUCK DEER": "Deer",
    "LIMITED-ENTRY BUCK DEER": "Deer",
    "DRAW-ONLY YOUTH ANY BULL/HUNTER’S CHOICE ELK": "Elk",
    "LIMITED-ENTRY BULL ELK": "Elk",
    "LIMITED-ENTRY BUCK PRONGHORN": "Pronghorn",
    "ONCE-IN-A-LIFETIME BULL MOOSE HUNTS": "Moose",
    "ONCE-IN-A-LIFETIME BISON HUNTS": "Bison",
    "ONCE-IN-A-LIFETIME DESERT BIGHORN SHEEP HUNTS": "Desert Bighorn Sheep",
    "ONCE-IN-A-LIFETIME ROCKY MOUNTAIN BIGHORN SHEEP HUNTS": "Rocky Mountain Bighorn Sheep",
    "ONCE-IN-A-LIFETIME MOUNTAIN GOAT HUNTS": "Mountain Goat",
}
HAMSS_DEER = "Handgun-archery-muzzleloader-shotgun-straight walled rifle-only (HAMSS) limited-entry buck deer hunts"
HAMSS_ELK = "Handgun-archery-muzzleloader-shotgun-straight walled rifle-only (HAMSS) limited-entry bull elk hunts"

# These are the guidebook's actual subheadings and weapon words. An absent
# weapon is null; neither another hunt nor prose elsewhere supplies one.
SUBHEAD_WEAPONS = {
    "Archery hunts": "Archery",
    "Extended archery only": "Extended archery",
    "Any legal weapon (rifle) — early hunts": "Any legal weapon (rifle)",
    "Any legal weapon (rifle) hunts": "Any legal weapon (rifle)",
    "Restricted rifle hunts": "Restricted rifle",
    "Muzzleloader hunts": "Muzzleloader",
    "Restricted muzzleloader hunts": "Restricted muzzleloader",
    "Restricted muzzleloader hunt": "Restricted muzzleloader",
    "Multiseason hunts": None,
    "Management buck hunts": None,
    "Cactus buck hunt": None,
    "Restricted archery hunt": "Restricted archery",
    "Muzzleloader hunts on general-season units": "Muzzleloader",
    "Restricted multiseason hunt": "Restricted multiseason",
    HAMSS_DEER: "Handgun-archery-muzzleloader-shotgun-straight walled rifle-only (HAMSS)",
    "September archery": "Archery",
    "Archery hunts — late season": "Archery",
    "Any legal weapon (rifle) — midseason hunts": "Any legal weapon (rifle)",
    "Any legal weapon (rifle) — late hunts": "Any legal weapon (rifle)",
    HAMSS_ELK: "Handgun-archery-muzzleloader-shotgun-straight walled rifle-only (HAMSS)",
    "Any legal weapon hunts, hunter’s choice": "Any legal weapon",
    "Any legal weapon hunt": "Any legal weapon",
    "Any legal weapon hunts, cow only": "Any legal weapon",
    "Archery hunts, hunter’s choice": "Archery",
    "Any legal weapon hunts": "Any legal weapon",
}

# (top heading, most-specific subheading) -> hunt_units' type. These are
# proposals for the lead's stop-1 review; the table keeps both printed headings.
# Dedicated Hunter and the statewide youth hunt have no corresponding list.
HUNT_TYPE_MAP = {}
for _group in GROUP_SPECIES:
    for _heading in SUBHEAD_WEAPONS:
        if _group == "GENERAL-SEASON BUCK DEER":
            _type = "General Season"
        elif _group == "PREMIUM LIMITED-ENTRY BUCK DEER":
            _type = "Premium Limited Entry"
        elif _group == "MANAGEMENT AND CACTUS BUCK DEER":
            _type = {"Management buck hunts": "Management Buck", "Cactus buck hunt": "Cactus Buck"}.get(_heading)
        elif _group == "LIMITED-ENTRY BUCK DEER":
            _type = "Limited Entry on General Season" if _heading == "Muzzleloader hunts on general-season units" else "Limited Entry"
        elif _group in ("LIMITED-ENTRY BULL ELK", "LIMITED-ENTRY BUCK PRONGHORN"):
            _type = "Limited Entry"
        elif _group.startswith("ONCE-IN-A-LIFETIME"):
            _type = "OIAL"
        else:
            _type = None
        HUNT_TYPE_MAP[(_group, _heading)] = _type
    HUNT_TYPE_MAP[(_group, _group)] = "OIAL" if _group.startswith("ONCE-IN-A-LIFETIME") else None

CODE_RE = re.compile(r"\b(?:DB|EB|PB|MB|BI|DS|RS|GO)\d{4}\b")
ROW_RE = re.compile(r"^\s*(?P<name>\S.*?)\s{2,}(?P<code>(?:DB|EB|PB|MB|BI|DS|RS|GO)\d{4})\b\s*(?P<dates>.*?)\s*$")
MARK_RE = re.compile(r"\*|†|\(new\)")
MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "june": 6,
          "july": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12}
MONTH = r"(?:Jan|Feb|Mar|Apr|May|June|July|Aug|Sept|Sep|Oct|Nov|Dec)\.?"
SPAN_RE = re.compile(r"^(?P<am>" + MONTH + r")\s+(?P<ad>\d{1,2})(?:,\s*(?P<ay>\d{4}))?\s*[–-]\s*"
                     r"(?:(?P<bm>" + MONTH + r")\s+)?(?P<bd>\d{1,2})(?:,\s*(?P<by>\d{4}))?$", re.IGNORECASE)
UNDATED_RE = re.compile(r"^(?:See page \d+|See (?:DB|EB)\d{4}.*|(?:All )?Limited-entry seasons)$", re.IGNORECASE)


def squash(text):
    return re.sub(r"\s+", " ", text).strip()


def parse_span(text, year=2026):
    """Return a row's printed span, or None for its printed date reference.

    A printed January date is in the following year of the hunt cycle, whose
    bounds are July 1 through January 31. Explicit printed years take priority.
    This interprets the row's dates; it never borrows a span from another row.
    """
    text = squash(text)
    if not text or UNDATED_RE.fullmatch(text):
        return None
    match = SPAN_RE.fullmatch(text)
    if not match:
        raise BuildError("unrecognised printed season: " + text)
    fields = match.groupdict()
    am = MONTHS[fields["am"].rstrip(".").lower()]
    bm = MONTHS[fields["bm"].rstrip(".").lower()] if fields["bm"] else am
    ay = int(fields["ay"]) if fields["ay"] else year + (am < 7)
    by = int(fields["by"]) if fields["by"] else year + (bm < 7)
    try:
        start, end = date(ay, am, int(fields["ad"])), date(by, bm, int(fields["bd"]))
    except ValueError as error:
        raise BuildError("invalid printed season: " + text) from error
    if not date(year, 7, 1) <= start <= end <= date(year + 1, 1, 31):
        raise BuildError("printed season is outside the hunt cycle: " + text)
    return {"start": start.isoformat(), "end": end.isoformat()}


def parse_layout(text, year=2026, first_page=1):
    """Parse full pdftotext -layout output, or a form-feed-preserving excerpt.

    Full PDFs use first_page=1. The committed pages 43–68 fixture uses
    first_page=43. Page limits exclude the summary/prose codes and CWMU tables.
    """
    rows, seen = [], set()
    for number, page_text in enumerate(text.split("\f"), first_page):
        if not TABLE_FIRST_PAGE <= number <= TABLE_LAST_PAGE:
            continue
        lines = page_text.splitlines()
        group = heading = weapon = None
        table_open = False
        index = 0
        while index < len(lines):
            raw = lines[index]
            line = re.sub(r"\s+\(continued\)$", "", squash(raw))
            index += 1
            if line == "ONCE-IN-A-LIFETIME ROCKY MOUNTAIN":
                if index >= len(lines) or squash(lines[index]) != "BIGHORN SHEEP HUNTS":
                    raise BuildError("incomplete Rocky Mountain sheep heading on page " + str(number))
                line += " " + squash(lines[index])
                index += 1
            if line == "Handgun-archery-muzzleloader-shotgun-straight walled":
                if index >= len(lines):
                    raise BuildError("incomplete HAMSS heading on page " + str(number))
                line += " " + squash(lines[index])
                index += 1
            if line in GROUP_SPECIES:
                group = heading = line
                weapon = None
                table_open = False
                continue
            if line in SUBHEAD_WEAPONS:
                if not group:
                    raise BuildError("subheading without hunt group on page " + str(number))
                heading, weapon = line, SUBHEAD_WEAPONS[line]
                table_open = False
                continue
            if re.match(r"^Hunt name\s+Hunt #(?:\s+Season dates)?$", raw.strip()):
                if not group or not heading:
                    raise BuildError("table without recognised headings on page " + str(number))
                table_open = True
                continue
            match = ROW_RE.fullmatch(raw)
            if not match or not table_open:
                continue
            fields = match.groupdict()
            code = fields["code"]
            if code in seen:
                raise BuildError("duplicate hunt-table code: " + code)
            seen.add(code)
            printed_name = squash(fields["name"])
            marks = MARK_RE.findall(printed_name)
            name = squash(MARK_RE.sub("", printed_name))
            # A weapon annotation is printed separately from the unit name in
            # Management buck rows. Preserve it in name; use only its own words.
            inline = re.search(r"\s+\((any legal weapon|archery|muzzleloader)\)$", name)
            unit = name[:inline.start()] if inline else name
            row_weapon = inline.group(1) if inline else weapon
            season_text = squash(fields["dates"])
            span = parse_span(season_text, year)
            if not season_text and group != "DEDICATED HUNTER BUCK DEER":
                raise BuildError("unexpected blank season column: " + code)
            rows.append({
                "code": code, "name": name, "marks": marks,
                "species": GROUP_SPECIES[group], "hunt_type": heading,
                "hunt_group": group, "weapon": row_weapon, "units": [unit],
                "boundary_ids": [], "seasons": [span] if span else [],
                "start": span["start"] if span else None,
                "end": span["end"] if span else None,
                "season_text": season_text, "page": number,
            })
    if not rows:
        raise BuildError("no public-land hunt-table rows found")
    return rows


def tool_path(name):
    found = shutil.which(name)
    if found:
        return found
    for directory in ("/opt/homebrew/bin", "/usr/local/bin"):
        candidate = Path(directory) / name
        if candidate.is_file():
            return str(candidate)
    raise BuildError(name + " is required (install Poppler)")


def pdf_layout(pdf_path):
    try:
        return subprocess.run([tool_path("pdftotext"), "-layout", str(pdf_path), "-"],
                              check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError as error:
        raise BuildError("pdftotext could not read the PDF: " + error.stderr.strip()) from error


def pdf_metadata(pdf_path):
    try:
        text = subprocess.run([tool_path("pdfinfo"), "-isodates", str(pdf_path)],
                              check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError as error:
        raise BuildError("pdfinfo could not read the PDF: " + error.stderr.strip()) from error
    values = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
    title, modified = values.get("Title", "").strip(), values.get("ModDate", "").strip()
    if not title or not re.match(r"^\d{4}-\d{2}-\d{2}T", modified):
        raise BuildError("PDF lacks its title or ISO reissue date")
    date.fromisoformat(modified[:10])
    return {"title": title, "reissued": modified[:10]}


def download_pdf(output):
    """Only the manual CLI calls this; imports, tests and refresh do not."""
    request = urllib.request.Request(PDF_URL, headers={"User-Agent": "ranger-hawk/1.0 (rangerhawk.com)"})
    with urllib.request.urlopen(request, timeout=60) as response:
        Path(output).write_bytes(response.read())


def serialize_table(table):
    return json.dumps(table, ensure_ascii=False, indent=2) + "\n"


def build_table(pdf_path, hunt_lists=None, pulled=None, year=None):
    """Return the proposed output; no file writes or network calls occur here."""
    pdf_path = Path(pdf_path)
    if not pdf_path.is_file():
        raise BuildError("PDF does not exist: " + str(pdf_path))
    if year is None:
        year = json.loads((DATA / "config.json").read_text())["hunt_year"]
    if not isinstance(year, int) or not 2000 <= year <= 2100:
        raise BuildError("hunt_year is not a supported year")
    pulled = pulled or datetime.now(ZoneInfo("America/Denver")).date().isoformat()
    date.fromisoformat(pulled)
    expected = json.loads((DATA / "pdf_hashes.json").read_text())["big_game_application"]
    digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()[:16]
    if digest != expected["sha"]:
        raise BuildError("PDF hash differs from committed pdf_hashes.json: " + digest)
    metadata = pdf_metadata(pdf_path)
    if str(year) not in metadata["title"]:
        raise BuildError("PDF title does not name hunt_year " + str(year))
    rows = parse_layout(pdf_layout(pdf_path), year)
    if hunt_lists is None:
        hunt_lists = json.loads((DATA / ("hunt_units_%s.json" % year)).read_text())
    try:
        from .build_hunt_units import resolve_hunt_name
    except ImportError:
        from build_hunt_units import resolve_hunt_name
    for row in rows:
        row["boundary_ids"] = sorted({boundary_id for unit in row["units"]
                                      for boundary_id in resolve_hunt_name(unit, row["species"], hunt_lists)})
    return {"_edition": {**metadata, "year": year, "pulled": pulled,
                         "pdf": PDF_URL, "sha": digest}, "hunts": rows}


def write_table(table, output):
    """Replace only after successful parsing/joining; interrupted writes are safe."""
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + output.name + ".", dir=output.parent)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(serialize_table(table))
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, help="cached guidebook PDF; omit to download it for this manual run")
    parser.add_argument("--date", dest="pulled", help="Utah pull date, YYYY-MM-DD (default: current Utah date)")
    parser.add_argument("--output", type=Path, help="output JSON (default: docs/data/ut/hunt_table_<hunt_year>.json)")
    args = parser.parse_args(argv)
    try:
        with tempfile.TemporaryDirectory(prefix="ranger-hawk-hunt-table-") as scratch:
            pdf = args.pdf
            if pdf is None:
                pdf = Path(scratch) / "biggameapp.pdf"
                download_pdf(pdf)
            table = build_table(pdf, pulled=args.pulled)
        output = args.output or DATA / ("hunt_table_%s.json" % table["_edition"]["year"])
        write_table(table, output)
    except (BuildError, KeyError, OSError, ValueError) as error:
        parser.exit(1, "build_hunt_table: stopped, output unchanged: " + str(error) + "\n")
    dated = sum(bool(row["seasons"]) for row in table["hunts"])
    unresolved = [row for row in table["hunts"] if not row["boundary_ids"]]
    print("build_hunt_table: %s rows, %s dated, %s undated, %s unplaced" %
          (len(table["hunts"]), dated, len(table["hunts"]) - dated, len(unresolved)))
    for row in unresolved:
        print("  unplaced: %s | %s | %s" % (row["code"], row["species"], "; ".join(row["units"])))
    for row in table["hunts"]:
        if not row["seasons"] and not re.search(r"Dedicated Hunter|Multiseason", row["hunt_type"], re.IGNORECASE):
            print("  undated other type: %s | %s" % (row["code"], row["hunt_type"]))
    print("build_hunt_table: wrote " + str(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
