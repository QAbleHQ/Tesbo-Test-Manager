export const REVIEW_BOARD_QUEUE = "review-board-analysis";
export const REVIEW_BOARD_JOB = "analyse-project";

/** Beyond this the run FAILS with a clear message rather than silently analysing a subset. */
export const MAX_TESTCASES_PER_RUN = 5000;
/** Findings kept per run, highest similarity first; the run records `truncated` when this bites. */
export const MAX_PAIRS_PER_RUN = 2000;

/** A run silent for this long is dead; the next start/status read expires it so it cannot block the project. */
export const RUN_LEASE_MINUTES = 10;
/** A *running* run silent this long may be re-claimed by a redelivered (stalled) BullMQ job. */
export const RUN_RECLAIM_MINUTES = 2;

/**
 * Score at or above which two non-identical cases are reported as Similar. The score is half wording similarity and
 * half the share of identical steps (see blendedScore), which lands lower than wording alone did, so the cut-off was
 * lowered from 0.70 to keep genuine near-duplicates listed (measured on the sandbox data: every earlier finding kept,
 * while valid-vs-invalid look-alikes at 56-58% stay out).
 */
export const SIMILAR_THRESHOLD = 0.6;
