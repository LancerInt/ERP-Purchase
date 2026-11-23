import { useState, useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import TallySyncModal from './TallySyncModal.jsx';
import { fetchAppSettings } from '../../utils/appSettings.js';
import { clearJustLoggedIn } from '../../store/slices/authSlice.js';

/**
 * Shows the Tally-sync greeting ONCE per login (never on refresh).
 *
 * auth.justLoggedIn is raised only by applySignedIn — the real sign-in moment —
 * and never by a page reload (a reload restores the session from storage via
 * initialState, which doesn't touch that flag). We open the shared modal when
 * it flips true, respecting the GLOBAL `tally_login_popup` flag, then lower the
 * flag so a remount can't re-trigger it.
 *
 * NOTE: the open is NOT gated on an effect-cleanup `alive` ref — an earlier
 * version cleared justLoggedIn first, which re-ran the effect, fired its
 * cleanup (alive=false), and the in-flight fetch then skipped setOpen — so the
 * popup never appeared. Here setOpen happens directly and the flag is cleared
 * in `finally`; firedRef guards against a double trigger.
 */
export default function TallySyncLoginModal() {
  const dispatch = useDispatch();
  const justLoggedIn = useSelector((s) => s.auth?.justLoggedIn);
  const [open, setOpen] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!justLoggedIn || firedRef.current) return;
    firedRef.current = true;
    (async () => {
      try {
        const settings = await fetchAppSettings();
        if (settings.tally_login_popup !== false) setOpen(true);  // default ON
      } catch {
        /* no access / endpoint down — stay silent */
      } finally {
        dispatch(clearJustLoggedIn());
      }
    })();
  }, [justLoggedIn, dispatch]);

  return <TallySyncModal open={open} onClose={() => setOpen(false)} />;
}
