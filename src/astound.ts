import * as cheerio from "cheerio";
import { CookieJar } from "tough-cookie";
import { config } from "./config";

const cookieJar = new CookieJar();

const saveCookiesFromResponse = (response: Response) => {
  const cookies = response.headers.get("set-cookie");
  if (cookies) {
    cookieJar.setCookieSync(cookies, response.url);
  }
};

export const getAuthenticityToken = async () => {
  const response = await fetch("https://my.astound.com/login");

  saveCookiesFromResponse(response);

  if (!response.ok) {
    throw new Error(`Failed to fetch login page: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const authenticityToken = $('input[name="authenticity_token"]').val();

  if (!authenticityToken) {
    throw new Error("Authenticity token not found on the login page");
  }

  if (typeof authenticityToken !== "string") {
    throw new Error("Authenticity token is not a string");
  }

  return authenticityToken;
};

export const login = async (authenticityToken: string) => {
  const response = await fetch("https://my.astound.com/login/login", {
    method: "POST",
    body: new URLSearchParams({
      utf8: "✓",
      authenticity_token: authenticityToken,
      username: config.ASTOUND_USERNAME,
      password: config.ASTOUND_PASSWORD,
      button: "",
    }),
    headers: {
      Cookie: cookieJar.getCookieStringSync("https://my.astound.com"),
    },
  });

  saveCookiesFromResponse(response);
};

export const getInvoicePdfUrls = async () => {
  const response = await fetch("https://my.astound.com/billing/bills", {
    headers: {
      Cookie: cookieJar.getCookieStringSync("https://my.astound.com"),
    },
  });
  saveCookiesFromResponse(response);

  if (!response.ok) {
    throw new Error(`Failed to fetch bills page: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  return $('a[href^="/billing/pdf/"]').map((index, element) => $(element).attr("href")).get();
};

export const downloadInvoicePdf = async (path: string) => {
  const response = await fetch(`https://my.astound.com${path}`, {
    headers: {
      Cookie: cookieJar.getCookieStringSync("https://my.astound.com"),
    },
  });
  saveCookiesFromResponse(response);

  if (!response.ok) {
    throw new Error(`Failed to download invoice pdf: ${response.status} ${response.statusText}`);
  }

  return response.arrayBuffer();
};
