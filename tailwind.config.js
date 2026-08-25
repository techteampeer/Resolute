/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'DM Sans', 'sans-serif'],
        display: ['DM Sans', 'Inter', 'sans-serif'],
      },
      colors: {
        /* ── Finalised brand palette ──
           navy   #12284C  headers, sidebars, primary text
           indigo #2441E5  the single accent: buttons, links, active state
           cyan   #00B8D9  highlights, bars, fills — DECORATIVE ONLY
                           (2.3:1 on white, never use for text or thin icons)
           grey   #F3F5F8  page background                                   */
        navy: {
          50:  '#EAEEF5', 100: '#CCD5E4', 200: '#9FAECA', 300: '#6E82A8',
          400: '#455F8B', 500: '#1E3A67', 600: '#12284C', 700: '#0E203D',
          800: '#0A182E', 900: '#071120', 950: '#040A14',
        },
        indigo: {
          50:  '#EEF1FE', 100: '#D9DFFC', 200: '#B3BEF9', 300: '#8496F3',
          400: '#4A63EA', 500: '#2441E5', 600: '#1B34C4', 700: '#152AA3',
          800: '#101F7C', 900: '#0B1656', 950: '#060B2E',
        },
        cyan: {
          50:  '#E4F7FB', 100: '#BDEDF6', 200: '#7FDCEC', 300: '#3ECBE1',
          400: '#00B8D9', 500: '#00A0BD', 600: '#0E7C90', 700: '#0C6274',
          800: '#094957', 900: '#06333D', 950: '#031A20',
        },
        /* Legacy alias so any stale `brand-*` class still resolves to indigo */
        brand: {
          50:  '#EEF1FE', 100: '#D9DFFC', 200: '#B3BEF9', 300: '#8496F3',
          400: '#4A63EA', 500: '#2441E5', 600: '#1B34C4', 700: '#152AA3',
          800: '#101F7C', 900: '#0B1656', 950: '#060B2E',
        },
      },
      animation: {
        'float':      'float 6s ease-in-out infinite',
        'pulse-slow': 'pulse 4s ease-in-out infinite',
        'shimmer':    'shimmer 2s linear infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':      { transform: 'translateY(-10px)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
}
