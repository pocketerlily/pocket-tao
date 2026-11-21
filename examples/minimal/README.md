# A single-turn model agent

Edit the system message or the tool menu in `harness.mjs` to try a different strategy. The worker runs this module inside its guest. For each user message it asks the session's model for an answer, executes one requested tool, gives the result back to the model and repeats. All answers come from the model. The build recipe copies this one module to the filename provided by the flat build driver.

This example supports cold starts and single-host production starts. The weekly eligibility gate requires all four web-agent scenes to pass and one scene to run after checkpoint, restore and activation. Use the operator's practice set to try the scored research tasks. [Weekly rules](../../docs/rules.md) · [Practice set](../../practice/practice-set.json)

## Run in the platform sandbox

Start in the kit root on a provisioned Linux/amd64 sandbox host, with `PLATFORM` set to the platform checkout. The operator needs root/KVM access, the flat build and browser configurations and the trusted evaluation fixtures. These commands read the base digest from the same build configuration used for evaluation and create fresh, short output paths.

```bash
KIT=$PWD
cd "${PLATFORM:?set PLATFORM to the platform checkout}"
CHECK=$(mktemp -d /tmp/pm.XXXXXXXX)
BASE=$(node -p 'require("./.runtime/build.json").config.base.imageDigest')
"$KIT/pocket-miner" pack --project "$KIT/examples/minimal" --base-image-digest "$BASE" --out "$CHECK/source.json"
"$KIT/pocket-miner" check "$CHECK/source.json"

npm run miner:self-check -- --source "$CHECK/source.json" --suite agent-web \
  --config .runtime/build.json --browser-config .runtime/browser.json \
  --model-runner examples/evaluation-fixture-model.ts --output "$CHECK/web"

npm run miner:self-check -- --source "$CHECK/source.json" --suite facts \
  --config .runtime/build.json --browser-config .runtime/browser.json \
  --facts-dataset examples/facts-dataset.json \
  --model-runner examples/evaluation-facts-model.ts --output "$CHECK/facts"
```

| Suite | Expected with the named offline model |
| --- | --- |
| `agent-web` | Four passing cases. Search and read, browser interaction, untrusted page content and user takeover. The last case returns `waiting`. |
| `facts` | Six passing cases for the supplied dataset. The model sees the search and read results and returns selected IDs with their source. |

Each command should exit 0. Its output directory should contain a `report.json` with `status` equal to `passed`, `stage` equal to `complete` and `productionEligible` equal to `false`. Exit 1 means a completed pack with a failing verdict. Exit 2 means an input, execution, build or host error. Use the operator's trusted model runner for the chosen suite. The `email` and `web` suites supply no model and are unsupported by this agent.

## The runtime protocol in ten steps

1. The single-host worker starts Node in an isolated guest. A cold start has an activation record ready. In production start mode the guest signals standby and waits for the worker to supply the record, possibly after a restore.
2. The guest reads the activation, connects to `/channels/control.sock` and serves HTTP on that connection.
3. The worker sends `GET /v1/health`. A cold start returns `{"ready":true}`. A production start also returns the activated instance ID and a fresh nonce.
4. The worker posts a `0.1-draft` session to `/v1/session`. The guest checks run and task IDs and retains the model and capability flags.
5. A POST to `/v1/message` contains a JSON string. The guest adds it to its model messages.
6. A POST to `/v1/model/stream` over `/channels/gateway.sock` names the session model, output budget and allowed tools. The reply contains newline-delimited JSON.
7. The guest joins tool fragments, waits for the finish event, then sends a typed operation to `/v1/tools/request`. The host authorizes each call.
8. If the session offers state, `/v1/state/request` provides workspace list, small text reads and writes. The host supplies a revision for subsequent operations.
9. The assistant call and tool result share a call ID in the next model request. The final step and any step after takeover allow only an answer.
10. The control reply contains `status` and nonempty `text`. Status is `completed` or `waiting` for user takeover. Channel closure ends the run.

The example supports a single tool per model step, buffered model output and one message turn. It omits cluster activation, action-event resumption, approval flows, history/context recovery and compaction, attachments, long-file editing, persistent memory and collaboration. Workspace access requires an enabled state gateway. Neither named evaluation suite supplies one.
