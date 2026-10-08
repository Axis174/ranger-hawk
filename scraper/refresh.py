#!/usr/bin/env python3
"""Refresh every dataset the atlas uses, and report what changed.

Writes docs/data/*.json and docs/data/changelog.json. Designed to run headless
in GitHub Actions on a cron. Never fails the build on a single bad source - it
records the failure and carries on, because a dead upstream should not blank
out the app.
"""
import hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from html import unescape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
UA = {"User-Agent": "ranger-hawk/1.0 (personal hunting reference; contact via repo)"}
os.makedirs(DATA, exist_ok=True)

report = {"run": datetime.now(timezone.utc).isoformat(timespec="seconds"),
          "changes": [], "errors": [], "ok": []}


def get(url, tries=3, timeout=120, backoff=2):
    """Fetch with retries. 429 gets a much longer wait - Reddit in particular
    rate-limits hard and a tight retry just burns the budget."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                time.sleep(20 * (i + 1))
            elif e.code in (400, 404):
                raise                      # a bad URL will not fix itself
            else:
                time.sleep(backoff * (i + 1))
        except Exception as e:            # noqa: BLE001 - upstream can fail any way
            last = e
            time.sleep(backoff * (i + 1))
    raise last


def arcgis_query(base, where="1=1", geometry=True, bbox=None, out_sr=4326, offset=0):
    # f=geojson REQUIRES geometry; asking for geojson with returnGeometry=false
    # is a 400. Use Esri json for attribute-only pulls and normalise the shape.
    fmt = "geojson" if geometry else "json"
    p = {"where": where, "outFields": "*", "returnGeometry": str(geometry).lower(),
         "outSR": out_sr, "f": fmt, "resultOffset": offset,
         "resultRecordCount": 2000}
    if bbox:
        p.update({"geometry": bbox, "geometryType": "esriGeometryEnvelope",
                  "inSR": 4326, "spatialRel": "esriSpatialRelIntersects"})
    raw = json.loads(get(base + "/query?" + urllib.parse.urlencode(p)))
    if fmt == "json":
        if "error" in raw:
            raise RuntimeError(str(raw["error"])[:200])
        raw = {"type": "FeatureCollection",
               "features": [{"type": "Feature", "geometry": None,
                             "properties": f.get("attributes", {})}
                            for f in raw.get("features", [])],
               "exceededTransferLimit": raw.get("exceededTransferLimit", False)}
    return raw


def fetch_all(base, **kw):
    """Page through a layer until it stops handing back features."""
    feats, offset = [], 0
    while True:
        gj = arcgis_query(base, offset=offset, **kw)
        batch = gj.get("features", [])
        feats.extend(batch)
        if len(batch) < 2000 or not gj.get("exceededTransferLimit"):
            break
        offset += len(batch)
    return {"type": "FeatureCollection", "features": feats}


def digest(obj):
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def load_prev(name):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        try:
            return json.load(open(p))
        except Exception:
            return None
    return None


def save(name, obj):
    # "checked" is the run's timestamp, and nothing reads it (the phone, the tests and
    # the README never do). Rewriting a file that differs only by that stamp put a
    # ~940 KB commit in .git every night, so the file is written only when its data
    # changes, and "checked" is therefore the last time the data changed.
    prev = load_prev(name)
    if isinstance(prev, dict) and isinstance(obj, dict) and "checked" in obj:
        drop = lambda d: {k: v for k, v in d.items() if k != "checked"}
        if drop(prev) == drop(obj):
            return
    json.dump(obj, open(os.path.join(DATA, name), "w"), separators=(",", ":"))


def watch_diff(key, prev, cur, watch_fields, id_field=None):
    """Field-level diff so the changelog says WHAT changed, not just 'changed'."""
    if not prev or not watch_fields:
        return []
    def index(fc):
        out = {}
        for f in fc.get("features", []):
            pr = f.get("properties", {})
            k = pr.get(id_field) if id_field else None
            if k is None:
                k = pr.get("name") or pr.get("Name") or pr.get("CHA_Name") \
                    or pr.get("Boundary_Name") or pr.get("Location")
            if k is None:
                continue
            out[str(k)] = pr
        return out
    a, b = index(prev), index(cur)
    notes = []
    for k in sorted(set(b) - set(a)):
        notes.append({"type": "added", "item": k})
    for k in sorted(set(a) - set(b)):
        notes.append({"type": "removed", "item": k})
    for k in sorted(set(a) & set(b)):
        for fld in watch_fields:
            if str(a[k].get(fld, "")) != str(b[k].get(fld, "")):
                notes.append({"type": "changed", "item": k, "field": fld,
                              "from": str(a[k].get(fld, ""))[:180],
                              "to": str(b[k].get(fld, ""))[:180]})
    return notes


# ---------------------------------------------------------------- ArcGIS ----
for key, spec in S.ARCGIS.items():
    name = f"raw_{key}.json"
    try:
        cur = fetch_all(spec["url"], geometry=spec.get("geometry", True))
        if not cur["features"] and spec.get("optional"):
            report["errors"].append({"source": key, "error": "empty (optional)"})
            continue
        prev = load_prev(name)
        notes = watch_diff(key, prev, cur, spec.get("watch", []))
        if prev is None:
            report["ok"].append({"source": key, "features": len(cur["features"]), "first_run": True})
        elif digest(prev) != digest(cur):
            report["changes"].append({"source": key, "desc": spec["desc"],
                                      "features": len(cur["features"]), "detail": notes[:40]})
        else:
            report["ok"].append({"source": key, "features": len(cur["features"])})
        save(name, cur)
    except Exception as e:                # noqa: BLE001
        report["errors"].append({"source": key, "error": repr(e)[:300]})

# Probe for a newer pheasant-release layer year (UDWR renames it annually).
try:
    yr = datetime.now().year
    for y in (yr + 1, yr):
        u = ("https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
             f"/{y}_Pheasant_Release_Areas_view/FeatureServer/0")
        try:
            meta = json.loads(get(u + "?f=json", tries=1, timeout=40))
            if meta.get("name"):
                report["ok"].append({"source": "pheasant_release_probe",
                                     "found_year": y, "layer": meta.get("name")})
                break
        except Exception:
            continue
except Exception as e:                    # noqa: BLE001
    report["errors"].append({"source": "pheasant_release_probe", "error": repr(e)[:200]})

# ------------------------------------------------------------- migration ----
mig = {"type": "FeatureCollection", "features": []}
for lname, lid in S.MIGRATION_LAYERS.items():
    try:
        fc = fetch_all(f"{S.MIGRATION_BASE}/{lid}", bbox=S.UTAH_BBOX)
        for f in fc["features"]:
            f.setdefault("properties", {})["_layer"] = lname
        mig["features"].extend(fc["features"])
        report["ok"].append({"source": f"migration:{lname}", "features": len(fc["features"])})
    except Exception as e:                # noqa: BLE001
        report["errors"].append({"source": f"migration:{lname}", "error": repr(e)[:300]})
if mig["features"]:
    prev = load_prev("migration_utah.json")
    if prev and digest(prev) != digest(mig):
        report["changes"].append({"source": "migration_utah",
                                  "desc": "USGS ungulate migration layers (Utah extent)",
                                  "features": len(mig["features"]), "detail": []})
    # Thin it. The raw pull is ~6 MB, which is too heavy to commit daily and far
    # too heavy to hand a phone. 4 decimal places is ~11 m - well inside the
    # precision of a collar-derived corridor - and we keep only the layer tag.
    def thin(coords):
        if isinstance(coords[0], (int, float)):
            return [round(coords[0], 4), round(coords[1], 4)]
        return [thin(c) for c in coords]
    slim = {"type": "FeatureCollection", "_source":
            "USGS Ungulate Migrations of the Western United States, Volume 1 (Utah extent)",
            "_note": "Coordinates rounded to 4 dp (~11 m).", "features": []}
    for f in mig["features"]:
        g = f.get("geometry")
        if not g or not g.get("coordinates"):
            continue
        slim["features"].append({
            "type": "Feature",
            "geometry": {"type": g["type"], "coordinates": thin(g["coordinates"])},
            "properties": {"layer": f["properties"].get("_layer")}})
    save("migration_utah.json", slim)

# ------------------------------------------------------------------ PDFs ----
hashes = load_prev("pdf_hashes.json") or {}
new_hashes = {}
for key, url in S.PDFS.items():
    try:
        b = get(url)
        h = hashlib.sha256(b).hexdigest()[:16]
        new_hashes[key] = {"sha": h, "bytes": len(b), "url": url}
        old = (hashes.get(key) or {}).get("sha")
        if old and old != h:
            report["changes"].append({
                "source": f"pdf:{key}", "desc": "GUIDEBOOK REISSUED - season tables need a human read",
                "detail": [{"type": "changed", "item": key, "field": "sha",
                            "from": old, "to": h}]})
        elif not old:
            report["ok"].append({"source": f"pdf:{key}", "first_run": True})
        else:
            report["ok"].append({"source": f"pdf:{key}"})
    except Exception as e:                # noqa: BLE001
        report["errors"].append({"source": f"pdf:{key}", "error": repr(e)[:300]})
if new_hashes:
    save("pdf_hashes.json", new_hashes)

# ------------------------------------------- fishing: emergency changes ----
# UDWR amends the fishing guidebook by signed notice during the year and never
# folds the change into the PDF, so the hash above cannot see it. This reads the
# Revisions list beside the Fishing Guidebook and keeps UDWR's words. It decides
# nothing: a new notice reaches the phone the next morning word for word, marked
# as not yet built into the rules, until a person has read it into
# scraper/fishing/amendments.json and rebuilt. A page that cannot be read never
# wipes the notices already held - it is recorded as a failed check instead, and
# the app shows how long ago the list was last read successfully.
try:
    import fishing_notices as FN
    prev = load_prev("fishing_notices.json") or {}
    had = {n["slug"]: n for n in prev.get("notices", [])}
    try:
        got = FN.read(get(S.FISHING_REVISIONS["page"], timeout=90).decode("utf-8", "ignore"),
                      S.FISHING_REVISIONS["block_id"], S.FISHING_REVISIONS["notice_path"])
    except Exception as e:                # noqa: BLE001
        got = {"ok": False, "error": repr(e)[:200], "notices": [], "other": []}
    if got["ok"] and not got["notices"] and had:
        got = {"ok": False, "error": "the list came back empty although %d notices were held" % len(had),
               "notices": [], "other": []}
    out = {"checked": report["run"], "page": S.FISHING_REVISIONS["page"],
           "guidebook": new_hashes.get("fishing") or prev.get("guidebook")}
    if got["ok"]:
        detail = []
        for n in got["notices"]:
            old = had.get(n["slug"])
            n["first_seen"] = (old or {}).get("first_seen") or report["run"][:10]
            for k in ("pdf_sha", "pdf_bytes"):
                if old and old.get(k):
                    n[k] = old[k]
            # The signed notice is read every day, not once: UDWR can replace the PDF
            # and leave its address and its summary as they were.
            if not n.get("no_pdf"):
                try:
                    b = get(n["url"], timeout=90)
                    if b[:5] == b"%PDF-":
                        n["pdf_sha"], n["pdf_bytes"] = hashlib.sha256(b).hexdigest()[:16], len(b)
                    else:
                        report["errors"].append({"source": "fishing_notice:" + n["slug"], "error": "what came back is not a PDF"})
                except Exception as e:        # noqa: BLE001
                    report["errors"].append({"source": "fishing_notice:" + n["slug"], "error": repr(e)[:160]})
            if old is None:
                detail.append({"type": "added", "item": n["title"]})
            else:
                if old.get("sha") != n["sha"]:
                    detail.append({"type": "changed", "item": n["title"], "field": "wording",
                                   "from": old.get("sha", ""), "to": n["sha"]})
                if old.get("pdf_sha") and n.get("pdf_sha") and old["pdf_sha"] != n["pdf_sha"]:
                    detail.append({"type": "changed", "item": n["title"], "field": "signed notice",
                                   "from": old["pdf_sha"], "to": n["pdf_sha"]})
        for slug_, old in had.items():
            if slug_ not in {n["slug"] for n in got["notices"]}:
                detail.append({"type": "removed", "item": old.get("title", slug_)})
        if not detail and prev.get("sha") and prev["sha"] != got["sha"]:
            # The list reads differently and no notice accounts for it: a heading, a
            # correction, or a notice set out in a way the reader does not know.
            detail.append({"type": "changed", "item": "the list itself", "field": "wording",
                           "from": prev["sha"], "to": got["sha"]})
        if detail and prev:
            report["changes"].append({
                "source": "fishing_notices",
                "desc": "FISHING EMERGENCY CHANGE - the app shows UDWR's words; a person must read it into "
                        "scraper/fishing/amendments.json and run build_fishing.py",
                "features": len(got["notices"]), "detail": detail[:40]})
        else:
            report["ok"].append({"source": "fishing_notices", "features": len(got["notices"]),
                                 **({"first_run": True} if not prev else {})})
        out.update({"ok": True, "last_ok": report["run"], "sha": got["sha"],
                    "notices": got["notices"], "other": got["other"]})
    else:
        report["errors"].append({"source": "fishing_notices", "error": got["error"]})
        out.update({"ok": False, "error": got["error"], "last_ok": prev.get("last_ok"),
                    "sha": prev.get("sha"), "notices": prev.get("notices", []), "other": prev.get("other", [])})
    save("fishing_notices.json", out)
except Exception as e:                    # noqa: BLE001
    report["errors"].append({"source": "fishing_notices", "error": repr(e)[:200]})

# --------------------------------------------------- 2027 application watch --
app_hits = []
for key, url in S.WATCH_PAGES.items():
    try:
        html = get(url, timeout=60).decode("utf-8", "ignore")
        txt = re.sub(r"<[^>]+>", " ", html)
        for m in re.finditer(
            r"application period[^.]{0,160}?(20\d\d)|"
            r"(?:applications?|apply)[^.]{0,80}?"
            r"((?:Jan|Feb|March|Mar|April|Apr|May|June|Jun)[a-z]*\.?\s+\d{1,2})[^.]{0,60}?20(2[7-9])",
            txt, re.I):
            app_hits.append({"page": key, "snippet": " ".join(m.group(0).split())[:200]})
    except Exception as e:                # noqa: BLE001
        report["errors"].append({"source": f"watch:{key}", "error": repr(e)[:200]})
save("application_watch.json", {"checked": report["run"], "hits": app_hits[:30]})

# ------------------------------------------------------------- community ----
community = []


def reddit_feed(url):
    """One polite read of a Reddit Atom feed. Anonymous readers get roughly one
    request per half minute; Reddit says exactly how long in x-ratelimit-reset,
    so wait that long afterwards instead of guessing. One retry on a 429."""
    for attempt in (1, 2):
        req = urllib.request.Request(url, headers=UA)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read().decode("utf-8", "ignore")
                wait = float(r.headers.get("x-ratelimit-reset") or 30)
            time.sleep(min(wait, 90) + 3)
            return body
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt == 1:
                time.sleep(min(float(e.headers.get("x-ratelimit-reset") or
                                     e.headers.get("retry-after") or 60), 120) + 5)
                continue
            raise
    return ""


# Search is closed to anonymous readers (it returns an empty feed), so read each
# community's newest 100 posts and filter here. National hunting communities are
# filtered for Utah place names; Utah communities are filtered for hunting words.
RE_UTAH = re.compile(r"\b(" + "|".join(re.escape(t) for t in S.REDDIT_TERMS) + r")\b", re.I)
RE_HUNT = re.compile(r"\b(" + "|".join(re.escape(t) for t in S.REDDIT_HUNT_TERMS) + r")", re.I)
seen_reddit = 0
for sub, mode in S.REDDIT_FEEDS:
    try:
        xml = reddit_feed(S.REDDIT_RSS.format(sub=sub))
        for m in re.finditer(r"<entry>(.*?)</entry>", xml, re.S):
            it = m.group(1)
            t = re.search(r"<title[^>]*>(.*?)</title>", it, re.S)
            l = re.search(r'<link[^>]*href="([^"]+)"', it)
            u = re.search(r"<updated>(.*?)</updated>", it, re.S)
            if not (t and l):
                continue
            seen_reddit += 1
            title = unescape(re.sub(r"<[^>]+>", "", t.group(1))).strip()
            low = title.lower()
            if any(k in low for k in S.REDDIT_SKIP):
                continue
            if not (RE_UTAH if mode == "utah" else RE_HUNT).search(title):
                continue
            community.append({"source": f"r/{sub}", "title": title[:220], "url": l.group(1),
                              "created": (u.group(1).strip()[:10] if u else ""), "score": 0})
    except Exception as e:                # noqa: BLE001
        report["errors"].append({"source": f"reddit:{sub}", "error": repr(e)[:200]})

# A single day rarely has a Utah hunting post, so keep what earlier runs found
# for 60 days. Without this the section is empty most mornings.
cutoff = (datetime.now(timezone.utc) - timedelta(days=60)).strftime("%Y-%m-%d")
have = {c["url"] for c in community}
for old in (load_prev("community.json") or {}).get("items", []):
    if old.get("source", "").startswith("r/") and old.get("url") not in have \
            and old.get("created", "")[:10] >= cutoff:
        community.append(old)
        have.add(old["url"])
report["ok"].append({"source": "reddit", "posts_read": seen_reddit,
                     "kept": sum(1 for c in community if c["source"].startswith("r/"))})
for nm, url in S.NEWS_PAGES.items():
    try:
        html = get(url, timeout=60).decode("utf-8", "ignore")
        seen = set()
        for path, label in re.findall(
                r'href="(/news/(\d{4})/(\d{2})/(\d{2})/[^"#?]+)"[^>]*>(.*?)</a>',
                html, re.S) and re.findall(
                r'href="(/news/\d{4}/\d{2}/\d{2}/[^"#?]+)"[^>]*>(.*?)</a>', html, re.S):
            title = " ".join(re.sub(r"<[^>]+>", "", label).split())
            if not title or path in seen:
                continue
            seen.add(path)
            if not any(t in title.lower() for t in S.NEWS_TERMS):
                continue
            d = re.search(r"/news/(\d{4})/(\d{2})/(\d{2})/", path)
            community.append({
                "source": nm, "title": title[:220],
                "url": "https://wildlife.utah.gov" + path,
                "created": f"{d.group(1)}-{d.group(2)}-{d.group(3)}" if d else "",
                "score": 0})
    except Exception as e:                # noqa: BLE001
        report["errors"].append({"source": f"news:{nm}", "error": repr(e)[:200]})
community.sort(key=lambda x: x.get("created", ""), reverse=True)
save("community.json", {"checked": report["run"], "items": community[:120],
                        "manual_watch": S.MANUAL_WATCH,
                        "policy": "Official sources and Reddit's public feeds only, read slowly. "
                                  "Facebook and Instagram are deliberately excluded: they are "
                                  "auth-walled, their terms forbid scraping, and anything built "
                                  "on them breaks within weeks."})

# ------------------------------------------------------------ lake level ----
# Great Salt Lake surface elevation from USGS Water Services (public domain,
# keyless). The level decides which marsh units hold water, so it is worth a
# daily number. 30 days of readings gives a trend without storing history.
try:
    q = urllib.parse.urlencode({"sites": ",".join(S.LAKE_SITES), "parameterCd": "62614",
                                "period": "P30D", "format": "json", "siteStatus": "all"})
    raw = json.loads(get("https://waterservices.usgs.gov/nwis/iv/?" + q, timeout=90))
    sites = []
    for ts in raw["value"]["timeSeries"]:
        code = ts["sourceInfo"]["siteCode"][0]["value"]
        vals = [v for v in ts["values"][0]["value"] if float(v["value"]) > 0]
        if not vals:
            continue
        first, last = vals[0], vals[-1]
        sites.append({"site": code, "name": S.LAKE_SITES.get(code, code),
                      "elev_ft": float(last["value"]), "at": last["dateTime"],
                      "elev_30d_ago_ft": float(first["value"]), "from": first["dateTime"],
                      "change_30d_ft": round(float(last["value"]) - float(first["value"]), 2)})
    if sites:
        save("lake_level.json", {"checked": report["run"], "sites": sites,
                                 "reference": S.LAKE_REFERENCE,
                                 "source": "USGS Water Services, parameter 62614 "
                                           "(lake surface elevation, ft above NGVD 1929)"})
        report["ok"].append({"source": "lake_level", "features": len(sites)})
    else:
        report["errors"].append({"source": "lake_level", "error": "no readings returned"})
except Exception as e:                    # noqa: BLE001
    report["errors"].append({"source": "lake_level", "error": repr(e)[:200]})

# ------------------------------------------------------------------ snow ----
try:
    end = datetime.now(timezone.utc).date()
    q = urllib.parse.urlencode({"stationTriplets": ",".join(S.SNOTEL), "elements": "SNWD,WTEQ",
                                "duration": "DAILY", "beginDate": str(end - timedelta(days=10)),
                                "endDate": str(end)})
    raw = json.loads(get("https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?" + q, timeout=90))
    snow = []
    for st in raw:
        meta = S.SNOTEL.get(st.get("stationTriplet"), {})
        row = {"station": st.get("stationTriplet"), **meta}
        for d in st.get("data", []):
            code = d.get("stationElement", {}).get("elementCode")
            vals = [v for v in d.get("values", []) if v.get("value") is not None]
            if not vals:
                continue
            key = "depth_in" if code == "SNWD" else "water_in"
            row[key] = vals[-1]["value"]
            row[key + "_7d_ago"] = vals[max(0, len(vals) - 8)]["value"]
            row["date"] = vals[-1]["date"][:10]
        if "date" in row:
            snow.append(row)
    if snow:
        save("snow.json", {"checked": report["run"], "stations": snow,
                           "source": "USDA NRCS SNOTEL (AWDB REST API)"})
        report["ok"].append({"source": "snow", "features": len(snow)})
    else:
        report["errors"].append({"source": "snow", "error": "no readings returned"})
except Exception as e:                    # noqa: BLE001
    report["errors"].append({"source": "snow", "error": repr(e)[:200]})

# ------------------------------------------------------- hunt unit shapes ----
# Simplified boundaries (about 200 m tolerance) so the phone can answer "which
# unit am I standing in" with no signal. Attribute diffs still come from the
# full-attribute pull above; this file is geometry only and is kept small.
try:
    base = S.ARCGIS["big_game_units"]["url"]
    feats, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"where": "1=1", "outFields": "Boundary_Name,BoundaryID",
                                    "returnGeometry": "true", "outSR": 4326, "f": "geojson",
                                    "maxAllowableOffset": 0.002, "geometryPrecision": 4,
                                    "resultOffset": offset, "resultRecordCount": 2000})
        gj = json.loads(get(base + "/query?" + q, timeout=180))
        batch = gj.get("features", [])
        feats.extend(batch)
        if len(batch) < 2000:
            break
        offset += len(batch)
    units = []
    for f in feats:
        g = f.get("geometry") or {}
        polys = [g["coordinates"]] if g.get("type") == "Polygon" else g.get("coordinates", [])
        if not polys:
            continue
        xs = [pt[0] for poly in polys for pt in poly[0]]
        ys = [pt[1] for poly in polys for pt in poly[0]]
        units.append({"n": f["properties"].get("Boundary_Name"),
                      "id": f["properties"].get("BoundaryID"),
                      "bb": [min(xs), min(ys), max(xs), max(ys)], "p": polys})
    if len(units) >= 100:                 # never overwrite a good file with a partial pull
        save("units_geo.json", {"checked": report["run"], "tolerance_m": 200, "units": units})
        report["ok"].append({"source": "units_geo", "features": len(units)})
    else:
        report["errors"].append({"source": "units_geo", "error": f"only {len(units)} units returned"})
except Exception as e:                    # noqa: BLE001
    report["errors"].append({"source": "units_geo", "error": repr(e)[:200]})

# ------------------------------------------------------------------ UDOT ----
# Road cameras, weather stations, road conditions and mountain passes, so the app
# can show what the drive looks like between home and the hunt. Every UDOT
# endpoint requires a developer key on the query string. With no key set this
# writes a file that says so rather than failing the run, and the app shows the
# feature as not set up instead of breaking.
UDOT_KEY = os.environ.get("UDOT_API_KEY", "").strip()


def udot_num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if -180 <= f <= 180 and f != 0 else None


def udot_rows(kind, raw):
    """Flatten one endpoint into {id,name,lat,lon,road,dir,views} we can map."""
    out = []
    for r in raw if isinstance(raw, list) else []:
        lat = udot_num(r.get("Latitude"))
        lon = udot_num(r.get("Longitude"))
        if lat is None or lon is None:
            continue
        views = []
        for v in (r.get("Views") or []):
            u = (v.get("Url") or "").strip()
            if u and (v.get("Status") or "Enabled").lower() != "disabled":
                views.append(u)
        out.append({"k": kind,
                    "id": str(r.get("Id") or r.get("SourceId") or len(out)),
                    "n": (r.get("Location") or r.get("StationName") or r.get("RoadwayName")
                          or r.get("Description") or "").strip()[:120],
                    "lat": round(lat, 5), "lon": round(lon, 5),
                    "road": (r.get("Roadway") or r.get("RoadwayName") or "").strip()[:40],
                    "dir": (r.get("Direction") or "").strip()[:12],
                    "v": views[:2]})
    return out


try:
    if not UDOT_KEY:
        save("udot.json", {"key": False, "checked": report["run"],
                           "note": "No UDOT_API_KEY is set in the workflow, so no road data was pulled.",
                           "cameras": [], "weather": [], "conditions": [], "passes": []})
        report["ok"].append({"source": "udot", "features": 0, "note": "no key set"})
    else:
        got, errs = {}, []
        names = {"cameras": "cameras", "weatherstations": "weather",
                 "roadconditions": "conditions", "mountainpasses": "passes"}
        for ep in S.UDOT_ENDPOINTS:
            try:
                raw = json.loads(get(f"{S.UDOT_API}/{ep}?format=json&key={UDOT_KEY}"))
                got[names[ep]] = udot_rows(names[ep], raw)
            except Exception as e:                    # noqa: BLE001
                errs.append(f"{ep}: {repr(e)[:80]}")
                got[names[ep]] = []
            time.sleep(7)                               # ten calls per 60 seconds
        total = sum(len(v) for v in got.values())
        if total:
            out = {"key": True, "checked": report["run"],
                   "source": S.UDOT_API,
                   "note": "UDOT Traffic API. Camera images need a signal; the locations work offline.",
                   **got}
            save("udot.json", out)
            report["ok"].append({"source": "udot", "features": total})
        else:
            report["errors"].append({"source": "udot",
                                     "error": "key set but every endpoint returned nothing: " + "; ".join(errs)})
        for e in errs:
            report["errors"].append({"source": "udot", "error": e})
except Exception as e:                                # noqa: BLE001
    report["errors"].append({"source": "udot", "error": repr(e)[:200]})

# ---------------------------------------------------------------- report ----
log = load_prev("changelog.json") or {"runs": []}
log["runs"].insert(0, report)
log["runs"] = log["runs"][:60]
save("changelog.json", log)

print(f"changes={len(report['changes'])} ok={len(report['ok'])} errors={len(report['errors'])}")
for c in report["changes"]:
    print("  CHANGED:", c["source"], "-", c.get("desc", ""))
for e in report["errors"]:
    print("  ERROR:  ", e["source"], "-", e["error"][:120])
