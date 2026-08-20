import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config-schema";

const requiredEnvironment = {
  ASTOUND_USERNAME: "user",
  ASTOUND_PASSWORD: "password",
  SQLITE_DB_PATH: ":memory:",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  EMAIL_FROM: "invoices@example.com",
  EMAIL_TO: "receipts@example.com",
};

describe("configuration", () => {
  test("uses safe SMTP and resource defaults", () => {
    const config = parseConfig(requiredEnvironment);

    expect(config.SMTP_PORT).toBe(587);
    expect(config.SMTP_SECURE).toBe(false);
    expect(config.SMTP_REQUIRE_TLS).toBe(true);
    expect(config.ASTOUND_HTTP_TIMEOUT_MS).toBe(15_000);
    expect(config.EMAIL_MAX_ATTACHMENTS).toBe(10);
  });

  test("parses false-like environment strings as false", () => {
    expect(
      parseConfig({
        ...requiredEnvironment,
        SMTP_SECURE: "false",
        SMTP_REQUIRE_TLS: "0",
      }),
    ).toMatchObject({
      SMTP_SECURE: false,
      SMTP_REQUIRE_TLS: false,
    });
  });

  test("rejects invalid ports and empty credentials", () => {
    expect(() =>
      parseConfig({ ...requiredEnvironment, SMTP_PORT: "0" }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...requiredEnvironment, SMTP_PASSWORD: "" }),
    ).toThrow();
  });
});
