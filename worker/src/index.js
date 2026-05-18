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

// Two-stage portrait pipeline:
//
//   1) flux-pulid generates the editorial scene with identity anchored
//      from the user's face (text-prompted, identity-locked).
//        docs: https://fal.ai/models/fal-ai/flux-pulid
//
//   2) CodeFormer polishes the resulting face — restores skin detail,
//      lifts the eyes, magazine-grade finish. Fidelity tuned to 0.7 so
//      the identity from step 1 doesn't shift.
//        docs: https://fal.ai/models/fal-ai/codeformer
//
// CodeFormer is best-effort: if it errors, we return the PuLID result
// unchanged so the user still sees their portrait.
const FAL_URL    = "https://fal.run/fal-ai/flux-pulid";
const POLISH_URL = "https://fal.run/fal-ai/codeformer";
const RESEND_URL = "https://api.resend.com/emails";

// Universal flattering layer — appended to every archetype prompt. The
// brief is "obviously the same person, on their best day". Magazine-grade
// retouching, glowing skin, bright eyes, softly flattering light.
const FLATTERING =
  " The subject looks their absolute best — clear glowing skin, bright " +
  "well-rested eyes, sharp jawline, a subtle natural glow, confident and " +
  "magnetic. Professional magazine-quality retouching that softens any " +
  "blemishes, dark circles or shadows under the eyes while keeping skin " +
  "texture natural and real. The pose, angle and lighting are deliberately " +
  "chosen to flatter — slight three-quarter angle, soft front fill light " +
  "that lifts the eyes, no harsh under-lighting, no double-chin angle. The " +
  "kind of photograph where a friend says 'wow, you look great here'. " +
  "Photorealistic, real-camera image, shallow depth of field, 85mm portrait " +
  "lens look. No text, no logos, no watermark.";

const PROMPTS = {
  charmer:
    "Editorial magazine-cover portrait photograph, the kind of polished " +
    "headshot one would be proud to upload to LinkedIn. Head-and-shoulders, " +
    "looking straight to camera, warm natural half-smile, eyes connecting " +
    "with the viewer with quiet confidence. Soft warm studio lighting with " +
    "a hint of golden-hour glow on the cheekbones, large soft key light " +
    "from front-left, subtle rim light. Stylish contemporary professional " +
    "wardrobe — earth-tone tailored blazer over a crisp shirt, optional " +
    "simple jewellery. Soft warm bokeh background in muted creams and warm " +
    "ambers, suggestion of a sunlit room. In the style of a Condé Nast or " +
    "Vogue executive portrait." + FLATTERING,
  magician:
    "High-contrast editorial portrait photograph, striking and cinematic, " +
    "the kind of headshot one would be proud to upload to LinkedIn. " +
    "Head-and-shoulders, looking straight to camera, slight knowing " +
    "half-smile, sharp intelligent eyes. Dramatic side-lighting with a " +
    "single warm key light from the side and a defined rim light on the " +
    "shoulder, deep but luminous shadows that still keep the face sharp " +
    "and readable. Sleek modern professional wardrobe — black turtleneck " +
    "or a structured dark blazer. Moody dark background with subtle " +
    "architectural or fabric depth, faint smoke or texture. In the style " +
    "of Platon's editorial portraits." + FLATTERING,
  alchemist:
    "Considered editorial profile-photograph portrait, thoughtful and " +
    "premium, the kind of headshot one would be proud to upload to " +
    "LinkedIn. Head-and-shoulders, looking straight to camera, a calm " +
    "steady gaze that suggests deep expertise, a faint hint of a smile at " +
    "the eyes. Warm soft lighting with a gentle golden tone, large soft " +
    "key light from front-right. Refined intellectual professional " +
    "wardrobe — fine tweed jacket or quality knit, considered details, " +
    "optionally subtle glasses. Softly defocused background of a " +
    "warm-toned study or wood-panelled library, books or artisan tools " +
    "just visible in the bokeh. In the style of a New Yorker or Sunday " +
    "Times Magazine profile portrait." + FLATTERING,
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
          "blurry, out of focus, low quality, distorted face, wrong identity, " +
          "different person, cartoon, painting, illustration, anime, watermark, " +
          "text, tired, exhausted, bags under eyes, dark circles, harsh shadows " +
          "on face, harsh under-lighting, double chin, unflattering angle, " +
          "low angle from below, oily skin, blemishes, acne, red skin, " +
          "wrinkled, aged, dull skin, washed out, flat lighting, ugly, " +
          "asymmetric face, deformed, bad anatomy",
      }),
    });

    if (!falRes.ok) {
      const detail = await falRes.text();
      return jsonResp({ error: "upstream", status: falRes.status, detail }, 502, cors);
    }

    const data = await falRes.json();
    const pulidUrl = data?.images?.[0]?.url;
    if (!pulidUrl) return jsonResp({ error: "no_image", data }, 502, cors);

    // Step 2: CodeFormer face-detail polish (best-effort). Restores skin
    // detail, lifts the eyes, polishes the face without shifting identity.
    let finalUrl = pulidUrl;
    try {
      const polishRes = await fetch(POLISH_URL, {
        method: "POST",
        headers: {
          Authorization: `Key ${env.FAL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image_url: pulidUrl,
          fidelity: 0.7,           // 0..1 — higher = stays closer to PuLID identity
          upscaling: 2,            // 1x or 2x; 2x adds detail without much cost
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
        if (polishedUrl) finalUrl = polishedUrl;
      } else {
        console.warn("CodeFormer polish failed:", polishRes.status, await polishRes.text());
      }
    } catch (polishErr) {
      console.warn("CodeFormer polish threw:", polishErr?.message);
    }

    // Proxy the (polished) image as inline base64 — avoids cross-origin
    // canvas taint and keeps fal.ai's transient URLs off the client.
    const imgRes = await fetch(finalUrl);
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
      subject: `Your Von Peach card — ${name}`,
      html: emailHtml(name, note),
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

function emailHtml(name, note) {
  const safe = (note || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#1a0610;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#FFD6BB;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1a0610;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">
        <tr><td style="padding:0 0 20px 0;">
          <div style="font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#FD8839;font-weight:700;">Von Peach</div>
          <h1 style="margin:8px 0 0 0;font-size:28px;font-weight:800;color:#FFD6BB;letter-spacing:-0.01em;">${name}</h1>
        </td></tr>
        <tr><td style="padding:0 0 24px 0;font-size:15px;line-height:1.6;color:rgba(255,214,187,0.88);">
          ${safe}
        </td></tr>
        <tr><td style="padding:0 0 24px 0;font-size:13px;line-height:1.55;color:rgba(255,214,187,0.65);">
          Your card is attached. Save it, share it, or keep it close. If this read
          landed, we'd love to hear about it — just reply.
        </td></tr>
        <tr><td style="border-top:1px solid rgba(255,214,187,0.18);padding:18px 0 0 0;font-size:11px;letter-spacing:0.24em;text-transform:uppercase;color:rgba(255,214,187,0.55);">
          Von Peach · vonpeach.com
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
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
