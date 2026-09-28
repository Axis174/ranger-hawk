#!/usr/bin/env python3
"""Build docs/data/fishing_places.json: where to fish, and which rules go with it.

Places come from UDWR's own public data, never from a list made up by hand:
  * the Fish Utah planner (a water's position, the point UDWR gives for
    directions, the species UDWR says are there, recent stocking)
  * the community fisheries layer
  * the property layer the daily job already pulls (angler access, and other
    properties whose stated purpose includes fishing)
  * the lake registry, for guidebook lakes the planner does not carry

THE PART THAT CAN GO WRONG IS THE LINK between a place and a guidebook entry,
because the three sources do not spell a water the same way and the same name
turns up in different counties. A wrong link would show the wrong rules. So:

  * A place is linked by itself ONLY when the whole name and the county match.
  * Every other link is a decision recorded in scraper/fishing/links.json.
  * Anything else stays unlinked. The app then shows entries with a similar name
    as "related", plus every water with its own rules in that county, and does
    not say that statewide rules apply.
  * Every position must fall inside Utah. One upstream record already sits at
    0,0; a position outside the state is dropped and reported, never plotted.

Run by hand, about once a year or when UDWR's layers change:
    python3 scraper/build_fishing_places.py            # reads UDWR (about 8 minutes, one request every 1.5 s)
    python3 scraper/build_fishing_places.py --cached   # reuse the last pull
    python3 scraper/build_fishing_places.py --drive    # also ask OSRM for drive times
Not part of the daily job.
"""
import json, math, os, re, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
SRC = os.path.join(ROOT, "scraper", "fishing")
CACHE = os.path.join(SRC, ".cache")
OUT = os.path.join(DATA, "fishing_places.json")
UA = {"User-Agent": "ranger-hawk/1.0 (rangerhawk.com; personal reference)"}

PLANNER = "https://dwrapps.utah.gov/fishing/"
AGOL = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
COMMUNITY = AGOL + "/Community_fisheries/FeatureServer/0"
REGISTRY = AGOL + "/UDWR_Fish_Stocking_Events_1979_2024_VIEW/FeatureServer/0"
COUNTIES = "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahCountyBoundaries/FeatureServer/0"
OSRM = "https://router.project-osrm.org/table/v1/driving/"
UTAH = (-114.1, 36.9, -109.0, 42.1)          # the same box scraper/sources.py uses

FAIL, NOTE = [], []
fail, note = FAIL.append, NOTE.append


def get(url, tries=3, timeout=120):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:                # noqa: BLE001
            last = e
            if "SSL" in repr(e):
                # The Python Apple ships is built on an old LibreSSL that some servers
                # will not shake hands with. curl on the same machine will.
                import subprocess
                r = subprocess.run(["curl", "-sS", "-f", "-m", str(timeout), "-A", UA["User-Agent"], url],
                                   capture_output=True)
                if r.returncode == 0:
                    return r.stdout
                last = RuntimeError(r.stderr.decode("utf-8", "ignore")[:200])
            time.sleep(5 * (i + 1))
    raise last


def cached(name, fetch, reuse):
    p = os.path.join(CACHE, name)
    if reuse and os.path.exists(p):
        return json.load(open(p))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    j = fetch()
    json.dump(j, open(p, "w"), ensure_ascii=False)
    return j


def in_utah(lon, lat):
    try:
        return UTAH[0] <= float(lon) <= UTAH[2] and UTAH[1] <= float(lat) <= UTAH[3]
    except (TypeError, ValueError):
        return False


def in_ring(x, y, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polys_of(g):
    return [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]


def centroid(g):
    """Area-weighted centre of a polygon or multipolygon, outer rings only."""
    A = X = Y = 0.0
    for poly in polys_of(g):
        ring = poly[0]
        a = x = y = 0.0
        for i in range(len(ring) - 1):
            x0, y0 = ring[i][0], ring[i][1]
            x1, y1 = ring[i + 1][0], ring[i + 1][1]
            c = x0 * y1 - x1 * y0
            a += c
            x += (x0 + x1) * c
            y += (y0 + y1) * c
        if abs(a) < 1e-14:
            continue
        A += abs(a) / 2
        X += (x / (3 * a)) * abs(a) / 2
        Y += (y / (3 * a)) * abs(a) / 2
    return (X / A, Y / A) if A else (None, None)


def miles(a, b, c, d):
    r = math.pi / 180
    h = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def clean(n):
    n = re.sub(r"<[^>]+>", "", n or "")
    n = re.sub(r"\((?:blue ribbon|limited angler access)\)", "", n, flags=re.I)
    return re.sub(r"\s+", " ", n).strip()


def strict(n):
    """The whole name with parentheses dropped. Nothing else is forgiven."""
    n = clean(n).lower().replace("’", "").replace("'", "")
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    return re.sub(r"\s+", " ", n).strip()


TYPE = r"(reservoirs?|lakes?|ponds?|creek|river|stream|tributar(?:y|ies)|inflow|inlet|angler access|wma|walk in access|conservation easement|and its tributaries)$"


def base(n):
    s = strict(n.split(",")[0])
    while True:
        t = re.sub(r"\s*" + TYPE, "", s).strip()
        if t == s or not t:
            return s
        s = t


def kind_of(name):
    n = name.lower()
    if re.search(r"\b(river|creek|fork|stream|canal)\b", n) and not re.search(r"\b(reservoir|lake|pond)s?\b", n):
        return "stream"
    if re.search(r"\bponds?\b", n):
        return "pond"
    return "lake"


def pull_planner(reuse):
    setup = cached("planner_setup.json", lambda: json.loads(get(PLANNER + "fSetup")), reuse)
    out = []
    for name, wid in zip(setup["nameList"], setup["nameListId"]):
        def one(wid=wid, name=name):
            j = json.loads(get(PLANNER + "BySegment?SEGID=%s" % wid))
            info = j.get("hsInfo") or {}
            time.sleep(1.5)                   # one polite read at a time
            return {"id": wid, "list_name": name, "name": info.get("displayName"), "status": info.get("status"),
                    "lon": info.get("centerX"), "lat": info.get("centerY"), "nav": info.get("googleAddress"),
                    "info_updated": info.get("updatedDate"),
                    "regs": ((j.get("hsRegs") or {}).get("description") or "").strip(),
                    "regs_updated": (j.get("hsRegs") or {}).get("updatedDate"),
                    "species": [{"n": s.get("speciesName"), "a": s.get("abundance")}
                                for s in ((j.get("hsSpecies") or {}).get("hotsSpecies") or [])],
                    "stocking": ((j.get("hsStocking") or {}).get("hlStocking") or [])[:40]}
        try:
            out.append(cached("planner/%s.json" % wid, one, reuse))
        except Exception as e:                # noqa: BLE001
            note("planner water %s (%s) could not be read: %r" % (wid, name, e))
    return out


MON = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def iso(d):
    m = re.match(r"([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})", d or "")
    return "%s-%02d-%02d" % (m.group(3), MON[m.group(1).lower()], int(m.group(2))) if m else None


ABUND = {"Likely": "L", "Possible": "P", "Invasive Species": "I", "Protected Species": "X", "Special": "S"}


def main():
    args = sys.argv[1:]
    reuse = "--cached" in args
    rules = json.load(open(os.path.join(DATA, "fishing_rules.json")))
    links = json.load(open(os.path.join(SRC, "links.json")))
    config = json.load(open(os.path.join(DATA, "config.json")))

    counties = cached("counties.json", lambda: json.loads(get(
        COUNTIES + "/query?" + urllib.parse.urlencode({"where": "1=1", "outFields": "NAME", "returnGeometry": "true",
                                                       "outSR": 4326, "maxAllowableOffset": 0.002,
                                                       "geometryPrecision": 4, "f": "geojson"}))), reuse)
    if len(counties["features"]) != 29:
        fail("county outlines: %d counties came back, not 29" % len(counties["features"]))

    def county_at(lon, lat):
        for f in counties["features"]:
            for poly in polys_of(f["geometry"]):
                if in_ring(lon, lat, poly[0]) and not any(in_ring(lon, lat, h) for h in poly[1:]):
                    return f["properties"]["NAME"].title()
        return None

    # ---- the guidebook side
    entries = {}
    for w in rules["waters"]:
        cs = list(w["counties"]) + links.get("extra_counties", {}).get(w["id"], {}).get("counties", [])
        entries[w["id"]] = {"id": w["id"], "name": w["name"], "counties": cs, "kind": w["kind"],
                            "reaches": [r.get("key") for r in w.get("reaches", [])]}
    for m in rules["community"]["members"]:
        entries["community:" + m["id"]] = {"id": "community:" + m["id"], "name": m["name"], "counties": [m["county"]],
                                           "kind": "community", "reaches": []}
    for k in links.get("extra_counties", {}):
        if k not in entries:
            fail("links.json extra_counties names %r, which the guidebook does not have" % k)

    places, dropped = [], []

    def add(p):
        if p.get("lat") is None or p.get("lon") is None or not in_utah(p["lon"], p["lat"]):
            dropped.append((p["id"], p["n"], p.get("lat"), p.get("lon")))
            return
        p["lat"], p["lon"] = round(float(p["lat"]), 5), round(float(p["lon"]), 5)
        hand = links.get("county", {}).get(p["id"])
        p["c"] = hand["county"] if hand else county_at(p["lon"], p["lat"])
        if not p["c"]:
            dropped.append((p["id"], p["n"], p["lat"], p["lon"]))
            return
        places.append(p)

    # ---- planner
    for q in pull_planner(reuse):
        name = clean(q.get("name") or q.get("list_name"))
        p = {"id": "p%s" % q["id"], "n": name, "lat": q.get("lat"), "lon": q.get("lon"), "src": "planner",
             "k": kind_of(name)}
        if re.search(r"\(blue ribbon\)", q.get("name") or "", re.I):
            p["br"] = 1
        m = re.match(r"\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$", q.get("nav") or "")
        if m and in_utah(m.group(2), m.group(1)):
            p["nav"] = [round(float(m.group(1)), 5), round(float(m.group(2)), 5)]
            # UDWR's directions point is sometimes a long way from its own point for the
            # water (Lower Fish Creek: 119 miles). Directions to the wrong county are worse
            # than directions to the middle of the water, so such a point is not used.
            off = miles(p["lat"], p["lon"], p["nav"][0], p["nav"][1])
            if off > 15:
                note("%s %r: UDWR's directions point is %d miles from its own point for the water; not used" % (p["id"], p["n"], off))
                del p["nav"]
        sp = [[s["n"], ABUND.get(s["a"], "P")] for s in q.get("species", []) if s.get("n")]
        if sp:
            p["sp"] = sp
        st = []
        for s in q.get("stocking", []):
            d = iso(s.get("dateStocked"))
            if d:
                st.append([d, (s.get("species") or "").title(), s.get("quantity"), s.get("avgLength")])
        st.sort(reverse=True)
        if st:
            p["st"] = st[:3]
        if st and st[0][0][:4] >= "2000":
            ids = [s.get("dwrWaterID") for s in q.get("stocking", []) if s.get("dwrWaterID")]
            if ids:
                p["dwr"] = ids[0]
        p["_regs"] = q.get("regs") or ""
        add(p)

    # ---- community fisheries layer
    com = cached("community.json", lambda: json.loads(get(COMMUNITY + "/query?" + urllib.parse.urlencode(
        {"where": "1=1", "outFields": "*", "returnGeometry": "true", "outSR": 4326, "f": "geojson"}))), reuse)
    for f in com["features"]:
        pr, g = f["properties"], f.get("geometry") or {}
        xy = g.get("coordinates") or [None, None]
        p = {"id": "c%s" % pr.get("OBJECTID_1"), "n": (pr.get("WaterName") or "").strip(), "lat": xy[1], "lon": xy[0],
             "src": "community", "k": "pond", "layer": 1}
        sp = [s.strip().capitalize() for s in re.split(r",| and ", pr.get("Species") or "") if s.strip()]
        if sp:
            p["sp"] = [[s, "L"] for s in sp]
        add(p)

    # ---- property layer (already in the repo, pulled daily)
    props = json.load(open(os.path.join(DATA, "raw_dwr_properties.json")))
    for f in props["features"]:
        pr = f["properties"]
        said = " ".join([pr.get("purpose") or "", pr.get("activityType") or ""])
        if pr.get("type_") != "Angler Access" and not re.search(r"angl|fish", said, re.I):
            continue
        if len((pr.get("county") or "").split(",")) > 6:
            continue                          # a statewide catch-all record has no one position
        lon, lat = centroid(f["geometry"]) if f.get("geometry") else (None, None)
        p = {"id": "a%s" % pr.get("id"), "n": (pr.get("name") or "").strip(), "lat": lat, "lon": lon,
             "src": "property", "k": "access", "pt": pr.get("type_"), "ac": round(pr.get("acres") or 0, 1)}
        if pr.get("restrictions") and pr["restrictions"] not in ("null", "None"):
            p["restr"] = pr["restrictions"].strip()
        if pr.get("closureDates") and not re.match(r"(?i)no seasonal closure|null|none|^$", pr["closureDates"]):
            p["closure"] = pr["closureDates"].strip()
        if pr.get("licenseRequiredType") and pr["licenseRequiredType"] not in ("No", "No (Exempt)"):
            p["needs"] = pr["licenseRequiredType"]
        if pr.get("purpose"):
            p["purpose"] = pr["purpose"].strip()
        add(p)

    # ---- lake registry, only for guidebook waters a person has matched to it
    reg = cached("registry.json", lambda: json.loads(get(REGISTRY + "/query?" + urllib.parse.urlencode(
        {"where": "1=1", "outFields": "DWR_WaterID,WaterName,CentralPoint_X,CentralPoint_Y,Shape__Area",
         "returnGeometry": "false", "f": "json"}))), reuse)
    by_dwr = {}
    for f in reg["features"]:
        a = f["attributes"]
        by_dwr.setdefault(a["DWR_WaterID"], []).append(a)
    for wid, dwr in links.get("registry", {}).items():
        if wid not in entries:
            fail("links.json registry names %r, which the guidebook does not have" % wid)
            continue
        rows = by_dwr.get(dwr)
        if not rows:
            fail("links.json registry: UDWR's lake registry has no water %r (for %s)" % (dwr, wid))
            continue
        a = max(rows, key=lambda r: r.get("Shape__Area") or 0)
        e = entries[wid]
        p = {"id": "r%s-%s" % (dwr, wid.split(":")[-1][:24]), "n": e["name"], "lat": a["CentralPoint_Y"],
             "lon": a["CentralPoint_X"], "src": "registry", "k": kind_of(e["name"]), "dwr": dwr,
             "as": a["WaterName"], "_hand": wid}
        n0 = len(places)
        add(p)
        if len(places) == n0:
            fail("registry water %s for %s lies outside Utah" % (dwr, wid))
            continue
        if p["c"] not in e["counties"]:
            if wid in links.get("county_notes", {}):
                p["note"] = links["county_notes"][wid]
            else:
                fail("registry water %s (%s) is in %s County; the guidebook files %s under %s"
                     % (dwr, a["WaterName"], p["c"], e["name"], ", ".join(e["counties"])))

    # ---- links
    ids = {p["id"]: p for p in places}
    for pid, l in links.get("places", {}).items():
        if pid not in ids:
            fail("links.json names place %r, which was not read from UDWR" % pid)
            continue
        ws = l.get("water") or []
        ws = ws if isinstance(ws, list) else [ws]
        if not l.get("why"):
            fail("links.json decides %s and does not say why" % pid)
        # entries a person has looked at and found near, or found to be another water
        for k in ("related", "unrelated"):
            for w in l.get(k, []):
                if w not in entries:
                    fail("links.json names %r as %s to %s; the guidebook does not have it" % (w, k, pid))
        ids[pid]["_rel"], ids[pid]["_unrel"] = l.get("related", []), l.get("unrelated", [])
        if l.get("note"):
            ids[pid]["note"] = l["note"]
        for w in ws:
            if w not in entries:
                fail("links.json links %s to %r, which the guidebook does not have" % (pid, w))
            elif ids[pid]["c"] not in entries[w]["counties"]:
                fail("links.json links %s (%s County) to %s, which the guidebook files under %s"
                     % (pid, ids[pid]["c"], w, ", ".join(entries[w]["counties"])))
        r = l.get("reach")
        if r is not None and r != "none":
            for k in (r if isinstance(r, list) else [r]):
                if len(ws) != 1 or k not in entries.get(ws[0], {}).get("reaches", []):
                    fail("links.json gives %s stretch %r, which %s does not have" % (pid, k, ws[0]))
        if ws:
            ids[pid]["_hand"] = ws
        if r is not None:
            ids[pid]["r"] = r if isinstance(r, list) or r == "none" else [r]
        if r == "none":
            if not l.get("why"):
                fail("links.json puts %s outside every listed stretch and does not say why" % pid)
            ids[pid]["why"] = l.get("why", "")

    linked_to = {}
    for p in places:
        hand = p.pop("_hand", None)
        auto = [e["id"] for e in entries.values() if p["c"] in e["counties"] and strict(e["name"]) == strict(p["n"])]
        if hand:
            ws = hand if isinstance(hand, list) else [hand]
            clash = [a for a in auto if a not in ws and not (a.startswith("community:") or any(w.startswith("community:") for w in ws))]
            if clash:
                fail("%s %r is linked by hand to %s but matches %s exactly" % (p["id"], p["n"], ws, clash))
            ws = ws + [a for a in auto if a not in ws]
            p["by"] = "hand"
        else:
            ws = auto
        if ws:
            p["w"] = ws
            for w in ws:
                linked_to.setdefault(w, []).append(p["id"])
        b = base(p["n"])
        rel = [e["id"] for e in entries.values()
               if p["c"] in e["counties"] and e["id"] not in ws and b and len(b) >= 4
               and re.search(r"(?<![a-z])" + re.escape(b) + r"(?![a-z])", strict(e["name"]))]
        unrel = p.pop("_unrel", [])
        rel = [x for x in rel if x not in unrel] + [x for x in p.pop("_rel", []) if x not in rel and x not in ws]
        if rel:
            p["rel"] = rel
        if any(w.startswith("community:") for w in ws):
            p["cf"] = 1
        if p.pop("layer", 0) and not p.get("cf"):
            p["note"] = ("UDWR's community fisheries map lists this pond, but the %s guidebook's list of community "
                         "waters does not. The app cannot tell which limit applies here; ask UDWR."
                         % rules["_edition"]["year"])

    # ---- one place per pond: the planner and the community layer often both carry it
    keep, gone = [], set()
    for p in places:
        if p["src"] != "community" or not p.get("w"):
            continue
        twin = [q for q in places if q["src"] == "planner" and q.get("w") == p["w"]
                and miles(p["lat"], p["lon"], q["lat"], q["lon"]) < 1.0]
        if twin:
            gone.add(p["id"])
    places = [p for p in places if p["id"] not in gone]
    # ---- a UDWR property that sits on a water already listed is folded into it
    for p in places:
        if p["src"] != "property" or p["id"] in gone:
            continue
        b = base(p["n"])
        for q in places:
            if q["src"] == "property" or q["id"] in gone or miles(p["lat"], p["lon"], q["lat"], q["lon"]) > 0.75:
                continue
            bq = base(q["n"])
            if re.search(r"\b(river|creek)\b", p["n"], re.I) and q["k"] != "stream":
                continue                      # access to a river is not the pond beside it
            if b and bq and (b == bq or b.startswith(bq + " ") or bq.startswith(b + " ")):
                if p.get("w") and q.get("w") and p["w"] != q["w"]:
                    continue
                q.setdefault("prop", []).append({k: p[k] for k in ("n", "pt", "restr", "closure", "needs", "ac") if p.get(k)})
                gone.add(p["id"])
                break
    places = [p for p in places if p["id"] not in gone]
    for w in list(linked_to):
        linked_to[w] = [i for i in linked_to[w] if i not in gone]

    # ---- every guidebook water is placed, or is on the list of those that cannot be
    for wid, why in links.get("no_place", {}).items():
        if wid not in entries:
            fail("links.json no_place names %r, which the guidebook does not have" % wid)
        elif linked_to.get(wid):
            fail("links.json says %s has no place, but %s is linked to it" % (wid, linked_to[wid]))
    unplaced = [e for e in entries.values() if not linked_to.get(e["id"]) and e["kind"] in ("water", "notice", "community")
                and e["id"] not in links.get("no_place", {})]
    lakes_unplaced = [e for e in unplaced if kind_of(e["name"]) != "stream" and not re.search(r"tributar|inflow|inlet|lakes and", e["name"])]
    for e in lakes_unplaced:
        fail("no place for %s (%s). Link one in links.json, or list it under no_place with the reason."
             % (e["name"], ", ".join(e["counties"])))

    # ---- second source: does UDWR's planner, for the same water, carry the same rules?
    # The planner's wording is mostly from 2019 and is NOT used by the app. It is read here
    # only to catch a rule filed under the wrong water by the guidebook reader.
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    agree = differ = 0
    odd = []
    water_rules = {w["id"]: [ru["text"] for r in w.get("reaches", []) for ru in r["rules"]] for w in rules["waters"]}
    for p in places:
        regs = norm(p.pop("_regs", "") if "_regs" in p else "")
        if not regs or not p.get("w"):
            continue
        for w in p["w"]:
            mine = water_rules.get(w)
            if not mine:
                continue
            hit = [t for t in mine if norm(t)[:40] in regs or norm(re.sub(r"\.$", "", t)) in regs]
            if hit:
                agree += 1
            else:
                differ += 1
                odd.append((p["n"], w))
    for p in places:
        p.pop("_regs", None)

    # ---- drive times from the three homes (town-level anchors; nothing personal)
    homes = [(h["id"], h["lat"], h["lon"]) for h in config["homes"]]
    if "--drive" in args:
        prev = {}
        for i in range(0, len(places), 90):
            chunk = places[i:i + 90]
            pts = [(h[2], h[1]) for h in homes] + [((p.get("nav") or [p["lat"], p["lon"]])[1], (p.get("nav") or [p["lat"], p["lon"]])[0]) for p in chunk]
            url = OSRM + ";".join("%.5f,%.5f" % xy for xy in pts) + "?sources=" + ";".join(str(k) for k in range(len(homes))) + "&annotations=duration,distance"
            try:
                j = json.loads(get(url, timeout=180))
                if j.get("code") != "Ok":
                    raise RuntimeError(j.get("code"))
                for hi, h in enumerate(homes):
                    for pi, p in enumerate(chunk):
                        d, m = j["durations"][hi][len(homes) + pi], j["distances"][hi][len(homes) + pi]
                        snap = j["destinations"][len(homes) + pi].get("distance", 0) / 1609.34
                        if d is None:
                            continue
                        p.setdefault("d", {})[h[0]] = {"min": int(round(d / 60)), "mi": round(m / 1609.34, 1)}
                        p["snap"] = round(snap, 2)
            except Exception as e:            # noqa: BLE001
                note("OSRM did not answer for places %d-%d: %r" % (i, i + len(chunk), e))
            time.sleep(1.5)
    else:
        old = {p["id"]: p for p in (json.load(open(OUT))["places"] if os.path.exists(OUT) else [])}
        for p in places:
            o = old.get(p["id"])
            if o and o.get("d") and abs(o["lat"] - p["lat"]) < 1e-4 and abs(o["lon"] - p["lon"]) < 1e-4:
                p["d"], p["snap"] = o["d"], o.get("snap")

    places.sort(key=lambda p: (p["n"].lower(), p["id"]))
    for n in NOTE:
        print("  note:", n)
    for d in dropped:
        print("  dropped, outside Utah or no position:", d)
    print("  places=%d (planner %d, community %d, property %d, registry %d); linked %d, by hand %d, related only %d, neither %d"
          % (len(places), sum(p["src"] == "planner" for p in places), sum(p["src"] == "community" for p in places),
             sum(p["src"] == "property" for p in places), sum(p["src"] == "registry" for p in places),
             sum(1 for p in places if p.get("w")), sum(1 for p in places if p.get("by") == "hand"),
             sum(1 for p in places if not p.get("w") and p.get("rel")), sum(1 for p in places if not p.get("w") and not p.get("rel"))))
    print("  guidebook waters with a place: %d of %d; streams and tributary groups without one: %d"
          % (len([e for e in entries.values() if linked_to.get(e["id"])]), len(entries), len(unplaced) - len(lakes_unplaced)))
    print("  second source: UDWR's planner carries the same rule for %d linked waters; for %d it does not:" % (agree, differ))
    for o in odd:
        print("      ", o)
    print("  with drive times: %d" % sum(1 for p in places if p.get("d")))
    for f in FAIL:
        print("  FAIL:", f)
    if FAIL:
        print("NOT WRITTEN: %d check(s) failed. %s is unchanged." % (len(FAIL), OUT))
        return 1
    out = {"_source": "Utah Division of Wildlife Resources: Fish Utah planner, community fisheries layer, property layer "
                      "and lake registry. County outlines: UGRC. Drive times: OSRM, from town-level anchors.",
           "_note": "A place is linked to a guidebook entry only when the whole name and the county match, or by a "
                    "decision recorded in scraper/fishing/links.json. Species and stocking are UDWR's and are not "
                    "regulations. Not legal advice.",
           "_built": time.strftime("%Y-%m-%d"), "_rules_sha": rules["_edition"]["sha"], "_rules_shape": rules["_shape"],
           "extra_counties": {k: v["counties"] for k, v in links.get("extra_counties", {}).items()},
           "no_place": links.get("no_place", {}),
           "places": places}
    json.dump(out, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote %s: %d KB" % (OUT, os.path.getsize(OUT) // 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
