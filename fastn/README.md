# fastn workflows

The code of the fastn workflows behind this site, kept here so changes can be reviewed and recovered.
fastn is the source of truth: the `news-digest-code-backup` workflow copies each workflow's published
code into this folder once a day, in one commit per changed file.

| File | Workflow | What it does | Trigger |
|---|---|---|---|
| `news-digest-slack.js` | News digest to Slack | Builds the digest, posts it to each subscriber's Slack channel and, for the site owner, dispatches the **Publish digest** Action | Daily 09:00 Asia/Karachi, per subscriber |
| `news-digest-register.js` | News digest registrations from GitHub | Turns `register` issues into personal setup links | GitHub webhook (issues, issue comments), plus a fallback run every 6 hours |
| `news-digest-code-backup.js` | News digest code backup | Copies the three workflows' code into this folder | Daily |

The site data in `docs/data/` is written by `.github/workflows/publish-digest.yml`, which the digest
workflow dispatches with the day's digest as JSON.

To change a workflow, edit it in fastn (or apply a reviewed change from here to fastn), publish it, and
let the backup bring the copy here up to date.
