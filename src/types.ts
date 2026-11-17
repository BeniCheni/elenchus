export type Observed = {
  requested: string | null;
  observed: string | null;
  source?: string;
};

export type Finding = {
  id: string;
  severity: string;
  status: "open" | "fixed" | "contested" | "killed";
  disposition?: "accept" | "contest" | "accept-observation-contest-severity";
  evidence?: string;
  path?: string;
  start_line?: number;
  end_line?: number;
  category?: string;
};

export type NextRoute = {
  runtime: string;
  model: string;
  effort: string;
  recommended_by: string | null;
  confirmed_by: string | null;
};

export type SeatRecord = {
  seat_record: 1;
  schema_version?: "1.2";
  reread?: true;
  next_route?: NextRoute;
  pr: number;
  pass: string;
  runtime: string;
  runtime_version?: string;
  session?: { id: string; log: string };
  model: Observed;
  effort: Observed;
  mode?: Observed;
  route: {
    recommended_by: string | null;
    confirmed_by: string | null;
    by_hand?: boolean;
  };
  posted_by?: string;
  input_sha: string;
  output_sha: string;
  commits: string[];
  findings: Finding[];
  coverage?: {
    total: number;
    reviewed: number;
    reviewed_paths?: string[];
    skipped: { path: string; reason: string }[];
  };
  not_verified?: string[];
  retries?: number;
  verdict: string;
};

/** What `prep` creates for a pass. Absent on a configuration status and check can still read. */
export type SeatKind = "writing" | "read-only" | "none";

export type PassConfig = {
  id: string;
  role: string;
  seat: string;
  seat_kind?: SeatKind;
  /** When true, check compares the record's coverage with the manifest at input_sha. */
  coverage?: boolean;
};

export type InstallConfig = { dir: string; lockfile: string };

export type HandoffConfig = {
  version_file: string;
  changelog: string;
  /** Prefix of the changelog heading, with `{version}` filled from the version file. */
  section_heading: string;
  /** Annotated tag name, with `{version}` filled. */
  tag: string;
  /** Tag message, with `{version}` and `{subject}` filled. The subject is the changelog section's first sentence. */
  tag_message: string;
  /** Squash subject, with `{subject}` filled. */
  merge_message: string;
  /** Shell command, with `{pr}` and `{merge_message}` filled. */
  merge_command: string;
  green: string[];
};

export type VendorConfig = {
  authors: string[];
  runtimes: string[];
  models: Record<string, string[]>;
  efforts: Record<string, string[]>;
  /** False for a vendor that must not hold a read-only seat (Cursor, S7). */
  read_only_seat?: boolean;
  /** Absolute path of the vendor binary, when it is not the command on PATH (Codex, S3). */
  binary?: string;
};

export type Config = {
  passes: PassConfig[];
  vendors: Record<string, VendorConfig>;
  retry_cap: number;
  /** GitHub logins whose comments may carry seat records. */
  record_authors: string[];
  /** Neutral command prefixes prep renders into each vendor's deny profile. */
  forbidden?: string[];
  installs?: InstallConfig[];
  handoff?: HandoffConfig;
};

export type GhComment = {
  id: number;
  html_url: string;
  body: string;
  created_at: string;
  user?: { login?: string };
};

export type GhCommitAuthor = { name?: string | null; email?: string | null };

export type GhCompareCommit = {
  sha: string;
  commit?: { author?: GhCommitAuthor | null };
};

export type GhCompareFile = {
  filename?: string;
  previous_filename?: string;
  status?: string;
};

export type GhCompare = {
  status: "ahead" | "behind" | "diverged" | "identical";
  total_commits?: number;
  commits?: GhCompareCommit[];
  files?: GhCompareFile[];
};

export type GhPull = {
  number: number;
  html_url?: string;
  head: { sha: string; ref?: string };
  base: { sha: string; ref: string };
};

export type GhContent = { content?: string; encoding?: string };

export type Attempt = {
  pass: string | null;
  commentUrl: string;
  createdAt: string;
  id: number;
  authorLogin: string;
  valid: boolean;
  reason: string | null;
  record: SeatRecord | null;
};

export type RangeCommit = { sha: string; author: string };

export type LaterRejection = { commentUrl: string; reason: string };

export type Unreadable = { commentUrl: string; reason: string; attached: boolean };

export type RecordedPosting = {
  record: SeatRecord;
  commentUrl: string;
  createdAt: string;
  id: number;
};

export type PassOutcome =
  | { kind: "absent" }
  | {
      kind: "recorded";
      record: SeatRecord;
      commentUrl: string;
      authorLogin: string;
      history: RecordedPosting[];
      priorFailures: number;
      laterRejections: LaterRejection[];
    }
  | {
      kind: "rejected";
      reason: string;
      commentUrl: string;
      failures: number;
    };

export type PassState = {
  id: string;
  role: string;
  seat: string;
  outcome: PassOutcome;
  outputIsAncestor: boolean | null;
  range: { commits: RangeCommit[]; error: string | null } | null;
  resolveError: string | null;
  /** Set when the pass requires coverage and the record reported some. */
  coverageManifest?: { paths: string[]; error: string | null };
};

export type Orphan = {
  rule: "schema" | "pass";
  pass: string | null;
  commentUrl: string;
  reason: string;
};

export type ReviewState = {
  repo: string;
  pr: number;
  head: string;
  baseRef: string;
  baseSha: string;
  config: Config;
  passes: PassState[];
  orphans: Orphan[];
  notices: Notice[];
  unreadable: Unreadable[];
  inProgressPass: string | null;
};

export type StatusPass = {
  pass: string;
  role: string;
  seat: string;
  state: "recorded" | "not_recorded" | "in_progress" | "rejected";
  output_sha: string | null;
  comment_url: string | null;
  reason: string | null;
};

export type StatusView = {
  repo: string;
  pr: number;
  head: string;
  base: { ref: string; sha: string };
  passes: StatusPass[];
  next: {
    step: string;
    seat: string | null;
    role: string | null;
    blocked: string;
    options: string[] | null;
  };
  /** Set once every pass is recorded: whether the head equals the last output_sha. */
  headNote: string | null;
  unreadable: Unreadable[];
};

export type Notice = {
  rule: string;
  commentUrl: string;
  message: string;
};

export type CheckItem = {
  severity: "fail" | "unverified" | "notice";
  rule: string;
  pass?: string;
  finding?: string;
  comment?: string;
  message: string;
};
