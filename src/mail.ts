import nodemailer from "nodemailer";
import { config } from "./config";

export const smtp = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: {
    user: config.SMTP_USER,
    pass: config.SMTP_PASSWORD,
  },
});

export const sendEmail = async (attachments: Map<string, Buffer>) => {
  return await smtp.sendMail({
    from: config.EMAIL_FROM,
    to: config.EMAIL_TO,
    subject: config.EMAIL_SUBJECT,
    text: config.EMAIL_TEXT,
    attachments: Array.from(attachments.entries()).map(([path, pdf]) => ({
      filename: path.split("/").pop()!!,
      content: pdf,
    })),
  });
};
