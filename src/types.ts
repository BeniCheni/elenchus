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

export type SeatRecord = {
  seat_record: 1;
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
    skipped: { path: string; reason: string }[];
  };
  not_verified?: string[];
  retries?: number;
  verdict: string;
};

export type PassConfig = { id: string; role: string; seat: string };

export type VendorConfig = {
  authors: string[];
  runtimes: string[];
  models: Record<string, string[]>;
  efforts: Record<string, string[]>;
};

export type Config = {
  passes: PassConfig[];
  vendors: Record<string, VendorConfig>;
  retry_cap: number;
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

export type GhCompare = {
  status: "ahead" | "behind" | "diverged" | "identical";
  total_commits?: number;
  commits?: GhCompareCommit[];
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
  valid: boolean;
  reason: string | null;
  record: SeatRecord | null;
};

export type RangeCommit = { sha: string; author: string };

export type LaterRejection = { commentUrl: string; reason: string };

export type Unreadable = { commentUrl: string; reason: string; attached: boolean };

export type PassOutcome =
  | { kind: "absent" }
  | {
      kind: "recorded";
      record: SeatRecord;
      commentUrl: string;
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
};

export type Orphan = {
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
