export function dashboardChunkForPackage(packageName: string): string | undefined {
  if (packageName === "react" || packageName === "react-dom") return "react";
  if (packageName === "@tanstack/react-query") return "query";
  if (packageName === "wouter") return "router";
}

export function fitterChunkForPackage(packageName: string): string | undefined {
  if (packageName === "react" || packageName === "react-dom") return "react";
  if (packageName === "@tanstack/react-query") return "query";
  if (
    packageName.startsWith("@radix-ui/") ||
    packageName === "cmdk" ||
    packageName === "vaul"
  ) {
    return "ui";
  }
  if (packageName === "recharts" || packageName === "framer-motion") {
    return "viz-motion";
  }
}
