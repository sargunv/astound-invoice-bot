import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AstoundClient,
  AstoundPortalError,
  parseAuthenticityToken,
  parseBillsPage,
} from "../src/astound";

const fixture = (name: string) =>
  Bun.file(new URL(`fixtures/${name}`, import.meta.url)).text();

const billsHtml = await fixture("bills.html");
const loginHtml = await fixture("login.html");
const emptyBillsHtml = await fixture("empty-bills.html");
const unrecognizedHtml = await fixture("unrecognized.html");

describe("Astound HTML parsing", () => {
  test("extracts the login authenticity token", () => {
    expect(parseAuthenticityToken(loginHtml)).toBe("fixture-csrf-token");
  });

  test("extracts and deduplicates same-origin invoice paths", () => {
    expect(parseBillsPage(billsHtml)).toEqual([
      "/billing/pdf/invoice-2026-07.pdf",
      "/billing/pdf/invoice-2026-08.pdf?download=1",
    ]);
  });

  test("recognizes an explicit empty state", () => {
    expect(parseBillsPage(emptyBillsHtml)).toEqual([]);
  });

  test("rejects login and unknown pages instead of treating them as empty", () => {
    expect(() => parseBillsPage(loginHtml)).toThrow(AstoundPortalError);
    expect(() => parseBillsPage(unrecognizedHtml)).toThrow(
      "refusing to treat it as an empty account",
    );
  });
});

describe("AstoundClient", () => {
  let server: Bun.Server;
  let redirectTarget: Bun.Server;
  let baseUrl: string;
  let crossOriginRequests = 0;

  beforeAll(() => {
    redirectTarget = Bun.serve({
      port: 0,
      fetch() {
        crossOriginRequests += 1;
        return new Response("credentials must never reach this server");
      },
    });

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const cookie = request.headers.get("cookie") ?? "";

        if (url.pathname === "/login") {
          return new Response(loginHtml, {
            headers: [
              ["content-type", "text/html"],
              ["set-cookie", "_session=preflight; Path=/; HttpOnly"],
              ["set-cookie", "theme=light; Path=/"],
            ],
          });
        }

        if (url.pathname === "/login/login" && request.method === "POST") {
          if (!cookie.includes("_session=preflight")) {
            return new Response("missing cookie", { status: 403 });
          }
          const form = await request.formData();
          if (form.get("username") === "cross-origin") {
            return new Response(null, {
              status: 307,
              headers: { location: redirectTarget.url.href },
            });
          }
          return new Response(null, {
            status: 302,
            headers: {
              location: "/dashboard",
              "set-cookie": "_session=authenticated; Path=/; HttpOnly",
            },
          });
        }

        if (url.pathname === "/dashboard") {
          return cookie.includes("_session=authenticated")
            ? new Response("<html><body>Dashboard</body></html>")
            : new Response("forbidden", { status: 403 });
        }

        if (url.pathname === "/billing/bills") {
          return cookie.includes("_session=authenticated")
            ? new Response(billsHtml, { headers: { "content-type": "text/html" } })
            : new Response("forbidden", { status: 403 });
        }

        if (url.pathname === "/billing/pdf/invoice-2026-07.pdf") {
          return new Response("%PDF-1.7\nfixture", {
            headers: { "content-type": "application/pdf" },
          });
        }

        if (url.pathname === "/billing/pdf/not-a-pdf") {
          return new Response("<html>not a PDF</html>", {
            headers: { "content-type": "text/html" },
          });
        }

        if (url.pathname === "/billing/pdf/too-large.pdf") {
          const chunks = [
            new TextEncoder().encode("%PDF-"),
            new TextEncoder().encode("12345"),
            new TextEncoder().encode("more data"),
          ];
          return new Response(
            new ReadableStream({
              pull(controller) {
                const chunk = chunks.shift();
                if (chunk) controller.enqueue(chunk);
                else controller.close();
              },
            }),
            { headers: { "content-type": "application/pdf" } },
          );
        }

        if (url.pathname === "/billing/pdf/slow.pdf") {
          const chunks = ["%PDF-", "slow", "fixture"];
          return new Response(
            new ReadableStream({
              async pull(controller) {
                await Bun.sleep(40);
                const chunk = chunks.shift();
                if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
                else controller.close();
              },
            }),
            { headers: { "content-type": "application/pdf" } },
          );
        }

        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = server.url.origin;
  });

  afterAll(() => {
    server.stop(true);
    redirectTarget.stop(true);
  });

  const authenticatedClient = async (
    options: { maxPdfBytes?: number; timeoutMs?: number } = {},
  ) => {
    const client = new AstoundClient({
      username: "test-user",
      password: "test-password",
      baseUrl,
      ...options,
    });

    const token = await client.getAuthenticityToken();
    await client.login(token);
    return client;
  };

  test("retains cookies across login redirects and validates PDFs", async () => {
    const client = await authenticatedClient();
    expect(await client.getInvoicePdfUrls()).toHaveLength(2);

    const pdf = await client.downloadInvoicePdf(
      "/billing/pdf/invoice-2026-07.pdf",
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");

    await expect(
      client.downloadInvoicePdf("/billing/pdf/not-a-pdf"),
    ).rejects.toThrow("returned HTML");
  });

  test("rejects cross-origin redirects before forwarding credentials", async () => {
    const client = new AstoundClient({
      username: "cross-origin",
      password: "must-not-leak",
      baseUrl,
    });

    const token = await client.getAuthenticityToken();
    await expect(client.login(token)).rejects.toThrow(
      "redirect outside its origin",
    );
    expect(crossOriginRequests).toBe(0);
  });

  test("stops reading chunked PDFs at the configured byte limit", async () => {
    const client = await authenticatedClient({ maxPdfBytes: 8 });
    await expect(
      client.downloadInvoicePdf("/billing/pdf/too-large.pdf"),
    ).rejects.toThrow("exceeds the 8-byte limit");
  });

  test("uses the HTTP timeout as an inactivity limit while streaming", async () => {
    const client = await authenticatedClient({ timeoutMs: 75 });
    const startedAt = performance.now();
    const pdf = await client.downloadInvoicePdf("/billing/pdf/slow.pdf");

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(performance.now() - startedAt).toBeGreaterThan(100);
  });
});
