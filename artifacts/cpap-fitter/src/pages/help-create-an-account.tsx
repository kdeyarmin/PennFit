import React from "react";
import { Link } from "wouter";
import { UserCircle } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  SignInShot,
  AccountShot,
} from "@/components/help/help-screens";
import { BrandName } from "@/components/company-contact";

const steps: HelpStep[] = [
  {
    title: "Open sign-up",
    body: (
      <p>
        Tap the account icon in the header and choose{" "}
        <Link href="/sign-up" className="text-primary hover:underline">
          Create an account
        </Link>
        . An account is free and optional — you can request a fit or ask our
        team to contact you without one — but it saves your details, order
        history, and reminder preferences for next time.
      </p>
    ),
  },
  {
    title: "Enter your email and a password",
    body: (
      <p>
        Provide your email and choose a password. We hash passwords securely
        (with argon2id) and never store them in plain text. Your email is used
        only to manage your account and orders — never sold to third parties.
      </p>
    ),
    substeps: [
      <>Enter the email you want order updates sent to.</>,
      <>Choose a strong password you don&apos;t reuse elsewhere.</>,
      <>Submit to create the account.</>,
    ],
    shot: (
      <Screenshot caption="The sign-up and sign-in screens share the same clean, single-card layout.">
        <SignInShot />
      </Screenshot>
    ),
    tip: "Already have an account? Use Sign in instead — and if you've forgotten your password, see the reset-password guide.",
  },
  {
    title: "Verify your email",
    body: (
      <p>
        We&apos;ll send a verification link to your inbox. Click it to confirm
        your address — this protects your account and makes sure order updates
        reach you.
      </p>
    ),
    substeps: [
      <>
        Open the email from <BrandName /> in your inbox.
      </>,
      <>
        Click <strong>Verify my email</strong>.
      </>,
      <>
        Don&apos;t see it within a couple of minutes? Check spam, or request a
        fresh link from the verification screen.
      </>,
    ],
    warning:
      "Verification links expire after a short window for security. If yours has lapsed, just request a new one — old links stop working.",
  },
  {
    title: "Use your account dashboard",
    body: (
      <>
        <p>
          Once signed in, your{" "}
          <Link href="/account" className="text-primary hover:underline">
            account dashboard
          </Link>{" "}
          puts everything in one place:
        </p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <strong>Overview</strong> — a snapshot of your therapy and what is
            due next.
          </li>
          <li>
            <strong>Therapy &amp; supplies</strong> — registered equipment and
            resupply status.
          </li>
          <li>
            <strong>Messages</strong> — threaded chat with your care team.
          </li>
          <li>
            <strong>Account</strong> — profile, addresses, security, and your{" "}
            <Link
              href="/help/resupply-reminders"
              className="text-primary hover:underline"
            >
              resupply reminder
            </Link>{" "}
            preferences. Insurance statements live at{" "}
            <Link
              href="/account/billing"
              className="text-primary hover:underline"
            >
              /account/billing
            </Link>
            .
          </li>
        </ul>
      </>
    ),
    shot: (
      <Screenshot caption="Your dashboard groups Overview, Therapy &amp; supplies, Messages, and Account into tabs.">
        <AccountShot />
      </Screenshot>
    ),
  },
];

export function HelpCreateAnAccount() {
  return (
    <HelpArticleShell
      eyebrow="Your Account"
      title="Create an account & sign in"
      Icon={UserCircle}
      minutes="3 min"
      metaDescription="How to create an account, verify your email, sign in, and use your dashboard for profile, therapy, messages, billing, and resupply reminders."
      intro="A free account saves your shipping details, therapy schedule, and messages with our team. Here's how to set one up and find your way around the dashboard."
      summary={
        <>
          Tap the account icon → <strong>Create an account</strong>, enter your
          email and a password, click the verification link we email you, and
          you&apos;re in. Your dashboard then keeps your profile, therapy,
          messages, billing, and reminders together.
        </>
      }
      prerequisites={[
        "An email address you can check right now (for the verification link).",
        "A password you don't reuse on other sites.",
      ]}
      steps={steps}
      next={{
        href: "/help/resupply-reminders",
        label: "Set up resupply reminders",
        blurb: "Let your account remind you when supplies are due.",
      }}
      faqs={[
        {
          q: "Do I have to create an account to ask for a mask?",
          a: (
            <>
              No. You can{" "}
              <Link
                href="/help/request-your-mask"
                className="text-primary hover:underline"
              >
                send us a request without an account
              </Link>
              . You never place the order yourself — our team verifies your
              coverage and places it for you. An account just keeps your
              details, shipments and statements in one place afterwards.
            </>
          ),
        },
        {
          q: "I forgot my password.",
          a: (
            <>
              Use the{" "}
              <Link
                href="/help/reset-password"
                className="text-primary hover:underline"
              >
                reset-password guide
              </Link>{" "}
              — tap <strong>Forgot password</strong> on the sign-in page and
              we&apos;ll email you a secure reset link.
            </>
          ),
        },
        {
          q: "Is my information sold or shared?",
          a: "No. Your account information is used only to fulfill your orders and is never sold to third parties. See our Privacy Policy for the full detail.",
        },
      ]}
      related={[
        {
          href: "/help/reset-password",
          label: "Reset your password",
          blurb: "Locked out? Get back in with a reset link.",
        },
        {
          href: "/help/resupply-reminders",
          label: "Set up resupply reminders",
          blurb: "Get reminded when supplies are due.",
        },
        {
          href: "/help/track-your-order",
          label: "Track your order",
          blurb: "See every order from your dashboard.",
        },
      ]}
    />
  );
}
