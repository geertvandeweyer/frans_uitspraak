# 🎙️ Frans Uitspraak

Een browser-only app om Franse uitspraak te oefenen. Lees een zin luidop voor; de app luistert via [OpenAI Whisper](https://github.com/openai/whisper) (draait volledig lokaal in de browser via [Transformers.js](https://github.com/xenova/transformers.js)) en geeft per woord kleurgecodeerde feedback plus een vloeiendheidsanalyse op basis van Whisper-tijdstempels.

Zinnen worden ingeladen vanuit `js/sentences.js`, gegenereerd vanuit de *En action 5*-handboek-PDF's via het extractiescript in `scripts/`. Extra zinnen werden op basis van de woordenschat in deze PDF's, na curatie, automatisch aangemaakt door chatGPT.  

---

## Publieke versie 

De app is beschikbaar via : [https://parler.geertvandeweyer.be](https://parler.geertvandeweyer.be)


---

## Wat doet de app?

- **Uitspraakfeedback per woord** — correct (groen) / bijna goed (oranje) / gemist (rood), via Levenshtein-vergelijking met globale sequentie-uitlijning (Needleman-Wunsch).
- **Vloeiendheidsanalyse** — snelheidsbalk + pauzedetectie op basis van Whisper-woordtijdstempels.
- **Twee modellen** — *whisper-tiny* (~150 MB, snel) en *whisper-small* (~460 MB, nauwkeuriger). Automatische aanbeveling op basis van de gedetecteerde GPU.
- **WebGPU of WASM** — gebruikt WebGPU voor hardware-versnelling; valt terug op WebAssembly (CPU) als er geen GPU-adapter beschikbaar is.
- **Offline na eerste download** — het model wordt gecached in de browser (Cache Storage); latere bezoeken laden het model lokaal.

---

## Installatie (Apache)

De app heeft geen server-side logica nodig. Een gewone statische webserver volstaat.

```bash
# Kloon of kopieer de bestanden naar je webroot
cp -Rf * /var/www/html/frans-uitspraak/

# Zorg dat Apache de map serveert en dat MIME-types correct zijn.
# Voeg dit toe aan je VirtualHost of .htaccess als .js-bestanden
# als verkeerd type worden geserveerd:
AddType application/javascript .js
AddType application/wasm       .wasm
```

Vereisten:
- **HTTPS of localhost** — WebGPU en de Microphone API werken alleen op een beveiligde oorsprong.
- **CORS-headers zijn niet nodig** — alle model-downloads gaan rechtstreeks van de browser naar de Hugging Face CDN.
- Apache hoeft geen speciale modules; enkel statische bestanden serveren.

### Zinnen genereren vanuit PDF

```bash
cd scripts
npm install
# Plaats de PDF-bestanden in ../input/
node extract_sentences.js
# Schrijft ../js/sentences.js
```

---

## Linux-tips: WebGPU / Vulkan

Op Linux gebruikt Chrome/Edge WebGPU via de Vulkan-backend. Zonder de juiste drivers valt de app terug op WASM (CPU), wat merkbaar trager is.

### Mesa Vulkan installeren (Intel/AMD)

```bash
# Debian / Ubuntu
sudo apt install mesa-vulkan-drivers vulkan-tools

# Controleer of Vulkan werkt
vulkaninfo --summary
```

### Nvidia (proprietary)

```bash
# Installeer de nvidia-driver (bijv. via ubuntu-drivers)
sudo ubuntu-drivers install
# Vulkan wordt meegeleverd met de driver; geen extra pakket nodig.
```

### Nvidia discrete GPU kiezen in Chrome

Als je een laptop hebt met zowel een Intel/AMD iGPU als een Nvidia dGPU, kiest Chrome standaard de geïntegreerde GPU. Forceer de discrete GPU via de Nvidia-instellingen:

1. Open **NVIDIA X Server Settings** of **nvidia-settings**.
2. Voeg Chrome/Chromium toe onder *PRIME Profiles* of stel de applicatie in op **NVIDIA (Performance Mode)**.
3. Herstart de browser.

De app detecteert de adapter en toont een waarschuwing als de gekozen GPU Intel blijkt te zijn terwijl *high-performance* is ingesteld.

### Controleer of WebGPU actief is

Open `chrome://gpu` en zoek naar `WebGPU: Hardware accelerated`. Als het *Software only* toont, ontbreken de Vulkan-drivers of wordt chrome niet correct gestart. Test via CLI als: 

```bash

google-chrome \
  --ozone-platform=x11 \
  --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan,UseSkiaRenderer \
  --use-angle=vulkan \
  --enable-unsafe-webgpu \
  --ignore-gpu-blocklist \
  "$@"

```

---

## Gegevensgebruik & privacy

| Wat | Waar |
|-----|------|
| **Spraakopnames** | Worden **nooit** verstuurd. Verwerking gebeurt 100% lokaal in de browser via het Whisper-model in een Web Worker. |
| **Whisper-model** | Wordt bij het eerste gebruik gedownload van de Hugging Face CDN (`cdn.jsdelivr.net`) en daarna gecached in de **browser Cache Storage**. Na de eerste download werkt de app volledig offline. |
| **Oefenvoortgang** | Opgeslagen in `localStorage` van de eigen browser — enkel lokaal, niet in de cloud. |
| **Statistieken** | Anonieme bezoekersstatistieken via **Cloudflare Web Analytics**. Geen cookies, geen persoonlijke gegevens, geen fingerprinting. |

Er is geen backend, geen database en geen account.

---

## Licentie

MIT — vrij te gebruiken, te kopiëren en aan te passen, ook commercieel, mits de originele auteursnaam vermeld blijft.

Gemaakt door **Geert Vandeweyer** · mei 2026 · ontwikkeld met behulp van Claude Sonnet 4.6.
