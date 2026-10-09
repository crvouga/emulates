/*! Adapted from vercel-labs/emulate (Apache-2.0), modified for Mockingbird. See port.json, LICENSE_EMULATE and THIRD_PARTY_NOTICES.md. */
import { Buffer } from "buffer";
import type { Context, Next } from "../http.js";

import { importPKCS8, importJWK, exportJWK, jwtVerify } from "jose";
import { debug } from "../debug.js";

export interface AuthUser {
  login: string;
  id: number;
  scopes: string[];
  installation?: AuthInstallation;
}

export interface AuthApp {
  appId: number;
  slug: string;
  name: string;
}

export interface AuthInstallation {
  installationId: number;
  appId: number;
  accountId: number;
  accountType: "User" | "Organization";
  permissions: Record<string, string>;
  repositoryIds: number[];
  repositorySelection: "all" | "selected";
}

export type TokenMap = Map<string, AuthUser>;

export interface TokenEntry {
  token: string;
  login: string;
  id: number;
  scopes: string[];
  installation?: AuthInstallation;
}

export function serializeTokenMap(tokenMap: TokenMap): TokenEntry[] {
  return [...tokenMap.entries()].map(([token, user]) => ({
    token,
    login: user.login,
    id: user.id,
    scopes: user.scopes,
    ...(user.installation ? { installation: user.installation } : {}),
  }));
}

export function restoreTokenMap(tokenMap: TokenMap, tokens: TokenEntry[]): void {
  tokenMap.clear();
  for (const t of tokens) {
    tokenMap.set(t.token, {
      login: t.login,
      id: t.id,
      scopes: t.scopes,
      ...(t.installation ? { installation: t.installation } : {}),
    });
  }
}

export type AppEnv = {
  Variables: {
    authUser?: AuthUser;
    authApp?: AuthApp;
    authToken?: string;
    authScopes?: string[];
    docsUrl?: string;
  };
};

export interface AppKeyResolver {
  (appId: number): { privateKey: string; slug: string; name: string } | null;
}

export interface AuthFallback {
  login: string;
  id: number;
  scopes: string[];
}

export function authMiddleware(tokens: TokenMap, appKeyResolver?: AppKeyResolver, fallbackUser?: AuthFallback, now: () => number = Date.now) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      const token = authHeader.replace(/^(Bearer|token)\s+/i, "").trim();

      if (token.startsWith("eyJ") && appKeyResolver) {
        try {
          const [, payloadB64] = token.split(".");
          const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString());
          const appId = typeof payload.iss === "string" ? parseInt(payload.iss, 10) : payload.iss;

          if (typeof appId === "number" && !isNaN(appId)) {
            const appInfo = appKeyResolver(appId);
            if (appInfo) {
              const privateKey = await importPKCS8(pkcs8Pem(appInfo.privateKey), "RS256", {extractable:true});
              const { kty, n, e } = await exportJWK(privateKey);
              const publicKey = await importJWK({ kty, n, e }, "RS256");
              await jwtVerify(token, publicKey, { algorithms: ["RS256"], currentDate: new Date(now()) });
              c.set("authApp", {
                appId,
                slug: appInfo.slug,
                name: appInfo.name,
              } satisfies AuthApp);
            }
          }
        } catch {
          // JWT verification failed
        }
      } else {
        let user = tokens.get(token);
        if (!user && fallbackUser && token.length > 0) {
          debug("auth", "fallback user for unknown token", { login: fallbackUser.login, id: fallbackUser.id });
          user = { login: fallbackUser.login, id: fallbackUser.id, scopes: fallbackUser.scopes };
        }
        if (user) {
          c.set("authUser", user);
          c.set("authToken", token);
          c.set("authScopes", user.scopes);
        }
      }
    }
    await next();
  };
}

/** WebCrypto consumes PKCS8; GitHub App test fixtures also commonly use PKCS1 PEM. */
function pkcs8Pem(pem: string): string {
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return pem;
  const key = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  const length = (size: number): number[] => {
    if (size < 128) return [size];
    const bytes: number[] = [];
    while (size > 0) { bytes.unshift(size & 255); size >>>= 8; }
    return [128 | bytes.length, ...bytes];
  };
  const body = Buffer.concat([Buffer.from([2,1,0,48,13,6,9,42,134,72,134,247,13,1,1,1,5,0,4,...length(key.length)]), key]);
  const der = Buffer.concat([Buffer.from([48,...length(body.length)]), body]);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----`;
}

export function requireAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authUser")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "Requires authentication",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}

export function requireAppAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authApp")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}
