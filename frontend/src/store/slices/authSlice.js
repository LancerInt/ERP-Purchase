/**
 * Authentication state slice
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import apiClient, { getErrorMessage } from '../../utils/api.js';
import { clearPermissionsCache } from '../../hooks/usePermissions.js';
import { clearLookupCache } from '../../hooks/useLookup.js';
import { authGet, authSetSession, authSetAccess, authClear } from '../../utils/authStorage.js';

// Restore the session on startup. "Remember me" sessions live in localStorage
// (survive a browser restart); the default lives in sessionStorage (tab-only).
const savedToken = authGet('accessToken');
const savedRefreshToken = authGet('refreshToken');
const savedUser = authGet('user');

const initialState = {
  user: savedUser ? JSON.parse(savedUser) : null,
  token: savedToken || null,
  refreshToken: savedRefreshToken || null,
  roles: [],
  permissions: [],
  modules: [],
  warehouseScope: [],
  isLoading: false,
  error: null,
  isAuthenticated: !!savedToken,
  // Whether the CURRENT user still needs to finish 2FA setup (their role
  // requires it, and they haven't enrolled anything yet). Seeded from the
  // login response for an immediate value, then re-derived from
  // /api/mfa/status/ by checkMfaSetupRequired below — that's what makes it
  // survive a page refresh (login only happens once; this field otherwise
  // wouldn't survive re-loading the app) and self-correct once the user
  // actually finishes setup.
  mustSetupMfa: false,
  // True for exactly one render-cycle after a REAL sign-in completes
  // (password, TOTP, or WebAuthn) — set by applySignedIn below, which a page
  // refresh never runs (a refresh re-seeds auth from storage via initialState
  // instead). The login greeting modal watches this to show once per login
  // and NOT on every reload, then calls clearJustLoggedIn to lower it.
  justLoggedIn: false,
};

/**
 * Async thunk for user login
 */
export const loginUser = createAsyncThunk(
  'auth/loginUser',
  async (credentials, { rejectWithValue }) => {
    try {
      // Django SimpleJWT expects username + password
      const response = await apiClient.post('/api/token/', {
        username: credentials.email,
        password: credentials.password,
      });

      // Two-factor login (see the mfa app): the password step returns a
      // challenge instead of tokens when the account has a confirmed
      // second factor. No session is established yet — hand this back to
      // the login page to show the code-entry step, which calls verifyMfa
      // below on success instead of retrying loginUser.
      if (response.data?.mfa_required) {
        return {
          mfaRequired: true,
          mfaToken: response.data.mfa_token,
          methods: response.data.methods || [],
        };
      }

      const { access, refresh, must_setup_mfa } = response.data;

      // Clear stale caches from previous session
      clearPermissionsCache();
      clearLookupCache();
      // Start every sign-in with all sidebar modules collapsed. Expansions are
      // remembered during the session (survive navigation) but not carried
      // across logins, so a fresh sign-in always shows the compact module list.
      try { localStorage.removeItem('sidebar-expanded-sections'); } catch { /* private mode */ }

      // Persist per the "Remember me" choice: localStorage (survives browser
      // restart) when remembered, else sessionStorage (tab-isolated default).
      const user = { email: credentials.email, name: credentials.email };
      authSetSession({ access, refresh, user, remember: !!credentials.remember });

      return {
        token: access,
        refreshToken: refresh,
        user,
        roles: [],
        permissions: [],
        modules: [],
        warehouseScope: [],
        mustSetupMfa: !!must_setup_mfa,
      };
    } catch (error) {
      // Prefer the backend's specific reason ("No account found…",
      // "Incorrect password…", "account is inactive…") over the generic
      // 401 text getErrorMessage would otherwise return for any auth
      // failure. Falls back to network / generic messages when there's
      // no detail to show.
      const data = error.response?.data;
      // The API's exception handler wraps failures as { error, status_code },
      // while raw DRF uses { detail }. Check both so the specific reason
      // always comes through.
      const msg = data?.error || data?.detail || data?.message
        || (error.request && !error.response
          ? 'Network error. Please check your connection.'
          : 'Login failed. Please try again.');
      return rejectWithValue(msg);
    }
  }
);

/**
 * Second step of a two-factor login — completes what loginUser started
 * once it returned { mfaRequired: true }. `credentials` here is the
 * original username/remember, purely for the `user` display object and
 * the storage choice; the mfaToken already carries WHO is signing in.
 */
export const verifyMfa = createAsyncThunk(
  'auth/verifyMfa',
  async ({ mfaToken, method, code, email, remember }, { rejectWithValue }) => {
    try {
      const response = await apiClient.post('/api/mfa/verify/', {
        mfa_token: mfaToken, method, code,
      });
      const { access, refresh } = response.data;

      clearPermissionsCache();
      clearLookupCache();
      // Fresh sign-in → all sidebar modules collapsed (see loginUser above).
      try { localStorage.removeItem('sidebar-expanded-sections'); } catch { /* private mode */ }

      const user = { email, name: email };
      authSetSession({ access, refresh, user, remember: !!remember });

      return {
        token: access,
        refreshToken: refresh,
        user,
        roles: [],
        permissions: [],
        modules: [],
        warehouseScope: [],
        mustSetupMfa: false,
      };
    } catch (error) {
      const data = error.response?.data;
      const msg = data?.error || data?.detail || data?.message || 'Incorrect code. Please try again.';
      return rejectWithValue(msg);
    }
  }
);

/**
 * Second step of a two-factor login via a registered biometric device
 * (WebAuthn). The caller drives the actual browser ceremony
 * (startAuthentication from @simplewebauthn/browser) and passes in the
 * signed `credential` it got back — this thunk only exchanges that for
 * real tokens, mirroring verifyMfa above.
 */
export const verifyMfaWebAuthn = createAsyncThunk(
  'auth/verifyMfaWebAuthn',
  async ({ mfaToken, credential, email, remember }, { rejectWithValue }) => {
    try {
      const response = await apiClient.post('/api/mfa/webauthn/login/complete/', {
        mfa_token: mfaToken, credential,
      });
      const { access, refresh } = response.data;

      clearPermissionsCache();
      clearLookupCache();
      // Fresh sign-in → all sidebar modules collapsed (see loginUser above).
      try { localStorage.removeItem('sidebar-expanded-sections'); } catch { /* private mode */ }

      const user = { email, name: email };
      authSetSession({ access, refresh, user, remember: !!remember });

      return {
        token: access,
        refreshToken: refresh,
        user,
        roles: [],
        permissions: [],
        modules: [],
        warehouseScope: [],
        mustSetupMfa: false,
      };
    } catch (error) {
      const data = error.response?.data;
      const msg = data?.error || data?.detail || data?.message || 'Could not verify with that device. Please try again.';
      return rejectWithValue(msg);
    }
  }
);

/**
 * Whether the current user still needs to complete 2FA setup — derived
 * fresh from /api/mfa/status/ rather than only trusted from the one-time
 * login response, so a page refresh (or finishing setup, or an admin
 * lifting the role requirement) is always reflected correctly. Called
 * once per authenticated session by MainLayout, which also redirects to
 * Profile > Security while this is true.
 */
export const checkMfaSetupRequired = createAsyncThunk(
  'auth/checkMfaSetupRequired',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await apiClient.get('/api/mfa/status/');
      const hasAnyFactor = data.totp_enabled || (data.webauthn_credentials || []).length > 0;
      return { mustSetupMfa: !!data.role_requires_mfa && !hasAnyFactor };
    } catch (error) {
      // A transient failure here shouldn't force (or clear) the redirect —
      // leave whatever value is already in state alone.
      return rejectWithValue(getErrorMessage(error));
    }
  }
);

/**
 * Async thunk to refresh access token
 */
export const refreshAccessToken = createAsyncThunk(
  'auth/refreshAccessToken',
  async (_, { getState, rejectWithValue }) => {
    try {
      const { auth } = getState();

      if (!auth.refreshToken) {
        return rejectWithValue('No refresh token available');
      }

      const response = await apiClient.post('/api/token/refresh/', {
        refresh: auth.refreshToken,
      });

      const { access } = response.data;
      authSetAccess(access);
      return { token: access };
    } catch (error) {
      return rejectWithValue(getErrorMessage(error));
    }
  }
);

/**
 * Async thunk to fetch current user
 */
export const fetchCurrentUser = createAsyncThunk(
  'auth/fetchCurrentUser',
  async (_, { getState, rejectWithValue }) => {
    try {
      // Verify token is still valid
      const { auth } = getState();
      await apiClient.post('/api/token/verify/', { token: auth.token });
      return {
        user: auth.user,
        roles: auth.roles || [],
        permissions: auth.permissions || [],
        modules: auth.modules || [],
        warehouseScope: auth.warehouseScope || [],
      };
    } catch (error) {
      return rejectWithValue(getErrorMessage(error));
    }
  }
);

/**
 * Auth slice reducer
 */
const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setCredentials: (state, action) => {
      const { token, refreshToken, user, roles, permissions, modules, warehouse_scope } = action.payload;

      state.token = token || state.token;
      state.refreshToken = refreshToken || state.refreshToken;
      state.user = user || state.user;
      state.roles = roles || state.roles;
      state.permissions = permissions || state.permissions;
      state.modules = modules || state.modules;
      state.warehouseScope = warehouse_scope || state.warehouseScope;
      state.isAuthenticated = !!state.token;
    },

    updateWarehouseScope: (state, action) => {
      state.warehouseScope = action.payload;
    },

    // NOTE: prefer dispatching the `signOut` thunk below over this reducer.
    // This only forgets the session locally; `signOut` also revokes the
    // refresh token server-side first. The reducer stays exported because
    // the 401 interceptor needs a synchronous, network-free way out when a
    // refresh has ALREADY been rejected — calling the API again there would
    // be pointless.
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.refreshToken = null;
      state.roles = [];
      state.permissions = [];
      state.modules = [];
      state.warehouseScope = [];
      state.isAuthenticated = false;
      state.mustSetupMfa = false;
      state.justLoggedIn = false;
      state.error = null;

      // Clear both storages and caches
      clearPermissionsCache();
      clearLookupCache();
      authClear();
    },

    clearError: (state) => {
      state.error = null;
    },

    // Called by TwoFactorSection the moment the user has ANY confirmed
    // factor — avoids waiting on a round trip to checkMfaSetupRequired
    // (and the brief window where a stale true would still redirect them
    // straight back to Profile) when the component already knows the
    // answer from the /api/mfa/status/ call it just made itself.
    clearMustSetupMfa: (state) => {
      state.mustSetupMfa = false;
    },

    // Lowered by the login greeting modal once it has shown, so it fires
    // exactly once per sign-in. See `justLoggedIn` in initialState.
    clearJustLoggedIn: (state) => {
      state.justLoggedIn = false;
    },
  },

  extraReducers: (builder) => {
    // A completed login, however it got there — the direct password path
    // when no second factor is set up, or verifyMfa completing the
    // second step. Deliberately NOT applied when loginUser resolves with
    // mfaRequired instead: that's a mid-login state, not a session, so
    // auth state stays exactly as it was (isAuthenticated stays false)
    // until the code/biometric step actually finishes.
    const applySignedIn = (state, action) => {
      state.isLoading = false;
      state.token = action.payload.token;
      state.refreshToken = action.payload.refreshToken;
      state.user = action.payload.user;
      state.roles = action.payload.roles;
      state.permissions = action.payload.permissions;
      state.modules = action.payload.modules;
      state.warehouseScope = action.payload.warehouseScope;
      state.isAuthenticated = true;
      state.mustSetupMfa = !!action.payload.mustSetupMfa;
      // Raised here and nowhere else — this is THE sign-in moment, so it
      // never fires on a page refresh (which restores auth via initialState).
      state.justLoggedIn = true;
      state.error = null;
    };

    // Login
    builder
      .addCase(loginUser.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loginUser.fulfilled, (state, action) => {
        state.isLoading = false;
        if (action.payload.mfaRequired) {
          state.error = null;
          return;
        }
        applySignedIn(state, action);
      })
      .addCase(loginUser.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
        state.isAuthenticated = false;
      });

    // Second step of a two-factor login (see verifyMfa above).
    builder
      .addCase(verifyMfa.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(verifyMfa.fulfilled, applySignedIn)
      .addCase(verifyMfa.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      });

    // Second step of a two-factor login via biometric device (see
    // verifyMfaWebAuthn above).
    builder
      .addCase(verifyMfaWebAuthn.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(verifyMfaWebAuthn.fulfilled, applySignedIn)
      .addCase(verifyMfaWebAuthn.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      });

    // Whether 2FA setup is still outstanding (see checkMfaSetupRequired).
    // No pending/rejected handling needed — a transient failure just
    // leaves the existing value alone rather than forcing either state.
    builder.addCase(checkMfaSetupRequired.fulfilled, (state, action) => {
      state.mustSetupMfa = action.payload.mustSetupMfa;
    });

    // Refresh token
    builder
      .addCase(refreshAccessToken.pending, (state) => {
        // Don't show loading for refresh
      })
      .addCase(refreshAccessToken.fulfilled, (state, action) => {
        state.token = action.payload.token;
        state.isAuthenticated = true;
        state.error = null;
      })
      .addCase(refreshAccessToken.rejected, (state, action) => {
        state.token = null;
        state.refreshToken = null;
        state.isAuthenticated = false;
        state.error = action.payload;
      });

    // Fetch current user
    builder
      .addCase(fetchCurrentUser.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchCurrentUser.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload.user;
        state.roles = action.payload.roles;
        state.permissions = action.payload.permissions;
        state.modules = action.payload.modules;
        state.warehouseScope = action.payload.warehouseScope;
        state.isAuthenticated = !!state.token;
        state.error = null;
      })
      .addCase(fetchCurrentUser.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      });
  },
});

export const {
  setCredentials,
  updateWarehouseScope,
  logout,
  clearError,
  clearMustSetupMfa,
  clearJustLoggedIn,
} = authSlice.actions;

/**
 * Sign out for real: revoke the refresh token server-side, THEN forget it
 * locally.
 *
 * Clearing storage alone (the `logout` reducer) left the refresh token valid
 * for its full 7 days, so anyone holding a copy — a shared machine, a browser
 * profile left behind, a laptop with "Remember me" on — kept working access
 * after the user believed they were out.
 *
 * The local clear happens FIRST, before the revoke is awaited, so a failed or
 * slow network call can never trap someone in the app. Worst case the revoke
 * didn't land and the token expires on its own schedule, which is exactly
 * where we were before.
 *
 * Order matters, and it used to be the other way round. Clearing in `finally`
 * left a window — as long as the round trip took — where the caller had
 * already navigate()'d to /login but the store still held a token. In that
 * window login.jsx sees isAuthenticated and bounces to /home, and MainLayout
 * sees a still-true mustSetupMfa and pins the user to /profile. /profile is
 * an unguarded route, so once the clear finally landed there was nothing left
 * to redirect them, and they sat on a logged-out /profile rendering a null
 * user ("User", "Member", "—"). Clearing up front closes the window: nothing
 * downstream can believe the session is alive. `refresh` is read out of the
 * store before the clear, and /api/token/logout/ is AllowAny (it reads the
 * token from the BODY, not the Authorization header), so the revoke still
 * works perfectly well afterwards.
 */
export const signOut = createAsyncThunk(
  'auth/signOut',
  async (_arg, { dispatch, getState }) => {
    const refresh = getState().auth?.refreshToken;
    dispatch(logout());
    try {
      if (refresh) {
        await apiClient.post('/api/token/logout/', { refresh });
      }
    } catch {
      // Deliberately ignored — see the docstring. Leaving must not depend
      // on the network.
    }
  }
);

export default authSlice.reducer;
