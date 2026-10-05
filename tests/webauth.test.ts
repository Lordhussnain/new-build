// tests/webauth.test.ts — web UI token authentication.

import { describe, expect, test } from "bun:test";
import { extractWebToken, isAuthorized, timingSafeEq } from "../src/web";
import { DEFAULT_CONFIG, type Config } from "../src/config";

function req(path: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(path);
  return [new Request(url, { headers }), url];
}

const withToken = (token: string): Config => ({ ...DEFAULT_CONFIG, webToken: token });

describe("extractWebToken", () => {
  test("reads the Authorization: Bearer header", () => {
    const [r, url] = req("http://x/api/status", { authorization: "Bearer secret123" });
    expect(extractWebToken(r, url)).toBe("secret123");
  });

  test("reads the X-Web-Token header", () => {
    const [r, url] = req("http://x/api/status", { "x-web-token": "headertoken" });
    expect(extractWebToken(r, url)).toBe("headertoken");
  });

  test("reads the ?token= query parameter", () => {
    const [r, url] = req("http://x/api/status?token=querytoken");
    expect(extractWebToken(r, url)).toBe("querytoken");
  });

  test("reads the yta_token cookie", () => {
    const [r, url] = req("http://x/api/status", { cookie: "other=1; yta_token=cookietoken; x=2" });
    expect(extractWebToken(r, url)).toBe("cookietoken");
  });

  test("returns null when nothing is presented", () => {
    const [r, url] = req("http://x/api/status");
    expect(extractWebToken(r, url)).toBeNull();
  });
});

describe("timingSafeEq", () => {
  test("compares equal strings", () => {
    expect(timingSafeEq("abc", "abc")).toBe(true);
    expect(timingSafeEq("", "")).toBe(true);
  });

  test("rejects different strings, including different lengths", () => {
    expect(timingSafeEq("abc", "abd")).toBe(false);
    expect(timingSafeEq("abc", "abcd")).toBe(false);
    expect(timingSafeEq("", "a")).toBe(false);
  });
});

describe("isAuthorized", () => {
  test("allows everything when no token is configured", () => {
    const config = { ...DEFAULT_CONFIG, webToken: "" };
    const [r, url] = req("http://x/api/status");
    expect(isAuthorized(r, url, config)).toBe(true);
  });

  test("requires the token via any accepted channel", () => {
    const config = withToken("s3cret");
    expect(isAuthorized(...req("http://x/", { authorization: "Bearer s3cret" }), config)).toBe(true);
    expect(isAuthorized(...req("http://x/", { "x-web-token": "s3cret" }), config)).toBe(true);
    expect(isAuthorized(...req("http://x/?token=s3cret"), config)).toBe(true);
    expect(isAuthorized(...req("http://x/", { cookie: "yta_token=s3cret" }), config)).toBe(true);
  });

  test("rejects a wrong or missing token", () => {
    const config = withToken("s3cret");
    expect(isAuthorized(...req("http://x/"), config)).toBe(false);
    expect(isAuthorized(...req("http://x/", { authorization: "Bearer wrong" }), config)).toBe(false);
    expect(isAuthorized(...req("http://x/?token=nope"), config)).toBe(false);
  });
});
