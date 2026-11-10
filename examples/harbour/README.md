# Harbour

A small Vite site used as the Quay sample. The built folder is a few kilobytes: one page, a nested log, a 404 page, and a tiny PNG.

Build it, then publish from the repository root:

```sh
npm install
npm run build
quay deploy ./dist -m "harbour 1"
quay promote 1
```

The live sample has three releases and one rollback. The source here matches release 3. Production was rolled back to release 2 after release 3 was sealed, so the site root and `/r/3/` are different pages.

The workflow in `.github/workflows/preview.yml` deploys a preview with the publish-only key. It does not call promote.
