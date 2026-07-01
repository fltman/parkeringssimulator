# Parkeringssimulator

[![Patreon](https://img.shields.io/badge/Patreon-AndersBjarby-F96854?logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

En interaktiv parkeringsplats-/tomtplanerare **och trafikmikrosimulering** i
webbläsaren, byggd som en hyllning till klippet i `paRkeringsimulator.mp4`: en
topdown-karta där du släpper in byggnader och parkeringen **löses om i realtid**,
och där du kan **köra trafik** för att se var det kör ihop sig.

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

- **Automatisk parkeringslösare** – fyller tomten med dubbelradiga fickor
  (2,5 × 5,0 m platser, 6,5 m körgång), **karvar ur rena tvärgator** där bilar
  kör, släpper stall utanför kantzonen eller mot byggnader, och räknar platserna.
- **Släpp in byggnader** – lägg till / flytta / skala / ta bort. Parkeringen
  genereras om runt varje byggnad; våningar styr BTA.
- **Layout** – 90 / 60 / 45° vinkel, öst–väst / nord–syd körgångar, justerbar
  kantzon och grönsketäthet.
- **Nyckeltal** – p-platser, platser/1000 m² BTA, BTA, tomtareal (ha), beläggning.
- Pan (dra tom yta), zoom (skrollhjul), måttlinjer och redigerbar tomtgräns.

## Trafikmikrosimuleringen

Bilar kommer in vid en av **två infarter (IN/UT)**, ruttas (Dijkstra) längs
körgångsnätet + en **perimeterslinga** till en ledig plats **så nära sin
målbyggnad som möjligt**, följer bilen framför (köer/spillback uppstår av sig
själva), parkerar, och kör ut. En **fotgängare** går från platsen till byggnadens
entré, handlar, går tillbaka — och först då kör bilen ut (gångturen styr
uppehållstiden).

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
panorera/zooma kartan för att lägga tomten över en verklig fastighet. Kräver
internet för kartrutor; stiliserat läge funkar offline.

## Manuell layout (rita själv)
Under **Layout** kan du växla **Auto ⇄ Manuell**. I manuellt läge ritar du planen
själv — utmärkt ovanpå kartläget för att planera en verklig plats:
- **Väg**: klicka ut punkter, dubbelklick/Enter avslutar. Vägarna blir körnätet;
  **korsningar skapas automatiskt** där vägar möts.
- **Rondell**: dra ut en cirkulär väg.
- **Sektion**: dra en parkeringsyta som fylls med p-platser. Markera den för att
  ställa **rotation** (rotera hela ytan) och **vinkel** (90/60/45°) samt riktning.
- In/utfarter snäpper till närmaste väg; trafiken kör på dina ritade vägar.

## Analys, betyg & export
Klicka **Analysera layouten** för att köra en kort, deterministisk trafik­benchmark
(på en slängbar sim, så den pågående simuleringen inte störs). Du får ett
**betyg A–F** över fyra dimensioner — genomströmning, flöde, åtkomst och säkerhet —
med **datadrivna förslag**, och den värsta **flaskhalsen markeras animerat på
ritytan**. Exportera planen som **PNG** eller **JSON** (och importera JSON igen).

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

