import os from "os";

export interface ExecutionReservation {
  /** The most memory (MiB) this work's sandboxes use at the same time. */
  memory?: number;
  /** AI validation work, which may use only `aiSlots` slots so that judging always has capacity. */
  ai?: boolean;
}

// Reserved by default for work that declares no memory (the old fixed per-slot estimate).
export const DEFAULT_RESERVATION = 256;

// Compilers are capped at 2 GiB but usually need far less; reserving the cap would serialize compilation.
export const COMPILE_RESERVATION = 512;

// Kept for the judge itself, sandbox kernel memory and the other services of the host.
const HOST_RESERVE_FRACTION = 0.15;
const HOST_RESERVE = 512;

/** The memory (MiB) sandboxes may reserve together when the configuration doesn't set `memoryBudget`. */
export function defaultMemoryBudget(totalMemory = os.totalmem()): number {
  return Math.max(
    DEFAULT_RESERVATION,
    Math.floor((totalMemory / 1048576) * (1 - HOST_RESERVE_FRACTION)) - HOST_RESERVE
  );
}

/** One execution slot is kept for judging when there are several. */
export function defaultAiSlots(slots: number): number {
  return Math.max(1, slots - 1);
}

interface Waiting {
  memory: number;
  ai: boolean;
  start: () => void;
}

/**
 * Admits work to the execution slots when a slot and the memory the work declares are free, in order of arrival,
 * so that the memory limits of everything running never add up to more than the budget. Work that declares more
 * than the whole budget runs alone. AI work beyond its slot share waits without holding up judging behind it.
 */
export class ExecutionScheduler {
  readonly memoryBudget: number;

  readonly aiSlots: number;

  private freeSlots: number;

  private freeMemory: number;

  private runningAi = 0;

  private readonly waiting: Waiting[] = [];

  constructor(readonly slots: number, memoryBudget?: number, aiSlots?: number) {
    this.memoryBudget = memoryBudget ?? defaultMemoryBudget();
    this.aiSlots = Math.min(slots, aiSlots ?? defaultAiSlots(slots));
    this.freeSlots = slots;
    this.freeMemory = this.memoryBudget;
  }

  /** Resolves with the function that releases the slot once it is admitted. */
  async acquire({ memory = DEFAULT_RESERVATION, ai = false }: ExecutionReservation = {}): Promise<() => void> {
    const reserved = Math.min(Math.max(0, Math.ceil(Number(memory) || 0)), this.memoryBudget);
    await new Promise<void>(start => {
      this.waiting.push({ memory: reserved, ai, start });
      this.admit();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.freeSlots++;
      this.freeMemory += reserved;
      if (ai) this.runningAi--;
      this.admit();
    };
  }

  private admit() {
    let i = 0;
    while (i < this.waiting.length) {
      const next = this.waiting[i];
      if (next.ai && this.runningAi >= this.aiSlots) {
        i++;
      } else {
        // Strictly in order otherwise, so that a large reservation isn't overtaken forever
        if (this.freeSlots === 0 || this.freeMemory < next.memory) return;
        this.waiting.splice(i, 1);
        this.freeSlots--;
        this.freeMemory -= next.memory;
        if (next.ai) this.runningAi++;
        next.start();
      }
    }
  }

  get status() {
    return {
      slots: this.slots,
      freeSlots: this.freeSlots,
      memoryBudget: this.memoryBudget,
      freeMemory: this.freeMemory,
      aiSlots: this.aiSlots,
      runningAi: this.runningAi,
      waiting: this.waiting.length
    };
  }
}
