// News digest registrations from GitHub.
// Open issues labelled "register" on the public site repo become personal fastn setup links for
// the News digest widget, posted as an issue comment. The requester can comment "new link" to get
// a fresh one.
// ctx.input: a GitHub webhook delivery (issues / issue_comment) = run now for that event,
// {} = scheduled fallback run, { dryRun: true } = report without acting.

const OWNER = "Waqas-Shah-42-fastn";
const REPO = "news-digest";
const WIDGET_ID = "wgt_90ffc04c1722";
const FASTN_API = "https://api.fastn.dev/api/v1";
const LINK_MINUTES = 120;   // links are posted publicly, so keep them short-lived
const MAX_PER_RUN = 20;     // cheap guard against a flood of requests
const REGISTER = "register";
const INVITED = "invited";
const MARKER = "<!-- news-digest-invite -->";

async function gh(call) {
  const r = await call;
  return r?.output ?? r;
}

function labelNames(issue) {
  return (issue?.labels || []).map(l => (typeof l === "string" ? l : l.name));
}

// Why a webhook delivery cannot lead to an invite, or null when it might. The delivery only wakes
// the workflow up: the issues are read again from GitHub below, so a forged or replayed delivery
// can do no more than a scheduled run.
function ignoreReason(event) {
  if (!event.issue) return event.zen ? "ping" : "not an issue event";
  if (event.issue.pull_request) return "pull request";
  if (!labelNames(event.issue).includes(REGISTER)) return "not a registration issue";
  if (event.comment) {
    const body = event.comment.body || "";
    if (body.includes(MARKER)) return "our own invite comment";
    if (event.action !== "created") return `comment ${event.action}`;
    if (event.comment.user?.login !== event.issue.user?.login) return "comment not by the requester";
    if (!/new link/i.test(body)) return "comment does not ask for a new link";
    return null;
  }
  // Not "labeled": GitHub sends it alongside "opened" for an issue created with labels, and two
  // runs at once would both post an invite. A label added later is picked up by the fallback run.
  if (event.action === "opened" || event.action === "reopened") return null;
  return `issue ${event.action}`;
}

async function createSetupLink(apiKey, issue) {
  const login = issue.user.login;
  const r = await fetch(`${FASTN_API}/setup-links`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      widgetId: WIDGET_ID,
      connectionName: "Slack",
      externalRef: `github-${login.toLowerCase()}`,
      createIfMissing: true,
      expiresInMinutes: LINK_MINUTES,
      label: `News digest · ${login}`,
      metadata: { github: login, issue: issue.number },
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`fastn setup link: HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.data ?? body;
}

function inviteText(login, link) {
  return `${MARKER}
Hi @${login}, here is your personal setup link for the news digest:

**${link.setupUrl}**

1. Open it and connect your Slack workspace.
2. Set the channel, and if you like, the sections and sources.
3. The digest arrives every day at 09:00 Pakistan time; you can change the time during setup.

The link works once and expires ${new Date(link.expiresAt).toUTCString()}. If it expires or someone else uses it first, comment \`new link\` here and a fresh one follows on the next check (within 6 hours).`;
}

// True when the requester asked for a new link after the most recent invite.
async function wantsNewLink(fastn, issue) {
  const comments = await gh(fastn.connector.github.listIssueComments({ owner: OWNER, repo: REPO, issue_number: issue.number, per_page: 100 }));
  const list = Array.isArray(comments) ? comments : [];
  let lastInvite = -1;
  list.forEach((c, i) => { if ((c.body || "").includes(MARKER)) lastInvite = i; });
  return list.slice(lastInvite + 1).some(c => c.user?.login === issue.user.login && /new link/i.test(c.body || ""));
}

export default async function (ctx) {
  const input = ctx.input || {};
  const dryRun = input.dryRun === true;
  const result = { dryRun, checked: 0, invited: 0, reissued: 0, skipped: 0, errors: 0, errorDetails: [] };

  // Anything other than {} or { dryRun } is a GitHub webhook delivery.
  const event = Object.keys(input).some(k => k !== "dryRun") ? input : null;
  if (event) {
    result.event = `${event.comment ? "issue_comment" : event.issue ? "issues" : "other"}.${event.action || "-"}`;
    const reason = ignoreReason(event);
    if (reason) {
      result.ignored = reason;
      return result;
    }
  }

  const fastn = new Fastn({ connectors: { github: { orgId: "managed" } } });
  if (dryRun) result.wouldInvite = [];

  const issues = await gh(fastn.connector.github.listIssues({ owner: OWNER, repo: REPO, state: "open", labels: REGISTER, per_page: 100, sort: "created", direction: "asc" }));
  let apiKey = null;
  let budget = MAX_PER_RUN;

  for (const issue of Array.isArray(issues) ? issues : []) {
    if (issue.pull_request) continue;
    result.checked++;
    const labels = labelNames(issue);
    const invited = labels.includes(INVITED);
    const reason = !invited ? "new" : (await wantsNewLink(fastn, issue)) ? "new link" : null;
    if (!reason) {
      result.skipped++;
      continue;
    }
    if (budget-- <= 0) break;
    if (dryRun) {
      result.wouldInvite.push({ issue: issue.number, login: issue.user.login, reason });
      continue;
    }
    try {
      apiKey = apiKey || await fastn.secrets.get("NEWS_DIGEST_FASTN_API_KEY");
      const link = await createSetupLink(apiKey, issue);
      await gh(fastn.connector.github.createIssueComment({ owner: OWNER, repo: REPO, issue_number: issue.number, body: inviteText(issue.user.login, link) }));
      if (!invited) await gh(fastn.connector.github.updateIssue({ owner: OWNER, repo: REPO, issue_number: issue.number, labels: [...labels, INVITED] }));
      if (reason === "new") result.invited++;
      else result.reissued++;
    } catch (e) {
      result.errors++;
      result.errorDetails.push({ issue: issue.number, error: e.message });
    }
  }
  return result;
}
