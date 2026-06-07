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

const steps: HelpStep[] = [
  {
    title: "Open sign-up",
    body: (
      <p>
        Tap the account icon in the header and choose{" "}
        <Link href="/sign-up" className="text-primary hover:underline">
          Create an account
        </Link>
        . An account is free and optional — you can always order as a guest —
        but it saves your details and order history for next time.
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
    shot: (
      <Screenshot
        url="pennpaps.com/sign-up"
        caption="The sign-up and sign-in screens share the same clean, single-card layout."
      >
        <SignInShot />
      </Screenshot>
    ),
    tip: "Already have an account? Use Sign in instead — and if you've forgotten your password, the Forgot password link emails you a reset.",
  },
  {
    title: "Verify your email",
    body: (
      <p>
        We&apos;ll send a verification link to your inbox. Click it to confirm
        your address — this protects your account and makes sure order updates
        reach you. If it doesn&apos;t arrive in a minute or two, check spam or
        request a new link from the verification screen.
      </p>
    ),
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
            <strong>Profile & addresses</strong> — saved so checkout is faster.
          </li>
          <li>
            <strong>Orders</strong> — full history with status and a{" "}
            <strong>Reorder</strong> button.
          </li>
          <li>
            <strong>Billing</strong> — your payment and statement details.
          </li>
          <li>
            <strong>Reminders</strong> — your{" "}
            <Link
              href="/help/resupply-reminders"
              className="text-primary hover:underline"
            >
              resupply reminder
            </Link>{" "}
            preferences.
          </li>
        </ul>
      </>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/account"
        caption="Your dashboard groups profile, orders, addresses, billing, and reminders into one sidebar."
      >
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
      metaDescription="How to create a PennPaps account, verify your email, sign in, and use your dashboard to manage profile, addresses, orders, billing, and resupply reminders."
      intro="A free account saves your shipping details and order history and gives you one-tap reordering. Here's how to set one up and find your way around the dashboard."
      steps={steps}
      faqs={[
        {
          q: "Do I have to create an account to order?",
          a: (
            <>
              No. You can{" "}
              <Link
                href="/help/place-an-order"
                className="text-primary hover:underline"
              >
                order as a guest
              </Link>
              . An account just saves your details and order history so future
              orders are quicker.
            </>
          ),
        },
        {
          q: "I forgot my password.",
          a: (
            <>
              On the{" "}
              <Link href="/sign-in" className="text-primary hover:underline">
                sign-in page
              </Link>
              , tap <strong>Forgot password</strong>. We&apos;ll email you a
              secure reset link.
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
