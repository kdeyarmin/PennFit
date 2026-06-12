// /admin/documents — New document panel: pick a type + title, then the
// editor opens for the freshly-created draft.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Input, Label, Select } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { describeError } from "@/components/admin/ErrorPanel";
import {
  createManualDocument,
  type ManualDocumentType,
  type ManualDocumentTypeDef,
} from "@/lib/admin/manual-documents-api";

export function NewDocumentPanel({
  types,
  loadingTypes,
  typesError,
  retryingTypes,
  onRetryTypes,
  onCreated,
  onClose,
}: {
  types: ManualDocumentTypeDef[];
  loadingTypes: boolean;
  typesError: unknown;
  retryingTypes: boolean;
  onRetryTypes: () => void;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<string>("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({ mutationFn: createManualDocument });

  const def = types.find((t) => t.type === type) ?? null;

  const handleCreate = async () => {
    setError(null);
    if (!type) {
      setError("Choose a document type.");
      return;
    }
    if (!title.trim()) {
      setError("Enter a title.");
      return;
    }
    try {
      const res = await create.mutateAsync({
        documentType: type as ManualDocumentType,
        title: title.trim(),
      });
      onCreated(res.id);
    } catch (err) {
      setError(describeError(err).detail ?? "Failed to create document.");
    }
  };

  return (
    <Card
      title="New document"
      subtitle="Pick a type and give it a title — you’ll fill in the details next."
    >
      <div className="p-5 space-y-4">
        <div>
          <Label htmlFor="docType">Document type</Label>
          {loadingTypes ? (
            <Spinner label="Loading types…" />
          ) : typesError != null ? (
            <div className="flex items-center gap-3">
              <span className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
                Couldn’t load the document types.{" "}
                {describeError(typesError).detail}
              </span>
              <Button
                intent="secondary"
                size="sm"
                isLoading={retryingTypes}
                onClick={onRetryTypes}
              >
                Try again
              </Button>
            </div>
          ) : (
            <Select
              id="docType"
              value={type}
              onChange={(e) => setType(e.target.value)}
              emptyOptionLabel="Choose a type…"
              options={types.map((t) => ({ value: t.type, label: t.label }))}
            />
          )}
          {def && (
            <p className="text-xs mt-1" style={{ color: "hsl(var(--ink-3))" }}>
              {def.description}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="docTitle">Title</Label>
          <Input
            id="docTitle"
            placeholder="e.g. Certificate of Medical Necessity"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {error && (
          <div className="text-sm" style={{ color: "hsl(0 70% 45%)" }}>
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={handleCreate} isLoading={create.isPending}>
            Create &amp; edit
          </Button>
          <Button intent="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
