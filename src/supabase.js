require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();

if (!supabaseUrl) throw new Error('SUPABASE_URL is not set');
if (!supabaseServiceKey) throw new Error('SUPABASE_SERVICE_KEY is not set');

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  realtime: {
    transport: ws
  },
  global: {
    headers: {
      'X-Client-Info': 'nurseprep-backend'
    }
  }
});

console.log('Supabase client initialized');
module.exports = supabase;
