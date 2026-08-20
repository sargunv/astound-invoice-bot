import { AstoundClient } from "./astound";
import { parseAstoundConfig } from "./config-schema";

const config = parseAstoundConfig(process.env);
const client = new AstoundClient({
  username: config.ASTOUND_USERNAME,
  password: config.ASTOUND_PASSWORD,
  timeoutMs: config.ASTOUND_HTTP_TIMEOUT_MS,
  maxPdfBytes: config.ASTOUND_MAX_PDF_BYTES,
});

const token = await client.getAuthenticityToken();
await client.login(token);
const invoicePaths = await client.getInvoicePdfUrls();

console.info(
  `Astound smoke check passed: authenticated bills page contained ${invoicePaths.length} invoice link(s).`,
);
