#!/usr/bin/env python3
"""Bake drive times from the anchor towns into docs/data/ut/bird_access.json.

Every access point that carries a drive time gets, for each anchor town in docs/data/ut/config.json:
    "drive": {"<anchor id>": {"min": whole minutes, "mi": road miles, "reliable": true or false, "range": null or [low, high]}}
The road figures come from OSRM's public router, asked the way the fishing bake asks (the call and its manners
live in scraper/build_fishing_places.py: at most 100 coordinates a request, one request every 1.5 s, and a
refusal backs off and halves the chunk). Nothing else in a point changes.

A point whose "drive" is empty stays empty: the southern WMA points have no usable road figure, and the app shows
straight-line miles for them. Pass --all to bake every point.

A marsh or a range is a centroid, not a place a car stops, so its road time can be far longer than the miles
suggest. A point marked "centroid": true in the file (by hand, in the data) gets a range when that happens. Its
"low" is the time the same road miles take at 45 mph, from OSRM's own mileage before it is rounded to a tenth;
when the road time is 1.5 times "low" or more the point is "reliable": false with "range": [low, min], which the
app shows as "low-min min *". Every other time on a centroid point, and every time on any other point, is
"reliable": true with "range": null. "snap_mi" is left as it is; a difference is counted in a note.

Run by hand when the anchors in config.json change or a point moves; not part of the daily job:
    python3 scraper/build_bird_drive.py           # the points that carry a drive time today
    python3 scraper/build_bird_drive.py --all     # every point
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_fishing_places as fp

OUT = os.path.join(fp.DATA, "bird_access.json")
SLOW_MPH = 45                                 # speed the "low" end of a range assumes
WORSE = 1.5                                   # road time this many times "low" or more makes a centroid a range


def drive_of(point, r, anchors):
    """The "drive" of one point from one osrm_bake answer: a figure for each anchor that routed."""
    d = {}
    for a in anchors:
        if a[0] not in r["to"]:
            continue
        sec, metres = r["to"][a[0]]
        minutes = int(round(sec / 60))
        low = int(round(metres / 1609.34 * 60 / SLOW_MPH))
        wide = bool(point.get("centroid")) and minutes >= WORSE * low
        d[a[0]] = {"min": minutes, "mi": round(metres / 1609.34, 1),
                   "reliable": not wide, "range": [low, minutes] if wide else None}
    return d


def main():
    args = sys.argv[1:]
    anchors = fp.anchors_of(json.load(open(os.path.join(fp.DATA, "config.json"))))
    ids = [a[0] for a in anchors]
    points = json.load(open(OUT))
    todo = [p for p in points if p.get("drive") or "--all" in args]
    try:
        got = fp.osrm_bake(anchors, [(p["lat"], p["lon"]) for p in todo])
    except RuntimeError as e:
        print("  FAIL:", e)
        print("NOT WRITTEN: %s is unchanged." % OUT)
        return 1
    snap_differs = unanswered = 0
    for p, r in zip(todo, got):
        if r is None:                         # its chunk was never answered: keep what it had, anchor by anchor
            unanswered += 1
            p["drive"] = {k: p["drive"][k] for k in ids if k in p["drive"]}
            continue
        p["drive"] = drive_of(p, r, anchors)
        snap_differs += p.get("snap_mi") is None or abs(round(r["snap"] / 1609.34, 2) - p["snap_mi"]) > 1e-9
        for k in ids:
            if k not in p["drive"]:
                fp.note("no drive time from %s to %s (%s)" % (k, p["name"], p["id"]))
    if snap_differs:
        fp.note("OSRM's distance to the nearest road differs from snap_mi for %d points; snap_mi is kept" % snap_differs)
    if unanswered:
        fp.note("%d points were not answered and keep their old drive times" % unanswered)
    for n in fp.NOTE:
        print("  note:", n)
    full = sum(1 for p in todo if all(k in p["drive"] for k in ids))
    wide = sum(1 for p in todo for v in p["drive"].values() if not v["reliable"])
    print("  points=%d; baked %d; with all %d anchors: %d; ranges: %d; left without a drive time: %d"
          % (len(points), len(todo), len(ids), full, wide, len(points) - len(todo)))
    json.dump(points, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote %s: %d KB" % (OUT, os.path.getsize(OUT) // 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
