// Adapter Transitous (MOTIS v2) — routing ferroviario europeo, senza prezzi.
// Policy transitous: User-Agent identificativo con contatto obbligatorio.
import type { JourneyResult, Solution, StationRef } from "./index.ts";

const BASE = "https://api.transitous.org/api/v1";
const UA = "TrenOvunque/1.0 (personal project; alessio.caruso@designgroupitalia.it)";

const geoCache = new Map<string, string | null>();

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) *
      Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

interface GeoHit {
  type?: string;
  name?: string;
  id?: string;
  lat?: number;
  lon?: number;
  modes?: string[];
}

const RAIL_MODES = [
  "HIGHSPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "REGIONAL_RAIL",
  "REGIONAL_FAST_RAIL",
  "RAIL",
  "SUBURBAN",
];

async function resolvePlace(ref: StationRef): Promise<string | null> {
  const key = `${ref.station}|${ref.lat}`;
  if (geoCache.has(key)) return geoCache.get(key)!;

  const res = await fetch(
    `${BASE}/geocode?text=${encodeURIComponent(ref.station)}`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`transitous geocode ${res.status}`);
  const hits = (await res.json()) as GeoHit[];

  const stops = hits.filter((h) =>
    h.type === "STOP" && h.id &&
    (h.modes ?? []).some((m) => RAIL_MODES.includes(m))
  );
  let best: GeoHit | undefined;
  if (ref.lat != null && ref.lon != null) {
    // scegli il candidato ferroviario più vicino alle coordinate note (< 3 km)
    best = stops
      .map((h) => ({
        h,
        d: haversineKm(ref.lat!, ref.lon!, h.lat ?? 0, h.lon ?? 0),
      }))
      .filter((x) => x.d < 3)
      .sort((a, b) => a.d - b.d)[0]?.h;
  }
  best = best ?? stops[0];

  const id = best?.id ?? null;
  geoCache.set(key, id);
  return id;
}

interface MotisLeg {
  mode?: string;
  routeShortName?: string;
  tripShortName?: string;
}

interface MotisItinerary {
  duration?: number; // secondi
  startTime?: string;
  endTime?: string;
  transfers?: number;
  legs?: MotisLeg[];
}

export async function searchTransitous(
  from: StationRef,
  to: StationRef,
  date: string,
): Promise<JourneyResult> {
  const [fromId, toId] = await Promise.all([
    resolvePlace(from),
    resolvePlace(to),
  ]);
  if (!fromId || !toId) throw new Error("stazione non trovata su transitous");

  const params = new URLSearchParams({
    fromPlace: fromId,
    toPlace: toId,
    time: `${date}T05:00:00+02:00`,
    numItineraries: "8",
  });
  const res = await fetch(`${BASE}/plan?${params}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`transitous plan ${res.status}`);
  const data = (await res.json()) as { itineraries?: MotisItinerary[] };

  const solutions: Solution[] = (data.itineraries ?? [])
    .filter((it) => it.startTime && it.endTime)
    // solo partenze nella data richiesta (confronto in ora italiana)
    .filter((it) =>
      new Date(it.startTime!).toLocaleDateString("sv-SE", {
        timeZone: "Europe/Rome",
      }) === date
    )
    .map((it) => ({
      departure: it.startTime!,
      arrival: it.endTime!,
      durationMin: Math.round((it.duration ?? 0) / 60),
      changes: it.transfers ?? 0,
      priceEur: null,
      trains: (it.legs ?? [])
        .filter((l) => l.mode !== "WALK")
        .map((l) => l.routeShortName || l.tripShortName || "")
        .filter(Boolean),
    }))
    .slice(0, 8);

  return { ok: true, provider: "transitous", solutions };
}
