import { z } from "zod";

const schema = z.object({
  ASTOUND_USERNAME: z.string().min(1),
  ASTOUND_PASSWORD: z.string().min(1),
  SQLITE_DB_PATH: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().nonnegative().int().max(65535).default(587),
  SMTP_SECURE: z.coerce.boolean().optional(),
  SMTP_USER: z.string(),
  SMTP_PASSWORD: z.string(),
  EMAIL_FROM: z.string().min(1),
  EMAIL_TO: z.string().min(1),
  EMAIL_SUBJECT: z.string().min(1).default("Astound invoice found"),
  EMAIL_TEXT: z
    .string()
    .min(1)
    .default("New invoices are available; check the attachments."),
});

export const config: z.infer<typeof schema> = schema.parse(process.env);
