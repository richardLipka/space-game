import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { runJob, type Job, type JobResult } from "./jobs";

/** Default thread count: all cores but two, at least one. */
export const defaultThreads = () => Math.max(1, availableParallelism() - 2);

/**
 * Runs jobs on `threads` worker threads (in this thread when threads ≤ 1). Results come back in job
 * order, so a run is reproducible whatever the thread count.
 */
export async function runJobs(
  jobs: readonly Job[],
  threads = defaultThreads(),
  onProgress?: (done: number, total: number) => void,
): Promise<JobResult[]> {
  const out: JobResult[] = new Array(jobs.length);
  if (threads <= 1 || jobs.length <= 1) {
    jobs.forEach((j, i) => {
      out[i] = runJob(j);
      onProgress?.(i + 1, jobs.length);
    });
    return out;
  }
  let next = 0;
  let done = 0;
  const n = Math.min(threads, jobs.length);
  const url = new URL("./worker-boot.mjs", import.meta.url);
  await Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(url);
          const feed = () => {
            if (next >= jobs.length) {
              void w.terminate().then(() => resolve());
              return;
            }
            const id = next++;
            w.postMessage({ id, job: jobs[id] });
          };
          w.on("message", (m: { id: number; result?: JobResult; error?: string }) => {
            if (m.error) {
              void w.terminate();
              reject(new Error(m.error));
              return;
            }
            out[m.id] = m.result!;
            onProgress?.(++done, jobs.length);
            feed();
          });
          w.on("error", reject);
          feed();
        }),
    ),
  );
  return out;
}
