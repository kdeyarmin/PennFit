import React from "react";
import { Link } from "wouter";
import { KeyRound } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  SignInShot,
  PasswordResetShot,
} from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Go to the sign-in page",
    body: (
      <p>
        Open{" "}
        <Link href="/sign-in" className="text-primary hover:underline">
          Sign in
        </Link>{" "}
        from the account icon in the header. Don&apos;t worry about your old
        password — you won&apos;t need it.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/sign-in"
        caption="The sign-in card has a “Forgot password” link beneath the password field."
      >
        <SignInShot />
      </Screenshot>
    ),
  },
  {
    title: "Tap “Forgot password”",
    body: (
      <p>
        Below the password field, tap <strong>Forgot password</strong> and enter
        the email address on your account. Then tap{" "}
        <strong>Email me a reset link</strong>.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/forgot-password"
        caption="Enter your account email and we'll send a secure, time-limited reset link."
      >
        <PasswordResetShot />
      </Screenshot>
    ),
    note: "For your security we show the same confirmation whether or not an account exists for that email — so a stranger can't use this page to discover who has an account.",
  },
  {
    title: "Open the reset link in your email",
    body: (
      <p>
        Check your inbox for an email from PennPaps and click{" "}
        <strong>Reset my password</strong>. The link is time-limited, so use it
        soon after it arrives.
      </p>
    ),
    substeps: [
      <>Open the PennPaps password-reset email.</>,
      <>
        Click the <strong>Reset my password</strong> button or link.
      </>,
      <>Not there in a couple of minutes? Check your spam/junk folder.</>,
    ],
    warning:
      "The link expires after about an hour. If yours has lapsed, just request a new one from the Forgot password page — old links stop working on purpose.",
  },
  {
    title: "Choose a new password",
    body: (
      <p>
        Enter a new password (twice, to confirm), then submit. You&apos;ll be
        able to sign in with it right away. For safety, pick something you
        don&apos;t reuse on other sites.
      </p>
    ),
    tip: "A password manager makes a long, unique password effortless — and you'll never need this guide again.",
  },
];

export function HelpResetPassword() {
  return (
    <HelpArticleShell
      eyebrow="Your Account"
      title="Reset your password"
      Icon={KeyRound}
      minutes="2 min"
      metaDescription="How to reset a forgotten PennPaps password: use the Forgot password link, open the secure reset email, and choose a new password."
      intro="Locked out? Resetting your password takes about two minutes and only needs access to your email. Here's the whole flow."
      summary={
        <>
          On the sign-in page, tap <strong>Forgot password</strong>, enter your
          email, and open the secure link we send you. Pick a new password and
          you&apos;re back in. The link expires after about an hour — request a
          fresh one if needed.
        </>
      }
      prerequisites={[
        "Access to the email inbox on your account (that's where the link goes).",
        "A new password you don't use on other sites.",
      ]}
      steps={steps}
      next={{
        href: "/help/create-an-account",
        label: "Tour your account dashboard",
        blurb: "Now that you're back in, see everything your account offers.",
      }}
      faqs={[
        {
          q: "I didn't get the reset email.",
          a: "Check your spam or junk folder and confirm you used the same email you signed up with. Still nothing? Request the link again, or contact our care team and we'll help.",
        },
        {
          q: "The link says it's expired.",
          a: "Reset links are time-limited for security. Just go back to Forgot password and request a new one — it'll arrive fresh.",
        },
        {
          q: "Do I need my old password?",
          a: "No. The reset flow replaces your password entirely, so a forgotten one is no problem.",
        },
      ]}
      related={[
        {
          href: "/help/create-an-account",
          label: "Create an account & sign in",
          blurb: "Set up an account or find your way around it.",
        },
        {
          href: "/help/track-your-order",
          label: "Track your order",
          blurb: "Once you're signed in, see all your orders.",
        },
      ]}
    />
  );
}
