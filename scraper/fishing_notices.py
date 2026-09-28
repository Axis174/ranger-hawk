"""Read UDWR's list of emergency changes to the fishing guidebook.

UDWR amends the fishing guidebook mid-year by signed notice and never folds the
change into the PDF. The notices are listed under "Revisions" beside the Fishing
Guidebook on wildlife.utah.gov/guidebooks. This module only READS that list and
keeps UDWR's own words. It does not decide what a notice means: that is done by a
person, in scraper/fishing/amendments.json, and until it has been done the app
shows the notice word for word and says it has not been built into the rules.

How it avoids missing one. The list is read as a run of lines, whatever tags UDWR
wraps them in. ANY link to a PDF starts a notice: a paragraph, a list item, a
table cell, a link in single quotes or in another folder. So does any line that
opens the way UDWR heads a notice, "Name (Some County):", with no link at all, so
that a notice posted without its PDF is not folded into the one above it.
Everything else in the block is kept as "other". Text that is struck through is
marked as struck. And the whole block is hashed with every character kept, so an
edit the reader could not make sense of, down to one digit or a fraction, still
changes the figure the app compares.

Standard library only, so the daily job cannot break on a package upgrade.
"""
import hashlib, re
from html.parser import HTMLParser

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"])}
MONTHS.update({"jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
               "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12})
DAY = r"([A-Z][a-z]+)\.?\s+(\d{1,2}),\s+(20\d\d)"
BLOCKS = {"p", "li", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "dd", "dt",
          "blockquote", "section", "article", "ul", "ol", "table", "details", "summary"}
HEADS = {"h1", "h2", "h3", "h4", "h5", "h6"}


def iso(m, d, y):
    n = MONTHS.get(m.lower().rstrip("."))
    return "%04d-%02d-%02d" % (int(y), n, int(d)) if n else None


def tidy(s):
    return re.sub(r"\s+", " ", s.replace("\u00a0", " ")).strip()


def digest(s):
    """Every character counts: "4.0" is not "40" and a half is not a quarter. Only
    the spacing is evened out, so that a reflowed page is not read as a rewording."""
    return hashlib.sha256(tidy(s).encode("utf-8")).hexdigest()[:16]


HEADED = re.compile(r"^(?:\[struck through\] )?(.{3,90}?)(?: \(([^()]*?)\s+(?:[Cc]ount(?:y|ies)|[Cc]o\.?)\)|,? \(?([A-Z][a-z]+(?: [A-Z][a-z]+)?) [Cc]ounty\)?)\s*:")
GENERIC = re.compile(r"^\(?\s*(?:pdf|here|notice|signed notice|download|link|read more|more)\s*\)?$", re.I)
STRUCK = {"del", "s", "strike"}


def block(page, block_id):
    """The inside of the element with id=block_id, found by counting nested tags of
    its own kind. The id may be quoted either way, or not at all."""
    m = re.search(r"<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bid\s*=\s*(?:\"%s\"|'%s'|%s(?=[\s>]))[^>]*>"
                  % ((re.escape(block_id),) * 3), page)
    if not m:
        return None
    tag, depth, i = m.group(1).lower(), 1, m.end()
    for t in re.finditer(r"<(/?)%s\b[^>]*>" % re.escape(tag), page[m.end():], re.I):
        depth += -1 if t.group(1) else 1
        if depth == 0:
            return page[i:m.end() + t.start()]
    return None


class Lines(HTMLParser):
    """The block as a run of lines: [{"tag", "txt", "links": [[href, text]], "bold": [..]}]."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lines, self.cur, self.a, self.b = [], None, None, None
        self.open_struck = []                 # tags that opened struck-through text

    def line(self, tag="p"):
        if self.cur is None:
            # a line that begins inside struck-through text says so itself
            self.cur = {"tag": tag, "txt": "[struck through] " if self.open_struck else "", "links": [], "bold": []}
        return self.cur

    def flush(self):
        if self.cur is not None:
            self.cur["raw"] = self.cur["txt"]          # link offsets count in this, untidied
            self.cur["txt"] = tidy(self.cur["txt"])
            if self.cur["txt"]:
                self.lines.append(self.cur)
        self.cur = None

    def handle_starttag(self, tag, attrs):
        style = (dict(attrs).get("style") or "").replace(" ", "").lower()
        klass = (dict(attrs).get("class") or "").lower()
        if tag in STRUCK or "line-through" in style or re.search(r"line-through|strike|struck|deleted|withdrawn", klass):
            self.open_struck.append(tag)
            if self.cur is not None and self.cur["txt"].strip() and tag not in BLOCKS:
                self.cur["txt"] += " [struck through: "
            elif self.cur is not None and not self.cur["txt"].strip():
                self.cur = None                   # nothing but spacing so far: let the next line say it
        if tag in BLOCKS:
            self.flush()
            self.line("h" if tag in HEADS else "li" if tag == "li" else "p")
        elif tag == "br":
            self.line()["txt"] += " "
        elif tag == "a":
            self.a = [dict(attrs).get("href") or "", "", len(self.line()["txt"])]
        elif tag in ("strong", "b"):
            self.b = ""

    def handle_endtag(self, tag):
        if self.open_struck and self.open_struck[-1] == tag:
            self.open_struck.pop()
            if self.cur is not None and "[struck through: " in self.cur["txt"]:
                self.cur["txt"] += "] "
        if tag in BLOCKS:
            self.flush()
        elif tag == "a" and self.a is not None:
            self.line()["links"].append([self.a[0].strip(), tidy(self.a[1]), self.a[2]])
            self.a = None
        elif tag in ("strong", "b") and self.b is not None:
            if tidy(self.b):
                self.line()["bold"].append(tidy(self.b))
            self.b = None

    def handle_data(self, data):
        self.line()["txt"] += data
        if self.a is not None:
            self.a[1] += data
        if self.b is not None:
            self.b += data


def pdfs_of(links):
    """Every link to a PDF on the line: (href, slug, link text, where in the line it starts)."""
    out = []
    for href, text, at in links:
        m = re.match(r"(.*?/)?([^/?#]+?)\.pdf(?:[?#].*)?$", href, re.I)
        if m and m.group(2) not in [o[1] for o in out]:
            out.append((href, m.group(2), text, at))
    return out


def split_line(ln):
    """One line, or, where a paragraph holds two notices run together, one line for each."""
    hits = pdfs_of(ln["links"])
    if len(hits) < 2:
        return [ln]
    raw, out = ln["raw"], []
    cuts = [0] + [h[3] for h in hits[1:]] + [len(raw)]
    for k_, h in enumerate(hits):
        out.append({"tag": ln["tag"], "txt": tidy(raw[cuts[k_]:cuts[k_ + 1]]), "raw": raw[cuts[k_]:cuts[k_ + 1]],
                    "links": [l for l in ln["links"] if cuts[k_] <= l[2] < cuts[k_ + 1]], "bold": ln["bold"] if k_ == 0 else []})
    return [o for o in out if o["txt"]]


def read(page, block_id, notice_path, base="https://wildlife.utah.gov"):
    """-> {"ok", "error", "sha", "notices": [...], "other": [...]}"""
    inner = block(page, block_id)
    if inner is None:
        return {"ok": False, "error": "the Revisions block was not found on the page", "notices": [], "other": []}
    px = Lines()
    try:
        px.feed(inner)
        px.close()
        px.flush()
    except Exception as e:                # noqa: BLE001
        return {"ok": False, "error": "the Revisions block could not be read: %r" % (e,), "notices": [], "other": []}
    def full(href):
        if href.startswith("//"):
            return "https:" + href
        return href if re.match(r"https?://", href) else base + (href if href.startswith("/") else "/" + href)

    notices, other, cur, seen = [], [], None, set()
    by_slug = {}
    for ln in [part for l_ in px.lines for part in split_line(l_)]:
        tag, txt = ln["tag"], ln["txt"]
        hits = [] if tag == "h" else pdfs_of(ln["links"])
        hit = hits[0][:3] if hits else None
        head = None if tag == "h" else HEADED.match(txt)
        if hit and hit[1] in seen and not head:
            # A line that points at a notice already listed is about THAT notice, wherever
            # on the page it stands. It is added to it, so that notice reads as reworded.
            by_slug[hit[1]]["text"].append([tag, txt])
            by_slug[hit[1]]["bold"] += ln["bold"]
            continue
        if hit and hit[1] not in seen:
            href, slug, atext = hit
            seen.add(slug)
            title = (atext or "").rstrip(":").strip()
            if not title or GENERIC.match(title):       # the link says "PDF": the name is in the line
                title = (head.group(0).rstrip(": ") if head else (ln["bold"][0] if ln["bold"] else txt.split(":")[0])).strip()
            tm = re.match(r"(.+?)\s*\(([^)]+?) Count(?:y|ies)\)\s*$", title)
            cur = {"slug": slug, "url": full(href), "title": title,
                   "name": tm.group(1).strip() if tm else title, "county": tm.group(2).strip() if tm else "",
                   "text": [["p", txt]], "bold": list(ln["bold"])}
            if notice_path not in href:
                cur["odd_path"] = True             # a PDF, but not where the notices are kept
            notices.append(cur)
            by_slug[slug] = cur
            continue
        if head:
            # Headed like a notice and carrying no PDF. It is a notice of its own.
            title = head.group(0).rstrip(": ").strip()
            slug = "nopdf-" + re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            if slug not in seen:
                seen.add(slug)
                links = [l[0] for l in ln["links"] if l[0]]
                cur = {"slug": slug, "url": full(links[0]) if links else base + "/guidebooks", "title": title,
                       "name": head.group(1).strip(), "county": (head.group(2) or head.group(3) or "").strip(),
                       "text": [["p", txt]], "bold": list(ln["bold"]), "no_pdf": True}
                notices.append(cur)
                continue
        if tag == "h" or re.match(r"All other rules established", txt):
            cur = None
            other.append([tag, txt])
            continue
        if cur is None:
            other.append([tag, txt])
        else:
            cur["text"].append([tag, txt])
            cur["bold"] += ln["bold"]
    for n in notices:
        whole = " ".join(t for _, t in n["text"])
        m = re.search(r"went into effect (?:on )?" + DAY + r",?\s+and will remain in effect until " + DAY, whole)
        n["from"] = iso(*m.groups()[:3]) if m else None
        n["until"] = iso(*m.groups()[3:]) if m else None
        n["bold"] = [b for b in n["bold"] if b and not b.lower().startswith("important")]
        n["sha"] = digest(whole)
    whole = " ".join(t for ln in px.lines for t in [ln["txt"]] + [l[0] for l in ln["links"]])
    return {"ok": True, "error": None, "sha": digest(whole), "notices": notices, "other": other}
