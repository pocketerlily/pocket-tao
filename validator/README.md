# Pocket validator

This validator reads the operator's `pocket-champions-v1` JSON results for each round and gives the current champion's UID the full weight of 65535. Each poll uses a finalized Bittensor block to check the champion's registration and the validator's eligibility. If a check fails, the existing weights stay in place.

## Install and configure

From the kit root, use Node 24.13 or newer and install the same Python SDK as the miner CLI.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install 'bittensor==11.3.2'
cp validator/config.example.json validator/config.json
```

Replace the example values in `validator/config.json`. The CLI uses the kit's virtual environment when present, then `python3` on PATH. Set `POCKET_VALIDATOR_PYTHON` to use another interpreter with the pinned SDK.

| Field | Value |
| --- | --- |
| `network`, `netuid` | Use the operator's exact Bittensor network name and numeric subnet ID. |
| `resultsUrl` | Paste the operator's direct HTTPS link to the JSON document. Redirects are refused. |
| `wallet.name`, `wallet.hotkey` | The local SDK wallet name and hotkey name. The SDK resolves the validator's public address. |
| `wallet.path` | The wallet directory containing the named wallet. An absolute path or a path starting with `~/` is accepted. |
| `allowWrites` | Defaults to `false`. Set the JSON boolean `true` to enable submissions from `run`. |
| `pollSeconds` | Seconds to wait between polls. Defaults to 600. |
| `maxResultAgeSeconds` | Maximum age of the document at submission. Defaults to 7200. A timestamp more than five minutes ahead of the local clock also fails. |
| `emptyRoundUid` | Optional numeric UID to receive the full weight when the published champion is null. Omit this field to leave weights alone in an empty round. |

## Dry run

```bash
./validator/pocket-validator status --config validator/config.json
./validator/pocket-validator run --config validator/config.json --once
```

`status` always previews. Each poll prints one JSON line. `champion` identifies the published winner by hotkey and UID, and `weights` shows the proposed allocation. The `checks` object gives a boolean for each check performed. Checks that depend on an earlier failed check are skipped. A status such as `result_stale`, `netuid_mismatch` or `champion_uid_mismatch` explains why the validator held its weights.

`wouldWrite` says whether a live run under the current configuration would attempt a submission. With the example settings, an eligible allocation reports `writes_disabled` and `wouldWrite: false`. With writes enabled, `status` can report `ready` and `wouldWrite: true` without signing anything.

## Enable writes

After reviewing the preview, set `"allowWrites": true` in the config and start the polling loop.

```bash
./validator/pocket-validator run --config validator/config.json
```

Use `--once` for a single poll. Restart the loop after editing the config. The validator observes the subnet's epoch and weight rate limit. A successful submission reports `submitted`. After an `outcome_unknown`, it waits for the next epoch before attempting another submission, even after a restart.

Use one persistent state directory per signing identity across restarts. The attempt record lives under `$XDG_STATE_HOME/pocket-validator/`, or `~/.local/state/pocket-validator/` by default. Keep this directory when moving the validator and stop the old instance before starting the new one.

## What this validator trusts

The operator evaluates submissions privately. This validator trusts the scores and champion selection published at the configured results URL. It verifies on chain that the champion's hotkey still owns the stated UID and that the local wallet's hotkey is registered and holds a validator permit. Miners' sources are public on Hugging Face after each cutoff, so anyone can inspect the source that won.
