import { createClient } from '@supabase/supabase-js';
import { tokenMatches } from '../lib/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const CRM_ASSISTANT_TOKEN = process.env.CRM_ASSISTANT_TOKEN || '';
const CRM_OWNER_UID = process.env.CRM_OWNER_UID || '';
const ALLOWED_HOST = 'zgbzjeiprratbyjnsbge.supabase.co';
const ACTIONS = new Set(['list_contacts', 'add_contact', 'list_events', 'add_event', 'list_notes', 'add_note']);

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function text(value, max = 1000) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new Error('Input is too long');
  return result;
}

function configured() {
  let parsed;
  try { parsed = new URL(SUPABASE_URL); } catch { return false; }
  return parsed.href === 'https://' + ALLOWED_HOST + '/' && Boolean(SUPABASE_SERVICE_KEY) && validUuid(CRM_OWNER_UID);
}

function rowForAction(action, data) {
  if (!action.startsWith('add_')) return null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('data must be an object');
  if (action === 'add_contact') {
    const first_name = text(data?.first_name, 120);
    if (!first_name) throw new Error('first_name is required');
    return { table: 'contacts', row: { owner_id: CRM_OWNER_UID, first_name, last_name: text(data.last_name, 120) || null, phone: text(data.phone, 500) || null, email: text(data.email, 500) || null, address: text(data.address, 1000) || null, profession: text(data.profession, 300) || null, notes: text(data.notes, 2000) || null, created_by: 'Buddy' } };
  }
  if (action === 'add_event') {
    const title = text(data?.title, 200);
    const date = text(data?.date, 20);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('title and YYYY-MM-DD date are required');
    return { table: 'events', row: { owner_id: CRM_OWNER_UID, title, date, time: text(data.time, 30) || null, location: text(data.location, 500) || null, created_by: 'Buddy' } };
  }
  if (action === 'add_note') {
    const category = text(data.category, 80);
    const content = text(data.content, 50000);
    if (!['homework', 'guitar', 'trumpet', 'bass', 'double-bass', 'drums', 'piano', 'general'].includes(category) || !content) throw new Error('valid category and content are required');
    return { table: 'notes', row: { owner_id: CRM_OWNER_UID, title: category, body: content } };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'Method Not Allowed' });
  if (!tokenMatches(CRM_ASSISTANT_TOKEN, bearer(req))) return reply(res, 401, { ok: false, error: 'Unauthorized' });
  if (!configured()) return reply(res, 503, { ok: false, error: 'Assistant CRM route is not configured' });

  let body = req.body || {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return reply(res, 400, { ok: false, error: 'Invalid JSON' }); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 400, { ok: false, error: 'Request body must be an object' });
  const action = String(body.action || '');
  if (!ACTIONS.has(action)) return reply(res, 400, { ok: false, error: 'Unsupported action' });

  let add;
  let requestedLimit = 50;
  try {
    add = rowForAction(action, body.data);
    if (!add) {
      requestedLimit = body.limit === undefined ? 50 : Number(body.limit);
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw new Error('limit must be an integer from 1 to 100');
      if (body.category !== undefined) text(body.category, 80);
    }
  } catch (error) {
    return reply(res, 400, { ok: false, error: error.message });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  try {
    if (add) {
      const { data, error } = await supabase.from(add.table).insert(add.row).select('id').single();
      if (error) throw error;
      console.info('assistant_crm_action', { actor: 'Buddy', action, rowId: data.id });
      return reply(res, 200, { ok: true, id: data.id });
    }

    const table = action.endsWith('contacts') ? 'contacts' : action.endsWith('events') ? 'events' : 'notes';
    const limit = requestedLimit;
    const columns = table === 'contacts'
      ? 'id, owner_id, first_name, last_name, phone, email, address, profession, notes, created_by, created_at, updated_at, deleted_at'
      : table === 'events'
        ? 'id, owner_id, title, date, time, location, created_by, created_at, updated_at, deleted_at'
        : 'id, owner_id, title, body, created_at';
    let query = supabase.from(table).select(columns).eq('owner_id', CRM_OWNER_UID).order('created_at', { ascending: false }).limit(limit);
    if (table !== 'notes') query = query.is('deleted_at', null);
    if (table === 'notes' && body.category) query = query.eq('title', text(body.category, 80));
    const { data, error } = await query;
    if (error) throw error;
    console.info('assistant_crm_action', { actor: 'Buddy', action, count: data?.length || 0 });
    return reply(res, 200, { ok: true, items: data || [] });
  } catch (error) {
    console.error('assistant_crm_failed', { action, message: error.message });
    return reply(res, 500, { ok: false, error: 'CRM action failed' });
  }
}
