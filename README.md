# Parkeringssimulator

[![Patreon](https://img.shields.io/badge/Patreon-AndersBjarby-F96854?logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

En interaktiv parkerings-/tomtplanerare **och trafikmikrosimulering** i
webbläsaren: en topdown-vy (stiliserad eller på riktig karta) där du **ritar
vägar, parkeringssektioner och byggnader själv** — varje parkeringsyta fylls med
platser i realtid — och sedan **kör trafik** för att se var det kör ihop sig.

Allt är metriskt (meter, m², hektar) och helt beroendefritt (vanlig HTML/CSS/JS,
inget byggsteg).

## Kör den

```bash
python3 -m http.server 8123
# öppna http://localhost:8123/index.html
```

…eller öppna `index.html` direkt (vanliga `<script>`-taggar, inga moduler/fetch).
Skripten laddas med `?v=N` för att undvika webbläsarens cache under utveckling —
bumpa siffran om en JS-ändring inte slår igenom.

## Planeraren

Du ritar planen själv (verktygen **Väg / Sektion / Rondell** + **Byggnad**). Varje
**parkeringssektion** är en polygon du klickar ut, och den **fylls med dubbelradiga
fickor** i realtid (2,5 × 5,0 m platser, 6,5 m körgång) med interna körgångar som
kopplas in i vägnätet.

- **Rita parkeringssektioner** – klicka ut en polygon; den fylls med platser i den
  form du ritat. Per yta (i **Vald sektion**) ställer du **vinkel** (90 / 60 / 45°),
  **riktning** (längs/tvärs), **grönsketäthet** och **rotation av parkeringen inuti
  formen**. Markera + dra ankarpunkter, eller dubbelklicka en kant för en ny punkt.
- **Byggnader** – **+ Byggnad** ger en fyrkant (flytta / skala / rotera) eller
  **✏️ Rita** en polygon-byggnad. Parkeringen viker undan för byggnader; våningar
  styr BTA.
- **Vägar & rondeller** – vägarna blir körnätet, korsningar skapas där de möts,
  rondeller är enkelriktade. In-/utfarter (IN/UT) snäpper till närmaste väg.
- **Nyckeltal** – p-platser, platser/1000 m² BTA, BTA, tomtareal (ha), beläggning.
- Pan (dra tom yta), zoom (skrollhjul), måttlinjer och redigerbar tomtgräns.

## Trafikmikrosimuleringen

Bilar kommer in vid en **infart (IN)**, ruttas (Dijkstra) längs ditt ritade
körgångs-/vägnät till en ledig plats **så nära sin målbyggnad som möjligt**,
följer bilen framför (köer/spillback uppstår av sig själva), parkerar, och kör ut
via en **utfart (UT)**. En **fotgängare** går från platsen till byggnadens entré,
handlar, går tillbaka — och först då kör bilen ut (gångturen styr uppehållstiden).

**Så ser man var det kör ihop sig:** trafikvärmekarta på körgångarna
(grön→gul→röd) + **röd pulsring på värsta flaskhalsen**, plus live-statistik
(rullande / parkerade / i kö / snitt söktid / krockar / avvisade).

### Förarbeteende (varje bil är en agent)
- **Personlighet**: aggressivitet, osäkerhet och dynamisk **stress**, slumpade
  vid spawn kring justerbara snitt + spridning. Styr fart och avstånd.
- **Korsningsregler**: väjer för den som redan är i korsningen och för fullt fält.
- **Saktar in** för att parkera / manövrera.
- **Stress** byggs i kö → **pratbubblor** (😤 / 🤬).
- **Aggressiva, stressade förare kör om i mötande fält** → risk för
  **frontalkrock**, då båda blir stående en stund och blockerar fältet.
- **Rubbernecking**: fotgängare stannar och glor vid en krock (🟠), och bilar
  saktar ner när de passerar olycksplatsen.
- **Frustration**: en bil som fastnat för länge ger upp och lämnar (självläker
  eventuell total propp).
- **Klicka på en bil** → panel där du ser status/mål och kan dra dess
  aggressivitet / osäkerhet / stress live, samt **💥 Krocka** den.

### Reglage
Startbeläggning, ankomsttakt, uppehållstid, hastighet, tempo, samt
förar-snitt (aggressivitet/osäkerhet), spridning och omkörning på/av. Vy-toggles
för trafikvärme, fotgängare, fotgängarkonflikter och mått.

## Filer

| Fil | Ansvar |
|-----|--------|
| `js/geometry.js` | 2D-geometri: area, punkt-i-polygon, avstånd, AABB, segment-skärning |
| `js/parking.js`  | Parkeringslösaren (kakling, tvärgator, validering, träd) |
| `js/traffic.js`  | Nät (graf + perimeter + infarter), mikrosim (bilar/fotgängare/incidenter), rendering av agenter/värme |
| `js/render.js`   | Canvas-ritning: karta, asfalt, stall, bilar, byggnader, mått |
| `js/app.js`      | UI, interaktion, live-regenerering, sim-loop |

## Planera på riktig karta
Under **Vy → Bakgrund** kan du växla mellan **Stiliserad** (den ritade kartan) och
**Karta** — en ren, ljus gatukarta (CARTO Positron via Leaflet, laddas lazy). I
kartläge ritas parkeringen genomskinligt ovanpå den riktiga marken i korrekt skala;
panorera/zooma kartan för att lägga tomten över en verklig fastighet. Sökrutan
**🔍 Navigera till** (uppe till vänster på kartan) flyger dig till valfri plats i
världen (OSM Nominatim). Kräver internet för kartrutor; stiliserat läge funkar offline.

## Rita layouten
Du ritar hela planen själv (utmärkt ovanpå kartläget för att planera en verklig
plats). Verktygen finns under **Layout**:
- **Väg**: klicka ut punkter, dubbelklick/Enter avslutar. Vägarna blir körnätet;
  **korsningar skapas automatiskt** där vägar möts.
- **Rondell**: dra ut en cirkulär (enkelriktad) väg.
- **Sektion**: klicka ut ankarpunkter (dubbelklick/Enter avslutar, eller klicka
  första punkten för att stänga) → en **polygon-parkeringsyta** som fylls med
  p-platser i den form du ritat. Markera den (**Vald sektion**) för att sätta
  **rotation av parkeringen** inuti formen, **vinkel** (90/60/45°), riktning och
  grönsketäthet.
- **Byggnader** görs i **Byggnader**-panelen (**+ Byggnad** för en fyrkant, **✏️
  Rita** för en polygon), inte bland ritverktygen.
- **Markera + forma om**: med Markör-verktyget markerar du en byggnad/sektion,
  **drar dess ankarpunkter** (eller flyttar hela ytan) och **dubbelklickar på en
  kant för att lägga till en ny punkt**.
- In-/utfarter snäpper till närmaste väg; trafiken kör på dina ritade vägar.

### Trace från kartan (OpenStreetMap)
I kartläget (**Vy → Karta**): klicka **🗺️ Trace från kartan**, rita en yta, och
appen hämtar **verkliga byggnader och vägar** inom ytan från OpenStreetMap
(Overpass API) och lägger in dem i planen — byggnader som polygoner (med BTA från
`building:levels`), vägar som körnät. Sedan ritar du parkering ovanpå en riktig
plats. Kräver nät; data © OpenStreetMap.

## Analys, betyg & export
Klicka **Analysera layouten** för att köra en kort, deterministisk trafik­benchmark
(på en slängbar sim, så den pågående simuleringen inte störs). Du får ett
**betyg A–F** över fyra dimensioner — genomströmning, flöde, åtkomst och säkerhet —
med **datadrivna förslag**, och den värsta **flaskhalsen markeras animerat på
ritytan**. Exportera planen som **PNG** eller **JSON** (och importera JSON igen).

**Spara / fortsätt senare:** projektet sparas **automatiskt i webbläsaren**
(localStorage) — inklusive kartläge och kartvy — och laddas när du kommer tillbaka.
Appen öppnar tom första gången; **Rensa layout** tömmer allt du ritat (vägar,
sektioner, rondeller, byggnader, in-/utfarter) och **Återställ allt** nollställer
även det sparade projektet.

### Fråga Claude (valfritt)
Ovanpå den regelbaserade analysen kan du be **Claude** (`anthropic/claude-sonnet-5`
via OpenRouter) om en resonerande andra åsikt. Klistra in din OpenRouter-nyckel i
fältet — den sparas bara i din webbläsares `localStorage` och anropet går direkt
till OpenRouter.

## Deploy
Statisk hosting räcker (GitHub Pages, Netlify, valfri webbserver) — lägg upp
filerna som de är, inget byggsteg. "Fråga Claude" sköts helt i webbläsaren med din
egen OpenRouter-nyckel; allt annat funkar utan nät (utom kartläget som hämtar
kartrutor).

## Demo
`demo/parkeringssimulator-demo.mp4` är en berättad genomgång av funktionerna
(svensk voice-over).

