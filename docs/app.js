/* quant-ph topic scanner — static client, no build step, no dependencies. */

const PAGE_SIZE = 25;

const state = {
  papers: [],
  groups: [],
  topics: new Map(),      // id -> {id, label, regex, group}
  matches: new Map(),     // paper id -> Set of topic ids
  newest: null,           // most recent submission in the dataset
  days: 1,
  selected: new Set(),
  mode: "any",
  query: "",
  page: 1,
};

const el = (id) => document.getElementById(id);

/* ---------- topic matching ---------- */

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keyword -> regex source. Three accommodations for real abstracts:
 *  hyphens and spaces are interchangeable ("non-Markovian" / "non Markovian"),
 *  a trailing plural is allowed ("quantum neural network" hits "...networks"),
 *  and boundaries are only required where the keyword ends in a word char
 *  ("Yb+" would never match if we demanded \b after the plus sign). */
function keywordSource(keyword) {
  const body = escapeRegex(keyword.toLowerCase()).replace(/\\?[-\s]+/g, "[\\s-]+");
  const prefix = /^\w/.test(keyword) ? "\\b" : "";
  const suffix = /\w$/.test(keyword) ? "(?:e?s)?\\b" : "";
  return prefix + body + suffix;
}

function buildTopics(groups) {
  for (const group of groups) {
    for (const topic of group.topics) {
      state.topics.set(topic.id, {
        ...topic,
        group: group.name,
        regex: new RegExp(topic.keywords.map(keywordSource).join("|"), "g"),
      });
    }
  }
}

/** Precompute topic hits once; filtering afterwards is a set lookup. */
function indexPapers() {
  for (const paper of state.papers) {
    const haystack = `${paper.title} ${paper.abstract}`.toLowerCase();
    const hits = new Set();
    for (const topic of state.topics.values()) {
      topic.regex.lastIndex = 0;
      if (topic.regex.test(haystack)) hits.add(topic.id);
    }
    state.matches.set(paper.id, hits);
  }
}

/* ---------- free-text query ---------- */

/** Split into bare words and "quoted phrases"; every term must appear.
 *  A term is anchored at the start of a word but left open at the end, which
 *  is the only combination that gets all three of these right:
 *    "entangl"        still narrows while you type -> entanglement
 *    "ion"            means ions, not dimens(ion)s or informat(ion)
 *    "spin squeezing" also finds "spin-squeezing" (hyphens == spaces) */
function parseQuery(raw) {
  const terms = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const text = (match[1] || match[2]).trim();
    if (!text) continue;
    const body = escapeRegex(text).replace(/\\?[-\s]+/g, "[\\s-]+");
    const source = (/^\w/.test(text) ? "\\b" : "") + body;
    terms.push({ text, regex: new RegExp(source, "i") });
  }
  return terms;
}

function matchesQuery(paper, terms) {
  if (!terms.length) return true;
  const haystack = `${paper.title} ${paper.abstract} ${paper.authors.join(" ")}`;
  return terms.every((term) => term.regex.test(haystack));
}

/* ---------- filtering ---------- */

function cutoff() {
  // Measured from the newest submission, not from "now": arXiv publishes in
  // daily batches, so a literal 24h window is empty for most of the day.
  return new Date(state.newest.getTime() - state.days * 86400000);
}

/** state.papers arrives newest-first from the scraper, so filtering preserves
 *  the chronological order and nothing needs re-sorting. */
function currentResults() {
  const since = cutoff();
  const terms = parseQuery(state.query);
  const selected = [...state.selected];

  return state.papers.filter((paper) => {
    if (new Date(paper.published) < since) return false;
    if (!matchesQuery(paper, terms)) return false;
    if (!selected.length) return true;
    const hits = state.matches.get(paper.id);
    return state.mode === "all"
      ? selected.every((id) => hits.has(id))
      : selected.some((id) => hits.has(id));
  });
}

/** Per-topic counts within the current time window, ignoring topic selection. */
function topicCounts() {
  const since = cutoff();
  const terms = parseQuery(state.query);
  const counts = new Map();
  for (const paper of state.papers) {
    if (new Date(paper.published) < since) continue;
    if (!matchesQuery(paper, terms)) continue;
    for (const id of state.matches.get(paper.id)) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/* ---------- rendering ---------- */

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

/** Mark the matches with sentinels, escape, then swap in the <mark> tags, so a
 *  term like "amp" can never land inside an HTML entity produced by escaping. */
function highlight(text, terms) {
  if (!terms.length) return escapeHtml(text);
  const pattern = new RegExp(`(${terms.map((term) => term.regex.source).join("|")})`, "gi");
  return escapeHtml(text.replace(pattern, "\u0000$1\u0001"))
    .replaceAll("\u0000", "<mark>")
    .replaceAll("\u0001", "</mark>");
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function formatAuthors(authors) {
  if (authors.length <= 6) return authors.join(", ");
  return `${authors.slice(0, 5).join(", ")} + ${authors.length - 5} more`;
}

function renderTopics() {
  const counts = topicCounts();
  el("topics").innerHTML = state.groups
    .map((group) => {
      const items = group.topics
        .map((topic) => {
          const count = counts.get(topic.id) || 0;
          const checked = state.selected.has(topic.id) ? "checked" : "";
          return `<label class="topic ${count ? "" : "empty"}">
            <input type="checkbox" value="${topic.id}" ${checked}>
            <span class="topic-label">${escapeHtml(topic.label)}</span>
            <span class="count">${count}</span>
          </label>`;
        })
        .join("");
      return `<details open class="group">
        <summary>${escapeHtml(group.name)}</summary>${items}
      </details>`;
    })
    .join("");
}

function renderActiveFilters() {
  const chips = [...state.selected].map((id) => {
    const topic = state.topics.get(id);
    return `<button class="chip" data-topic="${id}">${escapeHtml(topic.label)} <span>×</span></button>`;
  });
  el("active-filters").innerHTML = chips.length
    ? `${chips.join("")}<span class="chip-note">${state.mode === "all" ? "all required" : "any of them"}</span>`
    : "";
}

function renderPapers(results) {
  const terms = parseQuery(state.query);
  const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const slice = results.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

  if (!results.length) {
    el("papers").innerHTML = `<p class="empty-state">
      No paper matches these filters in this time window.<br>
      Try a wider window, or drop one of the topics.
    </p>`;
    el("pager").innerHTML = "";
    return;
  }

  el("papers").innerHTML = slice
    .map((paper) => {
      const hits = [...state.matches.get(paper.id)]
        .filter((id) => state.topics.has(id))
        .map((id) => {
          const active = state.selected.has(id) ? "badge active" : "badge";
          return `<span class="${active}">${escapeHtml(state.topics.get(id).label)}</span>`;
        })
        .join("");
      const crossLists = paper.categories.filter((category) => category !== "quant-ph");
      return `<article class="paper">
        <div class="paper-meta">
          <time>${formatDate(paper.published)}</time>
          ${paper.version > 1 ? `<span class="tag">v${paper.version}</span>` : ""}
          ${crossLists.length ? `<span class="tag">${escapeHtml(crossLists.join(" · "))}</span>` : ""}
          <span class="arxiv-id">${escapeHtml(paper.id)}</span>
        </div>
        <h3><a href="${paper.abs_url}" target="_blank" rel="noopener">${highlight(paper.title, terms)}</a></h3>
        <p class="authors">${escapeHtml(formatAuthors(paper.authors))}</p>
        ${hits ? `<div class="badges">${hits}</div>` : ""}
        <details class="abstract">
          <summary>Abstract</summary>
          <p>${highlight(paper.abstract, terms)}</p>
          ${paper.comment ? `<p class="comment">${escapeHtml(paper.comment)}</p>` : ""}
          ${paper.journal_ref ? `<p class="comment">${escapeHtml(paper.journal_ref)}</p>` : ""}
        </details>
        <div class="links">
          <a href="${paper.abs_url}" target="_blank" rel="noopener">arXiv</a>
          <a href="${paper.pdf_url}" target="_blank" rel="noopener">PDF</a>
          ${paper.doi ? `<a href="https://doi.org/${encodeURIComponent(paper.doi)}" target="_blank" rel="noopener">DOI</a>` : ""}
        </div>
      </article>`;
    })
    .join("");

  el("pager").innerHTML = pages > 1
    ? `<button id="prev" ${state.page === 1 ? "disabled" : ""}>← previous</button>
       <span>page ${state.page} of ${pages}</span>
       <button id="next" ${state.page === pages ? "disabled" : ""}>next →</button>`
    : "";
}

function render() {
  const results = currentResults();
  const window = { 1: "in the last day", 7: "in the last week", 30: "in the last month" }[state.days];
  const noun = results.length === 1 ? "paper" : "papers";
  const filtered = state.selected.size || state.query ? " matching your filters" : "";
  el("result-count").textContent = `${results.length} ${noun} ${window}${filtered}`;
  renderTopics();
  renderActiveFilters();
  renderPapers(results);
  syncUrl();
}

/* ---------- URL state, so a filtered view can be shared ---------- */

function syncUrl() {
  const params = new URLSearchParams();
  params.set("days", state.days);
  if (state.selected.size) params.set("topics", [...state.selected].join(","));
  if (state.mode !== "any") params.set("mode", state.mode);
  if (state.query) params.set("q", state.query);
  history.replaceState(null, "", `?${params}`);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const days = Number(params.get("days"));
  if ([1, 7, 30].includes(days)) state.days = days;
  for (const id of (params.get("topics") || "").split(",")) {
    if (state.topics.has(id)) state.selected.add(id);
  }
  if (params.get("mode") === "all") state.mode = "all";
  state.query = params.get("q") || "";

  el("query").value = state.query;
  for (const button of el("window-select").children) {
    button.classList.toggle("active", Number(button.dataset.days) === state.days);
  }
  for (const button of el("match-mode").children) {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  }
}

/* ---------- events ---------- */

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function wireEvents() {
  el("window-select").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.days = Number(button.dataset.days);
    state.page = 1;
    for (const sibling of el("window-select").children) {
      sibling.classList.toggle("active", sibling === button);
    }
    render();
  });

  el("match-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    state.mode = button.dataset.mode;
    state.page = 1;
    for (const sibling of el("match-mode").children) {
      sibling.classList.toggle("active", sibling === button);
    }
    render();
  });

  el("topics").addEventListener("change", (event) => {
    const box = event.target;
    if (box.type !== "checkbox") return;
    box.checked ? state.selected.add(box.value) : state.selected.delete(box.value);
    state.page = 1;
    render();
  });

  el("active-filters").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.selected.delete(chip.dataset.topic);
    state.page = 1;
    render();
  });

  el("clear-topics").addEventListener("click", () => {
    state.selected.clear();
    state.page = 1;
    render();
  });

  el("query").addEventListener("input", debounce((event) => {
    state.query = event.target.value;
    state.page = 1;
    render();
  }, 200));

  el("pager").addEventListener("click", (event) => {
    if (event.target.id === "prev") state.page -= 1;
    else if (event.target.id === "next") state.page += 1;
    else return;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  el("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  });
}

/* ---------- boot ---------- */

function showFailure(heading, body, error) {
  el("result-count").textContent = heading;
  el("papers").innerHTML = `<p class="empty-state">${body}</p>`;
  console.error(error);
}

async function main() {
  document.documentElement.dataset.theme =
    localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  let payload, taxonomy;
  try {
    const [papersResponse, topicsResponse] = await Promise.all([
      fetch("data/papers.json"),
      fetch("data/topics.json"),
    ]);
    if (!papersResponse.ok || !topicsResponse.ok) throw new Error("fetch failed");
    payload = await papersResponse.json();
    taxonomy = await topicsResponse.json();
  } catch (error) {
    return showFailure("Could not load the data",
      `Unable to read <code>data/papers.json</code>.<br>
       If you opened the file locally, serve the folder with
       <code>python3 -m http.server</code> instead.`, error);
  }

  // Kept apart from the fetch above: a crash in here is a bug or a stale
  // cached script, and blaming the data file would send you hunting in the
  // wrong place — as it did when a cached app.js met a newer index.html.
  try {
    state.papers = payload.papers;
    state.groups = taxonomy.groups;
    state.newest = new Date(payload.papers[0].published);

    buildTopics(state.groups);
    indexPapers();

    const generated = new Date(payload.generated_at);
    el("freshness").textContent =
      `${payload.count} papers · updated ${formatDate(payload.generated_at)} ${generated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    el("window-hint").textContent =
      `Measured from the latest submission (${formatDate(payload.papers[0].published)}), not from the current time.`;

    restoreFromUrl();
    wireEvents();
    render();
  } catch (error) {
    return showFailure("Something went wrong displaying the data",
      `The data loaded, but the page failed to render it.<br>
       Try a hard refresh (<code>Ctrl/Cmd + Shift + R</code>) to clear a stale script.`, error);
  }
}

main();
