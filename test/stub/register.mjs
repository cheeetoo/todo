// Point `import "obsidian"` at the headless stub, and let src/ import siblings without ".ts".
import { registerHooks } from "node:module";

const stub = new URL("./obsidian.ts", import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "obsidian") return { url: stub, shortCircuit: true };
    if (spec.startsWith(".") && !/\.[a-z]+$/.test(spec) && ctx.parentURL?.includes("/src/")) return next(spec + ".ts", ctx);
    return next(spec, ctx);
  },
});
