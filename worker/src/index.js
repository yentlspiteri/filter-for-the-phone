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

// Four-stage portrait pipeline — the Higgsfield/Aragon approach plus a
// realism finisher:
//
//   1) flux-pulid generates the editorial scene with identity anchored
//      from the user's face (text-prompted, identity-locked).
//        docs: https://fal.ai/models/fal-ai/flux-pulid
//
//   2) advanced face-swap copies the user's ACTUAL face + hair region
//      from the input selfie onto the PuLID result. PuLID gets the
//      scene right but can drift on identity and invents a new
//      hairstyle — this nails both.
//        docs: https://fal.ai/models/fal-ai/easel-ai/advanced-face-swap
//
//   3) CodeFormer polishes the face-swapped result — restores skin
//      detail, lifts the eyes. Light fidelity (0.85) so natural skin
//      texture survives.
//        docs: https://fal.ai/models/fal-ai/codeformer
//
//   4) Clarity Upscaler layers photographic detail throughout — film
//      grain, sharper micro-texture, natural shadow gradients. This is
//      what kills the "AI generated" look. Low creativity + high
//      resemblance so the face/structure is preserved.
//        docs: https://fal.ai/models/fal-ai/clarity-upscaler
//
// Stages 2–4 are best-effort: if any errors, we fall through with the
// most recent successful image so the user always sees a portrait.
const FAL_URL       = "https://fal.run/fal-ai/flux-pulid";
// easel-ai is its own org on fal.ai (NOT nested under fal-ai). Using
// fal.run/fal-ai/easel-ai/* returns 404 "Application 'easel-ai' not found".
const FACE_SWAP_URL = "https://fal.run/easel-ai/face-swap";
const POLISH_URL    = "https://fal.run/fal-ai/codeformer";
const REALISM_URL   = "https://fal.run/fal-ai/clarity-upscaler";
const RESEND_URL = "https://api.resend.com/emails";

// Universal studio-B&W headshot layer — appended to every archetype
// prompt. Locks the photography style across all three archetypes: same
// studio, same lighting, same lens, same backdrop, same photographer
// vocabulary. The three portraits should read as three shots from one
// session — only expression, wardrobe, and prop change.
const FLATTERING =
  " Black and white studio portrait photograph, fine-art monochrome — " +
  "no colour, rich tonal range, deep blacks, luminous mid-tones. " +
  "STUDIO SETUP (identical across all portraits): a large soft-box key " +
  "light at 45 degrees from the camera, GENEROUS reflector fill on the " +
  "opposite side about 1 stop below the key (not heavily shadowed, no " +
  "harsh chiaroscuro), plain mid-grey seamless studio backdrop softly " +
  "graduated darker at the edges. The overall mood is approachable and " +
  "warm — bright editorial portrait, not moody or gloomy. Same studio, " +
  "same lighting, same backdrop, same lens for every portrait — only " +
  "the subject's expression, wardrobe and accessories change. " +
  "Professional editorial HEADSHOT crop: framed from mid-chest to just " +
  "above the top of the head, the eyes positioned on the upper third of " +
  "the frame, the face fills the central area generously. Camera at " +
  "eye-level — NOT from above, NOT from below, NOT tilted. " +
  "The subject's hair is preserved exactly as in the reference image — " +
  "same hairstyle, same length, same texture, same parting, same volume. " +
  "Hair frames the face naturally, falling around the temples; the " +
  "hairline sits where it normally would on the subject's head. The " +
  "forehead is naturally proportioned — NOT exaggerated, NOT enlarged. " +
  "The subject looks their absolute best — clear healthy skin, bright " +
  "well-rested eyes, a subtle natural glow, confident and magnetic. " +
  "Natural balanced facial proportions, soft jawline, gentle chin line — " +
  "do NOT enlarge or exaggerate the chin. Tasteful editorial retouching " +
  "that softens dark circles and " +
  "blemishes while KEEPING natural skin texture, fine pores, faint " +
  "imperfections, subtle fine lines and the real grain of the face — " +
  "not plastic, not over-smoothed. Slight three-quarter angle if at all, " +
  "but mostly face-forward. " +
  "Style: candid editorial B&W photography by a master studio " +
  "photographer in the manner of Yousuf Karsh — confident, dignified, " +
  "slightly cinematic. Shot on a medium-format camera with an 85mm " +
  "portrait prime lens, natural film-like fall-off, fine silver-gelatin " +
  "grain, the texture of fine art black-and-white photography. Shallow " +
  "depth of field, beautiful soft bokeh. No text, no logos, no " +
  "watermark, no overly-stylised illustration look, no colour cast.";

// Archetype prompts diverge ONLY on expression + wardrobe + prop.
// Lighting, backdrop, lens, crop and tonal treatment all live in the
// shared FLATTERING block above.
//
// Each archetype carries a POOL of 5 props that the Worker randomly
// picks from at request time, so two people landing on the same
// archetype get visually distinct portraits.
const PROMPT_TEMPLATES = {
  charmer: {
    base:
      "Editorial B&W studio headshot. Expression: a genuine warm smile " +
      "that reaches the eyes, slightly parted lips, an inviting open " +
      "expression — magnetic and welcoming, like greeting a close " +
      "friend. Wardrobe: contemporary open-collar shirt or fine knit, " +
      "no jacket. ",
    props: [
      "Prop: holds a vintage crystal champagne coupe casually at chest " +
        "height, slightly tilted, the glass surface catching the " +
        "side-light in a single bright highlight along the rim — " +
        "old-money charm, mid-toast, not raised in cheers. Hand relaxed " +
        "around the stem.",
      "Prop: a single fresh white camellia bloom tucked at the lapel " +
        "or held loosely near the collarbone, petals catching a soft " +
        "highlight against the dark wardrobe.",
      "Prop: holds a folded handwritten letter or a wax-sealed envelope " +
        "casually between the fingers near the chest, paper texture " +
        "visible in the side-light — the gesture of someone about to " +
        "share a secret.",
      "Prop: a vintage silk scarf draped casually over one shoulder, " +
        "the fabric catching soft highlights and folds — elegant, lived-in, " +
        "considered styling without being theatrical.",
      "Prop: wears a single pearl earring catching the side-light in a " +
        "small bright highlight, a quiet Vermeer-style detail. No other " +
        "visible jewellery.",
    ],
  },
  magician: {
    base:
      "Editorial B&W studio headshot. Expression: a playful confident " +
      "half-smile with a knowing glint in the eye — mischief and " +
      "intelligence, the kind of person who's about to show you " +
      "something brilliant. Approachable, not stern. Wardrobe: sleek " +
      "dark turtleneck or a structured dark jacket. ",
    props: [
      "Prop: holds a fanned spread of three tarot cards between thumb " +
        "and forefinger, raised near the chest, the backs of the cards " +
        "facing the camera with an ornate geometric pattern visible. " +
        "Hand poised, fingers elegant. A faint wisp of smoke catches " +
        "the side-light just behind the shoulder for atmosphere.",
      "Prop: a vintage pocket watch on a fine chain dangling from the " +
        "breast pocket, the brass casing catching a single bright " +
        "side-light highlight, the chain looping elegantly across the " +
        "front of the jacket.",
      "Prop: holds a single antique coin pinched between thumb and " +
        "forefinger, raised near the cheekbone at chest height — the " +
        "edge of the coin catching the side-light in a sharp metallic " +
        "highlight, a sleight-of-hand pose.",
      "Prop: wears an antique brass key on a fine chain at the throat, " +
        "the key resting flat against the dark wardrobe, catching a " +
        "single bright highlight in the side-light.",
      "Prop: holds a single ornate playing card pinched edge-on between " +
        "two fingers at chest height, the card's back pattern catching " +
        "the side-light. A faint wisp of smoke drifts past the shoulder " +
        "for atmosphere.",
    ],
  },
  alchemist: {
    base:
      "Editorial B&W studio headshot. Expression: a calm warm " +
      "contemplative expression with a small natural smile playing at " +
      "the corners of the mouth — quiet inner authority but visibly " +
      "kind, the look of someone who's pleased you've stopped by. " +
      "Wardrobe: refined intellectual attire — a fine knit, a tweed " +
      "jacket, or considered tailoring. ",
    props: [
      "Prop: wears a classic monocle fixed in one eye by a fine chain, " +
        "with a hint of leather-bound books or a vintage brass instrument " +
        "just visible in the soft-focus background.",
      "Prop: holds a vintage fountain pen poised mid-thought between " +
        "thumb and forefinger near the chin, the polished nib catching " +
        "a small highlight — the gesture of someone about to write " +
        "down a thought.",
      "Prop: holds a small antique brass compass or astrolabe at chest " +
        "height, the engraved metal catching the side-light, hand " +
        "cradling it carefully like an instrument worth studying.",
      "Prop: holds a vintage magnifying glass near the chest, the round " +
        "glass catching a soft highlight, a scholar mid-investigation. " +
        "Faint suggestion of an old notebook or papers in the soft-focus " +
        "background.",
      "Prop: an open leather-bound notebook held at the chest with fine " +
        "ink sketches and handwriting just visible on the page, a " +
        "fountain pen tucked into the binding.",
    ],
  },
  oracle: {
    base:
      "Editorial B&W studio headshot. Expression: a serene knowing " +
      "expression, gentle small smile, eyes carrying a quiet depth — " +
      "the look of someone who's already seen where this conversation " +
      "is going. Wardrobe: a flowing soft drape, fine knit, or " +
      "considered tailoring in a calm tone. ",
    props: [
      "Prop: cradles a small smoky-quartz crystal in the palm at chest " +
        "height, the faceted surface catching the side-light in small " +
        "sharp highlights.",
      "Prop: holds a small bundle of dried sage delicately between " +
        "two fingers near the chest, a thin wisp of pale smoke drifting " +
        "up past the shoulder.",
      "Prop: holds a vintage hand-mirror at a slight angle near the " +
        "shoulder, the glass catching a soft luminous highlight — only " +
        "the back of the mirror's frame is visible, not the reflection.",
      "Prop: cradles a silk-wrapped tarot deck in one hand, the cards " +
        "edge-on, the silk fabric catching soft folds of light.",
      "Prop: holds a small clear glass orb pinched between thumb and " +
        "forefinger near the cheekbone, the orb catching one bright " +
        "specular highlight at its centre.",
    ],
  },
  rebel: {
    base:
      "Editorial B&W studio headshot. Expression: a wry confident " +
      "half-smile, sharp direct eyes, slight chin-tilt — the look of " +
      "someone who's already broken the rule you were about to mention. " +
      "Wardrobe: a worn leather jacket, vintage band tee, or sharp " +
      "structured wear with a punk edge. ",
    props: [
      "Prop: wears a worn black leather jacket with the collar turned " +
        "up, the leather catching side-light highlights along its grain.",
      "Prop: wears a single fingerless black leather glove on the hand " +
        "raised at chest height, the textured leather catching highlights.",
      "Prop: wears a vintage motorcycle key on a thick chain around the " +
        "throat, the key resting at the centre of the chest catching " +
        "one bright highlight.",
      "Prop: wears a heavy silver signet ring on the index finger, the " +
        "hand resting at the collarbone, the polished metal catching a " +
        "small bright highlight.",
      "Prop: a patched bomber jacket worn open over a vintage band tee, " +
        "subtle embroidered patches just visible at the lapel.",
    ],
  },
  monk: {
    base:
      "Editorial B&W studio headshot. Expression: a calm centred " +
      "expression with a small soft smile, eyes closed gently in some " +
      "frames or open in quiet directness — present, unhurried, " +
      "approachable. Wardrobe: simple natural cloth, a plain shawl, " +
      "or considered minimal layers in muted tones. ",
    props: [
      "Prop: holds wooden mala prayer beads draped over the fingers " +
        "at chest height, the beads catching small soft highlights.",
      "Prop: holds a single white lily stem delicately at the chest, " +
        "petals catching the side-light against the dark wardrobe.",
      "Prop: cradles a small handmade clay teacup between both palms " +
        "at chest height, gentle hands warming around it.",
      "Prop: holds an open cloth-bound simple book at the chest, hands " +
        "framing the spine, paper catching the side-light.",
      "Prop: holds a small wooden meditation singing-bowl cupped " +
        "between the hands at chest height, the wood catching warm " +
        "highlights.",
    ],
  },
  architect: {
    base:
      "Editorial B&W studio headshot. Expression: a focused considered " +
      "expression with a faint pleased smile at the corner of the " +
      "mouth, sharp eyes that look like they're sketching something " +
      "behind the camera. Wardrobe: clean modern tailoring, a fine " +
      "structured shirt or a precisely-cut jacket. ",
    props: [
      "Prop: holds a vintage brass architect's compass / divider in " +
        "one hand at chest height, the polished metal arms catching " +
        "the side-light.",
      "Prop: holds a rolled paper blueprint tucked casually under one " +
        "arm at the chest, the edge of architectural drawings just " +
        "visible at the open end.",
      "Prop: holds a finely sharpened drafting pencil poised between " +
        "thumb and forefinger near the chin, mid-thought.",
      "Prop: holds an open sketchbook at the chest with clean geometric " +
        "line drawings just visible on the page.",
      "Prop: cradles a small precise metal geometric sculpture (a " +
        "polished brass cube or icosahedron) in one palm, hand raised " +
        "to chest height.",
    ],
  },
  luminary: {
    base:
      "Editorial B&W studio headshot. Expression: an open confident " +
      "smile that reaches the eyes, easy magnetic presence, the look " +
      "of someone who walks into a room and brings the light with " +
      "them. Wardrobe: a sharp tailored jacket, a fine knit, or a " +
      "considered statement piece. ",
    props: [
      "Prop: wears a single statement signet ring on the index finger, " +
        "the polished metal catching a bright side-light highlight, " +
        "hand raised to the collarbone.",
      "Prop: wears a small enamel-and-gold lapel pin at the chest, " +
        "the metal trim catching a small bright highlight.",
      "Prop: a confident hand-on-chin pose, fingers gently against the " +
        "jawline, eyes meeting the camera.",
      "Prop: wears a heavy fine-link chain at the throat, resting just " +
        "below the collar, the links catching highlights.",
      "Prop: wears a small ornate medallion on a fine chain at the " +
        "chest, the medallion's centre catching a clear single " +
        "highlight.",
    ],
  },
};

function getPromptFor(archetype) {
  const t = PROMPT_TEMPLATES[archetype];
  if (!t) return null;
  const prop = t.props[Math.floor(Math.random() * t.props.length)];
  return t.base + prop + FLATTERING;
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

// ---------- pipeline: runs all four AI stages, returns a data URL ----------
async function runPortraitPipeline(env, image, archetype) {
  const prompt = getPromptFor(archetype);
  if (!prompt) throw new Error("unknown_archetype");
  if (!env.FAL_KEY) throw new Error("no_fal_key");

  const t0 = Date.now();
  console.log(`[pipeline] start archetype=${archetype}`);

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
        num_inference_steps: 12,      // dropped from 16 → 12 — floor before quality drops, saves another ~2-3s
        guidance_scale: 4,
        true_cfg: 1,
        id_weight: 0.9,               // 0.9 = strong likeness + just enough latitude to flatter
        num_images: 1,
        output_format: "jpeg",
        enable_safety_checker: true,
        negative_prompt:
          "colour, color photograph, colour cast, warm tones, sepia, " +
          "blurry, out of focus, low quality, distorted face, wrong identity, " +
          "different person, cartoon, painting, illustration, anime, watermark, " +
          "text, tired, exhausted, bags under eyes, dark circles, harsh shadows " +
          "on face, harsh under-lighting, double chin, unflattering angle, " +
          "low angle from below, high angle from above, tilted camera, " +
          "oversized forehead, exaggerated forehead, enlarged forehead, " +
          "tall forehead, exposed forehead, high hairline, receding hairline, " +
          "big chin, oversized chin, prominent chin, exaggerated chin, " +
          "jutting chin, lantern jaw, heavy jaw, masculine square jaw, " +
          "wide jaw, bulky jawline, " +
          "tight ponytail, slicked-back hair, hair pulled back, wet hair, " +
          "wide-angle distortion, fisheye, head proportions wrong, " +
          "oily skin, blemishes, acne, red skin, wrinkled, aged, dull skin, " +
          "washed out, flat lighting, ugly, asymmetric face, deformed, bad anatomy, " +
          "different hairstyle, restyled hair, recoloured hair, dyed hair, " +
          "longer hair, shorter hair, changed haircut, wig, hat, headwear, " +
          "head covering, hair extensions, " +
          "AI generated look, plastic skin, over-smoothed, waxy skin, " +
          "fake, synthetic, CGI, 3D render, doll-like, uncanny, airbrushed, " +
          "perfect symmetry, glossy, polished plastic, smooth perfection, " +
          "stern, gloomy, melancholic, joyless, severe, sad, depressed, " +
          "scowling, frowning, grim, moody, sombre, heavy shadows on the " +
          "face, deep chiaroscuro, low-key lighting",
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

  // The "current best" URL — each stage overwrites if it succeeds.
    let workingUrl = pulidUrl;

    // Step 2: Face-swap. Copies the user's actual face geometry from the
    // input selfie onto the PuLID result. Locks identity.
    try {
      const swapRes = await fetch(FACE_SWAP_URL, {
        method: "POST",
        headers: {
          Authorization: `Key ${env.FAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source_image_url: image,     // user's selfie (face to use)
          target_image_url: pulidUrl,  // PuLID scene (face to replace)
        }),
      });
      if (swapRes.ok) {
        const swapData = await swapRes.json();
        const swappedUrl =
          swapData?.image?.url ||
          swapData?.images?.[0]?.url ||
          swapData?.output_url;
        if (swappedUrl) workingUrl = swappedUrl;
        console.log(`[pipeline] face-swap ok t+${Date.now()-t0}ms`);
      } else {
        console.warn(`[pipeline] face-swap failed status=${swapRes.status} detail=${(await swapRes.text()).slice(0,300)}`);
      }
    } catch (swapErr) {
      console.warn(`[pipeline] face-swap threw: ${swapErr?.message}`);
    }

    // Step 3: CodeFormer face-detail polish (best-effort). Operates on the
    // face-swapped result so the polish applies to the user's actual face.
    try {
      const polishRes = await fetch(POLISH_URL, {
        method: "POST",
        headers: {
          Authorization: `Key ${env.FAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: workingUrl,
          fidelity: 0.85,          // 0..1 — higher = stays closer to swapped face / more natural texture; lower = more over-polished
          upscaling: 1,            // leave the upscale to step 4 so we don't compound
          face_upsample: true,
          background_enhance: false,
        }),
      });
      if (polishRes.ok) {
        const polishData = await polishRes.json();
        const polishedUrl =
          polishData?.image?.url ||
          polishData?.images?.[0]?.url ||
          polishData?.output_url;
        if (polishedUrl) workingUrl = polishedUrl;
        console.log(`[pipeline] CodeFormer ok t+${Date.now()-t0}ms`);
      } else {
        console.warn(`[pipeline] CodeFormer failed status=${polishRes.status} detail=${(await polishRes.text()).slice(0,300)}`);
      }
    } catch (polishErr) {
      console.warn(`[pipeline] CodeFormer threw: ${polishErr?.message}`);
    }

    // Step 4: Clarity Upscaler realism pass (best-effort). Low creativity
    // so the face/structure doesn't shift; high resemblance so the
    // upscaler treats the input as authoritative. Result: photographic
    // texture and grain layered onto an otherwise AI-flat image.
    try {
      const realismRes = await fetch(REALISM_URL, {
        method: "POST",
        headers: {
          Authorization: `Key ${env.FAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: workingUrl,
          prompt:
            "Black and white studio portrait photograph, fine silver-gelatin " +
            "grain, real-camera photographic detail, natural skin texture with " +
            "subtle fine pores, shot on 85mm prime lens, photorealistic, " +
            "monochrome editorial portrait",
          negative_prompt:
            "colour, color photograph, colour cast, sepia, " +
            "AI generated, plastic skin, over-smoothed, fake, synthetic, " +
            "CGI, render, doll-like, uncanny, airbrushed, glossy, " +
            "oversized forehead, exaggerated head proportions",
          creativity:  0.3,        // low — don't reinvent, just add detail
          resemblance: 0.7,        // high — preserve the input structure
          upscale_factor: 1,       // keep 1× — 2× was pushing the pipeline past Cloudflare's waitUntil window
          num_inference_steps: 10, // halved from 18 — fastest setting that still adds visible grain
          guidance_scale: 3,
        }),
      });
      if (realismRes.ok) {
        const realismData = await realismRes.json();
        const realismOut =
          realismData?.image?.url ||
          realismData?.images?.[0]?.url ||
          realismData?.output_url;
        if (realismOut) workingUrl = realismOut;
        console.log(`[pipeline] Clarity ok t+${Date.now()-t0}ms`);
      } else {
        console.warn(`[pipeline] Clarity failed status=${realismRes.status} detail=${(await realismRes.text()).slice(0,300)}`);
      }
    } catch (realismErr) {
      console.warn(`[pipeline] Clarity threw: ${realismErr?.message}`);
    }

  // Proxy the final image as inline base64 — avoids cross-origin canvas
  // taint and keeps fal.ai's transient URLs off the client.
  console.log(`[pipeline] fetching final image t+${Date.now()-t0}ms`);
  const imgRes = await fetch(workingUrl);
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
