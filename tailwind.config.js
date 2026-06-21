const paletteVar = (name) => `var(--color-${name})`;

module.exports = {
  darkMode: 'class',
  content: [
    './templates/**/*.html',
    './tasks/**/*.py',
  ],
  theme: {
    extend: {
      colors: {
        app: {
          bg: paletteVar('background-app'),
          surface: paletteVar('background-surface'),
          elevated: paletteVar('background-surface-elevated'),
          hover: paletteVar('background-surface-hover'),
          pressed: paletteVar('background-surface-pressed'),
        },
        fg: {
          primary: paletteVar('foreground-primary'),
          secondary: paletteVar('foreground-secondary'),
          tertiary: paletteVar('foreground-tertiary'),
          disabled: paletteVar('foreground-disabled'),
          inverse: paletteVar('foreground-inverse'),
        },
        line: {
          subtle: paletteVar('border-subtle'),
          DEFAULT: paletteVar('border-default'),
          strong: paletteVar('border-strong'),
          focus: paletteVar('border-focus'),
        },
        tile: {
          DEFAULT: paletteVar('tile-default'),
          alternate: paletteVar('tile-alternate'),
          active: paletteVar('tile-active'),
          completed: paletteVar('tile-completed'),
          overdue: paletteVar('tile-overdue'),
        },
        brand: {
          DEFAULT: paletteVar('accent-brand'),
          hover: paletteVar('accent-brand-hover'),
          pressed: paletteVar('accent-brand-pressed'),
          soft: paletteVar('accent-brand-soft'),
        },
        info: paletteVar('accent-info'),
        danger: paletteVar('button-danger-background'),
      },
      borderRadius: {
        smooth: '0.625rem',
      },
      boxShadow: {
        panel: '0 14px 35px var(--color-shadow-default)',
        strong: '0 18px 50px var(--color-shadow-strong)',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
