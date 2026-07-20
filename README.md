# TrenOvunque 🚆

Motore di ricerca treni "verso ovunque": scegli città di partenza, date di andata
e ritorno, e scopri tutte le destinazioni raggiungibili con prezzi e orari.
Filtri opzionali: tempo massimo (ore), distanza massima (km), solo diretti, estero.

**App:** https://alessio-caruso.github.io/trenovunque/

## Architettura
- `index.html` — frontend single-file (vanilla JS), hostato su GitHub Pages
- `supabase/functions/trenovunque/` — edge function API (proxy + normalizzazione):
  - `trenitalia.ts` — API non ufficiale LeFrecce (prezzi, Italia + tratte intl. vendute da Trenitalia)
  - `db.ts` — Transitous / MOTIS v2 (orari Europa, senza prezzi, fallback)
- `data/stations.json` — 165 destinazioni con coordinate verificate sui GTFS

## Note
- L'endpoint `GET /api/journeys?from=&to=&date=&fromCountry=&toCountry=` normalizza
  entrambi i provider in `{ok, provider, solutions[]}`.
- Supabase riscrive `text/html` in `text/plain` per i browser: per questo il
  frontend NON è servito dalla function (che fa solo redirect).
- Prezzi e orari sono indicativi; Italo non è coperto.
