/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      // Extra breakpoint between base and sm (640px). Used to switch
      // the mobile card lists from 1 to 2 columns on larger phones /
      // small tablets while keeping a single column on narrow phones.
      screens: {
        xs: '480px',
      },
      colors: {
        // ── SS Biochem brand theme (teal + cream) ─────────────────────────
        // App-wide reskin done HERE, not per-file: the app uses Tailwind's
        // default `indigo` (accent) and `slate` (text/surfaces) classes
        // throughout, so overriding those two ramps retints the whole app in
        // one place. `indigo-*` → teal; `slate-*` → a warm cream→ink ramp
        // (light shades = cream surfaces/borders, dark shades = warm ink text).
        // Semantic colours (success/danger/warning, emerald/amber/red) are
        // left alone so figures still read at a glance.
        indigo: {
          50:  '#e8f1ee',
          100: '#d2e3dd',
          200: '#a9cbc0',
          300: '#73a99a',
          400: '#3f897a',
          500: '#1d6b5c',   // brand teal (accent)
          600: '#1a6153',
          700: '#155447',   // deep teal — headings / primary text accents
          800: '#114539',
          900: '#0d362d',
        },
        slate: {
          50:  '#faf8f1',   // page / lightest surface (cream)
          100: '#f3eee1',   // cream panel tint / hover
          200: '#e4ddca',   // borders on cream
          300: '#cdc4ac',   // stronger borders
          400: '#6b6453',   // muted labels (darkened again for contrast on cream)
          500: '#60594a',   // secondary text / dates
          600: '#4a4438',   // body text
          700: '#39342b',   // strong text
          800: '#292621',   // headings
          900: '#1b2420',   // warm near-black (ink)
        },
        primary: {
          50:  '#e8f1ee',
          100: '#d2e3dd',
          200: '#a9cbc0',
          300: '#73a99a',
          400: '#3f897a',
          500: '#1d6b5c',
          600: '#1a6153',
          700: '#155447',
          800: '#114539',
          900: '#0d362d',
        },
        secondary: {
          50: '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#3f0f8f',
        },
        success: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#145231',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          200: '#fecaca',
          300: '#fca5a5',
          400: '#f87171',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
          800: '#991b1b',
          900: '#7f1d1d',
        },
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
        },
        neutral: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    // Pointer-type variants. Screen width cannot tell a 1024px iPad from a
    // 1024px laptop window, but those two need different row heights, hit
    // areas and scrollbars. These let a component ask what it actually needs
    // to know — "is this being driven by a mouse or a finger?" — instead of
    // guessing from a breakpoint.
    //
    //   fine:   mouse / trackpad  -> denser, more rows on screen
    //   coarse: touch             -> 44px hit targets
    //
    // Defaults stay touch-safe and `fine:` tightens, so a device that reports
    // no pointer support lands on the comfortable size, never the cramped one.
    ({ addVariant }) => {
      addVariant('fine', '@media (pointer: fine)');
      addVariant('coarse', '@media (pointer: coarse)');
    },
  ],
};
