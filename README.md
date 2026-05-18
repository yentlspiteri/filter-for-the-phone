# Von Peach — Filter for the Phone

Web app version of the workshop concept, in Von Peach colours. Three placeholder questions answered by **tilting your head left or right**. After three answers, the user is sorted into **The Charmer**, **The Magician**, or **The Alchemist**, and gets a **tarot-card-styled portrait** designed to be shared on Instagram Stories.

## What's deployable

Only **`index.html`** is needed. Everything else in this folder is local scratch (PDF assets, the headless render preview, npm artifacts) and should not be uploaded to the GitHub Pages repo.

## What it does
- Loads the camera on the user's phone (HTTPS required — GitHub Pages handles this).
- Runs **MediaPipe Face Landmarker** in-browser to detect head roll from the eye landmarks. No data leaves the device.
- Asks three questions in sequence. Tilt past ~10° and **hold for 0.7 s** to commit an answer; a fill animation shows progress on the active side.
- A scoring map (`QUESTIONS` constant at the top of the `<script>`) maps each answer to one or two archetypes. Highest score wins; ties break Charmer → Magician → Alchemist.

## The share image
When the third answer is committed, the camera frame is frozen and composed onto a 1080×1920 portrait canvas:
- **Tarot-style card** on a Von Peach peach/wine backdrop with stylised leaf decor and a hand-drawn floral motif.
- The frozen portrait is treated as a **duotone** (deep wine → warm peach) and clipped inside the card.
- Top-left **XIII**, top-centre **∞**, top-right **♥** — matching the inspo deck.
- Archetype name in **Playfair Display italic** below the portrait.
- **VON PEACH** wordmark at the foot.

Two share routes:
- **Share to Instagram** → triggers `navigator.share` with the image file. On iOS / Android, Instagram appears in the share sheet → Stories or DM.
- **Save image** → falls back to a download. User opens Instagram and posts manually.

## Swapping in real copy
Top of the `<script type="module">` block in `index.html`:

- `ARCHETYPES.<key>.name` — display name on the card.
- `ARCHETYPES.<key>.blurb` — the short tagline under the card.
- `ARCHETYPES.<key>.duotone` — `dark` (shadow) and `light` (highlight) RGB triplets used for the duotone treatment of the photo. Tweak to taste per archetype.
- `ARCHETYPES.<key>.accents` — three hex colours used for the decorative leaf shapes around the card. Pick anything that flatters the duotone.
- `QUESTIONS` — three objects with `q` (question text) and `left` / `right` (label + per-archetype score weights).

## Tuning knobs
- `TILT_THRESHOLD_DEG` — default 10. Higher = users need to lean more.
- `HOLD_MS` — default 700. Higher = fewer accidental picks; lower = faster.
- `COOLDOWN_MS` — default 900. Pause after each commit so the next question doesn't fire immediately.

## Deploying
GitHub Pages, Netlify, or Vercel all work — `index.html` is the only file. Open the live URL on a phone, grant camera access, and run through it. HTTPS is mandatory for the camera permission and for the Instagram share sheet on mobile.

## Known limits
- Face tracking needs reasonable light.
- The web Instagram share sheet only works on the mobile app; desktop browsers will fall back to download.
- Once loaded, the page works offline (per the brief's "ADDITIONAL" note about laptop backup).
