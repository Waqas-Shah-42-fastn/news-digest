// News digest to Slack.
// Reads its settings from the integration config (per-customer copy via getByTemplate),
// gathers Google News / Reddit / engineering-blog feeds, posts one Slack message, and, when the
// settings name a publishRepo, publishes the digest as JSON for the GitHub Pages site.
// ctx.input is scope only: {} = scheduled run, { dryRun: true } = preview, { force: true } = manual post,
// { dryRun: true, publish: true } = refresh the site without posting.

const TEMPLATE_ID = "cfg_0be8a5e2bd66";
const UA = "Mozilla/5.0 (compatible; fastn-news-digest/1.0)";
const DEFAULT_ITEMS = 5;
const MAX_ITEMS = 10;
const DEFAULT_BLOG_HOURS = 48;
const AI_WINDOW_HOURS = 48;
const MAX_TITLE = 200;

const SECTIONS = {
  top: { title: "🔝 Top stories" },
  geopolitics: { title: "🌍 Geopolitics", topic: "WORLD" },
  business: { title: "💼 Business", topic: "BUSINESS" },
  technology: { title: "💻 Technology", topic: "TECHNOLOGY" },
  ai: { title: "🤖 AI companies" },
  reddit: { title: "🔥 Reddit" },
  engineering: { title: "🛠️ Engineering blogs" },
};

// Extra names a company's news is usually written under.
const AI_ALIASES = {
  "anthropic": ["anthropic", "claude"],
  "openai": ["openai", "chatgpt", "gpt-", "sora"],
  "xai": ["xai", "grok"],
  "google deepmind": ["deepmind", "gemini"],
  "meta ai": ["meta ai", "llama", "meta superintelligence"],
};

// ---------- small helpers ----------

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

function attr(block, name, attribute) {
  const m = block.match(new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

// Parses RSS <item> and Atom <entry> elements into { title, link, published, source, raw }.
function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const head = xml.split(/<item[\s>]|<entry[\s>]/i)[0];
  const feedTitle = stripTags(tag(head, "title"));
  const items = blocks.map(b => {
    let link = tag(b, "link");
    if (!link || link.startsWith("<")) link = attr(b, "link", "href");
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "dc:date") || tag(b, "updated");
    const ts = Date.parse(date);
    return {
      title: stripTags(tag(b, "title")),
      link: link.trim(),
      published: isNaN(ts) ? null : ts,
      source: stripTags(tag(b, "source")),
      raw: b,
    };
  }).filter(i => i.title && /^https?:\/\//.test(i.link));
  return { feedTitle, items };
}

async function getFeed(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new Error("not an RSS/Atom feed");
  return parseFeed(text);
}

function googleNewsParams(edition) {
  const [country, lang] = String(edition || "US:en").split(":").map(s => s.trim());
  const gl = (country || "US").toUpperCase();
  const hl = `${(lang || "en").toLowerCase()}-${gl}`;
  return `hl=${hl}&gl=${gl}&ceid=${gl}:${(lang || "en").toLowerCase()}`;
}

// Google News titles look like "Headline - Source"; keep them apart.
function splitGoogleTitle(item) {
  const source = item.source || "";
  let title = item.title;
  if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
  else {
    const i = title.lastIndexOf(" - ");
    if (i > 0 && !source) return { title: title.slice(0, i), source: title.slice(i + 3) };
  }
  return { title, source };
}

// How many outlets Google News lists for a story (its coverage cluster).
function outletCount(item) {
  const desc = decodeEntities(tag(item.raw, "description"));
  const n = (desc.match(/<li[\s>]/gi) || []).length;
  return Math.max(n, 1);
}

function normTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function list(value) {
  return String(value || "").split(",").map(s => s.trim()).filter(Boolean);
}

function clampInt(value, def, min, max) {
  const n = parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || String(value).trim() === "" || n < min) return def;
  return Math.min(n, max);
}

function slackEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shorten(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function settingsFrom(config) {
  const entity = (config?.entities ?? config?.directions ?? [])[0] || {};
  const v = {};
  for (const c of entity.conditions || []) v[c.field] = c.value;
  const publishRepo = String(v.publishRepo || "").trim();
  return {
    channel: String(v.slackChannel || "").trim().replace(/^#/, ""),
    sections: list(v.sections).map(s => s.toLowerCase()),
    items: clampInt(v.itemsPerSection, DEFAULT_ITEMS, 1, MAX_ITEMS),
    aiCompanies: list(v.aiCompanies),
    subreddits: list(v.subreddits).map(s => s.replace(/^r\//i, "")),
    feeds: list(v.engineeringBlogFeeds),
    blogHours: clampInt(v.engineeringBlogHours, DEFAULT_BLOG_HOURS, 1, 168),
    edition: String(v.newsEdition || "US:en").trim(),
    aiOverview: String(v.aiOverview ?? "on").trim().toLowerCase() !== "off",
    // owner/repo of the GitHub Pages site; only the site owner's settings carry it.
    publishRepo: /^[\w.-]+\/[\w.-]+$/.test(publishRepo) ? publishRepo : "",
  };
}

// ---------- sources ----------

async function topStories(s) {
  const { items } = await getFeed(`https://news.google.com/rss?${googleNewsParams(s.edition)}`);
  return items
    .map(i => ({ ...splitGoogleTitle(i), link: i.link, published: i.published, outlets: outletCount(i) }))
    .sort((a, b) => b.outlets - a.outlets);
}

async function topicSection(s, topic) {
  const { items } = await getFeed(`https://news.google.com/rss/headlines/section/topic/${topic}?${googleNewsParams(s.edition)}`);
  return items.map(i => ({ ...splitGoogleTitle(i), link: i.link, published: i.published }));
}

async function aiSection(s) {
  if (!s.aiCompanies.length) return [];
  const q = s.aiCompanies.map(c => `"${c}"`).join(" OR ") + " when:2d";
  const { items } = await getFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${googleNewsParams(s.edition)}`);
  const terms = s.aiCompanies.flatMap(c => AI_ALIASES[c.toLowerCase()] || [c.toLowerCase()]);
  const since = Date.now() - AI_WINDOW_HOURS * 3600e3;
  return items
    .map(i => ({ ...splitGoogleTitle(i), link: i.link, published: i.published }))
    .filter(i => i.published && i.published >= since)
    .filter(i => terms.some(t => i.title.toLowerCase().includes(t)));
}

const REDDIT_FRESH_MS = 30 * 60e3;
const REDDIT_KEEP_MS = 24 * 3600e3;

// Reddit rate-limits unauthenticated feeds per source IP, which fastn's runners share, so one
// combined request is made and kept in fastn.state: runs within 30 minutes reuse it, and the
// last good copy (up to 24h old) stands in when Reddit answers 429.
async function redditPosts(fastn, s, warnings) {
  const combined = s.subreddits.map(encodeURIComponent).join("+");
  const key = `newsdigest:reddit:${s.subreddits.map(x => x.toLowerCase()).sort().join("+")}`;
  let cached = null;
  try {
    cached = await fastn.state.get(key);
  } catch (e) {
    warnings.push({ source: "Reddit cache", error: e.message });
  }
  if (cached && Date.now() - cached.fetchedAt > REDDIT_KEEP_MS) cached = null;
  if (cached && Date.now() - cached.fetchedAt < REDDIT_FRESH_MS) return cached.posts;
  try {
    const { items } = await getFeed(`https://www.reddit.com/r/${combined}/top/.rss?t=day&limit=100`);
    const posts = items.map(i => ({ title: i.title, link: i.link, published: i.published, sub: attr(i.raw, "category", "term").toLowerCase() }));
    try {
      await fastn.state.set(key, { fetchedAt: Date.now(), posts });
    } catch (e) {
      warnings.push({ source: "Reddit cache", error: e.message });
    }
    return posts;
  } catch (e) {
    if (!cached) throw e;
    warnings.push({ source: "Reddit", error: `${e.message}; used posts fetched at ${new Date(cached.fetchedAt).toISOString()}` });
    return cached.posts;
  }
}

async function redditSection(fastn, s, warnings) {
  if (!s.subreddits.length) return [];
  const perSub = new Map(s.subreddits.map(sub => [sub.toLowerCase(), { name: sub, posts: [] }]));
  for (const p of await redditPosts(fastn, s, warnings)) {
    const bucket = perSub.get(p.sub);
    if (bucket) bucket.posts.push({ title: p.title, link: p.link, published: p.published, source: `r/${bucket.name}` });
  }
  // Take each subreddit's #1, then each #2, and so on, so one subreddit doesn't fill the section.
  const merged = [];
  for (let rank = 0; rank < s.items; rank++) for (const { posts } of perSub.values()) if (posts[rank]) merged.push(posts[rank]);
  return merged;
}

async function engineeringSection(s, warnings) {
  const since = Date.now() - s.blogHours * 3600e3;
  const perFeed = await Promise.all(s.feeds.map(async url => {
    try {
      const { feedTitle, items } = await getFeed(url);
      const blog = feedTitle.replace(/\s*-\s*Medium$/i, "").trim() || url;
      return items.filter(i => i.published && i.published >= since)
        .map(i => ({ title: i.title, link: i.link, published: i.published, source: blog }));
    } catch (e) {
      warnings.push({ source: url, error: e.message });
      return [];
    }
  }));
  return perFeed.flat().sort((a, b) => b.published - a.published);
}

// ---------- Google News links ----------

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
// v2: v16 matched answers by position and cached wrong links under the old key.
const GN_CACHE_KEY = "newsdigest:gn-links:v2";
const GN_CACHE_MAX = 600;
const GN_ALERT_RULE = "News digest: Google links";   // fastn alert rule (code mode, emails the owner)
const GN_ALERT_MIN = 3;                              // one stray failure is not worth an email

// Google News article links open a page that redirects with JavaScript, which often leaves readers on
// the Google News home page. Resolve them to the publisher URL the way that page does: read its
// signature and timestamp, then ask Google's batchexecute endpoint (one request for all links).
// Results are kept in fastn.state, so each link is resolved once across runs and customers.
async function resolveGoogleLinks(fastn, sections, warnings) {
  const items = sections.flatMap(x => x.items).filter(i => /^https:\/\/news\.google\.com\/rss\/articles\//.test(i.link));
  if (!items.length) return { total: 0, unresolved: 0 };
  const idOf = link => link.split("/articles/")[1].split("?")[0];
  let cache = {};
  try {
    cache = (await fastn.state.get(GN_CACHE_KEY)) || {};
  } catch (e) { /* start with an empty cache */ }

  const todo = [...new Set(items.map(i => i.link).filter(l => !cache[idOf(l)]))];
  if (todo.length) {
    try {
      const pages = (await Promise.all(todo.map(async link => {
        try {
          const html = await (await fetch(link, { headers: { "User-Agent": BROWSER_UA } })).text();
          const id = (html.match(/data-n-a-id="([^"]+)"/) || [])[1];
          const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
          const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
          return id && ts && sg ? { key: idOf(link), id, ts: Number(ts), sg } : null;
        } catch (e) {
          return null;
        }
      }))).filter(Boolean);
      if (pages.length) {
        const options = [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0];
        // Each request carries its 1-based position as its id ("1", "2", ...).
        const freq = [pages.map((p, n) => ["Fbv4je", JSON.stringify(["garturlreq", options, p.id, p.ts, p.sg]), null, String(n + 1)])];
        const r = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": BROWSER_UA },
          body: "f.req=" + encodeURIComponent(JSON.stringify(freq)),
        });
        const text = await r.text();
        // Answers come back in any order, each echoing its request id in row[6]:
        // [["wrb.fr","Fbv4je","[\"garturlres\",\"<url>\",1]",null,null,null,"4"], ...]
        JSON.parse(text.slice(text.indexOf("["))).filter(row => row[0] === "wrb.fr").forEach(row => {
          try {
            const page = pages[Number(row[6]) - 1];
            const url = JSON.parse(row[2])[1];
            if (page && /^https?:\/\//.test(url)) cache[page.key] = url;
          } catch (e) { /* leave this one unresolved */ }
        });
      }
      const keys = Object.keys(cache);
      for (const k of keys.slice(0, Math.max(0, keys.length - GN_CACHE_MAX))) delete cache[k];
      await fastn.state.set(GN_CACHE_KEY, cache);
    } catch (e) {
      warnings.push({ source: "Google News links", error: e.message });
    }
  }

  let unresolved = 0;
  for (const i of items) {
    const url = cache[idOf(i.link)];
    if (url) i.link = url;
    else unresolved++;
  }
  if (unresolved) warnings.push({ source: "Google News links", error: `${unresolved} link(s) left as Google News redirects` });
  return { total: items.length, unresolved };
}

// The lookup above uses an undocumented Google endpoint. When it stops working the digest still
// posts, with Google News links again, so the owner gets an alert instead of an error.
async function alertGoogleLinks(fastn, { total, unresolved }, warnings) {
  try {
    await fastn.alerts.send(GN_ALERT_RULE, {
      title: `News digest: ${unresolved} of ${total} Google News links not resolved`,
      message: "These stories link to Google News, which may open its home page instead of the article. "
        + "If this repeats, Google's link lookup has probably changed and resolveGoogleLinks in news-digest-slack needs updating.",
      severity: unresolved === total ? "critical" : "warning",
      key: "google-links",
      data: { total, unresolved },
    });
  } catch (e) {
    warnings.push({ source: "Google links alert", error: e.message });
  }
}

// ---------- Slack ----------

// Unwraps a Slack connector call and turns Slack's { ok: false, error } into an exception.
async function slackCall(action, call) {
  const r = await call;
  const out = r?.output ?? r;
  if (out && out.ok === false) {
    const err = new Error(`Slack ${action}: ${out.error}`);
    err.slackError = out.error;
    throw err;
  }
  return out;
}

async function resolveChannel(fastn, name) {
  if (/^[CG][A-Z0-9]{8,}$/.test(name)) {
    const info = await slackCall("listConversationsInfo", fastn.connector.slack.listConversationsInfo({ channel: name }));
    const c = info.channel;
    return { id: c.id, name: c.name, member: !!c.is_member, private: !!c.is_private };
  }
  let cursor;
  for (let page = 0; page < 50; page++) {
    const r = await slackCall("listConversationsList", fastn.connector.slack.listConversationsList({
      types: "public_channel,private_channel", exclude_archived: true, limit: 1000, ...(cursor ? { cursor } : {}),
    }));
    const c = (r.channels || []).find(x => x.name === name);
    if (c) return { id: c.id, name: c.name, member: !!c.is_member, private: !!c.is_private };
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return null;
}

function buildBlocks(sections, s, dateLabel) {
  const blocks = [{ type: "header", text: { type: "plain_text", text: `📰 News digest · ${dateLabel}`, emoji: true } }];
  for (const sec of sections) {
    const lines = sec.items.length
      ? sec.items.map(i => {
          const title = shorten(i.title, MAX_TITLE).replace(/\|/g, "∣");
          const src = i.source ? ` · _${slackEscape(i.source)}_` : "";
          const outlets = sec.key === "top" && i.outlets > 1 ? ` (${i.outlets} outlets)` : "";
          return `• <${i.link}|${slackEscape(title)}>${src}${outlets}`;
        })
      : [sec.failed ? "_Couldn't load this section today_"
        : sec.key === "engineering" ? `_No new posts in the last ${s.blogHours}h_` : "_Nothing to show today_"];
    // A section block holds at most 3000 characters; split long sections across blocks.
    let chunk = `*${sec.title}*`;
    for (const line of lines) {
      if ((chunk + "\n" + line).length > 2900) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
        chunk = line;
      } else chunk += "\n" + line;
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    blocks.push({ type: "divider" });
  }
  blocks.pop();
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Google News · Reddit · engineering blogs. Change channel, sections or sources in your fastn settings." }] });
  return blocks.slice(0, 50);
}

// ---------- publishing to the GitHub site ----------

const PUBLISH_ACTION = "publish-digest.yml";
const MAX_DISPATCH_CHARS = 60000;   // GitHub accepts at most 65,535 characters of workflow_dispatch inputs

// Hands this run's digest to the repo's "Publish digest" Action, which writes docs/data/<date>.json,
// latest.json and the archive index in one commit, so the site gets one commit and one Pages build.
async function publishDigest(fastn, s, result, now) {
  const [owner, repo] = s.publishRepo.split("/");
  const date = now.toISOString().slice(0, 10);
  const digest = JSON.stringify({
    date, generatedAt: now.toISOString(), overview: result.overview || "", totalItems: result.totalItems,
    sections: result.sections.map(({ key, title, items }) => ({ key, title, items })),
  });
  if (digest.length > MAX_DISPATCH_CHARS) throw new Error(`digest is ${digest.length} characters; GitHub takes at most ${MAX_DISPATCH_CHARS}`);
  const r = await fastn.connector.github.dispatchWorkflow({ owner, repo, workflow_id: PUBLISH_ACTION, ref: "main", inputs: { date, digest } });
  if (r?.success === false) throw new Error(`dispatching ${PUBLISH_ACTION}: HTTP ${r.status} ${r.error || ""}`.trim());
  const out = r?.output ?? r;
  return out?.html_url || `https://github.com/${owner}/${repo}/actions/workflows/${PUBLISH_ACTION}`;
}

// ---------- main ----------

export default async function (ctx) {
  const input = ctx.input || {};
  const dryRun = input.dryRun === true;
  // Only the schedule (empty input) is limited to one post per hour slot; { force: true } posts regardless.
  const scheduled = Object.keys(input).length === 0;
  const fastn = new Fastn({ connectors: { slack: { orgId: "managed" }, github: { orgId: "managed" } } });

  const warnings = [];
  const result = { posted: false, skipped: false, dryRun, channel: null, joinedChannel: false, sections: [], totalItems: 0, errors: 0, errorDetails: [], warnings };

  // The customer's own copy of the settings; before they have one, the template's defaults.
  let config = await fastn.config.getByTemplate(TEMPLATE_ID);
  if (!(config?.entities ?? config?.directions ?? []).length) config = await fastn.config.get(TEMPLATE_ID);
  const s = settingsFrom(config);
  if (!s.sections.length) {
    result.errors = 1;
    result.errorDetails.push({ error: "Settings not found", detail: `No sections are enabled in config ${TEMPLATE_ID}.` });
    return result;
  }

  const enabled = s.sections.filter(k => {
    if (SECTIONS[k]) return true;
    warnings.push({ source: `section '${k}'`, error: "unknown section, ignored" });
    return false;
  });

  const loaders = {
    top: () => topStories(s),
    geopolitics: () => topicSection(s, SECTIONS.geopolitics.topic),
    business: () => topicSection(s, SECTIONS.business.topic),
    technology: () => topicSection(s, SECTIONS.technology.topic),
    ai: () => aiSection(s),
    reddit: () => redditSection(fastn, s, warnings),
    engineering: () => engineeringSection(s, warnings),
  };
  const loaded = await Promise.all(enabled.map(async key => {
    try {
      return { key, items: await loaders[key]() };
    } catch (e) {
      warnings.push({ source: SECTIONS[key].title, error: e.message });
      return { key, items: [], failed: true };
    }
  }));

  // Keep each story once, in the first section it appears in.
  const seenLinks = new Set();
  const seenTitles = new Set();
  const sections = loaded.map(({ key, items, failed }) => {
    const picked = [];
    for (const i of items) {
      if (picked.length >= s.items) break;
      const t = normTitle(i.title);
      if (seenLinks.has(i.link) || seenTitles.has(t)) continue;
      seenLinks.add(i.link);
      seenTitles.add(t);
      picked.push(i);
    }
    return { key, title: SECTIONS[key].title, items: picked, failed: !!failed };
  });

  result.googleLinks = await resolveGoogleLinks(fastn, sections, warnings);
  if (result.googleLinks.unresolved >= GN_ALERT_MIN) await alertGoogleLinks(fastn, result.googleLinks, warnings);

  result.sections = sections.map(x => ({
    key: x.key, title: x.title, count: x.items.length,
    items: x.items.map(i => ({ title: i.title, source: i.source, link: i.link, published: i.published ? new Date(i.published).toISOString() : null, outlets: i.outlets })),
  }));
  result.totalItems = sections.reduce((n, x) => n + x.items.length, 0);

  if (result.totalItems === 0) {
    result.errors = 1;
    result.errorDetails.push({ error: "No news could be loaded", detail: "Every enabled source failed or returned nothing; no digest was posted." });
    return result;
  }

  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const blocks = buildBlocks(sections, s, dateLabel);

  // AI overview from today's headlines, via fastn's built-in model. Optional: if the call
  // fails the digest still posts, without the overview.
  if (s.aiOverview) {
    try {
      const headlines = sections.filter(x => x.items.length)
        .map(x => `${x.title}\n` + x.items.map(i => `- ${i.title}${i.source ? ` (${i.source})` : ""}`).join("\n"))
        .join("\n\n");
      const reply = await fastn.ai.complete({
        systemPrompt: "You write a short news briefing for a Slack channel. Use only the headlines you are given. No preamble, no headings, no links.",
        prompt: `Today's headlines by section:\n\n${headlines}\n\nWrite 3 to 5 bullet points, each starting with "• ", on what is happening across geopolitics, business, technology and AI. One sentence each, at most 30 words.`,
      });
      result.overview = String(reply || "").trim().slice(0, 2500);
    } catch (e) {
      warnings.push({ source: "AI overview", error: e.message });
    }
    if (result.overview) {
      blocks.splice(1, 0, { type: "section", text: { type: "mrkdwn", text: `*🧭 Overview*\n${slackEscape(result.overview)}` } }, { type: "divider" });
    }
  }

  // Publishing is best-effort: a GitHub failure never stops the Slack digest.
  const publish = async () => {
    try {
      result.publishedTo = await publishDigest(fastn, s, result, now);
    } catch (e) {
      warnings.push({ source: "GitHub publish", error: e.message });
    }
  };

  const text = `News digest · ${dateLabel}: ${result.totalItems} stories`;
  result.blockCount = blocks.length;
  if (dryRun) {
    if (input.publish === true && s.publishRepo) await publish();
    return result;
  }

  if (!s.channel) {
    result.errors = 1;
    result.errorDetails.push({ error: "No Slack channel set", detail: "Set slackChannel in the settings." });
    return result;
  }

  try {
    const ch = await resolveChannel(fastn, s.channel);
    if (!ch) {
      result.errors = 1;
      result.errorDetails.push({ error: `Slack channel '${s.channel}' was not found`, detail: "Create the channel or fix slackChannel in the settings (name without #)." });
      return result;
    }
    result.channel = { id: ch.id, name: ch.name };

    // One post per channel per hour slot: a retried or duplicated tick is skipped, while a
    // schedule with several times a day (e.g. 09:00 and 18:00) still posts each time.
    const stateKey = `newsdigest:posted:${ch.id}:${now.toISOString().slice(0, 13)}`;
    if (scheduled && (await fastn.state.get(stateKey))) {
      result.skipped = true;
      result.reason = "already posted in this hour";
      return result;
    }

    if (!ch.member) {
      if (ch.private) {
        result.errors = 1;
        result.errorDetails.push({ error: "not_in_channel", detail: `'${ch.name}' is private. Invite the fastn app to it (/invite @fastn) and run again.` });
        return result;
      }
      await slackCall("createConversationsJoin", fastn.connector.slack.createConversationsJoin({ channel: ch.id }));
      result.joinedChannel = true;
    }

    const posted = await slackCall("createChatPostMessage", fastn.connector.slack.createChatPostMessage({
      channel: ch.id, text, blocks: JSON.stringify(blocks), unfurl_links: false, unfurl_media: false,
    }));
    result.posted = true;
    result.ts = posted.ts;
    if (scheduled) await fastn.state.set(stateKey, { ts: posted.ts, postedAt: now.toISOString() });
  } catch (e) {
    result.errors = 1;
    result.errorDetails.push({
      error: e.slackError || e.message,
      detail: e.slackError === "not_in_channel" ? "Invite the fastn app to the channel (/invite @fastn) and run again." : "Slack rejected the request.",
    });
  }
  if (result.posted && s.publishRepo) await publish();
  return result;
}
