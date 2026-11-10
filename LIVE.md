# Live deployments

Everything here is NEAR testnet. Transaction links open on the testnet explorer.

## Product site: `quay-esc0v902.testnet`

Hosts: https://quay.ss251.workers.dev/ (Workers mirror, primary), https://quay-esc0v902.testnet.page/, or `quay gateway --account quay-esc0v902.testnet`.

| Release | Role | Seal | Promote |
| --- | --- | --- | --- |
| 11 | production (dashboard probes the viewed account's own hosts and reads the relay from `quay-site.json`; board mirror link) | [3gV5PS5h…](https://explorer.testnet.near.org/transactions/3gV5PS5h3GLWDnswgtaJmk21v2SFxBRtxkfN2Asxm6zT) | [7otR3HuV…](https://explorer.testnet.near.org/transactions/7otR3HuVsu8ooLLzpAZVbx7sWWtEPJ1jU4GPnPmuo9G8) |
| 10 | previous, the rollback target (`quay rollback --account quay-esc0v902.testnet`) | [2opmA397…](https://explorer.testnet.near.org/transactions/2opmA397eFod68XsULSp5dwfnbQEo1536FEwteFWemP7) | [6Z36kLW9…](https://explorer.testnet.near.org/transactions/6Z36kLW9k11Tiks3E5GSTfKKjEv22rxD6WesxgZKQHQd) |
| 9 | older production, kept | [GegcmRL3…](https://explorer.testnet.near.org/transactions/GegcmRL3wurnmnQGqZk7bAqK5mKizR5b5fP611CKRxTg) | [CvfPW9CG…](https://explorer.testnet.near.org/transactions/CvfPW9CGFDA1JdMk5nGgW9PmBJi1PpXxmZbJRW4cvnPw) |

Releases 4 (the old design, linked from the README) and 8 are kept. Releases 1, 2, 3, 5, 6 and 7 were unreferenced previews and were deleted on 2026-11-10 to unlock storage before release 10. The account still runs the v2 contract; it needs nothing from v3.

## Harbour Board: `harbour-board.testnet`

The full-stack sample (v3 contract). Every transaction, call id and check is in [`examples/board/LIVE.md`](examples/board/LIVE.md).

## Harbour static sample: `quay-65nqd3rn.testnet`

https://quay-harbour.ss251.workers.dev/ (Workers mirror) or https://quay-65nqd3rn.testnet.page/. Unchanged by this work.
