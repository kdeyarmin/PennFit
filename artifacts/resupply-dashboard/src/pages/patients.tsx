import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getListPatientsQueryKey,
  ListPatientsStatus,
  useListPatients,
} from "@workspace/resupply-api-client";
import type { ListPatientsParams } from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import { Badge, humanizeStatus, patientStatusVariant } from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Pagination } from "../components/Pagination";
import { Input, Label, Select } from "../components/Input";
import { Button } from "../components/Button";
import { fullName, formatDateTime } from "../lib/format";

const PAGE_SIZE = 25;

const STATUS_OPTIONS = Object.values(ListPatientsStatus).map((v) => ({
  value: v,
  label: humanizeStatus(v),
}));

type PatientRow = {
  id: string;
  pacwareId: string;
  firstName: string;
  lastName: string;
  status: string;
  hasPhone: boolean;
  hasEmail: boolean;
  updatedAt: string;
};

export function PatientsPage() {
  const [, setLocation] = useLocation();

  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  // Debounce the search input so we don't hammer the API while the
  // operator is mid-type. The committed string is what drives the
  // query params; the input value is purely UI state.
  const [search, setSearch] = useState<string>("");
  const [offset, setOffset] = useState<number>(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const params: ListPatientsParams = useMemo(
    () => ({
      ...(statusFilter
        ? { status: statusFilter as keyof typeof ListPatientsStatus }
        : {}),
      ...(search ? { search } : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [statusFilter, search, offset],
  );

  const { data, isPending, isError, error, isFetching, refetch } =
    useListPatients(params, {
      query: {
        queryKey: getListPatientsQueryKey(params),
        placeholderData: keepPreviousData,
      },
    });

  const columns: Column<PatientRow>[] = [
    {
      key: "name",
      header: "Patient",
      render: (r) => (
        <div>
          <div className="font-semibold" style={{ color: "#0a1f44" }}>
            {fullName(r.firstName, r.lastName)}
          </div>
          <div className="text-xs" style={{ color: "#6b7280" }}>
            PAC #{r.pacwareId}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={patientStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "channels",
      header: "Channels",
      render: (r) => (
        <div className="flex gap-1.5">
          {r.hasPhone && <Badge variant="info">SMS / Voice</Badge>}
          {r.hasEmail && <Badge variant="neutral">Email</Badge>}
          {!r.hasPhone && !r.hasEmail && <Badge variant="muted">None</Badge>}
        </div>
      ),
    },
    {
      key: "updatedAt",
      header: "Updated",
      render: (r) => (
        <span className="text-xs" style={{ color: "#6b7280" }}>
          {formatDateTime(r.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-semibold mb-1"
            style={{ color: "#0a1f44" }}
          >
            Patients
          </h1>
          <p className="text-sm" style={{ color: "#374151" }}>
            Search and review the patient roster. Names decrypted server-side;
            phone and email are only shown as channel availability.
          </p>
        </div>
      </header>

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="patients-search">Search</Label>
            <Input
              id="patients-search"
              type="search"
              placeholder="Name or PACware ID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="patients-status">Status</Label>
            <Select
              id="patients-status"
              value={statusFilter}
              emptyOptionLabel="All statuses"
              options={STATUS_OPTIONS}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          <div className="flex items-end">
            <Button
              intent="ghost"
              size="sm"
              onClick={() => {
                setStatusFilter("");
                setSearchInput("");
                setSearch("");
                setOffset(0);
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>
      </Card>

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading patients…" />
          ) : (
            <>
              <Table
                columns={columns}
                rows={data.items}
                rowKey={(r) => r.id}
                onRowClick={(r) => setLocation(`/patients/${r.id}`)}
                emptyState={
                  <EmptyState
                    title="No patients match this view."
                    hint="Adjust filters or clear them to see the full roster."
                  />
                }
              />
              <Pagination
                total={data.total}
                limit={data.limit}
                offset={data.offset}
                onChange={setOffset}
                isLoading={isFetching}
              />
            </>
          )}
        </Card>
      )}
    </div>
  );
}
