import { test, expect } from "./fixtures";

test.use({ timezoneId: "Asia/Tokyo", locale: "en-US" });

test("CSR reviews calendar supplies, replacement dates, and paged orders without sending outreach", async ({
  page,
  fixtureDb: db,
}) => {
  test.setTimeout(60_000);
  const patientId = crypto.randomUUID();
  const maskRxId = crypto.randomUUID();
  const customRxId = crypto.randomUUID();
  const oldEpisodeId = crypto.randomUUID();
  const marker = `csr-e2e-${crypto.randomUUID()}`;
  const patientName = `Calendar ${marker}`;
  const maskSku = `MASK-${marker}`;
  const customSku = `CUSTOM-${marker}`;
  const timeZone = "America/New_York";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  // The first practice day of next month, but the second day in Tokyo.
  const dueAt = new Date(
    Date.UTC(Number(parts.year), Number(parts.month), 2, 2),
  );
  const suppliedAt = new Date(dueAt.getTime() - 90 * 86400000);
  const expiresAt = new Date(dueAt.getTime() + 30 * 86400000);
  const displayDate = (date: Date) =>
    date.toLocaleDateString("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  const calendarDate = dueAt.toLocaleDateString("en-US", { timeZone });
  let outreachRequests = 0;
  await page.route("**/resupply-api/admin/resupply-outreach", async (route) => {
    outreachRequests += 1;
    await route.abort();
  });

  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      "SELECT id FROM resupply.organizations WHERE slug = 'penn-home-medical'",
    );
    expect(rows).toHaveLength(1);
    const orgId = rows[0]!.id;
    // No phone/email, no consent, and only future outreach cycles.
    await db.query(
      `INSERT INTO resupply.patients
       (id, org_id, pacware_id, legal_first_name, legal_last_name, date_of_birth, cadence_override_days)
       VALUES ($1, $2, $3, 'Calendar', $3, '1990-01-01', 90)`,
      [patientId, orgId, marker],
    );
    await db.query(
      `INSERT INTO resupply.prescriptions
       (id, org_id, patient_id, item_sku, cadence_days, valid_from, valid_until, created_at)
       VALUES ($1, $3, $4, $5, 90, '2020-01-01', '2099-12-31', $7),
              ($2, $3, $4, $6, 90, '2020-01-01', '2099-12-31', $7)`,
      [maskRxId, customRxId, orgId, patientId, maskSku, customSku, suppliedAt],
    );
    await db.query(
      `INSERT INTO resupply.episodes
       (id, org_id, patient_id, prescription_id, status, due_at, expires_at)
       VALUES ($1, $4, $5, $6, 'fulfilled', $8, $9),
              ($2, $4, $5, $6, 'outreach_pending', $9, $10),
              ($3, $4, $5, $7, 'outreach_pending', $9, $10)`,
      [
        oldEpisodeId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        orgId,
        patientId,
        maskRxId,
        customRxId,
        suppliedAt,
        dueAt,
        expiresAt,
      ],
    );
    await db.query(
      `INSERT INTO resupply.fulfillments
       (org_id, patient_id, episode_id, item_sku, quantity, status, pacware_order_ref, created_at, shipped_at)
       SELECT $1, $2, $3, $4, CASE WHEN n = 0 THEN 2 ELSE 1 END, 'shipped',
              $5 || '-' || n, $6::timestamptz - n * interval '1 day', $6::timestamptz - n * interval '1 day'
       FROM generate_series(0, 25) AS n`,
      [orgId, patientId, oldEpisodeId, maskSku, marker, suppliedAt],
    );
    await db.query("COMMIT");

    const window = new URLSearchParams({
      from: new Date(dueAt.getTime() - 86400000).toISOString(),
      to: new Date(dueAt.getTime() + 86400000).toISOString(),
    });
    // The server's pending-agreement cache expires within ten seconds.
    await expect
      .poll(
        async () =>
          (
            await page.request.get(
              `/resupply-api/admin/resupply-calendar?${window}`,
            )
          ).status(),
        { timeout: 15_000 },
      )
      .toBe(200);

    await page.goto("/admin/resupply-calendar");
    await expect(
      page.getByRole("heading", { name: "Resupply calendar", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next month" }).click();
    await page.getByLabel("Search resupply patients or supplies").fill(marker);
    await expect(
      page.getByText("1 patients · 2 supply cycles", { exact: true }),
    ).toBeVisible();
    const dueDay = page.getByRole("button", {
      name: `${calendarDate}, 1 patients due`,
      exact: true,
    });
    await expect(dueDay).toBeVisible();
    await dueDay.click();
    await expect(
      page.getByRole("link", { name: patientName, exact: true }),
    ).toBeVisible();
    await page.getByLabel(`Select ${patientName}`, { exact: true }).check();
    await expect(page.getByText(/1 selected/)).toBeVisible();

    await page
      .getByRole("button", { name: "Orders & eligibility", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: patientName, exact: true }),
    ).toBeVisible();
    const supplyTable = dialog.getByRole("table").filter({
      has: page.getByRole("columnheader", {
        name: "Next eligibility",
        exact: true,
      }),
    });
    const maskRow = supplyTable
      .getByRole("row")
      .filter({ has: page.getByText(maskSku, { exact: true }) });
    await expect(maskRow.getByRole("cell").nth(1)).toHaveText(
      displayDate(suppliedAt),
    );
    await expect(maskRow.getByRole("cell").nth(2)).toContainText(
      `Interval opens ${displayDate(dueAt)}`,
    );
    await expect(maskRow.getByRole("cell").nth(3)).toHaveText(
      displayDate(dueAt),
    );
    await expect(
      dialog.getByText("Needs eligibility review", { exact: true }),
    ).toBeVisible();
    const orderTable = dialog.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Qty", exact: true }),
    });
    const latestOrder = orderTable
      .getByRole("row")
      .filter({ has: page.getByText(`${marker}-0`, { exact: true }) });
    await expect(latestOrder.getByRole("cell").nth(2)).toHaveText("2");
    await expect(dialog.getByText("1–25 of 26", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Older", exact: true }).click();
    await expect(
      dialog.getByText("26–26 of 26", { exact: true }),
    ).toBeVisible();
    await expect(
      orderTable.getByText(`${marker}-25`, { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Newer", exact: true }).click();
    await expect(latestOrder).toBeVisible();
    for (const name of ["Email", "SMS", "Automated call"])
      await expect(
        dialog.getByRole("button", { name, exact: true }),
      ).toBeDisabled();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.getByLabel(`Select ${patientName}`, { exact: true }),
    ).toBeChecked();
    await page
      .getByLabel("Search resupply patients or supplies")
      .fill(customSku);
    await expect(
      page.getByText("1 patients · 1 supply cycles", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel(`Select ${patientName}`, { exact: true }),
    ).not.toBeChecked();
    expect(outreachRequests).toBe(0);
  } finally {
    await db.query("ROLLBACK");
    // FK cascades remove only this test's prescriptions, episodes and orders.
    await db.query(
      "DELETE FROM resupply.patients WHERE id = $1 AND pacware_id = $2",
      [patientId, marker],
    );
  }
});
