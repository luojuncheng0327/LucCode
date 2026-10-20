/**
 * 并发限流器：限制同时在飞的子 agent 数（信号量），并对累计派发总数设 backstop。
 * @param {{ maxConcurrent: number, maxTotal: number }} opts
 */
export function createLimiter({ maxConcurrent, maxTotal }) {
  let active = 0;
  let total = 0;
  /** @type {Array<{ thunk: () => Promise<any>, resolve: Function, reject: Function }>} */
  const queue = [];

  function pump() {
    if (active >= maxConcurrent) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    Promise.resolve()
      .then(job.thunk)
      .then(job.resolve, job.reject)
      .finally(() => { active--; pump(); });
  }

  return {
    /**
     * @template T
     * @param {() => Promise<T>} thunk
     * @returns {Promise<T>}
     */
    run(thunk) {
      total++;
      if (total > maxTotal) {
        return Promise.reject(new Error(`workflow 超出 agent 总数上限 ${maxTotal}（防失控 backstop）`));
      }
      return new Promise((resolve, reject) => {
        queue.push({ thunk, resolve, reject });
        pump();
      });
    },
    get activeCount() { return active; },
    get totalSpawned() { return total; },
  };
}
