import apiClient from './api.js';

/**
 * Global UI settings — ONE value shared by all users (see core AppSetting).
 * GET /api/app-settings/ returns { settings: { tally_login_popup, ... } };
 * PATCH with { key: value } flips a key for everyone.
 */
export async function fetchAppSettings() {
  const res = await apiClient.get('/api/app-settings/');
  return res.data?.settings || {};
}

export async function patchAppSetting(key, value) {
  const res = await apiClient.patch('/api/app-settings/', { [key]: value });
  return res.data?.settings || {};
}
