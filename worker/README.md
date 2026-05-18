# Von Peach — Worker

One Cloudflare Worker, two routes:

- `POST /portrait` — transforms a captured photo into an archetype-specific
  Baroque oil portrait via fal.ai's flux-kontext.
- `POST /send-card` — emails the rendered card as a JPEG attachment via
  Resend, with an archetype-specific short read in the body.

The Worker exists so neither API key ever leaves the server.

## One-time setup

1. Install Wrangler (Cloudflare's CLI) — `npm i -g wrangler`, or use `npx`.
2. From this `worker/` directory: `wrangler login`.
3. Get the keys:
   - fal.ai: <https://fal.ai/dashboard/keys>
   - Resend: <https://resend.com/api-keys>
4. Plant the keys as Worker secrets (NOT in any file, NOT in git):
   ```
   wrangler secret put FAL_KEY
   wrangler secret put RESEND_KEY
   ```
   Paste the value when prompted.
5. (Recommended) Verify `vonpeach.com` in Resend
   (<https://resend.com/domains>), then edit `FROM_EMAIL` in `wrangler.toml`
   to something like `"Von Peach <hello@vonpeach.com>"`. Without a verified
   domain Resend will only deliver to the address that owns the API key.
6. Deploy:
   ```
   wrangler deploy
   ```
   Note the URL Wrangler prints — typically
   `https://vonpeach-portrait.<your-subdomain>.workers.dev`.

## Wire the frontend

Open `../index.html`, find these constants near the top of the inline
`<script>`:

```js
const AI_PORTRAIT_ENDPOINT = "";
const EMAIL_ENDPOINT       = "/api/send-card";
```

Set them to:

```js
const AI_PORTRAIT_ENDPOINT = "https://vonpeach-portrait.<sub>.workers.dev/portrait";
const EMAIL_ENDPOINT       = "https://vonpeach-portrait.<sub>.workers.dev/send-card";
```

…using the URL Wrangler printed.

## Tighten CORS once it's working

In `src/index.js`, change:

```js
"Access-Control-Allow-Origin": "*",
```

to your actual deployed origin, e.g.:

```js
"Access-Control-Allow-Origin": "https://tarot.vonpeach.com",
```

…and redeploy.

## Costs

- fal.ai `flux-pro/kontext`: ~$0.04 per portrait. Free credits at signup
  usually cover hundreds of tries.
- Resend: free tier 3k emails/month, 100/day. Plenty for an event filter.
- Cloudflare Workers: free tier 100k requests/day.

## Rotating keys

If a key has been exposed (pasted in a transcript, screenshot, etc.):

1. In the provider dashboard, delete the exposed key and generate a new one.
2. `wrangler secret put FAL_KEY` (or `RESEND_KEY`) with the new value.
   No redeploy needed — secrets update live.
