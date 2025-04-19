import { downloadInvoicePdf, getAuthenticityToken, getInvoicePdfUrls as getInvoicePdfPaths, login } from "./astound";
import { hasBeenProcessed, markAsProcessed } from "./db";
import { sendEmail } from "./mail";

const token = await getAuthenticityToken();
await login(token);
console.info("Logged in");

const invoicePdfPaths = await getInvoicePdfPaths();
console.info(`Found ${invoicePdfPaths.length} invoice pdf paths`);

const attachments: Map<string, Buffer> = new Map();
for (const path of invoicePdfPaths) {
  if (!hasBeenProcessed(path)) {
    console.info(`Downloading ${path} ...`);
    const pdf = await downloadInvoicePdf(path);
    console.info(`Downloaded ${pdf.byteLength} bytes`);
    attachments.set(path, Buffer.from(pdf));
  } else {
    console.info(`Skipping ${path} because it has already been processed`);
  }
}

if (attachments.size > 0) {
  console.info(`Sending email with ${attachments.size} attachments...`);
  const result = await sendEmail(attachments);
  console.info(result);

  console.info("Marking sent invoices as processed...");
  for (const path of attachments.keys()) {
    markAsProcessed(path);
  }
} else {
  console.info("No invoices to send");
}

console.info("Done.");
