/**
 * Where the browser sends API calls.
 *
 * The backend key is attached only by the same-origin `/backend` proxy in
 * middleware.ts, so the browser must never be pointed at the backend directly.
 * On Vercel this used to default to the backend URL: the browser then called
 * Render cross-origin, CORS blocked it, and the Overview showed
 * "TypeError: Failed to fetch" — while every server-side check still passed.
 */
import { getConfig } from "@/shared/lib/server/getConfig";
import { getApiUrlFromConfig } from "@/shared/lib/getApiUrlFromConfig";

describe("getConfig API_URL_CLIENT", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it("routes the browser through the proxy on Vercel", () => {
    process.env.VERCEL_GIT_COMMIT_REF = "main";
    process.env.API_URL = "https://backend.example.onrender.com";
    delete process.env.API_URL_CLIENT;

    const config = getConfig();

    expect(config.API_URL_CLIENT).toBeUndefined();
    expect(getApiUrlFromConfig(config)).toBe("/backend");
  });

  it("routes the browser through the proxy off Vercel", () => {
    delete process.env.VERCEL_GIT_COMMIT_REF;
    delete process.env.API_URL_CLIENT;

    expect(getApiUrlFromConfig(getConfig())).toBe("/backend");
  });

  it("still honours an explicit API_URL_CLIENT override", () => {
    process.env.VERCEL_GIT_COMMIT_REF = "main";
    process.env.API_URL_CLIENT = "/custom-proxy";

    expect(getApiUrlFromConfig(getConfig())).toBe("/custom-proxy");
  });
});
