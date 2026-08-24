/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0a0a0b',
          900: '#121214',
          800: '#1c1c1f',
          700: '#29292d',
          600: '#3c3c41',
        },
        brand: {
          50: '#fef2f3',
          100: '#fde3e5',
          200: '#f9c9cd',
          300: '#f29ba2',
          400: '#e96872',
          500: '#dc2f43',
          600: '#c01f34',
          700: '#9e1a2c',
          800: '#841a29',
          900: '#711a27',
        },
        accent: {
          error: '#b91c1c',
          success: '#15803d',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
        display: ['Poppins', 'Inter', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '6px',
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 8px -2px rgb(0 0 0 / 0.08)',
        'card-hover': '0 8px 24px -8px rgb(0 0 0 / 0.18), 0 2px 8px -2px rgb(0 0 0 / 0.08)',
        pop: '0 0 0 4px rgb(220 47 67 / 0.12)',
      },
      keyframes: {
        seatPop: {
          '0%': { transform: 'scale(0.85)' },
          '60%': { transform: 'scale(1.08)' },
          '100%': { transform: 'scale(1)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgb(220 47 67 / 0.35)' },
          '50%': { boxShadow: '0 0 0 8px rgb(220 47 67 / 0)' },
        },
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        seatPop: 'seatPop 220ms cubic-bezier(0.34,1.56,0.64,1)',
        shimmer: 'shimmer 1.6s infinite',
        glowPulse: 'glowPulse 2s ease-in-out infinite',
        fadeUp: 'fadeUp 300ms ease-out',
      },
    },
  },
  plugins: [],
};
