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

const FAL_URL = "https://fal.run/fal-ai/flux-pro/kontext";
const RESEND_URL = "https://api.resend.com/emails";

const PROMPTS = {
  charmer:
    "Regal Baroque oil-painting portrait, head and shoulders, warm golden chamber light, " +
    "ornate gilded collar, embroidered velvet robes in deep wine red, soft confident smile, " +
    "painterly brushstrokes, museum-quality, preserve the exact face, hair and likeness from " +
    "the input image, centered formal composition, no text, no logos, no watermark",
  magician:
    "Dark Baroque oil-painting portrait, head and shoulders, dramatic chiaroscuro lighting, " +
    "deep shadows, intricate brocade collar with silver thread, jewel-toned cape, sharp " +
    "intelligent gaze with a slight knowing smile, painterly brushstrokes, museum-quality, " +
    "preserve the exact face, hair and likeness from the input image, centered formal " +
    "composition, no text, no logos, no watermark",
  alchemist:
    "Renaissance alchemist oil-painting portrait, head and shoulders, candlelit warm tones, " +
    "scholar's robes in deep red and burnished gold, faint glints of copper and brass " +
    "instruments behind, contemplative wise expression, painterly brushstrokes, museum-quality, " +
    "preserve the exact face, hair and likeness from the input image, centered formal " +
    "composition, no text, no logos, no watermark",
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
        image_url: image,           // flux-kontext accepts data URLs
        guidance_scale: 3.5,
        num_images: 1,
        output_format: "jpeg",
        safety_tolerance: "2",
      }),
    });

    if (!falRes.ok) {
      const detail = await falRes.text();
      return jsonResp({ error: "upstream", status: falRes.status, detail }, 502, cors);
    }

    const data = await falRes.json();
    const outUrl = data?.images?.[0]?.url;
    if (!outUrl) return jsonResp({ error: "no_image", data }, 502, cors);

    // Proxy the image as inline base64 — avoids cross-origin canvas taint
    // and keeps fal.ai's transient URLs off the client.
    const imgRes = await fetch(outUrl);
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
