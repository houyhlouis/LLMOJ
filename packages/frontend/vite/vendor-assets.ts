import fs from "fs";
import path from "path";

import type { Plugin } from "vite";

/**
 * Libraries the pages load only when they need them (the code editor, maths, highlighting, emoji images), served from
 * the site's own build output instead of a CDN: `vendor/<name>/<version>/...`, next to the bundles. Each copy comes
 * with its package's licence files.
 */
export interface VendorPackage {
  /** The npm package */
  package: string;
  /** The directory under vendor/, and the package's version after it */
  name: string;
  /** What to copy: a package directory, to a directory under vendor/<name>/<version> */
  copy: Record<string, string>;
  /** Files to leave out, by their path in the package */
  exclude?: RegExp;
}

// The frontend's own dependencies (some packages export no package.json to resolve)
function packageDirectory(name: string) {
  return fs.realpathSync(path.join(import.meta.dirname, "..", "node_modules", name));
}

export function vendorVersion(name: string): string {
  return JSON.parse(fs.readFileSync(path.join(packageDirectory(name), "package.json"), "utf-8")).version;
}

/** Where a package's copy is, relative to the site's public path. */
export function vendorPath(vendor: VendorPackage, directory = ""): string {
  return path.posix.join("vendor", vendor.name, vendorVersion(vendor.package), directory);
}

/**
 * The libraries' stylesheets, linked by the page before the application's own (at `// __add_vendor_link_tags__` in
 * index.html), as when it loaded them from a CDN: the cascade depends on that order.
 */
export function vendorStylesheets(stylesheets: string[]): Plugin {
  return {
    name: "llmoj:vendor-stylesheets",
    transformIndexHtml(html) {
      if (html.split("// __add_vendor_link_tags__").length !== 2)
        throw new Error("index.html needs exactly one // __add_vendor_link_tags__");
      return html.replace("// __add_vendor_link_tags__", () =>
        stylesheets.map(file => `addLinkTag("stylesheet", window.publicPath + ${JSON.stringify(file)});`).join("\n")
      );
    }
  };
}

export default function vendorAssets(packages: VendorPackage[]): Plugin {
  let outDir: string;
  // URL path under vendor/ -> file in the package, for the development server
  const lookup = (url: string) => {
    for (const vendor of packages) {
      const prefix = "/" + vendorPath(vendor) + "/";
      if (!url.startsWith(prefix)) continue;
      const rest = url.slice(prefix.length);
      for (const [from, to] of Object.entries(vendor.copy)) {
        const target = to ? to + "/" : "";
        if (!rest.startsWith(target)) continue;
        const file = path.join(packageDirectory(vendor.package), from, rest.slice(target.length));
        if (!file.startsWith(packageDirectory(vendor.package) + path.sep)) return null;
        return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
      }
    }
    return null;
  };

  return {
    name: "llmoj:vendor-assets",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url && lookup(decodeURIComponent(req.url.split("?")[0]));
        if (!file) return next();
        const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
        res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      for (const vendor of packages) {
        const source = packageDirectory(vendor.package);
        const destination = path.join(outDir, vendorPath(vendor));
        for (const [from, to] of Object.entries(vendor.copy))
          fs.cpSync(path.join(source, from), path.join(destination, to), {
            recursive: true,
            filter: file => !vendor.exclude?.test(path.relative(source, file).split(path.sep).join("/"))
          });
        for (const entry of fs.readdirSync(source))
          if (/^(?:license|licence|copying|notice)(?:[.-]|$)/i.test(entry))
            fs.copyFileSync(path.join(source, entry), path.join(destination, entry));
      }
    }
  };
}
