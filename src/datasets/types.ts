import type { CacheMeta } from "../cache.js";
import type { Config } from "../config.js";
import type { GeneratedFile } from "../generated.js";

export interface BuildOutput {
  files: GeneratedFile[];
  /** Human-readable findings (counts, warnings) printed by `plan` and `apply`. */
  notes: string[];
}

/**
 * A dataset declares where its raw facts come from (`extract`, needs the game install) and how outputs are derived
 * from them (`build`, a pure function of the cache). Outputs are written only by `apply`.
 */
export interface Dataset {
  id: string;
  extract(config: Config): void;
  build(rawDir: string, meta: CacheMeta): Promise<BuildOutput>;
}
