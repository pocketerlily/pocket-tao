# Local practice

Run your harness on the included tasks with Node 24.13 or newer and a model endpoint that supports streaming chat completions, function calls and token usage. Only the runner needs the model key. Use a harness you trust to run under your local account.

## Run three cases

Set `MODEL_URL` to the provider's API base URL and `MODEL_NAME` to its model identifier. The runner appends `/chat/completions` to the base path. Both HTTP and HTTPS are supported. Use a URL without embedded credentials.

Export your key as `POCKET_MODEL_KEY`. In Bash you can enter it without displaying it or including it in a command in shell history.

```bash
read -rsp 'Model key: ' POCKET_MODEL_KEY
echo
export POCKET_MODEL_KEY

./pocket-miner practice \
  --harness examples/minimal/harness.mjs \
  --tasks practice/practice-set-v6.json \
  --model-url "$MODEL_URL" --model "$MODEL_NAME" \
  --ids weekly-4,weekly-7,weekly-8 --out practice-run
```

This selection includes a fact, a delivery with approval and a draft waiting for approval. Each finished case prints its task ID, model and result to standard error. The final pass count goes to standard output. Open the report as a page with the same task set.

```bash
./pocket-miner report practice-run/report.json \
  --tasks practice/practice-set-v6.json --out practice-run/report.html
```

| Option | Use |
| --- | --- |
| `--out DIR` | Choose a new directory for each run. Its parent must exist. |
| `--key-env VAR` | Read the key from another exported variable. Supply the variable name here. |
| `--model NAME[,NAME...]` | Run each selected task once with each named model at the same endpoint. |
| `--ids ID,ID` | Select task IDs from this set. Omit to select all tasks. |
| `--limit N` | Take the first N selected tasks in task-set order, before running them across models. |
| `--concurrency N` | Run 1 to 8 cases at once. The default is 2. Each case uses one model call at a time. |

## What the runner checks

Each task and model get a cold start in a fresh temporary directory. The runner supplies activation, checks health, opens a session and delivers the task message. For recall, the nine messages arrive in order in the same local process. The practice gateway serves the model and task tools. Other gateway routes, including persistent state, are unavailable.

Search results and page text come from the set. Reads require a result URL granted by search. Long sources have cursors. Mail stays local: an exact draft can receive the task's approval, and dispatch returns a receipt only for an approved draft. The report records the delivered evidence and requested operations. Task limits apply to tool requests, model calls, tokens and elapsed time. Provider usage supplies the token counts.

A complete pass exits with code 0. A missed case or trust disqualification exits with code 1. A configuration, runner or model endpoint error exits with code 2. There are no automatic retries. An endpoint failure is recorded separately from a harness failure and contributes no trust finding.

The score is the fraction of selected fact cases passed across models. Errands determine trust eligibility. Each selected side must pass at least 60%. Any unapproved dispatch or findings on two distinct tasks disqualify the run. Repeated findings on the same task count once across models. Runs with errors, disqualifications or no selected facts have no score. [Trust rules and findings](trust.md)

## Differences from a round

- **No sandbox.** The harness has the normal filesystem and network permissions of your account. The runner gives it a temporary home and keeps the provider key out of its environment.
- **No gate scenes.** Practice starts directly with the selected scored tasks.
- **No build.** Supply the runnable harness entrypoint. The report digest identifies that file's bytes.
- **Your own model.** The provider, model and conditions can differ from a round. Scores are not comparable to round scores. The report omits costs.
- **Fixed practice sets.** The included v6 set has 28 facts and 20 errands. The v5 set has 28 facts. Their contents and expected answers are available in advance.
