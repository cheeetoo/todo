// A small Google Calendar client over Obsidian's requestUrl, which works on
// phones too. Signing in needs a local web server, so it's desktop only; the
// refresh token it yields is all the other devices need.

import { requestUrl } from "obsidian";
import type { EventBody } from "./plan";

const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar";

export interface Account {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface LiveEvent extends Partial<EventBody> {
  id: string;
}

export class GoogleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

export class Google {
  private account: Account;
  private access: { token: string; expires: number } | null = null;

  constructor(account: Account) {
    this.account = account;
  }

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.access.expires) return this.access.token;
    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        client_id: this.account.clientId,
        client_secret: this.account.clientSecret,
        refresh_token: this.account.refreshToken,
        grant_type: "refresh_token",
      }),
      throw: false,
    });
    if (res.status !== 200) throw new GoogleError(401, "Google sign-in has expired. Sign in again in TODO Board's settings.");
    this.access = { token: res.json.access_token, expires: Date.now() + (res.json.expires_in - 60) * 1000 };
    return this.access.token;
  }

  private async call(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<any> {
    const qs = new URLSearchParams(query).toString();
    const res = await requestUrl({
      url: `${API}${path}${qs ? "?" + qs : ""}`,
      method,
      headers: { Authorization: `Bearer ${await this.token()}` },
      contentType: "application/json",
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (res.status >= 400) {
      const message = (() => {
        try {
          return res.json?.error?.message;
        } catch {
          return undefined;
        }
      })();
      throw new GoogleError(res.status, message ?? `Google Calendar answered ${res.status}`);
    }
    return res.status === 204 || !res.text ? null : res.json;
  }

  /** The calendar called `name`: the remembered id if it still exists, else found by name, else made. */
  async calendar(name: string, timeZone: string, knownId: string | null): Promise<string> {
    if (knownId) {
      try {
        await this.call("GET", `/calendars/${encodeURIComponent(knownId)}`);
        return knownId;
      } catch (e) {
        if (!(e instanceof GoogleError) || (e.status !== 403 && e.status !== 404)) throw e;
      }
    }
    let pageToken = "";
    do {
      const page = await this.call("GET", "/users/me/calendarList", { maxResults: "250", ...(pageToken && { pageToken }) });
      const found = page.items?.find((c: any) => c.summary === name);
      if (found) return found.id;
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return (await this.call("POST", "/calendars", {}, { summary: name, timeZone })).id;
  }

  /** Every event carrying `marker` between the two times. */
  async events(calendarId: string, marker: string, from: Date, to: Date): Promise<LiveEvent[]> {
    const out: LiveEvent[] = [];
    let pageToken = "";
    do {
      const page = await this.call("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        privateExtendedProperty: `${marker}=1`,
        singleEvents: "true",
        maxResults: "2500",
        ...(pageToken && { pageToken }),
      });
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  insert(calendarId: string, body: EventBody) {
    return this.call("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {}, body);
  }

  patch(calendarId: string, eventId: string, body: EventBody) {
    return this.call("PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {}, body);
  }

  async delete(calendarId: string, eventId: string) {
    try {
      await this.call("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      // Already gone is fine.
      if (!(e instanceof GoogleError) || (e.status !== 404 && e.status !== 410)) throw e;
    }
  }
}

/**
 * Desktop only: send the browser to Google's consent page, catch the redirect
 * on a throwaway local port, and trade the code for a refresh token.
 */
export async function signIn(clientId: string, clientSecret: string): Promise<string> {
  const http = (window as any).require("http");
  const state = Math.random().toString(36).slice(2);

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = "";
    const server = http.createServer((req: any, res: any) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const ok = code && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ok ? "<p>TODO Board is signed in to Google. You can close this tab.</p>" : "<p>Sign-in failed.</p>");
      server.close();
      clearTimeout(timer);
      ok ? resolve({ code, redirectUri }) : reject(new Error(url.searchParams.get("error") ?? "Sign-in failed"));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out"));
    }, 5 * 60_000);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
      });
      window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    });
  });

  const res = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    throw: false,
  });
  if (res.status !== 200 || !res.json.refresh_token) throw new Error("Google didn't return a refresh token");
  return res.json.refresh_token;
}
