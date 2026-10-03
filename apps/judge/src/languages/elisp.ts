import { interpreted } from "./interpreted";

const executable = "/usr/bin/emacs";
const sourceConfig = interpreted("elisp", executable, "el", ["--quick", "--batch", "--script"]);

export const languageConfig: typeof sourceConfig = {
  ...sourceConfig,
  run(parameters) {
    return {
      ...sourceConfig.run(parameters),
      // Initialize interpreter shared-library pages before starting the
      // contestant's own resource accounting in a custom rootfs.
      // This fixed command cannot load the submission or consume its stdin.
      runtimeInitialization: {
        executable,
        parameters: ["--quick", "--batch", "--eval", "(kill-emacs 0)"],
        time: 10000,
        memory: 512 * 1024 * 1024,
        stackSize: 8 * 1024 * 1024,
        process: 20
      }
    };
  }
};
