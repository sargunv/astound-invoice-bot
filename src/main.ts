import { downloadInvoicePdf, getAuthenticityToken, getInvoicePdfUrls as getInvoicePdfPaths, login } from "./astound";
import { getConfig } from "./config";
import {
  acquireRunLock,
  getDeliveryNamespace,
  hasBeenProcessed,
  markBatchAsProcessed,
  refreshRunLock,
  releaseRunLock,
} from "./db";
import { estimateAttachmentWireBytes, sendEmail, verifySmtp } from "./mail";

type DeliveryDependencies = {
  download(path: string): Promise<Buffer>;
  send(attachments: Map<string, Buffer>): Promise<void>;
  markProcessed(paths: string[]): void;
  assertLock(): void;
};

export const deliverInvoices = async (
  paths: string[],
  limits: { maxAttachments: number; maxBytes: number },
  dependencies: DeliveryDependencies,
) => {
  let batch = new Map<string, Buffer>();
  let batchBytes = 0;
  const failures: Error[] = [];

  const flush = async () => {
    if (batch.size === 0) return;
    dependencies.assertLock();
    await dependencies.send(batch);
    dependencies.markProcessed(Array.from(batch.keys()));
    batch = new Map();
    batchBytes = 0;
  };

  for (const path of paths) {
    let pdf: Buffer;
    let wireBytes: number;
    try {
      pdf = await dependencies.download(path);
      wireBytes = estimateAttachmentWireBytes(pdf.byteLength);
      if (wireBytes > limits.maxBytes) {
        throw new Error("Invoice exceeds the encoded email byte limit");
      }
    } catch (error) {
      failures.push(
        new Error(
          `Could not process ${path}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }

    if (
      batch.size > 0 &&
      (batch.size >= limits.maxAttachments ||
        batchBytes + wireBytes > limits.maxBytes)
    ) {
      await flush();
    }

    batch.set(path, pdf);
    batchBytes += wireBytes;
    if (
      batch.size >= limits.maxAttachments ||
      batchBytes >= limits.maxBytes
    ) {
      await flush();
    }
  }

  await flush();
  return failures;
};

export const main = async ({ dryRun = false }: { dryRun?: boolean } = {}) => {
  const config = dryRun ? undefined : getConfig();
  const runId = crypto.randomUUID();
  if (!dryRun && !acquireRunLock(runId)) {
    throw new Error(
      "Another invoice-bot run holds the delivery lock; wait for it to finish or for the lock TTL to expire",
    );
  }

  let lockLost = false;
  const heartbeat = dryRun
    ? undefined
    : setInterval(() => {
        try {
          if (!refreshRunLock(runId)) lockLost = true;
        } catch (error) {
          console.warn("Could not refresh the delivery lock; the next send will recheck it", error);
        }
      }, Math.max(250, Math.floor((config!.RUN_LOCK_TTL_SECONDS * 1000) / 3)));
  heartbeat?.unref();

  const assertRunLock = () => {
    if (dryRun) return;
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

    const deliveryConfig = config!;
    assertRunLock();
    console.info("Verifying SMTP...");
    await verifySmtp();

    const deliveryNamespace = getDeliveryNamespace();
    let batchNumber = 0;
    const failures = await deliverInvoices(
      unprocessedPaths,
      {
        maxAttachments: deliveryConfig.EMAIL_MAX_ATTACHMENTS,
        maxBytes: deliveryConfig.EMAIL_MAX_BYTES,
      },
      {
        async download(path) {
        console.info(`Downloading ${path} ...`);
          const pdf = await downloadInvoicePdf(path);
        console.info(`Downloaded ${pdf.byteLength} bytes`);
          return pdf;
        },
        async send(attachments) {
          batchNumber += 1;
          console.info(
            `Sending email batch ${batchNumber} with ${attachments.size} attachment(s)...`,
          );
          const result = await sendEmail(attachments, deliveryNamespace);
          console.info(`SMTP accepted batch ${batchNumber}: ${result.messageId}`);
        },
        markProcessed: markBatchAsProcessed,
        assertLock: assertRunLock,
      },
    );
    for (const failure of failures) console.error(failure.message);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} invoice(s) failed while healthy invoices were delivered`,
      );
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (!dryRun) releaseRunLock(runId);
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
