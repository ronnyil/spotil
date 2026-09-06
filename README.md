# spotil — TLV spotting, right now

A single-purpose site for plane spotters at Ben Gurion Airport (TLV/LLBG): it works
out which runways are actually being used for landings and takeoffs at this moment,
and tells you where to stand.

No build step, no backend. Open `index.html` or serve the folder statically.

## How it decides the runway

No free source publishes TLV's runway configuration — ATIS on 132.500 is voice only —
so the app derives it from live traffic.

Every 20 seconds it pulls all aircraft within 20 nm of the field, and for each one
checks four things against each of the six runway ends:

- **track** vs. the runway's true bearing (designators are magnetic; ADS-B track is
  true, so `data/airport.json` carries the local magnetic variation)
- **offset** from the extended centreline
- **which side** of the field the aircraft is on, along the runway axis
- **altitude AGL and vertical rate**

Low, aligned, on the approach side, descending → landing on that runway. Climbing away
past the far end → departing from it. High overflights and taxiing aircraft drop out.

Each aircraft then casts **one vote**, so a single aircraft in a hold cannot outvote a
stream of real traffic. Votes decay with an 8-minute half-life and expire after 20
minutes, which is what lets the reading follow a genuine configuration change instead
of averaging across it. Confidence combines how dominant the winning runway is against
how much traffic we have actually seen — thin traffic reads as low confidence rather
than as a confident guess.

**Fallback.** When traffic is too thin to read (quiet hours, or every source down), the
app falls back to the published time-of-day pattern and labels it `predicted from time
of day` in amber. It never presents a guess as an observation.

## Why not Flightradar24

The original idea was to read runway usage off FR24. Two problems:

1. **No usable API.** The FR24 API is an enterprise product, quote-based, with no
   self-serve tier; the old free live-data API was retired.
2. **Their terms forbid it.** Scraping and redistribution are prohibited, in large part
   because much of their feed comes from partners under agreements that do not allow
   redistribution.

So the app reads the same underlying ADS-B signal directly from community networks that
are keyless, CORS-enabled and free for non-commercial use, tried in order so one being
down is not an outage:

[airplanes.live](https://airplanes.live) → [adsb.fi](https://adsb.fi) → [adsb.lol](https://adsb.lol)

If you ever put this behind a domain with real traffic, move the polling to a small
serverless function so there is one shared poll rather than one per visitor, and read
each network's non-commercial terms first.

## Spot data

`data/spots.json` is the local knowledge, and it is the part most worth improving.

The primary source is Moti Kaplan's post in the Facebook group
חובבי הספוטינג בישראל (30 Aug 2025), which pairs spots to runways and to time of day:

| When | Landing | Spot |
|---|---|---|
| Morning | 12 (west→east) | Arcafe Or Yehuda, in the car park |
| Late morning–afternoon | 21 (from the north-east) | Bnei Atarot junction / Big Yehud |
| Evening | 30 (from the east) | Airport City / Dor Alon TLV |
| Most of the time | *takeoffs* from 26 | Western operations area, the old "Bama" spot |

Runway 08 (the reciprocal of 26, used on easterly winds and often at night) and the
Route 461 / Hatayasim option come from public spotting guides and are marked as such.

### Pin accuracy

**Coordinates are best-effort estimates** and every spot carrying one is flagged
`coordsApproximate: true`. The Navigate buttons therefore search by **place name**, not
by coordinate, so they route correctly even where a pin is off by a few hundred metres.
Fixing a pin is a one-line edit to `data/spots.json` — the map and the distance readout
pick it up on reload.

Runways with no spot on file yet are listed under `uncovered` in the same file.

## What else the app knows

- **Light.** It computes the sun's azimuth and elevation (NOAA equations, no library)
  and compares it to the direction you would be looking from that spot, so a spot can
  be reported as *into the sun*, *side light*, *golden hour* or *harsh overhead* rather
  than just "good".
- **Where to look.** Each recommendation gives a compass direction and bearing to the
  point where the aircraft actually will be — 3 nm out on the approach or the climb,
  not the middle of the airport.
- **Hebrew and English**, with full RTL.
- **Safety notice**, shown once. Access to some spots has been closed off by the Israel
  Airports Authority in the past, and security will ask what you are doing.

## Layout

```
index.html          markup and page shell
assets/style.css    styling, light and dark
js/geo.js           bearings, distances, cross/along-track maths
js/sun.js           solar position and light quality
js/adsb.js          live aircraft, with source fallback
js/runway.js        runway-in-use detection and vote tracking
js/recommend.js     runway → ranked spots
js/i18n.js          EN/HE strings
js/app.js           UI wiring
data/airport.json   runway geometry, magnetic variation, time-of-day pattern
data/spots.json     spotting locations
```

## Running it

```sh
python3 -m http.server 8777    # then open http://localhost:8777
```

The modules are plain ES modules, so it must be served over HTTP, not opened as a
`file://` URL.

## Caveats

- Runway true bearings are derived from the designators plus magnetic variation, which
  is accurate to about a degree. Refining them against the Israeli AIP threshold
  coordinates would tighten the centreline test.
- The 03/21 runway is the least used at TLV (mainly cargo and charter), so votes for it
  will be rare.
- Not for operational use. This is a hobby tool, not a flight-planning aid.
