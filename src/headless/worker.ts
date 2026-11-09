import { parentPort } from "node:worker_threads";
import { runJob, type Job } from "./jobs";

/** Balance worker: runs jobs sent by the pool and posts the results back. */
parentPort!.on("message", (msg: { id: number; job: Job }) => {
  try {
    parentPort!.postMessage({ id: msg.id, result: runJob(msg.job) });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: String((e as Error)?.stack ?? e) });
  }
});
