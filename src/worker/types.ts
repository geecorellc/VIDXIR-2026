/**
 * Worker handler contract.
 *
 * Kept in its own module rather than in `worker/index.ts` because that file
 * starts the workers as an import side effect. A handler importing its own type
 * from there would boot a second set of queue consumers inside a test — or worse,
 * inside the web process.
 */

/**
 * A job handler.
 *
 * Receives the `jobs` row id and the payload, and returns a serialisable result
 * stored on the row. Throwing reports failure; the harness decides whether to
 * retry from the error's `retryable` flag.
 */
export type JobHandler = (input: {
  jobId: string;
  payload: Record<string, unknown>;
  traceId: string;
  attempt: number;
}) => Promise<Record<string, unknown> | void>;
