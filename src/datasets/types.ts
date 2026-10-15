import type { CacheMeta } from "../cache.js";
import type { Config } from "../config.js";
import type { GeneratedFile } from "../generated.js";

export interface BuildOutput {
  files: GeneratedFile[];
  /** Human-readable findings (counts, warnings) printed by `plan` and `apply`. */
  notes: string[];
}

export interface ExtractContext {
  after(id: string): Promise<void>;
}

/**
 * A dataset declares where its raw facts come from (`extract`, needs the game install) and how outputs are derived
 * from them (`build`, a pure function of the cache). Outputs are written only by `apply`.
 */
export interface Dataset {
  id: string;
  /** Datasets extract at the same time; `ctx.after(id)` waits for another dataset's extraction when this one needs its files. */
  extract(config: Config, ctx: ExtractContext): void | Promise<void>;
  build(rawDir: string, meta: CacheMeta): Promise<BuildOutput>;
}
