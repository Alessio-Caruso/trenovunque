#!/bin/zsh
# Genera stations.ts per l'edge function a partire da data/stations.json.
# NB: il frontend (web/index.html) NON viene più embeddato: vive nella tabella
# public.app_assets del progetto Supabase (vedi deploy-frontend.sh).
set -e
cd "$(dirname "$0")"

python3 - <<'PY'
import json, pathlib
fn = pathlib.Path("supabase/functions/trenovunque")
stations = json.loads(pathlib.Path("data/stations.json").read_text(encoding="utf-8"))
(fn / "stations.ts").write_text(
    "export const STATIONS = " + json.dumps(stations, ensure_ascii=True, separators=(",", ":")) + " as const;\n",
    encoding="utf-8",
)
print(f"stations.ts: {len(stations)} stazioni")
PY
