// apps/conductor/src/evaluators/index.ts
// AGT.SCOPER.SEAM_CLAUSE.3 — Conductor AC evaluator dispatch map.
//
// The cold-read evaluator picks a strategy based on ac.verification:
//   'deployed-pixel' → evaluateDeployedPixelAC (network + DOM query)
//
// Other verification types (auto, physical_qa, kosta_review) are handled by
// their own long-standing paths (curl/SQL exec, human review) and are NOT
// re-implemented here — this dispatch map is scoped to verification types
// whose cold-read execution is Conductor-owned end-to-end.

import type { AcceptanceCriterion } from "../../../../scoper/src/decomposition.js";
import { evaluateDeployedPixelAC, type DeployedPixelResult } from "./deployed-pixel.js";

export type EvaluatorFn = (ac: AcceptanceCriterion) => Promise<DeployedPixelResult>;

export const evaluators: Record<string, EvaluatorFn> = {
  "deployed-pixel": evaluateDeployedPixelAC,
};

export { evaluateDeployedPixelAC };
