// Tailwind for the pages that used the runtime Play CDN (DEP-03): the home and
// sign-in page, attendance, the typing test, the quiz, recordings and the admin
// console. Built ahead of time into ui/tailwind.css by `npm run build`, so no
// page compiles CSS in the browser or waits on cdn.tailwindcss.com. Default
// Tailwind v3 theme, as the Play CDN used (none of the pages configured it).
module.exports = {
  content: [
    './index.html', './attendance/**/*.html', './typingtest/**/*.html', './mcqquiz/**/*.html',
    './recordings/**/*.html', './wsm-admin/**/*.html',
    // Scripts those pages load, which also build markup with Tailwind classes.
    './admin/**/*.js', './ui/**/*.js', './*.js',
    '!./ui/vendor/**', '!./node_modules/**',
  ],
  theme: { extend: {} },
  plugins: [],
};
