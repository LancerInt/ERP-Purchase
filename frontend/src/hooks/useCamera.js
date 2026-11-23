/**
 * useCamera — thin wrapper over getUserMedia for live selfie capture.
 *
 * Used by the face-enrollment wizard and the attendance check-in so both
 * capture from the LIVE camera stream (a saved gallery photo can't be
 * uploaded — a basic anti-spoofing measure). `capture()` grabs the current
 * video frame as a downscaled JPEG Blob ready to POST as multipart.
 */
import { useRef, useState, useEffect, useCallback } from 'react';

export default function useCamera({ facingMode = 'user' } = {}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const stop = useCallback(() => {
    const s = streamRef.current;
    if (s) s.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
  }, []);

  const start = useCallback(async () => {
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera is not supported on this device/browser.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Some browsers need an explicit play() after setting srcObject.
        await videoRef.current.play().catch(() => {});
      }
      setReady(true);
    } catch (e) {
      setReady(false);
      setError(
        e.name === 'NotAllowedError' || e.name === 'SecurityError'
          ? 'Camera permission denied. Allow camera access for this site and try again.'
          : e.name === 'NotFoundError'
            ? 'No camera found on this device.'
            : (e.message || 'Could not start the camera.'),
      );
    }
  }, [facingMode]);

  /**
   * Grab the current frame as a JPEG Blob, downscaled so the longest edge
   * is at most `maxW` px (keeps uploads small; server-side detection is
   * reliable at ~480px). Returns a Promise<Blob>.
   */
  const capture = useCallback((maxW = 480) => new Promise((resolve, reject) => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) {
      reject(new Error('Camera is not ready yet.'));
      return;
    }
    const scale = Math.min(1, maxW / v.videoWidth);
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not capture the frame.'))),
      'image/jpeg',
      0.9,
    );
  }), []);

  // Always release the camera when the component using the hook unmounts.
  useEffect(() => () => stop(), [stop]);

  return { videoRef, ready, error, start, stop, capture };
}
