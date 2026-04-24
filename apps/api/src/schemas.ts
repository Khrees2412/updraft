import { z } from 'zod';

export const createDeploymentSchema = z.object({
  git_url: z.string().url('git_url must be a valid URL').optional(),
}).refine(
  (d) => d.git_url !== undefined,
  { message: 'git_url is required for JSON requests; use multipart/form-data for uploads' },
);

export type CreateDeploymentBody = z.infer<typeof createDeploymentSchema>;
