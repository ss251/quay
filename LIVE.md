# Live deployments

Everything here is NEAR testnet. Transaction links open on the testnet explorer.

## Product site: `quay-esc0v902.testnet`

Hosts: https://quay.ss251.workers.dev/ (Workers mirror, primary), https://quay-esc0v902.testnet.page/, or `quay gateway --account quay-esc0v902.testnet`.

| Release | Role | Seal | Promote |
| --- | --- | --- | --- |
| 18 | production since 2026-11-11: the round 2 look (Geist, neutral greys, green for live) on the round 5 content, after the fidelity pass | [9EAsza5U…](https://explorer.testnet.near.org/transactions/9EAsza5ULu63fTE7yB3ZhVwoNhecqsXyn5bH8qALzBGd) | [2Wyby4Wm…](https://explorer.testnet.near.org/transactions/2Wyby4WmjiqLV9qaVqsikd4xTwrTc7abwLfDVSoR57X7) |
| 17 | preview, not promoted: the round 2 look after the fidelity pass | [9oiVTBvJ…](https://explorer.testnet.near.org/transactions/9oiVTBvJaU1pxQhXAGqngdvKVp7QBux2zty8YF2fBCpF) | none |
| 16 | preview, not promoted: the round 2 look (Geist, neutral greys, green for live) applied to the same content as 14. https://quay.ss251.workers.dev/r/16/ | [CKtaMgtV…](https://explorer.testnet.near.org/transactions/CKtaMgtVQd64shR625ahNgFKqSEP513uXzXzNVv5CS7s) | none |
| 14 | previous, the rollback target (`quay rollback --account quay-esc0v902.testnet`): the round 5 design (full-stack home, a docs page per layer, the live dashboard canvas, a poster under the hero frame until it loads) | [b1cjw1Ah…](https://explorer.testnet.near.org/transactions/b1cjw1AhLzpUAyNUFq7GPNZ5HEvnmKgTiN5Y2LpfVLk) | [8Zzc3Ss6…](https://explorer.testnet.near.org/transactions/8Zzc3Ss6KkQLRsPXtjeTr9b3zwXdPcUYdZWN5SRxprUV) |
| 12 | older production, kept: the last round 2 site before the full-stack content; cron live on the Board, wallet sign-in shown with one connector, NEARFS wording | [EBb1X1jb…](https://explorer.testnet.near.org/transactions/EBb1X1jbSGbd7jCRxie1G6fEtX1XURmAXLQTQqPzhwGv) | [2zL7JdE7…](https://explorer.testnet.near.org/transactions/2zL7JdE7sLH4QS1QXAbdKr4DsoHqCXbLm8ySXzSuBmTn) |
| 11 | older production, kept | [3gV5PS5h…](https://explorer.testnet.near.org/transactions/3gV5PS5h3GLWDnswgtaJmk21v2SFxBRtxkfN2Asxm6zT) | [7otR3HuV…](https://explorer.testnet.near.org/transactions/7otR3HuVsu8ooLLzpAZVbx7sWWtEPJ1jU4GPnPmuo9G8) |
| 10 | older production, kept | [2opmA397…](https://explorer.testnet.near.org/transactions/2opmA397eFod68XsULSp5dwfnbQEo1536FEwteFWemP7) | [6Z36kLW9…](https://explorer.testnet.near.org/transactions/6Z36kLW9k11Tiks3E5GSTfKKjEv22rxD6WesxgZKQHQd) |
| 9 | older production, kept | [GegcmRL3…](https://explorer.testnet.near.org/transactions/GegcmRL3wurnmnQGqZk7bAqK5mKizR5b5fP611CKRxTg) | [CvfPW9CG…](https://explorer.testnet.near.org/transactions/CvfPW9CGFDA1JdMk5nGgW9PmBJi1PpXxmZbJRW4cvnPw) |

Releases 4 (the old design, linked from the README) and 8 are kept. On 2026-11-11, with the owner's approval, the rejected previews 13 and 15 were deleted ([GRQzW17B…](https://explorer.testnet.near.org/transactions/GRQzW17BdBdUA9DE7tu4f7cSin9WCLP4idvnETKWxYZm), [7AtkLJcA…](https://explorer.testnet.near.org/transactions/7AtkLJcAXEwHZSJLvxxJBARQatxYMdtrd2QSK686mDiy)), taking storage from 1,936,547 B to 1,506,838 B before releases 17 and 18. Releases 1, 2, 3, 5, 6 and 7 were unreferenced previews and were deleted on 2026-11-10 to unlock storage before release 10. On 2026-11-11, before release 15, the faucet account `quay-topup-46a0a0e7.testnet` was deleted with this account as beneficiary, moving its 10 NEAR here ([5EJd82ua…](https://explorer.testnet.near.org/transactions/5EJd82uaZuP4u2ivRECqe4tPHhnXTRjz9K18Ta6nhn6v)). Earlier on 2026-11-11 a new faucet account, `qfund-za2p2fnl.testnet`, sent it 5 NEAR for the round 5 storage ([7iBCGQL7…](https://explorer.testnet.near.org/transactions/7iBCGQL7HHqAgfR2xLUqn2wNmh9EbPm5LePzjbL8PPmP)). On 2026-11-10 the account was topped up with 3 NEAR from the faucet account `qfund-1ktajy8t.testnet` ([67NAmNnZ…](https://explorer.testnet.near.org/transactions/67NAmNnZKZV5vowiVMJRaYE2stDZJ88x2imKXFHQ87Bx)). The account still runs the v2 contract; it needs nothing from v3.

## Harbour Board: `harbour-board.testnet`

The full-stack sample (v3 contract). Every transaction, call id and check is in [`examples/board/LIVE.md`](examples/board/LIVE.md).

## Harbour static sample: `quay-65nqd3rn.testnet`

https://quay-harbour.ss251.workers.dev/ (Workers mirror) or https://quay-65nqd3rn.testnet.page/. Unchanged by this work.

## Demo video account: `quay-2v5y8etg.testnet`

The account the hackathon demo video was recorded on, on 2026-11-11 (UTC), with the CLI from this repo and the Harbour sample built from `examples/harbour` (the index page edited to say release 3, then a winter timetable for release 4). Releases 1 and 2 were earlier smoke tests. https://quay-2v5y8etg.testnet.page/ serves production; `/r/3/` and `/r/4/` stay up. Dashboard: https://quay.ss251.workers.dev/dashboard/?account=quay-2v5y8etg.testnet.

| Step | Command | Transaction |
| --- | --- | --- |
| Top-up, 1 NEAR from `quay-i7qkbbp3.testnet` for storage | `near tokens … send-near` | [EdfVdon8…](https://explorer.testnet.near.org/transactions/EdfVdon8kU4dihzkG68QTLegCbs13MaajtVrSpz1fukn) |
| Seal release 3 | `quay deploy ./dist -m "harbour office"` | [J4nqY1Nv…](https://explorer.testnet.near.org/transactions/J4nqY1NvYvQsLvVUEtUHtDC8cPgfJQ8rQc39HXZASiH8) |
| Promote 3 | `quay promote 3` | [CkWhiEmi…](https://explorer.testnet.near.org/transactions/CkWhiEmi4APotQA9Dwnt8Hq7hVUMZQo6qCFKSqpv6ikz) |
| Seal release 4 (1.4 KB new, 7.9 KB reused) | `quay deploy ./dist -m "winter timetable"` | [BehoitHY…](https://explorer.testnet.near.org/transactions/BehoitHYwqJMjYpUnHdS4hoxCVzMJHVGFRn1voTajJNe) |
| Promote 4 | `quay promote 4` | [GpQosErP…](https://explorer.testnet.near.org/transactions/GpQosErPd8EFnKjhpVYHMjMiYSygT2BfTBwQhJEkdxUL) |
| Roll back to 3 | `quay rollback` | [H75U1SJi…](https://explorer.testnet.near.org/transactions/H75U1SJiT2KEbNa4EzSEQoQFsAe4hPnaFQbz8NVgLDux) |

Afterwards `quay status` read production 3, previous 4, 4 releases, 11 KB stored.
