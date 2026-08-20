import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { Config } from "./config-schema";
import { getConfig } from "./config";

export type InvoiceAttachments = Map<string, Buffer>;

const MIME_PART_OVERHEAD_BYTES = 1024;

export const estimateAttachmentWireBytes = (rawBytes: number) =>
  Math.ceil(rawBytes / 3) * 4 + MIME_PART_OVERHEAD_BYTES;

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

const messageIdDomain = (from: string, smtpHost: string) =>
  from.match(/@([a-z0-9.-]+)>?\s*$/i)?.[1] ?? smtpHost;

const deterministicMessageId = (
  namespace: string,
  paths: Iterable<string>,
  domain: string,
) => {
  const digest = createHash("sha256")
    .update(namespace)
    .update("\n")
    .update(Array.from(paths).sort().join("\n"))
    .digest("hex");
  return `<astound-${digest}@${domain}>`;
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
  config: Pick<
    MailConfig,
    "SMTP_HOST" | "EMAIL_FROM" | "EMAIL_TO" | "EMAIL_SUBJECT" | "EMAIL_TEXT"
  >,
  attachments: InvoiceAttachments,
  deliveryNamespace: string,
) => {
  if (attachments.size === 0) {
    throw new Error("Refusing to send an invoice email without attachments");
  }

  return {
    from: config.EMAIL_FROM,
    to: config.EMAIL_TO,
    subject: config.EMAIL_SUBJECT,
    text: config.EMAIL_TEXT,
    messageId: deterministicMessageId(
      deliveryNamespace,
      attachments.keys(),
      messageIdDomain(config.EMAIL_FROM, config.SMTP_HOST),
    ),
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

  private async withDeadline<T>(operation: Promise<T>, label: string) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.smtp.close();
        reject(new Error(`${label} exceeded the ${this.config.SMTP_TIMEOUT_MS}ms deadline`));
      }, this.config.SMTP_TIMEOUT_MS);
    });

    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  verify() {
    return this.withDeadline(this.smtp.verify(), "SMTP verification");
  }

  async sendEmail(
    attachments: InvoiceAttachments,
    deliveryNamespace: string,
  ) {
    const result = await this.withDeadline(
      this.smtp.sendMail(
        buildInvoiceMessage(this.config, attachments, deliveryNamespace),
      ),
      "SMTP delivery",
    );
    if (result.rejected.length > 0) {
      throw new Error(`SMTP rejected ${result.rejected.length} recipient(s)`);
    }
    return result;
  }
}

let defaultClient: MailClient | undefined;
const getDefaultClient = () => {
  defaultClient ??= new MailClient(getConfig());
  return defaultClient;
};

export const verifySmtp = () => getDefaultClient().verify();
export const sendEmail = (
  attachments: InvoiceAttachments,
  deliveryNamespace: string,
) => getDefaultClient().sendEmail(attachments, deliveryNamespace);
