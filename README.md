# elenchus

elenchus is a stateless controller for one pass of Kickoff's six-pass 360 review. Each run reads the pull request's comments and commits from GitHub and says what the review needs next. It keeps no state on disk and no cache, and it never writes to GitHub. GitHub access is a `gh` subprocess limited to GET.

This repository is a proof of concept under development. `main` holds the tool. `replay/*` branches hold a replay of [BeniCheni/kickoff#320](https://github.com/BeniCheni/kickoff/pull/320) as fixtures. Those pull requests are drafts, labelled `fixture`, and are never merged.

Sprint 1 is the read-only controller: `elenchus status` and `elenchus check`. A seat record is the one fenced `json` block that ends a pull-request comment, validated against `schema/seat-record-1.1.json`. What is Kickoff's — the pass order, seat roles, vendor commit identities, and the exact observed strings that count as each requested model and effort — is read from `.elenchus.json` on the pull request's base branch. `--config` overrides that file for tests.

Not in this sprint: preparing a seat, authorizing a merge, posting a status, tagging, or a pass value for the PM seat's re-read after the executor.
