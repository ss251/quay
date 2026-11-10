# Harbour

A small Vite site used as the Quay sample. The built folder is a few kilobytes: a board, a tide log, a berth page, a chart, a 404 page, and a tiny PNG.

Build it, then publish from a directory that has `quay.json`:

```sh
npm install
npm run build
quay deploy ./dist -m "harbour office"
quay promote 4
```

The live sample is https://quay-65nqd3rn.testnet.page/. Production is release 4. Release 2 is the previous production release, after a rollback from 3 and a later promote of 4. Older releases stay at `/r/1/`, `/r/2/`, and `/r/3/`.

The workflow in `.github/workflows/preview.yml` deploys a preview with the publish-only key. It does not call promote. `sh scripts/ci-local.sh` runs those steps on this machine.
