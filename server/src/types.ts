export type FeedKind = "newRun" | "approved" | "rejected";

export interface RunSummary {
  id: string;
  runUrl: string | null;
  gameId: string | null;
  gameName: string | null;
  categoryName: string | null;
  mapName: string | null;
  runner: string;
  primarySeconds: number | null;
  timeDisplay: string | null;
  submitted: string | null;
  verifyDate: string | null;
  rejectionReason: string | null;
}

export interface RawRun {
  id: string;
  weblink?: unknown;
  game?: unknown;
  category?: unknown;
  level?: unknown;
  players?: unknown;
  times?: {
    primary_t?: unknown;
  } | null;
  submitted?: unknown;
  status?: {
    status?: unknown;
    reason?: unknown;
    "verify-date"?: unknown;
  } | null;
}

export interface RawGame {
  id: string;
  names?: {
    international?: unknown;
    japanese?: unknown;
  };
  abbreviation?: unknown;
}

export interface RawUser {
  id: string;
  names?: {
    international?: unknown;
    japanese?: unknown;
  };
}

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiPage<T> {
  data: T[];
  pagination?: {
    links?: Array<{
      rel?: string;
      uri?: string;
    }>;
  };
}
