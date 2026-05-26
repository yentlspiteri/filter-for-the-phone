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
const FAL_URL = "https://fal.run/fal-ai/flux-pulid";
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
  "STRICTLY LIMITED PALETTE: warm peach background / paper (#FFD6BB), " +
  "deep wine red (#99112F) for linework, shadows and fills, brand " +
  "orange (#FD8839) for highlights and warm accents, brand red " +
  "(#CC1C0E) for flames and bold accents. ";

const STYLE_TRAIL =
  " The face is rendered in the SAME bold ink-illustration language as " +
  "the rest of the figure — large drawn comic-style eyes with bright " +
  "visible pupils, drawn lips with clear shape, drawn nose lines, " +
  "cel-shaded skin in peach-wine tones with heavy outline, vivid " +
  "animated-character expression. The hairstyle, hair length, hair " +
  "colour, face shape and overall identity should resemble the " +
  "reference subject — but rendered as an animated graphic-novel " +
  "character, not a photograph. The background fills every corner of " +
  "the frame with densely illustrated thematic motifs that tell the " +
  "archetype's story (buildings, weather, props, creatures, smoke or " +
  "flame patterns appropriate to the scene). No text on the card, no " +
  "caption, no banner, no logo, no watermark. No photographic skin " +
  "texture, no photographic eyes, no skin pores, no real hair strands, " +
  "no off-palette hues, no white empty margins, no stiff frontal " +
  "beauty-pose composition, no flat blank background.";

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
      "welcoming gesture, warm magnetic smile. Background swirling " +
      "with decorative ribbon-like patterns and scattered roses. ",
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
      "figure in a flowing hooded robe with rune-embroidered edges, " +
      "one hand raised commanding the elements, sharp determined " +
      "gaze. Background swirling with abstract flame patterns and " +
      "runic glyphs. ",
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
      "figure in a heavy rune-embroidered robe in deep wine red with " +
      "orange accents, focused determined expression, one hand " +
      "gesturing over a steaming vessel. Background swirling with " +
      "smoke and runic transformation symbols. ",
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
      "figure in flowing layered robes catching peach and wine " +
      "highlights, a serene knowing expression with eyes that seem " +
      "to look past the viewer. Background filled with stars, " +
      "celestial swirls, and abstract eye motifs. ",
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
      "Background of cracked stone, jagged flame patterns, and " +
      "broken chain motifs. ",
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
      "a meditative cross-legged pose or standing serenely, wearing a " +
      "simple draped robe in peach and wine tones, eyes gently " +
      "closed or open with quiet directness. Background of radiating " +
      "lines, lotus petals, and abstract mountain silhouettes. ",
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
      "considered expression. Background filled with blueprint grid " +
      "lines, geometric structures, and abstract cityscape " +
      "silhouettes in peach and wine. ",
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
      "figure in a regal robe or sharp ceremonial coat with " +
      "ornamental trim, open confident smile, radiant presence. " +
      "Background of radial sun-rays, decorative halo motifs, and " +
      "abstract throne silhouettes. ",
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
  return (
    `THE SUBJECT IS ${desc.toUpperCase()}. The figure MUST be ${desc} — ` +
    `match the gender, hairstyle, hair colour (or baldness), facial hair and ` +
    `eye colour exactly. Do NOT change the subject's gender. ` +
    (/\bman\b|male/i.test(subject.gender || "")
      ? "This is a MALE figure with masculine features and build. "
      : "") +
    (/bald|balding|shaved head|no hair/i.test(subject.hair || "")
      ? "The figure is BALD with no hair on top of the head. "
      : "")
  );
}

function getPromptFor(archetype, subject) {
  const t = PROMPT_TEMPLATES[archetype];
  if (!t) return null;
  const prop = t.props[Math.floor(Math.random() * t.props.length)];
  // STYLE_LEAD goes FIRST — PuLID/Flux weight the first prompt tokens
  // most heavily, and we need the "flat illustration, not a photograph"
  // directive to win against Flux's photo bias. The subject directive comes
  // immediately after so identity (gender/hair/eyes) is locked early too.
  return STYLE_LEAD + buildSubjectDirective(subject) + t.base + prop + STYLE_TRAIL;
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

    // GET routes for the admin gallery
    if (request.method === "GET") {
      if (url.pathname === "/gallery")               return handleGallery(request, env, url);
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
async function handlePortrait(request, env, ctx, cors) {
  try {
    const { image, archetype } = (await request.json()) || {};
    if (!image || !archetype) return jsonResp({ error: "missing_fields" }, 400, cors);
    const dataUrl = await runPortraitPipeline(env, image, archetype);
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
    const { image, archetype, archetypeName, email } = body;
    if (!image || !archetype || !email)  return jsonResp({ error: "missing_fields" }, 400, cors);
    if (!isValidEmail(email))            return jsonResp({ error: "invalid_email" }, 400, cors);
    if (!PROMPT_TEMPLATES[archetype])    return jsonResp({ error: "unknown_archetype" }, 400, cors);

    ctx.waitUntil((async () => {
      const bgT0 = Date.now();
      console.log(`[portrait-email] background start email=${email} archetype=${archetype}`);
      try {
        const portraitDataUrl = await runPortraitPipeline(env, image, archetype);
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
// Runs the user's photo through Workers AI (Llama 3.2 Vision) and extracts the
// few attributes that PuLID was losing: gender, hair colour/length or baldness,
// facial hair, eye colour, skin tone. Returns a plain object the prompt builder
// turns into a hard directive, or null if the AI binding is missing / the call
// fails (in which case we fall back to the old identity-silent behaviour).
async function describeSubject(env, imageDataUrl) {
  if (!env.AI) return null;
  try {
    const b64 = String(imageDataUrl).split(",").pop();
    const bytes = base64ToUint8Array(b64);
    const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      // Image as a byte array per Workers AI vision input contract.
      image: [...bytes],
      max_tokens: 256,
      messages: [
        {
          role: "system",
          content:
            "You are a precise facial-attribute extractor for an illustration " +
            "pipeline. Look at the single most prominent face in the photo and " +
            "report only what you can clearly see. Respond with STRICT JSON " +
            "only — no prose, no markdown — using exactly these keys: " +
            '{"gender":"man"|"woman", "age":"young adult"|"adult"|"middle-aged"|"older", ' +
            '"hair":"<colour + length, e.g. short dark brown hair> OR bald OR shaved head", ' +
            '"facial":"clean-shaven" | "<beard/moustache description>", ' +
            '"eyes":"<eye colour> eyes", "skin":"<skin tone> skin"}. ' +
            "If the person clearly has no hair, set hair to \"bald\". " +
            "Never omit the gender key.",
        },
        { role: "user", content: "Describe this person's visible attributes as JSON." },
      ],
    });
    const raw = (out && (out.response ?? out.description ?? out.text)) || "";
    const subject = parseSubjectJson(raw);
    if (subject) console.log(`[pipeline] subject=${JSON.stringify(subject)}`);
    return subject;
  } catch (err) {
    console.warn(`[pipeline] subject describe failed: ${err?.message}`);
    return null;
  }
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
    const subject = {
      gender: clean(obj.gender),
      age: clean(obj.age),
      hair: clean(obj.hair),
      facial: clean(obj.facial),
      eyes: clean(obj.eyes),
      skin: clean(obj.skin),
    };
    // Gender is the attribute we most need; if it's missing the rest is noise.
    return subject.gender ? subject : null;
  } catch {
    return null;
  }
}

// ---------- pipeline: runs all four AI stages, returns a data URL ----------
async function runPortraitPipeline(env, image, archetype) {
  if (!PROMPT_TEMPLATES[archetype]) throw new Error("unknown_archetype");
  if (!env.FAL_KEY) throw new Error("no_fal_key");

  const t0 = Date.now();
  console.log(`[pipeline] start archetype=${archetype}`);

  // Vision pre-pass first so the descriptor can be baked into the prompt.
  const subject = await describeSubject(env, image);
  const prompt = getPromptFor(archetype, subject);
  console.log(`[pipeline] subject pre-pass done t+${Date.now()-t0}ms hasSubject=${!!subject}`);

  const falRes = await fetch(FAL_URL, {
      method: "POST",
      headers: {
        Authorization: `Key ${env.FAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        reference_image_url: image,   // user's face — PuLID anchors on this
        image_size: "portrait_4_3",   // editorial portrait crop
        num_inference_steps: 22,      // illustration benefits from a few more steps for clean line work
        guidance_scale: 7,            // pushed up hard — Flux base has a photo bias; high CFG forces the illustration prompt to win
        true_cfg: 1,
        id_weight: 0.5,               // dropped further — at 0.7 the FACE region was still photographic against an illustrated body. 0.5 lets the face cartoonify too while still resembling the subject
        num_images: 1,
        output_format: "jpeg",
        enable_safety_checker: true,
        negative_prompt:
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
          "thin sparse linework, faint outlines, washed-out colours, " +
          "flat poster art, sticker-like figure, low-detail background, " +
          "anime, manga, chibi, 3D render, CGI, sculpture, statue, " +
          "deformed face, asymmetric face, distorted face, bad anatomy, " +
          "watermark, text, caption, banner, signature, logo, " +
          "complex gradients, rainbow colours, full colour palette, " +
          "blue, green, purple, yellow, brown",
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
// archetypeName, image } object. multipart is the preferred form for the
// /portrait-email upload because it skips the CORS preflight that some
// mobile Safari builds were silently failing after.
async function readMixedBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await request.formData();
    let image = null;
    const imageField = fd.get("image");
    if (imageField && typeof imageField !== "string") {
      const buf = await imageField.arrayBuffer();
      const mime = imageField.type || "image/jpeg";
      image = `data:${mime};base64,${arrayBufferToBase64(buf)}`;
    } else if (typeof imageField === "string") {
      image = imageField;
    }
    return {
      email:         fd.get("email") || null,
      archetype:     fd.get("archetype") || null,
      archetypeName: fd.get("archetypeName") || null,
      image,
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

// GET /portrait-image/<key>?key=<GALLERY_KEY>
//   Streams the underlying JPEG from R2. Passcode-gated.
async function handlePortraitImage(_request, env, url) {
  if (!env.GALLERY_KEY) return new Response("Gallery key not configured.", { status: 500 });
  const auth = url.searchParams.get("key") || "";
  if (auth !== env.GALLERY_KEY) return new Response("Forbidden.", { status: 403 });
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
      "Cache-Control": "private, max-age=300",
    },
  });
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
