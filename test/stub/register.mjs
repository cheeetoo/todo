// Point `import "obsidian"` at the headless stub.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "obsidian") return { url: new URL("./obsidian.ts", ${JSON.stringify(import.meta.url)}).href, shortCircuit: true };
  if (spec.startsWith("./") && !/\\.[a-z]+$/.test(spec) && ctx.parentURL?.includes("/src/")) return next(spec + ".ts", ctx);
  return next(spec, ctx);
}`));
