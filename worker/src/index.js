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
const FACE_SWAP_URL = "https://fal.run/fal-ai/easel-ai/advanced-face-swap";
const POLISH_URL    = "https://fal.run/fal-ai/codeformer";
const REALISM_URL   = "https://fal.run/fal-ai/clarity-upscaler";
const RESEND_URL = "https://api.resend.com/emails";

// Universal studio-B&W headshot layer — appended to every archetype
// prompt. Locked aesthetic across all three archetypes (consistency
// hides face-swap colour-tone shifts) and shifts the differentiation
// to expression, lighting hardness, and wardrobe. Crop + framing
// instructions are explicit to prevent the forehead-heavy
// disproportion we've seen ("hair frames the face, mid-chest crop,
// eye-level camera, hairline natural").
const FLATTERING =
  " Black and white studio portrait photograph, fine-art monochrome — " +
  "no colour, rich tonal range, deep blacks, luminous mid-tones. " +
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
  "well-rested eyes, sharp jawline, a subtle natural glow, confident and " +
  "magnetic. Tasteful editorial retouching that softens dark circles and " +
  "blemishes while KEEPING natural skin texture, fine pores, faint " +
  "imperfections, subtle fine lines and the real grain of the face — " +
  "not plastic, not over-smoothed. Slight three-quarter angle if at all, " +
  "but mostly face-forward. " +
  "Style: candid editorial B&W photography by a professional studio " +
  "photographer. Shot on a medium-format camera with an 85mm portrait " +
  "prime lens, natural film-like fall-off, fine silver-gelatin grain, " +
  "the texture of fine art black-and-white photography. Shallow depth of " +
  "field, beautiful soft bokeh. No text, no logos, no watermark, no " +
  "overly-stylised illustration look, no colour cast.";

const PROMPTS = {
  charmer:
    "Black and white studio editorial headshot. Warm soft Rembrandt-style " +
    "lighting from one side with gentle fill on the other, the kind of " +
    "soft sidelight that flatters the cheekbones. The subject wears " +
    "contemporary professional attire — an open-collar shirt or fine " +
    "knit, no jacket needed. A warm relaxed open expression, a hint of " +
    "a natural half-smile, eyes engaging the camera with quiet warmth. " +
    "Plain softly-lit studio backdrop, mid-grey tone. In the manner of " +
    "an Annie Leibovitz B&W editorial portrait." + FLATTERING,
  magician:
    "Black and white studio editorial headshot. Hard side-light from a " +
    "single key, deep velvety shadows on the other side of the face " +
    "while the lit side stays sharply detailed — high-contrast " +
    "chiaroscuro. The subject wears a sleek dark turtleneck or a " +
    "structured dark jacket. A knowing slight smirk, sharp intelligent " +
    "eyes that read the viewer. Plain dark studio backdrop, near-black. " +
    "In the manner of Platon's stark editorial portraits." + FLATTERING,
  alchemist:
    "Black and white studio editorial headshot. Gentle even diffused " +
    "lighting from a large soft source, slight directional shaping. The " +
    "subject wears refined intellectual attire — a fine knit, a tweed " +
    "jacket, or considered tailoring; optionally subtle glasses. A calm " +
    "steady contemplative expression, a quiet inner authority at the " +
    "corners of the eyes. Plain softly-lit studio backdrop, mid-to-dark " +
    "grey. In the manner of a New Yorker profile B&W portrait." + FLATTERING,
};

// Short, archetype-specific notes sent in the email body alongside the card.
const READS = {
  charmer: {
    name: "The Charmer",
    note:
      "You move through rooms like warm light — people say yes before they know why. " +
      "Your gift is making the room feel chosen. Used well, it earns trust faster than " +
      "any pitch; used carelessly, it can read as performance. This week, pick one " +
      "conversation where the most charming thing you can do is hold a silence.",
  },
  magician: {
    name: "The Magician",
    note:
      "Where others see a wall, you see a curtain. You reframe the obvious so the new " +
      "answer feels inevitable in hindsight. Your gift is making old constraints stop " +
      "applying. The trap is dazzling for its own sake. This week, pick one problem " +
      "where the smartest move is to bore people with the solution.",
  },
  alchemist: {
    name: "The Alchemist",
    note:
      "You take the raw and the broken and turn it to gold. Slow fire, true gold. Your " +
      "gift is patience with messy beginnings — and a refusal to let them stay messy. " +
      "The risk is over-polishing. This week, pick one piece of work you'd normally " +
      "keep refining, and let it leave your hands one revision sooner.",
  },
};

export default {
  async fetch(request, env) {
    // Tighten this to your deployed origin once everything works:
    //   "Access-Control-Allow-Origin": "https://tarot.vonpeach.com"
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, cors);

    const url = new URL(request.url);
    if (url.pathname === "/portrait")  return handlePortrait(request, env, cors);
    if (url.pathname === "/send-card") return handleSendCard(request, env, cors);
    return jsonResp({ error: "not_found", path: url.pathname }, 404, cors);
  },
};

// ---------- /portrait ----------
async function handlePortrait(request, env, cors) {
  try {
    const { image, archetype } = (await request.json()) || {};
    if (!image || !archetype)  return jsonResp({ error: "missing_fields" }, 400, cors);
    const prompt = PROMPTS[archetype];
    if (!prompt)               return jsonResp({ error: "unknown_archetype" }, 400, cors);
    if (!env.FAL_KEY)          return jsonResp({ error: "no_fal_key" }, 500, cors);

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
        num_inference_steps: 24,
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
          "tight ponytail, slicked-back hair, hair pulled back, wet hair, " +
          "wide-angle distortion, fisheye, head proportions wrong, " +
          "oily skin, blemishes, acne, red skin, wrinkled, aged, dull skin, " +
          "washed out, flat lighting, ugly, asymmetric face, deformed, bad anatomy, " +
          "different hairstyle, restyled hair, recoloured hair, dyed hair, " +
          "longer hair, shorter hair, changed haircut, wig, hat, headwear, " +
          "head covering, hair extensions, " +
          "AI generated look, plastic skin, over-smoothed, waxy skin, " +
          "fake, synthetic, CGI, 3D render, doll-like, uncanny, airbrushed, " +
          "perfect symmetry, glossy, polished plastic, smooth perfection",
      }),
    });

    if (!falRes.ok) {
      const detail = await falRes.text();
      return jsonResp({ error: "upstream", status: falRes.status, detail }, 502, cors);
    }

    const data = await falRes.json();
    const pulidUrl = data?.images?.[0]?.url;
    if (!pulidUrl) return jsonResp({ error: "no_image", data }, 502, cors);

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
      } else {
        console.warn("Face-swap failed:", swapRes.status, await swapRes.text());
      }
    } catch (swapErr) {
      console.warn("Face-swap threw:", swapErr?.message);
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
      } else {
        console.warn("CodeFormer polish failed:", polishRes.status, await polishRes.text());
      }
    } catch (polishErr) {
      console.warn("CodeFormer polish threw:", polishErr?.message);
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
          upscale_factor: 2,       // 2x — sharper micro-detail, manageable size
          num_inference_steps: 18,
          guidance_scale: 4,
        }),
      });
      if (realismRes.ok) {
        const realismData = await realismRes.json();
        const realismOut =
          realismData?.image?.url ||
          realismData?.images?.[0]?.url ||
          realismData?.output_url;
        if (realismOut) workingUrl = realismOut;
      } else {
        console.warn("Clarity realism pass failed:", realismRes.status, await realismRes.text());
      }
    } catch (realismErr) {
      console.warn("Clarity realism pass threw:", realismErr?.message);
    }

    // Proxy the final image as inline base64 — avoids cross-origin canvas
    // taint and keeps fal.ai's transient URLs off the client.
    const imgRes = await fetch(workingUrl);
    if (!imgRes.ok) return jsonResp({ error: "image_fetch_failed", status: imgRes.status }, 502, cors);
    const buf = await imgRes.arrayBuffer();
    const dataUrl = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;

    return jsonResp({ image: dataUrl }, 200, cors);
  } catch (err) {
    return jsonResp({ error: "server", message: err?.message }, 500, cors);
  }
}

// ---------- /send-card ----------
async function handleSendCard(request, env, cors) {
  try {
    const { email, archetype, archetypeName, image } = (await request.json()) || {};
    if (!email || !archetype || !image) return jsonResp({ error: "missing_fields" }, 400, cors);
    if (!isValidEmail(email))           return jsonResp({ error: "invalid_email" }, 400, cors);
    if (!env.RESEND_KEY)                return jsonResp({ error: "no_resend_key" }, 500, cors);

    const read = READS[archetype];
    const name = read?.name || archetypeName || "your archetype";
    const note = read?.note || "";
    const from = env.FROM_EMAIL || "Von Peach <onboarding@resend.dev>";

    // Strip "data:image/jpeg;base64," prefix — Resend wants raw base64.
    const b64 = String(image).split(",").pop();

    const payload = {
      from,
      to: [email],
      subject: `Your Von Peach photo — ${name}`,
      html: emailHtml(name, note, image),
      text: emailText(name, note),
      attachments: [
        { filename: `von-peach-${archetype}.jpg`, content: b64 },
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
      return jsonResp({ error: "resend_upstream", status: res.status, detail }, 502, cors);
    }

    const data = await res.json();
    return jsonResp({ ok: true, id: data?.id }, 200, cors);
  } catch (err) {
    return jsonResp({ error: "server", message: err?.message }, 500, cors);
  }
}

// ---------- helpers ----------
function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
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

// Where the email pulls the logo from. Must be publicly fetchable.
const LOGO_URL = "https://tarot.vonpeach.com/vonpeach-logo.png";

function emailHtml(name, note, imageDataUrl) {
  const safe = (note || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Light cream theme — the brand logo PNG is black, so a light background
  // is the only reliable way for it to render across email clients.
  // Order: logo → portrait → archetype title → body → centered linked
  // vonpeach.com. The portrait is embedded inline as a data URL so the
  // recipient sees the result without having to open the attachment first.
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#FFF6EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#3a0812;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF6EE;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 8px 32px rgba(58,8,18,0.08);" cellpadding="0" cellspacing="0">
        <tr><td style="padding:36px 36px 8px 36px;">
          <img src="${LOGO_URL}" alt="Von Peach" width="180" style="display:block;width:180px;height:auto;border:0;outline:none;" />
        </td></tr>
        <tr><td style="padding:20px 36px 0 36px;">
          <img src="${imageDataUrl}" alt="${name}" style="display:block;width:100%;max-width:448px;height:auto;border-radius:10px;border:0;outline:none;" />
        </td></tr>
        <tr><td style="padding:24px 36px 0 36px;">
          <h1 style="margin:0;font-size:28px;font-weight:800;color:#99112F;letter-spacing:-0.01em;line-height:1.2;">${name}</h1>
        </td></tr>
        <tr><td style="padding:16px 36px 0 36px;font-size:15px;line-height:1.6;color:#3a0812;">
          ${safe}
        </td></tr>
        <tr><td style="padding:24px 36px 0 36px;font-size:13px;line-height:1.55;color:rgba(58,8,18,0.7);">
          Your portrait is attached — feel free to upload it to LinkedIn or just keep it close. If this read landed, we'd love to hear about it — just reply.
        </td></tr>
        <tr><td align="center" style="padding:32px 36px 36px 36px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid rgba(153,17,47,0.15);width:100%;">
            <tr><td align="center" style="padding:18px 0 0 0;">
              <a href="https://vonpeach.com" style="font-size:12px;letter-spacing:0.28em;text-transform:uppercase;color:#99112F;text-decoration:none;font-weight:600;">vonpeach.com</a>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function emailText(name, note) {
  return [
    "VON PEACH",
    "",
    name,
    "",
    note,
    "",
    "Your card is attached. Save it, share it, or keep it close.",
    "",
    "If this read landed, we'd love to hear about it — just reply.",
    "",
    "— Von Peach",
    "vonpeach.com",
  ].join("\n");
}
