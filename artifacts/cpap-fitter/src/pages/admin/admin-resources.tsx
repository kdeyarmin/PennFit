// /admin/resources — Help & Resources hub.
//
// A simple, static, client-rendered library of downloadable operator guides.
// New guides are added as entries in GUIDES below; the PDFs live in the SPA's
// public/guides/ directory and are served at /guides/<file>.pdf.

import { BookOpen, FileText } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { PageHeader } from "@/components/admin/PageHeader";

interface Guide {
  title: string;
  description: string;
  href: string;
}

const GUIDES: Guide[] = [
  {
    title: "Set up Slack",
    description:
      "Connect your Slack workspace for real-time CS alerts and in-Slack actions (Claim / Escalate / Snooze, /pennfit). One-click setup or full manual steps, with troubleshooting.",
    href: "/guides/setup-slack.pdf",
  },
];

export function AdminResourcesPage() {
  return (
    <div className="admin-root space-y-6">
      <PageHeader
        title="Help & Resources"
        description="Downloadable setup guides and documentation for your team."
        icon={BookOpen}
      />

      <Card title="Setup guides">
        <ul className="divide-y" style={{ borderColor: "hsl(var(--line-1))" }}>
          {GUIDES.map((g) => (
            <li key={g.href} className="flex items-start gap-3 py-3 first:pt-0">
              <FileText
                className="mt-0.5 h-5 w-5 shrink-0"
                style={{ color: "hsl(var(--ink-3))" }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <a
                  href={g.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-semibold underline"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {g.title} (PDF)
                </a>
                <p
                  className="mt-0.5 text-xs"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {g.description}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Need a hand?">
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Can't find what you need? Open{" "}
          <a
            href="/admin/support"
            className="font-semibold underline"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Support
          </a>{" "}
          to ask the in-app assistant or file a request.
        </p>
      </Card>
    </div>
  );
}
