// One central serial queue (REVIEW.md plan §4). Every event and popup command
// runs as a task, one at a time, in the order it was queued.
//
// A task that throws rejects only its own promise; the queue always continues.
// A task must never await a task queued behind it (that would deadlock).

export function createSerialQueue() {
    let tail = Promise.resolve();

    return {
        enqueue(task) {
            const run = tail.then(() => task());
            tail = run.then(
                () => undefined,
                () => undefined
            );
            return run;
        }
    };
}
