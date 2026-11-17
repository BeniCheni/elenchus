# elenchus

A read-only controller for multi-pass, cross-vendor AI code review on GitHub.

In a review run this way, each pass of a pull request's review is its own agent session, a
*seat*, routed to the vendor, model and effort chosen for it: Claude Code, Codex or Cursor. Every
seat ends its pull-request comment with a *seat record*, a small JSON block saying what it was
asked to run, what it actually ran, which commits it read and wrote, and what it found. elenchus
reads those records back from GitHub, checks them against the repository's own rules, and says
what the review needs next. The pull request is its only state, and it never writes to GitHub.

The name is Socrates' method: a claim stands only if it survives questioning. Here the claim is
"this pull request was reviewed as routed", and the questions are asked of the records.

## Status

A working proof of concept, version 0.0.0, not yet published to npm. Two public projects are
adopting it:

- [keel](https://github.com/BeniCheni/keel), whose seats already post records by hand, read back
  with `status` and `check`.
- [Kickoff](https://github.com/BeniCheni/kickoff), where the review method was first run by hand.
  A replay of one of its reviews is this repository's live fixture, and its own seats start
  posting records after its v0.6.0 release.

Any repository on GitHub can adopt it the same way. Today it reads, checks, prepares seats and
prints a release block; it does not yet gate a merge or start a seat by itself (see
[Roadmap](#roadmap)).

## How a review runs

A review is an ordered list of passes. Seat record schema v1.1 fixes the seven pass ids below;
what each pass is called, who sits in it, what kind of seat it gets and whether it must report
coverage are the repository's to configure.

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
[`schema/seat-record-1.1.json`](schema/seat-record-1.1.json). Model and effort each carry what
was requested and what was observed, with the observation's source; an observed value the seat
cannot see is `null` with the source `"not reported"`, never a copy of the request.

```json
{
  "seat_record": 1,
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

Only comments by the logins in `record_authors` can carry records; any other account's comment
is ignored, and `check` names it.

## Commands

| Command | What it does |
| --- | --- |
| `elenchus status <pr>` | Where the review stands: each pass's record, output commit and comment, the next step, and, once every pass is recorded, whether the head still equals the last recorded output. `--json` for machines. |
| `elenchus check <pr>` | Every rule, below. Prints `ok`, or one `FAIL`, `UNVERIFIED` or `NOTICE` line per problem. |
| `elenchus prep <pr> <pass> --runtime <vendor> --model <id> --effort <word> --confirmed-by <name>` | Makes the seat for the next pass: its own clone at the expected commit, its installs, a deny profile in the vendor's own format, a stamp of the route and a coverage manifest; then prints the line that launches it. `--root` moves the seats from `~/.elenchus/seats`. |
| `elenchus handoff <pr>` | Prints the release block for a release-shaped pull request, pinned to the reviewed head, and runs none of it. `--subject` overrides the subject taken from the changelog. |

`<pr>` is `owner/repo#n` or a pull-request URL. `check` exits 0 with no `FAIL`, 1 with one, and
2 when it cannot run at all; a network failure is a 2, never a pass.

`check`'s rules:

| Rule | What it holds a record to |
| --- | --- |
| `sequence` | Every earlier pass has a record. |
| `schema` | The record validates against schema v1.1. |
| `sha-chain` | Each pass starts from the previous writing pass's output, and every output is in the head's history. |
| `commits` | A writing pass lists exactly the commits it added. |
| `route` | The observed model and effort are ones the configuration accepts for what was requested. |
| `authors` | The record's runtime is a configured vendor, and its commits carry that vendor's identity. |
| `posted_by` | The record's `posted_by` is the comment's author. |
| `retries` | A rejected record goes back to its seat, and is escalated to a person past `retry_cap` failed attempts; a record's `retries` matches the failures its comments show. |
| `finding-carry` | Every finding the cold review opened appears again in passes `2` and `2.5`. |
| `coverage` | For passes marked `coverage`, the record accounts for every path in the diff. |

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
count as it, because vendors report the same model under different names. `prep` and `handoff`
read further fields — `forbidden` (command prefixes the deny profile refuses), `installs`
(directories and their lockfiles), `read_only_seat` and `binary` per vendor, and `handoff` (the
version file, changelog heading, tag and merge templates, and the commands that must come back
green). Each is required only by the command that uses it.
[`examples/kickoff.elenchus.json`](examples/kickoff.elenchus.json) is one adopter's complete
file.

## What it will not do

- **Write to GitHub.** Every GitHub call is `gh api --method GET`, behind an allowlist that
  refuses any other shape before `gh` starts.
- **Run git beyond what `prep` needs.** git runs only through an allowlist of `prep`'s exact
  invocations, with hooks turned off; it never pushes, tags, commits or merges. The only other
  program `prep` runs is `npm ci`.
- **Release anything.** `handoff` prints the merge, tag and push for a person to run.

Two limits to know. The deny profiles `prep` writes are seatbelts that stop the direct forms,
not a guarantee: they miss a +refspec push such as `git push origin +HEAD:main`, `--force` after
the refspec, `--force-with-lease`, `sh -c` and `eval`. And Codex reads a project's rules only
from a trusted project, which cannot yet be granted for one run without writing `~/.codex`, so a
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
3. **The gate.** `elenchus authorize` and a required status check, proven on this repository's
   replay before any adopter turns it on. It will be elenchus's one write to GitHub, a commit
   status, with the credential still to be chosen. `status` already names `authorize` as the
   step after the last pass. Alongside it, which pass opens findings, which carry them and who
   an escalation goes to move from the code into the configuration.
4. **Adoption.** A release adopters can pin; the record block in each adopter's review
   instructions; the release block takes its base branch and its tagged commit from the pull
   request; then the gate on an adopter's default branch.
5. **Seats that start themselves.** `elenchus run` launches a seat on its confirmed route and
   reads the observed model back before the seat may push, stopping on a mismatch. Claude Code
   first, then Codex, then Cursor for writing seats.
6. **Schema v1.2.** A repository names its own passes instead of the seven ids above, and a
   record can carry the route of the pass it hands to and name the paths it read rather than
   count them.

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
