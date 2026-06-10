import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const EnvSchema = z.object({
  NOUS_KEY: z.string().min(1, 'NOUS_KEY is required'),
  ANTHROPIC_KEY: z.string().min(1, 'ANTHROPIC_KEY is required'),
  GITHUB_TOKEN: z.string().min(1, 'GITHUB_TOKEN is required'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres URL').optional(),
  PORT: z.coerce.number().int().positive().default(8792),
  MACGRUBER_INTAKE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`env validation failed:\n${issues}`);
  }
  return parsed.data;
}
