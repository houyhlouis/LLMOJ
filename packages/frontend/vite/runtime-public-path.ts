import type { Plugin } from "vite";

/**
 * The page decides at runtime where the build is served from (`window.publicPath`, which deployments set by replacing
 * `__public_path__`), so the stylesheets, module preloads and entry scripts Vite writes into index.html are added by
 * the page's own loader instead: at `// __add_link_tags__` and `// __add_script_tags__`. Code finds its other files
 * through `experimental.renderBuiltUrl` in vite.config.ts.
 */
export default function runtimePublicPath(): Plugin {
  return {
    name: "llmoj:runtime-public-path",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const links: string[] = [];
        const scripts: string[] = [];
        // Vite's own tags have paths relative to the page ("./assets/..."), as `base` is "./"
        html = html.replace(/<link\b([^>]*)>/g, (tag, attributes: string) => {
          const rel = /\brel="(stylesheet|modulepreload)"/.exec(attributes)?.[1];
          const href = /\bhref="\.\/([^"]+)"/.exec(attributes)?.[1];
          if (!rel || !href) return tag;
          links.push(`addLinkTag(${JSON.stringify(rel)}, window.publicPath + ${JSON.stringify(href)});`);
          return "";
        });
        html = html.replace(/<script\b([^>]*)><\/script>/g, (tag, attributes: string) => {
          const src = /\bsrc="\.\/([^"]+)"/.exec(attributes)?.[1];
          if (!/\btype="module"/.test(attributes) || !src) return tag;
          scripts.push(`addModuleScript(window.publicPath + ${JSON.stringify(src)});`);
          return "";
        });
        if (!scripts.length) throw new Error("index.html has no entry script for the page's loader to add");
        for (const placeholder of ["// __add_link_tags__", "// __add_script_tags__"])
          if (html.split(placeholder).length !== 2) throw new Error(`index.html needs exactly one ${placeholder}`);
        return html
          .replace("// __add_link_tags__", () => links.join("\n"))
          .replace("// __add_script_tags__", () => scripts.join("\n"));
      }
    }
  };
}
