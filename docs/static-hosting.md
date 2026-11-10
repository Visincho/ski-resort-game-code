# Static hosting (Cloudflare Pages)

The client is static files, so solo mode can be served from a CDN while the universe stays on the Node server (VPS).

## Build and deploy

```bash
npm run warm                      # once, with the server running: fills cache/ for the 33 famous resorts
npm run build:static              # -> dist/ (client + baked tiles + OSM)
npx wrangler login                # once
npm run deploy:cf                 # build + `wrangler pages deploy dist --project-name snowline`
```

Set `SNOWLINE_API=https://api.example.com` when building to enable the universe (see below). Without it the universe screen reports that the server is unreachable and solo mode works normally.

## What `build:static` does

- Copies `public/` to `dist/` and rewrites `dist/config.js` (`apiBase`).
- Copies only the tiles and `osm/<s>_<w>_<n>_<e>.json` files the famous resorts need (same bbox and zoom maths as `warm-cache.mjs`). Custom locations still load live: tiles from AWS, OSM from Overpass (slow, 30-200 s).
- `public/_headers` sets long cache times on vendor, fonts and tiles; `public/404.html` stops Cloudflare from answering missing files with `index.html` (SPA fallback).

Limits: 25 MB per file and about 20,000 files per deploy (currently ~830 files, ~90 MB).

## Load order for map data

- Tiles: `tiles/z/x/y.png` (baked or Node cache), then AWS.
- OSM: `osm/<key>.json` (baked), then `<apiBase>api/osm`, then Overpass directly.

## Universe on a VPS

The Node server already sends CORS `*`. Run it behind HTTPS (see `deploy/Caddyfile`) and build the static site with `SNOWLINE_API` set to its URL. Redeploy both sides when `public/js/shared/*` changes.
