// Von Peach — AI royal-portrait + email-card Worker
//
// Two routes on one Worker:
//
//   POST /portrait
//     { image: "data:image/jpeg;base64,...", archetype: "charmer"|"magician"|"alchemist" }
//     → 200 { image: "data:image/jpeg;base64,..." }
//   Hands the photo to fal.ai's flux-kontext with an archetype-specific
//   Baroque prompt, proxies the result back inline.
//
//   POST /send-card
//     { email, archetype, archetypeName, image: "data:image/jpeg;base64,..." }
//     → 200 { ok: true }
//   Emails the card as a JPEG attachment via Resend, with an archetype-
//   specific short read in the body.
//
// Errors return JSON `{ error: <code>, ... }` with a 4xx/5xx status.
//
// Secrets (set via `wrangler secret put <NAME>`):
//   FAL_KEY      — fal.ai API key (https://fal.ai/dashboard/keys)
//   RESEND_KEY   — Resend API key (https://resend.com/api-keys)
//
// Vars (set in wrangler.toml or via dashboard):
//   FROM_EMAIL   — verified Resend sender, e.g. "Von Peach <hello@vonpeach.com>"

// Illustration pipeline: a Workers AI vision pre-pass + flux-pulid with the
// brand-locked illustrated-tarot prompts. Identity is anchored two ways:
//   1. A vision pre-pass (Llama 3.2 Vision) reads the photo and extracts
//      gender / hair colour+length or baldness / facial hair / eye colour,
//      which get baked into the prompt as a hard "the figure MUST be …"
//      directive. Without this the prompt is silent on identity and Flux
//      defaults to a generic woman — so men, bald subjects, and distinct
//      hair/eye colours were all being lost.
//   2. reference_image_url + id_weight on PuLID for facial likeness.
// We previously chained face-swap + CodeFormer + Clarity Upscaler to drive the
// output toward a polished photograph; those stages all fight the flat-
// illustration look we want now, so they're removed. Net: ~12s + ~$0.04 per
// portrait (the vision pre-pass adds ~2-3s; Workers AI is free-tier cheap).
//   docs: https://fal.ai/models/fal-ai/flux-pulid
//         https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/
// Two pipelines available. The legacy PuLID pipeline generates the styled
// character + scene from scratch with a face embedding (text-to-image with
// identity guidance). The Snapchat-style pipeline starts FROM the user's
// actual photo, cartoonifies it (preserving face structure / glasses /
// beard / hair pixel-by-pixel), then enriches with the tarot scene around
// them. The Snapchat pipeline is dramatically better at identity preservation
// but costs ~$0.06-0.08 per render (vs ~$0.04 for PuLID) and takes ~16-20s
// (vs ~12s). Toggle via PIPELINE env var:
//   "pulid"    (default, what's serving prod after the snapchat rollback)
//   "kontext"  (NEW — single-call FLUX.1 Kontext, image-to-image with prompt-
//              guided style transfer. Closest-to-Snapchat identity preservation.
//              Per-request override available via ?pipeline=kontext for testing.)
//   "snapchat" (legacy two-stage; face-to-many call body was malformed and the
//              pipeline produced 4xx in prod. Kept disabled until #16's call
//              body is corrected; do not enable.)
//   docs: https://fal.ai/models/fal-ai/flux-pulid
//         https://fal.ai/models/fal-ai/flux-pro/kontext     ($0.04/image)
//         https://fal.ai/models/fal-ai/face-to-many         (legacy/broken)
//         https://fal.ai/models/fal-ai/flux/dev/image-to-image
const FAL_PULID_URL          = "https://fal.run/fal-ai/flux-pulid";
const FAL_KONTEXT_URL        = "https://fal.run/fal-ai/flux-pro/kontext";
const FAL_FACE_TO_MANY_URL   = "https://fal.run/fal-ai/face-to-many";
const FAL_FLUX_I2I_URL       = "https://fal.run/fal-ai/flux/dev/image-to-image";
// Back-compat alias (used by older log lines + may be referenced elsewhere)
const FAL_URL = FAL_PULID_URL;
const RESEND_URL = "https://api.resend.com/emails";

// Universal illustrated-tarot-card layer — placed at the FRONT of every
// prompt (PuLID weights early tokens most heavily). Locks the visual
// language across all eight cards: bold cel-shaded animated graphic-novel
// art on peach paper with deep-wine/near-black linework and brand
// orange/red accents. Modern animated-tarot aesthetic — think Western
// animation concept art (Disney/Pixar character energy) crossed with a
// hand-inked tarot deck, NOT flat poster art.
const STYLE_LEAD =
  "BOLD CEL-SHADED ANIMATED GRAPHIC-NOVEL TAROT ILLUSTRATION, in a " +
  "modern Western animation style — think Disney/Pixar concept art " +
  "crossed with a hand-inked comic-book tarot deck. NOT A PHOTOGRAPH. " +
  "NOT PHOTOREALISTIC. NOT A PHOTO COMPOSITE. NOT ANIME OR MANGA. The " +
  "ENTIRE image — face, skin, hair, eyes, lips, hands and everything " +
  "else — is drawn in the SAME bold ink-illustration language with " +
  "HEAVY DEEP-WINE OR NEAR-BLACK LINEWORK outlines, smooth solid " +
  "colour fills, and clean cel-shaded volumes that give the figure " +
  "real weight and dimension. The character has an EXPRESSIVE " +
  "ANIMATED-FILM FACE with large lively comic-style eyes (clearly " +
  "drawn pupils + simplified eyelid shapes), a clearly drawn open or " +
  "smiling mouth, drawn nose lines, and flat-fill skin tone — vibrant " +
  "animated-character energy, NEVER a photographic face on an " +
  "illustrated body. Strong DYNAMIC MID-ACTION POSE with clear " +
  "gestural movement — not a stiff frontal beauty shot. Edge-to-edge " +
  "artwork that completely fills the frame with DENSELY ILLUSTRATED " +
  "SYMBOLIC BACKGROUND MOTIFS (architecture, weather, props, " +
  "creatures relevant to the archetype) — no white margins, no empty " +
  "space, no centred 'spotlight' composition with blank surroundings. " +
  "LIMITED BRAND PALETTE — applied to the BACKGROUND, LINEWORK, " +
  "GARMENTS and DECORATIVE MOTIFS only (NOT to the subject's face, " +
  "skin, hair or eyes): warm peach paper (#FFD6BB) for the background, " +
  "deep wine red (#99112F) for linework, shadows and fills, brand " +
  "orange (#FD8839) for highlights and warm accents, brand red " +
  "(#CC1C0E) for flames and bold accents. HAIR, SKIN AND EYE COLOUR " +
  "ARE THE EXCEPTION — render them in the subject's REAL NATURAL " +
  "colours from the reference photo: a brunette has BROWN hair, a " +
  "blonde has BLONDE hair, blue eyes stay BLUE, green eyes stay " +
  "GREEN, brown eyes stay BROWN, dark skin stays DARK, fair skin " +
  "stays FAIR. DO NOT recolour hair or eyes to brand orange or wine " +
  "red — only the wardrobe and background follow the brand palette. " +
  "WARDROBE — MODERN EXECUTIVE / PROFESSIONAL attire: tailored blazers, " +
  "structured coats, crisp shirts, sharp open-collar pieces, fitted " +
  "leather jackets, professional dress (gender-appropriate to the " +
  "subject) — NOT full fantasy robes, NOT hooded medieval cloaks, NOT " +
  "dressing gowns. The archetype's thematic symbolism appears as " +
  "ACCENTS on the modern attire (rune-embroidered lapels or cuffs, " +
  "decorative trim along the collar or coat-line, a thematic pocket " +
  "square, an emblem on the shoulder) and in the BACKGROUND — not as " +
  "the literal garment shape. These figures are modern game-changers " +
  "in tarot symbolism, not medieval mystics. Wardrobe palette stays " +
  "on brand: deep wine red, peach, brand orange, near-black. " +
  "PROPORTIONS — render the subject's face and body with NATURAL, " +
  "FAITHFUL proportions. Do NOT exaggerate or caricature any feature " +
  "(ears, nose, chin, eyes, mouth). The animated illustration style " +
  "is NOT a license for comic caricature — features stay proportional " +
  "to the real subject. ";

const STYLE_TRAIL =
  " The face is rendered in the SAME bold ink-illustration language as " +
  "the rest of the figure — large drawn comic-style eyes with bright " +
  "visible pupils, BOTH PUPILS ALIGNED AND LOOKING IN THE SAME " +
  "DIRECTION (parallel gaze, NOT cross-eyed, NOT walleyed, NOT a lazy " +
  "eye — both irises symmetrically placed at the same height with the " +
  "same gaze angle), drawn lips with clear shape, drawn nose lines, " +
  "cel-shaded skin in the subject's REAL natural skin tone with heavy " +
  "outline (do NOT recolour the skin to peach or orange — keep the " +
  "real skin tone from the reference photo), vivid animated-character " +
  "expression. The hairstyle, hair length, NATURAL hair colour (e.g. " +
  "brown for a brunette, blonde for a blonde — NOT orange or wine), " +
  "natural eye colour, face shape and overall identity should match " +
  "the reference subject — rendered as an animated graphic-novel " +
  "character, not a photograph. The background fills every corner of " +
  "the frame with densely illustrated thematic motifs that tell the " +
  "archetype's story (buildings, weather, props, creatures, smoke or " +
  "flame patterns appropriate to the scene). NO heraldic crest, shield " +
  "badge, escutcheon, coat-of-arms, fortress emblem, ornate seal or any " +
  "central badge graphic at the TOP of the card — the upper-card area " +
  "must be clear scene illustration (sky, atmosphere, decorative motifs " +
  "appropriate to the archetype), NOT a heraldic emblem. The brand sigil " +
  "is composited separately and needs the top of the card uncluttered. " +
  "No text on the card, no " +
  "caption, no banner, no logo, no watermark. No photographic skin " +
  "texture, no photographic eyes, no skin pores, no real hair strands, " +
  "no off-palette hues, no white empty margins, no stiff frontal " +
  "beauty-pose composition, no flat blank background.";

// Static negative-prompt — shared by both the PuLID pipeline (text-to-image
// generation) and the Snapchat-style pipeline's Stage 2 (image-to-image
// scene enrichment). Per-subject negatives (opposite-gender, beardless-when-
// bearded, etc.) are appended at the call site via buildSubjectNegative.
const BASE_NEGATIVE_PROMPT =
  "photograph, photo, photorealistic, realistic face, real photo, " +
  "photographic face on illustrated body, photo composite, " +
  "mixed media photo-illustration, real human face, " +
  "DSLR photo, photographic skin texture, skin pores, fine pores, " +
  "individual hair strands, photographic eyes, eye reflections, " +
  "catchlights, real eyelashes, " +
  "blurry, shallow depth of field, bokeh, lens flare, film grain, " +
  "studio photo, headshot photo, portrait photo, " +
  "white empty margin, white border, blank space, centred " +
  "spotlight composition, isolated subject on plain background, " +
  "incomplete background, vignette, dark margins, " +
  "stiff frontal pose, beauty shot, expressionless face, " +
  "neutral closed-mouth expression, flat affect, lifeless eyes, " +
  "small beady eyes, dead-eyed stare, " +
  "cross-eyed, walleyed, lazy eye, strabismus, wandering eye, " +
  "asymmetric pupils, pupils pointing different directions, " +
  "misaligned gaze, one eye higher than the other, " +
  "uneven eye sizes, mismatched eye shape, googly eyes, " +
  "pupil drift, off-centre pupils, " +
  "caricature, exaggerated features, oversized ears, " +
  "enormous ears, dumbo ears, comically large ears, " +
  "oversized nose, enormous nose, exaggerated nose, " +
  "oversized chin, enormous chin, exaggerated jawline, " +
  "exaggerated facial proportions, distorted facial features, " +
  "feature caricature, comic book caricature, " +
  "fantasy robe, medieval robe, hooded medieval cloak, " +
  "wizard robe, monk robe, mage robe, druidic robe, " +
  "dressing gown, bathrobe, fairy-tale robe, " +
  "thin sparse linework, faint outlines, washed-out colours, " +
  "flat poster art, sticker-like figure, low-detail background, " +
  "anime, manga, chibi, 3D render, CGI, sculpture, statue, " +
  "deformed face, asymmetric face, distorted face, bad anatomy, " +
  "watermark, text, caption, banner, signature, logo, " +
  "complex gradients, rainbow colours, multi-coloured background, " +
  "saturated neon background, off-palette background, " +
  "heraldic crest at top of card, top-card emblem, escutcheon, " +
  "ornate shield badge at top, coat-of-arms graphic, fortress emblem, " +
  "central top-of-card seal, heraldic badge, top-card insignia, " +
  "orange hair, wine-red hair, brand-coloured hair, " +
  "orange eyes, red eyes, brand-coloured eyes, " +
  "orange skin, peach-recoloured skin, wine-tinted skin";

// Illustrated tarot card scenes — each archetype is a dramatic
// vector-poster scene with the figure mid-action and a symbolic
// background. The shared STYLE_LEAD goes at the front and STYLE_TRAIL
// at the back of every prompt (see getPromptFor below). Each archetype
// has 5 scene variants for visual variety
// across generations.
// ---- GENDER-RESTRICTED RARES ----
// Some Major Arcana cards are explicitly female-coded in their Kontext
// prompts (Empress: flowing dress, pomegranate scepter, mother energy;
// Witch: black cat familiar, knowing-feminine mischief). When a male
// user lands on one via the client's RARE_RULES roll, the render either
// fights the prompt or comes back uncanny. handlePortrait checks this
// table BEFORE the AI render runs and swaps to the user's common
// archetype if there's a mismatch.
//
// Values: "female" | "male". To add a male-coded restriction later
// (e.g., if we add The Emperor or The Hierophant as exclusively male),
// just add another entry here — no other code changes needed.
const GENDER_RESTRICTIONS = {
  witch:   "female",
  empress: "female",
};

// Loose match — the detector returns phrases like "woman", "man", "male",
// "female", sometimes with hedges. Substring match is the most forgiving.
function genderMatches(detected, required) {
  const d = String(detected).toLowerCase();
  if (required === "female") return /\bwoman\b|\bfemale\b/.test(d);
  if (required === "male")   return /\bman\b|\bmale\b/.test(d);
  return true;
}

// Convert a data URL like "data:image/jpeg;base64,...." to a Uint8Array
// for passing into the Workers AI vision detectors. Throws on invalid
// input — caller is expected to guard upstream.
function dataUrlToUint8Array(dataUrl) {
  const b64 = String(dataUrl).split(",").pop();
  return base64ToUint8Array(b64);
}

const PROMPT_TEMPLATES = {
  charmer: {
    base:
      "Illustrated tarot card: 'The Charmer'. Three-quarter-body " +
      "figure in flowing dramatic wine-red attire (robe, tunic, or " +
      "sharp open-collar coat — appropriate to the subject's gender) " +
      "with peach highlights, arms gracefully outstretched in a " +
      "welcoming gesture, warm magnetic smile. Background of an " +
      "elegant social scene — distant silhouetted dancers and " +
      "refined-party guests in the middle distance, a chandelier " +
      "glow above, scattered red roses and rose petals drifting " +
      "through the air, ribbons of light swirling around the " +
      "figure, vintage champagne coupes scattered decoratively, " +
      "glowing candle motifs framing the corners — warm intimate " +
      "atmosphere. ",
    props: [
      "Variant: arms wide open in a hosting gesture, large red roses " +
        "tumbling through the air around the figure, decorative " +
        "spiral motifs swirling behind in peach and orange.",
      "Variant: one hand offered forward as if inviting the viewer to " +
        "dance, the other hand holding a single long-stemmed rose, " +
        "gown billowing dramatically.",
      "Variant: head tilted slightly with a confident knowing smile, " +
        "fingers grazing a string of pearls at the throat, " +
        "rose-vine motifs framing the figure.",
      "Variant: arms crossed elegantly over the chest holding a posy " +
        "of roses, decorative heart motif and swirling ribbon " +
        "patterns in the background.",
      "Variant: one arm raised holding a vintage champagne coupe in a " +
        "mid-toast gesture, scattered rose petals and swirling " +
        "decorative flourishes filling the background.",
    ],
  },
  magician: {
    base:
      "Illustrated tarot card: 'The Magician'. Three-quarter-body " +
      "figure in a sharp tailored dark blazer or structured overcoat " +
      "with rune-embroidered lapels and cuffs, crisp shirt visible " +
      "underneath, one hand raised commanding the elements, sharp " +
      "determined gaze. Background of an arcane workshop — a " +
      "glowing runic circle inscribed in the air around the " +
      "figure, swirling abstract flame patterns rising upward, " +
      "floating ancient glyphs and arcane sigils, a halo of small " +
      "magical sparks, decorative occult symbols carved into the " +
      "surrounding stone architecture, a distant vaulted-temple " +
      "silhouette in the deep background — dramatic occult " +
      "atmosphere. ",
    props: [
      "Variant: one arm raised high holding a slim wand or staff, " +
        "flames and rune symbols swirling in a halo around the upper " +
        "body, hood casting a sharp shadow across the brow.",
      "Variant: both hands raised conjuring a glowing orb of light " +
        "between the palms, swirling flame patterns and runic symbols " +
        "filling the background.",
      "Variant: one hand outstretched with sparks and small flames " +
        "leaping from the fingertips, the other tucked into the robe, " +
        "decorative rune circles framing the figure.",
      "Variant: holding a fanned spread of tarot cards in one hand, " +
        "the other raised in a casting gesture, abstract flame motifs " +
        "and arcane glyphs swirling behind.",
      "Variant: one hand brought to the lips in a knowing 'shh' " +
        "gesture, the other holding a wand pointed downward, halo of " +
        "runes glowing around the head.",
    ],
  },
  alchemist: {
    base:
      "Illustrated tarot card: 'The Alchemist'. Three-quarter-body " +
      "figure in a structured deep-wine-red blazer with sleeves " +
      "rolled to the forearms over a tailored vest and crisp shirt, " +
      "rune-embroidered pocket square and lapel detail in brand " +
      "orange, focused determined expression, one hand gesturing " +
      "over a steaming vessel. Background of an alchemist's " +
      "laboratory — bubbling cauldrons and glass alembic flasks on " +
      "shelves, copper distillation apparatus with curling vapor, " +
      "stacked grimoires and leather-bound tomes, golden " +
      "transmutation symbols floating in the smoke, a brass mortar " +
      "and pestle, runic glyphs etched into the wall behind, " +
      "decorative spirals of vapor rising into sigil patterns — " +
      "atmospheric and scholarly. ",
    props: [
      "Variant: leaning over a bubbling cauldron with one hand " +
        "stirring above it, billowing smoke rising into runic glyphs " +
        "in the air, dramatic robe folds.",
      "Variant: holding a glass alembic flask up to the light, the " +
        "liquid catching highlights, swirling runic patterns and " +
        "transformation motifs around the figure.",
      "Variant: one hand pouring shimmering liquid from a brass " +
        "vessel, vapour rising into swirling sigil patterns, robe " +
        "billowing dramatically behind.",
      "Variant: both palms cupping a glowing orb of transmuted " +
        "energy, ancient script and decorative flourishes spiralling " +
        "around the figure.",
      "Variant: leaning thoughtfully over an open grimoire with " +
        "alchemical symbols visible, smoke rising from a small " +
        "burner, runic patterns filling the background.",
    ],
  },
  oracle: {
    base:
      "Illustrated tarot card: 'The Oracle'. Three-quarter-body " +
      "figure in a sharp tailored layered look — a structured " +
      "wine-red blazer or open overcoat over a silky shirt or " +
      "blouse, with celestial-embroidered trim along the collar and " +
      "lapels — a serene knowing expression with eyes that seem to " +
      "look past the viewer. Background of a celestial divination " +
      "chamber — floating crystal orbs reflecting starfields, " +
      "scattered tarot cards drifting through the air, glowing " +
      "moon-phase symbols, an all-seeing eye motif framed by " +
      "decorative ornament, swirling constellations and zodiac " +
      "wheel fragments, an open book of prophecy with luminescent " +
      "script, ribbons of stardust wrapping around the figure — " +
      "mystical and otherworldly. ",
    props: [
      "Variant: both hands cradling a glowing crystal orb at chest " +
        "height, the orb radiating decorative light beams, stars and " +
        "moon phases scattered through the background.",
      "Variant: one hand raised palm-up with a small constellation " +
        "of stars hovering above the fingertips, robes flowing into " +
        "celestial swirl patterns.",
      "Variant: head slightly turned, one finger touched to the " +
        "temple as if hearing a whisper, decorative eye motifs and " +
        "starbursts framing the figure.",
      "Variant: holding a vintage hand mirror angled to one side, " +
        "reflective light and decorative starlight motifs swirling " +
        "around the figure.",
      "Variant: arms crossed protectively over the chest holding a " +
        "silk-wrapped deck of cards, halo of stars and abstract " +
        "celestial swirls filling the background.",
    ],
  },
  rebel: {
    base:
      "Illustrated tarot card: 'The Rebel'. Dynamic full-body figure " +
      "in a leather jacket and battered trousers, mid-leap or " +
      "defiant stance, wry knowing half-smile and fierce eyes. " +
      "Background of disruption and defiance — a cracked stone " +
      "wall behind the figure with deep fissures, jagged flame " +
      "patterns leaping upward, broken chains scattering through " +
      "the air, torn-up rule scrolls and shredded paper drifting, " +
      "graffiti-style decorative tags on the surrounding surfaces, " +
      "sparks and stone shards flying outward, a distant burning " +
      "institutional building silhouette — high-energy and " +
      "rebellious. ",
    props: [
      "Variant: leaping forward with arms raised triumphantly, broken " +
        "chains scattering in the air, flame motifs swirling at the " +
        "feet, hair caught mid-motion.",
      "Variant: standing defiantly with one fist raised, chain " +
        "wrapped around the forearm, jagged graffiti-style patterns " +
        "and flames in the background.",
      "Variant: kicking through a cracked stone wall with one boot, " +
        "shards of stone flying outward, abstract flame patterns " +
        "filling the background.",
      "Variant: one hand on a hip in a confident sneer, other hand " +
        "holding a torch flaring with abstract flame motifs, jacket " +
        "billowing dramatically behind.",
      "Variant: tearing apart a paper scroll labelled with abstract " +
        "rules, pieces scattering in the air, sharp jagged background " +
        "patterns suggesting movement and disruption.",
    ],
  },
  monk: {
    base:
      "Illustrated tarot card: 'The Monk'. Full-body figure seated in " +
      "a meditative cross-legged pose or standing serenely, wearing " +
      "minimalist tailored attire — a clean unbuttoned linen-style " +
      "shirt under an open structured peach-and-wine coat, " +
      "understated but high-quality — eyes gently closed or open " +
      "with quiet directness. Background of serene contemplation — " +
      "distant mist-shrouded mountain silhouettes layered into the " +
      "deep distance, an ancient temple roof framed at one edge, " +
      "a koi-pond surface rippling at the figure's feet, lotus " +
      "petals drifting upward in clusters, a halo of concentric " +
      "radiating lines around the head, bamboo silhouettes in the " +
      "middle distance, prayer flags fluttering at the upper edges, " +
      "decorative cloud motifs — quiet meditative atmosphere. ",
    props: [
      "Variant: seated in lotus position with palms upward in the " +
        "lap, halo of concentric circles radiating outward, lotus " +
        "petals scattered in the background.",
      "Variant: standing with hands clasped at the chest in a gentle " +
        "prayer gesture, decorative mountain silhouettes and rising " +
        "sun-rays in the background.",
      "Variant: kneeling with one hand resting on a small stone " +
        "altar, the other raised in benediction, decorative " +
        "swirling-water motifs at the feet.",
      "Variant: walking with a wooden staff in one hand, robes " +
        "flowing gently, distant mountain peaks and a thin path " +
        "winding through the background.",
      "Variant: seated cross-legged holding a small singing bowl in " +
        "both hands, sound-ripple motifs and lotus flowers " +
        "decorating the background.",
    ],
  },
  architect: {
    base:
      "Illustrated tarot card: 'The Architect'. Three-quarter-body " +
      "figure in a structured long coat with geometric trim, focused " +
      "considered expression. Background of a visionary's design " +
      "studio — an unrolled blueprint scroll spreading across the " +
      "lower portion with sketched-line buildings emerging from " +
      "it, floating geometric solids (cube, sphere, pyramid) " +
      "suspended in the air, a brass drafting compass overlaying " +
      "the scene, ruled grid paper textures behind, an abstract " +
      "cityscape silhouette of modernist towers in the far " +
      "distance, golden-ratio spirals decorating the corners, " +
      "paper airplanes drifting through — visionary and ordered, " +
      "in peach and wine. ",
    props: [
      "Variant: holding a large brass compass / divider open between " +
        "both hands at chest height, geometric grid patterns and " +
        "skyline silhouettes filling the background.",
      "Variant: standing in front of an unrolled blueprint scroll " +
        "with one hand pointing at a sketched structure, geometric " +
        "wireframes and tower silhouettes in the background.",
      "Variant: arms folded thoughtfully across the chest while " +
        "surveying a floating geometric model (cube, sphere, " +
        "pyramid) hovering before the figure, grid lines radiating outward.",
      "Variant: one hand sketching mid-air with a glowing pencil, " +
        "intricate geometric construction lines forming a building " +
        "skeleton in the air, abstract grid in the background.",
      "Variant: seated at a drafting table angled forward, fingers on " +
        "a half-drawn plan, blueprint patterns and architectural " +
        "silhouettes filling the background.",
    ],
  },
  luminary: {
    base:
      "Illustrated tarot card: 'The Luminary'. Commanding full-body " +
      "figure in a sharp tailored ceremonial blazer or executive " +
      "long coat with ornamental gold-and-wine trim along the " +
      "lapels and cuffs, crisp shirt visible underneath, open " +
      "confident smile, radiant presence. Background of a " +
      "commanding stage — rays of golden light fanning outward " +
      "from behind the figure's head as a halo, an abstract " +
      "throne silhouette at the figure's back, a crowd of small " +
      "silhouetted admirers facing the figure in the lower " +
      "portion, banners and pennants unfurling from the upper " +
      "corners, decorative laurel-wreath motifs framing the scene, " +
      "decorative columns and arches suggesting a grand hall, a " +
      "podium or platform at the figure's feet — bright commanding " +
      "atmosphere. ",
    props: [
      "Variant: standing tall with one hand raised in greeting, the " +
        "other holding a tall slim staff, halo of radial sun-rays " +
        "fanning out behind the head.",
      "Variant: seated on an abstract throne silhouette with arms " +
        "open in a welcoming gesture, decorative laurel-wreath motifs " +
        "and radiating beams in the background.",
      "Variant: arms crossed confidently with a small crown or " +
        "circlet on the brow, sun-ray motifs filling the background.",
      "Variant: holding a glowing torch high in one hand, light beams " +
        "radiating outward, the other hand resting on the hip, " +
        "decorative laurel patterns at the feet.",
      "Variant: striding forward with one hand outstretched palm-up " +
        "offering a glowing flame, abstract crowd silhouettes in " +
        "the lower background looking toward the figure.",
    ],
  },
  // ---- RARE: The Witch ----
  // Deliberately distinct visual language from the other archetypes: moonlit
  // and herbal rather than firelit / runic. Black cat familiar + open
  // grimoire are the recognisable witch shorthand. Wardrobe stays modern
  // (per the global STYLE_LEAD directive — no fantasy robes) but trim is
  // pushed slightly more occult: pentacle clasps, embroidered moon-and-stars
  // along the collar, crystal pendant. The face stays grounded — knowing
  // half-smile, not theatrically wicked.
  witch: {
    base:
      "Illustrated tarot card: 'The Witch'. Three-quarter-body figure " +
      "in a structured deep-wine-red coat or layered tailored cape over " +
      "a high-collared shirt — modern silhouette with peach-embroidered " +
      "moon-and-stars trim along the collar and lapels, a small pentacle " +
      "or crescent clasp at the throat, a faceted crystal pendant " +
      "catching light. Knowing half-smile with a hint of mischief, eyes " +
      "level and assured. Background of a moonlit witch's grove and " +
      "study — a large crescent moon hanging in a deep starlit peach " +
      "sky, bare moonlit branches arching overhead, an open grimoire " +
      "floating mid-air with glowing peach script and arcane diagrams, " +
      "a sleek black cat familiar perched nearby with golden eyes, " +
      "bundles of dried herbs and pressed flowers hanging in the " +
      "corners, scattered quartz crystals and bone-white candles on a " +
      "low stone surface, swirling smoke forming sigils and runic " +
      "patterns in the air, decorative pentacle motifs woven into the " +
      "background ornament — mystical, grounded, distinctly nocturnal. ",
    props: [
      "Variant: one hand cupping a small floating orb of moonlight, the " +
        "other turning a page of a floating grimoire, the black cat " +
        "perched on the figure's shoulder, swirling moon-and-star " +
        "motifs filling the background.",
      "Variant: arms spread low and forward conjuring above a glowing " +
        "circle inscribed with pentacles, the black cat sitting at the " +
        "feet looking up, crescent moon haloed behind the head, herbs " +
        "and crystals scattered in the foreground.",
      "Variant: holding a slim wand of dark wood with a faceted crystal " +
        "tip in one hand, the other resting on the open grimoire, " +
        "scattered tarot cards drifting through the moonlit air, dense " +
        "starfield filling the upper background.",
      "Variant: one hand brought to the lips in a hushed 'shh' gesture " +
        "with a knowing smile, the other holding a single sprig of " +
        "wildflowers or wormwood, the black cat curled in the lower " +
        "corner, runic glyphs glowing faintly around the figure.",
      "Variant: leaning thoughtfully over a small cauldron at waist " +
        "height with one hand sprinkling herbs into it, vapour rising " +
        "into sigil patterns, the crescent moon large above, the cat " +
        "watching from a stack of leather-bound spellbooks.",
    ],
  },
  // ============================================================
  // RARE: MAJOR ARCANA ADDITIONS (PR B of deck expansion).
  // ============================================================
  // Each of these is a rare card gated by RARE_RULES on the client.
  // Patterns are designed to be non-overlapping where possible; when
  // they overlap, the FIRST matching rule in RARE_RULES wins.
  // Wardrobe stays modern (per global STYLE_LEAD); thematic motifs
  // appear as background, trim, and props — not as fantasy costume.

  // The Fool — curious wanderer, beginnings, the leap of faith.
  // Visual shorthand: a small dog companion, a bag on a stick, a
  // cliff edge with bright sky beyond.
  fool: {
    base:
      "Illustrated tarot card: 'The Fool'. Three-quarter-body " +
      "figure in a structured deep-wine-red coat or sharp tailored " +
      "jacket worn open over a casual collared shirt — modern " +
      "wanderer silhouette with peach-embroidered trim along the " +
      "lapels and a small cloud-and-sun motif at the cuffs. Bright, " +
      "open expression with a half-smile of curiosity, eyes lifted " +
      "to the horizon. Background of a sunlit clifftop edge against " +
      "a peach sky — golden-orange sunrise low on the horizon, " +
      "scattered drifting clouds catching the warm light, a small " +
      "loyal dog companion at the figure's heel looking up, a " +
      "leather satchel slung over one shoulder, distant mountains " +
      "and a winding road snaking out behind, white birds " +
      "scattering upward into decorative spiral motifs, swirling " +
      "wind patterns sweeping the cliff edge — open, hopeful, " +
      "edge-of-everything atmosphere. ",
    props: [
      "Variant: one foot stepped forward over the cliff edge with " +
        "arms spread wide in an open-armed leap of faith, dog at " +
        "the heels, sunrise filling the background.",
      "Variant: holding a small white flower up to the light in " +
        "one hand, satchel over the shoulder, the dog companion " +
        "trotting alongside, swirling cloud motifs in the sky.",
      "Variant: walking forward looking back over one shoulder with " +
        "a knowing smile, hand on the satchel strap, the road " +
        "behind disappearing into distant peach mountains.",
      "Variant: arms stretched up to the sky in a celebratory " +
        "gesture, scattered white birds bursting upward, the dog " +
        "leaping joyfully at the feet.",
      "Variant: standing at the very edge of the cliff with one hand " +
        "shading the eyes looking outward, walking-stick planted at " +
        "the side, swirling wind patterns through the hair.",
    ],
  },

  // The Empress — abundance, creativity, fertile ground, the source.
  // Visual shorthand: crown of stars, grain and pomegranates, a
  // verdant garden, flowing water.
  empress: {
    base:
      "Illustrated tarot card: 'The Empress'. Three-quarter-body " +
      "figure in a flowing deep-wine-red dress or layered drape " +
      "with peach embroidered vine-and-pomegranate motifs along " +
      "the neckline and sleeves, a delicate circlet of twelve small " +
      "stars resting on the brow, soft knowing smile, eyes steady " +
      "and generous. Background of a verdant abundant garden — " +
      "ripe pomegranates and golden wheat heads framing the figure, " +
      "trailing peach roses and ivy vines, a small stream of " +
      "shimmering water curling through the foreground, a heart-and-" +
      "Venus glyph carved into a decorative stone tablet to one " +
      "side, lush trees in the deep background, butterflies " +
      "scattering through the air, decorative spiral and floral " +
      "motifs in the corners — fertile, generous, growing-everywhere " +
      "atmosphere. ",
    props: [
      "Variant: one hand resting on a stylised pomegranate-laden " +
        "scepter, the other extended palm-up offering wheat heads, " +
        "garden vines climbing the background.",
      "Variant: arms wrapped gently around a bouquet of peach roses " +
        "and ripe pomegranates, the stream curling behind, " +
        "butterflies drifting around the figure.",
      "Variant: one hand placed protectively over the heart, the " +
        "other lifting a pomegranate to inspect it, twelve-star " +
        "circlet glowing faintly above the head.",
      "Variant: seated-pose feeling, leaning gracefully against a " +
        "decorative garden bench, vines and roses spiralling around " +
        "the figure, golden grain motifs filling the corners.",
      "Variant: standing tall with both hands raised offering " +
        "scattered seeds to the wind, sprouting vines following the " +
        "gesture, decorative Venus glyph centred behind.",
    ],
  },

  // The Hierophant — tradition, teaching, structured wisdom.
  // Visual shorthand: triple crown, crossed keys, pillared chamber.
  hierophant: {
    base:
      "Illustrated tarot card: 'The Hierophant'. Three-quarter-body " +
      "figure in a sharp tailored deep-wine-red coat or structured " +
      "long jacket over a high-collared shirt, peach embroidered " +
      "geometric trim along the lapels and cuffs, a small triple-" +
      "tiered emblem at the throat, calm authoritative expression. " +
      "Background of a vaulted teaching chamber — two stone pillars " +
      "framing the figure, an open ancient codex floating mid-air " +
      "with glowing peach script, a pair of crossed brass keys " +
      "displayed prominently in the upper background, decorative " +
      "rosette and quatrefoil motifs carved into the stone, a row " +
      "of small candle flames floating at the foot, geometric " +
      "interlocking patterns filling the architecture, scattered " +
      "scrolls and parchment fragments — scholarly, structured, " +
      "weight-of-tradition atmosphere. ",
    props: [
      "Variant: one hand raised in a teaching gesture with two " +
        "fingers extended, the other holding a slim staff topped " +
        "with the triple-tier emblem, crossed keys glowing behind.",
      "Variant: both hands resting on an open codex held at chest " +
        "height, candle flames floating around the figure, pillars " +
        "framing the composition.",
      "Variant: holding a single brass key forward as if offering " +
        "it to the viewer, the other crossed key floating in the " +
        "background, scrolls scattered at the feet.",
      "Variant: one hand placed on a stone tablet inscribed with " +
        "geometric glyphs, the other holding a smoking censer, " +
        "decorative rose-window motif glowing behind the head.",
      "Variant: arms folded across the chest in a stance of quiet " +
        "authority, the triple-tier emblem floating above the head, " +
        "candle flames lining the lower foreground.",
    ],
  },

  // The Lovers — partnership, choice, the bond.
  // Visual shorthand: two figures (but we render one), an angel
  // above, a sun, a garden of choice.
  lovers: {
    base:
      "Illustrated tarot card: 'The Lovers'. Three-quarter-body " +
      "figure in flowing deep-wine-red attire — tailored open-collar " +
      "jacket or soft draped layer over a crisp shirt — with " +
      "peach-embroidered heart-and-flame motifs along the lapel and " +
      "a small linked-rings emblem at the cuff. Warm open expression " +
      "with a knowing smile, one hand resting over the heart. " +
      "Background of a garden-at-choice — a large radiant sun " +
      "centred high above with peach rays spreading wide, a stylised " +
      "winged figure or angel motif sketched into the upper sky in " +
      "peach linework, two paths diverging into the lower background, " +
      "flowering trees on either side (one full of fruit, one in " +
      "bloom), scattered intertwined ribbons in peach and wine, " +
      "decorative heart and flame motifs framing the corners — " +
      "warm, charged, choice-and-connection atmosphere. ",
    props: [
      "Variant: one hand placed over the heart, the other extended " +
        "to the side as if offering a hand to an unseen partner, " +
        "sun radiating wide above.",
      "Variant: arms crossed gently with linked-rings emblem held " +
        "between the hands, the angel motif glowing softly above, " +
        "flowering trees framing the background.",
      "Variant: one hand holding a single long-stemmed peach rose, " +
        "the other resting at the side, intertwined ribbons curling " +
        "around the figure.",
      "Variant: leaning slightly forward with both hands open as " +
        "if presenting the heart, scattered flame and heart motifs " +
        "drifting upward through the air.",
      "Variant: standing tall with arms raised gracefully overhead, " +
        "the sun directly behind the head as a peach halo, the " +
        "diverging paths sweeping out from the feet.",
    ],
  },

  // The Chariot — willpower, drive, victory through control.
  // Visual shorthand: two sphinxes, a starry canopy, a charging
  // chariot — we render the driver standing tall.
  chariot: {
    base:
      "Illustrated tarot card: 'The Chariot'. Three-quarter-body " +
      "figure in a structured deep-wine-red blazer or armoured " +
      "tailored coat with peach-embroidered star-and-laurel trim at " +
      "the shoulders and lapels, a small crescent emblem at each " +
      "shoulder, determined forward-leaning expression with steady " +
      "focused eyes. Background of a charging chariot in motion — " +
      "two opposing motion lines (one peach, one wine) streaking " +
      "past either side of the figure suggesting the harnessed " +
      "tension of two beasts pulled together, a star-dotted canopy " +
      "arching overhead, a victory laurel wreath floating prominently " +
      "above the head, smoke and dust kicked up below, decorative " +
      "wheel-spoke motifs spiralling in the lower corners, distant " +
      "fortified city silhouette in the deep background — driving, " +
      "powerful, harnessed-forward-motion atmosphere. ",
    props: [
      "Variant: both hands gripping invisible reins held forward at " +
        "chest height, motion lines streaking behind, laurel wreath " +
        "glowing above the head.",
      "Variant: one hand raised commanding forward with a small " +
        "scepter or rod, the other on the hip, motion lines and " +
        "wheel-spoke motifs filling the background.",
      "Variant: arms crossed confidently across the chest with the " +
        "victory wreath haloing the head, dust and smoke trailing " +
        "behind the figure.",
      "Variant: leaning sharply forward as if mid-charge, one hand " +
        "extended pointing the way, two opposing-colour motion " +
        "streaks past either shoulder.",
      "Variant: standing tall with one fist raised in a triumphant " +
        "gesture, the laurel wreath descending toward the head, " +
        "star-dotted canopy filling the upper background.",
    ],
  },

  // Wheel of Fortune — cycles, fate, the turn.
  // Visual shorthand: a great spoked wheel, four corner symbols
  // (lion, eagle, ox, angel), inscribed letters.
  wheel: {
    base:
      "Illustrated tarot card: 'Wheel of Fortune'. Three-quarter-body " +
      "figure in a flowing deep-wine-red robe or layered cape over " +
      "a structured tailored under-layer, peach-embroidered cosmic " +
      "spiral motifs swirling across the lapels and sleeves, " +
      "centred steady expression with a hint of amused wisdom. " +
      "Background of a great spoked wheel filling the upper " +
      "background — a peach-and-wine concentric mandala wheel with " +
      "eight glowing spokes and inscribed glyphs around the rim, " +
      "four small allegorical creature motifs (a lion, an eagle, " +
      "an ox, a winged figure) in the corners as decorative " +
      "ornament, swirling clouds curling around the wheel's edge, " +
      "scattered playing-card-like tarot symbols drifting through " +
      "the air, decorative spiral and cycle motifs everywhere — " +
      "cosmic, turning, this-too-shall-pass atmosphere. ",
    props: [
      "Variant: one hand reaching up to touch the spinning wheel " +
        "rim, the other resting on the hip, the wheel glowing " +
        "brightly behind the head.",
      "Variant: arms raised wide as if conducting the wheel's turn, " +
        "decorative glyphs and spiral motifs orbiting the figure.",
      "Variant: both hands held palm-up at waist height with a small " +
        "glowing orb hovering between them, the great wheel filling " +
        "the upper background.",
      "Variant: holding a single tarot card forward as if mid-draw, " +
        "the wheel turning behind, scattered cards drifting around.",
      "Variant: standing serene at the wheel's centre with arms " +
        "folded peacefully, the four corner creatures glowing as " +
        "decorative emblems at the card corners.",
    ],
  },

  // Justice — balance, fairness, accountability.
  // Visual shorthand: a sword (vertical), scales (suspended), a
  // single bare pillar.
  justice: {
    base:
      "Illustrated tarot card: 'Justice'. Three-quarter-body figure " +
      "in a sharp structured deep-wine-red blazer or tailored long " +
      "coat with peach-embroidered scales-and-sword motifs at the " +
      "lapels, a small balanced-scales emblem at the throat, calm " +
      "level expression with steady direct eyes. Background of a " +
      "minimal stone chamber — a single set of balanced golden " +
      "scales suspended in the upper background, a tall stylised " +
      "sword held vertically beside the figure, two simple stone " +
      "pillars framing the composition, a checkerboard floor " +
      "pattern receding into the deep background, decorative " +
      "geometric Greek-key motifs along the architecture, scattered " +
      "feathers (truth) drifting gently in the air, small peach " +
      "weighing-coins floating around the scales — measured, " +
      "balanced, accountable atmosphere. ",
    props: [
      "Variant: one hand gripping the hilt of a vertical sword held " +
        "upright at the side, the other extended palm-up offering " +
        "the balanced scales.",
      "Variant: both hands holding the scales aloft above the head, " +
        "perfectly level, sword leaning against the figure's side.",
      "Variant: one hand pointing forward with two fingers extended " +
        "as if rendering a verdict, the scales floating beside the " +
        "head.",
      "Variant: arms folded across the chest with the sword held " +
        "diagonally behind the shoulder, scales glowing above the " +
        "head.",
      "Variant: seated-pose feeling, one hand resting on the hilt " +
        "of the sword placed before the body, the other holding " +
        "the scales out to the side.",
    ],
  },

  // The Star — hope, inspiration, calm after the storm.
  // Visual shorthand: a large central star with seven small stars
  // around it, two pitchers of water (one to land, one to sea),
  // a kneeling figure under starry sky.
  star: {
    base:
      "Illustrated tarot card: 'The Star'. Three-quarter-body figure " +
      "in flowing deep-wine-red attire — soft draped layer or fluid " +
      "tailored coat — with peach-embroidered seven-pointed-star " +
      "motifs scattered across the shoulders and lapels, calm " +
      "luminous expression with eyes turned slightly upward. " +
      "Background of a deep peach starlit sky — one large radiant " +
      "eight-pointed central star directly behind the head as a " +
      "halo, seven smaller stars arranged in a constellation arc " +
      "across the upper background, two stylised pitchers of " +
      "shimmering water in the lower foreground (one pouring to a " +
      "small pool, one pouring onto the ground), a calm reflective " +
      "pool catching the starlight, distant low hills, scattered " +
      "decorative star-and-spiral motifs through the air — hopeful, " +
      "still, after-the-storm atmosphere. ",
    props: [
      "Variant: one hand cupping a small floating star, the other " +
        "extended pouring water from a peach pitcher into the pool " +
        "below, large central star haloing the head.",
      "Variant: arms raised wide in a gesture of openness to the " +
        "stars, the seven smaller stars arcing brightly above.",
      "Variant: kneeling-pose feeling, one knee forward, both hands " +
        "tilting two pitchers simultaneously (one to land, one to " +
        "water), star reflections in the pool below.",
      "Variant: one hand pressed gently to the heart, the other " +
        "lifted with the palm catching falling starlight, stars " +
        "scattered through the dark peach sky.",
      "Variant: standing tall with a small bright star held aloft " +
        "in one hand like a torch, the constellation arcing behind.",
    ],
  },

  // The Moon — illusion, intuition, dream, the path through fear.
  // Visual shorthand: a large moon with a face profile, two towers,
  // a wolf and a dog howling, a crayfish emerging from water.
  moon: {
    base:
      "Illustrated tarot card: 'The Moon'. Three-quarter-body figure " +
      "in flowing deep-wine-red attire — layered hooded coat or " +
      "soft draped robe — with peach-embroidered moon-phase-and-" +
      "tear-drop motifs across the trim, knowing slightly secretive " +
      "expression with steady reflective eyes. Background of a " +
      "dreamscape moonlit pool — a large full moon with a subtle " +
      "profile face hanging in the upper background dropping " +
      "scattered teardrop-shaped peach light, two distant pillared " +
      "towers framing the moon, a winding path leading from the " +
      "foreground pool into the deep background, a stylised wolf " +
      "and a small loyal dog standing in the lower foreground (one " +
      "calm, one alert), shimmering reflections in a still pool, " +
      "scattered decorative moon-phase glyph motifs through the air, " +
      "mist curling around the path — dreamy, charged, illusion-and-" +
      "truth atmosphere. ",
    props: [
      "Variant: one hand raised toward the moon as if drawing down " +
        "its light, the other resting protectively on the dog's " +
        "head, mist curling around the feet.",
      "Variant: holding a small still mirror or polished disc " +
        "reflecting the moon's face, the other hand extended palm-" +
        "down over the pool below.",
      "Variant: walking the lit path forward looking over the " +
        "shoulder toward the viewer, the towers framing the figure, " +
        "the wolf and dog flanking either side.",
      "Variant: arms folded across the chest in a guarded gesture, " +
        "the full moon glowing directly behind the head, teardrop " +
        "lights falling around the figure.",
      "Variant: kneeling at the pool's edge with one hand touching " +
        "the water sending out ripples, the moon's reflection " +
        "shattering into starlight motifs.",
    ],
  },

  // Judgement — calling, awakening, rebirth, the trumpet's call.
  // Visual shorthand: an angel with a trumpet, rising figures,
  // mountain peaks.
  judgement: {
    base:
      "Illustrated tarot card: 'Judgement'. Three-quarter-body " +
      "figure in a structured deep-wine-red layered look — tailored " +
      "blazer or open robe over a high-collared shirt — with " +
      "peach-embroidered trumpet-and-wing motifs along the lapels " +
      "and cuffs, lit-up awakened expression with eyes turned " +
      "upward toward a calling, mouth slightly open as if drawing " +
      "breath. Background of a great trumpet call — a stylised " +
      "winged figure or angel motif sketched in peach linework in " +
      "the upper background holding a long radiant trumpet, golden " +
      "rays of awakening light bursting downward from the trumpet's " +
      "mouth, distant mountain peaks rising in the deep background, " +
      "small figures sketched in the lower background rising upward " +
      "with arms raised, scattered decorative spiral and rising-" +
      "light motifs through the air, swirling cloud patterns " +
      "around the angelic figure — awakening, calling, rising " +
      "atmosphere. ",
    props: [
      "Variant: both arms raised wide in an arms-open awakening " +
        "gesture, golden rays of light streaming down onto the " +
        "figure from above.",
      "Variant: one hand pressed to the chest as if hearing the " +
        "call, the other reaching upward, the trumpet glowing " +
        "brightly behind in the upper background.",
      "Variant: head tilted upward with eyes closed in receptive " +
        "stillness, hands held open palm-up at waist level, " +
        "rising-light motifs glowing around the figure.",
      "Variant: standing tall with one hand raised to point upward " +
        "toward the trumpet, mountain peaks framing the lower " +
        "background, light rays bursting through clouds.",
      "Variant: one foot stepped forward as if rising to the call, " +
        "both hands lifted to ear-height in a listening pose, " +
        "swirling cloud-and-wing motifs filling the upper sky.",
    ],
  },

  // The World — completion, integration, the dance.
  // Visual shorthand: a dancing figure inside a laurel wreath,
  // four corner creatures (same as Wheel of Fortune).
  world: {
    base:
      "Illustrated tarot card: 'The World'. Three-quarter-body " +
      "figure in flowing deep-wine-red attire — graceful draped " +
      "long coat or soft tailored layer — with peach-embroidered " +
      "laurel-and-globe motifs along the lapels and shoulders, " +
      "centred radiant expression with a quiet knowing smile of " +
      "completion. Background of a great laurel wreath — an oval " +
      "peach-and-wine laurel wreath encircling the figure in the " +
      "central background, four small allegorical creature motifs " +
      "(a lion, an eagle, an ox, a winged figure) sketched in the " +
      "four corners as decorative ornament, a small floating globe " +
      "or sphere held in the centre, swirling decorative spiral " +
      "and infinity motifs around the wreath's edge, soft starlight " +
      "scattered across the deep background — complete, integrated, " +
      "everything-in-its-place atmosphere. ",
    props: [
      "Variant: arms raised gracefully outward with the laurel " +
        "wreath encircling the whole figure, a small glowing globe " +
        "held aloft in one hand.",
      "Variant: one foot crossed slightly behind the other in a " +
        "dance-pose feeling, arms held wide and gentle, decorative " +
        "spiral motifs swirling around.",
      "Variant: both hands cupping a small floating globe at chest " +
        "height, the laurel wreath glowing behind, four corner " +
        "creature emblems prominently visible.",
      "Variant: head tilted slightly with a serene smile, one hand " +
        "raised in a gesture of blessing, the wreath haloing the " +
        "whole composition.",
      "Variant: standing tall with arms folded peacefully across " +
        "the chest, the great wreath encircling the figure, " +
        "decorative laurel motifs filling the corners.",
    ],
  },
};

// Turn the vision pre-pass attributes into a hard identity directive. This is
// placed RIGHT AFTER the style lead (very early in the prompt) because PuLID/
// Flux weight early tokens most heavily — and identity is exactly what we were
// losing. Without it, the templates are silent on who the figure is and Flux
// defaults to a generic woman. With it, gender / hair / baldness / eye colour /
// facial hair are stated explicitly and repeated as a constraint.
function buildSubjectDirective(subject) {
  if (!subject) return "";
  const bits = [];
  if (subject.gender)   bits.push(`a ${subject.gender}`);
  if (subject.age)      bits.push(subject.age);
  if (subject.hair)     bits.push(subject.hair);
  if (subject.facial)   bits.push(subject.facial);
  if (subject.eyes)     bits.push(subject.eyes);
  if (subject.skin)     bits.push(subject.skin);
  if (!bits.length) return "";
  const desc = bits.join(", ");
  const isMan   = /\bman\b|male/i.test(subject.gender || "");
  const isBald  = /bald|balding|shaved head|no hair/i.test(subject.hair || "");
  // "facial" can be a beard/moustache/stubble/goatee description, OR the
  // literal "clean-shaven". Detect any actual facial hair so we can emphasise it.
  const hasBeard = !!subject.facial && !/^clean[-\s]?shaven$/i.test(subject.facial);
  const hasTattoos = !!subject.tattoos;
  const hasNotable = !!subject.notable;
  return (
    `THE SUBJECT IS ${desc.toUpperCase()}. The figure MUST be ${desc} — ` +
    `match the GENDER, AGE, hairstyle, hair colour (or BALDNESS), facial hair, ` +
    `eye colour and skin tone EXACTLY. Do NOT change the subject's gender or age. ` +
    (isMan
      ? "This is an UNMISTAKABLY ADULT MALE figure — NOT a child, NOT a " +
        "teenager, NOT a boyish/babyfaced young hero. Draw an adult man " +
        "with strongly masculine anatomy: a SQUARE / ANGULAR jawline (not " +
        "soft or rounded), a DEFINED chin, THICKER eyebrows, a STRONGER " +
        "NOSE, BROAD shoulders (not slim or sloped), a THICKER NECK with " +
        "a visible Adam's apple, MASCULINE HANDS (broad palm, thicker " +
        "fingers, blunt trimmed natural nails — NEVER long, manicured, " +
        "polished or painted nails). NO rosy/pink blush on the cheeks, " +
        "NO glossy or coloured/pink lipstick, NO heavy curled eyelashes, " +
        "NO eye makeup, NO dainty hand-to-face poses or feminine mannerisms. " +
        "Render age cues honestly — visible jaw definition, brow weight, " +
        "any greying / salt-and-pepper hair if applicable, lines around " +
        "the eyes if visible in the reference — do NOT smooth them away " +
        "into a generic youthful hero face. If the archetype's pose " +
        "options include a delicate gesture, render it with strong " +
        "masculine framing instead. "
      : "") +
    (isBald
      ? "The figure is BALD with NO hair on top of the head — a shiny clean scalp, no flowing locks. "
      : "") +
    // Eye colour and hair colour are the two attributes Flux is most likely to
    // lose under stylization, so spell them out again as their own clauses.
    // For LIGHT colours (green / grey / hazel / amber / blue-grey / grey-green),
    // Kontext strongly defaults to a generic brown unless we lean on it hard
    // — three sentences with explicit "NOT brown" and the exact colour
    // requested again raises the hit rate dramatically vs a single mention.
    (subject.eyes
      ? (/\b(green|grey|gray|hazel|amber|blue-?grey|grey-?green)\b/i.test(subject.eyes)
          ? `Eye colour is critical: render clearly visible ${subject.eyes} — the iris colour must read unmistakably as ${subject.eyes}. ` +
            `DO NOT default to brown eyes; the subject's irises are ${subject.eyes}, not brown. ` +
            `Both irises drawn the SAME colour, the SAME colour throughout — ${subject.eyes}, clearly visible against the white of the eye. `
          : `Eye colour is critical: render clearly visible ${subject.eyes} — the iris colour must read unmistakably as ${subject.eyes}. `)
      : "") +
    (subject.hair && !isBald
      ? `Hair: ${subject.hair} — that exact colour and length, drawn unmistakably (NOT recoloured to brand orange or wine red). `
      : "") +
    // Beard / facial hair — given the same emphasis as baldness, because
    // animated styles aggressively default to clean-shaven and were dropping
    // beards from male subjects. Repeated and made physical: we describe
    // the actual pixel pattern (dark hair covering the lower face) so the
    // model can't interpret "beard" abstractly and skip it.
    (hasBeard
      ? `FACIAL HAIR — THIS IS NON-NEGOTIABLE: the subject has ${subject.facial}. ` +
        `The figure MUST be drawn WITH ${subject.facial} clearly visible — ` +
        `physical, drawn-in dark / coloured hair pixels covering the chin, ` +
        `upper lip, jawline and cheeks as appropriate to a ${subject.facial}. ` +
        `If you have ANY tendency to render a clean-shaven face, IGNORE IT — ` +
        `this man has a beard and it MUST appear. Do NOT smooth the lower ` +
        `face. Do NOT skip the beard because of the illustration style. The ` +
        `${subject.facial} is part of his core identity and recognising him. `
      : "") +
    // Tattoos — never extracted before, so the model couldn't draw them.
    (hasTattoos
      ? `Visible tattoos: ${subject.tattoos}. Render these tattoos visible on the figure (on the appropriate body area — neck, chest, arms, hands or face as in the photo). `
      : "") +
    // Distinctive features (glasses, piercings, scars, freckles, etc.) —
    // small details that anchor identity hard if rendered, lost if not asked.
    // Critical: include them WITHOUT exaggerating. Flux + animated style is
    // prone to caricature when a feature is named explicitly.
    (hasNotable
      ? `Distinctive features visible in the photo: ${subject.notable}. Include these — they are part of how the subject is recognised — but render them with NATURAL, FAITHFUL proportions. Do NOT exaggerate, enlarge or caricature these features. They should appear on the figure exactly as proportional to the real subject. `
      : "") +
    // Even when no specific feature was extracted, forbid caricature
    // globally — ears, nose, chin, eyes are all common exaggeration targets.
    "Render the face and body with NATURAL, FAITHFUL proportions throughout — do NOT exaggerate ears, nose, chin, eyes, mouth or any other feature into a comic caricature. The animated illustration style is for the rendering language, NOT for distorting proportions. " +
    // Face shape — quiet hint that helps the structural anatomy.
    (subject.face_shape
      ? `Face shape: ${subject.face_shape}. `
      : "") +
    // The brand palette directive in STYLE_LEAD was bleeding into the
    // subject's natural features, so call out the exception explicitly.
    "Render the subject's hair, eyes and skin in their REAL natural " +
    "colours from the reference photo — the brand orange/wine palette " +
    "applies to the wardrobe and background, NOT to the body. "
  );
}

// Late-token identity recap. Placed AFTER STYLE_TRAIL because Flux gives
// significant weight to the LAST tokens of a prompt as well as the first —
// repeating the core attributes here makes them much harder for the model to
// drop during sampling.
function buildSubjectTail(subject) {
  if (!subject) return "";
  const bits = [];
  if (subject.gender) bits.push(subject.gender);
  if (subject.age && /\b(adult|middle-aged|older)\b/i.test(subject.age)) bits.push(`ADULT (${subject.age}, not a child)`);
  if (subject.hair)   bits.push(subject.hair);
  if (subject.eyes)   bits.push(subject.eyes);
  if (subject.facial && !/clean-?shaven|none/i.test(subject.facial)) bits.push(`WITH ${subject.facial}`);
  if (subject.tattoos) bits.push(`with visible tattoos: ${subject.tattoos}`);
  if (subject.notable) bits.push(`with ${subject.notable}`);
  if (!bits.length) return "";
  return ` FINAL IDENTITY CHECK — the figure in this card is unmistakably a ${bits.join(", ")}. Hair, eyes and skin are rendered in their REAL natural colours from the photo (NOT brand-palette orange or wine). Do not deviate from these attributes.`;
}

// Build a small negative-prompt fragment that excludes the OPPOSITE identity
// (e.g. "woman, gown, dress, feminine features" when the subject is a man).
// Without this the static negative prompt has no idea who the subject is, so
// the model can silently fall back to its training-distribution default —
// which for tarot-style art skews female.
function buildSubjectNegative(subject) {
  if (!subject || !subject.gender) return "";
  const parts = [];
  const g = subject.gender.toLowerCase();
  if (/\b(man|male)\b/.test(g)) {
    parts.push(
      // Gender + body fundamentals
      "woman, female figure, feminine features, feminine body shape, breasts, " +
      "gown, dress, long flowing feminine robe, long feminine hair on a man, " +
      // Age — male renders kept coming back as boyish/young heroes
      "child, teenager, young boy, schoolboy, boyish face, baby face, " +
      "babyfaced young hero, smooth childlike face, anime boy, " +
      // Face — the most common slip is a soft, rounded "androgynous" face
      "soft rounded feminine face, soft jawline on a man, narrow weak chin, " +
      "delicate feminine features, androgynous face, " +
      // Hands — even after the body is masculine, hands keep coming out dainty
      "slim feminine hands, dainty fingers, slender feminine fingers, " +
      "manicured nails, polished nails, painted nails, long pink nails, " +
      "long red nails, nail polish on a man, " +
      // Makeup & cosmetic features
      "glossy lips, pink lipstick, red lipstick, lipstick on a man, " +
      "glossy pink lips, plumped lips on a man, " +
      "long curled eyelashes, false eyelashes, heavy mascara, eye shadow, " +
      "rosy blush on cheeks, pink feminine blush, contoured feminine cheeks, " +
      // Pose & body language
      "dainty pose, delicate gesture, hand touching face daintily, " +
      "slim narrow shoulders on a man, sloped feminine shoulders, " +
      "slim feminine neck, thin feminine collarbone"
    );
  } else if (/\b(woman|female)\b/.test(g)) {
    parts.push(
      "man, male figure, masculine features, masculine jawline, male body shape, " +
      "thick beard on a woman, moustache on a woman"
    );
  }
  // When the subject has a beard/moustache/stubble, explicitly forbid a
  // clean-shaven figure — otherwise animated styles default to no facial hair.
  if (subject.facial && !/^clean[-\s]?shaven$/i.test(subject.facial)) {
    parts.push("clean-shaven face on a bearded subject, beardless figure when the subject has facial hair, hairless smooth face");
  }
  if (subject.hair && /bald|shaved head|no hair/i.test(subject.hair)) {
    parts.push("full head of hair, long hair, flowing locks, thick hair on top of head, hair covering the scalp");
  }
  // When the subject has LIGHT eyes (green / grey / hazel / amber / blue-grey),
  // Kontext defaults toward generic brown irises under stylisation. Explicitly
  // forbidding brown for these users dramatically raises the hit rate — the
  // positive directive ("render green eyes") alone wasn't enough at the event.
  if (subject.eyes && /\b(green|grey|gray|hazel|amber|blue-?grey|grey-?green)\b/i.test(subject.eyes)) {
    parts.push("brown eyes on a light-eyed subject, dark brown irises, generic brown eye colour, default brown eyes");
  }
  return parts.join(", ");
}

function getPromptFor(archetype, subject) {
  const t = PROMPT_TEMPLATES[archetype];
  if (!t) return null;
  const prop = t.props[Math.floor(Math.random() * t.props.length)];
  // STYLE_LEAD goes FIRST — PuLID/Flux weight the first prompt tokens
  // most heavily, and we need the "flat illustration, not a photograph"
  // directive to win against Flux's photo bias. The subject directive comes
  // immediately after so identity (gender/hair/eyes) is locked early too,
  // and a compact recap goes at the very end (also a high-weight position).
  return STYLE_LEAD + buildSubjectDirective(subject) + t.base + prop + STYLE_TRAIL + buildSubjectTail(subject);
}

// Eight-archetype email content. `paragraphs` is rendered as separate <p>
// blocks in the email body. Copy comes verbatim from the brand brief.
const READS = {
  charmer: {
    name: "The Charmer",
    tagline: "Magnetism & connection",
    paragraphs: [
      "You make people feel like they're the most interesting person in the room. That's a rare kind of emotional intelligence, and it will come back to you in spades.",
      "People remember how you made them feel long after they've forgotten what you said. Just make sure you're also paying attention to how people are making you feel — connection should go both ways.",
    ],
  },
  magician: {
    name: "The Magician",
    tagline: "Skill & manifestation",
    paragraphs: [
      "Where others see a wall, you see a curtain. You have a knack for reframing a problem until the answer feels so obvious everyone wonders why they didn't see it sooner.",
      "You don't hang around waiting for perfect conditions. You just work with what's there and somehow make it magic. Don't forget to bring people along with you though — not everyone can see solutions at your pace.",
    ],
  },
  alchemist: {
    name: "The Alchemist",
    tagline: "Transformation & wisdom",
    paragraphs: [
      "You've been through things that stopped others cold. Instead, you turned the lessons into something useful. Something transformative, even.",
      "You're not afraid of the messy middle. In fact, that's probably where you do your best work. Just make sure you're giving yourself the same energy you give everything else.",
    ],
  },
  oracle: {
    name: "The Oracle",
    tagline: "Intuition & foresight",
    paragraphs: [
      "You notice things before they happen. Not because of magic, but because you pay attention in a way that most people don't.",
      "People come to you when they're stuck, because somehow you always know the question they should actually be asking. Don't be scared to trust your gut more loudly — the world needs to hear it.",
    ],
  },
  rebel: {
    name: "The Rebel",
    tagline: "Disruption & freedom",
    paragraphs: [
      "You've never been that interested in the way things are supposed to work. You have a genuine, restless curiosity about what happens if you don't follow the script.",
      "That instinct to question, disrupt and reimagine is rarer than people realise. Just make sure you can tell the difference between knowing when to burn something down and when to build on what's already there.",
    ],
  },
  monk: {
    name: "The Monk",
    tagline: "Solitude & inner truth",
    paragraphs: [
      "You know something most people spend their whole lives chasing — that you don't need to fill every silence with noise just for the sake of it.",
      "Your presence is quieter than most. And usually, far more lasting. The world will keep trying to rush you, but keep pushing against it. Your stillness is where the clearest thinking happens.",
    ],
  },
  architect: {
    name: "The Architect",
    tagline: "Creativity & vision",
    paragraphs: [
      "You see the possibility beneath the surface of things. Where most people see chaos or noise, you're already sketching the system that could sit underneath it all.",
      "You're a strategic thinker with an eye for beauty, but you can see the end vision so clearly that it's easy to get frustrated with how long it takes others to catch up. Stay patient and trust the process — it'll be worth it.",
    ],
  },
  luminary: {
    name: "The Luminary",
    tagline: "Leadership & power",
    paragraphs: [
      "You have the rare ability to lead not by force, but by making people believe something is possible that they didn't think was before.",
      "People are drawn to your energy without always being able to explain why. Just make sure you also have your own Luminary — you inspire others so naturally that you can forget to seek inspiration yourself.",
    ],
  },
  // ---- RARE ----
  // The Witch is the deck's first rare card. She fires on a specific
  // answer pattern (intuitive secret-keeper) AND a probability roll, so
  // most users who land in her "zone" still get the common archetype.
  // Designed to be the talked-about card of an event.
  witch: {
    name: "The Witch",
    tagline: "A rare draw · Magic & quiet power",
    paragraphs: [
      "You've drawn a rare one. The Witch isn't about pointed hats and broomsticks — she's about knowing what's true before anyone else does, and not needing permission to act on it.",
      "Most people are still consulting their checklists. You're already moving. Your instinct is the algorithm, and the people around you don't always see how much of the quiet magic is yours. Just remember: even witches have covens. Knowing when to share the spell — and when to keep it close — is the actual power.",
    ],
  },
  // ---- Major Arcana additions (PR B). All rare; brand-tone readings.
  fool: {
    name: "The Fool",
    tagline: "A rare draw · Beginnings & the leap",
    paragraphs: [
      "You've drawn The Fool — and not in the way people usually mean. The Fool steps off the cliff because they trust that the next step will appear when their foot lands.",
      "You're the person who says yes before the plan is finished, and somehow the plan finishes itself in the doing. Just keep an eye on the dog at your heels — that's the part of you that knows. Pay attention to it before the next leap.",
    ],
  },
  empress: {
    name: "The Empress",
    tagline: "A rare draw · Abundance & creation",
    paragraphs: [
      "You make things grow. People, projects, ideas — everything is more alive after spending time with you. That's not a soft skill; it's the rarest hard skill there is.",
      "The Empress doesn't push the river. She knows that nourishment is its own kind of strategy. Just make sure you're not pouring into everyone else's garden while yours waits for water. Tend yours too.",
    ],
  },
  hierophant: {
    name: "The Hierophant",
    tagline: "A rare draw · Tradition & teaching",
    paragraphs: [
      "You're a keeper of the keys. You know the rules deeply enough to choose which ones still serve and which ones are ready to be set down — and you teach others to read them, not just follow them.",
      "The Hierophant gives people something to lean on. Your job is to keep the structure honest. Don't mistake the institution for the wisdom it was built to hold. The wisdom is the part that travels.",
    ],
  },
  lovers: {
    name: "The Lovers",
    tagline: "A rare draw · Choice & connection",
    paragraphs: [
      "Every relationship in your life is a real choice — you don't just drift into people, you choose them, again and again. That's why the bonds you keep feel so unshakeable.",
      "The Lovers card isn't only about romance. It's about the moment you commit. The thing you keep choosing — the work, the people, the path — is the thing that becomes your life. Choose like it matters, because it does.",
    ],
  },
  chariot: {
    name: "The Chariot",
    tagline: "A rare draw · Drive & disciplined will",
    paragraphs: [
      "You hold two opposite forces in tension and somehow drive them in the same direction. That's not luck — that's harnessed will. It's also exhausting, and you know it.",
      "The Chariot wins through control, not through force. The reins matter as much as the horses. Keep checking both — the version of you that wants it more isn't always the version that should be driving.",
    ],
  },
  wheel: {
    name: "Wheel of Fortune",
    tagline: "A rare draw · Cycles & timing",
    paragraphs: [
      "You've drawn the Wheel — and that means you already know something most people learn the hard way: nothing stays. Not the bad days, not the good ones, not the version of you you used to be.",
      "Your superpower isn't predicting where the wheel lands. It's staying centered while it turns. People around you panic at change; you find the still point. That's a kind of magic the world is short on right now.",
    ],
  },
  justice: {
    name: "Justice",
    tagline: "A rare draw · Truth & accountability",
    paragraphs: [
      "You're the person in the room who actually asks the hard question. Justice doesn't draw the loudest people — it draws the ones who can hold the scales steady while everyone else is busy choosing sides.",
      "Your sense of fair is a compass others borrow without even knowing. Just remember: the sword is for the work, not for yourself. Hold yourself accountable, yes — but with the same fairness you bring to everyone else.",
    ],
  },
  star: {
    name: "The Star",
    tagline: "A rare draw · Hope & inspiration",
    paragraphs: [
      "After the storm, you're the one people look up at. The Star doesn't shout — she just keeps shining, and that's enough to navigate by. People orient their lives around your steadiness.",
      "Your job isn't to fix everyone. It's to keep showing up bright, in the open, undimmed. That alone is the most generous thing you can do for the rooms you walk into. The pitchers are full. Pour.",
    ],
  },
  moon: {
    name: "The Moon",
    tagline: "A rare draw · Intuition & shadow",
    paragraphs: [
      "You see in the dark. Not metaphorically — literally: the parts of conversations, situations and people that other people miss because the light's bad. You've been doing this since you were a kid.",
      "The Moon teaches that not every shadow is a threat — some are just the parts that haven't been named yet. Stay curious about your own. The path under the moon goes somewhere; you just can't see all of it at once. Walk anyway.",
    ],
  },
  judgement: {
    name: "Judgement",
    tagline: "A rare draw · The calling & the awakening",
    paragraphs: [
      "You've heard the call. Maybe more than once. The thing that won't leave you alone, that you keep pretending isn't the thing — Judgement is the moment you stop pretending.",
      "This card draws the people who are about to step into who they actually are. The trumpet isn't loud; it just won't stop. Whatever it's pointing you toward, the universe has been patient enough. Your turn.",
    ],
  },
  world: {
    name: "The World",
    tagline: "A rare draw · Completion & integration",
    paragraphs: [
      "You've drawn the final card. The World means you've actually done it — the thing, the chapter, the version of yourself you've been becoming. The wreath is around you, and you can feel it.",
      "But the World isn't an ending. It's the moment the dance begins again, this time as the person who knows the steps. Whatever's next, you're not starting from zero. You're starting from everything you've already integrated. That's a different kind of beginning.",
    ],
  },
};

export default {
  async fetch(request, env, ctx) {
    // Tighten this to your deployed origin once everything works:
    //   "Access-Control-Allow-Origin": "https://tarot.vonpeach.com"
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    // Some mobile Safari builds are pickier about preflight responses —
    // 204 + Max-Age is the most-compatible answer.
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // GET routes for the admin gallery + the live event wall
    if (request.method === "GET") {
      if (url.pathname === "/gallery")                 return handleGallery(request, env, url);
      if (url.pathname === "/wall")                    return handleWall(request, env, url);
      if (url.pathname === "/gallery.json")            return handleGalleryJson(request, env, url);
      if (url.pathname === "/scan")                    return handleScan(request, env);
      if (url.pathname === "/stats")                   return handleStats(request, env, url);
      if (url.pathname.startsWith("/portrait-image/")) return handlePortraitImage(request, env, url);
      if (url.pathname.startsWith("/p/"))               return handlePortraitShare(request, env, url);
      // Admin debug endpoint — verify the Mailchimp integration with a
      // synthetic add. Passcode-gated by GALLERY_KEY so only admins can
      // hit it. Returns the addToMailchimp result verbatim plus the
      // computed dc and list URL so we can sanity-check the wiring.
      if (url.pathname === "/debug/mailchimp")          return handleMailchimpDebug(request, env, url, cors);
      // Admin debug — fire a synthetic Slack ping. Same passcode gate as
      // /debug/mailchimp. Use to confirm the webhook URL is configured
      // before an event, or to debug "I'm not getting pings" mid-event.
      if (url.pathname === "/debug/slack")              return handleSlackDebug(request, env, url, cors);
      return jsonResp({ error: "not_found", path: url.pathname }, 404, cors);
    }

    // DELETE for admin cleanup. Passcode-gated by GALLERY_KEY — only the
    // admin /gallery view exposes the UI, but the endpoint itself can also
    // be curled by anyone with the key (useful for bulk-cleanup scripts).
    if (request.method === "DELETE") {
      if (url.pathname === "/gallery/before")          return handleGalleryBulkDelete(request, env, url, cors);
      if (url.pathname.startsWith("/portrait-image/")) return handlePortraitDelete(request, env, url, cors);
      return jsonResp({ error: "not_found", path: url.pathname }, 404, cors);
    }

    if (request.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, cors);

    if (url.pathname === "/portrait")        return handlePortrait(request, env, ctx, cors);
    if (url.pathname === "/send-card")       return handleSendCard(request, env, cors);
    if (url.pathname === "/portrait-email")  return handlePortraitEmail(request, env, ctx, cors);
    // POST /portrait-image/<key>/frame — REPLACE the R2 portrait bytes with
    // the client-rendered framed version (shareCanvas with brand pill +
    // sigil overlay). Removes the AI's bottom-pill gibberish from every
    // surface that streams the R2 JPEG directly (wall tiles, gallery, the
    // /p/<key> share page OG image preview). The /portrait flow uploads
    // here automatically after renderTarotCard finishes.
    if (url.pathname.startsWith("/portrait-image/") && url.pathname.endsWith("/frame")) {
      return handlePortraitFrame(request, env, url, cors);
    }
    return jsonResp({ error: "not_found", path: url.pathname }, 404, cors);
  },
};

// ---------- /portrait — synchronous, returns the image inline ----------
// Accepts an optional `face` field carrying a tight face crop (data URL,
// usually 512×512 JPEG extracted client-side from the MediaPipe FaceLandmarker
// detection). When present, the vision pre-pass uses it as a high-detail
// source for face-level attributes. Backwards compatible — old clients that
// only send `image` continue to work.
async function handlePortrait(request, env, ctx, cors) {
  try {
    const body = (await request.json()) || {};
    const { image, face, commonArchetype } = body;
    let { archetype } = body;
    if (!image || !archetype) return jsonResp({ error: "missing_fields" }, 400, cors);

    // Gender-gate rare archetypes. Witch + Empress are explicitly female-
    // coded in their Kontext prompts (flowing dress, knowing-mother energy,
    // black cat familiar, pomegranate-laden scepter, etc.). When a male
    // user lands on one via the client's RARE_RULES roll, the AI render
    // either fights the prompt (figure comes out androgynous and uncanny)
    // or just looks wrong to the recipient. Resolve before render starts.
    //
    // We do a fast focused detectGender call (~1-2s, Workers AI) instead
    // of the full describeSubject pre-pass to keep latency low. If the
    // detector errors or is unavailable, we let the original archetype
    // stand — better to risk a slightly-off render than to refuse outright.
    if (GENDER_RESTRICTIONS[archetype] && env.AI) {
      try {
        const bytes = dataUrlToUint8Array(image);
        const detected = await detectGender(env, bytes).catch(() => null);
        if (detected && !genderMatches(detected, GENDER_RESTRICTIONS[archetype])) {
          const fallback = commonArchetype && PROMPT_TEMPLATES[commonArchetype]
            ? commonArchetype
            : "charmer";
          console.log(`[gender-gate] ${archetype} requires ${GENDER_RESTRICTIONS[archetype]}, detected="${detected}" → falling back to ${fallback}`);
          archetype = fallback;
        }
      } catch (err) {
        console.warn(`[gender-gate] detector errored, keeping original archetype: ${err?.message}`);
      }
    }

    // Per-request pipeline override via ?pipeline=kontext (or pulid / snapchat).
    // Lets us safely A/B test a new pipeline against prod by hitting the same
    // worker with two different query params, without changing the global
    // default. Falls back to PIPELINE env var, then to "pulid".
    const url = new URL(request.url);
    const pipelineOverride = url.searchParams.get("pipeline");
    const dataUrl = await runSelectedPipeline(env, image, archetype, face, pipelineOverride);
    // Await the save so we can return a per-portrait share URL alongside the
    // image. R2 put is ~100ms — negligible next to the multi-second AI render
    // — and the URL is what powers the LinkedIn-share OG-preview flow + the
    // /p/<key> share page. If the save fails we still return the image (just
    // without a sharePath), so the experience degrades gracefully.
    const galleryKey = await saveToGallery(env, archetype, dataUrl);
    const sharePath = galleryKey ? "/p/" + encodeURIComponent(galleryKey) : null;
    const origin = url.origin;
    const shareUrl = sharePath ? origin + sharePath : null;
    // `archetype` echoed back so the client can re-render its UI under the
    // resolved archetype (it may have been swapped above by the gender gate).
    return jsonResp({ image: dataUrl, archetype, sharePath, shareUrl }, 200, cors);
  } catch (err) {
    const msg = err?.message || "server";
    const status = /upstream/i.test(msg) ? 502 : 500;
    return jsonResp({ error: "portrait_failed", message: msg }, status, cors);
  }
}

// ---------- /portrait-email — async, generates then emails in the background ----------
// Returns 200 OK immediately so the user can close the tab. The pipeline +
// Resend send happen inside ctx.waitUntil(), so Cloudflare keeps the worker
// alive until both finish (within the 30s wall-clock limit).
//
// Accepts either application/json (legacy) OR multipart/form-data (preferred,
// no CORS preflight required) so mobile Safari uploads land reliably.
async function handlePortraitEmail(request, env, ctx, cors) {
  try {
    const body = await readMixedBody(request);
    const { image, face, archetype, archetypeName, email } = body;
    if (!image || !archetype || !email)  return jsonResp({ error: "missing_fields" }, 400, cors);
    if (!isValidEmail(email))            return jsonResp({ error: "invalid_email" }, 400, cors);
    if (!PROMPT_TEMPLATES[archetype])    return jsonResp({ error: "unknown_archetype" }, 400, cors);

    ctx.waitUntil((async () => {
      const bgT0 = Date.now();
      console.log(`[portrait-email] background start email=${email} archetype=${archetype}`);
      try {
        const portraitDataUrl = await runSelectedPipeline(env, image, archetype, face);
        // Best-effort gallery save before sending the email — also gives us
        // the R2 key for the per-portrait share URL embedded in the email.
        const galleryKey = await saveToGallery(env, archetype, portraitDataUrl);
        const reqUrl = new URL(request.url);
        const sharePath = galleryKey ? "/p/" + encodeURIComponent(galleryKey) : null;
        console.log(`[portrait-email] pipeline done t+${Date.now()-bgT0}ms, sending via Resend`);
        await sendCardEmail(env, {
          email,
          archetype,
          archetypeName,
          image: portraitDataUrl,
          sharePath,
          shareOrigin: reqUrl.origin,
        });
        console.log(`[portrait-email] send complete t+${Date.now()-bgT0}ms`);
      } catch (err) {
        console.error(`[portrait-email] FAILED t+${Date.now()-bgT0}ms: ${err?.message}`);
      }
    })());

    return jsonResp({ ok: true, queued: true }, 200, cors);
  } catch (err) {
    return jsonResp({ error: "server", message: err?.message }, 500, cors);
  }
}

// ---------- vision pre-pass: describe the subject so we can keep their identity
// Two-tier model selection:
//   1. If OPENAI_API_KEY is set, prefer GPT-4o-mini Vision (much more accurate
//      at stubble / piercings / freckles / glasses-subtype / tattoo content
//      than Workers AI Llama 3.2 Vision). Cost: ~$0.0005-0.001 per render.
//   2. Otherwise fall back to Workers AI Llama 3.2 Vision (free, less accurate
//      on subtle features — the failure mode that prompted the GPT-4o swap).
//
// Both paths accept an optional FACE CROP image alongside the wide shot. When
// present, the tight crop gives the vision model ~4× the face-pixel density,
// which dramatically improves detection of fine features (stubble, moles,
// eye colour, piercings). The wide shot is still needed for body context
// (tattoos on neck/arms, glasses style, overall build).
//
// Returns a plain object the prompt builder turns into a hard directive, or
// null if every path fails (in which case we fall back to the original
// identity-silent behaviour).
async function describeSubject(env, imageDataUrl, faceImageDataUrl) {
  // Premium path: GPT-4o-mini Vision (multi-image, JSON-mode guaranteed).
  if (env.OPENAI_API_KEY) {
    // Run the omnibus AND a focused eye-colour call in parallel. The
    // omnibus extractor buries the eye field in a long multi-attribute
    // schema where GPT-4o-mini routinely defaults to "brown" or "blue"
    // and misses green / grey / hazel / amber. The focused call asks
    // ONLY about iris colour against the tight face crop, with the enum
    // up front — much more reliable for the easy-to-miss colours.
    const [subject, focusedEyes] = await Promise.all([
      describeSubjectOpenAI(env, imageDataUrl, faceImageDataUrl),
      detectEyeColorOpenAI(env, faceImageDataUrl || imageDataUrl).catch((err) => {
        console.warn(`[pipeline] focused eye-colour (OpenAI) errored: ${err?.message}`);
        return null;
      }),
    ]);
    if (subject) {
      if (focusedEyes) {
        const merged = mergeEyeColor(subject.eyes, focusedEyes);
        if (merged !== subject.eyes) {
          console.log(`[pipeline] eye-colour (OpenAI focused): omnibus="${subject.eyes}" focused="${focusedEyes}" → "${merged}"`);
          subject.eyes = merged;
        }
      }
      return subject;
    }
    // fall through to Workers AI if OpenAI is configured but errored — better
    // to degrade gracefully than to send a portrait with no identity directive
    console.warn("[pipeline] OpenAI vision returned nothing — falling back to Workers AI");
  }
  // Fallback path: Workers AI Llama 3.2 Vision (single image).
  if (!env.AI) return null;
  try {
    // When a face crop is available, send THAT to the single-image Llama call
    // — the face is what we mostly need for identity attributes. The wide
    // shot's body context is lost in this fallback path, but the face crop
    // beats the wide shot on every face-level feature.
    const sourceDataUrl = faceImageDataUrl || imageDataUrl;
    const b64 = String(sourceDataUrl).split(",").pop();
    const bytes = base64ToUint8Array(b64);
    const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      // Image as a byte array per Workers AI vision input contract.
      image: [...bytes],
      max_tokens: 384,
      messages: [
        {
          role: "system",
          content:
            "You are a precise facial-attribute extractor for an illustration " +
            "pipeline. Look at the single most prominent face / upper body in " +
            "the photo and report ONLY what you can clearly see. Respond with " +
            "STRICT JSON only — no prose, no markdown — using exactly these " +
            "keys (omit none — use the literal string \"none\" for absent items):\n" +
            '{"gender":"man"|"woman",\n' +
            ' "age":"young adult"|"adult"|"middle-aged"|"older",\n' +
            ' "hair":"<colour + length, e.g. short dark brown hair> OR bald OR shaved head",\n' +
            ' "facial":"clean-shaven" | "<beard/moustache description — be SPECIFIC: e.g. \\"thick full black beard\\", \\"short dark stubble\\", \\"trimmed grey goatee\\", \\"handlebar moustache\\">",\n' +
            ' "eyes":"<one of: brown eyes, dark brown eyes, light brown eyes, hazel eyes, amber eyes, blue eyes, light blue eyes, deep blue eyes, blue-grey eyes, green eyes, deep green eyes, light green eyes, grey eyes, grey-green eyes — be specific. Do NOT default to brown or blue if the irises are clearly green, grey, hazel or amber.>",\n' +
            ' "skin":"<skin tone> skin",\n' +
            ' "face_shape":"round"|"oval"|"square"|"heart"|"long",\n' +
            ' "age_cues":"<short comma-list of visible cues that fix age: facial hair, lines around eyes, greying hair, salt-and-pepper hair, fuller defined jawline, etc. — or \\"youthful smooth features\\" if none>",\n' +
            ' "tattoos":"<short description of any visible tattoos on neck/chest/arms/face — or \\"none\\">",\n' +
            ' "notable":"<short comma-list of distinctive features visible in the photo: glasses, piercings (ear/nose/lip), scars, freckles, prominent mole, dimples, etc. — or \\"none\\">"\n' +
            "}\n" +
            "If the person clearly has no hair, set hair to \"bald\". " +
            "Be HONEST about facial hair — if you see any beard or stubble at " +
            "all, DO NOT say \"clean-shaven\". Never omit the gender key. " +
            "GENDER — CRITICAL: hair length is NOT a reliable gender signal. " +
            "Many women have short hair (pixie cuts, bobs, buzz cuts, " +
            "undercuts). Many men have long hair. Determine gender from " +
            "facial bone structure, jawline, brow, lip shape — NOT from " +
            "hair length. A short-haired woman is still a woman.",
        },
        { role: "user", content: "Describe this person's visible attributes as JSON." },
      ],
    });
    const raw = (out && (out.response ?? out.description ?? out.text)) || "";
    const subject = parseSubjectJson(raw);
    if (subject) console.log(`[pipeline] subject=${JSON.stringify(subject)}`);

    // Focused re-checks (Workers AI path only). Three independent single-
    // purpose vision calls that confirm / refine the omnibus answer:
    //
    //   - detectFacialHair (males only)  — catches stubble / moustache /
    //                                       goatee / short beards the omnibus
    //                                       JSON pass loses across 10 fields.
    //   - detectHairColor (non-bald)     — resolves brown↔blonde ↔ black ↔
    //                                       dark-brown ambiguity under
    //                                       inconsistent lighting.
    //   - detectGlasses (everyone)       — rescues glasses dropped from the
    //                                       free-text "notable" field.
    //
    // Each detector is an independent Workers AI call (~2-3s) against the
    // same `bytes`. Previously serialized — total +6-9s per render. Now
    // parallelized via Promise.all → wall-clock = slowest single call
    // (~2-3s). Identity accuracy unchanged, latency dramatically lower.
    //
    // Per-detector .catch(()=>null) so one slow detector doesn't tank the
    // whole pipeline — the merge step treats null exactly like "skipped"
    // and falls back to the omnibus answer.
    if (subject) {
      const isMale = /\b(man|male)\b/i.test(subject.gender || "");
      const isBald = /bald|shaved head|no hair/i.test(subject.hair || "");

      const [focusedFacial, focusedHair, focusedGlasses, focusedGender, focusedEyes] = await Promise.all([
        isMale  ? detectFacialHair(env, bytes).catch(() => null) : Promise.resolve(null),
        !isBald ? detectHairColor(env, bytes).catch(() => null) : Promise.resolve(null),
        detectGlasses(env, bytes).catch(() => null),
        detectGender(env, bytes).catch(() => null),
        detectEyeColor(env, bytes).catch(() => null),
      ]);

      // Merge policy is unchanged from the sequential version — focused
      // overrides only when more specific / when omnibus missed something.
      //
      // Gender first — if it flips, the downstream subject directive
      // (buildSubjectDirective) reads the new value and applies the
      // correct preservation language. Short-haired-woman → "woman"
      // is the most consequential override here.
      if (focusedGender !== null) {
        const mergedGender = mergeGender(subject.gender, focusedGender);
        if (mergedGender !== subject.gender) {
          console.log(`[pipeline] gender re-check: omnibus="${subject.gender}" focused="${focusedGender}" → "${mergedGender}"`);
          subject.gender = mergedGender;
        }
      }
      if (focusedFacial !== null) {
        const merged = mergeFacialHair(subject.facial, focusedFacial);
        if (merged !== subject.facial) {
          console.log(`[pipeline] facial-hair re-check: omnibus="${subject.facial}" focused="${focusedFacial}" → "${merged}"`);
          subject.facial = merged;
        }
      }
      if (focusedHair !== null) {
        const mergedHair = mergeHair(subject.hair, focusedHair);
        if (mergedHair !== subject.hair) {
          console.log(`[pipeline] hair re-check: omnibus="${subject.hair}" focused="${focusedHair}" → "${mergedHair}"`);
          subject.hair = mergedHair;
        }
      }
      if (focusedGlasses !== null) {
        const mergedNotable = mergeGlassesIntoNotable(subject.notable, focusedGlasses);
        if (mergedNotable !== subject.notable) {
          console.log(`[pipeline] glasses re-check: notable was="${subject.notable}" focused="${focusedGlasses}" → "${mergedNotable}"`);
          subject.notable = mergedNotable;
        }
      }
      if (focusedEyes !== null) {
        const mergedEyes = mergeEyeColor(subject.eyes, focusedEyes);
        if (mergedEyes !== subject.eyes) {
          console.log(`[pipeline] eye-colour re-check: omnibus="${subject.eyes}" focused="${focusedEyes}" → "${mergedEyes}"`);
          subject.eyes = mergedEyes;
        }
      }
    }

    return subject;
  } catch (err) {
    console.warn(`[pipeline] subject describe failed: ${err?.message}`);
    return null;
  }
}

// GPT-4o-mini Vision path. Opt-in via OPENAI_API_KEY secret. Significantly
// more accurate than Workers AI Llama on the subtle features that drive
// likeness: stubble vs clean-shaven, small piercings, mole/freckle positions,
// glasses subtype, tattoo content, age cues.
//
// Multi-image: sends both the wide shot (low detail — body / tattoos / glasses
// context) AND the optional tight face crop (high detail — face attributes).
// Together this gives the model ~4× the face-pixel density of single-image
// Workers AI while still seeing body context.
//
// Cost: gpt-4o-mini is $0.150 per 1M input tokens. A typical call is
// ~600-900 input + ~250 output = ~$0.0003-0.0005. Negligible per render.
async function describeSubjectOpenAI(env, wideDataUrl, faceDataUrl) {
  try {
    // Build the message content with both images when face crop available,
    // otherwise just the wide shot at high detail.
    const userContent = [
      { type: "text", text: "Describe this person's visible attributes as JSON, using the supplied image(s)." },
    ];
    if (faceDataUrl) {
      // Face crop gets high-detail tiling — this is the primary identity
      // signal source.
      userContent.push({ type: "image_url", image_url: { url: faceDataUrl, detail: "high" } });
      // Wide shot at low detail — fixed ~85 tokens, gives body / tattoo /
      // glasses context without exploding cost.
      userContent.push({ type: "image_url", image_url: { url: wideDataUrl, detail: "low" } });
    } else {
      // No face crop — give the wide shot the high-detail treatment so the
      // model can still resolve face-level features as best it can.
      userContent.push({ type: "image_url", image_url: { url: wideDataUrl, detail: "high" } });
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a precise facial-attribute extractor for an illustration " +
              "pipeline. You will be shown ONE OR TWO photos of the same person " +
              "(usually a tight face crop AND a wider shot). Use BOTH to extract " +
              "the most accurate description possible. " +
              "Respond with a single JSON object — no prose, no markdown — using " +
              "EXACTLY these keys (use the literal string \"none\" for absent items):\n" +
              '{"gender":"man"|"woman",\n' +
              ' "age":"young adult"|"adult"|"middle-aged"|"older",\n' +
              ' "hair":"<colour + length, e.g. \\"short dark brown hair\\", \\"long wavy black hair\\"> OR \\"bald\\" OR \\"shaved head\\"",\n' +
              ' "facial":"<one of: clean-shaven, very light stubble, short stubble, heavy stubble, five o\'clock shadow, thin moustache, thick moustache, handlebar moustache, walrus moustache, goatee, goatee with moustache, soul patch, chin strap beard, short beard, medium beard, full beard, thick full beard, long beard, beard and moustache, thick sideburns, mutton chops — prefix with a colour adjective when visible: black, dark brown, brown, light brown, red, ginger, blonde, grey, salt-and-pepper, white. Be honest: even very light stubble or a 5-o-clock shadow counts.>",\n' +
              ' "eyes":"<one of: brown eyes, dark brown eyes, light brown eyes, hazel eyes, amber eyes, blue eyes, light blue eyes, deep blue eyes, blue-grey eyes, green eyes, deep green eyes, light green eyes, grey eyes, grey-green eyes — be PRECISE. Green and grey are easy to miss; look carefully. Hazel = brown with green or gold flecks. Amber = light brown with gold cast. If the iris is light but not blue, distinguish green vs grey vs hazel before defaulting to blue. NEVER default to brown if the irises are clearly light.>",\n' +
              ' "skin":"<skin tone description, e.g. fair, light, olive, medium, tan, brown, dark brown, dark> skin",\n' +
              ' "face_shape":"round"|"oval"|"square"|"heart"|"long",\n' +
              ' "age_cues":"<short comma-list of visible cues that fix age: facial hair, fine lines around eyes, crow\'s feet, smile lines, greying hair, salt-and-pepper hair, fuller defined jawline, receding hairline, etc. — or \\"youthful smooth features\\" if none>",\n' +
              ' "tattoos":"<specific description of any visible tattoos, including content (\\"floral sleeve on right arm\\", \\"script lettering on inner forearm\\", \\"small star behind ear\\") — or \\"none\\">",\n' +
              ' "notable":"<short comma-list of distinctive features visible in the photo: glasses (and their style — round wire, thick black acetate, aviator, frameless), piercings (location: ear, septum, nose, lip, eyebrow, monroe), scars, freckles, prominent mole + location, dimples, beauty mark — or \\"none\\">"\n' +
              "}\n" +
              "Important: report what you can SEE. Do not infer attributes from " +
              "clothing or background. Never omit the gender key. When in doubt " +
              "about facial hair, lean toward reporting whatever subtle hair is " +
              "visible rather than calling it clean-shaven. " +
              "GENDER — CRITICAL: hair length is NOT a reliable signal. Many " +
              "women have short hair (pixie cuts, bobs, buzz cuts, undercuts, " +
              "shaved sides). Many men have long hair. Determine gender from " +
              "FACIAL BONE STRUCTURE (jawline, brow ridge, cheekbones), lip " +
              "shape, eye shape, neck width, and body proportions — NOT from " +
              "hair length or hairstyle. A short-haired woman is still a woman.",
          },
          { role: "user", content: userContent },
        ],
        max_tokens: 500,
        temperature: 0.1,
        // Guarantees valid JSON in the response — no defensive regex needed
        // for OpenAI (Workers AI path still uses the regex extractor).
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.warn(`[pipeline] OpenAI vision failed: status=${res.status} detail=${detail.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const subject = parseSubjectJson(raw);
    if (subject) console.log(`[pipeline] subject(openai)=${JSON.stringify(subject)}`);
    return subject;
  } catch (err) {
    console.warn(`[pipeline] OpenAI vision threw: ${err?.message}`);
    return null;
  }
}

// Focused OpenAI eye-colour detector. GPT-4o-mini Vision against the tight
// face crop, asking ONLY about iris colour with the enum up front. Run in
// parallel with describeSubjectOpenAI; result is merged into the omnibus
// subject by mergeEyeColor.
//
// Why this is needed even though the omnibus prompt enumerates eye colours:
// in the long multi-attribute schema, the eye field is one of ten and the
// model frequently picks "brown" or "blue" by default — burying the
// "NEVER default" instruction. A single-purpose call with one field and
// the option list at the top of the system prompt is dramatically more
// reliable for the easy-to-miss colours (green, grey, hazel, amber).
async function detectEyeColorOpenAI(env, faceDataUrl) {
  if (!env.OPENAI_API_KEY || !faceDataUrl) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a precise iris-colour detector. ONE JOB: look at the " +
              "iris (the coloured ring around the pupil — NOT the pupil " +
              "itself, NOT the white of the eye) of BOTH eyes in the photo. " +
              "Pick the SINGLE most specific colour from this list:\n" +
              "  brown, dark brown, light brown, hazel (brown with green or " +
              "  gold flecks), amber (light brown with gold cast), blue, " +
              "  light blue, deep blue, blue-grey, green, deep green, light " +
              "  green, grey, grey-green\n" +
              "Reply with ONE PHRASE in this exact format:\n" +
              "  \"<colour> eyes\"\n" +
              "Examples: \"green eyes\", \"hazel eyes\", \"grey eyes\", " +
              "\"deep blue eyes\", \"light brown eyes\". " +
              "NO other words, NO JSON, NO punctuation, NO hedging like " +
              "\"possibly\" or \"approximately\". Just the phrase.\n" +
              "CRITICAL RULES:\n" +
              "  - Green, grey, hazel and amber are commonly missed because " +
              "    flat indoor lighting desaturates the iris and they read " +
              "    as muted blue or muted brown. Look HARDER before " +
              "    defaulting.\n" +
              "  - If the iris is clearly NOT dark brown and NOT a saturated " +
              "    blue, the answer is probably green, grey, or hazel — pick " +
              "    the most accurate of those three. Do NOT default to brown " +
              "    or blue for light irises.\n" +
              "  - Hazel = brown base with green/gold flecks or ring. Amber = " +
              "    light brown with a gold/honey cast.\n" +
              "  - Only return brown if the iris is clearly dark and uniform. " +
              "    Only return blue if the iris is clearly saturated blue.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "What colour are this person's eyes? One phrase only." },
              { type: "image_url", image_url: { url: faceDataUrl, detail: "high" } },
            ],
          },
        ],
        max_tokens: 24,
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.warn(`[pipeline] OpenAI eye detector HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const raw = String(data?.choices?.[0]?.message?.content || "").trim();
    const cleaned = raw.replace(/^["'`]+|["'`.,;:!?]+$/g, "").trim().toLowerCase();
    if (!cleaned) return null;
    // Must look like an eye phrase
    if (!/\beyes?\b/.test(cleaned)) return null;
    return cleaned;
  } catch (err) {
    console.warn(`[pipeline] OpenAI eye detector threw: ${err?.message}`);
    return null;
  }
}

// Focused facial-hair detector. Runs a separate Workers AI vision call with
// a SINGLE-PURPOSE prompt — only job is to look at the lower face and report
// facial hair across the FULL spectrum: stubble, moustaches, goatees, sideburns,
// chin straps, full beards, etc. A broad phrase list + colour adjective lets the
// model report a specific style instead of forcing it to choose between
// "clean-shaven" and "beard".
//
// Returns the cleaned phrase (e.g. "trimmed grey goatee", "light brown stubble",
// "handlebar black moustache") or null on parse / API failure. The caller
// (mergeFacialHair) decides whether to override the omnibus answer.
async function detectFacialHair(env, bytes) {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: [...bytes],
      max_tokens: 50,
      messages: [
        {
          role: "system",
          content:
            "You are a precise facial-hair detector. Look CAREFULLY at this " +
            "person's lower face — chin, upper lip, jawline, cheeks below the " +
            "eyes, and sideburns. " +
            "Detect ANY facial hair across the full spectrum — even subtle " +
            "things like very light stubble, a 5-o'clock shadow, a thin " +
            "moustache, or a small goatee. A darker shadow or shading on the " +
            "lower face usually IS facial hair, not just lighting. " +
            "Reply with ONLY one short phrase, no other words, no JSON, no " +
            "punctuation. Pick the BEST-FITTING style from this list:\n" +
            "  STUBBLE: \"very light stubble\", \"short stubble\", " +
            "\"heavy stubble\", \"five o'clock shadow\"\n" +
            "  MOUSTACHE: \"thin moustache\", \"thick moustache\", " +
            "\"handlebar moustache\", \"walrus moustache\"\n" +
            "  GOATEE / CHIN: \"goatee\", \"goatee with moustache\", " +
            "\"soul patch\", \"chin strap beard\"\n" +
            "  BEARD: \"short beard\", \"medium beard\", \"full beard\", " +
            "\"thick full beard\", \"long beard\", \"beard and moustache\"\n" +
            "  SIDEBURNS: \"thick sideburns\", \"mutton chops\"\n" +
            "  NONE: \"clean-shaven\"\n" +
            "Prefix a COLOUR adjective when visible: \"black\", \"dark brown\", " +
            "\"brown\", \"light brown\", \"red\", \"ginger\", \"blonde\", " +
            "\"grey\", \"salt-and-pepper\", \"white\". " +
            "Example replies: \"short black beard\", \"trimmed grey goatee\", " +
            "\"light brown stubble\", \"handlebar black moustache\", " +
            "\"salt-and-pepper full beard\". " +
            "Only say \"clean-shaven\" if you are confident there is " +
            "genuinely no facial hair at all — when in doubt, lean toward " +
            "reporting whatever subtle hair you can see.",
        },
        { role: "user", content: "What facial hair does this person have? Reply with the phrase only." },
      ],
    });
    const raw = String((out && (out.response ?? out.description ?? out.text)) || "").trim();
    // Strip quotes / JSON wrappers / trailing punctuation defensively.
    const cleaned = raw
      .replace(/^["'`]+|["'`.,;:!?]+$/g, "")
      .replace(/^\{.*?["']?\s*([^"'}]+)\s*["']?\s*\}$/, "$1")
      .trim()
      .toLowerCase();
    if (!cleaned) return null;
    // Accept either the clean-shaven sentinel OR any phrase containing a
    // recognised facial-hair keyword. We use the merge step (mergeFacialHair)
    // to decide whether to override the omnibus answer — this just produces
    // a clean string for that decision.
    if (/^clean[-\s]?shaven$/i.test(cleaned)) return "clean-shaven";
    if (!/\b(beard|stubble|goatee|moustache|mustache|sideburns|shadow|soul patch|mutton chops|chin strap)\b/i.test(cleaned)) return null;
    return cleaned;
  } catch (err) {
    console.warn(`[pipeline] facial-hair re-check failed: ${err?.message}`);
    return null;
  }
}

// Combine the omnibus pass's facial answer with the focused re-check. Both
// can be missing, vague, or specific — pick the most informative non-erasing
// answer. Asymmetric on purpose: a "saw hair" signal beats a "saw no hair"
// signal in either direction. We never fabricate facial hair the omnibus
// didn't see UNLESS the focused detector specifically reports it.
function mergeFacialHair(omnibus, focused) {
  const isClean = (s) => !s || /^clean[-\s]?shaven$/i.test(String(s).trim());
  // Focused failed / returned null → trust whatever omnibus gave us
  if (focused === null || focused === undefined) return omnibus || "";
  // Both clean → clean-shaven
  if (isClean(omnibus) && isClean(focused)) return omnibus || "clean-shaven";
  // Only focused sees hair → trust the rescue
  if (isClean(omnibus) && !isClean(focused)) return focused;
  // Only omnibus sees hair → keep omnibus (don't let a single focused-call
  // hiccup erase real facial hair the omnibus saw)
  if (!isClean(omnibus) && isClean(focused)) return omnibus;
  // Both see hair → prefer the more specific / longer phrase (the focused
  // detector usually returns colour + style; the omnibus often just "beard").
  return focused.length > omnibus.length ? focused : omnibus;
}

// Focused hair-colour + length detector. Runs a single-purpose vision call
// that ONLY asks about head hair — colour, shade and length. Multi-attribute
// extraction frequently swings between similar colours (brown ↔ blonde
// ↔ dark blonde, black ↔ very dark brown) under different lighting; a
// dedicated pass with a tight phrase list is much more stable.
async function detectHairColor(env, bytes) {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: [...bytes],
      max_tokens: 40,
      messages: [
        {
          role: "system",
          content:
            "You are a precise hair-colour and length detector. Look at the " +
            "head hair only — ignore facial hair. Reply with ONLY one short " +
            "phrase, no other words, no JSON, no punctuation, in this format:\n" +
            "  \"<length> <colour> hair\"\n" +
            "Length options: \"very short\", \"short\", \"medium-length\", \"shoulder-length\", " +
            "\"long\", \"very long\" (or describe a style if more accurate: \"buzzcut\", " +
            "\"crew cut\", \"pixie cut\", \"bob\").\n" +
            "Colour options — be precise: \"black\", \"jet black\", \"dark brown\", " +
            "\"brown\", \"chestnut brown\", \"light brown\", \"auburn\", " +
            "\"red\", \"ginger\", \"strawberry blonde\", \"dark blonde\", " +
            "\"blonde\", \"platinum blonde\", \"ash blonde\", \"grey\", " +
            "\"salt-and-pepper\", \"silver\", \"white\".\n" +
            "Add a texture descriptor when visible: \"straight\", \"wavy\", " +
            "\"curly\", \"coily\".\n" +
            "Examples: \"short dark brown hair\", \"long wavy chestnut brown hair\", " +
            "\"medium-length curly black hair\", \"shoulder-length blonde hair\", " +
            "\"buzzcut grey hair\". " +
            "If the person is bald or has a fully shaved head, reply \"bald\".",
        },
        { role: "user", content: "What hair does this person have? Reply with the phrase only." },
      ],
    });
    const raw = String((out && (out.response ?? out.description ?? out.text)) || "").trim();
    const cleaned = raw
      .replace(/^["'`]+|["'`.,;:!?]+$/g, "")
      .trim()
      .toLowerCase();
    if (!cleaned) return null;
    if (/^bald$/i.test(cleaned)) return "bald";
    // Must look like a hair phrase (contains "hair" OR a haircut keyword)
    if (!/\b(hair|cut|bob|crew|pixie|buzzcut|undercut|fade)\b/i.test(cleaned)) return null;
    return cleaned;
  } catch (err) {
    console.warn(`[pipeline] hair re-check failed: ${err?.message}`);
    return null;
  }
}

// Merge omnibus hair value with focused hair-detector value. Symmetric:
// neither is the "rescue" version (unlike facial hair where clean-shaven is
// special). We prefer the more specific / longer phrase because the focused
// detector usually returns texture + length + colour while omnibus may give
// just "blonde hair".
function mergeHair(omnibus, focused) {
  if (!focused) return omnibus || "";
  if (!omnibus) return focused;
  // If one is "bald" and the other isn't, that's a disagreement we don't
  // want to silently resolve — bias toward NOT bald (assume hair exists if
  // either detector reports it) so we don't erase a real hairstyle.
  const omnibusBald = /^bald$/i.test(omnibus) || /shaved head|no hair/i.test(omnibus);
  const focusedBald = /^bald$/i.test(focused);
  if (omnibusBald && !focusedBald) return focused;     // focused sees hair → keep it
  if (!omnibusBald && focusedBald) return omnibus;     // omnibus sees hair → keep it
  if (omnibusBald && focusedBald) return "bald";
  // Both describe hair — take whichever is more specific (longer phrase usually
  // means colour + length + texture all present).
  return focused.length > omnibus.length ? focused : omnibus;
}

// Focused eye-colour detector. The omnibus extractor frequently misses
// green / grey / hazel / amber irises and defaults to "brown" or "blue"
// — both because those are the global modal eye colours and because under
// most photo lighting a green or grey iris reads as a desaturated blue.
// A single-purpose call against the tight face crop, with the option list
// up front and an explicit "don't default" instruction, lifts detection
// accuracy on the easy-to-miss colours dramatically.
async function detectEyeColor(env, bytes) {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: [...bytes],
      max_tokens: 24,
      messages: [
        {
          role: "system",
          content:
            "You are a precise eye-colour detector. Look at the iris of " +
            "BOTH eyes (the coloured ring around the pupil, NOT the pupil " +
            "itself, NOT the white of the eye). Reply with ONLY one short " +
            "phrase, no other words, no JSON, no punctuation, in this " +
            "format:\n" +
            "  \"<colour> eyes\"\n" +
            "Colour options — pick the most specific match: \"brown\", " +
            "\"dark brown\", \"light brown\", \"hazel\" (brown with green " +
            "or gold flecks), \"amber\" (light brown with gold cast), " +
            "\"blue\", \"light blue\", \"deep blue\", \"blue-grey\", " +
            "\"green\", \"deep green\", \"light green\", \"grey\", " +
            "\"grey-green\". " +
            "Examples: \"green eyes\", \"hazel eyes\", \"grey eyes\", " +
            "\"deep blue eyes\". " +
            "CRITICAL: green, grey and hazel are commonly missed because " +
            "they read as desaturated blue under flat indoor lighting. " +
            "If the iris is clearly NOT brown and NOT clearly saturated " +
            "blue, look harder before defaulting — it is probably green, " +
            "grey or hazel. Equally: if the iris IS clearly dark, do not " +
            "invent green or grey. Be honest about what you see.",
        },
        { role: "user", content: "What colour are this person's eyes? Reply with the phrase only." },
      ],
    });
    const raw = String((out && (out.response ?? out.description ?? out.text)) || "").trim();
    const cleaned = raw.replace(/^["'`]+|["'`.,;:!?]+$/g, "").trim().toLowerCase();
    if (!cleaned) return null;
    // Must look like an eye phrase
    if (!/\beyes?\b/.test(cleaned)) return null;
    return cleaned;
  } catch (err) {
    console.warn(`[pipeline] eye re-check failed: ${err?.message}`);
    return null;
  }
}

// Merge omnibus eye value with focused eye-colour detector. Prefer the
// focused result when it disagrees AND looks more specific — because the
// focused call's explicit option list pushes it past the common
// "default-to-brown-or-blue" failure mode that the omnibus exhibits.
function mergeEyeColor(omnibus, focused) {
  if (!focused) return omnibus || "";
  if (!omnibus) return focused;
  // Strong-signal colours that the focused detector is especially good at
  // catching — if the focused call sees these, take it even if omnibus
  // disagrees. Otherwise fall back to "longer / more specific phrase wins"
  // which biases toward the more descriptive answer.
  const strongFocused = /\b(green|hazel|amber|grey|grey-?green|blue-?grey)\b/i.test(focused);
  if (strongFocused && !new RegExp("\\b" + focused.replace(/[^a-z\- ]/g, "").trim() + "\\b", "i").test(omnibus)) {
    return focused;
  }
  return focused.length > omnibus.length ? focused : omnibus;
}

// Focused glasses detector. Glasses are a major identity feature — when they
// go missing, the model invents random stylised eyes in the empty frame
// space. The omnibus extractor buries glasses inside the free-text "notable"
// field where it's often dropped entirely. This single-purpose call asks
// ONLY about glasses (presence + style).
async function detectGlasses(env, bytes) {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: [...bytes],
      max_tokens: 30,
      messages: [
        {
          role: "system",
          content:
            "You are a glasses / eyewear detector. Look CAREFULLY at the " +
            "person's eyes and the area around them — are they wearing " +
            "prescription glasses, sunglasses, or any eyewear? Reply with " +
            "ONLY one short phrase, no other words, no JSON. " +
            "If WEARING glasses, describe the frame style — choose from: " +
            "\"round wire-frame glasses\", \"round thick-frame glasses\", " +
            "\"square wire-frame glasses\", \"square thick-frame glasses\", " +
            "\"rectangular glasses\", \"thick black acetate glasses\", " +
            "\"thin metal-frame glasses\", \"aviator glasses\", " +
            "\"frameless rimless glasses\", \"half-rim glasses\", " +
            "\"cat-eye glasses\", \"sunglasses\", \"reading glasses\". " +
            "If NO glasses visible, reply exactly \"no glasses\".",
        },
        { role: "user", content: "Are they wearing glasses? Reply with the phrase only." },
      ],
    });
    const raw = String((out && (out.response ?? out.description ?? out.text)) || "").trim();
    const cleaned = raw
      .replace(/^["'`]+|["'`.,;:!?]+$/g, "")
      .trim()
      .toLowerCase();
    if (!cleaned) return null;
    if (/^no\s+glasses$|^none$/i.test(cleaned)) return "no glasses";
    if (!/\b(glasses|spectacles|eyewear|sunglasses|frames?)\b/i.test(cleaned)) return null;
    return cleaned;
  } catch (err) {
    console.warn(`[pipeline] glasses re-check failed: ${err?.message}`);
    return null;
  }
}

// Merge focused glasses detection into the omnibus `notable` field.
//   focused says glasses + notable doesn't mention them → prepend to notable
//   focused says glasses + notable already mentions them → leave (don't dup)
//   focused says no glasses → leave notable alone (don't try to remove)
//   focused failed/null → leave notable alone
function mergeGlassesIntoNotable(notable, focused) {
  if (!focused) return notable || "";
  if (/^no\s+glasses$/i.test(focused)) return notable || "";
  // Focused saw glasses. Does notable already mention them?
  const notableStr = String(notable || "").toLowerCase();
  if (/\b(glasses|spectacles|sunglasses|eyewear|frame)\b/i.test(notableStr)) {
    // Already in notable — leave as-is (omnibus may have a better description)
    return notable || "";
  }
  // Not in notable — prepend the focused detector's description.
  return notable ? `${focused}, ${notable}` : focused;
}

// Focused gender detector. The omnibus extractor uses hair length as a
// strong (but unreliable) gender signal — short-haired women routinely get
// labelled as men, and long-haired men sometimes get labelled as women.
// This focused call explicitly DE-EMPHASISES hair length and asks the model
// to look at facial bone structure instead.
async function detectGender(env, bytes) {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      image: [...bytes],
      max_tokens: 20,
      messages: [
        {
          role: "system",
          content:
            "You are a precise gender detector. Look at this person's " +
            "FACE — facial bone structure, jaw line, brow ridge, cheekbones, " +
            "lip shape, eye shape, neck width. " +
            "CRITICAL: hair length is NOT a reliable gender signal. Many " +
            "women have short hair (pixie cuts, bobs, buzz cuts, undercuts, " +
            "shaved sides). Many men have long hair (man-buns, shoulder- " +
            "length, ponytails). A short-haired woman is still a woman. " +
            "Determine gender from the face, not the hair. " +
            "Reply with ONLY one word, no punctuation, no other text: " +
            "\"man\", \"woman\", or \"unsure\" (use \"unsure\" only if the " +
            "face is genuinely ambiguous from facial structure).",
        },
        { role: "user", content: "Is this person a man or a woman? Look at the face — not the hair. Reply with one word only." },
      ],
    });
    const raw = String((out && (out.response ?? out.description ?? out.text)) || "").trim();
    const cleaned = raw.replace(/^["'`]+|["'`.,;:!?]+$/g, "").trim().toLowerCase();
    if (/^(man|male)$/i.test(cleaned))   return "man";
    if (/^(woman|female)$/i.test(cleaned)) return "woman";
    return null; // unsure / unparseable → keep omnibus answer
  } catch (err) {
    console.warn(`[pipeline] gender re-check failed: ${err?.message}`);
    return null;
  }
}

// Combine the omnibus gender value with the focused detector's answer.
//   focused null/unsure       → keep omnibus
//   they agree                → no change
//   they disagree             → trust focused (it was told to ignore hair length;
//                              omnibus often uses hair length as a tiebreaker)
function mergeGender(omnibus, focused) {
  if (!focused) return omnibus || "";
  if (!omnibus) return focused;
  const omnibusIsMan   = /\b(man|male)\b/i.test(omnibus);
  const omnibusIsWoman = /\b(woman|female)\b/i.test(omnibus);
  // Agree → keep omnibus phrasing (might be "young man", "adult woman", etc.)
  if (omnibusIsMan   && focused === "man")   return omnibus;
  if (omnibusIsWoman && focused === "woman") return omnibus;
  // Disagree → trust the focused detector (single-purpose call with explicit
  // anti-hair-length-bias guidance beats the omnibus default).
  return focused;
}

// Pull the first {...} block out of the model output and validate it. Vision
// models occasionally wrap JSON in prose or code fences despite instructions,
// so we extract defensively rather than JSON.parse the whole string.
function parseSubjectJson(raw) {
  if (!raw) return null;
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    const clean = (v) => (typeof v === "string" ? v.trim() : "");
    // Strip "none" sentinel — easier downstream than checking for it everywhere.
    const cleanField = (v) => {
      const s = clean(v);
      return /^(none|n\/?a|null|nothing|—)$/i.test(s) ? "" : s;
    };
    const subject = {
      gender:     clean(obj.gender),
      age:        clean(obj.age),
      hair:       cleanField(obj.hair),
      facial:     cleanField(obj.facial),
      eyes:       cleanField(obj.eyes),
      skin:       cleanField(obj.skin),
      face_shape: cleanField(obj.face_shape),
      age_cues:   cleanField(obj.age_cues),
      tattoos:    cleanField(obj.tattoos),
      notable:    cleanField(obj.notable),
    };
    // Gender is the attribute we most need; if it's missing the rest is noise.
    return subject.gender ? subject : null;
  } catch {
    return null;
  }
}

// Dispatcher — picks the active pipeline. Resolution order:
//   1. `override` arg (set from ?pipeline=… query param on /portrait)
//   2. PIPELINE env var (wrangler.toml [vars] or Cloudflare dashboard)
//   3. fallback default "pulid"
//
// Valid values:
//   "pulid"     — runPortraitPipeline (legacy flux-pulid text-to-image)
//   "kontext"   — runKontextPipeline (NEW: FLUX.1 Kontext image-to-image,
//                 Snapchat-style identity preservation)
//   "snapchat"  — runSnapchatPipeline (legacy two-stage, face-to-many call
//                 body malformed — kept only for reference, don't enable)
//
// The per-request override is the safe way to A/B test a new pipeline
// against prod: keep PIPELINE="pulid" globally, hit
// `/portrait?pipeline=kontext` from a test client to render through the
// new pipeline only when explicitly requested.
async function runSelectedPipeline(env, image, archetype, faceImage, override) {
  const choice = (override || env.PIPELINE || "pulid").toLowerCase();
  if (choice === "kontext")  return runKontextPipeline(env, image, archetype, faceImage);
  if (choice === "snapchat") return runSnapchatPipeline(env, image, archetype, faceImage);
  return runPortraitPipeline(env, image, archetype, faceImage);
}

// ---------- FLUX.1 Kontext pipeline ----------
// SINGLE-CALL image-to-image with prompt-guided style transfer. The model
// takes the user's actual photo as `image_url`, transforms it under our
// styled prompt, and returns the result — same architecture Snapchat /
// Lensa / Toonify use under the hood. Because the algorithm STARTS from
// the user's photo and only TRANSFORMS pixels, identity preservation
// (face structure, hair colour, eye colour, glasses, beard, skin tone)
// is dramatically stronger than the text-to-image PuLID approach which
// generates from a face embedding.
//
// Why this replaces the broken two-stage face-to-many pipeline:
//   - Single fal call instead of two — half the latency, fewer failure modes.
//   - Documented, stable API contract (verified against the model page
//     before shipping this time).
//   - Strong identity preservation by construction.
//
// Cost: $0.04 per render (per fal docs). Latency: ~6-10s typical.
// Endpoint: POST https://fal.run/fal-ai/flux-pro/kontext
//
// Request body schema (from fal docs):
//   image_url          (required) — input image as URL or data URL
//   prompt             (required) — editing instruction
//   guidance_scale     (optional) — prompt adherence, default works fine
//   num_inference_steps(optional) — quality knob
//   seed               (optional) — reproducibility
//
// Response: { images: [{ url, width, height }], seed, prompt, has_nsfw_concepts }
async function runKontextPipeline(env, image, archetype, faceImage) {
  if (!PROMPT_TEMPLATES[archetype]) throw new Error("unknown_archetype");
  if (!env.FAL_KEY) throw new Error("no_fal_key");

  const t0 = Date.now();
  console.log(`[kontext-pipeline] start archetype=${archetype} hasFaceCrop=${!!faceImage}`);

  // Vision pre-pass still useful — gives us the per-subject directive that
  // tells the model what to preserve (specific hair colour, glasses, beard).
  // Kontext is excellent at preserving what it sees in the photo, but the
  // textual directive gives extra reinforcement.
  const subject = await describeSubject(env, image, faceImage);
  console.log(`[kontext-pipeline] subject pre-pass done t+${Date.now()-t0}ms hasSubject=${!!subject}`);

  // Build the prompt: archetype + subject directives wrapped in an
  // "transform this image while preserving identity" framing that Kontext
  // understands as an editing instruction. The PRESERVE prefix is critical
  // — without it Kontext may treat the prompt as a regenerate instruction
  // and lose identity on heavy stylisation.
  const archetypePrompt = getPromptFor(archetype, subject);
  // Kontext doesn't accept a negative_prompt — anti-text guidance has to
  // be baked into the positive prompt instead. We sandwich the archetype
  // scene between a START directive (preserve identity, no text) and an
  // END directive (NO TEXT, NO PILL, NO LABEL) so Flux gets the no-text
  // signal at both high-weight ends of the prompt.
  const kontextPrompt =
    "TRANSFORM this portrait photo into an illustrated tarot card while " +
    "PRESERVING THE PERSON'S EXACT identity from this photo — same face " +
    "structure, same hair colour, same eye colour, same skin tone, same " +
    "beard / stubble / glasses / distinctive features if present. Do NOT " +
    "change who they are. Only transform the rendering STYLE and add the " +
    "SCENE around them. " +
    "ABSOLUTELY NO TEXT in the image — no letters, no words, no labels, " +
    "no name banners, no pill at the bottom with an archetype name, no " +
    "scrolls with writing, no watermarks, no signatures, no captions. " +
    "The bottom strip of the image is CLEAN illustration only — labels " +
    "are added separately by the application, the AI must NOT draw them. " +
    archetypePrompt +
    " FINAL CHECK: the rendered image contains ZERO text characters. " +
    "No letters anywhere. No name pill. No archetype label. No banner. " +
    "No scroll text. Just illustration — pure visual scene with the " +
    "subject and their tarot setting, no written language anywhere.";

  const reqBody = {
    image_url: image,
    prompt: kontextPrompt,
    // Kontext typically works at lower CFG than text-to-image generation
    // (~3-4) — too high erodes identity preservation.
    guidance_scale: 3.5,
    num_inference_steps: 30,
  };

  const falRes = await fetch(FAL_KONTEXT_URL, {
    method: "POST",
    headers: {
      Authorization: `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });

  if (!falRes.ok) {
    const detail = await falRes.text();
    console.error(`[kontext-pipeline] FAILED status=${falRes.status} detail=${detail.slice(0,500)}`);
    throw new Error(`kontext_upstream:${falRes.status}:${detail.slice(0,200)}`);
  }

  const data = await falRes.json();
  const outputUrl = data?.images?.[0]?.url;
  if (!outputUrl) {
    console.error(`[kontext-pipeline] no image returned, data=${JSON.stringify(data).slice(0,400)}`);
    throw new Error("kontext_no_image");
  }
  console.log(`[kontext-pipeline] kontext ok t+${Date.now()-t0}ms`);

  // Proxy the final image as inline base64 — avoids leaking fal's transient
  // CDN URLs to the client and dodges cross-origin canvas taint.
  const imgRes = await fetch(outputUrl);
  if (!imgRes.ok) throw new Error(`image_fetch_failed:${imgRes.status}`);
  const buf = await imgRes.arrayBuffer();
  const result = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
  console.log(`[kontext-pipeline] done t+${Date.now()-t0}ms size=${buf.byteLength}b`);
  return result;
}

// ---------- Snapchat-style pipeline: photo-translation + scene enrichment ----------
// Mimics how Snapchat / Lensa / Toonify achieve "looks uncannily like me" —
// the algorithm STARTS from the user's actual photo and TRANSFORMS pixels
// rather than generating a stylised character from a face embedding. Two stages:
//
//   Stage 1: fal-ai/face-to-many
//     Snapchat-style image-to-image translation. Takes the user's photo and
//     produces a cartoonified version that PRESERVES face structure, glasses,
//     beard, hair, jaw, skin tone — because it operates pixel-by-pixel rather
//     than generating from scratch. Output: cartoon character on a simple
//     background.
//
//   Stage 2: fal-ai/flux/dev/image-to-image
//     Takes Stage 1's cartoonified character as the init image and applies the
//     full archetype tarot prompt at MODERATE strength (~0.55). This preserves
//     the character (low enough strength) while filling the background with
//     archetype-specific motifs (high enough strength to add the tarot scene
//     around them). Output: cartoonified character INSIDE a rich tarot scene.
//
// Cost: ~$0.06-0.08 per render (vs ~$0.04 for PuLID). Latency: ~16-20s
// (vs ~12s). The likeness gain is large enough to justify both.
async function runSnapchatPipeline(env, image, archetype, faceImage) {
  if (!PROMPT_TEMPLATES[archetype]) throw new Error("unknown_archetype");
  if (!env.FAL_KEY) throw new Error("no_fal_key");

  const t0 = Date.now();
  console.log(`[snap-pipeline] start archetype=${archetype} hasFaceCrop=${!!faceImage}`);

  // Vision pre-pass — still useful for the per-subject directive that goes
  // into Stage 2's prompt, and for building the dynamic negative prompt.
  const subject = await describeSubject(env, image, faceImage);
  const subjectNegative = buildSubjectNegative(subject);
  console.log(`[snap-pipeline] subject pre-pass done t+${Date.now()-t0}ms hasSubject=${!!subject}`);

  // ----- STAGE 1: cartoonify the user's photo (Snapchat-style translation) -----
  // face-to-many supports several preset styles. "Comic" is closest to our
  // brand cel-shaded animated-graphic-novel aesthetic; "pixar" is the
  // fallback if "comic" produces something too flat. The prompt parameter
  // provides additional tone guidance.
  const stage1ReqBody = {
    image_url: image,
    style: "comic",                     // brand-aligned cartoon style
    prompt:
      "bold cel-shaded comic-book character portrait, animated " +
      "graphic-novel illustration, vivid expressive face, large lively " +
      "eyes with clearly drawn pupils, heavy deep-wine or near-black " +
      "linework, smooth solid colour fills with cel-shaded volumes",
    num_inference_steps: 30,
    guidance_scale: 7,
    image_size: "portrait_4_3",
    output_format: "jpeg",
    num_images: 1,
    negative_prompt: BASE_NEGATIVE_PROMPT + (subjectNegative ? ", " + subjectNegative : ""),
  };
  const stage1Res = await fetch(FAL_FACE_TO_MANY_URL, {
    method: "POST",
    headers: {
      Authorization: `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(stage1ReqBody),
  });
  if (!stage1Res.ok) {
    const detail = await stage1Res.text();
    console.error(`[snap-pipeline] STAGE 1 (face-to-many) FAILED status=${stage1Res.status} detail=${detail.slice(0,300)}`);
    throw new Error(`face_to_many_upstream:${stage1Res.status}:${detail}`);
  }
  const stage1Data = await stage1Res.json();
  const cartoonifiedUrl = stage1Data?.images?.[0]?.url || stage1Data?.image?.url;
  if (!cartoonifiedUrl) {
    console.error(`[snap-pipeline] STAGE 1 returned no image, data=${JSON.stringify(stage1Data).slice(0,300)}`);
    throw new Error("face_to_many_no_image");
  }
  console.log(`[snap-pipeline] STAGE 1 (face-to-many) ok t+${Date.now()-t0}ms`);

  // ----- STAGE 2: enrich the cartoonified character with the tarot scene -----
  // Image-to-image at LOW strength (0.40) — Stage 1 already produced a
  // cartoonified version of the user's actual face. Stage 2's only job is to
  // ADD the tarot scene around them, NOT to re-render the character. At
  // strength 0.55 we were seeing colour drift (brunettes → black hair, brown
  // eyes → green eyes) because flux had license to flip ~half the pixels
  // when applying the scene prompt. Dropping to 0.40 lets the scene paint
  // around the character while the character's hair/eye/skin pigment from
  // Stage 1 survives intact.
  //
  // The prompt is prepended with a "PRESERVE THE CHARACTER" directive that
  // tells flux explicitly: the figure in the init image is correct; do not
  // change their hair colour, eye colour, skin tone or face. Only add the
  // background scene around them.
  const archetypePrompt = getPromptFor(archetype, subject);
  const stage2Prompt =
    "PRESERVE THE CHARACTER in the input image EXACTLY — same face, same " +
    "hair colour, same eye colour, same skin tone, same wardrobe, same " +
    "pose. The figure in the input image is already correct; do NOT " +
    "recolour their hair, eyes or skin under any circumstances. Your only " +
    "job is to ADD the surrounding tarot scene around them. " +
    archetypePrompt;
  const stage2Negative =
    BASE_NEGATIVE_PROMPT +
    // Hard exclusions against colour drift — the failure modes we keep
    // seeing on Stage 2 specifically.
    ", recoloured hair, hair colour changed from input, black hair " +
    "replacing brown hair, brown hair replacing black hair, " +
    "recoloured eyes, eye colour changed from input, green eyes " +
    "replacing brown eyes, blue eyes replacing brown eyes, " +
    "different face from input image, different facial structure " +
    "from input, swapped identity" +
    (subjectNegative ? ", " + subjectNegative : "");
  const stage2ReqBody = {
    image_url: cartoonifiedUrl,
    prompt: stage2Prompt,
    strength: 0.40,                    // LOW — keep character intact, add scene around them only
    num_inference_steps: 28,
    guidance_scale: 7,
    image_size: "portrait_4_3",
    output_format: "jpeg",
    num_images: 1,
    enable_safety_checker: true,
    negative_prompt: stage2Negative,
  };
  const stage2Res = await fetch(FAL_FLUX_I2I_URL, {
    method: "POST",
    headers: {
      Authorization: `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(stage2ReqBody),
  });
  if (!stage2Res.ok) {
    const detail = await stage2Res.text();
    console.error(`[snap-pipeline] STAGE 2 (flux i2i) FAILED status=${stage2Res.status} detail=${detail.slice(0,300)}`);
    throw new Error(`flux_i2i_upstream:${stage2Res.status}:${detail}`);
  }
  const stage2Data = await stage2Res.json();
  const finalUrl = stage2Data?.images?.[0]?.url || stage2Data?.image?.url;
  if (!finalUrl) {
    console.error(`[snap-pipeline] STAGE 2 returned no image, data=${JSON.stringify(stage2Data).slice(0,300)}`);
    throw new Error("flux_i2i_no_image");
  }
  console.log(`[snap-pipeline] STAGE 2 (flux i2i) ok t+${Date.now()-t0}ms`);

  // Proxy the final image as inline base64 so we don't leak fal's transient
  // CDN URLs to the client and don't tangle with cross-origin canvas taint.
  console.log(`[snap-pipeline] fetching final image t+${Date.now()-t0}ms`);
  const imgRes = await fetch(finalUrl);
  if (!imgRes.ok) throw new Error(`image_fetch_failed:${imgRes.status}`);
  const buf = await imgRes.arrayBuffer();
  const result = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
  console.log(`[snap-pipeline] done t+${Date.now()-t0}ms size=${buf.byteLength}b`);
  return result;
}

// ---------- pipeline: runs all four AI stages, returns a data URL ----------
async function runPortraitPipeline(env, image, archetype, faceImage) {
  if (!PROMPT_TEMPLATES[archetype]) throw new Error("unknown_archetype");
  if (!env.FAL_KEY) throw new Error("no_fal_key");

  const t0 = Date.now();
  console.log(`[pipeline] start archetype=${archetype} hasFaceCrop=${!!faceImage}`);

  // Vision pre-pass first so the descriptor can be baked into the prompt
  // (and the negative prompt — see buildSubjectNegative below). When the
  // client sent a tight face crop alongside the wide shot, it dramatically
  // improves identity extraction (~4× face-pixel density to the vision model).
  const subject = await describeSubject(env, image, faceImage);
  const prompt = getPromptFor(archetype, subject);
  const subjectNegative = buildSubjectNegative(subject);
  console.log(`[pipeline] subject pre-pass done t+${Date.now()-t0}ms hasSubject=${!!subject}`);

  const falRes = await fetch(FAL_PULID_URL, {
      method: "POST",
      headers: {
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        reference_image_url: image,   // user's face — PuLID anchors on this
        image_size: "portrait_4_3",   // editorial portrait crop
        num_inference_steps: 22,      // dropped from 28 (which was bumped originally for cross-eye fix in #13). Eye alignment is now also enforced via STYLE_TRAIL ("BOTH PUPILS ALIGNED…") + dedicated negative-prompt block (cross-eyed, walleyed, lazy eye…) — the prompt-side directives carry the eye-alignment work, freeing the step count to drop back. Saves ~3s/render.
        guidance_scale: 7,            // pushed up hard — Flux base has a photo bias; high CFG forces the illustration prompt to win
        true_cfg: 1,
        // id_weight tuned per-subject: PuLID's face embedding is trained on
        // largely clean-shaven faces and at very high id_weight it can
        // OVERRIDE the text-prompt's beard directive on the lower-face pixels.
        // For bearded subjects we drop slightly (0.65) so the text prompt
        // wins on facial-hair pixels. For everyone else we keep the higher
        // 0.7 anchoring for closer overall likeness.
        id_weight: subject && subject.facial && !/^clean[-\s]?shaven$/i.test(subject.facial) ? 0.65 : 0.7,
        num_images: 1,
        output_format: "jpeg",
        enable_safety_checker: true,
        negative_prompt: BASE_NEGATIVE_PROMPT + (subjectNegative ? ", " + subjectNegative : ""),
      }),
    });

  if (!falRes.ok) {
    const detail = await falRes.text();
    console.error(`[pipeline] PuLID FAILED status=${falRes.status} detail=${detail.slice(0,300)}`);
    throw new Error(`pulid_upstream:${falRes.status}:${detail}`);
  }

  const data = await falRes.json();
  const pulidUrl = data?.images?.[0]?.url;
  if (!pulidUrl) {
    console.error(`[pipeline] PuLID returned no image, data=${JSON.stringify(data).slice(0,300)}`);
    throw new Error("pulid_no_image");
  }
  console.log(`[pipeline] PuLID ok t+${Date.now()-t0}ms`);

  // Illustration pipeline is single-stage: PuLID with the new prompts.
  // We previously chained face-swap + CodeFormer + Clarity to drive the
  // output toward a polished photograph — all three fight the flat-
  // illustration style we're now aiming for, so they're skipped.
  // Pipeline drops from ~25s/$0.10 → ~10s/$0.04 as a side benefit.

  // Proxy the final image as inline base64 — avoids cross-origin canvas
  // taint and keeps fal.ai's transient URLs off the client.
  console.log(`[pipeline] fetching final image t+${Date.now()-t0}ms`);
  const imgRes = await fetch(pulidUrl);
  if (!imgRes.ok) throw new Error(`image_fetch_failed:${imgRes.status}`);
  const buf = await imgRes.arrayBuffer();
  const result = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
  console.log(`[pipeline] done t+${Date.now()-t0}ms size=${buf.byteLength}b`);
  return result;
}

// ---------- /send-card — synchronous, uses a pre-rendered image ----------
async function handleSendCard(request, env, cors) {
  try {
    const body = (await request.json()) || {};
    const { email, archetype, image } = body;
    if (!email || !archetype || !image) return jsonResp({ error: "missing_fields" }, 400, cors);
    if (!isValidEmail(email))           return jsonResp({ error: "invalid_email" }, 400, cors);

    // Thread the request origin so sendCardEmail can build absolute URLs for
    // the per-portrait share page (LinkedIn needs an absolute URL to scrape OG
    // meta), even when the client doesn't echo back the worker origin.
    const reqUrl = new URL(request.url);
    const data = await sendCardEmail(env, { ...body, shareOrigin: reqUrl.origin });
    return jsonResp({ ok: true, id: data?.id }, 200, cors);
  } catch (err) {
    const msg = err?.message || "server";
    const status = /upstream/i.test(msg) ? 502 : 500;
    return jsonResp({ error: "send_failed", message: msg }, status, cors);
  }
}

// ---------- Mailchimp debug — verify integration on-demand ----------
// GET /debug/mailchimp?key=<GALLERY_KEY>&email=<test@email>&archetype=<key>
//   Synthetic add. Returns the addToMailchimp result + meta about the
//   computed dc / list URL so we can confirm:
//     1. The secrets are loaded into env
//     2. The dc parses correctly from the API key
//     3. The list ID resolves
//     4. Mailchimp accepts the contact (status "added") or already has
//        them (status "existing")
//   Use this BEFORE an event to confirm wiring; use it AFTER an event
//   if no contacts show up in Mailchimp.
async function handleMailchimpDebug(_request, env, url, cors) {
  if (!env.GALLERY_KEY) return jsonResp({ error: "no_key_config" }, 500, cors);
  const auth = url.searchParams.get("key") || "";
  if (auth !== env.GALLERY_KEY) return jsonResp({ error: "forbidden" }, 403, cors);

  const email = url.searchParams.get("email");
  const archetype = url.searchParams.get("archetype") || "charmer";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResp({ error: "bad_email", hint: "pass ?email=<address>" }, 400, cors);
  }

  // Surface the env-side wiring so the user can see what's configured
  // even before the add runs.
  const apiKeyParts = String(env.MAILCHIMP_API_KEY || "").split("-");
  const dc = apiKeyParts.length > 1 ? apiKeyParts[apiKeyParts.length - 1] : null;
  const config = {
    has_api_key: !!env.MAILCHIMP_API_KEY,
    has_list_id: !!env.MAILCHIMP_LIST_ID,
    parsed_datacenter: dc,
    api_url: dc && env.MAILCHIMP_LIST_ID
      ? `https://${dc}.api.mailchimp.com/3.0/lists/${env.MAILCHIMP_LIST_ID}/members`
      : null,
    event_tag: String(env.MAILCHIMP_EVENT_TAG || "").trim() || null,
  };

  const result = await addToMailchimp(env, email, archetype);
  return jsonResp({ config, result, tested_with: { email, archetype } }, 200, cors);
}

// ---------- Mailchimp: add the email to the audience after every send ----------
// Tags the contact with "filter-for-the-phone" + their archetype so the
// downstream audience can be segmented. Best-effort: if MAILCHIMP_API_KEY
// or MAILCHIMP_LIST_ID aren't set, or if Mailchimp errors, we log and
// continue — the email send must not depend on Mailchimp being healthy.
//
// Set the two env vars with:
//   wrangler secret put MAILCHIMP_API_KEY   (looks like xxxx-us12)
//   wrangler secret put MAILCHIMP_LIST_ID   (the audience / list id)
async function addToMailchimp(env, email, archetype) {
  // Return shape: { status: "added" | "existing" | "skipped" | "failed",
  //                 reason?: string, httpStatus?: number, detail?: string }
  // — so callers and the /debug/mailchimp endpoint can surface the
  // outcome without re-parsing. Logs every outcome with a [mailchimp]
  // prefix so `wrangler tail` filtering is one-liner.
  if (!env.MAILCHIMP_API_KEY || !env.MAILCHIMP_LIST_ID) {
    console.warn(`[mailchimp] skipped: ${!env.MAILCHIMP_API_KEY ? "MAILCHIMP_API_KEY" : "MAILCHIMP_LIST_ID"} secret not set`);
    return { status: "skipped", reason: "secret_not_set" };
  }

  // The datacenter is the suffix after the dash in the API key (e.g. "us12").
  const parts = String(env.MAILCHIMP_API_KEY).split("-");
  const dc = parts.length > 1 ? parts[parts.length - 1] : "";
  if (!dc) {
    console.warn("[mailchimp] skipped: API key has no `-<datacenter>` suffix (expected format like `xxxxxx-us12`)");
    return { status: "skipped", reason: "no_datacenter" };
  }

  const url = `https://${dc}.api.mailchimp.com/3.0/lists/${env.MAILCHIMP_LIST_ID}/members`;
  const auth = btoa(`anystring:${env.MAILCHIMP_API_KEY}`);

  // Tags applied to every contact:
  //   - "filter-for-the-phone"     always-on campaign tag (across all events)
  //   - <archetype>                so the audience can be segmented by card
  //   - MAILCHIMP_EVENT_TAG        per-event tag set in wrangler.toml (e.g.
  //                                "Biocap" for the current event); skip if blank
  const eventTag = String(env.MAILCHIMP_EVENT_TAG || "").trim();
  const body = {
    email_address: email,
    status: "subscribed",
    tags: ["filter-for-the-phone", archetype, eventTag].filter(Boolean),
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      console.log(`[mailchimp] added: ${email} (archetype=${archetype})`);
      return { status: "added" };
    }

    // 400 with "already a list member" or "exists" is success-equivalent:
    // they're already subscribed, which means we've already captured them
    // previously. Mailchimp's API requires the lowercase-MD5 subscriber
    // hash to PATCH tags on an existing member, and Workers crypto
    // doesn't expose MD5 — so we skip the tag update for existing members.
    // If you need to backfill archetype tags later, do it in bulk via
    // Mailchimp's CSV import or a one-off script.
    const detail = await res.text();
    if (res.status === 400 && /already a list member|exists/i.test(detail)) {
      console.log(`[mailchimp] existing: ${email} (archetype=${archetype})`);
      return { status: "existing" };
    }

    console.warn(`[mailchimp] failed: HTTP ${res.status} for ${email} — ${detail.slice(0, 240)}`);
    return { status: "failed", httpStatus: res.status, detail: detail.slice(0, 500) };
  } catch (err) {
    console.warn(`[mailchimp] threw: ${err?.message}`);
    return { status: "failed", reason: "exception", detail: err?.message };
  }
}

// ---------- Slack debug — verify the webhook on-demand ----------
// GET /debug/slack?key=<GALLERY_KEY>&email=<addr>&archetype=<key>
// Fires the same pingSlack call sendCardEmail makes, with the params
// passed via query. Returns the structured outcome + meta so we can
// see at a glance whether the secret is set and whether Slack accepted.
async function handleSlackDebug(_request, env, url, cors) {
  if (!env.GALLERY_KEY) return jsonResp({ error: "no_key_config" }, 500, cors);
  const auth = url.searchParams.get("key") || "";
  if (auth !== env.GALLERY_KEY) return jsonResp({ error: "forbidden" }, 403, cors);

  const email = url.searchParams.get("email") || "test@vonpeach.com";
  const archetype = url.searchParams.get("archetype") || "monk";
  const read = READS[archetype] || {};
  const archetypeName = read.name || archetype;

  const config = {
    has_webhook: !!env.SLACK_WEBHOOK_URL,
    // Echo a redacted form — the URL ends in a secret token; show only
    // the hosts.slack.com/services/T.../B... prefix to confirm shape
    // without leaking the token in the response body.
    webhook_prefix: env.SLACK_WEBHOOK_URL
      ? String(env.SLACK_WEBHOOK_URL).split("/").slice(0, 6).join("/") + "/..."
      : null,
    event_tag: String(env.MAILCHIMP_EVENT_TAG || "").trim() || null,
  };

  const result = await pingSlack(env, {
    email,
    archetype,
    archetypeName,
    sharePath: url.searchParams.get("sharePath") || null,
    shareOrigin: url.origin,
  });

  return jsonResp({ config, result, tested_with: { email, archetype } }, 200, cors);
}

// ---------- Slack: ping a webhook with each new email submission ----------
// Posts a small notification card to a Slack channel via an Incoming
// Webhook so we get live visibility into who's submitting emails during
// an event. Best-effort: silent no-op if SLACK_WEBHOOK_URL isn't set,
// swallows its own errors so the surrounding email send is never blocked.
//
// Set the webhook with:
//   wrangler secret put SLACK_WEBHOOK_URL
// Slack incoming-webhook URLs look like:
//   https://hooks.slack.com/services/T.../B.../xxxxxxxx
// Create one in Slack: App directory → Incoming Webhooks → Add to channel.
//
// The message uses Slack's Block Kit format so the recipient sees:
//   - A short header (":star2: New Von Peach card")
//   - A context line with the email + archetype
//   - A button linking to the user's /p/<key> share page (preview shows
//     their actual card via og:image, so the Slack preview unfurls nicely)
async function pingSlack(env, { email, archetype, archetypeName, sharePath, shareOrigin }) {
  if (!env.SLACK_WEBHOOK_URL) {
    // Quiet on missing — keep the log only when present-but-broken.
    return { status: "skipped", reason: "no_webhook" };
  }

  const shareUrl = (sharePath && shareOrigin)
    ? shareOrigin + sharePath
    : "https://tarot.vonpeach.com";

  // Per-event tag from wrangler.toml — shown in the Slack header so the
  // curator can see at a glance which event a ping belongs to when
  // multiple are active or recently finished.
  const eventTag = String(env.MAILCHIMP_EVENT_TAG || "").trim();
  const eventPrefix = eventTag ? ` · *${escapeSlack(eventTag)}*` : "";
  const titleEventBit = eventTag ? ` (${eventTag})` : "";

  // Block Kit payload. Header is bold, context section gives the
  // structured data, button gives the curator a one-click jump to the
  // share page (which already auto-unfurls via OG tags in Slack, so the
  // preview embed below the button shows the user's actual card).
  const payload = {
    text: `New Von Peach card${titleEventBit}: ${email} · ${archetypeName || archetype}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:sparkles: *New Von Peach card*${eventPrefix}\n*${escapeSlack(email)}* drew *${escapeSlack(archetypeName || archetype)}*`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View card", emoji: true },
            url: shareUrl,
            style: "primary",
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      console.log(`[slack] pinged: ${email} (archetype=${archetype})`);
      return { status: "ok" };
    }
    const detail = await res.text();
    console.warn(`[slack] failed: HTTP ${res.status} — ${detail.slice(0, 240)}`);
    return { status: "failed", httpStatus: res.status, detail: detail.slice(0, 500) };
  } catch (err) {
    console.warn(`[slack] threw: ${err?.message}`);
    return { status: "failed", reason: "exception", detail: err?.message };
  }
}

// Minimal Slack escape — Block Kit mrkdwn treats <, > and & as control
// characters used to wrap user mentions, links and HTML entities. The
// fields we pass in (email + archetype name) shouldn't contain them
// under normal use, but defending against weird inputs is cheap.
function escapeSlack(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- email send: posts to Resend, throws on failure ----------
// `image` is shown inline in the email body AND attached for download. We
// used to attach the raw AI portrait (`imageAttachment`) on the theory that
// a frameless version was more LinkedIn-friendly, but the current Kontext
// pipeline lets the AI invent its own tarot frame with gibberish text at the
// bottom — so the "clean" version actually looks worse than the framed one.
// Always attach the framed shareCanvas image now (covers the AI's gibberish
// pill with our brand pill). `sharePath` is a `/p/<key>` URL fragment built
// from the R2 key; combined with `shareOrigin` it gives the email a real
// per-portrait share URL so the LinkedIn button previews the user's own
// card instead of a generic site preview.
async function sendCardEmail(env, { email, archetype, archetypeName, image, imageAttachment, sharePath, shareOrigin }) {
  if (!env.RESEND_KEY) throw new Error("no_resend_key");

  const read = READS[archetype] || {};
  const name = read.name || archetypeName || "your archetype";
  const tagline = read.tagline || "";
  const paragraphs = read.paragraphs || [];
  const from = env.FROM_EMAIL || "Von Peach <onboarding@resend.dev>";

  // Strip "data:image/jpeg;base64," prefix — Resend wants raw base64.
  // Prefer the framed `image` (shareCanvas) over `imageAttachment` (raw AI
  // with gibberish text). The legacy fallback to imageAttachment is kept for
  // backwards compatibility with any old clients still in the wild.
  const attachmentSrc = image || imageAttachment;
  const attachmentB64 = String(attachmentSrc).split(",").pop();

  // Build the per-portrait share URL. If the gallery save failed (no
  // sharePath) we fall back to the campaign root so the LinkedIn button still
  // works — it just won't preview the user's specific card.
  const shareUrl = (sharePath && shareOrigin)
    ? shareOrigin + sharePath
    : "https://tarot.vonpeach.com";

  // CID-attached inline image. Previously the email HTML embedded the
  // ~700KB-1MB image as a data: URL inside <img src="data:...">, which:
  //   1. Doubled the email size (image once inline + once attached) so
  //      Gmail / Outlook frequently CLIPPED the email past their
  //      102KB / ~150KB visible-content limit. Outlook mobile in
  //      particular showed only the brand header + "view full message"
  //      link — see screenshot from event prep.
  //   2. Forced the recipient's client to base64-decode a huge string
  //      to render the inline image, which Outlook handles slowly.
  // Resend supports `content_id` on attachments — the same JPEG bytes
  // serve BOTH the inline <img src="cid:..."> AND the downloadable
  // attachment. Email size drops to ~few-KB HTML + 1 image attachment.
  const cid = `vonpeach-card-${archetype}`;
  const payload = {
    from,
    to: [email],
    subject: `Your Von Peach photo — ${name}`,
    html: emailHtml(name, tagline, paragraphs, `cid:${cid}`, shareUrl),
    text: emailText(name, tagline, paragraphs, shareUrl),
    attachments: [
      {
        filename: `von-peach-${archetype}.jpg`,
        content: attachmentB64,
        content_id: cid,
      },
    ],
    tags: [
      { name: "campaign", value: "filter-for-the-phone" },
      { name: "archetype", value: archetype },
    ],
  };

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`resend_upstream:${res.status}:${detail}`);
  }

  const data = await res.json();

  // Pipe the contact into Mailchimp. Awaited so the work completes within
  // ctx.waitUntil() bounds; the helper swallows its own errors so this
  // can never throw past the email send that already succeeded.
  await addToMailchimp(env, email, archetype);

  // Slack ping — same best-effort pattern as Mailchimp. Posts a small
  // notification card to the #vonpeach-cards channel (or wherever the
  // SLACK_WEBHOOK_URL points) with the new contact + a link to their
  // portrait. Silent if the secret isn't configured.
  await pingSlack(env, { email, archetype, archetypeName: name, sharePath, shareOrigin });

  return data;
}

// ---------- helpers ----------
function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Read JSON or multipart/form-data into a uniform { email, archetype,
// archetypeName, image, face } object. multipart is the preferred form for
// the /portrait-email upload because it skips the CORS preflight that some
// mobile Safari builds were silently failing after.
async function readMixedBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await request.formData();
    // Coerces either a File field (binary upload) or a string field (data URL)
    // into a data URL string so the rest of the pipeline doesn't care which.
    const readImageField = async (name) => {
      const field = fd.get(name);
      if (!field) return null;
      if (typeof field === "string") return field;
      const buf = await field.arrayBuffer();
      const mime = field.type || "image/jpeg";
      return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
    };
    const [image, face] = await Promise.all([
      readImageField("image"),
      readImageField("face"),
    ]);
    return {
      email:         fd.get("email") || null,
      archetype:     fd.get("archetype") || null,
      archetypeName: fd.get("archetypeName") || null,
      image,
      face,
    };
  }
  return (await request.json()) || {};
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function jsonResp(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...extraHeaders, "Content-Type": "application/json" },
  });
}

// ---------- ADMIN PORTRAIT GALLERY ----------
// Every successful generation is mirrored to a private R2 bucket. The
// /gallery route renders an HTML grid (passcode-gated via ?key=…) so the
// team can curate / pick favourites without exposing the bucket publicly.

// Writes a single portrait to R2 with archetype + timestamp metadata.
// Best-effort: returns silently if PORTRAITS binding isn't configured or
// the put fails — the user's portrait still gets returned/emailed.
async function saveToGallery(env, archetype, imageDataUrl) {
  if (!env.PORTRAITS) return null;
  try {
    const b64 = String(imageDataUrl).split(",").pop();
    const bytes = base64ToUint8Array(b64);
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const id = `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = `${yyyy}/${mm}/${dd}/${archetype}-${id}.jpg`;
    await env.PORTRAITS.put(key, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: {
        archetype,
        ts: String(now.getTime()),
        iso: now.toISOString(),
        // "false" = raw AI image with gibberish bottom-pill text. The wall
        // filters these out so the gibberish never shows. The client will
        // call /portrait-image/<key>/frame within ~1-2s with the framed
        // shareCanvas (brand pill on top of the gibberish), and that
        // handler flips this flag to "true" — tile then becomes visible
        // on the wall on the next 5s poll. Legacy portraits without this
        // flag are treated as framed (see handleGalleryJson) so we don't
        // hide pre-existing tiles.
        framed: "false",
      },
    });
    // Returned so callers (handlePortrait, handlePortraitEmail) can build a
    // per-portrait share URL (/p/<key>) that LinkedIn etc. preview with the
    // user's actual card as the OG image, instead of a generic site preview.
    return key;
  } catch (err) {
    console.warn("gallery save failed:", err?.message);
    return null;
  }
}

// GET /gallery?key=<GALLERY_KEY>
//   Lists the most recent portraits as an HTML grid. Passcode-gated.
async function handleGallery(_request, env, url) {
  if (!env.GALLERY_KEY) return new Response("Gallery key not configured.", { status: 500 });
  const key = url.searchParams.get("key") || "";
  if (key !== env.GALLERY_KEY) return new Response("Forbidden.", { status: 403 });
  if (!env.PORTRAITS) return new Response("R2 bucket not bound.", { status: 500 });

  // Optional archetype filter
  const archetypeFilter = url.searchParams.get("archetype");

  const list = await env.PORTRAITS.list({ limit: 200 });
  let items = list.objects || [];
  items.sort((a, b) => (b.uploaded?.getTime?.() || 0) - (a.uploaded?.getTime?.() || 0));

  // Enrich with custom metadata
  const enriched = await Promise.all(items.map(async (obj) => {
    const head = await env.PORTRAITS.head(obj.key);
    const meta = head?.customMetadata || {};
    return {
      key: obj.key,
      archetype: meta.archetype || "—",
      ts: meta.ts ? Number(meta.ts) : (obj.uploaded?.getTime?.() || 0),
      iso: meta.iso || obj.uploaded?.toISOString?.() || "",
      size: obj.size,
    };
  }));

  const filtered = archetypeFilter
    ? enriched.filter((x) => x.archetype === archetypeFilter)
    : enriched;

  const html = renderGalleryHtml(filtered, key, archetypeFilter, enriched.length);
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// GET /portrait-image/<key>
//   Streams the underlying JPEG from R2. PUBLIC — used by both the gated
//   admin /gallery view AND the public /wall view. The portrait keys
//   themselves aren't trivially guessable (timestamp + random id), and
//   the wall publishes the full list anyway, so gating individual images
//   would only block the wall from rendering its own tiles.
async function handlePortraitImage(_request, env, url) {
  if (!env.PORTRAITS) return new Response("R2 bucket not bound.", { status: 500 });

  // pathname is /portrait-image/<key>
  const objectKey = decodeURIComponent(url.pathname.slice("/portrait-image/".length));
  if (!objectKey) return new Response("Bad request.", { status: 400 });

  const obj = await env.PORTRAITS.get(objectKey);
  if (!obj) return new Response("Not found.", { status: 404 });

  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      // Short cache so the wall picks up the framed-version replace within
      // ~1 minute even when the browser/CDN has the raw image cached. Was
      // 300s (5min) which left gibberish-pilled raw images visible for too
      // long after handlePortraitFrame had already overwritten R2.
      "Cache-Control": "public, max-age=60, must-revalidate",
    },
  });
}

// GET /p/<key>
//   Public per-portrait share page. The "/p/" prefix is shorter than the
//   underlying R2 key for nicer link previews (and so we can change the
//   page's HTML/UX without changing the underlying storage layout).
//
//   The page exists for two distinct purposes:
//
//     1. OG-preview target for link unfurlers. When a user shares the page
//        URL to LinkedIn / Slack / iMessage / wherever, the unfurler scrapes
//        these <meta property="og:image"> + og:title tags and renders the
//        user's actual card as the preview thumbnail. Without this page,
//        LinkedIn would just show a generic tarot.vonpeach.com preview.
//
//     2. Landing page with explicit clickable share options when someone
//        opens the link directly. The email's "Open Your Share Page" button
//        takes the recipient here, where they can pick: Share on LinkedIn,
//        Copy link, Download image, native Share (mobile Web Share API),
//        or Take another (back to the campaign root).
//
//   The R2 object's key is opaque (timestamp + random id) so the URLs aren't
//   trivially enumerable. They're not strictly secret either — anyone with
//   the link can view the card — but that matches the share-by-link intent.
async function handlePortraitShare(_request, env, url) {
  if (!env.PORTRAITS) return new Response("R2 bucket not bound.", { status: 500 });

  const objectKey = decodeURIComponent(url.pathname.slice("/p/".length));
  if (!objectKey) return new Response("Bad request.", { status: 400 });

  // HEAD instead of GET so we don't pull the JPEG bytes into the worker —
  // just verifying existence + reading custom metadata to label the page.
  const head = await env.PORTRAITS.head(objectKey);
  if (!head) {
    return new Response(renderShareNotFoundHtml(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const meta = head.customMetadata || {};
  const archetypeKey = meta.archetype || "";
  const read = READS[archetypeKey] || {};
  const archetypeName = read.name || "Your Von Peach archetype";
  const tagline = read.tagline || "";

  const imageUrl = url.origin + "/portrait-image/" + encodeURIComponent(objectKey);
  const pageUrl = url.origin + "/p/" + encodeURIComponent(objectKey);
  const downloadName = `von-peach-${archetypeKey || "card"}.jpg`;

  const html = renderSharePageHtml({
    archetypeName,
    tagline,
    imageUrl,
    pageUrl,
    downloadName,
  });
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short cache so LinkedIn's scraper can refresh the OG preview if we
      // tune the meta tags, but long enough that hot shares don't hammer R2.
      // Short cache so the wall picks up the framed-version replace within
      // ~1 minute even when the browser/CDN has the raw image cached. Was
      // 300s (5min) which left gibberish-pilled raw images visible for too
      // long after handlePortraitFrame had already overwritten R2.
      "Cache-Control": "public, max-age=60, must-revalidate",
    },
  });
}

// HTML fallback for /p/<key> when the key doesn't resolve in R2 — most
// likely the portrait was deleted from the gallery after the link was sent.
function renderShareNotFoundHtml() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Card not found — Von Peach</title>
<link rel="icon" type="image/svg+xml" href="https://tarot.vonpeach.com/favicon.svg" />
<link rel="alternate icon" type="image/png" href="https://tarot.vonpeach.com/favicon.png" />
<link rel="apple-touch-icon" href="https://tarot.vonpeach.com/favicon.png" />
<style>
  body { margin:0; background:#0d0308; color:#FFE9D6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:32px; text-align:center; }
  h1 { font-size:24px; margin:0 0 12px 0; color:#FD8839; }
  p { font-size:15px; margin:0 0 24px 0; opacity:0.75; max-width:340px; }
  a { display:inline-block; background:linear-gradient(135deg,#FD8839 0%,#CC1C0E 60%,#99112F 100%); color:#fff; text-decoration:none; padding:12px 26px; border-radius:999px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; font-size:12px; }
</style></head>
<body>
  <div>
    <h1>Card not found</h1>
    <p>This share link expired or was removed. Take the test to mint a new one.</p>
    <a href="https://tarot.vonpeach.com">Start your card →</a>
  </div>
</body></html>`;
}

// Build the per-portrait share page. The HTML has two layers:
//   - SEO/OG meta (head) — for link unfurlers (LinkedIn, Slack, Messages…)
//   - On-page UI (body) — for human visitors landing on the page directly
function renderSharePageHtml({ archetypeName, tagline, imageUrl, pageUrl, downloadName }) {
  const title = `I'm ${archetypeName} — my Von Peach archetype`;
  const description = tagline
    ? `${tagline} — discover your own at tarot.vonpeach.com`
    : "Discover your own Game Changer archetype at tarot.vonpeach.com";
  const linkedInUrl = buildLinkedInShareUrl(pageUrl);

  // Escape for embedding inside HTML attributes / text nodes / JS strings.
  // Defensive — the inputs are server-controlled but the page renders user-
  // adjacent strings (archetype name) so we keep the discipline.
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const jsStr = (s) => JSON.stringify(String(s));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />

  <!-- Open Graph — LinkedIn, Slack, iMessage, Discord all consume this. -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Von Peach" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(imageUrl)}" />
  <meta property="og:image:width" content="1024" />
  <meta property="og:image:height" content="1820" />
  <meta property="og:url" content="${esc(pageUrl)}" />

  <!-- Twitter / X — separate tag set; "summary_large_image" gives a big card. -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(imageUrl)}" />

  <link rel="icon" type="image/svg+xml" href="https://tarot.vonpeach.com/favicon.svg" />
  <link rel="alternate icon" type="image/png" href="https://tarot.vonpeach.com/favicon.png" />
  <link rel="apple-touch-icon" href="https://tarot.vonpeach.com/favicon.png" />

  <style>
    :root {
      --peach: #FFD6BB;
      --peach-soft: #FFE9D6;
      --wine: #99112F;
      --red: #CC1C0E;
      --orange: #FD8839;
      --ink: #3a0812;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background:
        radial-gradient(80% 60% at 50% 0%, rgba(253,136,57,0.18) 0%, transparent 60%),
        radial-gradient(70% 50% at 50% 100%, rgba(153,17,47,0.22) 0%, transparent 60%),
        #0d0308;
      color: var(--peach-soft);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 32px 20px 56px 20px;
      gap: 24px;
    }
    .share-page {
      width: 100%;
      max-width: 460px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 22px;
    }
    .brand {
      font-family: "Georgia", "Times New Roman", serif;
      letter-spacing: 0.32em;
      font-size: 11px;
      text-transform: uppercase;
      color: rgba(255,233,214,0.7);
      margin: 0;
    }
    .card-frame {
      position: relative;
      width: 100%;
      max-width: 360px;
      border-radius: 18px;
      overflow: hidden;
      box-shadow:
        0 24px 56px rgba(0,0,0,0.55),
        0 0 0 1px rgba(255,214,187,0.16) inset;
      background: rgba(255,233,214,0.04);
    }
    .card-frame img {
      display: block;
      width: 100%;
      height: auto;
    }
    /* Brand pill — overlays the bottom of the AI image to cover the
       AI-generated tarot label (Kontext tends to write garbled text there
       like "TENNIA DAI CESH" / "THE STAIUCTUE" for archetype names it
       doesn't know). Same trick the live result screen uses. The pill sits
       INSIDE the AI's tarot frame area, not below it. */
    .card-pill {
      position: absolute;
      left: 5%;
      right: 5%;
      /* Sit just above the AI's own card border so we cover the AI's text
         strip but don't bleed onto the cream border below it. Heuristic
         tuned against real Kontext output where the AI text label occupies
         roughly the bottom 8-10% of the inner image. */
      bottom: 2%;
      padding: 16px 14px;
      background: linear-gradient(180deg, #FFE4CB 0%, #FFD0A9 100%);
      color: #3a0812;
      font-family: "Georgia", "Times New Roman", serif;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      text-align: center;
      border-radius: 6px;
      box-shadow: 0 3px 8px rgba(58,8,18,0.22), 0 0 0 1px rgba(58,8,18,0.14) inset;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @media (max-width: 380px) {
      .card-pill { font-size: 13px; padding: 12px 10px; letter-spacing: 0.14em; }
    }
    .meta {
      text-align: center;
    }
    .meta h1 {
      font-family: "Georgia", "Times New Roman", serif;
      font-size: 26px;
      letter-spacing: 0.02em;
      margin: 0 0 6px 0;
      color: var(--peach);
      font-weight: 700;
    }
    .meta p {
      margin: 0;
      font-size: 13px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--orange);
    }

    /* Action options — these are the "click on the options" UI. Primary
       LinkedIn button is the loudest, secondaries sit in a row below.    */
    .actions {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .btn {
      appearance: none;
      border: 0;
      cursor: pointer;
      font: inherit;
      width: 100%;
      padding: 14px 22px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 13px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      text-decoration: none;
      text-align: center;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
    }
    .btn:active { transform: translateY(1px); }
    .btn-primary {
      background: linear-gradient(135deg, var(--orange) 0%, var(--red) 60%, var(--wine) 100%);
      color: #fff;
      box-shadow: 0 12px 28px rgba(204,28,14,0.35);
    }
    .btn-primary:hover { box-shadow: 0 14px 32px rgba(204,28,14,0.45); }
    .secondary-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .btn-secondary {
      background: rgba(255,214,187,0.10);
      color: var(--peach);
      border: 1px solid rgba(255,214,187,0.25);
      backdrop-filter: blur(8px);
    }
    .btn-secondary:hover { background: rgba(255,214,187,0.16); }
    .btn-ghost {
      background: transparent;
      color: rgba(255,233,214,0.7);
      letter-spacing: 0.18em;
      font-size: 11px;
      padding: 10px 18px;
    }
    .btn-ghost:hover { color: var(--peach); }
    .btn svg { width: 16px; height: 16px; flex-shrink: 0; }

    /* Toast — shown after Copy link succeeds. */
    .toast {
      position: fixed;
      left: 50%;
      bottom: 32px;
      transform: translateX(-50%) translateY(10px);
      background: rgba(13,3,8,0.92);
      color: var(--peach);
      border: 1px solid rgba(255,214,187,0.25);
      padding: 12px 20px;
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 700;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    .footer {
      margin-top: 12px;
      text-align: center;
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(255,233,214,0.5);
    }
    .footer a { color: var(--orange); text-decoration: none; }

    @media (max-width: 380px) {
      .meta h1 { font-size: 22px; }
      .secondary-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="share-page">
    <p class="brand">Von Peach · Game Changer Card</p>

    <div class="card-frame">
      <img src="${esc(imageUrl)}" alt="${esc(archetypeName)} — Von Peach card" />
      <!-- Cover the AI's bottom auto-text with the actual archetype name -->
      <div class="card-pill" aria-hidden="true">${esc(archetypeName)}</div>
    </div>

    <div class="meta">
      <h1>${esc(archetypeName)}</h1>
      ${tagline ? `<p>${esc(tagline)}</p>` : ""}
    </div>

    <div class="actions">
      <!-- Primary LinkedIn share — opens LinkedIn's share dialog with this
           page URL pre-filled. LinkedIn scrapes the OG meta above and shows
           the card image as the preview thumbnail. -->
      <a class="btn btn-primary" href="${esc(linkedInUrl)}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/></svg>
        Share on LinkedIn
      </a>

      <!-- Native share — only renders on browsers that support Web Share API
           (iOS Safari, Android Chrome, modern desktop Chrome+macOS). The
           button is hidden via JS if navigator.share is missing so desktop
           users on older browsers don't see a no-op control. -->
      <button class="btn btn-primary" id="btnNativeShare" hidden>
        <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7 0-.24-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
        Share via…
      </button>

      <div class="secondary-row">
        <button class="btn btn-secondary" id="btnCopyLink">
          <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
          Copy link
        </button>
        <a class="btn btn-secondary" id="btnDownload" href="${esc(imageUrl)}" download="${esc(downloadName)}">
          <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          Save image
        </a>
      </div>

      <a class="btn btn-ghost" href="https://tarot.vonpeach.com">
        ← Take another card
      </a>
    </div>

    <div class="footer">
      <a href="https://vonpeach.com">vonpeach.com</a>
    </div>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite">Link copied</div>

  <script>
    (function () {
      var PAGE_URL = ${jsStr(pageUrl)};
      var TITLE    = ${jsStr(title)};
      var TEXT     = ${jsStr(description)};

      var toast = document.getElementById("toast");
      function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add("show");
        clearTimeout(showToast._t);
        showToast._t = setTimeout(function () { toast.classList.remove("show"); }, 1800);
      }

      // Copy link → clipboard. Modern API first, fallback to a hidden input
      // for browsers without it (legacy Safari, some embedded webviews).
      document.getElementById("btnCopyLink").addEventListener("click", function () {
        var ok = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(PAGE_URL).then(function () {
            showToast("Link copied");
          }).catch(function () {
            fallbackCopy();
          });
        } else {
          fallbackCopy();
        }
        function fallbackCopy() {
          try {
            var inp = document.createElement("input");
            inp.value = PAGE_URL;
            document.body.appendChild(inp);
            inp.select();
            ok = document.execCommand("copy");
            document.body.removeChild(inp);
          } catch (e) {}
          showToast(ok ? "Link copied" : "Copy failed — long-press the link");
        }
      });

      // Native share (Web Share API) — only show the button if the browser
      // actually supports it. iOS Safari + Android Chrome will surface the
      // OS-level share sheet (with Instagram / WhatsApp / Mail / etc).
      if (navigator.share) {
        var btn = document.getElementById("btnNativeShare");
        btn.hidden = false;
        btn.addEventListener("click", function () {
          navigator.share({ title: TITLE, text: TEXT, url: PAGE_URL })
            .catch(function () { /* user dismissed share sheet — fine */ });
        });
      }
    })();
  </script>
</body>
</html>`;
}

// DELETE /portrait-image/<key>?key=<GALLERY_KEY>
//   Removes a portrait from the R2 bucket. Passcode-gated — only the admin
//   /gallery view exposes the UI, but the endpoint can also be hit via curl
//   for bulk-cleanup scripts.
//
// POST /portrait-image/<key>/frame
//   Replace the R2 portrait bytes with the client-rendered framed version.
//   The client passes the shareCanvas JPEG (with brand pill + sigil
//   overlay drawn on top of the AI portrait) and we overwrite R2[<key>]
//   with those bytes, preserving the original customMetadata so the
//   gallery/wall enrichment still works.
//
//   This is the fix for the AI's auto-generated bottom-pill gibberish
//   leaking into every surface that streams the R2 JPEG: the live /wall
//   tiles, the /gallery admin grid, AND — critically — the LinkedIn OG
//   preview thumbnail (which fetches /portrait-image/<key> directly and
//   can't be CSS-overlaid). Once the framed bytes are in R2, every
//   downstream surface sees a clean Von Peach-pilled card.
//
//   Unauthed. The key isn't trivially enumerable (timestamp + random
//   suffix) and a malicious replacement is bounded — you can only
//   overwrite a portrait if you already know its key, and the gallery
//   already serves the same key publicly. Worst-case: someone replaces
//   a stranger's portrait with another JPEG. Acceptable for the event-
//   ephemera use case; tighten with an HMAC token if it becomes a problem.
async function handlePortraitFrame(request, env, url, cors) {
  if (!env.PORTRAITS) return jsonResp({ error: "no_r2" }, 500, cors);
  // pathname = /portrait-image/<encodedKey>/frame
  const p = url.pathname;
  const inner = p.slice("/portrait-image/".length, p.length - "/frame".length);
  const objectKey = decodeURIComponent(inner);
  if (!objectKey) return jsonResp({ error: "bad_key" }, 400, cors);

  try {
    // HEAD the existing object so we can (a) confirm it exists and (b)
    // preserve its customMetadata (archetype/ts/iso) across the replace.
    const head = await env.PORTRAITS.head(objectKey);
    if (!head) return jsonResp({ error: "not_found" }, 404, cors);

    const body = await request.json();
    if (!body?.image) return jsonResp({ error: "no_image" }, 400, cors);

    const b64 = String(body.image).split(",").pop();
    const bytes = base64ToUint8Array(b64);
    // Preserve original customMetadata, but flip `framed` → "true" so the
    // wall stops hiding this tile. saveToGallery wrote "false" on the
    // initial raw save; once the framed bytes land here, the tile is
    // safe to show on every public surface (wall, gallery, OG preview).
    const meta = { ...(head.customMetadata || {}), framed: "true" };
    await env.PORTRAITS.put(objectKey, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: meta,
    });
    console.log(`[frame] replaced ${objectKey} with framed bytes (${bytes.length}b)`);
    return jsonResp({ ok: true, size: bytes.length }, 200, cors);
  } catch (err) {
    console.warn(`[frame] replace failed for ${objectKey}: ${err?.message}`);
    return jsonResp({ error: "frame_failed", message: err?.message }, 500, cors);
  }
}

// Used by the per-tile "×" button on the admin gallery to clear out test
// renders / unwanted portraits before an event. The corresponding tile is
// removed from the wall on its next 5-second poll automatically.
async function handlePortraitDelete(_request, env, url, cors) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  if (!env.GALLERY_KEY) return new Response(JSON.stringify({ error: "no_key_config" }), { status: 500, headers: jsonHeaders });
  const auth = url.searchParams.get("key") || "";
  if (auth !== env.GALLERY_KEY) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: jsonHeaders });
  if (!env.PORTRAITS) return new Response(JSON.stringify({ error: "no_r2" }), { status: 500, headers: jsonHeaders });

  const objectKey = decodeURIComponent(url.pathname.slice("/portrait-image/".length));
  if (!objectKey) return new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers: jsonHeaders });

  try {
    await env.PORTRAITS.delete(objectKey);
    console.log(`[gallery] deleted ${objectKey}`);
    return new Response(JSON.stringify({ ok: true, key: objectKey }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    console.warn(`[gallery] delete failed for ${objectKey}: ${err?.message}`);
    return new Response(JSON.stringify({ error: "delete_failed", message: err?.message }), { status: 500, headers: jsonHeaders });
  }
}

// DELETE /gallery/before?key=<GALLERY_KEY>&ts=<unix-ms>
//   Bulk-deletes every portrait whose upload timestamp is < the ts cutoff.
//   Used by the admin /gallery's "Cleanup older" panel to clear test renders
//   in one shot rather than clicking the × on each tile.
//
//   Notes:
//     - Uses obj.uploaded.getTime() from the list call rather than head()ing
//       each object — much faster (no per-object round-trip). The customMetadata
//       ts and obj.uploaded are within milliseconds of each other anyway since
//       saveToGallery puts them at the same moment.
//     - Skips "gallery-stats.json" (the scan counter file) so we don't nuke it
//       by accident on a wide cutoff.
//     - Uses R2's bulk delete (passes an array of keys to env.PORTRAITS.delete).
//       R2 bulk delete supports up to 1000 keys per call; we chunk for safety.
async function handleGalleryBulkDelete(_request, env, url, cors) {
  const jsonHeaders = { ...cors, "Content-Type": "application/json" };
  if (!env.GALLERY_KEY) return new Response(JSON.stringify({ error: "no_key_config" }), { status: 500, headers: jsonHeaders });
  const auth = url.searchParams.get("key") || "";
  if (auth !== env.GALLERY_KEY) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: jsonHeaders });
  if (!env.PORTRAITS) return new Response(JSON.stringify({ error: "no_r2" }), { status: 500, headers: jsonHeaders });

  const ts = Number(url.searchParams.get("ts"));
  if (!Number.isFinite(ts) || ts <= 0) {
    return new Response(JSON.stringify({ error: "bad_ts", message: "ts must be a positive unix-ms number" }), { status: 400, headers: jsonHeaders });
  }

  // Walk the bucket (paginated) and collect candidate keys.
  const toDelete = [];
  let cursor;
  do {
    const list = await env.PORTRAITS.list({ limit: 1000, cursor });
    cursor = list.truncated ? list.cursor : undefined;
    for (const obj of (list.objects || [])) {
      if (obj.key === "gallery-stats.json") continue;
      const objTs = obj.uploaded?.getTime?.() || 0;
      if (objTs < ts) toDelete.push(obj.key);
    }
  } while (cursor);

  // Bulk-delete in chunks of 1000 (R2's per-call limit).
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 1000) {
    const chunk = toDelete.slice(i, i + 1000);
    try {
      await env.PORTRAITS.delete(chunk);
      deleted += chunk.length;
    } catch (err) {
      console.warn(`[gallery-bulk] chunk delete failed at offset ${i}: ${err?.message}`);
    }
  }

  console.log(`[gallery-bulk] deleted ${deleted}/${toDelete.length} portraits before ts=${ts} (${new Date(ts).toISOString()})`);
  return new Response(JSON.stringify({ ok: true, deleted, candidates: toDelete.length, cutoffMs: ts }), { status: 200, headers: jsonHeaders });
}

// GET /scan — the QR-code target. Counts the scan (best-effort) then
// 302-redirects to the live site with ?src=wall so any further analytics
// can distinguish QR-sourced traffic. Public — no auth.
//
// Counter is kept in a single small R2 object "gallery-stats.json" — a
// read-modify-write loop. Race conditions in a busy event can lose the
// occasional count, which is acceptable for an event-display counter.
// View the count at /stats?key=<GALLERY_KEY>.
async function handleScan(_request, env) {
  if (env.PORTRAITS) {
    try {
      const existing = await env.PORTRAITS.get("gallery-stats.json");
      let stats = { scans: 0 };
      if (existing) {
        try { stats = JSON.parse(await existing.text()) || stats; } catch { /* corrupt -> reset */ }
      }
      stats.scans = (Number(stats.scans) || 0) + 1;
      stats.lastScanIso = new Date().toISOString();
      stats.lastScanTs = Date.now();
      await env.PORTRAITS.put("gallery-stats.json", JSON.stringify(stats), {
        httpMetadata: { contentType: "application/json" },
      });
      console.log(`[scan] count=${stats.scans} ts=${stats.lastScanIso}`);
    } catch (err) {
      console.warn(`[scan] counter update failed: ${err?.message}`);
    }
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "https://tarot.vonpeach.com/?src=wall",
      "Cache-Control": "no-store",
    },
  });
}

// GET /stats?key=<GALLERY_KEY> — JSON {scans, lastScanIso, lastScanTs}.
// Passcode-gated. Used by the admin /gallery header to display a live
// scan counter alongside the portrait total.
async function handleStats(_request, env, url) {
  const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-cache" };
  if (!env.GALLERY_KEY) return new Response(JSON.stringify({ error: "no_key_config" }), { status: 500, headers: jsonHeaders });
  const key = url.searchParams.get("key") || "";
  if (key !== env.GALLERY_KEY) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: jsonHeaders });
  if (!env.PORTRAITS) return new Response(JSON.stringify({ error: "no_r2" }), { status: 500, headers: jsonHeaders });

  const obj = await env.PORTRAITS.get("gallery-stats.json");
  let stats = { scans: 0 };
  if (obj) {
    try { stats = JSON.parse(await obj.text()) || stats; } catch { /* corrupt */ }
  }
  return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeaders });
}

// ---------- LIVE EVENT WALL ----------
// Designed for projection / TV display during an in-person event. Big-tile
// auto-refreshing grid; new portraits "pop" in at the top of the wall with
// a "NEW" badge for 30 seconds, older portraits flow down.
//
// Two endpoints — both PUBLIC, no passcode required:
//   GET /wall[?window=today|hour|all]
//       Returns the HTML page. The page polls /gallery.json every 5s.
//   GET /gallery.json[?window=today|hour|all]
//       Returns the current list of portrait items (most recent first)
//       as JSON. Cheap; used by the wall's polling loop.
//
// Admin curation lives on /gallery which IS still GALLERY_KEY-gated.
//
// The wall is PUBLIC — no passcode required, so anyone with the URL can pull
// it up on a phone / projector during the event. Admin curation stays on
// /gallery which is still gated by GALLERY_KEY.
async function handleWall(_request, env, url) {
  if (!env.PORTRAITS) return new Response("R2 bucket not bound.", { status: 500 });

  // Default: last 7 days rolling so attendees can find their card all
  // week. Pass ?window=48h for the shorter event-night view (the previous
  // default), ?window=today for strict same-day, or ?window=all for
  // everything ever rendered.
  const win = url.searchParams.get("window") || "week";
  const html = renderWallHtml(win);
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

// PUBLIC polling endpoint used by the wall. Returns the list of portrait
// keys + metadata as JSON, filtered by the time window. No auth — admin
// curation lives on /gallery which is still gated.
async function handleGalleryJson(_request, env, url) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache" };
  if (!env.PORTRAITS) return new Response(JSON.stringify({ error: "no_r2" }), { status: 500, headers });

  // Default: last 7 days rolling so attendees can find their card all
  // week. Pass ?window=48h for the shorter event-night view (the previous
  // default), ?window=today for strict same-day, or ?window=all for
  // everything ever rendered.
  const win = url.searchParams.get("window") || "week";
  const cutoffMs = computeCutoffMs(win);

  // List up to 1000 objects from the bucket. R2 list orders
  // alphabetically by key, and our key scheme is YYYY/MM/DD/archetype-ts-id
  // — so chronological-ish but not perfect, so we sort by metadata.ts below.
  // Bumped from 500 → 1000 to comfortably cover a week of event activity
  // (~50 portraits/day × 7 days = 350 typical; 1000 leaves headroom for
  // heavy days without paginating).
  const list = await env.PORTRAITS.list({ limit: 1000 });
  const items = await Promise.all((list.objects || []).map(async (obj) => {
    const head = await env.PORTRAITS.head(obj.key);
    const meta = head?.customMetadata || {};
    const ts = meta.ts ? Number(meta.ts) : (obj.uploaded?.getTime?.() || 0);
    return {
      key: obj.key,
      archetype: meta.archetype || "—",
      ts,
      // "false" → raw AI image with gibberish bottom-pill text; the client
      // hasn't uploaded the framed shareCanvas yet. Wall hides these.
      // Legacy portraits saved BEFORE the framed flag existed have no
      // value here; treat them as framed (they've been visible for a
      // while already, no point hiding them retroactively).
      framed: meta.framed !== "false",
    };
  }));

  // Pass ?showRaw=1 to include unframed tiles (admin debugging) — default
  // hides them so the gibberish bottom-pill never makes it to the wall.
  const showRaw = url.searchParams.get("showRaw") === "1";

  const filtered = items
    .filter((x) => x.ts >= cutoffMs)
    .filter((x) => showRaw || x.framed)
    .sort((a, b) => b.ts - a.ts);

  return new Response(JSON.stringify({ items: filtered, now: Date.now(), window: win }), { status: 200, headers });
}

// Maps the `window` query param to a Unix-ms cutoff. Anything with a
// timestamp >= cutoff is included; everything older is filtered out.
//   "all"    → no cutoff (include everything in the bucket)
//   "today"  → start of today (UTC), 00:00:00.000
//   "hour"   → last 60 minutes
//   "48h"    → last 48 hours rolling (the old default; still selectable)
//   <unknown>→ treated as the new 7-day default
function computeCutoffMs(win) {
  if (win === "all")    return 0;
  if (win === "hour")   return Date.now() - 60 * 60 * 1000;
  if (win === "today")  { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
  if (win === "48h")    return Date.now() - 48 * 60 * 60 * 1000;
  // Default ("week" or anything unknown) — last 7 days rolling. Event
  // portraits stay visible on the wall for a full week so attendees can
  // still find their card in the days after the event. Pass ?window=48h
  // for the shorter event-night view, or ?window=today for strict same-day.
  return Date.now() - 7 * 24 * 60 * 60 * 1000;
}

// Render the live wall HTML. Self-contained: inlines the auth key + window
// config into a small bit of vanilla JS that polls /gallery.json every 5s
// and animates new tiles in. No build step, no external deps beyond the
// JPEGs served by /portrait-image/.
function renderWallHtml(win) {
  const safeWin = JSON.stringify(win);
  // Pretty archetype names — mirrors READS[k].name. Hard-coded so the
  // client doesn't need a second API call to look them up.
  const NAMES = {
    charmer:   "The Charmer",
    magician:  "The Magician",
    alchemist: "The Alchemist",
    oracle:    "The Oracle",
    rebel:     "The Rebel",
    monk:      "The Monk",
    architect: "The Architect",
    luminary:  "The Luminary",
  };

  return `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Von Peach — The Game Changer Gallery</title>
  <link rel="icon" type="image/svg+xml" href="https://tarot.vonpeach.com/favicon.svg" />
  <link rel="alternate icon" type="image/png" href="https://tarot.vonpeach.com/favicon.png" />
  <link rel="apple-touch-icon" href="https://tarot.vonpeach.com/favicon.png" />
  <!-- Public URL but not meant to be indexed; the wall is event-display
       ephemera, not a SEO target. -->
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
  <!-- Brand fonts — same loaders as the static site (Aileron primary,
       General Sans secondary, Playfair Display for serif display moments).
       preconnect first so the actual stylesheet GETs warm up faster. -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preconnect" href="https://api.fontshare.com" crossorigin>
  <link rel="preconnect" href="https://fonts.cdnfonts.com" crossorigin>
  <link href="https://fonts.cdnfonts.com/css/aileron" rel="stylesheet">
  <link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
  <!-- QR generator for the "scan to try" card in the corner. ~5KB, lazy
       loaded; the wall script retries the QR draw if the lib hasn't
       finished loading by first attempt. -->
  <script defer src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
  <style>
    :root {
      --wine:#99112F; --red:#CC1C0E; --orange:#FD8839; --peach:#FFD6BB;
      --bg:#0d0308; --card-bg:#1a0610;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background:
        radial-gradient(60% 50% at 15% 10%, rgba(253,136,57,0.18) 0%, transparent 60%),
        radial-gradient(70% 60% at 95% 100%, rgba(153,17,47,0.30) 0%, transparent 60%),
        var(--bg);
      color: var(--peach);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
    }
    header {
      padding: 24px 48px;
      display: flex; align-items: center; justify-content: space-between; gap: 24px;
      border-bottom: 1px solid rgba(255,214,187,0.10);
      background: linear-gradient(180deg, rgba(13,3,8,0.92), rgba(13,3,8,0.72));
      position: sticky; top: 0; z-index: 10;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      flex-wrap: wrap;
    }
    .header-left { display: flex; align-items: center; gap: 22px; min-width: 0; }
    /* Von Peach logo — same CSS-mask trick as the admin /gallery so we
       don't ship a separate tinted PNG. */
    .brand-logo {
      display: block;
      width: 200px; height: 44px;
      background-color: var(--peach);
      -webkit-mask: url('https://tarot.vonpeach.com/vonpeach-logo.png') no-repeat left center / contain;
              mask: url('https://tarot.vonpeach.com/vonpeach-logo.png') no-repeat left center / contain;
      flex-shrink: 0;
    }
    h1 {
      margin: 0;
      font-size: 26px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: linear-gradient(135deg, var(--orange) 0%, var(--red) 55%, var(--wine) 100%);
      -webkit-background-clip: text;
              background-clip: text;
      -webkit-text-fill-color: transparent;
      line-height: 1.1;
    }
    .meta {
      font-size: 14px;
      color: rgba(255,214,187,0.55);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 700;
      display: flex; gap: 22px; align-items: center;
    }
    .meta .count {
      color: var(--peach);
      background: rgba(255,214,187,0.10);
      border: 1px solid rgba(255,214,187,0.18);
      padding: 6px 14px;
      border-radius: 999px;
    }
    .wall {
      padding: 28px 40px 80px;
      display: grid;
      gap: 22px;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    }
    .tile {
      position: relative;
      background: var(--card-bg);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 14px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,214,187,0.06);
      aspect-ratio: 3 / 4;
      animation: tile-in 720ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .tile img {
      display: block;
      width: 100%; height: 100%;
      object-fit: cover;
    }
    /* Bottom-of-tile fade — hides any gibberish text/labels the AI tries
       to draw at the bottom of the image. Fades the bottom strip into the
       card background so the brand pill sits on a clean gradient. */
    .tile .tile-fade {
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 18%;
      background: linear-gradient(to top, var(--card-bg) 0%, var(--card-bg) 45%, rgba(26,6,16,0) 100%);
      pointer-events: none;
      z-index: 1;
    }
    .tile .pill {
      position: absolute;
      bottom: 18px; left: 50%;
      transform: translateX(-50%);
      background: var(--peach);
      color: var(--wine);
      font-family: Georgia, "Times New Roman", serif;
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      padding: 8px 18px;
      border-radius: 999px;
      white-space: nowrap;
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      z-index: 2;
    }
    .tile.new::before {
      content: "JUST IN";
      position: absolute;
      top: 14px; right: 14px;
      background: linear-gradient(135deg, var(--orange), var(--red), var(--wine));
      color: #fff;
      font-size: 11px;
      letter-spacing: 0.20em;
      text-transform: uppercase;
      font-weight: 800;
      padding: 7px 12px;
      border-radius: 999px;
      box-shadow: 0 6px 18px rgba(204,28,14,0.55);
      animation: badge-pulse 1.4s ease-in-out infinite;
      z-index: 2;
    }
    @keyframes tile-in {
      from { opacity: 0; transform: scale(0.85) translateY(28px); }
      to   { opacity: 1; transform: scale(1)    translateY(0); }
    }
    @keyframes badge-pulse {
      0%, 100% { transform: scale(1);    box-shadow: 0 6px 18px rgba(204,28,14,0.55); }
      50%      { transform: scale(1.10); box-shadow: 0 10px 28px rgba(204,28,14,0.85); }
    }
    .empty {
      padding: 120px 40px;
      text-align: center;
      color: rgba(255,214,187,0.55);
      font-size: 22px;
      letter-spacing: 0.10em;
    }
    .empty .blink {
      display: inline-block;
      width: 10px; height: 10px;
      background: var(--orange);
      border-radius: 50%;
      margin: 0 10px -1px 0;
      box-shadow: 0 0 18px rgba(253,136,57,0.7);
      animation: blink 1.4s ease-in-out infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50%      { opacity: 1;    transform: scale(1.10); }
    }
    .err {
      padding: 40px;
      text-align: center;
      color: rgba(255,214,187,0.55);
    }
    /* "Scan to try" QR card — fixed in the bottom-right of the wall on a
       16:9 event screen. Points at /scan which counts the scan in R2 then
       302-redirects to the live site. */
    .qr-card {
      position: fixed;
      bottom: 28px; right: 28px;
      background: var(--peach);
      padding: 22px 22px 16px;
      border-radius: 24px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.15);
      z-index: 5;
      text-align: center;
      max-width: 220px;
    }
    .qr-prize {
      /* Brand serif display — same family used for editorial moments on the
         static site. Georgia stays as a fallback so the wall still renders
         if the font CDN is blocked at an event venue. */
      font-family: "Playfair Display", Georgia, "Times New Roman", serif;
      font-weight: 800;
      font-size: 18px;
      color: var(--wine);
      line-height: 1.15;
      margin-bottom: 14px;
      letter-spacing: 0.01em;
    }
    .qr-prize .accent {
      display: block;
      /* Italic Playfair on the accent line for typographic motion — same
         editorial pattern the brand uses for emphasis. */
      font-style: italic;
      font-weight: 700;
      background: linear-gradient(135deg, var(--orange), var(--red) 60%, var(--wine));
      -webkit-background-clip: text;
              background-clip: text;
      -webkit-text-fill-color: transparent;
      font-size: 24px;
      letter-spacing: 0.02em;
    }
    .qr-frame {
      width: 172px; height: 172px;
      line-height: 0;
      background: #fff;
      border-radius: 10px;
      padding: 6px;
      margin: 0 auto;
    }
    .qr-frame img, .qr-frame svg { width: 100%; height: 100%; display: block; }
    .qr-eyebrow {
      margin-top: 12px;
      color: var(--wine);
      /* Brand sans for eyebrow / caps label — Aileron matches the rest of
         the app's small-caps moments. */
      font-family: "Aileron", "General Sans", -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }

    /* "Fullscreen" toggle for TV / event-display use. Hides the browser
       chrome (URL bar, tabs, OS menu bar) so the wall fills the screen
       edge-to-edge. Lives in the bottom-LEFT corner so it doesn't fight
       the QR card in the bottom-right. Auto-hides once fullscreen is
       active so it never appears on the wall in display mode.
       Keyboard shortcut: F toggles. Esc exits (browser default). */
    .fs-toggle {
      position: fixed;
      bottom: 28px; left: 28px;
      z-index: 5;
      appearance: none;
      border: 0;
      cursor: pointer;
      background: rgba(255, 214, 187, 0.10);
      color: var(--peach);
      border: 1px solid rgba(255, 214, 187, 0.30);
      padding: 10px 16px;
      border-radius: 999px;
      font-family: "Aileron", "General Sans", -apple-system, BlinkMacSystemFont, sans-serif;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      backdrop-filter: blur(8px);
      transition: background 180ms, opacity 240ms, transform 180ms;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .fs-toggle:hover { background: rgba(255, 214, 187, 0.18); }
    .fs-toggle:active { transform: translateY(1px); }
    .fs-toggle svg { width: 14px; height: 14px; flex-shrink: 0; }
    /* While fullscreen, hide the button entirely (it has done its job). */
    :fullscreen .fs-toggle,
    :-webkit-full-screen .fs-toggle { opacity: 0; pointer-events: none; }

    /* ------- Live archetype tally (small strip below the header) ------- */
    .tally {
      padding: 14px 48px 18px;
      display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center;
      border-bottom: 1px solid rgba(255,214,187,0.08);
      font-family: "General Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .tally-chip {
      display: inline-flex; align-items: baseline; gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(255,214,187,0.06);
      border: 1px solid rgba(255,214,187,0.14);
      font-size: 13px; letter-spacing: 0.10em; text-transform: uppercase;
      color: rgba(255,214,187,0.80);
      transition: background 200ms, border-color 200ms, color 200ms, transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .tally-chip strong { color: var(--peach); font-weight: 800; font-size: 14px; letter-spacing: 0; }
    .tally-chip.top {
      background: linear-gradient(135deg, rgba(253,136,57,0.30), rgba(204,28,14,0.20));
      border-color: rgba(253,136,57,0.50);
      color: var(--peach);
    }
    .tally-chip.bumped { animation: chip-bump 600ms ease-out; }
    @keyframes chip-bump {
      0%   { transform: scale(1); }
      40%  { transform: scale(1.18); }
      100% { transform: scale(1); }
    }

    /* ------- Spotlight reveal overlay (new tile takes the whole screen briefly) ------- */
    .spotlight {
      position: fixed; inset: 0;
      display: none;
      align-items: center; justify-content: center;
      z-index: 50;
      background: radial-gradient(60% 50% at 50% 50%, rgba(13,3,8,0.85) 0%, rgba(13,3,8,0.97) 80%);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      animation: spot-fade-in 420ms ease-out;
    }
    .spotlight.visible { display: flex; }
    .spotlight.closing { animation: spot-fade-out 480ms ease-in both; }
    .spotlight-card {
      position: relative;
      width: min(58vh, 60vw);
      aspect-ratio: 3 / 4;
      border-radius: 28px;
      overflow: hidden;
      box-shadow:
        0 0 0 6px rgba(255,214,187,0.18),
        0 0 80px 14px rgba(253,136,57,0.40),
        0 26px 80px rgba(0,0,0,0.7);
      transform: scale(0.6);
      animation: spot-pop 520ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .spotlight-card img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .spotlight-card .spotlight-fade {
      position: absolute; bottom: 0; left: 0; right: 0;
      height: 18%;
      background: linear-gradient(to top, rgba(26,6,16,1) 0%, rgba(26,6,16,1) 40%, rgba(26,6,16,0) 100%);
      pointer-events: none;
    }
    .spotlight-card .spotlight-pill {
      position: absolute; bottom: 28px; left: 50%;
      transform: translateX(-50%);
      background: var(--peach);
      color: var(--wine);
      font-family: Georgia, "Times New Roman", serif;
      font-weight: 700;
      font-size: 18px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      padding: 12px 28px;
      border-radius: 999px;
      white-space: nowrap;
      box-shadow: 0 10px 28px rgba(0,0,0,0.45);
    }
    .spotlight-eyebrow {
      position: absolute; top: 10vh; left: 50%;
      transform: translateX(-50%);
      font-family: "Aileron", "General Sans", sans-serif;
      font-weight: 900;
      font-size: 16px;
      letter-spacing: 0.40em;
      text-transform: uppercase;
      background: linear-gradient(135deg, var(--orange), var(--red), var(--wine));
      -webkit-background-clip: text;
              background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    @keyframes spot-fade-in  { from { opacity: 0; } to { opacity: 1; } }
    @keyframes spot-fade-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes spot-pop {
      0%   { transform: scale(0.6) translateY(40px); opacity: 0; }
      55%  { transform: scale(1.05); opacity: 1; }
      100% { transform: scale(1)   translateY(0);  opacity: 1; }
    }

    /* ------- Milestone celebration (confetti banner at round-number counts) ------- */
    .milestone {
      position: fixed;
      top: 16vh; left: 50%;
      transform: translateX(-50%);
      z-index: 60;
      display: none;
      flex-direction: column;
      align-items: center; text-align: center;
      pointer-events: none;
    }
    .milestone.visible { display: flex; animation: milestone-in 500ms cubic-bezier(0.16, 1, 0.3, 1); }
    .milestone.closing { animation: milestone-out 600ms ease-in both; }
    .milestone-eyebrow {
      font-family: "Aileron", "General Sans", sans-serif;
      font-weight: 900;
      font-size: 16px;
      letter-spacing: 0.40em;
      text-transform: uppercase;
      color: var(--peach);
      opacity: 0.78;
    }
    .milestone-count {
      font-family: "Aileron", "General Sans", sans-serif;
      font-weight: 900;
      font-size: clamp(72px, 12vw, 168px);
      line-height: 1;
      margin-top: 6px;
      background: linear-gradient(135deg, var(--orange), var(--red), var(--wine));
      -webkit-background-clip: text;
              background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.02em;
    }
    .milestone-sub {
      font-family: "Aileron", "General Sans", sans-serif;
      font-weight: 800;
      font-size: 22px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--peach);
      margin-top: 8px;
    }
    @keyframes milestone-in {
      0%   { opacity: 0; transform: translate(-50%, -16px) scale(0.85); }
      100% { opacity: 1; transform: translate(-50%, 0)     scale(1); }
    }
    @keyframes milestone-out {
      0%   { opacity: 1; transform: translate(-50%, 0)    scale(1); }
      100% { opacity: 0; transform: translate(-50%, -8px) scale(0.96); }
    }
    /* Confetti particles — CSS-only, falling peach/orange/wine dots */
    .confetti {
      position: fixed; inset: 0; pointer-events: none; z-index: 55;
      overflow: hidden;
    }
    .confetti span {
      position: absolute; top: -20px;
      width: 12px; height: 16px;
      border-radius: 2px;
      animation: confetti-fall 3.6s cubic-bezier(0.55, 0, 0.42, 1) forwards;
      opacity: 0;
    }
    @keyframes confetti-fall {
      0%   { transform: translateY(-10vh) rotate(0deg);    opacity: 1; }
      80%  { opacity: 1; }
      100% { transform: translateY(110vh) rotate(720deg);  opacity: 0; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <span class="brand-logo" aria-label="Von Peach"></span>
      <h1>The Game Changer Gallery</h1>
    </div>
    <div class="meta">
      <span class="window-label">${win === "all" ? "All time" : win === "hour" ? "Last hour" : win === "today" ? "Today" : win === "48h" ? "Last 48h" : "Last 7 days"}</span>
      <span class="count"><span id="count">—</span> revealed</span>
    </div>
  </header>
  <div class="tally" id="tally" aria-label="Live archetype distribution"></div>
  <div class="wall" id="wall"></div>

  <!-- Spotlight overlay (new tile fills the screen briefly on first arrival) -->
  <div class="spotlight" id="spotlight" aria-hidden="true">
    <div class="spotlight-eyebrow">Just revealed</div>
    <div class="spotlight-card" id="spotlightCard">
      <img id="spotlightImg" alt="" />
      <div class="spotlight-fade"></div>
      <div class="spotlight-pill" id="spotlightPill"></div>
    </div>
  </div>

  <!-- Milestone celebration (banner + confetti at round-number counts) -->
  <div class="milestone" id="milestone" aria-hidden="true">
    <div class="milestone-eyebrow">Milestone</div>
    <div class="milestone-count" id="milestoneCount">0</div>
    <div class="milestone-sub" id="milestoneSub">archetypes revealed</div>
  </div>

  <aside class="qr-card" aria-label="Scan to create yours and win a surprise prize">
    <div class="qr-prize">Win a <span class="accent">surprise prize</span></div>
    <div class="qr-frame" id="qrFrame"></div>
    <div class="qr-eyebrow">Scan to create yours</div>
  </aside>

  <!-- TV / event-display fullscreen toggle. Hides the browser chrome so
       the wall fills the screen edge-to-edge. Auto-hides itself once
       fullscreen is active. Press F to toggle, Esc to exit. -->
  <button class="fs-toggle" id="fsToggle" type="button" aria-label="Enter fullscreen (F)">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M3 9 V3 H9" />
      <path d="M21 9 V3 H15" />
      <path d="M3 15 V21 H9" />
      <path d="M21 15 V21 H15" />
    </svg>
    Fullscreen
  </button>

  <script>
    const WIN = ${safeWin};
    const NAMES = ${JSON.stringify(NAMES)};
    const POLL_MS = 5000;
    const NEW_BADGE_MS = 30000;   // tiles wear the "JUST IN" badge for 30s
    const MAX_TILES = 100;        // soft cap so the DOM doesn't grow unbounded
    const seenKeys = new Set();
    let firstLoad = true;

    function tileUrl(item) {
      return "/portrait-image/" + encodeURIComponent(item.key);
    }

    function makeTile(item, isNew) {
      const tile = document.createElement("div");
      tile.className = "tile" + (isNew ? " new" : "");
      tile.dataset.key = item.key;
      tile.dataset.archetype = item.archetype;
      const name = NAMES[item.archetype] || ("The " + item.archetype);
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = name;
      img.src = tileUrl(item);
      // Bottom fade — masks any gibberish text the AI tried to put at the
      // bottom of the image. The brand pill sits on top of this fade.
      const fade = document.createElement("div");
      fade.className = "tile-fade";
      const pill = document.createElement("div");
      pill.className = "pill";
      pill.textContent = name;
      tile.appendChild(img);
      tile.appendChild(fade);
      tile.appendChild(pill);
      if (isNew) {
        setTimeout(() => tile.classList.remove("new"), NEW_BADGE_MS);
      }
      return tile;
    }

    // ------- Spotlight reveal (new tile takes the whole screen briefly) -------
    let spotlightTimer = null;
    function showSpotlight(item) {
      const overlay = document.getElementById("spotlight");
      const img = document.getElementById("spotlightImg");
      const pill = document.getElementById("spotlightPill");
      img.src = tileUrl(item);
      img.alt = NAMES[item.archetype] || item.archetype;
      pill.textContent = NAMES[item.archetype] || ("The " + item.archetype);
      overlay.classList.remove("closing");
      overlay.classList.add("visible");
      overlay.setAttribute("aria-hidden", "false");

      // Auto-close after ~3.6s with a fade-out, then the tile is visible
      // in its grid position underneath.
      if (spotlightTimer) clearTimeout(spotlightTimer);
      spotlightTimer = setTimeout(() => {
        overlay.classList.add("closing");
        setTimeout(() => {
          overlay.classList.remove("visible", "closing");
          overlay.setAttribute("aria-hidden", "true");
        }, 480);
      }, 3600);
    }

    // ------- Live archetype tally (chips under header) -------
    let prevTopArchetype = null;
    function updateTally(items) {
      const tally = document.getElementById("tally");
      if (!tally) return;
      const counts = {};
      for (const it of items) counts[it.archetype] = (counts[it.archetype] || 0) + 1;
      // Sort by count desc, then by archetype name (stable)
      const entries = Object.entries(counts).sort(function (a, b) {
        return b[1] - a[1] || a[0].localeCompare(b[0]);
      });
      const topArch = entries.length ? entries[0][0] : null;
      const existing = new Map();
      Array.from(tally.children).forEach(function (el) { existing.set(el.dataset.archetype, el); });
      tally.innerHTML = "";
      entries.forEach(function (entry, idx) {
        const arch = entry[0];
        const n = entry[1];
        const chip = document.createElement("span");
        chip.className = "tally-chip" + (idx === 0 ? " top" : "");
        chip.dataset.archetype = arch;
        const label = document.createElement("span");
        label.textContent = (NAMES[arch] || arch).replace(/^The /, "");
        const num = document.createElement("strong");
        num.textContent = n;
        chip.appendChild(label);
        chip.appendChild(num);
        // Bump animation when the count changed since last refresh
        const prev = existing.get(arch);
        const prevText = prev ? prev.querySelector("strong")?.textContent : null;
        if (prev && prevText && Number(prevText) !== n) {
          chip.classList.add("bumped");
        }
        tally.appendChild(chip);
      });
      prevTopArchetype = topArch;
    }

    // ------- Milestone celebrations -------
    const MILESTONES = [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1000];
    let highestMilestoneShown = 0;
    function checkMilestone(count) {
      // Find the largest milestone we've crossed but not yet celebrated
      let toShow = 0;
      for (const m of MILESTONES) {
        if (count >= m && m > highestMilestoneShown) toShow = m;
      }
      if (toShow > 0) {
        highestMilestoneShown = toShow;
        showMilestone(toShow);
      }
    }
    function showMilestone(n) {
      const banner = document.getElementById("milestone");
      document.getElementById("milestoneCount").textContent = n;
      banner.classList.remove("closing");
      banner.classList.add("visible");
      banner.setAttribute("aria-hidden", "false");
      fireConfetti(80);
      setTimeout(function () {
        banner.classList.add("closing");
        setTimeout(function () {
          banner.classList.remove("visible", "closing");
          banner.setAttribute("aria-hidden", "true");
        }, 600);
      }, 3400);
    }
    function fireConfetti(count) {
      const colors = ["#FFD6BB", "#FD8839", "#CC1C0E", "#99112F"];
      const container = document.createElement("div");
      container.className = "confetti";
      for (let i = 0; i < count; i++) {
        const piece = document.createElement("span");
        piece.style.left = Math.random() * 100 + "vw";
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = (Math.random() * 0.5) + "s";
        piece.style.animationDuration = (3 + Math.random() * 1.4) + "s";
        piece.style.transform = "rotate(" + (Math.random() * 360) + "deg)";
        container.appendChild(piece);
      }
      document.body.appendChild(container);
      setTimeout(function () { container.remove(); }, 5000);
    }

    async function refresh() {
      try {
        const res = await fetch("/gallery.json?window=" + encodeURIComponent(WIN), { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const items = data.items || [];
        const wall = document.getElementById("wall");
        const count = document.getElementById("count");
        count.textContent = items.length;

        // Always update tally (even when empty — clears stale chips)
        updateTally(items);

        if (!items.length) {
          wall.innerHTML = '<div class="empty"><span class="blink"></span>Waiting for the first reveal…</div>';
          seenKeys.clear();
          firstLoad = true;
          highestMilestoneShown = 0; // reset so milestones re-fire after a clear
          return;
        }

        if (firstLoad) {
          // Initial paint — render all items in order, no NEW badge, no
          // spotlight, no milestone celebration (those are for fresh arrivals).
          wall.innerHTML = "";
          items.forEach((item) => {
            wall.appendChild(makeTile(item, false));
            seenKeys.add(item.key);
          });
          firstLoad = false;
          // Set milestone baseline so we don't re-celebrate already-passed counts
          for (const m of MILESTONES) {
            if (items.length >= m) highestMilestoneShown = m;
          }
          return;
        }

        // Subsequent polls — find items we haven't seen yet, prepend them
        // to the wall (newest first) with the JUST IN badge.
        const newItems = items.filter((it) => !seenKeys.has(it.key));
        if (newItems.length > 0) {
          // Spotlight reveal — only for the freshest single new tile to avoid
          // overlapping spotlights. The other new items still fly in via the
          // tile-in CSS animation.
          showSpotlight(newItems[0]);
        }
        newItems.reverse().forEach((it) => {
          const tile = makeTile(it, true);
          wall.insertBefore(tile, wall.firstChild);
          seenKeys.add(it.key);
        });

        // Milestone check on the post-update total
        checkMilestone(items.length);

        // Soft cap — keep DOM lean for long events.
        while (wall.children.length > MAX_TILES) {
          const last = wall.lastChild;
          if (last && last.dataset.key) seenKeys.delete(last.dataset.key);
          wall.removeChild(last);
        }
      } catch (err) {
        console.warn("wall refresh failed", err);
      }
    }

    refresh();
    setInterval(refresh, POLL_MS);

    // ---------- Scan-to-try QR ----------
    // Points at the worker's /scan endpoint (same origin as this wall) so
    // each scan is counted in R2 before the 302-redirect to tarot.vonpeach.com.
    // The QR library is loaded with defer; retry once if it isn't ready yet.
    function renderQR() {
      if (typeof window.qrcode !== "function") {
        return void setTimeout(renderQR, 200);
      }
      try {
        const qr = window.qrcode(0, "M");
        qr.addData(window.location.origin + "/scan");
        qr.make();
        const frame = document.getElementById("qrFrame");
        frame.innerHTML = qr.createImgTag(5, 0);
        const img = frame.querySelector("img");
        if (img) {
          img.removeAttribute("width");
          img.removeAttribute("height");
          img.setAttribute("alt", "Scan to create yours and win a prize");
        }
      } catch (err) {
        console.warn("QR render failed", err);
      }
    }
    renderQR();

    // ---------- Fullscreen toggle ----------
    // TV / event-display ergonomics. The Fullscreen API requires a user
    // gesture to enter (the click handler IS that gesture). F-key toggles
    // for the AV person at the event; Esc exits via the browser default.
    // Vendor prefixes for older Safari + WebKit-TV browsers (kiosk modes
    // on smart-TV Chromecast-style devices sometimes only expose the
    // webkit-prefixed API).
    const fsBtn = document.getElementById("fsToggle");
    function isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }
    async function toggleFullscreen() {
      try {
        if (isFullscreen()) {
          if (document.exitFullscreen)         await document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else {
          const el = document.documentElement;
          if (el.requestFullscreen)         await el.requestFullscreen({ navigationUI: "hide" });
          else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        }
      } catch (err) {
        console.warn("Fullscreen toggle failed:", err && err.message || err);
      }
    }
    fsBtn && fsBtn.addEventListener("click", toggleFullscreen);
    // F = toggle. Don't fire when the user is mid-typing in a hypothetical
    // future input field — Escape is the standard exit gesture.
    document.addEventListener("keydown", (e) => {
      if (e.key === "f" || e.key === "F") {
        if (e.target && /input|textarea/i.test(e.target.tagName)) return;
        e.preventDefault();
        toggleFullscreen();
      }
    });
  </script>
</body></html>`;
}

function renderGalleryHtml(items, authKey, currentFilter, totalCount) {
  const safeKey = encodeURIComponent(authKey);
  const counts = items.reduce((acc, x) => {
    acc[x.archetype] = (acc[x.archetype] || 0) + 1;
    return acc;
  }, {});
  const filterLink = (name, label) => {
    const params = new URLSearchParams({ key: authKey });
    if (name) params.set("archetype", name);
    const active = currentFilter === name || (!name && !currentFilter);
    return `<a href="/gallery?${params.toString()}" class="filter${active ? " active" : ""}">${label}${name ? ` <span class="filter-count">${counts[name] || 0}</span>` : ` <span class="filter-count">${totalCount}</span>`}</a>`;
  };
  const cards = items.map((x) => {
    const src = `/portrait-image/${encodeURIComponent(x.key)}?key=${safeKey}`;
    const date = x.iso ? new Date(x.iso).toLocaleString() : "";
    // Card is a wrapper div (for relative positioning) containing the
    // existing image-link AND a delete button. Button stops propagation so
    // clicking it doesn't open the image link.
    return `<div class="card" data-key="${encodeURIComponent(x.key)}">
      <a class="card-link" href="${src}" target="_blank" rel="noopener">
        <img loading="lazy" src="${src}" alt="${x.archetype}" />
        <div class="meta">
          <span class="archetype">${x.archetype}</span>
          <span class="ts">${date}</span>
        </div>
      </a>
      <button class="del-btn" data-key="${encodeURIComponent(x.key)}" title="Delete this portrait" aria-label="Delete this portrait">×</button>
    </div>`;
  }).join("");

  return `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Von Peach — The Game Changer Gallery</title>
  <link rel="icon" type="image/svg+xml" href="https://tarot.vonpeach.com/favicon.svg" />
  <link rel="alternate icon" type="image/png" href="https://tarot.vonpeach.com/favicon.png" />
  <link rel="apple-touch-icon" href="https://tarot.vonpeach.com/favicon.png" />
  <!-- QR generator for the "scan to win" CTA card. ~5KB lazy-loaded. -->
  <script defer src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
  <style>
    :root {
      --wine:#99112F; --red:#CC1C0E; --orange:#FD8839; --peach:#FFD6BB;
      --bg:#0d0308; --card-bg:#1a0610;
    }
    *, *::before, *::after { box-sizing:border-box; }
    body {
      margin:0; padding:0;
      background:
        radial-gradient(60% 50% at 15% 10%, rgba(253,136,57,0.18) 0%, transparent 60%),
        radial-gradient(70% 60% at 95% 100%, rgba(153,17,47,0.30) 0%, transparent 60%),
        var(--bg);
      color:var(--peach);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      min-height:100vh;
    }
    /* Header — sized up for 16:9 event-display viewing distance. */
    header {
      padding:24px 48px 20px;
      display:flex; align-items:center; justify-content:space-between; gap:24px;
      border-bottom:1px solid rgba(255,214,187,0.10);
      background:linear-gradient(180deg, rgba(13,3,8,0.92), rgba(13,3,8,0.72));
      position:sticky; top:0; z-index:10;
      backdrop-filter:blur(12px);
      -webkit-backdrop-filter:blur(12px);
      flex-wrap:wrap;
    }
    .header-left { display:flex; align-items:center; gap:22px; min-width:0; }
    /* Von Peach logo — uses the PNG as a CSS mask, recoloured to brand
       peach. Same trick used by the static site so we don't ship a
       separate tinted PNG. */
    .brand-logo {
      display:block;
      width:200px; height:44px;
      background-color: var(--peach);
      -webkit-mask:url('https://tarot.vonpeach.com/vonpeach-logo.png') no-repeat left center / contain;
              mask:url('https://tarot.vonpeach.com/vonpeach-logo.png') no-repeat left center / contain;
      flex-shrink:0;
    }
    header h1 {
      margin:0; font-size:26px; font-weight:900; letter-spacing:0.08em;
      text-transform:uppercase;
      background:linear-gradient(135deg, var(--orange) 0%, var(--red) 55%, var(--wine) 100%);
      -webkit-background-clip:text;
              background-clip:text;
      -webkit-text-fill-color:transparent;
      line-height:1.1;
    }
    .header-right {
      display:flex; gap:12px; align-items:center; flex-wrap:wrap; justify-content:flex-end;
    }
    .total {
      color:var(--peach);
      background:rgba(255,214,187,0.10);
      border:1px solid rgba(255,214,187,0.18);
      padding:8px 16px;
      border-radius:999px;
      font-size:14px; font-weight:700;
      letter-spacing:0.14em;
      text-transform:uppercase;
    }
    /* Cleanup button (bulk-delete-by-cutoff) */
    .cleanup-btn {
      appearance:none; border:0; cursor:pointer;
      background:linear-gradient(135deg, var(--orange), var(--red) 60%, var(--wine));
      color:#fff;
      padding:9px 18px;
      border-radius:999px;
      font-size:13px; font-weight:800; letter-spacing:0.14em; text-transform:uppercase;
      box-shadow:0 6px 18px rgba(204,28,14,0.32);
      font-family:inherit;
    }
    .cleanup-btn:hover { filter:brightness(1.08); }
    /* Cleanup panel — drops below the header when the button is toggled */
    .cleanup-panel {
      padding:18px 48px;
      display:flex; flex-wrap:wrap; gap:14px; align-items:center;
      background:rgba(204,28,14,0.10);
      border-bottom:1px solid rgba(204,28,14,0.30);
    }
    .cleanup-panel label { font-size:13px; letter-spacing:0.12em; text-transform:uppercase; color:rgba(255,214,187,0.85); font-weight:700; }
    .cleanup-panel input[type="datetime-local"] {
      background:var(--card-bg);
      color:var(--peach);
      border:1px solid rgba(255,214,187,0.20);
      border-radius:10px;
      padding:9px 14px;
      font-size:14px;
      font-family:inherit;
      color-scheme:dark;
    }
    .cleanup-panel button {
      appearance:none; border:0; cursor:pointer;
      padding:9px 18px;
      border-radius:999px;
      font-size:13px; font-weight:800; letter-spacing:0.14em; text-transform:uppercase;
      font-family:inherit;
    }
    .cleanup-panel .preview-btn {
      background:rgba(255,214,187,0.10);
      color:var(--peach);
      border:1px solid rgba(255,214,187,0.20);
    }
    .cleanup-panel .execute-btn {
      background:linear-gradient(135deg, #CC1C0E, #99112F);
      color:#fff;
      box-shadow:0 6px 18px rgba(204,28,14,0.4);
    }
    .cleanup-panel .execute-btn:disabled { opacity:0.45; cursor:not-allowed; box-shadow:none; }
    .cleanup-panel .preset { font-size:12px; letter-spacing:0.10em; text-transform:uppercase; padding:6px 12px; background:rgba(255,214,187,0.06); border:1px solid rgba(255,214,187,0.14); }
    .cleanup-result {
      margin-left:auto;
      color:var(--peach);
      font-size:13px;
      letter-spacing:0.06em;
      opacity:0.75;
    }
    .filters {
      padding:18px 48px; display:flex; flex-wrap:wrap; gap:10px;
      border-bottom:1px solid rgba(255,214,187,0.10);
    }
    .filter {
      display:inline-flex; align-items:center; gap:10px;
      padding:10px 18px; border-radius:999px;
      background:rgba(255,214,187,0.06); color:var(--peach);
      text-decoration:none; font-size:13px; font-weight:700;
      letter-spacing:0.16em; text-transform:uppercase;
      border:1px solid rgba(255,214,187,0.14); transition:background 120ms;
    }
    .filter:hover { background:rgba(255,214,187,0.12); }
    .filter.active { background:linear-gradient(135deg,var(--orange),var(--red) 60%,var(--wine)); border-color:transparent; color:#fff; }
    .filter-count { background:rgba(0,0,0,0.20); padding:3px 10px; border-radius:999px; font-size:12px; }
    /* Bigger tiles — sized for 1080p+ viewing rather than laptop curation. */
    .grid {
      display:grid; gap:22px; padding:28px 48px 120px;
      grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));
    }
    .card {
      position:relative;
      background:var(--card-bg); border-radius:14px; overflow:hidden;
      box-shadow:0 8px 22px rgba(0,0,0,0.4);
      transition:transform 140ms ease, box-shadow 140ms ease, opacity 200ms ease;
      display:flex; flex-direction:column;
    }
    .card:hover { transform:translateY(-2px); box-shadow:0 12px 30px rgba(204,28,14,0.30); }
    .card-link {
      text-decoration:none; color:var(--peach);
      display:flex; flex-direction:column;
    }
    .card img { display:block; width:100%; aspect-ratio:3/4; object-fit:cover; background:#1a0610; }
    .meta { padding:10px 14px; display:flex; justify-content:space-between; align-items:center; font-size:12px; gap:8px; }
    .archetype { font-weight:700; text-transform:capitalize; letter-spacing:0.04em; color:var(--orange); }
    .ts { color:rgba(255,214,187,0.55); font-size:11px; }
    .empty { padding:60px 24px; text-align:center; color:rgba(255,214,187,0.55); }

    /* Per-tile delete button — visible on hover, click confirms then DELETEs
       the R2 object via the /portrait-image/<key> endpoint. */
    .del-btn {
      position:absolute; top:10px; right:10px;
      width:34px; height:34px;
      border:0; border-radius:50%;
      background:rgba(204,28,14,0.92);
      color:#fff; font-size:22px; font-weight:800; line-height:1;
      cursor:pointer;
      display:flex; align-items:center; justify-content:center;
      opacity:0;
      transition:opacity 140ms ease, transform 140ms ease, background 140ms ease;
      box-shadow:0 6px 16px rgba(0,0,0,0.45);
      z-index:2;
      padding-bottom:3px;  /* visual centering of the × glyph */
      font-family:inherit;
    }
    .card:hover .del-btn { opacity:1; }
    .del-btn:hover  { transform:scale(1.10); background:rgba(204,28,14,1); }
    .del-btn:focus  { opacity:1; outline:2px solid var(--peach); outline-offset:2px; }
    .del-btn:disabled { opacity:0.6; cursor:wait; transform:none; }
    .card.deleting { opacity:0; transform:scale(0.92); pointer-events:none; }

    /* "Scan to win" QR card — fixed bottom-right, matching the event wall.
       Same prize CTA so the gallery view doubles as a 16:9 secondary
       event display when this URL is loaded on a projector. */
    .qr-card {
      position:fixed; bottom:28px; right:28px;
      background:var(--peach);
      padding:22px 22px 16px;
      border-radius:24px;
      box-shadow:0 20px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.15);
      z-index:5; text-align:center;
      max-width:220px;
    }
    .qr-prize {
      font-family:Georgia, "Times New Roman", serif;
      font-weight:800;
      font-size:18px;
      color:var(--wine);
      line-height:1.15;
      margin-bottom:14px;
      letter-spacing:0.02em;
    }
    .qr-prize .accent {
      display:block;
      background:linear-gradient(135deg,var(--orange),var(--red) 60%,var(--wine));
      -webkit-background-clip:text;
              background-clip:text;
      -webkit-text-fill-color:transparent;
      font-size:22px;
      letter-spacing:0.04em;
    }
    .qr-frame {
      width:172px; height:172px;
      line-height:0;
      background:#fff;
      border-radius:10px;
      padding:6px;
      margin:0 auto;
    }
    .qr-frame img, .qr-frame svg { width:100%; height:100%; display:block; }
    .qr-eyebrow {
      margin-top:12px;
      color:var(--wine);
      font-family:Georgia, "Times New Roman", serif;
      font-weight:700;
      font-size:12px;
      letter-spacing:0.22em;
      text-transform:uppercase;
    }
  </style>
</head><body>
  <header>
    <div class="header-left">
      <span class="brand-logo" aria-label="Von Peach"></span>
      <h1>The Game Changer Gallery</h1>
    </div>
    <div class="header-right">
      <span class="total" id="portraitTotal">${totalCount} total</span>
      <span class="total" id="scanTotal" title="QR scans on the event wall">— scans</span>
      <button class="cleanup-btn" id="cleanupBtn" title="Bulk-delete portraits older than a chosen date/time">Cleanup older</button>
    </div>
  </header>
  <!-- Cleanup panel — toggled by the Cleanup button. Lets admin pick a
       cutoff datetime and bulk-delete every portrait older than that. -->
  <div class="cleanup-panel" id="cleanupPanel" hidden>
    <label for="cleanupCutoff">Delete everything older than</label>
    <input type="datetime-local" id="cleanupCutoff" step="1" />
    <button class="preview-btn" id="cleanupPreview">Preview</button>
    <button class="execute-btn" id="cleanupExecute" disabled>Delete</button>
    <span class="cleanup-result" id="cleanupResult">Pick a cutoff, then preview</span>
  </div>
  <div class="filters">
    ${filterLink("",          "All")}
    ${filterLink("charmer",   "Charmer")}
    ${filterLink("magician",  "Magician")}
    ${filterLink("alchemist", "Alchemist")}
    ${filterLink("oracle",    "Oracle")}
    ${filterLink("rebel",     "Rebel")}
    ${filterLink("monk",      "Monk")}
    ${filterLink("architect", "Architect")}
    ${filterLink("luminary",  "Luminary")}
  </div>

  <aside class="qr-card" aria-label="Scan to create your card — win a surprise prize">
    <div class="qr-prize">Win a <span class="accent">surprise prize</span></div>
    <div class="qr-frame" id="qrFrame"></div>
    <div class="qr-eyebrow">Scan to create yours</div>
  </aside>
  ${items.length === 0
    ? `<div class="empty">No portraits yet.${currentFilter ? " Try removing the filter." : ""}</div>`
    : `<div class="grid">${cards}</div>`}
  <script>
    // Per-tile delete. Sends DELETE /portrait-image/<key>?key=<GALLERY_KEY>,
    // animates the card out on success, updates the header total count.
    // The encoded gallery key is interpolated from the server — same key
    // that gates this page, so it always matches.
    (function () {
      const KEY = ${JSON.stringify(safeKey)};
      const totalEl = document.getElementById("portraitTotal");
      const scanEl  = document.getElementById("scanTotal");
      function decTotal() {
        if (!totalEl) return;
        const m = totalEl.textContent.match(/(\\d+)/);
        if (!m) return;
        totalEl.textContent = (parseInt(m[1], 10) - 1) + " total";
      }
      // Live scan-count from /stats. Updates every 5s so the admin sees
      // QR-scan growth in real time during the event.
      async function refreshScanCount() {
        try {
          const res = await fetch("/stats?key=" + KEY, { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          if (scanEl) scanEl.textContent = (data.scans || 0) + " scans";
        } catch (e) { /* swallow */ }
      }
      refreshScanCount();
      setInterval(refreshScanCount, 5000);

      // Render the "scan to win" QR. Points at /scan (worker endpoint,
      // same origin) which counts the scan in R2 and 302-redirects to
      // tarot.vonpeach.com. Retry once if the lib hasn't loaded yet.
      function renderQR() {
        if (typeof window.qrcode !== "function") {
          return void setTimeout(renderQR, 200);
        }
        try {
          const qr = window.qrcode(0, "M");
          qr.addData(window.location.origin + "/scan");
          qr.make();
          const frame = document.getElementById("qrFrame");
          if (!frame) return;
          frame.innerHTML = qr.createImgTag(5, 0);
          const img = frame.querySelector("img");
          if (img) {
            img.removeAttribute("width");
            img.removeAttribute("height");
            img.setAttribute("alt", "Scan to create yours and win a prize");
          }
        } catch (err) { console.warn("QR render failed", err); }
      }
      renderQR();

      document.querySelectorAll(".del-btn").forEach(function (btn) {
        btn.addEventListener("click", async function (e) {
          e.preventDefault(); e.stopPropagation();
          const key = btn.dataset.key;  // already encodeURIComponent'd at render time
          if (!confirm("Delete this portrait? This can't be undone.")) return;
          btn.disabled = true;
          btn.textContent = "…";
          try {
            const res = await fetch("/portrait-image/" + key + "?key=" + KEY, { method: "DELETE" });
            if (!res.ok) {
              const detail = await res.text().catch(function(){return "";});
              throw new Error("HTTP " + res.status + (detail ? " — " + detail.slice(0,120) : ""));
            }
            const card = btn.closest(".card");
            if (card) {
              card.classList.add("deleting");
              setTimeout(function () { card.remove(); }, 220);
            }
            decTotal();
          } catch (err) {
            alert("Delete failed: " + (err && err.message ? err.message : err));
            btn.disabled = false;
            btn.textContent = "×";
          }
        });
      });

      // ---------- Bulk cleanup by cutoff ----------
      // Click "Cleanup older" → datetime panel drops down. Pick a cutoff,
      // click Preview to see how many portraits would be deleted, then
      // click Delete to execute. Uses the bulk DELETE /gallery/before
      // endpoint which deletes via R2's bulk-delete API.
      const cleanupBtn     = document.getElementById("cleanupBtn");
      const cleanupPanel   = document.getElementById("cleanupPanel");
      const cleanupCutoff  = document.getElementById("cleanupCutoff");
      const cleanupPreview = document.getElementById("cleanupPreview");
      const cleanupExecute = document.getElementById("cleanupExecute");
      const cleanupResult  = document.getElementById("cleanupResult");

      // Default cutoff = NOW in the user's local timezone, in the
      // datetime-local input format (YYYY-MM-DDTHH:MM:SS, no TZ).
      function nowLocalISO() {
        const d = new Date();
        const off = d.getTimezoneOffset() * 60000;
        return new Date(d.getTime() - off).toISOString().slice(0, 19);
      }
      cleanupCutoff.value = nowLocalISO();

      cleanupBtn.addEventListener("click", function () {
        cleanupPanel.hidden = !cleanupPanel.hidden;
      });

      cleanupPreview.addEventListener("click", async function () {
        const cutoffMs = new Date(cleanupCutoff.value).getTime();
        if (!Number.isFinite(cutoffMs)) {
          cleanupResult.textContent = "Pick a valid date/time first";
          return;
        }
        cleanupResult.textContent = "Counting…";
        cleanupExecute.disabled = true;
        try {
          const res = await fetch("/gallery.json?window=all", { cache: "no-store" });
          const data = await res.json();
          const matches = (data.items || []).filter(function (it) { return it.ts < cutoffMs; });
          cleanupResult.textContent = matches.length === 0
            ? "Nothing older than that cutoff"
            : "Would delete " + matches.length + " portrait" + (matches.length === 1 ? "" : "s");
          cleanupExecute.disabled = matches.length === 0;
          cleanupExecute.dataset.count = String(matches.length);
          cleanupExecute.dataset.cutoff = String(cutoffMs);
          cleanupExecute.textContent = matches.length > 0 ? ("Delete " + matches.length) : "Delete";
        } catch (err) {
          cleanupResult.textContent = "Preview failed: " + (err && err.message ? err.message : err);
        }
      });

      cleanupExecute.addEventListener("click", async function () {
        const cutoff = cleanupExecute.dataset.cutoff;
        const count  = cleanupExecute.dataset.count;
        if (!cutoff) return;
        if (!confirm("Delete " + count + " portrait" + (count === "1" ? "" : "s") + "? This can't be undone.")) return;
        cleanupExecute.disabled = true;
        cleanupExecute.textContent = "Deleting…";
        cleanupResult.textContent = "";
        try {
          const url = "/gallery/before?key=" + KEY + "&ts=" + encodeURIComponent(cutoff);
          const res = await fetch(url, { method: "DELETE" });
          if (!res.ok) {
            const detail = await res.text().catch(function(){return "";});
            throw new Error("HTTP " + res.status + (detail ? " — " + detail.slice(0, 120) : ""));
          }
          const data = await res.json();
          cleanupResult.textContent = "Deleted " + (data.deleted || 0) + " — refreshing…";
          setTimeout(function () { location.reload(); }, 1200);
        } catch (err) {
          cleanupResult.textContent = "Delete failed: " + (err && err.message ? err.message : err);
          cleanupExecute.disabled = false;
          cleanupExecute.textContent = "Try again";
        }
      });
    })();
  </script>
</body></html>`;
}

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Where the email pulls the logo from. Must be publicly fetchable.
const LOGO_URL = "https://tarot.vonpeach.com/vonpeach-logo.png";

// Build the LinkedIn share dialog URL from a per-portrait share URL. The
// share URL points to a /p/<key> page on the worker that exposes the user's
// actual card as the OG image — so when LinkedIn scrapes it, the post
// preview shows their card, not a generic tarot.vonpeach.com thumbnail.
function buildLinkedInShareUrl(shareUrl) {
  return "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(shareUrl);
}

function emailHtml(name, tagline, paragraphs, imageDataUrl, shareUrl) {
  const safeShare = shareUrl || "https://tarot.vonpeach.com";
  const linkedInUrl = buildLinkedInShareUrl(safeShare);
  // White inner card on dark outer with orange→red→wine accent stripes.
  // Layout: logo → hero tarot card (with wiggle) → archetype title →
  // italic tagline → archetype reading paragraphs → "your portrait is
  // attached" line → Share on LinkedIn → divider → "Ready to write the
  // rest of your story?" CTA pointing to vonpeach.com → socials.
  // Wiggle animation declared in <style>; Apple/iOS Mail honour it,
  // Gmail strips <style> and the card sits static — graceful degradation.
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <!-- Force light-mode rendering. Outlook mobile + iOS Mail + Gmail dark
       mode aggressively invert email colours when they detect a light
       palette — our brand peach + dark-text-on-cream pattern turns into
       muddy dark-on-darker which looked broken in the user's Outlook
       screenshot. These two metas tell well-behaved clients to skip the
       auto-invert. Outlook + Apple Mail respect them; Gmail still does
       some adjustment but less destructively. -->
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <style>
    /* Belt-and-braces for clients that DO honour <style>: tell them
       explicitly that this email is single-mode. */
    :root { color-scheme: light only; supported-color-schemes: light; }
    @keyframes vp-wiggle {
      0%, 100% { transform: rotate(-1.2deg) translateY(-2px); }
      50%      { transform: rotate(1.2deg)  translateY(2px); }
    }
    .vp-card { animation: vp-wiggle 5s ease-in-out infinite; transform-origin: center; }
    @media (prefers-reduced-motion: reduce) { .vp-card { animation: none; } }
    /* Outlook desktop honours @media (prefers-color-scheme: dark) for
       its own inversion logic — explicitly pin the inner card to light. */
    @media (prefers-color-scheme: dark) {
      .vp-bg          { background:#0d0308 !important; }
      .vp-card-bg     { background:#FFFFFF !important; color:#3a0812 !important; }
      .vp-text-dark   { color:#3a0812 !important; }
      .vp-text-wine   { color:#99112F !important; }
      .vp-text-orange { color:#CC1C0E !important; }
    }
  </style>
</head>
<body class="vp-bg" style="margin:0;padding:0;background:#0d0308;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#3a0812;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="vp-bg" style="background:#0d0308;padding:32px 16px;" bgcolor="#0d0308">
    <tr><td align="center">
      <table role="presentation" width="100%" class="vp-card-bg" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 14px 38px rgba(153,17,47,0.20);" cellpadding="0" cellspacing="0" bgcolor="#FFFFFF">

        <!-- Top brand stripe — orange → red → wine -->
        <tr><td style="height:6px;line-height:0;font-size:0;background:linear-gradient(90deg,#FD8839 0%,#CC1C0E 50%,#99112F 100%);">&nbsp;</td></tr>

        <!-- Logo, black on white — reads naturally -->
        <tr><td align="center" style="padding:32px 36px 24px 36px;">
          <img src="${LOGO_URL}" alt="Von Peach" width="160" style="display:block;width:160px;height:auto;border:0;outline:none;margin:0 auto;" />
        </td></tr>

        <!-- THE TAROT CARD — the hero -->
        <tr><td align="center" style="padding:0 24px;">
          <img src="${imageDataUrl}" alt="${name}" class="vp-card"
               style="display:block;width:100%;max-width:420px;height:auto;border:0;outline:none;border-radius:12px;" />
        </td></tr>

        <!-- Archetype title + italic tagline -->
        <tr><td style="padding:28px 36px 0 36px;">
          <h1 style="margin:0;font-size:28px;font-weight:800;color:#99112F;letter-spacing:-0.01em;line-height:1.2;">${name}</h1>
          <p style="margin:6px 0 0 0;font-size:14px;font-style:italic;color:#CC1C0E;letter-spacing:0.02em;">${tagline}</p>
          <div style="height:3px;width:56px;background:#FD8839;margin-top:14px;border-radius:2px;line-height:0;font-size:0;">&nbsp;</div>
        </td></tr>

        <!-- Body paragraphs -->
        ${paragraphs.map((p) => `
        <tr><td style="padding:18px 36px 0 36px;font-size:15px;line-height:1.6;color:#3a0812;">
          ${escapeHtml(p)}
        </td></tr>`).join("")}

        <!-- Portrait-attached note -->
        <tr><td style="padding:22px 36px 0 36px;font-size:13px;line-height:1.55;color:rgba(58,8,18,0.72);">
          Your portrait is attached, and lives at a sharable link below. Post it, send it, or keep it close as a reminder of what makes you special.
        </td></tr>

        <!-- Share CTAs — primary "Open share page" (where the user gets buttons
             for LinkedIn, copy-link, download, native share) + secondary
             direct LinkedIn link for the desktop-email read flow. -->
        <tr><td align="center" style="padding:22px 36px 4px 36px;">
          <a href="${safeShare}"
             style="display:inline-block;background:linear-gradient(135deg,#FD8839 0%,#CC1C0E 60%,#99112F 100%);color:#FFFFFF;text-decoration:none;padding:14px 28px;border-radius:999px;font-family:inherit;font-weight:800;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;box-shadow:0 8px 18px rgba(204,28,14,0.30);">
            Open Your Share Page
          </a>
        </td></tr>
        <tr><td align="center" style="padding:8px 36px 0 36px;">
          <a href="${linkedInUrl}"
             style="display:inline-block;color:#99112F;text-decoration:underline;font-family:inherit;font-weight:700;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">
            Or post straight to LinkedIn →
          </a>
        </td></tr>

        <!-- "Ready to write the rest of your story?" CTA block -->
        <tr><td style="padding:36px 36px 0 36px;">
          <div style="border-top:1px solid rgba(253,136,57,0.30);padding-top:28px;">
            <h2 style="margin:0;font-size:20px;font-weight:800;color:#99112F;letter-spacing:-0.01em;line-height:1.3;">Ready to write the rest of your story?</h2>
            <p style="margin:8px 0 18px 0;font-size:14px;line-height:1.55;color:rgba(58,8,18,0.78);">We'll help you get started.</p>
            <a href="https://vonpeach.com" style="display:inline-block;background:transparent;color:#99112F;border:1.5px solid #99112F;text-decoration:none;padding:12px 24px;border-radius:999px;font-family:inherit;font-weight:800;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;">vonpeach.com →</a>
          </div>
        </td></tr>

        <!-- Socials -->
        <tr><td align="center" style="padding:28px 36px 0 36px;">
          <a href="https://www.instagram.com/vonpeachonline/" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none;color:#99112F;margin:0 12px;line-height:0;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;">
              <path d="M7.8 2h8.4C19.4 2 22 4.6 22 7.8v8.4a5.8 5.8 0 0 1-5.8 5.8H7.8C4.6 22 2 19.4 2 16.2V7.8A5.8 5.8 0 0 1 7.8 2m-.2 2A3.6 3.6 0 0 0 4 7.6v8.8C4 18.39 5.61 20 7.6 20h8.8a3.6 3.6 0 0 0 3.6-3.6V7.6C20 5.61 18.39 4 16.4 4H7.6m9.65 1.5a1.25 1.25 0 0 1 1.25 1.25A1.25 1.25 0 0 1 17.25 8 1.25 1.25 0 0 1 16 6.75a1.25 1.25 0 0 1 1.25-1.25M12 7a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5 5 5 0 0 1 5-5m0 2a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>
            </svg>
          </a>
          <a href="https://www.linkedin.com/company/65850001/" target="_blank" rel="noopener" style="display:inline-block;text-decoration:none;color:#99112F;margin:0 12px;line-height:0;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;">
              <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/>
            </svg>
          </a>
        </td></tr>

        <tr><td style="padding:12px 36px 28px 36px;" align="center">&nbsp;</td></tr>

        <!-- Bottom brand stripe — wine → red → orange -->
        <tr><td style="height:6px;line-height:0;font-size:0;background:linear-gradient(90deg,#99112F 0%,#CC1C0E 50%,#FD8839 100%);">&nbsp;</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function emailText(name, tagline, paragraphs, shareUrl) {
  const safeShare = shareUrl || "https://tarot.vonpeach.com";
  return [
    "VON PEACH",
    "",
    name,
    tagline ? tagline : null,
    "",
    ...(paragraphs || []).flatMap((p) => [p, ""]),
    "Your portrait is attached. Open your share page to post on LinkedIn, copy the link, or download the image:",
    safeShare,
    "",
    "Ready to write the rest of your story?",
    "We'll help you get started.",
    "vonpeach.com",
  ].filter((line) => line !== null).join("\n");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
