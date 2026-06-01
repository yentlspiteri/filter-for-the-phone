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
  "flame patterns appropriate to the scene). No text on the card, no " +
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
  "orange hair, wine-red hair, brand-coloured hair, " +
  "orange eyes, red eyes, brand-coloured eyes, " +
  "orange skin, peach-recoloured skin, wine-tinted skin";

// Illustrated tarot card scenes — each archetype is a dramatic
// vector-poster scene with the figure mid-action and a symbolic
// background. The shared STYLE_LEAD goes at the front and STYLE_TRAIL
// at the back of every prompt (see getPromptFor below). Each archetype
// has 5 scene variants for visual variety
// across generations.
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
    (subject.eyes
      ? `Eye colour is critical: render clearly visible ${subject.eyes} — the iris colour must read unmistakably as ${subject.eyes}. `
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
};

export default {
  async fetch(request, env, ctx) {
    // Tighten this to your deployed origin once everything works:
    //   "Access-Control-Allow-Origin": "https://tarot.vonpeach.com"
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
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
      if (url.pathname.startsWith("/portrait-image/")) return handlePortraitImage(request, env, url);
      return jsonResp({ error: "not_found", path: url.pathname }, 404, cors);
    }

    if (request.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, cors);

    if (url.pathname === "/portrait")        return handlePortrait(request, env, ctx, cors);
    if (url.pathname === "/send-card")       return handleSendCard(request, env, cors);
    if (url.pathname === "/portrait-email")  return handlePortraitEmail(request, env, ctx, cors);
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
    const { image, face, archetype } = (await request.json()) || {};
    if (!image || !archetype) return jsonResp({ error: "missing_fields" }, 400, cors);
    // Per-request pipeline override via ?pipeline=kontext (or pulid / snapchat).
    // Lets us safely A/B test a new pipeline against prod by hitting the same
    // worker with two different query params, without changing the global
    // default. Falls back to PIPELINE env var, then to "pulid".
    const url = new URL(request.url);
    const pipelineOverride = url.searchParams.get("pipeline");
    const dataUrl = await runSelectedPipeline(env, image, archetype, face, pipelineOverride);
    // Detached save to R2 — don't block the client response.
    ctx.waitUntil(saveToGallery(env, archetype, dataUrl));
    return jsonResp({ image: dataUrl }, 200, cors);
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
        // Best-effort gallery save before sending the email.
        await saveToGallery(env, archetype, portraitDataUrl);
        console.log(`[portrait-email] pipeline done t+${Date.now()-bgT0}ms, sending via Resend`);
        await sendCardEmail(env, {
          email,
          archetype,
          archetypeName,
          image: portraitDataUrl,
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
    const subject = await describeSubjectOpenAI(env, imageDataUrl, faceImageDataUrl);
    if (subject) return subject;
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
            ' "eyes":"<eye colour> eyes",\n' +
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

      const [focusedFacial, focusedHair, focusedGlasses, focusedGender] = await Promise.all([
        isMale  ? detectFacialHair(env, bytes).catch(() => null) : Promise.resolve(null),
        !isBald ? detectHairColor(env, bytes).catch(() => null) : Promise.resolve(null),
        detectGlasses(env, bytes).catch(() => null),
        detectGender(env, bytes).catch(() => null),
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
              ' "eyes":"<eye colour> eyes",\n' +
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
  const kontextPrompt =
    "TRANSFORM this portrait photo into an illustrated tarot card while " +
    "PRESERVING THE PERSON'S EXACT identity from this photo — same face " +
    "structure, same hair colour, same eye colour, same skin tone, same " +
    "beard / stubble / glasses / distinctive features if present. Do NOT " +
    "change who they are. Only transform the rendering STYLE and add the " +
    "SCENE around them. " +
    archetypePrompt;

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

    const data = await sendCardEmail(env, body);
    return jsonResp({ ok: true, id: data?.id }, 200, cors);
  } catch (err) {
    const msg = err?.message || "server";
    const status = /upstream/i.test(msg) ? 502 : 500;
    return jsonResp({ error: "send_failed", message: msg }, status, cors);
  }
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
  if (!env.MAILCHIMP_API_KEY || !env.MAILCHIMP_LIST_ID) return null;

  // The datacenter is the suffix after the dash in the API key (e.g. "us12").
  const parts = String(env.MAILCHIMP_API_KEY).split("-");
  const dc = parts[parts.length - 1];
  if (!dc) {
    console.warn("Mailchimp: couldn't parse datacenter from API key");
    return null;
  }

  const url = `https://${dc}.api.mailchimp.com/3.0/lists/${env.MAILCHIMP_LIST_ID}/members`;
  const auth = btoa(`anystring:${env.MAILCHIMP_API_KEY}`);

  const body = {
    email_address: email,
    status: "subscribed",
    tags: ["filter-for-the-phone", archetype].filter(Boolean),
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
    if (res.ok) return await res.json();

    // 400 with "already a list member" or "exists" is success-equivalent:
    // they're already subscribed, nothing more we need to do.
    const detail = await res.text();
    if (res.status === 400 && /already a list member|exists/i.test(detail)) {
      return { existing: true };
    }

    console.warn("Mailchimp add failed:", res.status, detail);
    return null;
  } catch (err) {
    console.warn("Mailchimp add threw:", err?.message);
    return null;
  }
}

// ---------- email send: posts to Resend, throws on failure ----------
// `image` is shown inline in the email body (small framed card preview);
// `imageAttachment` is what gets attached for download (clean AI portrait
// without tarot framing — uploadable to LinkedIn). If imageAttachment isn't
// provided we fall back to attaching the inline image.
async function sendCardEmail(env, { email, archetype, archetypeName, image, imageAttachment }) {
  if (!env.RESEND_KEY) throw new Error("no_resend_key");

  const read = READS[archetype] || {};
  const name = read.name || archetypeName || "your archetype";
  const tagline = read.tagline || "";
  const paragraphs = read.paragraphs || [];
  const from = env.FROM_EMAIL || "Von Peach <onboarding@resend.dev>";

  // Strip "data:image/jpeg;base64," prefix — Resend wants raw base64.
  const attachmentSrc = imageAttachment || image;
  const attachmentB64 = String(attachmentSrc).split(",").pop();

  const payload = {
    from,
    to: [email],
    subject: `Your Von Peach photo — ${name}`,
    html: emailHtml(name, tagline, paragraphs, image),
    text: emailText(name, tagline, paragraphs),
    attachments: [
      { filename: `von-peach-${archetype}.jpg`, content: attachmentB64 },
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
  if (!env.PORTRAITS) return;
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
      },
    });
  } catch (err) {
    console.warn("gallery save failed:", err?.message);
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
      "Cache-Control": "public, max-age=300",
    },
  });
}

// ---------- LIVE EVENT WALL ----------
// Designed for projection / TV display during an in-person event. Big-tile
// auto-refreshing grid; new portraits "pop" in at the top of the wall with
// a "NEW" badge for 30 seconds, older portraits flow down.
//
// Two endpoints:
//   GET /wall?key=<GALLERY_KEY>[&window=today|hour|all]
//       Returns the HTML page. The page polls /gallery.json every 5s.
//   GET /gallery.json?key=<GALLERY_KEY>[&window=today|hour|all]
//       Returns the current list of portrait items (most recent first)
//       as JSON. Cheap; used by the wall's polling loop.
//
// Both endpoints are passcode-gated by the existing GALLERY_KEY secret,
// the same one that gates /gallery and /portrait-image — no extra secret
// to provision.
// The wall is PUBLIC — no passcode required, so anyone with the URL can pull
// it up on a phone / projector during the event. Admin curation stays on
// /gallery which is still gated by GALLERY_KEY.
async function handleWall(_request, env, url) {
  if (!env.PORTRAITS) return new Response("R2 bucket not bound.", { status: 500 });

  const win = url.searchParams.get("window") || "today";
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

  const win = url.searchParams.get("window") || "today";
  const cutoffMs = computeCutoffMs(win);

  // List up to 500 most recent objects from the bucket. R2 list orders
  // alphabetically by key, and our key scheme is YYYY/MM/DD/archetype-ts-id
  // — so chronological-ish but not perfect, so we sort by metadata.ts below.
  const list = await env.PORTRAITS.list({ limit: 500 });
  const items = await Promise.all((list.objects || []).map(async (obj) => {
    const head = await env.PORTRAITS.head(obj.key);
    const meta = head?.customMetadata || {};
    const ts = meta.ts ? Number(meta.ts) : (obj.uploaded?.getTime?.() || 0);
    return {
      key: obj.key,
      archetype: meta.archetype || "—",
      ts,
    };
  }));

  const filtered = items
    .filter((x) => x.ts >= cutoffMs)
    .sort((a, b) => b.ts - a.ts);

  return new Response(JSON.stringify({ items: filtered, now: Date.now(), window: win }), { status: 200, headers });
}

// Maps the `window` query param to a Unix-ms cutoff. Anything with a
// timestamp >= cutoff is included; everything older is filtered out.
//   "all"    → no cutoff (include everything in the bucket)
//   "today"  → start of today (UTC), 00:00:00.000
//   "hour"   → last 60 minutes
//   <unknown>→ treated as "today" (safe default for event use)
function computeCutoffMs(win) {
  if (win === "all") return 0;
  if (win === "hour") return Date.now() - 60 * 60 * 1000;
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
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
  <title>Von Peach — Live Wall</title>
  <!-- Public URL but not meant to be indexed; the wall is event-display
       ephemera, not a SEO target. -->
  <meta name="robots" content="noindex, nofollow" />
  <meta name="referrer" content="no-referrer" />
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
      padding: 28px 48px;
      display: flex; align-items: center; justify-content: space-between; gap: 24px;
      border-bottom: 1px solid rgba(255,214,187,0.10);
      background: linear-gradient(180deg, rgba(13,3,8,0.92), rgba(13,3,8,0.72));
      position: sticky; top: 0; z-index: 10;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    h1 {
      margin: 0;
      font-size: 30px;
      font-weight: 900;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      background: linear-gradient(135deg, var(--orange) 0%, var(--red) 55%, var(--wine) 100%);
      -webkit-background-clip: text;
              background-clip: text;
      -webkit-text-fill-color: transparent;
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
  </style>
</head>
<body>
  <header>
    <h1>Von Peach — Tonight's Archetypes</h1>
    <div class="meta">
      <span class="window-label">${win === "all" ? "All time" : win === "hour" ? "Last hour" : "Today"}</span>
      <span class="count"><span id="count">—</span> revealed</span>
    </div>
  </header>
  <div class="wall" id="wall"></div>

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
      const name = NAMES[item.archetype] || ("The " + item.archetype);
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = name;
      img.src = tileUrl(item);
      const pill = document.createElement("div");
      pill.className = "pill";
      pill.textContent = name;
      tile.appendChild(img);
      tile.appendChild(pill);
      if (isNew) {
        setTimeout(() => tile.classList.remove("new"), NEW_BADGE_MS);
      }
      return tile;
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

        if (!items.length) {
          wall.innerHTML = '<div class="empty"><span class="blink"></span>Waiting for the first reveal…</div>';
          seenKeys.clear();
          firstLoad = true;
          return;
        }

        if (firstLoad) {
          // Initial paint — render all items in order, no NEW badge.
          wall.innerHTML = "";
          items.forEach((item) => {
            wall.appendChild(makeTile(item, false));
            seenKeys.add(item.key);
          });
          firstLoad = false;
          return;
        }

        // Subsequent polls — find items we haven't seen yet, prepend them
        // to the wall (newest first) with the JUST IN badge. They slide
        // existing tiles down via the CSS grid auto-flow.
        const newItems = items.filter((it) => !seenKeys.has(it.key));
        newItems.reverse().forEach((it) => {
          const tile = makeTile(it, true);
          wall.insertBefore(tile, wall.firstChild);
          seenKeys.add(it.key);
        });

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
    return `<a class="card" href="${src}" target="_blank" rel="noopener">
      <img loading="lazy" src="${src}" alt="${x.archetype}" />
      <div class="meta">
        <span class="archetype">${x.archetype}</span>
        <span class="ts">${date}</span>
      </div>
    </a>`;
  }).join("");

  return `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Von Peach — Portrait Gallery</title>
  <style>
    :root {
      --wine:#99112F; --red:#CC1C0E; --orange:#FD8839; --peach:#FFD6BB;
      --bg:#0d0308; --card-bg:#1a0610;
    }
    * { box-sizing:border-box; }
    body {
      margin:0; padding:0; background:var(--bg); color:var(--peach);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      min-height:100vh;
    }
    header {
      padding:32px 24px 16px; display:flex; align-items:center; gap:14px;
      border-bottom:1px solid rgba(255,214,187,0.10);
    }
    header h1 {
      margin:0; font-size:22px; font-weight:800; letter-spacing:0.04em;
      text-transform:uppercase;
    }
    header .total { color:rgba(255,214,187,0.55); font-size:14px; }
    .filters {
      padding:14px 24px; display:flex; flex-wrap:wrap; gap:8px;
      border-bottom:1px solid rgba(255,214,187,0.10);
    }
    .filter {
      display:inline-flex; align-items:center; gap:8px;
      padding:8px 14px; border-radius:999px;
      background:rgba(255,214,187,0.06); color:var(--peach);
      text-decoration:none; font-size:12px; font-weight:700;
      letter-spacing:0.14em; text-transform:uppercase;
      border:1px solid rgba(255,214,187,0.14); transition:background 120ms;
    }
    .filter:hover { background:rgba(255,214,187,0.10); }
    .filter.active { background:linear-gradient(135deg,var(--orange),var(--red) 60%,var(--wine)); border-color:transparent; color:#fff; }
    .filter-count { background:rgba(0,0,0,0.18); padding:2px 8px; border-radius:999px; font-size:11px; }
    .grid {
      display:grid; gap:16px; padding:20px 24px 60px;
      grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));
    }
    .card {
      background:var(--card-bg); border-radius:14px; overflow:hidden;
      text-decoration:none; color:var(--peach);
      box-shadow:0 8px 22px rgba(0,0,0,0.4);
      transition:transform 140ms ease, box-shadow 140ms ease;
      display:flex; flex-direction:column;
    }
    .card:hover { transform:translateY(-2px); box-shadow:0 12px 30px rgba(204,28,14,0.30); }
    .card img { display:block; width:100%; aspect-ratio:3/4; object-fit:cover; background:#1a0610; }
    .meta { padding:10px 14px; display:flex; justify-content:space-between; align-items:center; font-size:12px; gap:8px; }
    .archetype { font-weight:700; text-transform:capitalize; letter-spacing:0.04em; color:var(--orange); }
    .ts { color:rgba(255,214,187,0.55); font-size:11px; }
    .empty { padding:60px 24px; text-align:center; color:rgba(255,214,187,0.55); }
  </style>
</head><body>
  <header>
    <h1>Portrait Gallery</h1>
    <span class="total">${totalCount} total</span>
  </header>
  <div class="filters">
    ${filterLink("", "All")}
    ${filterLink("charmer", "Charmer")}
    ${filterLink("magician", "Magician")}
    ${filterLink("alchemist", "Alchemist")}
  </div>
  ${items.length === 0
    ? `<div class="empty">No portraits yet.${currentFilter ? " Try removing the filter." : ""}</div>`
    : `<div class="grid">${cards}</div>`}
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

// LinkedIn share dialog pre-filled with the campaign URL. LinkedIn scrapes
// the page's OG tags for the preview thumbnail; recipients can attach their
// portrait from the email manually in the compose step.
const LINKEDIN_SHARE_URL =
  "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Ftarot.vonpeach.com";

function emailHtml(name, tagline, paragraphs, imageDataUrl) {
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
  <style>
    @keyframes vp-wiggle {
      0%, 100% { transform: rotate(-1.2deg) translateY(-2px); }
      50%      { transform: rotate(1.2deg)  translateY(2px); }
    }
    .vp-card { animation: vp-wiggle 5s ease-in-out infinite; transform-origin: center; }
    @media (prefers-reduced-motion: reduce) { .vp-card { animation: none; } }
  </style>
</head>
<body style="margin:0;padding:0;background:#0d0308;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#3a0812;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0308;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 14px 38px rgba(153,17,47,0.20);" cellpadding="0" cellspacing="0">

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
          Your portrait is attached. Share it, or keep it close as a reminder of what makes you special.
        </td></tr>

        <!-- Share-on-LinkedIn CTA -->
        <tr><td align="center" style="padding:22px 36px 0 36px;">
          <a href="${LINKEDIN_SHARE_URL}"
             style="display:inline-block;background:linear-gradient(135deg,#FD8839 0%,#CC1C0E 60%,#99112F 100%);color:#FFFFFF;text-decoration:none;padding:14px 28px;border-radius:999px;font-family:inherit;font-weight:800;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;box-shadow:0 8px 18px rgba(204,28,14,0.30);">
            Share on LinkedIn
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

function emailText(name, tagline, paragraphs) {
  return [
    "VON PEACH",
    "",
    name,
    tagline ? tagline : null,
    "",
    ...(paragraphs || []).flatMap((p) => [p, ""]),
    "Your portrait is attached. Share it, or keep it close as a reminder of what makes you special.",
    "",
    "Ready to write the rest of your story?",
    "We'll help you get started.",
    "vonpeach.com",
  ].filter((line) => line !== null).join("\n");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
