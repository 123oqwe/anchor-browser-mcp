/**
 * Per-OS browser history reader. Reads Chromium/Firefox/Safari sqlite
 * directly. Browsers lock the live file, so we copy to /tmp first then
 * read read-only.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

const HOME = os.homedir();
const PLATFORM = process.platform;
const APPDATA = process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local");

const BLOCKED_DOMAINS = new Set([
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com",
  "paypal.com", "venmo.com", "stripe.com", "wise.com", "revolut.com",
  "webmd.com", "mayoclinic.org", "healthline.com", "zocdoc.com", "mychart.com",
  "1password.com", "lastpass.com", "bitwarden.com", "dashlane.com",
  "pornhub.com", "xvideos.com", "xhamster.com",
  "accounts.google.com", "login.microsoftonline.com", "auth0.com",
]);

function isBlocked(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace("www.", "");
    return BLOCKED_DOMAINS.has(h) || h.includes("bank") || h.includes("health");
  } catch { return true; }
}

interface Profile { name: string; historyPath: string; engine: "chromium" | "firefox" | "safari" }

function chromiumBaseDir(browser: "Chrome" | "Brave" | "Edge" | "Arc"): string | null {
  if (PLATFORM === "darwin") return ({
    Chrome: path.join(HOME, "Library/Application Support/Google/Chrome"),
    Brave:  path.join(HOME, "Library/Application Support/BraveSoftware/Brave-Browser"),
    Edge:   path.join(HOME, "Library/Application Support/Microsoft Edge"),
    Arc:    path.join(HOME, "Library/Application Support/Arc/User Data"),
  })[browser];
  if (PLATFORM === "win32") return ({
    Chrome: path.join(LOCALAPPDATA, "Google/Chrome/User Data"),
    Brave:  path.join(LOCALAPPDATA, "BraveSoftware/Brave-Browser/User Data"),
    Edge:   path.join(LOCALAPPDATA, "Microsoft/Edge/User Data"),
    Arc:    path.join(LOCALAPPDATA, "Arc/User Data"),
  })[browser];
  if (PLATFORM === "linux") return ({
    Chrome: path.join(HOME, ".config/google-chrome"),
    Brave:  path.join(HOME, ".config/BraveSoftware/Brave-Browser"),
    Edge:   path.join(HOME, ".config/microsoft-edge"),
    Arc:    null,
  })[browser] ?? null;
  return null;
}

function firefoxProfilesDir(): string | null {
  if (PLATFORM === "darwin") return path.join(HOME, "Library/Application Support/Firefox/Profiles");
  if (PLATFORM === "win32")  return path.join(APPDATA, "Mozilla/Firefox/Profiles");
  if (PLATFORM === "linux")  return path.join(HOME, ".mozilla/firefox");
  return null;
}

export function findProfiles(): Profile[] {
  const profiles: Profile[] = [];
  for (const browser of ["Chrome", "Brave", "Edge", "Arc"] as const) {
    const base = chromiumBaseDir(browser);
    if (!base || !fs.existsSync(base)) continue;
    for (const profile of ["Default", "Profile 1", "Profile 2", "Profile 3"]) {
      const p = path.join(base, profile, "History");
      if (fs.existsSync(p)) profiles.push({ name: `${browser}/${profile}`, historyPath: p, engine: "chromium" });
    }
  }
  const ffDir = firefoxProfilesDir();
  if (ffDir && fs.existsSync(ffDir)) {
    try {
      for (const entry of fs.readdirSync(ffDir)) {
        const places = path.join(ffDir, entry, "places.sqlite");
        if (fs.existsSync(places)) profiles.push({ name: `Firefox/${entry}`, historyPath: places, engine: "firefox" });
      }
    } catch {}
  }
  if (PLATFORM === "darwin") {
    const safariP = path.join(HOME, "Library/Safari/History.db");
    if (fs.existsSync(safariP)) profiles.push({ name: "Safari", historyPath: safariP, engine: "safari" });
  }
  return profiles;
}

const webkitToUnix = (w: number) => (w / 1_000_000) - 11_644_473_600;
const safariToUnix = (s: number) => s + 978_307_200;
const prTimeToUnix = (p: number) => p / 1_000_000;

export interface Visit { url: string; title: string; visits: number; lastVisitAt: string; profile: string }

function readChromium(historyPath: string, profileName: string, sinceDays: number, limit: number): Visit[] {
  const tmp = path.join(os.tmpdir(), `anchor_bh_${Date.now()}_${Math.random().toString(36).slice(2,8)}.db`);
  try {
    fs.copyFileSync(historyPath, tmp);
    const db = new Database(tmp, { readonly: true });
    const sinceWebkit = (Date.now() / 1000 + 11_644_473_600 - sinceDays * 86_400) * 1_000_000;
    const rows = db.prepare(`
      SELECT u.url, u.title, u.visit_count, MAX(v.visit_time) as last_visit
      FROM urls u JOIN visits v ON u.id = v.url
      WHERE v.visit_time > ? GROUP BY u.id ORDER BY u.visit_count DESC LIMIT ?
    `).all(sinceWebkit, limit) as any[];
    db.close();
    return rows.filter(r => !isBlocked(r.url)).map(r => ({
      url: r.url, title: r.title ?? "", visits: r.visit_count ?? 1,
      lastVisitAt: new Date(webkitToUnix(r.last_visit) * 1000).toISOString(), profile: profileName,
    }));
  } catch (err: any) {
    process.stderr.write(`[browser-mcp] chromium read failed (${profileName}): ${err.message}\n`);
    return [];
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function readFirefox(places: string, profileName: string, sinceDays: number, limit: number): Visit[] {
  const tmp = path.join(os.tmpdir(), `anchor_bh_ff_${Date.now()}.sqlite`);
  try {
    fs.copyFileSync(places, tmp);
    const db = new Database(tmp, { readonly: true });
    const sincePR = (Date.now() - sinceDays * 86_400 * 1000) * 1000;
    const rows = db.prepare(`
      SELECT url, title, visit_count, last_visit_date FROM moz_places
      WHERE last_visit_date > ? AND visit_count >= 1 ORDER BY visit_count DESC LIMIT ?
    `).all(sincePR, limit) as any[];
    db.close();
    return rows.filter(r => !isBlocked(r.url)).map(r => ({
      url: r.url, title: r.title ?? "", visits: r.visit_count ?? 1,
      lastVisitAt: new Date(prTimeToUnix(r.last_visit_date) * 1000).toISOString(), profile: profileName,
    }));
  } catch (err: any) {
    process.stderr.write(`[browser-mcp] firefox read failed: ${err.message}\n`);
    return [];
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

function readSafari(historyPath: string, sinceDays: number, limit: number): Visit[] {
  const tmp = path.join(os.tmpdir(), `anchor_bh_sf_${Date.now()}.db`);
  try {
    fs.copyFileSync(historyPath, tmp);
    const db = new Database(tmp, { readonly: true });
    const sinceCF = (Date.now() / 1000) - sinceDays * 86_400 - 978_307_200;
    const rows = db.prepare(`
      SELECT i.url, i.visit_count, hv.title, MAX(hv.visit_time) as last_visit
      FROM history_items i JOIN history_visits hv ON i.id = hv.history_item
      WHERE hv.visit_time > ? GROUP BY i.id ORDER BY i.visit_count DESC LIMIT ?
    `).all(sinceCF, limit) as any[];
    db.close();
    return rows.filter(r => !isBlocked(r.url)).map(r => ({
      url: r.url, title: r.title ?? "", visits: r.visit_count ?? 1,
      lastVisitAt: new Date(safariToUnix(r.last_visit) * 1000).toISOString(), profile: "Safari",
    }));
  } catch (err: any) {
    process.stderr.write(`[browser-mcp] safari read failed: ${err.message}\n`);
    return [];
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function recentVisits(opts: { sinceDays?: number; limit?: number } = {}): Visit[] {
  const sinceDays = opts.sinceDays ?? 30;
  const limit = Math.min(opts.limit ?? 200, 1000);
  const profiles = findProfiles();
  const all: Visit[] = [];
  const seen = new Set<string>();
  for (const p of profiles) {
    const visits = p.engine === "chromium" ? readChromium(p.historyPath, p.name, sinceDays, limit)
                 : p.engine === "firefox"  ? readFirefox(p.historyPath, p.name, sinceDays, limit)
                 :                            readSafari(p.historyPath, sinceDays, limit);
    for (const v of visits) {
      if (seen.has(v.url)) continue;
      seen.add(v.url); all.push(v);
    }
  }
  return all.sort((a, b) => b.visits - a.visits).slice(0, limit);
}

export function topDomains(opts: { sinceDays?: number; limit?: number } = {}): { domain: string; visits: number }[] {
  const visits = recentVisits({ sinceDays: opts.sinceDays, limit: 1000 });
  const counts = new Map<string, number>();
  for (const v of visits) {
    try {
      const host = new URL(v.url).hostname.replace("www.", "");
      counts.set(host, (counts.get(host) ?? 0) + v.visits);
    } catch {}
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, opts.limit ?? 30).map(([domain, visits]) => ({ domain, visits }));
}

export function searchHistory(query: string, opts: { sinceDays?: number; limit?: number } = {}): Visit[] {
  const visits = recentVisits({ sinceDays: opts.sinceDays ?? 90, limit: 1000 });
  const q = query.toLowerCase();
  return visits.filter(v => v.url.toLowerCase().includes(q) || v.title.toLowerCase().includes(q)).slice(0, opts.limit ?? 30);
}

export function status(): { platform: NodeJS.Platform; profilesDetected: { name: string; engine: string }[]; blockedDomainCount: number } {
  return {
    platform: PLATFORM,
    profilesDetected: findProfiles().map(p => ({ name: p.name, engine: p.engine })),
    blockedDomainCount: BLOCKED_DOMAINS.size,
  };
}
