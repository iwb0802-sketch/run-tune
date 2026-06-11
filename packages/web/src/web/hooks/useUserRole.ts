import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'

type Role = 'free' | 'pro' | 'admin'

export function useUserRole(userId?: string | null) {
  const [role, setRole] = useState<Role>('free')

  useEffect(() => {
    if (!userId) { setRole('free'); return }

    supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .single()
      .then(({ data }) => {
        if (data?.role) setRole(data.role as Role)
        else setRole('free')
      })
  }, [userId])

  return {
    role,
    isPro: role === 'pro' || role === 'admin',
    isAdmin: role === 'admin',
  }
}
