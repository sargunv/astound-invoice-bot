import { downloadInvoicePdf, getAuthenticityToken, getInvoicePdfUrls as getInvoicePdfPaths, login } from "./astound";
import { getConfig } from "./config";
import {
  acquireRunLock,
  hasBeenProcessed,
  markBatchAsProcessed,
  refreshRunLock,
  releaseRunLock,
} from "./db";
import { sendEmail, verifySmtp } from "./mail";

export const main = async ({ dryRun = false }: { dryRun?: boolean } = {}) => {
  const config = getConfig();
  const runId = crypto.randomUUID();
  if (!acquireRunLock(runId)) {
    throw new Error(
      "Another invoice-bot run holds the delivery lock; wait for it to finish or for the lock TTL to expire",
    );
  }

  let lockLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!refreshRunLock(runId)) lockLost = true;
    } catch {
      lockLost = true;
    }
  }, Math.max(250, Math.floor((config.RUN_LOCK_TTL_SECONDS * 1000) / 3)));
  heartbeat.unref();

  const assertRunLock = () => {
    if (lockLost || !refreshRunLock(runId)) {
      lockLost = true;
      throw new Error("Invoice delivery lock was lost; stopping before another email is sent");
    }
  };

  try {
    const token = await getAuthenticityToken();
    await login(token);
    console.info("Authenticated with Astound");

    const invoicePdfPaths = await getInvoicePdfPaths();
    console.info(`Found ${invoicePdfPaths.length} invoice PDF paths`);

    const unprocessedPaths = invoicePdfPaths.filter((path) => {
      if (hasBeenProcessed(path)) {
        console.info(`Skipping ${path} because it has already been processed`);
        return false;
      }
      return true;
    });

    if (dryRun) {
      console.info(
        `Dry run: ${unprocessedPaths.length} invoice(s) would be downloaded and emailed`,
      );
      return;
    }

    if (unprocessedPaths.length === 0) {
      console.info("No new invoices to send");
      return;
    }

    assertRunLock();
    console.info("Verifying SMTP...");
    await verifySmtp();

    let batch: Map<string, Buffer> = new Map();
    let batchBytes = 0;
    let batchNumber = 0;
    const deliverBatch = async () => {
      if (batch.size === 0) return;
      assertRunLock();
      batchNumber += 1;
      console.info(`Sending email batch ${batchNumber} with ${batch.size} attachment(s)...`);
      const result = await sendEmail(batch);
      console.info(`SMTP accepted batch ${batchNumber}: ${result.messageId}`);
      markBatchAsProcessed(batch.keys());
      batch = new Map();
      batchBytes = 0;
    };

    for (const path of unprocessedPaths) {
      console.info(`Downloading ${path} ...`);
      const pdf = await downloadInvoicePdf(path);
      console.info(`Downloaded ${pdf.byteLength} bytes`);
      if (pdf.byteLength > config.EMAIL_MAX_BYTES) {
        throw new Error(`Invoice ${path} exceeds the email batch byte limit`);
      }

      if (
        batch.size > 0 &&
        (batch.size >= config.EMAIL_MAX_ATTACHMENTS ||
          batchBytes + pdf.byteLength > config.EMAIL_MAX_BYTES)
      ) {
        await deliverBatch();
      }

      batch.set(path, pdf);
      batchBytes += pdf.byteLength;
      if (
        batch.size >= config.EMAIL_MAX_ATTACHMENTS ||
        batchBytes >= config.EMAIL_MAX_BYTES
      ) {
        await deliverBatch();
      }
    }

    await deliverBatch();
  } finally {
    clearInterval(heartbeat);
    releaseRunLock(runId);
  }
};

if (import.meta.main) {
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--dry-run");
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
  }

  await main({ dryRun: process.argv.includes("--dry-run") });
  console.info("Done.");
}
