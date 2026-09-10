import { describe, expect, it } from 'vitest';

import { createPrLoadScheduler } from './pr-load-scheduler';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleScheduler() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PR load scheduler', () => {
  it('coalesces active invalidations and waits for eligibility before reloading', async () => {
    const scheduler = createPrLoadScheduler<number>(1);
    const started: number[] = [];
    const first = deferred();
    scheduler.register(1, () => { started.push(1); return started.length === 1 ? first.promise : Promise.resolve(); });
    scheduler.updateEligibility([{ job: 1, eligible: true }]);
    scheduler.requeue(1);
    scheduler.requeue(1);
    scheduler.updateEligibility([{ job: 1, eligible: false }]);
    first.resolve();
    await settleScheduler();
    expect(started).toEqual([1]);
    scheduler.updateEligibility([{ job: 1, eligible: true }]);
    await settleScheduler();
    expect(started).toEqual([1, 1]);
    scheduler.requeue(1);
    await settleScheduler();
    expect(started).toEqual([1, 1, 1]);
  });

  it('does not let bottom-up eligibility consume the two-job window before top-first ordering', async () => {
    const scheduler = createPrLoadScheduler<number>(2);
    const started: number[] = [];
    const completions = new Map<number, ReturnType<typeof deferred>>();

    for (const job of [1, 2, 3, 4, 5]) {
      const completion = deferred();
      completions.set(job, completion);
      scheduler.register(job, () => {
        started.push(job);
        return completion.promise;
      });
    }

    scheduler.setOrder([1, 2, 3, 4, 5]);
    scheduler.updateEligibility([5, 4, 3, 2, 1].map((job) => ({ eligible: true, job })));

    expect(started).toEqual([1, 2]);

    completions.get(1)!.resolve();
    await settleScheduler();
    expect(started).toEqual([1, 2, 3]);

    completions.get(2)!.resolve();
    await settleScheduler();
    completions.get(3)!.resolve();
    await settleScheduler();
    completions.get(4)!.resolve();
    await settleScheduler();
    completions.get(5)!.resolve();
    await settleScheduler();

    scheduler.updateEligibility([{ eligible: true, job: 1 }]);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not transition an active job back to paused when its eligibility becomes false', async () => {
    const scheduler = createPrLoadScheduler<number>(1);
    const started: number[] = [];
    const completions = new Map<number, ReturnType<typeof deferred>>();

    for (const job of [1, 2, 3]) {
      const completion = deferred();
      completions.set(job, completion);
      scheduler.register(job, () => {
        started.push(job);
        return completion.promise;
      });
    }

    scheduler.setOrder([1, 2, 3]);
    scheduler.updateEligibility([{ eligible: true, job: 1 }, { eligible: true, job: 2 }, { eligible: true, job: 3 }]);
    scheduler.updateEligibility([{ eligible: false, job: 1 }, { eligible: false, job: 2 }]);

    expect(started).toEqual([1]);

    completions.get(1)!.resolve();
    await settleScheduler();
    expect(started).toEqual([1, 3]);
  });

  it('does not start an unregistered queued job or release a second active-job slot after settlement', async () => {
    const scheduler = createPrLoadScheduler<number>(1);
    const started: number[] = [];
    const completions = new Map<number, ReturnType<typeof deferred>>();

    for (const job of [1, 2, 3, 4]) {
      const completion = deferred();
      completions.set(job, completion);
      scheduler.register(job, () => {
        started.push(job);
        return completion.promise;
      });
    }

    scheduler.setOrder([1, 2, 3, 4]);
    scheduler.updateEligibility([{ eligible: true, job: 1 }, { eligible: true, job: 2 }, { eligible: true, job: 3 }, { eligible: true, job: 4 }]);
    scheduler.unregister(3);
    scheduler.unregister(1);

    expect(started).toEqual([1, 2]);

    completions.get(1)!.resolve();
    await settleScheduler();
    expect(started).toEqual([1, 2]);

    completions.get(2)!.resolve();
    await settleScheduler();
    expect(started).toEqual([1, 2, 4]);
  });

  it('uses the latest order instead of preserving the queued registration order', async () => {
    const scheduler = createPrLoadScheduler<number>(1);
    const started: number[] = [];
    const completions = new Map<number, ReturnType<typeof deferred>>();

    for (const job of [1, 2, 3]) {
      const completion = deferred();
      completions.set(job, completion);
      scheduler.register(job, () => {
        started.push(job);
        return completion.promise;
      });
    }

    scheduler.setOrder([1, 2, 3]);
    scheduler.updateEligibility([{ eligible: true, job: 1 }, { eligible: true, job: 2 }, { eligible: true, job: 3 }]);
    scheduler.setOrder([1, 3, 2]);
    completions.get(1)!.resolve();
    await settleScheduler();

    expect(started).toEqual([1, 3]);
  });

  it('releases the rejected job slot instead of leaving the next eligible job queued', async () => {
    const scheduler = createPrLoadScheduler<number>(1);
    const started: number[] = [];
    const first = deferred();
    const second = deferred();

    scheduler.register(1, () => {
      started.push(1);
      return first.promise;
    });
    scheduler.register(2, () => {
      started.push(2);
      return second.promise;
    });
    scheduler.setOrder([1, 2]);
    scheduler.updateEligibility([{ eligible: true, job: 1 }, { eligible: true, job: 2 }]);

    first.reject(new Error('request failed'));
    await settleScheduler();

    expect(started).toEqual([1, 2]);
  });

  it('does not transition a queued job into two active runs for duplicate eligibility updates', () => {
    const scheduler = createPrLoadScheduler<number>(2);
    const started: number[] = [];
    const completion = deferred();

    scheduler.register(1, () => {
      started.push(1);
      return completion.promise;
    });
    scheduler.setOrder([1]);
    scheduler.updateEligibility([{ eligible: true, job: 1 }, { eligible: true, job: 1 }]);

    expect(started).toEqual([1]);
  });

  it('does not preserve cleared job priority or let a cleared active job release a replacement slot', async () => {
    const scheduler = createPrLoadScheduler<number>(1);
    const started: number[] = [];
    const oldCompletion = deferred();
    const replacementCompletion = deferred();
    const nextCompletion = deferred();

    scheduler.register(1, () => {
      started.push(1);
      return oldCompletion.promise;
    });
    scheduler.setOrder([2, 1]);
    scheduler.updateEligibility([{ eligible: true, job: 1 }]);
    scheduler.clear();

    scheduler.register(1, () => {
      started.push(10);
      return replacementCompletion.promise;
    });
    scheduler.register(2, () => {
      started.push(2);
      return nextCompletion.promise;
    });
    scheduler.updateEligibility([{ eligible: true, job: 1 }, { eligible: true, job: 2 }]);

    expect(started).toEqual([1, 10]);

    oldCompletion.resolve();
    await settleScheduler();
    expect(started).toEqual([1, 10]);

    replacementCompletion.resolve();
    await settleScheduler();
    expect(started).toEqual([1, 10, 2]);
  });
});
