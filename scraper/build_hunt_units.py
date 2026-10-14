#!/usr/bin/env python3
"""Produce UDWR hunt lists, retaining the app's four existing row fields.

The nightly calls update_hunt_units with refresh.py's GET and changelog report.
An upstream failure leaves the committed file untouched. --offline deliberately
uses the committed lists and boundary attributes without claiming a new pull.
Name aliases are judgments awaiting the packet's stop-1 review, not fuzzy joins.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import tempfile
from datetime import datetime, timezone
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data" / "ut"
SERVICE_ROOT = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
SEED_SERVICES = {
    "elk_anybull": "2026ElkBullGeneralSeasonAnyBull2",
    "elk_spike": "2026ElkBullGeneralSeasonSpikeOnly1",
    "elk_le": "2026ElkBullLimitedEntry2",
    "deer_gen": "2026MuleDeerGeneralSeason2",
    "deer_le": "2026MuleDeerLimitedEntry2",
    "pronghorn_le": "2026PronghornLimitedEntry",
    "antlerless_elk_control": "2026AntlerlessElkControl",
    "moose": "2026MooseOnce_in_a_Lifetime2",
    "goat": "2026MountainGoatOnce_in_a_Lifetime2",
    "bison": "2026BisonOnce_in_a_Lifetime2",
    "desert_sheep": "2026DesertBighornSheepOnce_in_a_Lifetime2",
    "rm_sheep": "2026RockyMountainBighornSheepOnce_in_a_Lifetime2",
}
LIST_ALIASES = {
    "Castle Valley": "La Sal, Castle Valley",
    "Dolores Triangle": "La Sal, Dolores Triangle",
    "La Sal Mtns": "La Sal, La Sal Mtns",
    "Moab Valley": "La Sal, Moab Valley",
    "Nebo, Moroni Hills": "Moroni Hills",
}
# Species-scoped guidebook spellings from audit appendix 2A. Parker Mtn is a
# provisional audit mapping, explicitly listed for the lead's stop-1 approval.
# San Rafael, North is intentionally absent for pronghorn: its exact-name
# polygon belongs to the desert-sheep list, not the pronghorn list.
HUNT_ALIASES = {
    "Deer": {"Fillmore": "Fillmore B", "Kaiparowits HAMSS": "Kaiparowits (HAMS)"},
    "Elk": {"Boulder": "Boulder Elk", "Nebo/San Pitch Mtn": "Nebo/San Pitch Mtns"},
    "Pronghorn": {"Book Cliffs, Bitter Creek": "Book Cliffs, Bitter Creek (pronghorn)",
                  "Parker Mtn": "Plateau"},
    "Bison": {"Henry Mtns": "Henry Mtns (bison)",
              "Book Cliffs, Bitter Creek": "Book Cliffs, Bitter Creek (pronghorn)"},
    "Desert Bighorn Sheep": {"Mineral Mtns": "Mineral Mountain"},
    "Rocky Mountain Bighorn Sheep": {"Fillmore, Oak Creek": "Fillmore, Oak Creek (cougar)"},
}
TABLE_ALIASES = HUNT_ALIASES
BIG_GAME = re.compile(r"elk|deer|pronghorn|moose|bison|sheep|goat|antlerless", re.I)
ROW_FIELDS = ("unit", "type", "season", "species")


class HuntBuildError(ValueError):
    def __init__(self, reason, list_name="directory", names=()):
        self.list_name = list_name
        self.names = sorted(set(names))
        super().__init__(reason)


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower().replace("&", "and")).strip("-")


def species_name(value):
    """Normalize species labels only; never normalize a unit spelling."""
    key = re.sub(r"[^a-z]+", "", str(value).lower())
    names = {"deer": "Deer", "muledeer": "Deer", "elk": "Elk",
             "pronghorn": "Pronghorn", "moose": "Moose", "bison": "Bison",
             "goat": "Mountain Goat", "mountaingoat": "Mountain Goat",
             "desertsheep": "Desert Bighorn Sheep", "desertbighorn": "Desert Bighorn Sheep",
             "desertbighornsheep": "Desert Bighorn Sheep",
             "rmsheep": "Rocky Mountain Bighorn Sheep", "rockymountainbighorn": "Rocky Mountain Bighorn Sheep",
             "rockymountainbighornsheep": "Rocky Mountain Bighorn Sheep"}
    return names.get(key, str(value))


def canonical_list_name(name, species=None):
    alias = HUNT_ALIASES.get(species_name(species), {}).get(name, name)
    return LIST_ALIASES.get(alias, alias)


def resolve_table_unit(name, species, hunt_lists):
    """Join through same-species list rows, never directly to polygons."""
    hunts = hunt_lists.get("hunts", hunt_lists)
    rows = [row for values in hunts.values() for row in values
            if species_name(row["species"]) == species_name(species)]
    exact = [row for row in rows if row["unit"] == name]
    if exact:
        return sorted({row["boundary_id"] for row in exact})
    target = canonical_list_name(name, species)
    matched = [row for row in rows if LIST_ALIASES.get(row["unit"], row["unit"]) == target]
    return sorted({row["boundary_id"] for row in matched})


resolve_hunt_name = resolve_table_unit


def boundary_index(raw, geo):
    polygons = {u["id"]: u["n"] for u in geo["units"]}
    if len(polygons) != len(geo["units"]) or len(set(polygons.values())) != len(polygons):
        raise HuntBuildError("duplicate polygon id or name", "boundaries")
    seen_slugs = {}
    for name in polygons.values():
        value = slug(name)
        if not value or value in seen_slugs:
            raise HuntBuildError("polygon slug collision", "slugs", [name, seen_slugs.get(value, "")])
        seen_slugs[value] = name
    out = {}
    for f in raw["features"]:
        pr = f.get("properties", f.get("attributes", {}))
        name, ident = pr.get("Boundary_Name"), pr.get("BoundaryID")
        if name in out or polygons.get(ident) != name:
            raise HuntBuildError("boundary attributes and polygons disagree", "boundaries", [str(name)])
        out[name] = {"id": ident, "description": pr.get("Description")}
    if len(out) != len(polygons):
        raise HuntBuildError("boundary attributes and polygons have different counts", "boundaries")
    return out


def enrich_rows(hunts, raw, geo, live=False):
    boundaries = boundary_index(raw, geo)
    result, used, unresolved, slugs = {}, set(), [], {}
    for key, rows in hunts.items():
        result[key] = []
        for row in rows:
            if any(not isinstance(row.get(k), str) or not row[k] for k in ROW_FIELDS):
                raise HuntBuildError("missing required hunt row field", key, [str(row.get("unit"))])
            name = row["unit"]
            target = name if name in boundaries else LIST_ALIASES.get(name)
            if target not in boundaries:
                unresolved.append((key, name))
                continue
            if target != name:
                used.add(name)
            b = boundaries[target]
            description = row.get("description") if live else b["description"]
            if not isinstance(description, str) or not description:
                raise HuntBuildError("missing verbatim boundary description", key, [name])
            new = {k: row[k] for k in ROW_FIELDS}
            new.update(boundary_id=b["id"], description=description)
            result[key].append(new)
            slugs[target] = slug(target)
    if unresolved:
        key = unresolved[0][0]
        detail = "; ".join(f"{k}: {n}" for k, n in unresolved)
        raise HuntBuildError("unresolved list names: " + detail, key, [n for _, n in unresolved])
    return result, dict(sorted(slugs.items())), used


def enrich_committed(committed, raw, geo, hunt_year=2026):
    rows, slugs, used = enrich_rows(committed["hunts"], raw, geo)
    result = copy.deepcopy(committed)
    # Preserve the known pull date rather than falsely reporting an offline
    # enrichment as a fresh UDWR pull. Re-running offline is byte-stable.
    prior = re.split(r"; services:|; offline enrichment", committed["_source"])[0]
    names = [v.replace("2026", str(hunt_year), 1) for v in SEED_SERVICES.values()]
    result["_source"] = (prior + "; services: " + ", ".join(names) +
                         "; offline enrichment from committed raw_big_game_units.json and units_geo.json; no live list pull")
    result["hunts"], result["slugs"] = rows, slugs
    return result, used


def discover_services(directory, hunt_year):
    if "error" in directory or not isinstance(directory.get("services"), list):
        raise HuntBuildError("ArcGIS directory returned an error or no services array")
    names = [s["name"] for s in directory["services"] if isinstance(s, dict) and
             isinstance(s.get("name"), str) and s.get("type", "FeatureServer") == "FeatureServer"]
    current = {k: v.replace("2026", str(hunt_year), 1) for k, v in SEED_SERVICES.items()}
    seeded = set(current.values())
    for name in sorted(set(names)):
        if name.startswith(str(hunt_year)) and BIG_GAME.search(name) and name not in seeded:
            key = slug(name[len(str(hunt_year)):]).replace("-", "_")
            if key in current:
                raise HuntBuildError("discovered service key collision", key, [name, current[key]])
            current[key] = name
    following = sorted({n for n in names if n.startswith(str(hunt_year + 1)) and BIG_GAME.search(n)})
    return current, following


def _json(get, url):
    value = get(url)
    if not isinstance(value, dict):
        value = json.loads(value)
    if "error" in value:
        raise HuntBuildError("ArcGIS error: " + str(value["error"]))
    return value


def fetch_service(get, name, list_name=None):
    key = list_name or name
    base = SERVICE_ROOT + "/" + urllib.parse.quote(name, safe="") + "/FeatureServer/0"
    try:
        meta = _json(get, base + "?f=json")
        object_id = meta.get("objectIdField") or "OBJECTID"
        count = int(_json(get, base + "/query?" + urllib.parse.urlencode(
            {"where": "1=1", "returnCountOnly": "true", "f": "json"}))["count"])
        rows, ids, offset = [], set(), 0
        while offset < count:
            params = {"where": "1=1", "outFields": "*", "returnGeometry": "false", "f": "json",
                      "orderByFields": object_id, "resultOffset": offset, "resultRecordCount": 1000}
            page = _json(get, base + "/query?" + urllib.parse.urlencode(params))
            features = page.get("features")
            if not isinstance(features, list) or not features:
                raise HuntBuildError("incomplete ArcGIS pagination", key)
            for feature in features:
                fields = feature.get("attributes")
                if not isinstance(fields, dict):
                    raise HuntBuildError("ArcGIS row has no attributes", key)
                low = {k.lower(): v for k, v in fields.items()}
                ident = fields.get(object_id)
                if ident is None or ident in ids:
                    raise HuntBuildError("ArcGIS pagination repeated or omitted an object id", key)
                ids.add(ident)
                rows.append({"unit": low.get("boundary_name"), "type": low.get("hunt_type"),
                             "season": low.get("season"), "species": low.get("species"),
                             "description": low.get("description")})
            offset += len(features)
        if len(rows) != count:
            raise HuntBuildError("ArcGIS count changed during pagination", key)
        return rows
    except HuntBuildError as e:
        raise HuntBuildError(str(e), key, e.names) from e
    except Exception as e:
        raise HuntBuildError("ArcGIS pull failed: " + repr(e), key) from e


def build_document(service_rows, raw, geo, previous, hunt_year, pulled, services):
    missing = set((previous or {}).get("hunts", {})) - set(service_rows)
    if missing:
        key = sorted(missing)[0]
        raise HuntBuildError("committed hunt list disappeared", key,
                             [r["unit"] for r in previous["hunts"][key]])
    for key, prior in (previous or {}).get("hunts", {}).items():
        rows = service_rows[key]
        if len(rows) * 3 < len(prior) * 2:
            gone = set(r["unit"] for r in prior) - set(r.get("unit") for r in rows)
            raise HuntBuildError(f"list count fell by more than a third ({len(prior)} to {len(rows)})", key, gone)
    rows, slugs, used = enrich_rows(service_rows, raw, geo, live=True)
    result = {"_source": f"UDWR ArcGIS hunt boundary services for {hunt_year}, pulled {pulled}; services: " +
              ", ".join(services[k] for k in sorted(services)),
              "_note": (previous or {}).get("_note", "UDWR hunt boundary lists; season labels are not hunt dates."),
              "hunts": rows, "slugs": slugs}
    return result, used


def serialize_document(document):
    return (json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def atomic_write(path, document):
    path = Path(path)
    value = serialize_document(document)
    if path.exists() and path.read_bytes() == value:
        return False
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", delete=False) as f:
            tmp = f.name
            f.write(value)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp and os.path.exists(tmp):
            os.unlink(tmp)
    return True


def update_hunt_units(data_dir, get, report, pulled=None):
    """Nonfatal refresh integration; one named error flag for any failed pull."""
    data_dir = Path(data_dir)
    previous = None
    try:
        config = json.loads((data_dir / "config.json").read_text())
        year = config["hunt_year"]
        if not isinstance(year, int) or isinstance(year, bool):
            raise HuntBuildError("config hunt_year must be an integer", "config")
        path = data_dir / f"hunt_units_{year}.json"
        previous = json.loads(path.read_text()) if path.exists() else None
        services, following = discover_services(_json(get, SERVICE_ROOT + "?f=json"), year)
        if following:
            report["changes"].append({"source": "hunt_units", "desc": f"{year + 1} hunt lists published",
                                      "services": following})
            return {"updated": False, "next_year": following}
        rows = {key: fetch_service(get, name, key) for key, name in services.items()}
        document, used = build_document(rows,
            json.loads((data_dir / "raw_big_game_units.json").read_text()),
            json.loads((data_dir / "units_geo.json").read_text()), previous, year,
            pulled or datetime.now(timezone.utc).date().isoformat(), services)
        changed = atomic_write(path, document)
        dest = report["changes"] if changed else report["ok"]
        dest.append({"source": "hunt_units", "desc": "UDWR hunt-type unit lists", "lists": len(rows),
                     "rows": sum(map(len, rows.values()))})
        return {"updated": changed, "used_aliases": sorted(used), "document": document}
    except Exception as e:
        list_name = getattr(e, "list_name", "configuration")
        names = getattr(e, "names", [])
        if not names and list_name in (previous or {}).get("hunts", {}):
            names = sorted({r["unit"] for r in previous["hunts"][list_name]})
        report["errors"].append({"source": "hunt_units", "error": str(e),
                                 "list": list_name, "names": names})
        return {"updated": False, "error": str(e)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--offline", action="store_true")
    p.add_argument("--data-dir", type=Path, default=DATA)
    p.add_argument("--output", type=Path)
    args = p.parse_args()
    config = json.loads((args.data_dir / "config.json").read_text())
    year = config["hunt_year"]
    path = args.output or args.data_dir / f"hunt_units_{year}.json"
    if args.offline:
        document, used = enrich_committed(json.loads((args.data_dir / f"hunt_units_{year}.json").read_text()),
            json.loads((args.data_dir / "raw_big_game_units.json").read_text()),
            json.loads((args.data_dir / "units_geo.json").read_text()), year)
        atomic_write(path, document)
        print(json.dumps({"offline": True, "lists": len(document["hunts"]),
                          "rows": sum(map(len, document["hunts"].values())), "polygons": len(document["slugs"]),
                          "used_aliases": sorted(used), "unused_aliases": sorted(set(LIST_ALIASES) - used)}))
    else:
        if args.output:
            p.error("--output is supported with --offline only")
        def get(url):
            req = urllib.request.Request(url, headers={"User-Agent": "ranger-hawk/1.0 (hunt lists)"})
            with urllib.request.urlopen(req, timeout=120) as response:
                return response.read()
        report = {"changes": [], "ok": [], "errors": []}
        update_hunt_units(args.data_dir, get, report)
        print(json.dumps(report))


if __name__ == "__main__":
    main()
