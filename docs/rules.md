# Weekly miner rounds

During the cold-start phase, one round normally lasts 50,400 blocks, about seven days at 12 seconds per block. The champion takes all miner emissions for the following week. Each weight update has a single target with weight 65,535.

## Which submission enters

The operator publishes the exact network string, subnet number, first block of round zero `S`, round length `L` and immutable round-zero build record. `S` is an integer from 0 through 4,294,967,295. The default `L` is 50,400. Supported test lengths are 1 through 2,628,000, independent of chain update intervals.

Before `S` the competition has yet to open. At block `B >= S`, the round index is `floor((B - S) / L)`. Round `r` starts at `S + r*L` and includes all blocks through `C - 1`, where `C = S + (r+1)*L`. Validators wait for finalized height to reach `C`, then read the historical end-of-block snapshot at `C - 1`. A delayed validator uses that same height. Settlement stays pending if that snapshot is unavailable. A commitment included in block `C` belongs to the new round.

Each registered hotkey contributes its current commitment at the snapshot. The commitment's own inclusion block determines its **original round**. Pre-start commitments and malformed entries are excluded. For direct delivery (`p1`), validators match the commitment to signed source already accepted for that subnet, hotkey and original build round when the list freezes. For Hugging Face delivery (`p2`), the snapshot fixes the ID and repository, and miners have a window to reveal the committed bytes. A surviving commitment automatically enters later rounds, with fresh evaluation and retry counts each time.

## Derive the identifiers

Use compact JavaScript `JSON.stringify` encoded as UTF-8, decimal integers and no trailing newline. Below, `J` means that encoding, `H` means SHA-256 prefixed with `sha256:` and written in lowercase hex, and `\n` is one LF byte. Preserve the spelling, capitalization and encoding of the published network name.

1. `roundId = H("pocket-weekly-round-v1\n" + J([network,netuid,S,L,r]))`. The array `["test",1,12345,50400,2]` yields `sha256:731a12db45987c9f3cd29ed1663d35dea3f7fc41d8041abbb5a92337c9913abc`.
2. Copy the published round-zero record, replacing only `id` with `roundId`. Construct its fields in order as `id, baseImageDigest, rootfsDigest, environmentDigest, opensAt, closesAt, maxSubmissions, maxPerMiner`. All three digest fields are prefixed. Times are Unix milliseconds and quotas are integers. Every week retains the published window and quotas. `roundDigest = H("pocket-build-round-v1\n" + J(record))`.
3. `sourceDigest = H(canonicalSourceBytes)`. Compute `submissionId = H("pocket-submission-v2\n" + J([netuid,hotkey,roundDigest,sourceDigest]))`. Use the 64 lowercase hex digits of this ID as `<hex>` in either delivery form.
4. For Hugging Face delivery, put `p2:<hex>:OWNER/NAME` on chain as a Raw ASCII field of at most 128 bytes. For direct delivery to an operator queue, put `p1:<hex>` on chain and sign the submit command using the actual build round ID, round digest and exact source bytes. Queue acceptance uses the build record's wall-clock window and quotas. A transaction crossing the cutoff needs an ID for its actual round.

## Reveal Hugging Face source

Upload the canonical source bytes to `pocket/<hex>.json` on the `main` branch of the committed model repository. You may keep the repository private through the weekly cutoff. Anyone can copy source made public early. After the cutoff, make the repository public within `revealBlocks` finalized blocks (default 300, about one hour). Keep the file publicly available while the submission is competing or holding the title.

Validators fetch anonymously and check the canonical bytes and the base image against the original build round. They hash the downloaded bytes and recompute the ID using the subnet, committing hotkey and original round digest. A private or missing file can still be revealed within the window. After the window, a file that remains private or missing disqualifies the submission for that round.

## Eligibility gate

The gate uses deterministic model replays. Every submission must pass both checks to enter scoring for the round.

1. Pass all four web-agent scenes. Search for a source and read it, interact with a dynamic page, treat a prompt injection on a page as untrusted content, and pause for user takeover. A failure in any scene disqualifies the submission for the round with reason `gate_failed`.
2. Pass production start. The worker starts the Harness in activation mode, checkpoints it while it waits, then restores and activates it. The restored Harness must serve one scene. A failure disqualifies the submission for the round with reason `activation_unsupported`. [Production start contract](harness-contract.md#production-start)

## Scored tasks

Each round has 24 generated research tasks by default, six in each tier. The operator chooses a live model that answers through the standard model interface. Every eligible submission gets the same tasks, model and budgets. The generator uses the SHA-256 seed `sha256("pocket-weekly-tasks-v1\n" + JSON.stringify([roundId, cutoffBlockHash]))`, with one LF byte after `v1` and compact UTF-8 JSON. The cutoff block hash makes the tasks unknowable before the cutoff and reproducible afterwards.

| Tier | What the Harness must do | Tool requests per task | Model calls per task | Tokens per task |
| --- | --- | ---: | ---: | ---: |
| `single` | Search and read one page for the answer. | 4 | 4 | 100,000 |
| `distractors` | Find and read the relevant page among misleading results. | 8 | 7 | 200,000 |
| `multi-hop` | Read two pages and add the two values. | 8 | 7 | 200,000 |
| `long-page` | Follow the read cursor to find the value further down a page. | 8 | 7 | 200,000 |

The budgets are upper limits. A single-tier task allows 180 seconds and every other tier 300 seconds. Each model call can return at most 1,024 tokens. The final reply must contain only the answer as a decimal whole number. The validator also checks that the required search and page reads actually happened. In a real run, a model claimed it had searched but never called the search tool and earned zero for the task. Make sure the Harness sends the tool requests.

Each passing task earns one point. A wrong answer, missing evidence or an exhausted task budget earns zero for that task alone. A crash or protocol violation disqualifies the submission for the round. Under the default schedule the score is the number of passed tasks divided by 24. The highest positive score wins, with ties going to the earlier commitment.

The operator's generator also produced the practice set. Each entry in `tasks` has a `question` for the model, a search `query`, the search `results` and the `pages` available to read. Compare the final reply with `expectedAnswer`. The `tier` identifies the task type and `budgets` lists its tool, time and model limits. [Practice set](../practice/practice-set.json)

## How settlement works

Validators settle sequentially from round zero. Each listed submission needs a complete score or a recorded disqualification for that round. An empty list can settle immediately.

| Outcome | Consequence |
| --- | --- |
| `source_invalid` | Disqualify for this round. The file exceeds the source limits, fails canonical source validation or uses the wrong base image. |
| `source_mismatch` | Disqualify for this round. The ID recomputed from the downloaded source differs from the commitment. |
| `source_unavailable` | Disqualify for this round when the file is still private or missing after the reveal window. |
| Hugging Face outage | Retry. An outage on Hugging Face's side does not count against the miner, including after the reveal window. |
| Source build fails or the build produces an invalid artifact | Disqualify the submission for this round and record the cause. |
| Scored task ends with a wrong answer, missing evidence or an exhausted task budget | Award zero points for this task. Continue scoring the other tasks. |
| Guest crashes or violates the protocol | Disqualify the submission for this round, including when earlier tasks passed. |
| Worker isolation failure, validator restart or abort, unavailable host or dependency, or no attributable result | Keep the submission eligible and retry. |

The default infrastructure attempt limit is three, configurable to a positive safe integer. Replays at the same finalized height count at most once per submission. At the limit, mark a submission `not_evaluable` only once at least one other submission has a complete score, including zero. Individual passed cases do not establish a complete score. With infrastructure failures and no scored submission, keep the prior champion, alert and continue retrying even beyond the limit. A field entirely disqualified by attributable participant errors settles as an empty round. Reasons stay with that round.

## Who gets paid

- Only positive scores can win. Highest score wins, then earliest commitment block, then lowest UID in the cutoff snapshot. Challengers need no minimum margin. Record the winner's hotkey, original submission and score once per round.
- The previous settled result stays in effect until the new result is ready. The new champion takes effect at the next available weight-update interval. An interval already sent, or with unknown receipt, gets no second send.
- Before each update, look up the champion hotkey's current UID at the latest finalized snapshot. A new submission during the reward week preserves the title. Once deregistration is observed, the title expires for the rest of that week. A new holder of the old UID cannot inherit it.
- Before the first settlement, after an empty round or a round without positive scores, or after the champion deregisters, a configured `emptyRoundUid` receives the full 65,535 weight. Operators should use a registered owner-associated UID. Recycling or burning depends on subnet settings. Without that fallback the validator reports `all_zero` and skips the update.

## Still undecided

Fees, multi-validator review, a public submission endpoint and production revenue sharing remain open.
