import { SandboxParameter, SandboxResult, SandboxStatus } from './interfaces';
import sandboxAddon from './nativeAddon';
import * as utils from './utils';

interface ProcessExit {
    status: 'exited' | 'signaled';
    code: number;
    userCpuTimeNanoseconds: string;
}

const activeSandboxes = new Set<SandboxProcess>();
function stopActiveSandboxes(): void {
    for (const sandbox of activeSandboxes) sandbox.stop();
}

export class SandboxProcess {
    private watchdog: NodeJS.Timeout;
    private failure: unknown;
    private cgroupState: 'active' | 'stopping' | 'removed' = 'active';
    private timedOut = false;
    private readonly waitPromise: Promise<SandboxResult>;

    public running = true;

    constructor(
        public readonly parameter: SandboxParameter,
        public readonly pid: number,
        private execution: unknown
    ) {
        this.waitPromise = this.waitForResult();
    }

    private startWatchdog(): void {
        if (this.parameter.time === -1) return;

        const interval = Math.min(this.parameter.time / 10, 50);
        let lastCheck = Date.now();
        let lastCpuTime = 0;
        let countedCpuTime = 0;
        this.watchdog = setInterval(() => {
            try {
                const now = Date.now();
                const cpuTime = Number(sandboxAddon.readSandboxStats(this.execution).cpuTimeNanoseconds);
                // Charge actual CPU use or 40% of the elapsed wall time, whichever is greater.
                countedCpuTime += Math.max(cpuTime - lastCpuTime, utils.milliToNano(now - lastCheck) * 0.4);
                lastCheck = now;
                lastCpuTime = cpuTime;
                if (countedCpuTime > utils.milliToNano(this.parameter.time)) {
                    this.timedOut = true;
                    this.stop();
                }
            } catch (error) {
                // Reap the stopped child before handing its workspace back to the launcher.
                this.failure ??= error;
                this.stop();
            }
        }, interval);
    }

    private clearWatchdog(): void {
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
    }

    private async waitForResult(): Promise<SandboxResult> {
        if (!activeSandboxes.size) process.once('exit', stopActiveSandboxes);
        activeSandboxes.add(this);
        try {
            const runResult = await new Promise<ProcessExit>((resolve, reject) => {
                this.startWatchdog();
                sandboxAddon.waitForProcess(this.execution, (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                });
            });
            if (this.failure) throw this.failure;
            return this.collectResult(runResult);
        } catch (error) {
            this.failure ??= error;
            this.tryKillCgroup();
            this.tryRemoveCgroup();
            throw this.failure;
        } finally {
            this.running = false;
            this.clearWatchdog();
            activeSandboxes.delete(this);
            if (!activeSandboxes.size) process.removeListener('exit', stopActiveSandboxes);
            this.execution = null;
        }
    }

    private collectResult(runResult: ProcessExit): SandboxResult {
        const stats = sandboxAddon.finalizeSandboxCgroup(this.execution);
        const time = this.parameter.resourceMode === 'arbiter'
            ? Number(runResult.userCpuTimeNanoseconds) : Number(stats.cpuTimeNanoseconds);
        const memory = Number(stats.memoryPeakBytes);
        let status = SandboxStatus.Unknown;
        if (this.timedOut || (this.parameter.time !== -1 && time > utils.milliToNano(this.parameter.time))) {
            status = SandboxStatus.TimeLimitExceeded;
        } else if (this.cgroupState === 'stopping') {
            status = SandboxStatus.Cancelled;
        } else if (
            Number(stats.oomKillCount) > 0 ||
            // SIGSEGV alone is not evidence of excessive memory use.
            (this.parameter.memory !== -1 && memory > this.parameter.memory)
        ) {
            status = SandboxStatus.MemoryLimitExceeded;
        } else if (runResult.status === 'signaled' || runResult.code !== 0) {
            status = SandboxStatus.RuntimeError;
        } else if (runResult.status === 'exited') {
            status = SandboxStatus.OK;
        }
        return { status, time, memory, code: runResult.code, termination: runResult.status };
    }

    private tryKillCgroup(): boolean {
        if (this.cgroupState !== 'active') return true;
        try {
            sandboxAddon.killSandbox(this.execution);
            this.cgroupState = 'stopping';
            return true;
        } catch (error) {
            this.failure ??= error;
            return false;
        }
    }

    private tryRemoveCgroup(): void {
        if (this.cgroupState === 'removed') return;
        try {
            // Kill descendants, wait for an empty cgroup and remove it without reading stats.
            sandboxAddon.removeSandboxCgroup(this.execution);
            this.cgroupState = 'removed';
        } catch {
            // Preserve the first failure. The native execution destructor also retries removal.
        }
    }

    stop(): void {
        if (!this.running) return;
        this.clearWatchdog();
        // A failed cgroup.kill gets another chance in Remove(). The registered waiter
        // still owns completion, even if both attempts fail and the child is still live.
        if (!this.tryKillCgroup()) this.tryRemoveCgroup();
    }

    waitForStop(): Promise<SandboxResult> {
        return this.waitPromise;
    }
}
