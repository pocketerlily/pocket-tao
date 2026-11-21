"""Read a finalized subnet snapshot or submit one checked weight through the SDK."""
import asyncio
import json
import os
import sys
import time
from contextlib import redirect_stderr, redirect_stdout
from importlib.metadata import version


async def inspect(bt, view, netuid, caller, champion):
    neurons = await view.read("neurons", netuid=netuid, lite=True)
    validator = next((n for n in neurons if n.hotkey == caller), None)
    winner = next((n for n in neurons if n.hotkey == champion), None)
    epoch = await view.read("epoch_status", netuid=netuid)
    cap = await view.query(bt.storage.SubtensorModule.MaxWeightsLimit, [netuid])
    return {
        "block": view.block, "epoch": epoch["epoch_index"], "tempo": epoch["tempo"],
        "validatorHotkey": caller, "validatorUid": validator.uid if validator else None,
        "validatorPermit": validator.validator_permit if validator else False,
        "championUid": winner.uid if winner else None,
        "lastUpdate": validator.last_update if validator else 0,
        "rateLimit": await view.read("weights_rate_limit", netuid=netuid),
        "maxWeight": 65535 if cap is None else int(cap),
    }


async def dispatch(bt, request):
    method, netuid = request["method"], request["netuid"]
    if method not in ("inspect", "submit") or (method == "submit" and request.get("allowWrites") is not True):
        return {"error": "writes_disabled"}
    try:
        wallet = bt.Wallet(**request["wallet"])
        caller = bt.public_view(wallet, "hotkey").ss58_address
    except Exception:
        return {"error": "wallet_unavailable"}
    async with bt.Client(request["network"], fallback_endpoints=[], archive_endpoints=[]) as chain:
        view = await chain.at(await chain.finalized_block())
        facts = await inspect(bt, view, netuid, caller, request["championHotkey"])
        if method == "inspect":
            return {"value": facts}

        # Recheck the approved snapshot before signing, allowing the finalized head to advance.
        expected = request["expected"]
        if facts["block"] < expected["block"] or any(
            facts[k] != expected[k] for k in facts if k != "block"
        ):
            return {"error": "chain_changed"}
        entry, = request["weights"]
        uid = entry["uid"]
        if type(uid) is not int or not 0 <= uid <= 65535 or entry["weight"] != 65535:
            return {"error": "chain_changed"}
        if request["championHotkey"] is not None and facts["championUid"] != uid:
            return {"error": "chain_changed"}
        if facts["validatorUid"] is None or not facts["validatorPermit"] or not facts["tempo"]:
            return {"error": "chain_changed"}
        if uid != facts["validatorUid"] and facts["maxWeight"] < 65535:
            return {"error": "chain_changed"}
        key = await view.query(bt.storage.SubtensorModule.WeightsVersionKey, [netuid])
        intent = bt.SetWeights(netuid=netuid, weights={uid: 65535}, version_key=int(key or 0))
        age_ms = time.time_ns() // 1_000_000 - request["generatedAt"]
        if age_ms > request["maxResultAgeSeconds"] * 1000:
            return {"error": "result_stale"}
        if age_ms < -300_000:
            return {"error": "result_in_future"}
        try:
            result = await chain.execute(intent, wallet, retries=0)
            result.raise_for_failure()
        except bt.ChainError as error:
            if error.name == "NoValidatorPermit":
                return {"error": "validator_permit_required"}
            code = {"not_registered": "validator_not_registered", "rate_limited": "rate_limited"}
            return {"error": code.get(error.code.value, "outcome_unknown")}
        return {"value": "submitted"}


def main():
    try:
        if version("bittensor") != "11.3.2":
            return {"error": "sdk_unavailable"}
        import bittensor as bt
    except ImportError:
        return {"error": "sdk_unavailable"}
    request = json.load(sys.stdin)
    try:
        return asyncio.run(dispatch(bt, request))
    except Exception:
        return {"error": "outcome_unknown" if request["method"] == "submit" else "chain_unavailable"}


if __name__ == "__main__":
    with open(os.devnull, "w") as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
        response = main()
    print(json.dumps(response))
