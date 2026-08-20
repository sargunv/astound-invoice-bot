import { describe, expect, test } from "bun:test";
import { deliverInvoices } from "../src/main";

describe("invoice delivery orchestration", () => {
  test("delivers healthy invoices around a failed download", async () => {
    const sent: string[][] = [];
    const processed: string[][] = [];
    let lockChecks = 0;

    const failures = await deliverInvoices(
      ["first", "broken", "second"],
      { maxAttachments: 2, maxBytes: 10_000 },
      {
        async download(path) {
          if (path === "broken") throw new Error("invalid PDF");
          return Buffer.from("%PDF-fixture");
        },
        async send(attachments) {
          sent.push(Array.from(attachments.keys()));
        },
        markProcessed(paths) {
          processed.push(paths);
        },
        assertLock() {
          lockChecks += 1;
        },
      },
    );

    expect(sent).toEqual([["first", "second"]]);
    expect(processed).toEqual(sent);
    expect(lockChecks).toBe(1);
    expect(failures.map(({ message }) => message)).toEqual([
      "Could not process broken: invalid PDF",
    ]);
  });

  test("uses the production count and encoded-size batching rules", async () => {
    const sent: string[][] = [];

    await deliverInvoices(
      ["one", "two", "three"],
      { maxAttachments: 2, maxBytes: 2056 },
      {
        async download() {
          return Buffer.alloc(3);
        },
        async send(attachments) {
          sent.push(Array.from(attachments.keys()));
        },
        markProcessed() {},
        assertLock() {},
      },
    );

    expect(sent).toEqual([["one", "two"], ["three"]]);
  });

  test("does not mark a batch when SMTP rejects it", async () => {
    let marked = false;

    await expect(
      deliverInvoices(["one"], { maxAttachments: 1, maxBytes: 10_000 }, {
        async download() {
          return Buffer.from("%PDF-fixture");
        },
        async send() {
          throw new Error("SMTP rejected");
        },
        markProcessed() {
          marked = true;
        },
        assertLock() {},
      }),
    ).rejects.toThrow("SMTP rejected");
    expect(marked).toBe(false);
  });
});
