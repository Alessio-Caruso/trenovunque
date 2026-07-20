// TrenOvunque — backend edge function
// Serve il frontend e fa da proxy normalizzatore verso i provider ferroviari:
//  - Trenitalia/LeFrecce (prezzi reali; Italia + alcune tratte internazionali)
//  - Transitous / MOTIS v2 (orari Europa, senza prezzi) come fallback
import { STATIONS } from "./stations.ts";
import { searchTrenitalia } from "./trenitalia.ts";
import { searchItalo } from "./italo.ts";
import { searchTransitous } from "./db.ts";

export interface Solution {
  departure: string; // ISO
  arrival: string; // ISO
  durationMin: number;
  changes: number;
  priceEur: number | null;
  trains: string[];
}

export interface JourneyResult {
  ok: true;
  provider: string;
  solutions: Solution[];
}

export interface StationRef {
  station: string;
  city: string;
  country: string;
  lat: number | null;
  lon: number | null;
}

const FRONTEND_URL = "https://alessio-caruso.github.io/trenovunque/";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

// cache in-memory per invocazioni calde (from|to|date -> risultato)
const cache = new Map<string, { at: number; body: string }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function toRef(stationName: string, country: string): StationRef {
  const known = STATIONS.find((s) => s.station === stationName);
  return known
    ? {
      station: known.station,
      city: known.city,
      country: known.country,
      lat: known.lat,
      lon: known.lon,
    }
    : { station: stationName, city: stationName, country, lat: null, lon: null };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  // path può essere /trenovunque/... o /functions/v1/trenovunque/...
  const path = url.pathname.replace(/^.*?\/trenovunque\/?/, "");

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  // Il frontend vive su GitHub Pages: Supabase riscrive text/html in
  // text/plain per i browser, quindi qui facciamo solo da API + redirect.
  if (path === "" || path === "index.html") {
    return Response.redirect(FRONTEND_URL, 302);
  }

  if (path === "api/stations") {
    return json({ ok: true, stations: STATIONS });
  }

  if (path === "api/journeys") {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const fromCountry = url.searchParams.get("fromCountry") ?? "IT";
    const toCountry = url.searchParams.get("toCountry") ?? "IT";
    const date = url.searchParams.get("date") ?? "";
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ ok: false, error: "parametri mancanti o non validi" }, 400);
    }

    const key = `${from}|${to}|${date}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return new Response(hit.body, { headers: JSON_HEADERS });
    }

    const fromRef = toRef(from, fromCountry);
    const toRef2 = toRef(to, toCountry);
    const domestic = fromCountry === "IT" && toCountry === "IT";

    let result: JourneyResult | null = null;
    let lastError = "nessun provider disponibile";

    if (domestic) {
      // Tratte italiane: Trenitalia + Italo in parallelo, soluzioni unite.
      const [tre, ita] = await Promise.allSettled([
        searchTrenitalia(fromRef, toRef2, date),
        searchItalo(fromRef, toRef2, date),
      ]);
      const merged: Solution[] = [];
      const labels: string[] = [];
      for (const [name, r] of [["trenitalia", tre], ["italo", ita]] as const) {
        if (r.status === "fulfilled") {
          if (r.value.solutions.length) labels.push(name);
          merged.push(...r.value.solutions);
        } else {
          lastError = r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      }
      if (merged.length) {
        merged.sort((a, b) => a.departure.localeCompare(b.departure));
        result = {
          ok: true,
          provider: labels.join("+") || "trenitalia",
          solutions: merged.slice(0, 12),
        };
      }
    }

    // Fallback (o tratte estere): Trenitalia poi Transitous per gli orari.
    if (!result) {
      for (const provider of [searchTrenitalia, searchTransitous]) {
        try {
          const r = await provider(fromRef, toRef2, date);
          if (r.solutions.length > 0) {
            result = r;
            break;
          }
          result = result ?? r; // risultato vuoto ma valido
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
    }

    if (!result) return json({ ok: false, error: lastError }, 502);

    const body = JSON.stringify(result);
    cache.set(key, { at: Date.now(), body });
    return new Response(body, { headers: JSON_HEADERS });
  }

  return json({ ok: false, error: "not found" }, 404);
});
