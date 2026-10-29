// News digest code backup.
// Copies the published code of every "news-digest-*" workflow into fastn/<slug>.js in the public site
// repo, so changes can be reviewed and recovered there. Only files whose code changed are written,
// one commit each. ctx.input: {} = scheduled run, { dryRun: true } = report what would change.

const OWNER = "Waqas-Shah-42-fastn";
const REPO = "news-digest";
const FASTN_API = "https://api.fastn.dev/api/v1";
const SLUG = /^news-digest-/;

async function gh(call) {
  const r = await call;
  return r?.output ?? r;
}

async function fastnApi(apiKey, path) {
  const r = await fetch(`${FASTN_API}${path}`, { headers: { "Authorization": `Bearer ${apiKey}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`fastn ${path}: HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.data ?? body;
}

// The sandbox has no btoa/atob/TextEncoder, so GitHub's Base64 file contents are converted here
// (as UTF-8: the code carries emoji).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(str) {
  const b = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) b.push(c);
    else if (c < 0x800) b.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) b.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else b.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = b[i] << 16 | (b[i + 1] ?? 0) << 8 | (b[i + 2] ?? 0);
    out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < b.length ? B64[n >> 6 & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
  }
  return out;
}

function fromBase64(b64) {
  const s = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  let bin = "";
  for (let i = 0; i < s.length; i += 4) {
    const n = B64.indexOf(s[i]) << 18 | B64.indexOf(s[i + 1]) << 12 | (B64.indexOf(s[i + 2]) & 63) << 6 | (B64.indexOf(s[i + 3]) & 63);
    bin += String.fromCharCode(n >> 16 & 255);
    if (s[i + 2] !== undefined) bin += String.fromCharCode(n >> 8 & 255);
    if (s[i + 3] !== undefined) bin += String.fromCharCode(n & 255);
  }
  return decodeURIComponent(escape(bin));
}

// The file's current blob (sha + content), or null when it does not exist yet.
async function githubFile(fastn, path) {
  try {
    const f = await gh(fastn.connector.github.getContent({ owner: OWNER, repo: REPO, path }));
    return f?.sha ? f : null;
  } catch (e) {
    return null;
  }
}

export default async function (ctx) {
  const dryRun = ctx.input?.dryRun === true;
  const fastn = new Fastn({ connectors: { github: { orgId: "managed" } } });
  const result = { dryRun, checked: 0, updated: [], unchanged: [], errors: 0, errorDetails: [] };

  const apiKey = await fastn.secrets.get("NEWS_DIGEST_FASTN_API_KEY");
  const list = await fastnApi(apiKey, "/workflows?limit=100");
  const rows = Array.isArray(list) ? list : list.items ?? list.workflows ?? [];

  for (const w of rows.filter(x => SLUG.test(x.slug || ""))) {
    result.checked++;
    const path = `fastn/${w.slug}.js`;
    try {
      const wf = await fastnApi(apiKey, `/workflows/${w.id}`);
      const code = wf.devCode ?? wf.code;   // the published (running) code
      if (!code) throw new Error("no code returned");
      const existing = await githubFile(fastn, path);
      if (existing && fromBase64(existing.content) === code) {
        result.unchanged.push(w.slug);
        continue;
      }
      if (!dryRun) {
        await gh(fastn.connector.github.createOrUpdateFile({
          owner: OWNER, repo: REPO, path,
          message: `fastn: ${w.slug} v${wf.devVersion ?? wf.version}`,
          content: toBase64(code),
          ...(existing ? { sha: existing.sha } : {}),
        }));
      }
      result.updated.push(w.slug);
    } catch (e) {
      result.errors++;
      result.errorDetails.push({ workflow: w.slug, error: e.message });
    }
  }
  return result;
}
