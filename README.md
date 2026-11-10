# HoloFold

AR origami guide. Photograph any folding instructions; Claude reads the diagram, turns every step into crease geometry, and HoloFold projects a holographic overlay onto your real paper through the camera, one fold at a time.

## Quick start

```bash
npm install
cp .env.example .env        # add your ANTHROPIC_API_KEY (needed for scanning + AI checks)
npm run dev                 # http://localhost:5173
```

The five built-in models (Crane, Ninja Star, Paper Plane, Cup, Fortune Teller) work with no API key.

**On a phone:** browsers only allow the camera on secure pages, so run `npm run dev:https`, open the `https://<your-LAN-IP>:5173` address it prints, and accept the self-signed certificate warning.

## How it works

### 1. Understanding the instructions (not just OCR)

Origami diagrams are mostly symbols, not text: dashed valley lines, dash-dot mountain lines, curved arrows, "turn over" loops, push arrows, and step numbers. OCR would only pick up the step numbers. Instead, the photos go to **Claude (`claude-opus-5-5`) with vision and structured outputs**. Claude returns a typed plan (`shared/schema.ts`), where each step has:

- an imperative instruction, a tip, and an action type (valley, petal, inside-reverse, …)
- the paper **outline** at the start of the step, normalized to its bounding box, plus its aspect ratio
- **fold lines** with FOLD-style assignments (`V` valley, `M` mountain, `F` existing crease) and a `flap` point marking which side moves
- the box around that step's diagram in the photo, so the original drawing can be shown next to the hologram

The server streams Claude's summarized reasoning and a live step count to the scan screen over Server-Sent Events. With no photo, you can type a model name ("jumping frog") and Claude writes the steps from its own knowledge.

### 2. Tracking the real sheet

`src/lib/tracker.ts` runs on every camera frame in the browser, with no ML model to download:

1. Downsample to 240 px and segment pixels close to the paper's color (YCbCr distance, tolerant of shadows). The color is auto-sampled from the middle of the view, or locked by tapping the paper.
2. Clean up the mask and pick the best connected blob (big, near the last position, not touching the frame edge).
3. Take the convex hull and reduce it to as many corners as the step's outline has (Visvalingam).
4. **Sub-pixel corner refinement:** fit a line to each edge and intersect neighbouring edges. This undoes the corner rounding from the cleanup step, bringing corner error to about 1 px in tests.
5. Try every vertex correspondence and keep the best Procrustes fit, preferring the previous frame's ordering so the overlay doesn't spin. Then solve a **homography** from paper space to the image and smooth it over time.

### 3. Hologram rendering

`src/lib/renderer.ts` draws on a canvas over the video, mapped through the homography so everything sits on the paper in correct perspective:

- the glowing outline, corner brackets, grid and scan beam
- marching dashed creases (cyan = valley, magenta = mountain)
- a **ghost flap** folding along each crease, its landing outline, and a curved fold arrow

The ghost flap is the paper on the moving side of the crease, inside the crease segment's span, and bounded by the step's other non-moving creases. That bounding is what makes a petal fold lift a narrow kite instead of a whole half. The same geometry (`src/lib/fold.ts`) drives the animated SVG diagram in the side panel.

### Hologram preview before you start

Picking a model (a library card, or **Start AR guide** after a scan) first opens a full-screen preview: the finished model materializes above a glowing projector pad and spins as a blue dot-matrix hologram, with orbit rings, target reticles and HUD read-outs. The side panels show difficulty, step count, paper and the full fold sequence. Drag to turn the model by hand. **Confirm · Start folding** opens the camera guide, while **Back** or Esc closes the preview.

The crane, ninja star, glider plane, cup and fortune teller have hand-built low-poly 3D shapes modeled on photos of real folds (`src/lib/holoModels.ts`). Scanned or generated models show their final step's outline as a spinning hologram panel. Rendering (`src/lib/holoProjector.ts`) draws each face into a tiny offscreen buffer, one pixel per dot, then draws every lit pixel as a glowing square. That gives the LED-matrix look and keeps each frame cheap.

### 4. Checking your fold

Tap **Check my fold**, or turn on auto-check in settings. HoloFold sends the current frame, the step and the original diagram crop to Claude. You get *complete / keep going / not quite / can't see*, with spoken feedback, and it advances automatically when the fold is done. Auto-check only fires after the paper has moved and then held still (hands away).

Hands-free extras: say "next", "back", "repeat" or "check" (Web Speech API), and turn on 🔊 to have steps read aloud. Keys: ← → to change steps, Space for next, C to check.

### 5. Profiles, badges and streaks

Finishing a model earns XP and can unlock badges, so there's always a next goal.

- **Profiles:** everyone gets a guest profile in their browser after their first fold. **Sign in with Google** (optional) to keep it across devices: a guest profile becomes the account, and guest progress from another browser is merged in. Profiles are stored on the server in `data/accounts.json` (git-ignored), with a signed, HttpOnly session cookie.
- **XP and levels:** 10 XP per step (×1.5 medium, ×2 hard), +25 for finishing, +50 the first time you fold a model, +5 per step confirmed by **Check my fold**, +30 for your first fold of the day, and a streak bonus. Ten levels run from Paper Rookie to Origami Legend.
- **17 badges:** one per built-in model, plus Library Complete, Diagram Decoder (finish a scanned model), Dream Weaver (finish a generated one), Flawless (every step AI-confirmed), Summit (a hard model), 3- and 7-day streaks, 5/10/25 folds, Explorer (6 different models) and Crease Engine (250 steps).
- **Keep playing:** the finish screen shows XP, level-ups and new badges, then a **Next challenge** button that opens whatever moves you toward your closest badge. The home screen and profile show your next badges too.
- Folds faster than about 2.5 s per step don't count, so clicking straight through doesn't earn badges.

The rules live in `shared/progress.ts`; the server applies them and the client only displays them.

**Setting up Google sign-in:** create an OAuth client ID of type *Web application* at [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials). Add `http://localhost` and `http://localhost:5173` as *Authorized JavaScript origins*, put the ID in `.env` as `GOOGLE_CLIENT_ID=…`, and restart. Google doesn't accept bare IP addresses as origins, so on a phone opened by LAN IP the profile stays a guest. To use Google sign-in on a phone, serve the app from a real domain, for example a tunnel such as `cloudflared tunnel --url http://localhost:5173` (add its address as an origin too).

### 6. Themes, languages and Easy view

On first launch HoloFold asks **"Who's folding?"** and sets everything up in one tap:

| Answer | Theme | Easy view |
|---|---|---|
| Kid | **Paper Craft**: warm cream, rounded font, thick crayon-style fold lines, sticker badges | Large text, simple words, read aloud |
| Teen or adult | **Hologram**: the neon sci-fi HUD | none |
| Senior | **Washi**: paper texture, indigo and vermilion, Mincho headings, hanko-stamp badges | Large text, calm motion, high contrast, read aloud |

Everything can be changed from the **Aa** button: theme, language (English or 日本語) and each Easy view switch. Settings are saved per player on that device.

- Themes restyle the page through CSS variables (`data-theme` on `<html>`), and each also restyles the camera overlay (`src/lib/themes.ts`) and the spinning preview: a hologram, a paper model on a craft mat, or an ink drawing on a wooden stand. Valley and mountain lines always differ in both color and dash pattern.
- Languages: UI text is in `src/i18n/en.ts` and `ja.ts`, with "Simple words" variants in `simple.ts` (Japanese uses mostly hiragana). Built-in models are translated in `src/library/ja.ts`. Scans, generated steps and fold-check feedback come back from Claude in the chosen language. Steps are read aloud in a Japanese voice, and voice commands understand 次・戻る・もう一度・チェック.
- Easy view: Large text scales reading areas but never the camera stage. Calm motion stops flicker, scanning and marching lines. High contrast thickens fold lines and adds an outline so they show on any paper color.

## Ideas taken from similar projects

| Project | What HoloFold uses from it |
|---|---|
| [cv-assisted-origami](https://concavegit.github.io/cv-assisted-origami/tech) ([repo](https://github.com/concavegit/cv-assisted-origami)) | Its pipeline: threshold, contour, approximate the polygon with the *current step's side count*, then a homography to warp instructions onto the paper. HoloFold adds sub-pixel edge fitting, temporal smoothing and correspondence locking. |
| [Origami Sensei](https://mscvprojects.ri.cmu.edu/f23team15/method) (CMU) | Treat hand-covered frames as transitions and check progress only once the hands move away. Its ResNet classifier needs a training set for every model, so HoloFold uses a vision model instead, which works for any scanned model with no training. |
| [FOLD format](https://github.com/edemaine/fold) | Crease assignment letters `M`/`V`/`F`/`U` in the step schema. |
| [Origami Simulator](https://apps.amandaghassaei.com/OrigamiSimulator/) | Inspiration for previewing folds in motion. HoloFold uses a lightweight per-flap rotation rather than a physics solver, so it runs at camera frame rate. |
| [img2cp](https://github.com/hunger-cp/img2cp), [Origami guru](https://ir.swu.ac.th/entities/publication/7b1bd6ad-56eb-47d2-9413-fa6f60f2c724) | Background on reading crease patterns from images and overlaying the next step on the recognized paper state. |

## Tips for good tracking

- Fold on a **plain surface that contrasts with the paper**: colored paper on a light table, or white paper on a dark or wooden one.
- Tap the paper once to lock its color if the lock is flaky. ⚙ → "Show what the tracker sees" shows the mask.
- Keep the whole sheet in view. Larger folds track best; very small late-stage folds (crane head) get an approximate overlay.

## Project layout

```
server/index.ts      Express + Vite middleware; /api/parse (SSE), /api/verify, /api/health, /api/me, /api/auth/*, /api/progress; optional HTTPS
server/claude.ts     Claude calls: diagram → plan, frame → verdict (structured outputs, server-side fallback)
server/accounts.ts   Profiles (JSON store), session cookies, Google ID-token sign-in, guest merge
shared/progress.ts   XP, levels, streaks and badge rules shared by server and client
shared/schema.ts     Zod schema shared by server and client (the step format)
src/lib/tracker.ts   Paper segmentation, corner refinement, correspondence, homography
src/lib/renderer.ts  Canvas hologram overlay
src/lib/fold.ts      Fold geometry + animation timeline (shared by AR and SVG)
src/lib/geometry.ts  Hull, clipping, DLT homography, Procrustes
src/lib/holoModels.ts     Low-poly 3D shapes of finished models for the preview
src/lib/holoProjector.ts  Dot-matrix hologram renderer (projector pad, beam, HUD)
src/library/         Hand-authored models in the same format Claude produces
src/components/      Home, Scan, Guide (AR screen), HoloPreview (spinning popup), Profile, Rewards, Player (badges, avatar), StepHologram, HoloCrane
```

## Notes

- Calls use `claude-opus-5-5` with adaptive thinking. Set `HOLOFOLD_MODEL` in `.env` to use a different model. Requests opt into server-side refusal fallbacks (`fallbacks: "default"`).
- Scans are saved in the browser's localStorage on that device only.
- Later steps whose outline is not convex (crane wings, neck) are matched by their convex hull, so the overlay there is approximate.
