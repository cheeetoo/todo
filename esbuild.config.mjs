// Builds main.js and installs the plugin into the vault.
import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// BOARD_VAULT=/path/to/vault installs somewhere else (e.g. a test vault).
const VAULT = process.env.BOARD_VAULT ?? join(process.env.HOME, "Documents/new");
const VAULT_PLUGIN = join(VAULT, ".obsidian/plugins/todo-board");
const watch = process.argv.includes("--watch");

const install = {
  name: "install",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      // obsidian-kanban's stylesheet, then ours.
      writeFileSync("styles.css", readFileSync("src/kanban.css", "utf8") + "\n\n" + readFileSync("src/board.css", "utf8"));
      mkdirSync(VAULT_PLUGIN, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(VAULT_PLUGIN, f));
      console.log(`installed → ${VAULT_PLUGIN}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  outfile: "main.js",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  plugins: [install],
});

if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
