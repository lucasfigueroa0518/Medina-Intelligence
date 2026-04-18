import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Frontend Spec §1.1
        bg: {
          root: '#09090B',
          surface: '#111114',
          'surface-hover': '#1A1A1F',
          elevated: '#222228',
          input: '#161619',
          inset: '#0D0D0F',
        },
        border: {
          DEFAULT: '#27272A',
          hover: '#3F3F46',
          active: '#D946A8',
        },
        text: {
          primary: '#FAFAFA',
          secondary: '#A1A1AA',
          muted: '#71717A',
          inverse: '#09090B',
        },
        accent: {
          magenta: '#D946A8',
          purple: '#8B5CF6',
        },
        semantic: {
          success: '#22C55E',
          warning: '#F59E0B',
          error: '#EF4444',
          info: '#3B82F6',
        },
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Instrument Serif', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #D946A8, #8B5CF6)',
      },
      borderRadius: {
        lg: '8px',
        xl: '12px',
        '2xl': '16px',
      },
    },
  },
  plugins: [],
};

export default config;
