/** Generate a unique job ID using crypto.randomUUID(). */
export function generateJobId(): string {
  return crypto.randomUUID();
}
