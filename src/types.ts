export type ParserKind = "listings-json" | "speedyapply" | "jobright";

export interface Source {
  /** Stable key used in KV state. Never change this once deployed. */
  id: string;
  /** Human label used in notifications. */
  label: string;
  owner: string;
  repo: string;
  /** Branch the data bot commits to. */
  branch: string;
  /** Files within the repo that carry job data. Everything else in a commit is ignored. */
  paths: string[];
  parser: ParserKind;
  /**
   * True when the watched files only ever contain internships, so a title that
   * omits the word "intern" should still be treated as one.
   */
  assumeInternship?: boolean;
}

/**
 * One line of a diff hunk, in file order.
 *
 * Context lines are carried alongside added ones because a markdown row's
 * company can live on the row above it, which is frequently unchanged and so
 * appears only as context. Only `added` lines are ever emitted as jobs.
 */
export interface DiffLine {
  text: string;
  added: boolean;
}

/** Lines of a single contiguous hunk. Separate hunks are not adjacent in the file. */
export type Hunk = DiffLine[];

export interface Job {
  sourceId: string;
  sourceLabel: string;
  company: string;
  title: string;
  url: string;
  locations: string[];
  /** Raw sponsorship string from the structured feeds, when present. */
  sponsorship?: string;
  /** e.g. "Summer 2027" — may be absent. */
  term?: string;
  /** Epoch seconds, when the feed provides it. */
  datePosted?: number;
  salary?: string;
  workModel?: string;
}

export interface RejectedJob {
  job: Job;
  reason: string;
}

export interface PipelineResult {
  matched: Job[];
  rejected: RejectedJob[];
  /** Jobs that passed filtering but were already seen. */
  duplicates: number;
}
