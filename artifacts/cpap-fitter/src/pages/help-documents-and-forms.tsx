import React from "react";
import { Link } from "wouter";
import { FileText } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import { Screenshot, AccountShot } from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open My documents",
    body: (
      <p>
        Sign in, open{" "}
        <Link href="/account" className="text-primary hover:underline">
          your account
        </Link>
        , and pick the <strong>Account</strong> tab. The{" "}
        <strong>My documents</strong> section is where you upload insurance
        cards, prescriptions, referrals, and anything else our team needs — they
        can view what you upload directly, so there&apos;s no need to email
        attachments.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="My documents and Required forms both live under the Account tab."
      >
        <AccountShot />
      </Screenshot>
    ),
  },
  {
    title: "Upload a document",
    body: (
      <p>
        Choose what it is from the <strong>Document type</strong> dropdown
        (insurance card, prescription, referral, and so on), then tap{" "}
        <strong>Upload document</strong> and pick the file. PDFs and photos
        (PNG, JPEG, HEIC, WebP) up to <strong>10&nbsp;MB</strong> are accepted —
        a clear phone photo works fine.
      </p>
    ),
    tip: "Uploading your insurance card and prescription ahead of an order saves a round of back-and-forth during insurance verification.",
  },
  {
    title: "Track review status",
    body: (
      <p>
        Each upload shows a status badge: <strong>Pending review</strong> right
        after upload, then <strong>Reviewed</strong> with the date once our team
        has checked it. Uploaded the wrong file? Remove it with the trash icon
        and upload again.
      </p>
    ),
  },
  {
    title: "Acknowledge required forms",
    body: (
      <p>
        Below your documents, the <strong>Required forms</strong> section lists
        click-through acknowledgements — HIPAA notice, billing, and
        supplier-standards forms that keep your chart audit-ready. Read each one
        and tap <strong>I acknowledge</strong>. Signed forms show the version
        you signed; if a form is updated later, it asks you to re-acknowledge
        the new version.
      </p>
    ),
    note: "Required forms appear once your account is linked to a patient record — typically after your first order or fitting.",
  },
];

export function HelpDocumentsAndForms() {
  return (
    <HelpArticleShell
      eyebrow="Your Account"
      title="Upload documents & sign forms"
      Icon={FileText}
      minutes="3 min"
      metaDescription="How to upload insurance cards, prescriptions, and referrals to your PennPaps account, track review status, and acknowledge required HIPAA and billing forms."
      intro="Skip the fax machine: upload insurance cards and prescriptions straight to your account, watch their review status, and e-sign required forms in a tap."
      summary={
        <>
          Open <strong>Account → Account tab → My documents</strong>, pick a{" "}
          <strong>Document type</strong>, and tap{" "}
          <strong>Upload document</strong> (PDF or image, max 10&nbsp;MB).
          Acknowledge anything waiting under <strong>Required forms</strong>{" "}
          while you&apos;re there.
        </>
      }
      prerequisites={[
        "A PennPaps account, signed in.",
        "A PDF or a clear photo of the document (up to 10 MB).",
      ]}
      steps={steps}
      next={{
        href: "/help/insurance-estimate",
        label: "Get an insurance estimate",
        blurb: "Your uploaded card makes verification faster.",
      }}
      faqs={[
        {
          q: "Who can see what I upload?",
          a: "Only the PennPaps team — documents are stored privately on your account so our staff can verify insurance and prescriptions without you emailing anything.",
        },
        {
          q: "My file is bigger than 10 MB — what do I do?",
          a: "Take a photo of the document instead of scanning at high resolution, or export the PDF at a smaller size. Each upload must be 10 MB or less.",
        },
        {
          q: "Why am I being asked to sign a form again?",
          a: "Forms are versioned. If we update one — say the HIPAA notice — your account shows the form again with a note that a newer version needs your acknowledgement.",
        },
      ]}
      related={[
        {
          href: "/help/place-an-order",
          label: "Order your recommended mask",
          blurb: "Where prescriptions fit into ordering.",
        },
        {
          href: "/help/caregiver-access",
          label: "Share updates with a caregiver",
          blurb: "Privacy-safe shipping updates for family.",
        },
      ]}
    />
  );
}
