<div align="center">

<img src="assets/pocket.png" width="112" alt="Pocket">

# Pocket

**An open RSI loop for agent harnesses.**

Miners compete in two-week rounds to build the best Engine for personal AI agents.<br>
One champion takes all miner emission, and becomes the baseline everyone has to beat.

[![Bittensor](https://img.shields.io/badge/Bittensor-subnet_26-111111?style=flat-square)](https://usepocket.fun/docs/how-the-subnet-works)
[![Network](https://img.shields.io/badge/network-mainnet-111111?style=flat-square)](#round-parameters)
[![Round](https://img.shields.io/badge/round-2_weeks-ff7a1a?style=flat-square)](docs/rules.md)
[![Reward](https://img.shields.io/badge/reward-winner_takes_all-ff7a1a?style=flat-square)](docs/rules.md#who-gets-paid)
[![Node](https://img.shields.io/badge/node-%E2%89%A5_24.13-111111?style=flat-square)](#quick-start)
[![License](https://img.shields.io/badge/license-MIT-111111?style=flat-square)](LICENSE)

[Website](https://usepocket.fun) · [Champions](https://usepocket.fun/champions) · [Docs](https://usepocket.fun/docs) · [Rules](docs/rules.md) · [Harness contract](docs/harness-contract.md)

</div>

---

## What you are building

Pocket is a desktop app where every agent has its own cloud computer. The part that decides
*how an agent works* — what to ask the model, which tool to call next, what to remember, when to
stop — is a replaceable program called the **Harness**. Users see it as the agent's **Engine**.

This repository is everything a miner needs to write one, pack it, and enter a round.

```mermaid
flowchart LR
    A([Write a Harness]) --> B[Pack and check]
    B --> C[(Private Hugging Face repo)]
    C --> D{{Commit on chain}}
    D --> E[/Round cutoff/]
    E --> F[Reveal]
    F --> G[[Gate, then scored tasks]]
    G --> H([Champion])
    H -. becomes the bar to beat .-> A
```

> [!NOTE]
> Miners submit **source code only**. There is no compute to rent and nothing to keep online:
> the validator builds and runs your Harness in its own sandbox.

## A round at a glance

| | When | What happens |
| :-: | --- | --- |
| **1** | Any time before the cutoff | Commit your submission on chain. Your latest commitment at the cutoff is the one that counts, and it carries over to later rounds until you replace it. |
| **2** | Cutoff, every 100,800 blocks | The list of entrants is frozen. The task set is derived from the cutoff block's hash, so nobody can know the tasks beforehand. |
| **3** | Within 300 blocks after it (~1 hour) | Make your repository public. The validator downloads the file and checks it against your commitment. |
| **4** | Evaluation | Eligibility gate first, then the scored tasks on every published model. |
| **5** | Settlement | Highest score above zero wins. Ties go to the earlier commitment. The champion receives all miner emission for the following round. |

## Scoring

Every eligible submission gets the **same tasks, the same models and the same budgets**.
A fact task passed on a model earns one point. The score is the average fact pass rate across models.
Each round publishes its profile. Rounds naming `agent-facts-v6` also run 20 [trust errands](docs/trust.md) per model.

| Tier | The agent has to | Tool requests | Model calls | Tokens |
| --- | --- | :-: | :-: | --: |
| `single` | Search once and read one page | 4 | 4 | 16,000 |
| `distractors` | Pick the right page among misleading results | 8 | 7 | 20,000 |
| `multi-hop` | Combine values from two pages | 8 | 7 | 20,000 |
| `long-page` | Page through a long document to the answer | 8 | 7 | 48,000 |
| `recall` | Answer from a conversation longer than the model's window | – | 24 | 90,000 |
| `collect` | Gather one value from each of twelve pages | 20 | 24 | 120,000 |
| Trust errands (v6) | Clear the trust veto and both 60% thresholds for eligibility. No points. | 8 | 7 | 20,000 |

Limits are per task and per model. Going over a limit, or giving a wrong answer, loses that one task.
A crash or protocol violation disqualifies the submission for the round.

> [!IMPORTANT]
> The validator checks evidence, not just the number. A model that says it searched without
> calling the search tool scores zero, and a Harness that replays a whole conversation into
> every call cannot pass `recall`. Making tools really get used, and keeping long context
> under control, is exactly what is being measured.

<details>
<summary><b>The eligibility gate</b></summary>

<br>

Before any scored task runs, a submission must pass two checks with a deterministic replayed
model, at no cost to anyone:

1. **Four web-agent scenes**: search and read, dynamic page actions, a page carrying a prompt
   injection, and handing control back to the user. Failing one ends the round for that
   submission (`gate_failed`).
2. **Production start**: the Harness is started in activation mode, checkpointed while it
   waits, restored, and must then serve a scene (`activation_unsupported` otherwise).

The second check exists because the champion's Engine is meant to run for real users.
[Production start contract](docs/harness-contract.md#production-start)

</details>

<details>
<summary><b>What you can and cannot know in advance</b></summary>

<br>

You can know the generator's task families, the budgets, the gate and the answer format, and
you can practise on any seed. You cannot know the round's actual tasks: the seed is

```js
sha256("pocket-weekly-tasks-v1\n" + JSON.stringify([roundId, cutoffBlockHash]))
```

and that block hash does not exist until the cutoff. After the cutoff anyone can reproduce the set.
Generated practice sets are included for [v5](practice/practice-set.json) and [v6](practice/practice-set-v6.json).

</details>

### Read your self-check as a page

`./pocket-miner report report.json --out report.html`

<img src="assets/report.png" alt="Self-check report page" width="720">

Open the page to see your local score, trust findings and individual cases. To include questions and expected answers, pass the exact task set used for that run with `--tasks SET.json`. A set generated with a different seed can reuse the same case IDs.

## Quick start

Node 24.13 or newer. Packing, checking and the offline tests need no package installation.

```bash
git clone https://github.com/pocketerlily/pocket-tao.git
cd pocket-tao
npm test
```

Pack the included example and check it the way the validator's admission does:

```bash
mkdir -p out
BASE=$(node -p '"sha256:" + "0".repeat(64)')   # practice digest; a real entry uses the round's
./pocket-miner pack --project examples/minimal --base-image-digest "$BASE" --out out/source.json
./pocket-miner check out/source.json
```

Then open [`examples/minimal/harness.mjs`](examples/minimal/harness.mjs). It is a complete agent
using only built-in Node modules.
It passes the gate and most short tasks, and loses the long ones. That gap is the competition.

## Entering a round

<details open>
<summary><b>1 · Pack against the round's base image</b></summary>

<br>

Take the operator's round-zero record (see [Round parameters](#round-parameters)) and set
`ROUND_ZERO` to its filename.

```bash
BASE=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1])).baseImageDigest)' "$ROUND_ZERO")
./pocket-miner pack --project examples/minimal --base-image-digest "$BASE" --out out/source.json
./pocket-miner check out/source.json
```

The check verifies canonical bytes, file paths, sizes and dependency locks.
[Example and sandbox self-check](examples/minimal/README.md)

</details>

<details>
<summary><b>2 · Publish to a private Hugging Face repository</b></summary>

<br>

Create a **private model repository** and set `REPO` to its `OWNER/NAME` (60 characters at most,
slash included). Set `HOTKEY` to your registered sr25519 address and `BLOCK` to the block where
you expect the commitment to land.

```bash
ROUND=$(./pocket-miner round --network "$NETWORK" --netuid "$NETUID" \
  --start "$START" --length "$LENGTH" --block "$BLOCK")
ROUND_ID=$(node -p 'JSON.parse(process.argv[1]).id' "$ROUND")
ROUND_DIGEST=$(./pocket-miner round-digest --round-zero "$ROUND_ZERO" --round-id "$ROUND_ID")
identity=(--netuid "$NETUID" --hotkey "$HOTKEY" --round "$ROUND_DIGEST" --source out/source.json)
./pocket-miner publish "${identity[@]}" --repo "$REPO" --out out --upload
```

Authenticate with the Hugging Face CLI before using `--upload`. The kit never reads or stores your
token. Without `--upload` it prints the exact upload command; the file belongs on the `main`
branch at `pocket/<64-hex-id>.json`, byte for byte as packed.

> [!WARNING]
> A repository that is public before the cutoff can be copied by anyone.

</details>

<details>
<summary><b>3 · Commit on chain</b></summary>

<br>

Wallet operations need Python with `bittensor==11.3.2` (`--python PATH`, `POCKET_MINER_PYTHON`,
`.venv/bin/python` in the kit, or `python3` on PATH).

```bash
./pocket-miner commit "${identity[@]}" --repo "$REPO" --hotkey-file "$HOTKEY_FILE" \
  --network "$CHAIN_NETWORK" --allow-writes
```

> [!CAUTION]
> This replaces your current commitment on the subnet. Nothing is written without
> `--allow-writes`. Wait for finalization and check the inclusion block: if it crossed a round
> cutoff, derive the round for that block, publish under the new ID and commit again.

</details>

## Round parameters

| Parameter | Value |
| --- | --- |
| `CHAIN_NETWORK` | `finney` |
| `NETUID` | `26` |
| `LENGTH` | `100800` blocks, about two weeks |
| Reveal window | `300` blocks after each cutoff |
| `NETWORK`, `START`, `ROUND_ZERO` | Published in this repository with round zero |
| Evaluation models | Published in this repository with round zero |

## Your own Harness

Put a `pocket.json` in your project root listing every file that should enter the build, then
`./pocket-miner pack --project DIR`. The packer reads the manifest and the listed files; it never
executes your build recipe. Projects with dependencies vendor them and declare each exact version.

| Read this | For |
| --- | --- |
| [Harness contract](docs/harness-contract.md) | Manifest, size limits, the worker protocol, model and tool interfaces, production start |
| [Rules](docs/rules.md) | Rounds, identifiers, reveal, gate, scoring, settlement, who gets paid |
| [Minimal example](examples/minimal/README.md) | A working agent and the sandbox commands to test it |

<details>
<summary><b>Command reference</b></summary>

<br>

`./pocket-miner --help` lists every option.

| Command | Use |
| --- | --- |
| `pack` | Build the canonical source bundle from a project. |
| `check FILE` | Apply the admission checks locally. |
| `digest FILE` | Print the normalized source digest. |
| `round`, `round-digest` | Derive the round ID and build-record digest. |
| `submission-id` | Preview the ID and commitment. `--repo` selects a Hugging Face commitment. |
| `publish` | Prepare, and optionally upload, the repository file. |
| `commit` | Write the commitment on chain. Requires `--allow-writes`. |
| `verify-remote` | Fetch your published file as a validator would. |
| `sign`, `submit` | Direct delivery to an operator queue, for operators who offer one. |

</details>

## Validators

The operator evaluates every round and publishes the result. [`validator/`](validator/README.md)
is a small program that reads that result, checks the champion's registration and UID on chain,
and sets weights. It previews by default and writes only when you turn writes on. Its README
states plainly what it verifies and what it takes on trust.

## Repository map

```text
pocket-miner          the CLI
lib/                  packing, identifiers, signing, Hugging Face helpers
lib/report.mjs        local self-check HTML reports
examples/minimal/     a complete agent in one file
docs/                 the Harness contract and the round rules
practice/             generated practice task sets
validator/            the public validator
tests/                offline tests: npm test
```

<div align="center">
<br>

Winning source is public after every cutoff. Read it, beat it.

<sub>Released under the <a href="LICENSE">MIT License</a>.</sub>

</div>
