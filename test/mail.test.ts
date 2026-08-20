import { describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import {
  buildInvoiceMessage,
  estimateAttachmentWireBytes,
  MailClient,
} from "../src/mail";

const emailConfig = {
  SMTP_HOST: "smtp.example.com",
  EMAIL_FROM: "invoices@example.com",
  EMAIL_TO: "receipts@example.com",
  EMAIL_SUBJECT: "New invoice",
  EMAIL_TEXT: "Attached.",
};

describe("invoice email construction", () => {
  test("accounts for base64 and MIME overhead", () => {
    expect(estimateAttachmentWireBytes(3)).toBe(1028);
    expect(estimateAttachmentWireBytes(20 * 1024 * 1024)).toBeGreaterThan(
      25 * 1024 * 1024,
    );
  });

  test("creates safe PDF filenames and deterministic message IDs", () => {
    const first = new Map([
      ["/billing/pdf/Invoice%20August?download=1", Buffer.from("%PDF-fixture")],
      ["/billing/pdf/july.pdf", Buffer.from("%PDF-fixture")],
    ]);
    const second = new Map(Array.from(first).reverse());

    const firstMessage = buildInvoiceMessage(emailConfig, first, "database-one");
    const secondMessage = buildInvoiceMessage(emailConfig, second, "database-one");

    expect(firstMessage.messageId).toBe(secondMessage.messageId);
    expect(
      buildInvoiceMessage(emailConfig, first, "database-two").messageId,
    ).not.toBe(firstMessage.messageId);
    expect(firstMessage.messageId).toEndWith("@example.com>");
    expect(firstMessage.attachments.map(({ filename }) => filename)).toEqual([
      "Invoice_August.pdf",
      "july.pdf",
    ]);
    expect(firstMessage.disableFileAccess).toBe(true);
    expect(firstMessage.disableUrlAccess).toBe(true);
  });

  test("refuses empty messages", () => {
    expect(() => buildInvoiceMessage(emailConfig, new Map(), "database-one")).toThrow(
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
        ...emailConfig,
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: port,
        SMTP_SECURE: false,
        SMTP_REQUIRE_TLS: false,
        SMTP_USER: "unused",
        SMTP_PASSWORD: "unused",
        SMTP_TIMEOUT_MS: 5_000,
      });

      await client.verify();
      const result = await client.sendEmail(
        new Map([["/billing/pdf/test.pdf", Buffer.from("%PDF-fixture")]]),
        "database-one",
      );

      expect(result.accepted).toContain("receipts@example.com");
      expect(receivedMessage).toContain("Content-Type: application/pdf");
      expect(receivedMessage).toContain("filename=test.pdf");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
