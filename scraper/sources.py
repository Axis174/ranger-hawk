"""Source registry. Everything the refresh job pulls, in one place.

Rules of the road:
  * Only official / public / API-sanctioned sources.
  * No social-media scraping. Facebook and Instagram are auth-walled and their
    terms forbid it; anything built on them breaks in weeks and risks the account.
    Reddit has a real API and most forums publish RSS - those are used instead.
"""

ARCGIS = {
    # --- bird access -------------------------------------------------------
    "wia_properties": {
        "url": "https://utility.arcgis.com/usrsvcs/servers/b995a06c0c564425bb2e66cdf196cc01"
               "/rest/services/ram/ram_WIA_PROD_v2/MapServer/1",
        "desc": "Walk-In Access properties (all, statewide)",
        "watch": ["PrimaryPurpose", "SeasonalClosure", "SpecialRestrict", "Status"],
    },
    "pheasant_release": {
        "url": "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
               "/2026_Pheasant_Release_Areas_view/FeatureServer/0",
        "desc": "Current-season pheasant release sites",
        "watch": ["Location", "Hunt", "Region"],
        "note": "Layer name carries the year - the refresh job probes for a newer year.",
    },
    "dwr_properties": {
        "url": "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
               "/ULTRA_Properties_2_view/FeatureServer/0",
        "desc": "All DWR public-access properties (WMAs, waterfowl MAs, hunter access)",
        "watch": ["closureDates", "restrictions", "licenseRequiredType", "accessType"],
    },
    "cha_boundaries": {
        "url": "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
               "/CHA_Boundaries(Public)/FeatureServer/0",
        "desc": "Commercial hunting areas",
        "watch": ["Status", "Pub_Phone", "Pub_Website", "Pub_Season"],
    },
    # --- big game ----------------------------------------------------------
    "big_game_units": {
        "url": "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
               "/Utah_Big_Game_Hunt_Boundaries_2025/FeatureServer/0",
        "desc": "Big game hunt unit boundaries",
        "year_probe": "Utah_Big_Game_Hunt_Boundaries_{year}/FeatureServer/0",
        "note": "The 2026-named service exists but publishes no layers (checked 2026-09-20); 2025 is the live one. The refresh job probes each year for a real replacement.",
        "watch": ["Boundary_Name", "Description"],
        "geometry": False,
    },
    "cwmu": {
        "url": "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services"
               "/LOA_2024_gdb/FeatureServer/0",
        "desc": "Landowner association boundaries",
        "watch": [],
        "optional": True,
        "geometry": False,  # 14 features but 2 MB of polygon - we only need the names
    },
}

# USGS Ungulate Migrations of the Western United States, Volume 1.
# Verified Utah coverage 2026-09-20: 278 elk routes, 111 mule deer routes,
# 56 mule deer corridors, 47 mule deer winter-range polygons inside the Utah bbox.
MIGRATION_BASE = ("https://services1.arcgis.com/754BERmVIq3RqSf8/arcgis/rest/services"
                  "/Ungulate_Migrations_of_the_Western_United_States_Volume_1/FeatureServer")
MIGRATION_LAYERS = {
    "elk_routes": 1,
    "mule_deer_routes": 6,
    "mule_deer_corridors": 8,
    "mule_deer_winter_range": 9,
}
UTAH_BBOX = "-114.1,36.9,-109.0,42.1"

# UDOT's traffic API. Every endpoint needs a free developer key passed as ?key=,
# so with no key in the environment the scraper skips this block entirely rather
# than failing the run. Throttle is ten calls per 60 seconds; we make four.
UDOT_API = "https://www.udottraffic.utah.gov/api/v2/get"
UDOT_ENDPOINTS = ["cameras", "weatherstations", "roadconditions", "mountainpasses"]

# PDFs watched for change. We hash them; a changed hash means UDWR reissued the
# book and the season tables need a human read.
PDFS = {
    "waterfowl_upland_turkey": "https://wildlife.utah.gov/guidebooks/waterfowl-upland-game-turkey-guidebook.pdf",
    "big_game_field_regs":     "https://wildlife.utah.gov/guidebooks/field_regs.pdf",
    "big_game_application":    "https://wildlife.utah.gov/guidebooks/biggameapp.pdf",
    # Fishing runs on a calendar year, Jan. 1-Dec. 31, and UDWR swaps the file at
    # this same address when the next year's book comes out. The app compares this
    # hash with the one docs/data/fishing_rules.json was built from and says so on
    # the phone when they differ.
    "fishing":                 "https://wildlife.utah.gov/guidebooks/fishing_guidebook.pdf",
}

# Emergency changes to the fishing guidebook. UDWR never folds these into the PDF:
# each is a signed notice listed under "Revisions" beside the Fishing Guidebook on
# the guidebooks page (nine of them in 2026 by September). So the PDF hash above
# cannot see them, and this block is read on its own every day.
FISHING_REVISIONS = {
    "page": "https://wildlife.utah.gov/guidebooks",
    "block_id": "contentguidebookFishingRevisions",
    "notice_path": "/pdf/guidebooks/emergency-changes/",
}

# Pages scanned for the 2027 application window announcement.
WATCH_PAGES = {
    "biggame":   "https://wildlife.utah.gov/biggame",
    "news":      "https://wildlife.utah.gov/news",
    "walkin":    "https://wildlife.utah.gov/walkinaccess",
    "uplandgame":"https://wildlife.utah.gov/uplandgame",
}

# Community sources. Public, API-sanctioned or RSS only.
REDDIT_RSS = "https://www.reddit.com/r/{sub}/new/.rss?limit=100"
# (community, filter): "utah" keeps posts naming a Utah place; "hunt" keeps posts
# with a hunting word. r/utahhunting was dropped - its only post is from 2022.
REDDIT_FEEDS = [("Hunting", "utah"), ("elkhunting", "utah"), ("bowhunting", "utah"),
                ("Waterfowl", "utah"), ("Utah", "hunt"), ("SaltLakeCity", "hunt")]
REDDIT_HUNT_TERMS = ["hunt", "elk", "mule deer", "deer tag", "pheasant", "chukar", "duck season",
                     "waterfowl", "ptarmigan", "grouse", "dwr", "wma", "draw results",
                     "archery season", "muzzleloader", "shed antler", "big game"]
REDDIT_SKIP = ["lounge", "megathread", "weekly thread", "daily thread"]
REDDIT_TERMS = ["utah", "wasatch", "uinta", "uintas", "boulder mountain", "fishlake",
                "thousand lakes", "manti", "book cliffs", "henry mountains", "bear river",
                "farmington bay", "ogden bay", "great salt lake", "strawberry reservoir",
                "udwr", "utah dwr"]
# UDWR advertises an RSS endpoint but it serves the HTML page, not a feed
# (checked 2026-09-20). So the news listing is parsed directly - a public page,
# no auth wall, light polling once a day.
NEWS_PAGES = {
    "UDWR news": "https://wildlife.utah.gov/news",
}
NEWS_TERMS = ["hunt", "deer", "elk", "pheasant", "chukar", "waterfowl", "duck",
              "upland", "permit", "draw", "application", "season", "walk-in",
              "wma", "migration", "ptarmigan", "turkey", "antlerless", "board"]
# Checked by hand, not scraped - kept here so the app can link them.
MANUAL_WATCH = [
    {"name": "Utah Wildlife Network forum - Upland Game",  "url": "https://www.utahwildlife.net/forums/upland-game.16/"},
    {"name": "Utah Wildlife Network forum - Waterfowl",    "url": "https://www.utahwildlife.net/forums/waterfowl.15/"},
    {"name": "Utah Wildlife Network forum - Big Game",     "url": "https://www.utahwildlife.net/forums/big-game.13/"},
    {"name": "UDWR Hunt Planner",                          "url": "https://hunt.utah.gov/"},
    {"name": "Utah Wildlife Migration Initiative",         "url": "https://wildlife.utah.gov/wildlife-migration-initiative.html"},
    {"name": "UGRC land ownership (check before you park)","url": "https://gis.trustlands.utah.gov/mapping/"},
]


# Great Salt Lake gauges (USGS). South arm is the one that matters for the
# Davis / Weber / Box Elder marshes; north arm is cut off by the railroad causeway.
LAKE_SITES = {
    "10010000": "Great Salt Lake, south arm (Saltair)",
    "10010100": "Great Salt Lake, north arm (Saline)",
}
LAKE_REFERENCE = {
    "record_low_ft": 4188.5,
    "record_low_when": "November 2022, south arm",
    "note": "State managers describe roughly 4,198-4,205 ft as the healthy range. "
            "Reference figures are hand-kept; confirm at water.utah.gov before relying on them.",
}


# NRCS SNOTEL snow gauges (public domain, keyless). Snow depth tells you whether
# the high country is still reachable: Trial Lake sits beside the Mirror Lake
# Highway, which is the ptarmigan access road and closes for winter.
SNOTEL = {
    "828:UT:SNTL": {"name": "Trial Lake", "where": "Uintas, Mirror Lake Hwy", "elev_ft": 9970},
    "763:UT:SNTL": {"name": "Smith and Morehouse", "where": "Upper Weber, west Uintas", "elev_ft": 7600},
    "820:UT:SNTL": {"name": "Timpanogos Divide", "where": "Wasatch above Heber", "elev_ft": 8140},
    "452:UT:SNTL": {"name": "Donkey Reservoir", "where": "Boulder Mountain above Torrey", "elev_ft": 9800},
}
