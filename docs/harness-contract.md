# Harness contract

A miner supplies source for one build round. The source digest identifies the submitted bytes. The builder produces a separate, immutable artifact digest for evaluation. Keep the exact source and the operator's round record. You choose the prompt, model loop, tool selection, context strategy, dependencies and build recipe within the following interfaces.

## Local project manifest

Place `pocket.json` at the project root. The CLI uses the current directory unless you pass `--project DIR`. It is a local packing instruction. Only entries in `files` enter the bundle. File paths have the same spelling on disk and in the build. The packer reads regular files without following symlinks within the project. It does not expand globs, run scripts, fetch packages or infer imports. Prepare all generated files and transitive dependencies before packing.

**Built-ins only.** List all inputs to the build. The root `build.mjs` must be present. Use this format for a single runtime module.

```json
{
  "format": "pocket-node-source-v1",
  "entrypoint": "build.mjs",
  "files": ["build.mjs", "harness.mjs"]
}
```

**Vendored tree.** List every included file under its final path. A dependency entry has exactly `name` and `version`. For the following example, the included `package.json` must declare the same name and version.

```json
{
  "format": "pocket-node-tree-source-v1",
  "entrypoint": "build.mjs",
  "files": ["build.mjs", "src/agent.mjs", "node_modules/word/package.json", "node_modules/word/index.mjs"],
  "dependencies": [{"name": "word", "version": "1.0.0"}]
}
```

Both formats fix the build entrypoint at `build.mjs`. Format selects the recipe and lock kind. The optional `dependencies` field defaults to an empty array and must be empty for the flat format. Unknown manifest fields are errors. Keep the manifest within 2 MiB. File order and dependency declaration order have no effect on the bundle.

## Canonical bytes and admission limits

The ordered fields of the wire object are `format`, `platform`, `baseImageDigest`, `recipe`, `dependencyLock`, `files`. Platform is `linux/amd64`. Every digest uses `sha256:` followed by 64 lowercase hex digits. The base digest must match the immutable round. The recipe contains `kind`, then `entrypoint`. The lock contains `kind`, then `packages`. Files contain `path`, then `content`. Content uses standard, padded, canonical Base64 of the file's original bytes.

Sort files by ascending ASCII path and lock entries by name. Serialize using UTF-8 compact JavaScript `JSON.stringify`, without BOM or trailing newline. The source digest hashes the entire encoded object. Recipe and dependency-lock digests separately hash the compact JSON of those objects. `check` requires byte equality with the canonical form. `digest` prints the digest of the normalized form.

| Rule | Flat | Tree |
| --- | --- | --- |
| Source format | `pocket-node-source-v1` | `pocket-node-tree-source-v1` |
| Recipe kind | `node-build-v1` | `node-tree-build-v1` |
| Lock kind | `node-builtins-only-v1` | `vendored-node-tree-v1` |
| Source JSON limit | 262,144 bytes | 36 MiB |
| Number of files | 1–32 | 1–4,096 |
| Decoded bytes per file / total | 65,536 / 131,072 | 4 MiB / 24 MiB |
| Locked packages | Empty array required | 0–512 |

Flat names match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,70}\.(mjs|json|txt)$`. Names are unique ignoring case. Tree paths are at most 220 characters. Each component is 1–100 characters, starts with an ASCII letter, digit, underscore or `@`, and can also contain dots, plus and hyphen after the first character. Trailing dots and reserved device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9, including their extensions) are rejected. Directory capitalization must be consistent. Duplicate or case-colliding paths and file/directory conflicts are rejected. Archives, links and mode bits have no special representation.

Tree lock entries contain `name, version, root, treeDigest` in that order. Names match `^(?:@[a-z0-9_-]+/)?[a-z0-9_-][a-z0-9_.-]{0,99}$`. Versions match `^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$` and are at most 80 characters. Each unique name has a root at `node_modules/<name>` with a matching JSON package manifest of at most 65,536 bytes. Compute its digest over the compact JSON array of its sorted files, stripping the root and slash from each path. Every file under `node_modules` must belong to a lock entry. Nested installations are rejected. This verifies the declared bytes. Authors remain responsible for dependency completeness, provenance and permissions.

## Build and runtime output

A trusted driver expands the source under `/tmp/source` with file mode 0400 and executes Node on `build.mjs` there. The recipe receives a standard executable search path and `POCKET_OUTPUT`. Write the runtime artifact to that destination. The driver owns the output protocol on stdout.

| Build detail | Flat profile | Tree profile |
| --- | --- | --- |
| `POCKET_OUTPUT` | File `/tmp/output/harness.mjs` | Directory `/tmp/output` |
| Required output | Nonempty regular script, at most 65,536 bytes | Complete runtime tree including a nonempty root `harness.mjs` |
| Recipe / maximum outer timeout | 10 s / 15 s | 25 s / 30 s |
| Temporary filesystem | 32 MiB | 128 MiB |
| Driver stdout ceiling | 100,000 bytes | 36 MiB |
| Installed runtime entrypoint | `/harness.mjs` | `/app/harness.mjs` |

The recipe has a 65,536-byte buffer limit per output stream. The outer timeout can be lowered to 100 ms. Driver stderr is capped at 8,192 bytes. A tree output uses the same portable file, decoded size and count rules as a source tree. The driver allows at most 4,096 directories and 4,096 entries per directory, and rejects special files, symbolic links and multiply linked files. The canonical application layer must fit in 29 MiB.

Builds run offline in gVisor/KVM on Linux/amd64 as UID/GID 65532 with zero capabilities, a read-only pinned root filesystem, half a CPU, 512 MiB RAM, 64 processes and 128 open files. Only guest temporary storage is writable. No installer, network, host sockets, credentials or package lifecycle hooks are supplied. The driver, sandbox and root filesystem are pinned by digest. Build metadata binds the source, recipe, lock, build environment, base image and root filesystem. An incompatible profile or base, nonzero recipe exit, timeout, invalid output or oversized layer fails the build.

## Worker control protocol

On a cold single-host run the worker starts `/usr/local/bin/node` on the installed runtime entrypoint, with working directory `/tmp`. Resolve module imports relative to the entrypoint. The runtime uses the build's user and CPU, memory, process and descriptor limits, with 16 MiB of temporary storage. The application and root filesystem are read-only. Durable workspace files live behind the state gateway.

The worker mounts per-run channels. With `POCKET_ACTIVATION_REQUIRED=1`, read the version-1 activation record at `/channels/activation.json`, binding the run and task IDs. Connect outward to `/channels/control.sock` and serve HTTP on that single persistent connection. The host sends the following requests.

| Request | Body and response |
| --- | --- |
| `GET /v1/health` | Reply with `{"ready":true}` within 10 s. Advertise `contextVersion:2`, `workspaceEdit:true` or `trailingCompaction:true` only if implemented. |
| `POST /v1/session` | One `0.1-draft` session with run/task/event IDs, artifact digest, time, recorded actions and capability flags. The optional model specifies alias, max output tokens and optional step limit. Restore required context before returning `{"ready":true}`. Negotiated sessions can request `compactAfterAnswer:true`. |
| `POST /v1/message` | Receives a JSON string. Return exactly `{"status":"completed","text":"..."}` or `{"status":"waiting","text":"..."}` with nonempty text. Use waiting for an outstanding user action. |
| `POST /v1/event` | Receives a recorded action including ID, operation, parameters, status and receipt. Resume using recorded outcomes and return the same reply shape. |
| `POST /v1/compact` | Optional negotiated post-answer compaction. Receives `{}` and acknowledges completion. |

Ordinary control requests and replies use JSON and fit in 32 KiB each. If the host accepts NDJSON, a streaming reply may send `{"type":"text","text":"..."}` records followed by exactly one `{"type":"result","value":...}`, each on its own line. Maximum stream size is 128 KiB. Errors use a non-200 JSON `{"error":"code"}` or a terminal stream record `{"type":"error","code":"..."}`. The bounded codes are `run_step_limit`, `model_provider_failed`, `model_budget_exhausted`, `model_context_limit`, `tool_failed`, `guest_crashed` and `guest_protocol_error`. Revocation closes the channels and cancels the run. The single-host run deadline can be at most 600 s. The engineering agent suites use 45 s per case.

## Model, tools and persistent state

Send HTTP POSTs on `/channels/gateway.sock` with UTF-8 JSON, `Content-Type: application/json` and an explicit byte `Content-Length`. The host rejects transfer-encoded or content-encoded bodies. It binds the socket to a run with permissions and budgets. Credentials and external network access stay with the host.

- **Model.** POST `/v1/model/stream` with `requestId, model, maxOutputTokens, messages, tools`. Use the session alias and budget. An optional `stableContextEnd` marks a stable prefix. Messages have a role and string content. Tool names must be supported by the gateway. Read NDJSON text chunks, indexed tool fragments (ID, name, arguments), usage and a terminal finish or error. Finish reasons are `stop`, `tool_calls` and `length`. Assemble a full call before dispatch. Follow an assistant message containing `toolCalls:[{id,name,arguments}]` with one `role:"tool"` message per call containing `toolCallId` and its string result.
- **Tools.** POST `/v1/tools/request`. Most operations include `requestId` and operation-specific fields. For example, `web.search` takes `query`, `web.read` takes an authorized `url`, and `browser.click` takes `snapshotId` and `ref`. Page content supplies data. The gateway enforces consent and grants. For `email.send`, `parameters` contains `to, subject, body`. A proposal can require approval. Only the recorded outcome establishes execution.
- **Workspace.** POST `/v1/state/request`, starting with `{"operation":"workspace.list","revision":null,"offset":0}`. Retain the returned revision. Use it for subsequent lists, reads, writes, ranged reads, chunked writes or negotiated edits. A committed change returns a new revision. Chunks use UTF-8 byte offsets and commit on `final:true`. Writes and chunks allow 8 KiB of text and at most 12,000 bytes as a serialized JSON string. An edit accepts 1–8 operations. Default workspace quotas are 1 MiB per file, 1,024 files and 16 MiB total.
- **Other capabilities.** History and context use the state gateway, including `history.read/search/record` and `context.read/recent/commit/failed`. Enabled memory supports listing, reading and proposing changes to `profile.`, `preference.` or `fact.` keys. Proposals bind base version and evidence and can require confirmation. Optional team and schedule routes are `/v1/team/request` and `/v1/schedules/propose`. The session determines availability.

A single-host run admits up to 128 gateway requests, eight simultaneous gateway sockets and one request per socket. Ordinary bodies and replies fit in 32 KiB, workspace edit requests in 48 KiB and model requests in 128 KiB. Model output is limited to 1 MiB per stream and 64 KiB per line. Model requests allow 1–64 messages, up to 16,384 characters of content each and 1–4,096 requested output tokens. The per-run model-step limit is 2–32, default 12, including context work. The host separately enforces route, token, cost and concurrency budgets. Request headers and receipt have 2 s timeouts. Tool abort deadlines are 9 s for ordinary tools, 15 s for browser operations and 24 s for calendar lists. Model provider attempts default to 45 s unless the route overrides that value.

## Production startup requirements

A checkpoint-required single-host worker prepares a clean guest that signals standby with a stdout JSON record containing `"pocketStartup":"activation-wait"` before it acquires a session or host connection. On restore, wait for a fresh activation, bind its run/task/instance and entropy, and return its `instanceId` plus a fresh 64-hex-character `instanceNonce` at health. The worker verifies the template and response.

Cluster workers use one-time warm pods. With `POCKET_CLUSTER_ACTIVATION=1`, signal clean standby and read a fresh newline-delimited activation on stdin. It binds pool, run, execution epoch, pod, instance, entropy, CA, leased gateway addresses and a short-lived token. Interactive control uses numbered stdin requests (`session`, `turn`, `event`, optional `compact`) and stdout health, text, reply or failure records. Bind replies to their request ID. Send calls only to the activated model, tool and memory gateways over authenticated TLS with the supplied CA, bearer lease and run binding. Warm admission and activation are required for cluster deployment. A cold-only example cannot satisfy either a warm cluster or a restore-required worker.

## Submission and rejection

The weekly rules define how to derive the round ID and build-record digest. The CLI's `round` returns JSON with a numeric `index` and string `id`, or an error for a pre-start block. `round-digest` reads the original record, substitutes the weekly ID and prints the prefixed digest. The operator's original window and quotas are retained. [Round record and worked example](rules.md)

1. Bind the canonical source digest and round digest to the subnet and registered sr25519 hotkey. The submission ID hashes `pocket-submission-v2\n` followed by compact JSON of `[netuid,hotkey,roundDigest,sourceDigest]`. The chain Raw field contains exactly 67 ASCII bytes, `p1:` followed by the ID's 64 hex digits. Here and below `\n` denotes one LF byte.
2. Construct the request fields in order as `version` (`pocket-miner-v2`), `identity` (fields `kind:"sr25519", hotkey`), numeric `netuid`, `at` in Unix milliseconds, and `command`. The command's fields in order are `action:"submit", roundId, roundDigest, sourceDigest, source`. The final value is the entire canonical bundle as a **string**. Sign the UTF-8 bytes of `pocket-miner-command-v2\n` followed by the prefixed SHA-256 of the compact request JSON. Send `{request,signature}` with the 64-byte signature in lowercase hex.
3. The queue rejects malformed or oversized input, wrong subnet, failed signature, noncanonical source, digest mismatch, unregistered hotkey or a finalized current commitment different from the expected one. The envelope limit is twice 36 MiB plus 4,096 bytes. Envelopes over 300,000 bytes require the tree format. The timestamp must be within five minutes of the validator clock at verification and again after the chain read.
4. The round must exist with matching digest and base. A new ID must fit both round and per-miner quotas and arrive during `opensAt <= now < closesAt`. An authenticated retry of an accepted ID can retrieve its existing record after closing. Successful admission queues a build. Evaluation still requires a valid artifact, a compatible runner and compliant guest behavior. An operator can ingest the signed envelope directly. There is no public intake URL.
