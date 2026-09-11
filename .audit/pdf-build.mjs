import { build } from 'esbuild'
await build({
  entryPoints: ['.audit/pdf-entry.js'],
  bundle: true, format: 'esm', outfile: '.audit/pdf-bundle.mjs',
  loader: { '.js': 'jsx' }, jsx: 'automatic', logLevel: 'warning',
  // The commitment HTML builder lives beside a React component that imports the
  // Supabase client, so the bundle needs import.meta.env. Empty values keep
  // isSupabaseConfigured false — document generation touches no backend.
  define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }) },
})
console.log('bundled')
