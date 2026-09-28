#!/usr/bin/env python3
"""Build docs/data/fishing_rules.json from UDWR's Utah Fishing Guidebook (PDF).

The guidebook is 173 named waters carrying 314 separate rules, layered over one
statewide table, and amended mid-year by signed emergency notices. Retyping that
by hand is how a limit ends up quietly wrong. So this does not retype it:

  * The WORDING of every rule is lifted from the PDF by position (pdftohtml -xml)
    and kept verbatim with its page number. The app shows UDWR's words.
  * A second, independent reading of the same pages (pdftotext -raw, which follows
    the PDF's content stream rather than positions) must contain every rule.
  * Every bullet printed in the section must be accounted for, in both directions.
  * Each rule is then SORTED - what it is about, which statewide limits it
    touches, which dates it covers - by strict whole-sentence patterns. A sentence
    no pattern fits is left unsorted; the app then shows the words with a caution
    and never assumes the statewide rule applies. Unsorted is a build failure until
    a person has read the sentence and recorded a reading in fishing/overrides.json.
  * Species named in a rule's wording must equal the species in its index.
  * The statewide table is read three ways (position, content order, and a
    hand-kept copy) and all three must agree.

It CHECKS ITSELF and writes nothing if any check fails.

Run by hand when UDWR reissues the guidebook (the daily job flags that, and the
app shows a banner on the phone):
    python3 scraper/build_fishing.py            # downloads the current PDF
    python3 scraper/build_fishing.py --pdf x.pdf
    python3 scraper/build_fishing.py --table    # also print how every rule was sorted
and again whenever a person has read a new emergency notice into
scraper/fishing/amendments.json.
Needs poppler (brew install poppler). Not part of the daily job, on purpose.
"""
import hashlib, html, json, os, re, subprocess, sys, tempfile, urllib.request
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
SRC = os.path.join(ROOT, "scraper", "fishing")
OUT = os.path.join(DATA, "fishing_rules.json")
UA = {"User-Agent": "ranger-hawk/1.0 (rangerhawk.com)"}

COUNTIES = ["Beaver", "Box Elder", "Cache", "Carbon", "Daggett", "Davis", "Duchesne", "Emery",
            "Garfield", "Grand", "Iron", "Juab", "Kane", "Millard", "Morgan", "Piute", "Rich",
            "Salt Lake", "San Juan", "Sanpete", "Sevier", "Summit", "Tooele", "Uintah", "Utah",
            "Wasatch", "Washington", "Wayne", "Weber"]
_C = "(?:" + "|".join(sorted(COUNTIES, key=len, reverse=True)) + ")"
COUNTY_LIST = re.compile(r"((?:%s(?:, and |, | and ))*%s) [Cc]ount(?:y|ies)\b\.?" % (_C, _C))

FAIL, WARN, NOTE = [], [], []
fail = FAIL.append
warn = WARN.append
note = NOTE.append


# ------------------------------------------------------------------ text ----
def plain(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s))


def squash(s):
    return re.sub(r"\s+", " ", s).strip()


def norm(s):
    """Letters and digits only. Two readings of the same sentence agree under this
    no matter how each one broke lines, spaced words or hyphenated."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


try:
    WORDS = set(w.strip().lower() for w in open("/usr/share/dict/words", encoding="utf-8", errors="ignore"))
except OSError:
    WORDS = set()
# Words the system dictionary lacks. Without these a line-break hyphen would be kept
# and the app would print "state-wide".
WORDS |= {"statewide", "tributaries", "headwaters", "upstream", "downstream", "cutthroat", "kokanee",
          "crappie", "campground", "catfish", "unlawful", "reservoir", "antimony", "emery", "community",
          "farmington", "confluence", "fishing", "considered", "combined", "immediately", "attached",
          "approximately", "structure", "identify", "extending", "counties", "motor", "unless"}
HYPHENS = []


def is_word(w):
    w = w.lower()
    if w in WORDS:
        return True
    for suf, rep in (("ies", "y"), ("es", ""), ("s", ""), ("ed", ""), ("ed", "e"), ("ing", ""), ("ing", "e"), ("ly", "")):
        if w.endswith(suf) and (w[:-len(suf)] + rep) in WORDS:
            return True
    return False


def join(a, b):
    """Join two printed lines of one paragraph, undoing line-break hyphenation."""
    a, b = a.rstrip(), b.lstrip()
    if not a:
        return b
    if not b:
        return a
    if a.endswith("—"):
        return a + b
    if a.endswith("/") and re.search(r"[a-z0-9-]+\.[a-z]{2,}/\S*$", a):
        return a + b                          # a web address broken over two lines
    if a.endswith("-"):
        left = re.split(r"[\s—(]", a[:-1])[-1]
        right = re.split(r"[\s,.;:)—]", b)[0]
        if b[:1].islower() and "-" not in left and "-" not in right and is_word(left + right):
            HYPHENS.append(("joined", left + right))
            return a[:-1] + b
        HYPHENS.append(("kept", left + "-" + right))
        return a + b
    return a + " " + b


# ------------------------------------------------------------------- pdf ----
def run(cmd):
    return subprocess.run(cmd, capture_output=True, check=True)


def fetch_pdf(path=None):
    if path:
        return open(path, "rb").read()
    req = urllib.request.Request(S.PDFS["fishing"], headers=UA)
    return urllib.request.urlopen(req, timeout=300).read()


class Book:
    def __init__(self, blob):
        self.blob = blob
        self.sha = hashlib.sha256(blob).hexdigest()[:16]      # same form the daily job stores
        self.dir = tempfile.mkdtemp(prefix="fishbook-")
        self.pdf = os.path.join(self.dir, "book.pdf")
        open(self.pdf, "wb").write(blob)
        info = run(["pdfinfo", self.pdf]).stdout.decode("utf-8", "ignore")
        self.info = dict((k.strip(), v.strip()) for k, v in (l.split(":", 1) for l in info.splitlines() if ":" in l))
        self.pages = int(self.info.get("Pages", "0"))
        self._raw, self._xml, self.fonts = {}, {}, {}

    def raw(self, n):
        if n not in self._raw:
            self._raw[n] = run(["pdftotext", "-raw", "-f", str(n), "-l", str(n), self.pdf, "-"]).stdout.decode("utf-8", "ignore")
        return self._raw[n]

    def runs(self, n):
        """Every text run on a page with its position and font."""
        if n not in self._xml:
            stem = os.path.join(self.dir, f"x{n}")
            run(["pdftohtml", "-xml", "-i", "-hidden", "-f", str(n), "-l", str(n), self.pdf, stem])
            t = open(stem + ".xml", encoding="utf-8", errors="ignore").read()
            fonts = {}
            for fid, size, fam, color in re.findall(r'<fontspec id="(\d+)" size="(\d+)" family="([^"]+)" color="([^"]+)"/>', t):
                fonts[fid] = {"size": int(size), "fam": fam.split("+")[-1], "color": color.lower()}
            self.fonts.update(fonts)
            out = []
            for top, left, w, h, f, c in re.findall(r'<text top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)" font="(\d+)">(.*?)</text>', t, re.S):
                if int(w) == 0:                                  # rotated margin text
                    continue
                c = re.sub(r"</?a[^>]*>", "", c)
                if not plain(c).strip():
                    continue
                out.append({"top": int(top), "left": int(left), "w": int(w), "font": self.fonts[f], "txt": plain(c),
                            "bold": "Black" in self.fonts[f]["fam"]})
            self._xml[n] = out
        return self._xml[n]


def line_text(runs):
    """Runs on one printed line, left to right. The PDF often omits the space
    between two runs and relies on the gap, so a gap becomes a space."""
    out, end = "", None
    for r in runs:
        if end is not None and r["left"] - end > 1 and not out.endswith((" ", "—")) and not r["txt"].startswith(" "):
            out += " "
        out += r["txt"]
        end = r["left"] + r["w"]
    return out


def lines_of(book, n, bases, top_min=30, top_max=843):
    """Printed lines of one page, column by column, top to bottom."""
    runs = [r for r in book.runs(n) if top_min <= r["top"] <= top_max]
    out = []
    bounds = list(bases) + [10 ** 6]
    for col, base in enumerate(bases):
        rs = sorted([r for r in runs if base - 8 <= r["left"] < bounds[col + 1] - 8], key=lambda r: (r["top"], r["left"]))
        lines = []
        for r in rs:
            if lines and abs(r["top"] - lines[-1]["top"]) <= 3:
                lines[-1]["runs"].append(r)
            else:
                lines.append({"pg": n, "col": col, "top": r["top"], "runs": [r]})
        for ln in lines:
            ln["runs"].sort(key=lambda r: r["left"])
            ln["x"] = ln["runs"][0]["left"] - base
            ln["text"] = line_text(ln["runs"])
            ln["size"] = ln["runs"][0]["font"]["size"]
            ln["boldstart"] = ln["runs"][0]["bold"]
            ln["blue"] = any(r["bold"] and r["font"]["color"] == "#28498a" for r in ln["runs"])
        out.extend(lines)
    return out


# ---------------------------------------------------- finding the section ----
def find_section(book):
    """Pages of 'Rules for specific waters', and the community-waters box inside it."""
    first = last = box = None
    for n in range(1, book.pages + 1):
        t = norm(book.raw(n))
        if first is None and "rulesforspecificwaters" in t and "takeprecedenceoverthegeneralrules" in t:
            first = n
        if first and "communityfishing" in t and "thefollowingrulesapplytoallthe" in t:
            box = n
        if first and re.search(r"(?m)^\s*(?:\d+\s+)?[A-Z][a-z][–-][A-Z][a-z]\s*$", book.raw(n)):
            last = n
    if not (first and last and box):
        fail(f"could not find the section: first={first} last={last} community box={box}")
    return first, last, box


# ------------------------------------------------------ the water entries ----
def parse_heading(text):
    """'Provo River, Summit, Utah and Wasatch counties' -> name, counties, rest."""
    text = squash(text)
    m = COUNTY_LIST.search(text)
    if not m:
        return None
    name = text[:m.start()].rstrip(" ,").strip()
    counties = [c.strip() for c in re.split(r", and |, | and ", m.group(1)) if c.strip()]
    return name, counties, text[m.end():].strip()


def parse_waters(book, first, last, box):
    lines = []
    for n in range(first, last + 1):
        if n == box:
            continue
        lines.extend(lines_of(book, n, (81, 320) if n % 2 == 0 else (27, 266)))
    entries, cur, reach, rule = [], None, None, None
    mode, inbox = "idle", False

    def new_reach(key=None, where=""):
        nonlocal reach, rule
        reach = {"key": key, "where": where, "rules": []}
        cur["reaches"].append(reach)
        rule = None

    for ln in lines:
        txt = ln["text"]
        if ln["size"] >= 20:                                  # the section title
            continue
        if ln["size"] == 18 and ln["boldstart"]:              # an inset box ("Rules for spearfishing")
            inbox = True
            continue
        if ln["size"] != 15:                                  # intro paragraphs and citations
            continue
        bullet = txt.lstrip().startswith("•")
        head = ln["boldstart"] and ln["x"] <= 20 and not bullet
        if inbox and not head:
            continue
        if head and mode == "head" and not COUNTY_LIST.search(cur["_head"]):
            cur["_head"] = join(cur["_head"], txt)            # the name wrapped onto a second line
            continue
        if head:
            inbox = False
            cur = {"_head": txt.strip(), "page": ln["pg"], "br": ln["blue"], "desc": "", "reaches": []}
            entries.append(cur)
            reach = rule = None
            mode = "head"
            continue
        if cur is None:
            continue
        if mode == "head" and not COUNTY_LIST.search(cur["_head"]) and not bullet:
            cur["_head"] = join(cur["_head"], txt)
            continue
        if mode == "head":
            mode = "desc"
        if bullet:
            if reach is None:
                new_reach()
            rule = {"text": re.sub(r"^\s*•\s*", "", txt).strip(), "page": ln["pg"]}
            lead = reach.get("_lead")
            (lead["items"] if lead is not None else reach["rules"]).append(rule)
            mode = "bullets"
            continue
        if ln["x"] >= 22 and rule is not None and mode == "bullets":
            rule["text"] = join(rule["text"], txt)
            continue
        m = re.match(r"\s*\(([a-z])\)\s*(.*)", txt)
        if m and ln["x"] < 8:
            new_reach(m.group(1), m.group(2).strip())
            mode = "reach"
            continue
        if mode == "reach":
            reach["where"] = join(reach["where"], txt)
            continue
        if mode == "desc":
            cur["desc"] = join(cur["desc"], txt)
            continue
        if mode == "bullets":
            # A paragraph after bullets is a lead-in that owns the bullets following it
            # (Lake Powell: "Archery ... prohibited within all of the following areas:").
            lead = reach.get("_lead")
            if lead is not None and not lead["items"]:
                lead["text"] = join(lead["text"], txt)
            else:
                lead = {"text": txt.strip(), "page": ln["pg"], "items": []}
                reach["rules"].append(lead)
                reach["_lead"] = lead
            rule = None

    out = []
    for e in entries:
        h = parse_heading(e.pop("_head"))
        if not h:
            fail(f"page {e['page']}: a heading with no county could not be read")
            continue
        e["name"], e["counties"], rest = h
        e["desc"] = squash((rest + " " + e["desc"]) if rest else e["desc"])
        for r in e["reaches"]:
            r.pop("_lead", None)
            r["where"] = squash(r["where"])
            for ru in r["rules"]:
                ru["text"] = squash(ru["text"])
                for it in ru.get("items", []):
                    it["text"] = squash(it["text"])
                if "items" in ru:
                    ru["item_pages"] = [it["page"] for it in ru["items"]]
                    ru["items"] = [it["text"] for it in ru["items"]]
        out.append(e)
    return out


# ------------------------------------------------ community fishing waters ----
def parse_community(book, n):
    lines = lines_of(book, n, (41, 267))
    rules, cur, blocks, intro, block = [], None, [], [], None
    for ln in lines:
        t = ln["text"]
        if ln["size"] >= 18:
            continue
        if ln["col"] == 0 and t.lstrip().startswith("•") and not blocks:
            cur = {"text": re.sub(r"^\s*•\s*", "", t).strip(), "page": n}
            rules.append(cur)
            continue
        m = re.match(r"\s*(%s) County:\s*(.*)" % _C, t)
        if m and ln["boldstart"]:
            block = {"county": m.group(1), "text": m.group(2)}
            blocks.append(block)
            cur = None
            continue
        if block is not None:
            if re.match(r"\s*See\s+wildlife\.utah\.gov/cf", t):
                block = None
                continue
            block["text"] = join(block["text"], t)
        elif cur is not None:
            cur["text"] = join(cur["text"], t)
        else:
            intro.append(t)
    members, notes = [], []
    for b in blocks:
        txt = squash(b["text"])
        m = re.search(r"\(\s*Note:\s*(.*?)\)\s*$", txt)
        if m:
            notes.append({"county": b["county"], "text": squash(m.group(1)), "page": n})
            txt = txt[:m.start()].strip()
        txt = txt.rstrip(". ")
        # split on commas and the final "and", but not inside parentheses
        parts, depth, buf = [], 0, ""
        toks = re.split(r"(\(|\)|, | and )", txt)
        for tk in toks:
            if tk == "(":
                depth += 1
            elif tk == ")":
                depth -= 1
            if tk in (", ", " and ") and depth == 0:
                parts.append(buf)
                buf = ""
            else:
                buf += tk
        parts.append(buf)
        for p in parts:
            p = squash(p)
            if not p:
                continue
            aka = re.search(r"\s*\((.+)\)\s*$", p)
            nm = p[:aka.start()].strip() if aka else p
            also = re.sub(r"^formerly called\s+", "", aka.group(1).strip()) if aka else None
            if also and not re.search(r"\b(Pond|Ponds|Lake|Reservoir|Fishery)\b", also):
                also = None                   # "(Upper and Lower)" describes the ponds; it is not another name
            members.append({"name": nm, "county": b["county"], "also": also, "as_printed": p})
    for r in rules:
        r["text"] = squash(r["text"])
    return {"rules": rules, "members": members, "notes": notes, "page": n,
            "intro": squash(" ".join(intro))}


# ------------------------------------------------ underwater spearfishing ----
def find_spear(book):
    first = None
    for n in range(1, book.pages + 1):
        t = norm(book.raw(n))
        if "underwaterspearfishing" in t and "waterbodiesopentospearfishing" in t:
            first = n
            break
    if first is None:
        fail("could not find the underwater spearfishing section")
        return None, None
    last = first
    for n in range(first + 1, min(first + 4, book.pages) + 1):
        t = norm(book.raw(n))
        if "spearfishing" in t and re.search(r"(?m)^\s*\u2022", book.raw(n)):
            last = n
    return first, last


def parse_spear(book, first, last):
    """Three lists - waters open to spearfishing, waters with a spring bass closure,
    waters with exceptions - each a heading in large type, an introduction, then
    waters set out exactly like the entries of 'Rules for specific waters'."""
    sections, sec, cur, rule, mode, lead = [], None, None, None, "idle", None
    for n in range(first, last + 1):
        xs = sorted(set(r["left"] for r in book.runs(n) if r["bold"] and r["font"]["size"] == 15 and 30 < r["top"] < 843))
        lines_ = lines_of(book, n, (81, 324) if n % 2 == 0 else (27, 270))
        for ln in lines_:
            txt = ln["text"]
            if ln["size"] >= 20:
                if ln["runs"][0]["font"]["color"] != "#007685":
                    continue
                if n == first and ln["col"] == 0 and sec is None:
                    continue                          # the page's own title
                if sec is not None and mode == "title" and ln["pg"] == sec["page"] and abs(ln["top"] - sec["_top"]) < 30:
                    sec["title"] = join(sec["title"], txt)
                    sec["_top"] = ln["top"]
                    continue
                sec = {"title": txt.strip(), "intro": "", "page": n, "entries": [], "_top": ln["top"]}
                sections.append(sec)
                cur = rule = lead = None
                mode = "title"
                continue
            if sec is None:
                continue
            if ln["size"] in (16, 18):                # a boxed aside ("Utah's boating laws and rules")
                mode = "box"
                cur = None
                continue
            if ln["size"] != 15:
                continue
            bullet = txt.lstrip().startswith("\u2022")
            # a water's name in bold, a comma, then the first of its counties
            head = ln["boldstart"] and ln["x"] <= 20 and not bullet and re.match(r"\s*[^,]{3,},\s*(?:%s)\b" % _C, txt)
            if mode == "head" and cur is not None and not COUNTY_LIST.search(cur["_head"]) and not bullet:
                cur["_head"] = join(cur["_head"], txt)
                continue
            if head:
                cur = {"_head": txt.strip(), "page": n, "rules": []}
                sec["entries"].append(cur)
                rule = lead = None
                mode = "head"
                continue
            if mode == "box":
                continue
            if cur is None:
                if mode in ("title", "intro"):
                    sec["intro"] = join(sec["intro"], txt)
                    mode = "intro"
                continue
            if bullet:
                rule = {"text": re.sub(r"^\s*\u2022\s*", "", txt).strip(), "page": n}
                (lead["items"] if lead is not None else cur["rules"]).append(rule)
                mode = "bullets"
                continue
            if ln["x"] >= 22 and rule is not None and mode == "bullets":
                rule["text"] = join(rule["text"], txt)
                continue
            if lead is not None and not lead["items"]:
                lead["text"] = join(lead["text"], txt)
            else:
                lead = {"text": txt.strip(), "page": n, "items": []}
                cur["rules"].append(lead)
            rule = None
            mode = "lead"
    out = []
    for sec in sections:
        sec.pop("_top", None)
        sec["title"] = squash(sec["title"])
        sec["intro"] = squash(sec["intro"])
        ents = []
        for e in sec["entries"]:
            h = parse_heading(e.pop("_head"))
            if not h:
                fail(f"spearfishing, page {e['page']}: a heading with no county could not be read")
                continue
            e["name"], e["counties"], rest = h
            if rest:
                fail(f"spearfishing: text after the county in the heading of {e['name']}: {rest!r}")
            for ru in e["rules"]:
                ru["text"] = squash(ru["text"])
                if "items" in ru:
                    ru["items"] = [squash(i["text"]) for i in ru["items"]]
            ents.append(e)
        sec["entries"] = ents
        out.append(sec)
    return out


# ------------------------------------------------------- statewide table ----
def cluster(items, gap=17):
    out = []
    for top, txt in sorted(items):
        if out and top - out[-1]["last"] <= gap:
            out[-1]["parts"].append(txt)
            out[-1]["last"] = top
        else:
            out.append({"first": top, "last": top, "parts": [txt]})
    for c in out:
        c["mid"] = (c["first"] + c["last"]) / 2
        t = ""
        for p in c["parts"]:
            t = join(t, p)
        c["text"] = squash(t)
    return out


def read_statewide(book, n):
    """The daily-limits table, read by position: a label column and a number
    column per half, paired by where they sit on the page."""
    runs = [r for r in book.runs(n) if 100 <= r["top"] <= 740 and r["font"]["size"] <= 15]
    rows = []
    for lab_x, val_x, edge in ((32, 195, 270), (276, 440, 520)):
        by_line = {}
        for r in runs:
            if lab_x - 4 <= r["left"] < val_x - 6:
                by_line.setdefault(round(r["top"] / 4), []).append(r)
        # merge runs that share a printed line (bold "Reminder:" sits a pixel off)
        merged = []
        for r in sorted([r for r in runs if lab_x - 4 <= r["left"] < val_x - 6], key=lambda r: (r["top"], r["left"])):
            if merged and abs(r["top"] - merged[-1][0]["top"]) <= 3:
                merged[-1].append(r)
            else:
                merged.append([r])
        labs = cluster([(m[0]["top"], line_text(sorted(m, key=lambda r: r["left"]))) for m in merged])
        vmerged = []
        for r in sorted([r for r in runs if val_x - 6 <= r["left"] < edge], key=lambda r: (r["top"], r["left"])):
            if vmerged and abs(r["top"] - vmerged[-1][0]["top"]) <= 3:
                vmerged[-1].append(r)
            else:
                vmerged.append([r])
        vals = cluster([(m[0]["top"], line_text(sorted(m, key=lambda r: r["left"]))) for m in vmerged])
        if len(labs) != len(vals):
            fail(f"statewide table: {len(labs)} labels but {len(vals)} numbers in one half of page {n}")
            continue
        for a, b in zip(labs, vals):
            if abs(a["mid"] - b["mid"]) > 14:
                fail(f"statewide table: '{a['text'][:30]}' and '{b['text']}' do not sit on the same row")
            rows.append({"label": a["text"], "limit": b["text"]})
    return rows


# ------------------------------------------------------------- dates ----
MONTH = {"jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
         "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
         "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12}
MON = r"(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?"
DATE = r"(?P<mon{i}>%s)\s*(?P<day{i}>\d{{1,2}})(?!\d)" % MON
NTH = r"(?:(?P<am{i}>6 a\.m\.) on )?the (?P<nth{i}>first|second|third|fourth|last) Saturday (?:of|in) (?P<nmon{i}>%s)" % MON
POINT = r"(?:" + NTH + r"|" + DATE + r")"
WINDOW = re.compile(POINT.replace("{i}", "a").replace("{{", "{").replace("}}", "}") + r"(?:\s*–\s*| through | to )" +
                    POINT.replace("{i}", "b").replace("{{", "{").replace("}}", "}"))
ANYPOINT = re.compile(POINT.replace("{i}", "x").replace("{{", "{").replace("}}", "}"))
ORD = {"first": 1, "second": 2, "third": 3, "fourth": 4, "last": -1}


def point(m, s):
    if m.group("nth" + s):
        p = {"n": ORD[m.group("nth" + s)], "m": MONTH[m.group("nmon" + s).rstrip(".").lower()]}
        if m.group("am" + s):
            p["h"] = 6
        return p
    return "%02d-%02d" % (MONTH[m.group("mon" + s).rstrip(".").lower()], int(m.group("day" + s)))


def windows(text):
    """Every date span in a sentence. Returns (spans, all date words were used)."""
    found = [[point(m, "a"), point(m, "b")] for m in WINDOW.finditer(text)]
    used = sum(len(ANYPOINT.findall(m.group(0))) for m in WINDOW.finditer(text))
    return found, used == len(ANYPOINT.findall(text))


# ----------------------------------------------------------- species ----
# Order is load-bearing: the narrow name is tested before the wide one that
# contains it, exactly as in docs/finder.js. "striped bass" before "bass".
SPECIES = [
    (r"trout with cutthroat (?:markings|characteristics)", "cutthroat trout", "trout"),
    (r"striped bass", "striped bass", "striper"),
    (r"white bass", "white bass", "whitebass"),
    (r"black bullhead catfish|bullhead catfish|bullheads?", "bullhead", "bullhead"),
    (r"channel catfish", "channel catfish", "catfish"),
    # "Limit 6 catfish." does not say which. The statewide table has a row for channel
    # catfish and another for bullhead, which the guidebook also calls a catfish, so
    # the bare word marks both rows.
    (r"catfish", "catfish", ("catfish", "bullhead")),
    (r"tiger musk(?:ie|ellunge)", "tiger muskellunge", "tigermuskie"),
    (r"tiger trout", "tiger trout", "trout"),
    (r"lake trout", "lake trout", "trout"),
    (r"brook trout", "brook trout", "trout"),
    (r"brown trout", "brown trout", "trout"),
    (r"rainbow trout|rainbow", "rainbow trout", "trout"),
    (r"cutthroat trout|cutthroat", "cutthroat trout", "trout"),
    (r"splake", "splake", "trout"),
    (r"kokanee salmon|kokanee|salmon", "kokanee salmon", "trout"),
    (r"arctic grayling|grayling", "Arctic grayling", "trout"),
    (r"trout", "trout", "trout"),
    (r"whitefish", "whitefish", "whitefish"),
    (r"smallmouth bass|smallmouth", "smallmouth bass", "bass"),
    (r"largemouth bass|largemouth", "largemouth bass", "bass"),
    (r"bass", "bass", "bass"),
    (r"black crappie|white crappie|crappie", "crappie", "crappie"),
    (r"bluegill", "bluegill", "bluegill"),
    (r"green sunfish", "green sunfish", "bluegill"),
    (r"sacramento perch", "Sacramento perch", "sacperch"),
    (r"yellow perch", "yellow perch", "perch"),
    (r"walleye", "walleye", "walleye"),
    (r"northern pike", "northern pike", "pike"),
    (r"burbot", "burbot", "burbot"),
    (r"wipers?", "wiper", "wiper"),
    (r"roundtail chub|roundtail", "roundtail chub", "roundtail"),
    (r"bonneville cisco|cisco", "Bonneville cisco", "cisco"),
    (r"common carp|carp", "common carp", "nongame"),
    (r"suckers?", "suckers", "nongame"),
    (r"pacu", "pacu", "nongame"),
    (r"tilapia", "tilapia", "nongame"),
    (r"gizzard shad", "gizzard shad", "nongame"),
    (r"nongame fish|nongame species", "nongame fish", "nongame"),
    (r"crayfish", "crayfish", "crayfish"),
]
ROWS = ["crappie", "bluegill", "cisco", "bullhead", "burbot", "catfish", "crayfish", "bass", "nongame", "pike",
        "roundtail", "sacperch", "striper", "tigermuskie", "trout", "walleye", "whitefish", "whitebass", "wiper", "perch"]
ALLFISH = re.compile(r"\ball species\b|\ball fish\b|\b\d+-fish\b|\bfish over\b|\bany fish\b", re.I)


# An aside that points at the statewide table does not name a fish of its own:
# "Limit 2 splake (goes toward the statewide trout limit)" is a rule about splake.
ASIDE = re.compile(r"\((?:goes toward the statewide trout limit|included in statewide limit|"
                   r"at all other times of the year, statewide trout limits apply)\)")


def species_in(text):
    """Species named in a sentence -> (names, statewide rows). Each stretch of text
    is claimed once, by the narrowest name that fits it."""
    low, names, rows = ASIDE.sub(" ", text).lower(), [], []
    for pat, name, row in SPECIES:
        def take(m):
            if name not in names:
                names.append(name)
            for r in (row if isinstance(row, tuple) else (row,)):
                if r not in rows:
                    rows.append(r)
            return " " * len(m.group(0))
        low = re.sub(r"(?<![a-z])(?:%s)(?![a-z])" % pat, take, low)
    return names, rows


# ------------------------------------------------------------ sorting ----
# A rule is sorted into one or more EFFECTS. Most rules have one. A few say two
# things at once ("Catch and release only and artificial flies and lures only"),
# and the app needs both.
#
# Topics: closed, limit, release, tackle, boat, method, keep, access, info.
NOTES = [
    r"To learn how to identify cutthroat trout in this water, see [^.]+\.",
    r"\(For information on how to properly catch and release tiger muskie, see wildlife\.utah\.gov/muskie\.\)",
    r"\(Common carp do not count toward the daily limit\.\)",
]
# A list of fish: names from SPECIES (in either case), joined by commas, "and", "or".
# It is filled in when the patterns are compiled.
F = r"@FISH@"
SIZE = r"(?:\d+ inches or (?:smaller|less)|from \d+ to \d+ inches|between \d+ and \d+ inches|(?:over|under) \d+ inches|less than \d+ inches or over \d+ inches)"
KILL = r"(?: Anglers (?:must|may) not release any (?:of these fish, which|" + F + r" they catch\. All " + F + r") must be immediately killed\.)"
# A date span, read separately by windows(). It may not run past the end of a
# sentence: "CLOSED Jan. 1 through July 10. Catch and release only the rest of the
# year." is two rules, and a pattern that swallowed the second would lose it. The
# full stops inside a span are all followed by a digit or a small letter ("Jan. 1",
# "6 a.m. on"), so a full stop followed by a capital or a bracket ends the sentence.
_D = r"(?:" + MON + r"|\d{1,2}(?!\d)|through|to|and|from|on|the|of|in|first|second|third|fourth|last|Saturday|6 a\.m\.|\u2013|,)"
W = r"(?:\s*" + _D + r"(?:\s*" + _D + r")*)"
CR = ("release", {"cr": 1, "all": 1})
FL = ("tackle", {"art": "fl"})

PATTERNS = [
    # --- closed to all fishing
    ([("closed", {"scope": "all"})], r"CLOSED TO FISHING(?: YEAR ROUND)?\."),
    ([("closed", {"scope": "all", "dated": 1})], r"(?:All tributaries to Grandaddy Lake |Facility )?CLOSED " + MON + W + r"\."),
    # --- open only between two dates: closed the rest of the year
    ([("access", {"dated": 1, "as": "open", "daylight": 1})], r"Open to fishing on " + W + r" during daylight hours\. \(Gate will be closed and locked from dusk to dawn\.\)"),
    # --- closed in part, or to one method
    ([("closed", {"scope": "part"})], r"CLOSED near the (?:inlet stream|spawning trap and portions of the lake and canal), as posted (?:for|during) spring spawning operations\."),
    ([("closed", {"scope": "part"})], r"Cement outlet channel between the dam and spillway pond, approximately 55 feet long, is CLOSED\."),
    ([("closed", {"scope": "part"})], r"Upstream of entrance to Red Butte Canyon Research Natural Area to the headwaters: CLOSED TO FISHING\."),
    ([("closed", {"scope": "part", "dated": 1})], r"Linwood Bay, west of a line from the easternmost point of the south shore of Linwood Bay \(mouth of canyon\) to easternmost point of the north shore of Linwood Bay \(Lucerne Point\), CLOSED to nighttime angling \(sunset to sunrise\) from " + W + r"\."),
    ([("method", {"dated": 1})], r"CLOSED to nighttime bowfishing \(sunset to sunrise\) from " + W + r"\."),
    ([("closed", {"scope": "part"})], r"Open to fishing, except where posted CLOSED\."),
    # --- limits
    ([("limit", {})], r"Limit (?:of )?\d+ " + F + r"(?: \(a combined total(?:, regardless of species)?\))?(?: of any size)?\.?"),
    ([("limit", {})], r"Limit \d+ " + F + r" \((?:goes toward the statewide trout limit|included in statewide limit)\)\."),
    ([("limit", {"dated": 1})], r"Limit (?:of )?\d+ trout from " + MON + W + r"(?: \(at all other times of the year, statewide trout limits apply\))?\."),
    ([("limit", {})], r"Limit \d+ " + F + r" (?:over|under) \d+ inches(?:, regardless of species)?(?: \(goes toward the statewide trout limit\))?\."),
    ([("limit", {})], r"Limit \d+ trout between \d+ and \d+ inches\."),
    ([("limit", {})], r"Limit \d+ trout \(must be under \d+ inches or over \d+ inches\)\."),
    ([("limit", {})], r"Limit \d+ trout \(\d+ under \d+ inches and \d+ over \d+ inches\)\."),
    ([("limit", {})], r"Limit \d+ " + F + r"(?: \(a combined total\))?, only \d+(?: " + F + r")? may (?:be over|exceed) \d+ inches\."),
    ([("limit", {})], r"Limit \d+ " + F + r",(?: and)? (?:only|no more than) \d+ may be a " + F + r" over \d+ inches\."),
    ([("limit", {})], r"Limit \d+ yellow perch and \d+ walleye \(no size restrictions\)\."),
    ([("limit", {})], r"Limit \d+ bluegill, green sunfish, black crappie and yellow perch \(a combined total\) and no more than \d+ of those fish may be black crappie\."),
    ([("limit", {})], r"No more than \d+(?: trout)? may be(?: " + F + r")? (?:under|over) \d+ inches(?:, and no more than \d+ may be a " + F + r" over \d+ inches)?\."),
    ([("limit", {})], r"Bonus limit of \d+ " + F + r" \(total limit of no more than \d+ trout if at least \d+ are " + F + r"\)\."),
    ([("limit", {})], r"No limit (?:for|on) " + F + r"\.?" + KILL + r"?"),
    ([("limit", {})], r"No limit for lake trout \d+ inches or less; only \d+ lake trout may exceed \d+ inches\."),
    ([("limit", {})], r"Excluding lake trout, a limit of \d+ trout or kokanee salmon \(a combined total\); no more than \d+ of these may be kokanee salmon\."),
    ([("limit", {})], r"Limit \d+ trout or kokanee salmon \(a combined total\)\. Kokanee salmon of any size may be harvested as part of the limit\."),
    ([("limit", {})], r"Limit \d+ trout and kokanee salmon, only \d+ may be rainbow, cutthroat or brown trout \(a combined total\)\. To take \d+ fish, you must possess at least \d+ kokanee\."),
    ([("limit", {})], r"Any trout with cutthroat (?:markings|characteristics \(not necessarily jaw slashing\)) is considered to be a cutthroat trout\."),
    ([("limit", {"all": 1})], r"Limits for all species (?:except for tiger muskellunge )?are double the statewide limits listed on page 7\."),
    ([("limit", {"all": 1})], r"The daily limit is 2 fish\."),
    # --- must release / may not keep
    ([("release", {})], r"All " + F + r"(?: " + SIZE + r")? must be immediately released\."),
    ([("release", {})], r"All cutthroat trout—or trout with cutthroat markings—must be immediately released\."),
    ([("release", {})], r"CLOSED to the possession of " + F + r"\.(?: All " + F + r" must be immediately released\.)?"),
    ([("release", {})], r"Closed to the possession of tiger muskie\. All tiger muskie must be immediately released\."),
    ([("release", {"dated": 1})], r"CLOSED to the possession of " + F + r" from " + W + r"\."),
    ([CR], r"Catch and release only\.(?: \(All fish must be immediately released\. It is illegal to fish if you have any fish in possession\.\))?"),
    # --- two things at once
    ([("release", {"cr": 1, "all": 1, "dated": 1}), ("tackle", {"art": "fl", "dated": 1})],
     r"Catch and release only and artificial flies and lures only \(" + W + r"\)\."),
    ([("release", {"cr": 1, "all": 1, "dated": 1}), ("tackle", {"art": "fl", "dated": 1})],
     r"Artificial flies and lures only and catch-and-release only fishing is allowed from " + W + r"\."),
    # --- tackle and bait
    ([FL], r"Artificial flies and lures only\.(?: \(The use or possession of bait while fishing is illegal\.\))?"),
    ([("tackle", {"art": "f"})], r"Artificial flies only\."),
    ([("tackle", {"art": "fl", "dated": 1})], r"Artificial flies and lures only from " + W + r"\."),
    ([("tackle", {})], r"Unlawful to use whole fish for bait\. Cut baitfish must not be larger than one inch in any dimension and no more than one piece per hook\."),
    ([("tackle", {})], r"Anglers may use dead (?:lake trout that are part of their daily bag limit|burbot|striped bass) as bait\."),
    ([("tackle", {})], r"Chumming is allowed, but you may chum only with legal baits(?:, dead burbot or lake trout| or dead striped bass), as specified in Utah Admin\. Rule R657-13-12\."),
    ([("tackle", {}), ("release", {})], r"Possession and use of commercially sold and preserved gizzard shad is allowed\. Otherwise, possession of gizzard shad, dead or alive, is unlawful\."),
    ([("tackle", {})], r"A person may not possess a multipoint hook with a weight permanently or rigidly attached directly to the shank\u2014or a weight suspended below a multipoint hook\u2014unless the hook is on an unweighted dropper line that is at least three inches long\."),
    # --- boats
    ([("boat", {"boat": "motor"})], r"Fishing from a boat with a motor(?: of any kind)? is (?:unlawful|prohibited)\."),
    ([("boat", {"boat": "motor", "except": 1})], r"Fishing from a boat with a motor is unlawful, except at (?:[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*(?:, | and )?)+\."),
    ([("boat", {"boat": "motor"})], r"CLOSED to fishing from a boat with a motor between the Utah-Colorado state line and Flaming Gorge Dam\."),
    ([("boat", {"boat": "none"})], r"Fishing from a boat or float tube is unlawful\."),
    ([("boat", {"boat": "shore"})], r"Shore fishing only\."),
    ([("boat", {"boat": "wakeless"})], r"Operating a boat above wakeless speed is prohibited\."),
    # --- methods
    ([("method", {})], r"An angler may use up to six lines when fishing through the ice\. If the angler is using more than two lines, the angler’s name must be attached to each line, pole or tip-up, and the angler may check only their lines\.(?: \(There is no restriction on ice hole size\.\))?"),
    ([("method", {})], r"When ice fishing(?: for fish other than cisco)?, the size of the hole may not exceed 18 inches\."),
    ([("method", {})], r"Anglers may keep snagged Bonneville cisco that are taken through normal, legal fishing activities\."),
    ([("method", {})], r"Cisco may be taken with a handheld dipnet\. Net opening may not exceed 18 inches in any dimension\. When dipnetting through the ice, the size of the hole is unrestricted\."),
    ([("method", {})], r"Any angler who possesses a valid Utah or Idaho fishing or combination license may fish within both the Utah and Idaho boundaries of Bear Lake\. "
                      r"An angler may fish with up to two poles on all areas of the Utah portion of Bear Lake that are open to fishing\. "
                      r"Anglers must comply with Idaho regulations if they want to use more than one pole when fishing on the Idaho portion of Bear Lake\. "
                      r"Visit idfg\.idaho\.gov/rules/ ?fish or scan the QR code for Idaho’s fishing regulations\."),
    ([("method", {})], r"Gaffs may be used to land striped bass only\."),
    ([("method", {})], r"Setline fishing is allowed\."),
    ([("limit", {})], r"Common carp are the only nongame fish allowed to be taken\."),
    ([("method", {})], r"Archery \(and underwater spearfishing\) are prohibited within all of the following areas:"),
    # --- what you may carry away
    ([("keep", {})], r"Trout(?: and salmon)? may not be filleted,? and (?:the|their) heads or tails may not be removed in the field or in transit\."),
    ([("keep", {})], r"Fish may be filleted at any time\."),
    ([("keep", {})], r"Anglers may possess filleted fish\."),
    ([("keep", {})], r"Anglers are only allowed one daily limit at Flaming Gorge\."),
    # --- access
    ([("access", {})], r"Fishing at Deseret Reservoir requires an onpost fishing permit\. You can obtain one at the following locations: [^.]+\."),
    ([("access", {})], r"No overnight camping on division land\."),
    ([("access", {})], r"Waters are open to fishing only when the community parks are open to the public\."),
    # --- notes that change nothing you may do
    ([("info", {})], r"Species of threatened and endangered fish occur in the (?:Colorado|Green River)\. If you catch one of these fish, you must release it immediately\. See page 16 for a list of prohibited fish\."),
    ([("info", {})], r"Anglers are encouraged to (?:harvest tiger trout|voluntarily release all (?:cutthroat trout|largemouth bass))\."),
    ([("info", {})], r"See specific water restrictions for individual waters\. Statewide regulations apply to those waters not specifically identified\."),
    ([("info", {})], r"Statewide regulations apply\."),
    ([("info", {"see": 1})], r"See [A-Z][A-Za-z ]+\."),
]
_FISH = "|".join(p_ for p_, _, _ in sorted(SPECIES, key=lambda x: -len(x[0])))
_TOK = r"(?:(?i:" + _FISH + r")|fish|and their hybrids|and|or)"
FISH_LIST = _TOK + r"(?:(?:, | )" + _TOK + r")*"
PATTERNS = [(e, re.compile(p.replace("@FISH@", "(?:" + FISH_LIST + ")"))) for e, p in PATTERNS]
NOTES = [re.compile(p) for p in NOTES]
TOPICS = ("closed", "limit", "release", "tackle", "boat", "method", "keep", "access", "info")
# Topics that change how many fish, or which fish, may be kept. A rule in one of
# these marks the statewide rows it names as "set by this water".
KEEPING = ("limit", "release")


def sort_rule(text):
    """One printed rule -> its effects, or None when no strict pattern fits it."""
    body, noted = text, False
    for p in NOTES:
        m = p.search(body)
        if m:
            noted = True
            body = squash(body[:m.start()] + " " + body[m.end():])
    hit = None
    for effects, p in PATTERNS:
        if p.fullmatch(body):
            hit = effects
            break
    if hit is None:
        return None
    spans, clean = windows(body)
    if spans and not clean:
        return None                              # a date word the span reader did not use
    names, rows = species_in(body)
    out = []
    for topic, flags in hit:
        fx = dict(flags)
        fx["t"] = topic
        dated, kind = fx.pop("dated", 0), fx.pop("as", "w")
        if bool(dated) != bool(spans):
            return None                          # the pattern and the wording disagree about dates
        if spans:
            fx[kind] = spans
        if topic in KEEPING:
            if fx.pop("all", 0) or ALLFISH.search(body):
                fx["rows"] = "all"
                if names:
                    fx["sp"] = names
            elif rows:
                fx["rows"], fx["sp"] = rows, names
            else:
                return None                      # a limit that names no fish we know
        else:
            fx.pop("all", None)
        out.append(fx)
    if noted:
        out.append({"t": "info"})
    return out


# Words that cannot appear in a rule without the index saying so. This is the net
# under the patterns AND under a person's override: whichever of them sorted the
# rule, a closure, a limit, a release or a tackle rule in the wording has to show
# up in the index, or the build stops.
MUST = [
    (re.compile(r"\b(?:CLOSED|[Cc]losed)\b|\b[Nn]o fishing\b"), ("closed", "release", "method", "boat", "access"), "a closure"),
    (re.compile(r"[Cc]atch[- ]and[- ]release"), ("release",), "catch and release"),
    (re.compile(r"must be (?:immediately )?released|(?:CLOSED|[Cc]losed) to the possession|may not be kept"), ("release",), "a fish that may not be kept"),
    (re.compile(r"^(?:Bonus limit|Limit|No limit)\b|\bdaily limit is\b|\ba limit of \d|\. Limit \d|\b\d+-(?:fish|trout|bass) limit\b|\blimit is \d"), ("limit",), "a limit"),
    (re.compile(r"\b[Ll]imits?\b"), ("limit", "keep", "release", "tackle", "info"), "a word about limits"),
    (re.compile(r"[Aa]rtificial flies(?: and lures)? only"), ("tackle",), "a tackle rule"),
    (re.compile(r"\bboat\b|float tube|[Ss]hore fishing|wakeless"), ("boat",), "a boat rule"),
]


def check_fx(text, effects, where):
    """The same checks whether the index came from a pattern or from a person."""
    if not isinstance(effects, list) or not effects:
        fail(f"{where}: the index is empty")
        return
    topics = [fx.get("t") for fx in effects]
    body = text
    for p in NOTES:
        body = p.sub(" ", body)
    if all(t == "info" for t in topics) and not any(p.fullmatch(text) for e, p in PATTERNS if all(t_ == "info" for t_, _ in e)):
        fail(f"{where}: read as a note only, and no pattern says this wording is a note: {text[:70]!r}")
    if re.search(r"CLOSED TO FISHING|\b[Ff]ishing is prohibited\b|\bNo (?:fishing|angling)\b", body) and "closed" not in topics:
        fail(f"{where}: the wording closes the water, or part of it, and the index has no closure ({topics}): {text[:70]!r}")
    if re.search(r"\b(?:is|are) (?:prohibited|unlawful|illegal)\b|\b[Uu]nlawful to\b|\bmay not\b", body) and all(t == "info" for t in topics):
        fail(f"{where}: the wording forbids something and the index is only a note: {text[:70]!r}")
    for rx, allowed, what in MUST:
        if rx.search(body) and not any(t in allowed for t in topics):
            fail(f"{where}: the wording holds {what} and the index has none ({topics}): {text[:70]!r}")
    if re.search(r"[Cc]atch[- ]and[- ]release only", body) and not any(fx.get("cr") for fx in effects):
        fail(f"{where}: the wording says catch and release only and the index does not")
    if re.search(r"[Aa]rtificial flies(?: and lures)? only", body) and not any(fx.get("art") for fx in effects):
        fail(f"{where}: the wording limits tackle to artificial flies or lures and the index does not")
    spans, clean = windows(text)
    dated = [fx for fx in effects if "w" in fx or "open" in fx]
    if spans and not dated:
        fail(f"{where}: the wording has dates {spans} but the index has none")
    if spans and not clean and not any(fx.get("w_by_hand") for fx in effects):
        fail(f"{where}: a date in the wording is outside every span read from it")
    rows_said, all_said = set(), False
    for fx in effects:
        if fx.get("t") not in TOPICS:
            fail(f"{where}: unknown topic {fx.get('t')!r}")
        have = fx.get("w") or fx.get("open")
        if have is not None and not fx.get("w_by_hand") and json.dumps(have) != json.dumps(spans):
            fail(f"{where}: the dates in the wording are {spans} but the index says {have}")
        if fx.get("t") == "closed" and fx.get("scope") not in ("all", "part"):
            fail(f"{where}: a closure that does not say whether it is the whole water or part of it")
        if fx.get("t") in KEEPING:
            if fx.get("rows") == "all":
                all_said = True
            elif not fx.get("rows"):
                fail(f"{where}: a rule about keeping fish that names no row of the statewide table")
            else:
                for r in fx["rows"]:
                    if r not in ROWS:
                        fail(f"{where}: {r!r} is not a row of the statewide table")
                    rows_said.add(r)
    if any(fx.get("t") in KEEPING for fx in effects) and not all_said:
        names, rows = species_in(text)
        if sorted(rows_said) != sorted(rows):
            fail(f"{where}: the wording names {sorted(rows)} but the index says {sorted(rows_said)}")
    names = species_in(text)[0]
    for fx in effects:
        if fx.get("t") in KEEPING and fx.get("sp") is not None and sorted(fx["sp"]) != sorted(names) \
                and not set(fx["sp"]) < set(names):
            fail(f"{where}: the wording names {sorted(names)} but the index lists {sorted(fx['sp'])}")


def from_override(o):
    return [dict(fx) for fx in o["fx"]]


# ------------------------------------------------------------- helpers ----
def slug(name, counties):
    s = re.sub(r"[^a-z0-9]+", "-", (name + " " + " ".join(counties)).lower().replace("’", "")).strip("-")
    return s


def rid(*parts):
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:8]


EXCEPTION = re.compile(r"^[.)]*(?:theonlyexception|theexception|thisdoesnotapply|thisruledoesnot|\(important|\(thisrule|however|exceptfor|exceptat|unless)")


def tight(s):
    """Letters, digits and the punctuation that ends a sentence."""
    return re.sub(r"[^a-z0-9.()]", "", s.lower())


FOLLOWS = re.compile(r"^(?:theonlyexception|theexception|thisdoesnotapply|thisruledoesnot|important|thisrule|"
                     r"however|except|unless|youmay|youcan|anglersmay|atmostwaters|note|reminder|remember|inaddition|"
                     r"pleasekeepinmind|pleasenote|keepinmind|pleaseremember)")
# "Nonresident anglers:", "Reminder:", "Important:" - a label and a colon open a new part of the same rule
LABEL = re.compile(r"^[A-Z][a-z]+(?:[A-Za-z]{0,28})?:")


def squeeze(s):
    """Everything but white space and hyphens, with case and punctuation kept:
    enough to see what is printed straight after a quote."""
    return re.sub(r"[\s\-\u2010\u2011\u00ad]", "", s)


def after_quote(book, text, page):
    want = squeeze(text)
    for p_ in (page, page + 1, page - 1):
        if 1 <= p_ <= book.pages:
            hay = squeeze(book.raw(p_))
            i = hay.find(want)
            if i >= 0:
                return hay[i + len(want):i + len(want) + 80]
    return None


def exception_follows(book, text, page):
    """What is wrong with where a hand-made quote stops, or None.

    Twice a general rule was quoted without what the guidebook printed next: six
    times an 'only exception', then a paragraph that went on 'You may use additional
    lines or hooks when you are:' and a sentence cut at a semicolon. So the words
    straight after every quote are read. A quote may not stop inside a sentence, and
    it may not stop before a sentence that opens like an exception, a permission or
    a note, unless a person has read on and written down why it is left out."""
    tail = after_quote(book, text, page)
    if tail is None:
        old = tight(text).rstrip(".")
        for p_ in (page, page + 1):
            if p_ <= book.pages:
                hay = tight(book.raw(p_))
                i = hay.find(old)
                if i >= 0:
                    t_ = hay[i + len(old):i + len(old) + 40]
                    return t_ if EXCEPTION.match(t_) else None
        return None
    if tail[:1] in (";", ",") or (text.rstrip()[-1:] not in ".):?!\u201d\"" and tail[:1].islower()):
        return "the quote stops inside a sentence, which goes on: " + tail
    if tail[:1] == "\u2022":
        return "the list goes on with another bullet: " + tail
    if tail[:1] == "(":
        return "the sentence goes on in brackets: " + tail
    if LABEL.match(tail):
        return "a labelled part follows: " + tail
    low = re.sub(r"[^a-z]", "", re.sub(r"^[^A-Za-z]+", "", tail).lower())
    return tail if FOLLOWS.match(low) else None


def in_raw(book, text, page, last):
    """Is this wording in the second reading of the page? A rule that runs over a
    column or page break is matched in two pieces."""
    want = norm(text)
    pages = [norm(book.raw(p)) for p in range(max(1, page - 1), min(last, page + 1) + 1)]
    if any(want in p for p in pages):
        return True
    for k in range(len(want) - 6, 6, -1):
        if any(want[:k] in p for p in pages) and any(want[k:] in p for p in pages):
            return True
    return False


# ---------------------------------------------------------------- main ----
def main():
    args = sys.argv[1:]
    path = args[args.index("--pdf") + 1] if "--pdf" in args else None
    book = Book(fetch_pdf(path))
    title = book.info.get("Title", "")
    ym = re.search(r"(20\d\d)", title)
    if not ym or "Fishing Guidebook" not in title:
        fail(f"this PDF does not call itself a fishing guidebook: {title!r}")
        return finish(None)
    year = int(ym.group(1))
    first, last, box = find_section(book)
    if FAIL:
        return finish(None)

    hand = json.load(open(os.path.join(SRC, "statewide.json")))
    over = json.load(open(os.path.join(SRC, "overrides.json")))
    over_used = set()

    # ---- statewide table: position, content order, and the hand-kept copy
    table = read_statewide(book, hand["page"])
    raw7 = norm(book.raw(hand["page"]))
    if len(table) != len(hand["limits"]):
        fail(f"statewide table: the page has {len(table)} rows, the hand-kept copy {len(hand['limits'])}")
    by_label = {norm(r["label"]): r for r in table}
    limits = []
    for h in hand["limits"]:
        r = by_label.get(norm(h["label"]))
        if not r:
            fail(f"statewide table: no row on the page reads {h['label'][:50]!r}")
            continue
        if norm(r["limit"]) != norm(h["limit"]):
            fail(f"statewide table: {h['label'][:40]!r} - page says {r['limit']!r}, hand-kept copy says {h['limit']!r}")
        if norm(h["label"]) + norm(h["limit"]) not in raw7:
            fail(f"statewide table: {h['label'][:40]!r} is not followed by {h['limit']!r} in the second reading")
        if h["row"] not in ROWS and h["row"] not in ("community", "kokanee"):
            fail(f"statewide table: unknown row key {h['row']!r}")
        limits.append({"row": h["row"], "name": h["name"], "limit": r["limit"], "label": r["label"], "page": hand["page"]})
    general = []
    # The start of every quote held, so that a quote which stops just before another
    # held quote is not taken for one that stops short.
    held_starts = [squeeze(x) for g_ in hand["rules"] + hand.get("spear_general", []) for x in [g_["text"]] + g_.get("items", [])]

    def held_next(tail, me, page):
        """Is what follows the start of ANOTHER quote that is held? Two bullets can
        open with the same words, so as much as can be compared is compared. A
        quote that runs over a page or column break is cut off by the page furniture;
        it still counts if the rest of it is printed on that page or the next."""
        t_ = re.sub(r"^[^A-Za-z(]+", "", re.sub(r"^[^:]*: ", "", tail or "", count=1) if (tail or "").startswith(("the list goes on", "the quote stops", "the sentence goes on", "a labelled part")) else (tail or ""))
        if len(t_) < 20:
            return False
        for h_ in held_starts:
            if h_ == squeeze(me):
                continue
            n_ = min(len(h_), len(t_), 70)
            same = 0
            while same < n_ and t_[same] == h_[same]:
                same += 1
            if same >= n_:
                return True
            if same >= 24 and any(h_[same:same + 30] in squeeze(book.raw(q_)) for q_ in (page, page + 1) if q_ <= book.pages):
                # the words up to the break must be the END of what that page prints of it
                return True
        return False
    for g in hand["rules"]:
        for piece in [g["text"]] + g.get("items", []):
            if not in_raw(book, piece, g["page"], book.pages):
                fail(f"statewide rule {g['id']!r}: not found on page {g['page']}: {piece[:60]!r}")
        pieces = [g["text"]] + g.get("items", [])
        for k_, piece in enumerate(pieces):
            tail = exception_follows(book, piece, g["page"])
            # what follows a piece may simply be the next piece of the same quote
            if tail and held_next(tail, piece, g["page"]):
                tail = None
            if tail and not g.get("ends_ok"):
                fail(f"statewide rule {g['id']!r} stops short of what is printed next: ...{tail[:110]!r}. "
                     f"Read on in the guidebook. Quote it too, or set ends_ok and say why in ends_why.")
        if g.get("ends_ok") and len(g.get("ends_why", "")) < 20:
            fail(f"statewide rule {g['id']!r} is marked ends_ok and does not say why")
        fx = [dict(f) for f in (g["fx"] if isinstance(g["fx"], list) else [g["fx"]])]
        if g["id"] != "protected":          # the protected fish are named in the list, not in the statewide table
            check_fx(" ".join([g["text"]] + g.get("items", [])), fx, "statewide rule " + g["id"])
        rec = {"id": g["id"], "head": g["head"], "text": g["text"], "page": g["page"], "fx": fx}
        if g.get("items"):
            rec["items"] = g["items"]
        if g.get("waters"):
            rec["waters"] = g["waters"]
        general.append(rec)

    # ---- the waters
    entries = parse_waters(book, first, last, box)
    waters, seen, n_rules, unsorted_, by_text = [], {}, 0, [], {}
    for e in entries:
        wid = slug(e["name"], e["counties"])
        if wid in seen:
            fail(f"two entries share the id {wid!r} (pages {seen[wid]} and {e['page']})")
        seen[wid] = e["page"]
        w = {"id": wid, "name": e["name"], "counties": e["counties"], "page": e["page"]}
        if e["br"]:
            w["br"] = True
        desc = e["desc"]
        # A rule printed in the description instead of as a bullet (Wheeler Creek).
        m = re.search(r"\s*(CLOSED TO FISHING(?: YEAR ROUND)?\.)\s*$", desc)
        if m and not e["reaches"]:
            e["reaches"].append({"key": None, "where": "", "rules": [{"text": m.group(1), "page": e["page"], "lifted": 1}]})
            desc = desc[:m.start()].strip()
            note(f"{e['name']}: a rule printed inside the description was lifted into a rule of its own")
        if re.search(r"\bCLOSED\b|\bLimit\b|Artificial|Catch and release|unlawful", desc):
            fail(f"{e['name']}: the description still holds what looks like a rule: {desc!r}")
        if desc:
            w["desc"] = desc
        reaches = []
        for r in e["reaches"]:
            rr = {}
            if r["key"]:
                rr["key"] = r["key"]
            if r["where"]:
                rr["where"] = r["where"].rstrip(":").strip() if r["where"].endswith(":") else r["where"]
                rr["where_as_printed"] = r["where"]
            rr["rules"] = []
            for ru in r["rules"]:
                n_rules += 1
                text = ru["text"]
                full = text + "".join(" " + i for i in ru.get("items", []))
                rec = {"id": rid(wid, r["key"] or "", text), "text": text, "page": ru["page"]}
                if ru.get("lifted"):
                    rec["lifted"] = 1
                if ru.get("items"):
                    rec["items"] = ru["items"]
                    rec["item_pages"] = ru["item_pages"]
                for piece in [text] + ru.get("items", []):
                    if not in_raw(book, piece, ru["page"], book.pages):
                        fail(f"{e['name']} p{ru['page']}: the second reading of the page does not contain {piece[:70]!r}")
                fx = sort_rule(text)
                o = over.get(text)
                if o is not None:
                    over_used.add(text)
                    if fx is not None and "force" not in o:
                        warn(f"an override exists for a sentence the patterns can already sort: {text[:60]!r}")
                    fx = from_override(o)
                    rec["by"] = "hand"
                if fx is None:
                    unsorted_.append((e["name"], ru["page"], text))
                    rec["fx"] = [{"t": "unsorted"}]
                else:
                    check_fx(text, fx, f"{e['name']} p{ru['page']}")
                    rec["fx"] = fx
                by_text.setdefault(text, rec["fx"])
                rr["rules"].append(rec)
            reaches.append(rr)
        w["reaches"] = reaches
        waters.append(w)

    # ---- pointers: "See Utah Lake tributaries."
    ids = {w["id"]: w for w in waters}
    by_name = {}
    for w in waters:
        by_name.setdefault(w["name"].lower(), []).append(w)

    def resolve(target, frm):
        t = target.strip().rstrip(".")
        m = COUNTY_LIST.search(t)
        cands = by_name.get((t[:m.start()].rstrip(" ,") if m else t).lower(), [])
        if m and len(cands) > 1:
            want = [c.strip() for c in re.split(r", and |, | and ", m.group(1))]
            cands = [c for c in cands if c["counties"] == want]
        if len(cands) != 1:
            fail(f"{frm}: 'See {t}' matches {len(cands)} entries")
            return None
        return cands[0]

    for w in waters:
        w["kind"] = "water"
        has_rules = any(r["rules"] for r in w["reaches"])
        m = re.fullmatch(r"See ([^.]+)\.", w.get("desc", ""))
        if m and not has_rules:
            tgt = resolve(m.group(1), w["name"])
            if tgt:
                named = [r.get("key") for r in tgt["reaches"]
                         if re.search(r"(?<!Little )(?<![A-Za-z])" + re.escape(w["name"]) + r"(?![A-Za-z])", r.get("where_as_printed", ""))]
                w["kind"] = "pointer"
                w["see"] = {"water": tgt["id"]}
                if named and len(named) < len(tgt["reaches"]):
                    w["see"]["reaches"] = named
                w.pop("reaches")
        elif not has_rules and not any(r.get("where_as_printed") for r in w["reaches"]):
            fail(f"{w['name']}: no rule and no pointer")
        for r in w.get("reaches", []):
            for ru in r["rules"]:
                for fx in ru["fx"]:
                    if fx.get("see"):
                        tm = re.fullmatch(r"See ([^.]+)\.", ru["text"])
                        tgt = resolve(tm.group(1), w["name"]) if tm else None
                        if tgt:
                            fx["see"] = tgt["id"]
            if not r["rules"]:
                tm = re.match(r"(.+?): See (.+?)\.?$", r.get("where_as_printed", ""))
                tgt = resolve(tm.group(2), w["name"]) if tm else None
                if tgt:
                    r["see"] = tgt["id"]
                    r["where"] = tm.group(1)
                else:
                    fail(f"{w['name']} ({r.get('key')}): a stretch with no rule and no pointer")
    for w in waters:
        for r in w.get("reaches", []):
            r.pop("where_as_printed", None)

    # ---- every bullet printed must be one we hold, and the other way round
    held = {}
    for w in waters:
        for r in w.get("reaches", []):
            for ru in r["rules"]:
                if ru.get("lifted"):
                    continue                    # printed as a sentence, not a bullet
                if ru.get("items"):
                    held[ru["page"]] = held.get(ru["page"], 0)      # a lead-in paragraph is not a bullet
                    for pg in ru["item_pages"]:
                        held[pg] = held.get(pg, 0) + 1
                else:
                    held[ru["page"]] = held.get(ru["page"], 0) + 1
    for n in range(first, last + 1):
        if n == box:
            continue
        # Every bullet on the page except the one in the running header
        # ("UTAH FISHING GUIDEBOOK • 2026"), which is letterspaced in the PDF.
        body = "\n".join(l for l in book.raw(n).splitlines() if not re.search(r"•\s*20\d\d\b|20\d\d\s*•", l))
        printed = body.count("•") - (2 if n == first else 0)
        if printed != held.get(n, 0):
            fail(f"bullets: page {n} prints {printed} but {held.get(n, 0)} are held")
    for w in waters:
        for r in w.get("reaches", []):
            for ru in r["rules"]:
                ru.pop("item_pages", None)
                ru.pop("lifted", None)

    # ---- community fishing waters
    com = parse_community(book, box)
    rawb = norm(book.raw(box))
    for r in com["rules"]:
        if norm(r["text"]) not in rawb:
            fail(f"community waters: rule not in the second reading: {r['text'][:60]!r}")
        fx = sort_rule(r["text"])
        o = over.get(r["text"])
        if o is not None:
            over_used.add(r["text"])
            fx = from_override(o)
            r["by"] = "hand"
        if fx is None:
            unsorted_.append(("Community fishing waters", box, r["text"]))
            fx = [{"t": "unsorted"}]
        else:
            check_fx(r["text"], fx, "community waters")
        r["id"] = rid("community", r["text"])
        r["fx"] = fx
    for m in com["members"]:
        if norm(m["as_printed"]) not in rawb:
            fail(f"community waters: {m['as_printed']!r} is not in the second reading")
        m["id"] = slug(m["name"], [m["county"]])
        m.pop("as_printed")
        if not m["also"]:
            m.pop("also")
    for nt in com["notes"]:
        if norm(nt["text"]) not in rawb:
            fail(f"community waters: note not in the second reading: {nt['text'][:60]!r}")
        o = over.get(nt["text"])
        if o is None:
            unsorted_.append(("Community fishing waters (note)", box, nt["text"]))
            nt["fx"] = [{"t": "unsorted"}]
        else:
            over_used.add(nt["text"])
            nt["fx"] = from_override(o)
            nt["members"] = [slug(x, [nt["county"]]) for x in o["members"]]
            for x in nt["members"]:
                if x not in [m["id"] for m in com["members"]]:
                    fail(f"community waters: the note names {x!r}, which is not a listed water")
            check_fx(nt["text"], nt["fx"], "community waters note")
        nt["id"] = rid("community-note", nt["text"])
    if len(com["members"]) < 60:
        fail(f"community waters: only {len(com['members'])} waters were read")

    for k in over:
        if k not in over_used and not k.startswith("_"):
            fail(f"overrides.json holds a sentence the guidebook no longer prints: {k[:70]!r}")
    for nm, pg, tx in unsorted_:
        fail(f"unsorted rule - {nm} p{pg}: {tx!r}")

    # ---- groups, and the names an entry covers without heading them
    NAMED = re.compile(r"((?:(?:[A-Z][\w’'-]*|of)\s)+(?:Creek|River|Lake|Lakes|Reservoir|Hollow|Fork|Canyon|Wash|Pond|Ponds|Canal|Bay))\b")
    for w in waters:
        if re.search(r"tributar|lakes and (?:reservoirs|streams)", w["name"]):
            w["group"] = True
        texts = [w.get("desc", "")] + [r.get("where", "") for r in w.get("reaches", [])]
        also = []
        for t_ in texts:
            for nm in NAMED.findall(t_):
                nm = re.sub(r"^(?:The|From|Including|Excluding|Also|See)\s+", "", nm.strip())
                if nm and nm != w["name"] and nm not in also and len(nm.split()) <= 5:
                    also.append(nm)
        if also and w["kind"] != "pointer":
            w["also"] = also
        for r in w.get("reaches", []):
            for ru in r["rules"]:
                for fx in ru["fx"]:
                    if fx.get("except"):
                        m = re.search(r"except at (.+?)\.$", ru["text"])
                        fx["except"] = [x.strip() for x in re.split(r", | and ", m.group(1)) if x.strip()]

    # A span written by hand ("at all other times of the year") is the other side of
    # a span the guidebook prints. So every date in it must be a date that another
    # rule of the same stretch prints; only the hour and a day's step may differ.
    def _pt(x):
        return x if isinstance(x, str) else (x.get("n"), x.get("m"))

    def _when(x, y, end=False):
        """The moment a point stands for; for the end of a span, the first moment after it."""
        from datetime import datetime as _dt, timedelta as _td, date as _d
        if isinstance(x, str):
            m_, d_ = (int(v) for v in x.split("-"))
            return _dt(y, m_, d_) + _td(days=1 if end else 0)
        if x["n"] > 0:
            first = _d(y, x["m"], 1).weekday()
            day = _d(y, x["m"], 1 + (5 - first) % 7 + 7 * (x["n"] - 1))
        else:
            last_ = _d(y + (x["m"] == 12), x["m"] % 12 + 1, 1) - _td(days=1)
            day = last_ - _td(days=(last_.weekday() - 5) % 7)
        day += _td(days=x.get("d", 0))
        if "h" in x:
            return _dt(day.year, day.month, day.day, x["h"])
        return _dt(day.year, day.month, day.day) + _td(days=1 if end else 0)

    for w in waters:
        for r in w.get("reaches", []):
            printed = set(_pt(x) for ru in r.get("rules", []) for fx in ru["fx"] if not fx.get("w_by_hand")
                          for sp_ in (fx.get("w") or fx.get("open") or []) for x in sp_)
            for ru in r.get("rules", []):
                for fx in ru["fx"]:
                    if fx.get("w_by_hand"):
                        theirs = [sp2 for ru2 in r.get("rules", []) for fx2 in ru2["fx"] if not fx2.get("w_by_hand")
                                  for sp2 in (fx2.get("w") or fx2.get("open") or [])]
                        for sp_ in (fx.get("w") or fx.get("open") or []):
                            for x in sp_:
                                if _pt(x) not in printed:
                                    fail(f"{w['name']}: a date written by hand ({x}) is not a date any other rule "
                                         f"of the stretch prints: {ru['text'][:60]!r}")
                            # "At all other times": it must start the moment a printed span
                            # ends and end the moment that span starts. Nothing else.
                            if not any(_when(sp_[0], year) == _when(t_[1], year, True) and _when(sp_[1], year, True) == _when(t_[0], year)
                                       for t_ in theirs):
                                fail(f"{w['name']}: the dates written by hand ({sp_}) are not the rest of the year left by "
                                     f"a span the stretch prints: {ru['text'][:60]!r}")

    # ---- emergency changes: a person's reading, checked against UDWR's own notice
    am = json.load(open(os.path.join(SRC, "amendments.json")))
    npath = os.path.join(DATA, "fishing_notices.json")
    if os.path.exists(npath):
        held = json.load(open(npath))
    else:
        import fishing_notices as FN
        page = urllib.request.urlopen(urllib.request.Request(S.FISHING_REVISIONS["page"], headers=UA), timeout=120).read().decode("utf-8", "ignore")
        held = FN.read(page, S.FISHING_REVISIONS["block_id"], S.FISHING_REVISIONS["notice_path"])
    posted = {n["slug"]: n for n in held.get("notices", [])}
    cache = args[args.index("--notices") + 1] if "--notices" in args else None
    from datetime import timedelta
    amendments, read_in = [], set()
    for a in am["amendments"]:
        tag = f"emergency change {a['name']}"
        n = posted.get(a["notice"])
        if not n:
            fail(f"{tag}: UDWR's list does not carry the notice {a['notice']!r}")
            continue
        read_in.add(a["notice"])
        if (n["name"], n["county"]) != (a["name"], a["county"]):
            fail(f"{tag}: the notice is headed {n['name']!r}, {n['county']!r}")
        if (n["from"], n["until"]) != (a["from"], a["until"]):
            fail(f"{tag}: UDWR's summary gives {n['from']} to {n['until']}, the reading {a['from']} to {a['until']}")
        # the signed notice itself
        try:
            local = os.path.join(cache, a["notice"] + ".pdf") if cache else None
            blob = open(local, "rb").read() if local and os.path.exists(local) else \
                urllib.request.urlopen(urllib.request.Request(n["url"], headers=UA), timeout=120).read()
            pth = os.path.join(book.dir, a["notice"] + ".pdf")
            open(pth, "wb").write(blob)
            signed = run(["pdftotext", "-layout", pth, "-"]).stdout.decode("utf-8", "ignore")
        except Exception as e:                # noqa: BLE001
            fail(f"{tag}: the signed notice could not be read ({e!r})")
            continue
        sha = hashlib.sha256(blob).hexdigest()[:16]
        if n.get("pdf_sha") and n["pdf_sha"] != sha:
            fail(f"{tag}: the signed notice has changed since the daily job first read it")
        flat = squash(signed)
        if norm("NOTICE OF EMERGENCY CHANGE TO THE " + str(year) + " UTAH FISHING GUIDEBOOK") not in norm(flat):
            fail(f"{tag}: the PDF does not read as a notice of emergency change to the {year} guidebook")
        if norm(f"{a['name']} ({a['county']} County)") not in norm(flat):
            fail(f"{tag}: the signed notice does not name {a['name']} ({a['county']} County)")
        dm = re.search(r"effective\s+([A-Z][a-z]+)\.?\s+(\d{1,2}),\s+(20\d\d),?\s+and will remain in effect until\s+([A-Z][a-z]+)\.?\s+(\d{1,2}),\s*(20\d\d)", flat)
        import fishing_notices as FN
        got = (FN.iso(*dm.groups()[:3]), FN.iso(*dm.groups()[3:])) if dm else (None, None)
        if got != (a["from"], a["until"]):
            fail(f"{tag}: the signed notice gives {got[0]} to {got[1]}, the reading {a['from']} to {a['until']}")
        until = date.fromisoformat(a["until"])
        want_last = until - timedelta(days=1) if a["direction"] == "more" else until
        if a["direction"] not in ("more", "less") or a["last_day"] != want_last.isoformat():
            fail(f"{tag}: last_day should be {want_last} for a change that allows {a['direction']}")
        summary = norm(" ".join(t for _, t in n["text"]))
        rules = []
        for r in a["rules"]:
            if norm(r["text"]) not in norm(flat):
                fail(f"{tag}: the signed notice does not say {r['text']!r}")
            if norm(r.get("html_says", r["text"])) not in summary:
                fail(f"{tag}: UDWR's summary does not say {r.get('html_says', r['text'])!r}")
            fx = [dict(f) for f in r["fx"]]
            check_fx(r["text"], fx, tag)
            rules.append({"id": rid(a["notice"], r["text"]), "text": r["text"], "fx": fx})
        if a.get("also") and norm(a["also"]) not in norm(flat):
            fail(f"{tag}: the signed notice does not say {a['also']!r}")
        if norm("All other rules established in the %d Utah Fishing Guidebook remain in effect" % year) not in norm(flat):
            fail(f"{tag}: the notice does not say the other rules remain in effect")
        stands = []
        for st in a.get("stands", []):
            if not in_raw(book, st["text"], st["page"], book.pages):
                fail(f"{tag}: the guidebook does not say {st['text']!r} on page {st['page']}")
            stands.append({"text": st["text"], "page": st["page"], "about": st["about"]})
        rec = {"notice": a["notice"], "url": n["url"], "name": a["name"], "county": a["county"],
               "from": a["from"], "until": a["until"], "last_day": a["last_day"], "direction": a["direction"],
               "rules": rules, "sha": n["sha"], "pdf_sha": sha}
        if a.get("also"):
            rec["also"] = a["also"]
        if stands:
            rec["stands"] = stands
        # what it sits on
        tgt, replaces = a["target"], []
        if tgt.get("water"):
            w = ids.get(tgt["water"])
            if not w or (w["name"], w["counties"]) != (a["name"], [a["county"]]):
                fail(f"{tag}: target {tgt['water']!r} is not {a['name']}, {a['county']} County")
                continue
            pool = {ru["text"]: ru["id"] for r in w.get("reaches", []) for ru in r["rules"]}
            rec["water"] = w["id"]
        elif tgt.get("community"):
            if tgt["community"] not in [m["id"] for m in com["members"]]:
                fail(f"{tag}: {tgt['community']!r} is not a listed community water")
                continue
            pool = {r["text"]: r["id"] for r in com["rules"]}
            rec["community"] = tgt["community"]
        else:
            wid = slug(a["name"], [a["county"]])
            if wid in ids:
                fail(f"{tag}: marked as having no guidebook entry, but {wid!r} exists")
                continue
            base = re.sub(r"\s+(Reservoir|Lake|Pond|Creek|River)$", "", a["name"])
            near = [x["id"] for x in waters if x.get("kind") != "pointer" and re.search(
                r"(?<![A-Za-z])" + re.escape(base) + r"(?![A-Za-z])",
                " ".join([x["name"], x.get("desc", "")] + [r_.get("where", "") for r_ in x.get("reaches", [])]))]
            nw = {"id": wid, "name": a["name"], "counties": [a["county"]], "kind": "notice", "reaches": []}
            if near:
                nw["near"] = near
            waters.append(nw)
            ids[wid] = nw
            pool = {}
            rec["water"] = wid
        for t_ in a["replaces"]:
            if t_ not in pool:
                fail(f"{tag}: it is said to replace a rule the water does not have: {t_!r}")
            else:
                replaces.append(pool[t_])
        rec["replaces"] = replaces
        amendments.append(rec)
    for s_ in posted:
        if s_ not in read_in:
            warn(f"UDWR lists a notice that has not been read in: {posted[s_]['title']}. The app will show it word for word.")
    waters.sort(key=lambda w: (w["name"].lower(), w["counties"]))

    # ---- underwater spearfishing
    # Kept word for word and NOT sorted: the app shows it under its own heading on the
    # waters it names and works nothing out from it. It is here because an emergency
    # change can leave one of these rules standing (Pineview's tiger muskie), and
    # because four of the 2026 changes open a water to spearfishing.
    sp_first, sp_last = find_spear(book)
    spear = parse_spear(book, sp_first, sp_last) if sp_first else []
    names = json.load(open(os.path.join(SRC, "spear_names.json")))
    want = {"Waterbodies open to spearfishing": "open", "Seasonal bass closures": "bass", "Exceptions": "except"}
    if [x["title"] for x in spear] != list(want):
        fail(f"spearfishing: the sections read are {[x['title'] for x in spear]}")
    n_sp, used_names = 0, set()
    for sec in spear:
        sec["id"] = want.get(sec["title"], "other")
        if not sec["intro"] or not in_raw(book, sec["intro"], sec["page"], book.pages):
            fail(f"spearfishing: the introduction to {sec['title']!r} is not in the second reading")
        for e in sec["entries"]:
            key = e["name"] + "|" + ", ".join(e["counties"])
            if key in names:
                used_names.add(key)
                e["water"] = names[key]["water"]
                if e["water"] is not None and e["water"] not in ids:
                    fail(f"spear_names.json sends {key!r} to {e['water']!r}, which the guidebook does not have")
            else:
                hit = [w_ for w_ in waters if w_["name"] == e["name"] and w_["counties"] == e["counties"]]
                if len(hit) == 1:
                    e["water"] = hit[0]["id"]
                else:
                    near_ = [w_["name"] for w_ in waters if e["name"].split()[0] in w_["name"] and set(w_["counties"]) & set(e["counties"])]
                    fail(f"spearfishing: {key!r} matches no entry by whole name and county. Similar: {near_}. "
                         f"Say which in scraper/fishing/spear_names.json (null if it has none).")
                    e["water"] = None
            e["id"] = rid("spear", sec["id"], key)
            for ru in e["rules"]:
                n_sp += 1 + len(ru.get("items", []))
                for piece in [ru["text"]] + ru.get("items", []):
                    if not in_raw(book, piece, ru["page"], book.pages):
                        fail(f"spearfishing, {e['name']} p{ru['page']}: not in the second reading: {piece[:60]!r}")
    for k in names:
        if k not in used_names and not k.startswith("_"):
            fail(f"spear_names.json names {k!r}, which the spearfishing section does not print")
    # Waters named inside an entry's rules. Matched by whole name, never by a name
    # found inside another ("Fish Lake (Weber River drainage)" is not the Weber River).
    inside = {k: v for k, v in names.get("_named", {}).items() if not k.startswith("_")}
    seen_in = set()
    for sec in spear:
        for e in sec["entries"]:
            key = e["name"] + "|" + ", ".join(e["counties"])
            if key not in inside:
                continue
            seen_in.add(key)
            plain_names = [x if isinstance(x, str) else x["n"] for x in inside[key]]
            words = " ".join([ru["text"] + " " + " ".join(ru.get("items", [])) for ru in e["rules"]])
            plain_ = re.sub(r"\s*\([^)]*\)", "", words)
            e["named"] = []
            for it_ in inside[key]:
                nm, qual = (it_, None) if isinstance(it_, str) else (it_["n"], it_.get("q"))
                if not re.search(r"(?<![A-Za-z])" + re.escape(nm) + r"(?![A-Za-z])", plain_):
                    fail(f"spearfishing, {e['name']}: spear_names.json says it names {nm!r}; its rules do not print that")
                printed_q = re.search(re.escape(nm) + r" \(([^)]+)\)", words)
                if (printed_q.group(1) if printed_q else None) != qual:
                    fail(f"spearfishing, {e['name']}: {nm!r} is printed with {printed_q.group(1) if printed_q else 'no words in brackets'}; "
                         f"spear_names.json gives {qual!r}")
                hit = [w_["id"] for w_ in waters if norm(w_["name"]) == norm(nm) and set(w_["counties"]) & set(e["counties"])]
                rec_ = {"n": nm, "w": hit[0] if len(hit) == 1 and not qual else None}
                if qual:
                    rec_["q"] = qual
                e["named"].append(rec_)
            # a printed list ("... the following lakes: A, B and C.") may hold no name that is not here
            for ru in e["rules"]:
                for piece in [ru["text"]] + ru.get("items", []):
                    m_ = re.search(r"(?:following [a-z\- ]+?(?: west of I-15)?): (.+?)\.?$", piece)
                    if m_:
                        got = [re.sub(r"\s*\([^)]*\)", "", x).strip() for x in re.split(r", | and ", m_.group(1)) if x.strip()]
                        # "Smith and Morehouse Reservoir" is one name that holds an "and"
                        joined, k_ = [], 0
                        while k_ < len(got):
                            if k_ + 1 < len(got) and (got[k_] + " and " + got[k_ + 1]) in plain_names:
                                joined.append(got[k_] + " and " + got[k_ + 1]); k_ += 2
                            else:
                                joined.append(got[k_]); k_ += 1
                        lost = [x for x in joined if x not in plain_names]
                        if lost:
                            fail(f"spearfishing, {e['name']}: the printed list names {lost}, which spear_names.json does not hold")
    for k in inside:
        if k not in seen_in:
            fail(f"spear_names.json lists names inside {k!r}, which the spearfishing section does not print")
    if sp_first:
        printed = 0
        for n in range(sp_first, sp_last + 1):
            body = "\n".join(l for l in book.raw(n).splitlines() if not re.search(r"\u2022\s*20\d\d\b|20\d\d\s*\u2022", l))
            printed += body.count("\u2022")
        held_sp = sum((len(ru["items"]) if ru.get("items") else 1) for sec in spear for e in sec["entries"] for ru in e["rules"])
        if printed - hand.get("spear_other_bullets", 0) != held_sp:
            fail(f"spearfishing bullets: pages {sp_first}-{sp_last} print {printed}, of which "
                 f"{hand.get('spear_other_bullets', 0)} are not under a water; {held_sp} are held")

    # What the places are matched against: every entry, its kind and its stretches.
    # The places file records the same figure, and the app will not use one with the
    # other unless they agree.
    # A water known only from an emergency notice is left out, so that reading in a
    # new notice does not orphan the places. The WORDS of each stretch are in, so a
    # guidebook that moves a stretch's end does.
    shape = hashlib.sha1("\n".join(sorted(
        "%s|%s|%s|%s" % (w["id"], w["kind"], norm(w.get("desc") or ""),
                         ",".join("%s=%s" % (r.get("key") or "", norm(r.get("where") or "")) for r in w.get("reaches", [])))
        for w in waters if w["kind"] != "notice") +
        sorted("community:" + m["id"] for m in com["members"])).encode("utf-8")).hexdigest()[:16]
    # The general rules of the spearfishing section, quoted by hand like the other
    # general rules and checked the same way. One of them names two waters.
    for g in general:
        for w_ in g.get("waters", []):
            if w_ not in ids or ids[w_].get("kind") == "pointer":
                fail(f"statewide rule {g['id']!r} names {w_!r}, which is not an entry of the guidebook")
    spear_general = []
    for g in hand.get("spear_general", []):
        pieces = [g["text"]] + g.get("items", [])
        for k_, piece in enumerate(pieces):
            if not in_raw(book, piece, g["page"], book.pages):
                fail(f"spearfishing rule {g['id']!r}: not found on page {g['page']}: {piece[:60]!r}")
            tail = exception_follows(book, piece, g["page"])
            if tail and held_next(tail, piece, g["page"]):
                tail = None
            if tail and not g.get("ends_ok"):
                fail(f"spearfishing rule {g['id']!r} stops short of what is printed next: ...{tail[:110]!r}. "
                     f"Read on in the guidebook. Quote it too, or set ends_ok and say why in ends_why.")
        if g.get("ends_ok") and len(g.get("ends_why", "")) < 20:
            fail(f"spearfishing rule {g['id']!r} is marked ends_ok and does not say why")
        for w_ in g.get("waters", []):
            if w_ not in ids:
                fail(f"spearfishing rule {g['id']!r} names {w_!r}, which the guidebook does not have")
        rec = {k: g[k] for k in ("id", "head", "page", "text", "items", "waters") if g.get(k)}
        spear_general.append(rec)
    if sp_first and not spear_general:
        fail("the spearfishing section was read and its general rules are missing from statewide.json")

    out = {
        "_shape": shape,
        "_notices_sha": held.get("sha"),
        "_notices_other": [t for _, t in held.get("other", [])],
        "_edition": {"title": title, "year": year, "from": f"{year}-01-01", "to": f"{year}-12-31",
                     "pdf": S.PDFS["fishing"], "sha": book.sha, "bytes": len(book.blob),
                     "pdf_modified": book.info.get("ModDate", ""), "built": date.today().isoformat(),
                     "pages": {"statewide": hand["page"], "waters": [first, last], "community": box}},
        "_note": "Wording is UDWR's, lifted from the guidebook PDF and checked against a second reading of "
                 "the same pages. The index beside each rule (fx) only sorts it; it is never the authority. "
                 "Not legal advice - the guidebook and UDWR's posted changes govern.",
        "_topics": list(TOPICS),
        "rows": [{"row": l["row"], "name": l["name"]} for l in limits],
        "statewide": {"page": hand["page"], "limits": limits, "rules": general},
        "waters": waters,
        "community": com,
        "amendments": amendments,
        "spear": {"pages": [sp_first, sp_last], "general": spear_general, "sections": spear},
    }
    stats = {"entries": len(waters), "pointers": sum(1 for w in waters if w["kind"] == "pointer"),
             "rules": n_rules, "distinct": len(by_text), "by_hand": sum(1 for t in by_text if t in over),
             "community": len(com["members"]), "statewide_rows": len(limits), "statewide_rules": len(general),
             "amendments": len(amendments), "waters_known_only_by_notice": sum(1 for w in waters if w["kind"] == "notice"),
             "spear_waters": sum(len(x["entries"]) for x in spear),
             "hyphens_kept": sorted(set(h[1] for h in HYPHENS if h[0] == "kept")), "by_text": by_text}
    return finish(out, stats)


def finish(out, stats=None):
    for n in NOTE:
        print("  note:", n)
    for w in WARN:
        print("  WARN:", w)
    for f in FAIL:
        print("  FAIL:", f)
    if stats:
        bt = stats.pop("by_text")
        print("  " + ", ".join(f"{k}={v}" for k, v in stats.items() if k != "hyphens_kept"))
        print("  hyphens kept:", ", ".join(stats["hyphens_kept"]))
        if "--table" in sys.argv:
            for t, fx in sorted(bt.items(), key=lambda kv: (kv[1][0].get("t", ""), kv[0])):
                print(f"    {json.dumps(fx, ensure_ascii=False)}  <=  {t}")
    if FAIL or out is None:
        print(f"NOT WRITTEN: {len(FAIL)} check(s) failed. {OUT} is unchanged.")
        return 1
    json.dump(out, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
    print(f"wrote {OUT}: {os.path.getsize(OUT) // 1024} KB, guidebook sha {out['_edition']['sha']}")
    places = os.path.join(DATA, "fishing_places.json")
    if os.path.exists(places) and json.load(open(places)).get("_rules_shape") != out["_shape"]:
        print("  THE PLACES MUST BE REBUILT NOW: the entries or their stretches have changed, and the phone will")
        print("  not match places to rules until they agree.   python3 scraper/build_fishing_places.py --cached")
    return 0


if __name__ == "__main__":
    sys.exit(main())
