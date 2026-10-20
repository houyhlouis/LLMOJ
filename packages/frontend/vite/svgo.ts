import fs from "fs";
import path from "path";
import crypto from "crypto";

import type { Plugin } from "vite";
import { optimize, type Config } from "svgo";

/**
 * Imported SVG images, optimized by SVGO. A build emits each as a file whose URL is found from the page's public path
 * at runtime (see runtime-public-path.ts); the development server inlines it.
 */
export default function svgo(options: Config): Plugin {
  let assetsDir: string;
  let isProd: boolean;

  function getBuiltFilename(originalFileName: string, content: string) {
    const ext = path.extname(originalFileName);
    const name = path.basename(originalFileName, ext);
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
    return assetsDir + "/" + name + "." + hash + ext;
  }

  return {
    name: "llmoj:svgo",
    enforce: "pre",
    configResolved(config) {
      assetsDir = config.build.assetsDir;
      isProd = config.command === "build";
    },
    async load(id) {
      if (!id.toLowerCase().endsWith(".svg")) return null;
      const content = optimize(await fs.promises.readFile(id, "utf-8"), { ...options, path: id }).data;
      if (!isProd)
        return {
          code: `export default ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(content).toString("base64")}`)};`
        };
      const fileName = getBuiltFilename(id, content);
      this.emitFile({ type: "asset", fileName, source: content });
      return { code: `export default window.publicPath + ${JSON.stringify(fileName)};` };
    }
  };
}
