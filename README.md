# elenchus

A controller for multi-pass, cross-vendor AI code review on GitHub.

In a review run this way, each pass of a pull request's review is its own agent session, a
*seat*, routed to the vendor, model and effort chosen for it. Every
seat ends its pull-request comment with a *seat record*, a small JSON block saying what it was
asked to run, what it actually ran, which commits it read and wrote, and what it found. elenchus
reads those records back from GitHub, checks them against the repository's own rules, and says
what the review needs next. The pull request is its only state.

The name is Socrates' method: a claim stands only if it survives questioning. Here the claim is
"this pull request was reviewed as routed", and the questions are asked of the records.

## Status

elenchus is an installable CLI. Two public projects illustrate the review method:

- [keel](https://github.com/BeniCheni/keel), whose seats already post records by hand, read back
  with `status` and `check`.
- [Kickoff](https://github.com/BeniCheni/kickoff), where the review method was first run by hand.
  A replay of one of its reviews is this repository's live fixture.

Any repository on GitHub can adopt it the same way.

## How a review runs

A review is an ordered list of passes named by the repository. Schema v1.2 accepts any
non-empty pass id. The configuration names the passes, their order, seats and coverage rules.
The seven passes below are one example.

| Pass | What it does, in a typical configuration | Seat kind |
| --- | --- | --- |
| `0` | brief the cold review | read-only |
| `1` | cold review: findings, covering every changed path | writing |
| `1.5` | brief the rebuttal | read-only |
| `2` | rebuttal: the builder answers or fixes each finding | writing |
| `2.5` | synthesis: what stands, covering every changed path | read-only |
| `3` | a person rules on what is left | none |
| `exec` | an executor applies the rulings | writing |

A writing seat may push commits to the pull request; a read-only seat is launched to read
only; a pass with no seat is a person's. The build and the review are meant to come from different vendors, so no
model grades its own work.

A **seat record** is the last fenced `json` block of a pull-request comment, validated against
[`schema/seat-record-1.2.json`](schema/seat-record-1.2.json) when it declares
`schema_version: "1.2"`. Records without that field use the preserved
[`v1.1 schema`](schema/seat-record-1.1.json). Model and effort each carry what
was requested and what was observed, with the observation's source; an observed value the seat
cannot see is `null` with the source `"not reported"`, never a copy of the request.

```json
{
  "seat_record": 1,
  "schema_version": "1.2",
  "pr": 42,
  "pass": "1",
  "runtime": "Claude Code",
  "model": { "requested": "claude-fable-5-2", "observed": "claude-fable-5-2", "source": "session transcript" },
  "effort": { "requested": "xhigh", "observed": null, "source": "not reported" },
  "route": { "recommended_by": "lead", "confirmed_by": "maintainer", "by_hand": true },
  "posted_by": "your-login",
  "input_sha": "4f1c2e9a7b3d5c8e0f6a1b2c3d4e5f60718293a4",
  "output_sha": "4f1c2e9a7b3d5c8e0f6a1b2c3d4e5f60718293a4",
  "commits": [],
  "findings": [
    { "id": "1", "severity": "blocking", "status": "open", "path": "src/app.ts", "start_line": 10, "end_line": 12 }
  ],
  "coverage": { "total": 3, "reviewed": 3, "skipped": [] },
  "verdict": "merge after a fix round"
}
```

Only comments by the logins in `record_authors` can carry records. `check` reports an ignored
comment from another account when it contains a JSON fence.

A v1.2 re-read sets `reread: true` on a later record of the same pass, with a later output SHA.
Its latest record supplies that pass's route, findings and coverage. The posting sequence
retains its original position. The re-read must advance its earlier output and continue the
recorded SHA chain. A record can include `next_route` with `runtime`, `model`, `effort`,
`recommended_by` and `confirmed_by`. `prep` uses that route, with each flag overriding its
corresponding field, and records each choice in the stamp. Optional
`coverage.reviewed_paths` accounts for each manifest path alongside `skipped`.
A later unmarked correction at the same input and output SHAs replaces the standing v1.2
record in its existing slot. Both `status` and `check` name the two comment IDs. v1.2 SHA
fields use all 40 hex digits.

## Commands

| Command | What it does |
| --- | --- |
| `elenchus status <pr>` | Where the review stands: each pass's record, output commit and comment, the next step, and, once every pass is recorded, whether the head still equals the last recorded output. `--json` for machines. |
| `elenchus check <pr>` | Every rule, below. Prints `ok`, or one `FAIL`, `UNVERIFIED` or `NOTICE` line per problem. |
| `elenchus prep <pr> <pass> --seat-keychain-service <name> [route flags]` | Makes the seat for the next pass: its own clone at the expected commit, its installs, a deny profile in the vendor's own format, a stamp of the route and a coverage manifest; then prints the line that launches it. `--root` moves the seats from `~/.elenchus/seats`. |
| `elenchus authorize <pr> [--dry-run] [--app-keychain-service <name>]` | Checks completeness, configured blockers, allowed head changes and required CI checks, then posts the success status as the configured App. Dry-run prints the decision. |
| `elenchus handoff <pr>` | Prints a release block with the reviewed head, squash subject and body. The block reads the PR's merge commit after merging, fetches and fast-forwards its base branch, then tags that commit. `--subject` overrides the changelog subject. |

`<pr>` is `owner/repo#n` or a pull-request URL. `check` exits 0 with no `FAIL`, 1 with one, and
2 when it cannot run. `authorize` exits 1 for each refusal and 2 for an execution error.
It reads configuration at the base branch's tip and prints that ref and commit in its decision.
It posts only success, at the evaluated head. The decision lists each blocker and the shape
that admitted each qualifying commit after the review.

`check`'s rules:

| Rule | What it holds a record to |
| --- | --- |
| `sequence` | Earlier passes have records posted in order. Re-reads retain the original pass position. |
| `schema` | The record validates against its declared version. |
| `pass` | The record names a configured pass. |
| `pr` | The record names the pull request it is posted on. |
| `sha-chain` | Each pass starts from the previous recorded pass's output, and every output is in the head's history. |
| `commits` | A writing pass lists exactly the commits it added. |
| `route` | The observed model and effort are ones the configuration accepts for what was requested. |
| `authors` | The record's runtime is a configured vendor, and its commits carry that vendor's identity. |
| `posted_by` | The record's `posted_by` is the comment's author. |
| `retries` | A rejected record goes back to its seat, and is escalated to a person past `retry_cap` failed attempts; a record's `retries` matches the failures its comments show. |
| `finding-carry` | Each carrying pass repeats the opener's IDs. The standing synthesis also carries IDs from earlier synthesis rounds and ruling records posted before it. The standing ruling carries IDs from earlier ruling rounds posted after the standing synthesis. Each carrier's standing record and the chain of records it replaces are one round. |
| `coverage` | For passes marked `coverage`, the record accounts for every path in the diff. Named reviewed paths must match the manifest without gaps or overlap. |
| `head` | Commits after the last review fall within the configured allowed set or need a re-read. |
| `ci` | When the head has moved past the reviewed boundary, each configured check is successful at that head and comes from its required App when pinned. |

`authorize` also requires all configured passes to have valid records, enforces configured
UNVERIFIED blockers, requires full output SHAs for the head decision, and checks CI even at
the reviewed head. It requires a schema v1.2 standing synthesis and a schema v1.2 ruling
posted after it. The historical v1.1 replay records on PR 1 therefore fail authorization.
Schema v1.2 accepts `blocking`, `should-fix` and `note`. A finding blocking in either
record needs an effective status of `fixed` or `killed`. The ruling supplies the status
when it names the ID. Otherwise the synthesis supplies it. Other contested findings need
a status other than `contested`. After any earlier pass without a valid record, `status` names
the pass that needs a v1.2 record for authorization when a gate is configured, or sends the
review to the ruling pass when the ruling is missing, stale or leaves findings unsettled.
Only `authorize` checks whether the gate meets its configuration requirements.
`status` makes no head compare, so a re-read that `check` requires comes before the pass
`status` names.
A same-SHA replacement under schema
v1.2 must precede any standing
record from a later configured pass. `authorize` reports accepted replacements with both
comment IDs. Seats follow the roster's vendor separation as a human review rule.

A merged pull request is named in one line. Its base is the merge commit's first parent when
available, and range rules are skipped. A comparison with 300 or more files uses the merge
base's and input commit's recursive trees to reconstruct coverage, with renames represented
as a deletion and an addition. A truncated tree fails the coverage check.

For the configured gate context at the head, `status` names the latest state for each
creator's login and account type and counts that creator's earlier statuses. Its source is
UNVERIFIED because GitHub's status API
does not report which App posted it; the review gate's ruleset decides whether it counts.
This applies to bots and people: a person's status can carry an App's integration when
posted with that App's user token. This display limitation adds no check rule or authorize
blocker. When the context has no status, the gate line says `no status`.

`prep` refuses an earlier missing record, unexpected head, unconfigured route, ineligible vendor,
open seat or fork. When the configured review pass has a standing record and the head has moved,
`prep` for that pass expects the current head and writes `reread: true` in its stamp.

## Configuration

Each repository describes its review in `.elenchus.json` on the pull request's base branch.
`--config <file>` reads another file instead. This is enough for `status` and `check`:

```json
{
  "passes": [
    { "id": "0", "role": "brief the cold review", "seat": "lead", "seat_kind": "read-only" },
    { "id": "1", "role": "cold review", "seat": "reviewer", "seat_kind": "writing", "coverage": true },
    { "id": "1.5", "role": "rebuttal brief", "seat": "lead", "seat_kind": "read-only" },
    { "id": "2", "role": "rebuttal", "seat": "builder", "seat_kind": "writing" },
    { "id": "2.5", "role": "synthesis", "seat": "lead", "seat_kind": "read-only", "coverage": true },
    { "id": "3", "role": "ruling", "seat": "maintainer", "seat_kind": "none" },
    { "id": "exec", "role": "executor", "seat": "executor", "seat_kind": "writing" }
  ],
  "vendors": {
    "claude": {
      "authors": ["Claude <noreply@anthropic.com>"],
      "runtimes": ["Claude Code"],
      "models": { "claude-fable-5-2": ["claude-fable-5-2"] },
      "efforts": { "xhigh": ["xhigh"], "high": ["high"] }
    }
  },
  "retry_cap": 2,
  "record_authors": ["your-login"]
}
```

Under each vendor, `models` and `efforts` map a requested value to the observed strings that
count as it, because vendors report the same model under different names. Equality must
also appear in the table. `examples/kickoff.elenchus.json` contains CLI request and observation
values. The historical prose names belong in the replay base's configuration, so those files
differ. `prep` and `handoff`
read further fields — `forbidden` (command prefixes the deny profile refuses), `installs`
(directories and their lockfiles), `read_only_seat` and `binary` per vendor, and `handoff` (the
version file, changelog heading, tag and merge templates, and the commands that must come back
green). Each is required only by the command that uses it.
[`examples/kickoff.elenchus.json`](examples/kickoff.elenchus.json) is one adopter's complete
file.

In `handoff.merge_command`, include `{merge_body}` where the merge CLI accepts its
squash body, for example `--body {merge_body}`. The renderer shell-quotes it as one
argument, just as it quotes `{merge_message}` for the subject. Each line names the configured
pass, role and seat, followed by the standing record's runtime, model and effort. A re-read
uses the latest record and includes the number of valid records for that pass. A missing
observation carries the request and its source. The trailers use the first configured author
of each vendor with a PR commit or a standing record, in vendor order. Vendors with an
empty authors list contribute no trailer.

Run the printed block in the target repository's checkout. It switches to the PR's base
branch and fast-forwards it. The tag uses the commit reported by `gh pr view --json mergeCommit`.
If the merge fails or is still queued, the command chain stops before tagging.

Optional `finding_flow` names `opens`, ordered `carries`, and the later `ruling` pass.
`escalate_to` supplies the escalation addressee. `gate` declares the status `context`,
`app_id`, `required_checks` (each `name` and optional `app_id`),
`blocking_unverified` rules, and `allowed_changes`. The allowed set names `paths`,
`reread_pass` and optional `version_only` settings for the version `file`, test globs and
`pattern`. The default version pattern accepts `MAJOR.MINOR.PATCH` with an optional
prerelease. `authorize` requires `gate.allowed_changes`, `finding_flow.ruling`, at least one
carrying pass in `finding_flow.carries` and at least one required check.
Unknown configuration keys produce notices in `status` and `check` and refusals in `authorize`.
The adoption example blocks unverified coverage.

The reviewed boundary is the standing record of `reread_pass`. Commits after it, including
executor commits, need green CI at the new head and one of these shapes.

- Configured paths and version-only changes. The version file and its install directory's
  lockfile must parse as JSON before and after, even when a path glob covers them. Each file
  keeps its original lines and line endings. Only the version strings on the version file's
  top-level `version` line and the lockfile's top-level `version` and `packages[""].version`
  lines can change. A lockfile with `lockfileVersion: 1` has only the top-level version for
  npm to update, so that project's bump needs a reviewed commit. `npm version` re-serialises
  `package.json`. If it would reformat the file (for example, expanding a one-line array or
  object, adding a final newline, or dropping a byte-order mark), bump in a reviewed commit
  or format the file as npm writes it first.
- Test changes by exact substitution of the old valid version string with the new valid string.
- A two-parent merge whose incoming parent is on the base branch and whose parents have
  one merge base. For each path, compare the two parents to that merge base. If only one side changes an entry, the result must
  carry that side's object and mode, including deletions. If both sides agree, the result
  must carry their shared entry. If both sides change it differently, a re-read is required.

Other commits need the configured review pass's re-read at their SHA. Before the review,
`authorize` counts a matching `verify` from a workflow the pull request defines or edits.
Passes 1 and 2.5 reading that workflow are the safeguard at that stage. After review in the
adopter's configuration, `.github/` falls outside the allowed paths and an edit needs a re-read.

### App and seat credentials

The operator creates a GitHub App with Commit statuses read and write and Metadata read,
webhooks off, installed on the intended repository. The App id belongs in `gate.app_id`.
Its RSA private key is a macOS Keychain generic password whose access controls prompt on
every read. `authorize --app-keychain-service <name>` reads it into memory through
`/usr/bin/security`. The reader accepts SecurityTool's lowercase
hex output followed by one newline and decodes the PEM bytes in memory. The reader clears
the `execFile` callback's stdout buffer, and the decoder clears its input and decoded PEM
buffer. Node manages the underlying stdout stream chunks and the crypto `KeyObject` used
to sign the JWT. Those allocations may retain key material until Node reclaims them.

Store the key's exact PEM bytes using `security -i` on standard input. In the interactive
command, `-X` takes the file's hex. For example, the operator can run this locally, replacing
the file path and placeholder service name. The command stream goes directly to `security`.

```bash
python3 - /path/to/app-private-key.pem <<'PYKEY' | /usr/bin/security -i
from pathlib import Path
import sys
key = Path(sys.argv[1]).read_bytes()
print('add-generic-password -a "review-controller" -s "your-app-key-service" -T "" -X ' + key.hex())
PYKEY
```

`-T ""` creates the item with an empty trusted-application list. Delete the downloaded PEM
file after storing the key.

Seats use a fine-grained token limited to the adopter repository, with Contents and Pull
requests read and write and Metadata read. Administration, Workflows and Commit statuses
remain at No access. Store it in another per-use-prompt Keychain item and pass its service
name to `prep --seat-keychain-service <name>`. To store the printable token, place `-w`
last so `security` prompts for its value.

```bash
/usr/bin/security add-generic-password -a "review-seat" -s "your-seat-token-service" -T "" -w
```

To inspect either list, find the service in Keychain Access, open **Get Info** and select
**Access Control**. Leave **Show password** unchecked. Confirm the item requires approval
and its trusted-application list is empty.

The clone resets inherited credential helpers and installs its own helper that reads that
item for HTTPS github.com requests. The printed launch line reads the same item by command
substitution and supplies `GH_TOKEN` to the vendor CLI. The stamp and launch line hold the
service name. Each read prompts the operator while the item requires confirmation and the
trusted-application list is empty. Choose **Allow** for one read. Never choose **Always Allow**,
which adds `/usr/bin/security` to the list and makes later reads silent. If this happens,
rotate the credentials and re-create both items before running the live gate again.

A seat runs as the operator's macOS user and can reach that user's `gh` login and SSH keys.
The credential-helper reset and override live in the clone's local Git configuration, which
the seat can edit with `git config --local --unset-all credential.helper`. GitHub's ruleset
requires the configured App's review status. The seat token has its own repository scope.

## Boundaries

- **GitHub reads.** `src/gh.ts` permits GET-only `gh api` calls, with paginated results
  assembled before checking the records.
- **GitHub writes.** `src/app-status.ts` permits exactly three App requests, checked before
  networking. It discovers the repository's installation with the JWT, creates the
  installation token with that JWT, and posts the four-field success status with the token.
  It refuses redirects. All other reads use the GET-only client.
- **git.** git runs only through an allowlist of `prep`'s exact invocations in `src/git.ts`, with
  hooks turned off. The only other program `prep` runs is `npm ci`.
- **Releases.** `handoff` prints the merge, tag and push for a person to run.

Two limits to know. The deny profiles `prep` writes are seatbelts that stop the direct forms,
not a guarantee: they miss a +refspec push such as `git push origin +HEAD:main`, `--force` after
the refspec, `--force-with-lease`, `sh -c` and `eval`. And Codex reads a project's rules only
from a trusted project, which cannot be granted for one run without writing `~/.codex`, so a
Codex seat currently runs without a deny profile; `prep` says so. `prep`'s `npm ci` runs the
pull request's install scripts as you.

## Install

Use Node 24 or later and npm. For `status` and `check`, sign in to `gh` with an account
that can read the target repository. To pin the tool in an adopter project, substitute the
full 40-character commit SHA from the elenchus revision you reviewed.

```bash
npm install 'github:BeniCheni/elenchus#<40-character-commit-sha>'
npx --no-install elenchus status owner/repo#123
npx --no-install elenchus check owner/repo#123
```

Commit the resulting package manifest and lockfile. CI installs the same revision with
`npm ci`. For a Git dependency, npm installs the build dependencies and runs `prepare`
to compile `dist/` before packing. Source installs require that preparation step.
For an installation that disables lifecycle scripts, build and pack the tool first and
install the resulting tarball, which already contains the CLI.

## Roadmap

Where it should end up: a repository declares how its pull requests are reviewed, by which
vendors and models; agents from different vendors take the seats; elenchus proves from the
records alone that each pass ran as routed, on the right commits, and covered what it claims;
and a merge waits for that proof. In order:

1. **Read the records** — `status` and `check`. Done.
2. **Prepare the seats** — `prep`, `handoff` and the coverage rule. Done.
3. **The gate and schema v1.2.** Done on the replay. App-backed `authorize`, configurable policy, re-reads and
   repository-defined passes. Live proof on the replay precedes adopter enablement.
4. **Adoption.** elenchus supports commit-pinned installs and release blocks built from the
   PR's records, base and merge commit. After v0.6.0, Kickoff's half adds the seat-record
   block to its review skill and calls the pinned tool. The gate on adopter default branches
   follows, including the bot-workflow path.
5. **Seats that start themselves.** `elenchus run` launches a confirmed route and checks its
   observation before the seat pushes. Claude Code first, then Codex.

Deferred: a graphical viewer, and seats from vendors beyond these three.

## Development

```bash
npm run typecheck
```

```bash
npm test
```

`ELENCHUS_RECORD_DIR`, off by default, saves every API response into that directory so a test
can keep it as a fixture; the tool never reads those files back. `npm run harness:t4` is a
manual probe of each vendor's seat in a scratch repository, never run in CI and not in the
package.

The `replay/*` branches replay a real six-pass review, Kickoff PR 320, as live fixtures. Their
pull requests are drafts labelled `fixture`, locked, and never merged.

## License

MIT
