// Supabase client - 기존 piano-tuning-scope 연결 정보 사용
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const SUPABASE_URL = 'https://bamhecfjwevpczkewkze.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbWhlY2Zqd2V2cGN6a2V3a3plIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NDcyOTcsImV4cCI6MjA5NjMyMzI5N30.i4ovK0km8n8EGpWH03-pr-KaubXQWVhTmDy6ks-K9Pw';

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: typeof window !== 'undefined' ? localStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
  }
});
