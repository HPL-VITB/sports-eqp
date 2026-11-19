// Bundles tools/preview/preview.ts with the stand-ins for React and Next.js (development check only).
import * as esbuild from "esbuild";
import path from "node:path";
import { existsSync } from "node:fs";
const withExt = (p) => [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`].find((c) => existsSync(c) && !c.endsWith("/")) ?? p;

const root = path.resolve(import.meta.dirname, "../..");
const stub = (f) => path.join(root, "tools/preview/stubs", f);
const alias = {
  react: stub("react.ts"), "react/jsx-runtime": stub("jsx-runtime.ts"), "react/jsx-dev-runtime": stub("jsx-runtime.ts"),
  next: stub("next.ts"), "next/link": stub("next-link.ts"), "next/navigation": stub("next-navigation.ts"),
  "next/headers": stub("next-headers.ts"), "server-only": stub("server-only.ts"),
};
const redirect = {
  name: "preview-redirects",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (alias[a.path]) return { path: alias[a.path] };
      if (a.path === "@/server/runtime" || (a.path.endsWith("/runtime") && a.resolveDir.includes(path.join("src", "server")))) return { path: stub("runtime.ts") };
      if (a.path.startsWith("@/")) return { path: withExt(path.join(root, "src", a.path.slice(2))) };
      if (a.path.endsWith(".css")) return { path: a.path, namespace: "empty" };
      if (a.path === "pg" || a.path === "nodemailer") return { path: a.path, namespace: "missing" };
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
    b.onLoad({ filter: /.*/, namespace: "missing" }, (a) => ({ contents: `throw new Error("${a.path} is not installed");`, loader: "js" }));
  },
};
await esbuild.build({
  entryPoints: [path.join(root, "tools/preview/preview.ts")],
  bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: path.join(root, "tools/preview/.out/preview.mjs"),
  jsx: "automatic", jsxImportSource: "react",
  resolveExtensions: [".tsx", ".ts", ".js", ".mjs"],
  external: ["jszip", "zod"],
  plugins: [redirect], logLevel: "warning",
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
console.log("built");
