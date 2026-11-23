import type { Finding, SeatRecord } from "../../src/types.js";

const posted = "BeniCheni";

function finding(
  id: string,
  severity: string,
  status: Finding["status"],
  evidence: string,
  disposition?: Finding["disposition"],
): Finding {
  return { id, severity, status, evidence, ...(disposition ? { disposition } : {}) };
}

function base(pass: string, over: Partial<SeatRecord>): SeatRecord {
  return {
    seat_record: 1,
    pr: 1,
    pass,
    runtime: "Claude Code",
    model: { requested: null, observed: null, source: "not reported" },
    effort: { requested: null, observed: null, source: "not reported" },
    route: { recommended_by: null, confirmed_by: null },
    posted_by: posted,
    input_sha: "0faf606",
    output_sha: "0faf606",
    commits: [],
    findings: [],
    verdict: "",
    ...over,
  };
}

const pass1 = [
  finding("1", "medium", "fixed", "No test failed when a hero printed a clock for a kickoff the league has not set. Fixed in 9b3a90a."),
  finding("2", "medium", "fixed", "The duplicate-key case in tests/urlCodecs.test.ts was rewritten so it passes whether canonicalSearch keeps the first duplicate or the last. Fixed in b275a56."),
  finding("3", "medium", "fixed", "npm test failed 7 of 9 plain runs at 0faf606 (ENOTEMPTY in tests/vercelIgnore.test.ts). Fixed in 961d320."),
  finding("4", "medium", "fixed", "Current-state text still described the removed surfaces. Fixed in d1f32c0."),
  finding("5", "medium", "open", "PR #316 and this PR conflict, and #316 extends the surface this PR deletes. Not fixed. The order is Beni's."),
  finding("6", "medium", "open", "The header fits the tabs and the switcher on one row at 375 with 3.86 px to spare, and only once Oswald has loaded. Not fixed. Row 125."),
  finding("7", "low", "open", "Five test files spell the retired names as broadcast and a unicode escape so the prompt's grep stays empty. Not fixed."),
  finding("8", "low", "open", "Both surviving heroes say \"No upcoming fixtures match your filters.\" when nothing is ahead. Not fixed. Row 126."),
  finding("9", "low", "open", "web/test/fixtures-table.test.tsx asserts the server markup has no data-lens=\"broadcast\". No markup renders data-lens. Not fixed."),
];

const pass2 = [
  finding("1", "medium", "fixed", "Accept. No product change. The slate-row mutation failed one test.", "accept"),
  finding("2", "medium", "fixed", "Accept. Both mutations fail. Only the URL rewrite is tied to keeping the retired name out of the file.", "accept"),
  finding("3", "medium", "fixed", "Accept for 0faf606. The guard stays. Two objects do repack, and the task is geometric-repack.", "accept"),
  finding("4", "medium", "fixed", "Accept. No change. The ARCHITECTURE rewrite matches the code.", "accept"),
  finding("5", "medium", "open", "The facts hold. No view on the order. Six conflicting files. Not fixed."),
  finding("6", "low", "contested", "Accept the observation. Severity here is low. No CSS.", "accept-observation-contest-severity"),
  finding("7", "low", "fixed", "Accept, and do it in this PR. It stayed one test file plus the five literals. Commit 0c7bdd8.", "accept"),
  finding("8", "low", "open", "Accept the observation. The copy stays out. Severity stays low.", "accept"),
  finding("9", "low", "fixed", "Accept. The assertion now reads the checked radio. Commit 97200f3.", "accept"),
  finding("N1", "low", "fixed", "The completed-rows table said row 10 and the month half of row 11 were closed by removal, while the ranked rows still said otherwise. Fixed in 09324fb."),
  finding("N2", "low", "fixed", "Row 116 said, in the present tense, that Broadcast is dark whatever the OS says. Fixed in 09324fb."),
];

const pass25 = [
  finding("1", "medium", "fixed", "With either hero printing the filler instant, no test notices at 0faf606. At the head the Ledger case and the Poster case each fail.", "accept"),
  finding("2", "medium", "fixed", "Last-duplicate-wins passes 19 of 19 at 0faf606 and fails one at the head.", "accept"),
  finding("3", "medium", "fixed", "The plain suite at 0faf606 was red with ENOTEMPTY in 2 of 3 runs, and green in 3 of 3 at the head. The guard stays.", "accept"),
  finding("4", "medium", "fixed", "Read against the code. A case-insensitive search of the audited paths finds the retirement note and dated history.", "accept"),
  finding("5", "medium", "open", "git merge-tree against 7f7746f: six files. The facts hold."),
  finding("6", "medium, not fixed → low", "contested", "The geometry reproduces to the pixel. The 360 half does not reproduce as a regression. Severity contested.", "accept-observation-contest-severity"),
  finding("7", "low", "fixed", "The audit passes clean. Done in 0c7bdd8 and 97200f3."),
  finding("8", "low", "open", "The copy is in both heroes. The snapshot's window runs 2026-10-14 to 2027-04-12, so today is not that state."),
  finding("9", "low", "fixed", "With the retired lens made to decode to Ledger, the web test passes at 0faf606 and fails at the head."),
  finding("N1", "low", "fixed", "Pass 2, fixed in 09324fb. The ranked rows and the completed-rows table now agree."),
  finding("N2", "low", "fixed", "Pass 2, fixed in 09324fb. The ranked rows and the completed-rows table now agree."),
];

export type ReplayRecord = { pass: string; firstLine: string; record: SeatRecord };

export const replayRecords: ReplayRecord[] = [
  {
    pass: "0",
    firstLine:
      "Transcribed by hand from docs/design-overhaul-clearing-review-prompt.md on BeniCheni/kickoff main for the elenchus replay. This is a fixture and is not a live seat.",
    record: base("0", {
      model: {
        requested: null,
        observed: "Opus 5.5",
        source: "transcribed: kickoff docs/design-overhaul-clearing-review-prompt.md:3",
      },
      route: { recommended_by: "PM", confirmed_by: null },
      input_sha: "0faf606",
      output_sha: "0faf606",
      verdict: "cold-review brief for the clearing",
      not_verified: ["It ran no test, build or browser."],
    }),
  },
  {
    pass: "1",
    firstLine:
      "Transcribed by hand from Kickoff PR 320 comment 6880031532 for the elenchus replay. This is a fixture and is not a live seat.",
    record: base("1", {
      model: {
        requested: "claude-fable-5-2",
        observed: "Fable 5.2",
        source: "transcribed: Kickoff PR 320 comment 6880031532",
      },
      effort: {
        requested: "xhigh",
        observed: "Extra",
        source: "transcribed: Kickoff PR 320 comment 6880031532",
      },
      route: { recommended_by: "PM", confirmed_by: null },
      input_sha: "0faf606",
      output_sha: "89b8067",
      commits: ["961d320", "b275a56", "9b3a90a", "d1f32c0", "d737ceb", "89b8067"],
      findings: pass1,
      verdict: "mergeable after fixes",
      not_verified: [
        "Safari or any WebKit, and a real phone: the 3.86 px margin at 375 is a Chrome measurement.",
        "The Vercel preview itself; a local next start of the same commit stood in.",
        "../Sportsbooks/CLAUDE.md, which is not on this machine.",
        "The first fixture row without the staleness banner.",
        "Studio's own checks beyond CI's green verify.",
        "The builder's local clearing.local/evidence, which is not in the PR.",
      ],
    }),
  },
  {
    pass: "1.5",
    firstLine:
      "Transcribed by hand from docs/design-overhaul-clearing-rebuttal-prompt.md on BeniCheni/kickoff main for the elenchus replay. This is a fixture and is not a live seat.",
    record: base("1.5", {
      model: {
        requested: null,
        observed: "Opus 5.5",
        source: "transcribed: kickoff docs/design-overhaul-clearing-rebuttal-prompt.md:3",
      },
      route: { recommended_by: "PM", confirmed_by: null },
      input_sha: "89b8067",
      output_sha: "89b8067",
      verdict: "rebuttal brief for Cursor on Grok 4.7 at Extra High",
    }),
  },
  {
    pass: "2",
    firstLine:
      "Transcribed by hand from Kickoff PR 320 comment 6882281451 for the elenchus replay. This is a fixture and is not a live seat.",
    record: base("2", {
      runtime: "Cursor",
      model: {
        requested: "grok-4.7-xhigh",
        observed: "Grok 4.7 Extra High",
        source: "transcribed: Kickoff PR 320 comment 6882281451",
      },
      effort: {
        requested: "xhigh",
        observed: "Extra High",
        source: "transcribed: Kickoff PR 320 comment 6882281451",
      },
      route: { recommended_by: "PM", confirmed_by: "Beni" },
      input_sha: "89b8067",
      output_sha: "09324fb",
      commits: ["0c7bdd8", "c4afa12", "97200f3", "09324fb"],
      findings: pass2,
      verdict: "mergeable on the findings",
      not_verified: [
        "The 7-of-9 flake rate. The object-count probe replaces it.",
        "Pass 1's four other hero mutations, and the delayed-font CLS scores.",
        "Safari, a phone, the 96-cell matrix, and the Next app in a browser.",
        "The Vercel preview of 09324fb.",
        "Studio, beyond the green verify at 89b8067.",
        "The Fergie Time design system and the Sportsbooks CLAUDE.md.",
      ],
    }),
  },
  {
    pass: "2.5",
    firstLine:
      "Transcribed by hand from Kickoff PR 320 comment 6882900669 for the elenchus replay. This is a fixture and is not a live seat. The brief that routed it is docs/design-overhaul-clearing-synthesis-prompt.md.",
    record: base("2.5", {
      model: {
        requested: "claude-fable-5-2",
        observed: "Fable 5.2",
        source: "transcribed: Kickoff PR 320 comment 6882900669",
      },
      effort: {
        requested: "xhigh",
        observed: "Extra",
        source: "transcribed: Kickoff PR 320 comment 6882900669",
      },
      route: { recommended_by: "PM", confirmed_by: null },
      input_sha: "09324fb",
      output_sha: "09324fb",
      findings: pass25,
      verdict: "corroborated and mergeable on the findings; escalated to Beni, not merged",
      not_verified: [
        "Safari or any WebKit and a real phone.",
        "The Vercel preview itself; a local next start of the same commit stood in.",
        "Studio beyond CI.",
        "Pass 1's Moments style comparison and three of its five hero mutations.",
        "The Fergie Time template was not read.",
      ],
    }),
  },
  {
    pass: "3",
    firstLine:
      "Transcribed by hand from docs/design-overhaul-clearing-release-prompt.md on BeniCheni/kickoff main for the elenchus replay. This is a fixture and is not a live seat.",
    record: base("3", {
      model: {
        requested: "claude-fable-5-2",
        observed: "Fable 5.2",
        source: "transcribed: kickoff docs/design-overhaul-clearing-release-prompt.md:3",
      },
      effort: {
        requested: "xhigh",
        observed: "Extra",
        source: "transcribed: kickoff docs/design-overhaul-clearing-release-prompt.md:3",
      },
      route: { recommended_by: "Pass 2.5", confirmed_by: "Beni" },
      input_sha: "09324fb",
      output_sha: "09324fb",
      verdict:
        "R1: D3 allows the public site to change before the cutover. R2: PR #316 merges first; it did, as v0.5.4. R3: the clearing is v0.5.5. R4: 961d320 stays in this PR, and so does c4afa12, which only corrects its comment. R5: the header at 360 and 375 stays as it is until the overhaul, so no CSS. R6: the README's three football pictures are recaptured from the v0.5.5 build. R7: v0.5.5 merges on Sat 14 Nov 2026.",
    }),
  },
  {
    pass: "exec",
    firstLine:
      "Transcribed by hand from Kickoff PR 320 comment 6884589607 for the elenchus replay. This is a fixture and is not a live seat. That comment calls itself Pass 3; schema v1.1 names this pass exec.",
    record: base("exec", {
      runtime: "Cursor",
      model: {
        requested: "grok-4.7-xhigh",
        observed: null,
        source: "not reported",
      },
      effort: { requested: "xhigh", observed: null, source: "not reported" },
      route: { recommended_by: "Pass 2.5", confirmed_by: "Beni" },
      input_sha: "09324fb",
      output_sha: "dcb914e",
      commits: ["217189c", "8ea93e2", "7b7da6b", "188b909", "dcb914e"],
      verdict: "on the branch; no merge, no auto-merge, no tag",
      not_verified: [
        "A separate suite run for the pictures commit and for the ideas commit.",
        "Root and web production builds again after those two commits.",
        "Studio's suite.",
        "The Cursor browser pane.",
      ],
    }),
  },
];

export function commentBody(entry: ReplayRecord): string {
  return `${entry.firstLine}\n\n\`\`\`json\n${JSON.stringify(entry.record, null, 2)}\n\`\`\`\n`;
}

/** The preparation fixture carries the same first brief on its own pull request. */
export const prepReplayRecord: ReplayRecord = {
  ...replayRecords[0]!,
  record: { ...replayRecords[0]!.record, pr: 3 },
};
