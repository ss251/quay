# Site fonts

The site uses the round 2 type: Geist and Geist Mono (SIL Open Font License 1.1, by Vercel). `web/assets/fonts/` holds subsets: only the characters the built pages and the dashboard script use, Geist at weights 400 to 600 and Geist Mono at 400 to 500.

Rebuild them after copy changes that add new characters:

1. Get the variable Latin files `geist-latin.woff2` and `geist-mono-latin.woff2` (Geist 1.8 and Geist Mono 1.7; the `geist` npm package ships them).
2. Build the site once with `node web/build.mjs`.
3. From the repository root, run `python3 -I web/fonts/subset.py <dir with the two files> web/assets/fonts`.
4. Build again.

The script needs `fonttools` and `brotli`.
