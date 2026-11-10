# Agent example

This script uses the `quay-near` package as a library. An agent account calls `buy` with 0.02 NEAR, which records the payment and leaves the NEAR on the contract account to cover storage. The publish-only key then deploys `site/`. A promote from that key exits 3 and does not send a transaction.

```sh
npm install
export QUAY_ACCOUNT=your-site.testnet
export QUAY_AGENT=your-agent.testnet
node agent.mjs
```

`QUAY_AGENT` needs a full-access key at `~/.near-credentials/testnet/<agent>.json`. `QUAY_ACCOUNT` needs `quay.json` or the flag above, plus a publish-only key from `quay keys create --ci` (the file `<account>.ci.json`, or `QUAY_CI_KEY` in the environment). The script does not print either secret.

To see the chain refuse the key, rather than the local check, run `quay keys prove` with the account's full-access key. That relays a promote signed by the publish-only key and expects the protocol to reject it.
