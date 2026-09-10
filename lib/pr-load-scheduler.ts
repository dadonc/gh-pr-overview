type JobState = 'registered' | 'queued' | 'active' | 'completed';

interface ScheduledJob<Job> {
  readonly job: Job;
  readonly run: () => Promise<void>;
  readonly registrationOrder: number;
  eligible: boolean;
  rerun: boolean;
  slotHeld: boolean;
  state: JobState;
}

export function createPrLoadScheduler<Job>(maximumActive: number) {
  const jobs = new Map<Job, ScheduledJob<Job>>();
  let activeCount = 0;
  let nextRegistrationOrder = 0;
  let order = new Map<Job, number>();

  function drain() {
    while (activeCount < maximumActive) {
      const next = [...jobs.values()]
        .filter((entry) => entry.state === 'queued')
        .sort((left, right) => (order.get(left.job) ?? Infinity) - (order.get(right.job) ?? Infinity)
          || left.registrationOrder - right.registrationOrder)[0];

      if (!next) return;

      next.state = 'active';
      next.slotHeld = true;
      activeCount += 1;

      try {
        const result = next.run();
        void result.then(
          () => complete(next),
          () => complete(next),
        );
      } catch {
        complete(next);
      }
    }
  }

  function complete(entry: ScheduledJob<Job>) {
    if (jobs.get(entry.job) !== entry || entry.state !== 'active') return;
    entry.state = entry.rerun ? (entry.eligible ? 'queued' : 'registered') : 'completed';
    entry.rerun = false;
    release(entry);
  }

  function release(entry: ScheduledJob<Job>) {
    if (!entry.slotHeld) return;
    entry.slotHeld = false;
    activeCount -= 1;
    drain();
  }

  return {
    register(job: Job, run: () => Promise<void>) {
      if (jobs.has(job)) return;
      jobs.set(job, { job, run, registrationOrder: nextRegistrationOrder++, eligible: false, rerun: false, slotHeld: false, state: 'registered' });
    },

    requeue(job: Job) {
      const entry = jobs.get(job);
      if (!entry) return;
      if (entry.state === 'active') entry.rerun = true;
      else entry.state = entry.eligible ? 'queued' : 'registered';
      drain();
    },

    unregister(job: Job) {
      const entry = jobs.get(job);
      if (!entry) return;
      jobs.delete(job);
      release(entry);
    },

    setOrder(nextOrder: readonly Job[]) {
      order = new Map();
      nextOrder.forEach((job, index) => {
        if (!order.has(job)) order.set(job, index);
      });
      drain();
    },

    updateEligibility(updates: readonly { job: Job; eligible: boolean }[]) {
      for (const { job, eligible } of updates) {
        const entry = jobs.get(job);
        if (!entry) continue;
        entry.eligible = eligible;
        if (entry.state === 'active' || entry.state === 'completed') continue;
        entry.state = eligible ? 'queued' : 'registered';
      }
      drain();
    },

    clear() {
      for (const entry of jobs.values()) entry.slotHeld = false;
      jobs.clear();
      activeCount = 0;
      nextRegistrationOrder = 0;
      order = new Map();
    },
  };
}
