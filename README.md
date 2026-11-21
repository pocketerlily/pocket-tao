# Pocket miner kit

Build a Harness that decides what to ask a model, which tools to call and what answer to return. This kit includes a standalone CLI, an editable one-file agent and the submission contract. Node 24.13 or newer runs the packer, source checks and offline tests with no package installation.

## Pack and check your source

Set `KIT_URL` to the kit's clone URL. For a real submission, get the operator's immutable round-zero JSON record and set `ROUND_ZERO` to its filename. The following commands use Bash.

```bash
git clone "$KIT_URL" pocket-miner
cd pocket-miner
mkdir -p out
BASE=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1])).baseImageDigest)' "$ROUND_ZERO")
./pocket-miner pack --project examples/minimal --base-image-digest "$BASE" --out out/source.json
./pocket-miner check out/source.json
```

For offline practice without an operator record, set `BASE=$(node -p '"sha256:" + "0".repeat(64)')` in place of the record lookup. The practice digest is suitable for packing and testing. A real build requires its pinned base image digest.

Edit `examples/minimal/harness.mjs`, then pack to a fresh filename and check it again. The check verifies canonical bytes, file paths, sizes and dependency locks. The example guide includes the exact sandbox commands and expected case counts. [Example and self-check](examples/minimal/README.md)

## Create a private repository and publish the file

Create a **private model repository** in your Hugging Face account. Set `REPO` to its `OWNER/NAME` (at most 60 characters including the slash). Anyone can copy the source if the repository is public before the weekly cutoff.

Use the operator's `NETWORK` (exact schedule name), `NETUID`, `START` (round-zero first block), `LENGTH` (normally 50400) and `ROUND_ZERO`. Set `HOTKEY` to your registered sr25519 address and `BLOCK` to the block where you expect the commitment to land.

```bash
WEEK=$(./pocket-miner round --network "$NETWORK" --netuid "$NETUID" \
  --start "$START" --length "$LENGTH" --block "$BLOCK")
ROUND_ID=$(node -p 'JSON.parse(process.argv[1]).id' "$WEEK")
ROUND_DIGEST=$(./pocket-miner round-digest --round-zero "$ROUND_ZERO" --round-id "$ROUND_ID")
identity=(--netuid "$NETUID" --hotkey "$HOTKEY" --round "$ROUND_DIGEST" --source out/source.json)
./pocket-miner publish "${identity[@]}" --repo "$REPO" --out out --upload
```

Authenticate with the Hugging Face CLI before using `--upload`. The kit prints one JSON line with the ID, commitment, repository path and upload command. For a manual upload, omit `--upload` and put the prepared file on the model repository's `main` branch at the printed path, `pocket/<64-hex-id>.json`. Keep its bytes exactly as packed.

## Commit the repository on chain

**This command replaces your current commitment on the selected subnet.** Review the ID and commitment from `publish`. Set `CHAIN_NETWORK` to the operator's Bittensor network selector and `HOTKEY_FILE` to your existing keyfile at `<wallet directory>/<wallet name>/hotkeys/<hotkey name>`.

Wallet operations require Python with `bittensor==11.3.2`. Choose an existing interpreter with `--python PATH` or `POCKET_MINER_PYTHON`. Otherwise the CLI tries `.venv/bin/python` in the kit, then `python3` on PATH. For a local installation, use `python3 -m venv .venv` and `.venv/bin/python -m pip install 'bittensor==11.3.2'`.

```bash
./pocket-miner commit "${identity[@]}" --repo "$REPO" --hotkey-file "$HOTKEY_FILE" \
  --network "$CHAIN_NETWORK" --allow-writes
```

Wait for finalization and check the actual inclusion block. If it crossed a weekly cutoff, derive the round for that block, publish under the new ID and commit for that round. If the outcome is unclear, check the current commitment before retrying.

## Reveal after the weekly cutoff and verify

After the weekly cutoff, **make the repository public within the reveal window**. The default is 300 finalized blocks after the cutoff, about one hour. A repository still private after the reveal window is disqualified for that round. The file must stay publicly available at the same path while the submission is competing or holding the title.

```bash
./pocket-miner verify-remote "${identity[@]}" --repo "$REPO"
```

The check downloads anonymously. Only `ok` exits successfully. For `not_public`, check visibility, branch and file path. For `mismatch` or `invalid`, check the uploaded bytes against the packed source and the round's base image. For `unreachable`, retry the download.

## Command reference

Run `./pocket-miner --help` for all options. The following commands use the same identity arguments as the walkthrough.

| Command | Use |
| --- | --- |
| `submission-id "${identity[@]}" [--repo OWNER/NAME]` | Preview the ID and commitment. A repository selects `p2`. Omitting it selects the direct-delivery `p1` commitment. |
| `digest FILE` | Print the normalized source digest. |
| `sign "${identity[@]}" --hotkey-file "$HOTKEY_FILE" --round-id "$ROUND_ID" --out FILE` | Direct delivery to an operator queue. Write a locally signed envelope containing the full source. |
| `submit "${identity[@]}" --hotkey-file "$HOTKEY_FILE" --round-id "$ROUND_ID" --out FILE` | Direct delivery to an operator queue. Write a fresh envelope, or use `--endpoint "$ENDPOINT"` in place of `--out FILE` to POST it to an operator-supplied URL. |

For direct delivery, commit without `--repo` and deliver the envelope within five minutes of signing. The operator checks it against the finalized commitment and confirms admission.

## Your own project

Put `pocket.json` in the project root and list every file that should enter the build. Paths relative to that root become bundle paths. Run `pocket-miner pack --project DIR`, or invoke the CLI from that directory without `--project`. Both forms require `--base-image-digest` and `--out`. The packer reads the manifest and selected regular files without executing the recipe. Tree projects list prepared dependency files under `node_modules` and declare each name and exact version. [Manifest examples, limits and runtime contract](docs/harness-contract.md)

## Contents

| Location | Purpose |
| --- | --- |
| `pocket-miner`, `lib/` | Pack and check source, derive rounds and submission IDs, sign, commit and deliver. |
| `examples/minimal/` | Editable built-ins-only agent, build recipe and sandbox instructions. |
| `docs/` | Source and runtime contract, weekly competition and reward rules. |
| `tests/` | Run `npm test` offline. No wallet, Python SDK, chain or sandbox required. |
| `scripts/conformance.mjs` | Developer-only platform comparison. Miners can use the kit without this script or a platform checkout. |

The weekly rules explain cutoff, automatic carry-over, disqualifications and champion selection. [Competition rules](docs/rules.md)

Developers with a trusted platform Git checkout and its local dependencies can run `npm run conformance -- --platform "$PLATFORM"`. The optional `--baseline "$BASELINE"` compares an external reference project's prepared source tree, in memory, with its own packer. Supply `--base-image-digest "$BASE"` to compare at a deployed image digest. The comparison defaults to the all-zero practice digest. No reference source is distributed with the kit.
