/**
 * Axios instance with JWT token injection and refresh logic
 * NOTE: Store is accessed lazily via getStore() to avoid circular dependency.
 */

import axios from 'axios';
import { authGet, authSetAccess, authSetRefresh, authClear } from './authStorage.js';

// In dev, use empty baseURL so requests go through Vite proxy (avoids CORS)
// In production, use the configured API URL
const API_BASE_URL = import.meta.env.PROD
  ? (import.meta.env.VITE_API_URL || 'http://localhost:8000')
  : '';

// Lazy store access to break circular dependency
let _store = null;
export const setStore = (store) => { _store = store; };
const getStore = () => _store;

// Create axios instance
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Request interceptor - Add JWT token to headers
 */
apiClient.interceptors.request.use(
  (config) => {
    // Try getting token from Redux store first, then sessionStorage as fallback
    let token = null;
    const store = getStore();
    if (store) {
      token = store.getState().auth.token;
    }
    if (!token) {
      token = authGet('accessToken');
    }
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

/**
 * Response interceptor - Handle token refresh on 401
 */
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  isRefreshing = false;
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const store = getStore();

    // A 401 FROM THE LOGIN CALL ITSELF means bad credentials, never a stale
    // access token - refreshing can't fix a wrong password, so this must
    // never enter the refresh dance below. (Second reason, belt-and-suspenders:
    // it also used to be how a wrong password with no stored refresh token
    // left `isRefreshing` stuck true forever - see the reset a few lines down.)
    const isLoginRequest = originalRequest?.url === '/api/token/';

    if (error.response?.status === 401 && !isLoginRequest && !originalRequest._retry && store) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(token => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return apiClient(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = store.getState().auth.refreshToken;

      if (!refreshToken) {
        // Nothing to refresh with - e.g. a wrong password on the login page,
        // or any screen hit after a session expired with no refresh token.
        // processQueue clears isRefreshing (set just above). Without it the
        // flag stayed true for good, so the NEXT 401 - on ANY request, not
        // just login - joined failedQueue to wait for a refresh that was
        // never running, and the Sign In button spun forever.
        processQueue(error, null);
        store.dispatch({ type: 'auth/logout' });
        return Promise.reject(error);
      }

      try {
        const response = await axios.post(
          `${API_BASE_URL}/api/token/refresh/`,
          { refresh: refreshToken },
          { timeout: 30000, headers: { 'Content-Type': 'application/json' } }
        );

        // ROTATE_REFRESH_TOKENS is on, so the server returns a NEW refresh
        // token alongside the access token and the one we just sent is spent.
        // This used to keep re-storing the original: harmless only because the
        // blacklist app was not installed, so a spent token still worked. The
        // moment blacklisting is enabled, re-using it makes the SECOND refresh
        // 401 and drops the user at the login screen. Keep whatever the server
        // just handed back; fall back to the old one if rotation is ever off.
        const { access: newToken, refresh: rotatedRefresh } = response.data;
        const nextRefresh = rotatedRefresh || refreshToken;

        // Update the Redux store AND whichever storage holds the session.
        store.dispatch({
          type: 'auth/setCredentials',
          payload: { token: newToken, refreshToken: nextRefresh },
        });
        authSetAccess(newToken);
        if (rotatedRefresh) authSetRefresh(rotatedRefresh);

        apiClient.defaults.headers.common.Authorization = `Bearer ${newToken}`;
        processQueue(null, newToken);

        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(originalRequest);
      } catch (err) {
        processQueue(err, null);
        // Clear both storages and let auth state handle redirect
        authClear();
        store.dispatch({ type: 'auth/logout' });
        return Promise.reject(err);
      }
    }

    return Promise.reject(error);
  }
);

/**
 * Get error message from response
 */
export const getErrorMessage = (error) => {
  if (!error) return 'An unknown error occurred';

  if (error.response) {
    const { status, data } = error.response;

    if (status === 400 && typeof data === 'object') {
      const firstError = Object.values(data)[0];
      if (Array.isArray(firstError)) return firstError[0];
      if (typeof firstError === 'string') return firstError;
    }

    if (status === 401) return 'Unauthorized. Please login again.';
    if (status === 403) return 'You do not have permission to access this resource.';
    if (status === 404) return 'Resource not found.';
    if (status === 500) return 'Server error. Please try again later.';

    if (data?.detail) return data.detail;
    if (data?.message) return data.message;
    if (data?.error) return data.error;
  }

  if (error.request && !error.response) {
    return 'Network error. Please check your connection.';
  }

  if (error.message) return error.message;

  return 'An unexpected error occurred.';
};

export default apiClient;
