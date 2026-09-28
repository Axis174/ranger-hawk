#!/usr/bin/env python3
"""Generate hunt.ics - the calendar feed the iPhone subscribes to.

Emits three kinds of entry:
  * All-day spans for each season (so you can see what's open at a glance).
  * Timed VALARM reminders ahead of every deadline, at each lead time.
  * Landowner-call tasks as dated events with the phone context in the body.

Subscribed once in iOS Settings > Calendar > Accounts > Add Subscribed Calendar,
it refreshes itself. No push server, no app permissions, and it keeps working
whether or not the app is ever opened.
"""
import json, os
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
OUT = os.path.join(ROOT, "docs", "hunt.ics")

S = json.load(open(os.path.join(DATA, "seasons.json")))
C = json.load(open(os.path.join(DATA, "config.json")))
STAMP = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def esc(t):
    return (str(t).replace("\\", "\\\\").replace(";", r"\;")
            .replace(",", r"\,").replace("\n", r"\n"))


def fold(line):
    """RFC 5545 caps lines at 75 octets."""
    b = line.encode("utf-8")
    if len(b) <= 73:
        return line
    out, cur = [], b""
    for ch in line:
        e = ch.encode("utf-8")
        if len(cur) + len(e) > 73:
            out.append(cur.decode("utf-8")); cur = b" "
        cur += e
    out.append(cur.decode("utf-8"))
    return "\r\n".join(out)


L = ["BEGIN:VCALENDAR", "VERSION:2.0",
     "PRODID:-//ranger-hawk//Pete Busch//EN",
     "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
     "X-WR-CALNAME:Ranger Hawk",
     "X-WR-CALDESC:Seasons, permit deadlines, access contacts and fishing dates for Utah",
     "X-PUBLISHED-TTL:PT12H", "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
     # Timed entries (a stream that opens at 6 a.m.) are in Utah's time wherever the
     # phone is. Mountain time: clocks go forward the second Sunday of March and back
     # the first Sunday of November.
     "BEGIN:VTIMEZONE", "TZID:America/Denver",
     "BEGIN:DAYLIGHT", "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
     "TZOFFSETFROM:-0700", "TZOFFSETTO:-0600", "TZNAME:MDT", "END:DAYLIGHT",
     "BEGIN:STANDARD", "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
     "TZOFFSETFROM:-0600", "TZOFFSETTO:-0700", "TZNAME:MST", "END:STANDARD",
     "END:VTIMEZONE"]


def ev(uid, start, end, summary, desc, alarms=(), allday=True, cat="SEASON"):
    L.append("BEGIN:VEVENT")
    L.append(f"UID:{uid}@utah-hunt-atlas")
    L.append(f"DTSTAMP:{STAMP}")
    if allday:
        L.append("DTSTART;VALUE=DATE:" + start.strftime("%Y%m%d"))
        L.append("DTEND;VALUE=DATE:" + (end + timedelta(days=1)).strftime("%Y%m%d"))
    else:
        L.append("DTSTART;TZID=America/Denver:" + start.strftime("%Y%m%dT%H%M%S"))
        L.append("DTEND;TZID=America/Denver:" + end.strftime("%Y%m%dT%H%M%S"))
    L.append(fold("SUMMARY:" + esc(summary)))
    L.append(fold("DESCRIPTION:" + esc(desc)))
    L.append(f"CATEGORIES:{cat}")
    L.append("TRANSP:TRANSPARENT")
    for days, label in alarms:
        L.append("BEGIN:VALARM")
        L.append("ACTION:DISPLAY")
        L.append(fold("DESCRIPTION:" + esc(label)))
        L.append(f"TRIGGER:-P{days}D" if days else "TRIGGER:-PT9H")
        L.append("END:VALARM")
    L.append("END:VEVENT")


GROUP = {"bird": "Bird", "deer": "Deer", "elk": "Elk", "turkey": "Turkey"}

# ---- season spans -----------------------------------------------------------
for s in S["seasons"]:
    a = date.fromisoformat(s["start"]); b = date.fromisoformat(s["end"])
    body = []
    if s.get("bag"):    body.append("Limit: " + s["bag"])
    if s.get("area"):   body.append("Area: " + s["area"])
    if s.get("permit"): body.append("Needs: " + s["permit"])
    if s.get("note"):   body.append("Note: " + s["note"])
    body.append("Source: " + S["_source"])
    ev(f"season-{s['id']}", a, b,
       f"{GROUP.get(s['group'], s['group']).upper()}: {s['name']}",
       "\n".join(body),
       alarms=[(3, f"{s['name']} opens in 3 days")],
       cat="SEASON")

# ---- deadlines --------------------------------------------------------------
KIND = {"application": "APPLY", "permit": "PERMIT", "closure": "CLOSES",
        "task": "TO DO", "season-close": "LAST DAY", "reporting": "REPORT"}
for d in S["deadlines"]:
    day = date.fromisoformat(d["date"])
    alarms = [(n, f"{d['title']} - {n} day{'s' if n != 1 else ''} out") for n in d.get("lead_days", [7])]
    alarms.append((0, d["title"]))
    body = d["detail"]
    if d.get("projected"):
        body = ("PROJECTED DATE - not yet confirmed by UDWR. The refresh job watches "
                "for the official announcement and will correct this.\n\n") + body
    ev(f"deadline-{d['id']}", day, day,
       f"[{KIND.get(d['kind'], 'NOTE')}] {d['title']}", body,
       alarms=alarms, cat="DEADLINE")

# ---- landowner calls --------------------------------------------------------
for i, w in enumerate(C.get("wia_landowner_calls", [])):
    day = date(2026, 10, 12) + timedelta(days=i)
    ev(f"wia-call-{i}", day, day,
       f"[CALL] {w['property']} WIA landowner",
       (f"{w['property']} - {w['county']} County, {w['acres']} acres.\n"
        f"{w['requirement']}\n{w.get('contact','')}\n"
        f"Coordinates: {w['lat']}, {w['lon']}\n\n"
        "Call before the Nov 7 pheasant opener - these take a week of phone tag in season."),
       alarms=[(7, f"Call {w['property']} landowner next week"), (0, f"Call {w['property']} landowner today")],
       cat="TASK")

# ---- DWR calls that are still open questions --------------------------------
for i, c in enumerate([c for c in C["contacts"] if c.get("priority") == "high"]):
    day = date(2026, 9, 28) + timedelta(days=i)
    ev(f"dwr-call-{i}", day, day, f"[CALL] {c['name']} - {c['phone']}",
       f"{c['why']}\n\nPhone: {c['phone']}",
       alarms=[(2, f"Call {c['name']}"), (0, f"Call {c['name']} today")], cat="TASK")

# ---- fishing ----------------------------------------------------------------
# Read from docs/data/fishing_rules.json, which scraper/build_fishing.py builds
# from the guidebook. Nothing here is typed in by hand, so the calendar cannot
# disagree with the rules the app shows. Four kinds of entry:
#   * the last day of each emergency change (grouped by day)
#   * the statewide kokanee closure
#   * the day the guidebook year ends
#   * waters within reach of a home that open or close on a date
FISH = os.path.join(DATA, "fishing_rules.json")
PLACES = os.path.join(DATA, "fishing_places.json")
REACH_MI = 75


def f_point(pt, year, end=False):
    """The same reading of a date as docs/fishing.js: "MM-DD", or the nth Saturday
    of a month (n = -1 for the last), at hour h, d days later."""
    if isinstance(pt, str):
        m, d = (int(x) for x in pt.split("-"))
        return datetime(year, m, d, 23 if end else 0, 59 if end else 0)
    m = pt["m"]
    if pt["n"] > 0:
        first = date(year, m, 1).weekday()                  # Monday is 0, Saturday is 5
        day = 1 + (5 - first) % 7 + 7 * (pt["n"] - 1)
        d0_ = date(year, m, day)
    else:
        last = date(year + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
        d0_ = last - timedelta(days=(last.weekday() - 5) % 7)
    d0_ += timedelta(days=pt.get("d", 0))
    if "h" in pt:
        return datetime(d0_.year, d0_.month, d0_.day, pt["h"], 0)
    return datetime(d0_.year, d0_.month, d0_.day, 23 if end else 0, 59 if end else 0)


def f_miles(a, b, c, d):
    from math import asin, cos, radians, sin, sqrt
    h = sin(radians(c - a) / 2) ** 2 + cos(radians(a)) * cos(radians(c)) * sin(radians(d - b) / 2) ** 2
    return 3958.8 * 2 * asin(sqrt(h))


if os.path.exists(FISH):
    F = json.load(open(FISH))
    yr = F["_edition"]["year"]
    src = ("Source: Utah Division of Wildlife Resources, %d Utah Fishing Guidebook and its posted emergency "
           "changes. Not legal advice." % yr)

    ends = {}
    for a in F.get("amendments", []):
        ends.setdefault(a["last_day"], []).append(a)
    for day, items in sorted(ends.items()):
        d = date.fromisoformat(day)
        names = ", ".join(a["name"] for a in items)
        body = ["UDWR's emergency change%s for %s end%s." % ("s" if len(items) > 1 else "", names, "" if len(items) > 1 else "s"),
                "UDWR's wording is 'will remain in effect until %s'. The app treats %s as the last day, to stay on "
                "the safe side. From the next day the guidebook rule is back." % (
                    date.fromisoformat(items[0]["until"]).strftime("%b. %-d, %Y"), d.strftime("%b. %-d"))]
        for a in items:
            body.append("%s (%s County): %s" % (a["name"], a["county"], "; ".join(r["text"] for r in a["rules"])))
        body.append(src)
        ev("fish-change-%s" % day, d, d,
           "[FISH] Last day: %d emergency change%s" % (len(items), "s" if len(items) > 1 else ""),
           "\n".join(body),
           alarms=[(3, "Emergency fishing changes end in 3 days: " + names), (0, "Emergency fishing changes end today: " + names)],
           cat="FISHING")

    # A change that SHUTS a water is a closure like any other, whether or not the
    # water is near a home: it is rare, and it is the kind of thing a calendar is for.
    for a in F.get("amendments", []):
        shut = [fx for r in a["rules"] for fx in r["fx"] if fx.get("t") == "closed" and fx.get("scope") == "all"]
        if shut:
            a0, b0 = date.fromisoformat(a["from"]), date.fromisoformat(a["last_day"])
            ev("fish-shut-%s" % a["notice"][-40:], a0, b0, "FISH CLOSED by emergency change: %s" % a["name"],
               "%s (%s County): %s\nUDWR: in effect %s until %s.\n%s" % (a["name"], a["county"], "; ".join(r["text"] for r in a["rules"]),
                                                                      a["from"], a["until"], src),
               alarms=[(1, "Closed by emergency change from tomorrow: " + a["name"])], cat="FISHING")

    kok = next((r for r in F["statewide"]["rules"] if r["id"] == "kokanee"), None)
    if kok:
        w = kok["fx"][0]["w"][0]
        a, b = f_point(w[0], yr).date(), f_point(w[1], yr, True).date()
        ev("fish-kokanee-%d" % yr, a, b, "FISH: kokanee may not be kept (statewide)",
           kok["text"] + "\n" + src, alarms=[], cat="FISHING")

    last = date.fromisoformat(F["_edition"]["to"])
    ev("fish-edition-%d" % yr, last, last, "[FISH] Last day of the %d fishing rules" % yr,
       "The %d Utah Fishing Guidebook is in force through %s. The %d guidebook governs from Jan. 1, and the "
       "rules in the app must be rebuilt from it (scraper/build_fishing.py) before they can be relied on.\n%s"
       % (yr, last.strftime("%b. %-d, %Y"), yr + 1, src),
       alarms=[(30, "The %d fishing rules end in 30 days" % yr), (7, "The %d fishing rules end in a week" % yr)],
       cat="FISHING")

    # Waters near a home that open or close on a date. A place stands for the
    # stretches it is known to be on: all of them when nobody has said which, none
    # of them when it lies outside every stretch the guidebook lists.
    near = {}
    if os.path.exists(PLACES):
        PJ = json.load(open(PLACES))
        if PJ.get("_rules_shape") != F.get("_shape"):
            print("fishing places and rules are from different builds - no opening or closing dates written")
            PJ = {"places": []}
        for p in PJ["places"]:
            if p.get("r") == "none":
                continue
            for h in C["homes"]:
                if f_miles(h["lat"], h["lon"], p["lat"], p["lon"]) <= REACH_MI:
                    for wid in p.get("w", []):
                        for k in (p.get("r") or ["*"]):
                            near.setdefault(wid, {}).setdefault(k, set()).add(h["label"])
    def f_in(span, t):
        a, b = f_point(span[0], t.year), f_point(span[1], t.year, True)
        return (t >= a or t <= b) if b < a else (a <= t <= b)

    shut_by_change = {}
    for a in F.get("amendments", []):
        if any(fx.get("t") == "closed" and fx.get("scope") == "all" for r in a["rules"] for fx in r["fx"]):
            shut_by_change.setdefault(a.get("water") or "community:" + a.get("community", ""), []).append(
                (date.fromisoformat(a["from"]), date.fromisoformat(a["last_day"])))

    def f_closed(rules, t, wid=None):
        """Closed to all fishing at this moment, by any rule of the stretch. A rule
        that says the water is open only between two dates closes it outside them.
        An emergency change that shuts the water shuts every stretch of it."""
        if any(a0 <= t.date() <= b0 for a0, b0 in shut_by_change.get(wid, [])):
            return True
        for ru in rules:
            for fx in ru["fx"]:
                if fx.get("t") == "closed" and fx.get("scope") == "all":
                    if not fx.get("w") or any(f_in(x, t) for x in fx["w"]):
                        return True
                if fx.get("open") and not any(f_in(x, t) for x in fx["open"]):
                    return True
        return False

    # An entry for the streams running into a lake has no position of its own, so
    # it is measured from the lake it is named for.
    import re as _re
    by_name = {}
    for wtr in F["waters"]:
        by_name.setdefault(wtr["name"].lower(), []).append(wtr)
    for wtr in F["waters"]:
        if wtr["id"] in near:
            continue
        parent = _re.sub(r"(,? tributar(y|ies)( and spillway)?| inflow| inlet| and its tributaries)$", "", wtr["name"], flags=_re.I).lower()
        for cand in by_name.get(parent, []):
            if cand["id"] in near and set(cand["counties"]) & set(wtr["counties"]):
                near[wtr["id"]] = {"*": set().union(*near[cand["id"]].values())}

    turns = {}
    for wtr in F["waters"]:
        if wtr["id"] not in near:
            continue
        for r in wtr.get("reaches", []):
            homes_ = near[wtr["id"]].get("*", set()) | near[wtr["id"]].get(r.get("key"), set())
            if not homes_:
                continue
            label = wtr["name"] + (" (%s)" % r["key"] if r.get("key") else "")
            edges = set()
            for ru in r.get("rules", []):
                for fx in ru["fx"]:
                    spans = fx.get("open") or (fx.get("w") if fx.get("t") == "closed" and fx.get("scope") == "all" else None)
                    for span in spans or []:
                        edges.add(f_point(span[0], yr))
                        e = f_point(span[1], yr, True)
                        # "through Oct. 31" ends with the day; the change comes with the next one
                        edges.add(e if "h" in (span[1] if isinstance(span[1], dict) else {}) else
                                  datetime(e.year, e.month, e.day) + timedelta(days=1))
            for t in sorted(edges):
                if t.year != yr or (t.month, t.day) == (1, 1):
                    continue
                before, after = f_closed(r.get("rules", []), t - timedelta(minutes=2), wtr["id"]), f_closed(r.get("rules", []), t + timedelta(minutes=2), wtr["id"])
                if before == after:
                    continue                  # another rule keeps it shut, or open, across this date
                why = "; ".join(ru["text"] for ru in r.get("rules", []) if any(fx.get("open") or (fx.get("t") == "closed" and fx.get("w")) for fx in ru["fx"]))
                turns.setdefault(("opens" if before else "closes", t), []).append((label, why, sorted(homes_)))
    # A community water the guidebook closes by name, in a note under the list.
    members = {m["id"]: m for m in F["community"]["members"]}
    for nt in F["community"].get("notes", []):
        for mid in nt.get("members", []):
            homes_ = set().union(*near.get("community:" + mid, {}).values()) if near.get("community:" + mid) else set()
            if not homes_ or mid not in members:
                continue
            edges = set()
            for fx in nt["fx"]:
                spans = fx.get("open") or (fx.get("w") if fx.get("t") == "closed" and fx.get("scope") == "all" else None)
                for span in spans or []:
                    edges.add(f_point(span[0], yr))
                    e = f_point(span[1], yr, True)
                    edges.add(e if "h" in (span[1] if isinstance(span[1], dict) else {}) else
                              datetime(e.year, e.month, e.day) + timedelta(days=1))
            for t in sorted(edges):
                if t.year != yr or (t.month, t.day) == (1, 1):
                    continue
                before, after = f_closed([nt], t - timedelta(minutes=2)), f_closed([nt], t + timedelta(minutes=2))
                if before != after:
                    turns.setdefault(("opens" if before else "closes", t), []).append((members[mid]["name"], nt["text"], sorted(homes_)))
    for (what, when), items in sorted(turns.items(), key=lambda kv: kv[0][1]):
        names = sorted(set(i[0] for i in items))
        body = ["Within %d miles of a home, in a straight line:" % REACH_MI]
        body += ["%s - %s (near %s)" % (i[0], i[1], ", ".join(i[2])) for i in sorted(set((i[0], i[1], tuple(i[2])) for i in items))]
        body.append(src)
        timed = when.hour == 6
        title = "FISH %s%s: %s" % (what, " 6 a.m." if timed else "", ", ".join(names[:4]) + (" and %d more" % (len(names) - 4) if len(names) > 4 else ""))
        if timed:
            ev("fish-%s-%s" % (what, when.strftime("%Y%m%d")), when, when + timedelta(hours=1), title, "\n".join(body),
               alarms=[(3, title)], allday=False, cat="FISHING")
        else:
            ev("fish-%s-%s" % (what, when.strftime("%Y%m%d")), when.date(), when.date(), title, "\n".join(body),
               alarms=[(3, title)], cat="FISHING")

L.append("END:VCALENDAR")
open(OUT, "w", newline="").write("\r\n".join(L) + "\r\n")

n = sum(1 for x in L if x == "BEGIN:VEVENT")
print(f"wrote {OUT} - {n} events, {os.path.getsize(OUT)} bytes")
