"""Evidence normalization — deterministic cleanup of whatever the tools
returned, into one canonical shape. Budget always ends up as an integer
number of INR (never a mix of raw rupees/lakhs/crores internally); BHK
naming, possession, developer/project names, and amenity casing are all
normalized here so the deduplicator and scorer downstream never have to
guess whether "2bhk" and "2 BHK" are the same thing.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from .query_understanding import _known_gazetteer_terms, extract_configuration, extract_locations, extract_possession
from .gazetteer import resolve_location
from .state import EvidenceItem, NormalizedProperty


def normalize_configuration(evidence: EvidenceItem) -> list[str]:
    cfg = evidence.get("configuration") or []
    if isinstance(cfg, str):
        cfg = [cfg]
    out = []
    for c in cfg:
        m = re.search(r"(\d+)\s*bhk", str(c), re.IGNORECASE)
        if m:
            out.append(f"{m.group(1)} BHK")
        elif str(c).strip():
            out.append(str(c).strip())
    if not out:
        # Fall back to extracting from title/description text — a listing
        # title like "2 BHK Flats for Rent in Liberty Garden" often carries
        # the configuration even when the connector's own field is empty.
        text = f"{evidence.get('title', '')} {evidence.get('description', '')}"
        found = extract_configuration(text)
        if found:
            out.append(found)
    seen = []
    for c in out:
        if c not in seen:
            seen.append(c)
    return seen


def normalize_possession_year(evidence: EvidenceItem) -> tuple[int | None, str | None]:
    raw = evidence.get("possession") or ""
    if not raw:
        text = f"{evidence.get('title', '')} {evidence.get('description', '')}"
        raw = extract_possession(text)
    if not raw:
        return None, None
    if re.search(r"ready", raw, re.IGNORECASE):
        return datetime.now(timezone.utc).year, "Ready to Move"
    m = re.search(r"20\d\d", raw)
    return (int(m.group(0)) if m else None), (raw or None)


def normalize_price(evidence: EvidenceItem) -> tuple[int | None, int | None, str | None]:
    price = evidence.get("price") or {}
    min_inr, max_inr, display = price.get("min_inr"), price.get("max_inr"), price.get("display")
    if min_inr is None and max_inr is None:
        text = f"{evidence.get('title', '')} {evidence.get('description', '')}"
        cr = re.search(r"(\d+\.?\d*)\s*(?:cr|crore)", text, re.IGNORECASE)
        if cr:
            max_inr = round(float(cr.group(1)) * 1e7)
            display = display or f"₹{cr.group(1)} Cr"
        else:
            lakh = re.search(r"(\d+\.?\d*)\s*(?:l|lakh|lakhs)\b", text, re.IGNORECASE)
            if lakh:
                max_inr = round(float(lakh.group(1)) * 1e5)
                display = display or f"₹{lakh.group(1)}L"
    return min_inr, max_inr, display


def normalize_project_name(name: str) -> str:
    n = re.sub(r"\s+", " ", name or "").strip()
    # Strip common listing-title noise ("| 99acres", "- Housing.com", a
    # leading result count like "37+ Flats for Sale in ...") so the same
    # project isn't seen as a different name per source purely due to
    # portal-specific title formatting — this directly feeds the
    # deduplicator's name-matching key.
    n = re.sub(r"\s*[\|\-–]\s*(99acres|magicbricks|housing\.com|makaan).*$", "", n, flags=re.IGNORECASE)
    n = re.sub(r"^\d+\+?\s+", "", n)
    return n.strip()


def normalize_location(evidence: EvidenceItem) -> str | None:
    loc = (evidence.get("location") or "").strip()
    # Same bug as the name side (see SOCIAL_PLATFORM_BARE_NAME_RE below,
    # which is defined later in this module) — a location field literally
    # equal to the source platform's own name ("Instagram") is metadata
    # leakage, not a real locality. Checked by value here rather than
    # importing the regex from further down the file (defined after this
    # function) — kept as its own tiny local check to avoid a forward
    # reference; same word list either way.
    if loc and loc.strip().lower() in {"instagram", "facebook", "twitter", "x", "pinterest", "threads", "youtube", "tiktok", "linkedin", "snapchat"}:
        loc = ""
    if loc:
        return loc
    # Portal/web-search snippets often carry the locality in the TITLE
    # ("2 BHK Flats in Liberty Garden, Malad West") even when the connector
    # has no structured location field — fall back to the same
    # deterministic location extraction the query parser uses. Title only,
    # deliberately NOT description: a listing's description/snippet often
    # namedrops OTHER nearby areas as marketing copy ("...similar options
    # in Kandivali, Borivali..."), and the gazetteer-scan tier finding one
    # of those alongside the real title locality would incorrectly credit
    # this property with being IN that other area too — confirmed live
    # (a "2 BHK Flats in Andheri East" result was scoring an "exact match"
    # for a Borivali East search purely because its description happened
    # to mention Borivali East in passing).
    found = extract_locations(evidence.get("title", ""))
    return ", ".join(found) if found else None


# The Location Map / Nearby Infrastructure / Location Quality Score /
# Competing Projects cascade (ProjectIntelligence.jsx's NearbyMap) needs a
# CITY to build a geocodable fallback query when the exact project name
# doesn't resolve on its own — confirmed live: a property whose only location
# term was "Daulat Nagar" (a real Borivali East pocket not in the gazetteer)
# had NO city at all anywhere in the API response, because this field was
# hardcoded None here and never populated by anything downstream. The
# fallback query ended up being just "Daulat Nagar" with zero city/state
# context — essentially ungeocodable — which is why all four of those cards
# failed together despite the underlying locality being perfectly real.
#
# A single extracted term is often NOT itself in the gazetteer (a small
# pocket like "Daulat Nagar" isn't), but a query/title naming multiple
# localities together ("Daulat Nagar, Borivali East") usually has at least
# ONE recognizable one — so this tries every extracted location term via the
# same resolve_location() scoring.py already uses for alias expansion, and
# takes the first real city match. Returns None (never a guess) if nothing
# resolves — an honest "no city known" is correct in that case, not a bug.
def derive_city(location_str: str | None) -> str | None:
    if not location_str:
        return None
    terms = [t.strip() for t in location_str.split(",") if t.strip()]
    for t in terms:
        resolved = resolve_location(t)
        if resolved.get("city"):
            return resolved["city"]
    return None


# Same core signal scoring.cjs's scoreExternalQualityPts already uses for AI
# Search — an obvious info/aggregator page marker (map/rates/photos/video/
# overview) is always disqualifying.
AGGREGATOR_MARKER_RE = re.compile(r"\bmap\b|property rates|photos\s*&?\s*video|video tour|: overview|complete guide|how to buy|buying guide|\bguide\b", re.IGNORECASE)

# Portal category/search-results-page title shapes: "BHK Flats in X", "Flats
# for Rent/Sale in X", "Resale Flats in X", "New Projects in X" — a real
# project's own title doesn't open this way. Ported directly from
# scoring.cjs's isAggregatorTitle() after a live production sample (a
# Daulat Nagar/Borivali East search) showed this Python side missing every
# one of these common real-world shapes.
PORTAL_CATEGORY_TITLE_RE = re.compile(
    r"^\s*(\d+\+?\s*)?(bhk\s*)?([/\s]*(flats?|apartments?|propert(y|ies)|resale(\s+flats?)?|new\s+projects?|projects?|houses?|rooms?|bedroom))+\b.{0,50}\b(in|for\s+sale|for\s+rent|near)\b",
    re.IGNORECASE,
)
# Trailing "N+ Properties/Flats/Apartments" count, with or without a
# preceding preposition (e.g. "...Borivali East – 16+ Properties").
TRAILING_COUNT_RE = re.compile(r"\d+\+?\s*(propert(y|ies)|flats?|apartments?)\s*$", re.IGNORECASE)

# A portal CATEGORY page ("14+ Apartments for Sale in Liberty Garden",
# "Flats in X for Sale Below 2 Crore") never names an actual project/
# building — only generic real-estate words + a locality. A genuine listing
# ALWAYS has something distinctive left over once locality names and filler
# words are stripped ("...for sale in Sheth Irene Liberty Garden" leaves
# "Sheth Irene" behind). This is what actually separates the two, rather
# than a specific phrase pattern that a real listing's title could also
# happen to match.
#
# CAUTION, found live: this heuristic's accuracy depends entirely on the
# gazetteer's coverage — "Daulat Nagar" (a real Borivali East pocket NOT in
# mmr-gazetteer.json) survived this strip untouched, so the leftover check
# saw ["Daulat", "Nagar"] and concluded (wrongly) that the title named a
# real project. PORTAL_CATEGORY_TITLE_RE/TRAILING_COUNT_RE/
# is_bare_locality_title() below are independent, gazetteer-agnostic checks
# that don't share this failure mode — kept as an additional net for
# genuinely different phrasing this narrower heuristic still catches.
GENERIC_FILLER_WORDS = {
    "bhk", "flat", "flats", "apartment", "apartments", "property", "properties",
    "house", "houses", "for", "sale", "rent", "in", "near", "below", "resale",
    "bedroom", "luxury", "budget", "cr", "crore", "l", "lakh", "lakhs", "and", "the",
}

# A bare "Locality, Sub-locality, City" title with no real-estate noun, no
# price, no BHK count, and no "By <Developer>"-style brand marker at all —
# reads as a locality landing page, not a specific property. Deliberately
# does NOT require the segments to be known gazetteer terms (that's exactly
# what made the earlier check miss "Daulat Nagar, Borivali East, Mumbai") —
# it's a structural check: short, comma-separated, Title Case, nothing else.
def is_bare_locality_title(title: str) -> bool:
    if re.search(r"\d|bhk|₹|\$|by\s+[A-Z]", title, re.IGNORECASE):
        return False  # has a price/BHK/developer-credit marker — a real listing signal
    segs = [s.strip() for s in title.split(",") if s.strip()]
    if len(segs) < 2 or len(segs) > 4:
        return False
    return all(re.match(r"^[A-Z][a-zA-Z\s]+$", s) for s in segs)


# A locality-GUIDE page ("Daulat Nagar is a affordable locality situated in
# Mumbai. The pincode of this locality is 400066. This locality is near
# Shantivan...") is a fundamentally different non-listing shape than a
# portal category page — it's not even trying to look like a property
# listing, it's a neighborhood-info page a search happened to surface for a
# locality name. Confirmed live: this passed every title-based check (the
# title itself, "Daulat Nagar, Borivali East – Property in Mumbai", doesn't
# match any of the category-page shapes above), but the DESCRIPTION content
# is unmistakable — these boilerplate phrases only ever appear on
# locality-guide pages, never in an actual project's own description.
LOCALITY_GUIDE_DESCRIPTION_RE = re.compile(
    r"is an?\s+\w*\s*locality situated in|pincode of this locality|this locality is near",
    re.IGNORECASE,
)


# ── Candidate eligibility classifier (Part P0.3/P0.4) ───────────────────────
# A hard gate: only INDIVIDUAL_LISTING/INDIVIDUAL_PROJECT may ever become a
# ranked property card. Everything else (category/search-results/collection
# pages, developer directories, social posts) can still be DISCOVERY
# evidence — it can surface a real project's name, contribute a URL — but
# is never itself scored/ranked as if it were the property.
#
# Multiple independent signals, not one regex (explicit brief requirement)
# — a title/URL/description each get their own check, and the FIRST signal
# that fires wins; a genuine listing must survive every one of them.

# "Page 3 - RERA registered Projects in Malad West, Mumbai" is exactly the
# live bug this classifier exists to catch: PORTAL_CATEGORY_TITLE_RE below
# is anchored at the START of the title (`^\s*...`), so a "Page 3 - " (or
# any other) PREFIX before the real category-page language made it slip
# through untouched — the anchored check simply never got to see the
# "...Projects in Malad West" part. These two are deliberately NOT
# anchored, so a pagination/category phrase anywhere in the title still
# counts, prefix or not.
PAGINATION_PREFIX_RE = re.compile(r"^\s*page\s+\d+\b", re.IGNORECASE)
PAGINATION_URL_RE = re.compile(r"[?&]page=\d+|/page/\d+|/p\d+(?:/|$)", re.IGNORECASE)
# "Projects in <Place>", "New Projects in <Place>", "...registered Projects
# in <Place>" — a plural "Projects" + "in <Somewhere>" ANYWHERE in the
# title is a category/listing-index shape; a single named project's own
# title virtually never phrases itself this way ("X Projects in Y" names a
# LIST, not a building).
PROJECTS_IN_PLACE_RE = re.compile(r"\bprojects?\s+in\s+[A-Z]", re.IGNORECASE)
SOCIAL_URL_RE = re.compile(r"(?:instagram\.com|facebook\.com|fb\.com|twitter\.com|x\.com|threads\.net|pinterest\.)", re.IGNORECASE)
DIRECTORY_RE = re.compile(r"\ball\s+projects\b|\bproject\s+listing\b|\bproject\s+directory\b|\bbuilder\s+profile\b", re.IGNORECASE)
# Live bug, reproduced 2026-08-17: "Buy 1 BHK in Borivali | New Projects &
# Properties in Borivali" — a common portal SEO title shape (a "Buy <BHK>
# in <Place>" clause, then a "|"/"-" separator, then a "New Projects &
# Properties in <Place>" boilerplate suffix). PROJECTS_IN_PLACE_RE above
# requires "Projects" to be followed DIRECTLY by "in <Place>"; the "&
# Properties" in between defeats it. Narrow and specific (not a broadened
# version of PROJECTS_IN_PLACE_RE, which would risk false-positiving on a
# real listing's own title mentioning "projects" and a place name anywhere
# near each other) — matches only this exact recurring boilerplate phrase.
PORTAL_SEO_SUFFIX_RE = re.compile(r"new\s+projects?\s*(&|and)\s*propert(y|ies)\s+in\s+[A-Z]", re.IGNORECASE)


def classify_page_type(evidence: EvidenceItem) -> str:
    """Returns one of: INDIVIDUAL_LISTING, INDIVIDUAL_PROJECT, CATEGORY_PAGE,
    SEARCH_RESULTS_PAGE, COLLECTION_PAGE, DEVELOPER_DIRECTORY, SOCIAL_POST,
    UNKNOWN. Only the first two are ever eligible to become a ranked
    candidate — see is_aggregator_title() below, the boolean gate the rest
    of the pipeline (scoring.py, graph.py's ranked_properties filter)
    actually reads.
    """
    title = (evidence.get("title") or "").strip()
    description = (evidence.get("description") or "").strip()
    url = (evidence.get("source_url") or "").strip()
    source_type = evidence.get("source_type")

    if not title:
        return "UNKNOWN"
    if SOCIAL_URL_RE.search(url) and not (evidence.get("developer") or "").strip():
        # A social-media URL is usually chatter/noise, not a listing — but
        # small/local Indian developers genuinely market real new launches
        # via Instagram Reels too. Live-caught on "1BHK in kandarpada
        # Dahisar West with gym nearby": an instagram.com/reel/... post —
        # "New Project by Pastonji Bliss Tower located near kandarpada
        # metro station... from only 73 lakhs" — a real, currently
        # under-construction project (confirmed independently: possession
        # Dec 2026, gym among its amenities) — was unconditionally rejected
        # purely because of where it was found, even though the connector
        # had already extracted a specific, non-generic developer name from
        # it. Only short-circuit to SOCIAL_POST when nothing else in the
        # evidence names anything specific; a social URL WITH an already
        # extracted developer name instead falls through to the same
        # title/description checks below (still fully able to reject it as
        # a CATEGORY_PAGE/COLLECTION_PAGE if it turns out to be generic).
        return "SOCIAL_POST"
    if PAGINATION_PREFIX_RE.search(title) or PAGINATION_URL_RE.search(url):
        return "SEARCH_RESULTS_PAGE"
    if DIRECTORY_RE.search(title):
        return "DEVELOPER_DIRECTORY"
    if LOCALITY_GUIDE_DESCRIPTION_RE.search(description):
        return "CATEGORY_PAGE"
    if AGGREGATOR_MARKER_RE.search(title):
        return "CATEGORY_PAGE"
    if PROJECTS_IN_PLACE_RE.search(title):
        return "CATEGORY_PAGE"
    if PORTAL_SEO_SUFFIX_RE.search(title):
        return "CATEGORY_PAGE"
    if PORTAL_CATEGORY_TITLE_RE.search(title) or TRAILING_COUNT_RE.search(title):
        return "CATEGORY_PAGE"
    if is_bare_locality_title(title):
        return "CATEGORY_PAGE"
    if not re.search(r"\b(flats?|apartments?|propert(y|ies)|houses?|rooms?|projects?)\b", title, re.IGNORECASE):
        # Doesn't even mention a generic real-estate noun at all — nothing
        # here suggests it's a listing-index page, leave it as a candidate.
        return "INDIVIDUAL_PROJECT" if source_type in ("official", "developer") else "INDIVIDUAL_LISTING"
    text = title
    for term in _known_gazetteer_terms():
        text = re.sub(re.escape(term), " ", text, flags=re.IGNORECASE)
    words = re.findall(r"[A-Za-z]+", text)
    leftover = [w for w in words if w.lower() not in GENERIC_FILLER_WORDS]
    if not leftover:
        # Nothing distinctive survives once locality names and generic
        # real-estate filler words are stripped — a category/collection
        # page names a LIST, never a single building, so it always has
        # something left over ("...for sale in Sheth Irene Liberty
        # Garden" leaves "Sheth Irene" behind); this one didn't.
        return "COLLECTION_PAGE"
    return "INDIVIDUAL_PROJECT" if source_type in ("official", "developer") else "INDIVIDUAL_LISTING"


_NON_CANDIDATE_TYPES = {"CATEGORY_PAGE", "SEARCH_RESULTS_PAGE", "COLLECTION_PAGE", "DEVELOPER_DIRECTORY", "SOCIAL_POST"}


def is_aggregator_title(evidence: EvidenceItem) -> bool:
    """The boolean gate scoring.py/graph.py actually read — True for every
    page_type that must never become a ranked candidate. UNKNOWN is
    deliberately treated as eligible (not aggregator) here — an empty/
    ambiguous classification isn't evidence of being a category page,
    it's evidence of nothing either way, and the rest of the scoring
    pipeline (evidence_quality, corroboration) already down-weights a
    thin, unconfirmed candidate on its own.
    """
    return classify_page_type(evidence) in _NON_CANDIDATE_TYPES


# ── Lifecycle / transaction-type classifier ──────────────────────────────
# This is a DIFFERENT question from classify_page_type() above. That
# classifier asks "is this an individual listing at all, or a category/
# directory/search-results page" — it has never looked at resale/rental
# transaction-type language, because a resale flat's own listing page is
# shaped exactly like a genuine new-project listing page (a title, a price,
# a BHK count, a description) and sails through INDIVIDUAL_LISTING
# untouched. This classifier is the missing second gate: even a perfectly
# well-formed individual listing must be REJECTED if it isn't an eligible
# new-project lifecycle stage. Deterministic, regex-only — no LLM call, and
# never guessed: an ambiguous/undetectable case returns UNKNOWN, and the
# caller (graph.py) treats UNKNOWN as ineligible, never as an assumed pass.
#
# Ordered by priority: a page can carry more than one signal (a resale
# portal listing mentioning "possession" of the ORIGINAL project, e.g.) —
# resale/rental disqualifiers are checked FIRST and win outright, since a
# resale/rental listing is disqualified regardless of what stage the
# underlying building is at.
RESALE_RE = re.compile(
    # `by\s+owner` (with `\s+` spanning newlines) used to false-positive on
    # portal FILTER-WIDGET chrome ("Posted By [newline] Owner Builder
    # Dealer [newline] clear") — a facet list, not a claim about this
    # specific listing. `[ \t]+` (no newline) still catches a genuine
    # same-line mention ("for sale by owner") while refusing to match
    # across separate UI elements. Confirmed live on a real fetched page
    # (a portal's filter sidebar) once page-content scanning started
    # covering more raw text than a short search snippet ever did.
    r"\bresale\b|\bpre[\s-]?owned\b|\bsecond\s*sale\b|\bsecond[\s-]?hand\b|"
    r"\bowner\s*(posted|listed|seller)?\b.{0,15}\b(sale|sell)\b|"
    r"\bby[ \t]+owner\b|\bdirect\s+from\s+owner\b|\bindividual\s+owner\b|"
    r"\bused\s+(flat|apartment|property)\b|"
    # NoBroker (and similar owner-listing portals) label their listing's
    # seller-identity facet "Ownership Type: Self Owned" instead of ever
    # using the word "resale" anywhere on the page — live-caught on
    # "1BHK in kandarpada Dahisar West with gym nearby": a real NoBroker
    # listing ("Age of Building: >10 years", "Ownership Type: Self Owned")
    # matched none of the patterns above, fell through to the
    # possession-year fallback in classify_lifecycle_status(), and got
    # misclassified NEAR_POSSESSION — because that listing's own
    # "Possession" field means "date the buyer takes possession from the
    # seller once this resale deal closes", not "date a new project's
    # construction completes", and nothing upstream of the fallback
    # distinguishes the two meanings.
    r"\bownership\s*type\b[^a-zA-Z]{0,20}self[\s-]?owned\b",
    re.IGNORECASE,
)
RENTAL_RE = re.compile(
    # `lease` alone is NOT a rental signal in Indian real estate — many
    # genuine new-launch/under-construction projects sit on government
    # leasehold land and their own listings say so ("99-year lease deed
    # from MHADA/MMRDA"). The negative lookahead excludes that specific,
    # common false-positive while still catching an actual rental-lease
    # offer ("available on lease", "lease: ₹25,000/month").
    r"\bfor\s+rent\b|\brental\b|\bto\s+let\b|\blease\b(?!\s*deed)|\brent(?:al)?\s*/\s*month\b|"
    r"\b(rent|lease)\s*:\s*₹|\bpg\b|\bpaying\s*guest\b|\bmonthly\s+rent\b",
    re.IGNORECASE,
)
# Follow-up spec — a real live false positive, distinct from resale/rental:
# a search connector returned a candidate sourced from a domain
# ("metzgerei-karlwinkler.de" — a German butcher shop) that got indexed
# with keyword-stuffed text mentioning the searched locality/possession
# year, but whose actual page content is unrelated e-commerce/shopping spam
# ("Pay in 4 interest-free payments of $10.25 · Enjoy 20% off shipping"),
# not a real-estate listing at all. This candidate passed the aggregator
# check (its title doesn't read as a category page), the resale/rental
# check (no resale/rental language), AND the geography gate (the locality
# name happened to appear in scraped keyword text) — nothing existing
# catches "this text isn't even about a property." Deterministic, narrow,
# high-precision signals only (shopping-cart/payment-plan boilerplate that
# has no legitimate reason to appear on a real project listing page) — not
# a broad "does this look generic" heuristic, which would risk false-
# rejecting a real listing that happens to mention payment plans for the
# FLAT itself (EMI language uses different, real-estate-specific phrasing
# — "EMI", "home loan", "booking amount" — deliberately not matched here).
UNRELATED_COMMERCE_RE = re.compile(
    r"\bpay\s+in\s+4\b|\binterest[\s-]?free\s+payments?\b|\badd\s+to\s+cart\b|"
    r"\bfree\s+shipping\b|\bshipping\s+charges?\b|\bitem\s+no\.?\s*:?\s*\d|"
    r"\bin\s+stock\b|\bout\s+of\s+stock\b|\bUS\$\s*\d",
    re.IGNORECASE,
)


def looks_like_unrelated_commerce(text: str) -> str | None:
    """Returns the matched evidence snippet if `text` reads like unrelated
    shopping/e-commerce spam rather than a real-estate listing, else None.
    """
    m = UNRELATED_COMMERCE_RE.search(text or "")
    if not m:
        return None
    start, end = max(0, m.start() - 25), min(len(text), m.end() + 25)
    return text[start:end].strip()


UNDER_CONSTRUCTION_RE = re.compile(r"\bunder[\s-]?construction\b|\bwork\s+in\s+progress\b|\bconstruction\s+(is\s+)?ongoing\b", re.IGNORECASE)
# `new\s+project\s+by` — live-caught on "1BHK in kandarpada Dahisar West
# with gym nearby": a genuine developer-marketing Instagram caption ("New
# Project by Pastonji Bliss Tower located near kandarpada metro station...")
# survived the SOCIAL_URL_RE fix above (a specific developer name was
# already extracted) but then stayed UNKNOWN here — the short caption never
# says "launch"/"pre-launch"/etc., and Instagram's own content can't be
# further enriched by fetch_page (JS-heavy/login-walled), so
# reclassify_lifecycle_from_enriched_evidence() had nothing more to work
# with than this exact snippet. "New Project by <Developer/Name>" is a
# common, specific, self-announcing developer phrasing distinct from a bare
# "new project" (which stays deliberately unmatched — too generic, and
# already excluded from ever reaching this classifier on a category page by
# PROJECTS_IN_PLACE_RE at the aggregator-gate stage).
NEW_LAUNCH_RE = re.compile(r"\bnew\s*launch\b|\bnewly\s+launched\b|\bpre[\s-]?launch\b|\bjust\s+launched\b|\bupcoming\s+project\b|\bnew\s+project\s+by\b", re.IGNORECASE)
NEAR_POSSESSION_RE = re.compile(r"\bnear\s+possession\b|\bpossession\s+(soon|shortly|imminent)\b|\bready\s+(for|by)\s+possession\b", re.IGNORECASE)
READY_TO_MOVE_RE = re.compile(r"\bready[\s-]?to[\s-]?move\b|\bready\s+possession\b|\bimmediate\s+possession\b|\bpossession\s+available\b|\bfully\s+occupied\b|\boccupancy\s+certificate\b", re.IGNORECASE)

# A future possession year (e.g. "Possession by Dec 2027") is real, useful
# lifecycle evidence even when none of the phrase-level markers above fire —
# normalize_possession_year() (below in this module) already extracts this
# deterministically from the SAME evidence. Reused here rather than
# re-parsing possession text a second time.
CURRENT_YEAR = datetime.now(timezone.utc).year


def classify_lifecycle_status(evidence: EvidenceItem, possession_year: int | None = None) -> tuple[str, str | None]:
    """Returns (lifecycle_status, evidence_text). lifecycle_status is one of
    UNDER_CONSTRUCTION / NEAR_POSSESSION / NEW_LAUNCH / READY_TO_MOVE /
    RESALE / RENTAL / UNKNOWN. evidence_text is the actual matched snippet
    (never fabricated) — None only for UNKNOWN, where there's nothing to
    quote.
    """
    title = (evidence.get("title") or "")
    description = (evidence.get("description") or "")
    text = f"{title} {description}".strip()
    if not text:
        return "UNKNOWN", None

    def _snippet(match: re.Match) -> str:
        start = max(0, match.start() - 25)
        end = min(len(text), match.end() + 25)
        return text[start:end].strip()

    m = RESALE_RE.search(text)
    if m:
        return "RESALE", _snippet(m)
    m = RENTAL_RE.search(text)
    if m:
        return "RENTAL", _snippet(m)
    m = NEW_LAUNCH_RE.search(text)
    if m:
        return "NEW_LAUNCH", _snippet(m)
    m = UNDER_CONSTRUCTION_RE.search(text)
    if m:
        return "UNDER_CONSTRUCTION", _snippet(m)
    m = NEAR_POSSESSION_RE.search(text)
    if m:
        return "NEAR_POSSESSION", _snippet(m)
    m = READY_TO_MOVE_RE.search(text)
    if m:
        return "READY_TO_MOVE", _snippet(m)

    # No phrase-level marker at all — fall back to the possession YEAR
    # already extracted for this evidence (real, extractive, not a guess).
    # A possession date more than ~1 year out reads as still-building; a
    # possession date due this year or next reads as near-possession; a
    # possession year already in the past with no other signal is most
    # consistent with a completed/ready building, not a fabricated "new
    # launch" — but is NOT auto-allowed by the default policy (READY_TO_MOVE
    # is deliberately excluded from ALLOWED_LIFECYCLE below), it's just an
    # honest classification rather than UNKNOWN.
    if possession_year is not None:
        if possession_year > CURRENT_YEAR + 1:
            return "UNDER_CONSTRUCTION", f"Possession year {possession_year} extracted from listing"
        if possession_year in (CURRENT_YEAR, CURRENT_YEAR + 1):
            return "NEAR_POSSESSION", f"Possession year {possession_year} extracted from listing"
        return "READY_TO_MOVE", f"Possession year {possession_year} extracted from listing"

    return "UNKNOWN", None


def reclassify_lifecycle_from_enriched_evidence(prop: NormalizedProperty) -> NormalizedProperty:
    """Re-runs classify_lifecycle_status against whatever deep_research/
    targeted_research has enriched a candidate with since it was first
    normalized from a raw search snippet — a fuller description,
    field_evidence entries (e.g. a possession fact extracted from the
    ACTUAL fetched page, not just a search snippet), and configuration_
    evidence's possession facts. Only changes anything when the candidate's
    CURRENT status is UNKNOWN or READY_TO_MOVE (Part 2's two "give it a
    second chance" outcomes, per graph.py's _apply_hard_eligibility_filter);
    a candidate already confidently classified (RESALE/RENTAL/an eligible
    stage) from the original evidence is left untouched — more evidence
    doesn't retroactively make a resale listing not-resale, and doesn't
    need to re-litigate an already-eligible classification.
    """
    current_status = prop.get("lifecycle_status") or "UNKNOWN"
    if current_status not in ("UNKNOWN", "READY_TO_MOVE"):
        return prop

    description_parts = [prop.get("description") or "", prop.get("possession_display") or ""]
    for entries in (prop.get("field_evidence") or {}).values():
        for e in entries:
            if e.get("field") == "possession_display" or "possess" in str(e.get("field") or "").lower():
                description_parts.append(str(e.get("value") or ""))
    for bucket in (prop.get("configuration_evidence") or {}).values():
        if bucket.get("possession"):
            description_parts.append(str(bucket["possession"]))
        for e in bucket.get("possession_evidence", []) or []:
            description_parts.append(str(e.get("value") or ""))
    for f in (prop.get("features") or []):
        if f.get("evidence_text"):
            description_parts.append(f["evidence_text"])

    synthetic_evidence: EvidenceItem = {
        "title": prop.get("name") or "",
        "description": " ".join(p for p in description_parts if p),
    }
    new_status, new_evidence_text = classify_lifecycle_status(synthetic_evidence, prop.get("possession_year"))
    if new_status == current_status:
        return prop
    out = dict(prop)
    out["lifecycle_status"] = new_status
    out["lifecycle_evidence_text"] = new_evidence_text or prop.get("lifecycle_evidence_text")
    return out


# Default AI Property Search policy (Part 2) — only these lifecycle stages
# are eligible new-project inventory. READY_TO_MOVE/RESALE/RENTAL/UNKNOWN
# are all rejected outright by graph.py's hard eligibility filter, the same
# gate is_aggregator already uses — never merely down-ranked.
ALLOWED_LIFECYCLE_STATUSES = {"UNDER_CONSTRUCTION", "NEAR_POSSESSION", "NEW_LAUNCH"}


# Part 2 of the Places-augmented pipeline — a candidate's name-VALIDITY
# check, the actual gate for a garbage extraction like the live "Security
# Alert" case (traced to a 99acres page that most plausibly served a bot-
# detection/interstitial page instead of its real listing content —
# refetching the identical URL moments later returned entirely different,
# legitimate content, confirming the page is non-deterministic per-request
# under repeated automated access). Deliberately a PATTERN FAMILY (portal UI
# chrome / interstitial / generic-action phrasing), not a hardcoded
# blocklist of "Security Alert" alone — that would be overfit to one bad
# example and miss the next differently-worded interstitial. Mirrors
# backend/scoring.cjs's looksLikeInvalidName() exactly.
#
# Only ever consulted as a gate when Places verification did NOT resolve
# the name (see graph.py's _apply_hard_eligibility_filter) — a real project
# simply absent from Places must never be rejected on Places-absence alone.
INVALID_NAME_RE = re.compile(
    r"^(security|fraud|scam|safety)\s+(alert|warning|notice)$|"
    r"\b(click here|view details?|read more|learn more|sign[\s-]?in|log[\s-]?in|log[\s-]?out|"
    r"register now|book\s+now|enquire\s+now|contact\s+us|about\s+us|"
    r"terms\s+(and|&)\s+conditions|privacy\s+policy|cookie\s+policy|"
    r"page\s+not\s+found|access\s+denied|please\s+wait|loading|coming\s+soon|"
    r"under\s+maintenance|verify\s+you.?re\s+human|are\s+you\s+a\s+robot|session\s+expired)\b",
    re.IGNORECASE,
)
# A bare social-platform name ("Instagram", "Facebook", ...) as the ENTIRE
# extracted name/location — live-caught: an Instagram-sourced candidate
# (a real Reel from Gagangiri Developers, mentioning a real project) had
# its NAME and LOCATION both come out as the literal string "Instagram",
# because Instagram serves a generic og:title="Instagram" for logged-out/
# scraper embed requests instead of the real caption text (the actual
# project name only appears in the caption body, which fact_extraction's
# page-title/JSON-LD extraction never reaches for a login-walled page).
# Matched as the WHOLE string (optionally with surrounding whitespace),
# not a substring — a real project genuinely named e.g. "Instagram
# Heights" (however unlikely) must not be caught by this.
SOCIAL_PLATFORM_BARE_NAME_RE = re.compile(
    r"^(instagram|facebook|twitter|x|pinterest|threads|youtube|tiktok|linkedin|snapchat)$",
    re.IGNORECASE,
)
# Small, narrow, non-proper-noun word list — same discipline as this
# module's other regex-family heuristics, not a real dictionary check.
_GENERIC_NAME_WORDS = {"alert", "notice", "warning", "error", "info", "details", "update", "news", "status", "message", "popup", "modal", "banner", "ad", "ads", "advertisement"}


def looks_like_invalid_name(name: str) -> bool:
    n = (name or "").strip()
    if not n:
        return True
    if INVALID_NAME_RE.search(n):
        return True
    if SOCIAL_PLATFORM_BARE_NAME_RE.match(n):
        return True
    # Structural fallback: a very short (<=2 word) name built ENTIRELY from
    # generic, non-proper-noun UI/status words doesn't read as a real
    # project name at all — a real project's name always has SOMETHING
    # distinctive ("Rivali Park", "Chandak Greenairy").
    words = n.lower().split()
    if len(words) <= 2 and all(w in _GENERIC_NAME_WORDS for w in words):
        return True
    return False


def normalize_evidence_item(evidence: EvidenceItem) -> NormalizedProperty:
    min_inr, max_inr, price_display = normalize_price(evidence)
    possession_year, possession_display = normalize_possession_year(evidence)
    name = normalize_project_name(evidence.get("property_name") or evidence.get("title") or "")
    location = normalize_location(evidence)
    lifecycle_status, lifecycle_evidence_text = classify_lifecycle_status(evidence, possession_year)
    prop = NormalizedProperty(
        id="",  # assigned by the deduplicator once merge keys are known
        name=name,
        developer=(evidence.get("developer") or "").strip() or None,
        location=location,
        micro_location=None,
        city=derive_city(location),
        configuration=normalize_configuration(evidence),
        price_min_inr=min_inr,
        price_max_inr=max_inr,
        price_display=price_display,
        carpet_area_sqft=(evidence.get("carpet_area") or {}).get("value_sqft"),
        possession_year=possession_year,
        possession_display=possession_display,
        rera=evidence.get("rera") or None,
        amenities=[a.strip() for a in (evidence.get("amenities") or []) if a and a.strip()],
        description=(evidence.get("description") or "").strip() or None,
        sources=[{
            "name": evidence.get("source"), "url": evidence.get("source_url"),
            "captured_at": evidence.get("captured_at"), "source_type": evidence.get("source_type"),
        }],
        field_evidence={},
        evidence_count=1,
        source_types=[evidence.get("source_type")] if evidence.get("source_type") else [],
        is_aggregator=is_aggregator_title(evidence),
        lifecycle_status=lifecycle_status,
        lifecycle_evidence_text=lifecycle_evidence_text,
    )
    # Real Places-provided coordinates (Part 1) — threaded straight through
    # from a places_search evidence item so downstream (Project
    # Intelligence's map) can use them directly instead of re-geocoding via
    # Nominatim/Google Geocoding string-matching for these specific
    # candidates. Absent (key not set at all) for every other source —
    # never a fabricated 0.0/None-as-if-checked placeholder.
    if evidence.get("lat") is not None and evidence.get("lon") is not None:
        prop["places_lat"] = evidence["lat"]
        prop["places_lon"] = evidence["lon"]
        prop["places_place_id"] = evidence.get("place_id")
        prop["places_address"] = evidence.get("formatted_address")
        prop["places_verified"] = True  # came FROM Places itself — trivially verified
    return prop


def normalize_all(raw_evidence: list[EvidenceItem]) -> list[NormalizedProperty]:
    # Part 2 (follow-up spec) — a page whose OWN title correctly reads as a
    # category/search-results page can still have real, individually-named
    # projects sitting in its own body text (a locality "New Projects in
    # X" roundup, e.g.), each with genuine RERA/price/carpet-area facts —
    # confirmed live. Rejecting the whole page threw those away too. Pull
    # them out here, BEFORE the wrapper page itself gets normalized (and
    # correctly flagged is_aggregator=True and rejected downstream, same
    # as always) — each sub-listing becomes its own evidence item and goes
    # through the EXACT SAME normalize/dedupe/score/eligibility pipeline as
    # any other discovered candidate, never a second path.
    from . import fact_extraction as fact_extraction_mod
    expanded: list[EvidenceItem] = []
    for e in raw_evidence:
        expanded.append(e)
        if classify_page_type(e) in ("CATEGORY_PAGE", "SEARCH_RESULTS_PAGE"):
            expanded.extend(fact_extraction_mod.extract_sub_listings(e))
    # Evidence with no usable name at all can't be matched to anything
    # downstream — dropped here rather than silently confusing the
    # deduplicator with an empty-string merge key.
    return [normalize_evidence_item(e) for e in expanded if (e.get("property_name") or e.get("title") or "").strip()]
