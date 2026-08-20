import { z } from "zod";

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

export const configSchema = z.object({
  ASTOUND_USERNAME: z.string().min(1),
  ASTOUND_PASSWORD: z.string().min(1),
  ASTOUND_HTTP_TIMEOUT_MS: positiveInteger(15_000),
  ASTOUND_MAX_PDF_BYTES: positiveInteger(10 * 1024 * 1024),
  SQLITE_DB_PATH: z.string().min(1),
  RUN_LOCK_TTL_SECONDS: positiveInteger(60 * 60),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: z.stringbool().default(false),
  SMTP_REQUIRE_TLS: z.stringbool().default(true),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_TIMEOUT_MS: positiveInteger(30_000),
  EMAIL_FROM: z.string().min(1),
  EMAIL_TO: z.email(),
  EMAIL_SUBJECT: z.string().min(1).default("Astound invoice found"),
  EMAIL_TEXT: z
    .string()
    .min(1)
    .default("New invoices are available; check the attachments."),
  EMAIL_MAX_ATTACHMENTS: positiveInteger(10),
  EMAIL_MAX_BYTES: positiveInteger(20 * 1024 * 1024),
});

export type Config = z.infer<typeof configSchema>;

export const parseConfig = (environment: Record<string, string | undefined>) =>
  configSchema.parse(environment);

export const astoundConfigSchema = configSchema.pick({
  ASTOUND_USERNAME: true,
  ASTOUND_PASSWORD: true,
  ASTOUND_HTTP_TIMEOUT_MS: true,
  ASTOUND_MAX_PDF_BYTES: true,
});

export const parseAstoundConfig = (
  environment: Record<string, string | undefined>,
) => astoundConfigSchema.parse(environment);

export const databaseConfigSchema = configSchema.pick({
  SQLITE_DB_PATH: true,
  RUN_LOCK_TTL_SECONDS: true,
});

export const parseDatabaseConfig = (
  environment: Record<string, string | undefined>,
) => databaseConfigSchema.parse(environment);
