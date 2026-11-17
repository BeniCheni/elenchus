# elenchus

A controller for multi-pass, cross-vendor AI code review on GitHub.

In a review run this way, each pass of a pull request's review is its own agent session, a
*seat*, routed to the vendor, model and effort chosen for it: Claude Code, Codex or Cursor. Every
seat ends its pull-request comment with a *seat record*, a small JSON block saying what it was
asked to run, what it actually ran, which commits it read and wrote, and what it found. elenchus
reads those records back from GitHub, checks them against the repository's own rules, and says
what the review needs next. The pull request is its only state.

The name is Socrates' method: a claim stands only if it survives questioning. Here the claim is
"this pull request was reviewed as routed", and the questions are asked of the records.

## Status

A controller built as an installable CLI package, version 0.0.0. Two public projects are
adopting it:

- [keel](https://github.com/BeniCheni/keel), whose seats already post records by hand, read back
  with `status` and `check`.
- [Kickoff](https://github.com/BeniCheni/kickoff), where the review method was first run by hand.
  A replay of one of its reviews is this repository's live fixture, and its own seats start
  posting records after its v0.6.0 release.

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

## Commands

| Command | What it does |
| --- | --- |
| `elenchus status <pr>` | Where the review stands: each pass's record, output commit and comment, the next step, and, once every pass is recorded, whether the head still equals the last recorded output. `--json` for machines. |
| `elenchus check <pr>` | Every rule, below. Prints `ok`, or one `FAIL`, `UNVERIFIED` or `NOTICE` line per problem. |
| `elenchus prep <pr> <pass> --seat-keychain-service <name> [route flags]` | Makes the seat for the next pass: its own clone at the expected commit, its installs, a deny profile in the vendor's own format, a stamp of the route and a coverage manifest; then prints the line that launches it. `--root` moves the seats from `~/.elenchus/seats`. |
| `elenchus authorize <pr> [--dry-run] [--app-keychain-service <name>]` | Checks completeness, configured blockers, allowed head changes and required CI checks, then posts the success status as the configured App. Dry-run prints the decision. |
| `elenchus handoff <pr>` | Prints the release block for a release-shaped pull request, pinned to the reviewed head, and runs none of it. `--subject` overrides the subject taken from the changelog. |

`<pr>` is `owner/repo#n` or a pull-request URL. `check` exits 0 with no `FAIL`, 1 with one, and
2 when it cannot run. `authorize` exits 1 for each refusal and 2 for an execution error.
It uses the configuration at the pull request's base SHA. It posts only success, at the head
it evaluated. Its output lists each blocker when it refuses.

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
| `finding-carry` | Every finding opened by `finding_flow.opens` appears in each `finding_flow.carries` pass. |
| `coverage` | For passes marked `coverage`, the record accounts for every path in the diff. Named reviewed paths must match the manifest without gaps or overlap. |
| `head` | Commits after the last review fall within the configured allowed set or need a re-read. |
| `ci` | Each configured check is successful at the evaluated head and comes from its required App when pinned. |
| `ruling` | A contested synthesis finding requires a later ruling record before authorization. |

A merged pull request is named in one line. Its base is the merge commit's first parent when
available, and range rules are skipped. A comparison with 300 or more files uses the merge
base's and input commit's recursive trees to reconstruct coverage, with renames represented
as a deletion and an addition. A truncated tree fails the coverage check.

`status` identifies the gate status at the head by App identity. It names statuses from
other accounts as not counting. When a private App's metadata is inaccessible to the GET
client, the source is reported as UNVERIFIED.

`prep` refuses rather than guess: it names the first earlier pass with no record, a head that
moved after the last record, a route that is not in the configuration's tables, a vendor that
may not hold that kind of seat, a seat still open on that pull request, or a pull request from
a fork.

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

Optional `finding_flow` names `opens`, ordered `carries`, and the later `ruling` pass.
`escalate_to` supplies the escalation addressee. `gate` declares the status `context`,
`app_id`, `required_checks` (each `name` and optional `app_id`),
`blocking_unverified` rules, and `allowed_changes`. The allowed set names `paths`,
`reread_pass` and an optional `version_only` pair of the version `file` and test globs.
The adoption example blocks unverified coverage.

After review, a commit qualifies when it changes only configured paths, or changes a test
only through exact old-to-new version substitutions. A two-parent base merge qualifies when
each path changed from its first parent has the second parent's object and mode, including
deletions. Other commits need the configured review pass's re-read at their SHA. Required CI
checks must be green at the new head.

### App and seat credentials

The operator creates a GitHub App with Commit statuses read and write and Metadata read,
webhooks off, installed on the intended repository. The App id belongs in `gate.app_id`.
Its RSA private key is a macOS Keychain generic password whose access controls prompt on
every read. `authorize --app-keychain-service <name>` reads it into memory through
`/usr/bin/security`. The reader accepts SecurityTool's lowercase
hex output followed by one newline, decodes the PEM bytes in memory, and clears both buffers.
The key is used to sign a JWT with Node's crypto library.

Store the key's exact PEM bytes using `security -i` on standard input. In the interactive
command, `-X` takes the file's hex. For example, the operator can run this locally, replacing
the file path and placeholder service name. The command stream goes directly to `security`.

```bash
python3 - /path/to/app-private-key.pem <<'PYKEY' | /usr/bin/security -i
from pathlib import Path
import sys
key = Path(sys.argv[1]).read_bytes()
print('add-generic-password -a "review-controller" -s "your-app-key-service" -X ' + key.hex())
PYKEY
```

Set the item's access controls in Keychain Access to prompt for every read with no trusted
application, then delete the downloaded PEM file.

Seats use a fine-grained token limited to the adopter repository, with Contents and Pull
requests read and write and Metadata read. Administration, Workflows and Commit statuses
remain at No access. Store it in another per-use-prompt Keychain item and pass its service
name to `prep --seat-keychain-service <name>`. To store the printable token, place `-w`
last so `security` prompts for its value.

```bash
/usr/bin/security add-generic-password -a "review-seat" -s "your-seat-token-service" -w
```

Set this item's access controls to prompt for every read with no trusted application.

The clone resets inherited credential helpers and installs its own helper that reads that
item for HTTPS github.com requests. The printed launch line reads the same item by command
substitution and supplies `GH_TOKEN` to the vendor CLI. The stamp and launch line hold the
service name. Each read prompts the operator.

A seat runs as the operator's macOS user and can still reach the operator's own `gh` login.
D1's ruleset pin to the GitHub App keeps a seat from satisfying the review gate. D9 scopes
the credentials that prep configures.

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

Node 24 or later, and `gh` signed in to an account that can read the repository.

```bash
git clone https://github.com/BeniCheni/elenchus.git && cd elenchus && npm ci && npm run build
```

```bash
node dist/cli.js status owner/repo#123
```

## Roadmap

Where it should end up: a repository declares how its pull requests are reviewed, by which
vendors and models; agents from different vendors take the seats; elenchus proves from the
records alone that each pass ran as routed, on the right commits, and covered what it claims;
and a merge waits for that proof. In order:

1. **Read the records** — `status` and `check`. Done.
2. **Prepare the seats** — `prep`, `handoff` and the coverage rule. Done.
3. **The gate and schema v1.2.** Done on the replay. App-backed `authorize`, configurable policy, re-reads and
   repository-defined passes. Live proof on the replay precedes adopter enablement.
4. **Adoption.** A release adopters can pin, record blocks in each adopter's review
   instructions, and release blocks that derive the base branch and merge commit from the
   pull request. Then the gate on adopter default branches, including the bot-workflow path.
5. **Seats that start themselves.** `elenchus run` launches a confirmed route and checks its
   observation before the seat pushes. Claude Code first, then Codex, then Cursor writing seats.

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
