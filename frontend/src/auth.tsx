import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, fetchMe, loadAuthToken, setAuthToken, signup as apiSignup, login as apiLogin } from './api';

type User = {
  id: string;
  email: string;
  username: string;
  display_name: string;
};

type AuthState = {
  user: User | null;
  isLoading: boolean;
  signup: (payload: { email: string; password: string; display_name: string; username: string }) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = await loadAuthToken();
      if (token) {
        try {
          const me = await fetchMe();
          setUser(me);
        } catch {
          await setAuthToken(null);
        }
      }
      setIsLoading(false);
    })();
  }, []);

  const signup = useCallback(async (payload: any) => {
    const { access_token, user: u } = await apiSignup(payload);
    await setAuthToken(access_token);
    setUser(u);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { access_token, user: u } = await apiLogin(email, password);
    await setAuthToken(access_token);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await setAuthToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me);
    } catch {}
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, signup, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
