// The self-test as the judge's account, started by self-test.mjs through the sandbox launcher: see selfTest.ts.
import { runSelfTest } from "./selfTest";

const only = process.argv[2] ? process.argv[2].split(",") : undefined;
runSelfTest(only).then(
  passed => process.exit(passed ? 0 : 1),
  error => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  }
);
