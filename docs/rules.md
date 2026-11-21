# Weekly miner rounds

During the cold-start phase, one round normally lasts 50,400 blocks, about seven days at 12 seconds per block. The champion takes all miner emissions for the following week. Each weight update has a single target with weight 65,535.

## Which submission enters

The operator publishes the exact network string, subnet number, first block of round zero `S`, round length `L` and immutable round-zero build record. `S` is an integer from 0 through 4,294,967,295. The default `L` is 50,400. Supported test lengths are 1 through 2,628,000, independent of chain update intervals.

Before `S` the competition has yet to open. At block `B >= S`, the round index is `floor((B - S) / L)`. Round `r` starts at `S + r*L` and includes all blocks through `C - 1`, where `C = S + (r+1)*L`. Validators wait for finalized height to reach `C`, then read the historical end-of-block snapshot at `C - 1`. A delayed validator uses that same height. Settlement stays pending if that snapshot is unavailable. A commitment included in block `C` belongs to the new round.

Each registered hotkey contributes its current commitment at the snapshot. The commitment's own inclusion block determines its **original round**. The validator matches subnet, hotkey, commitment and original build round to accepted signed source. A surviving commitment automatically enters later rounds, with fresh evaluation and retry counts each time. Pre-start commitments, malformed entries, wrong-round signatures and commitments without matching source at freeze time are excluded. Delivering source after the list is frozen cannot change it.

## Derive the identifiers

Use compact JavaScript `JSON.stringify` encoded as UTF-8, decimal integers and no trailing newline. Below, `J` means that encoding, `H` means SHA-256 prefixed with `sha256:` and written in lowercase hex, and `\n` is one LF byte. Preserve the spelling, capitalization and encoding of the published network name.

1. `roundId = H("pocket-weekly-round-v1\n" + J([network,netuid,S,L,r]))`. The array `["test",1,12345,50400,2]` yields `sha256:731a12db45987c9f3cd29ed1663d35dea3f7fc41d8041abbb5a92337c9913abc`.
2. Copy the published round-zero record, replacing only `id` with `roundId`. Construct its fields in order as `id, baseImageDigest, rootfsDigest, environmentDigest, opensAt, closesAt, maxSubmissions, maxPerMiner`. All three digest fields are prefixed. Times are Unix milliseconds and quotas are integers. Every week retains the published window and quotas. `roundDigest = H("pocket-build-round-v1\n" + J(record))`.
3. `sourceDigest = H(canonicalSourceBytes)`. Compute `submissionId = H("pocket-submission-v2\n" + J([netuid,hotkey,roundDigest,sourceDigest]))`. The raw chain commitment is the ASCII string `p1:` plus the 64 hex digits of the ID.
4. Sign the submit command using the actual build round ID, round digest and exact source bytes. Queue acceptance uses the build record's wall-clock window and quotas. Round assignment uses the commitment's block. A transaction crossing the boundary needs a new commitment and a fresh signature for its actual round.

## How settlement works

Validators settle sequentially from round zero. Each listed submission needs a complete score or a recorded disqualification for that round. An empty list can settle immediately. The current engineering score is passed cases divided by all cases.

| Outcome | Consequence |
| --- | --- |
| Source build fails or the build produces an invalid artifact | Disqualify the submission for this round and record the cause. |
| A case completes with a wrong answer or behavior | Fail that case. Other case scores still count. |
| Guest crashes, violates the protocol, gives malformed output or exceeds its execution time, step or resource budget | Fail that case and disqualify the submission for this round, including when earlier cases passed. |
| Worker isolation failure, validator restart or abort, unavailable host or dependency, or no attributable result | Keep the submission eligible and retry. |

The default infrastructure attempt limit is three, configurable to a positive safe integer. Replays at the same finalized height count at most once per submission. At the limit, mark a submission `not_evaluable` only once at least one other submission has a complete score, including zero. Individual passed cases do not establish a complete score. With infrastructure failures and no scored submission, keep the prior champion, alert and continue retrying even beyond the limit. A field entirely disqualified by attributable participant errors settles as an empty round. Reasons stay with that round.

## Who gets paid

- Only positive scores can win. Highest score wins, then earliest commitment block, then lowest UID in the cutoff snapshot. Challengers need no minimum margin. Record the winner's hotkey, original submission and score once per round.
- The previous settled result stays in effect until the new result is ready. The new champion takes effect at the next available weight-update interval. An interval already sent, or with unknown receipt, gets no second send.
- Before each update, look up the champion hotkey's current UID at the latest finalized snapshot. A new submission during the reward week preserves the title. Once deregistration is observed, the title expires for the rest of that week. A new holder of the old UID cannot inherit it.
- Before the first settlement, after an empty round or a round without positive scores, or after the champion deregisters, a configured `emptyRoundUid` receives the full 65,535 weight. Operators should use a registered owner-associated UID. Recycling or burning depends on subnet settings. Without that fallback the validator reports `all_zero` and skips the update.

## Still undecided

The formal ranking metric, hidden benchmarks, fees, multi-validator review, minimum entry qualifications, public submission endpoint and production revenue sharing remain open.
