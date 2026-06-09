// @vitest-environment jsdom
//
// Client-side sorting on the shared admin Table primitive.

import { describe, it, expect, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

import { Table, type Column } from "./Table";

interface Row {
  id: string;
  name: string;
  score: number | null;
}

const ROWS: Row[] = [
  { id: "a", name: "Charlie", score: 30 },
  { id: "b", name: "alice", score: 10 },
  { id: "c", name: "Bob", score: null },
];

const columns: Column<Row>[] = [
  {
    key: "name",
    header: "Name",
    sortable: true,
    sortValue: (r) => r.name,
    render: (r) => r.name,
  },
  {
    key: "score",
    header: "Score",
    sortable: true,
    sortValue: (r) => r.score,
    render: (r) => (r.score == null ? "—" : String(r.score)),
  },
  // A plain, non-sortable column to prove it's unaffected.
  { key: "id", header: "ID", render: (r) => r.id },
];

function renderTable() {
  render(<Table columns={columns} rows={ROWS} rowKey={(r) => r.id} />);
}

function bodyOrder(): string[] {
  const tbody = document.querySelector("tbody")!;
  return within(tbody)
    .getAllByRole("row")
    .map((tr) => within(tr).getAllByRole("cell")[2]!.textContent);
}

afterEach(() => cleanup());

describe("Table sorting", () => {
  it("renders unsorted in source order; only sortable columns get a sort button", () => {
    renderTable();
    expect(bodyOrder()).toEqual(["a", "b", "c"]);
    // 2 sortable columns → 2 header buttons.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("toggles ascending → descending → cleared on repeated header clicks", () => {
    renderTable();
    const nameHeaderBtn = screen.getByRole("button", { name: /Name/ });

    // asc: alice, Bob, Charlie  (locale compare, case-insensitive-ish)
    fireEvent.click(nameHeaderBtn);
    expect(bodyOrder()).toEqual(["b", "c", "a"]);
    expect(
      screen.getByText("Name").closest("th")!.getAttribute("aria-sort"),
    ).toBe("ascending");

    // desc
    fireEvent.click(nameHeaderBtn);
    expect(bodyOrder()).toEqual(["a", "c", "b"]);
    expect(
      screen.getByText("Name").closest("th")!.getAttribute("aria-sort"),
    ).toBe("descending");

    // cleared → back to source order
    fireEvent.click(nameHeaderBtn);
    expect(bodyOrder()).toEqual(["a", "b", "c"]);
    expect(
      screen.getByText("Name").closest("th")!.getAttribute("aria-sort"),
    ).toBe("none");
  });

  it("sorts numbers numerically and pushes null/blank values last in both directions", () => {
    renderTable();
    const scoreHeaderBtn = screen.getByRole("button", { name: /Score/ });

    // asc by score: 10 (b), 30 (a), null (c) last
    fireEvent.click(scoreHeaderBtn);
    expect(bodyOrder()).toEqual(["b", "a", "c"]);

    // desc by score: 30 (a), 10 (b), null (c) STILL last
    fireEvent.click(scoreHeaderBtn);
    expect(bodyOrder()).toEqual(["a", "b", "c"]);
  });
});
