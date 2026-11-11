# Live deployments

Everything here is NEAR testnet. Transaction links open on the testnet explorer.

## Product site: `quay-esc0v902.testnet`

Hosts: https://quay.ss251.workers.dev/ (Workers mirror, primary), https://quay-esc0v902.testnet.page/, or `quay gateway --account quay-esc0v902.testnet`.

| Release | Role | Seal | Promote |
| --- | --- | --- | --- |
| 14 | production since 2026-11-11: the round 5 design (full-stack home, a docs page per layer, the live dashboard canvas, a poster under the hero frame until it loads) | [b1cjw1Ah…](https://explorer.testnet.near.org/transactions/b1cjw1AhLzpUAyNUFq7GPNZ5HEvnmKgTiN5Y2LpfVLk) | [8Zzc3Ss6…](https://explorer.testnet.near.org/transactions/8Zzc3Ss6KkQLRsPXtjeTr9b3zwXdPcUYdZWN5SRxprUV) |
| 13 | preview, not promoted: the same design without the hero poster | [CCGMHppx…](https://explorer.testnet.near.org/transactions/CCGMHppxWkF5r2UDTWnii88anUJyVFd3o1TU1vA4WQLa) | none |
| 12 | previous, the rollback target (`quay rollback --account quay-esc0v902.testnet`); cron live on the Board, wallet sign-in shown with one connector, NEARFS wording | [EBb1X1jb…](https://explorer.testnet.near.org/transactions/EBb1X1jbSGbd7jCRxie1G6fEtX1XURmAXLQTQqPzhwGv) | [2zL7JdE7…](https://explorer.testnet.near.org/transactions/2zL7JdE7sLH4QS1QXAbdKr4DsoHqCXbLm8ySXzSuBmTn) |
| 11 | older production, kept | [3gV5PS5h…](https://explorer.testnet.near.org/transactions/3gV5PS5h3GLWDnswgtaJmk21v2SFxBRtxkfN2Asxm6zT) | [7otR3HuV…](https://explorer.testnet.near.org/transactions/7otR3HuVsu8ooLLzpAZVbx7sWWtEPJ1jU4GPnPmuo9G8) |
| 10 | older production, kept | [2opmA397…](https://explorer.testnet.near.org/transactions/2opmA397eFod68XsULSp5dwfnbQEo1536FEwteFWemP7) | [6Z36kLW9…](https://explorer.testnet.near.org/transactions/6Z36kLW9k11Tiks3E5GSTfKKjEv22rxD6WesxgZKQHQd) |
| 9 | older production, kept | [GegcmRL3…](https://explorer.testnet.near.org/transactions/GegcmRL3wurnmnQGqZk7bAqK5mKizR5b5fP611CKRxTg) | [CvfPW9CG…](https://explorer.testnet.near.org/transactions/CvfPW9CGFDA1JdMk5nGgW9PmBJi1PpXxmZbJRW4cvnPw) |

Releases 4 (the old design, linked from the README) and 8 are kept. Releases 1, 2, 3, 5, 6 and 7 were unreferenced previews and were deleted on 2026-11-10 to unlock storage before release 10. On 2026-11-11 a new faucet account, `qfund-za2p2fnl.testnet`, sent it 5 NEAR for the round 5 storage ([7iBCGQL7…](https://explorer.testnet.near.org/transactions/7iBCGQL7HHqAgfR2xLUqn2wNmh9EbPm5LePzjbL8PPmP)). On 2026-11-10 the account was topped up with 3 NEAR from the faucet account `qfund-1ktajy8t.testnet` ([67NAmNnZ…](https://explorer.testnet.near.org/transactions/67NAmNnZKZV5vowiVMJRaYE2stDZJ88x2imKXFHQ87Bx)). The account still runs the v2 contract; it needs nothing from v3.

## Harbour Board: `harbour-board.testnet`

The full-stack sample (v3 contract). Every transaction, call id and check is in [`examples/board/LIVE.md`](examples/board/LIVE.md).

## Harbour static sample: `quay-65nqd3rn.testnet`

https://quay-harbour.ss251.workers.dev/ (Workers mirror) or https://quay-65nqd3rn.testnet.page/. Unchanged by this work.
