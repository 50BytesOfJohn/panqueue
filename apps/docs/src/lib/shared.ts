export const appName = "panqueue";
export const docsRoute = "/docs";
export const docsImageRoute = "/og/docs";
export const docsContentRoute = "/llms.mdx/docs";

export const siteOrigin = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : undefined;

export function absoluteUrl(path: string) {
  if (!siteOrigin) return path;

  return new URL(path, siteOrigin).toString();
}

export const gitConfig = {
  user: "50BytesOfJohn",
  repo: "panqueue",
  branch: "main",
};
