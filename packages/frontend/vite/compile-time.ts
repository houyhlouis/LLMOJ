import path from "path";

import { bundleRequire } from "bundle-require";
import type { Plugin } from "vite";

const CALL = /import\.meta\.compileTime\(\s*(["'])([^"']+)\1\s*\)/g;

interface CompileTimeResult {
  /** A value to put in place of the call, as JSON */
  data?: unknown;
  /** Code to use as the whole module, when the module is only the call */
  code?: string;
}

/**
 * `import.meta.compileTime("./file")` runs ./file's default export when the frontend is built (or served), and puts
 * what it returns into the code. The locale messages (whole modules) and the UI font selectors (data) are made this way.
 */
export default function compileTime(): Plugin {
  return {
    name: "llmoj:compile-time",
    enforce: "pre",
    async transform(code, id) {
      if (!code.includes("import.meta.compileTime(")) return null;
      const calls = [...code.matchAll(CALL)];
      if (!calls.length) return null;
      const results: CompileTimeResult[] = [];
      for (const [, , file] of calls) {
        const filepath = path.resolve(path.dirname(id), file);
        const { mod, dependencies } = await bundleRequire({ filepath });
        for (const dependency of [filepath, ...dependencies]) this.addWatchFile(path.resolve(dependency));
        const run = mod.default ?? mod;
        results.push(await (typeof run === "function" ? run() : run));
      }
      if (calls.length === 1 && !code.replace(CALL, "").replace(/[\s;]/g, "") && typeof results[0].code === "string")
        return { code: results[0].code, map: null };
      let index = 0;
      return { code: code.replace(CALL, () => JSON.stringify(results[index++].data)), map: null };
    }
  };
}
