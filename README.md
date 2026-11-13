# quant-ph topic scanner

A web interface to see which `quant-ph` papers appeared on arXiv **in the last
day, week or month**, filtered by topic.

A Python scraper runs daily on GitHub Actions, pulls recent submissions from the
[arXiv API](https://info.arxiv.org/help/api/index.html) and publishes a static
site to GitHub Pages. No server and no database: all filtering happens in the
browser, so it is instant.

## How it works

```
scraper/fetch_arxiv.py   →  docs/data/papers.json   →  docs/ (static site)
   arXiv API, stdlib            ~2200 papers             vanilla JS
```


