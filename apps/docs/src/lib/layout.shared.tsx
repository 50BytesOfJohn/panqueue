import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="panqueue" className="h-6 w-6" />
          <span className="font-semibold tracking-tight">{appName}</span>
        </div>
      ),
    },
    links: [
      {
        on: "nav",
        text: "Documentation",
        url: "/docs",
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
