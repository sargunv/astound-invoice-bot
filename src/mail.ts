import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { Config } from "./config-schema";
import { getConfig } from "./config";

export type InvoiceAttachments = Map<string, Buffer>;

export const createAttachmentBatches = (
  attachments: InvoiceAttachments,
  maxAttachments: number,
  maxBytes: number,
) => {
  const batches: InvoiceAttachments[] = [];
  let batch: InvoiceAttachments = new Map();
  let batchBytes = 0;

  for (const [path, pdf] of attachments) {
    if (pdf.byteLength > maxBytes) {
      throw new Error(`Invoice ${path} exceeds the ${maxBytes}-byte email limit`);
    }

    if (batch.size >= maxAttachments || batchBytes + pdf.byteLength > maxBytes) {
      batches.push(batch);
      batch = new Map();
      batchBytes = 0;
    }

    batch.set(path, pdf);
    batchBytes += pdf.byteLength;
  }

  if (batch.size > 0) batches.push(batch);
  return batches;
};

const safeFilename = (path: string) => {
  const rawName = path.split("/").pop()?.split("?")[0] || "invoice.pdf";
  let decodedName = rawName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    // Keep the undecoded URL segment.
  }

  const sanitized = decodedName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.toLowerCase().endsWith(".pdf") ? sanitized : `${sanitized}.pdf`;
};

const deterministicMessageId = (paths: Iterable<string>) => {
  const digest = createHash("sha256")
    .update(Array.from(paths).sort().join("\n"))
    .digest("hex");
  return `<astound-${digest}@invoice-bot.local>`;
};

type MailConfig = Pick<
  Config,
  | "SMTP_HOST"
  | "SMTP_PORT"
  | "SMTP_SECURE"
  | "SMTP_REQUIRE_TLS"
  | "SMTP_USER"
  | "SMTP_PASSWORD"
  | "SMTP_TIMEOUT_MS"
  | "EMAIL_FROM"
  | "EMAIL_TO"
  | "EMAIL_SUBJECT"
  | "EMAIL_TEXT"
>;

export const buildInvoiceMessage = (
  config: Pick<MailConfig, "EMAIL_FROM" | "EMAIL_TO" | "EMAIL_SUBJECT" | "EMAIL_TEXT">,
  attachments: InvoiceAttachments,
) => {
  if (attachments.size === 0) {
    throw new Error("Refusing to send an invoice email without attachments");
  }

  return {
    from: config.EMAIL_FROM,
    to: config.EMAIL_TO,
    subject: config.EMAIL_SUBJECT,
    text: config.EMAIL_TEXT,
    messageId: deterministicMessageId(attachments.keys()),
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: Array.from(attachments.entries()).map(([path, pdf]) => ({
      filename: safeFilename(path),
      content: pdf,
      contentType: "application/pdf",
    })),
  };
};

export class MailClient {
  private readonly config: MailConfig;
  private readonly smtp: nodemailer.Transporter;

  constructor(config: MailConfig) {
    this.config = config;
    this.smtp = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      requireTLS: !config.SMTP_SECURE && config.SMTP_REQUIRE_TLS,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASSWORD,
      },
      connectionTimeout: config.SMTP_TIMEOUT_MS,
      greetingTimeout: config.SMTP_TIMEOUT_MS,
      socketTimeout: config.SMTP_TIMEOUT_MS,
      tls: {
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
      },
    });
  }

  verify() {
    return this.smtp.verify();
  }

  sendEmail(attachments: InvoiceAttachments) {
    return this.smtp.sendMail(buildInvoiceMessage(this.config, attachments));
  }
}

let defaultClient: MailClient | undefined;
const getDefaultClient = () => {
  defaultClient ??= new MailClient(getConfig());
  return defaultClient;
};

export const verifySmtp = () => getDefaultClient().verify();
export const sendEmail = (attachments: InvoiceAttachments) =>
  getDefaultClient().sendEmail(attachments);
