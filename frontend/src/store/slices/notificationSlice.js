/**
 * In-app notifications slice.
 *
 * Backed by /api/notifications/ — the bell (Header on desktop,
 * MobileBottomNav on mobile) reads `items` + `unreadCount` from here, and
 * MainLayout polls `fetchNotifications` on an interval while authenticated.
 */
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import apiClient from '../../utils/api.js';

export const fetchNotifications = createAsyncThunk(
  'notifications/fetch',
  async (_, { rejectWithValue }) => {
    try {
      const res = await apiClient.get('/api/notifications/');
      return res.data; // { results, unread_count }
    } catch (err) {
      return rejectWithValue(err?.response?.data || 'Failed to load notifications');
    }
  }
);

export const markNotificationRead = createAsyncThunk(
  'notifications/markRead',
  async (id) => {
    await apiClient.post(`/api/notifications/${id}/mark-read/`);
    return id;
  }
);

export const markAllNotificationsRead = createAsyncThunk(
  'notifications/markAllRead',
  async () => {
    await apiClient.post('/api/notifications/mark-all-read/');
  }
);

export const deleteNotification = createAsyncThunk(
  'notifications/delete',
  async (id) => {
    await apiClient.delete(`/api/notifications/${id}/`);
    return id;
  }
);

export const clearAllNotifications = createAsyncThunk(
  'notifications/clearAll',
  async () => {
    await apiClient.post('/api/notifications/clear-all/');
  }
);

const notificationSlice = createSlice({
  name: 'notifications',
  initialState: {
    items: [],
    unreadCount: 0,
    isLoading: false,
  },
  reducers: {
    clearNotifications(state) {
      state.items = [];
      state.unreadCount = 0;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchNotifications.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(fetchNotifications.fulfilled, (state, action) => {
        state.items = action.payload.results || [];
        state.unreadCount = action.payload.unread_count || 0;
        state.isLoading = false;
      })
      .addCase(fetchNotifications.rejected, (state) => {
        state.isLoading = false;
      })
      .addCase(markNotificationRead.fulfilled, (state, action) => {
        const n = state.items.find((i) => i.id === action.payload);
        if (n && !n.is_read) {
          n.is_read = true;
          state.unreadCount = Math.max(0, state.unreadCount - 1);
        }
      })
      .addCase(markAllNotificationsRead.fulfilled, (state) => {
        state.items.forEach((i) => { i.is_read = true; });
        state.unreadCount = 0;
      })
      .addCase(deleteNotification.fulfilled, (state, action) => {
        const n = state.items.find((i) => i.id === action.payload);
        if (n && !n.is_read) state.unreadCount = Math.max(0, state.unreadCount - 1);
        state.items = state.items.filter((i) => i.id !== action.payload);
      })
      .addCase(clearAllNotifications.fulfilled, (state) => {
        state.items = [];
        state.unreadCount = 0;
      });
  },
});

export const { clearNotifications } = notificationSlice.actions;
export default notificationSlice.reducer;
