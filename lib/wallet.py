"""One local wallet operation per process. Only the public result crosses stdout."""
import asyncio
import json
import re
import sys
from contextlib import redirect_stdout
from importlib.metadata import version
from pathlib import Path


class InputError(Exception):
    pass


async def dispatch(bt, request):
    method = request["method"]
    if method == "commit" and request.get("allowWrites") is not True:
        raise InputError("Commit requires --allow-writes")
    if method not in ("sign", "commit"):
        raise InputError("Invalid wallet operation")
    keyfile = Path(request.get("hotkeyFile") or "")
    if not keyfile.is_absolute() or keyfile.parent.name != "hotkeys" or not keyfile.is_file():
        raise InputError("Configure an existing wallet hotkey file")
    wallet_dir = keyfile.parent.parent
    wallet = bt.Wallet(name=wallet_dir.name, hotkey=keyfile.name, path=str(wallet_dir.parent))
    key = wallet.hotkey
    if key.crypto_type != bt.CRYPTO_SR25519 or key.ss58_address != request["hotkey"]:
        raise InputError("Wallet hotkey does not match the requested sr25519 identity")
    if method == "sign":
        message = request["message"]
        if not re.fullmatch(r"pocket-miner-command-v2\nsha256:[0-9a-f]{64}", message):
            raise InputError("Invalid signing message")
        return key.sign(message.encode("ascii")).hex()

    netuid = request["netuid"]
    if type(netuid) is not int or not 0 <= netuid <= 65535:
        raise InputError("Invalid netuid")
    if not re.fullmatch(r"p1:[0-9a-f]{64}", request["commitment"]):
        raise InputError("Invalid commitment")
    network = request["network"]
    if network not in ("test", "finney") and not re.fullmatch(r"wss?://\S+", network):
        raise InputError("Choose a Bittensor network or WebSocket endpoint")
    data = request["commitment"].encode("ascii")
    info = {"fields": [{f"Raw{len(data)}": "0x" + data.hex()}]}
    async with bt.Client(network, fallback_endpoints=[], archive_endpoints=[]) as chain:
        call = bt.calls.Commitments.set_commitment(netuid, info)
        result = await chain.submit_call(call, wallet, signer="hotkey")
        result.raise_for_failure()
        return {"receipt": result.extrinsic_id or result.block_hash}


def main():
    try:
        if version("bittensor") != "11.3.2":
            raise InputError("Bittensor 11.3.2 is required")
        import bittensor as bt
        return {"value": asyncio.run(dispatch(bt, json.load(sys.stdin)))}
    except InputError as error:
        return {"error": str(error)}
    except ImportError:
        return {"error": "Bittensor 11.3.2 is required"}
    except Exception:
        # SDK errors can contain RPC details, local paths or wallet data.
        return {"error": "Wallet operation failed"}


if __name__ == "__main__":
    with redirect_stdout(sys.stderr):
        response = main()
    print(json.dumps(response))
