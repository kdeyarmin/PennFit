import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import {
  fetchShopProductDetails,
  InventoryUnavailableError,
  patchShopProductDetails,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  PublicStorageUnavailableError,
  uploadShopProductImage,
  type PatchShopProductDetailsInput,
  type ShopProductDetails,
} from "@/lib/admin/shop-inventory-api";

// Edit Shop Product page — catalog copy only.
//
// Counterpart to admin-shop-product-new.tsx for fields that were
// previously create-only (name, description, tagline, replacement
// hint, manufacturer, model number, photo). Price, stock count, and
// low-stock threshold stay on the inventory grid's inline editors;
// identity fields (SKU, category, bundle contents) are deliberately
// not editable — those are "archive and re-create" operations, per
// the API's PATCH /details docs.
//
// Save semantics: only fields the operator actually changed are sent
// (the server treats omitted fields as unchanged and null as "clear"),
// so two operators editing different fields of the same SKU don't
// clobber each other.

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
  name: string;
  description: string;
  tagline: string;
  replacementHint: string;
  manufacturer: string;
  modelNumber: string;
  imageUrl: string;
}

function toFormState(p: ShopProductDetails): FormState {
  return {
    name: p.name,
    description: p.description ?? "",
    tagline: p.tagline ?? "",
    replacementHint: p.replacementHint ?? "",
    manufacturer: p.manufacturer ?? "",
    modelNumber: p.modelNumber ?? "",
    imageUrl: p.imageUrl ?? "",
  };
}

// Diff the edited form against the loaded product, mapping empty
// strings on optional fields to null ("clear the metadata key").
// Returns null when nothing changed.
function buildPatch(
  initial: FormState,
  form: FormState,
):
  | { ok: true; patch: PatchShopProductDetailsInput | null }
  | {
      ok: false;
      reason: string;
    } {
  const patch: PatchShopProductDetailsInput = {};

  const name = form.name.trim();
  if (name !== initial.name) {
    if (name.length < 2 || name.length > 250) {
      return { ok: false, reason: "Name must be 2–250 characters." };
    }
    patch.name = name;
  }
  const description = form.description.trim();
  if (description !== initial.description) {
    if (description.length < 2 || description.length > 2000) {
      return { ok: false, reason: "Description must be 2–2000 characters." };
    }
    patch.description = description;
  }

  const optionalFields = [
    ["tagline", 250],
    ["replacementHint", 250],
    ["manufacturer", 120],
    ["modelNumber", 120],
  ] as const;
  for (const [field, max] of optionalFields) {
    const value = form[field].trim();
    if (value === initial[field]) continue;
    if (value.length > max) {
      return { ok: false, reason: `${field} too long (${max} char max).` };
    }
    patch[field] = value === "" ? null : value;
  }

  const imageUrl = form.imageUrl.trim();
  if (imageUrl !== initial.imageUrl) {
    if (imageUrl !== "" && !/^https:\/\//i.test(imageUrl)) {
      return { ok: false, reason: "Image URL must use https://." };
    }
    if (imageUrl.length > 500) {
      return { ok: false, reason: "Image URL too long (500 char max)." };
    }
    patch.imageUrl = imageUrl === "" ? null : imageUrl;
  }

  return {
    ok: true,
    patch: Object.keys(patch).length > 0 ? patch : null,
  };
}

export function AdminShopProductEditPage() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute<{ productId: string }>(
    "/admin/shop/inventory/:productId/edit",
  );
  const productId = params?.productId ?? "";

  const productQuery = useQuery({
    queryKey: ["admin-shop-product-details", productId],
    queryFn: () => fetchShopProductDetails(productId),
    enabled: productId.length > 0,
  });

  // Form state initialises from the loaded product once; afterwards
  // the operator owns it. Keyed remount-free because the query result
  // is stable for a given productId.
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);

  const product = productQuery.data ?? null;
  if (product && form === null) {
    setForm(toFormState(product));
  }

  const saveMutation = useMutation({
    mutationFn: (patch: PatchShopProductDetailsInput) =>
      patchShopProductDetails(productId, patch),
    onSuccess: () => {
      setLocation("/admin/shop/inventory");
    },
    onError: (err) => {
      if (err instanceof InventoryUnavailableError) {
        setErrors([
          "Stripe is not configured in this environment — set STRIPE_SECRET_KEY to edit products.",
        ]);
        return;
      }
      const message = err instanceof Error ? err.message : "Save failed";
      setErrors(message.split("; "));
    },
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    if (errors.length > 0) setErrors([]);
  }

  async function onImageFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
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

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!product || !form) return;
    if (imageUploading) {
      setErrors(["Wait for the photo upload to finish."]);
      return;
    }
    const result = buildPatch(toFormState(product), form);
    if (!result.ok) {
      setErrors([result.reason]);
      return;
    }
    if (result.patch === null) {
      // Nothing changed — treat as a successful no-op.
      setLocation("/admin/shop/inventory");
      return;
    }
    setErrors([]);
    saveMutation.mutate(result.patch);
  }

  const isSubmitting = saveMutation.isPending;
  const submitBlocked = isSubmitting || imageUploading;

  const backLink = (
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
  );

  if (productQuery.isLoading) {
    return (
      <div style={{ maxWidth: 760 }}>
        {backLink}
        <p style={{ color: "hsl(var(--ink-2))", fontSize: 14 }}>
          Loading product…
        </p>
      </div>
    );
  }

  if (productQuery.isError || !product || !form) {
    return (
      <div style={{ maxWidth: 760 }}>
        {backLink}
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "12px 16px",
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          {productQuery.isError
            ? "Could not load the product — try again."
            : "This product is not in the shop catalog (it may have been archived in Stripe)."}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <header style={{ marginBottom: 24 }}>
        {backLink}
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            color: "hsl(var(--ink-1))",
          }}
        >
          Edit Shop Product
        </h1>
        <p
          style={{
            margin: "8px 0 0",
            color: "hsl(var(--ink-2))",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {product.category} · <code>{product.id}</code>. Edits write through to
          Stripe and reach the storefront immediately. Price, stock, and
          low-stock threshold are edited inline on the inventory page; SKU and
          category are fixed (archive and re-create to change them).
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
            Could not save changes
          </strong>
          <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <form onSubmit={onSubmit}>
        <section style={SECTION_STYLE}>
          <h2 style={SECTION_TITLE_STYLE}>Basics</h2>

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
              style={INPUT_STYLE}
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label htmlFor="description" style={FIELD_LABEL_STYLE}>
              Description <span style={{ color: "#dc2626" }}>*</span>
            </label>
            <textarea
              id="description"
              required
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              style={TEXTAREA_STYLE}
              disabled={isSubmitting}
            />
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
              style={INPUT_STYLE}
              disabled={isSubmitting}
            />
            <p style={FIELD_HINT_STYLE}>
              Short callout shown above the product name on the storefront card.
              Clear the field to remove it.
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
              style={INPUT_STYLE}
              disabled={isSubmitting || imageUploading}
            />
            <p style={FIELD_HINT_STYLE}>
              Public HTTPS URL Stripe can fetch. Clear the field to remove the
              photo from the storefront card.
            </p>
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
              ? "Saving…"
              : imageUploading
                ? "Uploading photo…"
                : "Save changes"}
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
