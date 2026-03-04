/** Generate a unique, sortable job ID using crypto.randomUUID(). */
export function generateJobId(): string {
  return crypto.randomUUID();
}
