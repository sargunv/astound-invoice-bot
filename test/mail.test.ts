import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import {
  buildInvoiceMessage,
  createAttachmentBatches,
  MailClient,
} from "../src/mail";

const emailConfig = {
  EMAIL_FROM: "invoices@example.com",
  EMAIL_TO: "receipts@example.com",
  EMAIL_SUBJECT: "New invoice",
  EMAIL_TEXT: "Attached.",
};

describe("invoice email construction", () => {
  test("batches attachments by count and total bytes", () => {
    const attachments = new Map([
      ["/billing/pdf/one", Buffer.alloc(3)],
      ["/billing/pdf/two", Buffer.alloc(3)],
      ["/billing/pdf/three", Buffer.alloc(3)],
    ]);

    expect(createAttachmentBatches(attachments, 2, 6).map((batch) => batch.size)).toEqual([
      2, 1,
    ]);
    expect(() => createAttachmentBatches(attachments, 2, 2)).toThrow(
      "exceeds the 2-byte email limit",
    );
  });

  test("creates safe PDF filenames and deterministic message IDs", () => {
    const first = new Map([
      ["/billing/pdf/Invoice%20August?download=1", Buffer.from("%PDF-fixture")],
      ["/billing/pdf/july.pdf", Buffer.from("%PDF-fixture")],
    ]);
    const second = new Map(Array.from(first).reverse());

    const firstMessage = buildInvoiceMessage(emailConfig, first);
    const secondMessage = buildInvoiceMessage(emailConfig, second);

    expect(firstMessage.messageId).toBe(secondMessage.messageId);
    expect(firstMessage.attachments.map(({ filename }) => filename)).toEqual([
      "Invoice_August.pdf",
      "july.pdf",
    ]);
    expect(firstMessage.disableFileAccess).toBe(true);
    expect(firstMessage.disableUrlAccess).toBe(true);
  });

  test("refuses empty messages", () => {
    expect(() => buildInvoiceMessage(emailConfig, new Map())).toThrow(
      "without attachments",
    );
  });

  test("verifies and delivers through a local SMTP sink", async () => {
    let receivedMessage = "";
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["AUTH", "STARTTLS"],
      onData(stream, _session, callback) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          receivedMessage += chunk;
        });
        stream.on("end", () => callback());
      },
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.server.address() as AddressInfo;
      const client = new MailClient({
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: port,
        SMTP_SECURE: false,
        SMTP_REQUIRE_TLS: false,
        SMTP_USER: "unused",
        SMTP_PASSWORD: "unused",
        SMTP_TIMEOUT_MS: 5_000,
        ...emailConfig,
      });

      await client.verify();
      const result = await client.sendEmail(
        new Map([["/billing/pdf/test.pdf", Buffer.from("%PDF-fixture")]]),
      );

      expect(result.accepted).toContain("receipts@example.com");
      expect(receivedMessage).toContain("Content-Type: application/pdf");
      expect(receivedMessage).toContain("filename=test.pdf");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
