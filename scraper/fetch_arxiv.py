#!/usr/bin/env python3
"""Fetch recent quant-ph submissions from the arXiv API into a static JSON file.

Only the standard library is used so the GitHub Action needs no dependencies.

Usage:
    python scraper/fetch_arxiv.py [--days 35] [--out docs/data/papers.json]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_URL = "https://export.arxiv.org/api/query"
CATEGORY = "cat:quant-ph"
PAGE_SIZE = 200
REQUEST_DELAY = 3.0
MAX_RETRIES = 4
USER_AGENT = "Scraper-Arxiv/1.0 (https://github.com/niccololaurora/Scraper)"

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}


def date_window(since: datetime, until: datetime) -> str:
    return "submittedDate:[{} TO {}]".format(
        since.strftime("%Y%m%d%H%M"), until.strftime("%Y%m%d%H%M")
    )


def build_url(search_query: str, start: int) -> str:
    params = {
        "search_query": search_query,
        "start": start,
        "max_results": PAGE_SIZE,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    }
    return f"{API_URL}?{urllib.parse.urlencode(params)}"


def build_query(start: int, since: datetime, until: datetime) -> str:
    """Build an API query restricted to a submission date window."""
    return build_url(f"{CATEGORY} AND {date_window(since, until)}", start)


def fetch_page(url: str) -> str:
    """GET a single API page, retrying with backoff on transient failures."""
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            backoff = REQUEST_DELAY * 2**attempt
            print(f"  request failed ({error}); retrying in {backoff:.0f}s", file=sys.stderr)
            time.sleep(backoff)
    raise RuntimeError(f"giving up on {url}: {last_error}")


def clean(text: str | None) -> str:
    """Collapse the newlines and padding the Atom feed wraps text in."""
    if not text:
        return ""
    return " ".join(text.split())


def parse_entry(entry: ET.Element) -> dict | None:
    raw_id = clean(entry.findtext("atom:id", default="", namespaces=NS))
    if not raw_id:
        return None
    
    tail = raw_id.rsplit("/abs/", 1)[-1]
    arxiv_id, _, version = tail.partition("v")

    categories = [
        category.get("term", "")
        for category in entry.findall("atom:category", NS)
        if category.get("term")
    ]
    primary = entry.find("arxiv:primary_category", NS)

    pdf_url = f"https://arxiv.org/pdf/{tail}"
    for link in entry.findall("atom:link", NS):
        if link.get("title") == "pdf" and link.get("href"):
            pdf_url = link.get("href", "").replace("http://", "https://")

    return {
        "id": arxiv_id,
        "version": int(version) if version.isdigit() else 1,
        "title": clean(entry.findtext("atom:title", default="", namespaces=NS)),
        "abstract": clean(entry.findtext("atom:summary", default="", namespaces=NS)),
        "authors": [
            clean(name)
            for author in entry.findall("atom:author", NS)
            if (name := author.findtext("atom:name", default="", namespaces=NS))
        ],
        "published": clean(entry.findtext("atom:published", default="", namespaces=NS)),
        "updated": clean(entry.findtext("atom:updated", default="", namespaces=NS)),
        "primary_category": primary.get("term", "") if primary is not None else "",
        "categories": categories,
        "comment": clean(entry.findtext("arxiv:comment", default="", namespaces=NS)),
        "journal_ref": clean(entry.findtext("arxiv:journal_ref", default="", namespaces=NS)),
        "doi": clean(entry.findtext("arxiv:doi", default="", namespaces=NS)),
        "abs_url": f"https://arxiv.org/abs/{tail}",
        "pdf_url": pdf_url,
    }


def fetch_all(search_query: str, papers: dict[str, dict] | None = None) -> dict[str, dict]:
    """Page through every result of a query, de-duplicated by arXiv id."""
    papers = {} if papers is None else papers
    start = 0
    while True:
        print(f"  start={start} (collected {len(papers)})")
        feed = ET.fromstring(fetch_page(build_url(search_query, start)))
        entries = feed.findall("atom:entry", NS)
        if not entries:
            break

        for entry in entries:
            paper = parse_entry(entry)
            
            if paper and paper["id"] not in papers:
                papers[paper["id"]] = paper

        total = feed.findtext("opensearch:totalResults", namespaces={
            "opensearch": "http://a9.com/-/spec/opensearch/1.1/"
        })
        start += PAGE_SIZE
        if total and start >= int(total):
            break
        time.sleep(REQUEST_DELAY)
    return papers


def by_date(papers) -> list[dict]:
    return sorted(papers, key=lambda paper: paper["published"], reverse=True)


def fetch_window(days: int) -> list[dict]:
    """Page through every quant-ph submission from the last `days` days."""
    until = datetime.now(timezone.utc)
    since = until - timedelta(days=days)
    print(f"Fetching quant-ph submissions from {since:%Y-%m-%d} to {until:%Y-%m-%d}")
    return by_date(fetch_all(f"{CATEGORY} AND {date_window(since, until)}").values())


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {path} ({path.stat().st_size / 1_048_576:.1f} MB)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=35, help="how far back to look")
    parser.add_argument("--out", type=Path, default=Path("docs/data/papers.json"))
    args = parser.parse_args()

    papers = fetch_window(args.days)
    if not papers:
        print("No papers returned; leaving the existing file untouched.", file=sys.stderr)
        return 1

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_json(args.out, {
        "generated_at": generated_at,
        "window_days": args.days,
        "count": len(papers),
        "papers": papers,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
