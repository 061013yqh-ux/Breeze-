import {build} from "esbuild";
import {readFile} from "node:fs/promises";

const mime = {
  "index.html": "text/html; charset=utf-8",
  "gallery.css": "text/css; charset=utf-8",
  "gallery.js": "text/javascript; charset=utf-8",
  "scene.js": "text/javascript; charset=utf-8",
  "atmosphere.js": "text/javascript; charset=utf-8",
  "lyrics.js": "text/javascript; charset=utf-8",
  "corridor-lyrics.js": "text/javascript; charset=utf-8"
};
const staticFiles = {};
for (const [file, type] of Object.entries(mime)) {
  staticFiles[file === "index.html" ? "/" : "/" + file] = [type, await readFile("web/" + file, "utf8")];
}
await build({
  entryPoints: ["worker/index.js"], outfile: "dist/server/index.js",
  bundle: true, format: "esm", target: "es2022", legalComments: "inline",
  plugins: [{
    name: "site-assets",
    setup(build) {
      build.onResolve({filter: /^site-assets$/}, () => ({path: "site-assets", namespace: "workspace"}));
      build.onLoad({filter: /.*/, namespace: "workspace"}, () => ({
        contents: "export const staticFiles = " + JSON.stringify(staticFiles),
        loader: "js"
      }));
    }
  }]
});
