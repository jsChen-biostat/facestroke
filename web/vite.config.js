import { defineConfig } from 'vite';

// FaceStroke web app.
// Rule (04_technical_architecture.md section 7): no CDN, no external fonts,
// everything must work offline. Do not add external asset hosts here.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Vite rejects requests whose Host header it does not recognise (DNS
    // rebinding protection) and answers 403. The phone is reached through a
    // cloudflared quick tunnel, so those hostnames must be allowed explicitly.
    // See 04_technical_architecture.md §5.
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', 'localhost', '.local'],
    watch: {
      // public/mediapipe holds ~35MB of wasm + the .task model.
      // Watching them is useless and previously crashed the server with EBUSY
      // while the model was being written.
      ignored: ['**/public/mediapipe/**'],
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 0,
  },
  // Keep relative paths so the built app also works from a Capacitor WebView.
  base: './',
});
