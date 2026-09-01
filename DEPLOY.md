# Deploying Resolute Portal to Vercel

The app is a static **Vite + React** single-page app. Vercel hosts it directly —
no server required. (The backend, when added, will be Supabase: Postgres + Auth +
Storage + Realtime, called straight from the browser with the anon key + RLS.)

## One-time setup (Vercel dashboard)

1. Go to **vercel.com → Add New → Project** and import the GitHub repo
   `Sagar-Dabasia/Resolute`.
2. Vercel auto-detects the framework from `vercel.json`:
   - **Framework Preset:** Vite
   - **Build Command:** `vite build` (default)
   - **Output Directory:** `dist` (default)
   - **Install Command:** `npm install` (default)
3. Click **Deploy**. First build takes ~1–2 min; you get a live URL.

That's it. No env vars are needed yet (the app currently runs on mock data).

## How routing works

`vercel.json` rewrites every path to `/index.html` so React Router can handle
client-side routes. Without this, refreshing or deep-linking to a route like
`/typer/order/RTS-10048` would 404. The rewrite fixes that.

## Branch behavior

- **Production:** every push/merge to `main` deploys to the production URL.
- **Previews:** every PR gets its own preview URL automatically — great for
  reviewing each role's screens before merging.

## When the Supabase backend is added (later phase)

Set these in **Vercel → Project → Settings → Environment Variables** (never commit them):

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | the **anon** public key (safe for the browser with RLS on) |

Only the `VITE_`-prefixed vars are exposed to the client build, which is exactly
what we want for the anon key. The service-role key must **never** be put here —
it stays server-side (Supabase Edge Functions / Vercel serverless functions).

## Local build sanity check

```bash
npm install
npm run build      # outputs to dist/
npm run preview    # serve the production build locally
```

A green local build is **not** enough on its own — see the next section.

## vercel.json: no comments, and it is validated before the build

Vercel validates `vercel.json` against its schema *before* it starts building.
An invalid file fails the deployment at that point, so there is no build log to
read — the deploy just never happens, and the last good build keeps serving.
That is a silent failure mode: the site looks fine, it is simply frozen.

This happened. A `"comment"` key was added to each `headers[]` entry to explain
the caching rules. `headers[]` items allow only `source`, `headers`, `has` and
`missing`, with `additionalProperties: false`, so every deployment failed from
that commit onward — for three weeks, while `npm run build` passed locally the
whole time.

**JSON has no comments. Explanations go here, not in the file.**

### Why the cache headers exist

`vercel.json` rewrites every non-`/api` path to `/index.html`. Without cache
rules the shell could be served from cache, and `index.html` is the only file
that names the current hashed bundle — so a cached shell keeps loading the
*previous* deploy's JS and the app stays on old code indefinitely, immune to a
plain refresh.

- `/assets/*` is content-hashed, so the filename changes whenever the content
  does: safe to cache for a year, `immutable`.
- Everything else is the shell: `max-age=0, must-revalidate`.

### Checking the file before you push

```bash
curl -s https://openapi.vercel.sh/vercel.json -o /tmp/vercel-schema.json
python3 -c "
import json; from jsonschema import Draft7Validator
errs = list(Draft7Validator(json.load(open('/tmp/vercel-schema.json'))).iter_errors(json.load(open('vercel.json'))))
print('valid' if not errs else [f\"{'/'.join(map(str,e.path))}: {e.message}\" for e in errs])
"
```

### Confirming a deploy actually shipped

Compare what the live site serves against what you expect, rather than trusting
the dashboard:

```bash
curl -s https://<your-app>/ | grep -oE '/assets/[^"]+\.css'   # current bundle
curl -s https://<your-app>/assets/index-XXXX.css | grep -c '#2441E5'
```

`0` means the deployment predates the current palette.
