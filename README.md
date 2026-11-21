# Pocket miner kit

Build a Harness that decides what to ask a model, which tools to call and what answer to return. This kit includes a standalone CLI, an editable one-file agent and the submission contract. Node 24.13 or newer runs the packer, source checks and offline tests with no package installation.

## Pack and check the example

Set `KIT_URL` to the kit's clone URL. For a real submission, get the operator's immutable round-zero JSON record and set `ROUND_ZERO` to its filename. The following commands use Bash.

```bash
git clone "$KIT_URL" pocket-miner
cd pocket-miner
mkdir -p out
BASE=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1])).baseImageDigest)' "$ROUND_ZERO")
./pocket-miner pack --project examples/minimal --base-image-digest "$BASE" --out out/source.json
./pocket-miner check out/source.json
./pocket-miner digest out/source.json
```

For offline practice without an operator record, set `BASE=$(node -p '"sha256:" + "0".repeat(64)')` in place of the record lookup. The practice digest is suitable for packing and testing. A real build requires its pinned base image digest.

Edit `examples/minimal/harness.mjs`, then pack to a fresh filename. Outputs are never overwritten. The check verifies canonical bytes, file paths, sizes and dependency locks. Build success, model/tool behavior, scoring, finalized registration and queue acceptance require operator infrastructure. The example guide includes the exact sandbox commands and expected case counts. [Example and self-check](examples/minimal/README.md)

## Identify, sign, commit and submit

The operator publishes `NETWORK` (exact schedule name), `NETUID`, `START` (round-zero first block), `LENGTH` (normally 50400) and `ROUND_ZERO`. Set `BLOCK` to the block in which you expect the commitment to land. Use the existing registered sr25519 address as `HOTKEY` and its keyfile path as `HOTKEY_FILE`. This kit uses the standard wallet layout `<wallet directory>/<wallet name>/hotkeys/<hotkey name>`. The CLI needs only the public address and path.

```bash
WEEK=$(./pocket-miner round --network "$NETWORK" --netuid "$NETUID" \
  --start "$START" --length "$LENGTH" --block "$BLOCK")
ROUND_ID=$(node -p 'JSON.parse(process.argv[1]).id' "$WEEK")
ROUND_DIGEST=$(./pocket-miner round-digest --round-zero "$ROUND_ZERO" --round-id "$ROUND_ID")
identity=(--netuid "$NETUID" --hotkey "$HOTKEY" --round "$ROUND_DIGEST" --source out/source.json)
wallet=("${identity[@]}" --hotkey-file "$HOTKEY_FILE")
./pocket-miner submission-id "${identity[@]}"
./pocket-miner sign "${wallet[@]}" --round-id "$ROUND_ID" --out out/signed.json
```

Wallet operations need Python with `bittensor==11.3.2`. Choose an existing interpreter with `--python PATH` or `POCKET_MINER_PYTHON`. Otherwise the CLI tries `.venv/bin/python` in the kit, then `python3` on PATH. For a local installation, use `python3 -m venv .venv` and `.venv/bin/python -m pip install 'bittensor==11.3.2'`. Signing checks the hotkey identity and creates an envelope locally.

**The next command replaces your current on-chain commitment on the selected subnet.** Set `CHAIN_NETWORK` to the operator's Bittensor network selector (`test`, `finney` or its WebSocket endpoint). Review the printed ID and commitment first. The CLI refuses a commit unless you supply the write flag.

```bash
./pocket-miner commit "${wallet[@]}" --network "$CHAIN_NETWORK" --allow-writes
```

Wait for finalization and check the actual inclusion block. If the transaction crossed a weekly boundary, derive the new round, re-sign and commit for that round. If the outcome is unclear, check the current commitment before retrying.

```bash
./pocket-miner submit "${wallet[@]}" --round-id "$ROUND_ID" --out out/delivery.json
```

**There is no public submission endpoint yet.** Give the operator the freshly signed delivery file within five minutes of signing. It contains the full source. The operator verifies it against the finalized commitment. When an operator supplies an HTTP intake URL, use `--endpoint "$ENDPOINT"` instead of `--out out/delivery.json` to POST a fresh envelope. HTTP success acknowledges delivery. The operator confirms admission.

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
