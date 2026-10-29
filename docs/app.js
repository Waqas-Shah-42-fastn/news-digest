// News Digest viewer. Static, no dependencies.
// All untrusted strings are inserted with textContent / text nodes, never innerHTML.
'use strict';

(function () {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const els = {
    main: document.getElementById('main'),
    picker: document.getElementById('picker'),
    select: document.getElementById('date-select'),
    status: document.getElementById('status'),
    digest: document.getElementById('digest'),
  };

  let digests = [];   // [{ date, totalItems }] newest first
  let loadToken = 0;  // guards against out-of-order responses

  // ---------- helpers ----------

  // Build an element. `props.text` sets textContent; other props become attributes.
  // Children may be nodes or strings (strings become text nodes, so they are never parsed as HTML).
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  async function fetchJSON(path) {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.json();
  }

  function str(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // Only allow http(s) links.
  function safeUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  function parseDay(date) {
    return new Date(`${date}T00:00:00Z`);
  }

  function formatDay(date, style) {
    const d = parseDay(date);
    if (Number.isNaN(d.getTime())) return date;
    const opts = style === 'short'
      ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };
    return d.toLocaleDateString(undefined, opts);
  }

  const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
    ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    : null;

  function relativeTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const diff = (t - Date.now()) / 1000;
    const units = [
      ['year', 31536000], ['month', 2592000], ['week', 604800],
      ['day', 86400], ['hour', 3600], ['minute', 60],
    ];
    for (const [unit, secs] of units) {
      if (Math.abs(diff) >= secs) {
        const n = Math.round(diff / secs);
        return rtf ? rtf.format(n, unit) : `${Math.abs(n)} ${unit}${Math.abs(n) === 1 ? '' : 's'} ${n < 0 ? 'ago' : 'from now'}`;
      }
    }
    return 'just now';
  }

  function overviewLines(text) {
    if (typeof text !== 'string') return [];
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[•\-*·▪◦]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
  }

  function hashDate() {
    let raw = location.hash.slice(1);
    try { raw = decodeURIComponent(raw); } catch (_) { /* keep raw */ }
    return DATE_RE.test(raw) ? raw : null;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  // ---------- status / errors ----------

  function setStatus(message) {
    els.status.textContent = message || '';
  }

  function showError(err, date) {
    setStatus('');
    const actions = h('p', { class: 'error-actions' },
      h('button', { type: 'button', class: 'btn btn-small' }, 'Try again'));
    actions.firstChild.addEventListener('click', () => route(true));
    if (date) {
      const latest = h('a', { href: './' }, 'Go to the latest digest');
      latest.addEventListener('click', (e) => {
        e.preventDefault();
        history.pushState(null, '', location.pathname + location.search);
        route(true);
      });
      actions.append(' ', latest);
    }
    const box = h('div', { class: 'card error', role: 'alert' },
      h('h1', { class: 'error-title', tabindex: '-1' },
        date ? `Couldn't load the digest for ${formatDay(date)}` : "Couldn't load the digest"),
      h('p', null, 'The data file could not be fetched. It may not have been published yet, or you may be offline.'),
      h('p', { class: 'muted small' }, String(err && err.message ? err.message : err)),
      actions);
    els.digest.replaceChildren(box);
  }

  // ---------- rendering ----------

  function renderItem(item, isTop) {
    const title = str(item && item.title) || 'Untitled';
    const href = safeUrl(item && item.link);
    const headline = href
      ? h('a', { class: 'headline', href, target: '_blank', rel: 'noopener' },
          title, h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'))
      : h('span', { class: 'headline' }, title);

    const meta = h('div', { class: 'meta' });
    const source = str(item && item.source);
    if (source) meta.append(h('span', { class: 'source' }, source));

    const published = item && item.published;
    const rel = published ? relativeTime(published) : null;
    if (rel) {
      const d = new Date(published);
      meta.append(h('time', { datetime: d.toISOString(), title: d.toLocaleString() }, rel));
    }

    const outlets = Number(item && item.outlets);
    if (isTop && Number.isFinite(outlets) && outlets > 1) {
      meta.append(h('span', { class: 'badge', title: `Reported by ${outlets} outlets` }, `${outlets} outlets`));
    }

    return h('li', { class: 'item' }, headline, meta.childNodes.length ? meta : null);
  }

  function renderSection(section, index) {
    const key = str(section && section.key) || `section-${index}`;
    const id = `sec-${key.replace(/[^a-z0-9_-]/gi, '') || index}`;
    const items = Array.isArray(section && section.items) ? section.items.filter(Boolean) : [];
    const isTop = key === 'top';

    return h('section', { class: `card section section-${key.replace(/[^a-z0-9_-]/gi, '')}`, 'aria-labelledby': id },
      h('div', { class: 'section-head' },
        h('h2', { id }, str(section && section.title) || key),
        h('span', { class: 'count' }, plural(items.length, 'item'))),
      items.length
        ? h('ol', { class: 'items' }, items.map((item) => renderItem(item, isTop)))
        : h('p', { class: 'empty' }, 'Nothing in this section today.'));
  }

  function renderDigest(data, date) {
    const sections = Array.isArray(data.sections) ? data.sections.filter(Boolean) : [];
    const counted = sections.reduce((n, s) => n + (Array.isArray(s.items) ? s.items.length : 0), 0);
    const total = Number.isFinite(Number(data.totalItems)) ? Number(data.totalItems) : counted;

    const frag = document.createDocumentFragment();

    if (data.sample === true) {
      frag.append(h('p', { class: 'banner', role: 'note' },
        h('strong', null, 'Sample data.'),
        ' This placeholder edition is shown until the first real digest is published.'));
    }

    const metaBits = [plural(total, 'item')];
    const generated = Date.parse(data.generatedAt);
    if (!Number.isNaN(generated)) {
      metaBits.push(`published ${new Date(generated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`);
    }

    frag.append(h('header', { class: 'digest-head' },
      h('p', { class: 'eyebrow' }, 'Daily digest'),
      h('h1', { id: 'digest-title', tabindex: '-1' }, date ? formatDay(date) : 'Latest digest'),
      h('p', { class: 'muted' }, metaBits.join(' · '))));

    const lines = overviewLines(data.overview);
    if (lines.length) {
      frag.append(h('section', { class: 'card overview', 'aria-labelledby': 'overview-title' },
        h('h2', { id: 'overview-title' }, 'Overview'),
        h('ul', null, lines.map((line) => h('li', null, line)))));
    }

    if (sections.length) {
      sections.forEach((s, i) => frag.append(renderSection(s, i)));
    } else {
      frag.append(h('p', { class: 'empty card' }, 'This digest has no sections.'));
    }

    els.digest.replaceChildren(frag);
  }

  function populatePicker() {
    els.select.replaceChildren();
    digests.forEach((d, i) => {
      const n = Number(d.totalItems);
      let label = formatDay(d.date, 'short');
      if (Number.isFinite(n)) label += ` · ${plural(n, 'item')}`;
      if (i === 0) label += ' (latest)';
      els.select.append(h('option', { value: d.date }, label));
    });
    els.picker.hidden = digests.length === 0;
  }

  function syncPicker(date) {
    if (!date) return;
    if (!digests.some((d) => d.date === date)) {
      // A dated file that isn't in index.json yet: still make it selectable.
      els.select.append(h('option', { value: date }, formatDay(date, 'short')));
      els.picker.hidden = false;
    }
    els.select.value = date;
  }

  // ---------- routing ----------

  async function route(fromUser) {
    const date = hashDate();
    const token = ++loadToken;
    const path = date ? `data/${date}.json` : 'data/latest.json';

    els.main.setAttribute('aria-busy', 'true');
    setStatus(date ? `Loading the digest for ${formatDay(date)}…` : 'Loading the latest digest…');

    try {
      const data = await fetchJSON(path);
      if (token !== loadToken) return;
      if (!data || typeof data !== 'object') throw new Error(`${path} is not a digest`);

      const shownDate = DATE_RE.test(data.date) ? data.date : date;
      renderDigest(data, shownDate);
      syncPicker(shownDate);
      setStatus('');
      document.title = shownDate ? `News Digest · ${formatDay(shownDate, 'short')}` : 'News Digest';
      if (fromUser) document.getElementById('digest-title').focus();
    } catch (err) {
      if (token !== loadToken) return;
      console.error(err);
      showError(err, date);
      if (fromUser) els.digest.querySelector('.error-title').focus();
    } finally {
      if (token === loadToken) els.main.removeAttribute('aria-busy');
    }
  }

  async function init() {
    // Skip link: focus <main> without touching the hash (the hash selects the edition).
    const skip = document.querySelector('[data-skip]');
    if (skip) {
      skip.addEventListener('click', (e) => {
        e.preventDefault();
        els.main.focus();
      });
    }

    els.select.addEventListener('change', () => {
      const value = els.select.value;
      if (!DATE_RE.test(value)) return;
      if (digests[0] && value === digests[0].date) {
        // Latest edition: drop the hash so the URL stays shareable as "latest".
        history.pushState(null, '', location.pathname + location.search);
        route(true);
      } else {
        location.hash = value;
      }
    });

    window.addEventListener('hashchange', () => {
      if (location.hash === '' || hashDate()) route(true);
    });

    try {
      const index = await fetchJSON('data/index.json');
      digests = (Array.isArray(index && index.digests) ? index.digests : [])
        .filter((d) => d && DATE_RE.test(d.date))
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch (err) {
      console.warn('Could not load data/index.json:', err);
      digests = [];
    }
    populatePicker();

    await route(false);
  }

  init();
})();
