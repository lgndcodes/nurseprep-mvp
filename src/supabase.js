/**
 * Supabase client — service-role key for backend use (bypasses RLS for trusted server writes).
 * Never expose SUPABASE_SERVICE_KEY to browsers or mobile clients.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    params: {
      eventsPerSecond: -1,
    },
  },
  global: {
    headers: {
      'X-Client-Info': 'nurseprep-backend',
    },
  },
});

console.log('Supabase client initialized');

(async () => {
  const test = await supabase.from('documents').select('count').single();
  console.log('DB connection test:', test);
})();

module.exports = supabase;
