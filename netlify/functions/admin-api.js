// Netlify Function: admin-api (ESM, Node 18+)
// Endpoints:
//   POST /admin/events   { title, start, end, notes? }
//   POST /admin/contacts { name, email?, phone?, notes? }
//   POST /admin/notes    { topic, body }
//
// Auth: Authorization: Bearer ${CRM_ADMIN_TOKEN}
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CRM_ADMIN_TOKEN
// CORS: Only allow Netlify site origin (URL/DEPLOY_PRIME_URL/SITE_URL), with OPTIONS preflight
// Rate limit: in-memory by token+IP (30 per 5 min)

import { createClient } from "@supabase/supabase-js";

// -------- Configuration --------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  CRM_ADMIN_TOKEN,
  URL: NETLIFY_URL,
  DEPLOY_PRIME_URL,
  SITE_URL,
} = process.env;

const ALLOWED_ORIGINS = [NETLIFY_URL, DEPLOY_PRIME_URL, SITE_URL]
  .filter(Boolean)
  .map((u) => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const rateBuckets = new Map(); // key -> { count, resetAt }

// -------- Utilities --------
const json = (status, body, extraHeaders = {}) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

function corsHeadersForOrigin(origin) {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "OPTIONS, POST",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
    };
  }
  return {};
}

function parsePathSuffix(path) {
  const marker = "/.netlify/functions/admin-api/";
  const idx = path.indexOf(marker);
  if (idx === -1) return "";
  return path.substring(idx + marker.length); // e.g. "events"
}

function getAuthToken(headers = {}) {
  const auth = (headers.authorization || headers.Authorization || "").toString();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function basicEmailValid(s) {
  if (!s) return true; // optional
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function isoDateValid(s) {
  if (typeof s !== "string" || s.length < 8 || s.length > 40) return false;
  const d = new Date(s);
  return !isNaN(d.getTime());
}

function rateLimitKey(token, ip) {
  return `${token || "no-token"}|${ip || "no-ip"}`;
}

function checkRateLimit(token, ip) {
  const now = Date.now();
  const key = rateLimitKey(token, ip);
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  const remaining = Math.max(0, RATE_LIMIT_MAX - bucket.count);
  const resetSec = Math.ceil((bucket.resetAt - now) / 1000);
  const limited = bucket.count > RATE_LIMIT_MAX;
  return { limited, remaining, resetSec };
}

function safeParseBody(raw, maxBytes = 10 * 1024) {
  if (!raw) return {};
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Error("Payload too large");
  }
  return JSON.parse(raw);
}

function ensureEnvOk() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY";
  }
  if (!CRM_ADMIN_TOKEN) {
    return "Missing CRM_ADMIN_TOKEN";
  }
  return null;
}

function makeSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}

// -------- Validators --------
function validateEvent(input) {
  const errors = [];
  const out = { title: "", start: "", end: "", notes: null };
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120) {
    errors.push("title is required (string, <=120 chars)");
  } else out.title = input.title.trim();
  if (!isoDateValid(input.start)) errors.push("start must be ISO date/time");
  else out.start = new Date(input.start).toISOString();
  if (!isoDateValid(input.end)) errors.push("end must be ISO date/time");
  else out.end = new Date(input.end).toISOString();
  if (input.notes != null) {
    if (typeof input.notes !== "string" || input.notes.length > 2000) {
      errors.push("notes must be string <=2000 chars");
    } else out.notes = input.notes;
  }
  return { ok: errors.length === 0, errors, value: out };
}

function validateContact(input) {
  const errors = [];
  const out = { name: "", email: null, phone: null, notes: null };
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) {
    errors.push("name is required (string, <=120 chars)");
  } else out.name = input.name.trim();
  if (input.email != null) {
    if (typeof input.email !== "string" || !basicEmailValid(input.email)) {
      errors.push("email invalid");
    } else out.email = input.email;
  }
  if (input.phone != null) {
    if (typeof input.phone !== "string" || input.phone.length > 40) {
      errors.push("phone must be string <=40 chars");
    } else out.phone = input.phone;
  }
  if (input.notes != null) {
    if (typeof input.notes !== "string" || input.notes.length > 2000) {
      errors.push("notes must be string <=2000 chars");
    } else out.notes = input.notes;
  }
  return { ok: errors.length === 0, errors, value: out };
}

function validateNote(input) {
  const errors = [];
  const out = { topic: "", body: "" };
  if (typeof input.topic !== "string" || !input.topic.trim() || input.topic.length > 160) {
    errors.push("topic is required (string, <=160 chars)");
  } else out.topic = input.topic.trim();
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 8000) {
    errors.push("body is required (string, <=8000 chars)");
  } else out.body = input.body;
  return { ok: errors.length === 0, errors, value: out };
}

// -------- Handler --------
export async function handler(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  const cors = corsHeadersForOrigin(origin);

  // OPTIONS preflight
  if (event.httpMethod === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return json(403, { ok: false, error: "CORS origin not allowed" }, cors);
    }
    return { statusCode: 204, headers: { ...cors } };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, cors);
  }

  // Env check
  const envErr = ensureEnvOk();
  if (envErr) return json(500, { ok: false, error: envErr }, cors);

  // Auth
  const token = getAuthToken(event.headers || {});
  if (!token || token !== CRM_ADMIN_TOKEN) {
    return json(401, { ok: false, error: "Unauthorized" }, cors);
  }

  // Rate limit
  const ip = event.headers["client-ip"] || event.headers["x-forwarded-for"] || event.ip || "";
  const rl = checkRateLimit(token, String(ip));
  if (rl.limited) {
    return json(
      429,
      { ok: false, error: "Rate limit exceeded. Try again later." },
      {
        ...cors,
        "Retry-After": String(rl.resetSec),
        "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(rl.resetSec),
      }
    );
  }

  // Route
  const suffix = parsePathSuffix(event.path || "");
  if (!suffix) return json(404, { ok: false, error: "Unknown endpoint" }, cors);

  // Payload
  let payload = {};
  try {
    payload = safeParseBody(event.body);
  } catch (e) {
    return json(400, { ok: false, error: e.message || "Invalid JSON" }, cors);
  }

  const supabase = makeSupabase();
  const now = new Date().toISOString();

  try {
    if (suffix === "events") {
      const v = validateEvent(payload);
      if (!v.ok) return json(400, { ok: false, error: v.errors.join("; ") }, cors);
      const row = {
        title: v.value.title,
        start: v.value.start,
        end: v.value.end,
        notes: v.value.notes,
        created_by: "buddy",
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await supabase.from("events").insert(row).select("id").single();
      if (error) throw error;
      return json(
        200,
        { ok: true, id: data.id },
        {
          ...cors,
          "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Reset": String(rl.resetSec),
        }
      );
    }

    if (suffix === "contacts") {
      const v = validateContact(payload);
      if (!v.ok) return json(400, { ok: false, error: v.errors.join("; ") }, cors);
      const row = {
        name: v.value.name,
        email: v.value.email,
        phone: v.value.phone,
        notes: v.value.notes,
        created_by: "buddy",
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await supabase.from("contacts").insert(row).select("id").single();
      if (error) throw error;
      return json(
        200,
        { ok: true, id: data.id },
        {
          ...cors,
          "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Reset": String(rl.resetSec),
        }
      );
    }

    if (suffix === "notes") {
      const v = validateNote(payload);
      if (!v.ok) return json(400, { ok: false, error: v.errors.join("; ") }, cors);
      const row = {
        topic: v.value.topic,
        body: v.value.body,
        created_by: "buddy",
        created_at: now,
        updated_at: now,
      };
      const { data, error } = await supabase.from("notes").insert(row).select("id").single();
      if (error) throw error;
      return json(
        200,
        { ok: true, id: data.id },
        {
          ...cors,
          "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
          "X-RateLimit-Remaining": String(rl.remaining),
          "X-RateLimit-Reset": String(rl.resetSec),
        }
      );
    }

    return json(404, { ok: false, error: "Unknown endpoint" }, cors);
  } catch (e) {
    return json(500, { ok: false, error: e?.message || "Server error" }, cors);
  }
}

// Curl examples (replace $BASE with your Netlify site URL)
// curl -X POST "$BASE/admin/events" \
//   -H "Content-Type: application/json" \
//   -H "Authorization: Bearer $CRM_ADMIN_TOKEN" \
//   -d '{"title":"Meet","start":"2026-04-17T09:00:00Z","end":"2026-04-17T10:00:00Z","notes":"Prep"}'
//
// curl -X POST "$BASE/admin/contacts" \
//   -H "Content-Type: application/json" \
//   -H "Authorization: Bearer $CRM_ADMIN_TOKEN" \
//   -d '{"name":"Alex Example","email":"alex@example.com","phone":"+61 400 000 000"}'
//
// curl -X POST "$BASE/admin/notes" \
//   -H "Content-Type: application/json" \
//   -H "Authorization: Bearer $CRM_ADMIN_TOKEN" \
//   -d '{"topic":"Stock","body":"Reorder SD cards"}'
