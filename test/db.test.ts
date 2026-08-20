import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvoiceStore } from "../src/db";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("InvoiceStore", () => {
  test("deduplicates processed paths across connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astound-invoice-bot-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "invoices.sqlite");
    const first = new InvoiceStore(path);
    const second = new InvoiceStore(path);

    expect(first.hasBeenProcessed("/billing/pdf/one.pdf")).toBe(false);
    first.markAsProcessed("/billing/pdf/one.pdf");
    expect(second.hasBeenProcessed("/billing/pdf/one.pdf")).toBe(true);
    first.markBatchAsProcessed([
      "/billing/pdf/two.pdf",
      "/billing/pdf/three.pdf",
    ]);
    expect(second.hasBeenProcessed("/billing/pdf/two.pdf")).toBe(true);
    expect(second.hasBeenProcessed("/billing/pdf/three.pdf")).toBe(true);

    first.close();
    second.close();
  });

  test("serializes runs and permits takeover only after expiry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "astound-invoice-bot-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "invoices.sqlite");
    const first = new InvoiceStore(path);
    const second = new InvoiceStore(path);

    expect(first.acquireRunLock("first", 1_000, 100)).toBe(true);
    expect(second.acquireRunLock("second", 1_050, 100)).toBe(false);
    expect(first.refreshRunLock("first", 1_075)).toBe(true);
    expect(second.acquireRunLock("second", 1_150, 100)).toBe(false);
    expect(second.acquireRunLock("second", 1_176, 100)).toBe(true);

    first.releaseRunLock("first");
    expect(first.acquireRunLock("first", 1_177, 100)).toBe(false);
    second.releaseRunLock("second");
    expect(first.acquireRunLock("first", 1_178, 100)).toBe(true);

    first.close();
    second.close();
  });
});
