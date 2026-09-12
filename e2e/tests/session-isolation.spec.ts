import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

type Patient = "first" | "second";
const emails = {
  first: "first-patient@example.test",
  second: "second-patient@example.test",
};

/** A shared server-side session fixture stands in for the same-origin cookie.
 * Every API request is intercepted; this suite cannot reach real patient data,
 * send a communication, or change a live account. Browser synchronization and
 * all React/query behavior use the actual app, without importing its internals.
 */
async function installAccountApi(context: BrowserContext) {
  const state = {
    patient: "first" as Patient | null,
    pendingPreference: undefined as Route | undefined,
    holdPreference: false,
    sessionReads: 0,
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Keep Vite and app assets available, but never follow an external URL.
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
      await route.abort();
      return;
    }
    if (!/^\/(api|resupply-api)\//.test(url.pathname)) {
      await route.continue();
      return;
    }
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (url.pathname === "/api/auth/me") {
      state.sessionReads += 1;
      await json(
        state.patient
          ? {
              id: state.patient,
              email: emails[state.patient],
              displayName: `${state.patient} patient`,
              role: "customer",
              emailVerified: true,
              mustChangePassword: false,
            }
          : { error: "session_required" },
        state.patient ? 200 : 401,
      );
      return;
    }
    if (url.pathname === "/api/auth/sign-out") {
      state.patient = null;
      await json({ ok: true });
      return;
    }
    if (url.pathname === "/api/auth/sign-in") {
      expect(request.postDataJSON()).toMatchObject({ email: emails.second });
      state.patient = "second";
      await json({ ok: true });
      return;
    }
    if (url.pathname === "/api/auth/csrf") {
      await json({ ok: true });
      return;
    }
    if (
      url.pathname === "/api/me/statement-preferences" &&
      request.method() === "PUT" &&
      state.holdPreference
    ) {
      state.pendingPreference = route;
      return;
    }
    if (url.pathname.startsWith("/api/me/")) {
      if (!state.patient) {
        await json({ error: "session_required" }, 401);
        return;
      }
      if (url.pathname === "/api/me/billing-balance") {
        await json({
          totalOpenCents: state.patient === "first" ? 12345 : 6789,
          claimCount: 1,
          claims: [
            {
              id: `${state.patient}-claim`,
              payerName: `${state.patient} private claim`,
              dateOfService: "2026-09-01",
              patientResponsibilityCents:
                state.patient === "first" ? 12345 : 6789,
            },
          ],
        });
        return;
      }
      if (url.pathname === "/api/me/statement-preferences") {
        await json({
          statementDeliveryMethod: "email",
          email: emails[state.patient],
          linked: true,
        });
        return;
      }
      if (url.pathname === "/api/me/billing-statements") {
        await json({ statements: [] });
        return;
      }
      if (url.pathname === "/api/me/claims") {
        await json({ claims: [] });
        return;
      }
    }
    if (url.pathname === "/api/usage-events") {
      await json({ ok: true });
      return;
    }
    // Unrelated optional features use their normal unavailable fallbacks.
    await json({ error: "fixture_not_configured" }, 404);
  });
  return state;
}

async function expectPrivateBilling(page: Page, patient: Patient) {
  await expect(page.getByTestId("billing-open-balance")).toContainText(
    `${patient} private claim`,
  );
  await expect(page.getByTestId("billing-delivery-preference")).toContainText(
    emails[patient],
  );
}

async function signInAsSecondPatient(page: Page) {
  await page.goto("/sign-in?redirect=%2Faccount%2Fbilling");
  await page.getByLabel("Email", { exact: true }).fill(emails.second);
  await page
    .getByLabel("Password", { exact: true })
    .fill("Fixture-password-123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/account\/billing$/);
  await expectPrivateBilling(page, "second");
}

for (const transport of ["broadcast", "storage"] as const) {
  test(`sign-out clears another tab and late private writes stay isolated (${transport})`, async ({
    context,
    page,
  }) => {
    if (transport === "storage") {
      await context.addInitScript(() => {
        Object.defineProperty(window, "BroadcastChannel", {
          value: undefined,
          configurable: true,
        });
      });
    } else {
      await context.addInitScript(() => {
        const local = window.localStorage;
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (this === local)
            throw new DOMException("Blocked", "SecurityError");
          return setItem.call(this, key, value);
        };
      });
    }
    const state = await installAccountApi(context);
    const other = await context.newPage();
    await page.goto("/account/billing");
    await other.goto("/account/billing");
    await expectPrivateBilling(page, "first");
    await expectPrivateBilling(other, "first");

    state.holdPreference = true;
    await other.getByTestId("billing-delivery-mail").click();
    await expect.poll(() => Boolean(state.pendingPreference)).toBe(true);
    await page.getByTestId("user-menu-button").first().click();
    await page.getByTestId("user-menu-sign-out").first().click();
    // Do not focus/reload the second tab: the transport itself must clear it.
    await expect(other).toHaveURL(/\/sign-in$/);
    await expect(
      other.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(other.getByTestId("billing-open-balance")).toHaveCount(0);
    await expect(
      other.getByText("first private claim", { exact: true }),
    ).toHaveCount(0);

    await signInAsSecondPatient(page);
    // Revisit the protected route within the same document. Reloading tab B
    // would discard its QueryClient and old mutation, masking cache leaks.
    await other.evaluate(() => {
      window.history.pushState(null, "", "/account/billing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expectPrivateBilling(other, "second");
    const oldResponse = other.waitForResponse(
      (response) =>
        response.url().endsWith("/api/me/statement-preferences") &&
        response.request().method() === "PUT",
    );
    await state.pendingPreference!.fulfill({
      json: {
        statementDeliveryMethod: "mail",
        email: emails.first,
        linked: true,
      },
    });
    await (await oldResponse).finished();
    await other.waitForLoadState("networkidle");
    await expectPrivateBilling(other, "second");
    await expect(other.getByTestId("billing-delivery-email")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(other.getByText(emails.first, { exact: false })).toHaveCount(
      0,
    );
  });
}

test("focus revalidation removes expired private content and allows a fresh sign-in", async ({
  context,
  page,
}) => {
  const state = await installAccountApi(context);
  await page.goto("/account/billing");
  await expectPrivateBilling(page, "first");
  const readsBeforeExpiry = state.sessionReads;
  state.patient = null;
  // Drive the browser event without advancing the 60-second polling interval.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect
    .poll(() => state.sessionReads)
    .toBeGreaterThan(readsBeforeExpiry);
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("billing-open-balance")).toHaveCount(0);
  await expect(page.getByText(emails.first, { exact: false })).toHaveCount(0);
  await signInAsSecondPatient(page);
});
