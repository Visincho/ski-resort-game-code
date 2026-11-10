# Snowline · kit per il lancio sui social

## File

| File | Uso |
|---|---|
| `snowline_trailer_9x16_it.mp4` | Reels, TikTok, YouTube Shorts, Storie (1080×1920, 40 s, con musica) |
| `snowline_trailer_9x16_it_senza_musica.mp4` | Stessa versione senza audio, per usare un audio di tendenza dentro l'app |
| `snowline_trailer_16x9_it.mp4` | YouTube, LinkedIn, X, Facebook, sito (1920×1080, 40 s, con musica) |
| `snowline_trailer_16x9_it_senza_musica.mp4` | Versione orizzontale senza audio |
| `copertina_9x16.jpg`, `copertina_16x9.jpg` | Copertina e miniatura (schermata finale con il logo) |
| `music.wav` | Colonna sonora originale, sintetizzata da zero (`tools/make-music.mjs`) |

Tutte le immagini vengono dal gioco vero: terreno reale di Cortina d'Ampezzo, impianti e piste importati da OpenStreetMap, sciatori simulati. Nessuna immagine è generata con l'IA.

## Instagram Reels / TikTok

> Costruisci il tuo comprensorio sciistico sulle montagne **vere** 🏔️
> Cortina d'Ampezzo ricostruita dai dati altimetrici reali, con gli impianti di oggi. Bufere, neve fresca, code agli impianti, Coppa del Mondo… e un universo online di stazioni sciistiche da conquistare.
> ⛷️ Gioca nel browser, link in bio
>
> #snowline #sci #skiing #cortina #dolomiti #videogiochi #gamedev #tycoon #simulatore #indiegame #montagna #skiresort

## YouTube Shorts

**Titolo:** Ho ricostruito Cortina in un videogioco gestionale 🏔️ #shorts
**Descrizione:** Snowline è un tycoon dello sci sulle montagne vere: terreno reale, impianti reali da OpenStreetMap, meteo dinamico, Coppa del Mondo e un universo online. Gioca nel browser: [link]

## LinkedIn

> Ho costruito **Snowline**, un gestionale nello stile di SimCity e Theme Hospital ambientato su montagne reali.
> • Terreno ricostruito dai modelli altimetrici (AWS Terrain Tiles)
> • Impianti e piste importati da OpenStreetMap: Cortina parte con il comprensorio di oggi
> • Simulazione di migliaia di sciatori, meteo, neve, valanghe ed economia
> • Grandi eventi (Coppa del Mondo, Olimpiadi) e un universo multiplayer persistente
> Tutto gira nel browser, con three.js. Il trailer qui sotto è girato nel gioco vero.

## X / Threads

> Un tycoon dello sci sulle montagne VERE 🏔️ Cortina ricostruita dai dati altimetrici, con gli impianti di oggi, bufere, Coppa del Mondo e un universo online. Gioca nel browser 👇 [link]

## Note prima di pubblicare

- **"Link in bio"**: per ora il gioco gira solo in locale (`npm start`). Prima del lancio va pubblicato su un indirizzo pubblico, da mettere nella bio.
- **Classifica nella scena multiplayer**: i nomi dei giocatori (DolomitiDream, MatterhornMax…) sono di fantasia, servono solo a far vedere la funzione.
- **Musica**: la traccia è originale e senza diritti di terzi. Su TikTok e Instagram spesso conviene la versione senza musica con un audio di tendenza scelto nell'app.
- **Rifare il video**: con il server avviato, `npm i -D puppeteer-core ffmpeg-static`, poi `npm run music` e `npm run trailer`. Testi e scene sono in `public/js/promo/director.js`, dove c'è già pronta anche una versione inglese (`en`): `node tools/record-trailer.mjs v en`.
