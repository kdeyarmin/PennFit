import { useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  createShopProduct,
  InventoryUnavailableError,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  PublicStorageUnavailableError,
  RECURRING_INTERVALS,
  SHOP_CATEGORIES,
  SkuAlreadyExistsError,
  uploadShopProductImage,
  type CreateShopProductInput,
  type RecurringInterval,
  type ShopCategory,
} from "@/lib/admin/shop-inventory-api";

// Add Shop Product page.
//
// One-line summary: form-driven Stripe Product + Price creation.
// Mirrors seed-stripe-products.ts so a SKU created here is byte-
// equivalent to one seeded from the script.
//
// Why a dedicated page (not a modal on /admin/shop/inventory):
//   The form has 14 fields including a multi-line description and
//   optional bundle-contents list. Cramming that into a modal made
//   the inventory grid unusable on narrow viewports; a dedicated
//   page can use full screen real estate and gives the operator
//   a clean back button to the inventory list.
//
// Failure modes the page renders inline (not a generic toast):
//   - 409 sku_already_exists  → "Open existing SKU" link
//   - 503 stripe_not_configured → preview-mode explainer
//   - 4xx Zod issues → list of `field: message` strings
//   - 502 orphaned product → "finish in Stripe Dashboard" hint
//
// Why optional fields are typed `string` (not `string | null`):
//   The HTML form inputs return strings; we convert empty strings
//   to `null` at submit time so the API skips writing the metadata
//   key (matches the seed script's behavior — missing key, not
//   empty key).

const FIELD_LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "hsl(var(--ink-1))",
  marginBottom: 4,
};

const FIELD_HINT_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: "hsl(var(--ink-3))",
  marginTop: 4,
  lineHeight: 1.4,
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 14,
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const TEXTAREA_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  minHeight: 88,
  resize: "vertical",
  fontFamily: "inherit",
};

const SECTION_STYLE: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 20,
  marginBottom: 20,
  background: "#ffffff",
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 15,
  fontWeight: 600,
  color: "hsl(var(--ink-1))",
};

interface FormState {
  sku: string;
  name: string;
  description: string;
  category: ShopCategory;
  unitAmountDollars: string; // user-facing "$11.99" → cents at submit
  tagline: string;
  replacementHint: string;
  manufacturer: string;
  modelNumber: string;
  imageUrl: string;
  stockCount: string;
  lowStockThreshold: string;
  bundleContentsRaw: string; // newline-separated, only used when category=bundle
  recurringInterval: RecurringInterval | "";
  recurringIntervalCount: string;
}

const INITIAL_STATE: FormState = {
  sku: "",
  name: "",
  description: "",
  category: "mask",
  unitAmountDollars: "",
  tagline: "",
  replacementHint: "",
  manufacturer: "",
  modelNumber: "",
  imageUrl: "",
  stockCount: "",
  lowStockThreshold: "",
  bundleContentsRaw: "",
  recurringInterval: "",
  recurringIntervalCount: "",
};

export function AdminShopProductNewPage() {
  const [, setLocation] = useLocation();
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [errors, setErrors] = useState<string[]>([]);
  const [collisionProductId, setCollisionProductId] = useState<string | null>(
    null,
  );
  const [imageUploading, setImageUploading] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);

  async function onImageFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Allow re-selecting the same file after a failed attempt.
    e.target.value = "";
    if (!file) return;
    setImageUploadError(null);
    if (!(PRODUCT_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setImageUploadError("Use a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
      setImageUploadError("Image too large — 5 MB max.");
      return;
    }
    setImageUploading(true);
    try {
      const url = await uploadShopProductImage(file);
      update("imageUrl", url);
    } catch (err) {
      if (err instanceof PublicStorageUnavailableError) {
        setImageUploadError(
          "Image hosting isn't configured in this environment (SUPABASE_STORAGE_BUCKET_PUBLIC unset) — paste an HTTPS image URL below instead.",
        );
      } else {
        setImageUploadError(
          err instanceof Error ? err.message : "Upload failed",
        );
      }
    } finally {
      setImageUploading(false);
    }
  }

  const createMutation = useMutation({
    mutationFn: (input: CreateShopProductInput) => createShopProduct(input),
    onSuccess: () => {
      // Pop back to the inventory list. The list query will refetch
      // on focus / next navigation; we don't manually invalidate
      // because the storefront also has a 60s product cache and
      // matching the visible state is a separate concern.
      setLocation("/admin/shop/inventory");
    },
    onError: (err) => {
      if (err instanceof SkuAlreadyExistsError) {
        setCollisionProductId(err.existingProductId);
        setErrors(["A product with this SKU already exists."]);
        return;
      }
      if (err instanceof InventoryUnavailableError) {
        setErrors([
          "Stripe is not configured in this environment — set STRIPE_SECRET_KEY to enable product creation.",
        ]);
        return;
      }
      // Surface the API's joined Zod messages directly. The client
      // wrapper formats them as "field: message; field: message".
      const message = err instanceof Error ? err.message : "Create failed";
      setErrors(message.split("; "));
    },
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Clear stale errors as the operator types — common pattern is
    // "saw the error, fixed the field, hit submit again". Leaving
    // the old errors visible would be misleading.
    if (errors.length > 0) setErrors([]);
    if (collisionProductId) setCollisionProductId(null);
  }

  function buildInput():
    | {
        ok: true;
        input: CreateShopProductInput;
      }
    | { ok: false; reason: string } {
    // Local validation mirrors the server schema closely so the
    // operator gets immediate feedback without a round-trip. The
    // server still validates (defense in depth); this is just UX.
    const sku = form.sku.trim();
    if (!/^[a-z0-9-]+$/.test(sku) || sku.length < 2 || sku.length > 120) {
      return {
        ok: false,
        reason:
          "SKU must be 2–120 chars, lowercase letters / digits / hyphens.",
      };
    }
    const name = form.name.trim();
    if (name.length < 2 || name.length > 250) {
      return { ok: false, reason: "Name must be 2–250 characters." };
    }
    const description = form.description.trim();
    if (description.length < 2 || description.length > 2000) {
      return { ok: false, reason: "Description must be 2–2000 characters." };
    }
    const dollars = parseFloat(form.unitAmountDollars);
    if (!Number.isFinite(dollars) || dollars < 0.5 || dollars > 100_000) {
      return { ok: false, reason: "Price must be between $0.50 and $100,000." };
    }
    const unitAmountCents = Math.round(dollars * 100);

    // Optional integer fields — empty string means "leave unset"
    // (server treats null as "skip the metadata key").
    function parseOptionalInt(
      raw: string,
      label: string,
      min: number,
      max: number,
    ): { ok: true; value: number | null } | { ok: false; reason: string } {
      const trimmed = raw.trim();
      if (trimmed === "") return { ok: true, value: null };
      if (!/^\d+$/.test(trimmed)) {
        return { ok: false, reason: `${label} must be a whole number.` };
      }
      const n = parseInt(trimmed, 10);
      if (n < min || n > max) {
        return {
          ok: false,
          reason: `${label} must be between ${min} and ${max}.`,
        };
      }
      return { ok: true, value: n };
    }

    const stockResult = parseOptionalInt(
      form.stockCount,
      "Stock count",
      0,
      1_000_000,
    );
    if (!stockResult.ok) return { ok: false, reason: stockResult.reason };
    const thresholdResult = parseOptionalInt(
      form.lowStockThreshold,
      "Low-stock threshold",
      0,
      1000,
    );
    if (!thresholdResult.ok)
      return { ok: false, reason: thresholdResult.reason };

    let bundleContents: string[] | null = null;
    if (form.category === "bundle") {
      const lines = form.bundleContentsRaw
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (lines.length === 0) {
        return {
          ok: false,
          reason: "Bundles must list at least one content line.",
        };
      }
      if (lines.length > 20) {
        return { ok: false, reason: "Bundle contents capped at 20 lines." };
      }
      bundleContents = lines;
    } else if (form.bundleContentsRaw.trim() !== "") {
      return {
        ok: false,
        reason: "Bundle contents only valid when category is 'bundle'.",
      };
    }

    // Recurring price: both fields together or both empty.
    let recurringInterval: RecurringInterval | null = null;
    let recurringIntervalCount: number | null = null;
    if (form.recurringInterval || form.recurringIntervalCount.trim() !== "") {
      if (!form.recurringInterval) {
        return {
          ok: false,
          reason: "Recurring interval required for cadence price.",
        };
      }
      const countResult = parseOptionalInt(
        form.recurringIntervalCount,
        "Recurring interval count",
        1,
        12,
      );
      if (!countResult.ok) return { ok: false, reason: countResult.reason };
      if (countResult.value === null) {
        return {
          ok: false,
          reason: "Recurring interval count required for cadence price.",
        };
      }
      recurringInterval = form.recurringInterval;
      recurringIntervalCount = countResult.value;
    }

    const imageUrl = form.imageUrl.trim();
    if (imageUrl !== "") {
      if (!/^https:\/\//i.test(imageUrl)) {
        return { ok: false, reason: "Image URL must use https://." };
      }
      if (imageUrl.length > 500) {
        return { ok: false, reason: "Image URL too long (500 char max)." };
      }
    }

    return {
      ok: true,
      input: {
        sku,
        name,
        description,
        category: form.category,
        unitAmountCents,
        tagline: form.tagline.trim() || null,
        replacementHint: form.replacementHint.trim() || null,
        manufacturer: form.manufacturer.trim() || null,
        modelNumber: form.modelNumber.trim() || null,
        imageUrl: imageUrl || null,
        stockCount: stockResult.value,
        lowStockThreshold: thresholdResult.value,
        bundleContents,
        recurringInterval,
        recurringIntervalCount,
      },
    };
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Guard the Enter-key path too, not just the disabled button.
    if (imageUploading) {
      setErrors(["Wait for the photo upload to finish."]);
      return;
    }
    setCollisionProductId(null);
    const result = buildInput();
    if (!result.ok) {
      setErrors([result.reason]);
      return;
    }
    setErrors([]);
    createMutation.mutate(result.input);
  }

  const isSubmitting = createMutation.isPending;
  // Block submission while a photo upload is in flight: buildInput()
  // reads form.imageUrl, so creating mid-upload would ship the product
  // without its selected photo and orphan the upload.
  const submitBlocked = isSubmitting || imageUploading;

  return (
    <div style={{ maxWidth: 760 }}>
      <header style={{ marginBottom: 24 }}>
        <a
          href={`${import.meta.env.BASE_URL}admin/shop/inventory`}
          style={{
            color: "hsl(var(--ink-1))",
            fontSize: 13,
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 8,
          }}
        >
          ← Back to inventory
        </a>
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            color: "hsl(var(--ink-1))",
          }}
        >
          Add Shop Product
        </h1>
        <p
          style={{
            margin: "8px 0 0",
            color: "hsl(var(--ink-2))",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          Creates a new Stripe Product + Price. The SKU you choose here becomes
          the stable identifier — re-using it later (e.g. via the seed script)
          updates this product instead of creating a duplicate. The storefront's
          60-second product cache will pick the new SKU up on its next flush.
        </p>
      </header>

      {errors.length > 0 ? (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "12px 16px",
            borderRadius: 6,
            fontSize: 13,
            marginBottom: 20,
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            Could not create product
          </strong>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
          {collisionProductId ? (
            <p style={{ margin: "8px 0 0" }}>
              Existing Stripe product:{" "}
              <code
                style={{
                  background: "#fff",
                  padding: "2px 6px",
                  borderRadius: 3,
                }}
              >
                {collisionProductId}
              </code>
              {" — "}
              <a
                href={`${import.meta.env.BASE_URL}admin/shop/inventory`}
                style={{ color: "hsl(var(--ink-1))" }}
              >
                edit it on the inventory page
              </a>
              .
            </p>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={onSubmit}>
        <section style={SECTION_STYLE}>
          <h2 style={SECTION_TITLE_STYLE}>Basics</h2>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="sku" style={FIELD_LABEL_STYLE}>
              SKU <span style={{ color: "#dc2626" }}>*</span>
            </label>
            <input
              id="sku"
              type="text"
              required
              value={form.sku}
              onChange={(e) => update("sku", e.target.value)}
              placeholder="mask-nasal-pillows-medium"
              style={INPUT_STYLE}
              disabled={isSubmitting}
            />
            <p style={FIELD_HINT_STYLE}>
              Lowercase letters, digits, and hyphens. Must be unique across the
              catalog. Stable identifier — used by the seed script and webhook
              handlers; changing it later requires archiving the old product.
            </p>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="name" style={FIELD_LABEL_STYLE}>
              Display name <span style={{ color: "#dc2626" }}>*</span>
            </label>
            <input
              id="name"
              type="text"
              required
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="ResMed AirFit P10 Nasal Pillows Mask — Medium"
              style={INPUT_STYLE}
              disabled={isSubmitting}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="description" style={FIELD_LABEL_STYLE}>
              Description <span style={{ color: "#dc2626" }}>*</span>
            </label>
            <textarea
              id="description"
              required
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="Two to three sentences. Mention compatibility, what's in the box, and any standout feature."
              style={TEXTAREA_STYLE}
              disabled={isSubmitting}
            />
          </div>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <div>
              <label htmlFor="category" style={FIELD_LABEL_STYLE}>
                Category <span style={{ color: "#dc2626" }}>*</span>
              </label>
              <select
                id="category"
                required
                value={form.category}
                onChange={(e) =>
                  update("category", e.target.value as ShopCategory)
                }
                style={INPUT_STYLE}
                disabled={isSubmitting}
              >
                {SHOP_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="unitAmountDollars" style={FIELD_LABEL_STYLE}>
                Price (USD) <span style={{ color: "#dc2626" }}>*</span>
              </label>
              <input
                id="unitAmountDollars"
                type="text"
                inputMode="decimal"
                required
                value={form.unitAmountDollars}
                onChange={(e) => update("unitAmountDollars", e.target.value)}
                placeholder="119.00"
                style={INPUT_STYLE}
                disabled={isSubmitting}
              />
              <p style={FIELD_HINT_STYLE}>
                Whole-dollar amount. Stripe minimum is $0.50.
              </p>
            </div>
          </div>
        </section>

        <section style={SECTION_STYLE}>
          <h2 style={SECTION_TITLE_STYLE}>Catalog metadata (optional)</h2>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginBottom: 16,
            }}
          >
            <div>
              <label htmlFor="manufacturer" style={FIELD_LABEL_STYLE}>
                Manufacturer
              </label>
              <input
                id="manufacturer"
                type="text"
                value={form.manufacturer}
                onChange={(e) => update("manufacturer", e.target.value)}
                placeholder="ResMed"
                style={INPUT_STYLE}
                disabled={isSubmitting}
              />
            </div>
            <div>
              <label htmlFor="modelNumber" style={FIELD_LABEL_STYLE}>
                Model number
              </label>
              <input
                id="modelNumber"
                type="text"
                value={form.modelNumber}
                onChange={(e) => update("modelNumber", e.target.value)}
                placeholder="62932"
                style={INPUT_STYLE}
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="tagline" style={FIELD_LABEL_STYLE}>
              Tagline
            </label>
            <input
              id="tagline"
              type="text"
              value={form.tagline}
              onChange={(e) => update("tagline", e.target.value)}
              placeholder="Most popular for side sleepers"
              style={INPUT_STYLE}
              disabled={isSubmitting}
            />
            <p style={FIELD_HINT_STYLE}>
              Short callout shown above the product name on the storefront card.
            </p>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="replacementHint" style={FIELD_LABEL_STYLE}>
              Replacement hint
            </label>
            <input
              id="replacementHint"
              type="text"
              value={form.replacementHint}
              onChange={(e) => update("replacementHint", e.target.value)}
              placeholder="Replace mask every ~3 months"
              style={INPUT_STYLE}
              disabled={isSubmitting}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="imageFile" style={FIELD_LABEL_STYLE}>
              Product photo
            </label>
            <input
              id="imageFile"
              type="file"
              accept={PRODUCT_IMAGE_TYPES.join(",")}
              onChange={(e) => void onImageFileChange(e)}
              style={{ fontSize: 13 }}
              disabled={isSubmitting || imageUploading}
            />
            {imageUploading ? (
              <p style={FIELD_HINT_STYLE}>Uploading…</p>
            ) : (
              <p style={FIELD_HINT_STYLE}>
                PNG, JPEG, or WebP up to 5 MB. Uploads to public storage and
                fills the URL field below.
              </p>
            )}
            {imageUploadError ? (
              <p role="alert" style={{ ...FIELD_HINT_STYLE, color: "#991b1b" }}>
                {imageUploadError}
              </p>
            ) : null}
            {form.imageUrl && !imageUploading ? (
              <img
                src={form.imageUrl}
                alt="Product preview"
                style={{
                  display: "block",
                  marginTop: 8,
                  maxHeight: 120,
                  maxWidth: 200,
                  borderRadius: 6,
                  border: "1px solid #e5e7eb",
                  objectFit: "contain",
                }}
              />
            ) : null}
          </div>

          <div>
            <label htmlFor="imageUrl" style={FIELD_LABEL_STYLE}>
              Image URL
            </label>
            <input
              id="imageUrl"
              type="url"
              value={form.imageUrl}
              onChange={(e) => update("imageUrl", e.target.value)}
              placeholder="https://app.pennpaps.com/products/airfit-p10.webp"
              style={INPUT_STYLE}
              disabled={isSubmitting || imageUploading}
            />
            <p style={FIELD_HINT_STYLE}>
              Public HTTPS URL Stripe can fetch. Filled automatically when you
              upload a photo above; you can also paste a URL directly (e.g. a
              path under the cpap-fitter public/ directory served from your
              deploy domain).
            </p>
          </div>
        </section>

        <section style={SECTION_STYLE}>
          <h2 style={SECTION_TITLE_STYLE}>Inventory (optional)</h2>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <div>
              <label htmlFor="stockCount" style={FIELD_LABEL_STYLE}>
                Initial stock count
              </label>
              <input
                id="stockCount"
                type="text"
                inputMode="numeric"
                value={form.stockCount}
                onChange={(e) => update("stockCount", e.target.value)}
                placeholder="(leave blank to untrack)"
                style={INPUT_STYLE}
                disabled={isSubmitting}
              />
              <p style={FIELD_HINT_STYLE}>
                Empty = untracked (always available). Set to 0 to start hidden.
              </p>
            </div>
            <div>
              <label htmlFor="lowStockThreshold" style={FIELD_LABEL_STYLE}>
                Low-stock threshold
              </label>
              <input
                id="lowStockThreshold"
                type="text"
                inputMode="numeric"
                value={form.lowStockThreshold}
                onChange={(e) => update("lowStockThreshold", e.target.value)}
                placeholder="(default: 5)"
                style={INPUT_STYLE}
                disabled={isSubmitting}
              />
              <p style={FIELD_HINT_STYLE}>
                Storefront shows "Only N left" when stock ≤ threshold.
              </p>
            </div>
          </div>
        </section>

        {form.category === "bundle" ? (
          <section style={SECTION_STYLE}>
            <h2 style={SECTION_TITLE_STYLE}>Bundle contents</h2>
            <label htmlFor="bundleContents" style={FIELD_LABEL_STYLE}>
              One line per item <span style={{ color: "#dc2626" }}>*</span>
            </label>
            <textarea
              id="bundleContents"
              value={form.bundleContentsRaw}
              onChange={(e) => update("bundleContentsRaw", e.target.value)}
              placeholder={
                "1× ResMed AirFit N20 cushion · medium (#63551)\n1× ResMed SlimLine tubing — 6ft (#36995)"
              }
              style={{ ...TEXTAREA_STYLE, minHeight: 120 }}
              disabled={isSubmitting}
            />
            <p style={FIELD_HINT_STYLE}>
              Up to 20 lines. Each line renders as a bullet on the storefront
              card.
            </p>
          </section>
        ) : null}

        <section style={SECTION_STYLE}>
          <h2 style={SECTION_TITLE_STYLE}>Subscription cadence (optional)</h2>
          <p style={{ ...FIELD_HINT_STYLE, marginTop: 0, marginBottom: 12 }}>
            Adds a second Stripe Price for recurring purchases at the same unit
            amount. Customers can choose "one-time" or this cadence at checkout.
          </p>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <div>
              <label htmlFor="recurringInterval" style={FIELD_LABEL_STYLE}>
                Interval
              </label>
              <select
                id="recurringInterval"
                value={form.recurringInterval}
                onChange={(e) =>
                  update(
                    "recurringInterval",
                    e.target.value as RecurringInterval | "",
                  )
                }
                style={INPUT_STYLE}
                disabled={isSubmitting}
              >
                <option value="">— none —</option>
                {RECURRING_INTERVALS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="recurringIntervalCount" style={FIELD_LABEL_STYLE}>
                Every N intervals
              </label>
              <input
                id="recurringIntervalCount"
                type="text"
                inputMode="numeric"
                value={form.recurringIntervalCount}
                onChange={(e) =>
                  update("recurringIntervalCount", e.target.value)
                }
                placeholder="e.g. 3 for every 3 months"
                style={INPUT_STYLE}
                disabled={isSubmitting}
              />
            </div>
          </div>
        </section>

        <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
          <button
            type="submit"
            disabled={submitBlocked}
            style={{
              background: "#0a1f44",
              color: "#fff",
              border: "none",
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 6,
              cursor: submitBlocked ? "wait" : "pointer",
              opacity: submitBlocked ? 0.7 : 1,
            }}
          >
            {isSubmitting
              ? "Creating…"
              : imageUploading
                ? "Uploading photo…"
                : "Create product"}
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => setLocation("/admin/shop/inventory")}
            style={{
              background: "#fff",
              color: "hsl(var(--ink-2))",
              border: "1px solid #d1d5db",
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
