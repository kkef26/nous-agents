import { z } from 'zod';

export const FailureClassEnum = z.enum([
  'compile_error',
  'test_failure',
  'lint_error',
  'merge_conflict',
  'missing_dependency',
  'runtime_error',
  'integration_error',
  'unknown',
]);
export type FailureClass = z.infer<typeof FailureClassEnum>;

export const IntakePayloadSchema = z.object({
  error_message: z.string().min(1, 'error_message is required'),
  step_attempted: z.string().min(1, 'step_attempted is required'),
  repo: z.string().min(1, 'repo is required'),
  branch: z.string().min(1, 'branch is required'),
  sha: z.string().min(7, 'sha must be a git commit sha'),
  clause_id: z.string().min(1, 'clause_id is required'),
  prior_attempts: z.number().int().min(0, 'prior_attempts must be a non-negative integer'),
  failure_class: FailureClassEnum.optional(),
  dispatch_event_id: z.string().uuid().optional(),
  agent_id: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  stack_trace: z.string().optional(),
  reported_by: z.enum(['conductor', 'scoper']).optional(),
});

export type IntakePayload = z.infer<typeof IntakePayloadSchema>;
