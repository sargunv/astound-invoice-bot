import * as cheerio from "cheerio";
import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import { parseAstoundConfig } from "./config-schema";

const DEFAULT_BASE_URL = "https://my.astound.com";
const PDF_PATH_PREFIX = "/billing/pdf/";
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type CookieFetch = (
  input: string | URL | Request,
  init?: RequestInit & { maxRedirect?: number },
) => Promise<Response>;

export class AstoundPortalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AstoundPortalError";
  }
}

export const parseAuthenticityToken = (html: string) => {
  const $ = cheerio.load(html);
  const authenticityToken = $('input[name="authenticity_token"]').val();

  if (typeof authenticityToken !== "string" || authenticityToken.length === 0) {
    throw new AstoundPortalError("Authenticity token not found on the login page");
  }

  return authenticityToken;
};

const isLoginPage = ($: cheerio.CheerioAPI) =>
  $('form[action*="/login/login"]').length > 0 ||
  ($('input[name="username"]').length > 0 && $('input[name="password"]').length > 0);

export const parseBillsPage = (html: string, baseUrl = DEFAULT_BASE_URL) => {
  const $ = cheerio.load(html);
  if (isLoginPage($)) {
    throw new AstoundPortalError("Astound returned the login page instead of an authenticated bills page");
  }

  const expectedOrigin = new URL(baseUrl).origin;
  const paths = Array.from(
    new Set(
      $(`a[href^="${PDF_PATH_PREFIX}"]`)
        .map((_index, element) => {
          const href = $(element).attr("href");
          if (!href) return undefined;

          const url = new URL(href, baseUrl);
          if (url.origin !== expectedOrigin || !url.pathname.startsWith(PDF_PATH_PREFIX)) {
            throw new AstoundPortalError(`Rejected unexpected invoice URL: ${href}`);
          }

          return `${url.pathname}${url.search}`;
        })
        .get()
        .filter((path): path is string => typeof path === "string"),
    ),
  );

  if (paths.length > 0) {
    return paths;
  }

  const billingContainer = $(
    "main, #billing, #billing-content, .billing-content, [data-page='billing']",
  ).first();
  const hasBillingHeading =
    billingContainer
      .find("h1, h2")
      .filter((_index, element) =>
        /\b(?:bills?|billing|statements?|invoices?)\b/i.test($(element).text()),
      ).length > 0;
  const pageText = billingContainer.text().replace(/\s+/g, " ").trim();
  const recognizedEmptyState =
    hasBillingHeading &&
    (/\bno (?:bills|statements|invoices)(?: are)? (?:available|found)\b/i.test(pageText) ||
      /\b(?:don't|do not) have any (?:bills|statements|invoices)\b/i.test(pageText));

  if (!recognizedEmptyState) {
    const title = $("title").text().trim() || "untitled page";
    throw new AstoundPortalError(
      `Bills page format was not recognized (${title}); refusing to treat it as an empty account`,
    );
  }

  return [];
};

type AstoundClientOptions = {
  username: string;
  password: string;
  timeoutMs?: number;
  maxPdfBytes?: number;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export class AstoundClient {
  private readonly baseUrl: URL;
  private readonly cookieFetch: CookieFetch;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly maxPdfBytes: number;
  private cachedBillsPage?: string[];

  constructor(options: AstoundClientOptions) {
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    this.username = options.username;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxPdfBytes = options.maxPdfBytes ?? 10 * 1024 * 1024;

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    // Browsers ignore malformed or cross-domain Set-Cookie values. Astound currently
    // emits a legacy corp.rcn.net cookie from my.astound.com, so mirror that behavior.
    this.cookieFetch = makeFetchCookie(fetchImpl, new CookieJar(), true) as CookieFetch;
  }

  private async request(path: string, init: RequestInit = {}) {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new AstoundPortalError(`Refusing to request a URL outside ${this.baseUrl.origin}`);
    }

    const retries = !init.method || init.method === "GET" ? 1 : 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.requestFollowingSafeRedirects(url, init);

        if (attempt < retries && (response.status === 429 || response.status >= 500)) {
          await response.body?.cancel();
          await Bun.sleep(250 * (attempt + 1));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt === retries || error instanceof AstoundPortalError) throw error;
        await Bun.sleep(250 * (attempt + 1));
      }
    }

    throw lastError;
  }

  private async requestFollowingSafeRedirects(startUrl: URL, init: RequestInit) {
    let currentUrl = startUrl;
    let currentMethod = init.method;
    let currentBody = init.body;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    if (!headers["accept"]) {
      headers["accept"] = "text/html,application/pdf;q=0.9,*/*;q=0.8";
    }
    if (!headers["user-agent"]) {
      headers["user-agent"] = "astound-invoice-bot/1.0";
    }

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const controller = init.signal ? undefined : new AbortController();
      const timeout = controller
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;
      let response: Response;
      try {
        response = await this.cookieFetch(currentUrl, {
          ...init,
          method: currentMethod,
          body: currentBody,
          headers,
          redirect: "manual",
          signal: init.signal ?? controller?.signal,
        });
      } catch (error) {
        if (controller?.signal.aborted) {
          throw new AstoundPortalError(
            `Astound request timed out after ${this.timeoutMs}ms: ${currentUrl.pathname}`,
          );
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects === MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new AstoundPortalError(`Astound exceeded ${MAX_REDIRECTS} redirects`);
      }

      const redirectUrl = new URL(location, currentUrl);
      if (redirectUrl.origin !== this.baseUrl.origin) {
        await response.body?.cancel();
        throw new AstoundPortalError(
          `Refusing Astound redirect outside its origin to ${redirectUrl.origin}`,
        );
      }

      await response.body?.cancel();
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod?.toUpperCase() === "POST")
      ) {
        currentMethod = "GET";
        currentBody = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      currentUrl = redirectUrl;
    }

    throw new AstoundPortalError(`Astound exceeded ${MAX_REDIRECTS} redirects`);
  }

  private async fetchBillsPage() {
    const response = await this.request("/billing/bills");
    if (!response.ok) {
      throw new AstoundPortalError(
        `Failed to fetch bills page: ${response.status} ${response.statusText}`,
      );
    }

    const finalPath = new URL(response.url).pathname;
    if (finalPath.startsWith("/login")) {
      throw new AstoundPortalError("Astound login failed or the session was not accepted");
    }

    return parseBillsPage(await response.text(), this.baseUrl.href);
  }

  async getAuthenticityToken() {
    const response = await this.request("/login");
    if (!response.ok) {
      throw new AstoundPortalError(
        `Failed to fetch login page: ${response.status} ${response.statusText}`,
      );
    }

    return parseAuthenticityToken(await response.text());
  }

  async login(authenticityToken: string) {
    const response = await this.request("/login/login", {
      method: "POST",
      body: new URLSearchParams({
        utf8: "✓",
        authenticity_token: authenticityToken,
        username: this.username,
        password: this.password,
        button: "",
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      throw new AstoundPortalError(`Login failed: ${response.status} ${response.statusText}`);
    }

    await response.body?.cancel();
    this.cachedBillsPage = await this.fetchBillsPage();
  }

  async getInvoicePdfUrls() {
    const billsPage = this.cachedBillsPage ?? (await this.fetchBillsPage());
    this.cachedBillsPage = undefined;
    return billsPage;
  }

  async downloadInvoicePdf(path: string) {
    const requestedUrl = new URL(path, this.baseUrl);
    if (
      requestedUrl.origin !== this.baseUrl.origin ||
      !requestedUrl.pathname.startsWith(PDF_PATH_PREFIX)
    ) {
      throw new AstoundPortalError(`Rejected unexpected invoice path: ${path}`);
    }

    const response = await this.request(`${requestedUrl.pathname}${requestedUrl.search}`);
    if (!response.ok) {
      throw new AstoundPortalError(
        `Failed to download invoice PDF: ${response.status} ${response.statusText}`,
      );
    }

    const finalUrl = new URL(response.url);
    if (!finalUrl.pathname.startsWith(PDF_PATH_PREFIX)) {
      throw new AstoundPortalError(`Invoice download redirected to ${finalUrl.pathname}`);
    }

    const contentLength = response.headers.get("content-length");
    const declaredLength = contentLength === null ? undefined : Number(contentLength);
    if (
      declaredLength !== undefined &&
      Number.isFinite(declaredLength) &&
      declaredLength > this.maxPdfBytes
    ) {
      await response.body?.cancel();
      throw new AstoundPortalError(`Invoice PDF exceeds the ${this.maxPdfBytes}-byte limit`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html")) {
      await response.body?.cancel();
      throw new AstoundPortalError("Invoice download returned HTML instead of a PDF");
    }

    if (!response.body) {
      throw new AstoundPortalError("Invoice download returned an empty response body");
    }

    const chunks: Buffer[] = [];
    const reader = response.body.getReader();
    let receivedBytes = 0;
    while (true) {
      let readTimeout: ReturnType<typeof setTimeout> | undefined;
      const read = reader.read();
      const timeout = new Promise<never>((_resolve, reject) => {
        readTimeout = setTimeout(
          () =>
            reject(
              new AstoundPortalError(
                `Invoice PDF stalled for ${this.timeoutMs}ms: ${requestedUrl.pathname}`,
              ),
            ),
          this.timeoutMs,
        );
      });

      const { done, value } = await (async () => {
        try {
          return await Promise.race([read, timeout]);
        } catch (error) {
          await reader.cancel();
          throw error;
        } finally {
          if (readTimeout) clearTimeout(readTimeout);
        }
      })();
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > this.maxPdfBytes) {
        await reader.cancel();
        throw new AstoundPortalError(
          `Invoice PDF exceeds the ${this.maxPdfBytes}-byte limit`,
        );
      }
      chunks.push(Buffer.from(value));
    }

    const pdf = Buffer.concat(chunks, receivedBytes);
    if (pdf.byteLength < 5 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new AstoundPortalError("Invoice download did not contain a valid PDF signature");
    }

    return pdf;
  }
}

let defaultClient: AstoundClient | undefined;
const getDefaultClient = () => {
  const config = parseAstoundConfig(process.env);
  defaultClient ??= new AstoundClient({
    username: config.ASTOUND_USERNAME,
    password: config.ASTOUND_PASSWORD,
    timeoutMs: config.ASTOUND_HTTP_TIMEOUT_MS,
    maxPdfBytes: config.ASTOUND_MAX_PDF_BYTES,
  });
  return defaultClient;
};

export const getAuthenticityToken = () => getDefaultClient().getAuthenticityToken();
export const login = (authenticityToken: string) =>
  getDefaultClient().login(authenticityToken);
export const getInvoicePdfUrls = () => getDefaultClient().getInvoicePdfUrls();
export const downloadInvoicePdf = (path: string) =>
  getDefaultClient().downloadInvoicePdf(path);
