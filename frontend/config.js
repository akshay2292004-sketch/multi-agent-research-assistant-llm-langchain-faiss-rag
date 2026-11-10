// Where the backend API lives.
// - Empty string: the API serves this page itself (local dev, or the Render URL).
// - On Vercel: set RENDER_API_URL to your Render service URL.
const RENDER_API_URL = "https://research-assistant-api-yc7f.onrender.com";

window.API_BASE =
  ["localhost", "127.0.0.1"].includes(location.hostname) || location.hostname.endsWith(".onrender.com")
    ? ""
    : RENDER_API_URL;
