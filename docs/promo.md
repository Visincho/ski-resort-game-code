# Promo trailer pipeline

The launch trailer is recorded from the real game: no AI-generated images, no stock footage. Headless Chrome renders the game on the GPU frame by frame while a director script controls camera, time of day, weather, skiers and the social-media overlays. A synthesized original soundtrack is added, and ffmpeg encodes the result.

## Outputs (`promo/`)

| File | Format |
|---|---|
| `snowline_trailer_9x16_it.mp4` | 1080×1920, 30 fps, 40 s, H.264 High CRF 18 + AAC 192k, faststart. For Reels, TikTok, Shorts, Stories. |
| `snowline_trailer_16x9_it.mp4` | 1920×1080, same settings. For YouTube, LinkedIn, X, Facebook. |
| `*_senza_musica.mp4` | Silent versions, for adding trending audio inside the social apps. |
| `anteprima_9x16_leggera.mp4` | 720p preview (about 6 MB) for quick sharing. |
| `copertina_9x16.jpg`, `copertina_16x9.jpg` | Covers and thumbnails (frame 1110, the end card). |
| `music.wav` | Original soundtrack (44.1 kHz stereo, about −11.5 LUFS). |
| `testi_social.md` | Ready-made Italian captions for Instagram/TikTok, YouTube Shorts, LinkedIn and X, hashtags, and notes for publishing. |

## How to regenerate

```bash
npm start                                  # the recorder loads the game from the running server
npm i -D puppeteer-core ffmpeg-static      # once (they're devDependencies; Chrome must be installed)
npm run music                              # promo/music.wav
npm run trailer                            # records + encodes 9:16 and 16:9 (Italian), about 2 min each
node tools/record-trailer.mjs v en         # English vertical version
node tools/record-trailer.mjs h it --frames=0,150,330   # preview a few frames only (JPGs in promo/frames_h_it/)
```

The recorder (`tools/record-trailer.mjs`):
1. Launches `/usr/bin/google-chrome` (override with `CHROME=`) headless with `--enable-gpu --use-angle=gl --ignore-gpu-blocklist`. Without those flags Chrome falls back to SwiftShader, which is much slower.
2. Sets the viewport: 540×960 at device scale 2 (vertical) or 1280×720 at scale 1.5 (horizontal).
3. Opens `http://localhost:8787/?record` (override with `SNOWLINE_URL=`). With `?record` the game loop idles and the WebGL buffer is preserved.
4. Imports `js/promo/director.js` in the page and calls `setup({lang})`, then `frame(f)` plus a JPEG screenshot for each of the 1,200 frames, into `promo/frames_<v|h>_<lang>/`.
5. Encodes the MP4 with and without `promo/music.wav` (via `ffmpeg-static`). With `--frames=…` it only writes preview JPGs (the frames in between are still played so that state such as construction progresses).

Frames are gitignored (about 350 MB per version); delete them after encoding.

## Director (`public/js/promo/director.js`)

**`setup()`:**
1. Starts Cortina with the real OSM layout, hides the HUD, and applies a contrast/saturation grade to the canvas.
2. Fast-forwards to Saturday 16 Jan 2027 (`catchUp`) and pre-runs the morning so skiers are spread out.
3. Prepares the scenes:
   - a construction site: a sunny slope with a valid 6-seat chair and, preferably, a red piste back down;
   - the race piste (Olimpia / Stratofana / Schuss): the steepest 150 m section, gates and red safety nets, a Finish Stadium, and about 500 spectators;
   - lit pistes for the night scene, and the busiest skier spot for the crowd shot;
   - a mock universe (fictional player names) for the map scene.
4. Builds the overlay DOM.

**Timeline** (seconds; the music is 120 BPM, so cuts fall on bar lines):

| t | Scene | Caption (it) |
|---|---|---|
| 0–4 | Morning light over Cortina towards Tofana, fade-in from black | *Montagne vere.* |
| 4–8 | Tofana slopes with real lift/piste names | *Impianti e piste reali* |
| 8–14 | A chairlift line grows (live towers, cost card), the lift gets built, a piste is drawn with its live difficulty colour | *Disegna il tuo comprensorio* |
| 14–18 | Close-up of a lift queue with skiers; stat chips (guests, rating, revenue) | *Migliaia di sciatori* |
| 18–22 | Snowstorm (wind chip), white flash, bluebird powder over Tofana | *Bufere, ghiaccio, neve fresca* |
| 22–25 | Night: lit pistes and a glowing village | *Di giorno e di notte* |
| 25–31 | World Cup downhill: chase cam behind a tucked racer, TV graphic (LIVE, bib, timer, km/h), then the finish with stadium and crowd | *Ospita la Coppa del Mondo* |
| 31–35 | World map zooming into the Alps with owned resorts and a leaderboard card | *Un universo online* |
| 35–40 | End card over a golden-hour aerial: logo, tagline, CTA "Gioca ora nel browser", "Link in bio", data credits | – |

- **Layout:** the vertical version keeps captions at 56–72 % of the height and cards in the top 10–40 %, out of the bottom UI zone of social apps. The horizontal version puts captions bottom-left and cards on the right.
- **Texts** live in `TEXT.it` and `TEXT.en`; add a language there.
- **Motion:** skiers move at about 20× real time (`SIM_DM`), and lift carriers animate at visual speed.

## Music (`tools/make-music.mjs`)

The track is pure synthesis in Node, with no samples, written as a 16-bit WAV:
- **Tempo and harmony:** 120 BPM in A minor, chords Am–F–C–G.
- **Instruments:** supersaw pad with filter sweeps, a 16th-note pluck arpeggio, a saw + sub bass sidechained to the kick, a lead hook with a dotted-eighth echo, and synthesized drums (kick, clap, hats, crash, impacts, risers, snare roll).
- **Mix:** Schroeder reverb on a send bus, tanh soft clip, peak normalized to −1 dBFS.
- **Structure:**

  | Time | Section |
  |---|---|
  | 0–8 s | intro, the filter opens |
  | 8 s | impact, the groove starts |
  | 22–25 s | breakdown with riser and snare roll |
  | 25 s | drop with the lead hook |
  | 35 s | final impact, logo sting, fade to 40 s |

Edit `CHORDS`, `HOOK` or the arrangement section and re-run `npm run music`.

## Social copy and caveats

See `promo/testi_social.md`. Before publishing:
- Put a public URL behind "Link in bio" (the game currently runs locally).
- The universe leaderboard names in the trailer are fictional.
- Listen to the track first: it was checked only by spectrogram and loudness. Or use the silent version with in-app audio.
