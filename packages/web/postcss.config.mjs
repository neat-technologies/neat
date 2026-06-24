/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    // Tailwind v4 moved its PostCSS plugin into its own package; the old
    // `tailwindcss: {}` entry (v3) is no longer a valid PostCSS plugin.
    '@tailwindcss/postcss': {},
  },
}

export default config
