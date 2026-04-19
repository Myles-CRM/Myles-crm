exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  const ok = (data) => ({
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    },
    body: JSON.stringify(data)
  });

  const bad = (code, msg) => ({
    statusCode: code,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    },
    body: JSON.stringify({ error: msg })
  });

  try {
    // GET health check → 405 per requirements
    if (event.httpMethod === 'GET') {
      return bad(405, 'Method not allowed');
    }

    // Auth: accept either admin token or passcode
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const isAuthorized = !!token && (
      token === process.env.CRM_ADMIN_TOKEN ||
      token === process.env.CRM_ADMIN_PASSCODE
    );
    if (!isAuthorized) {
      return bad(401, 'Unauthorized');
    }

    if (event.httpMethod !== 'POST') {
      return bad(405, 'Method not allowed');
    }

    const body = JSON.parse(event.body || '{}');
    let action = body.action;

    // Allow path-based shorthand: /admin/notes|contacts|events → map to action
    const pathTail = (event.path || '').split('/').pop();
    if (!action) {
      if (pathTail === 'notes') action = 'add-note';
      if (pathTail === 'contacts') action = 'add-contact';
      if (pathTail === 'events') action = 'add-event';
    }

    // Import Supabase client (local package)
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (action === 'add-event') {
      const { title, date, time, location, created_by = 'Buddy' } = body;
      if (!title || !date) return bad(400, 'title and date required');
      const { data, error } = await supabase
        .from('events')
        .insert([{ title, date, time, location, created_by }])
        .select()
        .single();
      if (error) return bad(500, error.message);
      return ok({ message: 'event added', id: data.id });
    }

    if (action === 'add-note') {
      const { category, content, created_by = 'Buddy' } = body;
      const allowed = ['guitar', 'trumpet', 'bass', 'drums', 'piano', 'general'];
      if (!allowed.includes(category)) return bad(400, 'invalid category');
      if (!content) return bad(400, 'content required');
      const { data, error } = await supabase
        .from('notes')
        .insert([{ category, content, created_by }])
        .select()
        .single();
      if (error) return bad(500, error.message);
      return ok({ message: 'note added', id: data.id });
    }

    if (action === 'add-contact') {
      const { first_name, last_name, phone, address, email, profession, notes, created_by = 'Buddy' } = body;
      if (!first_name || !last_name) return bad(400, 'first_name and last_name required');
      const { data, error } = await supabase
        .from('contacts')
        .insert([{ first_name, last_name, phone, address, email, profession, notes, created_by }])
        .select()
        .single();
      if (error) return bad(500, error.message);
      return ok({ message: 'contact added', id: data.id });
    }

    if (action === 'delete-item') {
      const { table, id } = body;
      const allowedTables = ['events', 'notes', 'contacts'];
      if (!allowedTables.includes(table)) return bad(400, 'invalid table');
      if (!id) return bad(400, 'id required');
      const { error } = await supabase
        .from(table)
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (error) return bad(500, error.message);
      return ok({ message: 'soft deleted', id });
    }

    return bad(400, 'unknown action');
  } catch (e) {
    return bad(500, e.message || 'server error');
  }
};
