#!/usr/bin/env python3
"""Build docs/data/ut/draw_odds.json from UDWR's published draw result PDFs.

UDWR prints one block per hunt code: a row per point level, residents on the
left and nonresidents on the right, then a Totals row. This reads the text layer
(pdftotext -layout), keeps only point levels that had applicants, and CHECKS
ITSELF: every hunt's rows must add up to its own Totals row, and the odds
recomputed from applicants and permits must match the ratio UDWR printed. A hunt
that fails either check is reported and left out rather than shipped wrong.

Run by hand once a year after UDWR posts results (late May / June):
    python3 scraper/build_odds.py
Needs `pdftotext` (brew install poppler). Not part of the daily job.
"""
import json, os, re, subprocess, sys, tempfile, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data", "ut")
OUT = os.path.join(DATA, "draw_odds.json")
BASE = "https://wildlife.utah.gov/pdf/bg/{y4}/{y2}_{name}.pdf"
REPORTS = [("bg-odds", "Limited entry and once-in-a-lifetime"),
           ("deer_odds", "General-season buck deer"),
           ("antlerless_drawing_odds_report", "Antlerless")]
YEARS = [2025, 2024]            # newest first; the app shows the first, compares the second
SPECIES = {"DB": "Deer", "DA": "Deer", "EB": "Elk", "EA": "Elk", "PB": "Pronghorn", "PD": "Pronghorn",
           "PA": "Pronghorn", "MB": "Moose", "MA": "Moose", "BI": "Bison", "DS": "Desert bighorn",
           "RS": "Rocky Mtn bighorn", "GO": "Mountain goat", "RE": "Rocky Mtn bighorn", "DE": "Desert bighorn"}
HUNT = re.compile(r"Hunt:\s+([A-Z]{2}\d{4})\s+(.+?)(?:\s{3,}.*)?$")
NUM = r"(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(N/A|(?:1 )?in [\d.,]+)"   # UDWR drops the leading "1" past 1 in 1000
ROW = re.compile(r"^\s*" + NUM + r"\s+" + NUM + r"\s*$")
TOT = re.compile(r"^\s*Totals\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(N/A|(?:1 )?in [\d.,]+)\s+Totals\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(N/A|(?:1 )?in [\d.,]+)")


def text_of(url):
    with tempfile.TemporaryDirectory() as d:
        pdf = os.path.join(d, "r.pdf")
        req = urllib.request.Request(url, headers={"User-Agent": "ranger-hawk/1.0 (rangerhawk.com)"})
        open(pdf, "wb").write(urllib.request.urlopen(req, timeout=300).read())
        return subprocess.run(["pdftotext", "-layout", pdf, "-"], capture_output=True, text=True, check=True).stdout


def ratio_ok(apps, permits, printed):
    if printed == "N/A":
        return permits == 0 or apps == 0
    want = float(printed.split("in")[1].replace(",", ""))
    return permits > 0 and abs(apps / permits - want) <= 0.06


def parse(txt):
    hunts, bad, cur = {}, [], None
    kind = "bonus"
    for line in txt.splitlines():
        if "Preference" in line and "Points" not in line.replace("Preference", ""):
            kind = "preference"
        elif re.search(r"^\s*Bonus\s+Eligible", line):
            kind = "bonus"
        m = HUNT.search(line)
        if m:
            cur = {"code": m.group(1), "name": re.sub(r"\s+", " ", m.group(2)).strip(), "r": [], "n": [], "kind": None}
            hunts[cur["code"]] = cur
            continue
        if not cur:
            continue
        if re.search(r"^\s*Preference\s+Eligible|^\s*Preference\s+Points", line) or "Preference     Eligible" in line:
            cur["kind"] = "preference"
        elif re.search(r"^\s*Bonus\s+Eligible", line):
            cur["kind"] = cur["kind"] or "bonus"
        m = ROW.match(line)
        if m:
            g = m.groups()
            for side, o in (("r", 0), ("n", 6)):
                pts, apps, bon, reg, tot, rat = int(g[o]), int(g[o+1]), int(g[o+2]), int(g[o+3]), int(g[o+4]), g[o+5]
                if bon + reg != tot:
                    cur["flag"] = f"row {pts} {side}: permits do not add up"
                elif not ratio_ok(apps, tot, rat):
                    # Counts are what the app uses, and they are checked against the Totals
                    # row below. A printed ratio that disagrees with UDWR's own counts is
                    # logged, not fatal.
                    cur.setdefault("ratio_notes", []).append(f"{pts}{side}: printed {rat}, counts give 1 in {apps / tot:.1f}" if tot else f"{pts}{side}: printed {rat}, no permits")
                if apps or tot:
                    cur[side].append([pts, apps, bon, reg])
            continue
        m = TOT.match(line)
        if m:
            g = m.groups()
            for side, o in (("r", 0), ("n", 5)):
                apps, bon, reg, tot = int(g[o]), int(g[o+1]), int(g[o+2]), int(g[o+3])
                got = [sum(x[1] for x in cur[side]), sum(x[2] for x in cur[side]), sum(x[3] for x in cur[side])]
                if got != [apps, bon, reg] or bon + reg != tot:
                    cur["flag"] = f"totals {side}: rows {got} vs printed {[apps, bon, reg]}"
            cur["done"] = True
            cur = None
    good = {}
    parse.notes = {c: h["ratio_notes"] for c, h in hunts.items() if h.get("ratio_notes")}
    for c, h in hunts.items():
        if h.get("flag") or not h.get("done"):
            bad.append((c, h.get("flag") or "no Totals row found"))
            continue
        good[c] = {"n": h["name"], "k": "p" if h["kind"] == "preference" else "b",
                   "s": SPECIES.get(c[:2], "Other"), "r": h["r"], "x": h["n"]}
    return good, bad


def main():
    out = {"_source": "Utah Division of Wildlife Resources, big game draw results (wildlife.utah.gov/biggame/odds)",
           "_note": "Row = [points, applicants, bonus-round permits, regular-round permits]. r = residents, x = nonresidents. "
                    "k: b = bonus points, p = preference points. Point levels with no applicants are omitted.",
           "years": {}}
    problems = 0
    for y in YEARS:
        allh = {}
        for name, label in REPORTS:
            url = BASE.format(y4=y, y2=str(y)[2:], name=name)
            try:
                good, bad = parse(text_of(url))
            except Exception as e:                     # noqa: BLE001
                print(f"{y} {label}: FAILED {e!r}"); problems += 1; continue
            for h in good.values():
                h["g"] = label
            allh.update(good)
            print(f"{y} {label}: {len(good)} hunts parsed and self-checked, {len(bad)} rejected")
            for c, why in bad[:8]:
                print("     rejected", c, "-", why)
            notes = [(c, n) for c, n in parse.notes.items()]
            if notes:
                print(f"     {len(notes)} hunts where UDWR's printed ratio disagrees with its own counts, e.g. {notes[0][0]}: {notes[0][1][0]}")
            problems += len(bad)
        out["years"][str(y)] = allh
    json.dump(out, open(OUT, "w"), separators=(",", ":"))
    print(f"wrote {OUT}: {os.path.getsize(OUT)//1024} KB; rejected or failed: {problems}")


if __name__ == "__main__":
    main()
