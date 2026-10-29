# News Digest

A daily news digest covering geopolitics, business, technology, AI companies, Reddit and engineering blogs. It is built on [fastn](https://fastn.ai), posted to each registered Slack workspace, and published as a static site.

- **Site:** https://waqas-shah-42-fastn.github.io/news-digest/
- **Register:** https://waqas-shah-42-fastn.github.io/news-digest/register.html

## Sections

| Key | Title |
| --- | --- |
| `top` | 🔝 Top stories (headlines covered by the most outlets) |
| `geopolitics` | 🌍 Geopolitics |
| `business` | 💼 Business |
| `technology` | 💻 Technology |
| `ai` | 🤖 AI companies |
| `reddit` | 👽 Reddit |
| `engineering` | 🛠️ Engineering blogs |

## Sources

- **Google News RSS:** topic feeds plus search queries.
- **Reddit:** top-of-day RSS feeds.
- **Engineering blog RSS:** Netflix, Stripe, Cloudflare, Meta, Airbnb, GitHub, Shopify, Discord, Spotify, Dropbox, Slack, Pinterest, OpenAI, Google DeepMind.

## How it works

1. The fastn workflow `news-digest-slack` runs once a day.
2. It fetches the feeds and groups the stories into sections. Top stories are the headlines covered by the most outlets.
3. It posts the digest to the Slack channel of every registered workspace.
4. It publishes the same digest as JSON to `docs/data/` in this repo (GitHub contents API). GitHub Pages serves `docs/` from `main`, and the site renders the JSON in the browser. There is no build step.

## Data format

All dates are UTC.

`docs/data/latest.json` and `docs/data/YYYY-MM-DD.json`:

```json
{
  "date": "2026-10-29",
  "generatedAt": "2026-10-29T04:00:12Z",
  "overview": "• bullet one\n• bullet two",
  "totalItems": 35,
  "sections": [
    {
      "key": "top",
      "title": "🔝 Top stories",
      "items": [
        {
          "title": "...",
          "source": "BBC",
          "link": "https://...",
          "published": "2026-10-29T11:27:05.000Z",
          "outlets": 5
        }
      ]
    }
  ]
}
```

- Sections appear in this order: `top`, `geopolitics`, `business`, `technology`, `ai`, `reddit`, `engineering`. A section can have zero items.
- `overview` is a string of bullet lines. It may be empty or missing.
- `outlets` appears only on `top` items. `published` may be `null`.
- A top-level `"sample": true` marks placeholder data. The site then shows a "sample data" banner.

`docs/data/index.json` lists every published digest, newest first:

```json
{
  "updatedAt": "2026-10-29T04:00:12Z",
  "digests": [{ "date": "2026-10-29", "totalItems": 35 }]
}
```

The files committed today are a sample for 2026-10-29. The first real run replaces them.

## Register

1. Open the [registration form](https://github.com/Waqas-Shah-42-fastn/news-digest/issues/new?template=register.yml). You need a GitHub account.
2. Within a minute or two a bot comments a personal, single-use fastn setup link on your issue.
3. Open it, connect your Slack workspace, pick a channel and, if you like, adjust sections and sources.
4. The digest arrives daily at the time you chose.

The setup link expires after 2 hours (issues are public, so links are kept short-lived). If it expires, comment `new link` on the issue.

## Local preview

```sh
cd docs && python -m http.server 8000
```

Then open http://localhost:8000.

## License

[MIT](LICENSE)
